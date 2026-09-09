<## Deterministic tests for production runner accounting and exit-code capture. ##>
. (Join-Path $PSScriptRoot 'production_mwdt_lib.ps1')

$failures = 0
function Assert-ProductionTest {
    param([bool]$Condition, [string]$Message)
    if ($Condition) { Write-Output "PASS: $Message" }
    else { $script:failures++; Write-Output "FAIL: $Message" }
}

$reset = '[LasecSimul][ESP32 reset] count=1 mask=0x0f cause0=1 cause1=1 pc0=0x50000000 pc1=0x00000000 wdt0_enabled=0 wdt1_enabled=0 network=disabled expected=no source=OTHER boot_epoch=1 pid=100'
$startup = '[LasecSimul][ESP32 reset] count=2 mask=0x02 cause0=1 cause1=12 pc0=0x4000689c pc1=0x40000400 wdt0_enabled=0 wdt1_enabled=0 network=disabled expected=app-cpu-startup source=SW_CPU_RESET_REGISTER boot_epoch=1 pid=100'
$unexpected = '[LasecSimul][ESP32 reset] count=3 mask=0x02 cause0=12 cause1=12 pc0=0x40083923 pc1=0x40082a39 wdt0_enabled=0 wdt1_enabled=0 network=disabled expected=no source=SW_CPU_RESET_REGISTER boot_epoch=1 pid=100'
$stats = Get-ProductionResetStatistics -Lines @($reset, $startup, $unexpected, $reset, $startup, $unexpected)
Assert-ProductionTest ($stats.rawLines -eq 6) 'raw reset lines preserve every physical log line'
Assert-ProductionTest ($stats.deduplicated -eq 3) 'reset events deduplicate by pid, epoch, count, mask, PCs and source'
Assert-ProductionTest ($stats.unexpectedCount -eq 1) 'unexpected reset count uses deduplicated events'

$ps = (Get-Process -Id $PID).Path
$probe = Invoke-ProductionProcess -FilePath $ps -ArgumentList @('-NoProfile', '-NonInteractive', '-Command',
    '[Console]::Out.Write("stdout"); [Console]::Error.Write("stderr"); exit 7')
Assert-ProductionTest ($probe.exitCode -eq 7) 'runner captures a nonzero child exit code'
Assert-ProductionTest ($probe.stdout -eq 'stdout') 'runner captures child stdout'
Assert-ProductionTest ($probe.stderr -eq 'stderr') 'runner captures child stderr'

$okReasons = @(Get-ProductionRunFailureReasons -HarnessExitCode 0 -SessionsDumped 1 -ExpectedSessions 1 `
    -JsonlSessions 1 -ClassifierSummary ([pscustomobject]@{ cellPass=$true; teardownClean=$true; anyJsonlStderrMismatch=$false }))
Assert-ProductionTest ($okReasons.Count -eq 0) 'pass-shaped run has no runner failure reasons'

$harnessFail = @(Get-ProductionRunFailureReasons -HarnessExitCode 1 -SessionsDumped 1 -ExpectedSessions 1 `
    -JsonlSessions 1 -ClassifierSummary ([pscustomobject]@{ cellPass=$true; teardownClean=$true; anyJsonlStderrMismatch=$false }))
Assert-ProductionTest (($harnessFail -contains 'harness_exit_code_1')) 'harness failure produces nonzero runner classification'

$cellFail = @(Get-ProductionRunFailureReasons -HarnessExitCode 0 -SessionsDumped 1 -ExpectedSessions 1 `
    -JsonlSessions 1 -ClassifierSummary ([pscustomobject]@{ cellPass=$false; teardownClean=$true; anyJsonlStderrMismatch=$false }))
Assert-ProductionTest (($cellFail -contains 'classifier_cellPass_false')) 'cellPass=false fails even when harness exit code is zero'

$timeoutFail = @(Get-ProductionRunFailureReasons -HarnessExitCode $null -ExternalBackstop:$true -SessionsDumped 1 -ExpectedSessions 1 `
    -JsonlSessions 1 -ClassifierSummary ([pscustomobject]@{ cellPass=$true; teardownClean=$true; anyJsonlStderrMismatch=$false }))
Assert-ProductionTest (($timeoutFail -contains 'harness_exit_code_unavailable') -and ($timeoutFail -contains 'external_timeout')) 'timeout and unavailable exit code are fail-closed'

$missingJsonl = @(Get-ProductionRunFailureReasons -HarnessExitCode 0 -SessionsDumped 1 -ExpectedSessions 1 `
    -JsonlSessions 0 -ClassifierSummary ([pscustomobject]@{ cellPass=$true; teardownClean=$true; anyJsonlStderrMismatch=$false }))
Assert-ProductionTest (($missingJsonl -contains 'incomplete_jsonl_0_of_1')) 'missing JSONL session is fail-closed'

$fakeProcesses = @(
    [pscustomobject]@{ ProcessId=1001; ParentProcessId=42; ExecutablePath='C:\fake\qemu-system-xtensa.exe'; CreationDate=(Get-Date) },
    [pscustomobject]@{ ProcessId=1002; ParentProcessId=4242; ExecutablePath='C:\fake\qemu-system-xtensa.exe'; CreationDate=(Get-Date) },
    [pscustomobject]@{ ProcessId=1003; ParentProcessId=42; ExecutablePath='C:\other\qemu-system-xtensa.exe'; CreationDate=(Get-Date) }
)
$owned = @(Select-ProductionOwnedQemuProcesses -Processes $fakeProcesses -ExpectedQemuPath 'C:\fake\qemu-system-xtensa.exe' `
    -HarnessProcessId 42 -StartedAt (Get-Date).AddSeconds(-5) -KnownBefore @(1002))
Assert-ProductionTest ($owned.Count -eq 1 -and [int]$owned[0].ProcessId -eq 1001) 'owned-process selection ignores pre-existing and wrong-path external processes'

$tmpRoot = Join-Path ([IO.Path]::GetTempPath()) ("lasecsimul-runner-process-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null
$fakeQemu = Join-Path $tmpRoot 'qemu-system-xtensa.exe'
Copy-Item -LiteralPath $ps -Destination $fakeQemu -Force
$external = $null
$harness = $null
try {
    $external = Start-Process -FilePath $fakeQemu -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden
    $childPidFile = Join-Path $tmpRoot 'child.pid'
    $harnessCommand = "& { `$p = Start-Process -FilePath '$fakeQemu' -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden; Set-Content -LiteralPath '$childPidFile' -Value `$p.Id; Start-Sleep -Seconds 30 }"
    $harnessStarted = Get-Date
    $harness = Start-Process -FilePath $ps -ArgumentList @('-NoProfile','-NonInteractive','-Command',$harnessCommand) -PassThru -WindowStyle Hidden
    $limit = (Get-Date).AddSeconds(10)
    while (-not (Test-Path -LiteralPath $childPidFile) -and (Get-Date) -lt $limit) { Start-Sleep -Milliseconds 100 }
    $ownedLive = @(Get-ProductionOwnedQemuProcesses -ExpectedQemuPath $fakeQemu -HarnessProcessId $harness.Id `
        -StartedAt $harnessStarted -KnownBefore @($external.Id))
    $stopped = @(Stop-ProductionOwnedQemuProcesses -Processes $ownedLive -ExpectedQemuPath $fakeQemu)
    Start-Sleep -Milliseconds 500
    $externalStillAlive = $null -ne (Get-Process -Id $external.Id -ErrorAction SilentlyContinue)
    $ownedStillAlive = @($ownedLive | Where-Object { $null -ne (Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue) }).Count
    Assert-ProductionTest ($ownedLive.Count -ge 1 -and $stopped.Count -ge 1 -and $ownedStillAlive -eq 0) 'owned fake QEMU descendant is killed'
    Assert-ProductionTest $externalStillAlive 'external pre-existing fake QEMU process is not touched'
} finally {
    if ($null -ne $external -and -not $external.HasExited) { $external.Kill(); [void]$external.WaitForExit(5000) }
    if ($null -ne $harness -and -not $harness.HasExited) { $harness.Kill(); [void]$harness.WaitForExit(5000) }
    Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures -gt 0) { exit 1 }
Write-Output 'ALL PASS'
exit 0

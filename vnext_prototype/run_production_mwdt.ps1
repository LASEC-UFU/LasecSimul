<#
    Runs the production VNEXT_B scale harness and classifies MWDT-attributed
    resets and QEMU log volume.  This is the E102 experiment: the fed Arduino
    I2C workload driven by a real Core session.

    HOST SAFETY (DECISION-010).  The harness spawns one QEMU per session and
    each one holds cores at 100%.  Child processes inherit the parent's
    processor-affinity mask and priority class on Windows, so constraining the
    harness constrains the whole tree.  Reserved cores stay free for the OS;
    an unconstrained 16-session run is what froze this host on 2026-09-03.

    E120/Fase 5 (EVIDENCE.md, 2026-09-05): the harness itself now carries a
    bounded, diagnosed defensive timeout around stopSimulation() (E104's
    pre-existing teardown hang for Sessions>1) and writes a structured,
    flushed-per-line JSONL result for every session BEFORE teardown starts --
    see VnextBProductionScaleTest.cpp's stopSessionsWithDefensiveTimeout()/
    writeSessionResultJsonlIfRequested(). This script now wires
    LASECSIMUL_SCALE_RESULTS_JSONL and waits on the process actually exiting
    (bounded by the harness's own 15s-per-session defensive timeout, not by
    this script polling for SUCCESS_QEMU_LOG_END markers and killing blind) --
    the external kill-after-7-minutes path below is now a last-resort backstop
    for a hang the in-process defensive timeout itself failed to catch, not
    the primary recovery mechanism it used to be.
#>
param(
    [Parameter(Mandatory=$true)][int]$Sessions,
    [int]$RunMs = 60000,
    [int]$ReserveCores = 6,
    [string]$Firmware,
    [string]$Qemu,
    [string]$OutDir,
    [switch]$Force,
    [switch]$EnablePanicCausalTrace,
    [switch]$EnableRtcSysResetCausalTrace,
    [switch]$EnableWdtCausalTrace,
    [switch]$EnableMwdtAccounting,
    [switch]$EnableXtensaPcSampler
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
. (Join-Path $repo 'vnext_prototype\production_mwdt_lib.ps1')
if (-not $Firmware) { $Firmware = Join-Path $repo 'vnext_prototype\guest_i2c_workload\.pio\build\esp32\merged.bin' }
if (-not $Qemu)     { $Qemu     = Join-Path $repo 'vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe' }
if (-not $OutDir)   { $OutDir   = Join-Path $repo 'vnext_prototype\production_mwdt_runs' }
$exe = Join-Path $repo 'core\build\Release\vnext_b_production_scale_test.exe'
foreach ($p in @($exe,$Firmware,$Qemu)) { if (-not (Test-Path $p)) { throw "missing: $p" } }
$firmwareElf = Join-Path (Split-Path -Parent $Firmware) 'firmware.elf'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$totalCores  = [Environment]::ProcessorCount
$usableCores = [Math]::Max(2, $totalCores - $ReserveCores)
$affinity    = [IntPtr]([int64]((1L -shl $usableCores) - 1))
$cpuTopology = @(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors)
$physicalCores = [int](($cpuTopology | Measure-Object -Property NumberOfCores -Sum).Sum)
$logicalCores = [int](($cpuTopology | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)

# Admission guard is in vCPU slots, not sessions: MTTCG thread=multi spawns 2
# host-thread vCPUs (CPU0/CPU1) per ESP32 session (PROJECT_CONSTITUTION.md).
$requiredVcpuSlots = 2 * $Sessions
if ($requiredVcpuSlots -gt $usableCores -and -not $Force) {
    throw "Sessions=$Sessions needs $requiredVcpuSlots vCPU slots but only $usableCores of " +
          "$totalCores cores are usable ($ReserveCores reserved, DECISION-010). " +
          "Lower -Sessions/-ReserveCores, or pass -Force for a deliberately oversubscribed run."
}

# Traces off: E099 measured ~2 s per emitted diagnostic line on this host.
foreach ($v in 'LASECSIMUL_TG0_WDT_TRACE','LASECSIMUL_TG1_WDT_TRACE','LASECSIMUL_VNEXT_TRACE',
               'LASECSIMUL_FAILURE_ISOLATION','LASECSIMUL_ESP32_WDT_SCALE','LASECSIMUL_I2C_FASTPATH_TRACE',
               'LASECSIMUL_XTENSA_PC_SAMPLER','LASECSIMUL_MWDT_ACCOUNTING','LASECSIMUL_CACHE_TRACE',
               'LASECSIMUL_LANE0_DIAG','LASECSIMUL_UART_DISABLE_CORE_NOTIFY','LASECSIMUL_WDT_CAUSAL_TRACE',
               'LASECSIMUL_APP_CPU_RESET_TRACE','LASECSIMUL_P9_DIAGNOSTIC','LASECSIMUL_VNEXT_B_LANE_DEPTH',
               'LASECSIMUL_VNEXT_B_SELF_TEST_STARTUP_RACE_DELAY_MS','LASECSIMUL_VNEXT_STARTUP_TRACE',
               'LASECSIMUL_QEMU_TCG_THREAD','LASECSIMUL_REENTRANCY_CONCURRENCY_PROBE',
               # B11 Fase 1 (EVIDENCE.md, 2026-09-05): the E122/E126 causal tracers and E123's
               # teardown trace must be off for any formal measurement run -- added here so a
               # variable left set in the calling shell from a prior diagnostic session cannot leak
               # into a formal B11 cell.
               'LASECSIMUL_PANIC_CAUSAL_TRACE','LASECSIMUL_RTC_SYS_RESET_CAUSAL_TRACE',
               'LASECSIMUL_CACHE_TRACE_DIR','LASECSIMUL_TEARDOWN_TRACE','LASECSIMUL_FLASH_WRITE_TRACE',
               'LASECSIMUL_SCALE_SCHEDULER_METRICS') {
    Remove-Item "Env:$v" -ErrorAction SilentlyContinue
}
$env:LASECSIMUL_SCALE_SESSIONS       = "$Sessions"
$env:LASECSIMUL_SCALE_RUN_MS         = "$RunMs"
$env:LASECSIMUL_SCALE_PARALLEL_START = '1'
$env:LASECSIMUL_MCU_TRANSPORT        = 'VNEXT_B'
$env:LASECSIMUL_QEMU_TB_SIZE         = '64'
$env:LASECSIMUL_TEST_FIRMWARE        = $Firmware
$env:LASECSIMUL_TEST_QEMU_BINARY     = $Qemu
$env:LASECSIMUL_DUMP_SUCCESS_QEMU_LOG = '1'
$enabledDiagnostics = @()
if ($EnablePanicCausalTrace) {
    $env:LASECSIMUL_PANIC_CAUSAL_TRACE = '1'
    $enabledDiagnostics += 'LASECSIMUL_PANIC_CAUSAL_TRACE'
}
if ($EnableRtcSysResetCausalTrace) {
    $env:LASECSIMUL_RTC_SYS_RESET_CAUSAL_TRACE = '1'
    $enabledDiagnostics += 'LASECSIMUL_RTC_SYS_RESET_CAUSAL_TRACE'
}
if ($EnableWdtCausalTrace) {
    $env:LASECSIMUL_WDT_CAUSAL_TRACE = '1'
    $enabledDiagnostics += 'LASECSIMUL_WDT_CAUSAL_TRACE'
}
if ($EnableMwdtAccounting) {
    $env:LASECSIMUL_MWDT_ACCOUNTING = '1'
    $enabledDiagnostics += 'LASECSIMUL_MWDT_ACCOUNTING'
}
if ($EnableXtensaPcSampler) {
    $env:LASECSIMUL_XTENSA_PC_SAMPLER = '1'
    $enabledDiagnostics += 'LASECSIMUL_XTENSA_PC_SAMPLER'
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$errLog = Join-Path $OutDir "prod_n${Sessions}_$stamp.err"
$outLog = Join-Path $OutDir "prod_n${Sessions}_$stamp.out"
$jsonlLog = Join-Path $OutDir "prod_n${Sessions}_$stamp.results.jsonl"
$manifestLog = Join-Path $OutDir "prod_n${Sessions}_$stamp.manifest.json"
$summaryLog = Join-Path $OutDir "prod_n${Sessions}_$stamp.b11_summary.json"
Remove-Item $jsonlLog -ErrorAction SilentlyContinue
$env:LASECSIMUL_SCALE_RESULTS_JSONL = $jsonlLog

$qemuBefore = @(Get-ProductionQemuProcessesForPath -ExpectedQemuPath $Qemu)
$qemuBeforePids = @($qemuBefore | ForEach-Object { [int]$_.ProcessId })
$sw = [Diagnostics.Stopwatch]::StartNew()
# E146 (EVIDENCE.md, 2026-09-09): the monitor loop below needs an upper bound on real QEMU
# children BEFORE the run happens, to know when it can stop re-scanning for more -- this release's
# actual certified session limit is a C++-side production constant
# (VnextBCapacityGuard.hpp::kVnextBCertifiedReleaseSessionLimit) deliberately not duplicated here
# (see that file's own comment on why it must not be hidden in a second, driftable place); this
# script's own topology ceiling is a safe (never-too-low) upper bound on it, just not necessarily
# tight -- a -Sessions request above the certified limit but at or below this topology ceiling
# still stops the scan at the right moment once every real child that will ever exist has been
# sampled, it just may keep scanning a little longer than strictly necessary first.
$expectedChildCount = [Math]::Min($Sessions, [Math]::Floor($usableCores / 2))
# E146 (EVIDENCE.md, 2026-09-09): isolated with a direct, unwrapped invocation carrying the same
# -BelowNormal/-ProcessorAffinity constraints this script applies -- a run that includes a
# capacity-guard rejection (one session's own full concurrent startup contending for the reduced
# core set, then torn down immediately, while the other admitted sessions are still starting)
# measured 128.5s wall-clock against a plain 60s-workload N=8 run's 71.4s under the same
# constraints; this is genuine extra affinity-constrained contention, not a hang -- the harness
# itself still exits with the correct classification, just later than the +60s budget below
# assumed. +90s (instead of +60s) keeps comfortable headroom above the measured 128.5s worst case
# without materially slowing down detection of an actual real hang.
$p = Invoke-ProductionProcess -FilePath $exe -WorkingDirectory $repo -TimeoutMilliseconds ($RunMs + 90000) `
    -BelowNormal -ProcessorAffinity $affinity -ExpectedChildQemuPath $Qemu -KnownChildPidsBefore $qemuBeforePids `
    -ExpectedChildCount $expectedChildCount
$p.stdout | Set-Content -LiteralPath $outLog -Encoding UTF8
$p.stderr | Set-Content -LiteralPath $errLog -Encoding UTF8
# The helper owns the redirected pipes, so the child cannot deadlock on a full
# stdout/stderr pipe while the harness is running, and returns the child's real
# exit code after WaitForExit().
$exitCode = $p.exitCode
$hitExternalBackstop = [bool]$p.timedOut
$ownedQemuAfter = @(Get-ProductionOwnedQemuProcesses -ExpectedQemuPath $Qemu -HarnessProcessId $p.processId `
    -StartedAt $p.startedAt -KnownBefore $qemuBeforePids)
$stoppedOwnedQemu = @(Stop-ProductionOwnedQemuProcesses -Processes $ownedQemuAfter -ExpectedQemuPath $Qemu)
Start-Sleep -Milliseconds 1500
$ownedQemuAfterCleanup = @(Get-ProductionOwnedQemuProcesses -ExpectedQemuPath $Qemu -HarnessProcessId $p.processId `
    -StartedAt $p.startedAt -KnownBefore $qemuBeforePids)

$lines = @(Get-Content $errLog -ErrorAction SilentlyContinue)
$fc    = @($lines | Where-Object { $_ -match 'final-credit' }).Count
$ack   = @($lines | Where-Object { $_ -match 'ackERR' }).Count
$fifo  = @($lines | Where-Object { $_ -match 'read I2C FIFO while it is empty' }).Count
$resetStats = Get-ProductionResetStatistics -Lines $lines
$resets = @($resetStats.records)
$dedupResets = @($resetStats.uniqueRecords)
$mwdt   = @($dedupResets | Where-Object { $_.source -match '^MWDT_SYS_STAGE$|^MWDT_CPU_STAGE$' })
$dumped = @($lines | Where-Object { $_ -match 'SUCCESS_QEMU_LOG_BEGIN' }).Count
$jsonlSessions = @(Get-Content $jsonlLog -ErrorAction SilentlyContinue)
$classifier = Join-Path $repo 'vnext_prototype\mttcg_causality\B11\b11_classify.ps1'
$b11Summary = $null
if (Test-Path -LiteralPath $classifier) {
    . $classifier
    $b11Summary = Get-B11CellSummary -ErrText ($lines -join "`n") -ExpectedSessions $Sessions -JsonlPath $jsonlLog
    $b11Summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryLog -Encoding UTF8
}

$childSamples = @($p.childSamples)
$expectedAffinity = [int64]$affinity
# E146 (EVIDENCE.md, 2026-09-09): originally checked against $dumped (a count of
# SUCCESS_QEMU_LOG_BEGIN lines) or the raw -Sessions request -- both wrong here. dumped counts one
# line PER REQUESTED SESSION regardless of whether it actually started (VnextBProductionScaleTest.
# cpp's dumpSuccessfulQemuLogIfRequested() runs unconditionally in the per-session loop; a rejected
# session just dumps zero bytes), and this release's real certified session limit is a C++-side
# production constant this script deliberately does not duplicate (see VnextBCapacityGuard.hpp's
# own comment on why) -- so there is no count derivable here that reliably equals "how many QEMU
# children this run actually produced" ahead of observing $childSamples directly. Require at least
# one real sample (never a vacuous pass from zero children) and that every sample actually
# observed inherited the right affinity/priority -- this is the ground truth the manifest can
# actually attest to, independent of how many sessions were merely requested.
$childAffinityOk = ($childSamples.Count -gt 0) -and
    (@($childSamples | Where-Object { $_.processorAffinity -ne $expectedAffinity }).Count -eq 0)
$childPriorityOk = ($childSamples.Count -gt 0) -and
    (@($childSamples | Where-Object { $_.priorityClass -ne 'BelowNormal' }).Count -eq 0)
$childInheritanceConfirmed = $childAffinityOk -and $childPriorityOk
# E146 (EVIDENCE.md, 2026-09-09): a -Sessions request above this release's certified capacity is
# EXPECTED to have the production capacity guard (DECISION-010) refuse the excess session(s)
# before any QEMU process starts for them, and the harness reports that as its own exit code 1 --
# that is the correct, designed outcome for this run, not a runner failure. $dumped/$jsonlSessions
# still need to equal $Sessions here (both the per-session log dump and the JSONL write run
# unconditionally, once per REQUESTED session, admitted or refused -- VnextBProductionScaleTest.
# cpp's dumpSuccessfulQemuLogIfRequested()/writeSessionResultJsonlIfRequested()): that is what
# proves the harness's own per-session accounting loop actually completed for every session
# instead of crashing or hanging partway through. Detected narrowly (the guard's own unmistakable
# message text, that loop completing for every requested session, no external timeout, and zero
# orphaned QEMU processes) so a genuine unrelated failure occurring alongside an incidental guard
# rejection is never masked by it.
$capacityGuardRejectionDetected = ($lines -join "`n") -match 'VNEXT_B capacity guard \(DECISION-010\)'
$capacityRejectedAsDesigned = $capacityGuardRejectionDetected -and
    (-not $hitExternalBackstop) -and ($dumped -eq $Sessions) -and ($jsonlSessions.Count -eq $Sessions) -and
    (($ownedQemuAfter.Count + $ownedQemuAfterCleanup.Count) -eq 0)
$failureReasons = @(Get-ProductionRunFailureReasons -HarnessExitCode $exitCode -ExternalBackstop:$hitExternalBackstop `
    -SessionsDumped $dumped -ExpectedSessions $Sessions -JsonlSessions $jsonlSessions.Count `
    -ClassifierSummary $b11Summary -OwnedOrphanCount ($ownedQemuAfter.Count + $ownedQemuAfterCleanup.Count) `
    -ChildInheritanceRequired:$true -ChildInheritanceConfirmed:$childInheritanceConfirmed)
if ($capacityRejectedAsDesigned) {
    # The classifier only knows how to score a cell where every REQUESTED session succeeds, and
    # the harness's own exit code 1 reports exactly this designed refusal -- neither is a runner
    # failure once the narrow detection above has confirmed this is the guard working as intended.
    # Every other potential failure reason (external timeout, orphaned QEMU, incomplete dump/jsonl
    # against what was actually achieved, unproven affinity/priority) still fails the run.
    $failureReasons = @($failureReasons | Where-Object { $_ -notin @("harness_exit_code_$exitCode", 'classifier_cellPass_false') })
}
$runClassification = if ($capacityRejectedAsDesigned) { 'CAPACITY_REJECTED_AS_DESIGNED' } else { $null }

$manifest = [pscustomobject]@{
    schema = 'production_mwdt_run_manifest_v2'
    createdAt = (Get-Date).ToString('o')
    sessions = $Sessions
    runMs = $RunMs
    transport = 'VNEXT_B'
    executionMode = 'MTTCG'
    tracesOperational = if ($enabledDiagnostics.Count -eq 0) { 'off' } else { 'diagnostic' }
    enabledDiagnostics = $enabledDiagnostics
    force = [bool]$Force
    reserveCores = $ReserveCores
    physicalCores = $physicalCores
    logicalCores = $logicalCores
    usableLogicalCores = $usableCores
    vcpusPerSession = 2
    requiredVcpuSlots = $requiredVcpuSlots
    helperThreadsIncludedInSlots = $false
    requestedAffinity = ('0x{0:x}' -f [int64]$affinity)
    harnessProcessorAffinity = if ($null -eq $p.processorAffinity) { $null } else { ('0x{0:x}' -f [int64]$p.processorAffinity) }
    requestedPriority = 'BelowNormal'
    harnessPriority = $p.priorityClass
    qemuChildSamples = $childSamples
    qemuChildSampleCount = $childSamples.Count
    qemuChildAffinityOk = $childAffinityOk
    qemuChildPriorityOk = $childPriorityOk
    qemuChildInheritanceConfirmed = $childInheritanceConfirmed
    qemuBeforePids = $qemuBeforePids
    ownedQemuAfter = $ownedQemuAfter
    stoppedOwnedQemu = $stoppedOwnedQemu
    ownedQemuAfterCleanup = $ownedQemuAfterCleanup
    harnessProcessId = $p.processId
    harnessStartedAt = $p.startedAt
    harnessEndedAt = $p.endedAt
    harnessExitCode = $exitCode
    externalBackstop = $hitExternalBackstop
    failureReasons = $failureReasons
    runnerPass = ($failureReasons.Count -eq 0)
    classification = $runClassification
    expectedChildCount = $expectedChildCount
    outLog = $outLog
    errLog = $errLog
    jsonlLog = $jsonlLog
    summaryLog = if ($null -eq $b11Summary) { $null } else { $summaryLog }
    qemu = $Qemu
    qemuSha256 = Get-ProductionSha256 -Path $Qemu
    firmware = $Firmware
    firmwareSha256 = Get-ProductionSha256 -Path $Firmware
    firmwareElf = $firmwareElf
    firmwareElfSha256 = Get-ProductionSha256 -Path $firmwareElf
    harness = $exe
    harnessSha256 = Get-ProductionSha256 -Path $exe
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestLog -Encoding UTF8

Write-Output "SESSIONS            = $Sessions"
Write-Output "HOST_GUARD          = $usableCores/$totalCores cores, $ReserveCores reserved, BelowNormal"
Write-Output "HOST_TOPOLOGY       = physical=$physicalCores logical=$logicalCores vcpus/session=2 required_slots=$requiredVcpuSlots helper_threads_counted=False"
Write-Output "DIAGNOSTICS         = $(if ($enabledDiagnostics.Count -eq 0) { 'off' } else { $enabledDiagnostics -join ',' })"
Write-Output "AFFINITY_REQUESTED  = $('0x{0:x}' -f [int64]$affinity)"
Write-Output "CHILD_INHERITANCE   = $childInheritanceConfirmed  (samples=$($childSamples.Count), affinityOk=$childAffinityOk, priorityOk=$childPriorityOk)"
Write-Output "WALL_SECONDS        = $([math]::Round($sw.Elapsed.TotalSeconds,1))"
Write-Output "EXIT_CODE           = $(if ($null -eq $exitCode) { '<unavailable>' } else { $exitCode })  (0=clean PASS-eligible, 1=harness-observed FAIL, 2=E120 defensive-timeout exit, other=external backstop kill)"
Write-Output "EXTERNAL_BACKSTOP   = $hitExternalBackstop  (true means even the in-process defensive timeout failed to bound this run -- see EVIDENCE E104/E120)"
Write-Output "SESSIONS_DUMPED     = $dumped / $Sessions"
Write-Output "JSONL_SESSIONS      = $($jsonlSessions.Count) / $Sessions  ($jsonlLog)"
Write-Output "QEMU_LOG_LINES      = $($lines.Count)"
Write-Output "  final-credit      = $fc"
Write-Output "  ackERR            = $ack"
Write-Output "  I2C FIFO empty    = $fifo"
Write-Output "QEMU_SHA256         = $(Get-ProductionSha256 -Path $Qemu)"
Write-Output "FIRMWARE_SHA256     = $(Get-ProductionSha256 -Path $Firmware)"
Write-Output "FIRMWARE_ELF        = $firmwareElf"
Write-Output "FIRMWARE_ELF_SHA256  = $(Get-ProductionSha256 -Path $firmwareElf)"
Write-Output "HARNESS_SHA256      = $(Get-ProductionSha256 -Path $exe)"
Write-Output "ESP32_RESETS_RAW    = $($resetStats.rawLines)"
Write-Output "ESP32_RESETS_DEDUP  = $($resetStats.deduplicated)"
Write-Output "ESP32_RESETS        = $($resetStats.deduplicated)  (deduplicated; raw shown above)"
Write-Output "MWDT_ATTRIB_RESETS  = $($mwdt.Count)"
if ($null -ne $b11Summary) { Write-Output "B11_CELL_PASS       = $($b11Summary.cellPass)" }
Write-Output "RUNNER_PASS         = $($failureReasons.Count -eq 0)"
if ($null -ne $runClassification) { Write-Output "CLASSIFICATION      = $runClassification" }
if ($failureReasons.Count -gt 0) { Write-Output "RUNNER_FAILURES     = $($failureReasons -join ',')" }
Write-Output "MANIFEST            = $manifestLog"
if ($null -ne $b11Summary) { Write-Output "B11_SUMMARY         = $summaryLog" }
Write-Output "LOG                 = $errLog"
if ($mwdt.Count) { Write-Output '--- MWDT resets ---'; $mwdt | Select-Object -First 4 | ForEach-Object { "  $_" } }
if ($failureReasons.Count -gt 0) { exit 1 }
exit 0

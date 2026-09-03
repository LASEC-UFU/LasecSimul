<#
    Focused regression set for a QEMU-side change.  These are the existing Core
    tests that exercise the real QEMU binary, the ESP32 adapter, the arena ABI
    and the I2C fast path - the surface touched by the E102/E103 fixes.

    Host-constrained per DECISION-010: BelowNormal priority and an affinity mask
    that leaves cores free, inherited by every QEMU the tests spawn.
#>
param(
    [int]$ReserveCores = 6,
    [int]$TimeoutSec = 240,
    [string]$Config = 'Debug'
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$bin  = Join-Path $repo "core\build\$Config"
$total = [Environment]::ProcessorCount
$usable = [Math]::Max(2, $total - $ReserveCores)
$affinity = [IntPtr]([int64]((1L -shl $usable) - 1))

foreach ($v in 'LASECSIMUL_TG0_WDT_TRACE','LASECSIMUL_TG1_WDT_TRACE','LASECSIMUL_VNEXT_TRACE',
               'LASECSIMUL_FAILURE_ISOLATION','LASECSIMUL_ESP32_WDT_SCALE','LASECSIMUL_SCALE_SESSIONS',
               'LASECSIMUL_SCALE_RUN_MS','LASECSIMUL_DUMP_SUCCESS_QEMU_LOG','LASECSIMUL_SCALE_PARALLEL_START') {
    [Environment]::SetEnvironmentVariable($v, $null)
}
$env:LASECSIMUL_TEST_FIRMWARE    = Join-Path $repo 'vnext_prototype\guest_i2c_workload\.pio\build\esp32\merged.bin'
$env:LASECSIMUL_TEST_QEMU_BINARY = Join-Path $repo 'vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe'
$env:LASECSIMUL_QEMU_TB_SIZE     = '64'

$tests = @(
 'esp32_adapter_test','qemu_arena_bridge_test','qemu_process_manager_test',
 'qemu_icount_calibrator_test','i2c_fast_path_dispatch_test','mcu_component_test',
 'mcu_controller_real_qemu_test','mcu_crash_resilience_test','scheduler_test','netlist_test'
)
$logDir = Join-Path $repo 'vnext_prototype\regression_runs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$results = @()
foreach ($t in $tests) {
    $exe = Join-Path $bin "$t.exe"
    if (-not (Test-Path $exe)) { $results += [pscustomobject]@{Test=$t;Result='NOT_BUILT';Sec=0}; continue }
    $o = Join-Path $logDir "$t.out"; $e = Join-Path $logDir "$t.err"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    # Start-Process -PassThru does not reliably surface ExitCode when both
    # streams are redirected, so drive System.Diagnostics.Process directly.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.WorkingDirectory = $repo
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    $null = $p.Start()
    try { $p.PriorityClass=[Diagnostics.ProcessPriorityClass]::BelowNormal; $p.ProcessorAffinity=$affinity } catch {}
    # Read both pipes asynchronously; a full pipe would otherwise deadlock the child.
    $so = $p.StandardOutput.ReadToEndAsync()
    $se = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutSec*1000)) { $p.Kill(); $p.WaitForExit(); $r = 'TIMEOUT'; $code = $null }
    else { $code = $p.ExitCode; $r = if ($code -eq 0) { 'PASS' } else { "FAIL($code)" } }
    Set-Content -Path $o -Value $so.Result -Encoding UTF8
    Set-Content -Path $e -Value $se.Result -Encoding UTF8
    Get-Process qemu-system-xtensa -ErrorAction SilentlyContinue | Stop-Process -Force
    $results += [pscustomobject]@{Test=$t;Result=$r;Sec=[math]::Round($sw.Elapsed.TotalSeconds,1)}
}
$results | Format-Table -AutoSize
"PASS=$(@($results|Where-Object{$_.Result -eq 'PASS'}).Count) of $(@($results|Where-Object{$_.Result -ne 'NOT_BUILT'}).Count) runnable"

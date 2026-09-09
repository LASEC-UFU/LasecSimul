<#
    Focused regression set for a QEMU-side change.  These are the existing Core
    tests that exercise the real QEMU binary, the ESP32 adapter, the arena ABI
    and the I2C fast path - the surface touched by the E102/E103 fixes.

    Host-constrained per DECISION-010: BelowNormal priority and an affinity mask
    that leaves cores free, inherited by every QEMU the tests spawn.

    Transport and execution mode are explicit (PLAN_MTTCG_VNEXT_B_CAUSALITY.md
    section 7.1): every run materializes exactly one of the six
    Transport x ExecutionMode cells, prints it in the header, and never lets a
    result's transport/mode stay implicit.
#>
param(
    [int]$ReserveCores = 6,
    [int]$TimeoutSec = 240,
    [string]$Config = 'Debug',
    [string]$BuildDir = '',
    [ValidateSet('LEGACY','VNEXT_B')]
    [string]$Transport = 'LEGACY',
    [ValidateSet('MTTCG','SINGLE_REALTIME','ICOUNT')]
    [string]$ExecutionMode = 'MTTCG',
    [string]$RunId = '',
    # E118-AUDIT (EVIDENCE.md, 2026-09-05): lets a not-yet-promoted candidate be regression-tested
    # against the same 13-test set before it replaces the canonical runtime. Empty (default) keeps
    # the canonical dev_qemu_runtime path exactly as before this parameter existed.
    [string]$QemuBinary = ''
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if (-not $BuildDir) { $BuildDir = Join-Path $repo 'core\build' }
$bin  = Join-Path $BuildDir $Config
$total = [Environment]::ProcessorCount
$usable = [Math]::Max(2, $total - $ReserveCores)
$affinity = [IntPtr]([int64]((1L -shl $usable) - 1))
if (-not $RunId) { $RunId = Get-Date -Format 'yyyyMMdd_HHmmss' }

foreach ($v in 'LASECSIMUL_TG0_WDT_TRACE','LASECSIMUL_TG1_WDT_TRACE','LASECSIMUL_VNEXT_TRACE',
               'LASECSIMUL_FAILURE_ISOLATION','LASECSIMUL_ESP32_WDT_SCALE','LASECSIMUL_SCALE_SESSIONS',
               'LASECSIMUL_SCALE_RUN_MS','LASECSIMUL_DUMP_SUCCESS_QEMU_LOG','LASECSIMUL_SCALE_PARALLEL_START',
               'LASECSIMUL_XTENSA_PC_SAMPLER','LASECSIMUL_MWDT_ACCOUNTING','LASECSIMUL_CACHE_TRACE',
               'LASECSIMUL_LANE0_DIAG','LASECSIMUL_UART_DISABLE_CORE_NOTIFY','LASECSIMUL_WDT_CAUSAL_TRACE',
               'LASECSIMUL_APP_CPU_RESET_TRACE','LASECSIMUL_P9_DIAGNOSTIC',
               'LASECSIMUL_MCU_TRANSPORT','LASECSIMUL_ESP32_EXECUTION_MODE',
               'LASECSIMUL_QEMU_TCG_THREAD','LASECSIMUL_QEMU_ICOUNT_SHIFT',
               'LASECSIMUL_ESP32_ICOUNT_SHIFT',
               # B11 Fase 1 (EVIDENCE.md, 2026-09-05): the E122/E126 causal tracers and E123's
               # teardown trace must be off for any formal measurement run -- added here so a
               # variable left set in the calling shell from a prior diagnostic session cannot leak
               # into a regression/B11 run.
               'LASECSIMUL_PANIC_CAUSAL_TRACE','LASECSIMUL_RTC_SYS_RESET_CAUSAL_TRACE',
               'LASECSIMUL_CACHE_TRACE_DIR','LASECSIMUL_TEARDOWN_TRACE','LASECSIMUL_FLASH_WRITE_TRACE',
               'LASECSIMUL_SCALE_SCHEDULER_METRICS') {
    Remove-Item "Env:$v" -ErrorAction SilentlyContinue
}
$env:LASECSIMUL_TEST_FIRMWARE    = Join-Path $repo 'vnext_prototype\guest_i2c_workload\.pio\build\esp32\merged.bin'
$env:LASECSIMUL_TEST_QEMU_BINARY = if ($QemuBinary) { $QemuBinary } else { Join-Path $repo 'vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe' }
$env:LASECSIMUL_QEMU_TB_SIZE     = '64'

# Materialize exactly one configuration per cell -- never leave transport/mode implicit.
switch ($ExecutionMode) {
    'MTTCG'           { $env:LASECSIMUL_ESP32_EXECUTION_MODE = 'mttcg' }
    'SINGLE_REALTIME' { $env:LASECSIMUL_ESP32_EXECUTION_MODE = 'mttcg'; $env:LASECSIMUL_QEMU_TCG_THREAD = 'single' }
    'ICOUNT'          { $env:LASECSIMUL_ESP32_EXECUTION_MODE = 'deterministic' }
}
if ($Transport -eq 'VNEXT_B') { $env:LASECSIMUL_MCU_TRANSPORT = 'VNEXT_B' }
# LEGACY: LASECSIMUL_MCU_TRANSPORT stays absent -- that is the compatible current contract.

$runtimeSha = (Get-FileHash $env:LASECSIMUL_TEST_QEMU_BINARY -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
Write-Output "RUN_ID          = $RunId"
Write-Output "TRANSPORT       = $Transport"
Write-Output "EXECUTION_MODE  = $ExecutionMode"
Write-Output "AFFINITY        = $usable/$total cores usable, $ReserveCores reserved, BelowNormal"
Write-Output "FIRMWARE        = $env:LASECSIMUL_TEST_FIRMWARE"
Write-Output "QEMU_RUNTIME    = $env:LASECSIMUL_TEST_QEMU_BINARY"
Write-Output "QEMU_RUNTIME_SHA256 = $runtimeSha"

$tests = @(
 'esp32_adapter_test','qemu_arena_bridge_test','qemu_process_manager_test',
 'qemu_icount_calibrator_test','i2c_fast_path_dispatch_test','mcu_component_test',
 'mcu_controller_real_qemu_test','mcu_crash_resilience_test','scheduler_test','netlist_test',
 'mcu_multiple_controllers_real_qemu_test','mcu_restart_stress_test',
 'mcu_scheduler_pacing_sync_real_qemu_test',
 'drain_cutoff_gate_test'
)
$logDir = Join-Path $repo "vnext_prototype\regression_runs\${Transport}_${ExecutionMode}_${RunId}"
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
$passed = @($results | Where-Object { $_.Result -eq 'PASS' }).Count
$runnable = @($results | Where-Object { $_.Result -ne 'NOT_BUILT' }).Count
$failed = @($results | Where-Object { $_.Result -ne 'PASS' }).Count
"PASS=$passed of $runnable runnable"
if ($failed -gt 0) {
    "FAILED=$failed"
    exit 1
}
exit 0

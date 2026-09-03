<#
    Runs the production VNEXT_B scale harness and classifies MWDT-attributed
    resets and QEMU log volume.  This is the E102 experiment: the fed Arduino
    I2C workload driven by a real Core session.

    HOST SAFETY (DECISION-010).  The harness spawns one QEMU per session and
    each one holds cores at 100%.  Child processes inherit the parent's
    processor-affinity mask and priority class on Windows, so constraining the
    harness constrains the whole tree.  Reserved cores stay free for the OS;
    an unconstrained 16-session run is what froze this host on 2026-09-03.
#>
param(
    [Parameter(Mandatory=$true)][int]$Sessions,
    [int]$RunMs = 60000,
    [int]$ReserveCores = 6,
    [string]$Firmware,
    [string]$Qemu,
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if (-not $Firmware) { $Firmware = Join-Path $repo 'vnext_prototype\guest_i2c_workload\.pio\build\esp32\merged.bin' }
if (-not $Qemu)     { $Qemu     = Join-Path $repo 'vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe' }
if (-not $OutDir)   { $OutDir   = Join-Path $repo 'vnext_prototype\production_mwdt_runs' }
$exe = Join-Path $repo 'core\build\Release\vnext_b_production_scale_test.exe'
foreach ($p in @($exe,$Firmware,$Qemu)) { if (-not (Test-Path $p)) { throw "missing: $p" } }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$totalCores  = [Environment]::ProcessorCount
$usableCores = [Math]::Max(2, $totalCores - $ReserveCores)
$affinity    = [IntPtr]([int64]((1L -shl $usableCores) - 1))

# Traces off: E099 measured ~2 s per emitted diagnostic line on this host.
foreach ($v in 'LASECSIMUL_TG0_WDT_TRACE','LASECSIMUL_TG1_WDT_TRACE','LASECSIMUL_VNEXT_TRACE',
               'LASECSIMUL_FAILURE_ISOLATION','LASECSIMUL_ESP32_WDT_SCALE','LASECSIMUL_I2C_FASTPATH_TRACE') {
    [Environment]::SetEnvironmentVariable($v, $null)
}
$env:LASECSIMUL_SCALE_SESSIONS       = "$Sessions"
$env:LASECSIMUL_SCALE_RUN_MS         = "$RunMs"
$env:LASECSIMUL_SCALE_PARALLEL_START = '1'
$env:LASECSIMUL_MCU_TRANSPORT        = 'VNEXT_B'
$env:LASECSIMUL_QEMU_TB_SIZE         = '64'
$env:LASECSIMUL_TEST_FIRMWARE        = $Firmware
$env:LASECSIMUL_TEST_QEMU_BINARY     = $Qemu
$env:LASECSIMUL_DUMP_SUCCESS_QEMU_LOG = '1'

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$errLog = Join-Path $OutDir "prod_n${Sessions}_$stamp.err"
$outLog = Join-Path $OutDir "prod_n${Sessions}_$stamp.out"

$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $exe -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
try {
    $p.PriorityClass     = [Diagnostics.ProcessPriorityClass]::BelowNormal
    $p.ProcessorAffinity = $affinity
} catch { Write-Warning "could not constrain harness: $($_.Exception.Message)" }

# The harness hangs in stopSimulation() teardown for Sessions > 1 (pre-existing;
# reproduced on the pre-patch binary too).  Everything this experiment needs -
# the per-session counters and the full QEMU log of every session - is written
# to stderr by the measurement loop *before* teardown starts, so wait for the
# last session's dump and then stop the process.  stdout stays block-buffered
# and is lost on kill, which is why nothing is read from it.
$deadline = $RunMs + 420000
$sw2 = [Diagnostics.Stopwatch]::StartNew()
$measured = $false
while (-not $p.HasExited -and $sw2.Elapsed.TotalMilliseconds -lt $deadline) {
    Start-Sleep -Seconds 3
    $done = @(Select-String -Path $errLog -SimpleMatch 'SUCCESS_QEMU_LOG_END' -ErrorAction SilentlyContinue).Count
    if ($done -ge $Sessions) { $measured = $true; break }
}
$hungInTeardown = (-not $p.HasExited) -and $measured
if (-not $p.HasExited) { $p.Kill(); $p.WaitForExit() }
$killed = -not $measured
Get-Process qemu-system-xtensa -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 1500

$lines = @(Get-Content $errLog -ErrorAction SilentlyContinue)
$fc    = @($lines | Where-Object { $_ -match 'final-credit' }).Count
$ack   = @($lines | Where-Object { $_ -match 'ackERR' }).Count
$fifo  = @($lines | Where-Object { $_ -match 'read I2C FIFO while it is empty' }).Count
$resets = @($lines | Where-Object { $_ -match '\[ESP32 reset\]' })
$mwdt   = @($resets | Where-Object { $_ -match 'source=MWDT_SYS_STAGE|source=MWDT_CPU_STAGE' })
$dumped = @($lines | Where-Object { $_ -match 'SUCCESS_QEMU_LOG_BEGIN' }).Count

Write-Output "SESSIONS            = $Sessions"
Write-Output "HOST_GUARD          = $usableCores/$totalCores cores, $ReserveCores reserved, BelowNormal"
Write-Output "WALL_SECONDS        = $([math]::Round($sw.Elapsed.TotalSeconds,1))$(if($killed){' (KILLED)'})"
Write-Output "MEASUREMENT         = $(if($measured){'COMPLETE'}else{'INCOMPLETE'})"
Write-Output "TEARDOWN_HANG       = $hungInTeardown  (pre-existing, Sessions>1; see EVIDENCE E104)"
Write-Output "SESSIONS_DUMPED     = $dumped / $Sessions"
Write-Output "QEMU_LOG_LINES      = $($lines.Count)"
Write-Output "  final-credit      = $fc"
Write-Output "  ackERR            = $ack"
Write-Output "  I2C FIFO empty    = $fifo"
Write-Output "ESP32_RESETS        = $($resets.Count)"
Write-Output "MWDT_ATTRIB_RESETS  = $($mwdt.Count)"
Write-Output "LOG                 = $errLog"
if ($mwdt.Count) { Write-Output '--- MWDT resets ---'; $mwdt | Select-Object -First 4 | ForEach-Object { "  $_" } }

<#
    Runs one bare-metal MWDT fixture variant directly on the canonical QEMU and
    prints a compact classification of the watchdog trace.

    This is a *device-level* oracle: no Core, no arena, no VNEXT_B session.  It
    answers "does the modeled MWDT expire and route its reset when unfed, and
    stay quiet when fed", which is the precondition every previous MWDT
    experiment lacked (evidence E060-E063).

    -Trace 0 keeps the opt-in TG watchdog diagnostics off.  The unconditional
    "[LasecSimul][ESP32 reset]" line still identifies every reset and its
    source, so reset classification stays valid while per-operation diagnostic
    I/O -- a documented timing hazard -- is out of the measurement.
#>
param(
    [Parameter(Mandatory=$true)][string]$Variant,
    [int]$Seconds = 40,
    [int]$WdtScale = 1,
    [int]$Trace = 1,
    [string]$Qemu,
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'

# Default parameter values cannot reference $PSScriptRoot reliably when the
# script is invoked with -File, so resolve every path from the script location.
$root = Split-Path -Parent $PSCommandPath
if (-not $Qemu)   { $Qemu   = Join-Path $root '..\dev_qemu_runtime\qemu-system-xtensa.exe' }
if (-not $OutDir) { $OutDir = Join-Path $root 'runs' }

$elf = Join-Path (Join-Path $root 'build') "mwdt_$Variant.elf"
if (-not (Test-Path $elf))  { throw "variant not built: $elf" }
if (-not (Test-Path $Qemu)) { throw "qemu not found: $Qemu" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$err = Join-Path $OutDir "${Variant}_t${Trace}_s${WdtScale}_$stamp.err"
$out = Join-Path $OutDir "${Variant}_t${Trace}_s${WdtScale}_$stamp.out"

if ($Trace -ne 0) {
    $env:LASECSIMUL_TG0_WDT_TRACE = '1'
    $env:LASECSIMUL_TG1_WDT_TRACE = '1'
} else {
    Remove-Item Env:LASECSIMUL_TG0_WDT_TRACE -ErrorAction SilentlyContinue
    Remove-Item Env:LASECSIMUL_TG1_WDT_TRACE -ErrorAction SilentlyContinue
}
$env:LASECSIMUL_ESP32_WDT_SCALE = "$WdtScale"

$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $Qemu -PassThru -RedirectStandardError $err -RedirectStandardOutput $out `
     -ArgumentList @('-M','esp32-simul','-display','none','-kernel',$elf,'-accel','tcg,thread=multi')
# The fixture guest never idles, so its vCPU thread pegs a core for the whole
# window.  Idle priority keeps the interactive session ahead of it.
try { $p.PriorityClass = [Diagnostics.ProcessPriorityClass]::Idle } catch {
    Write-Warning "could not lower priority of PID $($p.Id): $($_.Exception.Message)"
}
Start-Sleep -Seconds $Seconds
if (-not $p.HasExited) { $p.Kill(); $p.WaitForExit() }
$wall = $sw.Elapsed.TotalSeconds
Start-Sleep -Milliseconds 700

$lines = (Get-Content $err -ErrorAction SilentlyContinue)
$tg = if ($Variant -like 'tg1*') { 'TG1' } else { 'TG0' }

$expire     = @($lines | Where-Object { $_ -match "\[${tg}WDT\] EXPIRE" })
$resets     = @($lines | Where-Object { $_ -match '\[ESP32 reset\]' })
$mwdtResets = @($resets | Where-Object { $_ -match 'source=MWDT_SYS_STAGE|source=MWDT_CPU_STAGE' })

Write-Output "VARIANT           = $Variant"
Write-Output "TRACE             = $Trace"
Write-Output "WDT_SCALE         = $WdtScale"
Write-Output "WALL_SECONDS      = $([math]::Round($wall,1))"
Write-Output "${tg}_CONFIG       = $(@($lines | Where-Object { $_ -match "\[${tg}WDT\] config" }).Count)"
Write-Output "${tg}_FEED         = $(@($lines | Where-Object { $_ -match "\[${tg}WDT\] feed" }).Count)"
Write-Output "${tg}_ARM          = $(@($lines | Where-Object { $_ -match "\[${tg}WDT\] arm" }).Count)"
Write-Output "${tg}_EXPIRE       = $($expire.Count)"
Write-Output "ESP32_RESETS      = $($resets.Count)"
Write-Output "MWDT_ATTRIB_RESET = $($mwdtResets.Count)"
Write-Output "LOG               = $err"
if ($expire.Count)     { Write-Output '--- EXPIRE (first 4) ---';       $expire     | Select-Object -First 4 | ForEach-Object { "  $_" } }
if ($mwdtResets.Count) { Write-Output '--- MWDT resets (first 4) ---';  $mwdtResets | Select-Object -First 4 | ForEach-Object { "  $_" } }

<#
    ESP32_MWDT_LOAD_INDEPENDENCE oracle.

    Launches N concurrent canonical-QEMU instances of one bare-metal fixture
    variant and reports MWDT-attributed resets per instance.  A fed guest must
    show zero MWDT resets at every population; an unfed guest must keep
    resetting.  If a fed guest starts resetting only as N grows, the modeled
    watchdog is measuring host scheduling instead of guest virtual time.

    Diagnostics stay off: per-operation stderr writes cost ~2 s per line on
    this host and would dominate any timing measurement.

    HOST SAFETY.  The fixture guest is a tight infinite loop, so every vCPU
    thread pegs a core at 100% and never yields.  Launching one QEMU per core
    (or more) starves the interactive session: on 2026-09-03 a 32-instance run
    on a 32-core host froze the machine and forced a power-off, which corrupted
    an in-flight build.  This runner therefore reserves cores for the OS, drops
    every QEMU to Idle priority, and refuses populations that would oversubscribe
    the host unless -Force is given.
#>
param(
    [Parameter(Mandatory=$true)][string]$Variant,
    [int]$Sessions = 16,
    [int]$Seconds = 60,
    [int]$WdtScale = 1,
    [string]$Qemu,
    [string]$OutDir,
    # Logical cores kept free for the interactive session and the OS.
    [int]$ReserveCores = 6,
    # Allow a population that oversubscribes the usable cores.  Do not use this
    # on a machine anyone is sitting at.
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
if (-not $Qemu)   { $Qemu   = Join-Path $root '..\dev_qemu_runtime\qemu-system-xtensa.exe' }
if (-not $OutDir) { $OutDir = Join-Path $root 'runs' }

$elf = Join-Path (Join-Path $root 'build') "mwdt_$Variant.elf"
if (-not (Test-Path $elf)) { throw "variant not built: $elf" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Remove-Item Env:LASECSIMUL_TG0_WDT_TRACE -ErrorAction SilentlyContinue
Remove-Item Env:LASECSIMUL_TG1_WDT_TRACE -ErrorAction SilentlyContinue
$env:LASECSIMUL_ESP32_WDT_SCALE = "$WdtScale"

# Only CPU0 executes in this fixture (CPU1 stays in ROM), so budget one core
# per instance against the cores we are willing to use.  The affinity mask below
# is the real protection: whatever the guests do, the reserved cores stay free.
$totalCores  = [Environment]::ProcessorCount
$usableCores = [Math]::Max(2, $totalCores - $ReserveCores)
if ($Sessions -gt $usableCores -and -not $Force) {
    throw ("$Sessions sessions exceed the $usableCores usable cores of $totalCores " +
           "($ReserveCores reserved for the OS). Lower -Sessions, lower -ReserveCores, " +
           "or pass -Force if this host is unattended.")
}
# Confine the guests to the low cores; the reserved high cores stay free so the
# session, the input stack and the display always have somewhere to run.
$affinity = [IntPtr]([int64]((1L -shl $usableCores) - 1))
Write-Output ("HOST_GUARD         = $Sessions sessions, $usableCores/$totalCores cores usable, " +
              "$ReserveCores reserved, priority Idle")

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$procs = @()
$logs  = @()
for ($i = 0; $i -lt $Sessions; $i++) {
    $err = Join-Path $OutDir "scale_${Variant}_n${Sessions}_${i}_$stamp.err"
    $logs += $err
    $p = Start-Process -FilePath $Qemu -PassThru -RedirectStandardError $err `
        -RedirectStandardOutput (Join-Path $OutDir "scale_${Variant}_n${Sessions}_${i}_$stamp.out") `
        -ArgumentList @('-M','esp32-simul','-display','none','-kernel',$elf,'-accel','tcg,thread=multi')
    try {
        $p.PriorityClass       = [Diagnostics.ProcessPriorityClass]::Idle
        $p.ProcessorAffinity   = $affinity
    } catch {
        Write-Warning "could not constrain PID $($p.Id): $($_.Exception.Message)"
    }
    $procs += $p
}

Start-Sleep -Seconds $Seconds
$alive = @($procs | Where-Object { -not $_.HasExited }).Count
foreach ($p in $procs) { if (-not $p.HasExited) { $p.Kill() } }
foreach ($p in $procs) { $p.WaitForExit() }
Start-Sleep -Milliseconds 1200

$perInstance = @()
$totalMwdt = 0
foreach ($l in $logs) {
    $lines = Get-Content $l -ErrorAction SilentlyContinue
    $m = @($lines | Where-Object { $_ -match 'source=MWDT_SYS_STAGE|source=MWDT_CPU_STAGE' }).Count
    $perInstance += $m
    $totalMwdt += $m
}

Write-Output "VARIANT            = $Variant"
Write-Output "SESSIONS           = $Sessions"
Write-Output "WINDOW_SECONDS     = $Seconds"
Write-Output "WDT_SCALE          = $WdtScale"
Write-Output "ALIVE_AT_END       = $alive / $Sessions"
Write-Output "MWDT_RESETS_TOTAL  = $totalMwdt"
Write-Output "MWDT_RESETS_PER_QEMU = $($perInstance -join ',')"
Write-Output "INSTANCES_WITH_MWDT_RESET = $(@($perInstance | Where-Object { $_ -gt 0 }).Count)"

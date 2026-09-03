<#
    Builds the bare-metal MWDT fixture variants.

    Requires only the xtensa toolchain that ships with the repo-local
    PlatformIO package set.  No Python, no ESP-IDF, no PlatformIO runtime:
    that dependency chain is what blocked evidence E063-E096 for ~30
    orchestrator iterations without producing any watchdog evidence.
#>
param(
    [string]$Toolchain = "$PSScriptRoot\..\..\.piohome\packages\toolchain-xtensa-esp32\bin",
    [string]$OutDir    = "$PSScriptRoot\build"
)

$ErrorActionPreference = 'Stop'

$gcc = Join-Path $Toolchain 'xtensa-esp32-elf-gcc.exe'
if (-not (Test-Path $gcc)) { throw "xtensa-esp32-elf-gcc not found at $gcc" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# TIMER_GROUP0 = 0x3ff5f000 (main system MWDT, receives VNEXT transport-pause
# compensation).  TIMER_GROUP1 = 0x3ff60000 (MWDT1, uncompensated control).
$groups = @(
    @{ Name = 'tg0'; Hi = '0x3ff5'; Lo = '0xf000' },
    @{ Name = 'tg1'; Hi = '0x3ff6'; Lo = '0x0000' }
)

# PRESCALE 40000 against the 40 MHz APB clock gives a 1 kHz watchdog tick, so
# stage timeouts below are expressed directly in milliseconds.
$prescale = 40000

# 'fed_then_starve' is the validity probe for the fed case: it feeds a bounded
# number of times and then stops.  A run that produces no reset at all proves
# the guest never armed the watchdog, so a fed-guest "zero resets" result can be
# distinguished from a guest that never executed.
$variants = @(
    @{ Name = 'fed';             Feed = 1; Count = 0;    Stg0Mode = 3; Stg1Mode = 0; Stg0 = 1000; Stg1 = 0 },
    @{ Name = 'unfed';           Feed = 0; Count = 0;    Stg0Mode = 3; Stg1Mode = 0; Stg0 = 1000; Stg1 = 0 },
    @{ Name = 'fed_then_starve'; Feed = 1; Count = 3000; Stg0Mode = 3; Stg1Mode = 0; Stg0 = 1000; Stg1 = 0 },
    @{ Name = 'staged_unfed';    Feed = 0; Count = 0;    Stg0Mode = 1; Stg1Mode = 3; Stg0 = 500;  Stg1 = 1000 }
)

foreach ($g in $groups) {
    foreach ($v in $variants) {
        $elf = Join-Path $OutDir "mwdt_$($g.Name)_$($v.Name).elf"
        $defs = @(
            "--defsym", "TG_BASE_HI=$($g.Hi)",
            "--defsym", "TG_BASE_LO=$($g.Lo)",
            "--defsym", "FEED_ENABLED=$($v.Feed)",
            "--defsym", "STG0_MODE=$($v.Stg0Mode)",
            "--defsym", "STG1_MODE=$($v.Stg1Mode)",
            "--defsym", "STG0_TICKS=$($v.Stg0)",
            "--defsym", "STG1_TICKS=$($v.Stg1)",
            "--defsym", "PRESCALE=$prescale",
            "--defsym", "FEED_COUNT=$($v.Count)",
            "--defsym", "FEED_BUDGET=$(if ($v.Count -gt 0) { $v.Count } else { 1 })",
            "--defsym", "FEED_DELAY=200000"
        ) | ForEach-Object { "-Wa,$_" }

        & $gcc -nostdlib -nostartfiles -nodefaultlibs -mlongcalls `
            @defs `
            "-Wl,-T,$PSScriptRoot\link.ld,--gc-sections" `
            -o $elf "$PSScriptRoot\mwdt.S"
        if ($LASTEXITCODE -ne 0) { throw "build failed for $elf" }
        Write-Output "built $elf"
    }
}

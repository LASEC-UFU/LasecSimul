param(
    [Parameter(Mandatory=$true)][string]$Firmware,
    [string]$Project,
    [switch]$DisconnectPlot,
    [string]$QemuBinary,
    [ValidateRange(8,120)][int]$DurationSeconds = 30
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$test = Join-Path $repo 'core/build/Release/mcu_firmware_lasecplot_test.exe'
if (!$QemuBinary) { $QemuBinary = Join-Path $repo 'devices/qemu-esp32/bin/qemu-system-xtensa.exe' }
foreach ($file in @($Firmware, $QemuBinary, $test)) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Arquivo ausente: $file" }
}
$settings = @{
    LASECSIMUL_MCU_TRANSPORT = 'VNEXT_B'
    LASECSIMUL_ESP32_EXECUTION_MODE = 'mttcg'
    LASECSIMUL_TEST_FIRMWARE = (Resolve-Path -LiteralPath $Firmware).Path
    LASECSIMUL_TEST_QEMU_BINARY = (Resolve-Path -LiteralPath $QemuBinary).Path
    LASECSIMUL_TEST_EXPECTED_LINE = 'LED alternado'
    LASECSIMUL_TEST_DURATION_SECONDS = "$DurationSeconds"
    LASECSIMUL_TEST_GDB_PORT = $null
    LASECSIMUL_VNEXT_B_SYNTHETIC_MMIO = $null
    LASECSIMUL_VNEXT_TRACE = $null
    LASECSIMUL_QEMU_TCG_THREAD = $null
    LASECSIMUL_BENCHMARK_EXPECTED_LINE = 'LED alternado'
    LASECSIMUL_BENCHMARK_PROBE_TRACE = '1'
    LASECSIMUL_BENCHMARK_COMPACT = '1'
    LASECSIMUL_BENCHMARK_GDB_PORT = $null
    LASECSIMUL_BENCHMARK_DISCONNECT_PLOT = $(if ($DisconnectPlot) { '1' } else { $null })
    LASECSIMUL_NETWORK_MODE = 'disabled'
}
$saved = @{}
try {
    foreach ($key in $settings.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
    }
    $firmwareStream = [System.IO.File]::Open($Firmware, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try { Get-FileHash -InputStream $firmwareStream -Algorithm SHA256 | Format-List }
    finally { $firmwareStream.Dispose() }
    Get-FileHash -LiteralPath $QemuBinary -Algorithm SHA256 | Format-List
    if ($Project) {
        if (!(Test-Path -LiteralPath $Project -PathType Leaf)) { throw "Projeto ausente: $Project" }
        if ((Resolve-Path -LiteralPath $QemuBinary).Path -ine (Resolve-Path -LiteralPath (Join-Path $repo 'devices/qemu-esp32/bin/qemu-system-xtensa.exe')).Path) {
            throw 'O teste de projeto completo usa o QEMU empacotado neste workspace.'
        }
        & node (Join-Path $PSScriptRoot 'benchmark-real-esp32.mjs') $Project $Firmware ($DurationSeconds * 1000) (Join-Path $repo 'core/build/Release/lasecsimul-core.exe') true 1
    } else {
        & $test
    }
    $result = $LASTEXITCODE
} finally {
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
}
exit $result

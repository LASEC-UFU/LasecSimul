[CmdletBinding()]
param(
    [string]$QemuSource = 'C:\SourceCode\qemu_lasecSimul',
    [string]$MsysRoot = 'C:\SourceCode\tools\msys64'
)

$ErrorActionPreference = 'Stop'

function Convert-ToMsysPath([string]$WindowsPath) {
    $resolved = (Resolve-Path -LiteralPath $WindowsPath).Path
    if ($resolved -notmatch '^([A-Za-z]):\\(.*)$') {
        throw "Caminho Windows nao suportado pelo MSYS2: $resolved"
    }
    return "/$($Matches[1].ToLower())/$($Matches[2].Replace('\', '/'))"
}

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$qemuRoot = (Resolve-Path -LiteralPath $QemuSource).Path
$msys = (Resolve-Path -LiteralPath $MsysRoot).Path
$buildDir = Join-Path $qemuRoot 'build-ucrt64'
$configHost = Join-Path $buildDir 'config-host.mak'
$configStatus = Join-Path $buildDir 'config.status'
$bash = Join-Path $msys 'usr\bin\bash.exe'
$toolchainBin = Join-Path $msys 'ucrt64\bin'
$builtExe = Join-Path $buildDir 'qemu-system-xtensa.exe'
$stageDir = Join-Path $qemuRoot 'run-ucrt64'
$deployDir = Join-Path $projectRoot 'devices\qemu-esp32\bin'

foreach ($required in @(
    (Join-Path $qemuRoot '.git'),
    $configHost,
    $configStatus,
    $bash,
    $toolchainBin,
    $deployDir
)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Dependencia obrigatoria ausente: $required"
    }
}

$sourcePathLine = Select-String -LiteralPath $configHost -Pattern '^SRC_PATH=(.+)$'
if (-not $sourcePathLine) {
    throw "SRC_PATH ausente em $configHost"
}
$configuredSource = $sourcePathLine.Matches[0].Groups[1].Value.Trim()
$expectedSource = Convert-ToMsysPath $qemuRoot
if ($configuredSource -ne $expectedSource) {
    throw "Build recusado: SRC_PATH=$configuredSource, esperado $expectedSource"
}

$configureCommand = Get-Content -LiteralPath $configStatus -Raw
if ($configureCommand -notmatch "'--enable-slirp'") {
    throw "Build recusado: $configStatus nao habilita libslirp"
}

$trackedChanges = & git -C $qemuRoot status --porcelain --untracked-files=no
if ($LASTEXITCODE -ne 0) {
    throw 'Nao foi possivel verificar o estado Git do QEMU'
}
if ($trackedChanges) {
    throw "Build recusado: ha alteracoes rastreadas nao preservadas no QEMU:`n$trackedChanges"
}

$env:MSYSTEM = 'UCRT64'
$buildDirMsys = Convert-ToMsysPath $buildDir
& $bash --login -c "cd '$buildDirMsys' && ninja qemu-system-xtensa.exe"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $builtExe)) {
    throw "Falha ao compilar $builtExe"
}

New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

$runtimeFiles = @(
    'libbz2-1.dll',
    'libffi-8.dll',
    'libgcc_s_seh-1.dll',
    'libgcrypt-20.dll',
    'libgio-2.0-0.dll',
    'libglib-2.0-0.dll',
    'libgmodule-2.0-0.dll',
    'libgobject-2.0-0.dll',
    'libgpg-error-0.dll',
    'libiconv-2.dll',
    'libintl-8.dll',
    'libncursesw6.dll',
    'libpcre2-8-0.dll',
    'libpixman-1-0.dll',
    'libslirp-0.dll',
    'libwinpthread-1.dll',
    'libzstd.dll',
    'zlib1.dll'
)

Copy-Item -LiteralPath $builtExe -Destination (Join-Path $stageDir 'qemu-system-xtensa.exe') -Force
foreach ($runtimeFile in $runtimeFiles) {
    $runtimeSource = Join-Path $toolchainBin $runtimeFile
    if (-not (Test-Path -LiteralPath $runtimeSource)) {
        throw "DLL obrigatoria ausente no toolchain: $runtimeSource"
    }
    Copy-Item -LiteralPath $runtimeSource -Destination (Join-Path $stageDir $runtimeFile) -Force
}

foreach ($runtimeFile in @('qemu-system-xtensa.exe') + $runtimeFiles) {
    Copy-Item -LiteralPath (Join-Path $stageDir $runtimeFile) `
        -Destination (Join-Path $deployDir $runtimeFile) -Force
}

$commit = (& git -C $qemuRoot rev-parse HEAD).Trim()
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $builtExe).Hash
$provenance = @"
QEMU source: $qemuRoot
QEMU commit: $commit
Build directory: $buildDir
Configure: xtensa-softmmu, gcrypt, slirp
Executable SHA-256: $hash
"@
$provenancePath = Join-Path $deployDir 'BUILD-PROVENANCE.txt'
Set-Content -LiteralPath $provenancePath -Value $provenance -Encoding ASCII

$deployedHash = (Get-FileHash -Algorithm SHA256 `
    -LiteralPath (Join-Path $deployDir 'qemu-system-xtensa.exe')).Hash
if ($deployedHash -ne $hash) {
    throw "Hash divergente depois da implantacao: build=$hash deploy=$deployedHash"
}

Write-Host "QEMU oficial compilado e implantado: $commit"
Write-Host "SHA-256: $hash"
Write-Host "Destino: $deployDir"

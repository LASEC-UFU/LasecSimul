[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $TdpsSourceRoot,
    [int] $Width = 640
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $repoRoot '.spec/fixtures/tdps-v771-library.json') -Raw | ConvertFrom-Json
$destination = Join-Path $repoRoot 'subcircuits/tdps-reference-images'
New-Item -ItemType Directory -Force -Path $destination | Out-Null

foreach ($entry in $manifest.entries) {
    $source = Join-Path $TdpsSourceRoot ($entry.bitmap -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Bitmap TDPS ausente: $source" }
    $output = Join-Path $destination (($entry.file -replace '\.lssubcircuit$', '.png'))
    $inputImage = [Drawing.Image]::FromFile($source)
    try {
        $height = [Math]::Max(1, [Math]::Round($inputImage.Height * $Width / $inputImage.Width))
        $bitmap = New-Object Drawing.Bitmap($Width, $height)
        try {
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.DrawImage($inputImage, 0, 0, $Width, $height)
                $bitmap.Save($output, [Drawing.Imaging.ImageFormat]::Png)
            } finally { $graphics.Dispose() }
        } finally { $bitmap.Dispose() }
    } finally { $inputImage.Dispose() }
    Write-Host "[tdps-image] $($entry.bitmap) -> $(Split-Path -Leaf $output)"
}

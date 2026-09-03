$ErrorActionPreference = 'Stop'
$tool = 'C:\Users\josuemorais\.platformio\packages\toolchain-xtensa-esp32\bin'
$out = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$elf = Join-Path $out 'guest_i2c_baremetal.elf'
$args = @('-nostdlib', '-nostartfiles', '-nodefaultlibs', '-mlongcalls', "-Wl,-T,$(Join-Path $PSScriptRoot 'linker.ld'),--gc-sections", '-o', $elf, (Join-Path $PSScriptRoot 'entry.S'))
& (Join-Path $tool 'xtensa-esp32-elf-gcc.exe') @args
if ($LASTEXITCODE -ne 0) { throw 'Xtensa bare-metal link failed' }
& (Join-Path $tool 'xtensa-esp32-elf-objcopy.exe') -O binary --pad-to 0x200000 --gap-fill 0xff $elf (Join-Path $out 'guest_i2c_baremetal.bin')
if ($LASTEXITCODE -ne 0) { throw 'Xtensa bare-metal objcopy failed' }

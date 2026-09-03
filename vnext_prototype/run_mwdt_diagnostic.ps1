$ErrorActionPreference = 'Stop'
$q = 'C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe'
$fw = 'C:\SourceCode\LasecSimul\vnext_prototype\guest_mwdt_diagnostic\.pio\build\esp32\merged.bin'
$rom = 'C:\SourceCode\LasecSimul\devices\qemu-esp32\bin\esp32\rom\bin'
$out = 'C:\SourceCode\LasecSimul\vnext_prototype\mwdt_diagnostic_stdout.log'
$err = 'C:\SourceCode\LasecSimul\vnext_prototype\mwdt_diagnostic_stderr.log'
Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue
$env:LASECSIMUL_TG0_WDT_TRACE = '1'
$env:LASECSIMUL_TG0_WDT_FEED_TRACE = '1'
$env:LASECSIMUL_TG1_WDT_TRACE = '1'
$env:LASECSIMUL_APP_CPU_RESET_TRACE = '1'
$env:LASECSIMUL_ESP32_WDT_SCALE = '100'
$args = @('-M','esp32-simul','-display','none','-L',$rom,'-drive',("file={0},if=mtd,format=raw" -f $fw),'-accel','tcg,thread=multi,tb-size=64','-no-reboot')
$p = Start-Process -FilePath $q -ArgumentList $args -WorkingDirectory 'C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime' -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
Start-Sleep -Seconds 12
if (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) { Stop-Process -Id $p.Id -Force; $result = 'bounded_stop' } else { $result = 'guest_exit' }
Start-Sleep -Milliseconds 500
Write-Output ("PID={0} RESULT={1}" -f $p.Id,$result)
Write-Output ("STDOUT_BYTES={0} STDERR_BYTES={1}" -f (Get-Item $out).Length,(Get-Item $err).Length)
rg -n 'TG0WDT|TG1WDT|MWDT_CPU_STAGE|reset|RESET|DIAGNOSTIC' $err $out | Select-Object -First 160

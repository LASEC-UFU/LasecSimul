# Sonda I2C/SSD1306

Fixture usada para correlacionar o tempo de firmware e o tempo de parede do benchmark durante uma
transferência completa de framebuffer. Ela envia o mesmo quadro a 100, 400 e 800 kHz e publica
marcadores `I2CPROBE` pela UART.

```powershell
pio run
$env:LASECSIMUL_BENCHMARK_ALLOW_INCOMPLETE = '1'
$env:LASECSIMUL_BENCHMARK_UART_TIMELINE = '1'
$env:LASECSIMUL_QEMU_PROFILE = '1'
node scripts/benchmark-real-esp32.mjs `
  C:\SourceCode\II1P04_GPIO_Debug\lasecSimul\display.lsproj `
  .codex-validation\i2c-throughput\.pio\build\esp32\merged.bin 30000
```

Para validar NACK em endereço ausente, compile temporariamente com
`PLATFORMIO_BUILD_FLAGS=-DPROBE_ADDRESS=0x3d`.

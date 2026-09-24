# ESP32 Wi-Fi transparente no LasecSimul

Firmware Arduino **puro** que valida o Wi-Fi transparente da ESP32 simulada
(ver [`docs/47-plano-wifi-transparente-esp32-qemu.md`](../../docs/47-plano-wifi-transparente-esp32-qemu.md)).
Não há `sdkconfig` especial, OpenETH, `WiFiCompat.h` nem inicialização manual de
`esp_eth`: apenas `#include <WiFi.h>` e `WiFi.begin(ssid, senha)`.

```ini
[env:esp32]
platform = espressif32
board = esp32dev
framework = arduino
```

```cpp
#include <WiFi.h>
WiFi.begin("ssid-que-nao-existe", "senha-que-nao-existe");
while (WiFi.status() != WL_CONNECTED) delay(100);
```

O QEMU do LasecSimul apresenta ao firmware um enlace Wi-Fi já disponível em modo
estação e usa a rede do computador como transporte. SSID e senha **não** são
usados para decidir a conexão: o simulador ignora a senha por padrão
(`ignore-sta-password`, propriedade do modelo `esp32_wifi`) porque não modela
nem testa segurança Wi-Fi. Não existe AP, scan real, WPA/EAPOL nem associação de
rádio.

## Compilar

```powershell
pio run
```

O `.pio/build/esp32/firmware.factory.bin` (bootloader + tabela de partições +
app) é a imagem que o LasecSimul carrega. Selecione-a em **Carregar firmware** e
inicie a simulação.

## O que o firmware faz

Cada etapa imprime uma linha `[wifi-e2e] ...` no UART0, usada pelos testes
automatizados:

- eventos Wi-Fi (`STA_START`, `STA_CONNECTED`, `STA_GOT_IP`);
- `WiFi.localIP()`, gateway, DNS e MAC;
- resolução DNS de `example.com`;
- requisição HTTP e conexão HTTPS de saída;
- `WebServer` na porta 80, eco UDP na porta 4210;
- anúncio mDNS `lasecsimul-esp32.local` e Arduino OTA.

## Modos de rede

O comportamento de saída (DHCP, DNS, TCP/UDP, HTTP/TLS) funciona em qualquer modo
que ofereça rede. Serviços de entrada (WebServer, mDNS, OTA) dependem do modo
oferecer tráfego iniciado pelo host — ver
[`docs/17-modos-de-rede-esp32.md`](../../docs/17-modos-de-rede-esp32.md).

Para reverter temporariamente ao frontend Ethernet legado (diagnóstico), defina
`LASECSIMUL_NETWORK_FRONTEND=openeth`; nesse caso vale o exemplo
[`esp32-openeth-internet`](../esp32-openeth-internet/), que exige o firmware com
OpenETH.

# PlatformIO + Arduino + OpenETH no LasecSimul

Este guia mostra como compilar uma aplicação Arduino para a ESP32 simulada pelo
LasecSimul usando a interface Ethernet OpenETH do QEMU.

## Por que não usar apenas `framework = arduino`

OpenETH é um driver do ESP-IDF habilitado pela opção Kconfig
`CONFIG_ETH_USE_OPENETH`. No framework Arduino convencional, vários componentes
do ESP-IDF são fornecidos como bibliotecas previamente compiladas. Portanto,
adicionar somente esta opção não é suficiente:

```ini
build_flags = -D CONFIG_ETH_USE_OPENETH=1
```

Para que o componente Ethernet seja realmente compilado com OpenETH, use Arduino
como componente do ESP-IDF:

```ini
framework =
    arduino
    espidf
```

O código continua podendo usar `setup()`, `loop()`, `Serial`, bibliotecas Arduino
e as APIs usuais de socket. A inicialização da interface de rede precisa usar
`esp_eth`; `WiFi.begin()` não seleciona OpenETH e `ETH.begin()` normalmente
inicializa controladores Ethernet físicos.

## Estrutura do projeto

```text
meu-projeto/
|-- platformio.ini
|-- sdkconfig.defaults
`-- src/
    `-- main.cpp
```

## `platformio.ini`

```ini
[platformio]
default_envs = lasecsimul

[env:lasecsimul]
platform = platformio/espressif32
board = esp32dev

; Compila o Arduino como componente do ESP-IDF.
framework =
    arduino
    espidf

monitor_speed = 115200
monitor_filters =
    esp32_exception_decoder

board_build.flash_mode = dio
board_build.flash_size = 4MB
board_upload.flash_size = 4MB

build_flags =
    -DCORE_DEBUG_LEVEL=3
```

Fixe uma versão da plataforma depois de validar o projeto no laboratório, para
evitar que uma atualização futura altere simultaneamente as versões do ESP-IDF,
Arduino Core e ferramentas de compilação.

## `sdkconfig.defaults`

```ini
CONFIG_IDF_TARGET="esp32"

CONFIG_ETH_USE_OPENETH=y
CONFIG_ETH_OPENETH_DMA_RX_BUFFER_NUM=8
CONFIG_ETH_OPENETH_DMA_TX_BUFFER_NUM=4

CONFIG_AUTOSTART_ARDUINO=y
CONFIG_ARDUINO_LOOP_STACK_SIZE=8192

CONFIG_ESP_CONSOLE_UART_DEFAULT=y
CONFIG_ESP_CONSOLE_UART_BAUDRATE=115200

CONFIG_PARTITION_TABLE_SINGLE_APP=y
```

O PlatformIO gera `sdkconfig.lasecsimul` a partir desses valores. Não edite o
arquivo gerado como configuração permanente; altere `sdkconfig.defaults` e faça
uma compilação limpa.

## Exemplo de `src/main.cpp`

```cpp
#include <Arduino.h>

extern "C" {
#include "esp_eth.h"
#include "esp_eth_mac.h"
#include "esp_eth_phy.h"
#include "esp_eth_netif_glue.h"
#include "esp_event.h"
#include "esp_netif.h"
}

static esp_eth_handle_t ethHandle = nullptr;

static void onGotIp(void *, esp_event_base_t, int32_t, void *eventData)
{
    auto *event = static_cast<ip_event_got_ip_t *>(eventData);
    Serial.printf(
        "DHCP: IP=" IPSTR " mascara=" IPSTR " gateway=" IPSTR "\n",
        IP2STR(&event->ip_info.ip),
        IP2STR(&event->ip_info.netmask),
        IP2STR(&event->ip_info.gw));
}

static void startOpenEth()
{
    ESP_ERROR_CHECK(esp_netif_init());

    const esp_err_t eventLoopResult = esp_event_loop_create_default();
    if (eventLoopResult != ESP_OK && eventLoopResult != ESP_ERR_INVALID_STATE) {
        ESP_ERROR_CHECK(eventLoopResult);
    }

    ESP_ERROR_CHECK(esp_event_handler_register(
        IP_EVENT, IP_EVENT_ETH_GOT_IP, onGotIp, nullptr));

    esp_netif_config_t netifConfig = ESP_NETIF_DEFAULT_ETH();
    esp_netif_t *netif = esp_netif_new(&netifConfig);
    if (netif == nullptr) {
        Serial.println("Falha ao criar esp_netif");
        abort();
    }

    eth_mac_config_t macConfig = ETH_MAC_DEFAULT_CONFIG();
    eth_phy_config_t phyConfig = ETH_PHY_DEFAULT_CONFIG();
    phyConfig.phy_addr = 1;
    phyConfig.reset_gpio_num = -1;
    phyConfig.autonego_timeout_ms = 100;

    esp_eth_mac_t *mac = esp_eth_mac_new_openeth(&macConfig);
    esp_eth_phy_t *phy = esp_eth_phy_new_dp83848(&phyConfig);
    if (mac == nullptr || phy == nullptr) {
        Serial.println("Falha ao criar OpenETH");
        abort();
    }

    esp_eth_config_t ethConfig = ETH_DEFAULT_CONFIG(mac, phy);
    ESP_ERROR_CHECK(esp_eth_driver_install(&ethConfig, &ethHandle));

    const uint8_t macAddress[6] = {0x02, 0x4c, 0x53, 0x00, 0x00, 0x01};
    ESP_ERROR_CHECK(esp_eth_ioctl(
        ethHandle, ETH_CMD_S_MAC_ADDR, const_cast<uint8_t *>(macAddress)));

    esp_eth_netif_glue_handle_t glue = esp_eth_new_netif_glue(ethHandle);
    ESP_ERROR_CHECK(esp_netif_attach(netif, glue));
    ESP_ERROR_CHECK(esp_eth_start(ethHandle));
}

void setup()
{
    Serial.begin(115200);
    delay(1000);
    Serial.println("Iniciando OpenETH...");
    startOpenEth();
}

void loop()
{
    delay(1000);
}
```

Para várias ESP32 simultâneas, não use o mesmo MAC em todas. O LasecSimul já
gera um MAC próprio para a NIC QEMU conforme o namespace e a instância, mas o
firmware acima também define um MAC. Em um projeto multi-instância, derive esse
valor de uma configuração exclusiva por aluno ou remova a alteração explícita
se o driver preservar corretamente o MAC fornecido pelo dispositivo emulado.

## Limpar e compilar

Se o projeto já foi compilado com outra configuração, remova os artefatos e o
`sdkconfig` gerado:

```powershell
pio run -t clean
Remove-Item -Recurse -Force .pio -ErrorAction SilentlyContinue
Remove-Item sdkconfig.lasecsimul -ErrorAction SilentlyContinue
pio run
```

Confirme que OpenETH foi realmente habilitado:

```powershell
Select-String -Path sdkconfig.lasecsimul -Pattern "CONFIG_ETH_USE_OPENETH"
```

Resultado esperado:

```text
CONFIG_ETH_USE_OPENETH=y
```

## Gerar a imagem de flash completa

O `firmware.bin` contém somente a aplicação. O LasecSimul/QEMU precisa de uma
imagem contendo bootloader, tabela de partições e aplicação nos offsets da
ESP32:

```powershell
python -m esptool --chip esp32 merge_bin `
  -o .pio\build\lasecsimul\lasecsimul-flash.bin `
  --flash_mode dio `
  --flash_size 4MB `
  0x1000 .pio\build\lasecsimul\bootloader.bin `
  0x8000 .pio\build\lasecsimul\partitions.bin `
  0x10000 .pio\build\lasecsimul\firmware.bin
```

Carregue no LasecSimul:

```text
.pio\build\lasecsimul\lasecsimul-flash.bin
```

## Configuração do LasecSimul

No `settings.json` do VS Code:

```json
{
  "lasecsimul.network.mode": "lab-bridge",
  "lasecsimul.network.namespace": 1,
  "lasecsimul.network.gatewayPort": 9011
}
```

Cada aluno deve ter um namespace exclusivo. Depois da alteração, execute
`Developer: Reload Window`.

## Resultado esperado

No monitor UART:

```text
Iniciando OpenETH...
DHCP: IP=192.168.x.x mascara=255.255.255.0 gateway=192.168.x.1
```

No modo `lab-bridge`, o endereço é fornecido pelo DHCP real do laboratório. Ele
deve pertencer à mesma rede da bridge do servidor. A faixa `10.x.x.x` descrita
para o backend `isolated`/SLIRP não é o resultado esperado neste modo.

No computador hospedeiro:

```powershell
Test-NetConnection 127.0.0.1 -Port 9011
Get-Content "$env:ProgramData\LasecSimul\network-gateway.log" -Tail 50
arp -a
ping <IP-DA-ESP32>
```

O `ping` pode ser bloqueado pelo firmware ou por regras da rede, mesmo que DHCP,
DNS, HTTP e MQTT estejam funcionando. Para um teste conclusivo, execute uma
requisição DNS/HTTP na ESP32 e confira o monitor UART.

## Modos de rede

### `lab-bridge`

```text
Arduino/ESP-IDF/lwIP
        -> OpenETH emulada no QEMU
        -> gateway local 127.0.0.1:9011
        -> LasecSimul TAP
        -> Windows Network Bridge
        -> Ethernet física/LAN
```

- DHCP, DNS, gateway, ARP, broadcast e mDNS pertencem à rede real.
- Cada ESP32 deve ter MAC exclusivo e recebe seu próprio IP do DHCP real.
- Servidores na ESP32 podem ser acessados diretamente pelo IP, se a política da
  LAN permitir.
- O switch deve aceitar vários MACs na porta do servidor/thin client.

### `isolated`

```text
Arduino/ESP-IDF/lwIP -> OpenETH -> libslirp/QEMU -> NAT do host
```

- Não requer TAP nem bridge.
- Permite conexões de saída por NAT.
- Não coloca a ESP32 diretamente na LAN.
- mDNS e servidores de entrada precisam de recursos adicionais.

## Diagnóstico

### `esp_eth_mac_new_openeth` não foi declarado ou não foi vinculado

Confira:

```powershell
Select-String sdkconfig.lasecsimul -Pattern "CONFIG_ETH_USE_OPENETH"
```

Se não estiver habilitado, remova `.pio` e `sdkconfig.lasecsimul` e compile
novamente. Não tente resolver apenas com `build_flags`.

### O firmware fica aguardando DHCP

No host, verifique:

```powershell
Test-NetConnection 127.0.0.1 -Port 9011
netsh bridge list
netsh bridge show adapter
Get-Content "$env:ProgramData\LasecSimul\network-gateway.log" -Tail 100
```

Confirme que o QEMU conectou ao gateway, que `LasecSimul TAP` e a Ethernet
física pertencem à bridge e que o DHCP/switch aceita MACs adicionais.

### `WiFi.begin()` não conecta

Esse comportamento é esperado. A implementação atual oferece Ethernet virtual
OpenETH, não emulação do controlador Wi-Fi proprietário da ESP32. Use `esp_eth`
e a pilha de sockets/lwIP. HTTP, MQTT, TLS, DNS e mDNS não dependem de
`WiFi.begin()` depois que a interface Ethernet está ativa.

## Referências

- Espressif, Arduino como componente do ESP-IDF:
  <https://docs.espressif.com/projects/arduino-esp32/en/latest/esp-idf_component.html>
- Espressif, alteração de opções `sdkconfig` no Arduino:
  <https://docs.espressif.com/projects/arduino-esp32/en/latest/faq.html#how-to-modify-an-sdkconfig-option-in-arduino>
- ESP-IDF, `CONFIG_ETH_USE_OPENETH`:
  <https://docs.espressif.com/projects/esp-idf/en/v5.0/esp32/api-reference/kconfig.html#config-eth-use-openeth>
- PlatformIO, exemplo oficial Arduino + ESP-IDF:
  <https://github.com/platformio/platform-espressif32/tree/develop/examples/espidf-arduino-blink>
- Documentação dos modos de rede do projeto:
  [`../../docs/17-modos-de-rede-esp32.md`](../../docs/17-modos-de-rede-esp32.md)

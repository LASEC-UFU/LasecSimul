# Modos de rede da ESP32

A rede da ESP32 tem duas dimensões independentes:

- **modo** (`LASECSIMUL_NETWORK_MODE`): `disabled` (padrão), `lab-bridge`, `lab-router` ou
  `isolated` — decide o backend/host (sem rede, TAP/LAN, TAP roteada ou SLIRP/NAT).
- **frontend** (`LASECSIMUL_NETWORK_FRONTEND`): qual NIC emulada o firmware enxerga.
  - `wifi` (padrão): modelo `esp32_wifi` transparente (ver
    [`47-plano-wifi-transparente-esp32-qemu.md`](47-plano-wifi-transparente-esp32-qemu.md)). Um
    firmware Arduino comum com `#include <WiFi.h>` e `WiFi.begin(ssid, senha)` alcança a rede sem
    OpenETH, sem `sdkconfig` especial e sem `WiFiCompat.h`. SSID/senha são ignorados (o simulador
    não modela segurança Wi-Fi) e a saída passa pela pilha lwIP normal do firmware.
  - `openeth`: rollback temporário para o MAC Ethernet legado; exige firmware compilado com
    `CONFIG_ETH_USE_OPENETH=y` e inicialização via `esp_eth`/`esp_netif`.

`disabled` é o padrão do **modo**: não cria NIC, socket ou thread de rede e serve a firmwares
comuns (como Blink). Para habilitar rede, selecione `lab-bridge`, `lab-router` ou `isolated`; o
frontend `wifi` é usado automaticamente salvo se `LASECSIMUL_NETWORK_FRONTEND=openeth`.

## `disabled` (padrão)

O QEMU inicia sem `-nic`; OpenETH e os backends de rede não são realizados. Uma falha de TAP,
bridge ou gateway não pode afetar CPU, GPIO, timers ou o boot nesse modo.

## `lab-bridge`

Fluxo:

```text
ESP-IDF/lwIP -> OpenETH emulada -> socket TCP local -> gateway central
              -> uma TAP -> bridge do host -> LAN física
```

O DHCP, gateway, DNS, ARP, mDNS e tráfego broadcast são os da rede real. Assim, cada ESP32 obtém
um IP dinâmico do mesmo servidor DHCP dos computadores e aparece como outro dispositivo Ethernet.
Servidores HTTP/MQTT dentro da ESP32 são acessados diretamente por esse IP; não há port forwarding
ou NAT neste modo. mDNS funciona se a rede física permitir multicast IPv4/IPv6 entre os clientes.

No Windows existe apenas uma interface `LasecSimul TAP`, aberta pelo processo central
`LasecSimul.NetworkGateway.exe`. Todos os QEMUs conectam a `127.0.0.1:9011` usando o protocolo de
quadros do backend socket do QEMU (comprimento big-endian de 32 bits seguido do quadro Ethernet).
O gateway aprende endereços MAC, encaminha tráfego local entre ESP32 e envia/recebe tráfego externo
pela TAP. Assim a exclusividade do driver TAP não limita a quantidade de QEMUs.

Configure um namespace exclusivo para cada aluno dentro do mesmo domínio de broadcast. Ele não fixa
o IP: compõe parte de um MAC local exclusivo. O DHCP do laboratório continua decidindo o IP.
Para dezenas de instâncias, reserve endereços suficientes no pool DHCP e confirme que a política do
switch aceita vários MACs por porta do thin client (port-security/NAC pode bloquear esse cenário).

Configuração do VS Code:

```json
{
  "lasecsimul.network.mode": "lab-bridge",
  "lasecsimul.network.namespace": 42,
  "lasecsimul.network.gatewayPort": 9011
}
```

## `isolated`

Fluxo:

```text
ESP-IDF/lwIP -> OpenETH emulada -> libslirp do QEMU -> sockets/NAT do host
```

Não requer TAP nem administrador. Cada ESP32 recebe normalmente
`10.<namespace>.<instance>.15`, gateway `.2` e DNS `.3`. As redes são privadas por processo: a ESP32
acessa internet, mas não participa do broadcast da LAN. Descoberta mDNS para outros computadores e
entrada direta em servidores da ESP32 não funcionam sem mecanismos adicionais.

```json
{
  "lasecsimul.network.mode": "isolated",
  "lasecsimul.network.namespace": 42
}
```

## Requisitos do firmware

Com o frontend padrão `wifi`, **nenhum requisito especial**: um firmware Arduino comum com
`#include <WiFi.h>` e `WiFi.begin(...)` funciona sem `CONFIG_ETH_USE_OPENETH`. A pilha lwIP, DHCP,
DNS, TCP, UDP, TLS, HTTP, MQTT e mDNS permanecem dentro do firmware; o modelo `esp32_wifi` converte
os quadros 802.11 do driver em Ethernet para o backend do QEMU. Ver
[`../examples/esp32-wifi-transparent/`](../examples/esp32-wifi-transparent/).

Com o frontend de rollback `openeth`, os modos transportam Ethernet (não o rádio Wi-Fi): o firmware
deve ser compilado com `CONFIG_ETH_USE_OPENETH=y` e inicializar `esp_eth`/`esp_netif`. Nesse caso
`WiFi.begin()`/`esp_wifi` não selecionam a OpenETH.

## Instalação e limites operacionais

O fork oficial usado pelo Core fica exclusivamente em
`C:\SourceCode\qemu_lasecSimul`. No Windows, compile, prepare as DLLs (inclusive `libslirp-0.dll`)
e implante o executável vendorizado com:

```powershell
npm run build:qemu:windows
```

O script recusa um build cujo `SRC_PATH` aponte para outra árvore, exige `--enable-slirp`, exige
que todas as alterações rastreadas do QEMU estejam preservadas no Git e grava
`devices/qemu-esp32/bin/BUILD-PROVENANCE.txt` com o commit e o SHA-256 implantados.

- O instalador baixa no build o TAP-Windows6 9.27.0 oficial, valida SHA-256 e embute somente
  INF/CAT/SYS, licença GPLv2 e o código-fonte correspondente. Na instalação, uma etapa UAC instala
  o driver, cria `LasecSimul TAP`, cria a Windows Network Bridge e registra o gateway para iniciar
  como SYSTEM no boot. O simulador e os alunos não precisam elevar privilégios depois disso.
- Em instalações posteriores, cada aluno recebe sua cópia completa da extensão/Core/QEMU no perfil,
  mas o instalador detecta e reutiliza a infraestrutura global. Desinstalar a extensão no VS Code
  não remove TAP, bridge ou gateway; esses componentes possuem uma entrada administrativa própria
  no Painel de Controle.
- Quando houver mais de uma interface Ethernet física ativa, o instalador pede ao administrador
  qual delas deve integrar a bridge. Também aceita `--bridge-interface "Ethernet"`.
- O provisionamento automático exige DHCP habilitado na interface física. Em uma interface com IPv4
  estático, o Windows pode retirar o IP e a rota da placa sem transferi-los corretamente para
  `BridgeMP`; por isso o instalador v0.0.14 recusa a operação **antes de alterar a rede** e orienta o
  uso de `isolated` ou a configuração manual da bridge.
- Depois de criar uma bridge em DHCP, o instalador aguarda um IPv4 não-APIPA e uma rota padrão. Se
  eles não voltarem em 60 segundos, a bridge criada é desfeita automaticamente para preservar a
  conectividade do host.
- Wi-Fi físico costuma rejeitar bridge Ethernet transparente de múltiplos MACs; prefira a interface
  Ethernet cabeada do thin client.
- O switch físico precisa aceitar vários MACs na porta do thin client e o DHCP precisa ter endereços
  suficientes. Port-security/NAC ou isolamento de clientes pode bloquear DHCP, mDNS ou comunicação.
- Se o gateway central ou a bridge não estiver disponível, selecione temporariamente `isolated`.

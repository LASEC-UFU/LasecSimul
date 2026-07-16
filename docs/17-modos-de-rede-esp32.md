# Modos de rede da ESP32/OpenETH

O LasecSimul oferece dois backends para a interface OpenETH da ESP32. O modo padrão é
`lab-bridge`; `isolated` permanece disponível para execução sem driver ou privilégios.

## `lab-bridge` (padrão)

Fluxo:

```text
ESP-IDF/lwIP -> OpenETH emulada -> QEMU TAP -> bridge do host -> LAN física
```

O DHCP, gateway, DNS, ARP, mDNS e tráfego broadcast são os da rede real. Assim, cada ESP32 obtém
um IP dinâmico do mesmo servidor DHCP dos computadores e aparece como outro dispositivo Ethernet.
Servidores HTTP/MQTT dentro da ESP32 são acessados diretamente por esse IP; não há port forwarding
ou NAT neste modo. mDNS funciona se a rede física permitir multicast IPv4/IPv6 entre os clientes.

No Windows, o backend TAP do QEMU abre a interface com exclusividade. Portanto cada ESP32 simultânea
precisa de sua própria TAP. O padrão é `LasecSimul TAP {namespace}-{instance}`; por exemplo, namespace
42 e componente 7 usam `LasecSimul TAP 42-7`. As TAPs devem ser instaladas e adicionadas à bridge da
interface Ethernet física uma única vez por um administrador. Não reutilize a mesma TAP em dois
QEMUs.

Configure um namespace exclusivo para cada aluno dentro do mesmo domínio de broadcast. Ele não fixa
o IP: identifica a TAP e compõe um MAC local exclusivo. O DHCP do laboratório continua decidindo o IP.
Para dezenas de instâncias, reserve endereços suficientes no pool DHCP e confirme que a política do
switch aceita vários MACs por porta do thin client (port-security/NAC pode bloquear esse cenário).

Configuração do VS Code:

```json
{
  "lasecsimul.network.mode": "lab-bridge",
  "lasecsimul.network.namespace": 42,
  "lasecsimul.network.tapInterface": "LasecSimul TAP {namespace}-{instance}"
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

Ambos os modos transportam Ethernet, não o rádio Wi-Fi da ESP32. O firmware deve ser compilado com
`CONFIG_ETH_USE_OPENETH=y` e inicializar `esp_eth`/`esp_netif`. A pilha lwIP, DHCP, DNS, TCP, UDP,
TLS, HTTP, MQTT e mDNS permanecem dentro do firmware. `WiFi.begin()`/`esp_wifi` não selecionam a
OpenETH e ainda exigiriam a emulação do controlador MAC Wi-Fi proprietário.

## Limites operacionais do bridge direto

- A instalação da TAP e a criação/alteração da bridge são operações administrativas; a execução
  posterior do simulador normalmente não precisa elevar privilégios.
- Wi-Fi físico costuma rejeitar bridge Ethernet transparente de múltiplos MACs; prefira a interface
  Ethernet cabeada do thin client.
- O QEMU falha ao iniciar a NIC se a TAP calculada não existir ou já estiver aberta. Se a infraestrutura
  TAP ainda não foi provisionada, selecione temporariamente `isolated`.
- Em escala maior, um futuro switch/gateway central pode multiplexar QEMUs sobre uma única interface
  do host. O modo atual privilegia fidelidade L2 e isolamento de recursos por TAP.

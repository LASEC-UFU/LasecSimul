# Modos de rede da ESP32/OpenETH

O LasecSimul oferece dois backends para a interface OpenETH da ESP32, além do modo `disabled`.
`disabled` é o padrão: não cria NIC, socket ou thread de rede e deve ser usado por firmwares
comuns (como Blink). Para firmware compilado com `CONFIG_ETH_USE_OPENETH=y`, selecione
explicitamente `lab-bridge` ou `isolated`.

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

Ambos os modos transportam Ethernet, não o rádio Wi-Fi da ESP32. O firmware deve ser compilado com
`CONFIG_ETH_USE_OPENETH=y` e inicializar `esp_eth`/`esp_netif`. A pilha lwIP, DHCP, DNS, TCP, UDP,
TLS, HTTP, MQTT e mDNS permanecem dentro do firmware. `WiFi.begin()`/`esp_wifi` não selecionam a
OpenETH e ainda exigiriam a emulação do controlador MAC Wi-Fi proprietário.

## Instalação e limites operacionais

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
- Wi-Fi físico costuma rejeitar bridge Ethernet transparente de múltiplos MACs; prefira a interface
  Ethernet cabeada do thin client.
- O switch físico precisa aceitar vários MACs na porta do thin client e o DHCP precisa ter endereços
  suficientes. Port-security/NAC ou isolamento de clientes pode bloquear DHCP, mDNS ou comunicação.
- Se o gateway central ou a bridge não estiver disponível, selecione temporariamente `isolated`.

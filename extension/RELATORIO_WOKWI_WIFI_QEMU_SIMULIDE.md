# Arquitetura de rede/Wi-Fi do Wokwi e proposta para QEMU/SimulIDE

**Data da investigação:** 15 de julho de 2026  
**Escopo:** análise somente leitura dos fontes locais, pesquisa de fontes primárias, inspeção de código público e definição arquitetural.  
**Diretórios preservados sem alteração:** `G:\Meu Drive\SourceCode\qemu-simulide-1` e `C:\SourceCode\simulide_2`.

## Atualização de implementação — Ethernet integrada (15/07/2026)

O caminho Ethernet foi integrado ao LasecSimul, sem alterar os dois diretórios
preservados:

- o adapter ESP32 acrescenta automaticamente uma NIC OpenETH e o Core oferece
  dois backends: `lab-bridge` (TAP/LAN, padrão) e `isolated` (libslirp/NAT);
- o executável vendorizado em `devices/qemu-esp32/bin` foi atualizado com o
  build do fork `C:\SourceCode\qemu_lasecSimul` e com as DLLs da mesma
  toolchain;
- consulta HMP reproduzível no binário distribuído confirmou
  `open_eth.0` ligado ao backend `user`/SLIRP; o teste integrado confirmou a
  reconfiguração dinâmica, por exemplo `10.79.233.0/24`;
- `esp32_adapter_test` e `mcu_controller_real_qemu_test` passaram usando o
  adapter compilado e o executável QEMU real; o segundo usa uma flash MTD
  apagada de 4 MiB e confirma que o processo permanece vivo depois de
  inicializar máquina, ROM, OpenETH e SLIRP;
- o adapter usa `-display none`, eliminando a dependência indevida do keymap
  gráfico `en-us` encontrada pelo novo teste de integração;
- foi adicionado `examples/esp32-openeth-internet`, que inicializa OpenETH,
  aguarda DHCP, resolve `example.com` e faz uma requisição HTTP usando sockets
  da lwIP.
- no modo padrão `lab-bridge`, cada ESP32 recebe um MAC local distinto e usa
  uma TAP exclusiva chamada pelo padrão `LasecSimul TAP {namespace}-{instance}`;
  quando essa TAP está na bridge física, DHCP, DNS, ARP, broadcast e mDNS são
  os da LAN real;
- a configuração do VS Code expõe `lasecsimul.network.mode`,
  `lasecsimul.network.tapInterface` e `lasecsimul.network.namespace`.

Limite atual: a máquina de desenvolvimento não possui ESP-IDF instalado, então
o firmware do exemplo ainda não foi compilado/executado. A NIC e o NAT estão
confirmados no host; DHCP/DNS/TCP de ponta a ponta no guest permanecem pendentes
até compilar o exemplo com ESP-IDF 5.1.x. Firmware Arduino comum que chama
`WiFi.begin()` não usa OpenETH e não ganha rede automaticamente.

### Rede para thin clients

No modo `isolated`, cada QEMU possui seu próprio SLIRP; portanto, endereços
repetidos não colidem tecnicamente. Para identificação, o Core usa
`10.<namespace>.<instancia>.0/24`: guest DHCP `.15`, gateway `.2` e DNS `.3`.

No modo padrão `lab-bridge`, o IP não é escolhido pelo Core: o firmware envia
DHCP pela OpenETH/TAP e recebe um endereço do servidor real do laboratório.
Cada ESP32 usa um MAC `02:4c:53:<namespace>:<instancia>:01` e uma TAP exclusiva.
Isso permite que ela seja vista como outro dispositivo da LAN, inclusive para
mDNS, desde que multicast não seja bloqueado pelo switch/AP. O administrador
precisa provisionar uma TAP por ESP32 e conectá-las à bridge da Ethernet
física; Wi-Fi físico, port-security, NAC e pools DHCP pequenos podem impedir
esse uso. O nome da arena compartilhada também inclui o PID da instância host,
evitando colisão entre Cores simultâneos.

`lasecsimul.network.namespace` aceita `0..255` por aluno/instância ou `-1` para
seleção automática. Em `lab-bridge`, os valores devem ser exclusivos em todo o
domínio de broadcast para evitar MACs duplicados. Em `isolated`, futuras portas
publicadas no Windows ainda precisam de um alocador central e bind em
`127.0.0.1` por padrão; em `lab-bridge`, servidores são acessados diretamente
pelo IP DHCP da ESP32 e não precisam de `hostfwd`.

## Atualização de implementação no fork autorizado

Após a investigação, foi autorizada uma primeira implementação exclusivamente
em `C:\SourceCode\qemu_lasecSimul`. O fork agora também pode ser iniciado como
um QEMU convencional, sem remover o protocolo de memória compartilhada usado
pelo SimulIDE. A máquina independente `esp32` e a máquina integrada
`esp32-simul` são compiladas no mesmo executável.

Resultados confirmados em execução no Windows:

- criação do OpenETH ligado a um backend libslirp;
- endereço MAC configurável preservado nos registradores após reset;
- criação simultânea de OpenETH e `esp32_wifi`, cada um em uma sub-rede slirp;
- redirecionamento TCP restrito a `127.0.0.1` com `hostfwd`;
- inicialização sem TAP/TUN e sem privilégios administrativos;
- leitura por QMP dos registradores OpenETH `MODER=0x0000a000`,
  `TX_BD_NUM=0x40`, `MAC_ADDR0=0x00123456` e `MAC_ADDR1=0x0200`;
- evento QMP `RESET` e restauração dos mesmos valores depois do reset;
- registradores iniciais do modelo Wi-Fi acessíveis ao mesmo tempo que o
  OpenETH.

Também foram corrigidos dois bloqueios estruturais do fork: o laço principal
desreferenciava incondicionalmente a arena compartilhada mesmo no modo
independente, e o caminho Windows de `get_relocated_path()` escrevia por um
ponteiro invalidado após o redimensionamento de uma `GString`. A suíte qtest de
rede foi adicionada para plataformas em que o transporte qtest funciona. No
build Windows deste fork, os sockets conectam mas o frontend qtest não despacha
os comandos; por isso, nessa plataforma, a validação foi feita por QMP/HMP e a
suíte não é registrada automaticamente até que esse problema seja corrigido.

Esta etapa confirma um MVP Ethernet em nível de quadros usando os recursos já
existentes no QEMU. Ela ainda não constitui validação fim a fim com firmware
ESP-IDF: o repositório não contém uma imagem de teste OpenETH, portanto DHCP,
DNS, HTTP e MQTT dentro da lwIP permanecem como próximo marco.

## 1. Resumo executivo

É tecnicamente possível construir no QEMU/SimulIDE uma solução equivalente em capacidade à do Wokwi, mas há dois objetivos de dificuldade muito diferente:

1. **Rede IP funcional**, preservando a lwIP no firmware: é um trabalho moderado e pode reutilizar libslirp ou um gateway em espaço de usuário como `gvisor-tap-vsock`. Não exige PHY de rádio nem privilégios administrativos no modo normal.
2. **Firmware Arduino/ESP-IDF Wi-Fi sem modificação**, incluindo `esp_wifi`, scan, associação e PCAP 802.11: exige um modelo novo do controlador Wi-Fi da ESP32, com registradores não documentados, DMA, buffers, interrupções e MAC 802.11. Essa foi precisamente a parte que o Wokwi obteve por engenharia reversa.

A descoberta central é que o Wokwi **não usa um proxy de chamadas `socket()` no firmware**. O firmware binário original é executado instrução por instrução; a pilha lwIP e as bibliotecas Wi-Fi da Espressif produzem pacotes e quadros. O modelo proprietário do simulador trata o periférico Wi-Fi e o AP virtual. Na fronteira com o Private Gateway aberto, o tráfego já está convertido em **quadros Ethernet completos**, enviados em mensagens binárias WebSocket. O gateway executa switch L2, ARP, DHCP, DNS e uma pilha gVisor; para saída, termina fluxos TCP/UDP e abre sockets comuns do host. Portanto, “NAT” é uma boa descrição funcional, mas “gateway Ethernet em espaço de usuário com proxies TCP/UDP” é a descrição de implementação mais precisa.

Recomendação: adotar **gateway em nível de pacotes**, manter a lwIP dentro da ESP32, separar o modelo Wi-Fi do processo `LasecSimul IoT Gateway`, e implementar em duas trilhas: primeiro um enlace Ethernet/IP para validar gateway, DNS, TCP/UDP e segurança; depois o controlador Wi-Fi mínimo para firmware não modificado. Um proxy de operações de socket deve ser apenas ferramenta temporária de diagnóstico, não a arquitetura do produto.

## 2. Método, classes de evidência e limitações

Foram usadas as seguintes classes:

- **[DOC] Confirmado por documentação oficial**;
- **[CODE] Confirmado por código-fonte público**;
- **[TEST] Confirmado por teste reproduzível**;
- **[DEV] Informado por desenvolvedor do projeto**;
- **[INF] Inferido a partir de comportamento/evidência parcial**;
- **[NC] Não confirmado**.

Foram priorizados Wokwi Docs, repositórios da organização `wokwi`, código do gateway, apresentação do criador e dependências diretamente utilizadas. Código público foi inspecionado em clones temporários, fora dos diretórios protegidos. A documentação foi acessada em 2026-07-15.

Limitações:

- não havia navegador interativo autenticado nem assinatura paga para executar o Private Gateway contra uma simulação Wokwi;
- não foi feita inspeção de bundles proprietários nem interceptação do tráfego do serviço;
- o ambiente não contém Go, portanto `go test ./...` do gateway não pôde ser executado;
- não há binário QEMU construído nos diretórios examinados; a incompatibilidade `esp32_wifi`/`open_eth` foi confirmada estaticamente, não reproduzida em execução;
- associação, autenticação WPA2, RSSI e transporte do Public Gateway foram classificados conservadoramente quando a fonte pública não mostra a implementação.

## 3. “Reversing the ESP32 WiFi”

### Identificação

- **Título original:** *Remoticon 2021 // Uri Shaked Reverse Engineers ESP32 WiFi*.
- **Autor/apresentador:** Uri Shaked, criador do Wokwi.
- **Contexto:** Hackaday Remoticon 2021; gravação publicada pelo canal Hackaday em 30 de dezembro de 2021.
- **Duração:** aproximadamente 31min26s.
- **Vídeo:** [YouTube](https://www.youtube.com/watch?v=XmaT8bMssyQ).
- **Slides originais:** [Google Slides](https://docs.google.com/presentation/d/1XVXcjsA3jOGXkLbDOruA-IS346oupgpJrdhR7TaRvU4).
- **Relato contemporâneo:** Elliot Williams, Hackaday, 30/12/2021, [Remoticon 2021: Uri Shaked Reverses The ESP32 WiFi](https://hackaday.com/2021/12/30/remoticon-2021-uri-shaked-reverses-the-esp32-wifi/).
- **Vínculo oficial:** a [FAQ do Wokwi](https://docs.wokwi.com/faq) aponta esse vídeo como a explicação de como foi preparado o suporte a Wi-Fi.

### Conteúdo técnico observado

O material mostra um processo incremental de engenharia reversa, não uma substituição da API Wi-Fi:

1. O exemplo `scan` do ESP-IDF é executado até travar no simulador.
2. GDB/OpenOCD em uma ESP32 física e Ghidra com suporte Xtensa são usados para localizar o acesso que faltava.
3. O simulador é instrumentado para registrar chamadas e acessos.
4. Cada registrador/efeito necessário é implementado e o ciclo se repete.

Os slides identificam:

- periférico Wi-Fi na região `0x3ff73nnn`, que o TRM marcava como reservada;
- registrador TX em `0x3ff73d20`;
- registrador RX em `0x3ff73088`;
- registrador de eventos em `0x3ff73c48`;
- `ppTask()` como centro do processamento e `pp_post()` como mecanismo de agendamento/eventos.

O vídeo explica que, em TX, a biblioteca Wi-Fi produz um quadro em buffer DMA e entrega seu ponteiro ao registrador de transmissão. Em RX, o modelo fornece um buffer DMA, ajusta bits de evento e provoca a interrupção que leva o blob original a consumir o quadro. O resultado exibido é firmware real usando MQTT, com PCAP contendo Wi-Fi/IP/TCP/MQTT.

**Conclusão [DEV]:** os drivers/bibliotecas Wi-Fi originais do ESP-IDF são realmente executados e interagem com um periférico emulado por MMIO/DMA/interrupções. A implementação não é um mock de `WiFi.begin()`.

**Conclusão [INF]:** o modelo emula o rádio no nível necessário ao **MAC 802.11**, não formas de onda, modulação, ruído eletromagnético ou temporização de uma PHY completa. Isso é coerente com a documentação, que delimita a simulação a partir da “lowest 802.11 MAC Layer”, e com a apresentação, que trata quadros, não símbolos de RF. Não há fonte pública que prove uma PHY física detalhada.

### O que o material não publica

Ele não fornece o código do dispositivo Wi-Fi, mapa completo de registradores, layouts completos dos descritores, algoritmo do AP, WPA2, regras de temporização ou integração exata com o gateway. Os endereços e a metodologia são informação pública; copiar código descompilado ou blobs da Espressif não é recomendado.

## 4. Arquitetura do Wokwi: fatos confirmados

### Fluxo corrigido

```text
Aplicação Arduino / ESP-IDF / MicroPython
    ↓ chamadas de API
ESP-IDF + bibliotecas/blob Wi-Fi originais                         [DOC/DEV]
    ↓
lwIP dentro do firmware cria IP, TCP e UDP                         [CODE/INF]
    ↓
driver/blob Wi-Fi cria/consome quadros e usa MMIO/DMA/IRQ          [DEV]
    ↓
controlador Wi-Fi ESP32 emulado (registradores, buffers, eventos)  [DEV]
    ↓
MAC 802.11 + AP virtual no simulador                               [DOC/DEV]
    ↓ decapsulamento/encapsulamento pelo AP
quadros Ethernet                                                   [CODE]
    ↓ WebSocket binário no Private Gateway
Wokwi IoT Gateway: switch L2 + ARP + DHCP + DNS + gVisor           [CODE]
    ↓ termina TCP/UDP e abre sockets do host
rede do host / LAN / Internet                                      [CODE/DOC]
```

O fluxo proposto no pedido colocava lwIP antes das bibliotecas e do driver de forma ambígua. A ordem relevante em TX é: aplicação → TCP/IP na lwIP → encapsulamento Wi-Fi/driver → hardware emulado. O AP transforma o enlace 802.11 em Ethernet antes do gateway. Quadros de beacon, probe, autenticação e associação, quando presentes, são locais ao domínio rádio/AP e não precisam atravessar o gateway Ethernet.

### Blocos, evidência e reprodutibilidade

| Bloco | Responsabilidade no Wokwi | Evidência | Confiança | Reprodução proposta |
|---|---|---|---|---|
| CPU/firmware | Executar firmware binário instrução a instrução | FAQ oficial | Alta [DOC] | QEMU/TCG já faz a base |
| ESP-IDF/blobs | Executar driver real e gerar/consumir buffers | palestra | Alta [DEV] | Preservar, sem modificar firmware |
| lwIP | DHCP/DNS/TCP/UDP do convidado | DHCP real no gateway + PCAP + arquitetura ESP-IDF | Alta [CODE/INF] | Manter no firmware |
| Wi-Fi MMIO | Registradores, DMA, eventos e IRQ | palestra/slides | Alta [DEV] | Novo dispositivo QEMU |
| MAC 802.11 | Quadros Wi-Fi, beacon e dados | docs/PCAP/palestra | Alta [DOC/DEV] | Biblioteca própria do AP/MAC |
| PHY | RF, modulação, propagação | nenhuma evidência | Baixa [NC]; provável ausência [INF] | Não implementar no MVP |
| AP virtual | SSID/BSSID/canal/WPA2/internet | docs oficiais | Alta [DOC] | Objeto de rede no projeto |
| conversão AP–gateway | 802.11 para Ethernet | gateway recebe Ethernet | Alta [CODE/INF] | Dentro do modelo/AP QEMU |
| enlace ao gateway | Ethernet sobre WS binário | `wokwigw` | Alta [CODE] para Private | pipe/UDS ou WS com framing Ethernet |
| DHCP/DNS/ARP | Serviços de rede virtual | configuração e dependência gVisor | Alta [CODE] | libslirp ou gateway gVisor |
| saída TCP/UDP | Proxy transparente por fluxo | `net.Dial` em gvisor-tap-vsock | Alta [CODE] | reutilizar componente maduro |
| host/LAN | sockets e resolução do host | gateway aberto + docs | Alta [CODE/DOC] | ACL explícita |
| PCAP 802.11 | captura com relógio simulado | docs | Alta [DOC] | no modelo MAC/AP |

## 5. Respostas às 30 questões arquiteturais

| # | Resposta e classificação |
|---:|---|
| 1 | **Sim.** O firmware binário é executado instrução a instrução. [DOC] |
| 2 | **Sim.** A palestra mostra o código Wi-Fi binário original do ESP-IDF dirigindo MMIO/DMA/IRQ. [DEV] |
| 3 | **Sim, os registradores necessários.** Foram localizados em `0x3ff73nnn`. Não há prova de cobertura bit a bit de todo o silício. [DEV] |
| 4 | **MAC, confirmado; PHY completa, não confirmada e improvável.** [DOC/INF] |
| 5 | **Sim.** PCAP contém beacon e quadros 802.11; TX/RX usa buffers de quadros. [DOC/DEV] |
| 6 | **Sim.** `Wokwi-GUEST` é AP virtual interno, SSID aberto, canal 6, BSSID documentado. [DOC] |
| 7 | Associação é necessária e compatível com scan/beacon; WPA2-PSK customizado é suportado. O grau de fidelidade do handshake/autenticação não está publicado. DHCP é real. [DOC/CODE/NC] |
| 8 | **Sim.** DHCP no gateway entrega `10.10.0.2` (Public) ou `10.13.37.2` (Private). [DOC/CODE] |
| 9 | **Sim, com alta confiança.** O firmware original e a captura de TCP/IP são incompatíveis com um simples mock de API; a lwIP do firmware produz os pacotes. [DEV/INF] |
| 10 | **Sim.** TCP/UDP aparecem como pacotes completos antes do gateway; o gateway não recebe comandos de socket. [CODE/INF] |
| 11 | O **Private Gateway recebe quadros Ethernet**, um por mensagem binária WebSocket, e os prefixa internamente com comprimento QEMU de 32 bits big-endian. Não recebe 802.11 nem comandos de socket. [CODE] |
| 12 | Funcionalmente é NAT/user networking. Na implementação é switch Ethernet + pilha gVisor + proxies TCP/UDP que terminam cada fluxo e abrem sockets do host. Não é bridge transparente no modo comum. [CODE] |
| 13 | O Public Gateway fica na nuvem e o navegador precisa de um canal até ele; o transporte exato não foi publicado. WSS com quadros Ethernet é plausível, mas permanece [INF/NC]. |
| 14 | O Private usa `ws://localhost:9011`, HTTP Upgrade e mensagens WebSocket binárias. [CODE] |
| 15 | Private: WebSocket sobre TCP. Public: não confirmado publicamente; WebSocket seguro é hipótese. [CODE/NC] |
| 16 | `9011` continua sendo a porta TCP padrão do servidor HTTP/WebSocket do Private Gateway v2.0.1. [DOC/CODE] |
| 17 | DNS interno responde `host.wokwi.internal = 10.13.37.254`. O gateway trata esse IP virtual como `127.0.0.1` ao abrir a conexão real. [CODE] |
| 18 | **Sim.** O gateway oferece DNS UDP e TCP, primeiro zonas estáticas e depois resolvedor do host. [CODE] |
| 19 | DHCP associa `24:0a:c4:00:01:10` a `10.13.37.2` no Private; Public documenta `10.10.0.2`. [DOC/CODE] |
| 20 | Um listener TCP/UDP no host é associado a IP:porta do convidado e faz cópia bidirecional através da pilha gVisor. [CODE] |
| 21 | A conexão recebida termina no gateway; o gateway abre a conexão virtual ao socket da ESP32 através da pilha convidada. [CODE] |
| 22 | HTTP, MQTT, WebSocket etc. passam como payload de TCP/UDP; o gateway só implementa protocolos de rede genéricos. [CODE] |
| 23 | O PCAP principal é gravado no domínio 802.11 pelo simulador; há captura Ethernet separada no modo bridge do gateway. [DOC/CODE] |
| 24 | Captura Wi-Fi: entre MAC/controlador e AP, antes da conversão Ethernet [INF forte]. Captura `--captureFile` do bridge: na interface TAP Ethernet [CODE]. |
| 25 | SSID, BSSID e canal são confirmados. RSSI existe nas APIs observáveis, mas não há atributo/modelo oficial documentado; distância/atenuação não confirmadas. [DOC/NC] |
| 26 | **Sim**, APs customizados múltiplos, scan, seleção, canais e BSSIDs. [DOC] |
| 27 | A propriedade `internet: 0` desativa acesso à internet no AP. O mecanismo interno da regra não é publicado. [DOC] |
| 28 | Gateway, documentação, exemplos e alguns testes são abertos; o gateway usa gvisor-tap-vsock aberto. [CODE] |
| 29 | O núcleo ESP32, controlador Wi-Fi, MAC/AP no simulador, pipeline PCAP do navegador e Public Gateway não foram encontrados como código aberto. [CODE/NC] |
| 30 | MMIO/DMA/IRQ, Ethernet/WS e gateway privado são comprovados. PHY, transporte e política detalhada do Public Gateway, RSSI e fidelidade do WPA2 são inferidos ou não confirmados. |

## 6. Public Gateway

### Confirmado

Segundo a [documentação oficial de ESP32 Wi-Fi](https://docs.wokwi.com/guides/esp32-wifi):

- executa remotamente, na nuvem;
- é o modo padrão e disponível a todos;
- permite conexões de saída para a internet;
- não permite conexões recebidas nem acesso à rede local do usuário;
- o tráfego é monitorado e pode sofrer limites por segurança;
- DHCP entrega `10.10.0.2`;
- TCP e UDP são suportados; ICMP/ping não;
- por estar fora do computador, não pode transformar `localhost` da nuvem em `localhost` do usuário.

### Não publicado

Não foi localizada fonte primária que revele:

- URL/porta do serviço público;
- WebSocket, WebRTC ou protocolo proprietário;
- formato exato dos quadros no enlace;
- implementação de DNS, NAT, quotas ou inspeção;
- política precisa para broadcast, multicast, destinos e portas;
- topologia e isolamento entre usuários.

Arquitetura compatível com o comportamento: o navegador envia Ethernet por WSS a uma instância multi-tenant do mesmo tipo de rede virtual; a instância abre TCP/UDP sob ACL e quotas. É uma **inferência**, não um fato. Outras arquiteturas, como túnel de IP ou serviço próprio, também produziriam o mesmo comportamento.

Por que LAN é bloqueada: além de o gateway estar na nuvem e não possuir rota para a LAN do usuário, permitir RFC1918/link-local seria risco de SSRF contra a infraestrutura do provedor. A razão de segurança é inferência; a ausência de acesso é documentada.

## 7. Private Gateway

O [repositório oficial `wokwigw`](https://github.com/wokwi/wokwigw) publica a implementação em Go, licença MIT.

### Processo e transporte

- `127.0.0.1:9011`, não todas as interfaces;
- HTTP Upgrade para WebSocket;
- origens permitidas: `wokwi.com`, previews oficiais e HTTP em localhost/127.0.0.1;
- mensagem inicial textual `aloha` com protocolo/versões;
- cada mensagem binária contém um quadro Ethernet;
- internamente, o adaptador para `QemuProtocol` usa `uint32` big-endian de comprimento seguido pelo quadro;
- não há token criptográfico de sessão no código atual: loopback + validação de `Origin` são as proteções visíveis.

### Rede virtual normal

Configuração publicada em [`config.go`](https://github.com/wokwi/wokwigw/blob/main/cmd/wokwigw/config.go):

- subnet `10.13.37.0/24`;
- gateway `10.13.37.1` / MAC `42:13:37:55:aa:01`;
- lease estático `10.13.37.2` para `24:0a:c4:00:01:10`;
- host virtual `10.13.37.254`;
- MTU 1500;
- DNS `gateway.wokwi.internal` e `host.wokwi.internal`;
- tradução do host virtual para `127.0.0.1`;
- forward padrão `127.0.0.1:9080 → 10.13.37.2:80`.

O pacote `gvisor-tap-vsock` v0.8.3 cria switch Ethernet com aprendizado MAC, ARP, IPv4, TCP, UDP, ICMP interno, DHCP e DNS. Na saída, seus forwarders TCP/UDP usam `net.Dial`. Assim, o host vê conexões originadas pelo processo gateway, não pacotes IP crus com o endereço 10.13.37.2.

Isso explica o suporte transparente a HTTPS, MQTT, WebSocket e qualquer protocolo sobre TCP/UDP: nenhum deles precisa de implementação específica.

### Privilégios e bridge

O modo normal usa apenas sockets comuns e não requer administrador/root [DOC/CODE]. O modo bridge experimental usa TAP:

- Linux: TAP/bridge e root;
- Windows: driver TAP-Windows V9 e bridge configurada;
- port forwarding não é suportado no modo bridge, pois o convidado recebe endereço da LAN.

Não há Npcap, WinPcap, WinDivert ou WinNAT no modo normal. O código usa `songgao/water` somente para TAP/bridge.

### Broadcast, multicast, ICMP e IPv6

- broadcast Ethernet é distribuído pelo switch virtual;
- o proxy de saída descarta UDP destinado ao broadcast `255.255.255.255` e link-local;
- multicast externo não tem suporte documentado e não deve ser prometido;
- ICMP existe na pilha interna, mas não é encaminhado à rede externa; a documentação diz ping não suportado;
- a configuração Wokwi cria apenas rede IPv4; IPv6 não foi confirmado.

### Isolamento e encerramento

Um processo cria uma `VirtualNetwork` compartilhada por seus clientes WebSocket. Portanto, não há evidência de isolamento por cliente dentro do mesmo processo. Instâncias separadas do gateway isolam redes. Contextos/conexões são fechados na desconexão, mas uma especificação formal de isolamento e lifecycle não foi encontrada.

## 8. `host.wokwi.internal`

O mecanismo é comprovado por código:

```text
lwIP da ESP32 envia consulta DNS ao gateway
    ↓
DNS interno responde 10.13.37.254
    ↓
ESP32 conecta a 10.13.37.254:porta
    ↓
gateway reconhece o IP virtual
    ↓
destino real substituído por 127.0.0.1:porta
    ↓
socket do processo/serviço no host
```

Não é uma resolução para `127.0.0.1` dentro da ESP32: isso apontaria para a própria ESP32. O endereço intermediário reservado é essencial. O comportamento é confirmado apenas para o Private Gateway; no Public, o nome não poderia alcançar o computador do usuário sem um agente/túnel local e não há documentação afirmando isso.

### Nome recomendado

Usar **`host.lasecsimul.internal`**. A ICANN reservou permanentemente `.INTERNAL` contra delegação na raiz para uso privado em 29/07/2024 ([resolução 2024.07.29.06](https://www.icann.org/en/board-activities-and-meetings/materials/approved-resolutions-special-meeting-of-the-icann-board-29-07-2024-en)). O prefixo `lasecsimul` evita colisão com outros simuladores na mesma rede e representa o produto que administra o gateway. `host.simulide.internal` seria mais apropriado apenas se o recurso fosse incorporado e mantido pelo upstream SimulIDE.

Proposta IPv4 inicial:

- rede por sessão: `10.77.N.0/24` ou bloco dinamicamente escolhido sem colisão;
- gateway `.1`, convidado por DHCP, host virtual `.254`;
- DNS A para `host.lasecsimul.internal = .254`;
- sem AAAA no MVP; posteriormente usar ULA IPv6 por sessão e AAAA, nunca `::1` no convidado.

## 9. Redirecionamento de portas

No Wokwi normal, um listener TCP/UDP do host é criado explicitamente. A conexão recebida é injetada na pilha gVisor e chega como conexão comum à lwIP/servidor da ESP32. O default é TCP `localhost:9080 → 10.13.37.2:80`; CLI aceita TCP e prefixo `udp:`. O `wokwi.toml` no VS Code usa:

```toml
[[net.forward]]
from = "localhost:8180"
to = "target:80"
```

O listener deve ficar em loopback por padrão. Exposição em `0.0.0.0` precisa ser opção explícita com aviso. Colisão de porta deve falhar de forma visível; listeners e conexões precisam ser encerrados junto da simulação.

Para LasecSimul, o JSON sugerido pelo pedido é coerente com o estilo de projeto e deve ser adotado com pequenos acréscimos:

```json
{
  "network": {
    "mode": "private-gateway",
    "isolationGroup": "default",
    "allowInternet": true,
    "allowHost": false,
    "allowLan": false,
    "hostAlias": "host.lasecsimul.internal",
    "forward": [
      {
        "listenAddress": "127.0.0.1",
        "hostPort": 8180,
        "target": "esp32",
        "targetPort": 80,
        "protocol": "tcp"
      }
    ]
  }
}
```

`allowHost` deve tornar o alias utilizável; um forward de entrada não deve implicitamente liberar todas as portas de saída do host.

## 10. Access point virtual e PCAP

### AP confirmado

A referência [`wokwi-wifi-ap`](https://docs.wokwi.com/parts/wokwi-wifi-ap) documenta:

- SSID;
- senha WPA2-PSK;
- canal 1–13;
- BSSID automático ou configurado;
- `internet: 0` para rede sem internet;
- múltiplos APs para scan e seleção;
- supressão de `Wokwi-GUEST` quando há AP customizado.

O AP default é aberto, canal 6, BSSID `42:13:37:55:aa:01`. A documentação não oferece propriedade RSSI, posição, perda de caminho ou colisão. Qualquer modelo desse tipo é [NC].

### PCAP

O PCAP baixado pela interface contém 802.11 beacon, DNS, HTTP e demais pacotes decodificáveis pelo Wireshark. Os timestamps usam relógio de simulação. Isso localiza a captura no modelo MAC/AP, antes de converter dados 802.11 para Ethernet.

O gateway aberto também tem `--captureFile` no modo bridge; esse arquivo é Ethernet e usa relógio de parede (`time.Now()`), portanto **não é** a mesma captura Wi-Fi oferecida pelo simulador.

Proposta LasecSimul:

- ponto A: MAC/AP, DLT_IEEE802_11 ou radiotap; timestamp de tempo virtual;
- ponto B: enlace QEMU–gateway, DLT_EN10MB; timestamp de tempo virtual anexado ao framing;
- opcional pcapng com duas interfaces, metadados de SSID/BSSID/canal/RSSI;
- ring buffer e escrita assíncrona para limitar custo;
- opção GUI “Capturar Wi-Fi”, caminho de arquivo e botão “Abrir no Wireshark”;
- HTTPS aparece como TLS, não como HTTP legível; não fazer MITM.

## 11. Código público Wokwi relevante

Datas abaixo são de último `push` reportado pelo GitHub em 2026-07-15.

| Repositório | Finalidade/relação | Linguagem | Licença | Última atualização | Reutilização |
|---|---|---:|---|---|---|
| [`wokwigw`](https://github.com/wokwi/wokwigw) | Private IoT Gateway; configuração, WS, bridge, forwards | Go | MIT | 2025-07-31 | Sim, mantendo aviso MIT |
| [`wokwi-docs`](https://github.com/wokwi/wokwi-docs) | documentação do simulador | JavaScript/MD | repo MIT; conteúdo declarado CC BY 4.0 | 2026-07-09 | ideias/documentação com atribuição adequada |
| [`wokwi-cli`](https://github.com/wokwi/wokwi-cli) | CLI/CI, não núcleo Wi-Fi | TypeScript | MIT | 2026-06-06 | pouca utilidade à rede |
| [`dhcp-wasm`](https://github.com/wokwi/dhcp-wasm) | servidor DHCP em WASM | Go | BSD-3-Clause | 2022-11-03 | possível, mas não é dependência do gateway atual |
| [`esp32-test-binaries`](https://github.com/wokwi/esp32-test-binaries) | firmwares/testes binários ESP32, inclui testes Wi-Fi | Python/binários | sem licença detectada | 2026-07-12 | evidência/teste; não redistribuir/reusar sem licença |
| [`wokwi-tests`](https://github.com/wokwi/wokwi-tests) | testes históricos | C++ | sem licença detectada | 2023-12-05 | somente referência; sem permissão implícita |
| [`esp32-idf-hello-wifi`](https://github.com/wokwi/esp32-idf-hello-wifi) | exemplo de uso ESP-IDF | C | MIT | 2025-09-26 | teste de integração, não implementação |
| [`esp32-http-server`](https://github.com/wokwi/esp32-http-server) | servidor ESP32 e forward | C++ | MIT | 2023-10-25 | teste de entrada |
| [`wokwi-elements`](https://github.com/wokwi/wokwi-elements) | componentes visuais web | TypeScript | MIT | 2026-07-15 | não contém simulador Wi-Fi |

Dependência central do gateway: [`containers/gvisor-tap-vsock`](https://github.com/containers/gvisor-tap-vsock), v0.8.3/commit `f0f18025e5b7c7c281a11dfd81034641b40efe18`, Apache-2.0. Arquivos relevantes incluem `pkg/types/configuration.go`, `pkg/tap/protocols.go`, `pkg/tap/switch.go`, `pkg/services/dhcp`, `pkg/services/dns` e `pkg/services/forwarder`.

Não foi encontrado repositório oficial aberto com o controlador ESP32 Wi-Fi, AP/MAC 802.11, PCAP do navegador ou Public Gateway. A existência de muitos repositórios Wokwi abertos não implica que o simulador ESP32 seja aberto; a própria palestra diz que a parte ESP32 não era open source.

## 12. Auditoria dos fontes locais

### QEMU `qemu-simulide-1`

- snapshot declara QEMU `9.2.2`;
- máquina ESP32/`esp32-simul` executa firmware Xtensa e integra periféricos;
- `hw/xtensa/esp32.c` e `esp32-simul.c` instanciam `open_eth` em `DR_REG_EMAC_BASE`, IRQ `ETS_ETH_MAC_INTR_SOURCE`;
- busca em `hw` não encontrou `esp32_wifi`, Wi-Fi nem os registradores `0x3ff73d20`, `0x3ff73088`, `0x3ff73c48`;
- há infraestrutura QEMU `NetClientState`, TAP/socket e `net/dump.c` para PCAP Ethernet;
- `net/slirp.c` existe, mas `slirp_input`, `slirp_new`, poll, cleanup e migração estão comentados; no estado examinado, `-netdev user` não deve ser considerado funcional;
- o repositório Git local não permitiu resolver `HEAD` (`fatal: bad object HEAD`), portanto a identificação confiável é o conteúdo + `VERSION`, não um commit.

### SimulIDE `simulide_2`

- `QemuDevice` cria memória compartilhada, inicia um `QProcess` QEMU e sincroniza tempo/registros/IRQ;
- `qemuArena` não possui fila/buffer de rede;
- `esp32/esp32.cpp` carrega flash de 4 MiB, usa `-M esp32-simul`, ROMs e `-icount`;
- o mesmo arquivo passa `-nic user,model=esp32_wifi,id=u1,net=192.168.4.0/24`, embora esse modelo não exista nos fontes QEMU examinados;
- não há propriedades GUI para rede ESP32, AP, gateway, forward ou PCAP;
- `QemuDevice::m_pSelf` é singleton estático e merece correção antes de múltiplas ESP32, embora as chaves de memória compartilhada sejam por processo/componente;
- licença raiz: GNU AGPL-3.0;
- o worktree já estava extensamente alterado antes desta pesquisa; nada foi modificado.

### Lacuna funcional

O caminho atual não é “Wi-Fi incompleto”; ele é uma sobreposição inconsistente entre um argumento de NIC inexistente, um MAC Ethernet diferente e um slirp neutralizado. Antes do Wi-Fi, deve haver um teste de baseline que prove criação da NIC, DHCP e tráfego Ethernet.

### Trilha adicional: completar Ethernet no QEMU

É não apenas possível, mas recomendável fazer o Ethernet funcionar completamente antes do Wi-Fi. Há uma base melhor do que a análise inicial sugeria:

- `hw/net/opencores_eth.c` é um dispositivo QEMU completo: MMIO, descritores TX/RX, DMA na memória convidada, IRQ, MII/PHY e integração `NetClientState`;
- o arquivo local deriva do OpenCores Ethernet upstream e acrescenta comportamento do PHY DP83848C e inicialização do MAC, alterações plausivelmente feitas para o uso ESP32;
- o ESP-IDF possui um driver específico `CONFIG_ETH_USE_OPENETH`, oficialmente descrito como “OpenCores Ethernet MAC (for use with QEMU)”; ele usa buffers DMA de 1600 bytes e não representa hardware presente no chip físico;
- `net/stream.c` já transporta quadros Ethernet com o mesmo framing usado por `gvisor-tap-vsock`: comprimento de 32 bits em ordem de rede seguido pelo quadro. Isso permite ligar o QEMU diretamente a um gateway separado sem criar um backend de rede novo;
- o bloqueio principal imediato está em `net/slirp.c`: comparado ao QEMU upstream v9.2.2, 33 linhas funcionais foram comentadas e substituídas por stubs. Isso inclui criação da instância, entrada de quadros, poll, cleanup, estado, hostfwd/guestfwd e diagnóstico.

Há dois níveis de “Ethernet completo” que precisam ser distinguidos:

1. **OpenETH virtual do ESP-IDF:** firmware recompilado com `CONFIG_ETH_USE_OPENETH` e inicializado com a API `esp_eth`. É o caminho mais curto, bem alinhado ao dispositivo atual. A aplicação mantém lwIP, DNS, TCP/UDP, HTTP, MQTT e TLS, mas usa Ethernet/`ETH`, não `WiFi.begin()`/`esp_wifi`.
2. **EMAC real da ESP32 + PHY virtual:** emular fielmente o MAC interno, RMII/SMI e um PHY suportado, para firmware configurado como uma placa Ethernet física. É mais fiel ao hardware, mas desnecessário para o primeiro MVP, pois o ESP-IDF já fornece OpenETH especificamente para QEMU.

Portanto, completar Ethernet **não elimina** a futura engenharia reversa de Wi-Fi e não torna firmware que chama `WiFi.begin()` automaticamente compatível. Ele entrega, porém, toda a rede IP e de aplicações e cria a fronteira Ethernet exata que depois será alimentada pelo AP virtual Wi-Fi.

#### Mudanças que a implementação futura deverá fazer

1. Restaurar `net/slirp.c` a partir da mesma tag QEMU v9.2.2, revisando conscientemente a diferença de include/empacotamento da libslirp; não apenas descomentar trechos isolados.
2. Fixar e empacotar uma versão suportada da libslirp para Windows/Linux/macOS, com teste de ABI e licença.
3. Trocar no SimulIDE o modelo inexistente `esp32_wifi` por `open_eth`, ou separar explicitamente `-netdev user,id=net0` e a NIC onboard associada a `net0`.
4. Confirmar que `CONFIG_OPENCORES_ETH` está habilitado no target Xtensa e que a máquina conecta a NIC ao backend solicitado.
5. Criar firmware de teste ESP-IDF com `CONFIG_ETH_USE_OPENETH`, `esp_netif`, DHCP e handlers `ETH_EVENT`/`IP_EVENT_ETH_GOT_IP`.
6. Validar RX/TX, MAC, link up/down, MTU, checksum, quadros curtos/grandes, broadcast, ARP e reset.
7. Testar `-netdev user` com DHCP/DNS/TCP/UDP e `hostfwd`; em seguida testar `-netdev stream` contra o LasecSimul IoT Gateway.
8. Só depois expor configuração Ethernet estável na interface do SimulIDE.

#### Critério de conclusão da trilha Ethernet

- 100 ciclos boot/DHCP/reset sem perda de descritor ou deadlock;
- DNS, HTTP/HTTPS, MQTT, WebSocket e NTP funcionando pela lwIP convidada;
- servidor TCP e UDP na ESP32 alcançável por forward ligado somente a loopback;
- PCAP Ethernet válido no Wireshark com ARP, DHCP, DNS e TCP;
- link down/up e encerramento do backend tratados sem travar o QEMU;
- Windows sem administrador no modo slirp/gateway;
- pelo menos duas instâncias isoladas sem colisão de MAC/IP/porta.

## 13. Comparação Wokwi × QEMU/SimulIDE atual

| Aspecto | Wokwi | QEMU/SimulIDE atual | Alteração necessária |
|---|---|---|---|
| Execução do firmware | binário real | QEMU/TCG + flash | validar versões/boot |
| Emulação da CPU | Xtensa/RISC-V proprietária | QEMU Xtensa | manter |
| Driver Wi-Fi | original ESP-IDF | sem modelo capaz de atendê-lo | modelo MMIO/DMA/IRQ |
| Registradores Wi-Fi | mínimos reais RE | ausentes | novo SysBusDevice |
| MAC 802.11 | sim | ausente | MAC/AP próprio |
| PHY | não confirmada | ausente | fora do MVP |
| AP virtual | default/custom/múltiplos | ausente | domínio rádio/AP |
| DHCP | gateway | slirp quebrado | restaurar libslirp ou gateway |
| DNS | gateway + zona interna | ausente | DNS interno |
| TCP/UDP | lwIP convidada + proxy host | potencial, não funcional | enlace L2 + backend |
| Gateway local | `wokwigw` | ausente | processo separado |
| Internet | Public/Private | não comprovada | egress controlado |
| Host | alias `.254` | ausente | DNS + IP virtual |
| LAN | Private/bridge | ausente | ACL; bridge opcional |
| Port forwarding | TCP/UDP | ausente | listeners explícitos |
| PCAP | 802.11 sim-time + Ethernet bridge | `net/dump` Ethernet genérico | hooks duplos |
| Múltiplas ESP32 | não no mesmo projeto | riscos singleton/endereços | sessões, switch, IDs únicos |
| Configuração UI | ícone/AP/wokwi.toml | ausente | propriedades + JSON |
| Segurança | cloud monitorado; private loopback/origin | inexistente | autenticação, ACL, lifecycle |

### Resultado possível após a trilha Ethernet

Depois dessa correção, a coluna QEMU/SimulIDE passa a ter firmware real + lwIP, DHCP/DNS, TCP/UDP, internet, acesso controlado ao host, port forwarding e PCAP Ethernet. Continuam ausentes somente os recursos especificamente Wi-Fi: APIs `esp_wifi`, scan, associação, SSID/BSSID/canal, WPA2 e PCAP 802.11. Essa separação torna o avanço mensurável e evita que o gateway fique bloqueado pela engenharia reversa do rádio.

## 14. Estratégias: socket versus pacote

| Critério | Proxy de operações de socket | Gateway de pacotes |
|---|---|---|
| Firmware original | requer hook/alteração de lwIP ou ABI | preserva lwIP e APIs |
| scan/associação/WPA2 | não representa | representável no MAC/AP |
| DHCP/DNS/ARP | precisa falsificar/contornar | tráfego real do convidado |
| protocolos de aplicação | precisa mapear semântica/lifecycle | transparentes sobre TCP/UDP |
| PCAP | artificial | realista em 802.11/Ethernet |
| complexidade inicial | menor | maior |
| fidelidade final | limitada | caminho correto |

**Decisão:** pacote. A fronteira QEMU–gateway deve ser Ethernet, reproduzindo a separação comprovada no Wokwi. Dentro do QEMU, a fronteira controlador–AP deve ser quadro 802.11. Um proxy de socket não atende o requisito principal de firmware ESP-IDF/Arduino inalterado.

## 15. Componentes existentes

| Componente | Uso recomendado |
|---|---|
| libslirp / QEMU `-netdev user` | melhor atalho para Ethernet funcional; DHCP, DNS, NAT e hostfwd, mas restaurar `net/slirp.c` a partir do QEMU 9.2.2 upstream |
| gvisor-tap-vsock | forte candidato ao gateway separado; mesma base comprovada pelo Wokwi; Go + Apache-2.0 |
| virtio-net | não usar: firmware ESP32 não tem driver virtio |
| `open_eth` | útil apenas com driver Ethernet ESP-IDF; não satisfaz `esp_wifi` |
| TAP/TUN | bridge avançada; requer privilégio/driver e amplia superfície de segurança |
| lwIP | manter a instância já contida no firmware; não duplicar no QEMU |
| picoTCP/smoltcp | desnecessários se libslirp/gVisor forem usados |
| dnsmasq | opcional em bridge Linux; não necessário no modo user |
| WinNAT/Npcap/WinDivert | não necessários no MVP sem privilégio; avaliar só para bridge/captura avançada |
| QEMU `-netdev stream` | já envia `uint32` big-endian + quadro Ethernet; encaixa diretamente no protocolo QEMU de gvisor-tap-vsock |
| WebSocket | adaptador compatível e depurável; útil se houver browser/remoto |
| Named Pipe/Unix socket | melhor default local QEMU–gateway: ACL do SO, sem porta fixa |
| gRPC | excesso de framing/semântica para quadros; útil apenas no plano de controle |
| shared memory | otimização posterior; exige filas, backpressure e sincronização |
| PCAP/pcapng | formato de captura; pcapng preferível para múltiplas interfaces |

Para o primeiro gateway, recomenda-se reutilizar `-netdev stream` e seu framing Ethernet já testado. Autenticação/negociação podem ocorrer em um canal de controle separado ou antes de entregar o socket ao QEMU. Pipe nomeado no Windows e Unix domain socket no Linux/macOS continuam desejáveis, mas devem ser confirmados contra os tipos `SocketAddress` realmente suportados em cada build. WebSocket pode ser adaptador opcional. Isso reduz mudanças no QEMU e mantém a ideia arquitetural do Wokwi sem copiar código proprietário.

## 16. Arquitetura proposta

```text
SimulIDE (configuração, lifecycle, UI)
  ├─ QEMU ESP32
  │    ├─ CPU + firmware original
  │    ├─ dispositivo Wi-Fi MMIO/DMA/IRQ
  │    ├─ MAC 802.11 STA
  │    ├─ domínio rádio/AP virtual
  │    ├─ bridge 802.11 data ↔ Ethernet
  │    └─ captura 802.11 com relógio virtual
  │
  └─ LasecSimul IoT Gateway (processo filho)
       ├─ endpoint autenticado por sessão
       ├─ switch Ethernet por grupo de isolamento
       ├─ ARP/DHCP/DNS
       ├─ NAT/proxy TCP e UDP
       ├─ alias do host e ACL host/LAN/internet
       ├─ port forwarding explícito
       ├─ captura Ethernet/logs
       └─ encerramento junto da simulação
```

A divisão corresponde ao Wokwi nas fronteiras relevantes: MAC/AP no simulador; rede Ethernet/host no gateway. DHCP pertence ao gateway, não ao AP em si, embora a configuração do AP selecione qual rede/gateway é usada.

### Segurança por padrão

- gateway como filho do SimulIDE, porta efêmera ou pipe, nunca `0.0.0.0`;
- nonce aleatório de 256 bits passado por handle/pipe herdado; `Origin` apenas defesa adicional;
- uma rede virtual por `isolationGroup`;
- internet opcional; LAN, loopback, link-local, metadados cloud e redes privadas bloqueados por default;
- alias do host separado de LAN e com allowlist de portas opcional;
- revalidar endereço após DNS para impedir DNS rebinding;
- forward somente loopback por default;
- limites de conexões, datagramas, MTU, memória e throughput;
- zerar listeners, leases e conexões ao parar/resetar;
- logs sem payload/senhas por default.

## 17. Plano em fases

### Fase 0 — baseline e decisões

- congelar versão/commit válidos dos dois repositórios;
- restaurar build reproduzível;
- remover a inconsistência `esp32_wifi` versus `open_eth` por decisão explícita, não por workaround;
- restaurar `net/slirp.c` da tag upstream correspondente e empacotar libslirp;
- verificar as alterações locais do DP83848C em `opencores_eth.c` com testes, preservando-as se necessárias ao ESP-IDF;
- testes de boot, reset e múltiplos processos.

### Fase 1 — PoC IP/Ethernet

- firmware ESP-IDF de teste usando `CONFIG_ETH_USE_OPENETH` e `esp_eth_mac_new_openeth`;
- quadros Ethernet até libslirp/gateway;
- DHCP, DNS A, TCP, UDP;
- HTTP e MQTT externos;
- teste automatizado com servidor local controlado;
- logs e PCAP Ethernet.

Esse PoC requer firmware compilado para OpenETH, mas preserva a lwIP e as aplicações de rede acima da interface. Ele pode evoluir para um modo Ethernet útil do produto, não apenas código descartável. Ainda não cumpre Wi-Fi inalterado.

### Fase 2 — LasecSimul IoT Gateway

- processo separado sem admin;
- pipe/UDS autenticado, sessão e versionamento;
- gvisor-tap-vsock ou wrapper maduro equivalente;
- rede IPv4 isolada, DHCP/DNS, egress TCP/UDP;
- ACL internet/host/LAN;
- health check e lifecycle do processo;
- cobertura unitária de framing, DNS, DHCP e falhas.

### Fase 3 — hostname interno

- `host.lasecsimul.internal` → IP virtual `.254`;
- tradução somente no gateway;
- IPv4 primeiro; ULA/AAAA posterior;
- `allowHost` e allowlist de portas;
- testes para provar que `127.0.0.1` no convidado continua sendo o convidado.

### Fase 4 — port forwarding

- TCP primeiro, UDP depois;
- JSON validado, binding loopback default;
- target por ID de componente, não IP estático;
- detecção de colisões e status GUI;
- encerramento atômico e teste de reconnect/reset.

### Fase 5 — Wi-Fi/AP virtual

- modelo mínimo dos registradores descobertos por estudo independente;
- DMA TX/RX, descritores, status e IRQ;
- quadros data 802.11 e bridge para Ethernet;
- beacon, probe, autenticação/associação open;
- scan, SSID/BSSID/canal/RSSI determinístico;
- WPA2-PSK depois do AP aberto;
- múltiplos APs e flag de internet;
- matriz de ESP-IDF/Arduino por versão.

### Fase 6 — captura

- pcapng 802.11 e Ethernet;
- relógio virtual e precisão documentada;
- Wireshark: filtros `wlan`, `dhcp`, `dns`, `tcp`, `mqtt`;
- ring buffer, limites e captura por instância/conjunta.

### Fase 7 — GUI

- ligar rede, modo user/private/bridge;
- AP, senha, canal, BSSID, RSSI;
- permissões internet/host/LAN;
- IP/MAC/gateway/DNS/estado;
- editor de forwards;
- iniciar/parar captura e abrir logs;
- avisos claros ao expor LAN ou `0.0.0.0`.

### Fase 8 — múltiplas ESP32

- eliminar singleton `m_pSelf`;
- MAC localmente administrado único e persistente por componente;
- DHCP por ID/MAC;
- switch por grupo de isolamento;
- comunicação opcional entre convidados;
- portas associadas a `target` por componente;
- reset independente e captura por interface;
- testes com 2, 8 e stress de N instâncias.

## 18. MVP recomendado

O menor MVP útil passa a ser explicitamente o **MVP Ethernet**:

1. uma ESP32/QEMU executando firmware ESP-IDF configurado com OpenETH;
2. `open_eth` com RX/TX/DMA/IRQ e enlace Ethernet em nível de quadro;
3. primeiro libslirp restaurada; depois gateway local filho, sem admin, somente IPv4;
4. DHCP/DNS/TCP/UDP e internet;
5. `host.lasecsimul.internal` controlado;
6. um forward TCP loopback;
7. PCAP Ethernet e testes HTTP/MQTT.

Esse MVP já permite que aplicações HTTP/MQTT/TLS funcionem pela pilha original, desde que selecionem Ethernet. Ele prova a arquitetura e o gateway e pode ser entregue como recurso independente. O menor MVP **compatível com firmware Wi-Fi Arduino/ESP-IDF sem modificação** acrescenta controlador MMIO/DMA/IRQ, AP aberto único, associação mínima e quadros data 802.11. Não há atalho de socket que satisfaça esse segundo critério.

## 19. Testes reproduzíveis

### Testes Wokwi a executar em ambiente autorizado

1. Associação: registrar eventos, `localIP`, gateway, DNS, MAC, BSSID, canal e RSSI; repetir com e sem canal fixado.
2. DNS/HTTP: resolver domínio controlado, imprimir IP, conectar TCP e guardar PCAP.
3. Host: Private Gateway + servidor HTTP em loopback; acessar `host.wokwi.internal`.
4. Entrada: servidor ESP32 + `localhost:9080` e forward customizado TCP/UDP.
5. PCAP: verificar beacon, probe, auth, association, DHCP, ARP, DNS, TCP e aplicação. A ausência de uma classe deve ser registrada, não presumida.
6. AP sem internet: `internet: 0`; testar DHCP/local e falha externa.
7. Múltiplos APs: scan, BSSID, canal, RSSI, open/WPA2 e seleção.

### Testes locais propostos

- validação estática de que todo modelo pedido em `-nic` está registrado no QEMU;
- DHCP Discover/Offer/Request/Ack capturado;
- DNS estático do host e recursivo externo em UDP/TCP;
- HTTP, HTTPS, MQTT, WebSocket e NTP como tráfego transparente;
- bloqueio de ICMP/multicast/privados conforme política;
- host forward TCP/UDP e colisão de porta;
- fechamento de todos os sockets após stop/reset;
- golden PCAP com timestamps de tempo virtual;
- boot de Arduino core e ESP-IDF em versões suportadas;
- múltiplas instâncias com MAC/IP únicos.

Resultados desta etapa: a documentação e o código público confirmaram os fluxos; `go test` não foi executado porque Go não está instalado; o modelo QEMU não foi iniciado porque não há binário construído. Esses dois itens devem constar como pendências de reprodução, não como falhas do software externo.

## 20. Licenças e implementação clean-room

- QEMU local: GPL-2.0 (o upstream é GPL-2.0-or-later por arquivo/subsistema; verificar cabeçalhos de cada arquivo alterado).
- SimulIDE local: AGPL-3.0.
- `wokwigw`: MIT, permite uso/modificação/redistribuição com preservação do aviso.
- `gvisor-tap-vsock`: Apache-2.0, compatível com GPLv3/AGPLv3; não é compatível com GPLv2-only em combinação direta. QEMU possui mistura de licenças e a análise deve ser por módulo. Um processo separado reduz acoplamento jurídico, mas não substitui revisão legal.
- `dhcp-wasm`: BSD-3-Clause, permissiva com avisos e cláusula de não endosso.
- sem licença significa sem permissão para copiar/modificar/redistribuir.

Regras recomendadas:

1. usar especificações públicas, documentação, comportamento observável e código permissivo identificado;
2. implementar o dispositivo Wi-Fi de forma independente, com caderno de requisitos e origem de cada fato;
3. não copiar código Wokwi proprietário, bundles minificados, decompilações ou blobs Espressif;
4. não distribuir material derivado de firmware fechado;
5. separar equipe de pesquisa/especificação e implementação se a assessoria jurídica considerar necessário;
6. preservar avisos MIT/Apache/BSD e publicar o código exigido por GPL/AGPL;
7. obter revisão jurídica sobre EULAs Espressif, interoperabilidade e legislação local antes da engenharia reversa aprofundada.

É permitido reimplementar uma ideia/arquitetura; copyright protege expressão, não a ideia abstrata. Patentes, contratos e regras antievasão são questões separadas e dependem da jurisdição.

## 21. Riscos técnicos

| Risco | Impacto | Mitigação |
|---|---|---|
| mapa Wi-Fi/descritores incompletos | firmware trava ou varia por IDF | instrumentação, matriz de versões, RE incremental |
| blobs Espressif diferentes | regressões por versão/chip | perfis ESP32/ESP32-S2/S3/C3 separados |
| timing/IRQ incorreto | races difíceis | relógio virtual determinístico e traces |
| WPA2/crypto | grande complexidade | AP aberto primeiro, vetores públicos depois |
| slirp local adulterado | PoC falso/instável | restaurar upstream e testar isoladamente |
| singleton/multi-instância | corrupção de estado | remover globais antes da fase 8 |
| gateway expõe host/LAN | vulnerabilidade SSRF/RCE indireta | deny-by-default, token, loopback, ACL |
| DNS rebinding | contorna ACL | validar IP final em toda conexão |
| licenças/RE | bloqueio de distribuição | clean-room e revisão jurídica |
| desempenho PCAP | simulação lenta | captura opcional, ring buffer, filtros |
| diferença relógio real/virtual | timeouts e PCAP confuso | política explícita de sincronização |
| ausência de PHY | testes RF não realistas | declarar escopo; modelo estatístico posterior |

Nenhum desses riscos impede a rede IP. O principal risco para fidelidade Wokwi é a engenharia reversa do periférico Wi-Fi e sua estabilidade entre famílias/versões.

## 22. Decisão objetiva

1. **É possível?** Sim, em arquitetura equivalente; não por simples configuração do estado atual.
2. **Partes diretas?** Gateway Ethernet, DHCP/DNS, TCP/UDP, host alias, forwards, PCAP Ethernet, GUI e isolamento.
3. **Exigem RE?** Registradores Wi-Fi, descritores DMA, eventos/IRQ, interação com blobs e detalhes necessários ao MAC da família ESP32.
4. **Recursos QEMU?** TCG, dispositivos SysBus/MMIO, IRQ, DMA em memória convidada, NetClientState, backends, TAP, dump PCAP e libslirp upstream.
5. **Modificar firmware?** Não no alvo final; sim ou firmware Ethernet específico pode ser usado somente no PoC.
6. **Arduino/ESP-IDF inalterados?** Em princípio sim, depois do modelo Wi-Fi suficiente; não hoje.
7. **Começar onde?** Pacote Ethernet para o PoC/gateway; paralelamente quadro 802.11/MMIO para compatibilidade. Não socket proxy.
8. **Gateway separado?** Sim; melhora segurança, atualização, isolamento e portabilidade.
9. **Sem admin no Windows?** Sim no modo user/proxy com sockets e named pipe; não para bridge TAP tradicional.
10. **Menor MVP?** Ethernet + gateway IPv4 + DHCP/DNS/TCP/UDP + HTTP/MQTT + alias + um forward + PCAP Ethernet.
11. **Caminho à fidelidade Wokwi?** MMIO/DMA/IRQ → AP aberto/802.11 data → scan/management → WPA2/múltiplos APs → PCAP 802.11 → multi-ESP32.
12. **Riscos impeditivos?** Cobertura do periférico fechado, variação dos blobs/licenças e recursos de engenharia; o gateway em si não é o gargalo.

## 23. Referências primárias

Todas acessadas em 2026-07-15.

1. Wokwi/CodeMagic Ltd., *ESP32 WiFi Networking*, documentação oficial: https://docs.wokwi.com/guides/esp32-wifi
2. Wokwi/CodeMagic Ltd., *Frequently Asked Questions*, seção “How does Wokwi work?”: https://docs.wokwi.com/faq
3. Wokwi/CodeMagic Ltd., *Configuring Your Project (wokwi.toml)*: https://docs.wokwi.com/vscode/project-config
4. Wokwi/CodeMagic Ltd., *wokwi-wifi-ap Reference*: https://docs.wokwi.com/parts/wokwi-wifi-ap
5. Uri Shaked/Wokwi, *Wokwi IoT Network Gateway*, código MIT: https://github.com/wokwi/wokwigw
6. Uri Shaked, *Remoticon 2021 // Uri Shaked Reverse Engineers ESP32 WiFi*, Hackaday, 30/12/2021: https://www.youtube.com/watch?v=XmaT8bMssyQ
7. Uri Shaked, *Reversing the ESP32 WiFi*, slides: https://docs.google.com/presentation/d/1XVXcjsA3jOGXkLbDOruA-IS346oupgpJrdhR7TaRvU4
8. Elliot Williams, Hackaday, *Remoticon 2021: Uri Shaked Reverses The ESP32 WiFi*, 30/12/2021: https://hackaday.com/2021/12/30/remoticon-2021-uri-shaked-reverses-the-esp32-wifi/
9. Containers, *gvisor-tap-vsock*, Apache-2.0, versão usada v0.8.3: https://github.com/containers/gvisor-tap-vsock/tree/v0.8.3
10. Wokwi organização oficial no GitHub: https://github.com/wokwi
11. ICANN Board, resolução 2024.07.29.06 reservando `.INTERNAL`, 29/07/2024: https://www.icann.org/en/board-activities-and-meetings/materials/approved-resolutions-special-meeting-of-the-icann-board-29-07-2024-en
12. QEMU Project, documentação de networking/libslirp (referência de implementação futura): https://www.qemu.org/docs/master/system/devices/net.html
13. Espressif Systems, opção `CONFIG_ETH_USE_OPENETH`, driver OpenCores para QEMU: https://docs.espressif.com/projects/esp-idf/en/v5.1.5/esp32/api-reference/kconfig.html
14. QEMU Project, `net/slirp.c` v9.2.2 usado como baseline de comparação: https://gitlab.com/qemu-project/qemu/-/blob/v9.2.2/net/slirp.c
15. QEMU Project, `net/stream.c` v9.2.2, transporte de quadros com comprimento de 32 bits: https://gitlab.com/qemu-project/qemu/-/blob/v9.2.2/net/stream.c

## 24. Artefatos locais auditados

- `G:\Meu Drive\SourceCode\qemu-simulide-1\VERSION`
- `G:\Meu Drive\SourceCode\qemu-simulide-1\COPYING`
- `G:\Meu Drive\SourceCode\qemu-simulide-1\hw\xtensa\esp32.c`
- `G:\Meu Drive\SourceCode\qemu-simulide-1\hw\xtensa\esp32-simul.c`
- `G:\Meu Drive\SourceCode\qemu-simulide-1\net\slirp.c`
- `G:\Meu Drive\SourceCode\qemu-simulide-1\net\dump.c`
- `C:\SourceCode\simulide_2\COPYING`
- `C:\SourceCode\simulide_2\src\microsim\cores\qemu\qemudevice.h`
- `C:\SourceCode\simulide_2\src\microsim\cores\qemu\qemudevice.cpp`
- `C:\SourceCode\simulide_2\src\microsim\cores\qemu\esp32\esp32.cpp`

---

**Conclusão final:** a melhor inspiração a extrair do Wokwi não é um protocolo específico nem código proprietário, mas a separação de responsabilidades: firmware e lwIP intactos; periférico/MAC/AP no simulador; Ethernet como fronteira; gateway user-mode separado para DHCP/DNS/TCP/UDP/host/forward. O projeto local já possui a base de CPU e integração de processo, mas ainda não possui nenhum dos blocos Wi-Fi e precisa recuperar primeiro uma camada Ethernet funcional e verificável.

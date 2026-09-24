# Plano: Wi-Fi transparente da ESP32 no QEMU

> Data: 2026-09-23  
> Projeto integrador: `C:\SourceCode\LasecSimul`  
> Fonte canônica do QEMU: `C:\SourceCode\qemu_lasecSimul`

## 1. Objetivo

Permitir que um firmware Arduino comum seja executado pela ESP32 simulada sem
qualquer configuração OpenETH no projeto do usuário:

```cpp
#include <WiFi.h>

WiFi.begin("qualquer-ssid", "qualquer-senha");
while (WiFi.status() != WL_CONNECTED) {
    delay(100);
}
```

O resultado esperado é:

- `framework = arduino` continua suficiente;
- não existem `CONFIG_ETH_USE_OPENETH`, `sdkconfig.openeth`, `WiFiCompat.h` ou
  inicialização manual de `esp_eth` no firmware;
- `WiFi.begin()` funciona apenas como gatilho de conexão; o QEMU ignora
  completamente SSID e senha;
- a ESP32 simulada usa diretamente o backend conectado à rede do computador;
- não existe modo AP, autenticação WPA, associação real ou rede Wi-Fi
  configurável dentro do simulador;
- `WiFi.status()`, `WiFi.localIP()`, DNS, TCP, UDP, HTTP, MQTT e TLS continuam
  passando pela pilha normal do firmware;
- mDNS, servidor HTTP e Arduino OTA podem ser alcançados pelo host quando o
  backend selecionado oferecer tráfego de entrada;
- OpenETH permanece temporariamente disponível como fallback, mas deixa de ser
  requisito do usuário Arduino.

## 2. Decisão arquitetural

Não substituir `WiFi.begin()` por uma biblioteca de compatibilidade. O firmware
deve continuar carregando o `WiFi.h` oficial e o driver `esp_wifi` que já acompanha
o Arduino ESP32.

O caminho será:

```text
Aplicação Arduino
    |
    | WiFi.begin()/WiFiClient/WebServer/ArduinoOTA
    v
Arduino Core + esp_wifi + lwIP do firmware, sem alterações
    |
    | registradores, DMA e interrupções Wi-Fi da ESP32
    v
QEMU esp32_wifi + uplink virtual direto em modo estação
    |
    | quadros Ethernet
    v
SLIRP do QEMU ou LasecSimul IoT Gateway
    |
    v
Rede do host / Internet
```

O modelo `esp32_wifi` já existe no fork:

- `C:\SourceCode\qemu_lasecSimul\hw\misc\esp32_wifi.c` implementa MMIO, DMA e
  interrupção;
- `C:\SourceCode\qemu_lasecSimul\hw\misc\esp32_wifi_ap.c` contém o modelo legado
  de AP e a conversão 802.11/Ethernet; o controle de AP será substituído pelo
  uplink direto;
- `C:\SourceCode\qemu_lasecSimul\hw\misc\esp32_wlan_packet.c` cria os quadros;
- `C:\SourceCode\qemu_lasecSimul\hw\xtensa\esp32.c` conecta o modelo à máquina;
- o Core atualmente força `model=open_eth` em
  `core/src/mcu/McuController.cpp`.

## 3. Semântica do enlace virtual

O recurso não representa uma rede Wi-Fi pelo ar. Ele apresenta ao firmware um
enlace Wi-Fi já disponível e usa a rede do host como transporte.

Regras do modo transparente:

- a ESP32 simulada permanece em modo estação;
- a primeira tentativa de conexão inicia o enlace virtual;
- SSID e senha não participam de nenhuma decisão;
- não existem scan real, beacon, autenticação, WPA, EAPOL ou associação real;
- o QEMU produz apenas a sequência mínima de eventos esperada pelo driver para
  que o firmware alcance o estado conectado;
- depois do link-up, os dados do firmware seguem pela lwIP normal e são
  convertidos para quadros Ethernet destinados ao backend do QEMU;
- `WiFi.softAP()`, autenticação, potência de rádio, distância e interferência
  ficam explicitamente fora do escopo;
- `WiFi.scanNetworks()` poderá retornar uma rede sintética ou uma lista vazia,
  mas não será usado para decidir a conexão.

O ponto crítico de implementação é fazer o driver fechado `esp_wifi` publicar
os eventos normais de conexão sem executar autenticação. O QEMU deverá detectar
a ativação da estação na fronteira MMIO/DMA e concluir sinteticamente o controle
de link. Caso uma versão do driver exija passos internos adicionais, a
compatibilidade será versionada por fingerprint do Arduino Core/ESP-IDF.

## 4. Interfaces de rede do computador

O frontend Wi-Fi da ESP32 simulada não deve depender do tipo de conexão física
do computador. No modo `lab-router`, o fluxo será:

```text
ESP32 simulada -> esp32_wifi -> gateway/TAP privada -> WinNAT
                                                    -> rota padrão do Windows
                                                    -> Ethernet ou Wi-Fi físico
```

Requisitos:

- com apenas Ethernet cabeada ativa, a saída usa Ethernet;
- com apenas Wi-Fi físico ativo, a saída usa Wi-Fi;
- com as duas interfaces ativas, a métrica da tabela de rotas do Windows decide
  qual é usada;
- se a rota padrão mudar, novas conexões devem seguir a nova interface sem
  recompilar ou reiniciar o firmware;
- o `lab-router` não cria bridge com a interface Wi-Fi física e não expõe os MACs
  das ESP32 diretamente ao ponto de acesso real;
- as limitações de bridge e múltiplos MACs em adaptadores Wi-Fi pertencem ao
  modo `lab-bridge`, não ao `lab-router`;
- o NAT deve continuar usando o prefixo privado da TAP independentemente do
  uplink escolhido pelo Windows.

A configuração atual de `lab-router` já habilita encaminhamento nas interfaces
com rota padrão e cria WinNAT para a rede privada. A implementação do frontend
`esp32_wifi` deve preservar esse comportamento e acrescentar testes explícitos
para os dois tipos de uplink e para troca de rota.

No namespace padrão 42, os endereços esperados são distintos:

```text
Interface física do PC: endereço fornecido pela LAN ou pelo roteador Wi-Fi
LasecSimul TAP:          10.42.0.1/16
ESP32 simulada:          10.42.<slot>.15/16
```

Trocar o uplink físico entre Ethernet e Wi-Fi não altera o endereço privado da
ESP32. O WinNAT apenas encaminha novas conexões pela rota padrão atual.

Matriz de conectividade planejada:

| Origem/destino | `lab-router` | Observação |
|---|---|---|
| ESP32 -> Internet | Sim | NAT pela rota padrão do Windows, Ethernet ou Wi-Fi |
| PC que executa o LasecSimul -> IP da ESP32 | Sim | Rota direta pela TAP privada |
| Ping do PC para a ESP32 | Sim | Depende de ICMP habilitado na pilha convidada e firewall |
| mDNS entre o PC e a ESP32 | Sim | UDP 5353 na TAP; exige validação E2E no Windows |
| Arduino OTA do PC para a ESP32 | Sim | Descoberta mDNS e porta TCP dinâmica pela TAP |
| Outro computador da LAN -> ESP32 | Não por padrão | NAT não publica a ESP32 na LAN |
| mDNS da ESP32 para toda a LAN física | Não por padrão | Exigiria relay explícito ou `lab-bridge` |

## 5. Como seria um futuro `WiFi.softAP()`

`WiFi.softAP()` possui duas interpretações diferentes no simulador:

1. **SoftAP apenas virtual:** outras ESP32 simuladas poderiam participar da rede
   virtual, e o computador acessaria a sub-rede por uma TAP/rota do LasecSimul.
   O usuário abriria o IP ou hostname da ESP32, mas nenhum SSID apareceria na
   lista de redes Wi-Fi do Windows.
2. **SoftAP irradiado pelo computador:** o SSID apareceria para notebooks e
   celulares reais. Isso exigiria Windows WLAN/Wi-Fi Direct ou Mobile Hotspot,
   suporte específico do driver da placa, uma interface física dedicada ou
   compartilhável e configuração administrativa. Não é portátil e não deve ser
   acoplado ao funcionamento normal do QEMU.

Se `WiFi.softAP()` for implementado futuramente, o desenho recomendado é o
primeiro: uma rede exclusivamente virtual, acessível pelo host através do
`lab-router`. A exposição como SSID real deve ser um recurso separado e opcional.

No escopo atual, chamadas `WiFi.softAP()` devem retornar erro/não suportado e
nunca alterar o uplink de estação usado por `WiFi.begin()`.

## 6. Etapas de implementação

### Etapa 0 — baseline reproduzível

1. Adicionar um firmware de teste somente Arduino em
   `examples/esp32-wifi-transparent`.
2. Usar `framework = arduino`, `#include <WiFi.h>` e valores deliberadamente
   inexistentes para SSID e senha.
3. Fazer o firmware registrar eventos Wi-Fi, IP recebido, DNS e uma requisição
   HTTP.
4. Executar o binário vendorizado com
   `-nic user,model=esp32_wifi` e guardar o log como baseline.
5. Confirmar em qual etapa o driver atual espera a conclusão do link antes de
   iniciar DHCP.

Saída: teste falhando de forma determinística antes de alterar o modelo.

### Etapa 1 — tornar o frontend Wi-Fi seguro para múltiplas instâncias

Arquivos principais no QEMU:

- `hw/misc/esp32_wifi.c`;
- `hw/misc/esp32_wifi_ap.c`;
- `hw/misc/esp32_wlan_packet.c`;
- `include/hw/misc/esp32_wifi.h`.

Alterações:

1. Mover estado global de canal, enlace e filas para `Esp32WifiState`.
2. Remover buffers `static` compartilhados entre máquinas.
3. Validar tamanho dos descritores DMA, dos quadros e dos information elements
   antes de acessar memória.
4. Liberar fila e timers corretamente em reset/unrealize.
5. Tornar MAC e modo de enlace transparente propriedades QOM.
6. Preservar uma instância independente do frontend para cada ESP32 simulada.

Saída: duas ou mais ESP32 podem usar Wi-Fi simultaneamente sem compartilhar
estado de link ou fila de quadros.

### Etapa 2 — conexão direta ao iniciar a estação

1. Detectar a inicialização do frontend Wi-Fi e a primeira tentativa de conexão
   pelos registradores, DMA e interrupções já modelados.
2. Descartar probe requests, SSID, senha e qualquer requisito de autenticação.
3. Produzir sinteticamente a conclusão de link esperada pelo driver suportado.
4. Usar um BSSID interno estável apenas quando o driver exigir esse campo; ele
   não representa um AP configurável.
5. Fazer reconexão, disconnect e reset retornarem a estados determinísticos.
6. Não iniciar SoftAP quando o firmware transmite beacon ou chama APIs de AP;
   registrar que o recurso não é suportado.

Saída: qualquer chamada `WiFi.begin(...)` leva ao estado de link conectado sem
rede de rádio intermediária.

### Etapa 3 — modo `direct-uplink`

Adicionar ao `esp32_wifi` a propriedade QOM:

```text
direct-uplink=on
```

O comportamento será:

1. transformar a solicitação de conexão do driver em `link up` imediato;
2. não criar nem anunciar AP virtual;
3. não executar ou simular WPA/EAPOL;
4. manter a pilha lwIP e os sockets dentro do firmware;
5. identificar a versão do driver pelo fingerprint do firmware e falhar com
   diagnóstico claro quando a versão não estiver homologada;
6. nunca ler, armazenar ou registrar SSID e senha.

Essa etapa só estará concluída quando SSID e senha arbitrários não vazios
resultarem em `WL_CONNECTED`, sem tráfego de autenticação.

### Etapa 4 — tráfego IP normal

1. Corrigir e testar a conversão de dados 802.11 para Ethernet e o caminho
   inverso.
2. Remover o ajuste atual de tamanho `+22` sem justificativa e calcular os
   offsets a partir dos cabeçalhos efetivos.
3. Cobrir ARP, DHCP, IPv4, ICMP, UDP e TCP.
4. Verificar checksums e MTU; rejeitar quadros maiores que os buffers em vez de
   truncá-los silenciosamente.
5. Confirmar que DHCP, DNS e conexões de saída funcionam com `-nic user`/SLIRP.
6. Confirmar o mesmo frontend com o backend socket do `lab-router`.
7. Confirmar `lab-router` com Ethernet cabeada como única rota padrão.
8. Confirmar `lab-router` com Wi-Fi físico como única rota padrão.
9. Confirmar que novas conexões acompanham a mudança de rota padrão entre
   Ethernet e Wi-Fi.

Saída: `WiFi.localIP()` recebe endereço real do backend e aplicações continuam
usando os sockets normais do Arduino.

### Etapa 5 — integrar o frontend Wi-Fi ao Core

Arquivos principais do LasecSimul:

- `core/src/mcu/McuController.cpp`;
- `core/test/core/mcu/McuNetworkLaunchTest.cpp`;
- `core/test/core/mcu/McuDebugLaunchTest.cpp`;
- `mcu-adapters/espressif-esp32/mcu.lsdevice`;
- `docs/17-modos-de-rede-esp32.md`.

Alterações:

1. Separar `network mode` de `network frontend`:
   - modo: `disabled`, `lab-router`, `lab-bridge` ou `isolated`;
   - frontend: `wifi` ou `openeth`.
2. Tornar `wifi` o frontend padrão da ESP32 quando a rede estiver habilitada.
3. Manter `LASECSIMUL_NETWORK_FRONTEND=openeth` como rollback temporário.
4. Generalizar a função que gera MAC, hoje chamada `openEthMacAddress`, para que
   o mesmo endereço determinístico seja usado pelo Wi-Fi.
5. Gerar argumentos como:

```text
-nic user,model=esp32_wifi,mac=...,net=...
```

ou:

```text
-nic socket,model=esp32_wifi,mac=...,connect=127.0.0.1:9011
```

6. Atualizar o fallback do gateway para trocar apenas o backend socket por
   SLIRP, preservando `model=esp32_wifi`.
7. Alterar diagnósticos para informar separadamente modo e frontend.

Saída: o Core não exige nem presume `CONFIG_ETH_USE_OPENETH`.

### Etapa 6 — mDNS, servidores e OTA

Conexões de saída são suficientes para DNS, HTTP, MQTT e TLS, mas mDNS e OTA
também exigem tráfego iniciado pelo host ou multicast.

1. No modo `isolated`, documentar e testar `hostfwd` para portas estáticas.
2. No `lab-router`, encaminhar os quadros Ethernet produzidos pelo frontend
   Wi-Fi sem distingui-los de OpenETH.
3. Validar mDNS diretamente entre a TAP e o próprio host; as regras de firewall
   para UDP 5353 já fazem parte do provisionamento atual.
4. Implementar relay mDNS apenas se for necessário anunciar a ESP32 para outros
   computadores da LAN física, mantendo-o desabilitado por padrão.
5. Permitir o fluxo UDP de descoberta e a conexão TCP dinâmica usada pelo
   Arduino OTA entre o host e a ESP32.
6. Impedir exposição automática para interfaces externas; o padrão deve ser
   loopback/rede privada.

Saída: `hostname.local`, servidor web e Arduino OTA funcionam no modo de rede
que oferece entrada, sem mudança no firmware.

### Etapa 7 — testes e homologação

Testes obrigatórios:

1. unitário do parser de information elements 802.11;
2. unitário da máquina de estados start/link-up/disconnect/reset;
3. unitário da conversão 802.11/Ethernet nos dois sentidos;
4. argumento QEMU esperado para todos os modos de rede;
5. firmware Arduino sem OpenETH com:
   - SSID inexistente;
   - senha não vazia incorreta;
   - `WL_CONNECTED`;
   - DHCP e `WiFi.localIP()`;
   - DNS e HTTP/TLS de saída;
   - UDP bidirecional;
   - `WebServer` acessível;
   - mDNS;
   - Arduino OTA;
6. duas ESP32 simultâneas, com MACs e leases distintos;
7. 100 ciclos de boot/reset/reconexão;
8. firmware físico/legado sem rede continua iniciando sem NIC;
9. frontend OpenETH de rollback continua funcional durante a transição.
10. `lab-router` funciona com Ethernet do host, Wi-Fi do host e troca entre
    ambas, sem bridge com a interface Wi-Fi física.

## 7. Ordem de entrega

| Marco | Entrega | Critério de aceite |
|---|---|---|
| M1 | Baseline e firmware somente Arduino | Falha atual reproduzida automaticamente |
| M2 | Uplink direto do frontend Wi-Fi | A tentativa de conexão gera link-up sem AP ou autenticação |
| M3 | Parâmetros ignorados | SSID e senha arbitrários não vazios resultam em `WL_CONNECTED` |
| M4 | DHCP/DNS/TCP/UDP | Internet de saída funciona sem OpenETH |
| M5 | Integração no Core | LasecSimul inicia `model=esp32_wifi` por padrão |
| M6 | mDNS/WebServer/OTA | Serviços do convidado são alcançáveis pelo host |
| M7 | Robustez e release | multi-ESP32 e 100 resets passam; QEMU é empacotado |

## 8. Empacotamento

Depois de M7:

1. compilar `C:\SourceCode\qemu_lasecSimul` com
   `scripts/build-qemu-windows.ps1`;
2. copiar o binário e as DLLs validadas para `devices/qemu-esp32/bin`;
3. atualizar hashes e manifestos do runtime;
4. executar os testes de QEMU vendorizado e o empacotamento da extensão;
5. remover dos textos de produto a exigência de `CONFIG_ETH_USE_OPENETH` para
   firmware Arduino;
6. publicar inicialmente com rollback por
   `LASECSIMUL_NETWORK_FRONTEND=openeth`.

## 9. Definição de pronto

O recurso só será considerado concluído quando este projeto Arduino, sem
`sdkconfig` especial, funcionar no LasecSimul:

```ini
[env:esp32]
platform = espressif32
board = esp32dev
framework = arduino
```

e o código puder manter literalmente:

```cpp
#include <WiFi.h>

WiFi.begin("ssid-que-nao-existe", "senha-que-nao-existe");
while (WiFi.status() != WL_CONNECTED) {
    delay(100);
}
```

Sem `WiFiCompat.h`, sem OpenETH, sem ESP-IDF adicional, sem AP virtual e sem
autenticação, com os testes de IP, DNS, HTTP, mDNS e OTA aprovados nos modos
correspondentes.

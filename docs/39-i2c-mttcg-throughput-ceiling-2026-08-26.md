# Teto de vazão I2C sob MTTCG — arquitetura, causa raiz medida, o que já foi corrigido, o que falta

Data: 2026-08-26.

## Por que este documento existe

Esta investigação começou com dois sintomas reportados pelo usuário num projeto real (ESP32 +
SSD1306 por I2C + telemetria por UART pro LasecPlot):

1. O texto no OLED que devia rolar (scroll) quando ultrapassa a largura da tela ficava congelado
   depois do primeiro frame, no simulador (mas não, aparentemente, no hardware físico).
2. Dois valores telemetrados por UART (`>seno:...|g` a cada 100ms, `>reta:...|g` a cada 200ms)
   apareciam no LasecPlot com uma forma de onda serrilhada/poligonal, não suave — como se a taxa de
   amostragem efetiva fosse muito menor que a definida no firmware.

A investigação (documentada em detalhe abaixo) levou a uma descoberta bem mais profunda e mais
importante do que os dois sintomas originais: **o simulador tem um teto de vazão real na ponte
QEMU↔Core que faz uma transferência I2C fielmente bit-a-bit a 400kHz custar segundos de tempo real
em vez de ~23ms**. Isso explica por que alguém precisou colocar um freio manual no firmware do
usuário (para não travar o simulador), e é provavelmente a causa raiz por trás de várias
otimizações pontuais que já foram tentadas nesta área do código ao longo do tempo (ver "Histórico"
abaixo).

Este documento existe para que **outro agente/pessoa possa desenhar uma correção arquitetural de
verdade** sem repetir do zero as ~6 horas de instrumentação que já foram feitas aqui. Ele cobre:
arquitetura atual (com referências de arquivo:linha), os números medidos, o que já foi corrigido
(e validado com testes), e o que continua em aberto.

**Isto não é gambiarra territory** — o pedido explícito foi por um "conserto fino", então este
documento também é explícito sobre o que É e o que NÃO É uma correção real, e por quê.

---

## 1. Arquitetura atual (como I2C realmente flui hoje)

Há **três processos/camadas** envolvidos em qualquer transação I2C do firmware real até o
dispositivo simulado (ex.: o SSD1306):

```
┌─────────────────────────┐      arena       ┌──────────────────────────┐    stamp()/    ┌──────────────┐
│  QEMU (processo separado)│◄───compartilhada──►│  LasecSimul Core          │───solve()────►│ Dispositivo   │
│  hw/i2c/esp32_i2c.c      │   (memória mapeada, │  (processo separado)     │   MNA elétrico │ nativo (ex:   │
│  = periférico I2C do     │    fila circular +  │  mcu-adapters/           │                │ SSD1306, via  │
│  firmware ESP32 real     │    slot síncrono)   │  espressif-esp32/src/    │                │ plugin C ABI) │
│  (registradores, FIFO,   │                     │  Esp32Adapter.cpp        │                │               │
│  IRQ — o que o firmware  │                     │  = bit-bang elétrico     │                │               │
│  vê via MMIO)            │                     │  REAL (START/bits/ACK/  │                │               │
└─────────────────────────┘                     │  STOP em SCL/SDA)        │                └──────────────┘
                                                  └──────────────────────────┘
```

### 1.1 Camada QEMU (hardware do periférico, visto pelo firmware)

`qemu_lasecSimul` (fork próprio, `C:\SourceCode\qemu_lasecSimul`, `origin` =
`github.com/josuemoraisgh/qemu_lasecSimul`), arquivo `hw/i2c/esp32_i2c.c`. É o modelo do
periférico I2C real do ESP32 (registradores `A_I2C_*`, FIFO de comando, IRQ) — o que o driver
Arduino (`Wire`/`Adafruit_BusIO`) enxerga via MMIO. Cada opcode de comando (RSTART/WRITE/READ/STOP)
processado por `esp32_i2c_do_transaction()`/`esp32_i2c_event()` espelha registradores pra dentro da
"arena" compartilhada via `writeReg()`/`readReg()` (definidos em `softmmu/simuliface.c`).

### 1.2 A ponte (arena compartilhada, `softmmu/simuliface.c`)

- `writeReg(addr, value)` → `publishQueueEntry()` → `pushQueueEntry()`: publica numa fila circular
  de 32 slots (`QEMU_ARENA_QUEUE_DEPTH`), "dispara e esquece" (não bloqueia o QEMU esperando o Core
  processar) — MAS se a fila estiver cheia, `waitForSynch()`/`waitForQueueDrain()` **bloqueiam em
  spin-wait puro** (`while(!condição){}`, sem sleep/yield) até haver espaço.
- `readReg(addr)` (usado por `esp32_i2c_event()` pra ler `A_I2C_STATUS`/ACK) é **sempre síncrono**:
  publica um `SIM_READ`, e **spin-wait** (`while(!qatomic_load_acquire(&m_arena->qemuAction)){}`,
  `softmmu/simuliface.c:329-341`) até o Core responder. Antes disso, se houver escritas pendentes
  na fila, primeiro espera elas drenarem (`waitForQueueDrain()`, `softmmu/simuliface.c:282-296`,
  TAMBÉM spin-wait puro).
- Telemetria já embutida: `LASECSIMUL_QEMU_PROFILE=1` imprime, ~1x/segundo, uma linha
  `[LasecSimul][PROFILE] mode=... wall_ns=... virtual_ns=... realtime_percent=... events=...
  reads=... queue_waits=... read_waits=... max_queue=...` (contadores já existentes em
  `simuliface.c`, usados extensivamente nesta investigação).

### 1.3 Camada Core (elétrica real, bit-bang)

`mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp`, `struct I2cState` + `i2cAdvance()`
(linhas ~1334-1490) + `i2cKick()`. Esta é a máquina de estados que converte cada opcode espelhado
numa sequência elétrica REAL de START/repeated-START/8 bits+ACK/STOP em SCL/SDA — genérica, não
assume nenhuma biblioteca/dispositivo específico (comentário em `Esp32Adapter.cpp:302-312`: achado
histórico de que sem isso "Wire.write() funcionava do ponto de vista do QEMU, mas nenhum bit real
saía pro barramento").

Importante: **esta máquina de estados roda dentro do processo Core**, não dentro do QEMU — QEMU só
publica os opcodes de alto nível (via `writeReg`); o Core os transforma em ~28 transições de fase
por byte (setup/hold/change de cada bit, mais fases de START/ACK/STOP), cada uma agendada via
`i2c.dueNs = addDelayNs(nowNs, ...)` no relógio de simulação do próprio Core (`Esp32Adapter.cpp`
linhas 1334-1490, comentários linha a linha em cada fase). `i2c.halfPeriodNs` é aprendido dos
registradores REAIS que o firmware configura (`A_I2C_LOW_PERIOD`/`HIGH_PERIOD`, refletido por
`esp32_i2c_updt_frequency` no lado QEMU) — ou seja, **a temporização já é fiel ao clock configurado
(400kHz etc.)**; não é aqui que está o problema de "tempo simulado errado".

Cada transição de fase é despachada pelo Scheduler do Core como um evento agendado — que por sua
vez pode disparar um `stamp()`/`solve()` elétrico (MNA) se algo mudou eletricamente (ex.: nível de
SCL/SDA).

### 1.4 O laço do Scheduler (`core/src/simulation/Scheduler.cpp`)

Dois modos de avanço de tempo relevantes:

- `runUntil(targetTimeNs)` (`Scheduler.cpp:176-234`): avança em incrementos, cada um limitado pelo
  MENOR entre `targetTimeNs`, `m_maximumTimeStepNs` (padrão 100µs) e o próximo evento agendado
  (`m_events.top().timeNs`) — ou seja, **pula direto pro próximo evento real**, não gasta passos
  "vazios". Chama `m_commitTimeStep` (que no `SimulationSession` despacha `commitTransientStep()`
  dos componentes reativos e, desde a correção desta sessão, `advanceDynamicComponentsUnlocked()`
  — ver seção 3).
- O laço de fundo em `start()` (`Scheduler.cpp:263-...`) roda `runUntil()` repetidamente, com um
  **teto de avanço** (`AdvanceLimitFn` = `SimulationSession::computeSlowestMcuPositionNs()`) que
  impede o lado elétrico de correr mais que `leadNs` (5-20ms, `kMinAdvanceLeadNs`/
  `kMaxAdvanceLeadNs`, `Scheduler.hpp:286-287`) à frente da posição REAL já reportada pelo MCU —
  correção de corretude proposital: sem isso, o elétrico "alucinaria" progresso que o MCU real
  ainda não produziu.

### 1.5 Drenagem da fila da arena, do lado Core (`core/src/mcu/McuComponent.cpp`)

Uma thread de fundo dedicada por MCU (`runBackgroundPollLoop()`, `McuComponent.cpp:269-329`) chama
`pollStepLocked()` (linha 183) em loop apertado, sem sleep artificial — `arena.poll()` (PEEK) +
`dispatchArenaEvent()` (CONSOME, linha 558-582) sempre que há uma entrada nova. `dispatchArenaEvent`
em si é barato (só grava estado do módulo + confirma pra QEMU); nenhuma stamp cara acontece ali
diretamente.

---

## 2. Números medidos (não suposição)

### 2.1 Reprodução isolada usada

Projeto sintético (não o projeto real do usuário, construído especificamente pra isolar o
fenômeno): ESP32 DevKitC + `outputs.ssd1306` (SCL→G22, SDA→G21, com resistores de pull-up de
4,7kΩ pra 3V3 + `other.ground`) + `peripherals.lasecplot` (rx←TX do ESP32, 921600 baud). Firmware
mínimo (Arduino/PlatformIO), sem gate nenhum de limitação:

```cpp
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_SSD1306.h>
static constexpr uint8_t PIN_SDA = 21, PIN_SCL = 22, SCREEN_ADDRESS = 0x3C;
Adafruit_SSD1306 display(128, 64, &Wire, -1);
void setup() {
    Serial.begin(921600);
    Wire.begin(PIN_SDA, PIN_SCL);
    display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS, false, false);
    display.setTextSize(2); display.setTextColor(SSD1306_WHITE);
    Serial.println("i2c_probe: setup concluido");
}
void loop() {
    static uint32_t heartbeatCount = 0, lastHeartbeatMs = 0;
    static int16_t offset = 0;
    display.clearDisplay();
    display.setCursor(offset, 0);
    display.print("PROBE");
    display.display();              // <- 1024 bytes por I2C, SEM limite de taxa
    offset = (offset + 1) % 128;
    const uint32_t now = millis();
    if (now - lastHeartbeatMs >= 10) {
        lastHeartbeatMs = now;
        Serial.print(">heartbeat:"); Serial.print(now); Serial.print(":");
        Serial.print(heartbeatCount); Serial.println("|g");
        ++heartbeatCount;
    }
}
```

Rodado via `scripts/benchmark-real-esp32.mjs` (harness já existente no repo, spawna Core+QEMU
isolados — não interfere com nenhuma sessão interativa), com `LASECSIMUL_QEMU_PROFILE=1` e as
métricas de `getPerformanceMetrics()`.

### 2.2 Resultado principal

| Config | mcuRate (progresso real do MCU vs. tempo de parede) | Heartbeats esperados em 8s | Heartbeats recebidos |
|---|---:|---:|---:|
| `realTimeRate=0` (ilimitado) | **~0,9%** (min 0%, max 4,6%) | ~800 (a cada 10ms) | 0 |
| `realTimeRate=1` (tempo real — **padrão de produção** da extensão) | **~99,9%** (saudável!) | ~800 | **1-2** |

O ponto crítico: mesmo com `mcuRate≈100%` (o Scheduler tecnicamente "acompanhando o tempo real"),
o firmware só consegue completar 1-2 iterações de `loop()` em 8 segundos reais — porque cada
`display.display()` (1024 bytes) por si só consome vários segundos. Isso não é sobre
`realTimeRate` estar mal configurado; é sobre quanto tempo real UMA transferência I2C completa
custa, incondicionalmente.

### 2.3 De onde vem o tempo (instrumentação adicionada nesta sessão)

- **Lado QEMU** (`LASECSIMUL_QEMU_PROFILE=1`): ~500 eventos publicados/segundo pro Core
  (`events=4028` em 8,1s). `queue_waits=484` (a fila de 32 slots encheu e bloqueou o QEMU em
  spin-wait 484 vezes), `read_waits` crescendo (11→28 ao longo do teste) — ou seja, o QEMU **passa
  parte real do tempo bloqueado nos spin-waits de `simuliface.c`**, não só "esperando o firmware
  decidir escrever".
- **Lado Core**: `eventsProcessed` entre 58.336 e 183.194 no MESMO cenário em execuções diferentes
  (variação de ~3x entre runs — hipótese: contenção de scheduling do SO nos spin-waits/threads
  envolvidos, não determinístico). Ou seja, ~7.000-23.000 eventos internos/segundo.
- `maxSettleNanoseconds` (adicionado nesta sessão, ver seção 3): **199-226µs** no pior caso único —
  descarta a hipótese de "uma chamada de settle() gigante". `settleNanoseconds/settleIterations` ≈
  22-26µs em média — rápido, consistente, sem outliers.
- `componentStamps/solverCalls` ≈ 2,5 — descarta a hipótese de "recarimbar o circuito inteiro a
  cada evento" (o rastreamento de dirty-set já funciona corretamente; só ~2-3 componentes são
  carimbados por solve, não os ~53 ativos).
- `advanceLimitWaitCount` (adicionado nesta sessão): **0** nesta reprodução específica — descarta
  (para ESTE cenário) o bug do item 3.2 abaixo como causa dominante, mesmo sendo um bug real.
- `i2cAckErrors: 0` em todas as execuções — o barramento está eletricamente saudável (não é NACK).
- `display.litPixels` não-zero (303-348) em quase todas as execuções — pelo menos uma transferência
  completa eventualmente termina; não é um travamento infinito, é genuinamente lento.

### 2.4 A conta que fecha o veredito

Um frame de 1024 bytes a 400kHz precisa de 9.216 tempos de bit (9 bits/byte × 1024, incluindo ACK).
Com ~3 sub-fases por bit (setup/hold/change) mais fases de START/STOP/ACK, isso são
**~27.600-28.700 transições de fase distintas gerenciadas pelo Scheduler** (cada uma potencialmente
um evento agendado + uma stamp/solve). Mesmo a um throughput saudável de evento individual
(dezenas de µs cada, confirmado acima), processar ~28.000 DESSAS coisas — mesmo a
7.000-23.000/segundo — leva de **1,2 a 4 segundos reais**. Isso bate com os 2,6-3,9s por iteração
de `loop()` observados diretamente nos heartbeats.

**Conclusão**: não é um bug pontual de lentidão — é que o pipeline QEMU↔Core, do jeito que está,
sustenta uma vazão de milhares de eventos/segundo, e I2C bit-a-bit fiel a 400kHz PRECISA de uma
vazão de ordem de **centenas de milhares de eventos/segundo** pra acompanhar tempo real. Um teto de
vazão de ~1-2 ordens de magnitude abaixo do necessário.

---

## 3. O que já foi corrigido nesta sessão (validado com testes reais)

### 3.1 `postStep()` nunca era despachado (bug real, mas não relacionado ao teto de I2C)

`IComponentModel::postStep()` (`core/include/lasecsimul/IComponentModel.hpp:143`) é `= 0`
(virtual pura), documentada como "só chamada para componentes registrados como dinâmicos" — mas
NENHUM caminho de produção a chamava; só testes unitários diretos
(`core/test/core/plugins/PluginRuntimeTest.cpp:209,222`). Isso deixava mortos: a rolagem de
hardware do SSD1306 (comandos I2C 0x26-0x2F, `devices/simulide-complex/src/lib.c:918-934`) e a
animação de servo motor (`s->servo_pos`, mesmo arquivo).

**Correção**: novo `IComponentModel::isDynamic()` (default `false`,
`IComponentModel.hpp` próximo à linha 147), `NativeDeviceProxy::isDynamic() override { return
true; }` (`core/src/plugins/NativeDeviceProxy.hpp`), nova lista
`SimulationSession::m_dynamicComponentIndices` (espelhando o padrão já usado por
`m_reactiveComponentIndices`/`m_fpgaComponentIndices`) e `advanceDynamicComponentsUnlocked()`
(`SimulationSession.cpp`, chamado do `TimeStepCommitFn` do Scheduler só em passos aceitos).

Cuidado de desempenho deliberado: `NativeDeviceProxy::postStep` passa por
`PluginWatchdog::call()`, que **cria uma thread nova por chamada** sempre que o manifesto declara
`stepTimeoutMs` (todo device "complex" declara 8-10ms) — despachar a cada passo MNA aceito (que
pode ser em microssegundos sob passo adaptativo) teria gerado uma tempestade de criação de threads.
Por isso o despacho é limitado a uma cadência de ~60Hz por componente (`kDynamicComponentTickNs =
16'666'667ns`, mesma constante que `simulide-complex/src/lib.c` já usa internamente pro tick de
scroll/servo) — acumula `dt_ns` por componente, só despacha quando cruza o teto, entregando o
ACUMULADO (não o último delta).

Novo teste: `core/test/core/session/DynamicComponentDispatchTest.cpp` (registrado em
`CMakeLists.txt`), valida cadência, batching e que um componente sem `isDynamic()` nunca é chamado.
`plugin_runtime_test`, `simulation_plan_test`, `simulation_plan_session_test`,
`component_removal_test` todos passando.

**Nota importante**: isso NÃO resolve o sintoma original do OLED do usuário — o firmware dele usa
rolagem por SOFTWARE (redesenha e retransmite o frame inteiro a cada passo), não o comando de
hardware 0x26-0x2F. O bloqueio real ali é um gate `isChanged` no firmware do usuário
(`C:\SourceCode\II1P04_GPIO_Debug\include\services\display_ssd1306.h:94-112`, fora deste repo,
NÃO CORRIGIDO — o usuário optou por não mexer no firmware nesta rodada).

### 3.2 `notifyAdvanceLimitChanged()` não acordava a espera de verdade (bug real, confirmado NÃO ser o dominante no cenário medido)

`Scheduler::start()` (`Scheduler.cpp:367-377`), quando o teto de avanço (`AdvanceLimitFn`) impede
qualquer progresso no ciclo, dorme em `m_pacingWake.wait_for(lock, 5ms, predicado)`. O predicado
ANTIGO só verificava `!m_running`/`m_paused` — nunca "a posição de referência avançou". Ou seja,
`notifyAdvanceLimitChanged()` (chamada por `McuComponent::pollStepLocked()` sempre que o MCU
produz progresso real) acordava a thread, o predicado reavaliava falso, e ela voltava a dormir até
o timeout de 5ms **inteiro**, sempre — não só numa corrida rara, como o comentário original
sugeria.

**Correção**: mesmo padrão de contador atômico que `signalWorkAvailable()`/`m_workGeneration` já
usa (documentado ali como necessário exatamente por essa classe de wakeup perdido) — novo
`m_advanceLimitGeneration`, incrementado em `notifyAdvanceLimitChanged()`
(`Scheduler.hpp`), conferido pelo predicado do `wait_for` (`Scheduler.cpp:367-380`).

Validado: `scheduler_test`, `mcu_scheduler_pacing_sync_test` (incl. cenário real com 2 MCUs),
`session_restart_stress_test` (15 ciclos reais Scheduler+QEMU) — todos passando.

**Instrumentação nova (permanente, exposta em `getPerformanceMetrics()`)**:
`maxSettleNanoseconds`/`maxSettleAtNowNs` (o pior settle() individual e onde na timeline ocorreu —
o campo já existia internamente desde 2026-07-27, só não estava exposto no JSON;
`CoreApplication.cpp` agora expõe) e `advanceLimitWaitCount`/`advanceLimitWaitNanoseconds` (quantas
vezes o ramo de espera do teto disparou e quanto tempo real cada wait_for() levou de fato) — úteis
pra qualquer investigação futura de desempenho nesta área.

**Por que isto não fechou o problema medido em 2.2-2.4**: `advanceLimitWaitCount=0` na
reprodução — este ramo simplesmente não estava sendo exercitado nesse cenário específico. É um bug
real (mantido, testado, vale a pena), mas não É o teto de vazão.

### 3.3 Já existente antes desta sessão (não fiz eu, mas incorporei/commitei): WDT + I2C ACK-skip no fork do QEMU

Achado no checkout `C:\SourceCode\qemu_lasecSimul` (branch `main`), como trabalho não commitado —
commitado nesta sessão como dois commits:

- `cc68b4a` — instrumentação de diagnóstico temporária (cache-trace/PC-sampler), de uma
  investigação anterior não relacionada ("Cache error"/Guru Meditation), ainda presente porque o
  commit seguinte a usa (ver 3.4).
- `71a0b06` — estabilização do watchdog TIMER_GROUP1 sob MTTCG (`hw/timer/esp32_timg.c`) +
  otimização de I2C: `esp32_i2c_event()` só lê o ACK elétrico REAL (round-trip pro Core) no
  primeiro byte depois de um (repeated-)START; bytes de dados subsequentes no mesmo burst assumem
  ACK (`hw/i2c/esp32_i2c.c`).

Esta é exatamente a categoria de otimização que reduz round-trips por byte — e **está incorporada
no binário já testado nesta sessão** (é o binário usado em TODAS as medições da seção 2). Ou seja,
os números da seção 2 já refletem essa otimização, e mesmo assim o teto de vazão continua.

---

## 4. O que continua em aberto (a parte que precisa de desenho, não só instrumentação)

### 4.1 O problema, caracterizado com precisão

Reduzir round-trips *pro QEMU* (3.3) ajuda, mas a maior parte do custo está do lado **Core-interno**:
~28.000 transições de fase por frame, cada uma um evento agendado no Scheduler
(`Esp32Adapter.cpp::i2cAdvance`, seção 1.3), mesmo que cada uma seja individualmente barata
(dezenas de µs). **O gargalo é volume de eventos discretos gerenciados pelo Scheduler, não o custo
de nenhum evento específico.**

### 4.2 Por que isso é "arquitetura", não "parâmetro pra ajustar"

A fidelidade bit-a-bit (cada transição de SCL/SDA passando pelo solver elétrico completo) existe
porque dispositivos I2C reais (o SSD1306 nativo, `devices/simulide-complex/src/lib.c`, função
`i2c_clock_bit`) decodificam o protocolo observando bordas elétricas de verdade — não há uma camada
"lógica"/abstrata de I2C nesta simulação (ao contrário de, por exemplo, tratar o barramento como um
sinal digital simbólico). Isso é uma escolha de design real (fidelidade elétrica genérica,
funciona pra qualquer dispositivo I2C sem hardcode, comentário em `Esp32Adapter.cpp:302-312`), não
um descuido — então a solução não pode ser simplesmente "pare de simular os bits".

### 4.3 Direções candidatas (não avaliadas em profundidade — é aqui que outro agente entra)

Nenhuma destas foi implementada ou validada; são pontos de partida, não uma decisão:

1. **Lotear transições de fase sem round-trip por transição**: dentro do Core, processar VÁRIAS
   transições de fase consecutivas de `i2cAdvance()` numa única iteração do Scheduler quando nada
   mais no circuito precisa de resolução fina naquele intervalo (nenhum componente reativo/não-linear
   ativo) — o desafio é preservar a visibilidade de CADA borda pros dispositivos observadores
   (`i2c_clock_bit`), que hoje dependem de ver cada uma via `stamp()`/`onEvent()`.
2. **Reduzir o número de transições de fase por bit**: hoje ~3 sub-fases por bit (setup/hold/change)
   mais ACK — se algumas dessas fases não mudam nenhum pino observável, podem ser fundidas.
   Precisa de análise cuidadosa pra não quebrar os 4 patches de I2C já existentes (endereçamento,
   timing de ACK, cancelamento de timer obsoleto — `devices/qemu-esp32/patches/0002-0004`).
3. **Diminuir o custo fixo por evento do Scheduler** (fila de prioridade, locking, hop entre a
   thread de poll do MCU e a thread do Scheduler) — mesmo que o volume de eventos não mude, se o
   custo por evento cair de ~30-40µs pra próximo de zero, o teto sobe proporcionalmente. Requer
   profiling mais fino do que o feito aqui (que já descartou settle()/solve()/stamp() como
   dominantes via `maxSettleNanoseconds`/`componentStamps`/`solverCalls` — o tempo "sobrando" não
   contabilizado por esses três contadores ainda não foi localizado com precisão).
4. **Perfilar onde o tempo "não contabilizado" realmente vai**: somando settleNanoseconds +
   solverNanoseconds + deviceStampNanoseconds, cobre-se só uma fração do tempo de parede total
   (ex.: ~21% numa das execuções). O resto é candidato a: overhead do próprio laço de
   `Scheduler::runUntil` (fila de prioridade `m_events`, cálculo de `nextTime`), sincronização
   entre a thread de poll do MCU e a thread do Scheduler (`state->mutex`, `DeferredSchedulerCall`),
   ou — mais provável dado os spin-waits documentados na seção 1.2 — tempo genuíno gasto pelo
   próprio processo QEMU (fora de qualquer contador do Core) executando o loop de polling do
   firmware real dentro do driver Wire/BusIO. Medir isso com precisão (ex.: timestamps em ambos os
   processos, correlacionados) é o próximo passo de instrumentação mais valioso antes de desenhar
   qualquer correção.

### 4.4 O que NÃO fazer (gambiarra explicitamente descartada)

- Um "throttle" arbitrário no firmware do usuário (ex.: `if (millis()-last > 150) update();`) —
  contorna o sintoma pra ESTE firmware específico, não corrige o simulador, e qualquer outro
  projeto com I2C mais intenso (ex.: um display maior, múltiplos dispositivos I2C) bateria no
  mesmo teto.
- Desligar a fidelidade bit-a-bit "só pra I2C ficar rápido" sem entender o impacto em dispositivos
  que dependem de observar bordas reais (quebraria silenciosamente qualquer plugin I2C nativo).

---

## 5. Como reproduzir (pra quem for continuar)

```bash
# 1. Construir o projeto de reprodução (JSON acima, seção 2.1) e o firmware de sonda (código acima).
#    O firmware pode ser compilado com qualquer toolchain PlatformIO ESP32 padrão + libs
#    Adafruit SSD1306/GFX/BusIO; gera um merged.bin via create_merged_bin.py (ver qualquer projeto
#    PlatformIO existente que já use esse extra_script).
# 2. Rodar o benchmark isolado (não interfere com nenhuma sessão interativa):
cd C:/SourceCode/LasecSimul
LASECSIMUL_QEMU_PROFILE=1 node scripts/benchmark-real-esp32.mjs \
  <caminho para o .lsproj> <caminho para o merged.bin> 8000 \
  core/build/Release/lasecsimul-core.exe true 1
# realTimeRate=1 (último argumento) é o padrão de produção -- usar 0 reproduz o caso ainda pior
# (mcuRate ~0.9%) mas não é o cenário realista.
```

`LASECSIMUL_BENCHMARK_ALLOW_INCOMPLETE=1` evita que o script lance exceção quando o display não
termina de atualizar dentro da janela do teste (esperado neste cenário). `getPerformanceMetrics()`
(via `client.getPerformanceMetrics()` ou inspecionando o JSON de saída do benchmark) expõe todos os
contadores citados na seção 2, incluindo os quatro novos desta sessão.

---

## 6. Referência rápida de arquivos

| O quê | Onde |
|---|---|
| Periférico I2C (QEMU, visto pelo firmware) | `qemu_lasecSimul/hw/i2c/esp32_i2c.c` |
| Ponte arena (spin-waits, filas) | `qemu_lasecSimul/softmmu/simuliface.c` |
| Bit-bang elétrico real (Core) | `LasecSimul/mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp` (`I2cState`, `i2cAdvance`, linhas ~294-330, ~1334-1490) |
| Drenagem da fila (Core) | `LasecSimul/core/src/mcu/McuComponent.cpp` (`runBackgroundPollLoop`, `pollStepLocked`, `dispatchArenaEvent`) |
| Laço do Scheduler | `LasecSimul/core/src/simulation/Scheduler.cpp` (`runUntil`, `start`) |
| Teto de avanço (pacing MCU) | `LasecSimul/core/src/session/SimulationSession.cpp` (`computeSlowestMcuPositionNs`) |
| Dispositivo SSD1306 nativo | `LasecSimul/devices/simulide-complex/src/lib.c` (`i2c_clock_bit`, `oled_scroll_once`, `post_step`) |
| Patches I2C já existentes | `LasecSimul/devices/qemu-esp32/patches/0002-0004-*.patch` |
| Harness de benchmark isolado | `LasecSimul/scripts/benchmark-real-esp32.mjs` |
| Provenance do binário QEMU bundled | `LasecSimul/devices/qemu-esp32/bin/BUILD-PROVENANCE.txt`, `SOURCE.md` |

## 7. Ainda não confirmado (fora do escopo desta rodada)

O segundo sintoma original do usuário (forma de onda serrilhada do `>seno:`/`>reta:` no LasecPlot)
foi investigado até um nível de hipótese razoável (`drainUart` em `CoreApplication.cpp:1803-1826`
carimba o lote inteiro drenado com um único timestamp de "agora", não por amostra; se o Scheduler
ficar ocupado por vários polls seguidos os bytes se acumulam e chegam em rajada) mas **não foi
confirmado empiricamente** — a investigação pivotou pro teto de I2C antes de medir isso ao vivo.
Vale revisitar com o mesmo tipo de instrumentação usada aqui.

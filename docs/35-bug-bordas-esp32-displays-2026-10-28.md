# 35 - Bug: bordas do ESP32 perdidas/reordenadas antes de chegar aos devices (displays I2C/SPI) — 2026-10-28

**Status:** corrigido no Core para o transporte **VNEXT_B** (o que a extensão usa) — ver "Correção no
VNEXT_B" logo abaixo. As seções seguintes registram a investigação (feita primeiro, por engano, no
transporte LEGACY) e os contornos de firmware, que deixam de ser necessários com o Core corrigido.

## Correção no VNEXT_B (2026-10-28)

Três bugs independentes, todos no Core:

1. **Entrada digital nunca chegava ao firmware.** O QEMU atende `GPIO_IN`/`GPIO_IN1` direto do
   snapshot compartilhado (`vnext_b_gpio_read`, `softmmu/vnext_b.c` do fork), sem pedir ao Core — mas
   nada no Core escrevia esse snapshot (só existia `readSnapshot`; o único escritor era o autoteste do
   QEMU). `digitalRead()` era sempre 0, e um botão em 5 V lia LOW.
   Correção: `VnextBAttachment::publishSnapshot()` (seqlock igual ao do QEMU) e
   `McuComponent::publishVnextBGpioInputsLocked()`, chamado na anexação do QEMU, em cada
   `onEvent` de pino, no fim de `stamp()` e no início de cada rodada de despacho (só escreve se mudou).
2. **Pulsos de bit-bang sumiam.** O laço de despacho do VNEXT_B aplicava até 256 escritas de GPIO
   (aplicadas na hora no módulo) antes de um único settle, e `stamp()` podia despachar mais uma antes
   de estampar a anterior. Correção: uma mudança elétrica por solve — após um evento que muda a saída,
   a rodada para (`yieldForSettle`) e continua em now+1 ns; `m_vnextBChangeAwaitingStamp` impede
   `stamp()` de despachar outra antes de estampar a pendente. Mesmo princípio do LEGACY ("dirty
   primeiro").
3. **I2C sempre em NACK com instrumento no barramento.** No VNEXT_B o I2C só funciona pelo fast path
   (não há reserva elétrica); o fast path recusava qualquer componente além de resistor/túnel em
   SCL/SDA, e o analisador lógico da aula derrubava todas as transações. Correção:
   `isI2cFastPathTransparentUnlocked` aceita instrumentos de observação (analisador lógico, ponta de
   prova, osciloscópio, frequencímetro, voltímetro). Limitação: com o fast path, o analisador não vê a
   forma de onda bit a bit do I2C.

Verificado com `scripts/diagnose-esp32-display-edges.mjs` (`LASECSIMUL_MCU_TRANSPORT=VNEXT_B`,
`mttcg`, `RTR=1 PROBEALL=1`), projeto original com o analisador nos 8 canais: botão lido HIGH/LOW
conforme a fonte; LCD "Hello, world!"/"BUTTON High"/"BUTTON Low" sem perdas; PCD8544 correto com o
firmware original (SPI por software a 4 MHz, redesenho a cada 50 ms), com o contornado (10 kHz) e com
o exemplo SimulIDE (SPI por hardware). Testes: `i2c_fast_path_dispatch_test`
(`testFastPathIgnoresObservingInstruments`) e `vnext_b_attachment_test` (`P3_CORE_SNAPSHOT_PUBLISH`).

## Correções definitivas (2026-10-29) — fidelidade ao chip real

Critério: o dispositivo simulado tem de se comportar como o real em todos os aspectos; nenhum
contorno no firmware do usuário. Corrigido em três camadas (Core, adaptador ESP32 e fork QEMU,
patch `devices/qemu-esp32/patches/0012-*`):

**I2C elétrico no VNEXT_B.** Desfeito o "instrumento transparente" de 2026-10-28: o fast path só vale
quando o barramento é indistinguível de uma transferência direta (só dispositivos I2C, túneis e
resistores). Com analisador, ponta de prova, pull-up ou dispositivo sem `i2c_transfer`, o Core executa
o BATCH no motor do adaptador (`McuComponent::startOrQueueVnextBElectricalI2cLocked`; registradores
privados `0xF00/0xF04/0xF08` do módulo I2C): bordas reais em SCL/SDA, ACK amostrado do barramento,
NACK com ACK_CHECK_EN aborta com STOP como o controlador real, e a resposta ao QEMU sai quando a
transação termina no fio. O envelope BATCH ganhou dois bits (QEMU): STOP real (`END` segura o
barramento — antes o Core punha um STOP no fio e o display rejeitava a lista seguinte) e NACK do
último byte lido (`ACK_VAL` do último READ). Sem handler de topologia o QEMU também recebe resposta
(antes ficava com a vCPU pausada para sempre).

**Tempo do I2C (QEMU).** A conclusão passou a ser `max(agora, envio + duração no fio)`: o relógio do
guest anda durante a espera pela resposta, então no caminho elétrico a duração era contada duas vezes.

**Interrupção de GPIO (QEMU + Core).** O modelo de GPIO do QEMU só avaliava mudança de entrada quando o
firmware lia `GPIO_IN` — `attachInterrupt` sem polling nunca disparava. Agora: o Core publica cada
mudança de `GPIO_IN`/`GPIO_IN1` também como evento C2A e o QEMU (`esp32_gpio_vnext_input`) trava a
borda na hora; `GPIO_STATUS` por pino, `PCPU/ACPU(_NMI)_INT` derivados das habilitações de cada pino,
nível reafirmado enquanto ativo (inclusive depois de `W1TC`), reavaliação ao mudar tipo/habilitação, e
a linha de IRQ como OU dos pendentes (antes `W1TC` derrubava interrupções pendentes de outros pinos).

**GPIO 32–39.** `GPIO_IN1` estava deslocado de um bit (mapa começava no 33): `digitalRead(34..39)`
devolvia o pino vizinho e o GPIO32 nunca era lido. `GPIO_OUT1`/`GPIO_ENABLE1` não existiam no QEMU
nem no adaptador: GPIO32/33 não funcionavam como saída.

**LEDC (QEMU + adaptador).** O QEMU não devolvia `LEDC_CONF_REG` (seletor do SLOW_CLK) na leitura; o
ESP-IDF calculava frequência 0 e `ledcSetup`/`analogWrite` falhavam nos canais de baixa velocidade com
12 bits a 1 kHz. Agora há um banco de registradores com leitura de volta, bits auto-limpantes
(`PARA_UP`, `DUTY_START`), `DUTY_R` e contador `TIMERn_VALUE`. No adaptador, o PWM segue o hardware:
contador por timer a partir do reset no clock certo (REF_TICK, APB ou SLOW_CLK = APB/RC_FAST),
`HPOINT`, duty com 4 bits fracionários (dithering em 16 períodos), duty novo só no estouro seguinte ao
`DUTY_START`, `SIG_OUT_EN=0` → `IDLE_LV`, `PAUSE`/`RST`. Não modelado: o motor de fade.

**Verificação** no projeto `II1P06_SPI_I2C_UART` com o firmware original da aula (SPI por software a
4 MHz, PWM de 12 bits, redesenho a cada 50 ms), VNEXT_B + mttcg, analisador nos 8 canais: LCD
"Hello, world!" → "BUTTON High" pelo caminho elétrico, Nokia correto, nenhum erro de LEDC, SCL real no
analisador. Firmware de diagnóstico: interrupção `CHANGE` sem polling dispara a cada borda, 12 bits
@ 1 kHz e `ledcRead`/`ledcReadFreq` corretos, GPIO32 como saída, PWM medido no analisador com 500/500
µs exatos. Testes: `esp32_adapter_test` (LEDC alinhado ao contador, SLOW_CLK, `GPIO_IN1`, GPIO32,
transação I2C do Core com NACK/abort/END/leitura), `i2c_fast_path_dispatch_test`
(`testFastPathYieldsToObservingInstruments`), `vnext_b_attachment_test`.

**Mundo elétrico congelado durante polling (QEMU).** O Core só avança até onde o QEMU provou que o tempo
passou: eventos da fila ou o heartbeat, que tem 1 s de intervalo. Um firmware que só lê entradas
(`pulseIn`, `while (digitalRead(...))`, leitura de sensor por bit-bang) não gera eventos, e o circuito
que ele lia ficava parado por até 1 s (o `pulseIn` de um PWM de 1 kHz dava tempo esgotado). Agora cada
leitura de `GPIO_IN` publica a posição de tempo do QEMU (no máximo a cada 10 µs virtuais) e acorda o
Core, que acompanha o guest exatamente enquanto ele observa. Ritmo da simulação inalterado (~1x).

Regressão de escala: `vnext_b_production_scale_test` com VNEXT_B + mttcg passa com 4 sessões
(1092/1092 transações I2C) e 8 sessões (4932/4932), sem perda, duplicação, desvio nem travamento.

**Limite do modo `mttcg` (tempo real).** O QEMU não reproduz o tempo de ciclo do Xtensa (as instruções
rodam na velocidade do host) e guest e Core são dois processos em tempo real; o Core segue o QEMU com
atraso variável. Medido: `pulseIn` de um PWM de 500/500 µs vê de 200 a 3000 µs; o Nokia por SPI de
hardware não mostra nada. Resolvido pelo modo exato abaixo, que passou a ser o padrão da extensão.

## Cossimulação exata — lockstep (2026-10-29)

Configuração `lasecsimul.mcu.esp32Timing`: `realtime` (padrão, ver a seção seguinte), `exact`, `mttcg`
(o antigo). Nos dois primeiros o QEMU
roda com `-icount` (TCG de uma thread), o tempo de cada instrução sai do clock da CPU (240 MHz → 1
instrução/ciclo, `icount_set_ps_per_inst` chamado por `updtCpuFreqHz`) e guest e Core andam em passo
travado pela página de controle (ABI 1.2, `lasec_at_control_page`, campos `artifact_sync_seq`,
`core_sync_seq`, `core_time_ns`, `core_horizon_ns`, `core_input_horizon_ns`, `lockstep`):

- **O Core nunca passa do instante do guest.** Teto exato do Scheduler (`ExactAdvanceLimitFn`, sem
  folga, válido desde o boot) = instante publicado pelo QEMU; a thread da campainha antecipa
  `min(instante, cabeça das filas)` para o Core avançar no mesmo ciclo. Sem evento na fila o Core avança
  até o teto mesmo assim (o guest pode estar parado esperando por ele); o pacing de tempo real vale.
- **O guest nunca passa do horizonte do Core** sem sincronizar: o QEMU segura as vCPUs com o relógio
  virtual congelado (`cpu_can_run`/`cpu_thread_is_idle`/warp do icount respeitam o hold) e solta quando
  o Core ecoa a sequência e alcança o instante; antes de soltar consome respostas e C2A, então
  entradas e interrupções caem no instante certo. Sincroniza: no horizonte (timer virtual), numa leitura
  de `GPIO_IN` depois do horizonte de entrada ou de uma escrita ainda não sincronizada (a leitura é
  repetida depois), logo após uma escrita cujo efeito o guest veria sem ler `GPIO_IN` (com interrupção
  de GPIO armada, `GPIO_PINn`, periféricos fora de GPIO/IO_MUX/UART/SPI/LEDC), e num pedido de I2C.
- **Eventos suaves.** Despertares de SPI, LEDC e UART do adaptador só mexem em saídas deste MCU; sem
  interrupção de GPIO armada (canal privado `0xF00/0xF04` do módulo GPIO do adaptador) eles não limitam o
  horizonte rígido — só o de entrada, que faz a leitura de `GPIO_IN` sincronizar. Com interrupção armada
  toda borda vale como rígida. Quantum de 1 ms mesmo sem eventos; com vários MCUs em lockstep cada um só
  corre até 1 µs além do que os outros já provaram.

Bugs achados no caminho e corrigidos: o Core corria sem teto até o QEMU publicar a primeira posição (o
I2C elétrico ficava agendado além do teto e travava no boot — causa do "modo determinístico trava");
leitura de `GPIO_IN` em espera girava dentro do `cpu_exec` (faltava `cpu_exit` antes de reexecutar);
timer do QEMU (thread da vCPU no TCG de uma thread) era tratado como acesso do guest (`cpu->running`);
fila do C2A de 2 posições (agora 64); **modelo SPI do QEMU mandava `data_reg[k]` (uma palavra inteira, e
além de W15 a partir do 17º byte) como o byte k da transferência** — SPI por hardware com mais de um
byte saía lixo nos dois modos; agora W0..W15 são lidos por byte com `WR_BYTE_ORDER`/`WR_BIT_ORDER`.

Medido no projeto `II1P06_SPI_I2C_UART` (firmware `src/devkitc_test.ino` da aula, SPI por hardware):
LCD I2C e Nokia corretos, botão acompanhado, UART normal, ~1–1,6× o tempo real depois do boot. Firmware
de medição (PWM 1 kHz/50% em G17 ligado a G34): `pulseIn` = 500/499 µs, PWM no analisador 500/500 µs,
primeiro `display()` completo 1179 µs (504 bytes a 4 MHz). Com o tick do FreeRTOS em fase com o PWM o
`pulseIn` mede 505/494 µs: a ISR do tick (~6 µs na CPU1) cai em cima da borda — comportamento de chip
real para essa fase. Testes: `scheduler_test` (teto exato, eventos suaves), `vnext_b_attachment_test`
(`LOCKSTEP_CONTROL_PAGE`), `esp32_adapter_test` (interrupção armada), escala VNEXT_B nos dois modos.

Diagnóstico: `LASECSIMUL_LOCKSTEP_TRACE=1` (sincronizações, motivo, tempo de host por lado),
`LASECSIMUL_LOCKSTEP_SOFT=0` (toda borda rígida), `LASECSIMUL_ESP32_LOCKSTEP=0` (icount sem lockstep),
`LASECSIMUL_SPI_ENGINE_TRACE=1` (bytes do motor SPI do adaptador); no script, `QEMULOG=n` e `METRICS=1`.

**Limites que permanecem no modo exato:**
- *Os dois núcleos dividem um único relógio de instruções* (icount do QEMU com TCG de uma thread): o
  que a CPU0 executa (ex.: ISR do tick, ~2,9 µs/ms) atrasa a CPU1 no tempo virtual. No chip os núcleos
  rodam em paralelo. Firmware com Wi-Fi ativo na CPU0 sente mais.
- *Velocidade do TCG com icount*: um laço só de cálculo roda a 300–400 MIPS neste servidor (acima dos
  240 MHz do chip). Os ~0,2× medidos antes vinham da retradução a cada leitura de periférico, corrigida
  (ver a seção seguinte). O que ainda pode ficar abaixo de 240 MIPS — servidor cheio, código novo sendo
  traduzido — o modo `realtime` compensa.
- *CPI = 1*: cada instrução custa um ciclo; o LX6 real perde ciclos em cache de flash e acessos à IRAM.
- *UART RX no VNEXT_B*: o Core não entrega bytes de RX ao QEMU (C2A tipo 2 não é publicado).
- *SCL ocioso em 0 V* depois do I2C nos dois modos (o real fica alto pelo pull-up interno do Wire).
- *Motor de fade do LEDC* não modelado.

Pendente: o caminho LEGACY continua com a perda de bordas descrita abaixo (não é o transporte usado
pela extensão).

## Tempo real sincronizado — modo `realtime` (2026-10-29)

Requisito: no laboratório (8 thin clients, um servidor, todos simulando ao mesmo tempo) o ESP32 não pode
ficar mais lento que o real em momento nenhum. O modo exato fica quando o PC não executa o guest a
240 MHz. O físico não deixa as duas coisas juntas num trecho pesado — ou a simulação inteira atrasa, ou
a CPU do ESP32 fica mais lenta —, então o modo `realtime` escolhe a segunda, que é o que acontece num
chip real com ciclos de espera (cache de flash):

- **Mesmo lockstep do modo exato** (o guest nunca passa do circuito, o circuito nunca passa do guest);
  `micros()`, timers, PWM, `pulseIn`, interrupções, I2C, SPI e UART continuam no mesmo tempo virtual.
- **O Core publica onde a simulação deveria estar pelo relógio real** (`Scheduler::realTimeScheduleNs()`
  → `core_realtime_schedule_ns`, `lockstep_realtime`; o QEMU publica o esticamento em
  `artifact_cpu_dilation_q16`).
- **O QEMU estica o tempo de cada instrução** (`icount_set_time_dilation`: ps/instrução = período da CPU ×
  fator ≥ 1) num controlador por instância (`vnext_rt_step` em `softmmu/vnext_b.c`), a cada ~10 ms de
  parede e sempre num sincronismo (vCPUs paradas, nenhum orçamento de instruções em voo). Mede o tempo
  que a vCPU passou de fato dentro do `tcg_cpus_exec` e quantas instruções executou: só a parte
  proporcional às instruções conta (tradução de código novo e I/O do host não encolhem com o fator). Sobe
  o fator só quando é a execução do guest que segura a simulação; um circuito lento não ganha nada com uma
  CPU mais lenta. Volta para 1 (um ciclo por instrução) assim que sobra folga.
- **Atraso recuperável de até 1 s** (`kLockstepMaxPacingLagNs`): o vaivém normal de um sketch (trecho
  pesado atrasa, o `delay()` seguinte recupera) é recuperado; um engasgo maior do servidor (alguém
  compilando, troca de firmware) desliza a âncora em vez de a simulação correr acelerada por segundos.

Achados no caminho, corrigidos (valem para os modos `realtime` e `exact`):
- **Retradução a cada leitura de periférico (QEMU).** Com `-icount` só a última instrução de um bloco
  pode fazer I/O; uma no meio fazia `cpu_io_recompile` sair do bloco (`longjmp`, desenrolar de pilha no
  Windows) e executá-la sozinha — a cada volta de um laço de espera (FIFO da UART, fim de byte do SPI,
  status do I2C). Agora o PC da instrução fica registrado (`tb_io_insn_pc`) e o tradutor corta o bloco
  antes dela e lhe dá um bloco próprio com I/O permitido; o laço volta a rodar em blocos encadeados.
- **Roteamento de entradas a cada stamp (adaptador).** `gpioSetInputVoltageAt` percorria as 256 entradas
  da matriz de GPIO para cada pino a cada stamp do MCU (~40 mil/s): ~1/3 do tempo do Core. Agora só
  roteia quando o nível lógico muda (IO_MUX e `GPIO_FUNCn_IN_SEL` já roteiam o nível atual ao mudar).
- **Stamp (Core).** `ComponentMatrixView` resolve o pino pela posição em `pins()` (vetor por topologia)
  em vez de `unordered_map<string>` a cada operação, guarda a contribuição pendente do dono (um hash a
  menos por entrada) e `vnextBActive()` deixou de consultar o processo do QEMU (chamada de sistema) antes
  do flag.

Medido neste servidor (Ryzen 9 5950X, 16 núcleos), ritmo = Δtempo simulado / Δparede depois do boot:

| Carga | `exact` | `realtime` |
|---|---|---|
| 1 × sketch da aula (LCD I2C + Nokia SPI + PWM + UART), antes das correções do Core | 0,75× | 0,74× |
| 1 × sketch da aula, depois | — | 1,01–1,02× |
| 8 × sketch da aula ao mesmo tempo | — | 0,93–0,99× (o Core de cada um perto da saturação) |
| 8 × carga pura de CPU ao mesmo tempo | 0,84× | 1,000× (CPU 2–7× mais lenta conforme a disputa) |

`pulseIn` de um PWM 500/500 µs continua 500/500 e 500/499 µs no `realtime`. Com 8 sketches da aula o
que falta é Core: cada borda de SPI/PWM/UART ainda cruza a DLL do adaptador ~150 vezes
(`electricalOutputFingerprint` antes e depois de cada despertar) e mais ~190 no stamp do MCU, e
`publishSnapshot` roda em todo passo estável; a leitura em lote do estado dos pinos (seção seguinte)
tirou as chamadas, não o cálculo. O mesmo corte de bloco multiplicou por ~3,7 as transações I2C do MTTCG no teste de
escala (171 contra 46 na mesma janela).

Diagnóstico: `LASECSIMUL_LOCKSTEP_TRACE=1` imprime `[RT]` (fator, fração em execução e em instruções,
MIPS, blocos traduzidos, PCs das duas CPUs, atraso); `METRICS=1` no script agora traz
`pacingSleepNanoseconds` e `lockstepIdleWaitNanoseconds`; o script registra `wall=` junto de `core=`.

### Leitura em lote dos pinos — `mcu_abi.h` 3.2 (2026-10-29)

- **ABI.** `LsdnQemuModuleVTable` ganhou `get_pin_states` (estado de N linhas numa chamada:
  `LSDN_PIN_STATE_OUTPUT_ENABLED/OUTPUT_HIGH/PULL_UP/PULL_DOWN`) e `set_input_voltages_at` (N amostras de
  pad numa chamada). Os dois são opcionais. O Core só os lê de um plugin que declara minor ≥ 2
  (`PluginModule::abiMinor`), porque a vtable de um adaptador antigo termina antes deles; com o DLL
  anterior o Core volta sozinho às chamadas por pino.
- **Core.** `McuComponent` agrupa os pinos por módulo dono (`PinBatch`). `stamp()` lê o estado de todos
  antes do laço, estampa a matriz na mesma ordem do `pinMap` e entrega as entradas em lote no fim. Como
  no chip, uma entrada só muda uma saída pelo relógio do periférico (wakeup), nunca na mesma chamada.
  `electricalOutputFingerprint()` usa o mesmo lote. O default de `QemuModule` (módulos built-in e
  fakes de teste) continua chamando pino a pino.
- **Adaptador ESP32.** O lote existe no GPIO (40 pinos) e na USART (UART0_RX/TX). `gpioPadOutput()`
  calcula enable e nível com uma consulta só ao IOMUX/GPIO matrix e é a única fonte do caminho por pino
  e do lote. O teste do adaptador confere que as duas leituras dão o mesmo resultado nos 40 pinos.
- **Fidelidade: `INPUT_PULLUP`/`INPUT_PULLDOWN` num pino solto.** O fingerprint não incluía o pull
  interno. Uma escrita só de IO_MUX (`FUN_PU`/`FUN_PD`) não reestampava o MCU, e o pad ficava em 0 V até
  outra saída mudar; no chip, ele vai ao nível do pull na hora. Agora o pull de um pino não dirigido
  entra no fingerprint. O teste `mcu_component_live_poll_thread` falha sem isso, porque o pad continua
  em 0 V.
- **`getenv` em caminho quente.** `vnextTraceEnabled()` era lido a cada escrita de GPIO e a cada
  transação I2C do VNEXT_B; o trace do fast path I2C, a cada transferência. Os dois agora são lidos uma vez.
- **Ganho medido.** O caminho dos pinos caiu de ~18% para ~12% do tempo ocupado da thread do Scheduler
  (perfil por amostragem, sketch da aula). O que resta é o próprio cálculo por pino no adaptador
  (`gpioPadOutput`), proporcional ao número de leituras: 1 por stamp e 2 por evento do QEMU. Com 8
  sketches da aula ao mesmo tempo, os 8 ficaram em 0,995–1,019×. O caminho antigo por pino, na mesma
  medição, também ficou em ≈1,0×, então a diferença para a tabela acima não vem do lote.
- **Maiores custos restantes da thread do Scheduler** (mesmo perfil, % do tempo total da thread, que
  passa ~50% esperando o pacing):
  - `onStableStepUnlocked`, ~12%: `acquireSubscribedSignalsUnlocked` e `publishSnapshot`, com alocação
    de heap a cada passo estável;
  - `MnaSolver::solve`, ~7%;
  - `NativeDeviceProxy::postStep`, ~3,6%: todo dispositivo com `limits.stepTimeoutMs` (AIP31068,
    HD44780 e outros) cria e destrói uma thread (`PluginWatchdog::call`) a cada `post_step`. Corrigido
    na seção seguinte;
  - `SetEvent` de `publishLockstepTime` e de `publishRegisterResult`, ~3,5%.

### `post_step` dos dispositivos nativos sem thread por chamada (2026-10-29)

O Core chama `post_step` de cada dispositivo nativo a ~60 Hz (`kDynamicComponentTickNs`). Com
`limits.stepTimeoutMs` no manifesto, cada chamada passava por `PluginWatchdog::call`, que criava uma
`std::thread`, esperava e juntava. No sketch da aula isso ocupava 3,0% do tempo de parede da thread do
Scheduler (criação da thread, espera e `join`), com a simulação parada. E o custo crescia com o
circuito: todo dispositivo nativo era dinâmico, inclusive cada porta lógica do `simulide-logic`. Um
circuito com 30 portas criava 1.800 threads por segundo.

O código se afastava da spec (`.spec/archive/legacy-v2/lasecsimul-native-devices.spec`) em dois pontos,
e a correção segue a spec nos dois:

- **Seção 10, item 3: só o dispositivo que se registra como dinâmico recebe `post_step`.**
  `NativeDeviceProxy::isDynamic()` devolvia sempre `true`, mas o `post_step` só faz algo no servo e na
  rolagem do SSD1306 e do SH1107. Nos outros (LCDs, TFTs, Nokia, portas lógicas, periféricos, sensores,
  example-blinker) o corpo é vazio. Agora o manifesto declara `"dynamic": true` e só `servo`, `ssd1306`
  e `sh1107` o fazem (`ComponentMetadata::dynamic` → `ComponentMeta::dynamic`). O AIP31068 e o PCD8544
  da aula não recebem mais nenhuma chamada.
- **Seção 13, itens 2 e 3: thread reservada, não uma por chamada.** `PluginWatchdog` passou a ser uma
  instância com uma thread criada na primeira chamada e reaproveitada (`run`). Se o plugin estourar o
  tempo, a thread nunca é morta. Ela continua sendo a do dispositivo, e a chamada seguinte espera ela
  liberar dentro do próprio orçamento. Se ainda estiver presa, a chamada volta `TimedOut` sem entrar no
  plugin. Antes, cada timeout deixava mais uma thread presa e entrava de novo no mesmo plugin, ao mesmo
  tempo que a chamada travada. Ao virar `Faulted` (3 timeouts seguidos ou crash), a thread é liberada:
  juntada se livre, desanexada se presa. O destrutor do proxy faz o mesmo antes do `destroy` do handle,
  e descarta uma chamada postada que ainda não começou. A chamada captura o módulo e o handle por valor,
  e o módulo vai junto para o DLL continuar carregado até ela voltar. As chamadas frias do adaptador de
  MCU (`PluginWatchdog::call`) usam o mesmo mecanismo, com uma thread só delas.

Medido:

| Medida | Antes | Depois |
|---|---|---|
| Tempo parado por `post_step` com `stepTimeoutMs`, thread ociosa entre chamadas (microbenchmark, as duas versões no mesmo binário) | ~125 µs | ~15 µs |
| Chamadas de `post_step` por segundo no sketch da aula (AIP31068 + PCD8544) | ~120, cada uma criando uma thread | 0 |
| 8 sketches da aula ao mesmo tempo, ritmo | 0,98–1,02× | 1,000–1,018× (duas rodadas), LCD e Nokia corretos |
| 8 sketches da aula, CPU do Core por simulação | 61,5–68,8% de um núcleo (três rodadas de hoje) | 48,5% e 49,7% |

A queda de CPU é maior que os 3% do perfil, porque o perfil só via a espera da thread do Scheduler. A
thread nova tinha o próprio custo de partida noutro núcleo: no Windows, cada thread criada passa pela
inicialização de todas as DLLs carregadas. A comparação de CPU é com rodadas anteriores do mesmo dia,
não um A/B no mesmo instante. Um circuito com 30 portas lógicas e o watchdog antigo parava o
Scheduler por cerca de 225 ms a cada segundo (30 × 60 × 125 µs); agora as portas não entram nesse caminho.

Testes: `plugin_watchdog` (reuso da mesma thread em 200 chamadas, nenhuma entrada em paralelo com uma
chamada presa, crash sem perder a thread, `shutdown` sem esperar a thread presa), `plugin_runtime`
(`isDynamic` segue o manifesto, `post_step` sempre na mesma thread reservada) e `plugin_checksum`
(no `devices/library.json` real, só servo, SSD1306 e SH1107 são dinâmicos).

### Leitura I2C no lockstep e no barramento elétrico (2026-10-30)

O release da v0.0.104 foi segurado por isto. No modo `realtime` (e no `exact`), toda leitura I2C do
ESP32 recebia NACK: `Wire.requestFrom`, leitura de registrador de sensor, qualquer `i2c_master_read`.
O `vnext_b_production_scale_test` passava assim mesmo, com 2 transações por sessão em 10 s, contra
1276 em MTTCG, porque só exigia uma transação. Três defeitos independentes:

- **A leitura trocava de caminho no meio (QEMU, patch 0015).** O ESP-IDF manda uma leitura em duas
  listas de comandos: RSTART + WRITE(endereço|R) + END, depois READ… + STOP. A primeira não passava
  pelo planejador de burst (direção de leitura sem READ na lista) e caía no executor byte a byte, que é
  sempre elétrico. A segunda ia por BATCH. Num barramento de transferência direta o dispositivo via o
  endereço pelo fio e os dados pela transferência. No MTTCG o ACK do fio era lido com o Core ainda
  ocupado e assumido como ACK; no lockstep era lido de verdade, e era NACK (ver o item seguinte). Agora a
  primeira lista vai ao Core como seleção do alvo (BATCH com START + endereço, nenhum byte, sem fim
  lógico) e as listas de READ (uma ou mais READ, fechadas por STOP ou END) como continuação, sem START
  e com o endereço só como metadado. A leitura inteira fica no caminho que o Core escolher para o
  barramento: transferência direta ou motor elétrico do adaptador. O `simulide-complex` (displays, só
  escrita) responde à seleção sem bytes com ACK em vez de NACK no "primeiro byte lido".
- **O escravo elétrico do `simulide-logic` nunca dava ACK** (`logic.i2c_ram` e `logic.i2c_to_parallel`,
  o PCF8574). Puxava o ACK na subida do 8º pulso, com SCL alto: um START no barramento, que o próprio
  dispositivo via. E soltava o ACK na subida do 9º, antes de o mestre amostrar. Agora segue o chip: SDA
  só muda com SCL baixo, o ACK entra na descida do 8º pulso e fica baixo durante todo o 9º, e cada bit
  transmitido entra na descida anterior ao pulso em que o mestre o lê. O teste novo
  `devices/simulide-logic/test/i2c_slave_timing_test.c` conduz o escravo borda a borda num barramento
  wired-AND. O código antigo falha nas 13 verificações.
- **SDA e SCL trocados quando o `pinCount` é passado.** O `init` do `simulide-logic` redeclarava os
  pinos como `scl, sda, a0…`, o inverso do manifesto e do código elétrico (pino 0 = SDA). O fast path
  procura `sda`/`scl` pelo nome e funcionava. No fio, o pino ligado como `sda` recebia as bordas de SCL.
  Nenhum manifesto define `pinCount`, então só os testes que o passam (escala, LasecPlot, reinício)
  montavam o barramento assim. A ordem agora é a do manifesto.

Medido neste servidor, `vnext_b_production_scale_test` com 8 sessões por 20 s, transações por sessão:

| Modo | Antes | Depois |
|---|---|---|
| `mttcg`, transferência direta | não medido com 8 (1 sessão por 10 s: 1276) | 18.734–20.934 |
| `realtime`, transferência direta | 2 | 28.244–30.953 |
| `exact`, transferência direta | não medido com 8 (1 sessão por 10 s: 2) | 26.245–27.864 |
| `realtime`, ponta de prova e pull-ups no SDA (barramento elétrico) | todas NACK | 5.005–5.555, todas com ACK |

Nenhuma perda, duplicação ou resposta trocada. O firmware de teste grava 0x5A no endereço 0 da RAM e
depois lê em sequência. O 0x5A volta a cada 256 leituras, como deve, nos três modos. Projeto da aula
com 8 sessões em `realtime`: 0,991–1,018×, LCD e Nokia corretos.

O teste de escala passou a exigir 16 transações por sessão. Com `LASECSIMUL_SCALE_BUS_PROBE=1` ele põe
uma ponta de prova e pull-ups de 4,7 kΩ no barramento e roda o caminho elétrico.
`LASECSIMUL_I2C_DEVICE_TRACE=1` agora também imprime as bordas vistas pelo escravo do `simulide-logic`.

## Atualização: com o transporte VNEXT_B (padrão da extensão) nada funciona

A extensão sobe o Core com `LASECSIMUL_MCU_TRANSPORT=VNEXT_B` e `LASECSIMUL_ESP32_EXECUTION_MODE=mttcg`
fixos (`extension/src/extension.ts`, bloco `coreEnv`). Os testes abaixo, até "Contornos aplicados",
foram feitos sem essa variável, ou seja, no transporte **LEGACY**. Com o runtime empacotado da 0.0.102,
o firmware com contornos e o projeto original, rodando o script com `RTR=1 PROBEALL=1`:

| Transporte | PCD8544 | LCD I2C | GPIO13 (fonte de 5 V) |
|---|---|---|---|
| LEGACY | "BUTTON High" correto | "BUTTON High" (erro ocasional) | lido HIGH ✔ |
| VNEXT_B | `enabled=0` depois de piscar | `enabled=0` (nem inicializa) | lido **LOW** ✘ |

No VNEXT_B, além dos displays, **a leitura de entrada digital está errada**, e a UART mostra só uma linha
depois do boot. Isso é mais grave que a perda de bordas do LEGACY e deve ser investigado primeiro
(`McuComponent::pollAndDispatchPendingEvents`, publicação de registradores I2C via
`vnextBAttachment().publishRegisterResult`). Para reproduzir no VNEXT_B, rode o script com
`LASECSIMUL_MCU_TRANSPORT=VNEXT_B LASECSIMUL_ESP32_EXECUTION_MODE=mttcg LASECSIMUL_HOST_INSTANCE_ID=<pid>`
e, para usar o runtime instalado, `RUNTIME_ROOT=<extensão>\bundled`.

(Obsoleto depois da correção acima: chegou a ser cogitado trocar `"VNEXT_B"` por `"LEGACY"` no
`coreEnv` da extensão instalada; não foi aplicado.)

## Sintoma

Projeto `C:\Prof_Josue\0II1\II1P06_SPI_I2C_UART` (ESP32 DevKitC + LCD AIP31068 I2C + Nokia PCD8544 SPI +
analisador lógico nos barramentos). Na extensão os dois displays ficam em branco, embora o analisador
mostre tráfego I2C/SPI saindo do ESP32. Sem UI e em tempo real (`realTimeRate: 1`, como a extensão):

- **AIP31068 (I2C):** recebe dados, mas perde/duplica caracteres e comandos ao acaso:
  `"Helo, word!"`, `"Hllo, wold!"`, `"BUTON Higgh"`, `"BUTTON HighBUTTN igh"` (até `setCursor` se perde).
- **PCD8544 (SPI):** framebuffer com lixo (padrão repetido em todas as páginas) ou `enabled=0`.

Quanto mais carga (sondas de fio da UI, analisador, telemetria), maior a perda — na UI chega a não
aparecer nada.

## Reprodução

`scripts/diagnose-esp32-display-edges.mjs` (rodar pelo **PowerShell**; no Git Bash as DLLs do MSYS no
PATH derrubam o QEMU com `0xC0000139`):

```powershell
$env:RTR="1"; $env:DUMP="1"; $env:PROBEALL="1"
node scripts\diagnose-esp32-display-edges.mjs <projeto.lsproj> <merged.bin> 16000
```

Firmware de referência que reproduz: `src/test.cpp` do projeto **antes** dos contornos (SPI por
software a 4 MHz via `Adafruit_PCD8544(18, 23, 16, 5, 19)`, ou SPI por hardware via
`Adafruit_PCD8544(16, 5, 19)`), redesenhando os dois displays a cada 50 ms.

## O que foi descartado (com evidência)

| Hipótese | Teste | Resultado |
|---|---|---|
| Fiação / tunnels | Tensões medidas no pino do display = pino do ESP32 (ex.: G19 → `pcd.rst` 3,3 V) | OK |
| Modelo do PCD8544 (`devices/simulide-complex/src/lib.c`) | PCD8544 isolado, bit-bang lento por 5 `sources.fixed_volt` via IPC, fio direto **e** via tunnels | Decodifica perfeito (`enabled=1`, bytes `ff 81 ff`) |
| Ordem de pinos do manifesto | `validate_pin_order` não marcou `misconfigured`; pinos `rst,ce,dc,din,clk` / `scl,sda` | OK |
| Binários desatualizados | `lasecsimul-core.exe` 06:58 > fonte mais nova 06:55 | OK |
| Modo de execução do QEMU | `LASECSIMUL_ESP32_EXECUTION_MODE=deterministic` | Mesmo lixo no PCD8544 |
| SPI por software × hardware | Os dois testados | Os dois falham |
| Velocidade do I2C | `Wire.setClock(10000)` | Continua perdendo caracteres |

## Mecanismo (o que se sabe)

1. **Detecção de borda só vê o nível depois de cada settle.** `SimulationSession::settleStep()`
   ([core/src/session/SimulationSession.cpp:4235](../core/src/session/SimulationSession.cpp#L4235))
   compara o nível de cada nó antes/depois do solve e entrega `kPinChangeEventTag` em ordem de
   **índice de nó**, não em ordem causal. Se várias mudanças de pino do MCU forem aplicadas antes de um
   único settle, um pulso (CLK ↑↓) some e mudanças em nós diferentes (SDA/SCL, DIN/CLK) podem chegar
   invertidas.
2. **Eventos atrasados são processados em lote.** `Scheduler::runUntil`
   ([core/src/simulation/Scheduler.cpp:220-258](../core/src/simulation/Scheduler.cpp#L220-L258)) processa
   **todos** os eventos com `timeNs <= nextTime` — inclusive os agendados no passado por outra thread,
   que viram "agora" ([Scheduler.cpp:166](../core/src/simulation/Scheduler.cpp#L166)) — e só então faz um
   `settleUntilStableLocked`. Além disso a thread de poll do MCU despacha eventos prontos do QEMU
   diretamente (`McuComponent::onPollEvent`/`runBackgroundPollLoop`), aplicando várias escritas de GPIO
   antes de o Scheduler assentar. Bit-bang rápido (SPI por software a 4 MHz) perde bordas aqui.
   **Ainda não comprovado com trace por borda** — próximo passo do diagnóstico.
3. **SPI por hardware perde a ordem entre GPIO e o motor SPI.** DC/CS são GPIO (linha do tempo do
   QEMU), mas os bits saem do motor bit-bang do adaptador (`spiAdvance`/`spiKick`,
   `mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp`) em tempo do Core, depois. O firmware já trocou
   DC/CS para o próximo comando enquanto o motor ainda clocka o byte anterior: dado vira comando e
   vice-versa (o padrão repetido nas 6 páginas do PCD8544 é consistente com isso).
4. **I2C elétrico perde transações mesmo lento** (causa exata não identificada). O fast path de
   transferência I2C (`NativeDeviceProxy::transferI2c` → `i2c_transfer()` do device), que é imune a
   isso, **só é usado quando os nós SDA/SCL têm apenas tunnels/resistores** além do device
   (`SimulationSession::isI2cFastPathTransparentUnlocked`). Um analisador lógico com canais `SCL`/`SDA`
   (ligados por nome de tunnel) derruba o fast path. Sem esses canais: 382 transferências pelo fast
   path e LCD 100% correto.

## Contornos aplicados (firmware da aula) — reverter quando o Core for corrigido

Em `C:\Prof_Josue\0II1\II1P06_SPI_I2C_UART\src\test.cpp`:

- PCD8544 em **SPI por software a 10 kHz** (`Adafruit_SPIDevice(5, 18, -1, 23, 10000)` trocado no
  `spi_dev` via `#define private public` — feio, marcado como temporário). Com isso todas as linhas
  (CLK/DIN/DC/CS) vão pela mesma linha do tempo de GPIO e espaçadas o bastante: framebuffer correto
  ("BUTTON High") mesmo com o analisador nos 4 canais SPI e sondas em todos os fios.
- PCD8544 redesenhado **só quando o botão muda** (a 10 kHz um quadro leva ~0,5 s).
- LCD I2C: sem contorno no firmware. Com o analisador em SCL/SDA ainda há erro ocasional, que se corrige
  no refresh seguinte (50 ms). Tirar SCL/SDA do analisador deixa o LCD perfeito, mas os alunos perdem a
  forma de onda I2C.

## Correção correta (a fazer)

1. **Entregar cada transição de pino do MCU em ordem, com settle entre elas.** Opções: fila de
   transições por pino com timestamp, consumida um timestamp por vez no Scheduler; ou não colapsar no
   mesmo passo eventos atrasados com timestamps diferentes (processar um grupo de mesmo `timeNs` por
   vez, cada um com seu settle). Medir custo: cada borda vira um settle.
2. **Ordenar GPIO e motor SPI na mesma linha do tempo:** uma escrita de GPIO do mesmo MCU que chegue
   enquanto o motor SPI ainda tem bytes pendentes deve esperar o fim desses bytes (ou o QEMU deve
   aguardar o motor terminar antes de concluir a transação).
3. **Analisador lógico não deveria desligar o fast path I2C:** tratá-lo como observador transparente
   e gerar a forma de onda a partir da transferência, ou corrigir o caminho elétrico do I2C.
4. **Teste de regressão:** o script acima com `RTR=1 PROBEALL=1` e firmware original (SPI 4 MHz,
   redesenho a cada 50 ms) deve dar LCD com texto exato e PCD8544 com "BUTTON High".

## Bug relacionado: LEDC de baixa velocidade no QEMU

`ledcSetup()` nos canais 8–15 (grupo low-speed) falha para 1 kHz/12 bits e 5 kHz/8 bits; o canal 0
(high-speed) aceita todas as combinações testadas. Parece que o clock do timer low-speed é modelado
como 1 MHz (REF_TICK) em vez de 80 MHz (APB). Como `analogWrite()` usa o canal 15, `analogWrite` com 12
bits imprime `analogWrite setup failed` a cada chamada (e gasta um canal novo por chamada). Contorno no
firmware da aula: `analogWrite` com 8 bits.

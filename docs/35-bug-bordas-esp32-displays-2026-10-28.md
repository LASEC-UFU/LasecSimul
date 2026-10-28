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

Pendente: o caminho LEGACY continua com a perda de bordas descrita abaixo (não é o transporte usado
pela extensão); e com o fast path o analisador lógico não mostra a forma de onda do I2C.

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

# Baseline de IPC e fidelidade — 2026-08-27

## Critério

Toda otimização deve reduzir trabalho exclusivamente host-side/IPC sem alterar comportamento
observável do controlador virtual (FIFO, IRQ, timers, ACK/NACK, estado de registradores, bytes,
ordenação e tempo virtual).

## Provenance capturada

| Item | Caminho | SHA-256 / identidade |
|---|---|---|
| Core | `core/build/Release/lasecsimul-core.exe` | `D7E627BF20732F8519818760D886CCF64AE5740D2B3D39CD87A5A0F9D8839358` |
| QEMU | `devices/qemu-esp32/bin/qemu-system-xtensa.exe` | `502AD7EAF2D6836B6CC2068A45B37317D2DA0446827BC711BC2247770B509946` |
| Firmware | `II1P04_GPIO_Debug/.pio/build/esp32/merged.bin` | `2328824B5016AA292E701A03F2477A14B632CCEE1C91B463517CB423434452A9` |
| Core instalado | VS Code `...lasecsimul-0.0.26.../bundled/core/...` | igual ao Core de desenvolvimento |
| QEMU instalado | VS Code `...lasecsimul-0.0.26.../bundled/devices/...` | igual ao QEMU de desenvolvimento |
| LasecSimul HEAD | repositório principal | `8bd58a3083f39aa138b06cb98189bd75ae80bdd7` |
| QEMU HEAD | `qemu_lasecSimul` | `92d3b96071d4f3c7756a155536f8bfa0c7fdfd84` |
| PlatformIO | toolchain | `6.1.19` |

## Execução baseline

Projeto real `display.lsproj`, firmware real, runtime instalado, 1800 ms, trace detalhado
desligado. Resultado observado:

- UART: conteúdo byte a byte idêntico; 488 bytes; 8 linhas de telemetria; 0 linhas inválidas.
- Display: habilitado; 376 bytes não-zero; 1154 pixels acesos.
- I2C: 0 erros de ACK; 0 Guru Meditation.
- Taxa MCU: média 97,49%, mínimo 80,39%, máximo 100,54%.
- `advanceLimitWaitCount`: 5536; `advanceLimitWaitNanoseconds`: 1,811 s acumulado.
- `eventsProcessed`: 20746; `componentStamps`: 12410; `solverCalls`: 5978.
- `settleNanoseconds`: 102,6 ms acumulado; máximo individual 1,205 ms.
- `rejectedTransientSteps`: 3.

Os tempos acumulados não são somados diretamente ao wall-clock: QEMU, Core, Scheduler e
transporte executam parcialmente em paralelo. A próxima instrumentação deve reconstruir o caminho
crítico por sequência de operação, e não fazer soma bruta.

## Observação inicial

Nesta execução isolada o backend entregou UART regular durante a atividade do OLED. Isso não prova
que a sessão interativa esteja correta; apenas desloca a investigação para a correlação de eventos
e para a fronteira broker/WebView caso o defeito visual continue reproduzível.

## Próxima instrumentação

Adicionar trace binário opcional (`OFF`, `COUNTERS`, `DETAILED`) com registros fixos contendo:

`sequence`, `virtual_ns`, `host_qpc_ns`, `process/thread`, `phase`, `dependency_sequence` e
`wait_reason`.

O trace detalhado não será usado para o benchmark final; seu overhead será medido contra `OFF` e
`COUNTERS`.

## Comparação OFF / COUNTERS / DETAILED

Mesma execução, firmware/projeto/runtime, janela de 9 s. Os contadores abaixo são brutos da janela
(não representam tempo exclusivamente aditivo; há sobreposição entre processos/threads).

| modo | taxa MCU média | UART bytes | telemetria | pixels | eventos | stamps | solver | settle acumulado | advance-wait acumulado |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| OFF | 100,05% | 2637 | 116 | 1164 | 90523 | 71964 | 33995 | 449,85 ms | 8301,66 ms |
| COUNTERS | 100,00% | 2630 | 115 | 1162 | 89778 | 71588 | 33819 | 451,67 ms | 8318,97 ms |
| DETAILED | 99,04% | 2561 | 112 | 1172 | 88094 | 70114 | 33141 | 459,63 ms | 8195,80 ms |

Overhead relativo observado:

- COUNTERS: taxa MCU -0,05 ponto percentual; `settle` +0,4%.
- DETAILED: taxa MCU -1,01 ponto percentual; `settle` +2,2%; UART -2,9% em uma única repetição.

Essas diferenças são medidas desta repetição, não uma estimativa estatística. O DETAILED atual usa
linhas de trace existentes do caminho I2C/QEMU; ainda não satisfaz o formato causal completo e não
deve ser usado para benchmark de performance.

Uma execução de 1,2 s foi rejeitada pelo próprio benchmark porque o boot/I2C do OLED ainda não
havia terminado (`enabled=false`, framebuffer vazio). Isso confirma que a baseline deve separar
tempo de boot da janela de frames completos.

## Correção metodológica para as próximas medições

As execuções de 9 s são válidas como **Teste A (fixed host wall-clock)**: medem throughput,
progresso virtual por segundo, frames por segundo, UART por segundo e CPU. A diferença de bytes,
eventos ou solver entre modos nessa janela não será chamada de perda nem de overhead, pois cada modo
pode ter executado quantidade diferente de trabalho guest.

O overhead de instrumentação será medido pelo **Teste B (fixed guest workload)**. Cada execução
deverá terminar após o mesmo marcador determinístico: `N` frames SSD1306 completos após o primeiro
frame aceito, ou o mesmo intervalo de tempo virtual após a transição para `STEADY_STATE`. A janela
será classificada explicitamente como `BOOT`, `WARMUP` ou `STEADY_STATE`; somente a última entra na
distribuição de frame.

Para cada frame será correlacionado um `frame_sequence` com início/fim virtual e monotônico de host,
clock efetivo, bursts/refills, eventos FIFO e ACKs. A UART será comparada contra o mesmo trabalho
guest, incluindo contagem esperada, conteúdo, ordem, duplicação, ausência e timestamps virtuais.

OFF, COUNTERS e DETAILED serão repetidos em ordem alternada/randomizada. O DETAILED atual continua
sendo apenas diagnóstico; a nova versão causal deverá rejeitar a execução se
`traceRecordsDropped != 0`.

## Critério de fidelidade atualizado

O objetivo não é preservar divergências do controlador virtual atual. A regra é:

> reduzir trabalho exclusivamente host-side/IPC sem alterar comportamento guest-visible que
> corresponda ao hardware real; se o modelo virtual divergir do hardware/datasheet, corrigir o
> modelo.

O caminho de validação será um triângulo:

```text
                 REAL HARDWARE
                 /           \\
                /             \\
REFERENCE BACKEND -------- FAST BACKEND
```

O reference backend é uma ferramenta de comparação, não um oracle absoluto. Divergências serão
resolvidas contra datasheet, documentação ESP-IDF, biblioteca usada e, quando possível, captura
de ESP32 real com logic analyzer.

## Três classes de medição

- **Teste A — fixed host wall-clock:** throughput, progresso virtual por segundo, CPU e trabalho
  UART por segundo.
- **Teste B — fixed guest workload:** mesmo número de frames ou mesmo intervalo virtual; usado para
  medir overhead de instrumentação e comparar wall-clock.
- **Teste C — real-hardware fidelity:** mesmo firmware, SSD1306 e clock no ESP32 físico; mede
  `display.display()`, transações I2C, FIFO, duração de transferência, cadência UART e boot.

Os resultados serão rotulados sem mistura: `MEASURED_HARDWARE`, `MEASURED_SIMULATOR` ou
`DERIVED_FROM_DATASHEET`.

Para cada frame steady-state serão preservados `frame_sequence`, bytes/GDDRAM, limites de
transação, FIFO/refill, IRQ, ACK/NACK, duração virtual, duração host e duração física. Pixels
acesos e bytes não-zero permanecem apenas health checks; equivalência exigirá comparação de GDDRAM
e sequência I2C nos cenários de clear, texto, bitmap, partial update, addressing, offset, remap,
COM scan e scroll.

O erro temporal será calculado por operação quando houver referência:

```text
timing_error = simulator_duration - hardware_duration
timing_error_percent = timing_error / hardware_duration
```

Sem hardware disponível, a tolerância será derivada do limite físico mais overhead documentado,
não fixada arbitrariamente. A meta de `docs/39` nunca autoriza reduzir duração física ou eventos
guest-visible.

## Primeira implementação do trace causal

Foi adicionado `core/include/lasecsimul/CausalTrace.hpp` e
`core/src/trace/CausalTrace.cpp`. O recorder usa buffer pré-alocado, registros binários de tamanho
fixo, publicação atômica por índice e QPC bruto/frequência no cabeçalho. Os modos são selecionados
por `LASECSIMUL_CAUSAL_TRACE=off|counters|detailed`; o caminho OFF retorna imediatamente sem
alocação. O arquivo pode ser definido por `LASECSIMUL_CAUSAL_TRACE_PATH`.

O primeiro ponto instrumentado é a resolução de transações I2C do Core (`I2cEnter`/`I2cHandled`),
sem alterar a semântica da transferência. Uma execução de validação gerou 494 registros, 0
registros descartados e high-watermark 494 (`LSCTRCE1`, versão 1, QPC 10 MHz). Esta etapa ainda
não é o trace ponta-a-ponta: QEMU, FIFO/IRQ/timers e UART serão adicionados nas próximas unidades,
com os mesmos IDs/dependências. Portanto o arquivo é evidência de que o recorder funciona, não
uma reconstrução causal completa.
### Identidade do trace build

Baseline: Core `D7E627BF20732F8519818760D886CCF64AE5740D2B3D39CD87A5A0F9D8839358`, QEMU
`502AD7EAF2D6836B6CC2068A45B37317D2DA0446827BC711BC2247770B509946`, firmware
`2328824B5016AA292E701A03F2477A14B632CCEE1C91B463517CB423434452A9`.

Trace build: Core `9EAF1F6173CDEC4E9F3E239292B74F0050F2C202CDBA719C68291E0DD2C184B0`; QEMU e firmware
inalterados; formato `LSCTRCE1` versão 1. O parser validou 247 transações completas, sem órfãos,
duplicatas, dependências inválidas, violações de ordenação ou registros descartados.

`I2cEnter` ocorre na entrada de `resolveI2cTransferUnlocked`; `I2cHandled` ocorre imediatamente
antes do retorno do resultado combinado. O intervalo inclui resolução/dispatch e processamento do
dispositivo, não representa isoladamente o tempo interno do device.
## Guardrail SharedHost

As decisões de trace obedecem aos perfis Desktop e SharedHost: não há thread por dispositivo,
protocolo ou fonte; Core e QEMU mantêm buffers/arquivos separados; raw trace não passa pelas filas
de telemetria; Scheduler continua autoridade exclusiva do tempo virtual. Em `OFF` o recorder não
aloca buffer, não abre arquivo e não cria sincronização. Em `COUNTERS` são usados apenas contadores.
Em `DETAILED` a alocação é lazy e bounded. O registro atual tem 104 bytes; 1.000.000 registros
representam aproximadamente 104 MB por processo antes do header, portanto essa capacidade é
experimental e não default de SharedHost. A capacidade deverá ser configurável antes de testes de
1/4/8/20 sessões.

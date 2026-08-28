---
id: BENCH-005
kind: benchmark
status: active
dependsOn: [BENCH-001, ADR-0009, ARCH-003, ARCH-004, ARCH-007, ARCH-009]
supersedes: []
---

# IPC, fidelidade ao hardware e trace causal

## Objetivo

Separar atraso físico/guest-legitimate de overhead exclusivamente host-side/IPC e validar que fast paths preservam o comportamento correspondente ao hardware real sem degradar densidade SharedHost.

## Provenance obrigatória

Cada run registra:

- `session_execution_id`, runtime instance e launch generation;
- Core/runtime/firmware hashes e caminhos efetivamente carregados;
- ABI/protocolo/trace format;
- host, CPU, RAM, SO, toolchain e comando;
- modo `OFF|COUNTERS|DETAILED`.

Baseline e builds instrumentados permanecem identidades históricas separadas.

## Teste A — fixed host wall-clock

Mesma duração de host, após separar `BOOT`, `WARMUP` e `STEADY_STATE`.

Mede:

- virtual time por host second / MCU rate;
- frames por host second;
- UART por host second;
- CPU, waits, eventos, solver calls;
- throughput IPC.

Diferença de bytes/eventos entre modos não é chamada de perda se cada run executou quantidade diferente de trabalho guest.

## Teste B — fixed guest workload

Cada modo completa exatamente o mesmo trabalho, preferindo:

- `N` frames completos após `STEADY_STATE`; ou
- mesmo intervalo de tempo virtual pós-warmup.

Compara wall-clock, CPU e observer effect de `OFF`, `COUNTERS` e `DETAILED`.

UART é validada pelo mesmo trabalho guest: contagem esperada, conteúdo byte-perfect, ordem, duplicação, ausência e timestamps virtuais.

## Teste C — real-hardware fidelity

Executa quando possível o mesmo firmware em ESP32/periférico físico e captura sinais com logic analyzer. Fixtures podem usar GPIO de marcação para delimitar chamadas como `display.display()`, registrando explicitamente observer effect da fixture.

Fontes são rotuladas:

```text
MEASURED_HARDWARE
MEASURED_SIMULATOR
DERIVED_FROM_DATASHEET
```

Para I2C/SSD1306 compara quando observável:

- clock efetivo e limites START/STOP;
- bytes e ACK/NACK;
- GDDRAM/estado final e updates parciais;
- duração da transação/frame;
- comportamento FIFO/refill/IRQ/timer guest-visible;
- cadência UART concorrente.

Pixels acesos/bytes não-zero são somente health checks.

## Trace causal

DETAILED usa records fixos/bounded e buffers separados por processo. O parser rejeita:

- records descartados;
- órfãos/duplicatas;
- dependências inválidas;
- colisões de identidade;
- ordering causal impossível;
- merge de schema/provenance/execução incompatível.

Primeira cadeia I2C:

```text
T0 QemuI2cRequestReady
T1 QemuI2cRequestPublished
T2 CoreI2cEnter
T3 CoreI2cHandled
T4 CoreI2cCompletionPublished
T5 QemuI2cCompletionObserved
```

Distribuições mínimas:

```text
T0->T1
T1->T2
T2->T3
T3->T4
T4->T5
T0->T5
```

com min, mediana, p95, p99 e máximo. Períodos sobrepostos não são somados; a análise reconstrói dependências e caminho crítico.

Cada intervalo é classificado, quando houver evidência, como:

```text
PHYSICAL/GUEST-LEGITIMATE
HOST COMPUTE
IPC OVERHEAD
OS SCHEDULING
INTENTIONAL PACING
MODEL ERROR
UNKNOWN
```

## Observer effect

`OFF`, `COUNTERS` e `DETAILED` são repetidos em ordem alternada. DETAILED pode ter overhead mensurável e ainda servir à causalidade, mas benchmark final de performance usa OFF/COUNTERS conforme custo medido.

Reporte record size, capacidade, bytes alocados/commitados e high-watermark. Capacidade experimental grande não vira default SharedHost automaticamente.

## SharedHost density

Uma otimização candidata que altera recursos por sessão é medida em:

```text
1
4
8
20 sessões
```

quando aplicável ao gate de capacidade.

Registrar:

- CPU total e por processo;
- RSS/commit;
- threads/processos/handles;
- context switches e wakeups quando disponíveis;
- IPC rate;
- idle/paused CPU;
- frame timing;
- UART correctness;
- virtual-time fidelity.

Não é necessário executar 20 sessões a cada instrumentação provisória; é obrigatório antes de promover nova arquitetura/footprint como default SharedHost.

## Aceitação

- hardware é a referência final quando disponível;
- fast/reference não podem concordar entre si e divergir silenciosamente do hardware;
- mesmo guest workload permite quantificar observer effect;
- trace causal usado como evidência possui zero drops e integridade válida;
- QPC/wall-clock não altera semântica virtual;
- nenhuma otimização é aceita apenas por reduzir wall-clock se acelerar além do comportamento físico correto;
- nenhuma otimização vira default SharedHost se multiplicar recursos por sessão sem benchmark favorável.

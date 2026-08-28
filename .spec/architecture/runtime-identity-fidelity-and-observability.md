---
id: ARCH-009
kind: architecture
status: active
dependsOn: [ADR-0009, ARCH-001, ARCH-002, ARCH-003, ARCH-004, ARCH-005, ARCH-007]
supersedes: []
---

# Identidade de runtime, fidelidade e observabilidade causal

## Critério superior

Performance e otimização devem aproximar o simulador do hardware real em funcionalidade e tempo. O sistema remove overhead artificial do host sem remover comportamento que o firmware/periférico real observaria.

A validação forma um triângulo:

```text
                 REAL HARDWARE
                 /           \
                /             \
REFERENCE BACKEND -------- FAST BACKEND
```

O reference backend é ferramenta de comparação. Divergências são resolvidas por hardware real, datasheet, documentação ESP-IDF/toolchain e biblioteca efetivamente usada.

## Identidade de execução

A identidade mínima é criada no lifecycle frio e usa valores densos:

```text
session_execution_id
runtime_instance_id
launch_generation
local_transaction_sequence
```

### `session_execution_id`

- novo a cada execução real;
- pause/resume mantém o mesmo valor;
- stop + novo start gera novo valor;
- não é derivado de arena name, firmware hash ou outro fingerprint reutilizável.

### `runtime_instance_id`

- identifica o runtime lógico dentro da execução;
- MCUs distintos possuem IDs distintos mesmo se executarem o mesmo firmware;
- relaunch do processo do mesmo runtime preserva o ID;
- reutiliza handle/índice denso existente quando ele já satisfaz essas propriedades.

### `launch_generation`

- reservado/incrementado antes de cada launch attempt;
- não sofre rollback quando launch falha;
- relaunch/restart do processo externo produz nova geração;
- gaps são permitidos, reutilização não.

### Sequência local

Protocolos preservam a sequência já existente quando adequada. Para o I2C QEMU, `i2cRequestSeq` permanece a sequência local porque atravessa a arena e é devolvida em `i2cResponseSeq`.

Identidade completa de uma transação I2C:

```text
{ session_execution_id,
  runtime_instance_id,
  launch_generation,
  i2cRequestSeq }
```

Metadados de identidade podem ser passados ao processo externo por ambiente/argumento/metadata de launch. Eles são lidos uma vez no startup e não exigem alteração de ABI de arena apenas para observabilidade.

## Identity versus provenance

Identity identifica a execução. Provenance descreve o que foi executado.

Provenance por run/build inclui quando aplicável:

- build ID e SHA-256 do Core;
- build ID e SHA-256 do runtime externo;
- firmware/artefato SHA-256;
- ABI e protocolo IPC;
- toolchain e manifest versions;
- caminhos efetivamente carregados.

Uma nova compilação instrumentada recebe provenance nova sem apagar a baseline histórica.

## Causal trace

O envelope causal pode ser reutilizado por I2C, UART, Scheduler, solver e runtimes externos sem unificar a semântica dos domínios.

Campos conceituais:

```text
source_id
event_sequence
transaction/correlation_sequence
dependency_event_id
virtual_timestamp
host_monotonic/QPC
process/thread
phase/event type
state/wait reason quando necessário
```

`event_sequence` pode ser local à origem se `source_id + event_sequence` for globalmente não ambíguo. Dependências cross-process usam identidade completa, nunca apenas inteiro local ou proximidade temporal.

QPC/ticks são preservados em formato bruto com frequência no header. Conversão para nanossegundos é derivada e não implica resolução física de 1 ns.

## Modos e custo

### OFF

- zero buffer detalhado;
- zero arquivo/handle de trace;
- zero thread ou periodic wake;
- caminho reduzido a branch previsível/retorno imediato.

### COUNTERS

- somente contadores pequenos/bounded;
- nenhuma alocação de records detalhados.

### DETAILED

- alocação lazy;
- capacidade bounded/configurável;
- arquivos/buffers por processo/source;
- sem writer cross-process;
- merge offline;
- `traceRecordsDropped != 0` invalida uso como prova causal.

Dados invariantes de run/provenance ficam no header quando possível. Não se compacta record sacrificando causalidade; redução de footprint é feita depois de medir campos realmente necessários.

## SharedHost/thin-client

Toda mudança que afeta hot path ou recursos por sessão registra antes/depois de:

```text
CPU
RSS/commit
threads
processes
handles
context switches
wakeups
IPC rate
idle CPU
```

Não se cria thread por MCU, dispositivo, protocolo ou trace. Não se cria serviço global de identidade. Sessão vazia e trace OFF permanecem praticamente inativos.

O custo de DETAILED é diagnóstico e nunca define footprint padrão. Capacidade de trace deve ser avaliada em 1, 4, 8 e 20 sessões antes de qualquer promoção no perfil SharedHost.

## Fidelidade temporal

Para operação guest-visible relevante distinguem-se três relógios:

```text
virtual time
host monotonic/wall duration
real-hardware duration
```

O host clock observa execução; não define semântica.

Quando existir hardware de referência:

```text
timing_error = simulator_duration - hardware_duration
timing_error_percent = timing_error / hardware_duration
```

Tolerância é derivada da variabilidade física/host e do modelo, não escolhida apenas para satisfazer meta de performance.

Meta de wall-clock, como `<=100 ms`, nunca autoriza encurtar duração física, FIFO/refill, IRQ, timers, registradores ou oportunidades legítimas da vCPU.

## Trace I2C inicial

A primeira cadeia mínima é:

```text
QemuI2cRequestReady
QemuI2cRequestPublished
CoreI2cEnter
CoreI2cHandled
CoreI2cCompletionPublished
QemuI2cCompletionObserved
```

Ela deve existir antes de instrumentar em massa doorbell, FIFO, IRQ, timers ou UART. Cada ampliação passa por parser de integridade, zero drops e medição de observer effect.

## Aceitação

- pause/resume preserva `session_execution_id`; stop + novo start não;
- relaunch preserva `runtime_instance_id` e incrementa `launch_generation` sem reutilização;
- duas sessões e dois MCUs não colidem mesmo com a mesma sequência local;
- hot path não calcula hash/string para identidade;
- trace OFF não cria buffer, arquivo, thread, wake ou sincronização própria;
- DETAILED é bounded/lazy e rejeita análise causal com drops;
- Core e runtime externo escrevem separadamente e merge incompatível é rejeitado;
- QPC/wall-clock não alteram tempo virtual;
- otimização fast é diferencialmente equivalente ao comportamento correto de hardware;
- qualquer aumento de recurso por sessão é benchmarkado no SharedHost antes de virar default.

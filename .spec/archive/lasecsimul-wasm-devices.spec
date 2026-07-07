<!-- Claude Code Spec Header v1 -->
## Claude Code Operating Contract (English)

Purpose: Historical record of a superseded design path.
Audience: coding agents needing migration/decision context.
Mode: non-implementable reference.

Keywords: superseded, historical, wasm, worker-threads, rejected-architecture, migration-note

Priority Rules:
1. MUST treat this document as historical context only.
2. MUST NOT implement new features from this design path.
3. SHOULD map any relevant concept to the current native-plugin spec when needed.

Agent Workflow:
1. If requested behavior references this file, redirect implementation to native plugin architecture.
2. Keep this file for rationale and traceability only.

Decision Keywords:
- SUPERSEDED means implementation is prohibited unless the project explicitly reopens architecture strategy.

---
# LasecSimul — Sistema de Dispositivos Customizados em WASM (v0.1)

> **SUPERSEDED — não implementar.** Esta abordagem (worker_threads + módulo WASM por dispositivo) foi
> avaliada como inadequada para o caminho crítico do solver: o custo de IPC/mensagens por chamada (µs a
> dezenas de µs) é 3-4 ordens de magnitude maior que uma chamada de função nativa, o que se tornaria um
> gargalo caso a biblioteca padrão (resistor, capacitor, instrumentos) também precisasse passar por aqui.
> Substituída por **`lasecsimul-native-devices.spec`** (plugins nativos DLL/SO em processo, sem sandbox,
> mesma velocidade de um componente compilado no Core — ver `lasecsimul.spec` v0.2). Mantido neste arquivo
> apenas como registro histórico da decisão; não usar como referência de implementação.

Status: rascunho inicial — SUPERSEDED | Depende de: [`.spec/lasecsimul.spec`](./lasecsimul.spec) | Análogo conceitual: Wokwi Custom Chips

---

## 0. Relação com a especificação principal

Este subsistema é uma **especialização da Camada 3 (Componentes Eletrônicos)** definida em
`.spec/lasecsimul.spec`. Um dispositivo WASM customizado é, do ponto de vista do núcleo, um
`IComponentModel` igual a qualquer resistor ou LED nativo — a única diferença é que sua implementação não é
um `model.ts` compilado estaticamente na extensão, mas um módulo `.wasm` carregado **dinamicamente em
runtime**, fornecido pelo usuário.

Consequência arquitetural direta: **nenhuma interface nova é necessária no núcleo**. O sistema WASM introduz
um único adaptador genérico (`WasmDeviceProxy`) que implementa `IPinProvider` + `ISimulatable` +
`ISerializable` (as mesmas interfaces de `core/interfaces/`) e delega o comportamento elétrico ao módulo
WASM. Adicionar um dispositivo nunca é "adicionar código ao simulador" — é "adicionar uma pasta com
`device.json` + `device.wasm`".

## 1. Arquitetura geral do sistema de plugins

```
┌───────────────────────────────────────────────────────────────────────┐
│ Simulation Core (camada 2 do .spec principal)                        │
│                                                                       │
│  ComponentRegistry.register(typeId, factory) ◄── WasmDeviceLoader     │
│                                                                       │
│  ┌─────────────────┐        stamp()/postStep()       ┌─────────────┐ │
│  │  MnaSolver       │ ───────────────────────────────►│WasmDeviceProxy│ implementa IComponentModel
│  │  (Netlist)       │ ◄─── pin levels (cosimulação) ──│ (1 por device)│ │
│  └─────────────────┘                                  └──────┬──────┘ │
└─────────────────────────────────────────────────────────────┼────────┘
                                                                │ mensagens (SharedArrayBuffer + postMessage)
                                                  ┌─────────────▼─────────────┐
                                                  │   WasmDeviceHost           │
                                                  │   (pool de worker_threads) │
                                                  │   1..N devices por worker  │
                                                  └─────────────┬──────────────┘
                                                                │ WebAssembly.instantiate
                                                  ┌─────────────▼──────────────┐
                                                  │  Instância WASM isolada     │
                                                  │  (memória linear própria,   │
                                                  │   sem WASI, sem rede/FS)    │
                                                  └─────────────────────────────┘
```

Componentes novos do subsistema (todos em `LasecSimul/src/wasm-devices/`, fora de `core/`):

| Módulo | Responsabilidade única (SRP) |
|---|---|
| `WasmDeviceLoader` | Descobre bibliotecas, valida `device.json` e a ABI do `.wasm`, registra `typeId` no `ComponentRegistry` |
| `WasmDeviceProxy` | Implementa `IComponentModel`; ponte entre o `MnaSolver` e o worker do device |
| `WasmDeviceHost` | Gerencia o pool de `worker_threads`, ciclo de vida, watchdog de tempo |
| `BusController` | Roteia tráfego I2C/SPI/UART entre `IBusParticipant` (devices, e futuramente MCUs) |
| `WasmDeviceRegistry` | Mapa `typeId -> manifest + caminho do .wasm` (paralelo ao `ComponentRegistry`, alimenta-o) |

Baixo acoplamento: `WasmDeviceProxy` não conhece o conteúdo do `.wasm`; `WasmDeviceHost` não conhece
eletricidade (MNA); `BusController` não conhece se o participante é WASM ou nativo — todos conversam por
interface (`IComponentModel`, `IBusParticipant`), nunca por tipo concreto (DIP).

### Decisão de design: cosimulação com 1 passo de atraso

O `MnaSolver` é síncrono e determinístico; um worker WASM é assíncrono e seu tempo de resposta não é
garantido. Para não bloquear o solver a cada passo elétrico esperando um worker:

- A cada macropasso `Δt`, o `MnaSolver` usa os **níveis de pino calculados no passo anterior** pelo device
  (zero-order hold).
- Em paralelo, o `WasmDeviceProxy` envia `lsd_step(dt)` ao worker; quando a resposta chega, os novos níveis
  ficam disponíveis para o **próximo** macropasso.
- Isso é o mesmo princípio de co-simulação por passo usado por padrões como FMI co-simulation: aceita-se um
  atraso de 1 passo em troca de paralelismo real e isolamento de falhas. Para `Δt` típicos de simulação
  (microssegundos a poucos milissegundos), o atraso é imperceptível para a maioria dos dispositivos
  (sensores, displays, lógica discreta); dispositivos que exigem resposta combinacional no mesmo passo devem
  ser modelados como componente nativo, não como device WASM — isso deve constar na documentação do SDK.

## 2. Modelo de dispositivo customizado

Um dispositivo é definido por:

1. **Manifesto** (`device.json`) — declara `typeId`, pinos, propriedades configuráveis, barramentos e limites
   de execução. É a única fonte de verdade sobre a interface elétrica do dispositivo perante o núcleo.
2. **Módulo WASM** (`device.wasm`) — implementa o comportamento. Não declara pinos por conta própria; lê os
   pinos que o manifesto já declarou via `lsd_host_pin_declare` para obter um *handle* numérico.
3. **Estado runtime** — uma instância (`ctx`) por dispositivo colocado no esquemático; múltiplas instâncias
   do mesmo `typeId` são módulos WASM independentes (mesmo bytecode, memórias lineares distintas).

```typescript
// LasecSimul/src/wasm-devices/WasmDeviceProxy.ts (esqueleto conceitual)
export class WasmDeviceProxy implements IComponentModel {
  readonly typeId: string;                 // do manifesto
  readonly pins: Pin[];                    // do manifesto
  readonly properties: ComponentProperties; // do manifesto, editável na UI

  constructor(private readonly host: WasmDeviceHost, private readonly manifest: WasmDeviceManifest) {}

  stamp(matrix: MnaMatrix): void {
    // aplica os últimos níveis de pino conhecidos (cosimulação, ver seção 1)
  }
  postStep(time: SimTime): void {
    // dispara lsd_step(dt) no worker de forma assíncrona; não bloqueia
    this.host.step(this.manifest.instanceId, time);
  }
  toJSON() { /* delega a lsd_get_state via host */ return {}; }
  fromJSON(data: Record<string, unknown>) { /* delega a lsd_set_state via host */ }
  getPin(id: string) { return this.pins.find(p => p.id === id)!; }
}
```

## 3. Ciclo de vida do dispositivo

```
load            WasmDeviceLoader valida device.json + exports/imports do .wasm
  │
instantiate     WasmDeviceHost aloca/reaproveita worker, WebAssembly.instantiate(bytes, imports)
  │
create          guest: lsd_create() -> ctx
  │
init            guest: lsd_init(ctx)        — lê properties via lsd_host_get_property_f32, declara pinos
  │
┌─► running     guest: lsd_step(ctx, dt) a cada macropasso
│               guest: lsd_on_event(ctx, ev_ptr, ev_len) para pin-change/bus/timer
│   │
│   pause/resume  Scheduler para/retoma chamadas de lsd_step (sem destruir a instância)
└───┘
  │
serialize       guest: lsd_get_state(ctx, out_ptr, out_cap) — ao salvar o projeto (.lsproj)
deserialize     guest: lsd_set_state(ctx, in_ptr, in_len)  — ao abrir o projeto
  │
destroy         guest: lsd_destroy(ctx) — ao remover o componente do esquemático ou fechar o projeto
  │
unload          WasmDeviceHost libera a instância; worker retorna ao pool ou é finalizado
```

Estado de erro `faulted` pode ser entrado em qualquer ponto a partir de `instantiate` (ver seção 12) e é
terminal para aquela instância — o usuário precisa remover/recriar o componente para tentar novamente.

## 4. API pública para criação de dispositivos (SDK)

Distribuída como cabeçalho C versionado (`lasecsimul_device.h`) + wrappers idiomáticos:

- `@lasecsimul/device-sdk-rust` (crate, `#![no_std]` opcional)
- `@lasecsimul/device-sdk-as` (AssemblyScript)
- cabeçalho C puro para Clang/`wasm32-unknown-unknown` ou Zig

A API é **a única superfície permitida** entre o dispositivo e o simulador — nenhuma outra função pode ser
importada pelo módulo (o loader rejeita o módulo se ele importar qualquer símbolo fora do namespace
`lsd_host`). Versionamento semântico via `LSD_ABI_VERSION` (major.minor): bump de `minor` = nova função de
host adicionada (compatível com devices antigos); bump de `major` = mudança incompatível.

```c
// lasecsimul_device.h (trecho)
#define LSD_ABI_VERSION_MAJOR 1
#define LSD_ABI_VERSION_MINOR 0

typedef enum { LSD_PIN_DIGITAL_IN, LSD_PIN_DIGITAL_OUT, LSD_PIN_DIGITAL_BIDIR,
               LSD_PIN_ANALOG_IN, LSD_PIN_ANALOG_OUT, LSD_PIN_PWM_OUT, LSD_PIN_POWER } lsd_pin_kind_t;

typedef enum { LSD_EVT_PIN_CHANGE = 1, LSD_EVT_TIMER = 2, LSD_EVT_BUS_WRITE = 3,
               LSD_EVT_BUS_READ_REQUEST = 4, LSD_EVT_FAULT_WARNING = 5 } lsd_event_tag_t;

typedef enum { LSD_BUS_ROLE_MASTER = 0, LSD_BUS_ROLE_SLAVE = 1 } lsd_bus_role_t;
```

## 5. Funções obrigatórias exportadas pelo módulo WASM (guest)

Conjunto mínimo e fixo — qualquer evento além de `step` é roteado por `lsd_on_event` (seção 9), o que evita
crescer a lista de exports obrigatórios a cada nova funcionalidade (OCP):

| Export | Assinatura | Chamado quando |
|---|---|---|
| `lsd_create` | `() -> u32 (ctx)` | instanciação |
| `lsd_init` | `(ctx: u32) -> void` | uma vez, após `create` |
| `lsd_step` | `(ctx: u32, dt_ns: u64) -> void` | a cada macropasso de simulação (hot path) |
| `lsd_on_event` | `(ctx: u32, event_ptr: u32, event_len: u32) -> void` | pin-change, bus, timer, fault-warning |
| `lsd_get_state` | `(ctx: u32, out_ptr: u32, out_cap: u32) -> u32 (bytes escritos)` | salvar projeto |
| `lsd_set_state` | `(ctx: u32, in_ptr: u32, in_len: u32) -> void` | abrir projeto |
| `lsd_destroy` | `(ctx: u32) -> void` | remoção do componente |
| `memory` | (export de memória linear, não função) | usado pelo host para ler/escrever buffers |

## 6. Funções fornecidas pelo simulador ao dispositivo (host imports, namespace `lsd_host`)

| Import | Assinatura | Uso |
|---|---|---|
| `lsd_host_pin_declare` | `(ctx, index, kind, name_ptr, name_len) -> u32 (handle)` | registra pino do manifesto, obtém handle |
| `lsd_host_pin_write` | `(ctx, pin, level: i32) -> void` | escreve nível digital/Z |
| `lsd_host_pin_write_analog` | `(ctx, pin, volts: f32) -> void` | escreve nível analógico/PWM (duty pré-convertido) |
| `lsd_host_pin_read` | `(ctx, pin) -> i32` | lê nível do nó conectado |
| `lsd_host_pin_watch` | `(ctx, pin, enable: i32) -> void` | habilita `LSD_EVT_PIN_CHANGE` para esse pino |
| `lsd_host_bus_attach` | `(ctx, id_ptr, id_len, role, address) -> u32 (handle)` | entra em um barramento I2C/SPI/UART |
| `lsd_host_bus_write` | `(ctx, bus, data_ptr, data_len) -> void` | envia bytes no barramento |
| `lsd_host_bus_read` | `(ctx, bus, out_ptr, out_cap) -> u32` | lê bytes recebidos |
| `lsd_host_schedule_event` | `(ctx, delay_ns: u64, event_id: u32) -> void` | agenda `LSD_EVT_TIMER` futuro |
| `lsd_host_get_property_f32` | `(ctx, name_ptr, name_len) -> f32` | lê propriedade configurável do manifesto |
| `lsd_host_now_ns` | `(ctx) -> u64` | tempo de simulação (determinístico, não wall-clock) |
| `lsd_host_log` | `(ctx, level, msg_ptr, msg_len) -> void` | log estruturado, aparece no Output do VSCode |

Nenhuma função de I/O de sistema (arquivo, rede, processo, clock real) é importável — sandbox garantido pela
ausência do import, não por checagem em runtime.

## 7. Modelo de pinos digitais, analógicos, PWM e bidirecionais

Cada pino declarado no manifesto tem um `lsd_pin_kind_t` fixo (exceto `BIDIR`, que pode alternar direção em
runtime via um import adicional `lsd_host_pin_set_direction`). O `WasmDeviceProxy` traduz cada kind em uma
contribuição de `stamp()` diferente:

| Kind | Comportamento elétrico em `stamp()` |
|---|---|
| `DIGITAL_OUT` (nível alto) | fonte de tensão `Vlogic` em série com resistência de saída configurável |
| `DIGITAL_OUT` (nível baixo) | fonte de tensão `0V` |
| `DIGITAL_OUT` (alta impedância / tri-state) | sem stamp (nó flutua, resolvido pelo resto da rede) |
| `DIGITAL_IN` | sem stamp; amostra a tensão do nó por passo, compara a `Vth` (limiar configurável por família lógica) e gera `LSD_EVT_PIN_CHANGE` |
| `ANALOG_OUT` | fonte de tensão no valor escrito por `lsd_host_pin_write_analog` |
| `ANALOG_IN` | sem stamp; entrega a tensão real do nó (sem quantização) |
| `PWM_OUT` | dois modos configuráveis no manifesto: `"averaged"` (fonte de tensão = duty × Vlogic, sem ondulação — leve e suficiente para a maioria) ou `"edge-accurate"` (o `Scheduler` reduz `Δt` localmente para resolver as bordas reais do PWM) |
| `BIDIR` | direção corrente decide qual dos dois comportamentos acima se aplica nesse passo |
| `POWER` (Vcc/GND) | referência apenas; usado para lógica de power-good interna do device, não participa do `stamp()` como sinal |

## 8. Modelo de comunicação I2C, SPI, UART e GPIO

- **GPIO**: não é um barramento — é o conjunto de pinos digitais independentes já cobertos na seção 7.
  Reaproveitado sem alteração quando um device é exposto como periférico de um MCU (seção 20).
- **I2C**: seleção de participante é **por endereço de protocolo**, não elétrica. `BusController` mantém um
  mapa `endereço -> IBusParticipant` por `bus_id`; ao receber `lsd_host_bus_write` de um master, resolve o
  endereço do primeiro byte e roteia para o slave correspondente, entregando `LSD_EVT_BUS_WRITE`/
  `LSD_EVT_BUS_READ_REQUEST` a ele. Múltiplos masters no mesmo `bus_id` exigem arbitragem (fora do escopo
  v0.1 — documentar como limitação conhecida).
- **SPI**: seleção de participante é **elétrica**, via pino Chip-Select declarado como `DIGITAL_IN` comum no
  manifesto. `BusController` só encaminha bytes ao device cujo CS está ativo no momento da transferência —
  o protocolo SPI em si não carrega endereço.
- **UART**: tipicamente ponto-a-ponto (par TX/RX); modelado como pinos digitais com framing de byte feito
  pelo host (`lsd_host_bus_attach` com `role = UART`); não exige `BusController` com múltiplos participantes,
  mas usa a mesma interface `IBusParticipant` por consistência (ex: futura UART multiponto/RS-485).

```typescript
// LasecSimul/src/wasm-devices/IBusParticipant.ts (conceitual)
export interface IBusParticipant {
  readonly busRole: "master" | "slave";
  readonly address?: number; // só para I2C
  onBusWrite(data: Uint8Array): void;
  onBusReadRequest(): Uint8Array;
}
```

## 9. Modelo de eventos

Evento = struct pequena escrita pelo host na memória do guest antes de chamar `lsd_on_event`:

```c
typedef struct { uint32_t tag; uint32_t a; uint32_t b; uint32_t c; } lsd_event_t;
```

| Tag | Campos (a, b, c) | Origem |
|---|---|---|
| `LSD_EVT_PIN_CHANGE` | pin handle, novo nível, — | `WasmDeviceProxy` após `stamp()`/leitura de nó |
| `LSD_EVT_TIMER` | event_id, —, — | `lsd_host_schedule_event` vencido |
| `LSD_EVT_BUS_WRITE` | bus handle, ptr do payload (em memória do guest), len | `BusController` |
| `LSD_EVT_BUS_READ_REQUEST` | bus handle, —, — | `BusController` (master solicitando leitura) |
| `LSD_EVT_FAULT_WARNING` | código, —, — | `WasmDeviceHost` (ex: aproximando-se do limite de fuel) |

Adicionar um novo tipo de evento no futuro (ex: eventos de IRQ vindos de um MCU emulado) não exige novo
export no ABI — apenas um novo valor de `tag`, mantendo o contrato de exports estável (OCP).

## 10. Scheduler de execução dos dispositivos

`WasmDeviceScheduler` (parte de `core/simulation/Scheduler.ts`, mas modular — pode ser substituído):

1. No início de cada macropasso, coleta níveis de pino pendentes da rodada anterior (zero-order hold, seção 1) e os aplica via `stamp()` de cada `WasmDeviceProxy`.
2. Resolve o sistema elétrico normalmente (`MnaSolver`).
3. Dispara `step(dt)` para todos os devices ativos **em paralelo**, sem esperar a resposta antes de seguir para o próximo macropasso.
4. Respostas (`lsd_step` concluído + eventos emitidos) chegam de forma assíncrona e são aplicadas de forma
   determinística: bufferizadas e processadas na **ordem de registro do device no netlist**, nunca na ordem
   de chegada da thread (evita não-determinismo entre execuções).
5. Device que não responde dentro do orçamento (seção 13) mantém o último nível conhecido nesse macropasso e
   é marcado "lagging"; acumular faltas consecutivas leva a `faulted` (seção 12).

## 11. Suporte a multitarefa, workers ou execução paralela

- Pool de `worker_threads` dimensionado por `os.cpus().length` (configurável pelo usuário).
- Modo de isolamento por device, declarado em `device.json.isolation`:
  - `"shared"` (padrão): até N devices (configurável, padrão 8) compartilham um worker — menor overhead, indicado para devices leves (sensores, displays simples).
  - `"dedicated"`: o device recebe um worker próprio — maior isolamento e maior orçamento de CPU, indicado para devices pesados ou que o autor marcou como "não confiável" para co-habitar.
- Canal de dados de alta frequência (níveis de pino) via `SharedArrayBuffer` + fila lock-free SPSC por
  device; canal de controle/ciclo de vida (create/init/destroy/get_state/set_state) via `postMessage`
  estruturado — não é hot path, o custo de clonagem é aceitável.
- Cada worker é independente do `SimulationEngine` (camada 2) por design — múltiplas simulações futuras
  (ex: dois projetos abertos) podem compartilhar o mesmo pool de workers sem colisão.

## 12. Isolamento e prevenção de falhas

- **Memória**: cada instância WASM tem memória linear própria (garantia da especificação WebAssembly) —
  impossível um device ler/escrever memória de outro device ou do host.
- **Capacidades**: só os imports do namespace `lsd_host` (seção 6) são linkados; o loader rejeita no
  carregamento qualquer módulo que importe um símbolo fora dessa lista — não há checagem em runtime a
  burlar, a capacidade simplesmente não existe no módulo instanciado.
- **Falha de thread**: crash de um worker (trap não tratado, exceção JS na marshaling) é capturado por
  `WasmDeviceHost` via `worker.on('error'|'exit')`; todos os devices hospedados nesse worker são marcados
  `faulted` e, se o worker era compartilhado, um novo worker é criado para os devices saudáveis restantes
  serem remigrados (apenas os que não causaram o crash).
- **Contenção no circuito**: pinos de um device `faulted` deixam de contribuir ao `stamp()` (alta impedância)
  — uma falha de device nunca lança exc eção dentro do `MnaSolver`.
- **Validação estática no load**: manifesto declara contagem de pinos/propriedades/barramentos; o loader
  rejeita o módulo se os exports não casarem com a assinatura esperada (introspecção via
  `WebAssembly.Module.exports/imports` antes de instanciar) ou se o manifesto referenciar pino/barramento não
  declarado.

## 13. Limite de tempo de execução por dispositivo

Duas camadas de defesa, manifesto declara em `limits`:

```json
"limits": { "fuelPerStep": 200000, "fuelPerEvent": 100000, "memoryPages": 16, "stepTimeoutMs": 4 }
```

1. **Fuel metering** (linha primária): o motor WASM hospedeiro deve suportar contagem de instruções/"fuel"
   (ex: Wasmtime via binding Node) e interromper a chamada de forma limpa ao esgotar o orçamento por
   `step`/`on_event` — vira `faulted: cpu-budget-exceeded`, não um hang.
2. **Watchdog de wall-clock** (linha secundária, fallback para motores sem fuel metering, ex: `WebAssembly`
   nativo do V8): se a chamada não retornar em `stepTimeoutMs`, o macropasso atual não espera (zero-order
   hold, ver seção 10); após `K` timeouts consecutivos (padrão 5) o worker é finalizado via
   `Worker.terminate()` e o device marcado `faulted`.
3. `memoryPages` limita o crescimento da memória linear (cada página = 64 KiB); tentativa de `memory.grow`
   acima do limite falha no próprio guest (comportamento padrão do WASM), sem intervenção do host.

## 14. Estrutura de pastas de uma biblioteca

```
my-device-library/
├── library.json                   # nome, autor, versão, licença, devices incluídos
├── devices/
│   ├── my-led-matrix/
│   │   ├── device.json            # manifesto (seção 15)
│   │   ├── src/                   # fonte pré-build (Rust/C/AssemblyScript), opcional no pacote final
│   │   │   └── lib.rs
│   │   ├── build/
│   │   │   └── device.wasm        # único artefato necessário em runtime
│   │   ├── icon.svg
│   │   └── README.md
│   └── my-i2c-sensor/
│       └── ... (mesma estrutura)
├── test/                          # testes via device-test-kit (seção 19)
└── package.json                   # se distribuída via npm/VSCode marketplace
```

## 15. Exemplo de manifesto do dispositivo (`device.json`)

```json
{
  "schemaVersion": 1,
  "typeId": "community.my-led-matrix",
  "name": "8x8 LED Matrix (custom)",
  "abiVersion": { "major": 1, "minor": 0 },
  "wasmEntry": "build/device.wasm",
  "isolation": "shared",
  "pins": [
    { "id": "din", "kind": "DIGITAL_IN", "x": 0, "y": 0 },
    { "id": "clk", "kind": "DIGITAL_IN", "x": 0, "y": 1 },
    { "id": "vcc", "kind": "POWER", "x": 1, "y": 0 },
    { "id": "gnd", "kind": "POWER", "x": 1, "y": 1 }
  ],
  "properties": [
    { "name": "brightness", "type": "number", "default": 1.0, "min": 0, "max": 1 }
  ],
  "buses": [],
  "limits": { "fuelPerStep": 200000, "fuelPerEvent": 100000, "memoryPages": 16, "stepTimeoutMs": 4 }
}
```

## 16. Exemplo de dispositivo simples em WASM (blinker, em C)

```c
#include "lasecsimul_device.h"

typedef struct { uint32_t pin_out; uint64_t acc_ns; int32_t level; } device_ctx_t;
static device_ctx_t g_ctx; // 1 instância por módulo (cada device WASM já é isolado por instância)

uint32_t lsd_create(void) { return 1; /* handle opaco simples */ }

void lsd_init(uint32_t ctx) {
  g_ctx.pin_out = lsd_host_pin_declare(ctx, 0, LSD_PIN_DIGITAL_OUT, "out", 3);
  g_ctx.level = 0;
}

void lsd_step(uint32_t ctx, uint64_t dt_ns) {
  g_ctx.acc_ns += dt_ns;
  if (g_ctx.acc_ns >= 500000000ULL) { // 500 ms
    g_ctx.acc_ns = 0;
    g_ctx.level = !g_ctx.level;
    lsd_host_pin_write(ctx, g_ctx.pin_out, g_ctx.level);
  }
}

void lsd_on_event(uint32_t ctx, uint32_t event_ptr, uint32_t event_len) { /* não usa eventos */ }
uint32_t lsd_get_state(uint32_t ctx, uint32_t out_ptr, uint32_t out_cap) { return 0; }
void lsd_set_state(uint32_t ctx, uint32_t in_ptr, uint32_t in_len) {}
void lsd_destroy(uint32_t ctx) {}
```

## 17. Exemplo de dispositivo com barramento I2C (sensor de temperatura customizado)

```c
#include "lasecsimul_device.h"

typedef struct { uint32_t bus; float temperature_c; } device_ctx_t;
static device_ctx_t g_ctx;

uint32_t lsd_create(void) { return 1; }

void lsd_init(uint32_t ctx) {
  g_ctx.bus = lsd_host_bus_attach(ctx, "i2c0", 4, LSD_BUS_ROLE_SLAVE, 0x48);
  g_ctx.temperature_c = lsd_host_get_property_f32(ctx, "initialTemp", 11);
}

void lsd_step(uint32_t ctx, uint64_t dt_ns) {
  // ex: deriva térmica lenta em direção a uma temperatura ambiente configurável
}

void lsd_on_event(uint32_t ctx, uint32_t event_ptr, uint32_t event_len) {
  lsd_event_t* ev = (lsd_event_t*)event_ptr;
  if (ev->tag == LSD_EVT_BUS_READ_REQUEST) {
    int16_t raw = (int16_t)(g_ctx.temperature_c * 256.0f); // formato típico de sensor I2C
    uint8_t payload[2] = { (uint8_t)(raw >> 8), (uint8_t)(raw & 0xFF) };
    lsd_host_bus_write(ctx, g_ctx.bus, payload, 2); // resposta ao master é só uma escrita no barramento
  }
}

uint32_t lsd_get_state(uint32_t ctx, uint32_t out_ptr, uint32_t out_cap) { return 0; }
void lsd_set_state(uint32_t ctx, uint32_t in_ptr, uint32_t in_len) {}
void lsd_destroy(uint32_t ctx) {}
```

## 18. Processo de build, empacotamento e instalação

1. **Toolchains suportadas**: Rust (`--target wasm32-unknown-unknown`, sem `wasm-bindgen` — ABI é C puro),
   C/C++ (`clang --target=wasm32 -nostdlib`), AssemblyScript (`asc`).
2. **`lasecsimul-cli build`**: invoca a toolchain do `device.json`/`src/`, roda `wasm-opt -Oz` para reduzir
   tamanho, introspecciona o `.wasm` resultante e valida exports/imports contra o ABI da seção 5/6, grava
   `build/device.wasm` + checksum SHA-256.
3. **`lasecsimul-cli test`**: roda a suíte de conformidade (seção 19) contra o artefato antes de liberar
   publicação.
4. **Empacotamento**: a pasta da biblioteca é compactada (zip) **ou** publicada como pacote npm/extensão
   VSCode fina que só contribui `lasecsimul.deviceLibraries` apontando para `library.json` — mesmo mecanismo
   de `contributes` já usado para componentes nativos e MCUs no `.spec` principal.
5. **Instalação**, três origens descobertas pelo `WasmDeviceLoader` na ativação da extensão:
   - `~/.lasecsimul/libraries/<lib>/` — instalação global do usuário (drag-and-drop ou CLI);
   - biblioteca contribuída por outra extensão VSCode instalada (`contributes.lasecsimul.deviceLibraries`);
   - `./lasecsimul-devices/` na raiz do workspace — devices específicos do projeto, versionados com ele.
6. **Validação no load**: schema-valida `device.json` → checa `abiVersion` compatível → introspecciona
   exports/imports → faz um *dry-run* de `create`+`init`+`destroy` isolado → só então registra `typeId` no
   `ComponentRegistry`. Falha em qualquer etapa impede o carregamento e reporta erro acionável na UI
   (arquivo, linha do manifesto, motivo), nunca derruba a extensão.

## 19. Estratégia de testes

| Nível | Ferramenta | O que valida |
|---|---|---|
| Unitário (lógica) | testes nativos da linguagem-fonte (ex: `cargo test`) compilando para o target nativo, não wasm | regras de negócio do device isoladas da ABI |
| Unitário (ABI) | `@lasecsimul/device-test-kit` (Node) carrega o `.wasm` real e injeta estímulos de pino/barramento, sem simulador elétrico completo | comportamento do device fiel ao manifesto, rápido e determinístico |
| Trace dourado | `device-test-kit --golden` | regressão: grava estímulo→resposta de versões aprovadas, compara em cada build |
| Integração | `SimulationEngine` headless (sem VSCode) com netlist mínima contendo o device | comportamento elétrico correto dentro da co-simulação real (seção 1) |
| Fault injection | harness que carrega `.wasm` malformado/com loop infinito/memória fora dos limites | isolamento (seção 12) e limites de tempo (seção 13) seguram a falha sem propagar |
| Conformidade ABI | `lasecsimul-cli test` (roda os quatro níveis acima) | gate obrigatório antes de publicar uma biblioteca |

## 20. Integração com a extensão VSCode e com QEMU

**VSCode**:
- Ponto de extensão `contributes.lasecsimul.deviceLibraries` (mesmo padrão de `.components`/`.mcus` do
  `.spec` principal) aponta para `library.json`.
- Painel de propriedades lê `properties[]` do manifesto para gerar UI de edição automaticamente — nenhum
  código de UI por device.
- Paleta de componentes do editor de esquemático lista `typeId`s descobertos, usando `icon.svg` do manifesto.
- Erros de carregamento (seção 18, item 6) aparecem como diagnósticos no painel de problemas do VSCode,
  apontando o arquivo de manifesto.

**QEMU (integração futura, já suportada pela arquitetura sem mudanças)**:
- Um device WASM é um `IComponentModel` como qualquer outro — quando seus pinos estão ligados a nós que o
  `PinMapper`/`GpioBridge` (camada 4 do `.spec` principal) conecta a um MCU emulado, ele já participa da
  simulação como qualquer componente nativo, sem código especial.
- Para barramentos: o periférico I2C/SPI de um `IMcuAdapter` simplesmente se registra no mesmo
  `BusController` (seção 8) como `IBusParticipant` com `busRole: "master"` — um sensor WASM customizado e um
  ESP32 emulado conversando por I2C é apenas dois participantes no mesmo `bus_id`, nenhuma ponte dedicada
  MCU↔WASM é necessária.
- Único trabalho futuro de fato novo: mapear o `PeripheralRef` do `IMcuAdapter` para um `bus_id`/endereço de
  `BusController`, o que é configuração (no `mcu.json`), não arquitetura nova.

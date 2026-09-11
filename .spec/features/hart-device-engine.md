---
id: FEAT-013
kind: feature
status: planned
dependsOn: [FEAT-001, ARCH-002, ARCH-004, ARCH-005, ARCH-006, FEAT-009]
supersedes: []
---


# HART Device Engine — motor modular de dispositivos HART

## 1. Propósito

Esta especificação define a evolução da implementação HART existente no LasecSimul para um **HART Device Engine** modular, extensível e eficiente, capaz de representar múltiplos tipos e instâncias de dispositivos HART sem exigir alterações no dispatcher central, na UI ou no transporte a cada novo equipamento.

O motor deve permitir:

- adicionar novos perfis/tipos de dispositivo HART;
- remover perfis/tipos sem alterar o núcleo do protocolo;
- criar e remover instâncias de dispositivos a partir desses perfis;
- registrar e remover comandos HART independentemente;
- compartilhar funções de parsing/interpretação entre comandos;
- executar múltiplos dispositivos com baixo custo de CPU e memória;
- funcionar de forma determinística no transporte virtual;
- preservar isolamento por `SimulationSession`;
- operar adequadamente em Desktop, SharedHost e futuro backend remoto;
- suportar uma arquitetura thin client na qual a UI não executa a lógica HART;
- permitir transportes físicos/reais de maneira opcional, explícita e governada por orçamento de recursos.

Esta feature **não cria uma segunda implementação HART paralela**. Ela estende e generaliza `FEAT-009`, preservando os componentes HART já entregues como perfis/compatibilidade sobre o novo motor.

---

## 2. Contexto

O LasecSimul já estabelece:

- Core C++ como autoridade da simulação;
- Extension/cliente como camada de autoria, visualização e comando;
- `SimulationPlan` imutável compilado fora do hot path;
- `RuntimeState` mutável e isolado por sessão;
- registries e handles densos para evitar resolução de strings durante a execução;
- telemetria bounded e latest-wins quando apropriado;
- ResourceGovernor para limitar threads, processos, buffers, filas e transportes reais;
- protocolos industriais semanticamente separados de suas camadas físicas;
- HART virtual existente através de `protocol.hart.transmitter` e `protocol.hart.communicator`.

O projeto `process_simul` contém conceitos valiosos que devem ser reaproveitados arquiteturalmente, em especial:

- `EquipmentRepository`;
- definição/perfil de equipamentos;
- `HartCommandHandler`;
- `HartCommandContext`;
- `HartCommandRegistry`;
- `HartFunctionRegistry`;
- codec/parser compartilhado;
- framing HART;
- transportes TCP e serial;
- separação entre cadastro de equipamento e widgets.

Esses conceitos devem ser **adaptados para a arquitetura do LasecSimul**, e não copiados literalmente do Flutter/Dart.

---

## 3. Decisões arquiteturais obrigatórias

### 3.1. Um engine por sessão, não um runtime pesado por dispositivo

Cada `SimulationSession` deve possuir no máximo um `HartEngine` lógico.

O engine gerencia todos os barramentos, perfis e instâncias HART daquela sessão.

É proibido criar, por dispositivo virtual:

- `std::thread`;
- processo externo;
- socket;
- timer do sistema operacional;
- event loop independente;
- arquivo de log independente;
- fila sem limite;
- conexão de banco de dados.

Dispositivos virtuais inativos não devem gerar wakeups periódicos individuais.

### 3.2. Separação entre definição, instância compilada e estado

A arquitetura deve separar explicitamente:

```text
HartDeviceProfile
        ↓ compile
HartDevicePlan
        ↓ instantiate
HartDeviceRuntimeState
```

`HartDeviceProfile` pertence ao domínio de autoria/catálogo.

`HartDevicePlan` pertence ao `SimulationPlan` e contém somente dados normalizados e resolvidos.

`HartDeviceRuntimeState` pertence à sessão e contém somente estado mutável necessário durante a execução.

### 3.3. Sem resolução textual no hot path

Durante processamento normal de frames/comandos:

- não procurar dispositivo por nome;
- não procurar variável por string;
- não procurar comando por string;
- não fazer busca global no catálogo;
- não consultar arquivos;
- não consultar SQLite;
- não consultar a Extension.

Todos os vínculos devem estar resolvidos em compile-time para índices/handles.

### 3.4. Transporte semântico separado do transporte físico

O caminho primário deve ser:

```text
HartCommunicator
        ↓
HartVirtualBus
        ↓
HartEngine
        ↓
HartDeviceRuntime
```

Transportes reais devem ser adaptadores externos:

```text
TCP compatibility adapter ─┐
Serial adapter             ├─> HartTransportEndpoint -> HartEngine
Future physical FSK modem  ┘
```

Nenhum dispositivo virtual deve abrir uma porta real implicitamente.

### 3.5. Thin client

No perfil thin client:

```text
UI / VS Code / cliente
        ↓ ReliableControl
SharedHost / Core remoto
        ↓
SimulationSession
        ↓
HartEngine
```

Toda a lógica de protocolo, execução de comandos, estado de equipamentos, endereçamento, parsing e bindings deve permanecer no Core/SharedHost.

A UI recebe apenas:

- estado necessário à apresentação;
- alterações de configuração;
- resultados de operações;
- telemetria resumida;
- traces HART somente quando explicitamente habilitados.

---

## 4. Escopo funcional

### HART-FR-001 — Registry de perfis

Deve existir um `HartDeviceProfileRegistry`.

O registry deve permitir registrar e remover perfis fora do estado RUN.

Cada perfil deve possuir ao menos:

```text
profileId
profileVersion
displayName
manufacturerId
deviceType
capabilities
defaultParameters
variableDefinitions
commandSet
functionDependencies
```

`profileId + profileVersion` deve identificar de forma estável a definição usada por um projeto.

Registro duplicado deve falhar explicitamente.

### HART-FR-002 — Instâncias independentes do perfil

Um único perfil pode originar múltiplas instâncias.

Cada instância deve possuir no mínimo:

```text
deviceHandle
instanceId
profileHandle
busHandle
pollingAddress
uniqueId
tag
status
parameter/state slots
signal bindings
```

Dados comuns ao perfil não devem ser duplicados desnecessariamente em cada instância.

### HART-FR-003 — Adição de dispositivo

Adicionar uma nova instância HART deve exigir apenas uma operação de autoria/configuração.

Não deve exigir alteração de:

- dispatcher HART;
- widget específico;
- Core central;
- transporte;
- SQL;
- código de outro dispositivo.

Enquanto o suporte de hot-swap de `SimulationPlan` não existir, adição estrutural de dispositivo durante RUN deve:

1. ser rejeitada de maneira explícita; ou
2. ser enfileirada como alteração de autoria a aplicar após STOP.

Não implementar hot-swap ad hoc somente para HART.

### HART-FR-004 — Remoção de dispositivo

A remoção estrutural deve invalidar apenas os domínios de plano necessários.

Após recompilação, nenhum estado, binding, endpoint ou callback pertencente ao dispositivo removido pode permanecer alcançável pelo runtime.

### HART-FR-005 — Registry de comandos

Deve existir um `HartCommandRegistry` sem `switch` monolítico central.

Contrato conceitual:

```cpp
struct HartCommandContext;
struct HartResponseBuilder;

class IHartCommandHandler {
public:
    virtual HartCommandId command() const noexcept = 0;
    virtual HartCommandResult execute(
        const HartCommandContext& context,
        HartResponseBuilder& response) noexcept = 0;
};
```

A implementação concreta pode usar ABI C/function pointers quando necessário.

Adicionar ou remover um comando deve ser uma operação de registro, sem editar o dispatcher central.

### HART-FR-006 — Dispatch compilado

O `HartDevicePlan` deve conter tabela de dispatch já resolvida para o conjunto de comandos suportado pelo perfil.

O caminho normal deve ser O(1) sempre que tecnicamente razoável.

São aceitáveis:

- tabela densa para comandos universais/comuns;
- tabela compacta indexada;
- lookup binário em tabela ordenada para comandos estendidos/vendor-specific.

Não utilizar `unordered_map<string,...>` ou equivalentes no hot path.

### HART-FR-007 — Remoção explícita de comando

Quando houver compatibilidade com um conjunto legado/default, a remoção explícita de um comando deve impedir fallback acidental.

Pode ser utilizado conceito equivalente a tombstone durante a composição/compilação do perfil.

No plano final, o resultado deve ser uma tabela resolvida sem necessidade de interpretar tombstones a cada frame.

### HART-FR-008 — Contexto único de comando

Todos os handlers devem receber um contexto padronizado contendo, quando aplicável:

```text
session
deviceHandle
profileHandle
busHandle
virtualTime
request
runtime state access
parameter slots
signal handles
function registry
bounded response writer
diagnostic sink
```

Handlers não devem acessar diretamente:

- socket;
- serial;
- SQLite;
- Riverpod;
- WebView;
- VS Code;
- filesystem;
- singleton global de sessão.

### HART-FR-009 — Registry de funções reutilizáveis

Deve existir um `HartFunctionRegistry` para parsers e interpretações reutilizáveis.

Exemplos:

```text
float32_be
uint16_be
uint24_be
uint32_be
ascii_fixed
packed_status
engineering_unit
enum_value
bit_enum
device_variable
```

Funções devem:

- possuir identificador estável;
- validar bounds;
- produzir erro tipado;
- ser testáveis sem infraestrutura externa;
- não fazer I/O;
- não alocar memória dinamicamente no caminho comum quando evitável.

### HART-FR-010 — Codec HART compartilhado

Deve existir um único módulo de codec/framing utilizado por:

- barramento virtual;
- adaptadores TCP;
- adaptadores seriais;
- testes;
- ferramentas de diagnóstico.

O codec deve oferecer:

```text
HartFrameView
HartFrameDecoder
HartFrameEncoder
HartPayloadReader
HartPayloadWriter
HartChecksum
HartAddress
```

O decoder deve operar sobre buffers bounded e rejeitar frames inválidos sem crescimento ilimitado de memória.

### HART-FR-011 — Endereçamento

O engine deve suportar endereçamento HART curto e longo conforme o nível semântico implementado.

A resolução deve ser pré-compilada por barramento.

Para polling address curto, preferir estrutura direta de tamanho limitado.

Para long address/unique ID, utilizar estrutura compilada adequada, sem busca global textual.

Conflitos de endereço no mesmo barramento devem ser erro de validação antes de RUN.

### HART-FR-012 — Barramento virtual

Cada sessão pode conter zero ou mais `HartVirtualBus`.

Um barramento deve suportar múltiplos dispositivos e múltiplos comunicadores compatíveis com suas regras de endereçamento.

O barramento virtual:

- usa virtual time;
- não abre recursos do host;
- é determinístico;
- possui filas bounded;
- não depende da velocidade da UI;
- mantém isolamento entre sessões;
- permite fault injection controlada para testes.

### HART-FR-013 — Binding com Signal Engine

Variáveis HART que representam grandezas do processo devem poder ser vinculadas a slots do Signal Engine.

Exemplos:

```text
PV -> signalHandle
SV -> signalHandle
TV -> signalHandle
QV -> signalHandle
AO -> signalHandle
status/quality -> typed slot
```

Bindings devem ser resolvidos pelo `PlanCompiler`.

O runtime não pode resolver nomes de tags/variáveis a cada comando.

### HART-FR-014 — Escrita em parâmetros

Comandos de escrita devem atualizar uma única fonte autoritativa de estado.

Não manter cópias divergentes de um mesmo parâmetro em:

- protocolo;
- UI;
- componente de processo;
- PLC;
- persistence model.

Quando um valor estiver ligado ao Signal Engine, a regra de ownership deve ser explícita no plano.

### HART-FR-015 — Equipamentos declarativos

A forma preferencial de adicionar dispositivos deve ser declarativa.

Um novo equipamento padrão deve poder ser introduzido por:

```text
manifest/profile
+
command composition
+
bindings/defaults
+
fixtures/tests
```

sem criar uma nova DLL quando não houver comportamento nativo especial.

### HART-FR-016 — Extensão nativa opcional

Perfis que precisem de algoritmos proprietários, comandos vendor-specific complexos ou comportamento de dispositivo não expressável declarativamente podem utilizar plugin nativo.

O plugin deve integrar-se ao mecanismo de devices já existente no LasecSimul e respeitar ABI estável.

Handlers nativos devem ser resolvidos quando o plano/sessão é preparado.

Não carregar/descarregar DLL/SO por frame.

Não realizar unload de plugin enquanto alguma sessão utiliza handlers provenientes dele.

### HART-FR-017 — Compatibilidade com HART atual

Os componentes existentes:

```text
protocol.hart.transmitter
protocol.hart.communicator
```

devem continuar funcionando.

O transmitter atual deve evoluir para perfil default compatível sobre o engine.

O communicator deve utilizar o mesmo `HartVirtualBus`/contrato do engine.

Não manter uma implementação antiga paralela depois da migração.

### HART-FR-018 — Catálogo

Perfis HART disponíveis devem integrar o catálogo unificado.

A UI deve descobrir capacidades através de metadados e não por listas hard-coded de modelos.

O cliente deve conseguir apresentar:

```text
fabricante
modelo/perfil
versão
comandos suportados
variáveis
parâmetros editáveis
transportes compatíveis
```

sem conhecer a implementação interna do handler.

### HART-FR-019 — Persistência

O projeto deve persistir apenas informação de autoria necessária para reconstrução:

```text
profileId
profileVersion
instanceId
bus
address
identity overrides
parameter overrides
bindings
transport configuration
```

Estado derivado/compilado pertence ao `SimulationPlan`/`RuntimeState` e não deve ser tratado como autoria.

### HART-FR-020 — Versionamento de perfil

Se um projeto referencia uma versão de perfil que não está disponível, o carregamento deve:

- informar claramente o identificador ausente;
- não substituir silenciosamente por uma versão diferente;
- oferecer migração explícita quando suportada.

### HART-FR-021 — Hot parameter update

Parâmetros declarados runtime-mutable podem ser atualizados durante RUN por comando confiável, desde que:

- não alterem a topologia;
- não alterem tamanho/layout do plano;
- não exijam recompilação;
- sejam aplicados pelo single-writer da sessão ou mecanismo equivalente determinístico.

Mudanças estruturais continuam dependentes da política normal de invalidation/recompile.

### HART-FR-022 — Diagnóstico

O engine deve fornecer counters baratos:

```text
framesRx
framesTx
checksumErrors
decodeErrors
unknownAddress
unsupportedCommand
commandErrors
queueDrops
timeouts
externalTransportErrors
```

Tracing detalhado de frames deve permanecer OFF por padrão.

### HART-FR-023 — Transportes reais

Transportes reais são opcionais e explicitamente habilitados.

Devem obedecer ao `ResourceGovernor`.

Primeira implementação recomendada:

```text
HartTcpCompatibilityAdapter
```

como ponte de compatibilidade com o ecossistema `process_simul`, sem tratá-lo como camada física HART real.

Suporte serial deve ser etapa independente.

Interoperabilidade com modem FSK/PHY real requer especificação e validação próprias.

### HART-FR-024 — Multiplexação de transporte

Um adaptador TCP/serial deve poder atender múltiplos dispositivos/barramentos quando o protocolo/configuração permitir.

É proibida a arquitetura:

```text
1 dispositivo = 1 thread = 1 socket = 1 timer
```

como padrão.

### HART-FR-025 — Lifecycle

O lifecycle externo deve ser centralizado:

```text
configure
prepare
start
stop
dispose
```

Após `stop/dispose`:

- sockets devem estar fechados;
- handles seriais devem estar fechados;
- callbacks externos devem estar desregistrados;
- filas bounded devem ser drenadas/descartadas conforme política;
- nenhum worker dedicado a HART pode permanecer;
- nenhuma referência a `SimulationSession` destruída pode permanecer.

---

## 5. Modelo arquitetural proposto

```text
                           AUTHORING / COLD PATH

 Unified Catalog
      │
      ├── HartDeviceProfile A
      ├── HartDeviceProfile B
      └── HartDeviceProfile Vendor X
                     │
                     ▼
            HartProfileRegistry
                     │
                     ▼
            Validator / Normalizer
                     │
                     ▼
               PlanCompiler
                     │
         ┌───────────┴────────────┐
         ▼                        ▼
  HartProtocolPlan        Signal/Binding Plan
         │                        │
         └───────────┬────────────┘
                     ▼

                           RUNTIME / HOT PATH

              SimulationSession
                     │
                 HartEngine
                     │
       ┌─────────────┼──────────────┐
       ▼             ▼              ▼
  BusRuntime 0  BusRuntime 1 ... BusRuntime N
       │
       ├── DeviceRuntime[0]
       ├── DeviceRuntime[1]
       └── DeviceRuntime[n]
       │
       ▼
 Compiled Command Dispatch
       │
       ▼
 Shared Payload/Function Codec
```

No thin client:

```text
VS Code/Web Client
   │
   ├── projeto/configuração
   ├── comandos de controle
   └── telemetria bounded
   │
   ▼
Core/SharedHost
   │
   └── HartEngine + simulação
```

---

## 6. Estruturas conceituais

### 6.1. HartDeviceProfile

```cpp
struct HartDeviceProfile {
    ProfileId id;
    ProfileVersion version;
    ManufacturerId manufacturer;
    DeviceTypeId deviceType;

    span<const ParameterDefinition> parameters;
    span<const VariableDefinition> variables;
    span<const HartCommandDescriptor> commands;
    span<const HartFunctionId> requiredFunctions;

    HartCapabilities capabilities;
};
```

Objetos equivalentes podem variar na implementação, mas a separação conceitual é normativa.

### 6.2. HartDevicePlan

```cpp
struct HartDevicePlan {
    DeviceHandle device;
    ProfileHandle profile;
    HartBusHandle bus;

    PollingAddress pollingAddress;
    HartUniqueAddress uniqueAddress;

    span<const CommandDispatchEntry> dispatch;
    span<const ParameterSlotHandle> parameters;
    span<const SignalBindingHandle> bindings;

    RuntimeLayout runtimeLayout;
};
```

O plano deve conter handles e offsets já resolvidos.

### 6.3. HartProtocolPlan

```cpp
struct HartProtocolPlan {
    span<const HartBusPlan> buses;
    span<const HartDevicePlan> devices;
    span<const HartProfilePlan> profiles;
    span<const HartExternalEndpointPlan> externalEndpoints;
};
```

Metadados imutáveis comuns devem ser compartilhados entre instâncias.

### 6.4. HartRuntimeState

O estado mutável deve ser compactado em arrays/slots, evitando árvores de objetos com alocação por variável.

Exemplo conceitual:

```text
device status array
device flags array
parameter value arena
dynamic variable arena
diagnostic counters
bounded command queue
bounded transport RX/TX arenas
```

---

## 7. Dispatch de comandos

O fluxo deve ser:

```text
frame recebido
   ↓
decode + bounds + checksum
   ↓
resolve bus
   ↓
resolve short/long address
   ↓
deviceHandle
   ↓
command dispatch entry
   ↓
handler(context, boundedWriter)
   ↓
encode response
```

Não deve existir:

```text
frame
   ↓
buscar nome do equipamento
   ↓
consultar catálogo
   ↓
switch gigantesco por command
   ↓
consultar UI/banco
```

---

## 8. Perfil declarativo de equipamento

A especificação de schema correspondente deve ser criada antes da implementação definitiva.

Preferir integração com os manifests/catalog contracts existentes.

Modelo lógico esperado:

```yaml
kind: hart-device-profile
id: hart.vendor.model
version: 1

identity:
  manufacturerId: 0
  deviceType: 0

variables:
  - id: pv
    type: float32
    unitParameter: pvUnit
    runtimeMutable: true

parameters:
  - id: tag
    type: ascii
    maxLength: 8

commands:
  include:
    - hart.universal.0
    - hart.universal.1
    - hart.universal.3
  exclude: []
  custom: []

bindings:
  - variable: pv
    signalRole: processValue
```

O formato físico final pode ser JSON ou outro formato já aceito pelo catálogo.

Não introduzir um parser YAML adicional apenas para esta feature se o projeto não o utilizar.

---

## 9. Composição de comandos

Perfis devem compor conjuntos de comandos a partir de módulos reutilizáveis:

```text
HART Universal Commands
        +
Common Practice Commands
        +
Device Family Commands
        +
Vendor Commands
        -
Explicitly Removed Commands
```

A composição é resolvida no cold path.

O resultado publicado no `HartDevicePlan` é uma tabela final.

---

## 10. Integração com dispositivos nativos

A DLL/SO deve ser exceção, não requisito para cada modelo HART.

Usar plugin nativo quando existir:

- cálculo proprietário;
- comportamento dinâmico complexo;
- integração especial com modelo físico;
- comandos não representáveis por handlers reutilizáveis;
- necessidade comprovada de desempenho.

Um perfil simples com identidade, parâmetros, variáveis e comandos padrão não deve exigir binário próprio.

---

## 11. Thin client e SharedHost

### 11.1. Regras

No perfil SharedHost/thin client:

- HART virtual não cria threads extras por sessão se não houver trabalho suficiente;
- zero dispositivo HART significa custo de runtime praticamente zero;
- dispositivo ocioso não possui timer individual;
- traces detalhados permanecem desabilitados;
- frames de trace não trafegam continuamente para o cliente;
- telemetria de valores deve ser coalescida;
- atualizações de UI não participam do virtual time;
- transporte real fica desligado por padrão;
- número de endpoints reais é limitado pelo ResourceBudget;
- buffers são bounded;
- command queues são bounded.

### 11.2. Conteúdo enviado ao cliente

Enviar preferencialmente:

```text
deviceHandle
revision/state version
PV/SV/TV/QV solicitados
status
health/counters resumidos
command result quando requisitado
```

Não reenviar a definição completa do perfil a cada frame.

Metadados de perfil podem ser cacheados por:

```text
profileId
profileVersion
contentHash
```

### 11.3. Controle

Operações estruturais:

```text
add/remove device
change profile
change bus topology
change binding topology
```

devem usar ReliableControl e respeitar a política de recompilação do `SimulationPlan`.

Telemetria contínua deve seguir a política LossyTelemetry existente.

---

## 12. Orçamento de recursos

O engine deve integrar-se ao `ResourceGovernor`.

A implementação deve provar que não viola:

```text
maxWorkerThreads
maxParallelTasks
maxExternalProcesses
telemetryBytesPerSecond
telemetryQueueBytes
logBytes
commandQueueCapacity
```

Se necessário, introduzir budgets específicos apenas por ADR/schema apropriado, por exemplo:

```text
maxHartExternalEndpoints
maxHartFramesPerTick
maxHartTraceBytes
```

Não criar budgets novos dentro do código sem atualização da especificação canônica.

---

## 13. Metas de desempenho

As seguintes propriedades são requisitos:

1. nenhum `std::thread` por dispositivo;
2. nenhum socket por dispositivo virtual;
3. nenhum timer do SO por dispositivo virtual;
4. nenhuma resolução de string por frame no caminho steady-state;
5. nenhuma busca global de catálogo por frame;
6. buffers de frame bounded;
7. filas bounded;
8. alocações steady-state evitadas no processamento normal de comandos padrão;
9. metadados comuns compartilhados por perfil;
10. runtime state compacto por instância;
11. tracing detalhado sem footprint relevante quando OFF.

Metas de benchmark iniciais:

```text
Case A: 1 bus / 1 device
Case B: 1 bus / 64 devices
Case C: 16 buses / ~1,000 devices
Case D: múltiplas sessões SharedHost
Case E: stress de comandos + telemetry OFF
Case F: stress de comandos + telemetry bounded ON
```

Registrar ao menos:

```text
CPU time
wall time
allocations
peak RSS
bytes/device
threads
wakeups
queue depth
frames/s
p50 command latency
p95 command latency
p99 command latency
```

Meta orientadora para perfil padrão:

```text
<= 4 KiB de estado mutável incremental por instância
```

excluindo metadados compartilhados, buffers globais da sessão e modelos físicos externos.

Se a meta não for atingida, documentar a causa e o benchmark antes de aceitar regressão.

---

## 14. Segurança e robustez

Todo input proveniente de transportes externos é não confiável.

Obrigatório:

- validar tamanho antes de ler;
- validar checksum;
- limitar frame;
- limitar clientes/endpoints;
- limitar filas;
- limitar diagnostics/traces;
- rejeitar command/address inválidos;
- evitar integer overflow;
- evitar leitura fora do payload;
- evitar crescimento de buffer controlado pelo peer;
- garantir shutdown idempotente;
- não bindar interface pública por default;
- não abrir serial/socket sem configuração explícita.

Para TCP de compatibilidade, loopback deve ser o default quando tecnicamente aplicável.

Exposição de rede deve exigir configuração explícita.

---

## 15. Migração do `process_simul`

### 15.1. Reaproveitar como conceito e fixtures

`lib/domain/hart/hart_command_registry.dart`

Ação:

```text
ADAPTAR
```

Reaproveitar:

- `HartCommandHandler`;
- `HartCommandContext`;
- registry sem switch central;
- registro/remoção independente;
- ideia de tombstone para impedir fallback acidental.

Destino:

```text
Core C++ / HartEngine
```

Não portar dependências Flutter.

### 15.2. Reaproveitar parser/codec

`lib/domain/hart/hart_payload_parser.dart`

Ação:

```text
ADAPTAR + PORTAR TESTES/GOLDENS
```

Reaproveitar:

- parsing tipado;
- validação de bounds;
- interpretações reutilizáveis;
- erros explícitos.

Implementar em C++ com readers/views bounded.

### 15.3. Reaproveitar framing

`lib/infrastructure/hart/hart_frame.dart`

Ação:

```text
ADAPTAR + USAR COMO ORÁCULO DE COMPATIBILIDADE
```

Reaproveitar:

- framing;
- checksum;
- short/long address;
- fixtures existentes;
- casos inválidos.

Não copiar alocações/estruturas Dart diretamente.

O limite atual utilizado pelo projeto de origem deve ser validado contra os requisitos do LasecSimul antes de virar constante canônica.

### 15.4. Reaproveitar comportamento do transmitter

`lib/infrastructure/hart/hart_transmitter.dart`

Ação:

```text
EXTRAIR SEMÂNTICA + TESTES
```

Mapear comportamento existente para:

```text
default HartDeviceProfile
+
standard command handlers
+
runtime state
```

Não manter `HartTransmitter` como subsistema paralelo depois da migração.

### 15.5. TCP server

`lib/infrastructure/hart/hart_comm.dart`

Ação:

```text
NÃO PORTAR COMO ARQUITETURA CENTRAL
```

O servidor atual é útil como:

- referência de compatibilidade;
- protocolo de integração;
- fixture para testes;
- origem para um futuro `HartTcpCompatibilityAdapter`.

No LasecSimul:

- não criar servidor por dispositivo;
- não permitir I/O real implícito;
- multiplexar endpoints;
- usar lifecycle central;
- usar ResourceGovernor.

### 15.6. Serial

`lib/infrastructure/hart/hart_serial_channel.dart`

`lib/infrastructure/hart/hart_serial_comm.dart`

Ação:

```text
POSTERGAR / ADAPTAR COMO EXTERNAL TRANSPORT
```

Não fazer do serial uma dependência do engine semântico.

### 15.7. Type conversion

`lib/infrastructure/hart/hart_type_converter.dart`

Ação:

```text
AUDITAR + INCORPORAR AO CODEC/FUNCTION REGISTRY
```

Remover duplicação entre conversão, parser e handlers.

### 15.8. Equipment repository

Conceito de `EquipmentRepository` e perfis de equipamentos.

Ação:

```text
ADAPTAR
```

No LasecSimul a fonte de autoria deve integrar:

```text
unified catalog
project schema
SimulationPlan
```

Não introduzir SQLite apenas para reproduzir o repositório do Flutter.

### 15.9. Riverpod/UI/SQLite/WebView

Ação:

```text
NÃO PORTAR
```

Essas camadas pertencem à arquitetura do aplicativo de origem.

Somente regras de domínio comprovadamente necessárias devem migrar.

---

## 16. Estratégia de compatibilidade

Antes de substituir a implementação atual, criar uma suíte de caracterização contra o `process_simul`.

Golden vectors devem incluir:

```text
valid short-address request
valid long-address request
checksum valid/invalid
unknown device
unsupported command
explicitly removed command
payload too short
payload too large
read PV
read identity
write supported parameter
write invalid parameter
multiple devices
same address on different buses
address collision on same bus
stop/restart
```

Quando o comportamento de `process_simul` conflitar com a arquitetura/especificação HART do LasecSimul, registrar a diferença.

Compatibilidade não autoriza transportar bug conhecido.

---

## 17. Fases de implementação

### Fase 0 — Baseline e caracterização

Antes de alterar comportamento:

- identificar o código HART atual do LasecSimul;
- documentar fluxos existentes transmitter/communicator;
- executar testes atuais;
- importar/criar golden vectors a partir de `process_simul`;
- registrar baseline de CPU/memória/threads;
- confirmar que FEAT-009 continua passando.

Saída:

```text
baseline documentado + testes de caracterização
```

### Fase 1 — Contratos do domínio

Implementar:

```text
HartDeviceProfile
HartProfileRegistry
HartCommandDescriptor
HartCommandRegistry
HartFunctionRegistry
HartPayloadReader/Writer
HartFrame codec
```

Ainda sem transportes reais.

### Fase 2 — PlanCompiler

Adicionar compilação para:

```text
HartProtocolPlan
HartBusPlan
HartDevicePlan
command dispatch tables
address resolution
signal bindings
runtime layout
```

Falhar a compilação em:

- perfil ausente;
- função ausente;
- handler duplicado;
- address collision;
- binding inválido;
- versão incompatível.

### Fase 3 — HartEngine virtual

Implementar:

```text
HartEngine
HartVirtualBus
device runtime arrays
dispatch
virtual-time timeout
bounded queues
diagnostic counters
```

Migrar o HART existente para o engine.

### Fase 4 — Perfis default

Converter o transmitter existente em perfil default.

Adicionar ao menos um segundo perfil/fixture significativamente diferente para provar extensibilidade.

O segundo perfil deve ser adicionável sem edição no dispatcher central.

### Fase 5 — Catálogo/UI/projeto

Integrar:

- discovery no catálogo;
- criação/remoção de instância;
- propriedades do perfil;
- bus/address;
- bindings;
- persistence;
- erros de perfil/versionamento.

A UI não deve conhecer handlers concretos.

### Fase 6 — TCP compatibility adapter

Somente após o engine virtual estar estabilizado.

Requisitos:

- opt-in;
- bounded;
- shutdown limpo;
- múltiplos dispositivos;
- sem thread por device;
- sem socket implícito;
- ResourceGovernor;
- testes de loopback e malformed input.

### Fase 7 — Thin client / SharedHost hardening

Executar benchmarks multi-sessão.

Verificar:

- thread count;
- RSS;
- wakeups;
- telemetry;
- backpressure;
- session isolation;
- client disconnect/reconnect;
- engine funcionando sem UI conectada.

### Fase 8 — Serial/PHY

Somente com requisito real confirmado.

Separar:

```text
semantic HART
serial byte transport
physical FSK/modem
```

Não declarar conformidade/interoperabilidade física sem testes contra hardware apropriado.

---

## 18. Testes obrigatórios

### Unitários

- registry de perfil;
- registry de comando;
- registry de função;
- composição include/exclude;
- duplicate registration;
- explicit removal;
- payload reader;
- payload writer;
- checksum;
- frame decoder;
- short address;
- long address;
- response bounds;
- invalid payload.

### Plan compiler

- multiple profiles;
- multiple instances same profile;
- conflict same bus/address;
- same address different bus;
- missing profile;
- incompatible version;
- missing function;
- invalid binding;
- duplicate identity;
- runtime layout stable.

### Runtime

- deterministic response;
- pause/resume;
- accelerated virtual time;
- stop/restart;
- multiple devices;
- multiple buses;
- multiple sessions;
- isolation;
- device with no traffic causes no periodic wakeup;
- unsupported command;
- command mutation through single-writer.

### Transport

- virtual mode opens zero host ports;
- TCP opt-in only;
- bounded clients;
- bounded RX;
- malformed frame;
- disconnect during frame;
- reconnect;
- shutdown while clients connected.

### Thin client

- UI disconnect does not stop engine unless requested;
- reconnect restores snapshot without replaying unbounded history;
- telemetry backpressure does not block simulation;
- detailed trace OFF has negligible footprint;
- structural edit follows plan invalidation rules.

### Fuzz/property

Aplicar fuzzing ao decoder/frame parser.

Invariantes mínimos:

```text
never OOB
never unbounded allocation
never infinite loop
never response larger than configured bound
invalid input cannot crash SimulationSession
```

---

## 19. Critérios de aceitação

A feature somente pode ser considerada concluída quando:

1. `protocol.hart.transmitter` e `protocol.hart.communicator` existentes funcionarem sobre o novo engine;
2. um segundo tipo de dispositivo HART for adicionado sem editar dispatcher central;
3. esse segundo tipo puder ser removido sem deixar código especial no dispatcher;
4. um comando custom puder ser registrado por módulo/profile sem editar `HartEngine`;
5. um comando puder ser explicitamente removido sem fallback silencioso;
6. funções de parsing reutilizáveis forem compartilhadas entre comandos;
7. múltiplas instâncias do mesmo perfil compartilharem metadados imutáveis;
8. bindings forem resolvidos para handles antes de RUN;
9. não existir busca por string no hot path HART;
10. virtual HART abrir zero sockets/serial/processos;
11. não existir thread/timer por dispositivo;
12. queues e buffers forem bounded;
13. duas `SimulationSession` com o mesmo polling address não interferirem;
14. endereço duplicado dentro do mesmo barramento for rejeitado;
15. teardown não deixar socket/thread/callback ativo;
16. testes de caracterização do comportamento migrado passarem;
17. fuzz tests do decoder não encontrarem crash/OOB;
18. benchmark SharedHost provar orçamento compatível com thin client;
19. traces HART OFF não criarem fila/buffer/thread dedicada;
20. documentação canônica e schemas correspondentes estiverem atualizados;
21. `node .spec/governance/check-specs.mjs` passar.

---

## 20. Critérios específicos de thin client

Para ser aprovado como adequado ao objetivo thin client:

- a Extension não pode conter o runtime HART;
- o Core deve continuar simulando com cliente desconectado;
- metadata de perfil deve ser cacheável;
- o cliente não deve receber todo frame HART por default;
- mudança visual não pode afetar virtual time;
- o número de dispositivos não pode determinar diretamente o número de threads;
- o número de dispositivos virtuais não pode determinar diretamente o número de sockets;
- memória por instância deve ser mensurada;
- idle cost deve ser mensurado;
- múltiplas sessões devem respeitar o mesmo ResourceGovernor;
- real I/O deve ser explicitamente habilitado e limitado.

---

## 21. Invalidation e autoria

A introdução desta feature deve reutilizar o mecanismo de invalidation existente.

Se os domínios atuais não forem suficientes, adicionar um domínio protocol/HART por alteração canônica correspondente.

Mudanças que exigem recompilação:

```text
add/remove device
change profile/version
change bus
change polling/unique address
change command composition
change structural parameter
change signal binding
enable/disable external endpoint estrutural
```

Mudanças potencialmente runtime-mutable:

```text
PV source value
tag quando explicitamente permitido
selected units
damping/configuração não estrutural
device status
command-writable parameter
```

Cada parâmetro deve declarar sua classe de mutabilidade.

---

## 22. Observabilidade

Counters baratos permanecem sempre disponíveis.

Trace detalhado deve ser opt-in por:

```text
session
bus
device
command
```

Quando ativo:

- usar buffer bounded;
- contar drops;
- nunca bloquear o simulation thread por consumidor lento;
- aplicar rate limit;
- não preservar histórico ilimitado.

---

## 23. Compatibilidade de projeto

Projetos existentes que usam os componentes HART atuais devem continuar carregando.

A migração pode mapear implicitamente:

```text
legacy protocol.hart.transmitter
        ↓
built-in profile: lasecsimul.hart.generic-transmitter@1
```

Esse mapeamento deve ser versionado e testado.

Salvar novamente o projeto não deve destruir propriedades legadas sem migração explícita.

---

## 24. Decisões que exigem validação durante implementação

Os itens abaixo não bloqueiam a criação do engine, mas não devem ser resolvidos por suposição:

### 24.1. Polling address zero

O comportamento esperado do ecossistema PACTware/endereço zero deve ser reproduzido e caracterizado.

Há histórico de comportamento ambíguo no projeto de origem.

Criar fixture antes de consolidar a regra.

### 24.2. Device identity

Confirmar a composição canônica de:

```text
manufacturerId
deviceType
deviceId
expanded device type
revision fields
```

e como será representada no profile schema.

### 24.3. Commands estendidos

Definir se command id interno será sempre 16-bit ou se haverá representação estruturada para comandos expandidos.

Não espalhar encoding especial pelos handlers.

### 24.4. FSK/modem físico

Não faz parte da primeira entrega.

Se necessário futuramente, criar feature/ADR específica.

### 24.5. Native plugin API

Antes de expor API pública adicional aos plugins, verificar se a ABI atual de devices comporta o registro requerido.

Se for necessária extensão ABI, criar ADR e manter versionamento/compatibilidade.

---

## 25. Arquivos/componentes esperados

A nomenclatura final deve respeitar a árvore real do Core, mas a separação recomendada é:

```text
core/
  hart/
    HartEngine.*
    HartProtocolPlan.*
    HartProfileRegistry.*
    HartCommandRegistry.*
    HartFunctionRegistry.*
    HartFrameCodec.*
    HartPayloadCodec.*
    HartVirtualBus.*
    HartDiagnostics.*

  transport/
    HartTransportEndpoint.*
    HartTcpCompatibilityAdapter.*
    HartSerialAdapter.*             # etapa futura

  plan/
    ... integração do HartProtocolPlan ...

devices/
  ... apenas plugins nativos HART que realmente necessitem DLL/SO ...

.spec/
  features/
    hart-device-engine.md
  schemas/
    ... profile/project additions ...
  benchmarks/
    ... SharedHost/HART benchmark contract ...
```

Não criar árvores paralelas se estruturas equivalentes já existirem.

---

## 26. Anti-patterns proibidos

Não aceitar implementação que contenha:

```text
switch gigante de command id no engine central
widget decidindo regra de protocolo
1 thread por HART device
1 timer por HART device
1 socket por device virtual
SQLite no hot path
filesystem no hot path
lookup de tag/string por frame
global singleton compartilhando device state entre sessões
unbounded queue
unbounded frame buffer
trace sempre ligado
porta TCP aberta automaticamente
serial aberto automaticamente
duplicação do HART antigo + HART engine novo em produção
plugin DLL obrigatório para todo perfil simples
hot reload estrutural improvisado durante RUN
```

---

## Aceitação

Os critérios normativos completos desta feature estão definidos nas seções
19, 20 e 27: compatibilidade com FEAT-009, extensibilidade sem editar o
dispatcher, isolamento, handles compilados, transportes virtuais sem recursos
do host, limites de filas/buffers, fuzz sem falhas e o gate de 64 instâncias em
SharedHost.

## 27. Regra de conclusão

A implementação deve demonstrar que a arquitetura funciona com a seguinte operação sem alterações no núcleo:

```text
1. registrar Profile A
2. registrar Profile B
3. criar 32 instâncias de A
4. criar 32 instâncias de B
5. executar comunicação virtual
6. remover B do projeto
7. recompilar
8. executar somente A
9. adicionar Profile C com comando vendor-specific
10. executar C sem editar o dispatcher central
```

Em SharedHost, a execução acima não pode criar threads ou sockets proporcionalmente às 64 instâncias virtuais.

Esse cenário é o gate arquitetural principal desta feature.

---

## Anexo A — Auditoria de primitivas e DSL semântica de comandos (FASE 8-19)

### A.1 Escopo e método

Verificado diretamente contra a fonte pública (não assumido da paráfrase de uma
tarefa anterior):

- `ININDII-UFU/EININDII07_PACTware_ProcessSimul`: `hrt/hrt_transmitter_v6.py`,
  `hrt/hrt_transmitter_v1.py`, `hrt/hrt_type.py`.
- `josuemoraisgh/process_simul`: `lib/domain/hart/hart_command_registry.dart`.

**Não auditado nesta sessão** (limite de orçamento, não esquecimento):
`hrt_transmitter_v2..v5.py`, `hrt_frame.py`, `hrt_enum.py`, `hrt_bitenum.py`,
`hart_payload_parser.dart`, `hart_transmitter.dart`, `hart_comm.dart`,
`hart_type_converter.dart`. A confirmação de que `v6` já é totalmente
declarativo (`COMMANDS` com `req/write/resp/after`) é direta; a alegação de que
`v1` **já** possuía o mesmo formato declarativo veio de um resumo automatizado
da ferramenta de fetch e não foi confirmada por diff byte-a-byte contra `v6` —
tratar a tabela de evolução abaixo como direcional até uma reauditoria com
leitura completa de `v2..v5`.

### A.2 Primitivas confirmadas em `hrt_transmitter_v6.py`

`COMMANDS` é o único ponto de configuração; cada comando é um dict opcional com
estágios `req`/`write`/`resp`/`after`. Tokens confirmados: `"$BODY"`, `"$SEL2"`,
`"$BODY[a:b]"` (slice compilado, offset inclusivo/fim exclusivo), `"$code"`
(dentro de `FOR_CODES`), literais HEX (`"FE"`, `"7FC00000"`), e chaves de
linha/variável (`"manufacturer_id"`, `"PROCESS_VARIABLE"`, ...). Estruturas
dict: `SET{row,value}`, `IF{EQ:[A,B],THEN,ELSE}`, `MAP{KEY,TABLE,DEFAULT}`,
`FOR_CODES{SRC,PREFIX,DO}`. Macros confirmadas: `IDENTITY_BLOCK` (10 campos),
`PV_UNIT_AND_VALUE`. `compile_commands()` pré-compila slices e valida hex antes
da execução; o motor de avaliação (`_eval_token()`) é genérico, sem
if/elif por comando.

### A.3 `hrt_type.py` — inventário de codecs confirmado

| Tipo | Função | Largura | Endian | Observação |
|---|---|---|---|---|
| UNSIGNED | `_hrt_type_hex2_uint`/`_uint2_hex` | 1-4 bytes | BE | zero-pad à esquerda |
| INTEGER | `_hrt_type_hex2_int`/`_int2_hex` | 2 bytes | BE | complemento de dois |
| SREAL/FLOAT | `_hrt_type_hex2_sreal`/`_sreal2_hex` | 4 bytes | BE | IEEE-754, `struct`-packed |
| PACKED ASCII | `_hrt_type_hex2_pascii`/`_pascii2_hex` | variável (6 bits/char) | BE bit-packed | maiúsculas, ASCII 0x20-0x5F, trunca/pad |
| DATE | `_hrt_type_hex2_date`/`_date2_hex` | 3 bytes | BE | DD/MM/YYYY, ano offset +1900 |
| TIME | `_hrt_type_hex2_time`/`_time2_hex` | 4 bytes | BE | precisão de milissegundo |
| ENUM/BIT_ENUM/BOOL | roteados por `hrt_type_hex_to`/`hrt_type_hex_from` | — | — | tabelas em `hrt_enum.py`/`hrt_bitenum.py`, **não auditadas nesta sessão** |

O algoritmo de packed-ASCII confirmado (máscara de 6 bits sobre o intervalo
0x20-0x5F, com dobra do bit 6) é o algoritmo padrão HART documentado, não uma
particularidade do PACTware — `HartTypeCodec` (ver A.5) o implementa de forma
independente e caracterizada por round-trip, não copiado às cegas (regra da
seção 17).

### A.4 `process_simul` `HartCommandRegistry` — mapeamento confirmado

| `process_simul` (Dart) | LasecSimul (C++) | Estado |
|---|---|---|
| `HartCommandHandler` | `IHartCommandHandler` | já existia, preservado |
| `HartCommandContext` | `HartCommandContext` + `HartExecutionVariables` (novo) | preservado + estendido |
| registro sem switch central | `HartCommandRegistry`/`setCommandProgramHook` | preservado + estendido |
| tombstone (`_removedCommands`) impedindo fallback para `_onUnknown` | **ainda não implementado** para o caminho DSL | gap identificado, não fechado nesta sessão (FASE 21/71) |
| `HartFunctionRegistry` (parsers nomeados reutilizáveis) | **ainda não construído como registry separado**; `HartVarId` cobre a mesma necessidade sem lookup por string | decisão consciente: o gate "zero string no hot path" já está satisfeito sem essa camada extra; construir o registry nomeado fica para quando um comando real precisar de função authoring-time por nome (FASE 78) |
| `HartPayloadCodec`/reader bounded | `HartPayloadReader`/`HartResponseBuilder` (`HartEngine.hpp`, já existiam) | reutilizados, nenhum codec duplicado |

### A.5 DSL semântica canônica — implementada

`core/src/protocols/HartCommandProgram.hpp/.cpp` (authoring IR + compilador +
executor) e `core/src/protocols/HartTypeCodec.hpp/.cpp` (codecs tipados
reutilizáveis: `Float32BE`, `UnsignedBE`, `PackedAscii`). Nós de authoring:
`HartExpr` (`RequestBody`, `BodySlice`, `HexConstant`, `Variable`, `LocalCode`)
e `HartStatement` (`Append`, `Set`, `If`/`EQ`, `Map`, `ForCodes`). `req` foi
deliberadamente **omitido** do executor: o `HartEngine` do LasecSimul é sempre
o dispositivo (responder), nunca o mestre, então não há requisição de saída a
compor; o campo é reservado no comentário do cabeçalho para um eventual papel
de mestre, mas nenhum código o percorre hoje.

Variáveis usam `HartVarId` (enum estável), resolvido para acesso direto a
campo — nenhuma string é comparada por frame. `HartCommandCompiler::compile()`
valida: alcance de `BodySlice` contra um limite declarado de requisição,
chaves duplicadas em `MAP`, bound de iteração de `FOR_CODES` (1-64), destino de
`SET` gravável (`Tag`, `PrimaryVariableUnit`, `PrimaryVariable` apenas) e
estimativa estática de pior caso de resposta. `HartCommandExecutor::execute()`
roda `write -> resp -> after` nessa ordem sobre uma cópia de trabalho de
`HartExecutionVariables`, rejeita qualquer slice fora dos limites do
`request` real (não apenas do bound estático) e nunca escreve bytes parciais
em caso de falha.

`IHartCommandHandler`/`HartCommandRegistry` nativos continuam disponíveis como
último recurso (`HART-FR-016`); a integração usa um hook opcional
(`HartEngine::setCommandProgramHook`) para que `HartEngine.hpp` não precise
depender do módulo DSL — adicionar/remover um comando compilado não exige
editar `HartEngine`.

### A.6 Matriz comando × primitiva (escopo desta sessão)

| Comando | Estágios usados | Primitivas | Handler nativo antes | Handler nativo depois |
|---|---|---|---|---|
| 0x00 Read Unique Identifier | resp | `IDENTITY_BLOCK` macro (Append×10) | switch central (bugado: retornava ASCII de `uniqueId`) | **nenhum** — DSL |
| 0x01 Read Primary Variable | resp | Append(Variable) ×2 | switch central (bug: faltava byte de unidade, resposta de 4 bytes) | **nenhum** — DSL, 5 bytes, corrigido |
| 0x03 Read Dynamic Variables And Loop Current | resp | Append ×9 (constantes + variáveis) | switch central (placeholder incorreto de 4 bytes fixos) | **nenhum** — DSL, 24 bytes, SV/TV/QV/loop = "not used"/NaN documentado |
| 0x0B Read Unique ID Associated With Tag | resp | `If`/`EQ` + `IDENTITY_BLOCK` macro ×2 | **nunca existiu** | **nenhum** — primeira implementação, via DSL |
| 0x21 Read Device Variables | resp | `ForCodes` + `If`/`EQ` | **nunca existiu** | **nenhum** — primeira implementação, via DSL |
| demais 55 comandos do catálogo de 60 IDs | — | — | não implementados (apenas descritor id+nome) | não implementados — inalterado, não superestimar |

0x0B e 0x21 não são "migrações de handler especial" no sentido literal — nunca
houve handler nativo para eles em LasecSimul; são a primeira implementação, e
comprovam que a DSL cobre exatamente os dois casos que a tarefa aponta como
prova arquitetural obrigatória (FASE 19/72/73), sem exigir opcode ad-hoc.

### A.7 Gaps conhecidos, não resolvidos nesta sessão

- `HartFunctionRegistry` nomeado, tombstones no caminho DSL, codecs
  `ENUM`/`BIT_ENUM`, `MAP` como estrutura compacta além de varredura linear
  (aceitável para tabelas pequenas atuais, não validado em escala).
- `installCommandPrograms()` hoje repete `encodePackedAscii`/parse de hex de
  `uniqueId` a cada `execute()` (alocação pequena e limitada, não ilimitada,
  mas não é o "zero alocação" ideal do hot path) — otimização pendente: mover
  o snapshot de `HartExecutionVariables` para `RuntimeDevice`, calculado uma
  vez em `loadPlan()`, com apenas PV/unit atualizados por chamada.
  Ver [[project_hart_device_engine_v2]].
- Restam 55 dos 60 comandos catalogados sem corpo implementado, benchmarks em
  escala, fuzzing do compilador/executor, e remoção de legado — FASE 20-30
  permanecem abertas. `HartCommunicationComponent` foi migrado para o hook
  nesta sessão (ver Anexo B); Property Inspector semântico também — Anexo B.

---

## Anexo B — Property Inspector do HART: auditoria e implementação (2026-09-11)

### B.1 Reconciliação do estado herdado

`PropertyInspectorViewProvider.ts` (commit `c8593239`) já usava a infraestrutura
oficial do VS Code (`vscode.WebviewViewProvider` + `registerWebviewViewProvider`
com `"type": "webview"` em `package.json`, seção `views`) e já reencaminhava
mutações pelo caminho normal `requestUpdateProperty` (undo/redo/persistência
compartilhados, não duplicados) — isso foi preservado integralmente.

O que a auditoria encontrou **não** implementado, apesar de o arquivo existir:

- `renderHartCollections` tratava `hartVariablesJson`/`hartCommandsJson` como
  duas tabelas de linhas soltas (`id`/`name`/`unit`/`source`), sem `role`,
  `type`, `direction`, `readable`/`runtimeMutable` — e usava um campo
  `source`/`function` livre equivalente ao antigo modo `Expression` que a
  arquitetura já havia retirado (seção 48).
- **`hartCommandsJson` nunca era lido pelo Core.** `HartCommunicationComponent
  ::setPropertyValue` só armazenava a string; não existia parser, não existia
  compilação, não existia instalação no `HartEngine`. Um comando "criado" pelo
  Inspector não tinha nenhum efeito no dispositivo rodando — a seção Commands
  inteira era inerte.
- `HartReferenceCatalog::installCommandPrograms()` (os 5 comandos DSL da
  sessão anterior) nunca era chamado por `HartCommunicationComponent` — mesmo
  os comandos 0x00/0x01/0x03/0x0B/0x21 não estavam acessíveis pelo componente
  usado de verdade pelo `protocol.hart.serial`/`protocol.hart.udp`.
- **Bug de persistência real, anterior a esta sessão**: o construtor de
  `HartCommunicationComponent` nunca lia `hartVariablesJson`/`hartCommandsJson`
  de `ComponentParams` — um projeto salvo com variáveis/comandos configurados
  voltava para `"[]"` a cada reabertura (violava a seção 38/Gate 12).
- **Bug real, também anterior**: `device.tag` nunca era preenchido a partir de
  `m_tag` (nem no construtor, nem em `rebuildConfiguredPlan`) — o comando
  0x0B sempre comparava contra `plan.id`, nunca contra a Tag configurada pelo
  usuário.
- Painel sem agrupamento de seções (tudo em uma única lista sob "Properties",
  apesar de `PropertySchema.group` já existir e não ser usado), sem suporte a
  `editor:"select"`/`"display"` (só text/number/checkbox), sem diagnóstico do
  compilador visível, sem guarda estrutural durante RUN.

### B.2 O que foi implementado nesta sessão

**Core** (`core/src/protocols/`):

- `HartEngine.hpp`: `HartVariableRole`, `HartVariableType`, `HartVariableDirection`
  e os campos correspondentes em `HartDevicePlan::VariableConfiguration`
  (`role`, `type`, `direction`, `readable`, `runtimeMutable`), aditivos
  (posição final da struct, nenhum call site existente quebrado).
- `HartCommandJson.hpp/.cpp` (novo): ponte JSON <-> DSL semântica para o
  subconjunto plano de authoring (`Hex Constant`/`Variable`/`Request Body`/
  `Body Slice` como passos de `resp`), com rejeição explícita de: JSON
  malformado, variável desconhecida, hex inválido, id de comando duplicado, e
  id de comando reservado (0x00/0x01/0x03/0x0B/0x21 — nunca pode ser
  sombreado por um comando custom).
- `HartReferenceCatalog::installCommandPrograms(engine, additional)` (nova
  sobrecarga): compila os 5 comandos built-in + os comandos custom
  fornecidos num único hook combinado; se QUALQUER comando custom falhar ao
  compilar, a instalação cai para **somente os built-ins** (nunca deixa um
  edit quebrado derrubar 0x00/0x01/0x03/0x0B/0x21) e devolve a mensagem de
  erro exata.
- `HartCommunicationComponent`: agora lê `hartVariablesJson`/`hartCommandsJson`
  do `ComponentParams` no construtor (corrige o bug de persistência),
  preenche `device.tag` (corrige o bug da Tag), parseia/valida/compila os
  comandos custom via `HartCommandJson`+`HartCommandCompiler`, expõe duas
  propriedades read-only novas (`hartVariablesStatus`, `hartCommandsStatus`)
  com a mensagem de erro exata do compilador, e rejeita write-ownership
  (`direction=Input && writable` é rejeitado com diagnóstico, nunca
  silenciosamente aceito com o campo zerado).
- `HartPlanCompiler::compile()`/`HartEngine::execute()`: um id de comando
  custom agora pode ser declarado por dispositivo (`commandConfigurations`)
  sem precisar estar no `HartDeviceProfile` compartilhado — a validação
  original ("override não declarado pelo perfil") permanece para
  disable/static-response de comandos que o perfil *conhece*; só a
  declaração aditiva pura (enabled, sem override) de um id novo passou a ser
  aceita. Sem essa mudança, nenhum comando autorado pela UI conseguia
  despachar (ver B.4).
- `HartCommunicationComponent::propertySchema()`: os 4 campos JSON/status
  passaram a ter `PropertySchemaHidden` — não aparecem mais na property sheet
  genérica do canvas (que os mostraria como texto JSON cru, um segundo editor
  competindo com o painel estruturado), mas continuam totalmente
  legíveis/graváveis via IPC e via o próprio Inspector.

**Extension** (`extension/src/ui/`):

- `batchProperties.ts`: `propertyFieldKindFromEditor` movido de `main.ts`
  (só existia lá) para cá — agora é a MESMA função usada pela property sheet
  do canvas e pelo painel lateral (seção 46: um único dispatch de
  `editor` -> widget, não dois mantidos à mão separadamente). `main.ts`
  passou a importar em vez de duplicar.
- `hartInspectorSections.ts` (novo, sem dependência de `vscode`, testável em
  Node): modelo de linhas (`HartVariableRow`, `HartCommandRow`,
  `HartCommandStepRow`), parse/serialize simétricos ao JSON que o Core
  espera, e os renderers HTML dos editores de Variables/Commands — incluindo
  o script client-side (reconstrói as linhas a partir do DOM atual a cada
  commit, sem manter uma segunda cópia autoritativa).
- `PropertyInspectorViewProvider.ts`: reescrito para agrupar campos por
  `schema.group` (título por seção, em vez de lista única), suportar
  `editor:"select"` (dropdown com `schema.options`) e `"display"`
  (read-only), esconder os 4 campos HART "crus" do fluxo genérico, e montar
  as seções Variables/Commands/Diagnostics via `hartInspectorSections.ts`.
  Ganhou `setSimulationStatus()`, chamado por `coreLifecycle.ts::setSimulationStatus`
  (mesmo padrão de `lasecPlotManager`/`serialTerminalManager`) — controles
  estruturais (Add/Remove, `id`, `direction`, `type`) desabilitam durante
  RUN/PAUSE; campos com `runtimeMutable=true` continuam editáveis.

### B.3 Editor de Variables — modelo real exposto

`id` (variableId estável, somente-leitura após criado) · `name`
(displayName) · `role` (select: PV/SV/TV/QV/Internal/DeviceSpecific/
VendorSpecific/Custom) · `type` (select: Float32/UInt8/UInt16/Int16/
PackedAscii/Bool — só os tipos que `HartTypeCodec` de fato implementa) ·
`direction` (select: Internal/Input/Output) · `unit` · `value` · `readable`/
`writable`/`runtimeMutable` (checkboxes). `writable` desabilita
automaticamente quando `direction=Input`, com explicação inline. Um
`expression` legado (authoring computado via SignalExpression, pré-existente)
sobrevive ao round-trip sem ganhar um campo dedicado no editor novo — não é
mais um "modo de origem" de primeira classe, mas dado existente nunca é
descartado silenciosamente.

**Gap real, documentado, não fechado**: `direction=Input`/`Output` é
armazenado e validado (write-ownership), mas **não materializa uma porta no
Signal Graph** — isso exigiria estender o mecanismo `ComponentPinSpec`/
`DynamicPinGroupSpec` (`lasecsimul/Types.hpp`) para portas dirigidas por uma
coleção JSON (hoje ele só deriva contagem de pinos de UMA propriedade
numérica), preservação de fios ao trocar direction, e mudanças no
`PlanCompiler`. Isso é um recurso estrutural grande e separado — o Gate 3 do
contrato original (mudar direction e ver a porta aparecer/fio conectável)
**não está pronto**; a validação write-ownership (Gate 9) está.

### B.4 Editor de Commands — modelo real exposto

Cada comando: `id` (reservado 0x00/0x01/0x03/0x0B/0x21, somente-leitura após
criado) · `name` · `enabled` · lista ordenável de passos de `Response`:
`Hex Constant` (bytes), `Variable` (select sobre o conjunto fixo de
`HartVarId`), `Request Body`, `Body Slice` (offset/length) — reordenar via
&uarr;/&darr;, adicionar/remover por passo. Um indicador "Compiler: ✓ Valid /
✗ &lt;mensagem exata&gt;" fica sempre visível, alimentado por
`hartCommandsStatus` (Core).

**Gap real, documentado, não fechado**: `write`/`after` e os primitivos de
controle de fluxo (`If`/`Map`/`ForCodes`) não têm editor na UI ainda — só
`resp` com os 4 passos planos acima. Isso cobre o padrão real da maioria dos
comandos "leitura simples" (inclusive prova os Gates 6/7/8/10 abaixo), mas
não FOR_CODES/IF/MAP pela UI. Referenciar uma variável HART *customizada*
(criada pelo usuário) de dentro de um comando também não é suportado ainda —
só o conjunto fixo de `HartVarId` (PV via a convenção pré-existente
`id="PV"`/`"primary"` continua funcionando, ver B.5 Gate 2). Ambos exigiriam
estender `HartCommandJson` com os nós adicionais e, para variáveis
customizadas, um novo `HartExpr::Kind::UserVariable` resolvido por handle no
executor — desenho já esboçado, não implementado (ver [[project_hart_device_engine_v2]]).

### B.5 Gates — resultado real (não assumido)

Gates comprovados por teste automatizado (Core `hart_engine_test` +
Extension `hartInspectorSections.test.ts`, ambos verdes, e compilação limpa
de host+webview):

- **Gate 2 (criar variável, ler via comando)**: uma variável `id="PV"` com
  `value`/`expression` chega ao comando 0x01 padrão exatamente como salva —
  caracterizado ponta a ponta em `HartEngineTest.cpp` (constrói
  `HartCommunicationComponent` com `hartVariablesJson` real, executa 0x01,
  confere o float exato).
- **Gate 6/7 (criar comando novo via primitivas semânticas, sem editar
  `HartEngine`/dispatcher)**: comando custom com passos `Variable`+`Hex`+
  `BodySlice` compila e despacha ponta a ponta sem tocar `HartEngine.cpp`
  nem `PropertyInspectorViewProvider.ts` para esse comando específico —
  caracterizado em `HartEngineTest.cpp` ("custom command 128... executes end
  to end through the JSON bridge") e replicável pela UI (mesmo parser/
  compilador).
- **Gate 8 (diagnóstico do compilador)**: um `BodySlice` além do limite
  reporta erro (`installCommandPrograms` retorna `.error` não vazio) e os
  built-ins continuam respondendo — caracterizado em
  `HartEngineTest.cpp` ("a broken custom command reports a diagnostic" /
  "built-ins survive a broken custom command install").
- **Gate 12 (save/reopen)**: uma SEGUNDA instância de `HartCommunicationComponent`
  construída com os MESMOS `ComponentParams` (simulando reabrir o projeto)
  produz a mesma resposta 0x01 — prova direta do bug de persistência
  corrigido.
- **Gate 9 parcial (write-ownership)**: validado para os alvos `SET`
  atualmente graváveis (`Tag`/`PrimaryVariableUnit`/`PrimaryVariable` no
  `HartCommandCompiler`, e `direction=Input && writable` rejeitado em
  `HartCommunicationComponent::rebuildConfiguredPlan`); não validado ainda
  para `SET` de uma variável customizada, porque isso não existe na DSL
  ainda (ver B.4).

Gates **não executados** (exigem VS Code Extension Development Host
interativo, que este agente não tem como abrir/clicar) — sem evidência,
portanto não reivindicados como prontos:

- Gate 1 (inspecionar visualmente as 6 seções no canvas real).
- Gate 3 (porta Input/Output aparecendo/conectável no canvas) — também
  bloqueado pela lacuna estrutural da B.3.
- Gate 5 (mensagem de rejeição estrutural durante RUN visível na tela real —
  a lógica de desabilitar os controles está implementada e testada
  isoladamente, mas o clique real não foi reproduzido).
- Gate 11 (Undo/Redo manual) — a mutação usa o MESMO pipeline
  `requestUpdateProperty` de qualquer outra propriedade (então undo/redo
  deveria "vir de graça"), mas isso não foi confirmado clicando.
- Gate 13 (encapsulamento `.lssubcircuit`) — não auditado nesta sessão.
- Gate 14 (temas/resize) — CSS usa variáveis de tema do VS Code
  (`--vscode-*`) e `flex-wrap`/`overflow-wrap` para não quebrar em painel
  estreito, mas não foi visualmente confirmado.

### B.6 Checklist do contrato original (seção 90) — estado real

Feito e comprovado: painel persistente via infraestrutura oficial · sem modal
HART canônico competindo · fluxo de seleção canônico (`setSelection`
alimentado por `state.schematicState`, não DOM scraping) · seções agrupadas ·
`variableId` estável (não-editável após criado) · Internal/Input/Output
armazenado e validado · edição estrutural bloqueada durante RUN · campos
`runtimeMutable` seguem a regra do Core · comandos editáveis
semanticamente (subconjunto plano) · `Body`/`BodySlice`/`Variable`/`Hex`
representados · diagnóstico do compilador exposto · nenhum bytecode exposto
· commit-on-change (não por tecla) · sem polling do projeto inteiro ·
Inspector nunca é fonte de verdade · testes Core e Extension passam.

Parcial ou pendente: `req`/`write`/`after` e `If`/`Map`/`ForCodes` sem editor
· referência a variável customizada dentro de comando · porta Signal Graph
para Input/Output · encapsulamento `.lssubcircuit` não auditado · Undo/Redo,
temas, resize e os demais gates que exigem Extension Development Host
interativo não confirmados manualmente · consolidação do editor canônico é
parcial (dispatch de `kind` unificado; os dois renderers HTML continuam
fisicamente separados, um DOM client-side e um HTML string server-side —
unificação completa exigiria mover a sidebar para o mesmo modelo de
webview+DOM do canvas, fora do escopo desta sessão).

### B.7 Próxima ação

Continuar as fases HART pendentes (FASE 20-30): migrar mais comandos do
catálogo de 60 usando `HartReferenceCatalog::commandProgramDefinitions()`
como molde; depois, se ainda relevante, fechar os gaps do Inspector acima
(`UserVariable`, `If`/`Map`/`ForCodes` na UI, porta Signal Graph) antes de
tentar os gates que exigem Extension Development Host interativo. Não
declarar o HART Device Engine concluído enquanto os 55 comandos restantes,
benchmarks, fuzzing e remoção de legado continuarem pendentes.
### Correção arquitetural v2 — ownership de valor e portas de sinal

O modelo público de `HartVariable` possui somente identidade (`variableId`,
`name`), metadata (`role`, `type`, `unit`) e ownership do valor:
`Internal | Input | Output`. `Internal` persiste `value`; `Input` recebe o
valor do Signal Graph; `Output` publica o valor no Signal Graph. Expressões,
funções de transferência, Modbus e controladores são blocos externos ligados
por fios, nunca modos da variável HART.

`Input` e `Output` materializam `SignalPortDescriptor` genérico, com id estável
derivado de `variableId`; `Internal` não materializa porta. Os campos legados
`readable`, `writable`, `runtimeMutable` e `required` não fazem parte da UX
normal nem da representação canônica. O parser aceita dados antigos apenas
para migração; acesso e requisitos devem vir do profile/schema e das
semânticas dos comandos.

Comandos podem referenciar variáveis de usuário pelo mesmo `variableId` salvo
no Inspector. O nome exibido é apenas um rótulo de seleção e renomeá-lo não
altera bindings.

Esta seção supersede as descrições históricas B.3/B.5/B.6 que classificavam as
portas de sinal e referências de usuário como gaps: o plano efetivo agora
materializa e executa essas portas no Core.

Na compilação do plano, cada porta HART é materializada no Signal Graph com o
id `hart.<componentIndex>.<variableId>`. Portas `Input` são blocos `Probe` e
portas `Output` são blocos `ExternalInput`; o índice de componente é apenas o
namespace da instância e o identificador da variável permanece estável mesmo
quando o nome exibido muda.

---

## Anexo C — Auditoria completa e bidirecional do Property Inspector (2026-09-11, sessão 3)

### C.1 Reconciliação

Esta sessão começou com trabalho concorrente NÃO commitado em progresso:
suporte multi-perfil HART (`HartReferenceCatalog::registerProfiles`/
`makeProfile`, `profileId` por instância), portas Signal Graph reais para
Input/Output (`HartCommunicationComponent::signalPorts()`,
`SignalPortDescriptor`, `HartEngine::setVariableInput`/`variableValue`,
mudanças em `core/include/lasecsimul/IComponentModel.hpp`/`Signal.hpp` e
`core/src/session/SimulationSession.*`), remoção de `readable`/`writable`/
`expression` do modelo canônico de variável, `HartExpr::Kind::UserVariable`
(comandos referenciando variáveis criadas pelo usuário), e um novo módulo
`extension/src/dsl/` (DSL textual de circuito inteiro, comando "Aplicar DSL
ao Esquemático"). Nada disso foi revertido; nenhum arquivo fora do escopo
HART/Property-Inspector foi tocado (TDPS/Ctrl continuam intocados, conforme
`extension/src/catalog/packageSanitizers.ts` permanece modificado e não
staged por este agente).

### C.2 Bugs reais encontrados e corrigidos (não apenas "compila")

1. **Colisão silenciosa entre comando custom e fallback auto-gerado.**
   `commandProgramDefinitions()` passou a gerar um programa "echo body" para
   todo id catalogado sem handler dedicado (55 dos 60). `installCommandPrograms
   (engine, additional)` copiava os built-ins e usava
   `std::unordered_map::emplace` para inserir os comandos custom —
   `emplace` nunca sobrescreve uma chave existente. Resultado: um comando
   custom autorado para qualquer um desses 55 ids compilava com sucesso
   (`installed.success == true`, nenhum erro reportado) e NUNCA era
   despachado — o fallback "echo body" continuava respondendo, silenciosamente.
   Encontrado porque o teste original desta feature usava id 128 (== 0x80,
   "Vendor Read Configuration") como "id custom arbitrário" sem perceber a
   colisão. Corrigido: `(*combined)[id] = std::move(compiled.program)`
   (sobrescreve). Regressão coberta em `HartEngineTest.cpp` com comentário
   explícito apontando a causa raiz, para que uma futura reintrodução de
   `emplace` falhe o teste, não apenas "funcione por acaso".
2. **`HartCommandJson::toJson` descartava silenciosamente um passo
   `UserVariable`.** O `switch` sobre `HartExpr::Kind` não tinha `case
   UserVariable` (adicionado depois do `switch` original); o efeito era
   remover esse passo da serialização sem marcar `"unsupported": true` —
   exatamente a classe "parece ok, perde dado" que esta auditoria existe pra
   achar. Corrigido; teste de round-trip adicionado.
3. **`dslDocument` (módulo `extension/src/dsl/dslCommands.ts`) nunca era
   limpo.** `isDslDocumentOpen()` ficava `true` para sempre depois do
   primeiro uso de "Editar circuito em DSL", mesmo após aplicar ou fechar a
   aba — afetando `commitOpenDslIfPresent()` (gate de Save/Run) para sempre
   depois disso, e tornando inutilizável qualquer sinal "draft está aberto"
   que uma UI (como o Property Inspector) precisasse consultar. Corrigido com
   um listener em `vscode.workspace.onDidCloseTextDocument`.

Nenhum destes 3 bugs foi introduzido por esta sessão — os dois primeiros são
efeito colateral de trabalho concorrente ainda sem testes de regressão
próprios; o terceiro é um bug de nascença do módulo DSL novo. Todos foram
corrigidos, não apenas relatados, conforme a instrução de autonomia da tarefa.

### C.3 Conflito DSL vs. Property Inspector (seções 108-110 do enunciado)

Investigado end-to-end lendo `dslCommands.ts`/`DslReconciler.ts`: o DSL
textual é "propose-and-apply" — abrir o editor (`openDslCommand`) cria um
`vscode.TextDocument` independente com um snapshot serializado; nada em
`state.schematicState` muda até `commitDslCommand` (que substitui o
Authoring Model inteiro a partir do texto). Achado real: como o Property
Inspector edita `state.schematicState` diretamente e imediatamente
(pipeline `requestUpdateProperty` normal), uma edição feita no Inspector
**enquanto** um draft DSL não aplicado está aberto seria silenciosamente
sobrescrita na próxima vez que esse draft for aplicado (o draft não sabe que
o Inspector mudou algo nesse meio-tempo). Isso corresponde exatamente ao
cenário do enunciado (seção 109).

Resolvido seguindo a preferência arquitetural explícita do enunciado ("DSL
draft = editing authority"): `PropertyInspectorViewProvider.setDslDraftOpen()`
(novo), acionado via `onDslDraftOpenChanged` (novo, em `dslCommands.ts`) nos
dois pontos em que o estado do draft muda (abrir/fechar). Enquanto um draft
está aberto, o painel inteiro renderiza somente leitura com um banner
explicando por quê, e o handler de mensagens do lado do host rejeita
qualquer `setProperty` que ainda chegue (defesa em profundidade contra uma
Webview que não tenha re-renderizado a tempo). Não foi implementado um
mecanismo formal de "mutation → DSL patch" (a alternativa que o enunciado
também permite) — read-only é suficiente e mais simples, e é a opção que o
próprio enunciado chama de preferência original.

Limitação conhecida, documentada: o banner cobre "draft aberto" (uma aba com
`languageId === "lasecsimul-dsl"` existe), não "draft sujo desde o último
apply" — depois de aplicar, o painel continua bloqueado até a aba ser
fechada, mesmo que o texto agora reflita exatamente o Authoring Model atual.
Mais conservador que o estritamente necessário, mas seguro (nunca permite a
divergência silenciosa que a seção 109 descreve) e simples de raciocinar.

### C.4 Arquitetura confirmada por leitura direta de código (não suposição)

- **Fonte canônica de propriedades**: `PropertySchema` (Core,
  `lasecsimul/Types.hpp`) → `PropertySchemaEntry` (Extension,
  `ui/webview/model.ts`) é a ÚNICA fonte usada tanto pela property sheet do
  canvas (`main.ts::renderPropertyField`/`resolvePropertyFields`) quanto pelo
  painel lateral (`PropertyInspectorViewProvider::renderField`). Confirmado:
  nenhum dos dois mantém uma segunda lista de campos por `typeId` — ambos
  iteram `descriptor.propertySchema` genericamente.
- **Dispatch de `kind`**: unificado nesta linha de trabalho
  (`propertyFieldKindFromEditor` movido de `main.ts` pra
  `batchProperties.ts`, importado por ambos). Os DOIS renderers continuam
  fisicamente separados (um manipula DOM client-side, o outro gera uma
  string HTML server-side) — unificar isso de verdade exigiria portar a
  sidebar pro mesmo modelo de webview+script do canvas, o que é uma
  refatoração maior, fora do escopo seguro desta sessão (ver C.6).
- **Seleção canônica**: `state.selectedComponentIds`/`state.schematicState`
  é a única fonte; `propertyInspectorView.setSelection()` é alimentado pelos
  mesmos pontos que já existiam (`requestUpdateProperty` handler,
  `selectComponent` handler) — sem DOM scraping, sem polling.
- **Mutação canônica**: TODA edição de propriedade (canvas ou sidebar) passa
  por `requestUpdateProperty` → `pushPropertyToCore` → undo/redo/persistência
  compartilhados. O painel lateral nunca tem um caminho de mutação próprio.
- **Zero switch por `typeId`** no renderer genérico — a única ramificação por
  tipo é `isHart` para as duas coleções semânticas (Variables/Commands), que
  o próprio enunciado (seção 135) aceita como exceção legítima ("specialized
  editor... for genuinely complex semantic collections").
- Isto confirma estruturalmente a propriedade da seção 134 ("adicionar um
  componente novo com PropertyDescriptors padrão não deveria exigir nova tela
  no Inspector") para QUALQUER `typeId` cujo schema seja padrão — Ctrl,
  elétrico, PLC/Modbus, `.lsdevice` incluídos — sem precisar re-verificar tipo
  por tipo manualmente, porque a prova é estrutural (ausência de
  `if (typeId === ...)`), não uma amostragem.

### C.5 Testes adicionados (reais, executados, verdes)

Core (`hart_engine_test`, MSVC Release — `HART engine contracts: PASS`):
correção de `registerProfiles` vs. `registerGenericProfile` no teste de
referência; bytes golden de identidade atualizados para os valores reais do
perfil atual; regressão explícita para o bug de colisão de comando (C.2.1);
round-trip de `toJson` para `UserVariable` (C.2.2); gate de cobertura de
editor kind rodando sobre `HartCommunicationComponent::propertySchema()`
para os modos Serial e UDP (seção 117/120/134, ver C.5 nota de escopo).

Extension (`npm test`, host+webview TypeScript limpos, **449 verificações,
0 falhas** em toda a suíte existente — nenhuma regressão introduzida):
`hartInspectorSections.test.ts` (11 casos, já existentes, revalidados contra
o modelo Core atualizado) + novo teste de cobertura em `UnifiedCatalog.test.ts`
que itera o catálogo REAL carregado por `loadUnifiedCatalog` (sem Core) e
falha se qualquer `propertySchema` estático usar um `editor` que
`propertyFieldKindFromEditor` não reconheceria.

**Nota de escopo honesta sobre os gates de cobertura**: o catálogo estático
(`loadUnifiedCatalog`, sem processo Core) só carrega `propertySchema` pra 6
das 68 entradas atuais (manifests de device/subcircuito autorados
estaticamente) — os demais tipos (elétrico, HART, PLC/Modbus) declaram seu
schema em C++ e só chegam ao catálogo em runtime via
`attachPropertySchemas()`, que faz IPC contra um Core vivo. Não existe nesta
sessão um harness de teste que suba o Core e faça esse round-trip em Node,
então a cobertura automática de editor-kind para esses tipos fica limitada a:
(a) o gate C-side já citado, específico de `HartCommunicationComponent`; (b)
a prova estrutural de C.4 (nenhum dispatch por `typeId`, então o MESMO
`renderField` genérico atende qualquer schema, HART ou não). Construir um
harness de integração Core-IPC-em-Node é um esforço genuinamente separado e
maior (levantar processo, handshake, ciclo de vida) — não implementado aqui;
registrado como próxima ação concreta, não como "future work" vago.

### C.6 Matriz final (contrato original, seção 143)

| Area                    | PASS | PARTIAL | BROKEN | MISSING | BLOCKED_EXTERNAL |
|-------------------------|-----:|--------:|-------:|--------:|------------------:|
| Generic properties      | ✓ (arquitetura, testes automatizados) | seleção/undo/tema não confirmados clicando | — | — | Gates 1/5/11/14 (GUI) |
| Ctrl                    | — | — | — | não auditado propriedade-a-propriedade nesta sessão | requer varredura manual ou harness Core-IPC |
| HART device (General/Identity/Addressing) | ✓ | — | — | — | — |
| HART variables          | ✓ (id estável, role/type/direction, ownership, UserVariable em comandos) | portas materializam mas não confirmadas clicando no canvas | — | — | Gate 3 visual |
| HART commands           | ✓ (resp plano: Hex/Variable/Body/BodySlice, diagnóstico, override corrigido) | `write`/`after`/If/Map/ForCodes sem editor | — | não expostos na UI | — |
| .lssubcircuit            | — | encapsulamento (props expostas vs. internals) não auditado nesta sessão | — | — | — |
| Electrical               | — | — | — | não auditado propriedade-a-propriedade | requer varredura manual ou harness Core-IPC |
| PLC/Modbus               | — | — | — | não auditado propriedade-a-propriedade | requer varredura manual ou harness Core-IPC |
| Plugins (.lsdevice)      | — | genérico por arquitetura (C.4), não testado com um plugin real | — | — | — |
| Line/Tunnel              | — | — | — | não auditado nesta sessão | — |
| Save/reopen              | ✓ (HART: teste real reconstruindo o componente com os mesmos ComponentParams) | outros tipos não teste-reabertos nesta sessão | — | — | — |
| RUN policy               | ✓ (HART: guard genérico incluindo agora o draft DSL) | guard genérico fora do HART (propriedades `affectsPinCount`/estruturais de outros tipos) não auditado/testado | — | — | — |
| Undo/Redo                | ✓ (arquitetural: mesmo pipeline de qualquer propriedade) | não confirmado clicando | — | — | Gate 11 |
| DSL integration          | ✓ (conflito identificado e corrigido: read-only durante draft, bug de lifecycle corrigido) | — | — | — | — |

### C.7 Por que os itens não-PASS não foram fechados

- **Ctrl/Electrical/PLC-Modbus/Line-Tunnel, auditoria propriedade-a-propriedade**:
  exigiria ou (a) leitura manual de cada `propertySchema()` em C++ nesses
  domínios comparada campo a campo com o que a UI genérica realmente
  renderiza (dezenas de tipos, centenas de campos — múltiplas sessões de
  trabalho reais, não uma tarefa de minutos), ou (b) um harness de teste que
  suba o Core e faça `attachPropertySchemas()` de verdade em Node. Nenhum dos
  dois foi construído aqui. A prova estrutural de C.4 dá confiança de que a
  ARQUITETURA está correta (mesmo dispatch genérico pra todos), mas não
  substitui verificar que cada campo específico tem o `editor`/`options`
  certos. Próxima ação concreta: escolher entre (a) uma varredura manual
  dirigida por catálogo (visitar cada `*Component.cpp` e listar
  `propertySchema()`) ou (b) construir o harness Core-IPC-em-Node -- (b) é
  mais caro de construir mas paga dividendos permanentes (o mesmo gate de
  cobertura de C.5 passaria a cobrir 68/68 entradas, não 6/68 + o caso HART
  isolado).
- **`.lssubcircuit` encapsulamento, Line/Tunnel**: não teve nenhuma
  investigação começada nesta sessão (tempo). Próxima ação: repetir o
  método de C.4 (ler o código de seleção/renderização pra esses tipos
  específicos) antes de assumir que funcionam.
- **Gates 1/3/5/11/14 (visual/clique real)**: `BLOCKED_EXTERNAL` genuíno —
  este agente não tem VS Code Extension Development Host interativo
  disponível. Toda a lógica que esses gates exercitariam foi testada
  isoladamente (ver C.5) e por leitura de código, nunca reivindicada como
  clicada de verdade.

### C.8 Arquivos tocados nesta sessão (além dos já listados no Anexo B)

Modificados: `core/src/protocols/HartCommandJson.cpp`,
`core/src/protocols/HartReferenceCatalog.cpp`,
`core/test/core/protocols/HartEngineTest.cpp`,
`extension/src/catalog/UnifiedCatalog.test.ts`, `extension/src/extension.ts`,
`extension/src/ui/views/PropertyInspectorViewProvider.ts`,
`extension/src/dsl/dslCommands.ts` (arquivo novo de outro agente, ainda não
commitado; só o bug de lifecycle de C.2.3 foi corrigido, resto preservado
intacto), `.spec/features/hart-device-engine.md` (este Anexo). Nenhum
arquivo de TDPS/Ctrl/QEMU foi tocado ou commitado por este agente.

---

## Anexo D — Lasec DSL para HART Commands, correções reais, e estado master (2026-09-11, sessão 4)

Esta sessão recebeu uma tarefa de escopo deliberadamente enorme: concluir de
ponta a ponta a Lasec DSL unificada (circuitos + comandos HART), Visual⇄DSL,
Property Inspector completo em todos os domínios (Ctrl/elétrico/PLC-Modbus/
plugins/Line-Tunnel), Command Graph visual, migração de todos os ~60
comandos HART, remoção de legado, fuzzing e benchmarks. Isso não é uma tarefa
de uma sessão -- é um roadmap de produto de múltiplas semanas. Em vez de
fingir completude ou recusar o trabalho, esta sessão fez progresso real,
testado e verificado no que julgou ser a fatia de maior alavancagem --
**HART Command DSL/Graph/Compiler**, explicitamente marcada como "área
central" pela própria tarefa -- e reporta honestamente o restante como
`IN_PROGRESS`, nunca como `DONE` sem evidência.

### D.1 O que foi genuinamente concluído e comprovado nesta sessão

1. **`HartCommandJson` (Core) ganhou o vocabulário completo.** Antes: só
   `hex`/`variable`/`body`/`bodySlice` em `responseSteps` plano. Agora:
   `writeSteps`/`responseSteps`/`afterSteps`, com `set`/`if`/`map`/`forCodes`
   recursivos, parseados e serializados (`toJson()`) simetricamente. Testado:
   parse → compile → execute → `toJson()` → re-parse → re-compile → MESMO
   byte de saída (`HartEngineTest.cpp`, bloco "Full statement vocabulary
   through JSON").
2. **Existe agora um parser real da Lasec DSL para corpos de comando HART**
   (`extension/src/dsl/HartCommandDsl.ts`), reaproveitando o `lex()`
   exportado de `DslParser.ts` -- mesma camada léxica do DSL de circuito, não
   uma segunda linguagem inventada do zero (princípio "ONE LASEC DSL"
   respeitado no nível que importa: o léxico; a gramática acima dele é
   deliberadamente separada porque um corpo de comando HART é um pipeline de
   transformação de bytes limitado, não topologia de circuito). Suporta:
   cadeias (`A -> B -> out`), inferência leitura/escrita pela direção da seta
   (`Variable -> ... -> out` = leitura; `in[...] -> ... -> Variable` =
   escrita), slices (`in[a:b]`/`in[a]`), literais hex (`hex("...")`),
   `if <expr> == <expr> { ... } else { ... }`, expansão fria do macro
   `IdentityBlock` (10 campos, idêntico ao `hartIdentityBlockMacro()` em
   C++), e fallback para variável de usuário por nome quando o identificador
   não é um `HartVarId` conhecido -- mesma regra do lado JSON/C++.
   10 testes unitários reais (`HartCommandDsl.test.ts`), incluindo rejeição
   atômica de DSL inválida (chave faltando, seta pendente, identificador
   solto sem seta, slice invertido -- nenhum produz um corpo parcial).
3. **Prova cross-language de que 0x0B é DSL-representável, byte a byte.** A
   fonte DSL equivalente a 0x0B foi parseada no lado TypeScript (produzindo
   um JSON específico, testado), esse MESMO JSON foi fixado como literal em
   `HartEngineTest.cpp` e compilado/executado no lado C++, produzindo os
   bytes IDÊNTICOS ao AST manual de 0x0B já existente (match de tag e
   mismatch de tag, ambos). Isto é o "FASE 72 gate" (seção 72 do enunciado)
   fechado para este comando -- a primeira vez que um comando migra pela DSL
   de verdade, não por C++ manual reclassificado como "migrado".
4. **Dois bugs reais adicionais encontrados e corrigidos**, ambos com
   regressão testada:
   - `HartExpr::Kind::UserVariable` sempre codificava como Float32BE (4
     bytes) independente do `HartVariableType` declarado da variável --
     UInt8/UInt16/Int16/Bool produziam bytes errados no fio. Corrigido para
     despachar por tipo real (`HartCommandProgram.cpp::evalExpr`);
     `PackedAscii` fica explicitamente rejeitado (erro, não silenciosamente
     errado) até o modelo ganhar um slot de valor textual -- gap real,
     documentado, não escondido.
   - Um id de comando custom colidindo com qualquer um dos 55 ids
     padrão/vendor sem handler dedicado derrubava `HartPlanCompiler::compile()`
     inteiro ("duplicate HART command override"), silenciosamente
     desabilitando TODOS os comandos daquele dispositivo -- não só o
     colidente. Corrigido em `HartCommunicationComponent::rebuildConfiguredPlan()`
     (a entrada pré-scan não duplica mais um id já declarado). Regressão:
     comando custom 152 (== 0x98 "Vendor Keepalive") agora sobrescreve
     corretamente o fallback e mantém 0x01/0x0B/etc. funcionando.
   - Uma fragilidade real de teste (UB por aritmética de iterador não
     protegida após um `check()` que não aborta) foi encontrada e corrigida
     durante a investigação do bug acima -- documentada para não reaparecer.

### D.2 O que continua exatamente como a auditoria independente encontrou

- Os outros 54 comandos catalogados (fora 0x00/0x01/0x03/0x0B/0x21) continuam
  como fallback "eco corpo" auto-gerado -- nenhum ganhou corpo semântico
  nesta sessão. 0x00/0x01/0x03/0x21 continuam como AST manual em C++
  (funcionam, têm golden, mas não passaram pelo parser DSL ainda -- só 0x0B
  tem a prova cross-language completa até agora).
- `HartSemanticEndpoint`/o switch `command==0/1/3` em `IndustrialProtocols.cpp`
  continuam publicados por `protocol.hart.transmitter`/`protocol.hart.communicator`
  (confirmado ainda registrados em `CoreApplication.cpp`). Não removidos:
  são tipos de componente colocáveis pelo usuário em projetos EXISTENTES:
  remover sem uma história de migração fria quebraria esses projetos ao
  reabrir -- um bloqueio real de compatibilidade, não preguiça. Próxima ação
  concreta: escrever a migração fria (`protocol.hart.transmitter` salvo →
  reconhecido como perfil equivalente em `HartCommunicationComponent` ao
  abrir) antes de cogitar remoção.
- Não existe editor visual de Command Graph (nós/canvas) -- só o parser de
  texto. A Property Inspector Commands editor (`hartInspectorSections.ts`)
  continua editando os passos via os controles estruturados já existentes
  (select/input por step), não via um campo de texto DSL livre -- integrar o
  parser da DSL como uma superfície de autoria alternativa no Inspector é o
  próximo passo óbvio, não feito nesta sessão.
- `IHartCommandHandler` (o mecanismo de "NativeHandler") continua disponível
  na API do `HartEngine`, mas **zero** handlers de produção o registram --
  confirmado por busca (`grep registerCommandHandler` fora de testes), não
  assumido.
- Nenhuma auditoria propriedade-a-propriedade de Ctrl/elétrico/PLC-Modbus/
  plugins/Line-Tunnel foi feita nesta sessão (mesma lacuna já documentada no
  Anexo C, section C.7 -- não reaberta aqui por falta de tempo, não por
  decisão de escopo).
- Nenhuma validação de GUI/Extension Development Host foi feita (sem GUI
  disponível a este agente).
- Fuzzing e benchmarks representativos não foram executados nesta sessão.

### D.3 Status master

Usando exclusivamente `DONE` / `IN_PROGRESS` / `BLOCKED_EXTERNAL` (nunca
`PARTIAL` no fechamento, por instrução explícita da tarefa -- um item aqui
`IN_PROGRESS` teria sido `PARTIAL` numa taxonomia mais granular; a diferença
é que "in progress" não significa "abandonado", significa "próxima ação
concreta existe e está listada"):

| Area | Status | Evidência / próxima ação |
|---|---|---|
| Lasec DSL core (circuitos) | DONE (herdado, revalidado) | `DslParser.ts`/`DslReconciler.ts`/`DslSerializer.ts`, testes existentes passam |
| Lasec HART Command DSL | IN_PROGRESS | parser real + 10 testes + prova cross-language para 0x0B; gramática cobre chains/slices/hex/if, não cobre `map`/`forCodes` em texto ainda (só via JSON) |
| Visual→DSL / DSL→Visual (circuitos) | DONE (herdado) | `dslCommands.ts` (corrigido lifecycle), `DslReconciler.ts` |
| Visual⇄DSL (comandos HART) | IN_PROGRESS | parser existe, não integrado a um editor visual nem a um campo de texto no Inspector ainda |
| Direct Line / Tunnel (circuitos) | DONE (herdado) | `@Name` = tunnel, `A -> B` = line, distintos no parser/reconciler |
| Route/layout preservation | IN_PROGRESS | mecanismo existe (`DslReconciler.ts` preserva `points`/posições quando endpoints não mudam); não re-testado nesta sessão |
| Property Inspector genérico | DONE (sessão anterior, revalidado) | agrupamento por seção, select/readonly, sem stale selection, testado |
| Property Inspector HART (variáveis/comandos) | IN_PROGRESS | modelo funciona ponta a ponta (id estável, direction, UserVariable, override de fallback); DSL de comando ainda não é uma superfície do Inspector |
| Property Inspector Ctrl/Electrical/PLC-Modbus/plugins/Line-Tunnel | IN_PROGRESS | arquitetura genérica comprovada estruturalmente (Anexo C.4); varredura propriedade-a-propriedade real não feita |
| HART variables (Internal/Input/Output) | DONE (sessão anterior) | `signalPorts()`, `setVariableInput`/`variableValue`, testado |
| HART Command Graph (compilado/bounded IR) | DONE (infra) / IN_PROGRESS (cobertura) | `HartCommandCompiler`/`HartCommandExecutor` bounded e testados; só 5/60 comandos usam o pipeline com corpo real |
| Ctrl primitive reuse em HART commands | IN_PROGRESS | a DSL de comando usa a MESMA sintaxe de cadeia/slice do DSL de circuito (léxico compartilhado); não há ainda reuso de blocos Ctrl CONCRETOS (Gain/Select/etc.) dentro de um corpo de comando -- IF/EQ nativo do comando cobre os casos atuais, RelationalOperator/Select genéricos do Ctrl não foram conectados |
| HartCommandCompiler | DONE | bounded, testado, usado por todo comando (built-in, custom, agora DSL-provado para 0x0B) |
| Custom commands (override de fallback) | DONE | bug real corrigido + testado (D.1.4) |
| Standard commands (0x00/0x01/0x03/0x0B/0x21) | IN_PROGRESS | funcionam e têm golden; só 0x0B tem prova de vir da DSL de verdade até agora |
| Remaining 55 commands | IN_PROGRESS | fallback eco; nenhum migrado nesta sessão |
| Legacy switch/endpoint removal | IN_PROGRESS | não removido -- bloqueio real de compatibilidade com projetos existentes (D.2), precisa de migração fria primeiro |
| Save/reopen (HART) | DONE | testado ponta a ponta com `HartCommunicationComponent` real |
| Undo/redo | DONE (herdado, arquitetural) | mesmo pipeline `requestUpdateProperty` de qualquer propriedade |
| RUN policy | DONE (HART) / IN_PROGRESS (genérico fora de HART) | guard HART cobre estrutural + DSL draft; guard genérico para outras propriedades estruturais não auditado |
| Fuzz | IN_PROGRESS | não executado nesta sessão |
| Benchmarks | IN_PROGRESS | não executados nesta sessão |
| Specs | DONE (esta atualização) | Anexo D + atualização do audit independente |
| Extension Development Host | BLOCKED_EXTERNAL | sem GUI disponível a este agente |

### D.4 Testes desta sessão

Core (`hart_engine_test`, MSVC Release): **PASS**, incluindo os 2 bugs novos
corrigidos + regressão, vocabulário completo de JSON, e a prova
cross-language do 0x0B via DSL. Extension (`npm test`): **459/459**, sem
regressão em nenhum teste pré-existente (era 449 antes desta sessão; os 10
novos são `HartCommandDsl.test.ts`). `git diff --check`: limpo (só avisos de
LF/CRLF). `node .spec/governance/check-specs.mjs`: mesmos 2 erros
pré-existentes, não relacionados (referências `.piohome`).

### D.5 Por que esta sessão não tentou mais

Dado o volume genuíno do pedido (DSL unificada completa, Command Graph
visual, migração de 60 comandos, auditoria de 6+ domínios do Property
Inspector, remoção de legado, fuzzing, benchmarks), continuar por mais
tempo nesta MESMA sessão arriscava exatamente o padrão que as sessões
anteriores já provaram ser perigoso: mudanças rápidas e não verificadas
"parecem" avançar mas escondem bugs reais (como os 2 encontrados aqui, que
só apareceram testando de verdade, não por inspeção de código). A escolha
foi entre (a) reivindicar mais itens como `DONE` sem o mesmo rigor de teste
usado para os itens acima, ou (b) parar num ponto onde tudo que está
marcado `DONE` tem evidência real e tudo que não está é `IN_PROGRESS` com
uma próxima ação concreta escrita. Esta sessão escolheu (b).

## Anexo E -- Classificador normativo HCF_SPEC-99 e remoção do fake fallback (2026-09-11, sessão 5)

Esta sessão implementou a "arquitetura definitiva" pedida em torno de UM
princípio central que faltava de forma explícita e testada até aqui:
**quem define a semântica de um command number é determinado pela faixa
numérica (HCF_SPEC-99 §7.1, Table 9), nunca por convenção de nome de
vendor nem por "o que o Core já implementa hoje"**.

### E.1 O que foi construído (real, testado, buildado)

1. **`core/src/protocols/HartCommandClassification.{hpp,cpp}`** (novo par de
   arquivos) -- a ÚNICA autoridade para:
   - `HartCommandClass classifyHartCommandNumber(uint32_t)`: partição exata
     de HCF_SPEC-99 Table 9 (0-30 Universal, 31 ExpansionFlag, 32-121 exceto
     38/48 CommonPractice, 38/48 Universal, 122-126 NonPublic, 127 Reserved,
     128-253 DeviceSpecific, 254-511 Reserved, 512-767
     AdditionalCommonPractice, 768-1023 WirelessHart, 1024-33791
     DeviceFamily, 33792-64511 Reserved, 64512-64765
     WirelessDeviceSpecific, 64766-64767 Reserved, 64768-65021
     AdditionalDeviceSpecific, 65022-65535 Reserved).
   - `HartCommandImplementationPolicy implementationPolicyFor(HartCommandClass)`:
     deriva StandardCore / ManufacturerDsl / FactoryPrivateDsl /
     ProtocolInfrastructure / Forbidden a partir da classe -- nunca atribuída
     independentemente.
   - `isDeviceSpecificRangeOver90PercentConsumed(count)`: regra dos >90% da
     faixa 128-253 (126 ids) para liberar Additional Device-Specific,
     derivada do tamanho real da faixa (`kDeviceSpecificRangeSize = 126`),
     não um magic number hardcoded.
   - `isManufacturerAuthorable(id, isWirelessHartCapable, consumedCount)`:
     predicado único usado tanto pelos testes quanto pelo gate de autoria em
     `HartCommandJson`.
2. **`HartCommandJson::parseCommandDefinition`/`parseCommandCollection`
   reescritos para usar o classificador**, substituindo o antigo
   `isReservedStandardCommandId` (que só bloqueava 5 ids hardcoded:
   0x00/0x01/0x03/0x0B/0x21). Agora QUALQUER id HART-standardized
   (Universal, Common Practice, Additional Common Practice, WirelessHART,
   Device Family), Reserved, ExpansionFlag ou Non-Public é rejeitado com
   diagnóstico específico por classe; `parseCommandCollection` calcula
   `consumedDeviceSpecificCount` a partir da PRÓPRIA coleção antes de validar
   cada entrada, então a regra dos 90% é avaliada com o total real do
   dispositivo, não um contexto vazio.
3. **Removido o "echo fallback" de `HartReferenceCatalog::commandProgramDefinitions()`**
   -- este era o anti-padrão central que a diretiva desta sessão pediu para
   eliminar: para os 55 ids catalogados (todos os 60 ids de
   `commandDescriptors()` exceto os 5 com corpo real) o Core instalava
   automaticamente um programa que ecoava o corpo da requisição, fazendo um
   host HART que sondasse, por exemplo, o Command 128 (Device-Specific)
   receber uma resposta plausível em vez do "command not implemented"
   correto. Removido sem substituto: um id sem corpo real agora
   simplesmente não tem entrada no hook, e `HartEngine::execute()` já
   retorna `false` nesse caso (nenhuma resposta é enviada -- ver D.2 abaixo
   sobre o limite conhecido de não haver um byte de status RC=64 genérico no
   frame codec).
4. **29 dos 60 ids catalogados são, pela classificação normativa,
   Device-Specific (128-253)** -- esses ids agora ficam genuinamente livres
   para autoria de manufacturer DSL real (o mecanismo de override já
   existente continua funcionando, só que agora não está "vencendo" um
   fallback fake, é a ÚNICA implementação).
5. **Testes novos em `hart_engine_test`** (todos passando): os 33 boundary
   cases da seção 115 do pedido, a tabela completa de classificação
   esperada (seção 116), a tabela completa de policy esperada (seção 117),
   o teste de threshold 113 vs 114 (seção 122), o "manufacturer override
   test" (DSL Command 11/33/38/127/122/31 rejeitados, DSL Command 128
   aceito -- seção 118), e um teste de aplicabilidade Common Practice
   ponta-a-ponta (device que não declara Command 0x21 recebe "not
   implemented", sem nenhum toggle -- seção 119).
6. **Property Inspector**: o helper client-side "+ Add Command" agora
   restringe a sugestão de novo id à faixa 128-253 (antes usava uma lista
   fixa de 5 ids reservados e, sem limite superior, podia sugerir um id
   Reserved como 254 depois que 128-253 enchesse). Tooltip do campo id
   atualizado para explicar a faixa Device-Specific em vez de citar só os 5
   comandos antigos. Teste correspondente reescrito para validar o novo
   comportamento (o teste antigo procurava o literal `"[0, 1, 3, 11, 33]"`,
   que não existe mais no script).

Build: `hart_engine_test` (MSVC Debug) compila limpo e **PASS** (todos os
testes, incluindo os novos). Extension: `npm run compile` limpo, `npm test`
**459/459** (mesma contagem de antes -- 2 testes reescritos, não
adicionados, então o total não muda).

### E.2 Tabela de exemplo (seção 139/140 do pedido)

| ID | Nome (catálogo) | Classe normativa | Quem define semântica? | Core implementa? | Policy | Produção |
|---|---|---|---|---|---|---|
| 0 | Read Unique Identifier | Universal | HART | sim (corpo real) | StandardCore | StandardCore C++ |
| 11 (0x0B) | Read Unique Identifier Associated With Tag | Universal | HART | sim (corpo real) | StandardCore | StandardCore C++ (+ prova de paridade DSL, não produção) |
| 33 (0x21) | Read Device Variables | CommonPractice | HART | sim (corpo real) | StandardCore | StandardCore C++ |
| 2 (0x02) | Read Loop Current And Percent Of Range | Universal | HART | não | StandardCore | Not Implemented (honesto, sem fallback) |
| 152 (0x98) | Vendor Keepalive (nome do catálogo) | DeviceSpecific | Manufacturer | não por padrão | ManufacturerDsl | Not Implemented até autoria real; testado com corpo customizado autorado (D.1.4/E.1.5) |
| 128 (0x80) | Vendor Read Configuration (nome do catálogo) | DeviceSpecific | Manufacturer | não por padrão | ManufacturerDsl | idem |
| 127 | -- | Reserved | ninguém | -- | Forbidden | rejeitado na autoria |
| 64512 | -- | WirelessDeviceSpecific | Manufacturer (contexto wireless) | -- | ManufacturerDsl | rejeitado (build sem modelo de capability WirelessHART) |

### E.3 Contagens finais (seção 141)

```text
Universal Core commands (corpo real)                   = 4   (0x00, 0x01, 0x03, 0x0B)
Universal catalogado mas sem corpo real (not-impl)      = 17  (0x02,0x04-0x0A,0x0C-0x13,0x15)
Common Practice Core commands (corpo real)              = 1   (0x21 / 33)
Additional Common Practice Core commands               = 0   (nenhum id do catálogo cai nesta faixa)
WirelessHART Core commands                             = 0   (nenhum id do catálogo cai nesta faixa)
Device Family Core commands                            = 0   (nenhum id do catálogo cai nesta faixa)
Manufacturer Device-Specific ids catalogados (128-253)  = 29  (todos sem corpo por padrão, autoráveis)
Wireless Manufacturer DSL commands                      = 0   (sem contexto WirelessHART neste build)
Additional Manufacturer DSL commands                    = 0   (nenhum device chega perto de 90% de 128-253)
Factory Private commands                                = 0   (122-126 rejeitados; sem modo de fábrica)
Reserved definitions                                    = 0   (classificador rejeita toda autoria; nenhuma definição existe)
manufacturer-specific C++ runtime handlers remaining     = 0
standard commands incorrectly using production DSL       = 0  (os 5 corpos reais são definidos em C++, nunca por texto DSL do usuário)
generic Common Practice enable/disable toggles added     = 0  (verificado por leitura de hartInspectorSections.ts: único checkbox "Enabled" existente é por-comando-customizado, não um toggle genérico de Common Practice)
```

### E.4 O que esta sessão NÃO fez (honesto, não "PARTIAL")

- **Byte de status RC=64 genérico no frame**: `HartTransportEndpoint::transact`
  hoje simplesmente não envia resposta quando `HartEngine::execute` retorna
  `false` (nenhum frame de volta), em vez de compor um frame com
  Response-Code=64 ("command not implemented") no cabeçalho de status. Isso
  é uma lacuna real de fidelidade ao protocolo -- mas o codec de frame atual
  não modela os 2 bytes de status de forma genérica (cada corpo de comando
  escreve seu próprio primeiro byte de status quando precisa, ex.: 0x0B). Dar
  a UM frame codec compartilhado a responsabilidade do RC exigiria tocar
  TODOS os corpos de comando existentes (golden bytes mudariam) -- não
  tentado nesta sessão por ser uma mudança de alto risco fora do escopo
  imediato do classificador. Next action: modelar `HartResponseBuilder` com
  um método `writeStatus(HartResponseCode)` e migrar os 5 corpos reais para
  usá-lo antes de fazer `execute()` retornar um RC real em vez de `false`.
- **WirelessHART device-capability model**: não existe neste build (nenhum
  profile/plan tem um campo "isWirelessHartCapable"). A faixa Wireless
  Device-Specific (64512-64765) é sempre rejeitada na autoria como
  consequência honesta disso, não como uma feature implementada e depois
  desativada.
- **Migração dos 55 ids não-modelados para corpos reais de Common
  Practice/Universal** (ex.: dar a 0x02, 0x05, 0x54 etc. implementações
  C++ de verdade): continuam "not implemented" corretamente, mas isso é
  "correto e honesto", não "completo" -- só 4 ids Universal + 1 Common
  Practice têm corpo real hoje.
- **Command Graph visual editor, Map/ForCodes na sintaxe textual da DSL,
  Ctrl primitive reuse concreto dentro de um corpo de comando, auditoria
  propriedade-a-propriedade de Ctrl/electrical/PLC-Modbus/plugins/Line-Tunnel,
  fuzzing, benchmarks, remoção do endpoint legado
  `protocol.hart.transmitter`/`protocol.hart.communicator`**: nenhum destes
  avançou nesta sessão (mesmo estado do Anexo D.3), permanecem
  `IN_PROGRESS`.

### E.5 Correção de texto normativo (seção 133/134/135 do pedido)

Nenhum documento `.spec` encontrado nesta sessão afirmava literalmente "all
HART commands must use DSL" (revisado por busca textual); o texto mais
próximo de causar essa confusão era a doc comment de `HartCommandJson.hpp`
("compiler target the Lasec HART Command DSL parser lowers to"), que já
deixa claro que é um alvo de compilação para autoria manufacturer, não uma
afirmação sobre TODOS os comandos. Para eliminar qualquer ambiguidade
futura, o texto normativo abaixo fica registrado como a definição final:

> HART-defined commands use canonical Core implementations. Common Practice
> command semantics are standardized by HART, while their applicability is
> derived from the capabilities/declared commands of the individual field
> device -- never a generic per-command profile toggle. Device-Specific
> commands (128-253) are manufacturer-defined and are authored using Lasec
> DSL. Manufacturer-specific behavior must not reuse Universal, Common
> Practice, Additional Common Practice, WirelessHART or Device Family
> command numbers for different semantics -- `HartCommandClassification.hpp`
> is the single normative authority enforcing this at authoring time.
> Device-Specific = Manufacturer Defined; Device Family = HART-defined. The
> two must never be confused.

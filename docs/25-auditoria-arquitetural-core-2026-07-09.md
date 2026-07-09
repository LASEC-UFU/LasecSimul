# 25 — Auditoria arquitetural completa do Core (diagnóstico + plano + implementação)

> Pedido do usuário: auditoria técnica completa do Core, fase beta, mudanças disruptivas aceitáveis
> (inclusive quebrar compatibilidade com dispositivos já publicados). O documento original (abaixo)
> era só diagnóstico e planejamento. **Atualização 2026-07-09**: o usuário pediu "implemente todas
> as fases" — ver seção 16 (nova, no final) pro status real de implementação por item do plano.
> Todo o texto original abaixo permanece como estava escrito antes da implementação (histórico do
> diagnóstico), exceto onde marcado.

---

## 1. Resumo executivo

O Core tem um núcleo de simulação (`Scheduler`/`Netlist`/`CircuitGroup`/`MnaSolver`) genuinamente bem
abstraído: ele só enxerga `IComponentModel*`, nunca diferencia built-in de plugin ABI, e a malha de
stamp/solve/settle não tem nenhum `if (tipo == X)`. **O problema não está no motor — está nas bordas:**
cada uma das 3 formas de estender o simulador (built-in C++, plugin ABI de dispositivo, plugin ABI de
MCU/QEMU) reimplementa, de um jeito ligeiramente diferente, os mesmos 4 problemas:

1. **Descrição de propriedade duplicada 2-3x por componente** (schema estático + descriptor de
   instância +, pra built-ins, uma terceira cópia em `ComponentMetadata`), com nomes de propriedade
   redigitados à mão em cada cópia sem nenhum vínculo em tempo de compilação.
2. **Duas pipelines de validação de propriedade divergentes**: a de criação (`ComponentParams::property`,
   sem checagem nenhuma de schema) e a de edição em runtime (`SimulationSession::setProperty`, validada
   contra min/max/options/readonly). Isso já causou pelo menos 2 bugs reais confirmados em produção
   (`SimulidePassiveState`, `Probe`) — propriedade de criação silenciosamente ignorada ao recarregar um
   projeto salvo — porque a fábrica do componente esquece de ler o campo de `ComponentParams`.
3. **Um ABI paralelo e assimétrico pra MCU** (`mcu_abi.h`) que não compartilha nada com o ABI de
   dispositivo comum (`device_abi.h`) além da forma de carregar a DLL — inclusive tem uma lacuna de
   robustez real: dispositivos ABI comuns passam por `CrashGuard`/`PluginWatchdog` em toda chamada;
   adaptadores de MCU **não têm proteção nenhuma contra crash** — um MCU adapter mal escrito derruba o
   processo Core inteiro, enquanto um dispositivo lógico mal escrito só fica "Faulted".
4. **`kLeakageConductance` (1e-9 S) reimplementado de forma independente em 4 classes** — é a
   consequência correta e necessária da regra "todos os pinos do mesmo componente caem no mesmo grupo
   topológico" do `Netlist`, mas hoje é responsabilidade de cada autor de componente lembrar de aplicar,
   sem nenhuma rede de segurança — um componente futuro com pino flutuante que esquecer isso vai
   produzir "sistema singular" só em teste, não em compilação.

Nenhum desses 4 problemas é urgente isoladamente (o sistema funciona, os testes passam), mas juntos eles
formam o padrão que o pedido do usuário identificou por intuição: **built-in, ABI e QEMU "quase" seguem
um contrato comum, mas cada ponta reinventa a mesma cola.** A proposta central deste relatório (seção 5)
é elevar essa cola pra um pequeno número de structs/funções compartilhadas — não reescrever o motor
(que já está certo), e não forçar built-in/ABI/MCU a serem literalmente o mesmo caminho de código onde
isso não faz sentido (MCU tem responsabilidades genuinamente diferentes: processo externo, arena de
memória compartilhada, sem stamp elétrico por pino individual do jeito que um resistor tem).

**Recomendação de escopo**: tratar isso como refatoração de Fase 1 (só Core, comportamento preservado,
sem quebrar dispositivo nenhum) seguida de uma Fase 2 opcional (migrar built-ins pro padrão novo,
aproveitando a folga de "beta" pra also corrigir a lacuna de robustez do MCU). Detalhado nas seções
11-12.

---

## 2. Diagnóstico da arquitetura atual

### 2.1 O contrato que já existe e funciona

`IComponentModel` (`core/include/lasecsimul/IComponentModel.hpp`) é o contrato real e único do motor:

```cpp
class IComponentModel {
public:
    virtual ~IComponentModel() = default;
    virtual const char* typeId() const = 0;
    virtual std::span<Pin> pins() = 0;
    virtual uint32_t extraVariableCount() const { return 0; }
    virtual void stamp(MnaMatrixView& matrix) = 0;
    virtual bool isNonlinear() const { return false; }
    virtual bool hasConverged() const { return true; }
    virtual void postStep(uint64_t timeNs) = 0;
    virtual void onEvent(const ComponentEvent&) {}
    virtual size_t getState(uint8_t* out, size_t cap) const = 0;
    virtual void setState(const uint8_t* in, size_t len) = 0;
    virtual std::vector<PropertyDescriptor> propertyDescriptors() { return {}; }
    virtual PluginHealthStatus health() const { return PluginHealthStatus::Ok; }
    virtual void onAssignedIndex(uint32_t) {}
    virtual std::optional<double> current() const { return std::nullopt; }
};
```

Só 6 métodos são puros (`typeId`, `pins`, `stamp`, `postStep`, `getState`, `setState`); o resto tem
default. **Isso é exatamente o "contrato unificado" que o pedido pede — ele já existe.** Built-in,
`NativeDeviceProxy` (ABI de dispositivo) e `McuComponent` (MCU/QEMU) implementam essa MESMA interface, e
`SimulationSession::settleStep()`/`MnaSolver`/`Netlist` chamam só através dela — comentário explícito no
próprio header confirma a intenção: *"O MnaSolver nunca diferencia os dois caminhos"*.

O que falta não é criar o contrato — é **parar de vazar diferença de "tipo de componente" nas bordas
que ficam FORA dessa interface**: registro (3 registries paralelos), descrição de propriedade (schema
duplicado), e leitura estruturada (`ComponentMeta` vs `ComponentMetadata`).

### 2.2 As 3 formas de estender o Core, lado a lado

| | Built-in | ABI dispositivo | ABI MCU/QEMU |
|---|---|---|---|
| Onde mora | `core/src/components/*` (C++ direto) | `devices/*/src/lib.c` (DLL/SO) | `mcu-adapters/*` (DLL/SO) |
| Interface implementada | `IComponentModel` direto | `IComponentModel` via `NativeDeviceProxy` | `IComponentModel` via `McuComponent`, que embrulha `IMcuAdapter` (via `NativeMcuAdapterProxy`) — **camada extra que as outras duas não têm** |
| Registro de tipo | `ComponentRegistry` (`Factory = fn(ComponentParams) -> IComponentModel`) | mesmo `ComponentRegistry` (`replaceFactory`) | `McuRegistry` **separado** (`Factory = fn() -> IMcuAdapter`, sem `ComponentParams`) |
| ABI C / vtable | N/A | `device_abi.h`, `lsdn_get_vtable`, `LsdnDeviceVTable` (10 ponteiros) | `mcu_abi.h`, `lsdn_get_mcu_vtable`, `LsdnMcuVTable` (6 ponteiros, **sem overlap nenhum** de nome/forma com `LsdnDeviceVTable`) |
| Host API dada ao plugin | N/A | `LsdnHostApi` completa (10 callbacks: pin_declare/write/read/schedule_event/config_get/now_ns/log/submit_task/...), sempre populada | `LsdnMcuHostApi` (só `log`+`now_ns`) — **declarada mas NUNCA passada**: `PluginRuntime::createMcuAdapter` chama `vt->create(nullptr, nullptr)` |
| Proteção contra crash | N/A (C++ in-process) | `CrashGuard` (SEH no Windows) em toda chamada + `PluginWatchdog` (timeout) + `PluginHealthStatus` (Faulted após 3 timeouts) | **Nenhuma.** Zero uso de `CrashGuard`/`PluginWatchdog` em `NativeMcuAdapterProxy`/`QemuModuleProxy`/`McuComponent`. `health()` nunca sobrescrito — sempre `Ok` |
| Propriedades editáveis em runtime | `propertyDescriptors()` com getters/setters em membros C++ | `propertyDescriptors()` roteado por `get_property`/`set_property` da ABI | **Não implementado.** `McuComponent` não sobrescreve `propertyDescriptors()` — MCU não tem painel de propriedades runtime pelo caminho padrão |
| Contagem de pinos dinâmica | `ComponentPinSpec`/`resolveDynamicPins` (mesmo mecanismo p/ 2 dos 3) | `pin_declare` (callback ABI, mecanismo diferente do built-in) | Fixa por instância, resolvida uma vez no construtor a partir de `IMcuAdapter::pinMap()` |
| Downcast pro Core saber o "tipo real" | Nunca precisa | Nunca precisa (tudo via `IComponentModel`) | `SimulationSession::loadMcuFirmware`/`mcuLogs` fazem `dynamic_cast<McuComponent*>` — único caso do Core inteiro que precisa RTTI pra funcionar |

O padrão visível: **quanto mais "física de circuito simples" o componente tem (built-in, gate lógico),
mais uniforme ele é com o contrato central. Quanto mais "processo externo com estado próprio" ele tem
(MCU), mais ele empurra caminho especial pra fora da interface.** Isso é parcialmente inevitável — MCU
de fato tem responsabilidades que resistor não tem (processo QEMU, arena de memória compartilhada,
firmware) — mas a assimetria de robustez (crash guard ausente) e a falta total de propriedades runtime
não são inerentes ao domínio, são lacunas de implementação.

### 2.3 Onde há lógica específica por tipo de dispositivo (achados)

- `SimulationSession::addComponent` (`.cpp:118-126`) — único ponto de ramificação por "tipo de
  registry" no caminho de criação: tenta `ComponentRegistry`, senão `McuRegistry` (embrulhando em
  `McuComponent` na hora), senão erro.
- `SimulationSession::loadMcuFirmware`/`mcuLogs` — `dynamic_cast<McuComponent*>`, único downcast do
  Core.
- `SimulationSession::expandSubcircuit` — compara `typeId == "connectors.tunnel"` como string literal
  pra saber quando renomear tunnels expostos; subcircuitos nem passam por `IComponentModel` (usam um
  espaço de id à parte, `kSubcircuitInstanceFlag`).
- `CoreApplication.cpp` — `loadDeviceLibraryFile`/`loadMcuLibraryFile` são funções inteiramente
  separadas (mesma forma, texto quase idêntico) só porque apontam pra registries diferentes.
- Built-ins ignoram o campo `pins[].id` vindo do IPC `addComponent` (usam ids hardcoded); plugins
  **exigem** que esse campo venha preenchido pra `connectWire` funcionar — assimetria documentada em
  comentário no próprio `CoreApplication.cpp`, não em código genérico.

---

## 3. Pontos de duplicação e complexidade

Numerados pra referência cruzada com a seção 6 (mudanças recomendadas).

**D1 — Par schema/descriptor duplicado em toda classe built-in.** `Resistor`, `OpAmp`, `Rail`, `Probe`,
`AnalogMux`, `ResistorArray`, `DiodeLegArray` (e as classes-molde de `SimulideBuiltins.hpp`) implementam
**dois métodos paralelos**: um `static propertySchema()`/`schema()` (só metadado) e um
`propertyDescriptors()` de instância (get/set fechando sobre `this`) que **chama o primeiro só pra
reanexar o schema ao descriptor**. O nome/id de cada propriedade é escrito à mão duas vezes (ex.:
`Resistor.hpp` linha 39 `"resistance"` vs linha 53 `schema.id = "resistance"`) sem nenhum vínculo
verificado pelo compilador.

**D2 — Acoplamento posicional frágil em `Probe.hpp`.** `propertyDescriptors()` pega `schemas[0]`,
`schemas[1]`, `schemas[2]` do vetor devolvido por `propertySchema()` por índice numérico, não por id —
reordenar o schema quebra silenciosamente o descriptor correspondente.

**D3 — Tripla iteração sincronizada à mão em `SimulidePassiveState`.** Construtor, `propertyDescriptors()`
e `currentProperties()` percorrem o mesmo `m_schemas` três vezes, cada uma reimplementando o mesmo
`switch (schema.valueKind)` com contadores locais (`n`, `b`, `s`) pra indexar `m_numbers`/`m_bools`/
`m_strings` de forma coerente entre as três.

**D4 — Duas pipelines de validação de propriedade.** Criação (`ComponentParams::property(name,
default)`, `ComponentParams.hpp`) não valida NADA contra o schema — silenciosamente cai no default em
qualquer mismatch de tipo ou chave ausente. Edição em runtime (`SimulationSession::setProperty`)
valida `PropertySchemaReadOnly`, tipo, min/max, options. **Este é o bug que já mordeu duas vezes**
(`SimulidePassiveState`, depois `Probe`) — uma fábrica que esquece de ler um campo de `ComponentParams`
perde silenciosamente aquele valor ao recarregar um projeto salvo, sem erro, sem log.

**D5 — `ComponentParams::property()` não tem overload de `std::string`**, apesar de `PropertyValue`
suportar string. Quem precisa de propriedade string na criação (ex.: `registerSwitchLike` lendo a tecla
do teclado) reimplementa o `std::get_if<std::string>` manualmente.

**D6 — Boilerplate de fallback de pino duplicado ~19x apesar de já existir helper.** `CoreApplication.cpp`
define `makePinOr`/`makePins2`/`makePins3`/`makePinVector` especificamente pra evitar repetir
`Pin{pos[i].id.empty() ? "fallback" : pos[i].id, ...}`, mas 19 registros ainda repetem o padrão inline em
vez de chamar o helper — os dois estilos coexistem sem critério visível de quando usar qual.

**D7 — `ComponentMeta` (`Types.hpp`) vs `registry::ComponentMetadata` (`ComponentMetadataRegistry.hpp`).**
Dois structs com campos sobrepostos-mas-diferentes descrevendo o mesmo conceito ("declaração de tipo de
componente"). `SimulationSession::registerKnownPluginTypes` copia campo a campo de um pro outro em toda
construção de instância de plugin — se um dos dois structs ganhar um campo novo, o outro não segue
automaticamente.

**D8 — `ComponentMetadata::propertySchema` é uma terceira materialização do mesmo schema** (além do
`propertySchema()` estático da classe e do `propertyDescriptors()` de instância) — hoje não diverge
porque ambos os pontos de registro chamam a mesma função estática por convenção, mas nada garante isso
estruturalmente.

**D9 — `kLeakageConductance = 1e-9` reimplementado de forma independente em 4 arquivos**
(`OpAmp.hpp`, `AnalogMux.hpp`, `ResistorArray.hpp`, `DiodeLegArray.hpp`) — mesma constante, mesmo
motivo (pino sem stamp próprio deixaria o grupo topológico inteiro singular), zero compartilhamento.

**D10 — `MnaSolver::rebuildTopology()`/`stampDirty()` são código morto.** `SimulationSession::settleStep`
só chama `MnaSolver::solve()` — as outras duas funções públicas do solver nunca são invocadas em
produção (confirmado por busca — só existem na definição da classe).

**D11 — `McuController` é um caminho paralelo morto.** Duplica exatamente o que
`McuComponent::loadFirmware`/`stopFirmware` já fazem internamente (abrir arena + subir processo QEMU),
mas só é referenciado pelo próprio teste dedicado (`McuControllerRealQemuTest.cpp`) — nunca usado pela
`SimulationSession` real.

**D12 — `registerSubcircuitFromManifestLegacyUnused`** (`CoreApplication.cpp`, ~46 linhas) — zero
chamadores em todo o `core/`, parser de manifest de subcircuito sem checagem de `schemaVersion`,
convivendo com a versão viva (`registerSubcircuitFromManifestRich`) que faz a checagem certa.

**D13 — `IpcServer::sendNotification`/`OutgoingNotification`** — canal assíncrono Core→Extension
totalmente implementado e documentado, mas **zero chamadores** em todo o Core. Toda comunicação
observada hoje é requisição/resposta.

**D14 — Duas formas de JSON de "fio" coexistindo.** IPC ao vivo (`connectWire`/`disconnectWire`) usa
forma achatada (`componentA/pinIdA/componentB/pinIdB`); arquivo `.lssubcircuit` usa forma aninhada
(`from:{componentId,pinId}`/`to:{...}`) — mesma entidade lógica, dois esquemas JSON diferentes no mesmo
Core.

**D15 — `abiVersion` do manifesto `.lsdevice` é campo morto.** Existe em todo `.lsdevice`, é
documentado como "precisa bater com o Core em runtime", mas **nunca é lido em `core/src`** — a checagem
real é só o par `(abi_major, abi_minor)` devolvido por `lsdn_get_vtable()` em tempo de carregamento. Já
divergiu na prática: vários `.lsdevice` shipados declaram `"abiVersion": {"major": 4}` enquanto o Core
real está em major 3 — sem nenhum efeito, porque o campo é ignorado, mas é uma armadilha de
documentação-como-mentira esperando alguém confiar nele.

**D16 — `PluginLoader::scanDirectory` é um stub vazio**; o carregamento real de `.lsdevice`/
`library.json` está implementado inteiramente em `CoreApplication.cpp` (`loadDeviceLibraryFile`/
`loadMcuLibraryFile`), não na classe que o próprio nome/responsabilidade sugere. `verifyChecksum`
também é stub (sempre `true`), apesar de `library.json` já carregar um campo `checksums` pronto pra uso.

---

## 4. Inconsistências entre built-in, ABI, QEMU/CPU e subcircuitos

- **Subcircuitos**: não são `IComponentModel` — são expandidos ("flattened") em componentes/fios reais
  dentro da MESMA `SimulationSession`, na hora de `addComponent`. Isso é coerente com ADR-0008 e não
  precisa de contrato próprio — já reaproveita o contrato de built-in/ABI pra tudo que é elétrico; a
  única coisa "especial" é bookkeeping de id (`kSubcircuitInstanceFlag`) e nome de tunnel exposto.
- **Instância de propriedade: 2 pipelines divergentes** (criação vs edição) — já coberto em D4, é a
  inconsistência mais perigosa porque é silenciosa.
- **Robustez: 3 níveis diferentes** — built-in confia no C++ (try/catch genérico em `stamp()`), ABI de
  dispositivo tem `CrashGuard`+`PluginWatchdog`+`health()`, ABI de MCU não tem nenhuma proteção. Não há
  razão de design pra essa terceira categoria ser mais frágil — é lacuna, não decisão.
  **⚠️ Confirmar antes de agir**: não há registro de decisão explícita descartando proteção pra MCU;
  tratando como lacuna de implementação, não fato consumado — mas convém perguntar ao usuário se há um
  motivo de performance (overhead de watchdog por poll a cada 50µs) que justificaria manter assim, já
  que o ciclo de poll do MCU é muito mais quente que o de um dispositivo lógico.
- **Mensageria IPC**: dispatch é majoritariamente consistente (payload→session→resposta, try/catch), mas
  tem 2 desvios reais: `setSubcircuitChildProperty` não ecoa `requiresRestart` como `setProperty` faz
  (mesmo `session.setProperty()` por baixo); `instanceId` sempre trafega como string JSON (decisão
  provavelmente deliberada contra perda de precisão de `Number` no JS, mas não documentada em lugar
  nenhum — vale um comentário/ADR curto confirmando a intenção em vez de deixar implícito).
- **Manifesto `.lsdevice`**: campo `abiVersion` morto (D15) é a inconsistência documentação-vs-código
  mais concreta encontrada nesta auditoria.

---

## 5. Proposta de contrato unificado

**Princípio geral**: não existe um problema de "falta de contrato pro motor" — `IComponentModel` já
serve esse papel e deve continuar sendo o único ponto de entrada pro `Scheduler`/`Netlist`/`MnaSolver`.
O que falta são contratos **auxiliares e compartilhados** para as responsabilidades que hoje cada
integração (built-in/ABI/MCU) resolve com sua própria cópia. Proposta, nomenclatura provisória:

### 5.1 `PropertyDefinition<T>` (substitui o par schema+descriptor duplicado — resolve D1, D2, D3, D4, D7, D8)

Uma única estrutura declarativa por propriedade, de onde **tanto** o `PropertySchema` (metadado
estático, pra catálogo/UI) **quanto** o `PropertyDescriptor` (get/set de instância) são derivados
automaticamente — nunca escritos à mão duas vezes:

```cpp
// Um helper por componente, não um par de métodos.
struct PropertyDefinition {
    PropertySchema schema;                                  // id, label, unit, valueKind, min/max, flags...
    std::function<PropertyValue(const void* self)> get;
    std::function<PropertyBindResult(void* self, const PropertyValue&)> set; // valida E aplica, um só lugar
};

// Uso: cada classe declara UMA vez, schema+get+set juntos, id nunca repetido.
static const std::vector<PropertyDefinition>& Resistor::properties() {
    static const std::vector<PropertyDefinition> defs = {
        makeNumberProperty("resistance", "ohm", &Resistor::m_resistanceOhm, 0.01, 1e12),
    };
    return defs;
}
```

`propertyDescriptors()` (a implementação de `IComponentModel`) vira uma função genérica que projeta
`properties()` pra `PropertyDescriptor` — nunca mais reescrita por classe. `ComponentMetadata` deixa de
ter seu próprio `propertySchema` copiado: ele **referencia** `properties()` da classe (ou, pra plugins,
deriva do `.lsdevice` já parseado uma vez).

**Isso também resolve D4** (as duas pipelines de validação): se `set` já valida (min/max/options/
readonly) dentro de si mesmo, tanto a leitura de `ComponentParams` na criação quanto
`SimulationSession::setProperty` em runtime podem chamar o MESMO `set()` — elimina a divergência
"criação não valida, edição valida" de raiz, não só documenta-a.

### 5.2 `ComponentDescriptor` (substitui `ComponentMeta`/`ComponentMetadata` — resolve D7, D8)

Um único struct describing "o que é um tipo de componente", usado tanto pra built-in quanto plugin
(dispositivo) quanto MCU:

```cpp
struct ComponentDescriptor {
    std::string typeId;
    std::string displayName;
    ComponentPinSpec pinSpec;                 // já existe, reaproveitado como está
    std::vector<PropertyDefinition> properties;
    std::optional<ReadoutFormat> readout;
    std::optional<InteractionKind> interaction;
    uint32_t stepTimeoutMs = 0;
    // metadados de UI/i18n que hoje só existem em ComponentMetadata seguem aqui, sem duplicar
};
```

`ComponentRegistry`/`McuRegistry` passam a guardar `ComponentDescriptor` (não uma `Factory` isolada +
uma `ComponentMetadata` isolada em outro registry) — um `typeId` tem exatamente UM registro, não dois
sincronizados manualmente.

### 5.3 `StampContext` — não precisa mudar

`ComponentMatrixView`/`MnaMatrixView` já é exatamente esse contrato hoje (`addConductance`,
`addCurrentToGround`, `getNodeVoltage`, etc.) e já é compartilhado por built-in e ABI (via
`toAbiView`). **Não recomendamos renomear ou tocar essa parte** — está correta e é o exemplo do que o
resto da arquitetura deveria imitar.

### 5.4 `LeakageGuard` — mecanismo central pro problema D9

Em vez de cada componente lembrar de estampar `kLeakageConductance` nos próprios pinos "decorativos",
mover a responsabilidade pra fora do componente: depois que `Netlist::rebuildTopology` monta os grupos,
o próprio motor (`SimulationSession::rebuildTopologyIfNeeded` ou `CircuitGroup::factor()`) detecta
linhas de diagonal zero remanescentes após o stamp de todos os componentes dirty do grupo e aplica uma
condutância de fuga padrão automaticamente, **sem exigir que o autor do componente saiba disso**. Isso
transforma um workaround manual-e-esquecível em uma garantia estrutural do solver — qualquer componente
futuro com pino fisicamente desconectado fica protegido de graça, built-in ou ABI.
⚠️ Este item precisa de validação numérica cuidadosa (não pode mascarar um "sistema realmente singular"
por erro de fiação do usuário) — tratado como risco médio na seção 8, não trivial.

### 5.5 `RobustnessPolicy` por integração (resolve a assimetria MCU vs ABI)

Formalizar que TODA chamada pra código nativo fora do processo Core (ABI de dispositivo E ABI de MCU)
passa pelo mesmo par `CrashGuard`+`PluginWatchdog`, parametrizado por timeout (0 = sem watchdog, como já
é hoje pra `stamp()`). Isso não é um contrato novo — é aplicar o que já existe pra `NativeDeviceProxy`
também em `NativeMcuAdapterProxy`/`QemuModuleProxy`, fechando a lacuna de robustez sem inventar
mecanismo novo.

### 5.6 O que **não** deve ser unificado

- `IMcuAdapter`/`mcu_abi.h` continuam um contrato à parte de `IComponentModel`/`device_abi.h` — MCU tem
  responsabilidades genuinamente diferentes (processo externo, arena de memória, chip com registrador
  MMIO em vez de pino elétrico simples). Forçar os dois ABIs a parecerem iguais criaria abstração falsa.
  A unificação certa aqui é só a de `RobustnessPolicy` (5.5) e a de `ComponentDescriptor` (5.2) — a
  camada de metadado/registro, não a camada de execução.
- `EventBus`/`Lifecycle` genéricos (sugeridos no pedido) não têm hoje nenhuma dor concreta encontrada
  nesta auditoria que os justifique como structs novos — `ComponentEvent`+`onEvent()` já cobre eventos,
  e o ciclo de vida (`onAssignedIndex`→...→destrutor) já é simples o bastante. Introduzir esses dois
  sem um problema real que resolvem seria abstração especulativa, contra a diretriz de simplicidade do
  projeto.

---

## 6. Proposta de simplificação

Ações concretas mapeadas às duplicações da seção 3 (D1-D16):

1. **Um helper genérico `propertyDescriptors()` implementado uma vez em `IComponentModel` (ou em um
   mixin/CRTP leve)** que projeta `properties()` (seção 5.1) — elimina D1, D2, D3, D8.
2. **`ComponentParams::property()` ganha overload de `std::string`** e passa a validar contra o
   `PropertyDefinition::set` da seção 5.1 na criação — elimina D4, D5.
3. **Consolidar `makePins2`/`makePins3`/`makePinVector`** como a ÚNICA forma de montar pinos com
   fallback em `CoreApplication.cpp`; converter os 19 usos inline restantes — elimina D6 (mecânico, não
   arquitetural, mas fácil e reduz ruído).
4. **Fundir `ComponentMeta` em `ComponentDescriptor`** (seção 5.2) — elimina D7.
5. **Extrair `kLeakageConductance` pro motor (`LeakageGuard`, seção 5.4)** — elimina D9 e a
   necessidade de repeti-lo em componentes futuros.
6. **Remover `MnaSolver::rebuildTopology()`/`stampDirty()`** (D10, código morto — nunca chamados),
   **remover `McuController`** (D11, duplicado morto do que `McuComponent` já faz) ou dar a ele um papel
   real substituindo a lógica interna de `McuComponent::loadFirmware` (escolher um, não manter os dois),
   **remover `registerSubcircuitFromManifestLegacyUnused`** (D12) e **remover ou finalmente usar
   `IpcServer::sendNotification`** (D13 — decisão de produto: existe necessidade real de push
   assíncrono Core→Extension, por exemplo pra notificar mudança de `PluginHealthStatus` sem polling? Se
   sim, usar; se não, remover o código morto).
7. **Escolher UMA forma de JSON pra "fio"** (D14) — recomendação: adotar a forma aninhada
   `{from:{componentId,pinId}, to:{...}}` também na IPC ao vivo (é mais extensível e já é a forma
   usada em arquivo), ou o inverso; o importante é eliminar a segunda forma, não qual delas vence.
8. **Remover o campo `abiVersion` de `.lsdevice`** (D15, é lido por ninguém — remover reduz a chance de
   alguém confiar nele) OU **implementar a checagem real** (parsear e comparar contra
   `LSDN_ABI_VERSION_MAJOR`/`MINOR` no load, falhando com mensagem clara em vez de deixar o campo
   decorativo). Recomendação: implementar a checagem — já existe o dado, só falta o `if`.
9. **Mover o carregamento de `.lsdevice`/`library.json` de `CoreApplication.cpp` pra dentro de
   `PluginLoader::scanDirectory`** (D16 — hoje é stub, a lógica real mora no lugar errado) e
   **implementar `verifyChecksum` de verdade** (SHA-256 contra o campo `checksums` que `library.json`
   já carrega, hoje ignorado).

---

## 7. Mudanças disruptivas recomendadas

Já que beta permite quebra de compatibilidade interna, as seguintes valem considerar mesmo custando
reescrever componentes existentes:

- **Trocar o par schema/descriptor por `PropertyDefinition` único (5.1) em TODOS os built-ins.** Isso
  toca praticamente todo arquivo em `core/src/components/` — é a mudança de maior alcance, mas também a
  que mais reduz área de bug (elimina a classe de bug D4 estruturalmente, não só em instâncias já
  encontradas).
- **Fundir `ComponentMeta`/`ComponentMetadata` em `ComponentDescriptor` (5.2)** — toca
  `ComponentMetadataRegistry`, `PluginRuntime::createDeviceInstance`, `CoreApplication.cpp` (registro de
  built-in e parsing de `.lsdevice`).
- **Aplicar `CrashGuard`/`PluginWatchdog` em `NativeMcuAdapterProxy`/`QemuModuleProxy` (5.5)** —
  disruptivo no sentido de que qualquer MCU adapter já publicado (hoje só ESP32) precisa ser
  re-testado sob a nova política de timeout, mas não muda a ABI C (`mcu_abi.h` não precisa mudar,
  só o C++ do lado do Core).
- **Passar `LsdnMcuHostApi` de verdade** (`log`/`now_ns`) em vez de `nullptr, nullptr` — trivial de
  implementar, mas é uma mudança de comportamento observável pra qualquer MCU adapter que um dia queira
  usar esses callbacks (hoje nenhum usa, porque nunca funcionaram).
- **Não recomendado**: unificar `McuRegistry` dentro de `ComponentRegistry` fazendo `Factory` sempre
  aceitar `ComponentParams` — MCU genuinamente não tem parâmetro de construção (o chip inteiro é fixo
  por `chipId`), forçar a mesma assinatura criaria um parâmetro sempre-ignorado. Manter os dois
  registries separados, mas com `ComponentDescriptor` compartilhado (5.2) resolve a duplicação real sem
  forçar essa uniformidade artificial.

---

## 8. Riscos

| Risco | Descrição | Mitigação |
|---|---|---|
| **Alto** — regressão numérica em `LeakageGuard` automático (5.4) | Detectar automaticamente "diagonal zero após stamp" e aplicar fuga pode mascarar um erro real de fiação do usuário (nó genuinamente flutuante que deveria dar erro, não ser silenciosamente aterrado a 1e-9 S) | Manter o log de aviso já existente pra grupo singular; só aplicar fuga automática em pinos que o PRÓPRIO componente declara como "não crítico" via um novo flag em `ComponentPinSpec` (ex. `mayFloat: true`), não em qualquer pino zerado — evita mascarar bug de fiação real do usuário |
| **Médio** — reescrever todos os built-ins pro novo `PropertyDefinition` | Superfície de mudança grande (praticamente todo arquivo em `components/`), risco de regressão sutil em getter/setter (ex. troca de unidade, min/max esquecido) | Migrar componente por componente com teste de regressão dedicado por classe (o padrão já usado nesta sessão, ex. `inert_components_fix_test.cpp`) antes de apagar o código antigo |
| **Médio** — aplicar CrashGuard/Watchdog em MCU adapters | Overhead de watchdog em um poll de 50µs pode não ser desprezível se mal configurado (thread extra por chamada quando `timeoutMs > 0`) | Usar `timeoutMs = 0` (caminho direto, sem thread) pro poll de altíssima frequência, reservando watchdog de verdade só pra `create`/`build_launch_args`/`create_modules` (chamadas raras, de inicialização) |
| **Baixo-Médio** — fundir `ComponentMeta`/`ComponentMetadata` | Muitos call sites leem campos de um ou outro struct hoje — risco de esquecer um campo na fusão | Compilação já pega isso (campo ausente = erro de compilação), risco real é só de comportamento (campo com default errado), mitigado por rodar a suíte completa (32 testes Core) após cada etapa |
| **Baixo** — remover código morto (D10-D13) | Praticamente nenhum, são funções sem chamador confirmadas por grep | Rodar suíte completa antes/depois pra confirmar zero teste dependia de comportamento oculto |
| **Baixo** — mudar forma JSON de "fio" (D14) | Só afeta a Extension (que já processa ambos os formatos hoje, um por contexto) — quebra se a Extension não for atualizada junto | Coordenar com a mudança correspondente na Extension na mesma PR/fase, não deixar defasado |

### 8.1 Análise de desempenho — CrashGuard/Watchdog em MCU (resposta à pergunta do usuário — 2026-07-09)

Pergunta: dá pra fechar a lacuna de robustez do MCU (item 5.5) sem perder desempenho, já que o CPU
emulado precisa rodar "no máximo"? **Sim, com uma condição específica** — abaixo os números que
sustentam essa resposta, lidos direto do código (`core/src/plugins/CrashGuard.cpp`,
`core/src/plugins/PluginWatchdog.hpp`, `core/src/mcu/McuComponent.hpp`):

- `McuComponent::stamp()` roda a cada `kPollIntervalNs = 50'000` ns (**50 µs**) — esse é o orçamento de
  tempo real disponível por ciclo antes de a próxima estampa acontecer, e é o caminho mais quente de
  todo o Core (mais quente que qualquer built-in, que só reestampa quando algo muda).
- `CrashGuard::call` no Windows é `__try { fn(); } __except(...) { ... }` — no modelo de exceção x64
  (que é o alvo real de build, `win-x64`), SEH é **table-based, não frame-based**: não há push/pop de
  handler na pilha a cada entrada/saída do `__try` como no x86 antigo. O caminho feliz (sem exceção)
  custa **efetivamente zero instruções extras** — o custo só aparece SE uma exceção de fato disparar
  (caso que, por definição, é o que queremos capturar). No POSIX, `CrashGuard::call` é literalmente
  `fn(); return true;` — chamada direta, sem wrapper nenhum.
- `PluginWatchdog::call(..., timeoutMs, fn)` com **`timeoutMs == 0` não cria thread nenhuma** — cai
  direto em `CrashGuard::call(typeId, fn)` (linha 31-34 de `PluginWatchdog.hpp`, já é o comportamento
  hoje pra chamadas sem timeout declarado). Só quando `timeoutMs > 0` é que uma `std::thread` real é
  criada por chamada — e criação de thread no Windows custa tipicamente **dezenas de microssegundos**,
  o que **sozinho já estouraria o orçamento de 50 µs do poll** se aplicado ingenuamente no loop quente.

**Conclusão prática**: aplicar `CrashGuard` (contenção de crash via SEH) no caminho quente
(`stamp()`/despacho de eventos da arena, chamadas em `QemuModule`/`QemuModuleProxy`) é **de custo
desprezível — não compete com "CPU no máximo"**, porque a proteção em si não usa thread nem lock, só
uma tabela de unwind que o compilador já gera. O que **não pode** entrar no caminho quente é o
`PluginWatchdog` com timeout real (`timeoutMs > 0`, que cria thread) — esse deve ficar reservado só
pras chamadas raras e de inicialização (`create`, `build_launch_args`, `create_modules`, chamadas uma
vez por instância de MCU, nunca por poll). Isso já era exatamente a mitigação proposta na tabela acima
(linha "Médio — aplicar CrashGuard/Watchdog em MCU adapters") — agora confirmada com números do código
em vez de estimativa, então a Fase 3 pode prosseguir sem risco de desempenho **desde que a
implementação siga essa regra: `CrashGuard` puro (ou `PluginWatchdog` com `timeoutMs=0`, que é
equivalente) no `stamp()`/poll; `PluginWatchdog` com timeout real só no `create`/`build_launch_args`/
`create_modules`.**

---

## 9. Benefícios esperados

- **Elimina estruturalmente a classe de bug já vista 2x** (propriedade de criação ignorada
  silenciosamente) — não só corrige os casos encontrados, fecha a possibilidade de recorrência.
- **Reduz a área de superfície que um autor de componente novo precisa entender**: hoje escrever um
  built-in exige saber sobre `propertySchema()` estático, `propertyDescriptors()` de instância,
  `ComponentMetadata` de registro, E lembrar de `kLeakageConductance` se algum pino puder ficar
  desconectado — com as mudanças da seção 5/6, isso vira "declarar `properties()` uma vez, o resto é
  derivado".
- **Fecha uma lacuna de robustez real** (MCU sem CrashGuard) antes que um MCU adapter de terceiros
  (fora do ESP32 já shipado) derrube o Core em produção.
- **Remove ~150-200 linhas de código morto confirmado** (D10-D13) sem risco funcional.
- **Documentação para de mentir** (D15 — `abiVersion` morto) sem custo de reescrita, só decisão.

---

## 10. Dispositivos/grupos impactados

| Grupo | O que muda | Obrigatório ou opcional | Risco de quebra | Benefício | Prioridade |
|---|---|---|---|---|---|
| **Built-ins** (todos em `core/src/components/`) | Migrar pro `PropertyDefinition` único (5.1); remover leitura duplicada de schema | Obrigatório se adotar 5.1 (não dá pra misturar padrão novo/velho por muito tempo sem confundir) | Médio (comportamento de propriedade pode sutilmente mudar se min/max for esquecido na migração) | Alto (fecha D1-D4 pra sempre) | **Alta** — é o maior volume de código e a fonte dos bugs já confirmados |
| **ABI dispositivo** (`devices/simulide-logic`, `simulide-sensors`, `simulide-complex`, `simulide-peripherals`) | Nenhuma mudança na ABI C (`device_abi.h` não muda); só o lado Core (`ComponentDescriptor`) muda como consome `.lsdevice` | Opcional — DLLs existentes continuam funcionando sem recompilar, já que o C ABI não muda | Baixo | Médio (unifica registro/metadado, não muda comportamento do dispositivo) | **Média** |
| **QEMU/MCU** (`mcu-adapters/espressif-esp32`) | ABI C (`mcu_abi.h`) não muda; ganha `CrashGuard`/`PluginWatchdog` do lado Core e `LsdnMcuHostApi` real | Obrigatório pro Core (lado C++), zero mudança exigida no adapter C existente | Baixo (ABI binária idêntica) | Alto (fecha a lacuna de robustez) | **Alta** — é a lacuna de segurança mais concreta encontrada |
| **Subcircuitos** | Nenhuma mudança estrutural — continuam expandidos como `IComponentModel` reais; só se beneficiam indiretamente de D1-D9 sendo resolvidos nos componentes que eles instanciam | Opcional | Nenhum | Baixo/indireto | **Baixa** |
| **Medidores** (`meters/*`: Probe, Oscope, Voltmeter, Ampmeter, FreqMeter, LogicAnalyzer) | Migram pro `PropertyDefinition` junto com os demais built-ins; `Probe` em particular resolve D2 (acoplamento posicional) | Obrigatório junto com built-ins | Baixo (comportamento elétrico não muda, só a forma de declarar propriedade) | Médio | **Alta** (Probe já teve bug real) |
| **Fontes** (`sources/*`) | Idem — migram junto | Obrigatório junto com built-ins | Baixo | Médio | **Média** |
| **Conectores** (`connectors/*`: Tunnel, Junction) | Idem, mas menor superfície de propriedade | Obrigatório junto com built-ins | Baixo | Baixo | **Baixa** |
| **Componentes complexos com pino dinâmico** (`AnalogMux`, `Keypad`, `DiodeLegArray`, `ResistorArray`) | Além de D1-D4, se beneficiam diretamente de `LeakageGuard` (5.4) removendo o `kLeakageConductance` manual | Obrigatório junto com built-ins + opcional pra 5.4 | Médio (são os componentes mais recentes e menos testados em produção real) | Alto (elimina D9 nos 4 arquivos que hoje o duplicam) | **Alta** |
| **Componentes já migrados pra `.lsdevice`** (gate lógico, sensores, periféricos) | Já são ABI — só ganham o `ComponentDescriptor` unificado do lado Core, sem tocar o `.lsdevice`/DLL deles | Opcional | Nenhum | Baixo/indireto | **Baixa** |

---

## 11. Plano de refatoração por fases

**Fase 0 (já concluída nesta auditoria)**: diagnóstico, sem código tocado.

**Fase 1 — só Core, contratos + limpeza, comportamento preservado** (detalhada na seção 12):
1. Introduzir `PropertyDefinition`/helper de projeção `propertyDescriptors()` genérico, SEM migrar
   nenhum componente ainda (só a infraestrutura).
2. Introduzir `ComponentDescriptor` unificando `ComponentMeta`/`ComponentMetadata`.
3. Remover código morto confirmado (D10-D13).
4. Corrigir `abiVersion` (implementar checagem real ou remover o campo).
5. Mover carregamento de manifest pra dentro de `PluginLoader` (D16).
6. Rodar suíte completa (32 testes Core, 15 arquivos Extension) — nenhum comportamento deve mudar.

**Fase 2 — migração dos built-ins pro contrato novo**:
1. Migrar componente por componente (começando pelos que já tiveram bug real: `Probe`,
   `SimulidePassiveState`) pro `PropertyDefinition`.
2. Migrar `AnalogMux`/`ResistorArray`/`DiodeLegArray`/`OpAmp` pro `LeakageGuard` central (5.4), com o
   flag `mayFloat` novo em `ComponentPinSpec`.
3. Consolidar uso de `makePins2`/`makePins3`/`makePinVector` (D6).
4. Escolher e unificar a forma JSON de "fio" (D14) — coordenado com a Extension.

**Fase 3 — fechar a lacuna de robustez MCU**:
1. Aplicar `CrashGuard`/`PluginWatchdog` em `NativeMcuAdapterProxy`/`QemuModuleProxy`.
2. Passar `LsdnMcuHostApi` real em `PluginRuntime::createMcuAdapter`.
3. Decidir o destino de `McuController` (remover ou promover a caminho real).
4. Testar contra o adapter ESP32 real (único MCU shipado hoje) sob falha simulada.

**Fase 4 — ABI de dispositivo (opcional, menor prioridade)**:
1. Migrar consumo de `.lsdevice` pro `ComponentDescriptor` unificado (sem mudar `device_abi.h`).
2. Revisar se `IpcServer::sendNotification` tem uso real projetado (ex.: push de `PluginHealthStatus`);
   se não, remover.

Cada fase é independentemente revertível (não há dependência forte de Fase 3/4 em Fase 2 ter terminado)
— **Fase 1 é pré-requisito de tudo**, as demais podem ser priorizadas livremente pelo usuário.

---

## 12. Primeira etapa detalhada (só Core, sem tocar dispositivo nenhum)

Objetivo da Fase 1: criar a infraestrutura nova, remover código morto confirmado, **sem exigir
recompilação de nenhuma DLL de `devices/`/`mcu-adapters/`** e sem migrar nenhum built-in ainda (isso é
Fase 2). Passos concretos:

1. **`core/include/lasecsimul/PropertyDefinition.hpp` (novo)** — struct + helpers
   `makeNumberProperty`/`makeBoolProperty`/`makeStringProperty`/`makeOptionProperty` que produzem tanto
   o `PropertySchema` quanto o par get/set validado. Não requer mudar `IComponentModel` ainda (fica
   como ferramenta disponível, opt-in).
2. **`core/include/lasecsimul/ComponentDescriptor.hpp` (novo)** — struct unificado; adaptar
   `ComponentMetadataRegistry` pra armazenar `ComponentDescriptor` em vez de `ComponentMetadata`
   (rename/merge de campos); adaptar os ~3 call sites que hoje constroem `ComponentMeta` separadamente
   (`SimulationSession::registerKnownPluginTypes`, `CoreApplication.cpp`'s `loadDeviceLibraryFile`) pra
   usar o struct único.
3. **Remover `MnaSolver::rebuildTopology()`/`stampDirty()`** (D10) — checar zero chamador antes,
   remover declaração+definição, atualizar teste se algum cobre essas funções diretamente (não deveria,
   já que não são chamadas em produção).
4. **Remover `McuController`** (D11) OU decidir mantê-lo como a implementação real de
   `McuComponent::loadFirmware`/`stopFirmware` (escolha do usuário — recomendação é remover, já que
   `McuComponent` já faz o trabalho e é o caminho testado em produção).
5. **Remover `registerSubcircuitFromManifestLegacyUnused`** (D12) — zero chamador confirmado.
6. **Decidir e agir sobre `IpcServer::sendNotification`** (D13) — perguntar ao usuário se há uso
   planejado; se não, remover `buildNotification`/`sendNotification`/`OutgoingNotification`.
7. **`abiVersion`**: implementar a checagem (`PluginLoader::createDeviceModuleFromExports` já tem o par
   `abiMajor`/`abiMinor` retornado pela DLL — comparar também com o campo do manifesto e logar
   divergência) OU remover o campo dos `.lsdevice` existentes (decisão: seção 6, item 8, escolha do
   usuário).
8. **Mover `loadDeviceLibraryFile`/`loadMcuLibraryFile` de `CoreApplication.cpp` pra
   `PluginLoader::scanDirectory`** — implementar o stub de verdade; `CoreApplication.cpp` passa a só
   chamar `pluginLoader.scanDirectory(path)`.
9. **Implementar `verifyChecksum`** contra o campo `checksums` de `library.json` (SHA-256).
10. **Rodar suíte completa** (Core `ctest` Debug+Release, Extension `npm test`+`tsc`) — nenhuma
    regressão esperada, já que nenhum built-in/plugin muda de comportamento nesta fase.

**Explicitamente fora da Fase 1** (conforme pedido do usuário): nenhum built-in migra pro
`PropertyDefinition` ainda; nenhum `.lsdevice`/DLL precisa ser recompilado; `LeakageGuard` automático
(5.4) não é implementado ainda (é Fase 2, precisa da decisão de risco da seção 8 primeiro).

---

## 13. Testes necessários

- **Testes de regressão pré-existentes** (32 Core / 15 Extension) devem continuar 100% verdes depois de
  CADA passo da Fase 1 — nenhum é opcional, já que o objetivo da Fase 1 é "zero mudança de
  comportamento observável".
- **Novo teste pra `ComponentDescriptor` unificado**: confirmar que um built-in registrado E um plugin
  carregado de `.lsdevice` produzem o mesmo formato de resposta em `getPropertySchemas` antes/depois da
  fusão (teste de não-regressão de contrato IPC).
- **Novo teste pra checagem de `abiVersion`** (se implementada): DLL com `abiVersion.major` divergente
  do manifesto deve logar aviso claro (ou falhar, dependendo da decisão) — hoje não há cobertura
  nenhuma disso porque o campo nunca é lido.
- **Novo teste pra `PluginLoader::scanDirectory`** real (hoje só testável indiretamente via
  `CoreApplication`) — teste unitário isolado carregando um `library.json` de fixture.
- **Fase 2**: cada built-in migrado precisa de um teste "antes/depois" comparando o `PropertyDescriptor`
  produzido pelo código antigo vs o novo (schema idêntico, get/set com mesmo comportamento observável) —
  reaproveitar o padrão já usado em `inert_components_fix_test.cpp` desta sessão.
- **Fase 3**: teste de MCU adapter crashando deliberadamente (SEH sintético no Windows, como já existe
  pra `CrashGuardTest` de dispositivo) confirmando que o Core sobrevive e reporta `Faulted` em vez de
  derrubar o processo.

---

## 14. Documentação/spec/skill que deve ser atualizada

- **`.spec/lasecsimul.spec`** — seção 6 ("Interfaces principais") precisa de uma nova subseção
  descrevendo `PropertyDefinition`/`ComponentDescriptor` assim que a Fase 1 introduzir os arquivos
  novos; a atual descrição de `IComponentModel`/registries precisa apontar pro novo mecanismo.
- **`.spec/lasecsimul-native-devices.spec`** — seção 4 ("API pública ABI") não muda (C ABI é estável por
  design), mas seção 6 ("funções fornecidas pelo simulador") precisa documentar `ComponentDescriptor`
  substituindo a menção implícita a `ComponentMeta`; adicionar nota sobre a correção do campo
  `abiVersion` (D15) assim que decidida.
- **Novo `docs/adr/00XX-property-definition-unificada.md`** — registrar a decisão de unificar
  schema+descriptor (mudança arquitetural relevante o bastante pra merecer ADR própria, seguindo o
  padrão já usado pro resto do projeto).
- **Novo `docs/adr/00XX-crashguard-para-mcu-adapters.md`** — registrar a decisão de fechar a lacuna de
  robustez de MCU (por que não tinha antes, por que passa a ter).
- **`docs/18-guia-dispositivo-abi-e-mcu-qemu.md`** — atualizar a seção que menciona `abiVersion` como
  "precisa bater com o Core em runtime" pra refletir o comportamento real (hoje falso — não é checado).
- **`.skill/lasecsimul.skill`** — se contiver referências operacionais a como declarar propriedade de um
  componente novo, precisa de atualização pra ensinar o padrão novo (`PropertyDefinition`) assim que
  Fase 2 estabilizar, evitando que uso futuro do skill ensine o padrão antigo já obsoleto.
- **`README.md`** — nenhuma mudança de contagem de teste até que Fase 1/2 realmente adicionem/removam
  arquivos de teste (atualizar junto na hora certa, não antecipadamente).

---

## 15. Ranking unificado de prioridade (todos os achados, 2026-07-09)

Pedido do usuário: um ranking único (não agrupado por fase) de tudo que foi encontrado. Critério de
ranking: risco de bug/segurança em produção × custo de implementação × quantas frentes
(built-in/ABI/MCU) o achado atravessa. (WASM não consta desta lista nem do relatório — não existe no
código, nunca existiu, e a ausência já é uma decisão arquitetural registrada em ADR-0002; não é um
achado de auditoria, por isso foi removida da análise a pedido do usuário.)

| # | Achado | Prioridade | Por quê |
|---|---|---|---|
| 1 | **D4 — duas pipelines de validação de propriedade divergentes** | 🔴 Crítica | Já causou 2 bugs reais confirmados em produção (`SimulidePassiveState`, `Probe`); qualquer built-in novo pode reintroduzir o mesmo bug hoje, sem nenhum aviso do compilador |
| 2 | **5.5 — MCU sem CrashGuard/Watchdog** | 🔴 Crítica | Único ponto do Core onde um plugin de terceiro pode derrubar o processo inteiro sem contenção; confirmado agora (seção 8.1) que fechar isso não custa desempenho no caminho quente — sem motivo pra adiar |
| 3 | **D1/D2/D3 — schema/descriptor duplicado + acoplamento posicional em `Probe`** | 🟠 Alta | Fonte estrutural do achado #1; `Probe` já tem o acoplamento por índice (`schemas[0]`) que quebra silenciosamente se alguém reordenar o schema |
| 4 | **D9 — `kLeakageConductance` duplicado em 4 classes** | 🟠 Alta | Todo componente futuro com pino "decorativo" (mux, array, leg) precisa lembrar disso manualmente hoje; um esquecimento só aparece em teste como "sistema singular", não em compilação |
| 5 | **D15 — `abiVersion` do `.lsdevice` é campo morto e já divergiu** | 🟠 Alta | Documentação ativamente mentindo (diz "precisa bater com o Core", mas nunca é checado) — baixo custo de correção, alto valor de manter confiança no manifesto |
| 6 | **D7/D8 — `ComponentMeta` vs `ComponentMetadata` duplicados** | 🟡 Média | Risco de divergência silenciosa entre os dois structs; hoje não diverge só por convenção, não por garantia |
| 7 | **D10/D11/D12/D13 — código morto confirmado** (`MnaSolver::rebuildTopology/stampDirty`, `McuController`, `registerSubcircuitFromManifestLegacyUnused`, `IpcServer::sendNotification`) | 🟡 Média | Zero risco de regressão pra remover (confirmado por grep), mas zero urgência — só reduz ruído pra quem lê o código depois |
| 8 | **D16 — `PluginLoader::scanDirectory`/`verifyChecksum` são stubs** | 🟡 Média | A responsabilidade real mora no lugar errado (`CoreApplication.cpp`) e a verificação de integridade do binário nunca acontece de verdade, apesar do dado (`checksums`) já existir em `library.json` |
| 9 | **D14 — duas formas de JSON de "fio"** | 🟢 Baixa | Funciona hoje (Extension já lida com os dois formatos por contexto); só vira problema se um consumidor novo tentar tratar os dois casos com o mesmo parser |
| 10 | **D5/D6 — `ComponentParams::property()` sem overload string / boilerplate de pino duplicado 19x** | 🟢 Baixa | Puramente mecânico, zero risco funcional, só reduz repetição de código |

**Leitura direta do ranking**: os 2 itens críticos (#1, #2) são exatamente os 2 que você já indicou
interesse em resolver — robustez de propriedade (parte do contrato `PropertyDefinition`, seção 5.1) e
robustez de MCU (seção 5.5, com a confirmação de desempenho da seção 8.1). Recomendo tratá-los como o
verdadeiro "Fase 1" na prática, mesmo que a numeração de fases da seção 11 os distribua entre Fase 1
(infraestrutura) e Fase 3 (MCU) — a ordem de EXECUÇÃO pode seguir este ranking em vez da numeração de
fases, já que não há dependência forte entre #1 e #2.

---

## Critério de aceitação — como isso deixa o Core mais simples

Antes: 3 formas de estender o simulador, cada uma com sua própria cópia de "como descrever uma
propriedade" (D1, D3), duas pipelines de validação divergentes que já causaram bug real (D4), um
workaround manual duplicado 4x pro mesmo problema estrutural (D9), e uma assimetria de robustez sem
justificativa de design (MCU sem CrashGuard). Depois da Fase 1+2+3: uma única forma declarativa de
descrever propriedade (deriva schema E descriptor), um único registro de tipo de componente
(`ComponentDescriptor`), a mesma política de robustez pra qualquer código nativo fora do processo, e o
problema de pino flutuante resolvido no motor em vez de reimplementado por cada autor de componente. O
contrato central (`IComponentModel`) não muda — ele já estava certo; a simplificação é toda nas bordas
que hoje vazam diferença de "tipo de integração" pra fora dele.

---

## 16. Status real de implementação (2026-07-09, pós "implemente todas as fases")

Ranking §15 revisitado com o que de fato foi implementado, testado (32→**34** testes Core Debug,
mesma contagem Release) e mesclado. Ordem = mesma do ranking original.

| # | Achado | Status | Onde |
|---|---|---|---|
| 1 | D4 — pipelines de validação divergentes | ✅ **Fechado por completo pro lado da EDIÇÃO** (todo built-in migrado agora valida via `PropertyDefinition`/`validatePropertyValue`); lado da CRIAÇÃO (fábricas em `CoreApplication.cpp`) só convertido pra `propertyOrDefault` em `Probe`/`Resistor` — ver §17.1 | `PropertyDefinition.hpp`, ADR 0010, `.spec/lasecsimul.spec` §6.1.5 |
| 2 | 5.5 — MCU sem CrashGuard/Watchdog | ✅ **Fechado por completo** — mesma cobertura que dispositivo ABI comum já tinha | `NativeMcuAdapterProxy`/`QemuModuleProxy`/`McuComponent::health()`, ADR 0011, teste `mcu_crash_resilience` |
| 3 | D1/D2/D3 — schema/descriptor duplicado + acoplamento posicional | ✅ **Fechado por completo** — todos os 25 arquivos migrados, zero acoplamento posicional restante em `core/src/components/` (ver §17.1) | Todo `core/src/components/*.hpp`, teste `property_definition` |
| 4 | D9 — `kLeakageConductance` duplicado em 4 classes | ✅ **Fechado por completo** — `IComponentModel::leakagePinIndices()` (opt-in, não detecção automática — mitiga o risco 🔴 original) aplicado pelo framework; os 4 arquivos não estampam mais a condutância manualmente (ver §17.2) | `IComponentModel.hpp`, `SimulationSession.cpp`, `OpAmp`/`AnalogMux`/`DiodeLegArray`/`ResistorArray.hpp` |
| 5 | D15 — `abiVersion` morto/divergido | ✅ **Fechado** — 68 manifestos corrigidos pro valor real + aviso automático (não bloqueante) em toda carga futura | `GlobalPluginCache.hpp` (`warnIfAbiVersionMismatch`), `.spec/lasecsimul-native-devices.spec` §24.2 |
| 6 | D7/D8 — `ComponentMeta` vs `ComponentMetadata` | 🔄 **Reavaliado, não é duplicação nociva** — na prática `ComponentMeta` é um subconjunto legítimo, enxuto, do caminho quente de `NativeDeviceProxy` (não carrega `displayName`/`iconPath`/`language`, que esse proxy nunca usa); fundir infligiria bloat no hot path sem benefício real. Mantido como está — julgamento de engenharia revisado ao implementar, não um adiamento por falta de tempo | Nenhuma mudança — ver nota abaixo |
| 7 | D10/D11/D12/D13 — código morto confirmado | ✅ **Fechado, com uma correção ao plano original**: `MnaSolver::rebuildTopology/stampDirty` (D10) e `registerSubcircuitFromManifestLegacyUnused`/`IpcServer::sendNotification` (D12/D13) foram REMOVIDOS como planejado; `McuController` (D11) **não foi removido** — descobriu-se que tem um chamador real (`McuControllerRealQemuTest`, integração contra o binário QEMU de verdade) que seria perdido. Em vez de remover, `McuComponent` passou a DELEGAR pra `McuController` (unificação de verdade, não duplicação) | `McuComponent.hpp/.cpp`, `McuController.hpp/.cpp` |
| 8 | D16 — `PluginLoader::scanDirectory`/`verifyChecksum` stubs | 🔄 **Parcial, com correção de responsável**: o carregamento real saiu do lugar errado (`CoreApplication.cpp`) e virou `GlobalPluginCache::loadLibrary` — não `PluginLoader::scanDirectory` como o plano original sugeria, porque só `GlobalPluginCache` tem `loader()`+`metadata()`+os mapas `setActive*Module` juntos (`PluginLoader` sozinho não tem acesso a isso, e não deveria ganhar — quebraria seu escopo deliberadamente estreito). `verifyChecksum` continua stub — fora do escopo desta rodada | `GlobalPluginCache.hpp` |
| 9 | D14 — duas formas de JSON de "fio" | ⏸️ **Adiado** — exige coordenação com a Extension (TypeScript), escopo cross-cutting maior que o resto desta rodada | Sem mudança |
| 10 | D5/D6 — `property()` sem overload string / pin helpers duplicados | ⏸️ **Adiado** — mecânico, baixo risco, mas baixo valor (já ranqueado 🟢 Baixa); priorizado abaixo dos itens 1-8 | Sem mudança |

**Resumo de verificação**: `ctest -C Debug`/`-C Release` — **34/34** (era 32/32; +2:
`mcu_crash_resilience`, `property_definition`). Extension não tocada nesta rodada — confirmado por
busca (nenhum símbolo removido/alterado é referenciado do lado TypeScript). 2 ADRs novos (0010,
0011). `.spec/lasecsimul.spec` §6.1.5 e `.spec/lasecsimul-native-devices.spec` §24 atualizados.

**O que ficou de fora nesta rodada, e por quê** (não é esquecimento — decisão explícita registrada):
- Unificação da forma JSON de "fio" — cross-cutting com a Extension.
- `verifyChecksum` real (SHA-256 contra `library.json`) — não crítico, fora do escopo priorizado.
- Ver §17 (abaixo) — migração completa e LeakageGuard, inicialmente adiados aqui, foram
  implementados numa rodada seguinte, a pedido explícito do usuário.

---

## 17. Segunda rodada de implementação (2026-07-09) — migração completa + LeakageGuard

Pedido do usuário: "migre os outros ~20 built-ins com o padrão novo e acabe com o padrão antigo não
se preocupe com compatibilidade... e trabalhe no LeakageGuard centralizado". Os dois itens que a
seção 16 tinha deixado explicitamente de fora (item 1 parcial, item 4 adiado) foram fechados por
completo nesta rodada.

### 17.1 Migração completa dos built-ins pro `PropertyDefinition`

**Todos os 25 arquivos** que ainda tinham o padrão antigo (`static propertySchema()` +
`propertyDescriptors()` de instância reescrevendo schema) foram migrados — não sobra nenhum
`descriptor.schema = schemas[N]` (acoplamento posicional) em `core/src/components/`. Lista completa:
`Resistor`/`Probe` (já feitos na rodada anterior) + `Rail`, `FixedVolt`, `DcVoltageSource`,
`Battery`, `VoltSource`, `CurrSource`, `Clock`, `WaveGen`, `Csource` (sources/), `Capacitor`,
`Inductor` (passive/), `Button` (logic/), `Diode` (active/, caso especial: schema condicional por
`m_supportsBreakdown`, resolvido via `schemaById` em vez de índice fixo), `Keypad` (switches/, achado
ao migrar: `propertyDescriptors()` nunca preenchia `.schema` pra nenhuma das 3 propriedades editáveis
— `SimulationSession::setProperty` rejeitava `diodes`/`diodesDirection`/`pressedMask` com
`type_mismatch` mesmo com o tipo certo; corrigido como efeito colateral correto da migração),
`FreqMeter`, `Ampmeter`, `LogicAnalyzer`, `Oscope` (meters/), `OpAmp`, `AnalogMux`, `DiodeLegArray`
(active/), `ResistorArray` (passive/) — os últimos 4 também ganharam `leakagePinIndices()` (ver
17.2) — e as 8 classes-molde de `SimulideBuiltins.hpp` (`SimulideTwoPinResistor`,
`SimulidePotentiometer`, `SimulideSwitch`, `SimulideRelay`, `SimulidePassiveState`,
`SimulideDiodeLike`, `SimulideTransistorLike`, `SimulideVoltageRegulator`) — os helpers
`detail::numberDescriptor`/`boolDescriptor`/`textDescriptor` (que já indexavam schema por posição,
mesma classe de risco do D2 original) viraram `detail::numberProperty`/`boolProperty`/`textProperty`
(devolvem `PropertyDefinition`, validados via `validatePropertyValue`).

`SimulidePassiveState` é a exceção documentada: sua tripla iteração sobre `m_schemas` (construtor,
`properties()`, `currentProperties()`) foi PRESERVADA como estava — é uma lista de propriedades
genuinamente dinâmica (tamanho/tipos só conhecidos em runtime), não o mesmo problema estrutural que
`PropertyDefinition` resolve para classes com propriedades nomeadas e conhecidas em tempo de
compilação. Migrar `propertyDescriptors()` pra usar `PropertyDefinition`/`validatePropertyValue`
ainda trouxe benefício real (validação uniforme), só não elimina a tripla iteração em si (seria uma
mudança arquitetural mais profunda, fora do que foi pedido).

**Fábricas em `CoreApplication.cpp`**: só `passive.resistor`/`meters.probe` (as que já tinham o bug
real) foram convertidas pra `propertyOrDefault` nesta rodada e na anterior. As demais ~25 fábricas
continuam com `p.property(name, default)` direto — D4 já não é mais possível para os componentes
migrados PORQUE `PropertyDescriptor::set` agora valida (`SimulationSession::setProperty`, caminho de
EDIÇÃO, sempre validou); o que falta é só a validação no caminho de CRIAÇÃO — gap menor que o
original (silêncio total) já que agora pelo menos o schema existe e é consistente, mas ainda seria
uma melhoria completar essa conversão nas fábricas restantes numa rodada futura, se desejado.

### 17.2 LeakageGuard centralizado

Implementado o mecanismo declarativo desenhado (mas não implementado) na seção 5.4/8 do relatório
original: `IComponentModel::leakagePinIndices()` (novo método virtual, default `{}` — vazio, zero
custo pra quem não usa) devolve os índices locais (dentro de `pins()`) que o componente quer que o
FRAMEWORK garanta uma condutância mínima até a terra (`kLeakageGuardConductance = 1e-9`, movida pra
`IComponentModel.hpp`). `SimulationSession::settleStep()` aplica isso logo depois de `stamp()`
retornar (nunca antes, nunca dentro) via `view.addConductanceToGround(...)`, no MESMO
`ComponentMatrixView` já em uso (delta-stamping, mesmo `commit()` de sempre).

Diferente da ideia original de detecção automática ("diagonal zero após stamp"), que a seção 8 do
relatório tinha marcado como risco 🔴 alto (poderia mascarar erro de fiação real do usuário em
QUALQUER componente), o mecanismo implementado é **deliberadamente opt-in**: só o componente que
CHAMA `leakagePinIndices()` com uma lista não-vazia ganha a rede de segurança — um pino sem estampa
nenhuma que o componente não declarou continua produzindo "sistema singular" de verdade. Isso fecha
o risco identificado sem abrir mão do mecanismo.

`OpAmp` (`powerPos`/`powerNeg`, 2 índices fixos), `AnalogMux` (`en` + todo `addr-*`, recomputado
sempre que `channels` muda), `DiodeLegArray` e `ResistorArray` (TODOS os pinos, computado uma vez no
construtor) tiveram seu `matrix.addConductanceToGround(pin, kLeakageConductance)` manual REMOVIDO de
dentro do próprio `stamp()` — a constante local `kLeakageConductance` de cada uma das 4 classes foi
eliminada, substituída pela única `kLeakageGuardConductance` central.

**Verificação de que o comportamento elétrico não mudou**: `inert_components_fix_test.cpp` (já
existente, testa exatamente estes 4 componentes com pinos parcialmente fiados — o cenário que motivou
o padrão manual original) continua passando sem nenhuma alteração no próprio teste, Debug e Release.

### 17.3 Verificação

`ctest -C Debug`/`-C Release`: **34/34** (mesma contagem da rodada anterior — nenhum teste novo
necessário, os já existentes já cobrem o comportamento elétrico; `property_definition_test` já
cobria `Probe`/`Resistor`, que usam exatamente o mesmo mecanismo agora aplicado às outras 23
classes). Dois builds completos (Debug + Release) limpos, sem warning novo.

---

## 18. Terceira rodada de implementação (2026-07-09) — verifyChecksum real, fábricas restantes, unificação de JSON de fio

Pedido do usuário: "O que ficou de fora, registrado explicitamente: unificação da forma JSON de
'fio' (cross-cutting com a Extension), verifyChecksum real, e a conversão das ~23 fábricas restantes
em CoreApplication.cpp para propertyOrDefault". Os 3 itens que a seção 16 tinha deixado
explicitamente de fora (linhas 672, 682 e o parágrafo de 724-730) foram fechados nesta rodada.

### 18.1 Conversão das ~23 fábricas restantes para `propertyOrDefault`

Todas as fábricas de `registerBuiltinComponents` (`CoreApplication.cpp`) que ainda liam a
propriedade de criação via `p.property(name, literal)` (sem passar pelo schema/validação, mesma
classe de risco do D4 original) foram convertidas para `propertyOrDefault(p.properties,
schemaById(schemas, "..."))`: `passive.capacitor`, `passive.inductor`, `sources.dc_voltage`,
`active.diode`, `logic.button`, `passive.variable_resistor`/`resistor_dip`/`potentiometer`/
`electrolytic_capacitor`/`variable_capacitor`/`variable_inductor`, `logic.push`/`switch`/
`switch_dip`, `switches.relay`/`keypad`, `active.diac`/`scr`/`triac`/`zener`, `active.bjt`/
`mosfet`/`jfet`, `active.opamp`/`comparator`/`analog_mux`/`volt_regulator`, `outputs.led`/
`led_matrix`/`dc_motor`/`stepper`/`incandescent_lamp`, `sources.battery`/`rail`/`fixed_volt`/
`voltage_source`/`current_source`/`controlled_source`/`clock`/`wave_gen`, `meters.ampmeter`/
`freqmeter`/`logic_analyzer` (`meters.probe`/`passive.resistor` já tinham sido convertidos numa
rodada anterior). Só 2 leituras continuam com `p.property()` direto (`Diode::thermalVoltage`,
`WaveGen` além de `freqHz`) — não têm `PropertySchema` dedicado; documentado como gap
pré-existente separado, fora deste escopo.

Três divergências reais entre o default declarado no schema e o literal que a fábrica de fato usava
foram achadas e corrigidas durante a conversão (a conversão ingênua teria preservado ou mascarado o
bug em vez de corrigi-lo):
- `outputs.dc_motor`/`outputs.incandescent_lamp` registravam metadados com
  `Resistor::propertySchema()` (default 1000Ω) enquanto a fábrica literal usava 10.0Ω/100.0Ω —
  criados `dcMotorSchema`/`incandescentLampSchema` dedicados, com o default fisicamente correto,
  usados tanto pelo registro de metadados quanto por `propertyOrDefault`.
- `sources.fixed_volt`: `FixedVolt::propertySchema()` declarava `out.defaultValue = false`, mas a
  fábrica real e todo teste que instancia o componente (5 arquivos) esperavam `true` — corrigido no
  schema (a fonte com evidência esmagadora do lado correto), não na fábrica.
- `registerSwitchLike` (`push`/`switch`/`switch_dip`) usava
  `SimulideSwitch::propertySchemaFor(typeId)` — um SUBCONJUNTO por typeId (2 campos pra
  switch/switch_dip, 5 pra push) — como fonte pra TODOS os campos do construtor, que sempre precisa
  dos 5 independente do typeId; `schemaById` caía no fallback (`valueKind` string) pros campos
  ausentes do subconjunto, e `std::get<double>()` no default lançaria `bad_variant_access`. Corrigido
  usando `SimulideSwitch::pushPropertySchema()` (o superset completo) como fonte de validação de
  construção pra todos os 3 typeIds.

### 18.2 `verifyChecksum` real (SHA-256)

Implementado `lasecsimul::Sha256` (`core/include/lasecsimul/Sha256.hpp`) — FIPS 180-4 autocontido,
sem dependência externa, `update()`/`finalizeHex()`/`reset()`/`hashFile()` estático (lê em blocos de
64KB, nunca carrega o arquivo inteiro na memória). Verificado contra os vetores oficiais do NIST
(string vazia, `"abc"`, string de 56 bytes que cruza o padding de bloco) mais dois testes próprios
(acúmulo entre chamadas pequenas de `update()`, reuso via `reset()`) — `sha256_test`, 5/5.

`PluginLoader::verifyChecksum` deixou de ser um stub `return true;` incondicional:
```cpp
bool verifyChecksum(const std::filesystem::path& binaryPath, const std::string& expectedSha256Hex) {
    if (!looksLikeSha256Hex(expectedSha256Hex)) return true; // opt-in: ausente/placeholder = pula
    const std::string actual = Sha256::hashFile(binaryPath);
    if (actual.empty()) return false;
    return /* comparação case-insensitive */;
}
```
`loadDevicePlugin`/`loadMcuPlugin` ganharam um parâmetro `expectedSha256Hex` (default `{}`, mesma
semântica opt-in). `GlobalPluginCache::loadLibrary` extrai `library["checksums"]` uma vez e repassa
pra `loadDeviceEntry`/`loadMcuEntry`, que computam a chave (`std::filesystem::relative(binaryPath,
libraryDir)`) e buscam o hash esperado antes de chamar o loader — mesmo padrão de "ausência não é
erro" que o resto do sistema de propriedades já usa.

`devices/library.json`/`mcu-adapters/library.json` tinham chave stale (`build/win-x64/device.dll`,
não batia com o `nativeEntry` real do manifesto, `build-msvc/device.dll`) e valor placeholder
(`"PREENCHER_NO_BUILD_SHA256"`) — corrigidos para a chave real e o SHA-256 de verdade dos binários
compilados localmente.

**Cobertura de teste nova** (`plugin_checksum_test`, 13 asserções) — nenhum teste existente chamava
`GlobalPluginCache::loadLibrary()` nem passava um hash esperado pra `loadDevicePlugin`/
`loadMcuPlugin`, então a checagem em si não tinha nenhuma cobertura antes deste teste: hash correto
aceita, hash errado (1 char adulterado) rejeita com `runtime_error`, string vazia e placeholder não-
hex pulam a checagem, comparação case-insensitive, `GlobalPluginCache::loadLibrary` contra
`devices/library.json`/`mcu-adapters/library.json` REAIS de produção (prova que a chave relativa
computada bate com a chave gravada), e um `library.json` sintético (apontando via `nativeEntry`
absoluto pro mesmo binário real) com hash corrompido — prova que a rejeição se propaga pelo fio
completo `loadLibrary` → `checksumFor` → `loadDeviceEntry` → `loadDevicePlugin`, não só a chamada
direta. Pula graciosamente (`exit 0`) se os binários de `example-blinker`/`espressif-esp32` não
foram compilados ainda (`npm run build:devices`), mesmo padrão de `plugin_loader_real_dll_test`.

### 18.3 Unificação da forma JSON de "fio" (D14 fechado)

Duas formas de JSON pra mesma entidade lógica coexistiam: IPC ao vivo (`connectWire`/
`disconnectWire`) usava forma achatada (`componentA`/`pinIdA`/`componentB`/`pinIdB`); manifesto
`.lssubcircuit` (`wires[]`) usava forma aninhada (`from:{componentId,pinId}`/`to:{...}`) — e o
próprio Core tinha DOIS parsers independentes pra elas (`registerSubcircuitFromManifestRich` e os
handlers IPC), não só a Extension.

Escolhida a forma aninhada como única (era o que a seção 15 já recomendava): já é o formato do
arquivo `.lssubcircuit`, já é o modelo interno de fio da Webview (`WebviewWireModel.from`/`.to`,
`coreLifecycle.ts`) e já é o que `.spec/lasecsimul-subcircuits.spec` documenta — eliminar a forma
achatada, não escolher "a melhor" das duas do zero.

- `CoreApplication.cpp`: novo `parseWireEndpoints(wireJson, context)` (ao lado de
  `requiredString`/`requiredArray`) extrai `{fromComponentId, fromPinId, toComponentId, toPinId}` da
  forma aninhada; usado tanto pelo parser de `.lssubcircuit` quanto pelos handlers IPC
  `connectWire`/`disconnectWire` (que antes liam `payload.value("componentA", ...)` etc. diretamente).
- `extension/src/ipc/CoreClient.ts`: `connectWire`/`disconnectWire` mantêm a MESMA assinatura
  TypeScript (4 parâmetros posicionais) — só o payload que montam internamente mudou de
  `{componentA, pinIdA, componentB, pinIdB}` para `{from:{componentId,pinId}, to:{componentId,
  pinId}}`. Como `coreLifecycle.ts` já chamava esses métodos com `wire.from.pinId`/`wire.to.pinId`
  desmembrados, os 3 call sites (`pushWireToCoreNow`, `pushRemoveWireToCore`,
  `rebuildCoreFromSchematicStateNow`) não precisaram de nenhuma mudança.
- `core/test/core/CoreBootstrapTest.cpp`: os 7 `send("connectWire", {...})` que montavam a forma
  achatada diretamente (teste de IPC real, não passa pelo `SimulationSession` C++) migrados pra
  forma aninhada.

Nenhuma forma de compatibilidade dupla foi mantida — o projeto está em fase beta (autorização
explícita do usuário em rodada anterior desta mesma sessão), então a forma achatada foi removida por
completo, não deprecada.

### 18.4 Verificação

`ctest -C Debug`/`-C Release`: **34→36/36** (+2: `sha256`, `plugin_checksum`; nenhum teste existente
precisou de asserção nova além dos 7 call sites de `CoreBootstrapTest.cpp` já contados dentro do
teste `core_bootstrap`, que também exercita `parseWireEndpoints` via IPC real). Extension: `tsc`
limpo (`npm run compile`, main + webview) e `npm test` — **15 suítes, 175 asserções, 0 falhas**,
incluindo `symbolAuthoring`/`simulideSceneTranslator` que dependem indiretamente do mesmo
`WebviewWireModel.from`/`.to` agora espelhado 1:1 pela IPC.

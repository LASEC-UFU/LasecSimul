# LasecSimul — Sistema de Dispositivos Customizados Nativos (DLL/SO) (v0.1)

Status: rascunho inicial | Depende de: [`.spec/lasecsimul.spec`](./lasecsimul.spec) (v0.2+) | Substitui: `lasecsimul-wasm-devices.spec` (superseded)

---

## 0. Relação com a especificação principal e decisão de design

Este subsistema é a forma **exclusiva** de estender o LasecSimul Core com novos dispositivos e adaptadores
de MCU sem recompilá-lo. Decisão registrada na conversa de design (substitui a abordagem WASM v0.1):

- **Todo** dispositivo — built-in ou de terceiros — é carregado em processo (`LoadLibrary`/`dlopen`), nunca em
  worker/sandbox separado. Um plugin chamado pelo `MnaSolver` custa exatamente o mesmo que um componente
  compilado no Core (chamada de função direta, sem serialização, sem fila, sem cosimulação assíncrona).
- **Arquitetura-alvo**: o caminho de plugin/ABI deixa de ser “extensão de terceiros” e passa a ser o modelo
  canônico de componente executável do projeto. Built-ins elétricos específicos que existirem durante o
  bootstrap são transitórios; o crescimento do catálogo deve acontecer por manifesto + ABI, não por
  proliferação de classes hardcoded no Core.
- **Não há sandbox de memória nem de capacidades.** Esta é uma troca deliberada: velocidade nativa em troca
  de isolamento. A mitigação não é técnica (não existe equivalente à memória linear do WASM), é de processo:
  confiança declarada por publisher + verificação de integridade + consentimento explícito do usuário antes
  do primeiro carregamento (seção 12) + contenção de falha best-effort via SEH no Windows (seção 13).
- Quem precisa de garantia de isolamento de memória para código não confiável **não tem essa opção neste
  sistema** — essa troca foi avaliada e descartada em favor de simplicidade e desempenho máximo.

## 1. Arquitetura geral do sistema de plugins

> **Correção de design (revisão pós-review)**: "loaded code" e "per-instance state" são responsabilidades
> de objetos diferentes — `PluginModule` (binário carregado, compartilhado, com refcount) e `PluginInstance`
> (estado de uma colocação no esquemático). A versão anterior desta seção conflava as duas dentro de
> `NativeDeviceProxy`, o que não dava um dono claro para "quando é seguro `FreeLibrary`". Corrigido abaixo.
> Por consequência, `PluginLoader` (descoberta/validação/load) também foi separado de `PluginRuntime`
> (ciclo de vida de instância, fault state) — eram a mesma classe antes, com responsabilidades misturadas.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ LasecSimul Core (processo único, nativo)                                │
│                                                                          │
│  GlobalPluginCache (processo-wide, somente leitura após o load)        │
│   ├─ PluginLoader: descobre/valida ABI/LoadLibrary → produz PluginModule│
│   ├─ unordered_map<typeId,  shared_ptr<PluginModule>> (versão ativa)    │
│   ├─ unordered_map<chipId,  shared_ptr<PluginModule>> (versão ativa)    │
│   └─ ComponentMetadataRegistry (schema de pinos/propriedades/ícone)     │
│                              │ shared_ptr<PluginModule> (refcount)      │
│                              ▼                                          │
│  PluginRuntime (por SimulationSession) ─ cria/destrói PluginInstance   │
│   stamp()/postStep() — chamada direta   ┌──────────────┐               │
│   MnaSolver ───────────────────────────►│ IComponentModel│ implementado por:
│   Scheduler ◄──── valores de nó/pino ───│               │  • classe compilada no Core, OU
│                                          └──────┬───────┘  • NativeDeviceProxy (PluginInstance)
│                                                 │ delega via vtable C, módulo mantido vivo por shared_ptr
│                                     ┌───────────▼────────────┐
│                                     │  LsdnDeviceVTable*       │
│                                     │  (struct de ponteiros   │
│                                     │   de função, ABI C)     │
│                                     └───────────┬────────────┘
└─────────────────────────────────────────────────┼────────────────────────┘
                                       LoadLibrary/dlopen (mesmo processo)
                                      ┌───────────▼────────────┐
                                      │  device.dll / device.so  │
                                      └─────────────────────────┘
```

| Módulo (Core) | Responsabilidade única |
|---|---|
| `PluginModule` (`core/src/plugins/`) | Código carregado de **um** binário: handle de `LoadLibrary`/`dlopen` + vtable C. Vive em `shared_ptr`; `FreeLibrary`/`dlclose` só no destrutor, quando a última referência cai — nunca enquanto existir `PluginInstance` viva. |
| `PluginLoader` (`core/src/plugins/`) | Descobre bibliotecas (`library.json`), valida manifesto e ABI (versão, exports não-nulos), `LoadLibrary`/`dlopen`, devolve um `PluginModule`. **Não** cria instância nem registra factory — só carrega código. |
| `GlobalPluginCache` (`core/src/plugins/`) | Estado compartilhado entre sessões (hoje só existe uma, ver `lasecsimul.spec` seção 4): qual `PluginModule` é a versão ativa por `typeId`/`chipId`, metadados parseados. Único ponto onde um *versioned swap* (seção 3) é publicado. |
| `PluginRuntime` (por `SimulationSession`) | Cria/destrói `PluginInstance` a partir do `PluginModule` ativo no `GlobalPluginCache`; rastreia fault state e métricas por instância desta sessão. |
| `NativeDeviceProxy` (= `PluginInstance` de device) | Implementa `IComponentModel`; guarda `shared_ptr<PluginModule>` (mantém o código vivo) + `LsdnDevice*` (estado próprio). |
| `NativeMcuAdapterProxy` (= `PluginInstance` de MCU) | Implementa `IMcuAdapter`; mesmo padrão de `shared_ptr<PluginModule>` + handle próprio. |
| `ComponentMetadataRegistry` (`core/src/registry/`) | Schema de pinos/propriedades/ícone por `typeId`, **separado** do `ComponentRegistry` (factory) — UI consulta isto sem precisar de uma factory instanciável. |
| `CrashGuard` | Encapsula chamadas de plugin em SEH (Windows) / contenção best-effort (POSIX) (seção 13) |

`TrustStore` (lista de publishers confiáveis, decisão de consentimento) **não é um módulo do Core** — vive
inteiramente na Extension (ver seção 12, item 2). O Core só faz a *verificação mecânica* de integridade
(hash do binário == hash assinado no manifesto, seção 12 item 1) — política de confiança e UI de consentimento
nunca entram no processo nativo.

Baixo acoplamento: `PluginLoader` não conhece eletricidade nem sessão; `PluginRuntime` não conhece o conteúdo
do plugin, só sua vtable via `PluginModule`; `MnaSolver` não sabe se fala com um plugin ou um built-in — todos
via `IComponentModel` (DIP, igual à seção 11 do `lasecsimul.spec`).

## 2. Modelo de dispositivo customizado

Um dispositivo nativo é definido por:

1. **Manifesto** (`device.json`) — `typeId`, pinos, propriedades, barramentos, e o caminho do binário por
   plataforma/arquitetura. Única fonte de verdade sobre a interface elétrica perante o Core. Alimenta o
   `ComponentMetadataRegistry` independentemente de o binário carregar com sucesso. O mesmo arquivo também
   carrega o corpo/pinos visuais (bloco `package`, seção 21) — consumido só pela Extension, nunca pelo Core.
2. **Binário nativo** (`device.dll` / `device.so` / `device.dylib`) — implementa o comportamento via a vtable
   C de `device_abi.h`. Não declara pinos por conta própria; recebe os handles que o Core já resolveu do
   manifesto. Representado em runtime por **um único** `PluginModule` compartilhado por todas as instâncias.
3. **Estado runtime** — uma `PluginInstance` (`LsdnDevice*` + `shared_ptr<PluginModule>`) por componente
   colocado no esquemático; múltiplas instâncias do mesmo binário compartilham o `PluginModule`, cada uma com
   seu próprio `LsdnDevice*`.

```cpp
// core/src/plugins/PluginModule.hpp — código carregado, vida útil independente de qualquer instância
class PluginModule {
public:
    PluginModule(void* libraryHandle, const LsdnDeviceVTable* vtable, std::filesystem::path binaryPath)
        : m_libraryHandle(libraryHandle), m_vtable(vtable), m_binaryPath(std::move(binaryPath)) {}
    ~PluginModule(); // FreeLibrary/dlclose — só chamado quando o último shared_ptr<PluginModule> morre

    PluginModule(const PluginModule&) = delete; // não copiável: um handle de SO, um dono

    const LsdnDeviceVTable* vtable() const { return m_vtable; }

private:
    void* m_libraryHandle;
    const LsdnDeviceVTable* m_vtable;
    std::filesystem::path m_binaryPath;
};

// core/src/plugins/NativeDeviceProxy.hpp — PluginInstance: estado de UMA colocação no esquemático
class NativeDeviceProxy final : public IComponentModel {
public:
    NativeDeviceProxy(std::shared_ptr<PluginModule> module, LsdnDevice* handle, ComponentMeta meta)
        : m_module(std::move(module)), m_handle(handle), m_meta(std::move(meta)) {}

    const char* typeId() const override { return m_meta.typeId.c_str(); }
    std::span<Pin> pins() override { return m_meta.pins; }

    void stamp(MnaMatrixView& matrix) override {
        LsdnMatrixView view = toAbiView(matrix);
        m_faulted = !CrashGuard::call(m_meta.typeId, [&]{ m_module->vtable()->stamp(m_handle, &view); });
    }
    void postStep(uint64_t timeNs) override {
        if (m_faulted) return; // pinos já em alta impedância (seção 12) — não insiste numa instância falha
        m_faulted = !CrashGuard::call(m_meta.typeId, [&]{ m_module->vtable()->post_step(m_handle, timeNs); });
    }
    size_t getState(uint8_t* out, size_t cap) const override { return m_module->vtable()->get_state(m_handle, out, cap); }
    void setState(const uint8_t* in, size_t len) override { m_module->vtable()->set_state(m_handle, in, len); }
    ~NativeDeviceProxy() override { m_module->vtable()->destroy(m_handle); } // PluginModule só descarrega depois

private:
    std::shared_ptr<PluginModule> m_module; // mantém o binário vivo enquanto esta instância existir
    LsdnDevice* m_handle;
    ComponentMeta m_meta;
    bool m_faulted = false;
};
```

O `shared_ptr<PluginModule>` é o mecanismo inteiro do refcount — nenhuma contagem manual. Um *versioned swap*
(seção 3) troca qual `PluginModule` o `GlobalPluginCache` entrega para **novas** instâncias; instâncias já
criadas mantêm sua própria referência ao módulo antigo até serem destruídas, e só então ele descarrega.

`CrashGuard::call` é o único lugar onde o Core paga um custo extra por chamada de plugin (um `__try/__except`
no Windows é essencially gratuito quando nenhuma excecão ocorre — não há tax mensurável no caminho feliz).

## 3. Ciclo de vida

Dois ciclos de vida distintos, com donos distintos — esta separação é o que faz o *versioned swap* (abaixo)
funcionar sem arriscar `FreeLibrary` com código em uso.

**Ciclo do `PluginModule` (código), dono: `GlobalPluginCache`**
```
discover        PluginLoader varre biblioteca, lê device.json (a confiança/consentimento já aconteceu na
  │              Extension antes do IPC pedir este load — ver seção 12, item 2; TrustStore não é do Core)
verify          PluginLoader recalcula SHA-256 do binário e confere com o hash assinado no manifesto
  │             (defesa em profundidade — Core não confia ciegamente na Extension)
load            LoadLibrary/dlopen do binário da plataforma atual
  │
resolve         lsdn_get_vtable() — único símbolo resolvido por nome; valida abi_major/abi_minor
  │
publish         GlobalPluginCache::setActiveDeviceModule(typeId, module) — vira a versão ativa para
  │              NOVAS instâncias; nenhuma instância existente é tocada (versioned swap, ver abaixo)
  ▼
unload          ~PluginModule (FreeLibrary/dlclose) — só quando o último shared_ptr (a última
                 PluginInstance que o referenciava) for destruído. Pode ser muito depois do swap.
```

**Ciclo da `PluginInstance` (estado), dono: `PluginRuntime` da sessão**
```
create          PluginRuntime pede o PluginModule ativo ao GlobalPluginCache, chama
  │              vt->create(host_ctx, &host_api) -> LsdnDevice*
init            vt->init(handle) — lê propriedades via host_api->get_property_f32, declara pinos
  │
┌─► running     vt->stamp() quando "dirty" · vt->post_step() se registrado como dinâmico · vt->on_event()
│   │
│   pause/resume  Scheduler para/retoma chamadas de post_step (sem destruir a instância)
└───┘
  │
serialize       vt->get_state(handle, buf, cap) — ao salvar o projeto
deserialize     vt->set_state(handle, buf, len)  — ao abrir o projeto
  │
destroy         vt->destroy(handle) — ao remover o componente; libera a referência ao PluginModule
```

Estado `faulted` (seção 12/13) é terminal para a instância afetada; não implica descarregar o binário se
outras instâncias dele continuam saudáveis.

### Versioned swap (substitui "hot-reload por plugin")

Descarregar um binário com instâncias vivas apontando para suas páginas de código é use-after-free de código,
não uma simplificação aceitável — por isso este sistema **nunca** descarrega um `PluginModule` para recarregar
uma versão nova. Em vez disso:

1. Nova versão do binário é carregada como um `PluginModule` **novo e independente** (passo `load` acima),
   sem tocar no módulo antigo.
2. `GlobalPluginCache::setActiveDeviceModule(typeId, novoModule)` publica a troca — toda **nova** instância
   criada a partir de agora (em qualquer `SimulationSession`) usa o módulo novo.
3. Instâncias já existentes continuam com o `shared_ptr<PluginModule>` antigo que já capturaram — nunca são
   migradas, nunca são interrompidas. Convivem v1 e v2 em memória até cada instância v1 ser destruída
   normalmente (remoção do componente, fechamento do projeto).
4. Quando a última instância v1 morre, o `shared_ptr` zera e `~PluginModule` descarrega o binário v1 — sem
   coordenação explícita, é só destrutor de `shared_ptr`.

Não há "migração de estado v1 → v2" automática — se o autor do plugin mudou o layout de `get_state`/
`set_state` de forma incompatível, instâncias antigas continuam rodando v1 até serem recriadas pelo usuário.

## 4. API pública para criação de dispositivos (ABI)

Fronteira **100% C** — nenhum tipo C++ (sem STL, sem exceções, sem RTTI) cruza o limite da DLL/SO, exatamente
para evitar o problema clássico de ABI C++ instável entre compiladores/versões. Regras fixas:

- Linkage `extern "C"`, calling convention padrão da plataforma (`__cdecl` no Windows, SysV no Linux/macOS).
- Structs `Lsdn*` só com tipos POD de tamanho fixo (`uint32_t`, `int32_t`, `float`, `uint64_t`, ponteiros
  opacos) — sem `#pragma pack` implícito, campos ordenados por tamanho decrescente.
- Único símbolo exportado por binário: `lsdn_get_vtable`. Tudo o resto é resolvido através da struct retornada
  — isso elimina problemas de export/mangling em qualquer função além dessa.
- Versionamento semântico via `abi_major`/`abi_minor`: bump de minor = host ganhou função nova em
  `LsdnHostApi` (compatível com plugins antigos); bump de major = mudança incompatível.

### 4.0.1 Metamodelo único de componente

O contrato canônico de componente executável do LasecSimul passa a ser um conjunto único de metadados:

- identidade: `typeId`, `name`, `category`, `folderPath`, `icon`;
- interface elétrica: `pins[]`, `buses[]`;
- propriedades: `properties[]` com schema tipado;
- pacote visual: `package`;
- execução: `nativeEntry`, `limits`, ABI version.

O mesmo modelo deve servir para:

- UI/paleta;
- editor de propriedades;
- serialização de projeto;
- carregamento de plugin;
- instância runtime no Core.

Host e Core não podem manter um schema “rico” só para built-ins e outro “pobre” para plugins. O manifesto
de plugin deve ser suficiente para o host renderizar e editar o componente sem conhecimento hardcoded do tipo.

### 4.1 Ownership de memória e thread-affinity (regras obrigatórias, não documentação opcional)

A intenção da ABI já era clara; o que faltava era deixar isto inequívoco — qualquer função nova adicionada à
ABI segue estas regras por padrão, sem precisar repeti-las:

- **Buffers de saída são sempre pré-alocados pelo lado que lê.** Em `get_state(dev, out, cap)`: quem chama
  aloca `out`/`cap`; quem é chamado só escreve até `cap`, nunca realoca nem faz `free` do buffer do chamador.
  Nenhuma função desta ABI transfere ownership de memória heap-alocada através da fronteira.
- **Ponteiros passados como parâmetro (`const char*`, `const uint8_t*`) só são válidos durante a chamada.**
  Nem host nem plugin podem reter um ponteiro recebido como argumento depois que a função retorna — quem
  precisa do dado depois deve copiá-lo antes de retornar. Isso vale para `log(ctx, level, msg)`,
  `set_property(dev, key, value)`, etc. — inclusive a string retornada por `pin_name(host_ctx, index)`.
- **Strings retornadas por valor em structs (`LsdnQemuLaunchSpec.binary`/`.args`) devem apontar para memória
  estática ou de vida igual à instância** (ex: `static const char*` ou campo de `LsdnDevice`) — o host as lê
  imediatamente após a chamada e não as copia ali; se precisar reter, copia antes do próximo passo do
  `Scheduler`. Plugin nunca deve apontar para um buffer de pilha que já saiu de escopo.
- **Thread-affinity**: toda função de `LsdnHostApi` só pode ser chamada de dentro de uma chamada da vtable
  que o **próprio host** iniciou (`stamp`/`post_step`/`on_event`/etc.), na thread em que o host fez essa
  chamada. Um plugin que cria sua própria thread (não recomendado — ver `submit_task`, seção 6) **nunca**
  pode chamar `LsdnHostApi` a partir dela de forma concorrente com uma chamada já em andamento na thread do
  host para a mesma instância — isso é condição de corrida sobre o estado do `Netlist`, não comportamento
  indefinido "talvez aceitável". Se um plugin precisa de trabalho em background, usa `submit_task`, cujo
  callback o Core garante executar de forma serializada com as demais chamadas daquela instância.

```c
// include/lasecsimul/device_abi.h
#pragma once
#include <stdint.h>

#define LSDN_ABI_VERSION_MAJOR 3
#define LSDN_ABI_VERSION_MINOR 0
/* Changelog (git log é a fonte completa, isto é só orientação rápida):
 * Major 2: removidos bus_attach/bus_write/bus_read de LsdnHostApi e LSDN_EVT_BUS_WRITE/
 *          LSDN_EVT_BUS_READ_REQUEST de LsdnEventTag — esse caminho (barramento por bytes, sem
 *          simular SDA/SCL/SCK reais) nunca foi ligado a um SimulationSession real.
 * Major 3: pin_write/pin_write_analog/pin_read/now_ns/schedule_event deixaram de ser stubs vazios
 *          e passaram a ser reais; pin_watch saiu (redundante — todo pino já recebe
 *          LSDN_EVT_PIN_CHANGE automaticamente); entrou pin_name. */

typedef struct LsdnDevice LsdnDevice; // opaco — só o plugin sabe o que tem dentro

typedef enum { LSDN_PIN_DIGITAL_IN, LSDN_PIN_DIGITAL_OUT, LSDN_PIN_DIGITAL_BIDIR,
               LSDN_PIN_ANALOG_IN, LSDN_PIN_ANALOG_OUT, LSDN_PIN_PWM_OUT, LSDN_PIN_POWER } LsdnPinKind;

typedef enum { LSDN_EVT_PIN_CHANGE = 1, LSDN_EVT_TIMER = 2 } LsdnEventTag;

typedef struct { uint32_t tag, a, b, c; } LsdnEvent;

typedef struct LsdnMatrixView {
    void* opaque;                                                    // ponteiro para a matriz real do Core
    void (*add_conductance)(void* opaque, uint32_t pinA, uint32_t pinB, double siemens);
    void (*add_voltage_source)(void* opaque, uint32_t pinA, uint32_t pinB, double volts);
    double (*get_node_voltage)(void* opaque, uint32_t pin);
} LsdnMatrixView;
```

### 4.2 Modelo canônico de propriedades na ABI

O formato atual (`get_property_f32`) é insuficiente para alcançar o mesmo espaço funcional do SimulIDE.
Ele cobre só leitura de `float` no `init` e não expressa enum, bool, texto, path, cor, ponto, grupo,
readonly, efeito em topologia, nem edição em runtime. Isso é um déficit conhecido da ABI atual e deve ser
tratado como trabalho obrigatório antes da expansão do catálogo.

#### 4.2.1 Tipos canônicos

Para simplificar, a ABI não replica os nomes históricos de widget do SimulIDE. O contrato único é:

- `number` → cobre `double`, `int`, `uint`;
- `string` → cobre `string`, `textEdit`, `enum`, `color`, `path`, `file`;
- `bool`;
- `point`.

O “tipo de valor” e o “modo de edição” são coisas separadas:

- `enum` = `string` + `editor="enum"` + `options[]`;
- `color` = `string` + `editor="color"`;
- `path`/`file` = `string` + `editor="path"` + `pathKind`;
- `textEdit` = `string` + `editor="textarea"`;
- `int`/`uint` = `number` + flags (`integerOnly`, `unsignedOnly`).

#### 4.2.2 Schema canônico — implementado (formato real, ver nota abaixo)

`device.json` é a fonte de verdade da forma estática da propriedade. Formato REAL parseado por
`parsePropertySchema`/`parsePropertySchemaList` (`CoreApplication.cpp`) — difere da sketch original desta
seção (corrigida agora): flags são booleanos individuais no objeto, não um array `flags: [...]`; opções são
objetos `{value, label}`, não dois arrays paralelos:

```json
{
  "id": "mode",
  "label": "Mode",
  "group": "General",
  "valueKind": "string",
  "editor": "enum",
  "default": "fast",
  "options": [
    { "value": "slow", "label": "Slow" },
    { "value": "fast", "label": "Fast" }
  ],
  "hidden": false,
  "readOnly": false,
  "noCopy": false,
  "affectsTopology": false,
  "requiresRestart": false,
  "showOnSymbol": false
}
```

Exemplo real em uso hoje — `devices/voltmeter/device.json` (`displayVoltage`, `editor: "display"`,
`readOnly`+`showOnSymbol`, alimenta o campo de leitura ao vivo no diálogo de propriedades) e
`devices/example-blinker/device.json` (`periodMs`, `editor: "number"`, `min`/`step`) — ambos com `group`
em português, mesma convenção dos built-ins (`Resistor`/`Capacitor`/etc., todos com `group: "Elétrica"`,
ver `lasecsimul.spec` seção 6.1.2).

Campos normativos mínimos por propriedade:

- `id`: chave estável em projeto/IPC/runtime;
- `label`: rótulo de UI — `LocalizedString` (seção 4.2.2.1), não só `string`;
- `group`: aba/seção lógica, equivalente ao `PropDialog` — também `LocalizedString`;
- `valueKind`: `number | string | bool | point`;
- `editor`: sugestão de apresentação (`text`/`number`/`checkbox`/`switch`/`select`/`enum`/`display`/...);
- `default`;
- flags booleanas individuais (todas opcionais, default `false`): `hidden`, `readOnly`, `noCopy`,
  `affectsTopology`, `requiresRestart`, `showOnSymbol`.

Campos opcionais conforme o caso:

- `unit` (símbolo técnico, ex: "Ω"/"V" — NÃO é `LocalizedString`, não se traduz);
- `min`, `max`, `step` (números, só fazem sentido com `valueKind: "number"`);
- `options[]` — cada item `{ "value": string, "label": LocalizedString }`.

##### 4.2.2.1 `language`/`translations` no manifesto — internacionalização

Todo `device.json` declara, na raiz, em que língua o autor escreveu os campos textuais visíveis e pode,
opcionalmente, fornecer traduções. Exemplo real em uso (`devices/voltmeter/device.json`):

```json
{
  "language": "pt-BR",
  "name": "Voltímetro DC (medição entre dois pontos)",
  "translations": {
    "en": {
      "name": "DC Voltmeter (two-point measurement)",
      "properties": { "displayVoltage": { "label": "Measured voltage", "group": "Reading" } }
    }
  }
}
```

- `language` (BCP-47) é **obrigatório** — sem ele o host não sabe em que língua está o texto simples do
  resto do manifesto. Um manifesto sem `translations` é válido: a UI mostra sempre na língua declarada,
  qualquer que seja a língua ativa do host (fallback final, nunca string vazia).
- Política do produto LasecSimul a partir desta revisão: todo `device.json` novo mantido pelo projeto
  MUST trazer base `pt-BR` e bloco `translations.en` já no primeiro commit; migrar depois deixa de ser
  aceitável.
- `translations.<lang>.properties.<id>.label`/`.group`/`.options` — subconjunto das mesmas propriedades,
  só o que o autor de fato traduziu; campo ausente cai pra `language` (a língua-base), não pra string
  vazia. **Implementado**: `CoreApplication.cpp::resolvePropertySchemaForLanguage`, acionado pelo
  payload `language` do verbo IPC `getPropertySchemas`.
- `translations.<lang>.name` é usado pela shell para nome de exibição do componente quando a origem do
  item vem de manifesto/registro ABI; isso vale também para subcircuitos e itens registrados.
- Resolução (mesmo algoritmo do lado Core e do lado Extension, detalhado em `lasecsimul.spec` seção
  6.3.3): língua ativa do host → `language`-base → primeira tradução disponível. Testado de ponta a
  ponta em `CoreBootstrapTest.cpp::testGetPropertySchemasOverIpc` (pt-BR/en/fr contra o voltímetro real).
- `translations.<lang>.pins.<id>` (rótulo de pino) continua reservado para a próxima extensão do contrato;
  o verbo `getPropertySchemas` hoje só devolve/resolve `propertySchema[]`, não `pins[]`.
- Especificação completa, motivação e precedente (SimulIDE-dev usa Qt Linguist/`.ts` pro mesmo problema)
  em `lasecsimul.spec` seção 6.3 e `docs/adr/0009-localizacao-de-strings-declarativas.md`.

#### 4.2.3 Runtime ABI obrigatório

Além do schema estático no manifesto, a ABI precisa de suporte genérico de runtime:

- host → plugin: `set_property(dev, property_id, value)` para edição após criação;
- host ← plugin: `get_property(dev, property_id, out_value)` para leitura do estado atual quando o valor
  efetivo puder divergir do configurado;
- plugin ← host: `config_get(host_ctx, property_id, out_value)` para bootstrap e releitura eventual da
  configuração persistida.

Regra: propriedade editável de plugin **não** pode depender de verbos especiais por tipo de componente.
Se um osciloscópio, voltímetro, regulador, display ou MCU auxiliar precisa de uma propriedade nova, ela entra
 pelo mesmo contrato genérico.

#### 4.2.4 Efeito estrutural da propriedade

O schema precisa carregar semântica suficiente para o Core saber o impacto da edição. Caso base (sem
nenhuma flag marcada): `setProperty` chama o setter e marca o componente dirty pro próximo re-stamp — não
existe uma flag `affectsSimulation` separada, porque isso já é o comportamento padrão de qualquer
propriedade. As flags existem pra declarar exceções a esse padrão:

- `affectsTopology`: exige reconstrução de netlist/grupos/conectividade, não só re-stamp;
- `requiresRestart`: a instância precisa ser reinicializada após a mudança;
- `readOnly`: valor visível, não editável.

Isso elimina o tratamento especial atual de casos como `Tunnel.name`: o comportamento especial continua
existindo, mas é declarado no schema, não escondido fora do mecanismo genérico. **Implementado**: as 6
flags (`hidden`/`readOnly`/`noCopy`/`affectsTopology`/`requiresRestart`/`showOnSymbol`) existem no
`PropertySchema` e viajam até a UI; `readOnly`/`hidden`/`showOnSymbol` já têm efeito real na Webview.
**Pendente**: `affectsTopology`/`requiresRestart` ainda não disparam nenhum comportamento no
`SimulationSession::setProperty` — são metadata exibida, não lógica — ver `lasecsimul.spec` seção 6.1.2.

## 5. Funções obrigatórias exportadas pelo binário (plugin)

| Export | Assinatura | Quando |
|---|---|---|
| `lsdn_get_vtable` | `(uint32_t* abi_major, uint32_t* abi_minor) -> const LsdnDeviceVTable*` | resolvido uma vez, no load |
| `vt->create` | `(void* host_ctx, const LsdnHostApi*) -> LsdnDevice*` | instanciação |
| `vt->init` | `(LsdnDevice*) -> void` | uma vez, após `create` |
| `vt->stamp` | `(LsdnDevice*, LsdnMatrixView*) -> void` | só quando "dirty" (topologia/propriedade mudou) |
| `vt->post_step` | `(LsdnDevice*, uint64_t time_ns) -> void` | só se o device se registrou como dinâmico |
| `vt->on_event` | `(LsdnDevice*, const LsdnEvent*) -> void` | pin-change, timer |
| `vt->get_state` / `vt->set_state` | buffers de serialização | salvar/abrir projeto |
| `vt->destroy` | `(LsdnDevice*) -> void` | remoção do componente |

Nenhuma função além dessas é necessária — novo tipo de evento usa um novo valor de `tag` em `LsdnEvent`, sem
crescer a vtable (OCP), igual ao desenho original do ABI WASM.

## 6. Funções fornecidas pelo simulador ao dispositivo (`LsdnHostApi`)

| Campo da vtable | Assinatura | Uso |
|---|---|---|
| `pin_declare` | `(ctx, index, kind, name) -> uint32_t` | registra pino do manifesto, retorna handle |
| `pin_write` / `pin_write_analog` | `(ctx, pin, level/volts) -> void` | dirige o próprio pino diretamente na matriz real (atalho ergonômico — equivalente a `stamp()` via `LsdnMatrixView`), nunca stub |
| `pin_read` | `(ctx, pin) -> int32_t` | tensão do próprio pino na última `stamp()` (cache, nunca dispara solve novo) |
| `pin_name` | `(ctx, index) -> const char*` | nome do pino (mesma ordem de `device.json` `pins[]`) — usado por device pra validar a ordem declarada bate com a esperada (ver `validate_pin_order()`) |
| `schedule_event` | `(ctx, delay_ns, event_id) -> void` | agenda `LSDN_EVT_TIMER`, real (não stub) |
| `config_get` | `(ctx, property_id, out_value) -> uint32_t` | lê configuração persistida do manifesto/projeto, em tipo genérico |
| `now_ns` | `(ctx) -> uint64_t` | tempo de simulação (determinístico) |
| `log` | `(ctx, level, msg) -> void` | aparece no Output do VSCode (via IPC até a Extension) |
| `submit_task` | `(ctx, fn, arg) -> void` | submete trabalho ao thread-pool do Core em vez do plugin criar sua própria thread (seção 11) |

Diferente do ABI WASM, **não há limitação de capacidade aqui** — o binário do plugin é código nativo com os
mesmos privilégios do processo Core (pode chamar qualquer API do SO diretamente). `LsdnHostApi` é a interface
*recomendada*, não uma fronteira de segurança — isso é uma consequência direta da decisão da seção 0, não um
descuido.

`get_property_f32` é considerado legado de transição e deve ser removido do caminho principal assim que
`config_get` + `set_property/get_property` estiverem disponíveis no ABI versionado.

## 7. Modelo de pinos digitais, analógicos, PWM e bidirecionais

Idêntico em semântica ao modelo já definido para o sistema WASM (mesmos sete `LsdnPinKind`), só que a tradução
para `stamp()` agora escreve **diretamente na matriz do Core** através de `LsdnMatrixView` — sem proxy
intermediário, sem cópia:

| Kind | Contribuição em `stamp()` |
|---|---|
| `DIGITAL_OUT` (alto/baixo) | fonte de tensão `Vlogic`/`0V` via `add_voltage_source` |
| `DIGITAL_OUT` (Z) | nenhuma chamada — nó fica a cargo do resto da rede |
| `DIGITAL_IN` | sem stamp; amostra `get_node_voltage`, compara a `Vth`, dispara `LSDN_EVT_PIN_CHANGE` |
| `ANALOG_OUT` | fonte de tensão no valor escrito por `pin_write_analog` |
| `ANALOG_IN` | sem stamp; lê a tensão real do nó |
| `PWM_OUT` | `"averaged"` (duty × Vlogic) ou `"edge-accurate"` (Scheduler reduz `Δt` localmente) — mesma opção do modelo anterior |
| `BIDIR` | direção corrente decide qual comportamento acima se aplica |
| `POWER` | referência; não participa de `stamp()` como sinal |

## 8. Modelo de comunicação I2C, SPI, UART e GPIO — decodificação bit a bit, sem módulo de barramento

**O desenho anterior desta seção (módulo de barramento genérico, `BusController`/`IBusParticipant`,
`I2cBusModule`/`SpiBusModule`) foi avaliado, implementado, testado, e descartado** — nunca chegou a ser
ligado a um `SimulationSession` real, só os próprios testes do subsistema o exercitavam. Foi substituído por
um mecanismo mais simples, construído e testado nesta sessão (2026-06-28):

- **GPIO**: conjunto de pinos digitais independentes (seção 7); sem alteração quando o pino é exposto como
  periférico de um MCU emulado.
- **I2C/SPI/UART**: decodificados **bit a bit pelo próprio device**, nunca por um módulo de barramento
  intermediário. `SimulationSession::settleStep()` detecta borda digital real (quando a tensão de um nó
  cruza `kDigitalLevelThreshold`, 2.5V, `core/include/lasecsimul/Types.hpp`) e dispara
  `ComponentEvent{kPinChangeEventTag, localPinIndex, nivel, nsDesdeABordaAnterior}` (que chega ao plugin como
  `LsdnEvent{LSDN_EVT_PIN_CHANGE, ...}` via `on_event`) para **todo** componente/pino presente naquele nó —
  built-in ou plugin, sem distinção, sem precisar de registro prévio (`pin_watch` foi removido por ser
  redundante com isso).
- Quem decodifica start/stop/ACK (I2C) ou shift bit-a-bit (SPI) é o **próprio device**, com a lógica que ele
  já precisa ter de qualquer forma para entender o protocolo — ver `devices/simulide-complex/src/lib.c`
  (`i2c_clock_bit`, `pcd8544_clock_bit`, `max_clock_bit`, `ws_edge`, etc.) como referência real de
  implementação.

Um sensor nativo e um adaptador de MCU (ESP32, por exemplo) conversam pelos mesmos `Pin`s reais do circuito —
nenhuma ponte dedicada plugin↔MCU é necessária, e nenhum dos dois lados sabe se quem está do outro lado do
fio é um MCU emulado ou outro componente.

**Regra de design**: `Netlist`/`Scheduler` resolvem **só** topologia/tempo — nunca um
`if (chipFamily == ...)`/`if (typeId == ...)`. Bugs reais achados decodificando protocolo bit a bit (lição
pra qualquer device novo que decodifique I2C/SPI por borda): `aip31068_i2c.json` tinha SCL/SDA trocados
(decodificava o protocolo errado silenciosamente); `ili9341.json` usava nomes de pino inconsistentes
(`mosi`/`rst` em vez de `sda`/`reset`). Mitigação adotada: `pin_name(host_ctx, index)` na ABI (seção 6) +
`validate_pin_order()` (chamado no `init()` de cada device em `devices/simulide-complex/src/lib.c`), que loga
erro se a ordem de pino declarada no `device.json` não bate com a esperada.

### 8.1 MCU emulado (QEMU) com periférico I2C/SPI do outro lado — módulo é chip-específico, não genérico

Pergunta recorrente ao descrever um device novo: "preciso de QEMU pra falar I2C/SPI com um chip?" — resposta
baseada no mecanismo real confirmado contra o fork QEMU (`C:\SourceCode\qemu_simulide`) e o SimulIDE atual
(`C:\SourceCode\simulide_2`), não suposição:

- **Sem MCU envolvido** (device fala I2C/SPI com outro device customizado ou built-in): nunca toca QEMU. Os
  dois lados decodificam o protocolo bit a bit via `LSDN_EVT_PIN_CHANGE`, como descrito na seção 8 acima.
- **Com um MCU emulado do outro lado**: o periférico I2C/SPI do MCU é, no QEMU usado, um conjunto de
  registradores cujos acessos da CPU emulada são exportados pra arena de memória compartilhada como
  endereço+valor **bruto, sem decodificação nenhuma** (`hw/gpio/esp32_gpio.c` do fork real confirma isso —
  QEMU nunca pré-decodifica). Quem dá significado ao registrador (`offset 0x04 = GPIO_OUT_REG`, por exemplo)
  é um `QemuModule` concreto do lado do Core (`core/include/lasecsimul/QemuModule.hpp`,
  `Esp32GpioModule` como exemplo hoje) — **achado crítico desta sessão: esse módulo é CHIP-ESPECÍFICO de
  propósito, não genérico reusado por qualquer chip.** Só `Scheduler`/`Netlist`/IPC/UI precisam ser neutros
  quanto a chip.
- `McuComponent` (`core/src/mcu/McuComponent.{hpp,cpp}`, `lasecsimul.spec` seção 8) é a peça que liga isso a
  pinos de circuito reais: despacha `SIM_READ`/`SIM_WRITE` pro `QemuModule` certo por endereço, e a cada
  `stamp()` traduz `isOutputEnabled`/`outputLevel` em estampa elétrica real. Uma vez que o sinal chega num
  `Pin` real do circuito, o resto (decodificação I2C/SPI por borda, seção 8 acima) funciona igual,
  MCU-emulado ou não — o device do outro lado do fio não distingue os dois casos.
- Periféricos I2C/SPI/USART reais do ESP32 (`Esp32TwiModule`/`Esp32SpiModule`/`Esp32UsartModule`) ainda não
  existem — só GPIO puro (`Esp32GpioModule`) está implementado hoje; também falta IOMUX/pin-matrix (tabela de
  512 entradas roteando periférico pra pino, `Esp32::createMatrix()` real) pra rotear qualquer periférico pra
  qualquer pino via firmware real. Ver `docs/17-pendencias-pos-sessao-qemu-abi.md`, seção 3.1, para os
  arquivos de referência reais a copiar fielmente quando esse trabalho acontecer.

## 9. Modelo de eventos

Igual à seção 9 do `lasecsimul-wasm-devices.spec`: `LsdnEvent { tag, a, b, c }`, entregue via `vt->on_event`.
Tags fixas (seção 4) cobrem pin-change e timer; protocolo de barramento é decodificado pelo device a partir
de eventos de pin-change (seção 8), não por uma tag própria. Novas tags não exigem nova função na vtable.

## 10. Scheduler de execução dos dispositivos

Não existe mais um scheduler dedicado a plugins — eles participam do **mesmo** `Scheduler` que os
componentes built-in (diferença estrutural chave em relação ao desenho WASM, que precisava de um scheduler
assíncrono próprio):

1. `NativeDeviceProxy` marca seu componente como "dirty" quando `pin_write`/`set_property` muda algo
   relevante — entra na changed-list do `Scheduler` (`lasecsimul.spec`, seção 7), igual a um `Resistor`.
2. `stamp()` roda inline, na mesma iteração do `MnaSolver`, sem atraso de um passo (sem cosimulação).
3. `post_step()` só é chamado para devices que se registraram como dinâmicos (capacitância interna, lógica
   temporal, amostragem) — devices puramente combinacionais nunca recebem `post_step`.
4. Ordem de chamada determinística: ordem de registro no netlist, igual ao Core inteiro.

## 11. Suporte a multitarefa, workers ou execução paralela

- O **Core** pode paralelizar internamente (`std::thread`/thread-pool) partes independentes do solver (ex:
  subcircuitos sem acoplamento) — isso é uma otimização interna do `MnaSolver`/`Scheduler`, opaca aos plugins.
- Um **plugin** pode criar suas próprias threads, mas o Core não as gerencia nem as sandboxa — risco e
  responsabilidade do autor do plugin. Para reduzir a necessidade disso, o host expõe `submit_task` em
  `LsdnHostApi` (seção 6): plugins bem-comportados submetem trabalho ao thread-pool do próprio Core em vez de
  criar threads não supervisionadas.
- Diferente do desenho WASM, não há isolamento "shared vs dedicated" por instância — todas as instâncias
  rodam no mesmo processo; o paralelismo real vem do thread-pool do Core, não de processos/workers por device.

## 12. Isolamento e prevenção de falhas

Sem sandbox de memória/capacidades (seção 0). As defesas disponíveis são, em ordem:

1. **Verificação de integridade no load**: SHA-256 do binário comparado ao hash assinado em `library.json`
   pelo publisher. Binário com hash divergente é rejeitado antes de `LoadLibrary`.
2. **Consentimento explícito por publisher** (`TrustStore`): primeiro carregamento de um publisher
   desconhecido dispara um diálogo na Extension — *"Este pacote contém código nativo sem isolamento e pode
   travar ou comprometer o simulador. Confiar em '<publisher>'?"* com opções **Bloquear** / **Permitir uma
   vez** / **Sempre confiar**. O Core só recebe a ordem de carregar via IPC depois desse consentimento — a
   decisão de confiança mora na Extension, não no Core.
3. **Validação estrutural do binário**: `lsdn_get_vtable` deve retornar todos os ponteiros de função
   não-nulos e a versão de ABI compatível; manifesto declara pinos/propriedades/barramentos e o `PluginLoader`
   rejeita incompatibilidade antes de instanciar.
4. **Contenção de crash em tempo de chamada** (`CrashGuard`, seção 13): no Windows, toda chamada a `stamp`/
   `post_step`/`on_event` é envolvida em SEH (`__try/__except`) — uma falha de acesso à memória dentro do
   plugin é capturada, a instância é marcada `faulted` (pinos passam a alta impedância) e **o processo Core
   continua rodando** para os demais componentes. Em POSIX (Linux/macOS), captura de `SIGSEGV` não é segura
   para continuar a execução (limitação conhecida e documentada da plataforma, não do LasecSimul) — a
   mitigação ali é o processo Core inteiro reiniciar (próximo item), não a recuperação granular por device.
5. **Reinício do processo Core com retomada de estado**: o Core salva snapshot periódico do projeto em
   memória compartilhada/disco temporário; se o processo cair (crash não contido, hang forçado a `kill`), a
   Extension detecta a queda, reinicia o Core e restaura o último snapshot, perdendo no máximo alguns
   segundos de simulação — essa é a rede de segurança final, sempre disponível independente de plataforma.

## 13. Limite de tempo de execução por dispositivo

**Não existe preempção segura de código nativo em loop infinito sem isolamento de processo** — isso é uma
limitação real, aceita na decisão da seção 0, não algo a esconder. O que é possível, em camadas:

1. **Convenção cooperativa**: o SDK documenta que loops longos dentro de `stamp`/`post_step` devem chamar
   `host_api->yield_check(ctx)` periodicamente; o host pode usar isso para abortar a chamada de forma limpa
   (lança uma falha controlada) se um orçamento de tempo foi excedido. Funciona para plugins bem-comportados;
   não funige nada contra um `while(true);` sem cooperação.
2. **Watchdog por thread dedicada**: cada chamada de plugin roda numa thread do pool reservado para isso; uma
   thread watchdog mede o tempo decorrido. Se exceder `stepTimeoutMs` (manifesto), o Core **não espera** —
   segue o macropasso com o último valor conhecido do device (igual ao zero-order hold do desenho anterior) e
   marca o device "lagging".
3. **Abandono da thread após N timeouts consecutivos**: a thread presa é desanexada (não usa
   `TerminateThread`/`pthread_cancel` — ambos inseguros, podem corromper heap/locks) e o device é marcado
   `faulted` permanentemente. Custo: aquela thread/núcleo fica ocupado para sempre enquanto o processo Core
   viver; um contador de threads abandonadas é exposto à UI para sugerir reinício do Core se acumular.
4. **Sem opção de "matar com segurança" um loop infinito dentro do mesmo processo** — a única forma
   verdadeiramente segura de interromper código nativo travado é a fronteira de processo (item 5 da seção
   12), que é exatamente o que esta arquitetura abriu mão de ter por padrão.

Manifesto continua declarando expectativas, agora como guia de UI/diagnóstico, não enforcement rígido:
```json
"limits": { "stepTimeoutMs": 4, "expectedComplexity": "low" }
```

## 14. Estrutura de pastas de uma biblioteca

```
my-device-library/
├── library.json                    # publisher, versão, licença, hash assinado de cada binário
├── devices/
│   └── my-led-matrix/
│       ├── device.json             # manifesto (seção 15)
│       ├── src/                    # fonte (C/C++/Rust), opcional no pacote final
│       │   └── lib.c
│       ├── build/
│       │   ├── win-x64/device.dll
│       │   ├── linux-x64/device.so
│       │   └── macos-universal/device.dylib
│       ├── icon.svg                # miniatura da paleta — diferente do corpo desenhado no canvas (seção 21.2)
│       └── README.md
├── test/                           # harness nativo (seção 19)
└── CMakeLists.txt                  # build multiplataforma
```

## 15. Exemplo de manifesto do dispositivo (`device.json`)

Inclui o bloco `package` (corpo + pinos visuais) — schema completo e justificativa na seção 21.

```json
{
  "schemaVersion": 1,
  "typeId": "community.my-led-matrix",
  "name": "8x8 LED Matrix (custom)",
  "abiVersion": { "major": 1, "minor": 0 },
  "nativeEntry": {
    "win32-x64": "build/win-x64/device.dll",
    "linux-x64": "build/linux-x64/device.so",
    "darwin-universal": "build/macos-universal/device.dylib"
  },
  "package": {
    "width": 80, "height": 80, "border": true,
    "background": { "kind": "color", "value": "#1a1a1a" },
    "shapes": [{ "kind": "text", "x": 8, "y": 14, "value": "8x8", "fontSize": 10, "color": "#ffffff" }]
  },
  "pins": [
    { "id": "din", "kind": "DIGITAL_IN",  "x": 0,  "y": 20, "angle": 180, "length": 8, "label": "DIN" },
    { "id": "clk", "kind": "DIGITAL_IN",  "x": 0,  "y": 60, "angle": 180, "length": 8, "label": "CLK" },
    { "id": "vcc", "kind": "POWER",       "x": 80, "y": 20, "angle": 0,   "length": 8, "label": "VCC" },
    { "id": "gnd", "kind": "POWER",       "x": 80, "y": 60, "angle": 0,   "length": 8, "label": "GND" }
  ],
  "properties": [
    {
      "id": "brightness",
      "label": "Brightness",
      "group": "General",
      "valueKind": "number",
      "editor": "text",
      "default": 1.0,
      "min": 0,
      "max": 1,
      "step": 0.01
    },
    {
      "id": "mode",
      "label": "Mode",
      "group": "General",
      "valueKind": "string",
      "editor": "enum",
      "default": "normal",
      "options": ["eco", "normal", "boost"],
      "optionLabels": ["Eco", "Normal", "Boost"]
    }
  ],
  "buses": [],
  "limits": { "stepTimeoutMs": 4, "expectedComplexity": "low" }
}
```

## 16. Exemplo de dispositivo simples em C nativo (blinker)

```c
#include "lasecsimul/device_abi.h"
#include <stdlib.h>

typedef struct { uint32_t pin_out; uint64_t acc_ns; int32_t level; } DeviceState;

static LsdnDevice* create(void* host_ctx, const LsdnHostApi* api) {
    DeviceState* s = (DeviceState*)calloc(1, sizeof(DeviceState));
    return (LsdnDevice*)s;
}
static void init(LsdnDevice* dev) { /* pino declarado pelo Core a partir do manifesto */ }
static void stamp(LsdnDevice* dev, LsdnMatrixView* m) { /* sem contribuição passiva */ }
static void post_step(LsdnDevice* dev, uint64_t dt_ns) {
    DeviceState* s = (DeviceState*)dev;
    s->acc_ns += dt_ns;
    if (s->acc_ns >= 500000000ULL) { s->acc_ns = 0; s->level = !s->level; /* host_api->pin_write(...) */ }
}
static void on_event(LsdnDevice* dev, const LsdnEvent* ev) {}
static uint32_t get_state(LsdnDevice* dev, uint8_t* out, uint32_t cap) { return 0; }
static void set_state(LsdnDevice* dev, const uint8_t* in, uint32_t len) {}
static void destroy(LsdnDevice* dev) { free(dev); }

static const LsdnDeviceVTable kVTable = {
    create, init, stamp, post_step, on_event, get_state, set_state, destroy
};

#if defined(_WIN32)
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
const LsdnDeviceVTable* lsdn_get_vtable(uint32_t* major, uint32_t* minor) {
    *major = LSDN_ABI_VERSION_MAJOR; *minor = LSDN_ABI_VERSION_MINOR;
    return &kVTable;
}
```

## 17. Exemplo de dispositivo com barramento I2C (sensor de temperatura customizado)

Sem `bus_attach`/módulo de barramento: o device decodifica START/STOP/ACK e bytes MSB-first ele mesmo, a
partir de `LSDN_EVT_PIN_CHANGE` nos pinos SDA/SCL (mesmo padrão real usado em
`devices/simulide-complex/src/lib.c` para AIP31068/SSD1306/SH1107 — ver seção 8). Versão simplificada,
ilustrativa:

```c
#include "lasecsimul/device_abi.h"

typedef struct { uint32_t pinSda, pinScl; int sclWasHigh; int started; uint8_t shiftReg; int bitCount;
                  float temperature_c; } DeviceState;

static void init(LsdnDevice* dev) {
    DeviceState* s = (DeviceState*)dev;
    s->pinSda = 0; s->pinScl = 1; /* índice local, validado contra pin_name() no init — ver seção 8 */
    s->temperature_c = 25.0f;
}
static void on_event(LsdnDevice* dev, const LsdnEvent* ev) {
    DeviceState* s = (DeviceState*)dev;
    if (ev->tag != LSDN_EVT_PIN_CHANGE) return;
    /* ev->a = pino local, ev->b = novo nível -- detecta START (SDA cai com SCL alto), shift de bit em
     * borda de subida de SCL, e responde ao endereço 0x48 escrevendo de volta via pin_write quando for
     * o byte de leitura -- decodificação completa fica no device real, isto é só a forma. */
}
// create/stamp/post_step/get_state/set_state/destroy/lsdn_get_vtable: mesmo padrão da seção 16
```

## 18. Processo de build, empacotamento e instalação

1. **Toolchains**: qualquer compilador C/C++/Rust capaz de gerar uma biblioteca dinâmica nativa para o
   triplo-alvo desejado (MSVC ou Clang/MinGW no Windows; GCC/Clang no Linux; Clang no macOS). Não é exigido o
   mesmo compilador do Core — a fronteira ABI (seção 4) é especificamente desenhada para tolerar isso.
2. **Exportação**: `extern "C"` + `__declspec(dllexport)` (Windows) ou
   `__attribute__((visibility("default")))` com `-fvisibility=hidden` global (Linux/macOS) — só
   `lsdn_get_vtable` fica visível, reduzindo colisão de símbolos entre plugins.
3. **`lasecsimul-cli build`**: invoca CMake com toolchain do alvo, introspecciona o binário resultante
   (`dumpbin /exports` / `nm -D`) para confirmar que só `lsdn_get_vtable` é exportado, grava
   `build/<plataforma>/device.{dll,so,dylib}` + checksum SHA-256 por arquivo.
4. **`lasecsimul-cli sign`**: grava no `library.json` o hash assinado (chave do publisher) de cada binário —
   base da verificação de integridade da seção 12. Assinatura de código do SO (Authenticode/codesign) é
   suportada como camada adicional opcional, não obrigatória no v0.1.
5. **Empacotamento**: pasta da biblioteca compactada. A descoberta em runtime é registrada no catálogo
  unificado do projeto (`LasecSimul/project/schema/component-catalog.json`, campo `deviceLibraries[]`),
  apontando para o `library.json` da biblioteca.
6. **Instalação**, descoberta pela Extension (não pelo Core diretamente) em três origens: `~/.lasecsimul/libraries/`,
   extensões VSCode instaladas, e `./lasecsimul-devices/` do workspace.
7. **Carregamento**: Extension verifica hash/publisher → se necessário, solicita consentimento do usuário
   (seção 12) → só então envia ao Core, via IPC, a ordem "carregar este binário, para este `typeId`" — o Core
   nunca decide confiança por conta própria, só executa.

## 19. Estratégia de testes

| Nível | Ferramenta | O que valida |
|---|---|---|
| Unitário (lógica) | testes nativos da linguagem-fonte (`ctest`/`cargo test`) no target nativo de teste | regra de negócio isolada da ABI |
| Unitário (ABI) | executável de teste que `LoadLibrary` o binário real e injeta estímulos via uma `LsdnHostApi` fake, capturando `pin_write`/`pin_write_analog` | comportamento fiel ao manifesto, fora do Core completo |
| Trace dourado | mesmo harness, modo `--golden` | regressão entre builds |
| Integração | `LasecSimul Core` headless (sem VSCode, sem QEMU) com netlist mínima carregando o plugin real | comportamento elétrico correto via `MnaSolver` real |
| Fault injection | harness dedicado: binário sem `lsdn_get_vtable`, com versão de ABI incompatível, que crasha em `init`, que trava em `stamp` | `PluginLoader` rejeita corretamente; `CrashGuard`/watchdog contêm sem derrubar o test runner |
| Conformidade | `lasecsimul-cli test` (roda os níveis acima) | gate obrigatório antes de publicar uma biblioteca |

Teste de fault injection é mais crítico aqui do que era no desenho WASM exatamente porque não há sandbox de
linguagem — a suíte de conformidade é a única coisa que detecta um plugin mal comportado antes de chegar ao
usuário final.

## 20. Integração com a extensão VSCode e com QEMU

**VSCode**:
- Descoberta de bibliotecas vem de `LasecSimul/project/schema/component-catalog.json` (`deviceLibraries[]`),
  não de `contributes` do host.
- Painel de propriedades e paleta de componentes gerados a partir do manifesto, como antes.
- Fluxo de consentimento (seção 12, item 2) é UI da Extension — modal nativo do VSCode, decisão persistida em
  `globalState` da extensão (lista de publishers confiáveis), nunca decidida pelo Core.
- Crash do Core (não contido) é detectado pela Extension (processo morreu) → reinício automático + restauro
  de snapshot (seção 12, item 5) → aviso ao usuário no Output, com o `typeId` do último device chamado antes
  da queda, quando recuperável (registrado pelo `CrashGuard` antes de cada chamada).

**QEMU**:
- **Adaptador de MCU é sempre plugin DLL/SO** (`mcu_abi.h`, `LsdnMcuVTable`, carregado via
  `NativeMcuAdapterProxy`) — não existe mais caminho built-in. Até 2026-06-28 só um adaptador built-in (C++
  compilado direto no Core) conseguia de fato decodificar registrador; nesta data `mcu_abi.h` bumpou para
  **major 2**: ganhou `LsdnQemuModuleVTable`/`LsdnQemuModuleHandle` e `LsdnMcuVTable::create_modules` —
  simétrico ao `QemuModule` C++ que só built-in tinha antes (resolve a pendência que a seção 3.4 do
  `docs/17-pendencias-pos-sessao-qemu-abi.md` deixou aberta). O ESP32
  (`mcu-adapters/espressif-esp32/`) foi migrado do built-in que existia (removido) pra esse plugin, provando
  paridade total de desempenho — `QemuModuleProxy` (`core/src/plugins/QemuModuleProxy.hpp`) embrulha o
  `LsdnQemuModuleHandle` do plugin numa subclasse de `QemuModule`, uma indireção de ponteiro de função C, no
  mesmo processo do Core, sem IPC — mesmo custo de uma chamada virtual C++ built-in.
- `create_modules` (novo na major 2) segue o mesmo protocolo de duas chamadas de `get_memory_regions`/
  `get_pin_map` (`cap=0` só pra contar). Cada `LsdnQemuModuleHandle` devolvido é CHIP-ESPECÍFICO de
  propósito — não existe módulo genérico (`I2cBusModule`/`SpiBusModule`/`GpioModule`) reusado entre chips;
  `write_register`/`read_register` são obrigatórias, `reset`/`is_output_enabled`/`output_level`/
  `set_input_level`/`destroy` são opcionais (`NULL` = no-op/"nunca dirige nada").
- `McuComponent` (`IComponentModel` real, `lasecsimul.spec` seção 8) é quem liga isso a pinos de circuito de
  verdade — nenhuma ponte dedicada device↔MCU é necessária: uma vez que o sinal chega a um `Pin` real, a
  decodificação de protocolo (I2C/SPI/UART) acontece pelo mesmo mecanismo bit a bit da seção 8 acima, sem
  custo de cosimulação, já que tudo roda no mesmo processo Core.

## 21. Modelo visual do dispositivo (package) e editor de UI

> Mecanismo de referência validado pelo `simulide_2`, não suposição — ver
> `C:\SourceCode\simulide_2\src\components\subcircuits\chip.cpp` (`initPackage`/`setPinStr`, campos
> `width`/`height`/`border`/`background`/`logic_symbol` e `xpos`/`ypos`/`angle`/`length`/`space`/`label`/`type`
> por pino) e `C:\SourceCode\simulide_2\src\components\other\subpackage.cpp` (`embeedBackground` — lê um
> arquivo de imagem e embute
> como bytes no próprio pacote, linha ~459-463). SimulIDE não tem um editor de pacote separado: reaproveita o
> editor de esquemático, com componentes só-gráficos (`components/graphical/{rectangle,ellipse,line,
> textcomponent,image}`) e um componente especial (`SubPackage`) que entra em "board mode" para
> redimensionar o corpo, clicar para adicionar pino, e fazer upload de uma imagem de fundo.

### 21.1 Por que isso cabe inteiramente em JSON, sem segundo formato

A pergunta era se isso exige um arquivo separado (ex: XML/SVG à parte). Resposta: não — SVG é texto, e o
próprio SimulIDE já embute a imagem de fundo como dado opaco dentro do pacote (`bckGndData`), não como
referência externa. O equivalente em JSON é trivial: o markup do SVG (ou um data URI, para raster) entra como
**string** num campo do mesmo `device.json`. Não há ganho em separar em outro arquivo — só risco de
referência pendente (o problema que o SimulIDE evita ao embutir).

### 21.2 Extensão do manifesto (`device.json`)

```json
{
  "...": "...campos já existentes (typeId, nativeEntry, properties, buses, limits)...",

  "package": {
    "width": 120,
    "height": 80,
    "border": true,
    "background": {
      "kind": "svg",
      "data": "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='80'>...</svg>"
    },
    "shapes": [
      { "kind": "rect", "x": 0, "y": 0, "w": 120, "h": 80, "stroke": "#000000", "fill": "none", "strokeWidth": 1 },
      { "kind": "text", "x": 10, "y": 16, "value": "U1", "fontSize": 12 },
      { "kind": "line", "x1": 0, "y1": 40, "x2": 120, "y2": 40, "stroke": "#888888" },
      { "kind": "ellipse", "cx": 60, "cy": 60, "rx": 8, "ry": 8, "stroke": "#000000", "fill": "none" }
    ]
  },

  "pins": [
    { "id": "out", "kind": "DIGITAL_OUT", "x": 0, "y": 20, "angle": 180, "length": 8, "label": "OUT" }
  ]
}
```

| Campo | Equivalente no SimulIDE | Observação |
|---|---|---|
| `package.width`/`height` | `Package; width=...; height=...` | área do corpo, em px (não em unidades de grade — escolha deliberada, mais direto que `8 * grid` do SimulIDE) |
| `package.border` | `border=true` | desenha contorno do retângulo do corpo |
| `package.background.kind` | implícito por extensão de arquivo | `"svg"` (markup inline) \| `"image"` (data URI base64) \| `"color"` \| `"none"` |
| `package.background.data` | `bckGndData` (bytes embutidos) | string — SVG inline ou data URI, nunca caminho de arquivo externo |
| `package.shapes[]` | componentes `graphical/{rectangle,ellipse,line,textcomponent}` colocados ao lado do corpo | aqui não são "componentes" à parte — são entradas declarativas dentro do mesmo JSON |
| `pins[].x/y` | `xpos`/`ypos` | relativo ao canto superior-esquerdo do `package` (0,0) — não ao centro, pra evitar a aritmética com sinal que o SimulIDE tem |
| `pins[].angle` | `angle` | 0/90/180/270 — de qual lado do corpo o terminal sai e em que direção desenha |
| `pins[].length` | `length` | tamanho do traço do terminal, em px |
| `pins[].label` | `label` | texto exibido junto ao pino; se omitido, usa `id` |

Nenhum campo novo aqui é lido pelo Core — `package`/`pins[].angle|length|label` são consumidos **só pela
Extension** (ela já lê `device.json` direto do disco para popular a paleta/painel de propriedades; não
precisa pedir isso ao Core por IPC). O Core continua só enxergando `pins[].id/kind` (contrato elétrico).
`icon.svg` (seção 14) continua existindo **à parte** — é a miniatura da paleta de componentes, papel
diferente do corpo completo desenhado no canvas (mesma separação que o SimulIDE faz entre o ícone da árvore
de componentes e o pacote do componente).

### 21.3 Editor de pacote na Extension — mesmo princípio do SimulIDE, não uma ferramenta nova

**Implementado em 2026-06-29** (segunda versão — a primeira, de 2026-06-28, era um canvas SVG bespoke
com alças de arrastar feitas à mão; descartada depois de revisão com captura de tela real mostrando
rótulos sobrepostos e visual divergente do renderizador de leitura, e de uma auditoria do fonte real do
SimulIDE, `C:\SourceCode\simulide_2\src\components\other\subpackage.{h,cpp}` +
`components\graphical\{rectangle,ellipse,line,textcomponent,image}.{h,cpp}`).

**Achado da auditoria**: o SimulIDE NÃO tem um editor separado. `SubPackage` é só mais um `Component`
na MESMA `QGraphicsScene` do circuito; `Rectangle`/`Ellipse`/`Line`/`TextComponent`/`Image` também são
`Component`s comuns ali, redimensionados por **propriedades numéricas** (`H_size`/`V_size`) no MESMO
painel de propriedades de qualquer resistor — nunca por alça de arrastar. Pino novo: Shift+hover na
borda do `SubPackage` → clique cria um `PackagePin` (também um `Component` arrastável) → `EditDialog`
modal pequeno (não tela cheia) pra id/label/ângulo. `SubPackage::savePackage()` varre os pinos que
mantém e escreve um arquivo `.package`.

**Reimplementação fiel a esse princípio**: não existe mais canvas/alça/barra lateral bespoke. A
"edição de pacote" é uma **sessão de autoria** dentro do MESMO webview do esquemático — `main.ts`
troca temporariamente qual `WebviewProjectState` `render()`/drag/seleção/painel de propriedades operam
em cima (`enterSymbolAuthoring`/`exitSymbolAuthoring`/`saveSymbolAuthoring`), sem nenhum código de
renderização/interação novo: tudo isso já era genérico sobre a variável `state`, nunca soube que era
"o circuito do usuário" especificamente.

- `other.package` (typeId já existia no catálogo, desabilitado — agora habilitado e property-driven:
  `width`/`height`/`border`/`backgroundColor`) representa o corpo do símbolo. `graphics.rectangle`/
  `ellipse`/`line`/`text` (também já existiam, decorativos — agora property-driven) representam as
  formas. `other.package_pin` (NOVO typeId) representa um pino do símbolo: `pinId`/`label`/`length`
  como propriedades, o **ângulo do lead é o próprio `component.rotation`** (0/90/180/270, já genérico
  pra qualquer componente — reaproveita rotação por teclado/toolbar sem nenhum campo/código novo).
  Todos com `pinCount: 0`, nunca sincronizados com o Core (`shouldSyncComponentToCore`, já existia).
- Resize: só por campo numérico no painel de propriedades (`inferPropertyFields`, já existia, nunca
  precisou de mudança) — **igual ao SimulIDE real**, não uma alça de arrastar nova.
- Adicionar pino: colocar um `other.package_pin` na paleta, posicionar arrastando (drag genérico de
  qualquer componente), girar com o atalho de rotação genérico. Sem o gesto "Shift+hover na borda" do
  SimulIDE (decisão de simplificação: a paleta já é o caminho de "adicionar algo" de todo o resto do
  app, não duplicar um segundo gesto só pra isto).
- Sem upload de imagem de fundo nesta rodada (só cor sólida via `backgroundColor`) — um `package` que já
  tinha fundo `svg`/`image` escrito à mão é **preservado verbatim** ao salvar
  (`extension.ts::saveSymbolCommand` relê o valor atual do disco antes de compilar), nunca apagado
  silenciosamente.
- Salvar ("Salvar Símbolo" na barra, só aparece durante a sessão de autoria) varre os componentes da
  sessão (`extension/src/catalog/symbolAuthoring.ts::compileSymbolAuthoringComponents`), espera
  exatamente 1 `other.package` (erro claro com 0 ou mais de 1), e grava de volta só a chave `package` do
  manifesto original (relido do disco) — **é o mesmo arquivo que alguém poderia editar à mão**, exatamente
  como especificado.
- Abrir pra editar (`seedSymbolAuthoringComponents`, inverso exato de compilar) semeia a sessão a partir
  do `package` já existente — round-trip sem perda pra retângulo/elipse/texto/pino; `graphics.line` perde
  precisão de ângulo não-cardinal (vira o múltiplo de 90° mais próximo, já que só rotação genérica de
  4 valores existe) — nenhum dos manifestos reais do projeto usa ângulo de linha não-cardinal hoje.

Pontos de entrada (decisão de implementação, não descritos no texto original): botão "✎" por item
registrado na paleta (`palette.ts`, sessão abre já semeada com o `package` daquele item) e comando
genérico `lasecsimul.palette.editSymbol` (botão na barra de título da paleta) que abre um seletor de
arquivo — permite editar o símbolo de um manifesto ainda não registrado.

Esse fluxo é só código de Extension (TypeScript/webview) — não depende do Core estar rodando, e o Core
nunca precisa ser tocado para isso existir (nenhum dos typeIds novos/alterados tem pino elétrico real).
**O que isto não inclui** (fora de escopo desta rodada, ver `.spec/lasecsimul-subcircuits.spec` seção 4
e `docs/16-roadmap-pendencias-spec.md` Épico G): o comando "Criar Subcircuito a partir da Seleção"
(detectar fios cruzando a borda de uma seleção no esquemático e gerar tunnels automaticamente) — esse
fluxo ainda não existe; a sessão de autoria hoje só edita o `package` de um manifesto que já tem seus
pinos elétricos declarados à mão.

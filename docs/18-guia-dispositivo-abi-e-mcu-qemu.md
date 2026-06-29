# 18 - Guia prático: criar um dispositivo via ABI nativa e um adaptador de MCU via QEMU

## Objetivo

Guia passo a passo, com exemplo completo e template copiável, para as duas formas de estender o
LasecSimul com código compilado fora do Core: (1) um **dispositivo nativo** (DLL/SO via
`device_abi.h`) e (2) um **adaptador de MCU emulado via QEMU** (`IMcuAdapter`/`QemuModule`). Tudo
aqui foi conferido contra o código real do repositório nesta data (2026-06-28) — nenhum nome de
função, campo de struct ou caminho de arquivo é hipotético.

Leitura de referência completa (este guia é o atalho prático, não substitui):
`.spec/lasecsimul-native-devices.spec` (dispositivo ABI), `.spec/lasecsimul.spec` seção 8 (QEMU/MCU),
`docs/17-pendencias-pos-sessao-qemu-abi.md` (estado real pós-sessão de correção da ABI de MCU).

---

## 0. Ferramentas que você precisa instalar

| Ferramenta | Versão mínima | Para que serve aqui |
|---|---|---|
| **CMake** | 3.20+ | Cada `devices/<nome>/` e o Core são projetos CMake separados. |
| **Compilador C/C++ com suporte a C++20** | — | Windows: MSVC (Visual Studio Build Tools) ou Clang/MinGW. Linux: GCC ou Clang. macOS: Clang (Xcode CLT). O dispositivo em si pode ser escrito em C puro (como `example-blinker`) ou C++ — só a vtable exportada precisa ser `extern "C"`. |
| **Node.js** | 18+ | Só pra rodar os scripts agregados (`npm run build:devices`, `npm run build:core`) — o dispositivo/adaptador em si não usa Node em runtime. |
| **Git** | qualquer recente | O Core baixa `Eigen` via CMake `FetchContent` na primeira configuração — só é necessário se você for **também** recompilar o Core (não é necessário só para compilar um device novo). |

Não precisa instalar: Qt, Python, WASM toolchain (`emcc`) — essas dependências são de abordagens já
descartadas neste projeto (ver ADRs 0002/0007). Para o adaptador de MCU especificamente, **não**
precisa instalar o QEMU nem o SDK do fabricante do chip só para compilar o adaptador — o binário real
do QEMU já está vendorizado em `devices/qemu-esp32/bin/` para o caso ESP32; você só precisaria do SDK
de verdade (ex: ESP-IDF) se quiser gerar um firmware `.bin` real para testar de ponta a ponta, o que é
um passo totalmente separado de "escrever o adaptador".

Comando de verificação rápida:

```sh
cmake --version   # >= 3.20
node --version    # >= 18
```

---

# Parte 1 — Dispositivo nativo (ABI `device_abi.h`)

## 1.1 O que é e quando usar

Um dispositivo nativo é uma DLL/SO compilada separadamente do Core, que implementa uma "vtable" C
fixa (`LsdnDeviceVTable`) e é carregada em runtime (`LoadLibrary`/`dlopen`). É o caminho certo para
**qualquer componente novo que não seja mantido pelo próprio projeto** — sensor customizado, display,
chip lógico, instrumento. Componentes que o projeto mantém para sempre (resistor, capacitor) são C++
compilado direto no Core; não use a ABI pra isso.

Por que DLL/SO e não outra coisa: decisão deliberada e já reconfirmada (ver `.spec`, seção 0/12) —
velocidade nativa, sem sandbox de processo/linguagem. Isso significa que um plugin mal escrito *pode*
derrubar o Core (mitigado por `CrashGuard`, mas não eliminado) — não existe rede de segurança de
linguagem aqui.

## 1.2 Anatomia de `device_abi.h` — o que cada peça faz

Arquivo real: `core/include/lasecsimul/device_abi.h`. Você nunca edita este arquivo para criar um
device — só `#include` ele.

### Enums e tipos de dado

- **`LsdnPinKind`** — o tipo elétrico de um pino: `LSDN_PIN_DIGITAL_IN`, `LSDN_PIN_DIGITAL_OUT`,
  `LSDN_PIN_DIGITAL_BIDIR`, `LSDN_PIN_ANALOG_IN`, `LSDN_PIN_ANALOG_OUT`, `LSDN_PIN_PWM_OUT`,
  `LSDN_PIN_POWER` (referência de alimentação, não participa de `stamp()` como sinal).
- **`LsdnEventTag`** — só dois valores hoje: `LSDN_EVT_PIN_CHANGE` (algum pino do mesmo nó elétrico
  mudou de nível digital — `a`=índice local do pino, `b`=novo nível 0/1, `c`=ns desde a borda
  anterior NESTE pino) e `LSDN_EVT_TIMER` (um `schedule_event` seu disparou — `a`=`event_id` que você
  passou). Protocolo (I2C/SPI/UART) é decodificado bit a bit pelo seu próprio device a partir de
  `LSDN_EVT_PIN_CHANGE` — não existe mais um evento de "byte de barramento pronto".
- **`LsdnPropertyKind`** — `LSDN_PROPERTY_NUMBER`/`STRING`/`BOOL`/`POINT`. Não existe um kind "enum"
  separado — enum é `STRING` mais a UI saber que só alguns valores são válidos (ver seção 1.4).
- **`LsdnPropertyValue`** — union-like struct com os 4 campos (`number_value`, `bool_value`,
  `string_value`, `point_value`) mais `kind` dizendo qual está em uso. Sempre preencha `kind`.
- **`LsdnMatrixView`** — sua janela direta pra matriz elétrica do Core, sem cópia: `add_conductance`
  (resistor entre dois pinos), `add_voltage_source` (fonte ideal entre dois pinos — cuidado, isso
  aloca variável extra no rebuild de topologia, não no `stamp()`, então só funciona se o device
  realmente precisa disso topologicamente), `get_node_voltage` (ler tensão de um nó), e os dois
  atalhos de 1 terminal: `add_conductance_to_ground`/`add_current_to_ground`.

### `LsdnHostApi` — o que o Core te dá (você só chama, nunca implementa)

| Função | O que faz |
|---|---|
| `pin_declare(ctx, index, kind, name)` | Registra um pino do seu device (mesma ordem do `pins[]` do `device.json`), devolve um handle pra usar nas outras chamadas. Chame em `init()`. |
| `pin_write(ctx, pin, level)` | Jeito ergonômico de dirigir um pino digital direto (fonte de baixa impedância) — sem montar `stamp()` na mão. Equivalente a "eu sou o único dono deste pino". |
| `pin_write_analog(ctx, pin, volts)` | Mesma ideia, valor analógico. |
| `pin_read(ctx, pin)` | Nível (0/1) do próprio pino na última `stamp()` — cache, nunca dispara solve novo. Use fora de `stamp()` (em `on_event`/`post_step`). |
| `pin_name(ctx, index)` | Nome do pino pelo índice — útil pra validar no `init()` que a ordem que você assumiu bate com o `device.json` (erro clássico: SCL/SDA trocados). |
| `schedule_event(ctx, delay_ns, event_id)` | Agenda um `LSDN_EVT_TIMER` no futuro — para piscar, fazer polling, animar. |
| `config_get(ctx, name, out_value)` | Lê o valor **atual** de uma propriedade declarada no `device.json` (já considerando o que o usuário configurou no projeto). |
| `now_ns(ctx)` | Tempo de simulação atual, determinístico. |
| `log(ctx, level, msg)` | Aparece no Output do VSCode. |
| `submit_task(ctx, fn, arg)` | Único jeito correto de fazer trabalho em background — nunca crie sua própria thread e chame `LsdnHostApi` dela concorrentemente. |

**Regra de sequenciamento que todo mundo esquece uma vez**: `pin_write`/`pin_write_analog`/
`schedule_event`/`now_ns` são **no-op silencioso se chamadas dentro de `init()`** — o host só liga o
componente ao `Scheduler` depois que `init()` retorna. Se seu device precisa se auto-agendar (ex:
piscar), agende na **primeira `stamp()`** com uma flag "já agendei" no seu estado — exatamente o
padrão de `devices/example-blinker/src/lib.c` (seção 1.5 abaixo).

### `LsdnDeviceVTable` — as 10 funções que você implementa

```c
typedef struct LsdnDeviceVTable {
    LsdnDevice* (*create)(void* host_ctx, const LsdnHostApi* host_api);
    void        (*init)(LsdnDevice* dev);
    void        (*stamp)(LsdnDevice* dev, LsdnMatrixView* matrix);
    void        (*post_step)(LsdnDevice* dev, uint64_t time_ns);
    void        (*on_event)(LsdnDevice* dev, const LsdnEvent* ev);
    uint32_t    (*get_property)(LsdnDevice* dev, const char* name, LsdnPropertyValue* out_value);
    uint32_t    (*set_property)(LsdnDevice* dev, const char* name, const LsdnPropertyValue* value);
    uint32_t    (*get_state)(LsdnDevice* dev, uint8_t* out, uint32_t cap);
    void        (*set_state)(LsdnDevice* dev, const uint8_t* in, uint32_t len);
    void        (*destroy)(LsdnDevice* dev);
} LsdnDeviceVTable;
```

| Função | Quando é chamada | O que fazer |
|---|---|---|
| `create` | Uma vez, ao instanciar | Alocar seu struct de estado, guardar `host_ctx`/`api`. **Nunca** chamar `host_api` aqui ainda. |
| `init` | Uma vez, logo depois de `create` | `pin_declare` de cada pino, ler propriedades iniciais via `config_get`. |
| `stamp` | Só quando "dirty" (mudou topologia/propriedade) | Contribuir na matriz (`LsdnMatrixView`) se o device tiver comportamento elétrico passivo; é também onde você faz o primeiro `schedule_event` (ver regra acima). |
| `post_step` | Só se o device se registrou como dinâmico — na prática, raramente usado; a maioria dos devices reais usa `schedule_event`/`on_event` em vez disso (ver `example-blinker`). | Lógica de avanço de tempo contínuo, se precisar. |
| `on_event` | Quando um `LSDN_EVT_PIN_CHANGE`/`LSDN_EVT_TIMER` chega | Decodificar protocolo bit a bit, reagir a timer. |
| `get_property`/`set_property` | Usuário edita propriedade no painel | Espelhar exatamente o schema do `device.json` — `name` é o `id` da propriedade. |
| `get_state`/`set_state` | Salvar/abrir projeto | Serializar todo estado interno relevante num buffer próprio seu (formato é privado ao seu device). |
| `destroy` | Remoção do componente | Liberar memória. |

Por fim, o único símbolo exportado pela DLL/SO:

```c
LSDN_EXPORT
const LsdnDeviceVTable* lsdn_get_vtable(uint32_t* abi_major, uint32_t* abi_minor) {
    *abi_major = LSDN_ABI_VERSION_MAJOR;
    *abi_minor = LSDN_ABI_VERSION_MINOR;
    return &kVTable;
}
```

`LSDN_ABI_VERSION_MAJOR` hoje é **3**. O `PluginLoader` só rejeita por `major` diferente (minor é só
informativo) — sempre recompile o device (`npm run build:devices`) depois de atualizar o Core.

## 1.3 Anatomia de `device.json` — cada campo, o que faz

Arquivo real de referência: `devices/example-blinker/device.json` e
`devices/voltmeter/device.json`. Schema completo: `.spec/lasecsimul-native-devices.spec` seção 4.2.2.

```json
{
  "schemaVersion": 1,
  "typeId": "example.blinker",
  "name": "Blinker (exemplo de dispositivo nativo)",
  "language": "pt-BR",
  "translations": { "en": { "name": "...", "properties": { "periodMs": { "label": "Period", "group": "Timing" } } } },
  "abiVersion": { "major": 3, "minor": 0 },
  "nativeEntry": {
    "win32-x64": "build/win-x64/device.dll",
    "linux-x64": "build/linux-x64/device.so",
    "darwin-universal": "build/macos-universal/device.dylib"
  },
  "package": { "width": 60, "height": 40, "border": true,
    "background": { "kind": "color", "value": "#ffffff" },
    "shapes": [ { "kind": "text", "x": 8, "y": 16, "value": "BLINK", "fontSize": 9, "color": "#000000" } ]
  },
  "pins": [
    { "id": "out", "kind": "DIGITAL_OUT", "x": 60, "y": 20, "angle": 0, "length": 8, "label": "OUT" }
  ],
  "properties": [ /* ver seção 1.4 */ ],
  "buses": [],
  "limits": { "stepTimeoutMs": 4, "expectedComplexity": "low" }
}
```

| Campo | O que faz |
|---|---|
| `schemaVersion` | Sempre `1` hoje. |
| `typeId` | Chave estável global (`"categoria.nome"`) — usada em projeto/IPC/catálogo. Nunca muda depois de publicado. |
| `name` | Nome de exibição, no idioma de `language`. |
| `language`/`translations` | Idioma em que `name`/labels foram escritos; `translations.<locale>` sobrescreve campos textuais por locale (ver seção 1.3.1). |
| `abiVersion` | Major/minor que este binário foi compilado contra — **major precisa bater** com o Core em runtime. |
| `nativeEntry` | Caminho do binário compilado, por plataforma, relativo à pasta do device. |
| `package` | Corpo visual desenhado pelo editor (retângulo + formas) — lido só pela Extension, o Core nunca processa isso. `width`/`height` em pixels do grid do esquemático; `shapes[]` aceita pelo menos `text`/formas geométricas (ver dispositivos em `devices/simulide-complex/` para exemplos mais ricos, incluindo imagem de fundo embutida). |
| `pins[]` | Um item por pino, na **mesma ordem** que `pin_declare(ctx, index, ...)` vai usar (`index` é a posição no array). `x`/`y`/`angle`/`length` posicionam o terminal visualmente; `kind` é a string do `LsdnPinKind` sem o prefixo `LSDN_PIN_` (`DIGITAL_OUT`, `ANALOG_IN`, `POWER`, etc). |
| `properties[]` | Ver seção 1.4 — schema completo de cada propriedade editável. |
| `buses[]` | Campo legado, não processado pelo Core hoje (a decodificação de protocolo é bit a bit via pino, não por barramento declarado) — deixe `[]`. |
| `limits.stepTimeoutMs` | Orçamento de tempo por chamada da vtable antes do watchdog (`PluginWatchdog`) considerar o device "lagging"/"faulted". |

### 1.3.1 Internacionalização

Todo campo textual visível pode ser uma string simples (no idioma de `language`) ou um objeto
`translations.<locale>` espelhando a mesma chave. Exemplo real (`devices/voltmeter/device.json`):
`language: "pt-BR"`, e `translations.en.name`/`translations.en.properties.displayVoltage.label`
fornecem a versão em inglês só dos campos que precisam de tradução — não precisa duplicar tudo.

## 1.4 Como exportar propriedades e enums

Cada item de `properties[]` no `device.json`:

```json
{
  "id": "mode",
  "label": "Modo",
  "group": "Geral",
  "valueKind": "string",
  "editor": "enum",
  "default": "fast",
  "options": [
    { "value": "slow", "label": "Lento" },
    { "value": "fast", "label": "Rápido" }
  ],
  "hidden": false,
  "readOnly": false,
  "noCopy": false,
  "affectsTopology": false,
  "requiresRestart": false,
  "showOnSymbol": false
}
```

- **`valueKind`** é o tipo de dado real: `number | string | bool | point` — estes quatro, sem mais.
  Corresponde 1:1 a `LsdnPropertyKind` do lado C (`LSDN_PROPERTY_NUMBER`/`STRING`/`BOOL`/`POINT`).
- **`editor`** é só a *apresentação* — não muda o tipo: `text`/`number`/`checkbox`/`switch`/`select`/
  `enum`/`display`/etc.
- **Enum = `valueKind: "string"` + `editor: "enum"` + `options[]`.** Não existe um `LsdnPropertyKind`
  de enum separado — do lado C você sempre lê/escreve `string_value` (`LSDN_PROPERTY_STRING`), e
  compara contra os valores de `options[].value` que você mesmo declarou. A UI é quem restringe a
  escolha a essas opções; o C não precisa validar de novo (mas pode, defensivamente).
- **`color`**/**`path`**/**`file`**/**`textEdit`** seguem o mesmo padrão: todos são `valueKind:
  "string"` com um `editor` diferente — nenhum tipo C novo.
- **`min`/`max`/`step`** só fazem sentido com `valueKind: "number"`.
- **Flags booleanas** (todas opcionais, default `false`):
  - `hidden` — não aparece na UI.
  - `readOnly` — aparece mas não é editável (útil para leitura ao vivo — ver `displayVoltage` do
    voltímetro, com `editor: "display"`).
  - `noCopy` — não é copiada ao duplicar o componente.
  - `affectsTopology` — mudar isso força o Core a refazer a topologia da `Netlist`.
  - `requiresRestart` — a UI avisa o usuário que precisa reiniciar a simulação.
  - `showOnSymbol` — o valor aparece sobre o símbolo no esquemático (ex: leitura de instrumento).

**No lado C**, cada propriedade é só um `if (strcmp(name, "...") == 0)` dentro de `get_property`/
`set_property` — não existe (de)serialização automática, você escreve isso à mão (ver seção 1.5).
`config_get` (via `LsdnHostApi`) é o caminho pra ler o valor configurado no `init()`, antes de o
usuário poder ter chamado `set_property` ainda.

## 1.5 Exemplo completo: um sensor com propriedade `number` E `enum`

Dispositivo de 2 pinos: lê uma tensão analógica de entrada e dirige uma saída digital como
comparador — com um `threshold` (`number`) e um `mode` (`enum`: `"normal"` = saída alta quando
entrada > threshold; `"inverted"` = o contrário). Baseado fielmente no padrão real de
`devices/example-blinker/src/lib.c` e `devices/voltmeter/src/lib.c`.

`devices/comparator-example/device.json`:

```json
{
  "schemaVersion": 1,
  "typeId": "example.comparator",
  "name": "Comparador (exemplo com enum)",
  "language": "pt-BR",
  "translations": {
    "en": {
      "name": "Comparator (enum example)",
      "properties": {
        "threshold": { "label": "Threshold", "group": "Settings" },
        "mode": { "label": "Mode", "group": "Settings" }
      }
    }
  },
  "abiVersion": { "major": 3, "minor": 0 },
  "nativeEntry": {
    "win32-x64": "build/win-x64/device.dll",
    "linux-x64": "build/linux-x64/device.so",
    "darwin-universal": "build/macos-universal/device.dylib"
  },
  "package": {
    "width": 60, "height": 40, "border": true,
    "background": { "kind": "color", "value": "#ffffff" },
    "shapes": [ { "kind": "text", "x": 6, "y": 22, "value": "CMP", "fontSize": 10, "color": "#000000" } ]
  },
  "pins": [
    { "id": "in", "kind": "ANALOG_IN", "x": 0, "y": 20, "angle": 180, "length": 8, "label": "IN" },
    { "id": "out", "kind": "DIGITAL_OUT", "x": 60, "y": 20, "angle": 0, "length": 8, "label": "OUT" }
  ],
  "properties": [
    {
      "id": "threshold", "label": "Limiar", "group": "Configuração",
      "valueKind": "number", "editor": "number", "default": 2.5, "min": 0, "max": 5, "step": 0.1, "unit": "V"
    },
    {
      "id": "mode", "label": "Modo", "group": "Configuração",
      "valueKind": "string", "editor": "enum", "default": "normal",
      "options": [
        { "value": "normal", "label": "Normal" },
        { "value": "inverted", "label": "Invertido" }
      ]
    }
  ],
  "buses": [],
  "limits": { "stepTimeoutMs": 4, "expectedComplexity": "low" }
}
```

`devices/comparator-example/src/lib.c`:

```c
#include "lasecsimul/device_abi.h"
#include <stdlib.h>
#include <string.h>

typedef struct {
    void* host_ctx;
    const LsdnHostApi* api;
    uint32_t pin_in;
    uint32_t pin_out;
    double threshold;
    int inverted; /* 0 = "normal", 1 = "inverted" */
} ComparatorState;

static LsdnDevice* create(void* host_ctx, const LsdnHostApi* api) {
    ComparatorState* s = (ComparatorState*)calloc(1, sizeof(ComparatorState));
    s->host_ctx = host_ctx;
    s->api = api;
    return (LsdnDevice*)s;
}

static void init(LsdnDevice* dev) {
    ComparatorState* s = (ComparatorState*)dev;
    s->pin_in = s->api->pin_declare(s->host_ctx, 0, LSDN_PIN_ANALOG_IN, "in");
    s->pin_out = s->api->pin_declare(s->host_ctx, 1, LSDN_PIN_DIGITAL_OUT, "out");

    LsdnPropertyValue value;
    memset(&value, 0, sizeof(value));
    s->threshold = 2.5;
    if (s->api->config_get && s->api->config_get(s->host_ctx, "threshold", &value) &&
        value.kind == LSDN_PROPERTY_NUMBER) {
        s->threshold = value.number_value;
    }

    memset(&value, 0, sizeof(value));
    s->inverted = 0;
    if (s->api->config_get && s->api->config_get(s->host_ctx, "mode", &value) &&
        value.kind == LSDN_PROPERTY_STRING && value.string_value) {
        s->inverted = (strcmp(value.string_value, "inverted") == 0);
    }
}

/* Sem contribuição passiva direta na matriz -- o nível de saída é dirigido via pin_write em
 * post_step(), não em stamp(). stamp() só precisa existir (vtable exige). */
static void stamp(LsdnDevice* dev, LsdnMatrixView* matrix) { (void)dev; (void)matrix; }

static void post_step(LsdnDevice* dev, uint64_t time_ns) {
    ComparatorState* s = (ComparatorState*)dev;
    (void)time_ns;
    /* pin_read só serve pra digital -- para ler tensão analógica real, use a própria stamp()
     * com matrix->get_node_voltage. Simplificado aqui assumindo IN já chega como nível 0/1 pelo
     * pin_read por clareza didática; um sensor analógico real leria get_node_voltage em stamp(). */
    int32_t level = s->api->pin_read(s->host_ctx, s->pin_in);
    int32_t out_level = s->inverted ? !level : level;
    s->api->pin_write(s->host_ctx, s->pin_out, out_level);
}

static void on_event(LsdnDevice* dev, const LsdnEvent* ev) { (void)dev; (void)ev; }

static uint32_t get_property(LsdnDevice* dev, const char* name, LsdnPropertyValue* out) {
    ComparatorState* s = (ComparatorState*)dev;
    if (!name || !out) return 0;
    memset(out, 0, sizeof(*out));
    if (strcmp(name, "threshold") == 0) {
        out->kind = LSDN_PROPERTY_NUMBER;
        out->number_value = s->threshold;
        return 1;
    }
    if (strcmp(name, "mode") == 0) {
        out->kind = LSDN_PROPERTY_STRING;
        out->string_value = s->inverted ? "inverted" : "normal";
        return 1;
    }
    return 0;
}

static uint32_t set_property(LsdnDevice* dev, const char* name, const LsdnPropertyValue* value) {
    ComparatorState* s = (ComparatorState*)dev;
    if (!name || !value) return 0;
    if (strcmp(name, "threshold") == 0 && value->kind == LSDN_PROPERTY_NUMBER) {
        s->threshold = value->number_value;
        return 1;
    }
    if (strcmp(name, "mode") == 0 && value->kind == LSDN_PROPERTY_STRING && value->string_value) {
        s->inverted = (strcmp(value->string_value, "inverted") == 0);
        return 1;
    }
    return 0;
}

static uint32_t get_state(LsdnDevice* dev, uint8_t* out, uint32_t cap) {
    ComparatorState* s = (ComparatorState*)dev;
    if (cap < sizeof(int32_t)) return 0;
    *(int32_t*)out = s->inverted;
    return sizeof(int32_t);
}

static void set_state(LsdnDevice* dev, const uint8_t* in, uint32_t len) {
    ComparatorState* s = (ComparatorState*)dev;
    if (len >= sizeof(int32_t)) s->inverted = *(const int32_t*)in;
}

static void destroy(LsdnDevice* dev) { free(dev); }

static const LsdnDeviceVTable kVTable = {
    create, init, stamp, post_step, on_event, get_property, set_property, get_state, set_state, destroy
};

LSDN_EXPORT
const LsdnDeviceVTable* lsdn_get_vtable(uint32_t* abi_major, uint32_t* abi_minor) {
    *abi_major = LSDN_ABI_VERSION_MAJOR;
    *abi_minor = LSDN_ABI_VERSION_MINOR;
    return &kVTable;
}
```

`devices/comparator-example/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.20)
project(ComparatorExampleDevice C)

add_library(device SHARED src/lib.c)
target_include_directories(device PRIVATE ${CMAKE_SOURCE_DIR}/../../core/include)

set_target_properties(device PROPERTIES C_VISIBILITY_PRESET hidden)
```

> Nota didática: este exemplo usa `pin_read` no nível digital por simplicidade. Um comparador real
> deveria ler a tensão exata do nó de entrada (`get_node_voltage` via `LsdnMatrixView`, dentro de
> `stamp()`) e comparar contra `threshold` ali — fica como exercício natural depois de entender o
> fluxo básico.

## 1.6 Build e registro

1. Crie a pasta `devices/<seu-nome>/` com `CMakeLists.txt`, `device.json`, `src/lib.c` (ou `.cpp`).
2. `npm run build:devices` — o script (`scripts/build-devices.js`) **descobre automaticamente**
   qualquer pasta em `devices/` que tenha um `CMakeLists.txt`, configura+builda com CMake, e copia o
   artefato pra `devices/<nome>/build/<plataforma>/device.{dll,so,dylib}` (o caminho que
   `nativeEntry` espera). Não precisa registrar o novo device em nenhum script — só precisa existir.
3. Adicione uma entrada em `devices/library.json` (`devices[]`: `{ "typeId": "...", "manifest":
   "<seu-nome>/device.json" }`) — é isso que o catálogo lê pra descobrir seu `typeId`.
4. Reinicie/abra o Core — o `typeId` novo aparece na paleta de componentes.

---

# Parte 2 — Adaptador de MCU emulado via QEMU

## 2.1 Plugin DLL/SO — único caminho, sem recompilar o Core, mesmo desempenho de built-in

**Todo adaptador de MCU é plugin DLL/SO (`mcu_abi.h`).** Não existe, e não deve ser criado, um
caminho built-in (C++ compilado direto no Core) para adaptador de MCU — essa possibilidade existiu
até 2026-06-28 (o ESP32 era built-in), foi avaliada e **removida deliberadamente**: o ESP32
(`mcu-adapters/espressif-esp32/`) foi migrado pro plugin, prova real de que esse caminho tem paridade
total de desempenho, então o caminho built-in deixou de ter qualquer justificativa. `McuRegistry`
resolve `chipId` exclusivamente via `NativeMcuAdapterProxy`; `registerFactory` é chamado só pra
adaptadores carregados de plugin (ver `SimulationSession::registerKnownMcuTypes()`).

A ABI (`mcu_abi.h`) bumpou para **major 2** pra viabilizar isso: ganhou `LsdnQemuModuleVTable`/
`LsdnQemuModuleHandle` e `LsdnMcuVTable::create_modules` — um plugin declara o mesmo `QemuModule`
chip-específico que só um built-in conseguia declarar antes, com **o mesmo custo de chamada**
(ponteiro de função C, mesmo processo, sem IPC/serialização — exatamente o motivo de `device_abi.h`
já ser "tão rápido quanto built-in", ver seção 0 deste guia). **Use plugin DLL/SO para qualquer chip
novo** — não há segundo caminho a escolher.

## 2.2 Anatomia das peças (`mcu_abi.h`, `QemuModuleProxy`, `McuComponent`)

### `mcu_abi.h` (`core/include/lasecsimul/mcu_abi.h`) — o que cada peça faz

```c
typedef struct LsdnMcuVTable {
    LsdnMcuAdapter*    (*create)(void* host_ctx, const LsdnMcuHostApi* host_api);
    LsdnQemuLaunchSpec (*build_launch_args)(LsdnMcuAdapter* adapter, const char* firmware_path);
    uint32_t (*get_memory_regions)(LsdnMcuAdapter* adapter, LsdnMemoryRegion* out, uint32_t cap);
    uint32_t (*get_pin_map)(LsdnMcuAdapter* adapter, LsdnPinMapping* out, uint32_t cap);
    uint32_t (*create_modules)(LsdnMcuAdapter* adapter, LsdnQemuModuleHandle* out, uint32_t cap);
    void (*destroy)(LsdnMcuAdapter* adapter);
} LsdnMcuVTable;

typedef struct LsdnQemuModuleVTable {
    void     (*reset)(LsdnQemuModule* module);
    void     (*write_register)(LsdnQemuModule* module, uint64_t address, uint64_t value);
    uint64_t (*read_register)(LsdnQemuModule* module, uint64_t address);
    int32_t  (*is_output_enabled)(LsdnQemuModule* module, uint32_t bit_or_line);
    int32_t  (*output_level)(LsdnQemuModule* module, uint32_t bit_or_line);
    void     (*set_input_level)(LsdnQemuModule* module, uint32_t bit_or_line, int32_t level);
    void     (*destroy)(LsdnQemuModule* module);
} LsdnQemuModuleVTable;
```

- **`create`/`build_launch_args`/`get_memory_regions`/`get_pin_map`** — mesma vtable declarativa de
  sempre: `chipId` (não está na vtable, vem de `mcu.json`), argumentos de launch do QEMU, faixas
  MMIO, mapa de pino lógico → bit. **`argv[0]`** deve ser o nome convencional que o próprio QEMU
  espera (ex: `"qemu-system-xtensa"`) — **não** inclua a chave da shared memory, isso é
  responsabilidade do `McuController`, que prepende `argv[1]` automaticamente.
- **`create_modules`** — a peça nova (major 2): mesmo protocolo de duas chamadas que
  `get_memory_regions` já usa (`cap=0` só pra contar, depois de novo com buffer do tamanho certo).
  Devolve um `LsdnQemuModuleHandle` por periférico que você de fato implementa — `{moduleKind,
  moduleIndex, module, vtable}`, onde `module` é um ponteiro opaco seu e `vtable` é uma
  `LsdnQemuModuleVTable` estática (uma só, compartilhada por todas as instâncias daquele
  periférico).
- **`write_register`/`read_register`** são **obrigatórias** — é o mínimo pra um módulo decodificar
  registrador de verdade. `reset`/`is_output_enabled`/`output_level`/`set_input_level`/`destroy` são
  **opcionais** (ponteiro `NULL` = no-op/"nunca dirige nada") — um módulo que não é GPIO-like (ex:
  timer puro) deixa os três do meio como `NULL`.
- **Por que isso tem o mesmo desempenho de built-in**: o Core (`QemuModuleProxy`,
  `core/src/plugins/QemuModuleProxy.hpp`) só embrulha `module`+`vtable` numa subclasse de
  `QemuModule` que repassa cada chamada pro ponteiro de função C — uma indireção, no mesmo processo,
  sem serialização. É o mesmo raciocínio de `device_abi.h` (seção 1.2 acima): a fronteira ABI custa
  uma chamada indireta, não uma chamada entre processos.

### Identidade chip-específica: cada módulo sabe seus próprios offsets

Um módulo concreto (ex: GPIO do ESP32, ver seção 2.3) é **deliberadamente chip-específico** — é ele
quem sabe que "offset `0x04` dentro da minha faixa é `GPIO_OUT_REG`". Isso não é generalizável entre
chips: cada fabricante define seu próprio mapa de registrador. Como o módulo é criado pelo MESMO
plugin que declarou a faixa de endereço (`get_memory_regions`), ele já conhece seu próprio
`memStart` em tempo de compilação — não precisa receber isso como parâmetro de `write_register`/
`read_register` (que recebem o endereço **absoluto**, igual `QemuModule::writeRegister` em C++).

### `McuComponent` (`core/src/mcu/McuComponent.{hpp,cpp}`) — você nunca toca nisto, só entender o papel

É o `IComponentModel` real que entra no `Netlist`/`Scheduler` com os pinos do `pinMap()`. Faz
polling da arena, despacha `SIM_READ`/`SIM_WRITE` pro `QemuModule`/`QemuModuleProxy` certo (por
endereço), e a cada `stamp()` traduz `isOutputEnabled`/`outputLevel` em estampa elétrica real (Norton
de baixa impedância), ou lê a tensão do nó de volta pro módulo via `setInputLevel`. Seu código nunca
interage com `McuComponent` diretamente — você só escreve o binário do plugin.

## 2.3 Passo a passo: criar um adaptador de MCU novo (plugin DLL/SO)

Usando como referência fiel `mcu-adapters/espressif-esp32/{mcu.json,src/Esp32Adapter.cpp}` —
migrado nesta sessão do equivalente built-in que existia antes em `core/src/mcu/esp32/`.

1. **Pasta nova**: `mcu-adapters/<nome>/{CMakeLists.txt,mcu.json,src/<Chip>Adapter.cpp}` — mesma
   convenção de `devices/<nome>/` (qualquer pasta com `CMakeLists.txt` é descoberta automaticamente
   por `npm run build:mcu-adapters`).
2. **Offsets de registrador e faixas MMIO**: copiados fielmente da documentação/SDK real do chip (ou
   do fork QEMU usado) — nunca inventados. Declare-os como `constexpr` no topo do `.cpp` (não
   precisa de um header separado para um adaptador pequeno — ver `Esp32Adapter.cpp` real).
3. **Um módulo concreto por periférico**: funções C livres (`xxxWriteRegister`/`xxxReadRegister`/...)
   operando sobre um `struct` de estado seu, agrupadas numa `LsdnQemuModuleVTable` estática.
4. **O adaptador**: `create`/`destroy` (aloca/libera seu `struct` de estado),
   `build_launch_args`/`get_memory_regions`/`get_pin_map` declarativos, `create_modules` instancia
   um `LsdnQemuModuleHandle` por módulo que o chip realmente tem implementado (pode ser só um, como
   o ESP32 hoje — GPIO puro).
5. **`mcu.json`**: `chipId`, `nativeEntry` por plataforma, `abiVersion: {major: 2, minor: 0}`.
6. **`mcu-adapters/library.json`**: adicionar `{chipId, manifest}` à lista `"mcus"`.
7. **`npm run build:mcu-adapters`** — compila e copia o artefato pra `build/<plataforma>/
   adapter.{dll,so,dylib}`, mesmo padrão de `build:devices`.

## 2.4 Exemplo real: ESP32 (`mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp`)

Trecho completo do módulo GPIO real (offsets confirmados contra `hw/gpio/esp32_gpio.c` do fork QEMU
e `esp32gpio.cpp` do SimulIDE real — não fictícios, este é o código que roda hoje):

```cpp
struct Esp32GpioModuleState {
    uint32_t out = 0;
    uint32_t enable = 0;
    uint64_t in = 0;
};

void gpioWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    auto* s = reinterpret_cast<Esp32GpioModuleState*>(module);
    const uint64_t offset = address - kGpioStart;
    if (offset == 0x04) s->out = static_cast<uint32_t>(value);       // GPIO_OUT_REG
    else if (offset == 0x20) s->enable = static_cast<uint32_t>(value); // GPIO_ENABLE_REG
}

uint64_t gpioReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<Esp32GpioModuleState*>(module);
    const uint64_t offset = address - kGpioStart;
    if (offset == 0x3C) return s->in & 0xFFFFFFFFull;  // GPIO_IN_REG (pinos 0-31)
    if (offset == 0x40) return (s->in >> 32) & 0x7Full; // GPIO_IN1_REG (pinos 33-39)
    return 0;
}

int32_t gpioIsOutputEnabled(LsdnQemuModule* module, uint32_t bit) {
    auto* s = reinterpret_cast<Esp32GpioModuleState*>(module);
    return (bit < 32 && (s->enable & (1u << bit)) != 0) ? 1 : 0;
}

const LsdnQemuModuleVTable kGpioModuleVTable = {
    &gpioReset, &gpioWriteRegister, &gpioReadRegister, &gpioIsOutputEnabled, &gpioOutputLevel,
    &gpioSetInputLevel, &gpioDestroy,
};

uint32_t createModules(LsdnMcuAdapter*, LsdnQemuModuleHandle* out, uint32_t cap) {
    constexpr uint32_t kCount = 1; // só GPIO puro nesta versão
    if (out && cap >= kCount) {
        out[0] = LsdnQemuModuleHandle{
            LSDN_MODULE_GPIO, 0, reinterpret_cast<LsdnQemuModule*>(new Esp32GpioModuleState()), &kGpioModuleVTable,
        };
    }
    return kCount;
}
```

Arquivo completo (adapter inteiro, incluindo `build_launch_args`/`get_memory_regions`/`get_pin_map`):
`mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp`. Testado de ponta a ponta via
`core/test/core/mcu/Esp32AdapterTest.cpp` (`esp32_adapter` no ctest) — carrega o `adapter.dll` real
pelo `PluginLoader` de produção, cria o `IMcuAdapter` via `PluginRuntime`, e prova que o módulo GPIO
decodifica `ENABLE_REG`/`OUT_REG` de verdade (não só declara a faixa de endereço).

**Cuidado de dimensionamento (lição real, documentada em `docs/17-pendencias-pos-sessao-qemu-abi.md`
seção 0.5)**: se seu chip tiver muitos pinos simultaneamente flutuantes (sem fio), não copie os
mesmos valores de condutância "ligado"/"flutuante" de outro componente sem checar o `rcond()`
resultante contra o limite de singularidade do solver — um spread grande demais entre os dois valores
pode disparar falso positivo de matriz singular mesmo em uma matriz bem-condicionada
equação-a-equação. Isso é responsabilidade do `McuComponent` (não muda com a migração pra plugin).

---

## 3. Checklist final

**Dispositivo ABI**:
- [ ] `devices/<nome>/{CMakeLists.txt,device.json,src/lib.c}` criados.
- [ ] `pins[]` do `device.json` na mesma ordem dos `pin_declare(..., index, ...)`.
- [ ] Toda propriedade em `properties[]` tem `get_property`/`set_property` correspondentes em C.
- [ ] `npm run build:devices` passa, gera `build/<plataforma>/device.{dll,so,dylib}`.
- [ ] Entrada adicionada em `devices/library.json`.

**Adaptador de MCU**:
- [ ] `mcu-adapters/<nome>/{CMakeLists.txt,mcu.json,src/<Chip>Adapter.cpp}` criados.
- [ ] Offsets de registrador e faixas MMIO copiados de fonte real (datasheet/SDK/fork QEMU), nunca
  inventados.
- [ ] `LsdnQemuModuleVTable` concreta por periférico; `create_modules` devolve todos eles.
- [ ] `mcu.json` com `abiVersion: {major: 2, minor: 0}`.
- [ ] Entrada adicionada em `mcu-adapters/library.json` (`"mcus"`).
- [ ] `npm run build:mcu-adapters` passa, gera `build/<plataforma>/adapter.{dll,so,dylib}`.
- [ ] Teste com arena sintética (sem QEMU real) antes de tentar o pipeline real — ver
  `core/test/core/mcu/Esp32AdapterTest.cpp`/`McuComponentTest.cpp` como referência.

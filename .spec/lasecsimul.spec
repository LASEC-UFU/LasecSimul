<!-- Claude Code Spec Header v1 -->
## Claude Code Operating Contract (English)

Purpose: This file is a source-of-truth technical spec for LasecSimul architecture and implementation behavior.
Audience: coding agents and maintainers.
Mode: normative guidance before code changes.

Keywords: source-of-truth, architecture, extension-host, native-core, ipc, qemu, plugin-abi, mna-solver, scheduler, contracts, acceptance-criteria

Priority Rules:
1. MUST preserve architecture boundaries (Extension UI/orchestration vs Core simulation runtime).
2. MUST treat this spec as normative when task instructions are ambiguous.
3. MUST update this spec when introducing a new architectural decision.
4. SHOULD keep protocol and file-format decisions host-agnostic.
5. MUST NOT move simulation logic into the VS Code extension layer.

Agent Workflow:
1. Read this file first.
2. Validate whether requested changes fit existing requirements.
3. If a gap exists: compare alternatives, pick best option, and document the decision in this spec.
4. Implement only after contract clarity.

Decision Keywords:
- MUST: mandatory behavior.
- SHOULD: preferred unless a documented reason exists.
- MAY: optional behavior.
- OUT OF SCOPE: must not be implemented in the current phase.

---
# LasecSimul — Especificação Técnica (v0.2)

Status: rascunho | Tipo: extensão VSCode (UI) + núcleo nativo C++ (simulação) | Emulação de MCU: QEMU (processo externo)

> **Changelog v0.2**: o núcleo de simulação deixa de ser TypeScript/Node e passa a ser um **processo nativo
> C++ separado** (`LasecSimul Core`), para que dispositivos eletrônicos e adaptadores de MCU possam ser
> carregados como **plugins nativos (DLL/SO)** com custo de chamada equivalente a código compilado no próprio
> núcleo — sem IPC, sem serialização, sem sandbox no caminho crítico do solver. Isso substitui a abordagem
> WASM descrita em `lasecsimul-wasm-devices.spec` (agora superseded; ver `lasecsimul-native-devices.spec`).
> Motivação registrada na conversa de design: rodar **todo** componente (R, L, C, fontes, instrumentos) via
> um mecanismo de plugin com overhead de IPC/worker tornaria o simulador lento mesmo para circuitos triviais
> — confirmado comparando com `C:\SourceCode\simulide_2\src\simulator\elements\passive\e-resistor.cpp`, onde `stamp()`
> roda uma única vez (não a cada passo) e o dispatch é uma chamada de função direta em processo único.

---

## 1. Visão geral

LasecSimul recria as ferramentas do SimulIDE-dev (Qt/C++) como duas peças que se comunicam por IPC, não como
um monólito:

- **LasecSimul Extension** (`LasecSimul/extension/`, TypeScript) — única camada que conhece a API do VSCode:
  editor de esquemático (webview), painéis, comandos, propriedades. Não executa nenhum cálculo elétrico.
  Organização de UI baseada no SimulIDE real, exceto qualquer área de digitar/compilar código — não existe
  no LasecSimul, compilação é sempre externa (seção 13).
- **LasecSimul Core** (`LasecSimul/core/`, C++ nativo) — processo separado, dono do `MnaSolver`, do
  `Scheduler`, do registro de componentes/MCUs e do carregamento de plugins nativos. Não conhece VSCode.

Isso cumpre os dois requisitos originais do projeto simultaneamente: "a camada principal da extensão pode
ser em TypeScript" (a extensão é TS) e "a simulação pode ser separada em processos independentes" (o núcleo
é um processo nativo). Microcontroladores continuam **sempre** emulados via QEMU — nunca por interpretação de
instrução escrita à mão — e a integração QEMU agora mora no processo nativo, pelo mesmo motivo de desempenho
do solver (seção 8).

**Divergência deliberada do SimulIDE-dev, não descuido**: o SimulIDE trata ARM/ESP32/STM32 via QEMU mas
AVR (Arduino Uno) e PIC via interpretador de instrução escrito à mão (`microsim/cores/` — fora do escopo
deste projeto). No LasecSimul **toda** família de MCU passa por QEMU, sem exceção — inclusive as que o
SimulIDE simula manualmente. Isso é mais trabalho por família (precisa de CPU emulada no QEMU, não só um
interpretador simples), mas elimina a categoria inteira de bug "o interpretador não bate com o hardware
real" e mantém só um mecanismo de integração de MCU no projeto inteiro (seção 8.2 traz o estado real,
verificado, de cada família).

### 1.1 Fronteira de desacoplamento da UI — o protocolo IPC é o único contrato

Requisito adicional, registrado depois do MVP inicial: a Extension VSCode de hoje precisa continuar sendo
**uma** implementação de shell, nunca **a** UI — deve ser possível, no futuro, escrever um shell totalmente
diferente (ex: app Flutter, ou outra IDE) que fale com o mesmo `LasecSimul Core` sem reescrever nem reusar
nada do lado VSCode/webview. Isso já é parcialmente verdade por construção (RNF03/RNF06: o Core não conhece
Qt nem VSCode, só fala o protocolo de IPC da seção 7) — esta seção formaliza a regra e fecha as lacunas onde
algo VSCode-específico tinha vazado pra fora da Extension.

**Regra**: nada que cruze a fronteira Core↔shell pode depender de um mecanismo específico de um host. Dito de
outro modo, o **protocolo de IPC (named pipe/socket + JSON, seção 7) e os formatos de arquivo em disco
(`.lsproj`, `.lsdevice`, `.lssubcircuit`, `library.json`, ver
`lasecsimul-subcircuits.spec`) são o contrato inteiro.** Um shell Flutter implementaria seu próprio cliente
do protocolo (equivalente a `CoreClient.ts`, em Dart) e sua própria renderização (widgets Flutter, não
DOM/SVG) — **não existe nem se espera reuso de código de UI entre frameworks tão diferentes**; o que se
reaproveita é o protocolo e os formatos de arquivo, nunca TypeScript/webview.

**Correção aplicada**: a declaração de quais bibliotecas carregar saiu de `contributes` do VSCode e foi
consolidada em arquivo host-agnóstico de projeto: `LasecSimul/project/schema/component-catalog.json`.
Esse arquivo é a fonte única para: (a) itens da paleta (`items[]`, incluindo hierarquia de pastas por
`folderPath`), e (b) bibliotecas que a shell manda o Core carregar (`deviceLibraries[]`, tipicamente
`../devices/library.json`, `../mcu-adapters/library.json`, e `../subcircuits/library.json`).
Qualquer shell alternativo lê o mesmo arquivo e chama o mesmo verbo IPC (`loadDeviceLibrary`) sem conhecer
nada de VSCode.

**O que isso não muda**: a Extension continua sendo o único shell implementado nesta fase — não estamos
construindo um shell Flutter agora, só impedindo que decisões de protocolo/formato fiquem amarradas ao VSCode
de um jeito que tornaria um shell futuro mais caro do que precisa ser. Ver ADR 0007
(`docs/adr/0007-ui-desacoplada-protocolo-como-contrato.md`).

## 2. Objetivos

- Editor de esquemáticos e simulação de circuito analógico/digital dentro do VSCode (webview ↔ núcleo nativo).
- Suporte a múltiplos MCUs emulados via QEMU, com firmware real compilado pelo usuário.
- Extensibilidade: novos componentes eletrônicos e novos MCUs **sem recompilar o núcleo**, via plugins
  nativos (DLL/SO) carregados em runtime — ver `lasecsimul-native-devices.spec`.
- **Arquitetura-alvo de longo prazo**: o Core converge para um runtime genérico (solver, scheduler,
  registries, ABI, projeto, telemetria e ponte QEMU), **sem manter modelos elétricos específicos hardcoded
  como estratégia de crescimento do catálogo**. Built-ins que existirem durante o bootstrap/MVP são
  transitórios ou de compatibilidade; todo componente novo que exija comportamento próprio deve entrar pelo
  mesmo caminho de ABI/manifeste usado pelos dispositivos externos. Subcircuitos continuam sendo o caminho
  declarativo sem código.
- **Desempenho do núcleo equivalente ao SimulIDE**: chamada direta em processo único no caminho crítico do
  solver, sem IPC/serialização/sandbox por elemento e por passo.
- Instrumentos virtuais (osciloscópio, multímetro, gerador de função, analisador lógico) como **plugin
  nativo (DLL/SO)** via `device_abi.h`, igual a qualquer outro dispositivo de terceiros — decisão revertida
  por ADR 0006 (`docs/adr/0006-instrumentos-como-plugin-abi.md`); o texto anterior desta seção dizia "código
  nativo de primeira classe no núcleo, não como plugin", o que não vale mais.
- Depuração de firmware integrada (gdbserver do QEMU + Debug Adapter do VSCode).
- **Subcircuitos**: circuito desenhado no próprio editor, salvo como um terceiro tipo de componente
  reutilizável — **dado (JSON), não código** — com pinos de I/O e símbolo visual definidos pelo usuário, sem
  exigir DLL/SO nem recompilar o Core. Ver `lasecsimul-subcircuits.spec` e ADR 0008.
- **UI desacoplável do VSCode**: nenhuma decisão de protocolo/formato de arquivo pode depender de um
  mecanismo específico do VSCode (seção 1.1) — para que um shell alternativo (ex: Flutter) seja viável no
  futuro sem reescrever o Core nem o protocolo.

## 3. Requisitos

### 3.1 Funcionais
- RF01: Criar/abrir/salvar projetos de circuito (formato `.lsproj`), persistidos pela Extension, lidos/escritos pelo Core via IPC.
- RF02: Posicionar, conectar e configurar componentes eletrônicos em um esquemático.
- RF03: Executar simulação (start/pause/step/stop) com resolução de passo configurável.
- RF04: Instanciar um MCU como componente, associar um binário/firmware e executá-lo via QEMU.
- RF05: Mapear pinos do MCU emulado para nós do circuito (bidirecional, tempo real, dentro do Core).
- RF06: Exibir instrumentos virtuais conectados a nós/pinos arbitrários do circuito.
- RF07: Permitir que terceiros contribuam novos componentes e novos MCUs como **plugins nativos** (DLL/SO), sem recompilar o Core.
- RF08: Depurar firmware do MCU emulado (breakpoints, step, watch) a partir do VSCode.
- RF09: Carregar uma versão nova de um plugin já em uso não derruba instâncias existentes nem reinicia a
  simulação — via *versioned swap* (`GlobalPluginCache`, ver `lasecsimul-native-devices.spec` seção 3): v2
  carrega lado a lado de v1; só instâncias novas usam v2; v1 descarrega sozinha quando sua última instância
  for destruída. **Não existe** "descarregar e recarregar o mesmo `PluginModule`" com instâncias vivas — isso
  foi avaliado como inseguro (use-after-free de código) e descartado.
- RF10: Permitir que o usuário crie um **subcircuito** a partir de uma seleção no próprio editor de
  esquemático — circuito interno + pinos de I/O expostos + símbolo visual, salvo como arquivo `.lssubcircuit` (não
  C++, não DLL/SO) — e o reutilize como componente em outros projetos, na mesma paleta de built-ins e
  plugins. Especificação completa em `lasecsimul-subcircuits.spec`.

### 3.2 Não funcionais
- RNF01: O Core nunca bloqueia a UI do VSCode — toda comunicação Extension↔Core é assíncrona.
- RNF02: Caminho crítico do solver (stamp/solve/post-step de componentes nativos e plugins) roda inteiramente
  dentro do processo Core, sem cruzar IPC por elemento/por passo.
- RNF03: O Core não depende de Qt, VSCode API, nem de nenhum MCU concreto — testável isoladamente via CLI/headless.
- RNF04: Adicionar um componente ou um MCU não exige alterar arquivos do Core, apenas adicionar um plugin (DLL/SO) + manifesto.
- RNF05: O Core não depende de runtime gerenciado (CLR, JVM, Node, motor WASM) nem de Qt — Qt existe no
  SimulIDE-dev principalmente para a GUI (QPainter/QWidget), responsabilidade que aqui pertence ao webview da
  Extension, não ao Core; herdá-lo só para suprir as poucas lacunas da seção abaixo não se justifica (e
  evita carregar a obrigação de relinkagem da LGPLv3 num projeto que já tem complexidade de licenciamento
  própria com plugins de terceiros). Dependências mínimas do Core, quase todas MIT/Boost license, sem GUI:

  | Necessidade | Cobertura |
  |---|---|
  | Filesystem, threads, mutex | `std::filesystem`, `std::thread` (stdlib, sem dependência) |
  | Carregar plugin (DLL/SO) | `LoadLibrary`/`dlopen` direto, sem lib (ver `PluginLoader.cpp`) |
  | IPC (named pipe/unix socket) + spawn do processo QEMU | **libuv** (MIT) — mesma lib usada pelo Node por baixo; cobre os dois com uma dependência só |
  | Álgebra linear do `MnaSolver` (LU densa com pivoteamento + esparsa quando necessário) | **Eigen** (MPL2, header-only, sem GUI) — substitui fatoração à mão; ver seção 7.1. MPL2, não MIT, mas sem efeito copyleft viral (permite uso comercial/fechado sem obrigação de publicar fonte) |
  | Memória compartilhada (ring buffer de telemetria) | shim próprio (`CreateFileMapping`/`mmap`), mesmo padrão do `PluginLoader` — não justifica lib externa |
  | Parsing de JSON (manifests, `.lsproj`) | **nlohmann::json** (MIT, header-only) |
- RNF06: Extension e Core são processos distintos; a Extension nunca lê/escreve memória do Core diretamente — só via o protocolo de IPC da seção 7.
- RNF07: **Todo código C++ novo do Core é escrito para compilar em Windows, Linux e macOS — isso é verificado
  a cada PR/geração de código, não revisado só ao final.** Qualquer API específica de plataforma (carregar
  biblioteca dinâmica, memória compartilhada, captura de falha, IPC) fica isolada num shim `#ifdef`/arquivo
  por plataforma — nunca espalhada no código de domínio (`MnaSolver`, `Scheduler`, `registry/`, modelos de
  componente). Padrão já estabelecido em `PluginLoader.cpp` (LoadLibrary/dlopen) e `CrashGuard.cpp`
  (SEH/passthrough) — replicar essa estrutura para qualquer nova integração de SO, em vez de introduzir um
  novo estilo a cada arquivo. "Cross-platform" aqui significa **mesmo código-fonte compilando nos três
  alvos**, não um binário único — CI deve buildar nas três plataformas a cada mudança no Core.
- RNF08: O protocolo de IPC (canal de controle, seção 7) é versionado desde a primeira mensagem — handshake
  inicial troca `protocolVersion` antes de qualquer comando; Core/Extension recusam-se a operar contra uma
  versão incompatível em vez de assumir compatibilidade. Evita migração retroativa de mensagens já em uso.
- RNF09: O canal de telemetria (ring buffer, seção 7) tem política de descarte explícita: amostras contínuas
  (osciloscópio, traços de pino) descartam a mais antiga quando o consumidor não drena a tempo — perder uma
  amostra velha é aceitável, travar o solver esperando a Extension não é (RNF01). Eventos discretos (device
  entrou em `faulted`, fim de simulação) **não** usam esse canal lossy — vão pelo canal de controle
  (confiável), porque perder uma notificação de falha é um custo real, diferente de perder uma amostra.
- RNF10: Nenhuma configuração necessária para o Core operar (ex: quais bibliotecas de dispositivo/subcircuito
   carregar) pode depender de mecanismo específico de host. A fonte canônica é
   `LasecSimul/project/schema/component-catalog.json` (`deviceLibraries[]`) e qualquer shell deve ler esse
   arquivo para decidir quais caminhos enviar ao verbo IPC `loadDeviceLibrary`.
- RNF11: O modelo de metadados de componente e de propriedade MUST ser único para built-ins residuais,
  plugins ABI e subcircuitos. O host não pode manter contratos paralelos “mais ricos” para um tipo de
  componente e “mais pobres” para outro. Se um recurso de propriedade ou pacote visual existir para um, o
  contrato canônico precisa comportá-lo para todos.
- RNF12: Toda string declarativa visível na UI (nome de componente, rótulo/grupo de propriedade, rótulo de
  opção de enum, segmento de categoria/pasta da paleta) MUST suportar múltiplas línguas — quem declara o
  dispositivo/catálogo informa em que língua escreveu (`language`, obrigatório) e pode opcionalmente
  fornecer traduções (`translations`); a UI usa a língua ativa do VSCode quando disponível, senão cai pra
  língua declarada pelo autor — nunca string vazia. Especificação completa na seção 6.3; decisão em
  `docs/adr/0009-localizacao-de-strings-declarativas.md`. **Implementado** — Core
  (`resolvePropertySchemaForLanguage`/`getPropertySchemas`), Extension (`UnifiedCatalog.ts::
  resolveLocalizedItems`), fallback localizável pra fontes registradas (`extension.ts::
  localizedRegisteredFolder`/`localizedManifestName`), exemplo real de tradução em
  `devices/voltmeter/.lsdevice`, `devices/example-blinker/.lsdevice` e
  `project/schema/component-catalog.json` (pt-BR → en). Política de produto desta fase:
  todo dispositivo/componente novo MUST nascer com base `pt-BR` + tradução `en`, e a shell MUST
  expor chave runtime entre essas duas línguas nas configurações.

## 4. Arquitetura modular

```
┌──────────────────────────────────────────────────────────────────────┐
│ LasecSimul Extension (processo VSCode Extension Host, TypeScript)   │
│   extension.ts · webview (editor de esquemático, painéis)          │
│   ui/commands · ui/panels · ipc/CoreClient                          │
│   NÃO calcula nada elétrico — só edita, exibe, envia/recebe IPC     │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ IPC local (named pipe / unix socket)
                            │  · canal de controle: comandos, netlist, propriedades
                            │  · canal de telemetria: shared memory ring buffer
┌───────────────────────────▼──────────────────────────────────────────┐
│ LasecSimul Core (processo nativo C++, independente do VSCode)       │
│                                                                      │
│  GlobalPluginCache (processo-wide, somente leitura após o load)    │
│   PluginLoader · PluginModule ativo por typeId/chipId · metadata    │
│                              │ shared_ptr<PluginModule>              │
│                              ▼                                      │
│  SimulationSession (uma por projeto aberto — hoje sempre 1 por      │
│  processo; o tipo existe para não exigir refactor de singleton se   │
│  múltiplas sessões forem necessárias no futuro, ver nota abaixo)    │
│  ┌────────────┐   stamp()/postStep() — chamada direta   ┌─────────┐ │
│  │ MnaSolver  │◄─────────────────────────────────────────┤Component │ │
│  │ Scheduler  │   (componente nativo OU PluginInstance)  │ Registry │ │
│  │ Netlist    │                                           └────┬────┘ │
│  └─────┬──────┘                                                │      │
│        │                                          PluginRuntime (desta sessão)
│  ┌─────▼─────────────┐  ┌──────────────┐  ┌──────────────────┐ │      │
│  │ Built-in components│  │  McuComponent │  │ NativeDeviceProxy│◄┘      │
│  │ (compilados no Core)│ │ (pinos reais, │  │ (= PluginInstance)│        │
│  │                     │ │  via QemuModule)│ └──────────────────┘        │
│  └────────────────────┘  └──────────────┘                              │
│  Detecção de borda (settleStep) despacha ComponentEvent{kPinChangeEventTag} │
│  pra todo componente/pino do nó — é assim que I2C/SPI/UART são decodificados │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ QEMU Integration: QemuProcessManager · QemuModule (por chip)  │  │
│  │ (arena de memória compartilhada + dispatch por endereço bruto,│  │
│  │  ver seção 8 — mecanismo validado contra o fork QEMU real)     │  │
│  └───────────────────────────────┬──────────────────────────────┘  │
└──────────────────────────────────┼─────────────────────────────────┘
                                    │ child process (spawn/exec)
                          ┌─────────▼─────────┐
                          │ qemu-system-xtensa  │
                          │ qemu-system-arm ...  │
                          └────────────────────┘
```

| Módulo (Core, C++) | Responsabilidade única (SRP) |
|---|---|
| `GlobalPluginCache` | Estado compartilhado entre sessões: `PluginModule` ativo por `typeId`/`chipId`, manifestos parseados, `ComponentMetadataRegistry`. Nunca mutado fora de um load/versioned-swap; sessões só leem. |
| `SimulationSession` | Unidade de isolamento lógico de um projeto aberto: dona de `Netlist`, `Scheduler`, `PluginRuntime`, `QemuProcessManager` dessa sessão. **Escopo atual: exatamente uma sessão por processo Core** — o tipo existe para que isso não seja um singleton implícito, não porque múltiplas sessões simultâneas sejam suportadas hoje. |
| `MnaSolver` | Monta e resolve a matriz (Modified Nodal Analysis + Newton-Raphson para não-lineares) |
| `Scheduler` | Avança o tempo de simulação, decide quando re-stampar (changed-list, ver seção 7) |
| `ComponentRegistry` / `McuRegistry` | Mapa `typeId`/`chipId` → fábrica de `IComponentModel`/`IMcuAdapter`, por sessão |
| `PluginLoader` / `PluginRuntime` | `PluginLoader` (em `GlobalPluginCache`) descobre/valida/carrega DLL/SO; `PluginRuntime` (por sessão) cria/destrói instâncias a partir do módulo ativo. Distinção completa em `lasecsimul-native-devices.spec`, seção 1. |
| `NativeDeviceProxy` / `NativeMcuAdapterProxy` | `PluginInstance` — adaptam a vtable C de um plugin (via `shared_ptr<PluginModule>`) para a interface C++ interna; solver não distingue plugin de built-in |
| `McuComponent` | `IComponentModel` que liga um `IMcuAdapter` ao circuito de verdade: polling da arena, despacho `SIM_READ`/`SIM_WRITE` pro `QemuModule` certo (por endereço), estampa elétrica real a partir de `isOutputEnabled`/`outputLevel` |
| `QemuModule`/`QemuModuleProxy` (por chip/periférico, ex: GPIO do ESP32 via plugin) | Decodifica registrador bruto (`regAddr`/`regData`) — CHIP-ESPECÍFICO de propósito, único lugar que conhece o mapa de registrador real. Sempre via plugin (`mcu_abi.h`/`LsdnQemuModuleVTable`) desde 2026-06-28 — não existe mais `QemuModule` built-in |
| Detecção de borda digital (`SimulationSession::settleStep()`) | Substitui o antigo `BusController`: ao cruzar `kDigitalLevelThreshold`, despacha `ComponentEvent{kPinChangeEventTag}` pra todo componente/pino do nó — quem decodifica I2C/SPI/UART é o próprio componente/device, bit a bit |
| `QemuProcessManager` | Ciclo de vida do processo QEMU + arena de memória compartilhada (88 bytes, seção 8.1) |
| `IpcServer` | Expõe o protocolo de controle + telemetria para a Extension |

Regra de dependência (DIP): `MnaSolver`/`Scheduler` dependem só de `IComponentModel`/`IMcuAdapter` (interfaces
C++ abstratas). Nunca importam um componente, plugin ou MCU concreto por nome.

## 5. Estrutura inicial de pastas

```
LasecSimul/
├── extension/                       # LasecSimul Extension — TypeScript, VSCode
│   ├── package.json                 # manifest da extensão (contributes, activationEvents, comandos/keybindings)
│   ├── tsconfig.json                # main (Node/Extension Host) -- compila separado do webview
│   ├── tsconfig.webview.json        # Webview (ambiente de browser, sem tipos Node) -- ver seção 13
│   └── src/
│       ├── extension.ts             # activate()/deactivate(), TODOS os comandos, handler central de
│       │                             # mensagens Webview↔Host, sanitização de manifesto, fila do Core
│       │                             # (arquivo único e grande de propósito histórico -- candidato a
│       │                             # modularização, ver plano de refatoração da auditoria de UI)
│       ├── language.ts              # locale ativo do VSCode -> pt-BR/en pra Webview e mensagens
│       ├── ipc/
│       │   ├── CoreClient.ts        # cliente do protocolo de controle (named pipe / unix socket)
│       │   ├── CoreProcess.ts       # spawn/lifecycle do processo Core nativo
│       │   ├── protocol.ts          # framing de linha (envelope de request/response/notification)
│       │   ├── types.ts             # DTOs do protocolo (PropertySchemaDto etc.), espelhados em model.ts
│       │   └── testSupport/MockCoreServer.ts  # servidor Core falso pra testes de CoreClient
│       ├── catalog/                 # lógica pura de catálogo/manifesto (testável, sem `vscode`)
│       │   ├── UnifiedCatalog.ts    # carrega/mescla component-catalog.json + registeredSources[]
│       │   ├── catalogMerge.ts      # normalização compartilhada (nextIndexedLabel etc.)
│       │   ├── simulideSceneTranslator.ts  # tradutor de cena `.sim2` real (import de subcircuito)
│       │   └── subcircuitInternals.ts # leitura de circuito interno/overlay de subcircuitos registrados
│       ├── project/
│       │   ├── ProjectTypes.ts      # schema do `.lsproj` (ProjectDocument/ProjectComponent/ProjectWire)
│       │   └── ProjectSerializer.ts # load/save com validação real de campo (não JSON.parse otimista)
│       ├── trust/
│       │   ├── TrustStore.ts        # decisão de confiar em publisher de plugin (sempre da Extension)
│       │   └── trustDecision.ts     # lógica pura de decisão, testável separado da UI de consentimento
│       └── ui/
│           ├── panels/
│           │   └── SchematicPanel.ts        # painel do canvas central (webview), sempre aberto
│           ├── views/
│           │   └── ComponentPaletteViewProvider.ts  # paleta -- Webview própria (`WebviewViewProvider`),
│           │       #  ver seção 13.1: NÃO é `TreeView` nativo (decisão final, revertida do plano original)
│           └── webview/             # código que RODA dentro da Webview (compila via tsconfig.webview.json)
│               ├── main.ts          # editor de esquemático inteiro: canvas, seleção, drag, fios, menus
│               │                     # de contexto, diálogo de propriedades (modal), undo/redo (arquivo
│               │                     # único e grande de propósito histórico, mesma nota de extension.ts)
│               ├── palette.ts       # script da Webview de paleta (busca/árvore/drag-to-place)
│               ├── paletteTree.ts   # construção da árvore a partir de `folderPath`/`category` (lógica pura)
│               ├── componentSymbols.ts  # renderer: PackageDescriptor -> SVG (ver seção 21 do native-devices.spec)
│               ├── simulidePaint.ts # tradutor SimulidePaintSpec -> PackageShape[] (primitivas declarativas)
│               ├── model.ts         # tipos da IR declarativa (PackageDescriptor, WebviewComponentModel...)
│               ├── messages.ts      # união discriminada HostToWebviewMessage/WebviewToHostMessage
│               ├── catalog.ts, instrumentTrigger.ts, valueFormatting.ts, wireGeometry.ts  # lógica pura auxiliar
│
├── core/                            # LasecSimul Core — C++ nativo, processo separado
│   ├── CMakeLists.txt
│   ├── include/lasecsimul/          # headers públicos (consumidos por plugins, ver native-devices.spec)
│   │   ├── IComponentModel.hpp      # interface C++ interna; addVoltageSource/addConductanceToGround reais, current()
│   │   ├── IMcuAdapter.hpp          # chipId/buildLaunchArgs/memoryRegions/pinMap/createModules()
│   │   ├── QemuModule.hpp           # base chip-específica: memStart/memEnd/writeRegister/readRegister/reset
│   │   ├── device_abi.h             # ABI C estável para plugins (ver lasecsimul-native-devices.spec), major 3
│   │   └── qemu_arena_abi.h         # protocolo real (regAddr/regData/SIM_READ/SIM_WRITE, 88 bytes, seção 8.1)
│   ├── test/
│   │   └── voltage_divider_test.cpp # fonte+2 resistores+terra, confere contra conta analítica (seção 7.3)
│   └── src/
│       ├── main.cpp                 # entry point do processo Core; cria GlobalPluginCache + 1 SimulationSession
│       ├── session/
│       │   └── SimulationSession.{h,cpp}     # dona de Netlist/Scheduler/PluginRuntime/Qemu desta sessão
│       ├── simulation/
│       │   ├── MnaSolver.hpp          # particiona em grupos, fatora/resolve via Eigen (seção 7.1)
│       │   ├── CircuitGroup.hpp       # 1 sistema linear (nós + variáveis extras, seção 7.3)
│       │   ├── UnionFind.hpp          # disjoint-set genérico — base das 2 passadas (seção 7.2)
│       │   ├── ComponentMatrixView.hpp # MnaMatrixView real, por componente (seção 7.2/7.3)
│       │   ├── SparseSet.hpp          # dirty-tracking O(1), array denso, cresce sob demanda (seção 7.4)
│       │   ├── Scheduler.{h,cpp}      # thread própria; fila de eventos = std::priority_queue + sequence (7.4)
│       │   └── Netlist.hpp            # 2 passadas de UnionFind + alocação de variável extra (seção 7.2/7.3)
│       ├── components/               # biblioteca padrão, compilada direto no Core (Tier nativo estático)
│       │   ├── passive/{Resistor,Capacitor,Inductor}.{h,cpp}
│       │   ├── active/{Diode,Bjt,Mosfet,OpAmp}.{h,cpp}        # candidatos a isNonlinear() (seção 7.4)
│       │   ├── logic/{AndGate,DFlipFlop,...}.{h,cpp}
│       │   ├── sources/{DcVoltageSource,AcVoltage,Battery}.{h,cpp} # DcVoltageSource já implementado
│       │   ├── connectors/Tunnel.hpp  # conecta por nome de túnel, não por fio (seção 7.2)
│       │   ├── other/Ground.hpp       # referência de 0V — todo grupo passivo precisa de uma (seção 7.3)
│       │   └── instruments/{Oscilloscope,Multimeter,FunctionGenerator,LogicAnalyzer}.{h,cpp}
│       ├── registry/
│       │   ├── ComponentRegistry.{h,cpp}         # factory, por sessão
│       │   ├── ComponentParams.hpp               # posição de pino + propriedades de uma instância
│       │   ├── ComponentMetadataRegistry.{h,cpp} # schema de pinos/propriedades/ícone, em GlobalPluginCache
│       │   └── McuRegistry.{h,cpp}
│       ├── plugins/
│       │   ├── PluginModule.{h,cpp}          # código carregado (refcount via shared_ptr), em GlobalPluginCache
│       │   ├── GlobalPluginCache.{h,cpp}     # PluginLoader + módulo ativo por typeId/chipId + metadata
│       │   ├── PluginLoader.{h,cpp}          # LoadLibrary/dlopen + validação de ABI — só descoberta/load
│       │   ├── PluginRuntime.{h,cpp}         # cria/destrói PluginInstance, por sessão
│       │   ├── NativeDeviceProxy.{h,cpp}     # PluginInstance de device
│       │   ├── NativeMcuAdapterProxy.{h,cpp} # PluginInstance de MCU adapter
│       │   └── QemuModuleProxy.hpp           # embrulha LsdnQemuModuleHandle (plugin) em QemuModule
│       ├── mcu/
│       │   ├── QemuProcessManager.{h,cpp}      # spawn/kill do processo qemu-system-* + arena (88 bytes, seção 8.1)
│       │   ├── McuComponent.{h,cpp}            # IComponentModel real: liga IMcuAdapter ao circuito via pinos
│       │   └── FirmwareWatcher.{h,cpp}         # poll de mtime na pasta configurada -> kill+respawn (seção 8.3)
│       # ESP32 não tem mais pasta aqui -- vive em mcu-adapters/espressif-esp32/ (plugin), não em core/src/mcu/
│       └── ipc/
│           ├── IpcServer.{h,cpp}
│           └── protocol/             # definição de mensagens do canal de controle
│
├── devices/                          # exemplos de plugins nativos de dispositivo (DLL/SO)
│   └── example-blinker/              # ver lasecsimul-native-devices.spec, seção 16
│
├── mcu-adapters/                     # exemplos de plugins nativos de MCU
│   └── espressif-esp32/              # ver lasecsimul-native-devices.spec, seção 10 (adaptado)
│
├── project/                          # gerenciamento de projetos (.lsproj) — schema compartilhado
│   └── schema/lsproj.schema.json
│
└── test/
    └── extension/                    # testes da camada TS (mock do IpcServer) — ainda não escrito
```

## 6. Interfaces principais

No **Core** (C++, `include/lasecsimul/`), únicas dependências que `MnaSolver`/`Scheduler` conhecem:

```cpp
// IComponentModel.hpp — implementada por componentes nativos E por NativeDeviceProxy (plugins)
class IComponentModel {
public:
    virtual ~IComponentModel() = default;
    virtual const char* typeId() const = 0;
    virtual std::span<Pin> pins() = 0;
    virtual uint32_t extraVariableCount() const { return 0; }   // fonte de tensão ideal, ver seção 7.3
    virtual void stamp(MnaMatrixView& matrix) = 0;       // só quando topologia/propriedade muda
    virtual bool isNonlinear() const { return false; }          // diodo/transistor, ver seção 7.4
    virtual bool hasConverged() const { return true; }
    virtual void postStep(uint64_t timeNs) = 0;          // hot path, opcional (ver Scheduler, seção 7)
    virtual size_t getState(uint8_t* out, size_t cap) const = 0;
    virtual void setState(const uint8_t* in, size_t len) = 0;
    virtual std::vector<PropertyDescriptor> propertyDescriptors() { return {}; } // edição em runtime, seção 6.1
    virtual std::optional<double> current() const { return std::nullopt; } // leitura de corrente, seção 6.1.4
};

// IMcuAdapter.hpp — chipId/buildLaunchArgs/memoryRegions/pinMap continuam declarativos;
// createModules() é a peça que faltava para o chip de fato afetar o circuito (ver McuComponent, seção 8).
class IMcuAdapter {
public:
    virtual ~IMcuAdapter() = default;
    virtual const char* chipId() const = 0;
    virtual QemuLaunchSpec buildLaunchArgs(std::string_view firmwarePath) const = 0;
    virtual std::span<const MemoryRegion> memoryRegions() const = 0; // faixa MMIO -> módulo concreto
    virtual std::span<const PinMapping> pinMap() const = 0;          // pino lógico -> bit/linha de um módulo
    virtual std::vector<std::unique_ptr<QemuModule>> createModules() const = 0; // módulos concretos do chip
};
```

`NativeDeviceProxy`/`NativeMcuAdapterProxy` implementam essas mesmas interfaces por dentro, delegando cada
método para a vtable C exportada por uma DLL/SO (`lsdn_device_abi.h`, detalhado em
`lasecsimul-native-devices.spec`). **O `MnaSolver` nunca sabe se está chamando um `Resistor` compilado no
Core ou um plugin carregado em runtime — o custo é o mesmo** (chamada virtual em processo único).

### 6.1 Modelo único de propriedade — compatível com o que o SimulIDE já permite hoje

Achado em auditoria do SimulIDE-dev: o sistema real de propriedades não é “um número editável e pronto”.
`gui/properties/` e `PropDialog` suportam, hoje, pelo menos estes formatos de edição:

- número com unidade/multiplicadores (`double`, `int`, `uint`, `numval.cpp`);
- enum com lista de valores e rótulos (`enum`, `enumval.cpp`);
- booleano (`bool`, `boolval.cpp`);
- texto curto (`string`, `strval.cpp`);
- texto longo/multilinha (`textEdit`, `textval.cpp`);
- caminho (`path`) e arquivo (`file`, ambos em `pathval.cpp`);
- cor (`color`, `colorval.cpp`);
- ponto/coordenada (`point`, usado em propriedades geométricas).

O LasecSimul **não** deve copiar essa taxonomia ao pé da letra na ABI, porque parte dela são detalhes de
widget e nomes históricos do código Qt. A regra aqui é: quando dois nomes do SimulIDE forem o mesmo conceito
com diferença só de apresentação, o contrato do LasecSimul deve unificar.

#### 6.1.1 Taxonomia canônica e simplificada

O contrato canônico do projeto passa a ter **4 tipos de valor** e metadados de UI por cima deles:

- `number` → cobre `double`, `int`, `uint` do SimulIDE.
  Metadados: `integerOnly`, `unsignedOnly`, `min`, `max`, `step`, `unit`, `siPrefixPolicy`.
- `string` → cobre `string`, `enum`, `color`, `path`, `file`, `textEdit`.
  Metadados: `editor` (`text`, `textarea`, `enum`, `color`, `path`), `options[]`, `pathKind`,
  `fileFilters[]`, `placeholder`.
- `bool` → cobre `bool`.
- `point` → cobre `point`.

Isso evita proliferar tipos quase-iguais na ABI sem perder capacidade:

- `enum` não vira um tipo de valor separado; é `string` com `editor="enum"` e `options[]`.
- `color` não vira um tipo de valor separado; é `string` com `editor="color"` (ex: `#RRGGBB`).
- `path` e `file` viram um conceito só (`editor="path"`), diferenciados por `pathKind`.
- `textEdit` e `string` viram o mesmo tipo de valor (`string`), diferenciados por `editor`.
- `double`/`int`/`uint` viram `number`, diferenciados por flags.

#### 6.1.2 `PropertySchema` substitui a visão minimalista antiga — implementado

O projeto deixou de tratar "propriedade editável" só como `name + unit + get/set`. O contrato canônico é um
schema reutilizável em manifesto, metadata registry, IPC e UI. Forma real implementada (`core/include/
lasecsimul/Types.hpp`, não a sketch original desta seção — ver nota abaixo):

```cpp
enum class PropertyValueKind : uint32_t { Number = 0, String = 1, Bool = 2, Point = 3 };

struct PropertyOption { std::string value; std::string label; };

enum PropertySchemaFlags : uint32_t {
    PropertySchemaNone = 0,
    PropertySchemaHidden = 1u << 0,
    PropertySchemaReadOnly = 1u << 1,
    PropertySchemaNoCopy = 1u << 2,
    PropertySchemaAffectsTopology = 1u << 3,
    PropertySchemaRequiresRestart = 1u << 4,
    PropertySchemaShowOnSymbol = 1u << 5,
};

struct PropertySchema {
    std::string id;             // chave estável em projeto/IPC/ABI
    std::string label;          // rótulo mostrado na UI
    std::string group;          // grupo/aba lógica, estilo PropDialog
    std::string unit;
    PropertyValueKind valueKind = PropertyValueKind::String;
    std::string editor = "text"; // "text" | "number" | "checkbox" | "switch" | "select"/"enum" | "display" | ...
    PropertyValue defaultValue = std::string{};
    std::optional<double> minValue;
    std::optional<double> maxValue;
    std::optional<double> step;
    std::vector<PropertyOption> options;
    uint32_t flags = PropertySchemaNone; // bitmask das 6 flags acima
};

using PropertyValue = std::variant<double, std::string, bool, PropertyPoint>; // PropertyPoint = {x, y}
```

Diferença da sketch original desta seção (corrigida agora pra não divergir do código real): `flags` é
bitmask (`uint32_t`), não `vector<std::string>`; `options` é `vector<PropertyOption>` (`{value, label}`
emparelhado), não dois arrays paralelos; `minValue`/`maxValue`/`step` são `optional<double>` dedicados, não
`optional<PropertyValue>` genérico (nenhuma propriedade hoje precisa de min/max não-numérico).

`PropertyDescriptor` (`core/include/lasecsimul/IComponentModel.hpp`) é o adaptador runtime — `get`/`set`
de UMA instância — e carrega o `PropertySchema` correspondente:

```cpp
struct PropertyDescriptor {
    std::string name;
    std::string unit;
    std::function<PropertyValue()> get;
    std::function<void(const PropertyValue&)> set;
    PropertySchema schema; // preenchido tanto por built-in quanto por plugin — ver abaixo
};
```

**Built-ins participam do mesmo contrato que plugins (lacuna fechada).** Cada componente built-in com
propriedade editável (`Resistor`, `Capacitor`, `Inductor`, `DcVoltageSource`, `Button`) declara um método
estático `propertySchema()` (mesmo arquivo `.hpp` do componente) que devolve o `PropertySchema` rico —
reusado em dois lugares: (a) `propertyDescriptors()` da instância preenche `PropertyDescriptor::schema` a
partir dele; (b) `CoreApplication::registerBuiltinComponents` registra o mesmo schema, por `typeId`, no
`ComponentMetadataRegistry` (`core/src/registry/ComponentMetadataRegistry.hpp`) — **o mesmo registry que
plugins já populavam via `loadDeviceLibraryFile`** (`.lsdevice`'s `properties[]`, parseado por
`parsePropertySchema`/`parsePropertySchemaList` em `CoreApplication.cpp`). Não existem dois registries
paralelos (um pra built-in, um pra plugin); a fonte é única, só o que a alimenta difere (C++ estático vs.
JSON de manifesto).

`SimulationSession::setProperty(component, id, value)` continua sendo o caminho genérico de edição em
runtime — localiza o `PropertyDescriptor` pelo nome e chama `set`. **Implementado** (estava listado como
pendente aqui até 2026-07-08, quando uma auditoria "pente fino" achou que já tinha sido feito sem a spec
ser atualizada — mesma classe de drift já documentada pro Newton-Raphson do diodo): validação de
tipo/faixa/opções contra o schema antes de chamar `set` (`SimulationSession.cpp:184-207`,
`propertyKindMatches`/`minValue`/`maxValue`/`options`, cada um com seu próprio código de erro) E reação
automática às duas flags — `affectsTopology`/`affectsPinCount` marcam `m_topologyDirty = true`
(`SimulationSession.cpp:211`); `requiresRestart` volta `{"requiresRestart": true}` na resposta IPC de
`setProperty` (`CoreApplication.cpp:1408-1409`), lido por `coreLifecycle.ts` que mostra
`vscode.window.showInformationMessage(...)` pro usuário — regressão coberta em
`core/test/core/CoreBootstrapTest.cpp` ("setProperty aplica mudanca em propriedade requiresRestart").

#### 6.1.3 IPC `getPropertySchemas` e fluxo até a Webview — implementado

A lacuna "6. IPC de metadata" (seção 6.2 original) está resolvida assim — **divergindo da sketch original
de `ComponentDisplayMeta.propertySchema` por instância**: schema é por **`typeId`** (catálogo), nunca por
instância, então viaja junto do catálogo, não de cada componente.

```
Core: handler "getPropertySchemas" (sem payload) → { schemasByTypeId: { "<typeId>": [<schema>, ...] } }
      -- itera ComponentMetadataRegistry::all() (novo método), serializa cada PropertySchema via
         propertySchemaToJson() (inverso de parsePropertySchema), CoreApplication.cpp
Extension: CoreClient.getPropertySchemas() → extension.ts::attachPropertySchemas(), chamado dentro de
      refreshUnifiedCatalogState() depois de loadConfiguredDeviceLibraries() -- anexa
      WebviewComponentCatalogEntry.propertySchema (PropertySchemaEntry[], cópia webview-safe do DTO,
      ver extension/src/ui/webview/model.ts) por entrada do catálogo, casando por typeId
Webview: main.ts::resolvePropertyFields(component) -- acha a entrada do catálogo pelo typeId do
      componente, monta PropertyField[] na ORDEM do array do schema (isso já dá ordem de campo E ordem
      de grupo/aba); cai pra heurística antiga (inferPropertyFields, por typeof do valor JS) só se o
      Core não tiver schema pra aquele typeId ainda (ex: registrado porém desabilitado)
```

`listComponents()`/`ComponentDisplayMeta` (a sketch original desta seção) **permanecem um gap separado,
ainda não implementado** — declarado em `CoreClient.ts`, sem handler no Core (ver `docs/mvp-limitacoes.md`).
Não foi reaproveitado pra schema porque seu DTO é por instância; `getPropertySchemas` resolveu a
necessidade real (UI de propriedades) sem depender dele.

Teste de regressão: `core_bootstrap` (`testGetPropertySchemasOverIpc` — built-in aparece sem nenhum
`loadDeviceLibrary`, plugin aparece só depois); `passive_components`/`logic_components` (cada
`propertyDescriptors()[0].schema` não-vazio).

#### 6.1.3.1 ABI v2 (2026-06-30) — `readoutFormatByTypeId`/`interactionKindByTypeId`, mesmo payload

A mesma resposta de `getPropertySchemas` ganhou 2 mapas irmãos ADITIVOS (`readoutFormatByTypeId`/
`interactionKindByTypeId`, por typeId) — como a UI decodifica `getComponentState()`/interage com um
componente sem checar typeId em código nenhum. Especificação completa, desenho, justificativa (por que
LasecSimul precisa disso onde o SimulIDE usa despacho virtual C++) e migração dos devices reais em
`.spec/lasecsimul-native-devices.spec` seção 22. Teste de regressão: `core_bootstrap`
(`testGetPropertySchemasOverIpc`, mesma função, asserções novas pra oscope/logic_analyzer/ampmeter/
freqmeter/probe/push/switch).

#### 6.1.3.2 `setSubcircuitChildProperty`/`getSubcircuitChildInstanceId` (2026-06-29)

Variante de `setProperty` endereçando por `{instanceId do subcircuito, localId do componente interno}`
em vez de um `componentIndex` de topo (a Extension não tem como conhecer o índice Core de um
componente DENTRO de um subcircuito sem perguntar) — usado pelo overlay de Modo Placa e pelo diálogo
de propriedades de componente exposto no esquemático principal. Especificação completa em
`.spec/lasecsimul-subcircuits.spec` seção 6.1 (handler em `CoreApplication.cpp`,
`SimulationSession::findSubcircuitChildByLocalId`).

### 6.1.4 Leitura de corrente (`current()`) — implementado 2026-06-28

Opção de baixo custo, sem incógnita nova na matriz: `IComponentModel::current()` lê estado já cacheado na
última `stamp()` (`std::nullopt` se o componente não implementa). `MnaMatrixView::getBranchCurrent()` dá
leitura gratuita da corrente de ramo de fontes de tensão ideal (variável extra já resolvida).
`SimulationSession::componentCurrent(componentIndex)` nunca dispara solve novo — `std::nullopt` se o
componente não implementa ou já foi removido (mesmo princípio de `nodeVoltageOfPin`). Exposto via IPC
`getComponentCurrent` (`CoreApplication.cpp`) e `CoreClient.getComponentCurrent` na Extension.

**Convenção de sinal, validada empiricamente, não só derivada**: convenção passiva — positiva entrando no
primeiro pino/saindo no segundo (ou na terra implícita pra componente de 1 pino); fonte fornecendo energia
aparece **negativa**. Implementado em: `Resistor`, `Inductor`, `Capacitor` (sempre 0.0 — modelo atual não
contribui nada pra matriz), `Diode`, `DcVoltageSource`, `Battery`, `Rail`, `FixedVolt`, `VoltSource`,
`CurrSource`, `Csource`, `Clock`, `WaveGen`, `Ampmeter`.

Lição de um bug real corrigido neste caminho: qualquer componente com pino "decorativo" (ex: `gnd` de um modo
de operação) precisa de alguma contribuição na matriz — nunca zero absoluto, ou a linha fica inteiramente
zerada (matriz singular). `WaveGen` no modo não-bipolar tinha esse bug, corrigido fixando o pino em 0V via
`addConductanceToGround`.

### 6.1.5 `PropertyDefinition` — schema + get/set num só lugar (implementado 2026-07-09)

Achado de auditoria arquitetural (`docs/25-auditoria-arquitetural-core-2026-07-09.md`; ver também
ADR 0010): até esta correção, cada built-in implementava **dois** métodos separados —
`static propertySchema()` (metadado) e `propertyDescriptors()` de instância (get/set) — sempre
redigitando o `id` de cada propriedade duas vezes, sem vínculo verificado pelo compilador. Isso já
causou um bug real em `Probe.hpp`: o descriptor pegava schema por ÍNDICE numérico do vetor, então
reordenar `propertySchema()` quebraria o descriptor errado em silêncio.

`core/include/lasecsimul/PropertyDefinition.hpp` (novo) declara:

```cpp
struct PropertyDefinition { PropertySchema schema; std::function<PropertyValue()> get;
                             std::function<PropertyBindResult(const PropertyValue&)> set; };

std::vector<PropertyDescriptor> toPropertyDescriptors(std::vector<PropertyDefinition>);
std::optional<std::string> validatePropertyValue(const PropertySchema&, const PropertyValue&);
PropertyValue propertyOrDefault(const std::unordered_map<std::string, PropertyValue>& properties,
                                 const PropertySchema& schema);
PropertySchema schemaById(const std::vector<PropertySchema>& schemas, const std::string& id);
```

Uma classe migrada declara `properties()` (não-estático, schema+get+set casados por `schemaById`,
nunca por posição) e `propertyDescriptors()` vira `return toPropertyDescriptors(properties());`.
`propertySchema()` estático continua existindo (usado por `registerBuiltinMetadata`, sem instância
disponível ainda) — agora é a ÚNICA fonte de schema, `properties()` busca nele por id.

`propertyOrDefault` fecha uma segunda lacuna, mais séria: `ComponentParams::property(name, default)`
(usado na CRIAÇÃO de um componente, a partir de um `.lsproj` salvo) nunca validava nada contra o
schema — caía no default do chamador em qualquer mismatch de tipo/faixa, em silêncio total. Já
causou 2 bugs reais confirmados (`SimulidePassiveState`, `Probe` — `pauseOnChange`/`showVolt`
perdidos ao reabrir um projeto). `propertyOrDefault` valida o valor salvo contra o schema
(`validatePropertyValue`, mesma regra que `SimulationSession::setProperty` já usa em runtime) antes
de aceitar; se inválido, cai no default do SCHEMA (não do chamador) com log em stderr.

**Migração completa (2026-07-09)**: todos os built-ins do Core (`core/src/components/**/*.hpp`,
incluindo as 8 classes-molde de `SimulideBuiltins.hpp`) foram migrados pro padrão `properties()` --
não sobra nenhum `descriptor.schema = schemas[N]` (acoplamento posicional) no projeto. Detalhe
completo por arquivo em `docs/25-auditoria-arquitetural-core-2026-07-09.md` §17.1 e ADR 0010.
`Probe`/`Resistor`, as duas classes com bug real já confirmado, também tiveram suas fábricas em
`registerBuiltinComponents` (`CoreApplication.cpp`) convertidas pra `propertyOrDefault` em vez de
`p.property()` direto -- as demais ~23 fábricas continuam usando `p.property()` (o lado de EDIÇÃO já
valida via `PropertyDescriptor::set` migrado; só o lado de CRIAÇÃO ainda não converteu pra
`propertyOrDefault` em todo lugar, gap menor que o original já que o schema agora existe e é
consistente em toda classe).

Teste dedicado: `core/test/property_definition_test.cpp` (`property_definition` no `ctest`) —
prova `validatePropertyValue`/`propertyOrDefault` isoladamente e que editar UMA propriedade de
`Probe`/`Resistor` nunca afeta as outras (a exata classe de bug que o acoplamento posicional antigo
permitia); `inert_components_fix_test.cpp` cobre o comportamento elétrico de `OpAmp`/`AnalogMux`/
`ResistorArray`/`DiodeLegArray` (também migrados, junto com `leakagePinIndices()` -- ver seção sobre
LeakageGuard em `.spec/lasecsimul.spec` §7.3 e ADR 0011).

### 6.2 Lacunas obrigatórias antes da expansão do catálogo estilo SimulIDE

Para que o catálogo atual do SimulIDE (ver `itemlibrary.cpp` e `gui/properties/`) possa migrar para o
LasecSimul sem reabrir arquitetura a cada família de componente, os seguintes pontos foram identificados.
Status atualizado depois da seção 6.1.2/6.1.3:

1. ~~**ABI de propriedade genérica**: substituir o bootstrap limitado a `get_property_f32` por
   `config_get` + `set_property/get_property` tipados.~~ **Feito** — `device_abi.h`, vtable de plugin tem
   `get_property`/`set_property` (10 funções, ABI 1.1); `config_get` existe em `LsdnHostApi`.
2. ~~**Schema único de componente**: `.lsdevice`/catálogo/IPC/Core precisam falar o mesmo idioma para
   `pins`/`properties`.~~ **Feito pra `properties`** (seção 6.1.2/6.1.3, built-in e plugin no mesmo
   `ComponentMetadataRegistry`). **Ainda não feito pra `package`/`pins`** de built-in — ver item 3.
3. **Package data-driven**: a renderização de símbolo/corpo/pinos de built-in ainda depende de
   `componentSymbols.ts` (switch hardcoded por `typeId`) — plugins/subcircuitos já usam `package.json`
   data-driven (`lasecsimul-native-devices.spec` seção 21), built-ins não. **Parcialmente mitigado pela seção
   13.5** (2026-06-28): os componentes que precisavam de renderização gráfica rica/protocolada (displays,
   TFTs, MAX72xx, WS2812, servo, DIAC/SCR/TRIAC, BJT/MOSFET/JFET, transformer) foram movidos de built-in
   incompleto pra plugin ABI — esses já ganham `package.json` data-driven de graça. O que resta como built-in
   C++ de fato (resistivos, potenciômetro, chaves, relé simples, regulador, LED simples) não precisa de
   renderização rica hoje; o gap descrito aqui só volta a importar se um built-in novo precisar de corpo
   gráfico custom — não bloqueia o catálogo atual.
4. **Semântica declarada de propriedade**: flags `affectsTopology`/`requiresRestart`/`readOnly`/
   `showOnSymbol`/`noCopy`/`hidden` **existem no schema e viajam até a UI** (`readOnly`/`hidden`/
   `showOnSymbol` já têm efeito real na Webview — campo desabilitado, oculto, ou ligado à telemetria).
   `affectsTopology`/`requiresRestart` **ainda não têm efeito no Core** (são metadata exibida, não
   comportamento) — aberto, ver nota no fim da seção 6.1.2.
5. **Core como runtime genérico**: built-ins continuam classes C++ dedicadas (não migraram pra
   manifesto+ABI) — decisão consciente desta rodada: deram ao built-in o MESMO schema rico que plugin já
   tinha, sem removê-los como C++. Migrar built-in pra plugin "de fábrica" continua um item separado, não
   decidido. Aberto.
6. ~~**IPC de metadata**: a UI deve poder pedir ao Core/registry o schema completo do componente sem
   inferir comportamento por `typeId`.~~ **Feito** — `getPropertySchemas` (seção 6.1.3).

Itens 3 e 5 continuam abertos; sem eles, built-in nunca atinge paridade total de extensibilidade com
plugin/subcircuito (que já são 100% manifesto), mas isso não bloqueia o catálogo atual de crescer com novas
propriedades — só limita acrescentar built-in NOVO sem tocar C++.

### 6.3 Internacionalização de strings declarativas (labels, grupos, taxonomia) — implementado

**Requisito**: toda string visível de UI que vem de uma declaração estática (não de telemetria/estado de
simulação) — nome de componente, rótulo/grupo de propriedade, rótulo de opção de enum, segmento de
`folderPath`/categoria da paleta — precisa suportar múltiplas línguas. Quem constrói um dispositivo (plugin
nativo ou, no futuro, um subcircuito publicado) declara em qual língua (ou línguas) escreveu essas strings;
a UI mostra na língua ativa do VSCode quando disponível, senão cai pra língua que o autor de fato forneceu
— nunca string vazia, nunca erro. Built-in segue o mesmo contrato (hoje só declara `pt-BR`).

Precedente real, não suposição: o próprio SimulIDE-dev já resolve exatamente isto — `itemlibrary.cpp`
declara os nomes/categorias em inglês e `resources/translations/simulide_pt_BR.ts` (Qt Linguist, mecanismo
`tr()`) fornece a tradução pt_BR carregada em runtime (já referenciado na seção 13.1). O LasecSimul não
reusa Qt Linguist (não há Qt no projeto), mas adota o mesmo princípio — string base + mapa de traduções —
num formato JSON simples, coerente com o resto do manifesto.

#### 6.3.1 `LocalizedString` — tipo canônico

```typescript
// Conceitual — mesmo formato em JSON (.lsdevice, component-catalog.json) nos dois lados (Core e
// Extension), implementado duas vezes (C++ e TypeScript) com o MESMO algoritmo de resolução, não
// uma dependência cruzada entre os dois processos.
type LocalizedString = string | Record<string, string>;
// string simples = string já na língua-base declarada pelo manifesto (ver 6.3.2) -- forma mínima,
// sem exigir mapa de quem só escreve numa língua.
// Record<string,string> = mapa BCP-47 (ex: "pt-BR", "en", "en-US") -> string traduzida.
```

**Implementado** (`devices/voltmeter/.lsdevice`, `project/schema/component-catalog.json`): o tipo é o
conceito; a codificação JSON real NÃO faz o campo em si virar union — `properties[].label`/`items[].label`
continuam sempre string simples (a língua-base, exatamente como já eram antes desta seção existir), e o
"mapa" mora num bloco `translations.<lang>` paralelo, separado, no mesmo arquivo (ver 6.3.2). Mantém o
arquivo-base 100% legível como já era (puro pt-BR), em vez de toda string virar `{"pt-BR": "...", "en":
"..."}` inline — o `LocalizedString` acima é o modelo mental, não o JSON literal.

Todo campo hoje declarado como `string` solto e VISÍVEL ao usuário final passa a aceitar
`LocalizedString` em vez de só `string` — não troca de tipo nos campos que são identificador estável
(`id`, `typeId`, `editor`, `valueKind`, `unit` continuam `string` puro: `unit` é símbolo técnico ("Ω", "V"),
não texto traduzível). Campos afetados:

- `.lsdevice`: `name` (nome do dispositivo), `properties[].label`, `properties[].group`,
  `properties[].options[].label`, `pins[].label`, `package.shapes[].value` (texto desenhado no símbolo).
- `component-catalog.json`/`library.json`/fontes registradas: `items[].label`, cada segmento de
  `items[].folderPath` (categoria/pasta da paleta).
- Schema de built-in (C++, `PropertySchema::label`/`group`, `PropertyOption::label`, `displayName` de
  `ComponentMetadata`): mesma forma conceitual, representada em C++ como
  `std::variant<std::string, std::unordered_map<std::string, std::string>>` (ou `std::string` continua
  válido — caso de língua única — e um mapa só existe quando há tradução de fato).

#### 6.3.2 Língua-base declarada — nunca string vazia

Todo manifesto (`.lsdevice`) e toda declaração de built-in passam a ter uma língua-base obrigatória:

```json
{
  "language": "pt-BR",
  "translations": {
    "en": {
      "name": "DC Voltmeter (two-point measurement)",
      "properties": { "displayVoltage": { "label": "Measured voltage", "group": "Reading" } }
    }
  }
}
```

- `language` (string, BCP-47, **obrigatório**): a língua em que o autor escreveu os campos `string`
  simples do resto do manifesto (`name`, `properties[].label`, etc.) — declarar isto é o que permite ao
  host saber "essa string que não é um mapa, em que língua está" sem adivinhar.
- `translations` (objeto, **opcional**): por língua adicional, um subconjunto dos MESMOS campos
  (`name`/`properties.<id>.label`/`.group`/opções/`pins.<id>.label`) — só o que o autor efetivamente
  traduziu; campo ausente em `translations.<lang>` cai pra língua-base, não pra string vazia.
- Regra de catálogo desta fase: para componentes/dispositivos mantidos pelo projeto, `translations.en`
  deixa de ser opcional na prática e passa a ser obrigatória; a língua-base continua `pt-BR`.
- A mesma regra vale pros segmentos de pasta/categoria (`folderPath`) e para nomes derivados de fontes
  registradas/subcircuitos: a UI nunca deve ficar presa a um nome de pasta em uma língua só quando o
  usuário alternar a configuração do editor entre `pt-BR` e `en`.
- Um dispositivo com `language` só (sem `translations`) é 100% válido — equivalente ao "se não tiver a
  primeira [tradução], usa a que tem" pedido: a língua-base SEMPRE existe e é sempre o fallback final.
- `folderPath`/`label` no catálogo seguem a mesma idéia: cada fonte (catálogo base, `library.json` de
  plugin, fonte registrada) declara seu `language`; quando o autor não traduziu o `folderPath` pra outra
  língua, a pasta na paleta aparece na língua-base mesmo com a UI em outro idioma — preferível a uma
  pasta com nome técnico/typeId.

#### 6.3.3 Resolução — mesmo algoritmo nos dois processos

```
resolve(localized, requestedLang, baseLang):
  se localized é string simples  → devolve localized (já é a língua-base, por definição de 6.3.2)
  se localized é mapa:
      se mapa[requestedLang] existe        → devolve mapa[requestedLang]
      senão se mapa[baseLang] existe         → devolve mapa[baseLang]
      senão                                  → devolve o primeiro valor do mapa (alguma língua existe,
                                                 nunca um mapa vazio é um LocalizedString válido)
```

- **Core** resolve isso ao responder `getPropertySchemas` (e, no futuro, qualquer verbo de metadata):
  request ganha um campo opcional `language` (BCP-47); Core devolve string já resolvida, não o mapa
  inteiro — Extension/Webview nunca precisam saber que tradução existe, só o resultado.
- **Extension** resolve isso pro `component-catalog.json`/fontes registradas (que ela lê direto do disco,
  sem o Core no meio) com o MESMO algoritmo, implementado em TS — `vscode.env.language` é a `requestedLang`
  passada pros dois lados (pro Core, vai dentro do payload de `getPropertySchemas`; pro catálogo local, é
  só uma chamada de função).
- Webview nunca resolve idioma — sempre recebe string já resolvida tanto do catálogo (Extension) quanto
  do schema (Core via Extension) — consistente com a Webview não ter acesso a `vscode.*` (decisão de
  desacoplamento, seção 1.1/ADR 0007).

#### 6.3.4 Fora de escopo desta seção

- Strings de erro/log do Core e da Extension (não são declarativas de dispositivo, não fazem parte do
  manifesto) — fora de escopo; tratamento de l10n da própria Extension (`vscode-nls`/`package.nls.json`,
  textos de comando/menu) é mecanismo nativo do VSCode, decisão independente, não decidida aqui.
- Subcircuitos (`.lssubcircuit`) ganham o mesmo contrato (`language`/`translations`) quando a seção 5 de
  `lasecsimul-subcircuits.spec` for revisada — não duplicado aqui, só referenciado.
- Decisão completa, alternativas descartadas e justificativa em
  `docs/adr/0009-localizacao-de-strings-declarativas.md`.

## 7. Fluxo de simulação

0. **Handshake de versão, antes de qualquer comando**: ao conectar, `CoreClient` envia `{ protocolVersion }`;
   `IpcServer` responde aceitando ou recusando. Versão incompatível encerra a conexão com erro explícito —
   nunca segue assumindo compatibilidade. Isso é o que permite evoluir mensagens do canal de controle sem
   migração retroativa (ver RNF08); o payload de cada mensagem é versionado dentro do mesmo esquema.
   **Framing de transporte** (2026-06-30): cada mensagem é uma linha JSON terminada em `\n`
   (newline-delimited), igual desde sempre — o que mudou foi `IpcServer::readLine()` (Windows e
   POSIX): lia 1 byte por `ReadFile`/`read()` (N syscalls pra uma mensagem de N bytes, clássico
   gargalo de I/O); passou a ler em blocos de 4096 bytes num `m_readBuffer` interno, extraindo linhas
   por `\n` e guardando sobra parcial pro próximo `readLine()` — mesmo protocolo/formato de mensagem,
   só troca de ESTRATÉGIA de leitura. `sendLine()` não mudou (já escrevia a linha inteira de uma vez).
1. Webview edita o esquemático → `CoreClient` envia o diff (componente adicionado/removido, propriedade
   alterada, conexão alterada) pelo canal de controle ao `IpcServer` do Core.
2. Core atualiza a `Netlist` e marca os componentes afetados como "dirty".
3. `Scheduler` roda em **thread própria, separada da thread do `IpcServer`** — espelha o padrão GUI-thread +
   worker-thread do SimulIDE (`Simulator::timerEvent`/`QtConcurrent::run`, ver decisão da seção 7.1): um
   macropasso pesado nunca atrasa a resposta a um comando `pause`/`addComponent` chegando por IPC.
   **Correção sobre o SimulIDE**: lista de "dirty" não é lista ligada intrusiva — é um *sparse set* (seção
   7.1) por ser mais amigável a cache em hardware atual; mesmo efeito (push/remove O(1), sem alocação por
   item), iteração contígua em vez de perseguir ponteiros.
4. A cada macropasso `Δt`, dentro de um laço que **assenta antes de avançar o tempo** (não é stamp-once/
   solve-once — ver seção 7.1, "settle loop"):
   a. Componentes "dirty" são stampados (lineares direto; não-lineares entram na iteração de
      `NewtonRaphson`) — cada um escreve só no grupo (componente conectado) a que pertence (seção 7.1).
   b. `MnaSolver` resolve **só os grupos que mudaram** — refatora (LU) só se a admitância/topologia daquele
      grupo mudou; se só a fonte/corrente mudou, reaproveita a fatoração e só resolve (seção 7.1) — e resolve
      múltiplos grupos dirty **em paralelo** no thread-pool do Core, já que grupos não compartilham estado.
   c. Se o solve de algum grupo dirtyficou outro componente (ex: saída de um comparador muda, derruba a
      entrada de outro), volta ao passo (a) para esse(s) componente(s) **antes** de avançar `Δt` — o laço só
      sai quando não há mais "dirty" pendente e a iteração não-linear convergiu.
   d. `postStep()` roda **só** para componentes que se registraram como "dinâmicos" (capacitores/indutores
      com estado, fontes variáveis no tempo, instrumentos amostrando, plugins com comportamento temporal,
      pinos de MCU) — um resistor estático nunca tem `postStep()` chamado.
   e. Detecção de borda digital: quando a tensão de um nó cruza `kDigitalLevelThreshold` (2.5V,
      `core/include/lasecsimul/Types.hpp`), dispara `ComponentEvent{kPinChangeEventTag, localPinIndex,
      nivel, nsDesdeABordaAnterior}` para todo componente/pino presente naquele nó (`Netlist::Topology::
      pinRefsByNode`) — built-in ou plugin, sem distinção. **Substitui por completo** o antigo
      `BusController`/I2C/SPI/UART por byte: protocolo agora é decodificado bit a bit pelo próprio
      componente/device do outro lado do fio, nunca por um módulo de barramento intermediário.
   f. `McuComponent` (MCU emulado) processa eventos pendentes da arena QEMU no seu próprio `stamp()`
      (`SIM_READ`/`SIM_WRITE` despachado pro `QemuModule` certo por endereço) e injeta no `Netlist` os
      níveis elétricos resultantes — tudo dentro do mesmo processo Core, sem cosimulação assíncrona
      (diferente do que era necessário com WASM/workers). Agendamento é por evento detectado, não pelo
      timestamp exato (`qemuTime`) reportado pelo QEMU — simplificação aceitável para GPIO digital simples,
      revisitar se/quando precisão de timing fino for necessária (ver `docs/17-pendencias-pos-sessao-qemu-abi.md`,
      seção 3.6).
5. Telemetria (amostras de instrumentos, traços de pino) é publicada num ring buffer de memória compartilhada;
   a Extension lê e renderiza no webview sem round-trip de IPC por amostra. Política de descarte sob
   saturação é a da RNF09 (descarta amostra mais antiga; eventos discretos como `faulted` vão pelo canal de
   controle, não por aqui).
6. `pause()/step()/stop()` controlam o `Scheduler`; o Core não distingue se a pausa veio de um comando do
   usuário ou de um breakpoint de firmware via QMP. Como o `Scheduler` está em thread própria (item 3), esses
   comandos chegam e são honrados mesmo com um macropasso pesado em andamento.

**Auditoria de performance (2026-06-30)**: revisão dedicada do solver/scheduler (dirty-tracking em 2
níveis, item 7.1 abaixo) e do carregamento de DLL/projeto (`LoadLibrary`/`dlopen` nativo do SO) não
achou gargalo real sem evidência de profiling — ambos documentados como já adequados nesta rodada, sem
mudança especulativa. Os 2 gargalos REAIS confirmados e corrigidos foram: leitura de IPC byte a byte
(item 0 desta seção) e reconstrução total do DOM da Webview a cada render (`extension/src/ui/webview/
main.ts::createComponentElement`/`updateComponentElement`, reconciliação incremental por id —
implementada, pendente validação manual interativa do usuário antes de considerar fechada).

### 7.1 `MnaSolver` — decisões de algoritmo (auditoria do SimulIDE-dev, com correções)

Mecanismo de partida validado lendo `C:\SourceCode\simulide_2\src\simulator\{circmatrix,e-node,simulator}.{h,cpp}` — mas
**não copiado às cegas**: SimulIDE é um projeto solo de 2012+, e nem toda escolha dele resiste ao escrutínio
em hardware/bibliotecas de hoje. Decisão por item, com o porquê:

| Item | Decisão | Origem |
|---|---|---|
| Particionar por componente conectado (DFS sobre adjacência de nós, cada grupo galvanicamente isolado vira um sistema linear independente) | **Adotado como está** | `CircMatrix::analyze()`/`addConnections` — técnica atemporal de teoria de grafos, sem contra real |
| Dirty em 2 níveis por grupo: admitância (precisa refatorar) vs corrente (só resolver) | **Adotado como está** | `CircMatrix::solveMatrix()` — técnica numérica padrão (SPICE moderno faz igual), não é "coisa de 2012" |
| Nó isolado (1 conexão) resolve por Lei de Ohm direta, com acumulador próprio, nunca entra em matriz | **Substituído**: vira `CircuitGroup` 1×1 normal, mesmo pipeline Eigen de qualquer outro grupo | `eNode::solveSingle()`/`m_totalCurr`/`m_totalAdmit` — útil pra evitar montar matriz em 2012; com Eigen, 1×1 já é trivial, manter um acumulador paralelo só pra esse caso é complexidade que não se paga aqui. Único cuidado: nó sem nenhuma conexão real dá matriz singular — detectar (`!voltages.allFinite()`) e cair pra 0V com aviso, nunca propagar NaN |
| Hierarquia (subcircuitos/dispositivos aninhados) achatada num `Netlist` único antes do solver rodar | **Adotado como está** | `Simulator::createNodes()` — sem matriz-dentro-de-matriz |
| LU densa, sem pivoteamento, escrita à mão (método de Crout) | **Substituído**: `Eigen::PartialPivLU` (denso, com pivoteamento parcial) por grupo; `Eigen::SparseLU` como caminho alternativo quando um grupo crescer além de um limiar configurável | A versão do SimulIDE não pivota (`if (div==0) continue`, sem mais) — risco de imprecisão numérica em matrizes mal-condicionadas; vetorização/cache de uma lib madura supera loop manual |
| Lista de "dirty"/changed via ponteiro intrusivo (`nextChanged`) | **Substituído**: sparse set (array denso + índice esparso, swap-and-pop na remoção) — mesma O(1) de push/remove, sem perseguir ponteiro | Pointer-chasing é hostil ao cache em CPUs atuais; array contíguo favorece prefetch e (eventual) vetorização ao iterar "tudo que está dirty" |
| Fila de eventos agendados (timers) via ponteiro ordenado por tempo | **Substituído**: `std::priority_queue` (heap binário sobre array) | Mesmo raciocínio do item anterior — stdlib já dá isso de graça, sem reinventar |
| Resolver matriz inteira numa única worker thread (nunca paralelo entre núcleos) | **Divergência deliberada**: grupos dirty são resolvidos em paralelo no thread-pool do Core quando há mais de um grupo grande o bastante para compensar o overhead | SimulIDE nunca paraleliza o solve; isso parece limitação de projeto solo, não escolha de escala — paralelizar **entre grupos** é seguro porque grupos não compartilham estado mutável por construção (não é o mesmo risco de paralelizar dentro de uma única matriz grande) |

Sem solver esparso desde o v1 — `Eigen::SparseLU` fica especificado como caminho de upgrade (mesma interface,
trocar a implementação por grupo quando o nó count justificar), não implementado às pressas antes de medir se
algum grupo real chega a ficar grande o suficiente para precisar. Gatilho concreto, não "algum dia": acima de
`kLargeGroupNodeThreshold` (200 nós num único grupo, ajustável por medição real) o Core registra um aviso —
isso dá um sinal mensurável de quando vale revisitar, em vez de decidir por intuição.

**Equilibração diagonal (Jacobi), adicionada 2026-06-29** — `CircuitGroup::factor()`/`solve()`: antes de
checar posto/`rcond()` e de fatorar, cada linha/coluna `i` é escalada por `1/sqrt(|A_ii|)` (variável extra
com diagonal 0 por construção MNA fica com escala 1, intocada). Achado real, não preventivo: um grupo
misturando condutância "ideal" Norton-pra-terra (`Ground`/`FixedVolt`/`Clock`/`VoltSource`/`WaveGen`, todas
`1e9`) com um componente de muitos pinos simultaneamente flutuantes (`McuComponent`, `1e-6` — ajustado pra
ficar seguro sozinho, nunca testado em conjunto) fazia `FullPivLU::rank()` cair bem abaixo de `cols()` —
nenhuma linha literalmente zerada, só o threshold do Eigen (`maxPivot·tamanho·epsilon`) sepultando as linhas
fracas por spread de magnitude, não por falta de conexão real. `CircuitGroup::singular()` rejeitava o grupo
inteiro (caso real: pull-up + botão de um GPIO do ESP32 ligado a GND/3V3, `subcircuits/
esp32_devkitc_v4.lssubcircuit`, EN/BOOT). Equilibração é transformação de similaridade (`x = S·y`, resolve-se
`S·A·S·y = S·b`) — preserva a solução exata a menos de erro de ponto flutuante, não muda comportamento de
grupo já bem-condicionado, e resolve a causa raiz pra qualquer combinação futura de magnitudes, não só este
caso (ver `.spec/lasecsimul-native-devices.spec` seção 8.1 para o relato completo do bug original).

### 7.2 Resolução de topologia — `Netlist` (pino → nó → grupo)

Validado contra um caso real do SimulIDE que expõe uma fonte de "conexão" diferente de fio:
**`Tunnel`** (`C:\SourceCode\simulide_2\src\components\connectors\tunnel.{h,cpp}`) une pinos por **nome
compartilhado**, não por desenho gráfico — `Tunnel::registerEnode()` propaga o mesmo `eNode` para
todo outro `Tunnel` com o mesmo nome via um registro estático (`m_tunnels`). A resolução abaixo
generaliza isso sem caso especial: união por nome é só outra fonte de aresta para a mesma primitiva
de união usada para fio.

**Duas passadas de `UnionFind` (`core/src/simulation/UnionFind.hpp`), sempre recalculadas do
zero quando a topologia muda — nunca incrementais.** Motivo de não serem incrementais: união não é
desfazível (renomear um túnel pode separar nós que estavam fundidos), e recalcular do zero é barato
porque topologia só muda em edição do usuário, nunca no caminho crítico de simulação — mesmo
princípio do `Simulator::createNodes()` do SimulIDE, que também deleta tudo e reconstrói.

1. **Passada 1 (pino → nó)**: cada pino de cada componente recebe um *slot* na criação
   (`Netlist::registerComponent`). Dois slots se unem por **fio** (`connectWire`) ou por
   **grupo de túnel** — todo slot com o mesmo nome de túnel é unido entre si
   (`setTunnelName`, ver abaixo). Resultado: `slot -> nó global` (id denso).
2. **Passada 2 (nó → grupo)**: cada componente une os nós dos seus **próprios** pinos entre si —
   é isso que faz um resistor de dois nós diferentes virar um `CircuitGroup` só (eles estão
   eletricamente diferentes, mas pertencem ao mesmo sistema linear a resolver). Resultado:
   `nó -> grupo` (id denso), que constrói os `CircuitGroup` (seção 7.1).

Diferente do SimulIDE: o registro de nomes de túnel vive no **`Netlist` de cada `SimulationSession`**,
nunca num `static QMap` de processo inteiro — dois projetos abertos nunca compartilham nomes de
túnel por acidente (isolamento que o SimulIDE, sendo single-document, não precisava resolver).

**Listener por nó**: junto com a passada 1, `Netlist` monta `listenersByNode[nó] -> [componentIndex]`
— quem tem um pino naquele nó. Depois de cada `MnaSolver::solve()`, `SimulationSession` compara a
tensão nova contra a anterior por nó; só os nós que **de fato mudaram** (epsilon, não bit-exato)
marcam seus listeners como dirty — isso é o que fecha o settle-loop da seção 7 sem reprocessar o
circuito inteiro a cada round.

**`ComponentMatrixView`** (`core/src/simulation/ComponentMatrixView.hpp`) é a implementação real de
`MnaMatrixView`: criada por componente por round de stamp, resolve `Pin.id -> índice local` dentro
do **único** `CircuitGroup` a que aquele componente pertence (garantido pela passada 2).

### 7.3 Fonte de tensão ideal — variável extra e referência de terra

`addVoltageSource` e `addConductanceToGround` (seção 6) já estão implementados — fecha a lacuna que
ficava aberta antes (resolvia rede resistiva, não circuito com fonte de ponta a ponta).

**Variável extra (corrente de ramo)**: dimensão da matriz de um `CircuitGroup` passa a ser
`nós + variáveis extras` — MNA não distingue tensão de nó de corrente de ramo, são só incógnitas
resolvidas juntas pelo mesmo `Eigen::PartialPivLU`. Alocação acontece **uma vez, no rebuild de
topologia** (`Netlist::rebuildTopology`, recebendo `extraVariableCount()` de cada componente),
nunca durante `stamp()` — alocar lá faria a matriz crescer a cada round do settle-loop.
`IComponentModel::extraVariableCount()` tem default 0; só fonte de tensão ideal (e futuramente
dependente/op-amp ideal) retorna > 0. Capacitor e indutor **não precisam disso**: usando modelo de
companhia Norton (condutância + fonte de corrente, não Thevenin) o estado deles entra só via
`rhs()`, igual a uma fonte de corrente — por isso `addCurrentSource`/equivalente em `RHS`-only é o
método que falta pra eles, não a máquina de variável extra.

**Terra (`Ground`, `core/src/components/other/Ground.hpp`)**: convenção deliberadamente simples —
puxa o pino pra 0V com admitância alta (`1e9` S) em vez de eliminar linha/coluna como MNA "de
livro" faria. Sem isso, **qualquer** grupo resolvido só com elementos passivos é singular por
construção (KCL somada em todos os nós sempre dá zero — é redundância estrutural, não bug) — não é
só o nó isolado que precisa de tratamento, é qualquer grupo sem referência. Erro residual ~1/1e9,
desprezível na prática, não bit-exato. Eliminação de linha/coluna "de livro" fica como refinamento
futuro, não bloqueando nada hoje.

Teste de integração (`core/test/voltage_divider_test.cpp`): fonte 10V + 2 resistores 1kΩ + terra,
roda `settleStep()` manualmente até estabilizar, confere `V_B = 5V` contra a conta analítica. Sem
framework de teste — só `assert`/código de saída, registrado via `add_test()` no CMake.

### 7.4 Correções de robustez no Scheduler + contrato de não-linear

Dois bugs reais (não hipotéticos) achados em auditoria do que já existia, corrigidos:

- **`SparseSet` não crescia.** Capacidade era fixa no construtor; inserir um índice acima dela era
  acesso fora dos limites sem checagem (UB, não exceção). `insert()` agora chama `grow()` sozinho
  quando precisa — nunca mais UB por excesso de capacidade.
- **`ScheduledEvent` sem desempate.** `std::priority_queue` não garante ordem estável entre
  elementos "iguais" pelo comparador; dois eventos no mesmo `timeNs` podiam processar em ordem
  não-determinística entre execuções. Adicionado `sequence` (ordem de `scheduleEvent()`) como
  critério secundário — necessário pra replay/teste reprodutível, não só estética.

**Contrato de componente não-linear** (`IComponentModel::isNonlinear()`/`hasConverged()`,
`device_abi.h`/ABI de plugin **não** tocado ainda — isto é só o lado C++ interno): depois de cada
solve(), todo componente que estampou no round e está marcado não-linear é consultado; se não
convergiu, volta pro dirty set pra outra iteração de linearização — mesmo que nenhum vizinho tenha
mudado tensão o bastante pra disparar isso via listener (seção 7, passo 3). Limite de iterações
(`kMaxNonlinearIterations = 50`, contador global por enquanto, mesmo papel do
`Simulator::m_maxNlstp` do SimulIDE) evita girar pra sempre se algo nunca convergir.

**O que isto define**: o Scheduler só fornece o laço de repetição e o limite — toda a matemática de
Newton-Raphson (linearização, tolerância de convergência) é responsabilidade de cada componente
concreto que implementa `stamp()`. `stamp()` lê o ponto de operação via `getNodeVoltage()` (mesmo
mecanismo de qualquer componente, sem API especial) e decide por conta própria, em
`hasConverged()`, se a estimativa estabilizou.

**Estado real (2026-07-08), primeiro componente não-linear implementado com Newton-Raphson
genuíno** (`core/src/components/active/Diode.hpp`, classe `Diode`): diodo Shockley
(`Id = Is*(exp(Vd/Vt)-1)`) com companion model (condutância + fonte de corrente equivalente)
linearizado no ponto de operação da última `stamp()`, amortecimento de Newton ("limiting" padrão de
SPICE — passo de `Vd` entre iterações limitado a `2*Vt` uma vez passado `vCrit`, evita que
`exp()` divirja antes do laço convergir) e `hasConverged()` genuíno (compara `Vd` entre iterações
consecutivas contra uma tolerância, não hardcoded). Parâmetro opcional `breakdownVoltage`
(0 = desativado) adiciona um segundo ramo exponencial espelhado pra ruptura reversa tipo zener,
com o mesmo amortecimento espelhado. A mesma classe é reaproveitada por três typeIds com parâmetros
diferentes:
- `active.diode`: `saturationCurrent` editável, sem ruptura (`supportsBreakdown=false`).
- `active.zener`: idem + `breakdownVoltage` editável (`supportsBreakdown=true`, default 5.1V).
- `outputs.led`: `saturationCurrent`/`thermalVoltage` fixados nos valores do preset real "RGY
  Default" do SimulIDE (`e-diode.cpp::getModels()`, `satCurr=0.0932nA`, `thermalVoltage` efetivo =
  `emCoef*Vt = 3.73*0.025865 ≈ 0.0965V`, sem `emCoef` como parâmetro separado — já embutido no
  `thermalVoltage` desta classe), sem ruptura. Testes: `core/test/diode_test.cpp` (diodo comum),
  `core/test/zener_led_test.cpp` (regulador zener + LED, ambos validando KCL no ponto convergido,
  não só que o laço parou de iterar).

**Achado documentado, não corrigido nesta tarefa**: `active.diac`/`active.scr`/`active.triac`/
`active.bjt`/`active.mosfet`/`active.jfet` têm registro built-in (`CoreApplication.cpp`) mas são
CONFIRMADAMENTE código morto em produção — `devices/simulide-complex` (plugin ABI) registra os
MESMOS typeIds via `SimulationSession::registerKnownPluginTypes()`, chamado depois de
`registerBuiltinComponents()`, e sempre vence via `ComponentRegistry::replaceFactory`. O modelo do
plugin (`lib.c`) é um limiar on/off simplificado, não Newton-Raphson real — portar Shockley/Ebers-Moll
pra estes exigiria mexer no `lib.c` do plugin (fora do escopo desta tarefa), não só no built-in
inerte.

### 7.5 Auditoria "pente fino" 2026-07-08 — componentes eletricamente inertes corrigidos

Auditoria completa pedida pelo usuário achou que 11 typeIds built-in usavam `SimulidePassiveState`
(`stamp()` no-op puro, `SimulideBuiltins.hpp:355`) apesar de terem física real e conhecida no
SimulIDE — ou seja, existiam no catálogo/UI mas eram eletricamente **inertes** (nenhuma corrente
fluía, nenhuma tensão real era produzida), o bug mais grave possível pra um simulador de circuitos.
Todos os 11 ganharam `stamp()` real:

- **`active.opamp`/`active.comparator`** — `components::OpAmp` (`core/src/components/active/
  OpAmp.hpp`), amplificador nullor simplificado: entrada de impedância infinita (nada estampado em
  in+/in-), saída Norton-pra-terra (`addConductanceToGround`/`addCurrentToGround`, mesma técnica de
  `Rail`) com valor alvo `clamp(gain*(V+-V-), ±1e6V)`. **Amortecimento por sub-relaxação obrigatório**
  (`alpha = 1/(1+gain)`) — sem isto, um opamp em realimentação negativa (a config mais comum:
  buffer/inversor/não-inversor) diverge geometricamente na iteração ingênua (`|derivada| = gain >>
  1`). Prova algébrica no comentário da classe: com essa escolha de `alpha`, um buffer de ganho
  unitário converge em UMA iteração, de qualquer ponto de partida. `active.comparator` reaproveita a
  MESMA classe com ganho default bem mais alto (1e7 vs 1e5), sem typeId nem classe separados.
  Pinos `powerPos`/`powerNeg` continuam sem física de trilho (simplificação documentada), mas
  precisam de uma condutância de fuga mínima até a terra (`kLeakageConductance=1e-9`) mesmo assim —
  ver achado de arquitetura abaixo.
- **`active.analog_mux`** — `components::AnalogMux` (`core/src/components/active/AnalogMux.hpp`):
  chaveamento resistivo real por canal (`kOnConductance=1000S` no canal endereçado + habilitado,
  `kOffConductance=1e-7S` nos demais, mesma ordem de grandeza do `low_imp` real do SimulIDE),
  endereço decodificado em binário dos pinos `addr-*`, `en` ativo em nível baixo (`voltage<2.5V`),
  mesma convenção do `mux_analog.cpp` real. Interpreta o MESMO `ComponentPinSpec`/
  `resolveDynamicPins` já usado pra contagem de pinos, agora também pra semântica elétrica.
- **`outputs.led_rgb`/`outputs.led_bar`/`outputs.led_matrix`/`outputs.seven_segment`** —
  `components::DiodeLegArray` (`core/src/components/active/DiodeLegArray.hpp`): N pernas de diodo
  independentes dentro de UM componente multi-pino (mesma física/amortecimento de `Diode`, sem
  ruptura reversa, duplicada em vez de reaproveitada pois `Diode` é hardcoded pra 2 pinos), preset
  "RGY Default" igual a `outputs.led`. `led_rgb`: 3 pernas (R/G/B) pro catodo comum. `led_bar`: pares
  P_i/N_i independentes (`size` pinos dinâmicos). `led_matrix`: `rows*columns` pernas (uma por
  interseção linha×coluna, linha=anodo/coluna=catodo, mesma convenção de `ledmatrix.cpp`).
  `seven_segment`: 8 pernas (a-g+ponto) para um pino comum por display, igual a
  `SevenSegment::createDisplay()` do SimulIDE. `shortedPairs` continua disponível como recurso
  genérico do modelo, mas não é usado para inventar um segundo comum no display padrão.
- **`outputs.dc_motor`/`outputs.incandescent_lamp`** — `components::Resistor` direto (2 pinos,
  reaproveitado sem mudança). **`outputs.stepper`** — `components::StepperWindings` (quatro
  meias-bobinas resistivas ligadas ao terminal comum `Co`, preservando os cinco pinos do Stepper
  unipolar real). Nenhum modela torque/rotação/back-EMF/resistência variável com
  temperatura (simplificação documentada) — só a carga resistiva real, elétrica de verdade em vez de
  circuito aberto.
- **`switches.keypad`** — `components::Keypad` (`core/src/components/switches/Keypad.hpp`): matriz
  linha×coluna real (`kClosedConductance`/`kOpenConductance` sem diodo; física de `Diode` em série
  quando `diodes=true`, direção controlada por `diodesDirection`, mesma topologia do `keypad.cpp`
  real). Nova propriedade `pressedMask` (bitmask, bit `row*columns+col`) representa o estado de
  tecla pressionada — substitui o clique interativo do mouse por tecla que o SimulIDE real tem
  (UI/IPC novos, fora de escopo aqui); a matriz elétrica em si é real, só a FONTE do estado é uma
  propriedade em vez de um evento de clique.

**`passive.resistor_dip`** (achado relacionado, mesma classe de bug): registrava só os 2 primeiros
dos 16 pinos declarados no `package` (via `SimulideTwoPinResistor`), os outros 14 ficavam
eletricamente flutuando — não uma simplificação, uma topologia ERRADA (o símbolo desenhava 8
resistores independentes, só 1 existia de verdade). Corrigido com `components::ResistorArray`
(`core/src/components/passive/ResistorArray.hpp`): 8 pares reais, MESMA resistência compartilhada
entre todos (igual ao `resistordip.cpp` real). Redimensionamento dinâmico e modo "Pullup" (barramento
com pino direito oculto) do original NÃO implementados — o catálogo atual já declara os 16 pinos como
fixos, sem `dynamicLayout`, então essa parte do gap nem existia.

**Achado de arquitetura descoberto durante os testes** (não é um bug do `Netlist`, é uma
característica existente que qualquer componente multi-pino novo precisa respeitar):
`Netlist::rebuildTopology` funde TODOS os pinos do MESMO componente no MESMO grupo topológico,
sempre — "Passada 2: nó -> grupo (mesmo componente => mesmo grupo)" (`Netlist.hpp`). Pra um
componente com sub-redes eletricamente INDEPENDENTES entre si (pares de `ResistorArray`, pernas de
`DiodeLegArray` sem hub comum, pinos só-lidos-nunca-estampados como `en`/`addr-*` do `AnalogMux` ou
`powerPos`/`powerNeg` do `OpAmp`), se o usuário só fiar PARTE dessas sub-redes (uso normal — ninguém
fia os 16 pinos de um DIP sempre), as sub-redes não-fiadas ficam sem NENHUMA equação dentro do MESMO
grupo das sub-redes que ESTÃO fiadas — isso torna o grupo INTEIRO singular, e o fallback do
`MnaSolver` zera TODAS as tensões do grupo, inclusive as sub-redes que tinham referência real.

**LeakageGuard centralizado (2026-07-09, substitui o padrão manual descrito acima)**: em vez de cada
componente chamar `matrix.addConductanceToGround(pin, kLeakageConductance)` dentro do próprio
`stamp()` (como `OpAmp`/`AnalogMux`/`ResistorArray`/`DiodeLegArray` faziam até esta correção),
`IComponentModel::leakagePinIndices()` (novo método virtual, default vazio) declara quais índices
locais de `pins()` precisam da rede de segurança; `SimulationSession::settleStep()` aplica
`kLeakageGuardConductance=1e-9` (`IComponentModel.hpp`) a eles logo depois de `stamp()` retornar,
sempre, sem o componente precisar lembrar disso no meio da própria física. Deliberadamente OPT-IN
(não detecção automática de "diagonal zero após stamp", que mascararia erro de fiação real do
usuário em qualquer componente, não só nos que precisam): um pino sem estampa que o componente não
declarou continua produzindo "sistema singular" de verdade. Qualquer novo componente multi-pino com
sub-redes independentes deve sobrescrever `leakagePinIndices()`, não reimplementar o padrão manual.

**Sensores resistivos falsos removidos** (achado de duplicação, não de física ausente):
`passive.ldr`/`passive.thermistor`/`passive.rtd`/`passive.force_strain_gauge` eram resistores
estáticos disfarçados (`SimulideTwoPinResistor`, ZERO resposta a luz/temperatura/força — eletricamente
indistinguíveis de um `passive.resistor` comum), catalogados em "Passivos > Resistive Sensors",
DUPLICANDO os sensores REAIS (`sensors.ldr`/`thermistor`/`rtd`/`strain`, física de verdade —
`devices/simulide-sensors/src/lib.c`, curva gamma real pro LDR — catalogados em "Sensores"). Um
usuário pegando "LDR" pela pasta óbvia ("Passivos") ganhava o componente ERRADO. Removidos os 4
builtins falsos e suas entradas de catálogo — `sensors.*` é agora a única fonte pra sensores
resistivos.

**NAND/NOR/NOT/XNOR** (achado de paridade SimulIDE, não elétrico): `devices/simulide-logic/src/
lib.c` só tinha AND/OR/XOR/Buffer fixos em 2 entradas, sem flag de inversão — tornando NAND/NOR/
NOT/XNOR inconstruíveis, apesar de serem portas mais fundamentais em projeto digital real que XOR.
Mesma solução do SimulIDE real (`gate.cpp`: propriedade booleana "Inverted Outs" na MESMA porta
AND/OR/XOR/Buffer, não um typeId separado por porta): `stamp_gate()` agora lê `cfg_bool(s,
"inverted", 0)` e inverte a saída antes de estampar; os 4 `.lsdevice` (`and_gate`/`or_gate`/
`xor_gate`/`buffer`) ganharam a propriedade `inverted` (checkbox). `logic.buffer` com
`inverted=true` É o NOT. Testado via DLL real (`core/test/logic_gate_plugin_test.cpp`, mesmo padrão
`esp32_devkitc_subcircuit_test.cpp`). **Atualização 2026-07-09**: a paridade visual foi implementada
— os 4 `.lsdevice` ganharam um `partId: "invertBubble"` no `package.viewSpec.paint` com
`stateProjection: {invertBubble: [{kind:"visible", prop:"inverted"}]}` (mecanismo `ViewSpecProjection`
já existente, reaproveitado), então o símbolo agora mostra a bolha quando `inverted=true` (ver
`docs/24-itens-menor-prioridade-2026-07-09.md`). **Atualização final 2026-07-09**: a contagem de
entradas variável também foi implementada para AND/OR, sem helper interno por `typeId`: o manifesto
declara `inputs`, `pinSpec.dynamicGroups`, `package.dynamicLayout` e `viewSpec.paint[].statePath`;
`stamp_gate()` lê N entradas reais no DLL. XOR/Buffer seguem fixos porque a referência SimulIDE 2 não
expõe `Num_Inputs` nesses dois.

**Verificação editorial (documentação estava desatualizada, achado à parte)**: `.spec/lasecsimul.spec`
seção 6.1.2 (validação de propriedade + `affectsTopology`/`requiresRestart`), `README.md`, `docs/
mvp-limitacoes.md` (subcircuitos, Newton-Raphson) e `docs/16-roadmap-pendencias-spec.md` (undo/redo/
copiar-colar/flip) descreviam funcionalidades JÁ implementadas em rodadas anteriores como pendentes
ou inexistentes — mesma classe de drift já corrigida uma vez pro diodo (ver nota em 7.4). Todos
corrigidos nesta auditoria.

## 8. Fluxo de integração com QEMU

> Mecanismo validado pelo próprio `simulide_2` (não é suposição de design) — ver
> `C:\SourceCode\simulide_2\src\microsim\cores\qemu\{qemudevice,qemumodule}.{h,cpp}` e, por chip,
> `C:\SourceCode\simulide_2\src\microsim\cores\qemu\esp32\esp32{,iomux,twi,spi,usart}.{h,cpp}`. O LasecSimul
> Core porta essa mesma arquitetura para o processo nativo descrito neste `.spec`, sem Qt (RNF05) e sem QMP —
> o controle do processo é mais simples do que QMP sugere. **Achado crítico confirmado lendo
> `hw/gpio/esp32_gpio.c` do fork real (`C:\SourceCode\qemu_simulide`)**: o QEMU manda registrador bruto
> (endereço + valor) sem decodificar nada — quem decodifica é o módulo do lado do Core, e esse módulo É
> chip-específico de propósito (só `Scheduler`/`Netlist`/IPC/UI precisam ser neutros quanto a chip). Não
> existe mais "módulo de barramento genérico reusado por qualquer chip" — ver seção 8.1.

1. Usuário insere um componente MCU no esquemático e associa uma **pasta** (não um arquivo fixo) onde o
   firmware (`.bin`/`.elf`/`.hex`) é gerado pela toolchain externa do usuário (Arduino IDE/PlatformIO/ESP-IDF
   — o LasecSimul nunca compila nada, ver seção 13) — caminho da pasta enviado pela Extension ao Core via
   IPC. `FirmwareWatcher` (seção 8.3) passa a vigiar essa pasta a partir daqui, sem ação manual nenhuma.
2. `McuRegistry` resolve `chipId` → instancia o `IMcuAdapter`, sempre via plugin nativo
   (`mcu_abi.h`/`NativeMcuAdapterProxy`) — **não existe caminho built-in para adaptador de MCU**, decisão
   tomada em 2026-06-28 ao migrar o ESP32 (ver seção 8.1).
3. **QEMU usado é um build modificado por chip** (espelhando o fork da Espressif para ESP32, ou um patch
   equivalente para STM32/outros) — os modelos de periférico (I2C/SPI/USART/Timer/GPIO) desse chip, dentro do
   QEMU, não emulam o hardware sozinhos: a cada acesso da CPU emulada a um registrador desses periféricos,
   eles escrevem o evento (endereço, valor, tipo de ação) numa **arena de memória compartilhada** e
   sinalizam o host — em vez de manter o protocolo inteiro só dentro da QEMU. Isso é uma dependência externa
   por chip (qual build de QEMU expõe essa arena), documentada no manifesto do adaptador, não algo o Core
   implementa.
4. `QemuProcessManager` cria a memória compartilhada (`CreateFileMapping`/`mmap`, chave única por instância —
   mesmo padrão de `shm_open`+`mmap`/`CreateFileMapping`+`MapViewOfFile` do SimulIDE) **antes** de iniciar o
   processo QEMU (`-machine <chip>`, `-kernel/-drive <firmware>` etc., via `buildLaunchArgs()`), e espera a
   arena reportar `running` para confirmar que o processo subiu.
5. Sincronização é por **espera ativa num campo da arena** (`simuTime`), não por socket/QMP — o `Scheduler`
   despacha a thread dedicada à instância de MCU para essa espera; o custo de uma syscall por evento é
   trocado por uma thread ocupando um núcleo enquanto o firmware roda. Isso é deliberado (mesma troca já
   validada pelo SimulIDE) e está coberto pelo orçamento de threads do Core (`std::thread`/pool).
6. Cada evento da arena traz `regAddr`/`regData`; `McuComponent` (`core/src/mcu/McuComponent.{hpp,cpp}`) —
   a peça que liga o `IMcuAdapter` ao circuito de verdade — despacha pro `QemuModule` concreto (`SIM_READ`/
   `SIM_WRITE`, por faixa de endereço, `IMcuAdapter::createModules()`) que é dono daquele endereço. O
   `QemuModule` decodifica o registrador (ex: `Esp32GpioModule` sabe que offset `0x04` é `GPIO_OUT_REG`) —
   o `McuComponent`/`Scheduler`/`Netlist` nunca sabem que registrador é esse.
7. A cada `stamp()`, `McuComponent` traduz `isOutputEnabled`/`outputLevel` do módulo em estampa elétrica real
   (Norton de baixa impedância) nos `Pin`s de circuito reais (`IMcuAdapter::pinMap()`), ou lê a tensão do nó
   de volta pro módulo (`setInputLevel`). Protocolo (I2C/SPI/UART) não é decodificado por um "módulo de
   barramento" intermediário — é decodificado bit a bit pelo componente/device do outro lado do fio via
   `ComponentEvent{kPinChangeEventTag}` (mesmo mecanismo de qualquer detecção de borda no `Netlist`, seção
   0.4 do handoff `docs/17-pendencias-pos-sessao-qemu-abi.md`). Um dispositivo nativo do outro lado nunca
   sabe se quem está do outro lado do fio é um MCU emulado ou outro componente.
8. UART/SPI/I2C reais do ESP32 (`Esp32TwiModule`/`Esp32SpiModule`/`Esp32UsartModule`) ainda não existem —
   só GPIO puro (`Esp32GpioModule`) está implementado hoje (ver pendência 3.1 do handoff). Quando existirem,
   seguem o mesmo padrão do item 6/7: `QemuModule` concreto por periférico, nunca módulo genérico.
9. Depuração: `gdbserver` da QEMU exposto em porta TCP; Debug Adapter do VSCode conecta diretamente nele
   (não passa pelo Core).
10. **Reset e parada não usam QMP**: o pino de reset do componente, ao ser ativado, zera `arena->running` e
    **mata o processo QEMU** (kill direto, sem handshake); ao ser liberado, um novo processo QEMU é
    iniciado do zero (boot é rápido o suficiente para isso ser aceitável — mesma escolha do SimulIDE). Parar
    a simulação segue a mesma rota: kill + timeout, nunca um comando de protocolo esperando resposta. Isso
    elimina a necessidade de um `QmpClient`/protocolo QMP no Core.

### 8.1 `qemu_arena_abi.h` — reescrito nesta sessão (2026-06-28), confirmado contra o binário real

`core/include/lasecsimul/qemu_arena_abi.h` foi **reescrito por completo** depois de auditar o protocolo real
contra três fontes confirmadas acessíveis nesta máquina: `C:\SourceCode\qemu_simulide`
(`softmmu/simuliface.{h,c}`, fork QEMU atual), `C:\SourceCode\simulide_2` (fonte C++ do SimulIDE atual — o
antigo `SimulIDE-dev` não existe mais neste disco) e o binário oficial vendorizado de
`SimulIDE_2-R260501_Win64\data\bin\qemu-system-xtensa.exe`. O protocolo anterior descrito aqui (tag
`simuAction` com payload já decodificado, sem endereço) **estava errado** — substituído pelo protocolo real:
`regAddr`/`regData`/`irqNumber`/`irqLevel`/`SIM_READ`/`SIM_WRITE`/`loop_timeout_ns`/`ps_per_inst`, **88 bytes
total** (confirmado batendo com o log do próprio binário real: "Qemu: arena mapped 88 bytes"). Duas decisões
de versionamento/sincronização seguem valendo, e ambas são correções confirmadas, não polimento:

- **Sem cabeçalho de versão dentro da struct.** O binário já compilado (`qemu-system-xtensa.exe`) e os
  patches já existentes (`hw/gpio/esp32_gpio.c`, `hw/arm/stm32.c`) dependem do layout exato, campo a campo,
  na ordem atual — inserir `abiMajor`/`abiMinor` na frente deslocaria tudo e exigiria recompilar o QEMU.
  Versionamento fica fora da struct: o manifesto do adaptador (`.lsdevice`, campo `qemuBuild`) é quem declara
  qual build de QEMU é esperado pra aquele chip. Isso é uma troca deliberada — usar o binário que já existe
  sem precisar mantê-lo (recompilar QEMU é um projeto de build próprio) — não um esquecimento.
- **Protocolo é ping-pong síncrono por construção, não seqlock.** O protocolo real (`doAction()` em
  `simuliface.c`) bloqueia em espera ativa em ambos os sentidos — QEMU escreve o evento e espera o Core
  confirmar antes de seguir; não executa a próxima instrução emulada enquanto isso não acontece. Isso garante
  zero perda de evento sem precisar de sequence number: o produtor não consegue avançar antes da confirmação,
  por construção. Para semântica de acesso a registrador de hardware (a CPU pode ler de volta o que escreveu
  na instrução seguinte) isso é o modelo correto, não só mais simples.

Campos reais do contrato (88 bytes), QEMU **nunca pré-decodifica**:

1. **QEMU → Core** (evento de periférico): escreve `regAddr` (endereço bruto do registrador acessado pela
   CPU emulada, sem decodificação — quem decodifica "offset 0x04 = GPIO_OUT_REG" é o `QemuModule` do lado do
   Core, nunca o QEMU) + `regData` + `SIM_READ`/`SIM_WRITE` (qual operação foi feita). Despacho por endereço
   dentro do QEMU usa `MemoryRegionOps` nativo só para decidir que aquele endereço pertence à arena — não
   decodifica o significado do registrador.
2. **IRQ**: `irqNumber`/`irqLevel` — sinalização de interrupção, independente do par `regAddr`/`regData`.
3. **Timing**: `loop_timeout_ns`/`ps_per_inst` — orçamento de tempo virtual por rodada de espera ativa e
   picosegundos por instrução emulada (usado pelo Core para converter tempo de CPU emulada em `timeNs` real
   do `Scheduler`).

Não existe mais um enum de ação chip-específico trocado pela arena (`simuAction`/`qemuAction` da versão
anterior desta seção) — o endereço bruto já basta, e quem dá significado a ele é o `QemuModule` concreto,
sempre vindo de um plugin (`mcu_abi.h`/`LsdnQemuModuleVTable`, via `QemuModuleProxy`) desde 2026-06-28 — ver
GPIO do ESP32 (`mcu-adapters/espressif-esp32/`) hoje; `IMcuAdapter::createModules()` decide quais módulos um
chip usa.

**Por que isso não vira o mesmo padrão na ABI de plugin nativo (`device_abi.h`)**: ping-pong por memória
compartilhada existe pra evitar o custo de uma syscall **entre processos diferentes**. Plugin roda no mesmo
processo do Core — `vtable->stamp()` já é uma chamada de função direta, mais barata que qualquer protocolo
de espera ativa em memória compartilhada, porque não há fronteira de processo a economizar ali. E o problema
que o ping-pong resolve (perda de evento por sobrescrita) **não existe** na ABI de plugin por construção: lá
cada evento é uma chamada de função com parâmetro próprio (`on_event(dev, &ev)`), nunca um campo único
reaproveitado — não tem nada a corrigir. Avaliado e descartado deliberadamente, não esquecido.

**Estado atual (não mais "formato sem pipeline")**: o pipeline mínimo já funciona de ponta a ponta —
`McuController`/`buildLaunchArgs` (no adaptador ESP32, hoje um plugin, `mcu-adapters/espressif-esp32/`)
prependam a chave da shared memory como `argv[1]`
(confirmado lendo `simuMain()` real em `simuliface.c`: `shMemKey = argv[1]; argv = &argv[2];`), e o resto dos
args bate com `Esp32::createArgs()` real: `-M esp32-simul -L <romdir> -drive file=...,if=mtd,format=raw
-icount shift=4,align=off,sleep=off` — não mais o placeholder antigo `-machine esp32 -kernel ...`. O binário
real
(`devices/qemu-esp32/bin/qemu-system-xtensa.exe` + DLLs + ROMs do ESP32, vendorizado nesta sessão a partir de
`SimulIDE_2-R260501_Win64\data\bin\`) é de fato lançado pelo teste
`core/test/core/mcu/McuControllerRealQemuTest.cpp` (`mcu_controller_real_qemu` no ctest) — abre a arena,
inicia o processo, só falha no firmware porque ainda não existe um `.bin` real (falta toolchain ESP-IDF, ver
`docs/mvp-limitacoes.md`). `McuComponent` (`core/src/mcu/McuComponent.{hpp,cpp}`) já liga isso a um circuito
de verdade, sem precisar do processo QEMU real — `core/test/core/mcu/McuComponentTest.cpp` prova
`GPIO_ENABLE_REG`+`GPIO_OUT_REG` subindo um pino do circuito pra 3.3V com arena sintética.

### 8.2 Estado real do fork QEMU — verificado, não suposto

Dependência concreta, não hipotética: `G:\...\qemu-simulide` (binário compilado, `qemu-system-xtensa.exe` +
DLLs MSYS2, confirmado executável) e `G:\...\qemu-simulide-1` (fonte completo, git em
`LASEC-UFU/qemu-simulide`, upstream `Arcachofo/qemu-simulide`, base QEMU 9.2.2). Histórico git local
corrompido (objects incompletos, provavelmente sync do Google Drive) — arquivos atuais intactos, só o
`git log` não funciona; não tentar `fsck`/reclone sem necessidade real.

A ponte com a arena (`system/simuliface.{h,c}`) já está formalizada na seção 8.1 (struct exata + protocolo
ping-pong). Detalhe operacional que vale registrar aqui: `argv[1]` do processo QEMU é sempre a chave da
memória compartilhada — convenção fixa de posição, não uma flag — e o resto de `argv` segue direto pro
`qemu_init()` normal do QEMU (machine/kernel/etc., sem nada de SimulIDE no meio).

Estado por família de MCU, verificado lendo o fork (não suposto):

| Família | CPU no QEMU | Bridge com a arena hoje |
|---|---|---|
| ESP32 (Xtensa) | Pronta (`target/xtensa`, fork Espressif) | GPIO output (chip→Core) e GPIO input por poll (`hw/gpio/esp32_gpio.c`) ok; UART/SPI/I2C **zero** |
| STM32 (ARM) | Pronta (`target/arm`, upstream maduro) | GPIO input **push** (Core→chip) e UART RX push ok (`hw/arm/stm32.c`) — mais adiantado que o ESP32 nisso |
| Arduino Uno/Mega (AVR) | Pronta (`target/avr`, `hw/avr/arduino.c`, upstream) | Zero — nenhuma referência à arena ainda; mesmo padrão de patch do GPIO do ESP32 se aplicaria |
| PIC | **Não existe** — nenhum target de CPU PIC no QEMU, neste fork ou em qualquer outro conhecido | Fora de escopo (ver RF/decisão abaixo) |

**PIC fica fora do escopo do LasecSimul** até (e a menos que) exista um target de CPU PIC no QEMU — decisão
explícita, não esquecimento: escrever um target de CPU do zero é projeto separado, de meses, de escala
maior que o resto do LasecSimul somado. Não é uma lacuna a fechar nesta fase; é uma dependência externa que
simplesmente não existe ainda.

### 8.3 `FirmwareWatcher` — recarga automática, sem ação manual (diferença deliberada do SimulIDE)

Confirmado lendo o SimulIDE-dev de verdade (não suposição): `QemuDevice` só tem `slotLoad()`/`slotReload()`
acionados por item de menu de contexto ("Load firmware"/"Reload firmware") — **nenhum** `QFileSystemWatcher`
existe em lugar nenhum do projeto (busca confirmada, zero ocorrências). Recompilar o firmware fora do
SimulIDE nunca atualiza a simulação até o usuário clicar manualmente. O LasecSimul resolve isso:

1. **Configuração é uma pasta, não um arquivo fixo.** Toolchains externas (Arduino IDE, PlatformIO,
   ESP-IDF) escrevem o artefato compilado num caminho de build muitas vezes gerado/variável — o usuário
   aponta a PASTA de saída, não um nome de arquivo específico. `FirmwareWatcher` resolve, dentro dela, o
   `.bin`/`.elf`/`.hex` de maior `mtime` (se houver mais de um, vence o mais recente — caso comum de pastas
   de build com artefatos antigos não limpos).
2. **Detecção por polling do `mtime`, não API nativa de evento de filesystem por SO.** Decisão deliberada de
   simplicidade: `inotify`/`ReadDirectoryChangesW`/`FSEvents` são três implementações por SO pra economizar
   uma latência que não importa aqui (o usuário acabou de compilar manualmente fora do LasecSimul; esperar
   1-2s pra simulação notar é imperceptível nesse fluxo). `FirmwareWatcher::poll()` roda no mesmo timer que
   já dispara `qemuTime` (seção 8, item 5) — sem thread nem timer dedicado novo.
3. **Reaproveita o mecanismo de kill+respawn já especificado (seção 8, item 10), não um caminho novo.** Mudança
   detectada = exatamente o mesmo efeito de pino de reset sendo ativado: mata o processo QEMU atual, sobe um
   novo com `-kernel/-drive` apontando pro arquivo novo. **Recarregar firmware nunca foi um caso especial —
   é "reset" com um gatilho diferente** (arquivo mudou, em vez de pino mudou). Nenhuma lógica de "hot-swap de
   firmware num processo QEMU vivo" é necessária nem cogitada.
4. **Sem debounce explícito além do próprio polling.** Uma toolchain grava o artefato final de uma vez
   (rename atômico ou escrita seguida de close) — o intervalo de poll já absorve qualquer escrita parcial
   sem necessidade de detectar "arquivo parou de crescer".

```
core/src/mcu/qemu/FirmwareWatcher.{hpp,cpp}   // poll(folder) -> optional<caminho mais recente>
```

**Status real (corrigido 2026-07-09, ver seção 19)**: implementado e testado
(`core/test/core/mcu/FirmwareWatcherTest.cpp`), mas **nunca foi ligado** a `QemuProcessManager`/
`McuComponent` nem a nenhum outro chamador -- `poll()` nunca roda em produção. A UI seguiu exigindo
clique manual em "Recarregar Firmware" até 2026-07-09, quando a recarga automática foi implementada
de outra forma (Extension, arquivo único verificado só antes de "Run" -- não pasta, não polling
contínuo). Este design (itens 1-4 acima) permanece só como REFERÊNCIA/intenção original, não descreve
o comportamento atual -- ver seção 19 pro que de fato roda hoje.

## 9. Estratégia para adicionar novos componentes eletrônicos

Três caminhos, sem nunca editar `MnaSolver`/`Scheduler`:

- **Biblioteca padrão** (mantida pelo projeto): nova classe C++ em `core/src/components/<categoria>/`,
  compilada direto no binário do Core, implementa `IComponentModel`. Caminho mais rápido possível (mesma
  unidade de compilação), reservado para componentes de primeira parte.
- **Plugin de terceiros** (usuário/comunidade, código): DLL/SO carregada em runtime pelo `PluginLoader`
  (descoberta + ABI) para o `GlobalPluginCache`; instâncias são criadas pelo `PluginRuntime` de cada sessão,
  exportando a vtable C de `device_abi.h`, que o Core envolve num `NativeDeviceProxy` (`IComponentModel`).
  Especificação completa — manifesto, ABI, ciclo de vida, build, testes — em **`lasecsimul-native-devices.spec`**.
- **Subcircuito** (usuário, sem código): circuito desenhado no editor, salvo como `.lssubcircuit` — pinos internos
  expostos via `Tunnel` com nome reaproveitando o mesmo mecanismo da seção 7.2, símbolo visual reaproveitando
  o mesmo bloco `package` de `.lsdevice` (seção 21 do `lasecsimul-native-devices.spec`). **Não implementa
  `IComponentModel`** — ao instanciar, o Core expande os componentes internos diretamente na mesma
  `SimulationSession` (sem flattening prévio pela Extension, sem sandbox/consentimento porque é dado, não
  código executável). Especificação completa em **`lasecsimul-subcircuits.spec`**.

O `ComponentRegistry` registra os dois primeiros caminhos da mesma forma; o solver não diferencia built-in de
plugin. Subcircuito é deliberadamente diferente — não é uma terceira variante de `IComponentModel`, é uma
composição de instâncias já existentes (ver `lasecsimul-subcircuits.spec`, seção 5).

Critério de quando usar qual: biblioteca padrão para tudo que o projeto distribui e mantém; plugin pra
comportamento novo que só código resolve (lógica, protocolo, estado complexo); subcircuito pra reaproveitar
uma combinação de componentes já existentes sem escrever nada — não existe um quarto caminho "mais lento, mas
mais seguro" neste momento — essa troca foi avaliada e descartada deliberadamente (ver nota de isolamento na
seção 12 do `lasecsimul-native-devices.spec`).

## 10. Estratégia para adicionar novos microcontroladores

Mesmo princípio, espelhando o ESP32 — mas **o protocolo de registrador (GPIO/I2C/SPI/USART) é CHIP-ESPECÍFICO
de propósito, não genérico** (achado crítico confirmado lendo `hw/gpio/esp32_gpio.c` do fork real, seção 8):

1. Implementar `IMcuAdapter` como plugin nativo (`mcu-adapters/<chip>/`, `mcu_abi.h`/`LsdnMcuVTable`,
   carregado via `NativeMcuAdapterProxy`) — não existe mais caminho built-in (removido ao migrar o ESP32 em
   2026-06-28, mesmo desempenho dos dois): (a) `build_launch_args` para o binário QEMU daquele chip, (b)
   `get_memory_regions`/`get_pin_map` declarativos, (c) `create_modules` — devolve um
   `LsdnQemuModuleHandle` (`mcu_abi.h`) concreto por periférico que o chip de fato usa (ex: GPIO do ESP32);
   `QemuModuleProxy` (`core/src/plugins/QemuModuleProxy.hpp`) embrulha isso num `QemuModule` C++ do lado do
   Core, mesmo custo de chamada que um `QemuModule` built-in teria.
2. Implementar um módulo (`LsdnQemuModuleVTable`) por periférico, do lado do plugin — **é aqui que vive o
   conhecimento do mapa de registrador real daquele chip** (ex: offset `0x04` = `GPIO_OUT_REG` no ESP32);
   copiar fielmente do código de referência real
   (`C:\SourceCode\simulide_2\src\microsim\cores\qemu\<chip>\`), nunca inventar offset. Não existe módulo
   genérico reusado entre chips — cada `QemuModule` concreto é específico de um periférico de um chip.
3. Pré-requisito por chip: precisa existir um build de QEMU modificado para esse chip que escreva os eventos
   de registrador na arena de memória compartilhada (seção 8.1) — documentar isso como dependência externa no
   manifesto do adaptador (campo `qemuBuild`), não como limitação do Core.
4. `McuComponent`/`McuRegistry`/`Scheduler`/`Netlist`/IPC/UI são neutros por design — não conhecem "ESP32" nem
   "STM32", só `IMcuAdapter`/`QemuModule`/`MemoryRegion`/`PinMapping`. Protocolo de barramento real (I2C/SPI)
   entre o MCU e outro componente do circuito é decodificado bit a bit pelo componente do outro lado do fio
   via `ComponentEvent{kPinChangeEventTag}` (seção 7, passo "3e"), nunca por um módulo de barramento.

## 11. SOLID aplicado

| Princípio | Aplicação concreta |
|---|---|
| **S**RP | `MnaSolver` resolve circuito; `QemuProcessManager` gerencia processo QEMU; `McuComponent` só despacha registrador da arena pro `QemuModule` certo e traduz pra estampa elétrica; cada `QemuModule` só decodifica o registrador de um periférico; `IpcServer` só serializa/desserializa; `PluginLoader` só descobre/valida/carrega código, `PluginRuntime` só cria/destrói instâncias — nenhuma classe acumula mais de uma responsabilidade. **Esclarecimento (2026-06-30)**: SRP aqui é "uma responsabilidade", não "uma classe por arquivo" — agrupar múltiplos devices RELACIONADOS num mesmo módulo (`SimulideBuiltins.hpp` com 8+ classes; `simulide-complex`/`simulide-logic`, 18+25 tipos cada num único `lib.c`) é permitido e intencional, tanto built-in quanto plugin ABI/DLL. O que de fato violaria SRP/DIP: lógica específica de UM typeId vazando pra fora do código daquele device E/OU duplicada em vários lugares (ex: a mesma classificação por typeId repetida em 4 funções da Extension) — ver `.spec/lasecsimul-native-devices.spec` seção 22.8 pro critério completo e o exemplo formal (`ReadoutFormat`/`InteractionKind`, seção 22) de centralizar em vez de duplicar. |
| **O**CP | Novo componente/MCU = nova classe compilada no Core **ou** novo plugin DLL/SO — nunca uma edição em `MnaSolver`/`Scheduler`. Novo periférico de chip = novo `QemuModule` concreto, nunca edição em `McuComponent`/`Scheduler`/`Netlist` (item 10.2). |
| **L**SP | Qualquer `IComponentModel` (built-in, `NativeDeviceProxy` envolvendo um plugin, ou `McuComponent`) é intercambiável no `stamp()` do solver sem checagem de tipo concreto. Idem para `IMcuAdapter`/`QemuModule` no `McuComponent`. |
| **I**SP | `IComponentModel` e `IMcuAdapter` são interfaces separadas — um MCU adapter não implementa métodos de pino de componente passivo. `ComponentMetadataRegistry` separado de `ComponentRegistry` — consultar o catálogo para UI não exige uma factory instanciável. |
| **D**IP | `simulation/` depende só de `include/lasecsimul/*.hpp`. `components/`, `plugins/`, `mcu/` dependem do Core, nunca o contrário. `GlobalPluginCache` + `ComponentRegistry`/`McuRegistry` por sessão são o único ponto de inversão de controle. |

## 12. Exemplos práticos

### 12.1 Resistor nativo (biblioteca padrão, compilado no Core)

`core/src/components/passive/Resistor.hpp`
```cpp
class Resistor final : public IComponentModel {
public:
    Resistor(std::array<Pin,2> pins, double resistanceOhm) : m_pins(pins), m_r(resistanceOhm) {}

    const char* typeId() const override { return "passive.resistor"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        const double g = 1.0 / m_r;
        matrix.addConductance(m_pins[0], m_pins[1], g); // idêntico em custo ao eResistor::stampAdmit()
    }
    void postStep(uint64_t) override { /* resistor é puramente algébrico — nunca é chamado */ }
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

private:
    std::array<Pin,2> m_pins;
    double m_r;
};
```

### 12.2 Registro (Core, `main.cpp`)

```cpp
GlobalPluginCache pluginCache;             // processo-wide — carrega código, nunca instâncias
pluginCache.loader().scanDirectory("./devices");
pluginCache.loader().scanDirectory("./mcu-adapters");

SimulationSession session(pluginCache);    // hoje sempre 1 por processo
session.components().registerFactory("passive.resistor", [](const ComponentParams& p) {
    return std::make_unique<Resistor>(p.pins<2>(), p.property("resistance", 1000.0));
});
session.registerKnownPluginTypes();        // delega ao PluginRuntime para cada typeId/chipId do cache
```

### 12.3 Protocolo de IPC (visão da Extension)

```typescript
// extension/src/ipc/CoreClient.ts (esqueleto conceitual)
export class CoreClient {
  async addComponent(typeId: string, properties: Record<string, unknown>): Promise<string /* instanceId */> { /* envia pelo named pipe */ return ""; }
  async setProperty(instanceId: string, name: string, value: unknown): Promise<void> {}
  onTelemetry(cb: (sample: TelemetrySample) => void): void { /* assina o ring buffer */ }
}
```

Esse mesmo `CoreClient` é o único ponto onde a Extension "sabe" que existe um processo nativo — todo o resto
da UI fala com `CoreClient`, nunca com sockets/buffers diretamente (SRP também no lado TypeScript).

## 13. UI da Extension — baseada no SimulIDE, exceto edição/compilação de código

Princípio: a organização de painéis/fluxo de trabalho segue o SimulIDE real (`C:\SourceCode\simulide_2\src\gui\`,
`mainwindow.{h,cpp}`), lido agora, não suposto — **com exceção de qualquer área de digitar/compilar
firmware**, que não existe no LasecSimul (compilação é sempre externa; o Core só lê o artefato já
compilado, seção 8.3). Onde o equivalente nativo do VSCode já cobre algo que o SimulIDE precisou construir
do zero (Qt não tem), o nativo do VSCode vence — "baseado no SimulIDE" não é cópia pixel a pixel.

`MainWindow` real é `QSplitter` com `CircuitWidget` (canvas) + `QTabWidget` lateral (`m_sidepanel`) contendo
abas de Componentes/Arquivos/Editor; instrumentos (`dataplotwidget/`), monitor serial (`serial/`) e monitor
de MCU (`memory/mcumonitor.h`) são janelas **abertas sob demanda**, nunca fixas no layout principal.

| SimulIDE (real) | Papel | Equivalente no LasecSimul (real, auditado 2026-07-07) | Nota |
|---|---|---|---|
| `CircuitWidget`/`CircuitView` (canvas central) | Área principal, sempre visível | `SchematicPanel.ts` (`vscode.WebviewPanel`) + `ui/webview/main.ts` | Mesmo conceito; renderização própria (SVG/DOM), não `QGraphicsScene`. |
| `ComponentList` + busca (aba do `m_sidepanel`) | Paleta de componentes, filtro por texto | `ComponentPaletteViewProvider.ts` (`vscode.WebviewView`) + `ui/webview/palette.ts`/`paletteTree.ts` | **Decisão final, revertida do plano original** (esta linha dizia "`TreeView` nativo do VSCode, não webview"): uma implementação em `TreeDataProvider` chegou a existir (`ui/tree/ComponentPaletteProvider.ts`) mas nunca foi registrada/ligada, e foi removida como código morto na auditoria de 2026-07-07 — a Webview de paleta é a que está de fato em produção, com busca/árvore construídas a partir de `folderPath`/`category` do catálogo (seção 13.1, sem hardcode de typeId→pasta). Migrar de volta pra `TreeView` nativo é decisão de produto nova, não retomada do código morto. |
| `FileWidget` (aba do `m_sidepanel`) | Navegador de arquivos do projeto | **Nenhum** | Redundante com o Explorer nativo do VSCode — não replicar. |
| `EditorWindow` (aba do `m_sidepanel`) | Editor + compilador de firmware embutido | **Nenhum — excluído** | Pedido explícito: não compilamos firmware. Se o usuário quiser ver a fonte, abre um arquivo normal no próprio VSCode — sem necessidade de editor dedicado. |
| Diálogo de propriedades (`gui/properties/`, `QDialog` modal) | Editar propriedade do componente selecionado | `<dialog>` modal DENTRO do mesmo `SchematicPanel`/`main.ts`, aberto com duplo-clique no componente | **Decisão revertida** (esta linha dizia "painel persistente, não modal" — avaliado na prática e descartado): um painel lateral fixo ocupava espaço permanente e duplicava a paleta; o diálogo sob demanda, igual ao SimulIDE, manteve o canvas inteiro livre. Já alimentável via `IComponentModel::propertyDescriptors()` (seção 6.1), só a apresentação na Extension mudou. Não é um `vscode.WebviewPanel` separado -- é um `<dialog>` HTML dentro da MESMA Webview do canvas. |
| `dataplotwidget/` (osciloscópio/plotter) | Instrumento aberto a partir de um componente | Popup flutuante DENTRO do mesmo `SchematicPanel`/`main.ts` (`renderInstrumentPopups`), não um `vscode.WebviewPanel` separado | Mesmo conceito (sob demanda, não fixo na tela), implementação mais leve que o previsto originalmente -- nunca existiu `InstrumentPanel.ts` como painel próprio; um popup por instrumento aberto, todos dentro da mesma Webview do canvas. |
| `serial/` (terminal serial) | Console de UART | `vscode.Terminal` (já decidido na seção 8, item 8) | Sem painel novo — UART já roteia pro terminal nativo. |
| `memory/mcumonitor.h` (`MCUMonitor`, RAM/Flash/registrador/PC, `QDialog` sob demanda) | Inspeção de memória/registrador do MCU emulado | Ainda não implementado como UI dedicada (`McuMonitorPanel.ts` planejado aqui nunca foi construído) | QEMU já expõe isso via `gdbserver` (seção 8, item 9), usável direto do VSCode; um painel amigável por cima continua como trabalho futuro genuíno, não uma nomenclatura desatualizada como os itens acima. |
| Toolbar: `powerCircAct`/`pauseSimAct` | Play/pause da simulação | `lasecsimul.run`/`lasecsimul.pause`, registrados direto em `extension.ts` | Confirma o que já existia — sem mudança. Não existe `ui/commands/` como diretório separado (todo comando é registrado em `extension.ts`, ver seção 5). |
| Toolbar: `newCircAct`/`openCircAct`/`saveCircAct` | Novo/abrir/salvar projeto | API nativa de arquivo do VSCode (`workspace.fs`, diálogos nativos) | Não construir diálogo de arquivo próprio — o VSCode já oferece. |
| Toolbar: `zoomFitAct`/`zoomSelAct`/`zoomOneAct` | Zoom do canvas | Interno a `ui/webview/main.ts` | Estado de zoom é da webview, não um comando da Extension. |

### 13.1 Taxonomia da paleta de componentes — categorias do SimulIDE, não inventadas

A paleta (`ui/webview/paletteTree.ts::buildPaletteTree`) replica a árvore derivada do catálogo unificado
`LasecSimul/project/schema/component-catalog.json` (`items[]`). A taxonomia continua seguindo o
SimulIDE (`src/gui/componentlist/itemlibrary.cpp`, `loadItems()`, com tradução pt_BR de
`resources/translations/simulide_pt_BR.ts`) — não uma taxonomia própria. **Regra**: todo `typeId`
novo no catálogo usa nome/caminho de pasta equivalente ao SimulIDE; nunca inventar categoria nova se
já houver equivalente. Tabela completa (12 categorias de topo, 17 subcategorias, ~140 itens — o que
o LasecSimul implementa hoje é fração disso) em **`docs/15-taxonomia-paleta.md`**.

Cada item de paleta declara `folderPath` (array de segmentos) e a árvore é construída por caminho
hierárquico completo, sem limite fixo de profundidade (não só categoria/subcategoria). `category`/
`subcategory` existem como compatibilidade para entradas legadas; quando `folderPath` estiver presente,
ele é soberano.

Mesmo princípio visual do SimulIDE: pasta/categoria de topo nunca exige ícone próprio; item de
componente pode declarar ícone de Webview (`iconLightUri`/`iconDarkUri`, derivados de
`extension/media/components/{light,dark}/<icone>.svg` — par claro/escuro porque ícone de arquivo
custom não é retematizado automaticamente pelo VSCode, diferente de `ThemeIcon`/codicon). Árvore é
derivada do catálogo (sem lista hardcoded no provider) — pasta sem item descendente não aparece.

### 13.1.1 Contrato canônico do catálogo unificado (anti-corrupção)

Arquivo canônico: `LasecSimul/project/schema/component-catalog.json`.

Campos mínimos:

```json
{
  "schemaVersion": 1,
  "deviceLibraries": ["../devices/library.json", "../mcu-adapters/library.json"],
  "items": [
    {
      "typeId": "passive.resistor",
      "label": "Resistor",
      "pinCount": 2,
      "icon": "resistor",
      "folderPath": ["Passivos", "Resistores"],
      "defaultProperties": { "resistance": 1000 }
    }
  ]
}
```

Regras normativas (MUST/NEVER):

1. `project/schema/component-catalog.json` é a única fonte de verdade para catálogo de UI e para
   descoberta de bibliotecas a carregar no Core.
2. A shell (VSCode Extension hoje, qualquer outra no futuro) MUST ler `deviceLibraries[]` desse
   arquivo e chamar `loadDeviceLibrary` para cada entrada.
3. Código de UI MUST montar árvore/paleta a partir de `items[]`; listas hardcoded de componentes ou
   categorias são proibidas.
4. `folderPath` MUST ser tratado como caminho hierárquico completo e soberano quando presente.
5. `category`/`subcategory` (quando existirem) são fallback de compatibilidade; novos itens SHOULD
   declarar `folderPath`.
6. `typeId` é a chave estável entre UI, IPC e Core; mudar `typeId` exige migração explícita de
   projetos/fixtures e revisão de compatibilidade.
7. `pinCount` e `defaultProperties` definidos no catálogo MUST ser o contrato inicial da UI para
   criação de instância (requestAddComponent/addComponent).
8. Subcircuitos, plugins e built-ins seguem o mesmo catálogo (`items[]`) — a origem de execução muda,
   o mecanismo de catalogação não.
9. `extension/src/ui/webview/catalog.ts` pode existir somente como fallback de boot; nunca como fonte
   primária em produção.
10. `contributes["lasecsimul.deviceLibraries"]` (VSCode `package.json`) NÃO existe mais (removido em
    2026-07-07, auditoria de UI -- confirmado que nada no código lia esse bloco; a única fonte real
    já era `component-catalog.json::deviceLibraries[]`, item 1 acima). Não reintroduzir.
11. `language` (string, BCP-47) MUST estar declarado na raiz de `component-catalog.json` — é a língua
    em que `items[].label`/`items[].folderPath` estão escritos. `translations.<lang>.items.<typeId>`
    MAY sobrescrever `label`/`folderPath` por item, pra outra língua (seção 6.3.1/6.3.2 — modelo
    conceitual `LocalizedString`, codificado como bloco `translations` paralelo, não union inline).
    Para o catálogo first-party do projeto, `translations.en` é obrigatória para todo item novo.
    **Implementado**: `UnifiedCatalog.ts::resolveLocalizedItems`, exemplo real em
    `project/schema/component-catalog.json`, e fontes registradas/subcircuitos com fallback de pasta

12. A UI MUST traduzir `authoringScene`/`package` por um parser/tradutor genérico compatível com a
  construção do SimulIDE (mesmos primitivos, mesmas transformações e mesma semântica de pinos/fios).
13. A UI MUST NOT depender de helper ad-hoc por dispositivo (`if/switch` por `typeId`) para montar
  geometria, pinos, placement ou wire routes quando essa informação existir no payload declarativo
  (`authoringScene`/`package`/metadata).
14. Mapeamento hardcoded por dispositivo para rendering/placement é OUT OF SCOPE; a única exceção
   permitida é infraestrutura genérica do próprio parser/tradutor (normalização, validação, fallback
   sintático), sem regra de negócio acoplada a `typeId` específico.
    localizável em `extension.ts`.
15. `registeredSources[]` (opcional, não mostrado no bloco de campos mínimos acima) MUST apontar só pra
    arquivos/diretórios — bibliotecas inteiras ou um registro avulso feito pelo usuário via "Registrar
    arquivo..." — NUNCA enumerar manualmente cada dispositivo já coberto por uma entrada de
    `deviceLibraries[]`. A Extension deriva as entradas de paleta automaticamente expandindo cada
    `library.json` de `deviceLibraries[]` (`registeredSources.ts::expandLibraryJsonToSources`,
    `catalogCommands.ts::refreshUnifiedCatalogState`) — um `library.json` já é, sozinho, o "arquivo
    canônico que declara 1 ou vários dispositivos" (`lasecsimul-native-devices.spec` seção 14, "Unicidade
    global de device ID"). Achado real corrigido 2026-07-15: os ~69 dispositivos de
    `devices/library.json`/`mcu-adapters/library.json`/`subcircuits/library.json` estavam TAMBÉM
    hand-authored em `registeredSources[]`, mascarando um bug de empacotamento (`package-release.js`
    zerava esse array antes de gerar o VSIX) que fazia NENHUM deles aparecer numa instalação real.
16. Cada `typeId`/`chipId` MUST pertencer a exatamente um arquivo canônico (`.lsdevice`/`.lssubcircuit`),
    descoberto uma única vez pelo sistema inteiro. Duplicidade entre `items[]` estático,
    `deviceLibraries[]` expandido e `registeredSources[]` avulso é erro arquitetural, nunca
    first-wins/last-wins/overwrite silencioso — reportado por `deviceUniqueness.ts::checkDeviceIdUniqueness`
    (Extension, `vscode.window.showErrorMessage` nomeando as duas definições) e rejeitado por
    `GlobalPluginCache::loadLibrary` (Core, lança `std::runtime_error`). Recarregar o MESMO arquivo de
    novo (mesmo caminho canônico) é reload idempotente, não conflito.

### 13.1.1 Contrato normativo único de geometria (`simulide-terminal-v1`)

Este contrato é a fonte normativa para geometria de componentes e substitui qualquer descrição
histórica conflitante nesta especificação. O relatório
`docs/28-geometria-simulide-terminal-unico-2026-07-13.md` contém evidências, referências de linha e
resultados da investigação; ele não cria uma segunda definição do contrato.

1. `PackagePin.x`/`y` MUST representar sempre, em coordenadas locais do componente, o **terminal
   elétrico externo**: o mesmo ponto onde começa visualmente o lead e onde o wire se conecta.
   Corpo, renderer e topologia MUST NOT manter coordenadas independentes para esse ponto.
2. O contato interno com o corpo MUST ser derivado exclusivamente do terminal, de `angle` e de
   `length`, seguindo a semântica do SimulIDE (`Pin::setRotation(180-angle)`). `leadOrigin` é legado e
   MUST NOT existir no catálogo canônico, em `PackagePin` ou no modelo interno. O sanitizador de
   entrada MAY aceitar somente payload legado explicitamente marcado como origem no corpo, convertê-lo
   imediatamente para terminal e descartar a marca.
   Packages portados do `paint()` real SHOULD declarar `coordinateSpace: "simulide-local"`: nesse
   modo, `pins`, labels e primitivas usam diretamente os `QPoint` locais da fonte e
   `simulidePaint.bounds`/`m_area` fornece a única origem de normalização para corpo e terminais.
3. Flip local, rotação em torno da origem local, translação para a cena, transformação inversa,
   cálculo dos cantos transformados e snap MUST usar a infraestrutura comum
   `extension/src/ui/webview/componentGeometry.ts`. Renderer, wire topology, hit-test, seleção e
   dispositivos MUST NOT reimplementar fórmulas próprias equivalentes.
4. A ordem normativa é: geometria local -> espelhamento local -> rotação local -> translação de cena.
   A conversão cena->local MUST ser a inversa exata dessa composição. Arredondamento ou snap MUST
   ocorrer somente em eventos de placement/edição no espaço da cena, nunca durante `paint`/SVG nem
   durante a transformação dos pinos.
5. `boundingRect`/bounds resolvidos MUST ser derivados do corpo, shapes e extremos visuais dos leads,
   com margem de stroke explícita e mínima. Labels só integram os limites quando a política declarada
   assim determinar. Área de seleção/`shape` MAY ser mais tolerante, mas MUST NOT alterar a geometria,
   a origem, o snap ou o endpoint elétrico.
6. Rotação e espelhamento MUST usar a mesma origem local declarada para corpo e pinos. Escala/zoom da
   view MUST NOT mudar coordenadas lógicas, comprimentos de terminais ou endpoints elétricos.
7. Componentes repetitivos MUST derivar corpo, células e pinagem de uma única descrição paramétrica
   (`dynamicLayout`/`pinGroups` e `simulidePaint.repeat`, ou sucessor genérico equivalente): linhas,
   colunas, célula, espaçamento, margens, ordem e orientação. Coordenadas especiais por célula ou por
   dispositivo são proibidas quando puderem ser obtidas desses parâmetros.
   Quando `dynamicLayout.replacePins` for `true`, `package.pins` MUST estar vazio; manter uma cópia
   estática do mesmo layout é erro de catálogo e MUST ser rejeitado pelo check de migração.
   O `fallback` interno de uma `PackageNumberExpression` é uma base bruta que ainda recebe
   `multiplier/offset`. Já o fallback fornecido pelo campo (`package.width`/`height` ou bounds
   declarado) é o resultado final e MUST NOT passar novamente pela expressão. Previews de inserção
   MUST materializar as mesmas `defaultProperties` usadas para criar a instância antes de calcular
   `componentBox`.
8. Esquemático e Modo Placa MAY ter desenhos e bounds visuais diferentes, mas MUST compartilhar
   identidade dos pinos, endpoint elétrico, transformação, rotação/flip, serialização e estado de
   simulação. Uma variante visual não cria uma segunda implementação elétrica.
9. O catálogo canônico MUST declarar `geometryConvention: "simulide-terminal-v1"`. A migração/check
   `scripts/migrate-package-pin-terminals.mjs --check` MUST rejeitar coordenadas legadas ou ambíguas.
10. A aceitação MUST cobrir, no mínimo: quatro rotações, ambos os flips, round-trip local/cena,
    coincidência entre extremo visual e wire endpoint, bounds sem corte/margem excessiva, layout
    repetitivo uniforme, snap, zoom e persistência após salvar/reabrir. Novos dispositivos entram na
    auditoria geral; não recebem offset corretivo por `typeId`.

Referência arquitetural confirmada no SimulIDE: `Component : QGraphicsItem` e `m_area` em
`src/components/component.h`; `Component::boundingRect`, flip com `QTransform::fromScale` e rotação
do item em `src/components/component.cpp`; `Pin` como item filho, `setPos`, `setRotation(180-angle)`,
`scenePos` como conexão elétrica e lead desenhado a partir de `(0,0)` em
`src/components/connector/pin.cpp`; snap/grid em `src/utils.cpp` e `src/gui/circuitwidget/circuit.cpp`;
zoom via `QGraphicsView::scale` em `src/gui/circuitwidget/circuitview.cpp`. O commit de referência é
`ed253d6612b1293a320d68d6e27968cd7e6523c4`; linhas exatas ficam registradas no relatório citado.

### 13.2 Achado fora do mapeamento de painel: `BatchTest` — regressão headless de circuitos

`gui/testing/batchtest.h` roda N arquivos de circuito de uma pasta sem UI, contra "unidades de teste"
(componentes especiais colocados no próprio circuito que reportam pass/fail), acumulando falhas. Não é um
painel — é uma capacidade de **testar circuitos salvos automaticamente, sem abrir o VSCode**. Não implementar
agora, mas vale registrar: nosso Core já é headless por construção (`core/test/voltage_divider_test.cpp`
prova isso), então replicar essa capacidade depois é rodar o Core contra N `.lsproj` salvos — não exige
nenhuma peça nova de arquitetura, só um executável pequeno que itera arquivos e chama `SimulationSession`.
Candidato natural a feature futura de CI/regressão, não a UI.

### 13.3 Rótulo de identificação e de valor no esquemático — implementado

Achado em auditoria do SimulIDE-dev (`components/component.{h,cpp}`): todo componente tem dois rótulos de
texto desenhados perto do símbolo — `m_idLabel` (nome com índice, ex: `"Resistor-1"`) e `m_valLabel`
(valor formatado da propriedade principal, ex: `"1 kΩ"`) — cada um com checkbox próprio de visibilidade
(`Show_id`/`Show_Val`), modelados como `ComProperty` comuns do próprio componente (mesmo mecanismo
genérico de propriedade, sem caso especial). O LasecSimul replica o conceito com duas diferenças
deliberadas (decididas com o usuário, não suposição):

1. **Contador por `typeId`**, não global de sessão — SimulIDE usa `Circuit::m_seqNumber` único pra todos
   os tipos (gera furos ao misturar tipos: "Resistor-1", "Capacitor-2", "Resistor-3"); o LasecSimul conta
   por tipo (`nextIndexedLabel` em `extension.ts` e em `main.ts`, duplicado — dois pontos de criação de
   componente independentes), igual ao padrão de ferramentas EDA (KiCad/Eagle) — `Resistor-1`,
   `Resistor-2` sempre sequenciais entre si. Nunca persistido como contador separado: recalculado a
   cada criação a partir de `WebviewComponentModel.label` de quem já existe (mesmo princípio do
   `Circuit::loadStrDoc` do SimulIDE — "se number > m_seqNumber, ajusta", só que aqui é recalculado toda
   vez, não cacheado).
2. **Reaproveita a flag `PropertySchemaShowOnSymbol`** (seção 6.1.2) em vez de um ponteiro `m_showProperty`
   separado por componente — o rótulo de valor é, por definição, a propriedade do schema marcada
   `showOnSymbol` (no máximo uma por typeId hoje); `Resistor`/`Capacitor`/`Inductor`/`DcVoltageSource`
   marcam sua única propriedade elétrica com essa flag, `Button` não marca nenhuma (estado já visível
   pelo símbolo aberto/fechado). O mesmo flag já alimentava a leitura ao vivo do voltímetro
   (`displayVoltage`, `editor: "display"`) — `valueLabelText` (`main.ts`) generaliza os dois casos
   (estático formatado vs. telemetria ao vivo) por um único caminho, sem checar `typeId`.

Visibilidade (`WebviewComponentModel.showId`/`showValue`) é propriedade **de sistema** — aplica-se a
QUALQUER typeId igual, nunca vem do `propertySchema` do Core (não é elétrica); 2 checkboxes sintéticos
("Mostrar nome"/"Mostrar valor") são injetados direto pelo diálogo de propriedades (`renderPropertySheet`
em `main.ts`), num grupo "Visual" sempre presente, fora do mecanismo `resolvePropertyFields`. Mudar um
envia `requestUpdateLabelVisibility` (`WebviewToHostMessage`) — handler em `extension.ts` só atualiza
`schematicState`, nunca toca o Core (puramente visual). Persistido em `ProjectComponent.label`/`showId`/
`showValue` (`.lsproj`) — sem isso, o nome indexado se perderia a cada save/reload, igual o
`label`/`Show_id`/`Show_Val` que o SimulIDE também persiste (`CompBase::toString()`).

Formatação do rótulo de valor (`formatEngineeringValue` em `main.ts`) porta o `valToUnit` do SimulIDE
(`utils.h`): escolhe o prefixo SI (p/n/µ/m/—/k/M/G) que mantém a mantissa abaixo de 1000.

**Fora de escopo desta rodada** (não implementado, backlog): arrastar o rótulo independentemente do
símbolo (`Label::mousePressEvent`/`mouseMoveEvent` do SimulIDE) — posição hoje é fixa (acima/abaixo da
caixa do componente), sem edição de posição/rotação do rótulo em si.

### 13.4 Seleção múltipla, atalhos de teclado e zoom — implementado

Achado em auditoria do SimulIDE-dev: **o SimulIDE não distingue arrastar pra direita vs. pra esquerda**
ao selecionar por retângulo — `CircuitView` usa só `QGraphicsView::setDragMode(RubberBandDrag)` puro do
Qt (`circuitview.cpp` linha 52), seleção por **interseção simples** (`IntersectsItemShape`, padrão do
Qt), sem lógica de direção alguma. Essa distinção (direita = "contém", esquerda = "intersecta") é
convenção de outras ferramentas (AutoCAD/Eagle), não do SimulIDE — o LasecSimul implementa a versão
real do SimulIDE (interseção simples), não a variante direcional.

**Modelo de seleção múltipla**: `WebviewProjectState.selectedComponentId?: string`/`selectedWireId?:
string` (singulares) tornaram-se `selectedComponentIds: string[]`/`selectedWireIds: string[]` — array
vazio é "nada selecionado", nunca `undefined`. Migração de estado persistido pré-existente
(`vscode.getState()`) feita em `normalizeProjectState` (`main.ts`), unidirecional (seleção não precisa
sobreviver a uma atualização da extensão).

**Marquee** (`main.ts`, `pointerdown` no `.canvas` em área vazia — componente/fio/pino já chamam
`stopPropagation()` nos próprios listeners, então nunca disparam o marquee por engano): overlay visual
em coordenadas de tela (`.marquee-rect`); confirmado como arrasto (não clique simples) só após um
limiar de ~4px; no `pointerup`, `applyMarqueeSelection` testa interseção de caixa
(`component.x/y` + `componentBox(typeId)`) contra os 2 cantos convertidos pra coordenada local
(`eventToCanvasPoint`) — fio entra se algum ponto da polilinha cair dentro do retângulo (simplificação
documentada de "toca"). Shift+click individual alterna um item dentro/fora da seleção (convenção comum
de desktop, não verificada item-a-item contra o SimulIDE).

**Atalhos** (`circuit.cpp::keyPressEvent` do SimulIDE, replicados em `window.addEventListener("keydown")`
de `main.ts`): `Ctrl+R` rotaciona CW todos os componentes selecionados; `Ctrl+Shift+R` rotaciona CCW;
`Ctrl+A` seleciona todo componente/fio não oculto; `Delete`/`Backspace` remove toda a seleção (estendido
de 1 item pra N — uma mensagem IPC por item, nenhum verbo em lote novo). Atalho solto `r` (sem Ctrl,
pré-existente) continua rotacionando só o primeiro selecionado, sem conflito com `Ctrl+R`.

**Zoom por scroll** (`CircuitView::wheelEvent` do SimulIDE): fator `2^(-deltaY/700)` (mesma fórmula),
zoom centralizado no cursor (ponto canvas-local sob o cursor recalculado e mantido fixo após a mudança
de escala — técnica padrão de "zoom under cursor"), limitado a `[0.2, 4]` (**decisão do LasecSimul, não
do SimulIDE** — o SimulIDE real não tem limite codificado). Implementação exigiu introduzir
`viewport.{x,y,zoom}` de fato (existia no schema, mas estava morto — nenhum código lia/escrevia):
conteúdo do esquemático (fios+componentes) passou a viver num wrapper `.canvas-content` com
`transform: translate(x,y) scale(zoom)`, enquanto `.canvas` (onde ficam os listeners de
pointerdown/wheel/contextmenu) continua um viewport fixo, nunca se move — `eventToCanvasPoint` inverte
a transformação (`(client - rect - pan) / zoom`) em todo cálculo de coordenada tela→canvas. O drag de
componente (que somava delta de `clientX`/`clientY` cru) precisou dividir o delta por `zoom` — sem isso,
mover um componente com zoom ≠100% ficaria mais rápido/lento que o cursor.

**Menu de contexto** (`Component::contextMenu` do SimulIDE): completo com Rotacionar CW/CCW/180°,
Excluir, Propriedades (só quando exatamente 1 item selecionado) — right-click num item que já faz parte
de uma seleção múltipla atual opera sobre TODOS os selecionados; right-click num item FORA da seleção
atual troca a seleção pra só ele primeiro. Fundo vazio ganhou "Selecionar tudo".

**Cursor `grabbing`**: classe `.dragging` aplicada via JS no início do arraste de componente, removida
no fim — `cursor: grabbing` (CSS) enquanto arrasta, `grab` em repouso (já existia).

**Implementado após esta rodada inicial**: copiar/colar (`Ctrl+C/X/V`), flip horizontal/vertical
(`H`/`V`) e undo/redo (`Ctrl+Z/Y`/`Ctrl+Shift+Z`) já existem. Ver seção 17 para o desenho atual do
histórico de undo/redo e os keybindings finais.

**Correção pós-validação — `Ctrl+R`/`Ctrl+Shift+R` sobrepondo keybinding nativo do VSCode**: tratar a
tecla só no `keydown` da Webview (com `event.preventDefault()`) não impede o VSCode de TAMBÉM despachar
seu próprio comando nativo pra essas teclas (`Ctrl+R` = "Abrir recente") — são dois listeners
independentes (host VSCode vs. conteúdo do iframe da Webview), `preventDefault()` de um não afeta o
outro. Mecanismo certo (e o usado aqui): `contributes.keybindings` (`extension/package.json`) rebind
explícito pros comandos `lasecsimul.rotateSelectionCw`/`Ccw`, com `"when": "activeWebviewPanelId ==
'lasecsimul.schematic'"` — sobrepõe o nativo do VSCode SÓ enquanto o painel do esquemático está em
foco; ao trocar de foco o `when` deixa de casar e o atalho nativo volta a funcionar sozinho, sem
nenhuma lógica de restauração manual no código. O comando manda `requestRotateSelection`
(`HostToWebviewMessage`) pra Webview; a Webview NÃO trata mais `Ctrl+R`/`Ctrl+Shift+R` no próprio
`keydown` (só esse caminho, pra não rotacionar em dobro caso o evento ainda chegasse de algum jeito).
Mesmo padrão deve ser usado pra qualquer atalho futuro que colida com um comando nativo do VSCode —
nunca tentar "ganhar a corrida" só dentro da Webview.

### 13.5 Atualizacao Core/Paleta SimulIDE de Switches, Passive, Active e Outputs

Implementado em 2026-06-28: a paleta canonica (`project/schema/component-catalog.json`) inclui os itens das
pastas do SimulIDE mostradas na referencia do usuario: `Switches`, `Passive` (`Resistors`, `Resistive
Sensors`, `Reactive`), `Active` (`Rectifiers`, `Transistors`, `Other Active`) e `Outputs` (`Leds`,
`Displays`, `Motors`, `Other Outputs`). No LasecSimul esses itens aparecem nas pastas pt-BR usadas pela UI
atual (`Interruptores`, `Passivos`, `Ativos`, `Saidas`) e preservam os nomes de item do SimulIDE, como
`Push`, `Switch (all)`, `Switch Dip`, `Relay (all)`, `KeyPad`, `ResistorDip`, `Electrolytic Capacitor`,
`BJT`, `Mosfet`, `LedMatrix`, `Hd44780`, `Dc Motor`, etc.

O Core registra os itens simples como built-ins em `CoreApplication.cpp`. Componentes que o solver atual
consegue representar diretamente continuam por `IComponentModel` built-in (resistivos, potenciometro,
chaves, rele simples, regulador de tensao, LED simples e passivos equivalentes). A regra de produto para
componentes complexos fica explicita: eles nao devem ganhar uma terceira forma de runtime; entram por uma
das duas vias existentes, built-in ou ABI. Nesta rodada, os componentes que estavam incompletos por serem
protocolados/graficos ou modelos ativos mais ricos foram movidos para a via ABI/plugin em
`devices/simulide-complex/`, mantendo os mesmos `typeId`s do catalogo:
`outputs.ssd1306`, `outputs.sh1107`, `outputs.hd44780`, `outputs.aip31068_i2c`, `outputs.ili9341`,
`outputs.st7735`, `outputs.st7789`, `outputs.gc9a01a`, `outputs.pcf8833`, `outputs.pcd8544`,
`outputs.ks0108`, `outputs.max72xx_matrix`, `outputs.ws2812`, `outputs.servo`, `outputs.audio_out`,
`passive.transformer`, `active.diac`, `active.scr`, `active.triac`, `active.bjt`, `active.mosfet` e
`active.jfet`.

A ABI foi aprimorada sem criar runtime paralelo: `PluginRuntime` injeta a propriedade reservada
`__typeId` no contexto de configuracao para permitir que um mesmo binario ABI compartilhe codigo entre
varios manifests, e `SimulationSession`/IPC expõem `sendComponentEvent`, que entrega eventos diretamente a
`LsdnDeviceVTable::on_event`. O evento usa os tags ABI existentes (`LSDN_EVT_PIN_CHANGE`/`LSDN_EVT_TIMER`)
para bordas temporizadas — `LSDN_EVT_BUS_WRITE`/`LSDN_EVT_BUS_READ_REQUEST` foram removidos no bump de ABI
major 2 (sem barramento por bytes nunca ligado a um `SimulationSession` real, ver
`docs/17-pendencias-pos-sessao-qemu-abi.md` seção 0.3). Quando uma biblioteca ABI
declara um `typeId` que ja existia como built-in aproximado, o registro de plugin substitui explicitamente a
factory anterior para novas instancias; isso preserva o contrato "built-in ou ABI" sem manter duas
implementacoes ativas do mesmo componente.

O pacote `simulide-complex` implementa interpretadores de comandos inspirados no SimulIDE para HD44780/AIP31068,
OLED SSD1306/SH1107, PCD8544, KS0108, controladores TFT ST77xx/ILI9341/GC9A01A/PCF8833, MAX72xx, WS2812 e
servo PWM, expondo RAM/framebuffer/estado por `get_state`. A entrada principal desses componentes e bit a bit via
`LSDN_EVT_PIN_CHANGE`: HD44780/KS0108 fazem latch de pinos paralelos em `EN`, PCD8544/MAX72xx/TFTs deslocam bits em
SCK/SCL, AIP31068/SSD1306/SH1107 reconhecem START/STOP e bytes I2C MSB-first, WS2812 mede pulsos temporizados e
servo PWM converte largura de pulso em alvo angular. Nao existe mais modulo generico de barramento remontando
byte algum — cada device decodifica o protocolo por conta propria a partir dos eventos de borda. Tambem substitui os aproximados de
DIAC/SCR/TRIAC, BJT/MOSFET/JFET, audio out e transformer por plugins ABI com estado/propriedades/modelo eletrico no
caminho de plugin. Teste de aceitacao headless: `CoreBootstrapTest::testSimulideComplexAbiEventsOverIpc` carrega
`devices/library.json`, instancia `outputs.hd44780` via ABI, envia RS/RW/D0-D7/EN por IPC bit a bit e verifica a DDRAM
via `getComponentState`.

Tambem esta implementado o contrato de `setProperty` que estava pendente na secao 6.1.2: validacao de
`readOnly`, tipo, faixa e opcoes antes do setter; erro IPC estavel (`errorCode`); `affectsTopology` marcando
topologia suja; e `requiresRestart` reportado explicitamente na resposta IPC sem reinicio automatico.

## 15. Novos verbos IPC e contratos de UI (2026-07-03)

### 15.1 `setTunnelName` — renomear túnel em runtime via IPC dedicado

**Contrato**: `setTunnelName { instanceId, pinId, oldName, newName }` → `{ ok, error? }`.

O `setProperty` genérico NÃO pode ser usado para renomear túnel porque ele apenas re-stampa o
componente (não reconstrói topologia). `SimulationSession::setTunnelName` faz o que é necessário:
remove o slot do mapa de túneis pelo nome antigo, muda o nome da propriedade, e re-registra — o que
dispara o rebuild de topologia correto (mesma operação que o `Tunnel::setName()` do SimulIDE real
desencadeia via `Simulator::rebuild()`). A Extension captura o estado ANTES de atualizar o
`schematicState` para obter `oldName` e `pinId`, depois chama `setTunnelName` em vez de `setProperty`
quando `name === "name"` e `typeId === "connectors.tunnel"`.

O catálogo de `connectors.tunnel` declara `defaultProperties: { name: "NetA" }` para que toda nova
instância tenha um nome não-vazio desde a criação — sem isso, o primeiro `setTunnelName` receberia
`oldName: ""` e não encontraria o slot para mover.

### 15.2 `setSimulationConfig` — throttle e limite de iterações não-lineares

**Contrato**: `setSimulationConfig { targetStepUs?, maxNonLinearIterations? }` → `{ ok, error? }`.

Configura dois parâmetros do `Scheduler` via `std::atomic` (thread-safe, sem parar a simulação):
- `targetStepUs`: intervalo mínimo de sleep entre eventos processados. `0` = sem throttle (padrão).
  Útil para ver a simulação em câmera-lenta em projetos simples.
- `maxNonLinearIterations`: cap no número de iterações do settle-loop por evento. `0` = sem limite
  (padrão). Útil para evitar que simulações com não-linearidades fortes travem em laços longos.

Ambos sobrevivem até o próximo `setSimulationConfig` ou fim da sessão. O Core não persiste esses
valores em arquivo — é responsabilidade da Extension reaplicá-los ao abrir o painel (via listener de
`vscode.workspace.onDidChangeConfiguration`).

### 15.3 Settings VSCode (`lasecsimul.*`)

As seguintes configurações VSCode (contribuídas em `package.json`) controlam comportamento global:

| Setting | Tipo | Default | Efeito |
|---|---|---|---|
| `lasecsimul.simulation.targetStepUs` | number | 0 | Enviado via `setSimulationConfig` ao mudar |
| `lasecsimul.simulation.maxNonLinearIterations` | number | 0 | Enviado via `setSimulationConfig` ao mudar |
| `lasecsimul.ui.showComponentIds` | boolean | false | Mostra IDs internos na UI (debug) |
| `lasecsimul.ui.snapToGrid` | boolean | true | Snap de posicionamento à grade |

O comando `lasecsimul.openSettings` abre o painel nativo de Settings do VSCode filtrado em
`"lasecsimul."` via `workbench.action.openSettings` — sem painel próprio, sem reimplementar a UI de
configurações.

### 15.4 Campo `help` no catálogo de componentes

`WebviewComponentCatalogEntry.help?: { description?: string; url?: string; file?: string }`

- `description`: texto curto (1-2 linhas) exibido no tooltip do botão "Ajuda" no diálogo de
  propriedades e no tooltip do item na paleta de componentes.
- `url`: link externo para documentação completa. O botão "Ajuda" no diálogo de propriedades dispara
  `requestOpenExternal { url }` → Extension → `vscode.env.openExternal(Uri.parse(url))`.
- `file`: caminho relativo ao manifesto para arquivo `.md` local (não implementado ainda — reservado).

O botão "Ajuda" fica desabilitado quando `help` está ausente ou nenhum `url` é fornecido. Todos os
device JSONs de `devices/simulide-sensors/` e `devices/simulide-peripherals/` têm `help.description`
declarado. Os built-ins do catálogo `project/schema/component-catalog.json` têm `help` nos tipos
relevantes (resistor, capacitor, fontes, medidores, conectores, etc.).

### 15.5 `requestOpenExternal` (Webview → Extension)

**Mensagem**: `{ version, type: "requestOpenExternal", url: string }`

Disparado pela Webview ao clicar no botão "Ajuda" quando `help.url` está presente. A Extension
simplesmente chama `vscode.env.openExternal(vscode.Uri.parse(url))` — sem validação adicional (a URL
vem do manifesto de primeira parte ou de item registrado pelo usuário, já confiável no mesmo nível que
o restante do manifesto).

## 16. Bug corrigido: menu de contexto do dispositivo aparece e é substituído pelo menu nativo (2026-07-06)

**Sintoma relatado**: clique direito num dispositivo mostra o menu customizado correto (com todas as
propriedades/ações) por um instante, mas ele logo desaparece e é substituído por um menu genérico
com apenas Cortar/Copiar/Colar.

**Causa raiz**: `showContextMenu()` (`extension/src/ui/webview/main.ts`, chamada por TODOS os 5
handlers de `contextmenu` da Webview -- componente, rótulo de texto externo, corner/segment handle
de fio, canvas vazio) chamava `event.stopPropagation()` incondicionalmente. Isso cortava a
propagação do evento DOM antes dele chegar em `window`/`document` -- onde o HOST da Webview do
VSCode (fora do controle da extensão, parte da infraestrutura de webview do próprio VSCode/Electron)
também escuta `contextmenu` pra decidir se abre o menu NATIVO (Cortar/Copiar/Colar) do editor, com
base em `event.defaultPrevented`. Como o evento nunca chegava lá, o host nunca via que o menu já
tinha sido tratado por completo e abria o nativo por cima -- um instante depois, por ser um
round-trip nativo/nível-Electron, não um evento DOM síncrono, o que explica o "aparece e some".

Confirmado com uma simulação do algoritmo real de dispatch/bubble (target → ancestors → window,
checando `defaultPrevented` a cada nível): com `stopPropagation()`, o "host" nunca observa o evento
e vê `defaultPrevented=false` (abriria o nativo); sem `stopPropagation()`, o host observa
`defaultPrevented=true` depois que qualquer handler mais específico já tratou o evento.

**Correção**: removido `event.stopPropagation()` de `showContextMenu()` e dos 2 handlers que também
chamavam explicitamente (componente, rótulo de texto externo) -- `preventDefault()` sozinho já basta
pra suprimir o menu nativo do navegador E sinalizar (via `defaultPrevented`) pro host que o evento
foi tratado. Como o evento agora BORBULHA normalmente até o `canvas` (ancestor de todo
componente/fio/handle no DOM, ver `.canvas` > `.canvas-content` > elementos), o handler de
`contextmenu` do `canvas` (o "genérico", mostra só "Selecionar tudo" em área vazia) ganhou uma
guarda `if (event.defaultPrevented) return;` no topo -- nunca substitui um menu mais específico já
mostrado por um descendente. Os 2 handlers de `handle` (corner/segment de fio) e o de rótulo de
texto externo NUNCA chamavam `stopPropagation()` diretamente (só via `showContextMenu`), então já
ficaram corretos automaticamente com a mudança na função compartilhada.

**Por que não é workaround visual**: a causa raiz era a suposição errada de que "cortar a propagação"
é a forma certa de impedir um menu mais genérico de substituir um mais específico -- na presença de
um host de Webview que TAMBÉM observa o mesmo evento em `window`/`document`, cortar a propagação tem
o efeito colateral de esconder do host que o evento já foi tratado. A troca por `defaultPrevented`
resolve os dois problemas com o MESMO mecanismo idiomático do DOM (`preventDefault()` sinaliza "já
tratado" pra qualquer observador em qualquer nível da árvore, sem impedir ninguém mais de OBSERVAR o
evento).

**Limitação desta sessão**: sem GUI disponível neste ambiente pra abrir o VSCode e confirmar
interativamente que o menu nativo não aparece mais -- a verificação foi (a) compilação limpa
(`tsc` webview + test), (b) suíte de testes completa sem regressão, e (c) uma simulação numérica do
algoritmo de bubble/`defaultPrevented` reproduzindo o bug com o código antigo e confirmando a
correção com o novo. Recomenda-se confirmar visualmente no VSCode real.

## 17. Undo/Redo (Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z) (2026-07-06/07)

Recurso inexistente até aqui (ver seção 13, item "Não existe" da auditoria de 2026-07-03) -- primeira
implementação, cobrindo tanto o circuito principal quanto a sessão de autoria de símbolo/subcircuito
("Abrir Subcircuito"/editor de `package`).

### 17.1 Por que snapshot de conteúdo, não comando/patch reversível

`state.components`/`state.wires` (`main.ts`) são mutados de formas inconsistentes ao longo do
arquivo -- às vezes por reatribuição imutável (`state = {...state, ...}`), às vezes campo a campo
direto (`component.x = ...` durante um drag, `state.viewport.x = ...` no pan). Não há um único ponto
de mutação nem um padrão de comando reversível (tipo Redux/command-pattern) pra interceptar. Em vez
de reescrever esse padrão do zero (risco alto, toca ~40 pontos do arquivo), o undo aproveita
`persistState()` (`main.ts`) como o funil ÚNICO por onde toda mutação relevante já passa hoje --
comparando o CONTEÚDO (`components`/`wires`, serializado) ANTES/DEPOIS de cada chamada e empilhando
um snapshot profundo (`structuredClone`) só quando algo realmente mudou.

### 17.2 Dois hooks, não quarenta

Mapeamento das ~40 chamadas de `persistState()`/`send()` revelou dois padrões de mutação:

1. **Mutação local + `persistState()`** (drag de componente, rotação, edição de propriedade no
   diálogo, Modo Placa, etc.) -- já cai automaticamente no hook de `persistState()`
   (`recordUndoSnapshotIfChanged`), sem precisar tocar cada call site.
2. **Só `send()` pro Host, sem mutar `state` local** (`deleteSelectedItems()` fora de autoria manda
   `requestRemoveComponent`/`requestRemoveWire` e espera o Host devolver o estado já sem o item via
   `syncState`; `pasteClipboardItems()` muta local mas via `vscode?.setState(state)` direto, não
   `persistState()`) -- sem cobertura própria, ficaria não-desfazível. Coberto por um 2º hook no
   handler de mensagem `"syncState"` (`main.ts`): compara o `state` ATUAL (ainda não sobrescrito)
   contra o `message.project` recebido, ANTES de aplicar a sobrescrita -- mesma função
   (`recordUndoTransition`) usada pelo hook de `persistState()`, só que alimentada por uma fonte
   diferente. `"init"` (1ª carga) NUNCA vira uma entrada de undo -- reseta o histórico pro estado
   recém-carregado em vez de registrar transição.

Isso evita duas armadilhas: (a) instrumentar manualmente 40+ pontos de mutação (alto risco de
esquecer um, ou de duplicar registro quando os DOIS hooks disparam pro mesmo evento -- o hook de
`syncState` é idempotente quando o conteúdo já bate, ex. depois de uma rotação que já mutou local +
persistiu, o `syncState` de confirmação do Host não gera 2ª entrada); (b) desfazer/refazer coisas que
não são realmente "ações do usuário" (mudança só de seleção, que também passa por `persistState()`
em vários call sites, nunca conta pra fins de undo -- comparação usa só `components`+`wires`, nunca
`selectedComponentIds`/`selectedWireIds`).

### 17.3 Uma pilha do esquemático

Desde 2026-07-09 não existe sessão de autoria visual de símbolo/package dentro do webview. O undo/redo
é uma única `UndoHistory` (`mainUndoHistory`) do esquemático real, e `activeUndoHistory()` sempre retorna
essa pilha. `mainUndoHistory` é resetada só em `"init"` (1ª carga/reload do painel); alterações
confirmadas por `"syncState"`/`"syncStatePatch"` entram nessa mesma história.

### 17.4 Atalho de teclado -- mesmo caminho do Ctrl+R (não o `keydown` da Webview)

Ctrl+Z (undo), Ctrl+Y e Ctrl+Shift+Z (redo, os dois) são comandos GLOBAIS nativos do VSCode
(undo/redo do editor de texto) -- mesmo problema documentado na seção 13.4 pro Ctrl+R/Ctrl+Shift+R:
sem um keybinding dedicado, o VSCode intercepta a tecla antes dela chegar no `keydown` da Webview.
Resolvido com o MESMO padrão: `contributes.keybindings` (`package.json`, `when:
activeWebviewPanelId == 'lasecsimul.schematic'`) aponta pros comandos `lasecsimul.undo`/
`lasecsimul.redo` (`extension.ts`), que só fazem `schematicPanel?.postMessage({type: "requestUndo"
| "requestRedo"})` -- a Webview trata essas mensagens (`main.ts`) chamando as MESMAS funções
`undo()`/`redo()` internas, únicas donas da lógica (nenhuma lógica duplicada no `keydown` local).
Como o painel do esquemático é o MESMO em modo normal e em sessão de autoria (`state` troca, o
painel/`viewType` não), o mesmo par de comandos cobre os dois contextos automaticamente --
`undo()`/`redo()` escolhem a pilha certa via `activeUndoHistory()` em tempo de execução.

### 17.5 Verificação

Sem GUI disponível neste ambiente pra confirmar interativamente no VSCode real. Feito: (a)
compilação limpa (`tsc` main + webview + test), (b) suíte de testes completa sem regressão, (c) uma
simulação standalone (Node, fora do DOM) replicando fielmente `recordUndoTransition`/`undo`/`redo`/
`resetUndoHistory` com 15 cenários -- sequência de undo/redo de múltiplas ações, nova ação após um
undo invalida o redo, mudança só de seleção não empilha, fluxo `syncState` (remoção via Host) vira
undoable e restaura a seleção anterior, pilhas de autoria/principal independentes -- todos passando.
Recomenda-se confirmar visualmente: mover/rotacionar/apagar/colar itens no schematic real e dentro de
"Abrir Subcircuito", Ctrl+Z/Ctrl+Y em cada caso, incluindo com o foco alternando entre o painel do
esquemático e outros painéis do VSCode.

## 18. Bug corrigido: bola azul grande permanente nas alças de canto de fio ortogonal (2026-07-09)

**Sintoma relatado** (com screenshot do circuito interno do ESP32 DevKitC dentro de "Abrir
Subcircuito", ver `lasecsimul-subcircuits.spec` seção 16): alguns encontros/cotovelos de fio
mostravam uma bola azul grande, permanente, poluindo visualmente o esquemático -- padrão diferente
do SimulIDE real, que não desenha marcador nenhum sobre fio fora de interação ativa.

**Causa raiz**: `renderWireCornerHandles()` (`extension/src/ui/webview/main.ts`) desenha um
`<circle class="wire-layer__corner-handle">` em CADA ponto interior (cotovelo) de TODO fio ortogonal
com 3+ pontos -- chamada incondicionalmente pro loop principal de render (`main.ts`) e pra
`updateWireVisual` (atualização incremental), nunca gated por seleção/hover. A classe base
`.wire-layer__corner-handle` (`styles.css`) tinha `fill: #eef5ff; stroke: #5b7fd1` (azul claro)
como cor PADRÃO, só trocando pra âmbar (`--selected`, `#f4b942`) quando aquele cotovelo específico
estava selecionado -- ou seja, todo cotovelo de todo fio multi-segmento ficava permanentemente
visível em azul, não só o selecionado. Isso não é o mesmo marcador que `.junction-dot` (nó elétrico
real de nó de topologia, âmbar 8px, ver seção 15 do spec de subcircuitos) -- é uma alça de UI
pra ARRASTAR o cotovelo, sem relação nenhuma com topologia elétrica. **Nota 2026-07-11** (seção 24):
na época desta seção, aquele nó elétrico ainda era o componente `connectors.junction`; desde a
reconstrução do sistema de fios ele é um `topologyNode` puramente visual, nunca um componente do
Core -- o resto desta seção (o bug da alça de canto azul) não muda em nada.

**Correção** (`extension/src/ui/webview/styles.css`): base de `.wire-layer__corner-handle` virou
`fill: transparent; stroke: transparent` (igual ao padrão já estabelecido em `.pin-terminal`, mesmo
bloco de comentário histórico "bola grande na cor de destaque" de 2026-07-04) -- `fill: transparent`
(não `none`) preserva 100% da área clicável/arrastável (`pointer-events` só ignora `none`;
"transparente" ainda conta como pintado), então NENHUMA lógica de drag/roteamento/reconciliação foi
tocada, só a cor. `.wire-layer__corner-handle--selected` continua âmbar como antes -- único estado em
que a alça fica visível, exatamente quando o usuário já selecionou aquele cotovelo especificamente
(mesmo princípio de `.wire-layer__segment-highlight`, que também só aparece com
`isWireSegmentSelected`, nunca por hover passivo). `cursor: move` (inalterado) já basta de affordance
antes de clicar.

**Verificação**: compilação limpa (`tsc` webview + test) e suíte de testes completa (154 testes) sem
regressão -- nenhum teste depende de cor/preenchimento de alça de fio. Mudança é puramente CSS (uma
troca de `fill`/`stroke` na regra base), zero linha de TypeScript tocada nesta correção. Sem GUI
disponível neste ambiente pra confirmar visualmente; recomenda-se reabrir um esquemático com fios
roteados em L/Z e confirmar que nenhuma bola aparece até selecionar o fio.

## 19. "Recarregar Firmware" removido da UI -- recarga automática antes de "Run" (2026-07-09)

**Pedido**: o usuário não deveria precisar clicar manualmente em "Recarregar Firmware" (menu de
contexto, MCU direto ou exposto dentro de um subcircuito) toda vez que recompilava o `.bin` fora do
LasecSimul -- ver seção 8.3 (`FirmwareWatcher`) pra contexto: aquele mecanismo (Core, polling de
PASTA) foi ESPECIFICADO em 2026-06-28 mas **nunca chegou a ser ligado em lugar nenhum** (confirmado
de novo nesta sessão: `grep` por `FirmwareWatcher` fora de `FirmwareWatcher.{hpp,cpp}`/seu teste
próprio não acha nenhuma chamada -- zero uso em `QemuProcessManager`/`McuComponent`). A UI sempre
exigiu o clique manual documentado como "nunca deveria acontecer" -- a seção 8.3 descrevia uma
INTENÇÃO de design, não o comportamento real até esta sessão.

**Decisão de arquitetura**: em vez de finalmente ligar o `FirmwareWatcher` nativo (pasta + polling
contínuo, muito mais invasivo -- exigiria trocar o seletor de arquivo por seletor de PASTA, mexer em
`QemuProcessManager`, recompilar o Core), a recarga automática foi implementada na Extension, no
formato que o pedido descreveu (arquivo único escolhido pelo usuário, verificado só no momento de
"Run", não continuamente):

- `extension/src/mcu/mcuCommands.ts::ensureAllMcuFirmwareUpToDate` -- roda ANTES de toda "Run"
  (`extension.ts::runSimulationWithFirmwareCheck`, os dois pontos de entrada: mensagem
  `requestRunSimulation` da Webview E comando `lasecsimul.run`). Para cada MCU/CPU com
  `properties.firmwarePath` configurado (`collectMcuFirmwareTargets` -- direto, `mcuHost: true` no
  catálogo, OU exposto dentro de uma instância `subcircuit-file`, via
  `gatherInternalComponentSnapshots`): confirma que o arquivo existe (`fileExists`), lê `mtimeMs`/
  `size` (`fs.statSync`) e compara contra `state.ts::lastLoadedFirmwareByCoreId` (novo `Map`, chave =
  `instanceId` do Core, não `componentId` -- uma instância NOVA, criada por
  `rebuildCoreFromSchematicState`, nunca está no mapa, então sempre recebe o firmware pelo menos uma
  vez, mesmo no PRIMEIRO Run; uma instância que sobrevive a Parar/Rodar sem edição estrutural no meio
  mantém a marca e pula o push se nada mudou).
- Idêntico (mesmo, mesmo tamanho) → pula, não chama `loadMcuFirmware` de novo (sem reiniciar o
  processo QEMU à toa). Diferente ou nunca carregado → chama `loadMcuFirmware` (mesmo verbo IPC de
  sempre -- Core trata como reset, seção 8 item 10, nenhuma lógica nova nele) e atualiza o mapa.
  Arquivo ausente/inacessível OU a própria recarga falhando → devolve `{ok:false, message}`, o Run
  inteiro é abortado com `vscode.window.showErrorMessage`, nada roda com firmware potencialmente
  desatualizado.
- "Carregar firmware" (escolher um NOVO arquivo, ação que continua existindo -- só "Recarregar" foi
  removida) empurra imediatamente se a simulação já estiver rodando (comportamento pré-existente,
  inalterado) e agora também grava em `lastLoadedFirmwareByCoreId`
  (`mcuCommands.ts::recordFirmwareLoaded`) -- sem isto, trocar o firmware ao vivo e depois Parar/Rodar
  recarregaria o MESMO arquivo de novo à toa no próximo Run.
- Removido da UI: itens de menu "Recarregar firmware" (`main.ts`, topo E submenu de MCU exposto),
  mensagens `requestReloadMcuFirmware`/`requestReloadExposedMcuFirmware` (`messages.ts`), funções
  `reloadMcuFirmwareCommand`/`reloadExposedMcuFirmwareCommand` (`mcuCommands.ts`) -- sem substituto
  nem no menu nem em nenhum comando de paleta de comandos, a recarga não é mais uma ação que existe
  pro usuário disparar.

**O que NÃO mudou**: como o `.bin` é escolhido inicialmente ("Carregar firmware", ainda um seletor de
ARQUIVO único, não pasta -- diferente do `FirmwareWatcher` especificado, que assumia pasta de build
variável); o verbo IPC (`loadMcuFirmware`, mesmo path+`instanceId`); o efeito no Core (mesmo kill+
respawn de sempre). `FirmwareWatcher` (seção 8.3) permanece implementado e testado, porém morto --
não foi removido (nenhuma instrução pra isso), só continua sem nenhuma chamada real.

**Verificação**: compilação limpa (`tsc` main + webview + test) e suíte completa (154 testes) sem
regressão. Sem GUI disponível neste ambiente pra confirmar interativamente com um MCU real; a lógica
de dedup (mtime+tamanho, chave por `instanceId`) foi revisada por leitura, sem simulação numérica
dedicada (não há cálculo geométrico/matricial aqui pra valer a pena simular fora do DOM, diferente das
seções 17/18). Recomenda-se: escolher um `.bin`, rodar, recompilar o mesmo arquivo fora do LasecSimul,
rodar de novo (deve recarregar sozinho, sem clique manual) e rodar uma 3ª vez sem tocar no arquivo
(não deve reiniciar o processo QEMU).

## 20. Knob "Dial" -- porta fiel de `CustomDial::paintEvent` e correção dos dependentes (2026-07-09)

**Pedido**: o usuário identificou que SimulIDE tem um widget "Dial" reutilizado como base de vários
dispositivos (inclusive os knobs de ajuste do osciloscópio) e pediu uma porta fiel + atualização de
tudo que depende dele.

**Achado de arquitetura real (`gui/customdial.cpp`, `gui/dialwidget.cpp`, `gui/circuitwidget/
dialed.cpp`, `components/other/dial.cpp`, todos em `C:\SourceCode\simulide_2`)**: existem DOIS
"dials" diferentes no SimulIDE real, não um só --
1. **`CustomDial`** (`QDial` com `paintEvent` customizado, pintado à mão) -- base de `Dialed`,
   usado por `Dial` (`other.dial`), `Potentiometer`, `VarResBase`/`VarInductor`/`VarCapacitor`
   (resistor/indutor/capacitor variável) e o `SourceWidget` de fonte controlada. Geometria: arco de
   300° a partir de 240° (sem wrapping) ou 360° a partir de 270° (com wrapping); marcas de escala
   (contagem = `maximum/singleStep`, limitada a espaçamento mínimo de 4px, sempre par) com a
   PRIMEIRA sempre vermelha (referência de zero); gradiente radial quase-branco com centro
   deslocado pro canto superior-esquerdo (`0%→#fff, 80%→#e6e6e1, 83%→#dcdcd7, 100%→#c8c8c3`); nub de
   valor (halo + corpo, círculos concêntricos) que se move ao longo do arco via `ângulo(ratio) =
   ratio*spanDeg - startDeg` -- MESMA fórmula pras marcas E pro nub, nunca duas separadas.
2. **`QDial` nativo sem subclasse** -- usado SÓ pelos 4 knobs do osciloscópio/analisador lógico
   (`oscwidget.ui`/`lawidget.ui`: `timeDivDial`/`timePosDial`/`voltDivDial`/`voltPosDial`), chrome
   do próprio SO, sem paint customizado. `wrapping=true`, e o valor muda por DIREÇÃO relativa (~1%
   do valor atual por "clique" do encoder, `OscWidget::on_timeDivDial_valueChanged`) -- nunca por
   ângulo absoluto; não existe posição real pra refletir (µs↔s não cabe numa rotação fixa).

**Implementação** (`extension/src/ui/webview/componentSymbols.ts::dialKnobSvg`, antiga
`qDialKnobSvg` renomeada e reescrita): porta fiel da geometria de `CustomDial::paintEvent` acima,
parametrizada por raio total do widget + `ratio`/`wrapping`/`tickCount` opcionais. **Dois bugs reais
corrigidos na função antiga**: (a) fórmula das marcas usava `startDeg + spanDeg*i/n` (SEM o sinal
negativo de `painter.rotate(-startAngle)` do real) -- marcas ficavam sistematicamente fora de
posição; (b) o nub tinha uma fórmula TOTALMENTE separada, decorativa, sempre travado no meio do
curso -- as duas agora usam a mesma `ângulo(ratio) = ratio*spanDeg - startDeg`, verificada por
rederivação manual da matriz de rotação real do Qt (`painter.rotate()`, convenção Y-pra-baixo, mesma
já usada por `rotatePoint`/`svgBodyTransform` no resto do projeto).

**Dependentes atualizados**:
- `other.dial` (`componentSymbols.ts`): usa `dialKnobSvg` com `ratio: 0.5` (valor padrão real do
  `QDial` recém-criado, `setValue(500)` sobre range 0-1000) -- sem `properties` modeladas ainda
  nesta rodada (catálogo não declara min/max/valor), não há estado real além disso pra refletir.
  Comentário anterior ("widget do SO, não dá pra reproduzir em SVG") corrigido -- factualmente
  invertido, é o CONTRÁRIO que é verdade (`CustomDial` é pintado à mão pelo próprio SimulIDE, 100%
  reproduzível; é o `QDial` do osciloscópio que é nativo/não reproduzível com fidelidade 1:1).
- `passive.variable_resistor`/`variable_capacitor`/`variable_inductor` (`project/schema/
  component-catalog.json`, `viewSpec` declarativo dos 3, blocos idênticos): gradiente corrigido
  pros stops reais (`0/80/83/100%`, antes `0/55/100%` com cores mais escuras/erradas); nub ganhou o
  halo que faltava (2º `<ellipse>` sem preenchimento, MESMO `partId: "dialIndicator"` do nub
  original -- `viewSpecResolvedProjection` (`componentSymbols.ts:734`) é chamada POR FORMA, não uma
  vez por `partId` único, então múltiplas formas com o mesmo `partId` recebem a MESMA projeção
  computada e se movem juntas em sincronia, verificado por leitura antes de aplicar). Interação/
  hit-test/limites (`dragAngular`, `stepsPerRev`, `-150°..150°`) intocados -- zero risco à
  funcionalidade já testada (`ViewSpec rotate aceita propRange/angleRange para Dialed contínuo`).
  Marcas de escala (ticks) NÃO adicionadas nesta rodada -- exigiriam enumerar ~15-20 formas de linha
  à mão por componente (`ComponentViewSpec.paint` usa `PackageShape[]`, sem a primitiva `repeat` que
  `simulidePaint.primitives[]` tem); risco/esforço vs. ganho visual não pareceu valer nesta rodada,
  registrado como pendência.
- Knobs do osciloscópio/analisador lógico (`main.ts::makeKnobRow`): trocado o círculo CSS estático
  (gradiente + entalhe fixo que nunca girava) pelo `dialKnobSvg` real, com `wrapping: true` (igual
  ao `QDial` real desses 4 controles). Como o valor NÃO mapeia pra ângulo absoluto (ver ponto 2
  acima), o nub gira por um contador de posição PRÓPRIO (`knobDialPositions`, módulo-level, mesmo
  modelo 0-1000 do `QDial` interno real) incrementado a cada interação (roda do mouse/arrasto) --
  puramente feedback visual de "girei o botão", nunca uma representação do valor físico (µs↔s não
  caberia numa posição fixa sem pular loucamente a cada refresh). Interação real (wheel/drag
  ajustando o spinner numérico ao lado) inalterada.

**Verificação**: compilação limpa (`tsc` main + webview + test) e suíte completa (154 testes) sem
regressão, incluindo os 2 testes existentes que cobrem os 3 componentes `viewSpec.dial`
(`ViewSpec overlayPaint desenha dial por cima de simulidePaint`, `ViewSpec rotate aceita propRange/
angleRange para Dialed contínuo`) -- nenhum deles asserta contagem exata de `stops`/formas do nub, o
que teria quebrado com estas mudanças se fosse o caso. Fórmula angular verificada por rederivação
manual da matriz de rotação (não simulação numérica automatizada desta vez -- ver seções 17/18 pro
padrão quando compensa). Sem GUI disponível neste ambiente pra confirmar visualmente; recomenda-se
abrir um `other.dial`, um resistor/indutor/capacitor variável (arrastar o knob, confirmar que ainda
ajusta o valor normalmente) e a janela "Expande" do osciloscópio, e comparar visualmente com o
`CustomDial` real do SimulIDE.

**Errata visual do `CustomButton` (2026-07-13)**: `CustomButton::paintEvent()` configura um `QPen`
escuro e chama `QPainter::drawText`; isso colore os glifos, não cria contorno. Na tradução SVG, o
grupo `.meter-expand-button` MUST ser somente hit-target/cursor e MUST NOT declarar `fill`/`stroke`
herdáveis. O `<text>` MUST usar `stroke="none"`. Bordas e gradiente pertencem exclusivamente aos
retângulos do botão. Aplicar `stroke:#999` ao grupo produz texto duplo/borrado em qualquer DPI.

## 21. Bug corrigido: corpo do símbolo deslocado, desconectado dos pinos (2026-07-10)

**Sintoma relatado**: depois de adicionar o dial ao Potenciômetro (seção 20), o usuário reportou
"resíduo" -- na verdade era o corpo INTEIRO (dial, retângulo, fio do cursor) desenhado ~16 unidades
deslocado dos 3 pinos, restos "flutuando" desconectados na tela.

**Causa raiz** (`extension/src/ui/webview/componentSymbols.ts`): todo `package` com `simulidePaint`
passa por DOIS deslocamentos que deveriam ser UM só:
1. `simulidePaintToPackageShapes`/`transformFor` (`simulidePaint.ts`) já desloca coordenadas locais
   do `QPainter` (`bounds.x`/`bounds.y`, tipicamente negativas) pro espaço positivo da caixa.
2. `packageSymbolSvg` (`componentSymbols.ts:1107`) SEMPRE envolve o corpo inteiro num
   `<g transform="translate(offsetX,offsetY)">`, onde `offsetX/Y` vem de `resolvePackageLayout`
   (baseado na extensão real dos PINOS, não do `simulidePaint`).

Pra QUALQUER `typeId` cujos pinos usam coordenada "local" (mesmo espaço negativo do `simulidePaint`,
ex: `active.diode` pino ânodo em `x:-10`, espelhando `bounds.x:-10`) em vez de já-no-espaço-da-caixa
(convenção usada por `passive.variable_resistor`/`sources.voltage_source`/etc, pinos sempre ≥0), o
passo 2 RECALCULA `offsetX` a partir do próprio pino negativo -- deslocando o corpo (que o passo 1 JÁ
tinha posicionado certo) uma SEGUNDA vez pela MESMA quantidade. Pinos (que não passam pelo passo 1)
recebem só o deslocamento certo (passo 2) -- resultado: corpo e pinos acabam em referenciais
diferentes, sempre que `offsetX`/`offsetY` calculado a partir dos pinos for diferente de zero.

**Por que só apareceu agora**: o Potenciômetro sempre teve esse bug (`pin-1.x: -11`, deslocamento de
16 unidades) -- só nunca foi notado porque, sem o dial novo pra comparar, um retângulo cinza
levemente deslocado passava despercebido. Auditando TODOS os `typeId` com `simulidePaint` (medindo o
`translate(...)` real de cada um via script), achei **19 suspeitos** por terem caixa calculada maior
que a declarada -- sinal AMBÍGUO por si só (folga de lead também aumenta a caixa, de propósito).
Renderizando cada um por completo, confirmei **17 com o bug de verdade** (corpo genuinamente
desconectado dos pinos: `active.diode`/`zener`, `active.opamp`/`comparator`, `active.volt_regulator`,
`outputs.led`/`led_rgb`/`seven_segment`/`dc_motor`/`stepper`/`incandescent_lamp`,
`connectors.socket`/`header`, `passive.resistor_dip`, `passive.potentiometer` -- e **2 falsos
positivos** (`switches.keypad`, `meters.probe`, offset já `0` -- caixa maior só por folga de lead
mesmo, não bug).

**Errata normativa (2026-07-13)**: a correção descrita originalmente abaixo como “estratégia A/B”
era um workaround por componente e está **revogada** pela convenção única da seção 13.1.1. Não se
deve deslocar manualmente `pin.x/y`, zerar `simulidePaint.bounds.x/y` nem medir um `translate(...)`
particular para fazer corpo e terminais coincidirem.

Pacotes portados de `paint()` usam `coordinateSpace: "simulide-local"`: primitivas, pinos, labels e
contatos permanecem nos `QPoint/QRect m_area` originais, e o renderer normaliza todos uma única vez
usando `simulidePaint.bounds`. A folga dos terminais é consequência geométrica desses mesmos pontos,
não uma margem criada por teste ou por offset. `outputs.led_matrix`, `outputs.led_bar` e
`active.analog_mux` foram migrados para esse contrato; no mux, somente `z`/`en` são estáticos e os
endereços/canais vêm exclusivamente de `dynamicLayout.pinGroups`, eliminando a declaração duplicada.

O texto anterior desta seção permanece útil apenas como diagnóstico histórico da dupla translação.
Qualquer dado ou teste que exija as antigas estratégias A/B deve ser corrigido para a seção 13.1.1,
e não perpetuar a exceção.

## 22. Bloco genérico de subcircuito (`subcircuits.external`): vínculo pelo clique direito + forma
placeholder própria (2026-07-10)

**Contexto**: o bloco genérico "aponta pra `.lssubcircuit` por caminho" (seção do épico de
subcircuito por caminho, `extension.ts::chooseSubcircuitFileCommand`) tinha 2 problemas antes de
qualquer arquivo ser vinculado a ele.

**Problema 1 -- vínculo só pelo painel de propriedades**: o item de menu de contexto
"Localizar arquivo do subcircuito..." (`main.ts`, `subcircuitRefMenuItems`) só aparecia quando
`component.subcircuitRef` já existia -- ou seja, só depois de UMA vinculação anterior (mesmo que
quebrada, arquivo movido/apagado). Um bloco `subcircuits.external` recém-colocado, NUNCA vinculado
(sem `subcircuitRef` nenhum ainda), não tinha esse campo -- a única forma de escolher o
`.lssubcircuit` era abrir o painel de propriedades e achar o editor `filePath` da propriedade
"Arquivo do subcircuito". `chooseSubcircuitFileCommand` (`extension.ts:296`) já tratava os dois casos
igual (comentário próprio: "serve pra escolha inicial e pra 'relink'"), então bastou alargar a
condição do item de menu:
```ts
const subcircuitRefMenuItems: ContextMenuItem[] = !isGroup && (component.subcircuitRef || component.typeId === "subcircuits.external")
  ? [...]
  : [];
```
Nenhuma mudança no handler foi necessária -- ele já troca `typeId`/pinos/`package` da instância pro
do arquivo escolhido (`parsed.typeId`/`parsed.package`, ver seção 21 do
`.spec/lasecsimul-subcircuits.spec` referenciada no próprio comentário do handler), então a forma
final já reflete o conteúdo do `.lssubcircuit` normalmente -- isso nunca esteve quebrado, só o ponto
de entrada pelo clique direito é que faltava pro caso "ainda não vinculado".

**Problema 2 -- forma placeholder parecia um resistor**: a entrada de catálogo `subcircuits.external`
(`project/schema/component-catalog.json`) não declara `package` nenhum (forma só existe DEPOIS de
vinculado, injetada como catálogo efêmero pelo handler acima). Sem `package`, a renderização caía no
`default:` genérico de `componentSymbolSvg` (`componentSymbols.ts`) -- `horizontalLeads(box,yMid)` +
um retângulo fino de 20px de altura -- a MESMA composição (leads + corpo retangular fino) que dá a
silhueta de um resistor sem zigzag, numa caixa `DEFAULT_BOX` de 70x40. Corrigido com um `case`
dedicado pro typeId, igual ao padrão já usado por `other.test_unit`/`other.dial`:
- `builtinComponentBox`: `case "subcircuits.external": return { width: 56, height: 40 }` (retângulo
  "de tamanho médio" -- não os 70x40 do fallback genérico nem os 32x9 de um resistor real).
- `componentSymbolSvg`: `case "subcircuits.external"` desenha só
  `<rect x="2" y="2" width="52" height="36" rx="4" class="symbol-stroke" fill="none"/>` -- SEM leads
  (não há pino nenhum, `pinCount:0` no catálogo até ser vinculado), cantos arredondados pra
  diferenciar visualmente de qualquer corpo de componente real.

**Verificação**: compilação limpa (`tsc` webview + test) e suíte completa (154 testes) sem regressão.
Script Node ad-hoc chamando `componentBox`/`componentSymbolSvg` diretamente confirmou a caixa
`{width:56,height:40}` e o SVG exato do retângulo (sem leads, sem parecer resistor). Sem GUI
disponível neste ambiente; recomenda-se colocar um bloco "Subcircuit" novo no esquemático real,
confirmar visualmente o retângulo neutro, clicar com o botão direito nele (sem nenhum arquivo
vinculado ainda) e confirmar que "Localizar arquivo do subcircuito..." aparece e, ao escolher um
`.lssubcircuit`, a forma muda pra do arquivo escolhido.

## 23. Autoria visual de ícone (Figura) + Package do SimulIDE dentro de "Abrir Subcircuito"
(2026-07-10)

**Superseded em 2026-07-16**: todo o mecanismo descrito nesta seção (`other.package`/
`other.package_pin`/`packageIconRole`, `subcircuitPackageAuthoring.ts`) foi removido e substituído
por um modo de editor dedicado ("Símbolo"/"Ícone", `schemaVersion 3`) — ver
`.spec/lasecsimul-subcircuits.spec` seção 22 pro modelo atual. Registro histórico mantido abaixo.

Detalhamento completo (histórico) em `.spec/lasecsimul-subcircuits.spec` seção 17 (conceito de `SubPackage`/
`PackagePin` do SimulIDE real, distinção Figura×Package, formato de persistência, vínculo
pino↔túnel, migração/compat, decisão de estender a arquitetura atual em vez de restaurar a antiga).
Resumo: dentro da MESMA cena já usada pra editar o circuito interno de um subcircuito (seção 16 do
spec de subcircuitos, nenhum editor/modo novo), passou a ser possível colocar `other.package`/
`other.package_pin` (typeIds já existentes no catálogo, antes código morto sem compilador nenhum) +
UMA instância de `graphics.image` marcada como ícone (`WebviewComponentModel.packageIconRole`) --
`extension/src/catalog/subcircuitPackageAuthoring.ts` (novo, `seedPackageAuthoringComponents`/
`compilePackageAuthoringComponents`, puro/testável sem DOM) materializa esses componentes ao abrir a
sessão e compila de volta pra `package`/`interface[]` ao salvar, validando ANTES de qualquer escrita
em disco (pinId/vínculo de túnel duplicado, Package/ícone duplicado = erro bloqueante; pino sem
túnel = excluído + aviso). Vínculo pino↔túnel agora usa `interface[].internalTunnelId` (id ESTÁVEL do
componente-túnel) como fonte de verdade -- `internalTunnel` (nome, exigido pelo Core) é re-derivado
automaticamente a cada save, corrigindo o problema de quebrar ao renomear um túnel. Pré-requisitos
implementados junto: `graphics.image` ganhou `width`/`height` reais e passou a renderizar a imagem de
verdade (antes só um glifo decorativo); o editor de propriedade `filePath` foi generalizado pra
qualquer campo (antes hard-coded só pro bloco genérico de subcircuito).

**Verificação**: compilação limpa e suíte completa (168 testes: 154 anteriores + 14 novos de
`subcircuitPackageAuthoring.test.ts`) sem regressão. Sem GUI disponível neste ambiente pra confirmar
drag visual de pino/menu "Vincular a túnel..."/copiar-colar pela UI real -- recomenda-se verificação
manual no VSCode real (ver seção 17.7 do spec de subcircuitos pro roteiro completo).

## 24. Reconstrução do sistema de fios/junções: grafo de topologia canônico, transação atômica no
Core, `connectors.junction` removido (2026-07-11)

Decisão de arquitetura tomada a partir de `docs/auditoria-tecnica-fios-simulide-2026-07-11.md`
(auditoria técnica comparando a implementação de fios/junções do LasecSimul contra o SimulIDE-dev
real) -- **Alternativa D** da auditoria (reconstruir a cadeia, por substituição controlada e
fatiada, sem adaptador legado permanente), executada por partes: kernel de topologia + transação
atômica no Core + índice espacial + persistência v2. Não implementado (deliberadamente fora de
escopo desta rodada, ver seção 24.5): Command Bus/FSM explícito e documento canônico headless como
camada separada -- o mesmo efeito (nenhuma mutação de modelo/Core até o gesto terminar, transação
atômica, sem resíduo em cancelamento) foi alcançado direto em `extension.ts`/`main.ts` sem introduzir
essa camada nova.

### 24.1 Junção deixa de ser um `IComponentModel` do Core

`connectors.junction` (`core/src/components/connectors/Junction.hpp`) foi **removido por inteiro** --
não existe mais fábrica registrada em `CoreApplication.cpp::registerBuiltinComponents`. Uma junção de
grau N (T, cruzamento com derivação, etc.) nunca mais chega ao Core como um componente de 1 pino; em
vez disso, ela é **achatada** numa árvore de N-1 arestas porta-a-porta ANTES de o Core ver qualquer
coisa -- o Core só enxerga `IComponentModel`s reais conectados diretamente entre si. Dois lugares
independentes fazem essa mesma transformação, cada um no seu domínio:

- **Projeto principal** (Webview/Extension host): `electricalEdgesForProject`
  (`extension/src/core/coreLifecycle.ts`) -- percorre `wires[]` + `topologyNodes[]`, decompõe em
  redes conexas por BFS, e para cada rede emite N-1 arestas entre os pinos de componente REAIS
  daquela rede (ignorando os nós de topologia como vértices de passagem). Usado por
  `rebuildCoreFromSchematicStateNow` (rebuild completo) -- o Core nunca recebe um nó de topologia
  como endpoint de `connectWire`.
- **Subcircuitos** (`.lssubcircuit`, Core): mesmo algoritmo, dentro do próprio Core, em
  `CoreApplication.cpp::registerSubcircuitFromManifestRich` -- decompõe `topologyNodeIds` (ver 24.4)
  + `def.wires` num grafo de adjacência, faz BFS por rede, emite N-1 arestas entre portas reais.
  Comentário no código: "Junction é sintaxe topológica do arquivo, nunca componente de simulação."

Consequência prática: `connectors.bus` (que reusava a classe `Junction` como implementação) passou a
usar `SimulidePassiveState` com o mesmo pino único -- mesmo comportamento elétrico (nó de
passagem), sem depender da classe removida.

### 24.2 Webview/host: `topologyNodes` substitui a junção-como-componente-oculto no caminho vivo

`WebviewProjectState`/`schematicState` ganhou um array paralelo, `topologyNodes: Array<{id, x, y}>`,
separado de `components`/`wires`. Um nó de topologia (T, cruzamento com derivação) vive **só** nesse
array -- nunca mais nasce como `WebviewComponentModel{typeId: "connectors.junction", hidden: true}`
no caminho de edição vivo. `JUNCTION_TYPE_ID` (`model.ts`) continua existindo só como forma de
projeção legada usada nas bordas (ver 24.6).

`extension/src/ui/webview/topologyDocument.ts` (novo) define um documento canônico
(`CanonicalTopologyDocument{revision, nodes[], conductors[]}`, endpoints
`{kind:"port",componentId,pinId}|{kind:"node",nodeId}`) com validação de invariantes
(`assertTopologyInvariants` -- nó/condutor duplicado, endpoint órfão, condutor de comprimento
topológico zero, vértices duplicados). **Não é o modelo de edição vivo** -- é usado só nas bordas
(persistência, seção 24.6; rebuild do Core) como ponte determinística entre o par
`components+wires+topologyNodes` (formato vivo) e o par `topology{nodes,conductors}` (formato
canônico/persistido). O comentário no código chama isso explicitamente de "ponte determinística
temporária".

### 24.3 IPC: transação atômica de fio + revisão otimista

Novo verbo `applyWireTopologyTransaction` (`CoreApplication.cpp`, handler `msg.type ==
"applyWireTopologyTransaction"`; `SimulationSession::applyWireTopologyTransaction`,
`SimulationSession.hpp/cpp`): aplica um lote de operações `connect`/`disconnect` como uma única
mutação observável. `baseRevision` precisa bater com `SimulationSession::wireTopologyRevision()`
(contador incrementado a cada `connectWire`/`disconnectWire`/transação bem-sucedida) -- divergência
lança `topology_revision_conflict` sem tocar em nada. Internamente, a transação faz uma cópia barata
do `Netlist` (staging), aplica cada operação, e se qualquer uma falhar restaura `Netlist`/
`m_topologyDirty`/`m_wireTopologyRevision` para o estado anterior por inteiro -- nunca deixa o Core
com metade das arestas aplicadas. `connectWire`/`disconnectWire` (verbos IPC já existentes) passaram
a devolver `topologyRevision` na resposta também, e resolvem pino por id exato primeiro, com
fallback posicional `pin-N` (`resolveSlot` em `SimulationSession::connectWire`) para arquivos de
autoria antigos/packages genéricos.

Do lado da Extension: `CoreClient.applyWireTopologyTransaction` (`ipc/CoreClient.ts`) guarda
`wireTopologyRevision` localmente, atualizado a cada resposta; `pushWireTopologyTransaction`
(`coreLifecycle.ts`) resolve `componentId` webview -> `instanceId` Core e chama o verbo. Usado em
`syncProjectSnapshotToCore` (`extension.ts`) quando só endpoints de fio mudaram (sem nó de topologia
envolvido) -- substitui o antigo padrão de mandar `connectWire`/`disconnectWire` um a um sem garantia
de atomicidade entre eles.

### 24.4 Verbos antigos removidos: gesto vira transação, split para de ser commitado cedo

`requestConnectPins`/`requestConnectPinToWire` (mensagens Webview->Host) foram **removidos**, junto
com `wireConnections.ts` (arquivo inteiro deletado -- `buildPinToPinWire`/`buildPinToWireConnection`).
Substituídos por um único verbo, `requestConnectEndpoints`, carregando `baseRevision`
(`state.schematicState.topologyRevision`) -- se o host detecta que o cliente trabalhou sobre uma
revisão desatualizada, republica o estado canônico via `syncState` completo em vez de tentar mesclar
por heurística (`extension.ts`, handler `"requestConnectEndpoints"`). A computação pura de split/
reuso de junção existente vive em `connectEndpointToNode` (`wireTopology.ts`), que devolve
`newNodes`/`newWires`/`replacedWireIds` -- o host aplica o resultado ao `schematicState`, dispara
`queueCoreRebuild()` uma vez, e só publica a `syncState` nova depois do Core confirmar (rollback pro
estado anterior se o rebuild falhar).

**Bug histórico corrigido (o mais citado na auditoria)**: `requestStartWireFromWire` (iniciar uma
derivação clicando no MEIO de um fio já existente) deixou de fazer split/criar junção/tocar no Core
nesse momento -- é um DRAFT PURO (`pendingConnection: {kind:"wire", wireId, point}`), sem nenhuma
mutação de modelo. Esc, botão direito ou trocar de ferramenta simplesmente limpam
`pendingConnection` sem deixar nenhum resíduo (nem no Core, nem em `components`/`wires`). O split/
criação de nó só acontece quando o gesto de fato termina em outro ponto, dentro do mesmo
`requestConnectEndpoints` transacional acima.

### 24.5 `Netlist::rebuildTopology`: full-rebuild continua sendo o único oracle (decisão revertida)

Uma otimização de cache incremental de conectividade dentro de `Netlist` (union-find comprimido
reaproveitado entre chamadas, com invalidação por slot dirty) foi implementada, testada
(diferencial de 250 mutações aleatórias contra um `Netlist` de referência, mais um teste dedicado de
contagem de slots revisitados) e **revertida no mesmo dia** -- risco de correção desproporcional ao
ganho: união via union-find não é uma operação desfazível (remover uma aresta pode precisar separar
nós que estavam fundidos; renomear um túnel idem), e um cache incremental hand-rolled é uma
superfície de bug sutil bem maior que o benefício, considerando que:

- `rebuildTopology()` já só roda quando `m_topologyDirty` está setado
  (`SimulationSession::rebuildTopologyIfNeeded`, `SimulationSession.cpp:450`) -- ou seja, "um rebuild
  por lote de edição" já é garantido de graça pelo gate existente, com ou sem cache incremental
  dentro do `Netlist`; o cache só ajudaria no caso estreito de múltiplos ciclos dirty consecutivos
  com pouca mudança entre eles.
- Componentes ativos/não-lineares podem precisar de reestabilização completa depois de qualquer
  mudança estrutural -- `core/test/diode_test.cpp` ganhou um teste de regressão específico (settle
  de uma rede com diodo depois de um split/restauração via `applyWireTopologyTransaction`) que
  travava com o cache incremental.

`Netlist::rebuildTopology` (`core/src/simulation/Netlist.hpp`) permanece um union-find puro,
recalculado do zero a cada chamada -- documentado no comentário de classe como "sempre do zero --
nunca incremental" com a justificativa acima.

O reaproveitamento seletivo posterior é descrito em 25.5. Ele não altera este contrato: o grafo é
sempre reconstruído integralmente; somente matrizes de ilhas lineares comprovadamente idênticas
podem sobreviver, e apenas depois de uma adição pura de aresta.

### 24.6 Persistência `.lsproj` v2: `topology{revision,nodes,conductors}` substitui `wires[]`

`ProjectTypes.ts::LS_PROJ_SCHEMA_VERSION` subiu de 1 para 2. `ProjectDocument.topology`
(`ProjectTopology{revision, nodes[], conductors[]}`, mesmo formato do `CanonicalTopologyDocument` da
seção 24.2) é agora **obrigatório** e é a fonte de verdade gravada em disco -- `ProjectSerializer.save`
não grava mais `wires[]` nem `visual.wires`/`visual.components` (só `visual.viewport`).
`ProjectSerializer.load` valida `topology` (`validateTopology`, endpoints tipados, nó/condutor
duplicado, referência a componente/nó inexistente) e deriva `wires[]` em memória só como projeção de
compatibilidade interna (não persistida). **Sem adaptador de leitura pra `schemaVersion` 1** -- um
`.lsproj` antigo sem bloco `topology` falha ao carregar (consistente com a política do projeto de
não manter compat retroativa preventiva, ver seção sobre isso mais adiante neste documento).
`project/schema/lsproj.schema.json` foi atualizado pra `schemaVersion: {const: 2}` + bloco `topology`
+ `visual` só com `viewport` obrigatório (documentação/referência -- nada no código valida
runtime contra este arquivo hoje, `ProjectSerializer.ts` tem sua própria validação manual).

O mesmo formato `topology{...}` substitui `wires[]` dentro de `.lssubcircuit` também --
`.spec/lasecsimul-subcircuits.spec` seção 19 tem o contrato completo (parsing no Core, achatamento de
junção, e uma regressão real encontrada/corrigida num parser de teste duplicado).

### 24.7 Índice espacial de fios (`WireSpatialIndex`)

`extension/src/ui/webview/wireSpatialIndex.ts` (novo) -- spatial hash mutável (`cellSize` padrão 64),
`upsertWire`/`removeWire` O(células tocadas), `queryPoint`/`queryConnectionPoints` idem. Integrado em
`wireTopology.ts::findAtPosition`/`buildWireSpatialIndex` (índice opcional -- sem ele, cai pro scan
linear anterior, usado só nos testes puros que não montam um índice) e mantido incrementalmente no
`render()` de `main.ts` (`wireSpatialIndex.upsertWire` só quando a polilinha de um fio muda de
verdade, comparado por assinatura de pontos) -- usado tanto pro hit-test de clique quanto por
`maybeAutoJunctionForDraggedComponents` (consulta `queryPoint` pra detectar overlap pino-sobre-fio
depois de arrastar um componente).

### 24.8 Regressão encontrada e corrigida: parser de teste duplicado não migrado

`core/test/esp32_devkitc_subcircuit_test.cpp` mantém propositalmente um `parseLssubJson` PRÓPRIO,
independente de `CoreApplication.cpp` (comentário no código: "mesmo mapeamento de campos... mantido
em sincronia manualmente"). Ao migrar `subcircuits/esp32_devkitc_v4.lssubcircuit` pro formato
`topology{...}` (seção 24.6), esse parser de teste NÃO foi atualizado -- continuou lendo
`manifest["wires"]`, chave que o arquivo migrado não tem mais, resultando em **zero fios**
registrados silenciosamente (só os nós unidos por `connectors.tunnel`, que não depende de `wires[]`,
sobreviviam). Sintoma: `ctest` reportando `esp32_devkitc_subcircuit` falho, com várias tensões de
rede (3V3/5V/EN) caindo pra 0V por sistema singular. Corrigido replicando a mesma branch
`canonicalTopology` de `CoreApplication.cpp` neste parser de teste. Um segundo problema, encontrado
na mesma investigação e não relacionado à migração: o teste só dava 5 iterações de
`session.settleStep()` antes de ler tensão -- suficiente com a topologia antiga (efetivamente vazia),
insuficiente para o circuito real totalmente conectado; aumentado para 200 (mesma ordem de grandeza
de `diode_test.cpp::settleWithin`). Lição: qualquer teste que reimplemente parsing de manifesto por
razões de isolamento precisa ser tratado como uma segunda fonte de verdade que PODE divergir -- exatamente
o débito "regras diferentes entre serializers/loaders" que a auditoria já apontava (seção de débitos
técnicos, `docs/auditoria-tecnica-fios-simulide-2026-07-11.md`), reproduzido de novo dentro da própria
correção.

## 25. Roteamento de edição de fio pela transação atômica + FSM leve + validação de invariante em
toda edição (2026-07-11, plano em `docs/27-analise-critica-fios-vs-auditoria-2026-07-11.md`)

Continuação direta da seção 24 -- a análise crítica em `docs/27-...` achou que
`applyWireTopologyTransaction` (24.3) ficava **inatingível na prática** assim que um projeto tinha
qualquer nó de topologia, porque `syncProjectSnapshotToCore`/`requestConnectEndpoints` sempre caíam
em `queueCoreRebuild()` (full teardown+recreate sequencial, O(componentes+fios) round-trips de IPC)
pra esse caso -- o caminho DEFAULT de qualquer edição de fio num circuito real, não uma exceção. Esta
seção fecha essa lacuna.

### 25.1 EX-F: diff de arestas achatadas substitui full-rebuild como caminho default

`electricalEdgesForProject`/`diffElectricalEdges` (movidos de `coreLifecycle.ts` pra
`wireTopology.ts` -- são funções puras, cabem na "fonte única de verdade" que o arquivo já é;
`coreLifecycle.ts` reexporta pra não quebrar import site nenhum) -- o diff compara duas listas JÁ
ACHATADAS (saída de `electricalEdgesForProject`, antes/depois) por identidade de PAR DE PINOS REAIS
(chave `componentId::pinId`, ordem-independente), nunca por id sintético (`electrical-N` muda de
índice a cada chamada). Como o achatamento é determinístico por rede não tocada, o diff fica
naturalmente restrito à(s) rede(s) que a edição de fato afetou -- **não precisa de um algoritmo
incremental à parte**, só recomputar a árvore inteira duas vezes (barato, é um BFS em memória) e
comparar os dois conjuntos resultantes.

Roteamento atualizado:
- `syncProjectSnapshotToCore` (`extension.ts`): a antiga condição "há nó de topologia E (geometria OU
  componente mudou) → `queueCoreRebuild()`" virou duas condições separadas -- `componentSetChanged`
  continua indo pro rebuild completo (registrar/desregistrar instância Core exige isso mesmo);
  só-topologia-mudou agora usa o diff achatado + `pushWireTopologyTransaction`.
- `requestConnectEndpoints`: nunca muda o CONJUNTO de componentes (só fios/nós) -- sempre usa o diff
  achatado agora; `queueCoreRebuild()` fica reservado pra quando a transação é rejeitada (conflito de
  revisão etc.), não mais o caminho feliz.
- `requestRemoveWire`/`requestRemoveComponent`: mesmo diff achatado. Para remoção de COMPONENTE, o
  "antes" achatado é computado sobre `afterRemoval.wires` (já excluindo os fios que tocavam o
  componente removido) -- nunca sobre a lista completa anterior, porque o Core já desconectou esses
  fios sozinho dentro de `Netlist::removeComponent` (`pushRemoveToCore` já rodou); incluir esses
  endpoints no diff falharia a resolver `coreInstanceIdByComponentId` (mapeamento já apagado) e
  derrubaria a transação inteira à toa.
- `pushWireTopologyTransaction` (`coreLifecycle.ts`) passou a capturar qualquer exceção internamente
  (inclusive `topology_revision_conflict`) e devolver `false` -- nenhum chamador precisa mais de
  try/catch próprio pra tratar rejeição de transação; todos caem no mesmo padrão "`if (!applied) await
  queueCoreRebuild()`".

**Correção não é garantida ser mínima, só é garantida ser correta**: se a inserção de uma porta nova
muda qual porta é escolhida como raiz da estrela do achatamento, o diff pode incluir mais
`connect`/`disconnect` do que o estritamente necessário (a rede inteira "reconecta" em vez de só o
ramo novo) -- mas o resultado final é sempre eletricamente equivalente. Testado explicitamente:
`wireTopology.test.ts` ("root da estrela muda de porta -- diff ainda cobre a rede inteira
corretamente"), que reconstrói a rede a partir do diff e confere via union-find que nenhuma
conectividade se perde, mesmo no pior caso.

**Testes de regressão** (`wireTopology.test.ts`, 5 casos novos): sem nó (1 aresta por fio), T de 3
ramos achata em N-1 sem nunca referenciar o nó, adicionar um ramo gera só 1 `connect` e não toca rede
não relacionada, colapso de nó grau-2 em fio direto não gera operação nenhuma (já é a mesma aresta),
e o caso de troca de raiz acima.

### 25.2 FSM leve: ferramentas de fio e posicionamento de componente nunca mais coexistem

Achado real na análise (`docs/27-...`, seção "Análise da FSM"): `enterPlacementMode()` não verificava
`state.pendingConnection`, e o handler de Esc tinha um `return` antecipado que, com os dois estados
combinados, só cancelava um dos dois -- exigia um SEGUNDO Esc. Investigação mais funda durante a
correção achou mais 3 pontos com a MESMA classe de bug (clique em alça de canto de fio, clique em
alça de segmento de fio, clique em pino -- todos os três chamam `stopPropagation()`, então nunca
delegavam a decisão pro handler de fundo do canvas que já tratava `placingTypeId`).

Correção: dois funis únicos de entrada (`extension/src/ui/webview/main.ts`) --
`beginWireDraft(origin)` (cancela posicionamento de componente ativo antes de armar um draft de fio)
e `enterPlacementMode(typeId)` (cancela draft de fio ativo antes de entrar em posicionamento) -- e um
funil único de saída, `cancelActiveTool()` (chamado por Esc, incondicional, sem `return` antecipado
escondendo o segundo caso). Os 4 pontos de entrada adicionais (clique em pino, canto, segmento,
botão-direito-no-canvas) ganharam a mesma guarda (`if (placingTypeId) return;` logo após
`stopPropagation()` -- clique é descartado, nunca inicia derivação por baixo da ferramenta ativa).

**Escopo deliberadamente contido**: não virou uma FSM formal genérica cobrindo TAMBÉM marquee-select
e arrasto de segmento/canto -- esses dois já são estruturalmente protegidos por `pointerCapture`
(exclusivos por construção dentro de um único gesto contínuo de ponteiro, não podem vazar pra outro
modo entre cliques discretos como `pendingConnection`/`placingTypeId` podiam). A correção mira
exatamente a classe de bug encontrada (estados que persistem ENTRE cliques discretos), não todo
estado de interação do editor.

### 25.3 Validação de invariante antes de commitar (não só em save/load)

`requestConnectEndpoints`/`requestRemoveWire`/`requestRemoveComponent` (`extension.ts`) passaram a
chamar `canonicalTopologyFromLegacy(...)` (que já roda `assertTopologyInvariants` como efeito
colateral, `topologyDocument.ts`) sobre o resultado ANTES de commitar em `state.schematicState` --
descarta o documento canônico resultante, só a validação importa aqui. Duas políticas diferentes
deliberadas:
- `requestConnectEndpoints`: falha BLOQUEIA a mutação (`return` antes de tocar `state.schematicState`)
  -- nada irreversível aconteceu ainda no Core nesse ponto, seguro rejeitar.
- `requestRemoveWire`/`requestRemoveComponent`: falha só AVISA (`reportCoreWarning`, sem `return`) --
  pra remoção de componente, o Core já processou `pushRemoveToCore` antes desse ponto (irreversível);
  bloquear a atualização do lado Webview deixaria os dois lados mais divergentes, não menos.

### 25.4 Consolidação parcial (não a migração completa pro modelo canônico vivo)

A análise recomendava (seção "Recomendação arquitetural") promover `CanonicalTopologyDocument` a
modelo vivo por inteiro -- `WebviewWireModel.from/to` virando `CanonicalEndpoint`
(`{kind:"port"|"node",...}`) em vez de `{componentId,pinId}` plano, e `state.wires`/`state.topologyNodes`
virando um único `state.topology`. Avaliado nesta rodada e **conscientemente não executado por
inteiro**: essa retipagem tocaria centenas de call sites em `main.ts` (render, hit-test, drag,
undo/redo) que hoje assumem endpoint plano, sem nenhuma cobertura de teste de GUI possível neste
ambiente pra confirmar visualmente que nada quebrou -- risco desproporcional ao ganho, que é de
manutenção futura (a duplicação hoje é gerenciável, não um bug ativo), não de correção presente.

O que FOI feito desta frente, com risco baixo e valor real e verificável: consolidado
`main.ts::wirePolylinePoints` (chamado em TODO `render()`, hot path) pra delegar em
`wireTopology.ts::pinScenePosition` em vez de reimplementar a distinção porta-vs-nó pela terceira vez
no projeto (as outras duas cópias já reduzidas a `Set.has()` de uma linha em
`electricalEdgesForProject`/`voltageProbesForProject`, risco de divergência bem menor que uma função
inteira duplicada). `topologyNodes` continua um array paralelo a `wires`; `topologyDocument.ts`
continua sendo ponte de borda -- ambos permanecem trabalho futuro caso uma feature nova (barramentos
tipados, rótulo de rede) force a mão, não uma dívida bloqueante hoje.

**Verificação**: suíte completa da Extension (223 casos, incluindo os 5 novos de 25.1) e suíte
completa do Core (36/36) sem regressão. Sem GUI disponível neste ambiente pra confirmar
interativamente os 6 pontos de FSM corrigidos (25.2) nem o comportamento visual do roteamento novo
(25.1) -- ambos verificados por rastreamento direto de código + testes puros onde o código é
testável; recomenda-se sessão manual no VSCode real cobrindo exatamente os 6 cenários de estado
combinado desta seção antes de considerar 25.2 encerrado.

**SUPERSEDIDO pela seção 25.6**: a decisão de escopo contido acima (não retipar
`WebviewWireModel.from/to`, não unificar `state.wires`/`state.topologyNodes`) foi revisada na mesma
sessão seguinte -- decisão explícita de que tamanho de mudança não é critério negativo por si só, só
qualidade técnica/funcional do resultado. A migração completa foi feita; ver 25.6.

### 25.5 Core: `reuseUnaffectedCircuitGroups` -- não marca todo componente vivo como dirty a cada
rebuild de topologia (2026-07-11)

Lacuna deixada explícita em 25.1 como conhecida, não escondida: `rebuildTopologyIfNeeded()`
(`SimulationSession.cpp`) reconstruía a topologia inteira do zero a cada mudança (correto, união não é
desfazível -- ver `Netlist.hpp`), mas depois marcava **todo componente vivo** como dirty,
independente de estar ou não na rede afetada -- efeito prático: editar um fio em QUALQUER lugar do
circuito re-estampava (e refatorava, se a admitância mudasse) TODOS os `CircuitGroup`, mesmo os de
redes eletricamente desconexas e intocadas. Maior retorno/menor risco que sobrava do plano original
de `docs/27-...`.

**Política de segurança (revisada em 2026-07-12)**: o reuso só é elegível quando a revisão
pendente contém exclusivamente adições de fio. Deleção, split, mudança de túnel, pinos,
componente ou propriedade topológica executa rebuild + restamp global. Grupos que contenham qualquer
`isNonlinear()` nunca são reaproveitados. O flag `m_topologyReuseSafe` acumula essa classificação
durante o lote e também participa do rollback transacional.

**Mecanismo**: `reuseUnaffectedCircuitGroups(previous, previousNodeVoltages)`, chamada de dentro de
`rebuildTopologyIfNeeded()` logo após o rebuild, compara a topologia ANTIGA (capturada por
`std::move` antes do rebuild) com a NOVA por **assinatura de grupo** (conjunto ordenado de
`componentIndex` vivos que caem em cada grupo). Grupo cujo conjunto de componentes bate dos dois
lados só é reaproveitado se, ALÉM disso, todo pino de todo membro cair no MESMO `localIndex` (linha/
coluna da matriz) nos dois lados -- conjunto de componentes igual não basta (A-B + B-C virar A-B +
B-C + A-C encolhe de 3 nós pra 2 sem o conjunto mudar, mas a fiação real mudou). Só quando as duas
condições batem, os vetores de índices globais de nó também precisam ser idênticos; então o
`CircuitGroup` antigo (com toda a estampa acumulada e a fatoração LU em cache) é
literalmente `std::move`ido pro slot do grupo novo, e SÓ os componentes de grupos NÃO reaproveitados
entram no `dirtySet()` do `Scheduler`.

Índices globais não são presumidos estáveis: uma fusão anterior na ordem de slots pode deslocar a
numeração densa de redes posteriores. Por isso `nodeIndices()` antigo e novo são comparados por
igualdade exata; qualquer deslocamento cai no restamp seguro.

**Bug real encontrado e corrigido durante a verificação** (não presumir "compilou, deve estar certo"
-- ver `[[feedback_review_build_and_test_before_reporting]]`): a primeira versão reaproveitava o
`CircuitGroup` corretamente, mas `rebuildTopologyIfNeeded()` continuava fazendo
`m_nodeVoltages.assign(novoTamanho, 0.0)` incondicionalmente pra TODO o array a cada rebuild.
`MnaSolver::solve()` pula grupo não-dirty (`if (!group.dirty()) continue;`, `MnaSolver.hpp`) -- um
grupo reaproveitado nunca é dirty (suas flags já estavam limpas desde a última solve antes do
rebuild), então nunca seria resolvido de novo, e sua leitura de tensão ficava travada em 0.0 pra
sempre (até a rede voltar a ficar dirty por outro motivo). Sintoma: `circuit_group_reuse_test`
(abaixo) falhava JÁ na primeira rodada -- ilha elétrica nunca tocada caía de 5V pra 0V assim que
QUALQUER outra rede do circuito era editada. Corrigido capturando
`previousNodeVoltages = std::move(m_nodeVoltages)` antes do reset e, dentro de
`reuseUnaffectedCircuitGroups`, copiando `previousNodeVoltages[nodeIndex]` pra
`m_nodeVoltages[nodeIndex]` de cada nó do grupo reaproveitado -- os índices são os mesmos dos dois
lados (parágrafo acima), então a cópia é direta, sem remapeamento.

**Teste de regressão**: `core/test/circuit_group_reuse_test.cpp` (novo, registrado em
`CMakeLists.txt` como `circuit_group_reuse`) -- duas ilhas elétricas independentes (divisores de
tensão), ilha 1 nunca tocada depois do settle inicial, ilha 2 editada 20 vezes seguidas (liga/desliga
um resistor em T). Cada rodada confere BIT-A-BIT que a tensão da ilha 1 não mudou (prova que
reaproveitamento não vaza estampa velha nem perde a tensão já resolvida) e que a ilha 2 continua
fisicamente correta pra topologia atual (prova que a rede que DEVERIA ser re-estampada foi).

**Verificação**: suíte completa do Core, 37/37 (36 anteriores + `circuit_group_reuse`).

### 25.6 Fase C completa: `CanonicalEndpoint` promovido a modelo vivo único (2026-07-11)

Revisão da decisão de escopo contido em 25.4 (marcada como superseded acima) -- instrução explícita
de que tamanho de refatoração não é critério negativo por si só, só qualidade técnica/funcional do
resultado. Migração completa executada nesta sessão:

- `WebviewWireModel.from`/`.to`: de `{componentId, pinId}` plano pra `CanonicalEndpoint`
  (`{kind:"port", componentId, pinId} | {kind:"node", nodeId}`, `model.ts`) -- elimina a suposição
  implícita de que nó de topologia e componente real compartilhavam o mesmo espaço de string por
  convenção (`componentId` de um endpoint-nó era na verdade um `nodeId`).
- `WebviewProjectState`: campos separados `wires[]`/`topologyNodes?[]`/`topologyRevision?` viram um
  único `topology: CanonicalTopologyDocument` (`{revision, nodes: TopologyNode[], conductors:
  WebviewWireModel[]}`) -- fonte única de verdade, viva E persistida (não existe mais um formato de
  runtime e outro de disco).
- Helpers centralizados em `model.ts` (`endpointId`, `endpointPinId`, `portEndpoint`, `nodeEndpoint`,
  `remapEndpoint`) substituem acesso direto a `.componentId`/`.pinId` em toda a base -- ponto único
  de verdade sobre "qual é o id/pino do outro lado deste endpoint", nunca reimplementado por chamador.
- `topologyDocument.ts`: as funções-ponte `canonicalTopologyFromLegacy`/`legacyTopologyFromCanonical`
  foram REMOVIDAS por inteiro (não fazem mais sentido -- não existe mais um lado "legado" separado
  pra converter). Arquivo ficou só com `assertTopologyInvariants`, operando nativamente sobre os tipos
  de `model.ts`.
- `wireTopology.ts` inteiro (todas as funções: `pinScenePosition`, `wirePolylinePoints`,
  `findExistingJunctionAt`, `findAtPosition`, `splitSegmentAtPoint`, `connectEndpointToNode`,
  `removeOrphanNodes`, `normalizeWireGeometry`, `rebuildElectricalNet`, `electricalEdgesForProject`,
  `diffElectricalEdges`) reescrito pra operar sobre `TopologyNode[]`/`CanonicalEndpoint` diretamente
  -- elimina todo tratamento de `JUNCTION_TYPE_ID` como se fosse um componente disfarçado dentro
  dessas funções (a distinção porta-vs-nó agora é o `kind` do endpoint, não uma checagem de typeId).
- `extension.ts::normalizeRuntimeTopology` (função-ponte que sintetizava componentes
  `connectors.junction` a partir de `topologyNodes[]` pros 3 call sites que ainda esperavam o formato
  antigo) foi DELETADA -- os 3 call sites chamam `normalizeWireGeometry` direto.
- `projectCommands.ts::importProjectCommand`: bug PRÉ-EXISTENTE encontrado e corrigido durante a
  migração -- nós de topologia importados eram silenciosamente descartados (só componentes/fios
  passavam por remapeamento de id); agora `remapEndpoint` também é aplicado aos nós.
- Todos os arquivos de teste (`topologyDocument.test.ts`, `wireTopology.test.ts` -- 34 casos,
  `junctionComponent()` substituído por `topologyNode()`+`nodeWire()`/`portWire()` --,
  `simulideSceneTranslator.test.ts`) reescritos pro novo shape.

**Verificação**: os 3 tsconfigs (`tsconfig.json`/`tsconfig.webview.json`/`tsconfig.test.json`)
compilam sem erro; suíte completa da Extension, 214/214 casos, 0 falhas.

### 25.7 Fase E: varredura de código morto -- conclusão é que não sobrou nada pra remover (2026-07-11)

Varredura final de referências a `JUNCTION_TYPE_ID` fora de teste, pra confirmar que a migração de
25.6 não deixou nenhum tratamento especial de "junção como componente" sobrevivendo por inércia.
Resultado, arquivo por arquivo -- todos os 6 usos são LEGÍTIMOS, nenhum removido:

- `subcircuitInternals.ts`/`extension.ts` (parsing de manifesto de subcircuito/device): NÃO é
  compat especulativa -- existem arquivos REAIS no repositório hoje ainda no formato antigo
  (`subcircuits/esp32_wroom32.lssubcircuit` usa `wires[]` direto, não `topology.conductors[]`; a
  grande maioria de `devices/*.lsdevice` idem) que o parser do Core (`parseLssubJson`,
  `esp32_devkitc_subcircuit_test.cpp`, mesma lógica de `CoreApplication.cpp`) também aceita via
  fallback deliberado, não removido. Testado e exercitado de verdade pelo teste
  `esp32_devkitc_subcircuit` (carrega os DOIS arquivos, migrado e não-migrado, no mesmo run).
- `extension.ts:677` (`requestAddComponent`): defesa em profundidade documentada em comentário --
  junção só nasce de split de fio real, nunca de mensagem IPC direta; guarda contra mensagem
  malformada/webview desatualizada, não relacionado a formato de arquivo.
- `componentSymbols.ts` (`builtinComponentBox`/anchor): `connectors.junction` continua um typeId de
  catálogo válido e registrado (`hidden:true`, filtrado da paleta, não deletado do sistema) -- a
  entrada de tabela de 1 linha devolvendo caixa 0x0 é consistente com isso, não é resíduo morto.

Nenhuma remoção feita nesta seção -- ver `[[feedback_no_preemptive_compat_during_production_phase]]`
antes de reconsiderar: a distinção que importa é "arquivo real existente hoje" vs. "formato
hipotético futuro", não "código que menciona um formato antigo" por si só.

### 25.8 Bug pré-existente corrigido durante a verificação: pull-up do EN do ESP32 DevKitC não
tocava 3V3 (2026-07-11)

Achado ao investigar por que `esp32_devkitc_subcircuit_test` falhava mesmo depois de 25.5/25.6 --
confirmado por instrumentação temporária que o reaproveitamento de `CircuitGroup` (25.5) NUNCA
disparava neste teste (é o primeiro rebuild da sessão, `previous` sempre vazio), então a causa era
outra: bug de fiação real em `subcircuits/esp32_devkitc_v4.lssubcircuit`, não uma regressão desta
sessão.

`pullup_en` (resistor de 10k) tinha o pino 1 ligado ao MESMO nó de `mcu1.RST`/`button_en` (em vez de
à trilha 3V3) e o pino 2 ligado direto ao pino exposto `EN` -- ou seja, o resistor ficava EM SÉRIE
dentro da própria rede EN/RST, sem nenhuma ponta tocando 3.3V; o "pull-up" não puxava pra lugar
nenhum. Comparado contra o padrão do circuito irmão (BOOT/GPIO0, com fiação correta:
`pullup_boot.pin-1` -- 3V3, `pullup_boot.pin-2` -- {GPIO0, button}) pra derivar a topologia certa.
Corrigido trocando o destino de 2 condutores no `.lssubcircuit`: `pullup_en.pin-1` agora liga na
junção 3V3 (mesma junção de `tunnel_3v3`/`pullup_boot.pin-1`), e `tunnel_EN` ganhou um condutor extra
direto pra junção RST/button (em vez de só tocar `pullup_en.pin-2`) -- resultado:
3V3 -[pullup_en]- {EN, RST, button_en} -[button_en]- GND, mesmo padrão do BOOT.

**Verificação**: `esp32_devkitc_subcircuit_test` (assert `nodeVoltageOfPin(EN) > 3.0` com botão
solto) passa; suíte completa do Core, 37/37, 0 falhas.

### 25.9 Reestruturação da interação de fios/junções: motor de hit-test unificado, junção
interativa, mover-em-grupo generalizado (2026-07-12)

Pedido explícito do usuário, com autorização de mudança disruptiva ("não me preocupo em mudanças
robustas desde que o ganho seja grande") e 4 queixas concretas de uso real: (1) clicar no meio de um
fio pra iniciar uma derivação não funcionava de forma confiável, (2) a marca visual da junção era
grande e inadequada, (3) impossível conectar corretamente um 4º+ fio no mesmo ponto, (4) selecionar
um componente + um fio e movê-los juntos não funcionava fora do caso de um único canto/segmento já
selecionado. Investigação encontrou uma causa raiz comum em `main.ts`: interação de fio nunca usava
o motor de hit-test unificado que `wireTopology.ts` já tinha (pronto e testado, mas código morto --
`findAtPosition`/`buildWireSpatialIndex` sem NENHUM call site fora dos próprios testes), e em vez
disso cada tipo de alça (pino/segmento/canto) reimplementava sua própria cópia quase idêntica da
lógica de "iniciar vs. terminar uma derivação". Junção especificamente nunca teve handler nenhum
(`.junction-dot` era `pointer-events:none`) -- não havia COMO clicar numa junção existente, só por
acidente via a borda de um segmento adjacente.

**25.9.1 Junção virou elemento SVG interativo real.** `renderJunction` (antes um `<div>` decorativo
solto em `canvasContent`) agora é um `<g>` dentro do MESMO `wire-layer` SVG que pino/segmento/canto,
com dois círculos concêntricos: um alvo de clique/arrasto maior e invisível (`r=8`,
`.wire-layer__junction-hit`) e a marca visual pequena por cima (`r=2.5`,
`.wire-layer__junction-dot`, `pointer-events:none` -- todo o hit-test fica no círculo de baixo). Isso
resolve (2) diretamente (marca pequena, fiel ao SimulIDE) e (3): clique na junção passa pelo MESMO
`handleWireGestureClick` de pino/segmento/canto usando `{kind:"wire", wireId: <qualquer fio que já
toca a junção>, point: <posição do nó>}` -- **sem precisar de um `kind:"junction"` novo no
protocolo**: como o ponto clicado já É uma extremidade real daquele fio (a própria junção),
`splitSegmentAtPoint` cai no caminho "ponto já é extremidade, não divide" e `connectEndpointToNode`
resolve via `findExistingJunctionAt` pro MESMO nó -- reaproveita 100% da máquina já existente e
testada (`.spec` seção 24), zero mudança de modelo/mensagem IPC. Junção também ganhou arrasto (mover
`node.position` direto -- mais simples que canto/segmento, os fios tocando o nó se re-roteiam
sozinhos via `wirePolylinePoints`/`buildOrthogonalPath`, igual a mover um componente) e menu de
contexto (seleciona os fios tocando + `deleteSelectedItems`).

**25.9.2 `handleWireGestureClick` consolida pino/segmento/canto/junção numa função só.** Único
ponto de decisão "clicar num alvo de conexão já existente" -- início de derivação é SEMPRE local
(`beginWireDraft`, nunca mais um round-trip pela Extension só pra armar `pendingConnection`, que é
estado 100% transitório da Webview); terminar SEMPRE passa por `requestConnectEndpoints` no Core (o
único momento em que a topologia de verdade muda). O verbo IPC `requestStartWireFromWire`
(round-trip que servia SÓ pra armar o draft, sem tocar no Core -- redundante com o padrão já usado
pro pino) foi removido por inteiro (`messages.ts`, `extension.ts`, `main.ts`) -- resolve (1): a causa
raiz mais provável do "clique não inicia derivação" era a combinação de um round-trip assíncrono
desnecessário com uma seleção `render()`-síncrona disparada dentro do PRÓPRIO `pointerdown` que
recriava o DOM do alvo antes do `click` nativo do browser ter chance de disparar nele.

**25.9.3 Mover-em-grupo generalizado pra `selectedWireIds` inteiro.** `currentGroupWireSelection`/
`applyGroupWireDelta` (pré-existente) só cobriam UM canto ou segmento individualmente selecionado
acompanhando um arrasto de componente -- não cobria fio inteiro selecionado via marquee. Nova dupla
`computeGroupMoveWireTargets`/`applyGroupMoveWireDelta` (esta última reaproveitando o mesmo nome de
função de uma versão anterior mais restrita, agora generalizada) cobre TODA a seleção múltipla de
fios: cada fio selecionado translada seus pontos internos pelo delta; um nó de topologia só
translada junto se `movableTopologyNodeIds` (`wireTopology.ts`, nova função pura, testada) confirmar
que TODOS os fios que o tocam também estão selecionados -- senão um T com só um ramo selecionado
rasgaria os outros dois. Aplicado simetricamente nos 4 pontos de entrada de arrasto (componente,
canto, segmento, junção) -- resolve (4): arrastar QUALQUER elemento cuja seleção inclua
componente(s) e/ou fio(s) move tudo junto, não só o caso estreito de antes.

**Verificação**: os 3 tsconfigs compilam sem erro; suíte completa da Extension, 218/218 (4 novos
casos de `movableTopologyNodeIds`), 0 falhas. Sem GUI disponível neste ambiente pra confirmar
interativamente os 4 gestos corrigidos -- verificado por rastreamento direto de código (incluindo
correção de um bug real encontrado durante a própria implementação: a marca visual da junção não
acompanhava seu próprio arrasto, só os fios tocando ela) + testes puros onde o código é testável;
recomenda-se sessão manual no VSCode real cobrindo os 4 cenários desta seção (derivar do meio de um
fio, conectar um 4º fio numa junção existente, arrastar uma junção, selecionar componente+fio e
mover juntos) antes de considerar 25.9 encerrado.

### 25.10 Auditoria pente fino da camada de interação de fios/junções (2026-07-12)

Pedido explícito do usuário: varredura de código morto, duplicação e regras repetidas em toda a
camada de desenho/edição/interação de fios (`main.ts`, `wireTopology.ts`, `wireGeometry.ts`,
`wireSpatialIndex.ts`, `messages.ts`, `extension.ts`, `coreLifecycle.ts`), consolidando em fonte
única sem alterar comportamento. Cada remoção/consolidação abaixo foi confirmada por grep de TODOS
os call sites antes de agir (não só leitura) -- ver `[[feedback_review_build_and_test_before_reporting]]`.

**Bug real encontrado e corrigido (não era só limpeza)**: no arrasto de componente,
`groupWireDragTarget` (canto/segmento especificamente selecionado) e `groupWireMoveTargets` (toda
`selectedWireIds`) podiam mirar o MESMO fio simultaneamente -- `selectOnlyWire`/
`selectOnlyWireCorner` sempre colocam o fio em `selectedWireIds` como efeito colateral de selecionar
um canto/segmento dele. Os dois mecanismos escreviam em `wire.points` na mesma rodada de `onMove`,
o segundo (`applyGroupMoveWireDelta`, mais grosseiro -- desloca TODOS os pontos internos por igual)
sobrescrevendo silenciosamente o ajuste preciso do primeiro (`applyGroupWireDelta`, que respeita o
eixo do canto/segmento). Corrigido excluindo o fio de `groupWireDragTarget` da computação de
`groupWireMoveTargets` nesse ponto de entrada (`computeGroupMoveWireTargets(groupWireDragTarget?.wireId)`).

**Código morto removido:**
- `findAtPosition`/`buildWireSpatialIndex`/`HitTestResult` (`wireTopology.ts`) -- motor de hit-test
  unificado, correto e testado, mas ZERO call sites fora dos próprios testes: `main.ts` nunca
  adotou esse caminho, construiu 4 alças DOM independentes (pino/segmento/canto/junção) com
  hit-test nativo do browser em vez disso (ver 25.9). Removido junto: a metade de
  `WireSpatialIndex` que só existia pra sustentar isso (`upsertConnectionPoint`/
  `removeConnectionPoint`/`queryConnectionPoints`/`IndexedConnectionPoint`/`clear()`) -- a metade de
  SEGMENTOS (`upsertWire`/`removeWire`/`queryPoint`) continua em uso real
  (`maybeAutoJunctionForDraggedComponents`). Cobertura de teste do que sobrou da classe reescrita
  pra testar `WireSpatialIndex` direto, sem depender de `findAtPosition`.
- `rebuildElectricalNet` (`wireTopology.ts`) -- união-busca sobre endpoints, zero call sites de
  produção (só os próprios testes); a invariante que ela verificava ("cruzamento sem nó fica
  eletricamente separado") foi PORTADA pra um teste novo em cima de `electricalEdgesForProject`
  (o mecanismo que de fato roda em produção), não simplesmente descartada.
- Um condicional morto (`if (matchedWire) break;`) em `maybeAutoJunctionForDraggedComponents` --
  inalcançável (o `break` de dentro do `if` anterior já garante que `matchedWire` nunca chega
  `truthy` nesse ponto do laço).
- Verbo IPC `requestStartWireFromWire` já tinha sido removido na sessão anterior (25.9); confirmado
  sem nenhum resíduo nesta varredura.

**Duplicação consolidada em fonte única:**
- `applyGroupTagAlongDelta` (`main.ts`, nova) -- as 4 alças de arrasto que tocam fio/junção (canto,
  canto via Shift-no-segmento, segmento, junção) repetiam byte a byte o mesmo bloco de ~10 linhas
  pra aplicar o delta de grupo (componentes + fios co-selecionados acompanhando o elemento
  agarrado). Agora cada uma só calcula `groupDx`/`groupDy` e delega.
- `startWireDragListeners` (`main.ts`, nova) -- as mesmas 4 alças repetiam a fiação de
  `pointermove`/`pointerup`/`pointercancel` em `window` com um `finish` nomeado só pra poder se
  referenciar nos próprios listeners. Agora é uma função (`onMove, onFinish`) reutilizada nas 4;
  cada `onFinish` continua sendo o código específico de cada uma (limpa a referência de arrasto
  certa -- `wireCornerDrag`/`wireSegmentDrag`/variável local da junção -- e decide
  persistir/suprimir o próximo clique), deliberadamente NÃO generalizado (tipos de referência de
  arrasto diferentes entre si, generalizar exigiria um genérico sem ganho real).
- `electricalOperationsDiff` (`coreLifecycle.ts`, nova) -- `extension.ts` repetia, em 4 handlers
  (sync genérico de `projectChanged`, `requestRemoveComponent`, `requestRemoveWire`,
  `requestConnectEndpoints`), o cálculo "achata antes/depois em arestas de pino real
  (`electricalEdgesForProject`) e monta a lista de operações connect/disconnect
  (`diffElectricalEdges`)". Extraída só essa PARTE mecânica (idêntica nos 4); a orquestração de
  cada verbo (aguardar ou disparar sem esperar, fallback quando não há diferença nenhuma,
  granularidade de polling) continua no call site -- são genuinamente diferentes entre si (ver
  "problema estrutural" abaixo) e forçar uma fusão total arriscaria alterar comportamento de
  rollback/erro que hoje é intencional.
- `WireEndpoint` (`messages.ts`) e `ConnectionEndpoint` (`wireTopology.ts`) eram dois tipos
  estruturalmente IDÊNTICOS (`{kind:"pin",componentId,pinId} | {kind:"wire",wireId,point}`)
  definidos em paralelo -- exemplo literal de "regra de conexão repetida em arquivo diferente".
  `WireEndpoint` agora é um alias de `ConnectionEndpoint` (import direto, sem redefinição), os dois
  lados do protocolo (mensagem IPC e motor de topologia) nunca mais podem divergir por acidente.

**Duplicação avaliada e mantida DELIBERADAMENTE (não é remendo, é fronteira arquitetural real):**
`flipLocalPoint`/`rotateLocalPoint` (`wireTopology.ts`) duplicam `flipPoint`/`rotatePoint`
(`main.ts`), mesma matemática de box/origem/flip/rotação, ~15 linhas. Já documentado como deliberado
numa sessão anterior: `wireTopology.ts` roda tanto no Host (Node, sem DOM) quanto na Webview, e
`main.ts` é Webview-only (não pode ser importado pelo Host). Extrair um 3º módulo compartilhado só
pra ~15 linhas usadas por exatamente 2 consumidores, um dos quais é o "original", seria abstração
desproporcional ao ganho -- mantido como está, documentado aqui de novo pra não ser "redescoberto"
como duplicação ingênua numa auditoria futura.

**Problemas estruturais encontrados (não corrigidos nesta rodada -- mudança de comportamento, fora
do escopo de "não alterar funcionalidades existentes"):**
1. **"Reconexão" de extremidade de fio não existe como gesto dedicado.** O pedido do usuário lista
   reconexão entre as operações que precisam de fonte única de verdade, mas não há hoje nenhum
   caminho de UI pra arrastar a PONTA de um fio existente (pino ou nó real, índice 0/último de
   `wirePolylinePoints`) pra outro pino -- `renderWireCornerHandles` deliberadamente pula esses dois
   índices (`for (let index = 1; index < points.length - 1; ...)`), só cobre pontos INTERNOS. O
   único caminho hoje é apagar o fio e desenhar outro. O modelo de dados já suporta a mudança
   (`WebviewWireModel.from`/`.to` são campos comuns, nada os torna imutáveis) -- o que falta é o
   gesto interativo em si (handle no índice 0/último com hit-test especial, arrasto que solta sobre
   um pino/segmento/junção e reescreve só aquele endpoint). Fica como trabalho futuro explícito, não
   implementado aqui por ser funcionalidade NOVA, não consolidação.
2. **Os 4 handlers de `extension.ts` que chamam `electricalOperationsDiff` têm orquestração
   pós-diff genuinely diferente** (aguardar vs. disparar sem esperar, fallback quando o diff vem
   vazio, granularidade de polling, rollback em erro). Isso É uma duplicação de FORMA (todos seguem
   "computa diff → decide o que fazer") mas não de CONTEÚDO -- uma fusão total exigiria um
   parâmetro de estratégia (callback/enum) que ganha pouco e arrisca alterar o comportamento de
   recuperação de erro de cada verbo, hoje ajustado individualmente. Candidato a uma passada futura
   SE esses 4 comportamentos forem intencionalmente unificados por decisão de produto (não é uma
   decisão de limpeza de código).

**Verificação**: os 3 tsconfigs compilam sem erro; suíte completa da Extension, 218/218, 0 falhas
(mesmo total de 25.9 -- nenhum teste foi perdido, `rebuildElectricalNet` teve sua invariante
portada, não descartada). ~146 linhas líquidas removidas nesta rodada (321 remoções, 175 inserções,
7 arquivos). Sem GUI disponível neste ambiente -- verificação das operações de conexão feita por
rastreamento de código (cada função consolidada foi comparada campo a campo com as N cópias que
substituiu antes de remover as originais) e pela suíte automatizada; recomenda-se sessão manual no
VSCode real cobrindo criação de fio (pino→pino, pino→segmento, segmento→segmento), arrasto de
canto/segmento/junção com e sem seleção mista, e remoção de fio/componente com simulação rodando
antes de considerar 25.10 encerrado.

## 26. Auditoria de Modo Placa e Componentes Expostos (2026-07-12)

**Nota 2026-07-16**: o "Mecanismo A" descrito na seção 26.2 abaixo (`subcircuitBoardMode.ts`, toggle
DENTRO da sessão de edição) foi removido e absorvido pelo modo de editor "Símbolo" — ver
`.spec/lasecsimul-subcircuits.spec` seção 22.5. O "Mecanismo B" (overlay na instância JÁ COLOCADA,
`renderBoardOverlaysFor`/`boardOverlayData`) continua vivo e ativo, só re-cabeado pra ler/escrever
`exposedComponents[]` (array de nível superior do `.lssubcircuit`, schemaVersion 3) em vez dos
campos planos `boardX`/`boardY`/... descritos na seção 26.3 — o bug de dois-armazenamentos-paralelos
ali documentado não existe mais estruturalmente (só há UM array de exposição agora, não dois
formatos concorrentes). Registro histórico mantido abaixo.

Pedido explícito do usuário: auditoria minuciosa de "Modo Placa" e "Selecionar componentes
expostos" durante edição de subcircuito, usando o SimulIDE real como referência (fonte estudada:
`subpackage.cpp`/`subpackage.h`, `linker.cpp`/`linker.h`, `component.cpp`/`component.h`, branch
`simulide_2`).

### 26.1 Como o SimulIDE real funciona (pesquisa de código, não suposição)

Dois mecanismos SEPARADOS e ortogonais, ambos vivendo em `SubPackage` (item que representa o
símbolo/pacote externo de um subcircuito, análogo ao `other.package` do LasecSimul):

- **`SubPackage::setBoardMode(bool)`** (ação de menu "Board Mode", checkable): opera sobre TODOS os
  componentes da CENA atualmente aberta (equivalente a estar dentro de "Abrir Subcircuito" no
  LasecSimul). Ao entrar: salva posição/rotação/flip atuais em `circPos`/`circRot`/etc, e SE já
  existia uma posição de placa salva (`boardRot() != -1e6`, sentinela de "nunca definido"), aplica
  `boardPos`/`boardRot`/etc. Ao sair: salva a posição atual (de placa) em `boardPos`/etc, restaura
  `circPos`/etc. `Component::setHidden(mode,...)` esconde o corpo INTEIRO de todo componente
  NÃO-`m_graphical`; componentes `m_graphical` só têm os PINOS escondidos (corpo visual continua
  visível) -- ou seja, **só quem é `m_graphical` aparece no Modo Placa**, sem exceção, sem seleção
  adicional.
- **`m_graphical`** (`Component`, `component.h`): flag booleana **hardcoded por CLASSE de
  componente** no construtor de cada subclasse (LEDs, switches, motores, displays, medidores,
  sensores, MCU, potenciômetro, `shape`/`textcomponent`, `dial`, o próprio `SubPackage` etc, ~40
  classes) -- **NUNCA uma propriedade editável pelo usuário por instância**. É um traço do TIPO,
  não do componente individual.
- **`Linker`/`m_isMainComp`** ("Select Exposed Components", outra ação de menu em `SubPackage`):
  clique-para-alternar (`startLinking()`/`compSelected()`) quais componentes internos são "Main
  Components". Persistido via `getLinks()`/`setLinks()` (lista de UIDs separada por vírgula,
  resolvida de volta em `createLinks()` no carregamento). Destaque visual: azul+número durante a
  seleção ativa, amarelo permanente fora dela (`Component::paintSelected`).
- **Achado importante**: `m_isMainComp` **NÃO controla visibilidade no Modo Placa** (`setBoardMode`
  nunca consulta `isMainComp()`) -- os dois mecanismos são estruturalmente independentes no C++
  real. O uso real de `isMainComp` encontrado é dar acesso rápido às propriedades do componente
  interno a partir de fora (`Component::contextMenu`, `if (!event && m_isMainComp)`), não gate de
  Modo Placa.
- **Achado importante #2**: `SubPackage::paint()` só desenha `Chip::paint()` (fundo/pinos do
  pacote) -- **não existe, no SimulIDE real, nenhuma renderização de componentes internos
  "espiando" por cima do símbolo externo quando visto de FORA do subcircuito** (isto é, a partir do
  circuito PAI, sem abrir o subcircuito). Esse recurso (pressionar um botão exposto de uma
  instância direto no circuito principal, sem abrir o subcircuito) é uma **invenção do
  LasecSimul**, sem equivalente no SimulIDE -- mantida por ser funcionalidade real e útil (ex:
  apertar o botão RESET de uma instância de ESP32 durante a simulação sem precisar entrar no
  subcircuito), não removida, mas identificada explicitamente aqui para não ser confundida com
  paridade de SimulIDE.
- **Achado importante #3** (responde à seção 2 do pedido do usuário, "representação diferente no
  Modo Placa"): não foi encontrada NENHUMA representação visual alternativa/distinta pro Modo Placa
  em componente nenhum -- `Component::m_boardMode` (flag estática) só é lida em MAIS UM lugar do
  código inteiro (`component.cpp:174`, um modificador de evento de mouse, não desenho). Um
  componente `m_graphical` usa o MESMO `paint()` tanto no esquemático quanto no Modo Placa -- Modo
  Placa muda só POSIÇÃO e VISIBILIDADE, nunca a forma de desenhar. **Não foi implementada** uma
  "representação Board-Mode distinta por componente" porque ela não existe no SimulIDE real que o
  pedido pede pra usar como referência -- ver seção 26.4 (comportamento não-equivalente/decisão) pra
  transparência completa sobre esse ponto.

### 26.2 Mapeamento do que já existia no LasecSimul (dois mecanismos, nomeados aqui pra clareza)

- **Mecanismo A** (`subcircuitBoardMode.ts` + `main.ts::setSubcircuitBoardMode`/
  `isBoardModeVisible`): Modo Placa de verdade, só ativo DENTRO de uma sessão "Abrir Subcircuito"
  -- já era uma porta fiel de `SubPackage::setBoardMode` (`captureCircuitTransforms`/
  `applyBoardTransforms`/`captureBoardTransforms`/`restoreCircuitTransforms`, mesmo padrão
  circPos/boardPos). Reaproveita o pipeline de renderização/interação normal do esquemático (mesmos
  `state.components`, só reposicionados) -- por construção, mover/rotacionar/espelhar/multi-
  selecionar/arrastar já funcionavam SEM nenhum código adicional, confirmado por leitura (nenhum
  gate de `subcircuitBoardMode` nos handlers de seleção/arrasto/rotação/flip).
- **Mecanismo B** (`main.ts::renderBoardOverlaysFor` + `boardModeEnabled` property + IPC
  `requestBoardOverlayData`/`requestUpdateBoardOverlayVisual`/`requestUpdateBoardOverlayProperty`):
  overlay interativo no circuito PRINCIPAL sobre uma instância de subcircuito com Modo Placa
  ligado -- funcionalidade LasecSimul-específica (ver 26.1), não existe no SimulIDE.

### 26.3 Bug crítico real encontrado e corrigido: dois armazenamentos paralelos nunca sincronizados

`WebviewComponentModel` (`model.ts`) já tinha os campos PLANOS corretos, persistidos e usados pelo
Mecanismo A: `boardX`/`boardY`/`boardRotation`/`boardFlipH`/`boardFlipV`. Mas o Mecanismo B lia e
escrevia um campo **completamente diferente e nunca lido por mais ninguém**:
`subcircuitInternals.ts::extractInternalComponents` lia `value.boardVisual` (objeto aninhado
`{x,y,rotation,flipH,flipV}`) direto do JSON cru -- campo que o Mecanismo A **nunca escreveu** (só
escreve os campos planos). E `mcuCommands.ts::updateBoardOverlayVisualCommand` (chamado ao
ARRASTAR o overlay no circuito principal) escrevia justamente nesse `boardVisual` aninhado, nunca
nos campos planos.

Consequência real: posicionar um componente com o Modo Placa DE VERDADE (Mecanismo A, dentro de
"Abrir Subcircuito") nunca aparecia no overlay da instância no circuito principal (Mecanismo B
sempre lia `undefined`, caindo no posicionamento padrão em coluna); e arrastar o overlay no
circuito principal nunca refletia de volta no Modo Placa real. Exatamente o "array paralelo sem
sincronização" que a seção 5 do pedido pede pra caçar -- este era o mais grave encontrado.

**Corrigido**: `subcircuitInternals.ts` ganhou `boardVisualFromFlatFields`, que deriva o
`boardVisual` (agrupamento só de conveniência pro payload IPC `InternalComponentSnapshot`, não mais
fonte de verdade) a partir dos MESMOS campos planos que o Mecanismo A grava.
`updateBoardOverlayVisualCommand` agora escreve direto em `boardX`/`boardY`. Fonte única de verdade
persistida: os 5 campos planos em `WebviewComponentModel`, os mesmos de sempre -- nenhuma migração
necessária (nenhum arquivo real no repositório tinha `boardVisual` OU `boardX` escritos ainda,
confirmado por grep em `subcircuits/`/`devices/` antes da correção).

### 26.4 Comportamento que permanece NÃO-equivalente ao SimulIDE (decisão consciente, documentada)

- **Representação visual distinta no Modo Placa** (seção 2 do pedido): não implementada -- ver
  26.1, achado #3. O SimulIDE real não tem esse recurso; implementá-lo seria inventar
  comportamento sem lastro na referência pedida. Se o usuário quiser isso mesmo assim como recurso
  PRÓPRIO do LasecSimul (não paridade SimulIDE), é uma decisão de produto nova, não uma correção de
  divergência -- fica pendente de confirmação explícita antes de qualquer implementação futura.
- **Mecanismo B (overlay no circuito principal)** continua sem equivalente no SimulIDE -- mantido
  por ser funcionalidade real já usada (não removida, matching "não remover funcionalidades
  existentes"), agora corretamente sincronizado com o Mecanismo A (26.3).
- **`isMainComp`/exposed não gatilha Modo Placa no SimulIDE real, mas gatilha no LasecSimul**
  (filtro `item.exposed && item.graphical` em `renderBoardOverlaysFor`) -- decisão deliberada de
  MANTER o comportamento atual do LasecSimul (dá controle de curadoria que o SimulIDE não tem: nem
  todo componente `graphical` de um subcircuito precisa aparecer no overlay externo) em vez de
  replicar a independência total do SimulIDE, que teria o overlay mostrando TODO componente
  gráfico sem nenhuma curadoria possível -- pior UX, não melhor paridade que valha a pena.
- **Grade/snap ao arrastar componente** (dentro OU fora do Modo Placa): LasecSimul não tem snap de
  grade no arrasto de componente (só fios têm `WIRE_GRID_SIZE`/`snapCoordinate`) -- isto NÃO é uma
  lacuna introduzida ou específica do Modo Placa, é como TODO arrasto de componente já funciona no
  editor hoje; não alterado aqui pra não introduzir uma inconsistência nova (componente ganhando
  snap só dentro do Modo Placa, diferente do resto do editor).

### 26.5 Outras correções desta auditoria

- `main.ts`: "Modo Placa"/"Selecionar Componentes Expostos" só apareciam no menu de contexto de um
  componente já existente -- numa folha de subcircuito recém-criada (zero componentes), não havia
  NENHUM jeito de entrar em Modo Placa. Adicionadas as mesmas 2 entradas ao menu do fundo vazio do
  canvas, condicionadas a `state.subcircuitEditingContext` (igual ao menu por componente).
  Resolve "entrada e saída do Modo Placa" (seção 1) pra qualquer estado do canvas.
- `main.ts::pasteClipboardItems`: colar uma cópia de um componente já posicionado no Modo Placa
  deslocava `x`/`y` (esquemático) pelo grid, mas NUNCA `boardX`/`boardY` -- a cópia nascia
  exatamente empilhada sobre o original na visão de placa. Mesmo deslocamento aplicado aos dois
  agora.
- `isBoardModeVisible` (antes função local em `main.ts`, acoplada a `catalogEntryFor`) extraída pra
  `subcircuitBoardMode.ts` como função pura (recebe `isGraphicalTypeId` injetado) -- resolve
  "responsabilidades misturadas entre UI e modelo" (seção 5) pro cálculo de visibilidade
  especificamente, e torna a regra "só `graphical` (ou `other.package`/ícone) aparece" testável
  diretamente, sem precisar montar um catálogo inteiro pro teste.

### 26.6 Segurança contra duplicação/referência órfã (verificado, não precisou de correção)

- `exposed`/`boardX`/`boardY`/`boardRotation`/`boardFlipH`/`boardFlipV` são campos ESCALARES
  (`number`/`boolean`) direto em `WebviewComponentModel` -- `cloneComponent` (`{...rest}`) já os
  copia por valor, sem risco de referência compartilhada entre original e cópia/colagem.
  `exposed` É copiado através de cópia/colagem deliberadamente (mesmo comportamento esperado de
  `BoolProp` no SimulIDE real, que copia todas as propriedades registradas ao colar).
- **Sem array paralelo de "ids expostos"**: `exposed` é uma flag NO PRÓPRIO componente, não uma
  lista separada referenciando ids (diferente do `Linker::m_linkedComp`/UID-string do SimulIDE
  real) -- excluir ou renomear um componente exposto nunca deixa referência órfã, por construção
  (não existe uma segunda estrutura de dados que precise ser limpa à parte). Isto é estruturalmente
  MAIS robusto contra órfãos do que o mecanismo original do SimulIDE.
- **Duas instâncias do mesmo subcircuito**: layout de Modo Placa e conjunto de expostos são
  propriedades do ARQUIVO `.lssubcircuit` (definição compartilhada), não da instância -- duas
  instâncias mostram o MESMO layout de placa por design (igual ao SimulIDE: `SubPackage`/Board Mode
  pertence à cena INTERNA do subcircuito, não à instância externa). `boardModeEnabled` (se o
  overlay está LIGADO) é uma property PER-INSTANCE (`component.properties`, objeto próprio por
  instância via `cloneComponent`), então ligar o overlay numa instância nunca liga na outra --
  testado por leitura de código, comportamento correto confirmado.

### 26.7 Testes adicionados

`subcircuitBoardMode.test.ts`: +5 casos -- `isBoardModeVisible` (gráfico/não-gráfico/`other.package`/
ícone), seleção múltipla incremental (marcar 3, desmarcar 1, os outros 2 continuam), componente sem
posição de placa salva nunca pula pra `(0,0)` (arquivo antigo/1ª vez), rotação+espelhamento
sobrevivem a um ciclo completo entrar/sair do Modo Placa, e duas capturas independentes (2
"instâncias") nunca compartilham objeto de transform por referência. `subcircuitInternals.ts`/
`mcuCommands.ts` (o outro lado do fix) não têm suíte própria porque importam `vscode` no escopo do
módulo -- mesma limitação estrutural de QUALQUER arquivo do lado Extension que toca a API do VS
Code neste projeto (sem shim de `vscode` no test runner atual); verificado por compilação limpa +
leitura campo a campo comparando com o padrão já testado em `subcircuitBoardMode.ts`.

**Verificação**: os 3 tsconfigs compilam sem erro; suíte completa, 223/223 (5 novos), 0 falhas. Sem
GUI disponível neste ambiente -- "comparação visual com o SimulIDE" (item 19 dos testes pedidos)
feita por leitura direta do código-fonte real do SimulIDE (`C:\SourceCode\simulide_2\src`, branch
`simulide_2`, já usado numa auditoria anterior -- ver `[[reference_simulide_schematic_analysis]]`),
não por captura de tela (sem GUI aqui pra rodar nenhum dos dois programas). Recomenda-se sessão
manual no VSCode real cobrindo: abrir/fechar Modo Placa numa folha de subcircuito vazia (via o novo
menu de fundo), posicionar um componente gráfico e confirmar que a MESMA posição aparece no overlay
da instância no circuito principal (e vice-versa, arrastando o overlay e reabrindo o subcircuito),
colar uma cópia de um item posicionado na placa, e desfazer/refazer um ciclo de Modo Placa.

## 27. Representação visual própria do Modo Placa (2026-07-12)

Pedido explícito do usuário, respondendo diretamente à "decisão pendente" registrada em 26.4/26.1
achado #3: confirmar (com duas imagens de referência de um ESP32 DevKitC -- vista "placa física" com
botões redondos "e"/"b", e vista "esquemático/fiação" com os mesmos botões ao lado dos pinos
elétricos reais) que o LasecSimul deve implementar uma aparência de Modo Placa DISTINTA da
aparência esquemática, como recurso PRÓPRIO do LasecSimul (não paridade SimulIDE -- ver 26.1/26.4:
o SimulIDE real usa o MESMO `paint()` nos dois contextos, só muda posição/visibilidade).

### 27.1 Requisito e por que não é paridade SimulIDE

Requisitos explícitos do pedido: (1) aparência distinta por componente no Modo Placa; (2)
posicionamento independente (já existia, `boardX`/`boardY`/etc, seção 26); (3) tamanho/orientação
próprios do Modo Placa; (4) vínculo com o MESMO componente/estado, nunca uma cópia paralela; (5)
interação (clique/estado) durante simulação usando os MESMOS pinos/propriedades; (6) persistência;
(7) não alterar o comportamento do modo esquemático, não duplicar lógica elétrica/simulação.

Como 26.1 já documentou que `Component::m_boardMode` só é lido fora do `paint()` no SimulIDE real,
este recurso não tem onde "portar de" -- é autoria nova, seguindo o MESMO formato declarativo
(`package.simulidePaint`, primitivas ellipse/rect/roundedRect/polygon/line/text/repeat com
`stateFill`/`stateVisible`/`stateText`) já usado para portar os símbolos elétricos reais, só que sem
fonte C++ para copiar -- as imagens anexadas pelo usuário foram a referência visual usada.

### 27.2 Arquitetura: 3º slot de package, escolhido por CONTEXTO de renderização (não por propriedade)

Extensão direta do padrão já existente para "Chip or Logic Symbol"
(`LOGIC_SYMBOL_PACKAGE_BY_TYPE_ID`, escolhido por `properties.logicSymbol === true`, uma propriedade
da INSTÂNCIA): `componentSymbols.ts` ganhou `BOARD_PACKAGE_BY_TYPE_ID` (mapa separado) e um novo
parâmetro `variant?: "board"` em `resolvedPackageFor`/`componentBox`/`packageSymbolSvg`, propagado
por `registerPackage(typeId, pkg, logicSymbolPkg?, boardPkg?)`. Diferença deliberada do Logic
Symbol: Board-Mode-ness é uma decisão de QUEM está renderizando (`main.ts`, dentro do Modo Placa
real -- Mecanismo A -- ou no overlay da instância -- Mecanismo B), nunca um estado gravado no
componente; por isso é um parâmetro explícito passado a cada chamada, não uma property lida de
dentro de `componentSymbols.ts`. Prioridade quando ambos existem: `variant==="board"` vence sobre
`logicSymbol` (contexto de renderização mais específico). Sem `boardPackage` registrado pro typeId,
cai no `package` esquemático de sempre -- Modo Placa nunca fica sem aparência nenhuma, e nenhum
typeId existente muda de comportamento sem ser explicitamente portado.

`registerPackage` aceita `boardPkg` sem exigir nenhum pino (guarda mais frouxa que `pkg`/
`logicSymbolPkg`, que exigem `pins.length > 0`): ao contrário do esquemático, o Modo Placa nunca
desenha fio/terminal (26.1: pinos ficam ESCONDIDOS pra componentes `m_graphical` em Board Mode, só o
corpo visual continua) -- uma aparência com 0 pinos é o caso NORMAL aqui, não uma entrada malformada.

Consequência direta em `main.ts::updateComponentElement`: quando `boardVariant==="board"`, o laço
que desenha terminal/pino de fio é pulado inteiramente (`if (boardVariant !== "board") { ...laço de
pinos... }`) -- coordenadas de pino do package esquemático não fariam sentido sobre uma forma/
tamanho de package diferente, e replica o comportamento real do `Component::setHidden` (26.1) de
esconder pinos em componentes gráficos durante Board Mode.

### 27.3 Tamanho/orientação próprios (`boardWidth`/`boardHeight`)

Reaproveita o mecanismo de escala por-instância já existente (`__simulideSceneScaleX/Y`, lido por
`packageInstanceScale`, já usado noutro fluxo de escala de package) em vez de inventar um 2º sistema
de geometria: `main.ts` calcula a razão entre `component.boardWidth`/`boardHeight` (novos campos em
`WebviewComponentModel`, mesma família de `boardX`/`boardY`/`boardRotation`/`boardFlipH`/
`boardFlipV`) e o tamanho NATURAL do `boardPackage` (via `componentBox(typeId, props, "board")`), e
injeta o fator resultante num objeto de properties SINTÉTICO passado ao renderer -- nunca mutando
`component.properties` em memória (risco identificado proativamente: `runtimeSymbolProperties` pode
devolver a referência VIVA de `component.properties`; o código sempre espalha `{...symbolProperties,
...}` numa cópia nova antes de injetar o fator de escala). Ausente (`undefined`) == usa o tamanho
natural do `boardPackage`, sem nenhuma escala aplicada. Rotação/flip do Modo Placa já eram cobertos
por `boardRotation`/`boardFlipH`/`boardFlipV` (seção 26), reaproveitados sem alteração.

### 27.4 Vínculo com o componente real / interação unificada

Nenhuma cópia paralela de componente ou de estado: o `boardPackage` é só uma FORMA DIFERENTE de
desenhar o MESMO `component.properties`/`component.pins`, resolvida a cada `render()` a partir do
mesmo `state.components` de sempre -- mesmo princípio já usado por `logicSymbol`. As primitivas do
`boardPackage` de `switches.push`/`switches.switch` usam `cssClass: "toggle-hit-zone"`, a MESMA
classe CSS que o handler de clique genérico em `main.ts` já procura (`event.target.closest(
".toggle-hit-zone")`, linha ~4646) para decidir `canToggle`/chamar `setSwitchClosed(component,
component.properties.closed !== true)` (linha ~4720) -- verificado por leitura direta do fluxo
clique→toggle: não existe (nem foi criado) nenhum 2º caminho de clique específico do Modo Placa;
clicar no botão físico do Modo Placa aciona exatamente o mesmo `closed` que o símbolo elétrico do
esquemático leria, e a mudança aparece nos dois (schematic + board) no próximo `render()`, porque
ambos leem o mesmo `component.properties.closed` -- só a `stateFill` do binding SVG muda.

### 27.5 Componentes portados nesta rodada e limitações documentadas

- **`switches.push`**: botão físico redondo (referência: botões EN/Boot do ESP32 DevKitC).
  `stateFill` em `closed` (verde/cinza), `stateText` ecoando `key` (mesmo rótulo do esquemático).
- **`switches.switch`**: chave/rocker física, dois "thumbs" com `stateVisible` opostos em `closed`.
- **`outputs.led`**: LED físico redondo (vermelho fixo). **Limitação conhecida e documentada no
  próprio `component-catalog.json` (`source.notes`)**: o Core ainda não expõe corrente/intensidade
  real como propriedade pra `outputs.led` -- o símbolo ESQUEMÁTICO também não reflete estado hoje.
  A aparência do Modo Placa é estática (mesma cor sempre) até esse dado existir; quando existir, o
  binding é só adicionar `stateFill`/`stateProjection` aqui, sem mexer no resto da arquitetura.
- **Fora de escopo desta rodada** (decisão deliberada, não pressa): `passive.potentiometer` e
  `outputs.seven_segment` não ganharam `boardPackage` -- typeIds sem `boardPackage` registrado
  simplesmente continuam reusando o package esquemático no Modo Placa (27.2), nenhum comportamento
  quebrado, só menos "físico" visualmente até serem portados numa rodada futura.
- **`registeredSources.ts`** (manifesto `.lsdevice`/`.lssubcircuit`, que já tem seu próprio
  `logicSymbolPackage` via `sanitizePackage`) deliberadamente NÃO ganhou `boardPackage` nesta
  rodada -- os typeIds pedidos pelo usuário são todos do catálogo base (`component-catalog.json`),
  não de device/subcircuito externo; extensão do manifesto fica pendente de necessidade real.

### 27.6 Bug real encontrado e corrigido de passagem (Mecanismo B, overlay no circuito principal)

`renderBoardOverlaysFor` montava `properties` como `{ closed: false }` **hardcoded**, descartando
`item.properties` inteiramente -- um switch salvo com `closed: true` sempre desenhava aberto no
overlay da instância no circuito principal (Mecanismo B), mesmo com o Modo Placa real (Mecanismo A)
mostrando o estado correto. Corrigido para `{ closed: false, ...item.properties }` (default só para
typeIds sem a propriedade, nunca sobrescrevendo o valor real salvo). Diretamente relevante ao
requisito "5. Interação durante simulação -- estado deve refletir imediatamente" do pedido: sem essa
correção, a NOVA aparência física do Modo Placa herdaria o mesmo bug de estado errado no overlay.

### 27.7 Dados novos / formato

- `PackageDescriptor` (formato já existente, sem mudança de schema) usado como o TIPO do novo campo
  `boardPackage?: PackageDescriptor` em `WebviewComponentCatalogEntry` (`model.ts`) e
  `UnifiedCatalogItem`/`entryToWebview` (`UnifiedCatalog.ts`) -- mesmo shape de `package`.
- `WebviewComponentModel` ganha `boardWidth?: number`/`boardHeight?: number` (persistidos junto dos
  demais campos escalares `boardX`/`boardY`/etc, mesma família, mesma garantia de cópia por valor em
  `cloneComponent` -- seção 26.6 já cobre essa garantia estrutural, reaproveitada sem mudança).
- `component-catalog.json`: `boardPackage.simulidePaint.source.file` marcado explicitamente como
  `"N/A -- aparência própria do Modo Placa do LasecSimul, sem equivalente no paint() real do
  SimulIDE"` em cada entrada nova, para nunca ser confundido com os OUTROS `simulidePaint` do mesmo
  arquivo, que são portes fiéis de `paint()` C++ reais.

### 27.8 Testes e verificação

`componentSymbols.test.ts`: +5 casos -- seleção do package certo por `variant` (sem variant reusa o
esquemático; com `variant:"board"` e `boardPackage` registrado usa o board; com `variant:"board"` mas
SEM `boardPackage` registrado cai no esquemático, nunca fica sem aparência); os 3 typeIds portados
(`switches.push`/`switches.switch`/`outputs.led`) lidos DIRETO do `component-catalog.json` real (não
fixture) confirmando SVG do Modo Placa visualmente diferente do esquemático, `key`/`closed`
continuam ecoados (mesmo estado, nunca duplicado), e presença de `toggle-hit-zone` (clicável pelo
mesmo mecanismo genérico).

Um dos 5 testes inicialmente falhou por um erro na PRÓPRIA fixture do teste (não na implementação):
um pino de teste com `angle:180,length:8` se estendia 8px para fora da caixa 32x28 declarada, e
`resolvePackageLayout` corretamente EXPANDE o bounding box calculado para caber qualquer lead que
ultrapasse `width`/`height` (comportamento correto e pré-existente, não uma regressão desta rodada)
-- o box observado (40x28) misturava a largura esperada do board package (40) só por coincidência
numérica. Corrigido trocando o pino da fixture por um terminal canônico (`x`/`y`) com `length:0`, exatamente
na borda declarada (não estica o box), preservando a exigência de `registerPackage` de pelo menos 1
pino para tratar o package como "real".

**Verificação**: os 3 tsconfigs (`tsconfig.json`/`tsconfig.webview.json`/`tsconfig.test.json`)
compilam sem erro; suíte completa, 228/228 (5 novos sobre os 223 anteriores), 0 falhas. Sem GUI
disponível neste ambiente -- comparação feita por leitura de código (fluxo clique→toggle→render,
binding `stateFill`/`stateText`), não por captura de tela real; recomenda-se sessão manual no VSCode
cobrindo: entrar no Modo Placa de um subcircuito com `switches.push`/`switches.switch`/`outputs.led`,
confirmar visual físico (botão redondo, chave rocker, LED bulbo) distinto do esquemático, clicar no
botão/chave físicos durante simulação e confirmar que o pino elétrico correspondente reage no
esquemático (mesma rede), redimensionar via `boardWidth`/`boardHeight` numa propriedade futura de UI
(ainda sem editor dedicado nesta rodada -- os campos existem e persistem, mas não há um controle
"Largura na Placa"/"Altura na Placa" na paleta de propriedades ainda), salvar e reabrir o arquivo
confirmando que posição/tamanho/orientação do Modo Placa sobrevivem.

### 27.9 Correção: `switches.push`/`switches.switch` NÃO precisam de `boardPackage` (2026-07-12)

Usuário questionou a afirmação de 27.1 ("SimulIDE não tem representação distinta") pedindo análise
mais profunda -- achado real, não estava certo pela metade.

**O que a 1ª pesquisa (seção 26/27.1) confirmou certo**: `Component::m_boardMode` só é lido em
`freeMove()` e `SubPackage::setBoardMode()` -- nunca dentro de um `paint()`. Um componente NUNCA
redesenha a si mesmo diferente por causa do Modo Placa.

**O que a 1ª pesquisa deixou passar**: `Push::paint()` (`components/switches/push.cpp:110-135`)
desenha a barra do atuador usando um `QGraphicsProxyWidget` de fundo, `CustomButton`
(`gui/custombutton.cpp`), cujo `paintEvent()` **já muda de gradiente sozinho** com
`isDown()||isChecked()` -- e `LedBase::paint()` (`components/outputs/leds/ledbase.cpp:152-187`) **já
calcula a cor a partir de `m_intensity`** (corrente real) a cada frame. Ou seja: pra estes tipos
`m_graphical`, a ÚNICA aparência que existe já É física (botão com gradiente 3D, LED redondo colorido)
e já É dinâmica (muda com o estado) -- desde SEMPRE, no esquemático inclusive, não é um recurso do
Modo Placa. Conferido contra o `component-catalog.json` REAL (não o `boardPackage` novo): o package
ESQUEMÁTICO de `switches.push` já tem `stateFill` em `closed` (`"#62d67b"`/`"#dddddd"`, porte fiel do
`CustomButton`) -- **já era dinâmico antes desta sessão**.

**Conclusão**: o `boardPackage` circular que autorei pra `switches.push`/`switches.switch` era
redundante -- duplicava (com forma diferente, sem lastro em nenhum C++ real) uma dinâmica que o
package esquemático já tinha. **Revertido**: `boardPackage` removido de ambos no
`component-catalog.json`; Modo Placa agora reaproveita o package ESQUEMÁTICO (já físico, já dinâmico)
via `boardX`/`boardY`/etc (mecanismo independente desde a seção 26), sem package próprio -- exatamente
como o SimulIDE real funciona pra estes dois tipos. Mecanismo `boardPackage` (`componentSymbols.ts`)
continua no código, disponível pra typeIds que precisarem de fato de uma forma diferente (nenhum caso
concreto identificado ainda).

**Bug real encontrado e corrigido nesta mesma revisão** (`main.ts::updateComponentElement`): o
esconde-pino do Modo Placa estava gated em `boardVariant === "board"` (só os typeIds com
`boardPackage` registrado), não em `catalogEntry?.graphical === true` como o `Component::setHidden`
real -- ou seja, TODO OUTRO componente `m_graphical` sem `boardPackage` (motores, displays, sensores,
LED antes desta rodada, etc, ~40 classes) ficava com pino visível/clicável no Modo Placa, divergindo
do SimulIDE. Corrigido pra `const pinsHiddenInBoardMode = subcircuitBoardMode && catalogEntry?.graphical
=== true`, cobrindo TODO componente gráfico, não só os poucos com aparência própria.

**`outputs.led` mantinha `boardPackage`** logo depois desta correção, como única exceção -- mas com a
MESMA ressalva: é igualmente estático ao package esquemático (nenhum dos dois reflete `m_intensity`/
corrente real, gap genuíno do Core, não resolvido por nenhum dos dois packages), então não resolvia o
"LED acende/apaga" que o usuário perguntou. **Decisão do usuário (mesma sessão, minutos depois):
remover também, por consistência** -- ver seção 27.10.

**Testes**: `componentSymbols.test.ts` -- o teste de `switches.push`/`switches.switch` reescrito pra
confirmar exatamente o comportamento revertido (SEM `boardPackage` no catálogo, `componentBox`/
`packageSymbolSvg` com `variant:"board"` caem no package esquemático, que já muda de cor com `closed`).
Suíte completa após a correção: 228/228, 0 falhas (mesma contagem de antes -- teste substituído, não
removido). 3 tsconfigs compilam limpos.

### 27.10 `outputs.led` também revertido -- os 3 tipos originais ficam sem `boardPackage` (2026-07-12)

Usuário confirmou (mesma sessão): remover `boardPackage` de `outputs.led` também, pela mesma lógica de
27.9 -- não resolve o problema real (LED não acende porque falta intensidade real do Core, não porque
falta forma redonda), e mantê-lo só pelos outros dois terem sido revertidos criaria inconsistência sem
motivo (um typeId com aparência própria estática, os outros dois reaproveitando o esquemático).

**Estado final desta rodada**: `component-catalog.json` não tem MAIS NENHUM `boardPackage` registrado
(nenhum dos 59 itens) -- `switches.push`/`switches.switch`/`outputs.led` todos caem no package
esquemático (já físico onde já era físico no SimulIDE real, ainda abstrato/estático onde o SimulIDE
real também é, caso do LED) via `boardX`/`boardY`/etc, exatamente como o SimulIDE faz. O MECANISMO
`boardPackage` (`componentSymbols.ts::BOARD_PACKAGE_BY_TYPE_ID`, `registerPackage`'s 4º argumento,
`variant?: "board"` em `resolvedPackageFor`/`componentBox`/`packageSymbolSvg`, `boardWidth`/
`boardHeight` em `WebviewComponentModel`) **continua no código, funcional e testado** (seção 27.8) --
não foi removido, só ficou sem nenhum usuário real no catálogo por ora. Antes de registrar um
`boardPackage` pra um typeId futuro, confirmar primeiro (27.9) se o `paint()` real do SimulIDE pra essa
classe já é físico e dinâmico por si só (a maioria dos `m_graphical` é) -- só vale a pena inventar uma
aparência nova quando o símbolo esquemático real for genuinamente abstrato/elétrico E não existir
nenhuma foto/forma física correspondente em lugar nenhum do C++ real pra reaproveitar.

**Correção de processo registrada em memória** (não `.spec`, mas relevante pra sessões futuras): ao
reverter o `boardPackage` do LED, um round-trip via `json.dump()` do Python (só pra remover 2 campos)
reformatou números não relacionados no arquivo inteiro (notação científica), e o reflexo de rodar
`git checkout --` pra desfazer só esse efeito colateral apagou TODO o trabalho não commitado da sessão
no arquivo (não só o efeito colateral) -- recuperado manualmente porque o conteúdo tinha acabado de
aparecer num `git diff` anterior. Reversões subsequentes usaram edição cirúrgica de texto (Edit tool),
nunca mais um round-trip de arquivo inteiro nem `git checkout` em arquivo com trabalho não commitado.

**Verificação final**: suíte completa 228/228 (2 testes a mais reescritos, mesma contagem), 3
tsconfigs compilando limpos, `component-catalog.json` validado como JSON íntegro (59 itens) após as
duas remoções cirúrgicas.

## 28. Bug de empacotamento: CSS dos webviews ausente no VSIX gerado pelo workflow (2026-07-12)

Usuário reportou (2 screenshots comparando lado a lado): a paleta de componentes compilada localmente
(F5/Extension Development Host) mostra uma LISTA de 1 coluna; a mesma paleta, instalada a partir do
`.vsix` gerado pelo `package-installers.yml` (mesmo commit, confirmado via `gh run view` -- não é
questão de versão desatualizada), aparece como uma GRADE de vários ícones por linha, sem nenhum
estilo aparente.

### 28.1 Causa raiz

`SchematicPanel.ts:115` e `ComponentPaletteViewProvider.ts:107` montam o HTML do webview **em tempo de
execução** referenciando o CSS DIRETO da pasta `src/` do código-fonte:

```ts
vscode.Uri.joinPath(this.extensionUri, "src", "ui", "webview", "styles.css")   // SchematicPanel.ts
vscode.Uri.joinPath(this.extensionUri, "src", "ui", "palette", "styles.css")   // ComponentPaletteViewProvider.ts
```

Isso funciona em DEV (F5) porque `extensionUri` aponta direto pra pasta `extension/` do repositório --
`src/ui/webview/styles.css` existe ali, sempre atualizado. Mas o `compile` do `extension/package.json`
é só `tsc -p ./ && tsc -p ./tsconfig.webview.json` -- `tsc` NUNCA copia `.css`, só processa `.ts`/
`.tsx`. E `scripts/package-release.js::stageExtensionFiles()` só copiava `out`/`out-webview`/`media`
pro pacote staged -- **nunca `src/`**. `rewriteStagedPackageJson()`'s `pkg.files` (o que `vsce package`
de fato inclui no `.vsix`) também nunca tinha um glob pra `src/**`. Resultado: os dois `styles.css`
NUNCA existiram no `.vsix` publicado -- só no repositório fonte. No pacote instalado, `<link
rel="stylesheet" href="...">` aponta pra um recurso inexistente, o webview carrega SEM NENHUM CSS
custom, e o navegador cai no layout padrão: `<button class="palette-item">` sem `display:flex`
declarado vira `inline-block` (padrão de `<button>`), e vários botões inline-block em sequência
naturalmente quebram linha e "empilham" em grade -- exatamente a grade vista no screenshot, sem
precisar de nenhuma regra CSS própria pra isso, é só o navegador sem estilo nenhum. O MESMO bug afeta
o editor de esquemático principal (`SchematicPanel.ts`), não só a paleta -- provavelmente também
aparece sem estilo algum na versão instalada, mesmo sem o usuário ter reportado ainda.

### 28.2 Correção

`scripts/package-release.js::stageExtensionFiles()` -- adicionados os 2 arquivos à lista `filesToCopy`
(`src/ui/webview/styles.css`, `src/ui/palette/styles.css`), copiados pro staging preservando o MESMO
caminho relativo `src/ui/...` (não precisa mudar nenhum `vscode.Uri.joinPath` em runtime, só garantir
que o arquivo exista onde o código já espera). `rewriteStagedPackageJson()`'s `pkg.files` ganhou os 2
caminhos explícitos, pra `vsce package` de fato incluir esses arquivos no `.vsix` (globs `out/**/*` etc
não cobririam `src/`).

Verificado por simulação isolada da lógica de cópia (Node ad-hoc, fora do pipeline completo -- rodar
`package-release.js` de ponta a ponta exige compilar Core/devices/MCU adapters nativos, pesado demais
pra esta verificação pontual): os 2 arquivos existem nos caminhos fonte esperados e a cópia produz o
destino correto. `node --check scripts/package-release.js` confirma sintaxe válida.

### 28.3 Correção relacionada: versão do pacote nunca refletia a tag da release

Investigação paralela (antes de achar a causa real acima) revelou um problema de processo genuíno,
mesmo não sendo a causa principal deste bug: `extension/package.json` ficava travado em `0.0.1`
independente da tag Git da release (`v0.0.1`, `v0.0.3` etc) -- o job `release` de
`package-installers.yml` só cria a tag no Git (`git tag`/`git push`), nunca escreve a versão de volta
em `package.json`. Corrigido: novo passo "Sync extension version with release tag" no job `package`,
que escreve a versão (do input `workflow_dispatch` ou de `github.ref_name` no push de tag, sem o
prefixo `v`) em `extension/package.json` **e** `extension/package-lock.json` (`npm ci` valida que os
dois batem, senão falha com "not in sync") -- só no checkout efêmero do runner, nunca commitado de
volta ao repositório. Relevante porque, mesmo corrigido o CSS, o VS Code só detecta uma extensão como
"atualizada" (e força reload de webviews abertos) quando o número de versão muda de verdade.

### 28.4 Ação imediata recomendada ao usuário (independente do fix de código)

Reinstalar via `code --install-extension ... --force` reescreve os arquivos em disco mas NÃO recarrega
um VS Code já aberto -- extension host e `WebviewView` continuam servindo o conteúdo antigo em memória
até "Developer: Reload Window" ou reiniciar o editor inteiro. Recomendado fechar todas as janelas do VS
Code e reabrir após qualquer reinstalação, não confiar só no `--force` do instalador.

### 28.5 Bug menor encontrado de bônus: ícone ausente de `other.package_pin`

`other.package_pin` referenciava `icon: "package-pin"`, sem nenhum arquivo `.svg`/`.png`
correspondente em `media/components/{light,dark}/` -- caía silenciosamente no fallback
`generic-component`. Criados `package-pin.svg` (light e dark), mesmo estilo/paleta de cores do
`package.svg` existente (retângulo do encapsulamento + 1 pino em destaque com um ponto de solda).
Bug pré-existente, presente igualmente em dev e instalado (não relacionado à causa raiz de 28.1).

## 29. Auditoria completa dos 59 dispositivos vs SimulIDE real (2026-07-13)

Pedido explícito do usuário: varredura completa de TODA categoria/dispositivo registrado, comparando
representação esquemática, Modo Placa, propriedades configuráveis, comportamento elétrico e
persistência contra o SimulIDE real, com evidências concretas (2 screenshots de `outputs.led_bar`
mostrando propriedades ausentes: Cor, lógica de acionamento, GND/VCC do comum, estado visual).

### 29.1 Metodologia

Dado o tamanho (59 dispositivos, 15 categorias), a pesquisa foi paralelizada: 7 agentes em background
(um por categoria: Switches, Motors/Other Outputs, Active, Passive, Sources, Meters, Connectors+Other+
Graphical), cada um lendo o C++ real do SimulIDE (`C:\SourceCode\simulide_2\src`) e comparando contra
`component-catalog.json`/`core/src/app/CoreApplication.cpp`/`core/src/components/**`, devolvendo
achados citados por arquivo:linha (nunca "poderia melhorar" vago). Em paralelo, eu mesmo fiz um
mergulho profundo e uma reescrita real na categoria com evidência concreta do usuário (Leds). Depois
dos 7 relatórios prontos, apliquei um subconjunto de correções de ALTA confiança (JSON/constante
isolada, sem redesenho de arquitetura) diretamente; o resto fica documentado como pendência com
justificativa técnica precisa (não uma correção rasa/forçada só pra "fechar item").

**Achado transversal repetido em quase toda categoria** (não é um bug isolado, é um padrão): muitos
componentes (`dc_motor`/`stepper`/`incandescent_lamp`, `outputs.led` antes desta rodada, `active.diode`
parcialmente) são modelados no Core como um `Resistor`/`ResistorArray` genérico, sem NENHUM estado
dinâmico (ângulo do rotor, brilho, corrente máxima) exposto -- então o `package.simulidePaint`
correspondente é necessariamente estático, mesmo quando o `paint()` real do SimulIDE é dinâmico. Corrigir
isso caso a caso não escala; o padrão certo (aplicado em 29.2) é generalizar no MODELO ELÉTRICO
primeiro (Core), não inventar bindings visuais sem dado real por trás.

### 29.2 Outputs > Leds -- reescrita real (led, led_rgb, led_bar, led_matrix, seven_segment)

**Causa raiz encontrada**: `outputs.led` usava a classe `Diode` (exponencial de Shockley, certa pra
`active.diode`/`active.zener`, ERRADA pro LED real). O LED real do SimulIDE (`eLed::voltChanged()`,
`simulator/elements/outputs/e-led.cpp`) é um modelo PIECEWISE totalmente diferente: abaixo de
`threshold` a perna está essencialmente aberta (condutância de fuga `1e-9`); acima, conduz como um
resistor linear (`resistance`) ancorado exatamente no joelho `(threshold, 0)` via uma fonte de corrente
companion. `led_rgb`/`led_bar`/`led_matrix`/`seven_segment` usavam `DiodeLegArray` (mesma exponencial,
N pernas) com `propertyDescriptors()` retornando `{}` -- ZERO propriedades editáveis, confirmando
exatamente o que o usuário reportou pro Led Bar (sem Cor, sem lógica de acionamento, sem indicar
GND/VCC do comum).

**Corrigido**: `core/src/components/active/DiodeLegArray.hpp` reescrita -- `stamp()` agora usa o modelo
piecewise real (não a exponencial), com propriedades REAIS `Color` (enum, 7 cores, mesmos labels de
`LedBase::getColorList()`), `Threshold` (V, também setável direto, Color só é um preset -- Threshold
salvo pelo usuário nunca é sobrescrito num reload, ver `applyLedProperties` em
`CoreApplication.cpp`), `Resistance` (Ω) -- as MESMAS 3 propriedades pros 5 typeIds de uma vez só
(generalização no sistema comum, não 5 correções isoladas). `outputs.led` migrado de `Diode` (2 pinos
dedicados) pra `DiodeLegArray` com 1 perna só -- unifica a família inteira numa classe e ganha
`current()` de verdade (só existe leitura de corrente via `getComponentCurrent`/IPC quando
`legs.size()==1`, honesto sobre não fingir uma leitura por segmento nos outros 4).

**Simplificações documentadas (não escondidas)**: `Color`/`Threshold`/`Resistance` são UNIFORMES pro
componente inteiro -- fiel ao real `LedBar`/`LedMatrix`/`SevenSegment` (que também aplicam um único
valor a todos os segmentos de uma vez, `ledbar.cpp::setColorStr` propaga a MESMA cor a cada `m_led[i]`,
nunca por-segmento individual -- então "cor individual por LED" que o usuário pediu como opção NÃO é
sequer um recurso do SimulIDE real pra estes tipos, só "geral" existe). `led_rgb` real tem
`Threshold_R/G/B`/`MaxCurrent_R/G/B`/`Resistance_R/G/B` (9 propriedades por-canal) + `CommonCathode`
(toggle Common Anode) -- aqui simplificado pra um valor uniforme + catodo comum fixo, documentado como
pendência (não implementado). `seven_segment` real tem `NumDisplays`/`Vertical_Pins`/`CommonCathode`
-- não portados. `MaxCurrent`/`Grounded` do LED real (que dirigem só a visual de brilho/GND, sem
efeito na equação `stamp()`) foram DELIBERADAMENTE deixados de fora desta rodada -- adicionar uma
propriedade sem efeito observável nenhum ainda violaria a regra do próprio pedido do usuário
("garanta que cada propriedade esteja realmente conectada ao comportamento"); a leitura viva de
brilho (`current()`→intensidade→`stateFill`) que daria sentido a `MaxCurrent` é um recurso de telemetria
NOVO que não existe hoje pra nenhum componente arbitrário (só instrumentos com `readoutFormat`
registrado têm sincronização ao vivo -- ver 29.9).

**Catálogo**: `defaultProperties` dos 5 typeIds atualizado (`color:"Yellow"`, `threshold:2.4`,
`resistance:0.6`, batendo com os defaults reais de `eLed::eLed()`) -- removidos os pares
`threshold`/`resistance` "mortos" que existiam antes sem NENHUM backing real (`outputs.led` tinha
`{threshold:2,resistance:1}` mas o Core só lia `saturationCurrent`; `outputs.led_rgb` tinha só
`{threshold:2}` sem nenhuma propriedade real atrás).

**Testes**: `core/test/zener_led_test.cpp` reescrito -- `testLedForwardVoltage` agora valida o joelho
piecewise real (Vd converge em ~2.4046V com R=1k+fonte 10V, não mais a faixa larga 1.0-3.0V do modelo
exponencial antigo); novo `testLedColorChangesThreshold` prova que `Color="Red"` muda o threshold de
simulação pra ~1.8V de verdade (não é rótulo decorativo).

### 29.3 Correções aplicadas em outras categorias (alta confiança, baixo risco)

- **`switches.push`**: barra do atuador solto desenhava em y=-8, real é y=-6 (`push.cpp:125`) --
  corrigido no `package.simulidePaint` e no teste.
- **`switches.switch_dip`**: default `closed:false` deveria ser `true` (`switchdip.cpp:194`, todas as
  8 posições nascem fechadas no real); housing desenhava `fill:"none"`, real é preenchido `#646478`
  (`QColor(100,100,120)`, `switchdip.cpp:47` + `Component::paint()` real sempre pinta com `m_color`).
- **`switches.keypad`**: os 7 pinos estáticos e os 2 `pinGroups` dinâmicos foram migrados para
  coordenadas canônicas de terminal; antes, o ponto de fiação ficava 4px deslocado do buraco/traço
  desenhado. Corrigido pelo contrato comum `simulide-terminal-v1`, sem flag ou regra específica do
  keypad; testes que validavam a geometria ANTIGA foram atualizados para validar a posição real.
- **`sources.rail`**: faltava `package.initialTransform` (rotação 90° -- `Rail::Rail()` sempre chama
  `setRotation(90)` no construtor, `rail.cpp:43`) -- mesmo mecanismo já usado por `meters.probe`
  (pivô `(-bounds.x,-bounds.y)`, aqui `(4,8)`).
- **`other.ground`**: ângulo do pino salvo como 270, real é 90 (`ground.cpp:33`, `IoPin(90,...)`) --
  corrigido por fidelidade de fonte, embora `length:0` torne isto sem efeito visual observável hoje.
- **`instruments.voltmeter`**: impedância de entrada 10x abaixo do real (`kInputConductance=1e-6`
  = 1MΩ; real `high_imp=1e7` = 10MΩ, `voltmeter.cpp:29`) -- corrigido em `Voltmeter.hpp`.

### 29.4 Bug pré-existente encontrado (não introduzido nesta sessão, documentado e parcialmente corrigido)

`core/test/esp32_devkitc_subcircuit_test.cpp` tem seu PRÓPRIO registro mínimo de componentes
(`registerNeededBuiltins`, independente de `CoreApplication.cpp`) que nunca incluía `outputs.led_bar`
-- confirmado por `git diff` que este arquivo estava intocado antes desta sessão, e por já existir
NO MESMO ARQUIVO um comentário idêntico sobre `sources.rail` ter tido o mesmo problema antes
("faltava aqui, causando 'Unknown component typeId'"). Corrigido o registro (`DiodeLegArray` com
pernas resolvidas de `p.pinList`) e a derivação de id `pin-P{i}`/`pin-N{i}` (o `.lssubcircuit` real
não embute id por pino em `properties`, só x/y -- confirmado que sem essa derivação os ids ficam
vazios/genéricos, nunca batendo com o que os fios do arquivo referenciam).

**Pendência restante** (mesmo teste, mais funda): mesmo com o id forçado corretamente, o teste ainda
falha com `fio interno inválido component-X.pin-P1 -> component-Y.pin-1: invalid stoul argument` --
rastreado até `SimulationSession::connectWire`/`resolveSlot` (`SimulationSession.cpp:198-210`): o
match exato (`slots.find(pinId)`) não está encontrando "pin-P1" nos slots do componente mesmo com o
`Pin.id` correto no vetor construído pela fábrica, caindo no fallback posicional genérico `pin-N`
(que exige sufixo NUMÉRICO puro via `std::stoul`, e "P1" não é). Não investigado mais fundo por
tempo -- pode ser (a) `m_netlist.pinSlotsOf()` construindo slots a partir de outra fonte que não
`component->pins()` no momento do `addComponent`, ou (b) uma diferença sutil entre o pinList que
`ComponentParams` entrega e o que a fábrica de fato usa. Este teste ISOLADO (só ele, dos 40) segue
falhando -- não é regressão desta sessão (já falhava antes, por um motivo diferente e mais raso),
mas também não foi totalmente resolvido. Ver 29.9.

### 29.5 Achados documentados, SEM correção aplicada (fora do escopo desta rodada -- pendências reais)

Resumo por categoria, prioridade e citação -- detalhe completo nos relatórios dos 7 agentes (não
reproduzidos aqui por tamanho; refazer a mesma pesquisa é barato se necessário, os prompts usados
citam arquivo:linha tanto do SimulIDE real quanto do LasecSimul).

- **Active** (`opamp`/`comparator`/`analog_mux`/`volt_regulator`/`diode`/`zener`): **achado de maior
  severidade potencial de toda a auditoria, NÃO verificado visualmente, NÃO corrigido por precaução**
  -- padrão sistemático em 5 de 6 dispositivos onde o ponto elétrico de cada pino parece estar
  deslocado pelo próprio `length` do lead (ex: `active.diode` pino calculado em `(0,32)` quando devia
  ser `(-6,26)`) -- se confirmado numa sessão com GUI, é um bug de fiação real (fios conectariam no
  lugar errado). `active.comparator` reusa a classe `OpAmp` (5 pinos, ganho) em vez de modelar um
  comparador digital de verdade (real: 3 pinos, sem `Gain`, com `Out_High_V`/`Inverted`/etc) --
  mudança de arquitetura, não catalogada aqui. `active.zener`: `defaultProperties` usa chaves
  (`threshold`/`resistance`) que não correspondem a NENHUMA propriedade real do Core
  (`saturationCurrent`/`breakdownVoltage`) -- silenciosamente ignoradas.
- **Passive**: 2 bugs de geometria CONFIRMADOS rodando o renderer de verdade (não só lidos): pinos de
  `passive.potentiometer` e `passive.resistor_dip` renderizam deslocados do corpo (fios pareceriam
  sair do lugar errado). Família "Dialed" (`variable_resistor`/`variable_capacitor`/
  `variable_inductor`) e família Reactive inteira (`capacitor`/`electrolytic_capacitor`/`inductor`)
  não têm ESR (`Resistance`)/`InitVolt` que o real expõe -- Core só modela capacitância/indutância
  pura.
- **Sources**: `sources.wave_gen` nasce ligado por padrão (`alwaysOn=true`), real nasce desligado.
  `sources.voltage_source`/`sources.current_source` não têm nenhum toggle liga/desliga (fonte sempre
  ativa desde que colocada) -- documentado como simplificação intencional já existente, não nova.
- **Meters**: `meters.oscope` falta o 5º pino de referência (`PinG`) que o real usa pra leitura
  DIFERENCIAL -- LasecSimul lê tensão absoluta ao terra em vez de V(canal)-V(ref); além disso
  `filter`/`autoScale`/`tracks`/`sampleIntervalNs` são descartados silenciosamente a cada reload
  (fábrica nunca lê essas properties de volta). `meters.probe`'s `negativeThreshold` é uma propriedade
  "morta" (só usada no lado visual, sem schema real no Core, nunca editável/sincronizada).
- **Connectors/Other/Graphical**: `connectors.bus` é um stub decorativo de 1 pino sem NENHUMA
  semântica de fan-out multi-bit do `Bus` real (achado de maior severidade da categoria).
  `connectors.socket`/`connectors.header` têm o ponto elétrico dos pinos deslocado +24px e no ângulo
  errado em relação aos buracos desenhados (confirmado, mesma classe de bug do Active). 5 tipos
  `graphics.*` faltam `Opacity` (todos) e `Border`/`strokeWidth` configurável (`ellipse` especificamente,
  inconsistente com `rectangle` que já tem).

### 29.6 Verificação final

Extension: suíte completa **228/228 passando** (2 testes reescritos pra refletir geometria corrigida
de push/keypad, contagem final igual), 3 tsconfigs compilando limpos. Core: **39/40 testes passando**
(`zener_led`/`voltmeter`/`diode` cobrindo as mudanças desta rodada, todos verdes; único vermelho é
`esp32_devkitc_subcircuit`, pré-existente e parcialmente investigado, ver 29.4). Sem GUI disponível
neste ambiente -- os 2 bugs de geometria de Passive foram confirmados executando o renderer de
verdade (não visual), os 5 do Active NÃO foram confirmados visualmente e por isso não foram corrigidos
às cegas.

### 29.7 Pendências e recomendação de próxima rodada

Por ordem de valor esperado:
1. Verificar visualmente (sessão com GUI/Extension Development Host) o padrão sistemático de pinos
   deslocados do Active (5 dispositivos) -- se confirmado, é a correção de maior impacto restante
   (fiação visualmente errada, não só cosmético).
2. Corrigir os 2 bugs de geometria confirmados do Passive (`potentiometer`/`resistor_dip`) -- mesma
   classe de bug do Active, já com posições corretas calculadas nos relatórios dos agentes.
3. Investigar a fundo `SimulationSession::connectWire`/`resolveSlot` (29.4) -- possível bug real de
   resolução de pino por id fora do fallback puramente numérico, não só um problema do teste.
4. Telemetria de corrente/intensidade genérica (não só pros LEDs) -- generalizaria o binding visual
   dinâmico pra motor/lâmpada/LED de uma vez, resolvendo o achado transversal da seção 29.1.
5. `connectors.bus` como componente real (fan-out multi-bit) -- maior gap funcional isolado
   encontrado.

### 29.8 Errata normativa e fechamento das pendencias prioritarias (2026-07-13)

Esta secao registra o estado final posterior a 29.4--29.7 e **substitui expressamente** as indicacoes
de pendencia e os resultados de testes ali documentados para os itens abaixo. As secoes anteriores
permanecem apenas como historico da auditoria e da investigacao.

#### 29.8.1 Geometria e referencia de coordenadas

Confirmou-se que a causa raiz do deslocamento visual nao era uma translacao arbitraria do renderer,
mas a mistura de duas convencoes no catalogo: algumas coordenadas descreviam o contato com o corpo e
outras ja descreviam o terminal eletrico. A correcao sistemica e o contrato
`simulide-terminal-v1`, definido em 13.1.1: toda coordenada `PackagePin.x/y` e o terminal eletrico,
enquanto o contato com o corpo e derivado de `angle`/`length` pela infraestrutura comum. Nao existe
flag que altere a semantica eletrica por dispositivo, `leadOrigin` no modelo canonico nem helper
geometrico duplicado. `coordinateSpace: "simulide-local"` apenas declara que todo o pacote conserva
o referencial nativo (`QPoint`/`m_area`); ele aciona a mesma normalizacao de corpo, pinos e labels e
nao constitui uma formula ou offset especial do dispositivo.

- `active.diode`, `active.zener`, `active.opamp`, `active.comparator`,
  `active.volt_regulator`, `outputs.led`, `outputs.led_rgb`, `outputs.led_bar`,
  `outputs.led_matrix` e `outputs.seven_segment` foram migrados como consumidores do mesmo contrato;
  nao constituem excecoes. O ponto visual e o ponto logico coincidem nas rotacoes 0, 90, 180 e 270
  graus e sob espelhamento.
- Em `led_bar`/`led_matrix`, o layout parametrico tambem corrige a caixa resolvida: os pinos deixam de
  puxar artificialmente o topo do componente e expandem apenas os lados/borda onde o terminal existe.
- `active.comparator` deixou de reutilizar o modelo de `OpAmp` de cinco pinos. Passou a ser um
  comparador real de tres pinos (`in+`, `in-`, `out`), com `outputHighVoltage` e `inverted` ligados
  ao comportamento eletrico.
- `passive.potentiometer` teve os dois terminais laterais e o terminal do cursor alinhados ao desenho
  real; `passive.resistor_dip` teve as origens de corpo/lead corrigidas e normalizadas pelo bounds.
- Rotacao, posicao e propriedades desses tipos continuam persistidas e reconstruidas sem alterar a
  topologia eletrica.

As coordenadas foram derivadas diretamente das fontes do SimulIDE para diodo, amplificador
operacional, comparador, regulador, potenciometro e resistor DIP, e validadas pelo mesmo resolvedor
usado pela Webview, incluindo limites do simbolo e coincidencia terminal/logica.

#### 29.8.2 Barramento funcional (`connectors.bus`)

`connectors.bus` deixa de ser um stub decorativo e passa a ser um endpoint vetorial real. A convencao
normativa e:

- largura configuravel de 1 a 64 bits e propriedade `startBit`;
- ordem LSB-first: o indice interno 0 representa `bit-startBit`; visualmente o vetor representa
  `[startBit + width - 1 : startBit]`;
- `bus-in` e `bus-out` sao aliases vetoriais equivalentes para os mesmos bits escalares ordenados;
- conexao vetor-vetor exige larguras iguais e expande, na compilacao da topologia, para pares de
  slots escalares; incompatibilidade de largura e rejeitada com erro explicito;
- split e merge sao feitos conectando `bit-N` individualmente ou conectando os endpoints vetoriais;
- bits desconectados permanecem em nivel baixo pela condutancia de fuga do modelo, sem estado
  indefinido; a leitura de estado expoe uma mascara digital de 64 bits com limiar de 2,5 V;
- alteracoes de `width` ou `startBit` afetam pinagem/topologia e exigem a recompilacao normal do
  grafo; conexao, desconexao e rebuild preservam o mapeamento deterministico;
- largura, bit inicial e fios sao persistidos pelo mecanismo generico do projeto. A representacao
  visual gera `bit-0` corretamente (sem o antigo fallback indevido para `bit-1`).

Essa solucao evita copiar valores por evento entre objetos: o barramento e resolvido para os mesmos
nos/slots escalares na topologia MNA, mantendo o caminho de simulacao compacto e sem alocacao por
passo.

#### 29.8.3 Osciloscopio e persistencia generica de instrumentos

`meters.oscope` agora possui os cinco pinos do SimulIDE: quatro canais e a referencia comum. Quando o
quinto pino esta conectado, cada canal mede `V(canal) - V(ref)` e os companions de entrada sao
carimbados entre canal e referencia. Quando ele esta desconectado, o comportamento legado e mantido:
a referencia equivale ao GND, evitando quebrar projetos antigos de quatro fios.

A hidratacao inicial de propriedades em `SimulationSession::addComponent` foi generalizada: todo
parametro cujo nome corresponda a um descritor do componente e aplicado ao modelo. Com isso,
`filter`, `autoScale`, `tracks`, `sampleIntervalNs` e as propriedades equivalentes dos demais meters
nao dependem mais de whitelists por fabrica e sobrevivem ao ciclo salvar/carregar.

#### 29.8.4 Subcircuitos, identificadores semanticos e ciclo de vida

A falha de `esp32_devkitc_subcircuit_test` foi eliminada. A causa raiz era a perda de `pinList` antes
da instanciacao do componente interno: os fios conservavam identificadores como `pin-P1`, mas o
netlist so possuia a pinagem generica reconstruida. A expansao de subcircuito agora recompõe a lista
de pinos a partir dos metadados, da especificacao de pinos e de todos os identificadores semanticos
referenciados pelos fios antes de criar o modelo. O fallback numerico de `connectWire` tambem valida
o sufixo e retorna erro de pino inexistente, em vez de deixar escapar `std::stoul`.

Durante a validacao foi encontrada e corrigida uma segunda causa independente: a hidratacao generica
podia aplicar `Clock.alwaysOn` antes de o componente receber um indice, marcando `UINT32_MAX` como
dirty e fazendo a estrutura esparsa tentar crescer excessivamente. `Clock` agora agenda/marca apenas
depois de ter indice valido. O pool de memoria deixa de ser pressionado por essa inicializacao.

#### 29.8.5 Contratos de arquitetura

O contrato de componente ganhou dois pontos deliberadamente pequenos e gerais:

- `busEndpointPinIds(endpoint)` descreve, quando aplicavel, a expansao ordenada de um endpoint
  vetorial; componentes escalares continuam retornando vazio e nao sofrem custo adicional;
- `onPinConnectionChanged(pinIndex, connected)` informa o estado de conexao externa apos cada rebuild,
  permitindo ao osciloscopio escolher referencia diferencial ou compatibilidade com GND sem consultar
  objetos da interface.

Esses contratos mantem a resolucao no Core, separada da Webview, e nao introduzem `new`, tarefas ou
IPC no loop de simulacao.

#### 29.8.6 Validacao final que substitui 29.6

- build completo do Core em Debug concluido com sucesso (MSVC, paralelismo 2);
- suite completa do Core: **41/41 testes passando**, incluindo o teste ESP32/subcircuito antes
  vermelho e a nova cobertura de barramento;
- barramento coberto por padrao de 8 bits `0xA5`, leitura/escrita por bit, vetor de mesma largura,
  rejeicao 8-vs-4, split/merge, desconexao/reconexao, rebuild e mascara de estado;
- osciloscopio coberto em modo legado (referencia desconectada) e diferencial (`3,3 - 1,3 = 2,0 V`),
  alem de historico e hidratacao de propriedades;
- suite completa da Extension concluida sem falhas, com os tres tsconfigs compilando; testes do
  renderer de simbolos: **58/58 passando**, incluindo os cinco ativos nas quatro rotacoes, as duas
  geometrias passivas e os bits visuais do barramento;
- serializacao cobre round-trip generico das propriedades de todos os meters e round-trip de
  posicao/rotacao das geometrias alteradas.

Nao restam pendencias funcionais dentro do escopo solicitado nesta rodada: geometria dos cinco ativos
e dos dois passivos, barramento multi-bit, referencia diferencial do osciloscopio, persistencia de
meters e falha do subcircuito ESP32 estao implementados e cobertos. Itens mais amplos ja listados em
29.5 (por exemplo telemetria visual generica de motores/lampadas ou novas propriedades de familias
reativas) continuam sendo evolucoes separadas e nao bloqueiam este fechamento.

### 29.9 Interface expandida comum dos instrumentos (2026-07-13)

Os popups de `meters.oscope` e `meters.logic_analyzer` compartilham obrigatoriamente a mesma
infraestrutura visual (`instrument-popup`, chassis, cabecalho, bezel do plot, secoes de controle,
legenda e comportamento responsivo). Eles nao devem voltar a manter layouts ou temas independentes.
A estrutura funcional do SimulIDE permanece como referencia: plot 10 x 8, controles laterais,
canais identificados por cor, base/posicao de tempo, escala/posicao de tensao e disparo.

Contrato do renderer de instrumentos:

- a grade possui divisoes principais, cinco subdivisoes menores e eixos centrais distintos;
- traces analogicos sao continuos e traces digitais usam sample-and-hold ortogonal, sem diagonais
  entre estados logicos;
- a legenda deriva das mesmas cores e do mesmo estado de visibilidade usados pelo trace;
- os controles continuam ligados ao estado persistente existente; a reformulacao visual nao cria
  uma segunda fonte de estado nem altera o protocolo Core/Webview;
- em viewport estreito os controles passam para baixo do plot e o SVG preserva a proporcao 10:8,
  sem corte ou overflow horizontal obrigatorio;
- novas funcoes comuns devem ser adicionadas aos helpers de instrumentos em `main.ts` ou
  `instrumentTrigger.ts`, nunca copiadas separadamente para os dois popups.

`digitalStepPath` e coberto por teste puro que exige arestas verticais e patamares horizontais. A
suite completa da Extension, incluindo compilacao dos tres tsconfigs, deve permanecer verde.

### 29.10 Canais de instrumentos por nome de Tunnel (2026-07-13)

Oscope e Logic Analyzer devem aceitar, em cada campo colorido, o nome de um `connectors.tunnel` da
mesma sessao. A referencia normativa e o SimulIDE real:

- `src/gui/dataplotwidget/datawidget.cpp:71-88`: `QLineEdit::editingFinished` chama
  `Oscope::channelChanged`, e `setTunnel` restaura o texto;
- `src/gui/dataplotwidget/datalawidget.cpp:54-83`: mecanismo identico nos oito canais digitais;
- `src/gui/dataplotwidget/plotbase.h:86` e `plotbase.cpp:239-244`: cada `DataChannel` guarda
  `m_chTunnel` e a propriedade `Tunnels` serializa a lista;
- `src/components/meters/oscope.cpp:129-141` e `logicanalizer.cpp:139-153`: primeiro verifica o
  conector fisico; somente se estiver desconectado chama `Tunnel::getEnode(nome)`;
- `src/components/meters/oscope.cpp:210-217` e `logicanalizer.cpp:292-299`: `setTunnels` hidrata os
  canais e os campos ao reabrir.

No LasecSimul, `IComponentModel::fallbackTunnelNameForPin` e `Netlist::setFallbackTunnelName`
generalizam essa semantica. Um fallback nao cria uma rede sozinho: ele so se une a um grupo criado
por Tunnel real do mesmo nome. Um fio fisico no pino desativa o fallback; ao remover o fio, o nome
persistido volta a valer automaticamente. A propriedade `tunnels` e uma lista CSV com exatamente
um campo por canal e participa do salvar/carregar generico.

Os campos compactos sao inputs reais em `foreignObject`, portanto acompanham as transformacoes SVG
do componente. As janelas expandidas expoem os mesmos valores, sem segunda fonte de estado. Testes
obrigatorios cobrem nome existente, nome inexistente, prioridade de fio, reativacao apos desconectar,
round-trip e renderizacao dos inputs.

#### 29.10.1 Layout compacto do Logic Analyzer

`DataLaWidget.ui` e a fonte normativa do empilhamento: oito `QLineEdit` de 60 x 14 e
`QVBoxLayout::spacing = 2`, seguidos por `CustomButton` de 60 x 16. A posicao vertical deve ser
derivada desses valores. Para o layout nativo atual, o oitavo canal ocupa `y=120..134` e o botao
comeca em `y=136`. A antiga constante `y=132` era incorreta e sobrepunha duas unidades do ultimo
campo verde. Teste de markup deve impedir a reintroducao dessa sobreposicao.

### 29.11 Janelas expandidas de instrumentos em tempo real (2026-07-13)

Esta secao substitui o escopo apenas visual de 29.9 por um contrato funcional verificavel. O
baseline anterior a implementacao foi comparado diretamente com o SimulIDE local de referencia:

| Aspecto | SimulIDE | baseline do LasecSimul | requisito normativo |
|---|---|---|---|
| composicao | `OscWidget`/`LaWidget` (`QDialog` + `.ui`) hospedam um `PlotDisplay` comum | popup DOM com SVG fixo de 560 x 448 | chassis responsivo e viewport comum, dimensionado pelo espaco real |
| desenho | `PlotDisplay::paintEvent` usa `QPainter`, `QPen` e antialiasing | SVG recriado integralmente em cada atualizacao | camada de plot reutilizavel, sem bloquear a thread da Webview |
| grade | 10 divisoes de tempo, trilhas/8 linhas e marcas centrais | 10 x 8 com subdivisoes, mas dimensao rigida | 10 divisoes, eixos e marcas conservados em qualquer tamanho |
| navegacao | `wheelEvent` altera `timeDiv` em 20% e ancora o tempo sob o cursor; arrasto horizontal altera `timePos` | somente knobs/campos | wheel ancorado, pan horizontal e reposicionamento do zero de tempo |
| medicoes | cursor, tempo e tensao sob o mouse; maximos/minimos analogicos | sem cursor nem leituras no plot | crosshair e leituras derivados da mesma transformacao tempo/valor |
| traces | sample-and-hold e decimacao min/max; digital ortogonal; barramento com hexadecimal | analogico diagonal; digital ortogonal | analogico sample-and-hold com envelope por pixel; digital/bus sem diagonais |
| redimensionamento | layouts Qt e `PlotDisplay::updateValues()` usam `width()`/`height()` correntes | tamanho fixo, apenas fallback CSS estreito | resize livre, limites minimos e nenhum controle sobreposto |
| persistencia | propriedades do `PlotBase`/instrumento guardam escalas, posicoes, trigger, canais e tunnels | a maior parte do estado vive apenas no `Map` aberto | estado de viewport/controles/janela serializado no componente |
| ciclo de simulacao | o componente atualiza o buffer; a janela apenas apresenta; ao pausar o ultimo quadro permanece | polling IPC assincrono ja desacoplado | preservar polling assincrono, congelar na pausa e continuar/reiniciar sem timer de UI concorrente |

Referencias normativas exatas do SimulIDE:

- `src/gui/dataplotwidget/plotdisplay.cpp:19-60`, construcao, cores, fontes e mouse tracking;
- `plotdisplay.cpp:67-105`, janela temporal e geometria recalculada pelo tamanho real;
- `plotdisplay.cpp:108-132`, zoom de wheel ancorado no cursor;
- `plotdisplay.cpp:135-179`, grade, eixos, trilhas e marcas;
- `plotdisplay.cpp:181-340`, pintura, cursor, sample-and-hold e decimacao min/max;
- `oscwidget.h:15` e `lawidget.h:16`, dialogs Qt; `oscwidget.cpp:13-81` e
  `lawidget.cpp:15-41`, grupos de canais e controles;
- `oscwidget.cpp:378-399` e `lawidget.cpp:180-201`, pan e zero de tempo;
- `oscope.cpp:160-178` e `logicanalizer.cpp:172-190`, transferencia do mesmo display entre modo
  compacto e expandido;
- `lawidget.cpp:161-170`, exportacao VCD.

A implementacao no LasecSimul deve usar um unico `InstrumentViewport` puro para conversao
tempo/valor/pixel, zoom, pan, cursor e limites; um unico codec versionado de estado persistente; e
um unico chassis responsivo. Osciloscopio e analisador so fornecem configuracao de canais e o
renderer analogico/digital. O estado de UI deve ser salvo numa propriedade reservada `__ui_` para
participar do `.lsproj` sem atravessar nem acoplar o Core de simulacao.

#### 29.11.1 Estado implementado e validacao

`instrumentViewport.ts` e a implementacao comum. A janela usa resize nativo com bounds, o plot
preenche o espaco flexivel, wheel preserva o tempo sob o cursor, arrasto faz pan e botao central
reposiciona o zero. O cursor informa tempo e, no osciloscopio, tensao. Traces analogicos usam
sample-and-hold com envelope min/max limitado por coluna de pixel; digitais permanecem ortogonais.
Atualizacoes de historico substituem apenas o SVG, nunca toda a janela. A propriedade versionada
`__ui_instrumentView` persiste controles e geometria sem atravessar o Core. Stop limpa buffers, pause
conserva o quadro e o analisador exporta VCD em 1 ns.

Validacao obrigatoria cumprida: build Debug do Core concluido; Core 41/41; suite completa da
Extension verde, incluindo `instrumentViewport` (zoom ancorado, pan, clamp, codec, sample-and-hold,
preservacao de pico e VCD), `instrumentTrigger` 11/11 e renderer 63/63.

As antigas pendencias de barramento vetorial, condicao executada no Core e validacao visual real
foram fechadas pelo contrato normativo 29.12 abaixo; este paragrafo nao deve voltar a descrever o
estado anterior como limitacao atual.

### 29.12 Sinais vetoriais, pausa deterministica e E2E real (2026-07-13)

Esta secao substitui as pendencias finais de 29.11.1. A fonte unica de resolucao e o contrato Core
`SignalSubscription` -> `ResolvedSignal`/`SignalDescriptor`; Analyzer e expressoes de pausa nao podem
manter resolvers paralelos. Uma referencia aceita componente/pino, alias, tunnel, barramento inteiro,
elemento (`BUS[3]`) ou intervalo (`BUS[7:4]`). O vetor interno permanece LSB-first; `msb`/`lsb` no
descritor conservam a apresentacao solicitada.

#### 29.12.1 Protocolo IPC v2 e Analyzer vetorial

- `PROTOCOL_VERSION` e 2 nos dois processos; v1 e recusado pelo handshake com mensagem explicita.
- `ReadoutKind::VectorHistory`/`vectorHistory` substitui `bitmaskHistory` para o Analyzer. O legado
  continua decodificavel e vira canais de largura 1 ao carregar; projetos antigos sem
  `signalChannels` materializam os oito pinos fisicos como oito subscriptions escalares.
- `signalChannels` e JSON persistido com `id`, `source`, `label` e `kind`; admite 1..32 canais, cada
  um com 1..64 bits. A UI expande visualmente `DATA` em `DATA[n]`, sem converter o contrato Core em
  canais escalares hardcoded.
- O blob V2 contem mascara escalar legada, magic `LAV2`, versao, descritores (id/label/source/kind,
  width/msb/lsb), quantidade e amostras `{timestampNs, packedValues}`. Cada valor usa exatamente
  `ceil(width/8)` bytes; inteiros de 64 bits atravessam JSON de eventos como decimal string para nao
  perder precisao no JavaScript.
- A aquisicao so percorre `m_signalSubscribers`; `wantsResolvedSignalSample(timestamp)` e consultado
  antes de resolver/alocar vetores. Nao ha varredura global nem trabalho de barramento antes do
  intervalo. IPC de notificacao usa fila dedicada, nunca bloqueia o scheduler.

#### 29.12.2 Linguagem e instante semantico da pausa

`PauseExpression` implementa lexer, parser, AST e avaliador deterministico, sem `eval`. Gramática:
literais decimais/hex/booleanos; `!`, `&&`, `||`; `==`, `!=`, `<`, `<=`, `>`, `>=`; parenteses;
referencias; `V(x)`, `digital(x)`, `I(x)`, `rising(x)` e `falling(x)`. Erros informam coluna e
contexto; simbolos, indices e tipos sao validados pelo mesmo resolver de sinais do Analyzer.

A expressao e avaliada no Core depois de os componentes atualizarem e o settle convergir, depois do
commit do passo aceito e antes do proximo passo. Ao ocorrer `false -> true`, o scheduler pausa
preservando aquele estado e publica `pauseConditionTriggered` com owner, expressao, timestamp e
valores resolvidos. Condicao nivel-alto nao redispara ate voltar a falso. `rising`/`falling` mantem
estado anterior por execucao e e resetado ao registrar/reiniciar. Condicao vazia remove o registro;
erro em runtime (sinal removido/largura alterada) pausa e e notificado uma vez. Retomar libera o
scheduler antes de `start`; a UI publica running antes do request para uma pausa no primeiro passo
nao ser sobrescrita pela resposta tardia de start.

#### 29.12.3 Harness visual normativo

`extension/test/e2e/run-webview-e2e.cjs` deve executar a extensao numa distribuicao VS Code 1.128.0
isolada por `@vscode/test-electron`, abrir a Webview real, carregar a fixture pelo serializer/Core
reais, abrir os dois instrumentos, iniciar sinais deterministas, observar pausa do Core, redimensionar
e reabrir. HTML isolado nao satisfaz este contrato.

Viewport e DPR sao 1440x1000 e 1. Fontes sao aguardadas; animacoes sao desativadas. Baselines
versionados ficam em `extension/test/e2e/snapshots`. `pixelmatch` usa threshold 0,12, ignora AA e
aceita no maximo 0,5% de pixels; expected/actual/diff e `results.json` sao artefatos. Atualizacao de
baseline so ocorre com `UPDATE_SNAPSHOTS=1`; a execucao normal deve comparar sem sobrescrever.

Validacao desta versao: build Debug completo; Core 43/43; Extension completa verde; E2E normal com
0 pixels diferentes nos dois snapshots. Carga Debug de 32 canais x 64 bits x 1024 amostras:
271078 bytes serializados e 49102 us de aquisicao total (aprox. 48 us por amostra extrema). Esse
numero e baseline de regressao, nao promessa de Release; qualquer mudanca deve preservar os gates
de assinantes, intervalo e packing e repetir a medicao.

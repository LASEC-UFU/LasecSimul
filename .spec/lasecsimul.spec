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
│       │   └── symbolAuthoring.ts   # seed/compile PackageDescriptor <-> sessão de autoria visual
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
  `seven_segment`: 8 pernas (a-g+ponto) pro catodo comum — suporta `shortedPairs` (condutância alta
  entre dois índices de pino SEM diodo) porque o package tem DOIS pinos comuns
  (`commona`/`commonb`) que no hardware real são o MESMO net, exposto duas vezes só pra solda.
- **`outputs.dc_motor`/`outputs.incandescent_lamp`** — `components::Resistor` direto (2 pinos,
  reaproveitado sem mudança). **`outputs.stepper`** — `components::ResistorArray` (2 bobinas
  independentes, A+/A- e B+/B-). Nenhum modela torque/rotação/back-EMF/resistência variável com
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
core/src/mcu/FirmwareWatcher.{h,cpp}   // poll(folder) -> optional<caminho mais recente>; QemuProcessManager
                                        // chama em cada tick e compara com o caminho/mtime já carregado
```

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

### 17.3 Duas pilhas (principal x autoria), independentes

`enterSymbolAuthoring()`/`exitSymbolAuthoring()` (`main.ts`) trocam a variável `state` inteira (o
circuito real vira `realCircuitState`, `state` passa a apontar pro `package`/circuito interno sendo
editado). Duas `UndoHistory` separadas (`mainUndoHistory`/`authoringUndoHistory`), escolhidas em
runtime por `activeUndoHistory()` (checa `symbolAuthoringContext`) -- desfazer dentro da sessão de
autoria nunca enxerga o histórico do circuito principal, e vice-versa. `authoringUndoHistory` é
resetada (`resetUndoHistory`) toda vez que `enterSymbolAuthoring()` roda (entrar na sessão, ou trocar
de vista Físico/Símbolo Lógico) -- cada sessão de autoria começa com histórico limpo, de propósito
(não haveria como desfazer "para fora" de uma sessão anterior já fechada). `mainUndoHistory` é
resetada só em `"init"` (1ª carga/reload do painel).

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

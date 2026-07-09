# LasecSimul

## Objetivo

LasecSimul é um simulador eletrônico para VSCode inspirado no SimulIDE-dev, mas com arquitetura própria: UI em TypeScript na Extension e simulação em um processo Core nativo C++ separado.

## Escopo

Este README é a porta de entrada do projeto. Ele resume como navegar, compilar e validar o MVP sem substituir as specs nem a documentação operacional em `docs/`.

## Arquitetura resumida

- `extension/`: VSCode Extension Host em TypeScript. Abre comandos, webviews, painéis e orquestra o projeto. Nunca calcula simulação elétrica e nunca gerencia QEMU diretamente.
- `core/`: processo C++ nativo. Dono de `SimulationSession`, `Netlist`, `Scheduler`, `MnaSolver`, registries, plugins nativos e integração QEMU.
- `devices/`: bibliotecas de dispositivos customizados nativos DLL/SO via ABI C estável.
- `mcu-adapters/`: adaptadores de MCU, com MCUs sempre emulados por QEMU.
- IPC: toda comunicação Extension/Core passa por `CoreClient` e pelo `IpcServer` do Core.

## Estrutura do repositorio

Use este mapa para se orientar rapidamente:

- `core/`: codigo-fonte C++, headers publicos, testes acoplados ao Core e diretorio oficial de build em `core/build/`.
- `extension/`: manifest da extensao VSCode, fontes TypeScript, webview e testes da extensao.
- `devices/`: manifests declarativos e plugins nativos por dispositivo. Os artefatos finais esperados pelos manifests ficam em `build/<plataforma>/`.
- `mcu-adapters/`: adapters de MCU e manifests relacionados.
- `project/schema/`: schema `.lsproj` e catalogo unificado de componentes.
- `docs/`: visao geral, ADRs, roadmap e documentacao operacional.
- `test/`: ponto de entrada de testes compartilhados, fixtures e areas reservadas para integracao/E2E.
- `scripts/`: scripts agregados de build/test usados a partir da raiz.
- `examples/`: projetos de exemplo para validacao manual.
- `tasks/`: backlog por agente, util como historico de execucao.

## Convencoes de organizacao

- Versionar codigo-fonte, manifests, schemas, docs e fixtures.
- Nao versionar artefatos gerados: `*.obj`, `node_modules/`, saidas de `tsc`, caches do CMake e diretorios de build intermediarios.
- Usar `core/build/` como diretorio oficial de build do Core quando trabalhar pela raiz do projeto.
- Usar `devices/<nome>/build/` apenas para o artefato final empacotado do plugin; caches intermediarios de CMake ficam fora do controle de versao.

## Status

MVP funcional de ponta a ponta, com limitações conhecidas documentadas em
[`docs/mvp-limitacoes.md`](docs/mvp-limitacoes.md). Core compila e passa 34/34 testes via `ctest`
(Netlist, Scheduler, MnaSolver, passivos, não-lineares (diodo/zener/LED), lógica — incluindo DLL
real de `devices/simulide-logic` —, remoção de componente, subcircuito ESP32 DevKitC/WROOM-32 real,
plugins — incluindo DLL real de `devices/example-blinker` —, QEMU bridge, ESP32 adapter,
orquestrador `McuController` contra o binário real do QEMU, `PropertyDefinition`/contrato de
propriedade unificado e resiliência de MCU a crash de plugin). Extension compila (Host + Webview) e
passa 15/15 testes. Extension
envia componentes/fios desenhados na Webview para o Core via IPC
(`addComponent`/`connectWire`/`setProperty`/`removeComponent`) e tem comandos para salvar/abrir
`.lsproj` (`lasecsimul.saveProject`/`lasecsimul.openProject`) — validado manualmente carregando
[`examples/mvp-passive.lsproj`](examples/mvp-passive.lsproj) contra o binário real do Core.

## Stack principal

- Extension: TypeScript, VSCode API, Webview.
- Core: C++20, CMake, Eigen.
- Plugins: DLL/SO com ABI C em `core/include/lasecsimul/device_abi.h` e `mcu_abi.h`.
- QEMU: processo externo por chip, arena de memória compartilhada e dispatch por faixa de endereço.
- Testes planejados: unitários, integração headless e E2E Extension + Core.

## Fontes de verdade

- [Skill do projeto](.skill/lasecsimul.skill)
- [Catálogo unificado de componentes](project/schema/component-catalog.json) — ponto único para:
   definição dos itens da UI (paleta), hierarquia de pastas/subpastas (`folderPath`) e bibliotecas
   ABI que a Extension manda o Core carregar (`deviceLibraries`).
- [Spec principal](.spec/lasecsimul.spec)
- [Spec de plugins nativos](.spec/lasecsimul-native-devices.spec)
- [Spec de subcircuitos](.spec/lasecsimul-subcircuits.spec) — terceiro caminho de extensibilidade (dado, não código); implementado (`.lssubcircuit` de arquivo único, expansão real via `SimulationSession::addSubcircuitInstance`, testado em `core/test/subcircuit_test.cpp`/`esp32_devkitc_subcircuit_test.cpp`).
- [Spec WASM superseded](.spec/archive/lasecsimul-wasm-devices.spec), apenas histórico, não usar como arquitetura ativa.
- [Documentação operacional](docs/00-visao-geral.md)
- [Tarefas por agente](tasks/agent-01-estrutura-repositorio.md)

## Configurar ambiente

1. Instalar Node.js LTS e VSCode.
2. Instalar CMake 3.20+ e um compilador C++20.
3. Garantir acesso à internet no primeiro configure do Core para baixar Eigen via CMake `FetchContent`.
4. Instalar QEMU modificado por chip apenas quando trabalhar no fluxo ESP32/QEMU.

## Build agregado (raiz)

A raiz do repositório tem um `package.json` próprio (não confundir com `extension/package.json`, que é o
manifest da extensão VSCode) só com scripts agregados de build/test, implementados em Node puro
(`scripts/*.js`) para funcionar de forma idêntica em PowerShell, bash ou zsh — sem depender de um shell
específico:

```
npm run build            # builda Extension e depois Core
npm run build:extension  # só Extension (npm install + tsc)
npm run build:core       # só Core (cmake -S core -B core/build && cmake --build core/build)
npm run build:devices    # compila devices/example-blinker (DLL/SO real) e copia pra build/<plataforma>/
npm run watch:extension  # tsc -w na Extension
npm run test:core        # ctest --test-dir core/build (requer build:core antes)
npm run test:extension   # delega para "npm test" dentro de extension/
```

Estes comandos são equivalentes aos passos manuais abaixo — use os agregados no dia a dia, os manuais para
depurar um passo específico.

## Compilar Extension

```powershell
cd LasecSimul/extension
npm install
npm run compile
```

## Compilar Core

Caminho direto (usado pela verificação obrigatória do agente 01 e pelo script `build:core`):

```powershell
cd LasecSimul
cmake -S core -B core/build
cmake --build core/build
```

Alternativa com presets (`core/CMakePresets.json`), útil para escolher generator explicitamente (Ninja
Multi-Config nas três plataformas, ou Visual Studio 16 2019 no Windows):

```powershell
cd LasecSimul/core
cmake --list-presets
cmake --preset ninja-multi
cmake --build --preset ninja-multi-debug
```

Os dois caminhos resolvem para o mesmo diretório de build, `core/build` — é o caminho que
`extension/src/extension.ts` espera ao spawnar `lasecsimul-core` (`../core/build/lasecsimul-core`,
relativo a `extension/`). Não mover esse diretório sem atualizar `extension.ts` (ver "Observações de
integração" em `tasks/agent-01-estrutura-repositorio.md`).

O `FetchContent` do Eigen baixa o código via git na primeira configuração — exige rede; se a rede cair no
meio do clone, apague `core/build/_deps` e rode o configure de novo.

Se o repositório estiver dentro de uma pasta sincronizada por nuvem (Google Drive, OneDrive,
Dropbox), aponte `-B` para um caminho local fora dela (ex: `cmake -S core -B C:\ls-build`) e use o
preset `windows-msvc` em vez de Ninja — Ninja Multi-Config entra em loop de "manifest still dirty"
e o `FetchContent` pode falhar com erro de acesso negado nesse tipo de pasta (ver
`docs/mvp-limitacoes.md`).

## Rodar testes

Estrutura e plano em [`test/`](test/README.md) e [docs/13-testes.md](docs/13-testes.md). Hoje 19
testes nativos passam via CTest (Netlist, UnionFind, Scheduler, SparseSet, CoreBootstrap,
CircuitGroup, MnaSolver, PassiveComponents, LogicComponents, ComponentRemoval, PluginLoader,
PluginLoaderRealDll, PluginRuntime, QemuProcessManager, QemuArenaBridge, McuControllerRealQemu,
FirmwareWatcher, Esp32Adapter, voltage_divider). `PluginLoaderRealDll` e `McuControllerRealQemu`
pulam (sem falhar) se os artefatos externos não existirem — rode `npm run build:devices` antes do
primeiro para validar carregar o DLL real de `devices/example-blinker`; o segundo precisa do fork
QEMU compilado em `qemu-simulide/` (sibling deste repositório, ver `docs/mvp-limitacoes.md`):

```powershell
cd LasecSimul
npm run build:core
npm run test:core
# equivalente manual: ctest --test-dir core/build --output-on-failure
```

Extension tem suites TypeScript/headless para projeto, IPC, catalogo, paleta, geometria de fios,
renderizacao de componentes e decisao de trust, sem framework externo. Compila e roda via `node`:

```powershell
cd LasecSimul/extension
npm test
```

Ainda faltam testes de ativação real do VSCode (`@vscode/test-electron`) e testes automatizados de
integração/E2E formalizados em `test/integration/`/`test/e2e/` — ver `docs/mvp-limitacoes.md`.

## Iniciar o MVP

1. Abrir o workspace no VSCode.
2. Compilar a Extension.
3. Compilar o Core.
4. Executar o comando `LasecSimul: Open Schematic Editor`.
5. Adicionar passivos pela paleta nativa, conectar fios e editar propriedades — cada ação é
   enviada ao Core via `CoreClient` (`addComponent`/`connectWire`/`setProperty`) automaticamente.
6. `LasecSimul: Save Project As...` / `LasecSimul: Open Project...` salvam/abrem `.lsproj` e, ao
   abrir, recriam o circuito no Core na ordem certa (componentes antes dos fios). Ver
   `examples/mvp-passive.lsproj` para um projeto de exemplo já validado.

O simbolo grafico de dispositivos registrados e carregado do `package` declarado no `.lsdevice`/
`.lssubcircuit`. Nesta etapa nao ha fluxo de edicao manual de simbolo pela UI; alteracoes de simbolo
devem ser feitas no manifesto versionado.

## Roadmap resumido

- MVP 1: estrutura, Extension, Core bootstrap, IPC e projeto `.lsproj`.
- MVP 2: Netlist, Scheduler, MNA com Eigen e passivos R/C/L.
- MVP 3: Webview do esquemático, salvar/reabrir projeto e testes.
- MVP 4: QEMU Bridge, ESP32 Adapter e blink inicial.
- MVP 5: plugins nativos, exemplo mínimo e integração final.

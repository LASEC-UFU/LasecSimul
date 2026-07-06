# MVP - Limitações Conhecidas

## Objetivo

Registrar, depois da integração final (agente 15), o que foi validado de fato versus o que ainda
fica para depois do MVP. Ver `docs/14-integracao-final.md` para os critérios de aceite e
`examples/mvp-passive.lsproj` para o projeto de exemplo.

## O que foi validado de ponta a ponta (não só lido no código)

- Core compila (MSVC/CMake) e roda headless via CLI (`lasecsimul-core.exe --pipe <nome>`), agora
  fora de qualquer pasta sincronizada por nuvem (ver nota de ambiente de build abaixo).
- Suite completa de 19 testes nativos passa via `ctest` (Netlist, UnionFind, Scheduler, SparseSet,
  CoreBootstrap, CircuitGroup, MnaSolver, PassiveComponents, LogicComponents, PluginLoader,
  PluginLoaderRealDll, PluginRuntime, QemuProcessManager, QemuArenaBridge, McuControllerRealQemu,
  FirmwareWatcher, Esp32Adapter, voltage_divider, ComponentRemoval).
- Extension TypeScript compila (host + webview, dois tsconfigs separados) e os 7 testes existentes
  passam (`CoreClient` IPC + `ProjectSerializer`).
- Handshake IPC real: `hello` → `addComponent` (ground/fonte/resistor) → `connectWire` (três fios,
  malha com referência de terra) → `setProperty` → `start`/`stop` → `shutdown`, contra o binário
  real do Core (não mock) — circuito de exemplo simula sem erro e o processo encerra limpo.
- `examples/mvp-passive.lsproj` carrega via `ProjectSerializer`, e cada componente/fio é enviado ao
  Core real via IPC com sucesso (mesmo fluxo que `lasecsimul.openProject` executa na Extension).
- `addComponent` com `typeId` desconhecido (ex: `logic.led`, ainda sem componente built-in) é
  rejeitado com erro claro, sem derrubar o processo Core.
- **Remoção de instância no Core**: `SimulationSession::removeComponent` desconecta fios/túnel no
  `Netlist`, libera a instância e mantém os índices das instâncias restantes estáveis — índice
  removido nunca é reciclado (decisão documentada abaixo). IPC `removeComponent` exposto e ligado
  em `requestRemoveComponent` na Extension (`pushRemoveToCore`). Teste `component_removal` cobre
  remover, religar o circuito sem o componente removido, rejeitar `connectWire`/`setProperty` num
  componente já removido (sem crash) e remoção idempotente.
- **Catálogo do Core completo com o que está na paleta**: `logic.button` (chave ideal, condutância
  alta/baixa) tem `ComponentRegistry::registerFactory` real, com teste `logic_components`.
  `semiconductors.*`, `logic.led` e `mcu.arduino_uno` foram **removidos do catálogo** (não mais
  oferecidos na paleta) até existir modelo/adapter real — ver limitações abaixo.
- **Plugin nativo de exemplo carregado de verdade**: `npm run build:devices` compila
  `devices/example-blinker` como DLL real (`device.dll`) via seu próprio projeto CMake e copia para
  `devices/example-blinker/build/win-x64/device.dll` (convenção de `.lsdevice`). Teste
  `plugin_loader_real_dll` carrega esse binário real (não vtable sintética) via `PluginLoader`,
  confere ABI, publica no `GlobalPluginCache` e confirma que uma `SimulationSession` real passa a
  conhecer `example.blinker` via `registerKnownPluginTypes()`.
- **McuController novo, validado contra o binário REAL do fork QEMU**: junta `Esp32Adapter` +
  `QemuProcessManager` + `QemuArenaBridge` num ciclo de vida (`start`/`stop`). Teste
  `mcu_controller_real_qemu` roda contra `qemu-simulide/qemu-system-xtensa.exe` de verdade (não
  fake/stub) — confirma que o Core consegue abrir a arena, iniciar o processo QEMU real, e encerrar
  tudo sem travar nem vazar processo/handle. Pula (não falha) se o binário não estiver presente.
- **Leitura genérica de estado via IPC (`getComponentState`)**: novo verbo IPC devolve os bytes
  opacos de `IComponentModel::getState()` de qualquer instância (built-in ou plugin) — mecanismo
  único de "ler de volta" um valor calculado, sem verbo por tipo de componente. Teste
  `core_bootstrap` cobre instância válida, `instanceId` inválido e instância removida.
- **`loadDeviceLibrary` implementado**: parseia `library.json`+`.lsdevice` real, resolve o
  binário da plataforma atual e publica no `GlobalPluginCache` (`CoreApplication.cpp`,
  `loadDeviceLibraryFile`). A Extension chama isto na ativação para cada entrada de
  `contributes["lasecsimul.deviceLibraries"]` do `package.json` — sem isso, nenhum plugin (nem o
  `example-blinker`) ficava ativo, só carregável isoladamente em teste.
- **`addComponent` repassa `pins` do payload pra `ComponentParams::pinList`**: sem isso, qualquer
  plugin (via `NativeDeviceProxy`) tinha `ComponentMeta::pins` vazio e `stamp()` falhava
  silenciosamente (capturado pelo `CrashGuard`, sem crashar, mas sem efeito). Built-ins não são
  afetados (cada factory hardcoda o id do próprio pino, ex: `Pin{"p1",...}`).
- **Primeiro instrumento real via plugin ABI: `instruments.voltmeter`** (`devices/voltmeter`) —
  mede tensão DC entre dois pinos usando só `LsdnMatrixView::add_conductance`/`get_node_voltage`
  dentro de `stamp()`, deliberadamente sem usar `LsdnHostApi`/`pin_declare` (ver próximo item).
  Decisão arquitetural registrada em `docs/adr/0006-instrumentos-como-plugin-abi.md` — reverte o
  texto de `.spec/lasecsimul.spec` que dizia "instrumentos como código nativo, não como plugin".
  Teste `core_bootstrap` (`testVoltmeterPluginOverIpc`) valida de ponta a ponta contra o `.dll`
  real: `loadDeviceLibrary` → `addComponent` com `pins` → `connectWire` num divisor resistivo
  10V/1k/1k → `getComponentState` lê **4.999998 V** no ponto médio.
- **Bugs corrigidos para o Extension Development Host (F5) não crashar**: `corePath` em
  `extension.ts` agora procura o binário em `core/build/`, `core/build/Debug/` e
  `core/build/Release/` (geradores multi-config — Visual Studio, Ninja Multi-Config, os únicos
  documentados pra Windows — colocam o `.exe` num subdiretório; o caminho antigo só funcionava com
  gerador single-config). `CoreProcess` agora trata o evento `error` do `spawn()` (ENOENT etc) com
  uma mensagem na UI em vez de exceção não tratada derrubando o Extension Host. Adicionado
  `extension/.vscode/launch.json`+`tasks.json` (`Run Extension`, com `npm: compile` como
  `preLaunchTask`) pra abrir com F5.
- **UI do editor de esquemático alinhada ao SimulIDE (Fase A do plano "UI fiel ao SimulIDE")**:
  paleta duplicada dentro do canvas removida (só a árvore nativa adiciona componente); componente
  no canvas é só o símbolo SVG, tamanho irregular por tipo (`componentBox()` em
  `componentSymbols.ts`), sem card/título/botão "×"; remoção pela tecla Delete/Backspace com Escape
  cancelando fio pendente; corrigido bug de propagação de evento que impedia a ligação clique-clique
  nos pinos de completar; seleção visual virou retângulo translúcido sobre o símbolo (igual
  `Component::paintSelected()` do SimulIDE) em vez de borda; painel de propriedades virou `<dialog>`
  modal aberto com duplo-clique (substituindo o painel lateral fixo, decisão revertida — ver tabela
  da seção 13 de `.spec/lasecsimul.spec`); fio do esquemático ganhou CSS de cor visível (faltava
  inteiramente, por isso parecia "não conectar") e anima vermelho/azul por tensão durante a
  simulação (`getNodeVoltage` IPC, igual `ConnectorLine::paint()` do SimulIDE).
- **Paleta de componentes com taxonomia/ícones do SimulIDE**: `ComponentPaletteProvider` (TreeView
  nativo) replica categoria → subcategoria → item do SimulIDE (`itemlibrary.cpp`), com ícone
  (`media/components/{light,dark}/*.svg`) antes do nome — categoria de topo nunca tem ícone, igual ao
  original. Tabela completa (implementado vs. os ~130 itens do SimulIDE ainda não implementados) em
  `docs/15-taxonomia-paleta.md`.
- **Diálogo de propriedades 100% guiado por schema do Core, fim da inferência**: `PropertySchema`
  (grupo/label/editor/min/max/step/opções/6 flags, já existia em `Types.hpp` só pra plugins) agora
  também é declarado pelos built-ins (`Resistor`/`Capacitor`/`Inductor`/`DcVoltageSource`/`Button`,
  método estático `propertySchema()` reusado em `propertyDescriptors()` E em
  `registerBuiltinComponents`) e registrado no mesmo `ComponentMetadataRegistry` que plugins usam.
  Novo verbo IPC `getPropertySchemas` (sem payload, devolve tudo por typeId) — `extension.ts`
  (`refreshUnifiedCatalogState`/`attachPropertySchemas`) busca uma vez por catálogo e anexa em
  `WebviewComponentCatalogEntry.propertySchema`; a Webview (`resolvePropertyFields` em `main.ts`)
  monta grupos/ordem/campos a partir disso (spinbox com min/max/step real, select/enum com opções,
  campo oculto via flag, leitura ao vivo do voltímetro generalizada via `showOnSymbol+editor:
  "display"`, não mais hardcoded por typeId) — cai pra heurística antiga (`inferPropertyFields`) só
  se o Core não tiver schema pro typeId (registrado-desabilitado). Testes: `core_bootstrap`
  (`testGetPropertySchemasOverIpc`), `passive_components`/`logic_components` (`schema.group`/
  `.editor`/`.unit` não-vazios).
- **Rótulo de identificação (nome com índice) e de valor no esquemático, igual ao SimulIDE**: nome
  com índice POR TIPO (ex: "Resistor-1", "Resistor-2"; desvio deliberado do contador global de sessão
  real do SimulIDE) atribuído na criação (`nextIndexedLabel`, duplicado em `extension.ts`/`main.ts`);
  valor formatado com prefixo SI (`formatEngineeringValue`, porta `valToUnit` do SimulIDE) da
  propriedade marcada `PropertySchemaShowOnSymbol` — generaliza o que antes era hardcoded só pro
  voltímetro. Dois checkboxes de sistema ("Mostrar nome"/"Mostrar valor",
  `WebviewComponentModel.showId`/`showValue`) no diálogo de propriedades, fora do schema do Core (não
  é elétrico); persistido em `ProjectComponent` (`.lsproj`) — antes desta rodada, `label` não era
  persistido nenhum. Ver `.spec/lasecsimul.spec` seção 13.3.
- **Internacionalização de strings declarativas implementada** (ADR 0009, `.spec/lasecsimul.spec`
  seção 6.3, RNF12): `.lsdevice`/`component-catalog.json` declaram `language` (obrigatório) +
  `translations` (opcional); resolução por fallback (idioma ativo do VSCode → `language` do autor →
  primeira tradução disponível) implementada nos dois lados — Core
  (`resolvePropertySchemaForLanguage`, payload `language` em `getPropertySchemas`) e Extension
  (`UnifiedCatalog.ts::resolveLocalizedItems`). Exemplo real de tradução `en`:
  `devices/voltmeter/.lsdevice` (`displayVoltage`) e `project/schema/component-catalog.json` (8
  itens). Testes: `testGetPropertySchemasOverIpc` (pt-BR/en/fr), `UnifiedCatalog.test.ts`. Built-ins
  só declaram `language: "pt-BR"`, sem tradução nenhuma fornecida ainda.
- **Seleção múltipla (marquee), atalhos de teclado e zoom no esquemático, igual ao SimulIDE**:
  achado importante na investigação — o SimulIDE real **não distingue arrastar pra direita vs.
  esquerda** ao selecionar por retângulo (`QGraphicsView::RubberBandDrag` puro do Qt, interseção
  simples); implementado fiel a isso, não à variante direcional de outras ferramentas (AutoCAD/Eagle).
  `selectedComponentId?`/`selectedWireId?` (singulares) → `selectedComponentIds`/`selectedWireIds:
  string[]`. Marquee por `pointerdown` em área vazia + limiar de 4px; `Ctrl+R`/`Ctrl+Shift+R` rotaciona
  CW/CCW toda a seleção; `Ctrl+A` seleciona tudo; `Delete` remove toda a seleção; scroll do mouse dá
  zoom centralizado no cursor (fórmula `2^(-deltaY/700)` do SimulIDE, limite `[0.2,4]` — esse limite É
  decisão do LasecSimul, o SimulIDE real não tem nenhum codificado) — exigiu introduzir de fato
  `viewport.{x,y,zoom}` (existia no schema, mas estava morto) via wrapper `.canvas-content` com
  CSS transform, e corrigir `eventToCanvasPoint`/drag de componente pra dividir por zoom (sem isso,
  mover um componente com zoom≠100% ficaria errado). Menu de contexto completo (Rotacionar CW/CCW/180°,
  Excluir, Propriedades só com 1 selecionado, "Selecionar tudo" no fundo vazio) e cursor `grabbing`
  durante arraste. Ver `.spec/lasecsimul.spec` seção 13.4. Copiar/colar, flip H/V e undo/redo
  deixados de fora desta rodada (backlog, ver "Próximos passos sugeridos" abaixo).
- **Correções pós-rodada de seleção múltipla/atalhos/zoom** (achadas testando a rodada anterior):
  - **`Ctrl+R`/`Ctrl+Shift+R` conflitavam com keybinding nativo do VSCode** (`Ctrl+R` = "Abrir
    recente") — a Webview chamava `event.preventDefault()` no próprio `keydown`, mas isso não
    impede o VSCode de também despachar o comando nativo (são dois listeners independentes, um no
    host, um dentro do iframe da Webview). Corrigido com o mecanismo certo do VSCode:
    `contributes.keybindings` (`extension/package.json`) rebind `Ctrl+R`/`Ctrl+Shift+R` pros novos
    comandos `lasecsimul.rotateSelectionCw`/`Ccw`, com `"when": "activeWebviewPanelId ==
    'lasecsimul.schematic'"` — só ativo enquanto o painel do esquemático está em foco; ao trocar de
    foco o `when` deixa de casar e o atalho nativo do VSCode volta a funcionar sozinho, sem nenhuma
    lógica de restauração manual. Os comandos mandam `requestRotateSelection` pra Webview
    (`HostToWebviewMessage` novo); a Webview parou de tratar `Ctrl+R`/`Ctrl+Shift+R` no próprio
    `keydown` (só esse caminho agora, pra não rotacionar em dobro).
  - **Marquee quebrava o clique-em-pino-pra-iniciar-fio e podia interromper outros gestos** — pino/
    componente/fio nunca chamavam `stopPropagation()` no próprio `pointerdown` (só no `click`), e o
    novo listener de marquee em `.canvas` chamava `setPointerCapture` pra QUALQUER `pointerdown` que
    borbulhasse até ele — incluindo os que vieram de um pino, roubando o pointer capture do gesto de
    clique-clique de fio (mesma classe de bug já corrigida 2x antes nesta sessão). Corrigido com um
    guard no início do handler do marquee (`event.target.closest(".pin-terminal"/".component"/
    "polyline[data-wire-id]")` → `return`).
  - **Remover vários fios selecionados de uma vez gerava erro "recriar fio ... falhou: conexão"** —
    `requestRemoveWire` sempre disparava `rebuildCoreFromSchematicState()` (reconstrução completa:
    para simulação, remove todas as instâncias, recria tudo, reconecta tudo) sem aguardar uma
    reconstrução anterior terminar; `deleteSelectedItems()` (novo, multi-seleção) manda várias
    `requestRemoveWire` em sequência rápida, disparando reconstruções CONCORRENTES que competem pelo
    mesmo `coreInstanceIdByComponentId`. Corrigido com uma fila de execução serializada
    (`queueCoreRebuild`, `extension.ts`) — cada reconstrução só começa depois que a anterior terminou.

## Limitações conhecidas

- **Sem teste de ativação real dentro do VSCode**: `test/extension/` e `test/e2e/` só têm
  `.gitkeep`. Não há harness `@vscode/test-electron` configurado — abrir o editor de esquemático
  dentro de uma janela real do VSCode não foi automatizado, só os caminhos de IPC e serialização
  (que não dependem do Extension Host real).
- **Índice de instância removida nunca é reciclado**: `SimulationSession::removeComponent` deixa um
  buraco permanente — `addComponent` sempre cresce `m_componentInstances`, nunca reaproveita um
  índice livre (`Netlist::registerComponent` exige `componentIndex` denso e crescente). Em uma
  sessão com muitos ciclos de adicionar/remover, o vetor de instâncias cresce sem limite — sem
  impacto funcional hoje, mas eventualmente exigiria compactação se isso virar um padrão de uso
  pesado (fora de escopo agora).
- **Sincronização interativa Extension→Core é fire-and-forget**: ao adicionar/conectar/editar/remover
  pela Webview, a chamada IPC não é esperada antes da próxima ação do usuário ser aceita — corrida
  teórica se o usuário agir mais rápido que o round-trip IPC. Carregar um projeto do disco
  (`lasecsimul.openProject`) não tem esse problema: `pushProjectToCore` aguarda cada
  `addComponent`/`connectWire` em sequência antes do próximo.
- **Semicondutores/LED/Arduino Uno ainda fora do catálogo**: `semiconductors.diode`,
  `semiconductors.transistor_npn/pnp` e `logic.led` exigem modelo não-linear (diodo/transistor) —
  só o contrato (`IComponentModel::isNonlinear()`/`hasConverged()`) existe, sem Newton-Raphson real
  implementado ainda (ver `SimulationSession.cpp`); modelá-los como resistor linear seria
  fisicamente incorreto, por isso foram removidos da paleta em vez de fingidos. `mcu.arduino_uno`
  exigiria um `IMcuAdapter`/máquina QEMU próprios para ATmega328p (hoje só `espressif.esp32`
  existe). Reintroduzir cada um no catálogo só depois de existir a factory/adapter correspondente.
- **Resolvido nesta sessão (2026-06-28)**: `pin_write`/`pin_write_analog`/`pin_read`/`now_ns`/
  `schedule_event` deixaram de ser stubs vazios e passaram a ser reais (ligados a
  `Netlist`/`Scheduler` da sessão); `device_abi.h` foi de major 1 → 3 (bus removido, `pin_watch`
  removido, `pin_name` adicionado). `devices/example-blinker` foi migrado e funciona, incluindo
  `instruments.voltmeter` (que já usava só `LsdnMatrixView`, sem mudança necessária). Ver
  `docs/17-pendencias-pos-sessao-qemu-abi.md` seções 0.2/0.3 para o detalhamento completo.
- **`device_abi.h` mudou de forma binário-incompatível (vtable de 8 → 10 funções, `get_property`/
  `set_property` novos no meio da struct) sem rebuild automático dos `.dll` existentes**: qualquer
  mudança na ordem/contagem de `LsdnDeviceVTable` exige `npm run build:devices` de novo — sem isso,
  o `.dll` antigo é binário-incompatível com o Core novo (campos deslocados, chamada de função
  selvagem) e `PluginLoader` só percebe se o `abiMinor` embutido no `.dll` antigo também tiver
  ficado defasado (rejeita com erro limpo) ou, na falta dessa checagem pegar a divergência, pode
  nem chegar a crashar — só falha silenciosamente (plugin nunca registra `typeId`, `addComponent`
  falha, instrumento nunca aparece). Sintoma observado: voltímetro no circuito sem nunca mostrar
  leitura (`"... V"` parado) porque `instruments.voltmeter` nunca tinha factory — corrigido
  rebuildando `core` + `devices` juntos. **Sempre que `device_abi.h` mudar, rebuildar os dois**:
  `npm run build:core && npm run build:devices` (não basta só um dos dois).
- **Ciclo ESP32/QEMU real sem firmware de verdade (GPIO já funciona)**: `McuController` abre a arena e
  inicia o `qemu-system-xtensa.exe` real com sucesso (teste `mcu_controller_real_qemu`, binário
  vendorizado em `devices/qemu-esp32/bin/`), e `McuComponent`/`Esp32GpioModule` já provam GPIO de
  ponta a ponta com arena sintética (`McuComponentTest`). O que falta é só: não há toolchain
  `xtensa-esp32-elf`/ESP-IDF nesta máquina para compilar um firmware `.bin` de blink real — decisão
  explícita de não instalar ESP-IDF (download grande, fora de escopo). **Resolvido nesta sessão**: o
  mecanismo de passagem do nome da arena pro processo QEMU — `argv[1]` é sempre a chave da shared
  memory (confirmado lendo `simuMain()` real em `simuliface.c` do fork
  `C:\SourceCode\qemu_simulide`); resto dos args bate com `Esp32::createArgs()` real. Ver
  `docs/17-pendencias-pos-sessao-qemu-abi.md` seção 0.5 para o detalhamento completo.
- **Ambiente de build**: o projeto foi movido para fora de pastas sincronizadas por nuvem (Google
  Drive/OneDrive/Dropbox) — `cmake -S core -B core/build` com o gerador padrão (Visual Studio no
  Windows) funciona normalmente agora. A limitação de Ninja Multi-Config em pasta sincronizada
  (`ninja: error: manifest still dirty after 100 tries`, erro de acesso negado no `FetchContent`)
  só se aplica a quem ainda mantiver o código-fonte dentro de uma pasta desse tipo — ver
  `core/CMakePresets.json` e o preset `windows-msvc` como contorno nesse cenário.

## Próximos passos sugeridos

- Configurar `@vscode/test-electron` para um smoke test real de ativação (abrir editor, ver
  comandos registrados).
- ~~Implementar o `LsdnHostApi` real~~ — feito (2026-06-28): `pin_write`/`pin_read`/`now_ns`/
  `schedule_event` reais; `example-blinker` migrado e funcionando.
- ~~Descobrir o mecanismo de passagem do nome da arena~~ — feito (2026-06-28): `argv[1]`, confirmado
  contra o binário/fonte real. Falta só compilar um firmware `.bin` de blink real (exige instalar
  ESP-IDF) para validar GPIO de ponta a ponta com firmware de verdade — o pipeline em si
  (`McuController`/`McuComponent`/`Esp32GpioModule`) já funciona (ver acima).
- IOMUX/pin-matrix e módulos `Esp32TwiModule`/`Esp32SpiModule`/`Esp32UsartModule` do ESP32 (só GPIO
  existe hoje) — ver `docs/17-pendencias-pos-sessao-qemu-abi.md` seção 3.1.
- Implementar diodo/transistor com Newton-Raphson real (`IComponentModel::isNonlinear()`) antes de
  reintroduzir `semiconductors.*`/`logic.led` no catálogo.
- Próximo instrumento (ex: osciloscópio/traço de pino ao longo do tempo) segue o mesmo padrão do
  voltímetro: plugin em `devices/`, estado lido via `getComponentState` — ver ADR 0006.
- ~~Corrigir `contributes["lasecsimul.deviceLibraries"]`~~ — feito: consolidado em
  `project/schema/component-catalog.json` (`deviceLibraries[]`), lido por
  `extension/src/catalog/UnifiedCatalog.ts` — ver `.spec/lasecsimul.spec` seção 1.1 e ADR 0007.
- Implementar subcircuitos (circuito reutilizável definido por `.lssubcircuit`, sem código) — spec
  completa em `.spec/lasecsimul-subcircuits.spec` e ADR 0008; nada implementado ainda, só
  especificado. Preparação recomendada antes da implementação: catálogo da Webview aceitar um
  campo `package` por entrada (renderização data-driven do símbolo, em vez do `switch(typeId)`
  hardcoded em `componentSymbols.ts` hoje) — beneficia subcircuitos e plugins igualmente.
- **Backlog de paridade SimulIDE na Webview** (achado ao investigar a UI do SimulIDE — itens restantes,
  nenhum é pré-requisito de outro):
  - Copiar/colar (Ctrl+C/Ctrl+X/Ctrl+V) — exige remapear fios internos entre os itens copiados, não é
    só duplicar componente; deixado de fora da rodada de seleção múltipla/atalhos/zoom de propósito.
  - Flip horizontal/vertical (Ctrl+L/Ctrl+Shift+L) — nova capacidade real (espelhar símbolo+pinos),
    não implementada.
  - Undo/redo (Ctrl+Z/Y) — o LasecSimul não tem NENHUM sistema de undo hoje; SimulIDE tem, mas
    construir um aqui é um projeto à parte, não um item isolado deste backlog.
  - Arrastar o rótulo de nome/valor independentemente do símbolo (`Label::mousePressEvent` do
    SimulIDE) — posição hoje é fixa (acima/abaixo da caixa do componente), ver `.spec/lasecsimul.spec`
    seção 13.3.
  - Tradução de `name` (nome de exibição do componente) e `pins[].label` — o mecanismo de
    `language`/`translations` (ADR 0009) já existe pra `properties[]`, mas `getPropertySchemas` ainda
    não devolve/resolve `displayName`/`pins[]`; ver `.spec/lasecsimul-native-devices.spec` seção
    4.2.2.1.

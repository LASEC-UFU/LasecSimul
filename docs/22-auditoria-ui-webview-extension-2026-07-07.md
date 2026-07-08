# 22 — Auditoria completa de UI/Webview/Extension (2026-07-07, v2)

> Segunda rodada de auditoria completa da UI/Webview/Extension, pedida explicitamente do zero pelo
> usuário mesmo já existindo uma auditoria anterior (documentada só em `docs/21-handoff-auditoria-61-achados.md`,
> uma sessão de trabalho que já implementou ~50 dos 61 achados daquela rodada — ver "Fases 1-7 completas"
> lá). Esta auditoria confirma o que já foi corrigido, investiga a fundo os 3 itens que ficaram
> explicitamente em aberto (EX-9 modularização, EX-2 duplicação de manifesto, UI-12 modelo de seleção),
> e busca achados novos surgidos desde então (inclusive das mudanças recentes "refactor subcircuit").
>
> **Nada foi implementado nesta etapa.** Este documento é só investigação/proposta, para o usuário decidir
> o que fazer e em que ordem.

## Atualização pós-implementação (2026-07-07)

Esta seção registra o estado final depois da sequência de correções executada após a auditoria. O corpo
do documento abaixo permanece como histórico do diagnóstico original.

- **TR-8 fechado**: removidos os fallbacks mortos em `componentSymbols.ts` para built-ins já migrados para
  `package`; os built-ins restantes devem passar pelo mesmo pipeline declarativo (`component-catalog.json`
  -> `packageSanitizers`/parser -> `registerPackage` -> renderer), sem helpers internos por device.
- **HARD-1 fechado**: a normalização compartilhada de manifesto em `registeredSources.ts` foi extraída
  para helpers comuns (`manifestFolderPath`, `manifestIconFields`, `manifestDefaultProperties`) e usada
  nos caminhos de subcircuito/ABI.
- **PERF-1/PERF-2 fechados**: `main.ts` passou a indexar fios por componente para atualização localizada
  durante drag e consolidou os passes de `render()` sobre `state.components`.
- **OPT-1/OPT-2 fechados**: `UnifiedCatalog.ts` recebeu cache de leitura por `mtimeMs`, invalidado ao
  salvar fontes registradas, e a paleta passou a usar texto localizado para singular/plural de pinos.
- **TR-9 fechado após decisão explícita do usuário**: `switches.keypad` agora usa `dynamicLayout` no
  próprio `package`, com `rows`/`columns` vivos no parser/renderer e pinGroups dinâmicos conforme o
  SimulIDE (`C:\SourceCode\simulide_2\src\components\switches\keypad.cpp`). A geometria/pinos são
  materializados por instância a partir do package, não por fallback hardcoded.
- **HARD-2 fechado**: `extractPackageForEditing` deixou de reimplementar o parser de `package` e agora
  delega para `sanitizePackage`, preservando o pipeline compartilhado de `background.asset`,
  `dynamicLayout`, `viewSpec`, shapes e pins.
- **EX-B fechado**: `registerAdhocSubcircuit` ganhou modo `returnPayload: false` no Core, exposto pela
  Extension como `registerAdhocSubcircuitDefinition`, para registrar definições quando o payload rico seria
  descartado.
- **EX-E fechado após decisão explícita do usuário**: as mutações do Core na Extension agora passam por uma
  fila compartilhada em `coreLifecycle.ts`, incluindo add/remove component, connect/disconnect wire,
  propriedades, túnel e rebuild.
- **FMT-1 fechado**: subcircuitos avulsos sem `library.json` permanecem habilitados e registram o
  manifesto direto no Core (`adhocSubcircuitPathToRegister`), coberto por teste em `registeredSources`.
- **PC-19 fechado**: o diálogo de propriedades usa `componentVisualFlags`/metadado para atualizar toggles
  e fonte fixa, não mais checks locais por `typeId` literal no handler de edição.
- **UI-DUP fechado**: `wireConnections.ts` concentra a montagem de fio pino→pino e pino→fio, usado tanto
  por `extension.ts` quanto pela Webview em modo de autoria, com teste dedicado.
- **UI-TXT fechado**: `normalizeSelectedTextLabel()` roda junto de `normalizeSelectedWireSegment()` e
  `normalizeSelectedWireCorner()` no início de `render()`.
- **PC-20/PC-21 fechados**: a contribuição morta `view/item/context` não existe mais no `package.json`, e a
  mensagem de catálogo integrado já está com acentuação correta.
- **SPEC/DOC fechados**: `.spec/lasecsimul.spec`, `.spec/lasecsimul-subcircuits.spec`,
  `docs/07-extension-typescript.md`, `docs/08-ui-webview.md`, `docs/11-qemu-esp32.md` e
  `docs/mvp-limitacoes.md` foram alinhados ao estado atual de paleta, subcircuito, undo/redo,
  copiar/colar e flip.
- **EX-9 terceira etapa concluída**: além de `project/projectCommands.ts`, foram extraídos
  `catalog/catalogCommands.ts` (registro/remoção/refresh de catálogo), `mcu/mcuCommands.ts` (firmware,
  monitor serial e overlay Modo Placa) e `symbolAuthoring/symbolCommands.ts` (edição, troca de vista,
  carregamento e salvamento de package/símbolo). `extension.ts` caiu para 1273 linhas e ficou concentrado
  no dispatcher/orquestração do editor, seleção/criação de subcircuito, sincronização com Core e exportação
  de instrumentos.
- **TR-9 generalizado (pino dinâmico, além do que o item original pedia)**: a pedido explícito do
  usuário, o mecanismo virou genérico — `ComponentPinSpec`/`resolveDynamicPins` (Core,
  `core/include/lasecsimul/Types.hpp`), único intérprete usado tanto por built-ins
  (`SimulidePassiveState`) quanto por plugin nativo (`NativeDeviceProxy`/`PluginRuntime`). Aplicado a
  4 built-ins (`switches.keypad`, `outputs.led_matrix`, `outputs.led_bar`, `active.analog_mux` —
  auditados TODOS os `PropertySchemaAffectsTopology` existentes contra o SimulIDE real pra achar quem
  de fato precisa). ABI de plugin: `pin_declare` (existia desde a major 3, mas era vestigial — nunca
  afetava a topologia elétrica) agora funciona de verdade, de `init()` ou de dentro do próprio
  `set_property()`, **sem nenhuma mudança de assinatura de ABI**; existe também um caminho 100%
  declarativo (`pinSpec` no `.lsdevice`) pra quem não quer escrever C. `Netlist::reregisterComponentPins`
  segue a mesma filosofia append-only de `removeComponent`. Ver `.spec/lasecsimul-native-devices.spec`
  seção 7.1 pro desenho completo e [[project_lasecsimul_dynamic_pins]] na memória.
  - **Gap visual fechado nesta mesma tarefa**: `outputs.led_matrix`/`outputs.led_bar`/`active.analog_mux`
    ganharam `package.dynamicLayout`/`simulidePaint` completos (só `switches.keypad` tinha antes),
    derivados linha a linha do SimulIDE real (`ledmatrix.cpp`/`ledbar.cpp`/`mux_analog.cpp`).
    `active.analog_mux` exigiu estender a linguagem declarativa da Extension com `countFn`/`transform:
    "log2Ceil"` (`PackageDynamicPinGroup`/`PackageNumberExpression`, `model.ts`), espelhando
    `DynamicPinCountFn::Log2Ceil` do Core, porque a posição do pino `En` e a contagem do grupo `addr-`
    dependem de `ceil(log2(channels))`, não expressável só com multiplicador/offset lineares.
    **⚠️ Valores de pixel NÃO verificados numa sessão interativa** (sem GUI/harness de DOM neste
    projeto) — a fórmula foi conferida por leitura direta do código-fonte real do SimulIDE e por 3
    testes de regressão novos (`componentSymbols.test.ts`, 46/46 passando), mas nunca vista renderizada
    de verdade. Recomendo abrir o Extension Development Host e comparar visualmente antes de considerar
    isto no mesmo nível de confiança que o `switches.keypad` (que teve o mesmo trabalho feito por outra
    sessão, também sem confirmação de que foi visualmente checado).
- **Validação final**:
  - `npm test` passou; após as extrações de `catalogCommands.ts`, `mcuCommands.ts` e
    `symbolAuthoring/symbolCommands.ts`, passou novamente.
  - `npx tsc -p tsconfig.json --noEmit` passou duas vezes na terceira etapa: uma logo após conectar a
    extração de autoria de símbolo e outra na rodada final.
  - `npx tsc -p tsconfig.webview.json --noEmit` passou.
  - `npx tsc -p tsconfig.test.json --noEmit` passou.
  - `npx --yes mocha "out-test/**/*.test.js"` saiu com código 0. Observação: os testes atuais são scripts
    autoexecutáveis, não specs Mocha nativas; por isso o rodapé do Mocha mostra `0 passing`, enquanto os
    próprios scripts imprimem seus blocos com `0 falharam`.
  - `node scripts/build-core.js --config=Debug` passou.
  - `ctest --test-dir core/build -C Debug --output-on-failure -E "esp32_devkitc_subcircuit"` passou 27/27.
  - `ctest --test-dir core/build -C Debug --output-on-failure` passou até `esp32_adapter` e ficou travado
    sem saída no teste `esp32_devkitc_subcircuit`; o processo foi encerrado manualmente para não deixar a
    sessão pendurada.

Memória de continuidade: built-ins migrados não devem ganhar helpers internos paralelos; qualquer novo
comportamento visual/pinagem precisa entrar como dado de `package` e ser interpretado pelo parser/renderer
compartilhado. Para os casos arquiteturais restantes de Fase D, pedir decisão explícita antes de alterar
fluxo global. A terceira etapa de EX-9 já extraiu `symbolAuthoring/symbolCommands.ts`; não reabrir este
cluster dentro de `extension.ts` em trabalhos futuros.

## Método

5 agentes de investigação em paralelo, cada um com escopo de domínio, acesso ao código atual, às specs
(`.spec/lasecsimul.spec`, `.spec/lasecsimul-native-devices.spec`, `.spec/lasecsimul-subcircuits.spec`),
à skill (`.skill/lasecsimul.skill`) e ao SimulIDE real (`C:\SourceCode\simulide_2`) como referência de
comportamento. Cada agente recebeu o contexto do handoff anterior para não redescobrir o que já foi
corrigido, e foi instruído a **confirmar lendo o código atual** antes de aceitar qualquer afirmação do
handoff como verdadeira (o handoff podia estar desatualizado — e em um caso estava: `extension.ts` tem
2692 linhas hoje, não as 2592 que o handoff registrava, por causa de ~100 linhas de mudança não
commitada no working tree).

Domínios:
1. Translator/parser/render (`simulideSceneTranslator.ts`, `symbolAuthoring.ts`, `componentSymbols.ts`,
   `simulidePaint.ts`, `packageSanitizers.ts`, `UnifiedCatalog.ts`).
2. Interação da Webview (`main.ts`, `wireGeometry.ts`, `palette.ts`, `paletteTree.ts`,
   `instrumentTrigger.ts`, `valueFormatting.ts`, `messages.ts`).
3. Extension host (`extension.ts`, `state.ts`, `core/coreLifecycle.ts`, `catalog/registeredSources.ts`,
   `project/ProjectSerializer.ts`, `trust/TrustStore.ts`, `ipc/CoreClient.ts`).
4. Paleta/propriedades/ABI/formatos de arquivo (`ui/views/ComponentPaletteViewProvider.ts`,
   `ui/webview/palette.ts`, diálogo de propriedades em `main.ts`, `.lsdevice`/`.lssubcircuit`/`.lsproj`).
5. Conformidade `.spec`/`.skill`/`docs/` × código real, e paridade com o SimulIDE.

Os achados de dois agentes que investigaram o **mesmo item pendente** (EX-2, duplicação de normalização
de manifesto) de ângulos diferentes foram deduplicados manualmente abaixo — convergiram no mesmo código,
o que é um sinal de confirmação, não de achado duplo.

---

## 1. Resumo executivo

- **A maior parte da auditoria anterior (61 achados) foi de fato implementada** — confirmado, não só
  por leitura do handoff, mas por verificação ativa de cada ponto pelos 5 agentes desta rodada.
  `ui/tree/ComponentPaletteProvider.ts` (TreeView morto) está deletado, `pinIds` vêm do Core via IPC,
  fios individuais não reconstroem o circuito inteiro, `syncStatePatch` existe e é usado, UTF-8 não
  corrompe mais em `CoreClient`, código morto antigo foi removido. Isso reduz consideravelmente o volume
  de achados novos desta rodada frente à anterior.
- **1 achado crítico novo**: o fluxo principal e documentado de "Criar Subcircuito a partir da Seleção"
  produz um subcircuito que nasce **desabilitado na paleta** (FMT-1) — regressão real introduzida pela
  reutilização de uma regra de confiança pensada para plugins nativos (`abi-device`) num caminho que não
  deveria precisar dela (subcircuito é dado puro, sem código nativo).
- **5 achados altos**: uma regressão visual determinística no keypad (TR-9), uma janela de corrida real
  entre duas filas de mutação do Core que não se coordenam (EX-E), um ponto isolado que ainda decide por
  `typeId` literal em vez do metadado ABI v2 já migrado (PC-19), uma contradição interna grave na própria
  spec sobre o que está ou não implementado (SPEC-3), e uma duplicação de lógica de conexão de fio entre
  Extension e Webview no modo de autoria de subcircuito — a mesma classe de bug já corrigida antes
  ("Symbol-authoring wire edit bug", 2026-07-06) reaparecendo de forma estrutural.
- **A modularização de `extension.ts` (EX-9) está estagnada**: nenhum módulo novo foi extraído desde o
  handoff. O arquivo continua com ~2700 linhas e ~150 funções misturando domínios (comandos de projeto,
  autoria de símbolo, MCU, dispatcher de mensagens). O plano de extração sugerido no handoff continua
  válido e não foi executado.
- **EX-2 (duplicação de normalização de manifesto)**, deixado em aberto na rodada anterior, está
  **confirmado**: 3 blocos de lógica (extração de ícone, de `folderPath`, e do padrão `logicSymbol:
  false`) são reimplementados quase idênticos em 2-3 pontos de `registeredSources.ts`, e
  `extractPackageForEditing` (extension.ts) reimplementa `sanitizePackage` (packageSanitizers.ts) com
  validação mais fraca e sem resolver `background.asset` — um bug latente ainda não exercitado pelos
  dados reais do projeto.
- **UI-12 (modelo de seleção)**, também deixado em aberto, está majoritariamente OK — é uma separação
  deliberada e documentada (comentário explícito no código), não uma fragilidade. Só uma inconsistência
  pequena sobrou (`selectedTextLabel` sem a mesma auto-cura que `selectedWireSegment`/`selectedWireCorner`
  têm).
- **A documentação normativa tem uma contradição interna séria**: `.spec/lasecsimul.spec` §13.4 lista
  undo/redo, copiar/colar e flip como "fora de escopo, não implementado" — mas os três já existem e a
  própria §17 do mesmo arquivo documenta a implementação. Um agente futuro que leia só §13.4 pode tentar
  reimplementar do zero algo que já existe.
- **Código morto**: ~18 entradas hardcoded inalcançáveis em `componentSymbols.ts` (typeIds que já migraram
  pra `package` real), uma função órfã resultante de mudança não commitada em `registeredSources.ts`, e
  uma contribuição de menu de contexto morta em `package.json` (resíduo do TreeView deletado).
- Nenhuma spec está tão ambígua ou contraditória a ponto de impedir uma arquitetura melhor — as
  divergências encontradas são de documentação desatualizada (custo baixo/zero de corrigir), exceto a
  contradição de escopo (SPEC-3), que é séria por risco de retrabalho, não por ambiguidade arquitetural.

---

## 2. Lista completa de achados

| ID | Título | Severidade | Camadas |
|---|---|---|---|
| FMT-1 | Subcircuito criado por "Criar Subcircuito da Seleção" nasce desabilitado na paleta | **Crítico** | Extension |
| TR-9 | `switches.keypad`: redimensionamento por `rows`/`columns` quebrado após migração pra `package` | Alto | Core, Extension, UI |
| EX-E | Duas filas de serialização de mutação do Core que não se coordenam entre si (race condition) | Alto | Extension |
| PC-19 | Diálogo de propriedades usa `typeId` literal em vez do metadado ABI v2 já migrado | Alto | UI |
| SPEC-3 | `.spec/lasecsimul.spec` §13.4 contradiz §17: lista undo/redo/copiar-colar/flip como não implementados | Alto | Spec |
| UI-DUP | Lógica de conexão de fio duplicada entre `extension.ts` e `main.ts` no modo de autoria de subcircuito | Alto | Extension, UI |
| HARD-1 | Normalização de manifesto (ícone, `folderPath`, `logicSymbol` default) duplicada 2-3x em `registeredSources.ts` | Médio | Extension |
| HARD-2 | `extractPackageForEditing` reimplementa `sanitizePackage` com validação mais fraca e sem resolver `background.asset` | Médio | Extension |
| DOC-1 | `docs/11-qemu-esp32.md` desatualizado: afirma que "Criar Subcircuito da Seleção" não existe | Médio | Docs |
| DOC-2 | `docs/08-ui-webview.md` inteiro descreve design pré-reversão (paleta TreeView, propriedades não-modais), sem aviso | Médio | Docs |
| EX-B | `registerAdhocSubcircuit` busca payload do Core que é sempre descartado (round-trip IPC desperdiçado) | Médio | Extension |
| TR-8 | ~18 entradas hardcoded mortas em `componentSymbols.ts` (typeIds já migrados pra `package`) | Baixo | UI |
| UI-TXT | `selectedTextLabel` não tem auto-cura como os irmãos `selectedWireSegment`/`selectedWireCorner` | Baixo | UI |
| EX-A | Função órfã `registeredSubcircuitInfoToParsedManifest` (resultado de edição não commitada) | Baixo | Extension |
| PC-20 | Contribuição `view/item/context` morta em `package.json` (resíduo do TreeView deletado) | Baixo | Extension (manifesto) |
| PC-21 | Mensagem de erro com mojibake exibida ao usuário | Baixo | Extension |
| SPEC-1 | `.spec/lasecsimul-subcircuits.spec` contradiz a si mesmo: linha 37 diz `.json`, resto do doc diz `.lssubcircuit` | Baixo | Spec |
| SPEC-2 | Spec referencia `TreeItem.iconPath`, API não mais usada (resíduo do TreeView) | Baixo | Spec |
| DOC-3 | `docs/07-extension-typescript.md` referencia `ui/commands/`, diretório que nunca existiu de fato | Baixo | Docs |
| SPEC-4 | Mojibake em `.spec/lasecsimul-native-devices.spec` (mudança não commitada do próprio usuário) | Baixo (nota) | Spec |
| PERF-1 | `updateWiresTouchingComponent` faz scan O(total de fios) por componente arrastado, a cada `pointermove` | Baixo | UI |
| PERF-2 | `render()` itera `state.components` inteiro 5x em passes de `.filter()` separados | Baixo | UI |
| OPT-1 | `loadUnifiedCatalog` sem cache — relido/reparseado do disco em 7+ pontos de `extension.ts` | Melhoria opcional | Extension |
| OPT-2 | Contador de pinos na paleta ignora `language` (hardcoded pt-BR "pinos") | Melhoria opcional | UI |

---

## 3. Classificação por severidade

- **Crítico**: FMT-1.
- **Alto**: TR-9, EX-E, PC-19, SPEC-3, UI-DUP.
- **Médio**: HARD-1, HARD-2, DOC-1, DOC-2, EX-B.
- **Baixo**: TR-8, UI-TXT, EX-A, PC-20, PC-21, SPEC-1, SPEC-2, DOC-3, SPEC-4, PERF-1, PERF-2.
- **Melhoria opcional**: OPT-1, OPT-2.

---

## 4. Detalhe de cada achado

### FMT-1 — Subcircuito criado por "Criar Subcircuito da Seleção" nasce desabilitado na paleta

- **Arquivo/função**: `extension/src/catalog/registeredSources.ts:489-526` (branch `subcircuit-file` de
  `resolveRegisteredItem`) + `extension/src/extension.ts:1348-1477`
  (`createSubcircuitFromSelectionHandler`).
- **Evidência**: o branch `kind === "subcircuit-file"` exige um `library.json` na mesma pasta do
  `.lssubcircuit` (via `inferLibraryPathForSubcircuit`); na ausência, força `disabled: true` +
  `disabledReason`. O único fluxo real de criação (comando `lasecsimul.newSubcircuit`) grava o
  `.lssubcircuit` e registra a fonte **sem `libraryPath`**, e nunca cria/atualiza `library.json`. O mesmo
  vale para "Registrar arquivo..." apontando direto pra um `.lssubcircuit` avulso.
- **Por que é problema**: quebra o fluxo principal e documentado (`.spec/lasecsimul-subcircuits.spec`
  seção 11) de criação de subcircuito — o resultado aparece na paleta com ícone fantasma/desabilitado.
- **Relação com `.spec`/`.skill`**: contradiz `.spec/lasecsimul-subcircuits.spec` §12.1, que documenta
  `registerAdhocSubcircuit` no Core **sem exigir** `library.json` para subcircuito avulso. A exigência de
  `library.json` foi copiada da regra de confiança de `abi-device` (código nativo, precisa de
  `publisher`/`trust`, seção 12 do native-devices.spec) sem adaptação — subcircuito é dado puro, não tem
  esse risco.
- **Impacto atual**: todo subcircuito criado pela feature nativa fica inutilizável até o usuário descobrir
  que precisa criar manualmente um `library.json`.
- **Risco de corrigir**: baixo — é lógica de resolução/registro, não formato de arquivo.
- **Proposta**: no branch `subcircuit-file`, não bloquear na ausência de `library.json` (registrar
  normalmente, como já faz a rota "adhoc" via `subcircuitRef`), ou fazer
  `createSubcircuitFromSelectionHandler` gerar/atualizar um `library.json` mínimo.
- **Disruptivo**: não.
- **Camadas**: Extension (`registeredSources.ts`, `extension.ts`); esclarecer no spec que `library.json` é
  opcional para `subcircuit-file`.

### TR-9 — `switches.keypad`: redimensionamento por `rows`/`columns` quebrado

- **Arquivo/função**: `extension/src/ui/webview/componentSymbols.ts:1101-1109` (`propertyDrivenBox`, case
  `switches.keypad`), `extension/src/ui/webview/simulidePaint.ts:268-303`
  (`offsetTransform`/`repeat`/`simulidePaintToPackageShapes`), `core/src/app/CoreApplication.cpp:357`
  (`makePinVector(p, 8)`, fixo).
- **Evidência**: o `simulidePaint` do keypad usa `repeat`/`countProp: "rows"`/`"columns"` pra desenhar a
  grade de teclas dinamicamente, mas `simulidePaintToPackageShapes` só desloca os primitivos filhos — o
  `transform`/`bounds` do package continua fixo em `{72, 72}`, e os 8 pinos do Core são fixos
  independente de `rows*columns`. Há um comentário no código (linha 1104) dizendo que esse comportamento
  responsivo foi corrigido em 2026-06-30 — a correção ficou código morto quando o keypad foi migrado pra
  `package`/`simulidePaint` depois, sem ninguém restaurar o comportamento.
- **Por que é problema**: mudar `rows`/`columns` de um keypad já colocado (propriedade editável,
  `PropertySchemaAffectsTopology`) faz a grade desenhada crescer/encolher via `repeat`, mas a caixa do
  componente e os 8 pinos ficam no tamanho/posição do 4×4 default — overflow/clipping visual e
  desalinhamento entre teclas e leads reais. Determinístico, verificável só por leitura de código
  (matemática de posições fixas vs. dinâmicas).
- **Relação com `.spec`/`.skill`**: viola a regra do skill de que geometria/pinos vêm 100% do
  parser/tradutor genérico compatível com o dado declarativo — aqui o dado declarativo (`repeat`) e o
  dado fixo (bounds/pinos) divergem estruturalmente para este device específico.
- **Impacto atual**: alto para qualquer usuário que edite `rows`/`columns` de um keypad após colocá-lo.
- **Risco de corrigir**: médio/alto — qualquer correção real (package dinâmico por instância) é mudança
  arquitetural (hoje `registerPackage` é por typeId, não por instância). Mudança visível sem GUI de teste
  disponível aqui — candidato a "pergunte antes de implementar" por decisão de escopo (redimensionar de
  verdade vs. fixar 4×4 e remover a ilusão de que é editável).
- **Proposta**: decisão do usuário entre (a) package computado dinamicamente por instância
  (arquitetural), ou (b) fixar `rows`/`columns` em 4×4 no catálogo e possivelmente remover essas
  propriedades da UI se não puderem variar sem quebrar o desenho.
- **Disruptivo**: sim, se optar por (a).
- **Camadas**: Core (pinos), Extension (catálogo), UI (renderer).

### EX-E — Duas filas de serialização de mutação do Core que não se coordenam

- **Arquivo/função**: `extension/src/core/coreLifecycle.ts:415-440` (`rebuildQueue`/`queueCoreRebuild`),
  `extension/src/extension.ts:1003-1011` (`projectSnapshotSyncQueue`/`enqueueProjectSnapshotSync`), e
  pushes diretos não enfileirados em `extension.ts:476, 484, 960, 967, 994, 1049, 1072-1073, 1080, 1130,
  1523-1527`.
- **Evidência**: `queueCoreRebuild()` existe justamente para evitar reconstruções concorrentes do Core
  (comentário em `coreLifecycle.ts:409-414` cita o sintoma real: `"recriar fio ... falhou: conexão"`,
  documentado em `docs/mvp-limitacoes.md`). Mas essa proteção só cobre chamadas dentro dela mesma. Existem
  hoje 3 classes de mutação de Core sem coordenação entre si: (1) `syncProjectSnapshotToCore` com sua
  própria fila (`projectSnapshotSyncQueue`, distinta de `rebuildQueue`); (2) handlers de
  `handleWebviewMessage` que chamam `pushComponentToCore`/`pushWireToCore`/`pushRemoveToCore`
  **diretamente**, sem fila nenhuma; (3) o próprio `queueCoreRebuild()`.
- **Por que é problema**: `rebuildCoreFromSchematicState` começa limpando `coreInstanceIdByComponentId`
  inteiro e reconstruindo do zero — se rodar concorrente com um push avulso de (2) (ex: usuário arrasta
  componente novo no exato momento em que salvar um símbolo dispara um rebuild), o componente novo pode
  perder seu id de instância no Core, ficando "preso": edições de propriedade e fios nesse componente
  silenciosamente viram no-op.
- **Relação com `.spec`/`.skill`**: é exatamente a classe de bug que `queueCoreRebuild`/EX-6.3 (auditoria
  anterior) foram desenhados para eliminar — a proteção não cobre os outros dois caminhos concorrentes.
- **Impacto atual**: janela de corrida real, não garantida — exige timing específico, o que explica por
  que não foi pego antes; mas é reproduzível em teoria com ações rápidas do usuário.
- **Risco de corrigir**: médio/alto — a correção real (unificar tudo numa única fila de mutações de Core)
  é mudança arquitetural, e só é verificável de fato testando drag-and-drop/salvamento concorrente na
  Webview real (sem GUI de teste automatizada disponível neste ambiente).
- **Proposta**: unificar as duas filas + os pushes avulsos num único serializador
  (`coreMutationQueue`) por onde tudo que toca `coreInstanceIdByComponentId`/emite chamadas ao Core passa.
- **Disruptivo**: moderadamente — muda o fluxo interno de todo push ao Core, mas não muda formato de
  arquivo nem API externa.
- **Camadas**: Extension (`coreLifecycle.ts` + `extension.ts`). Candidato explícito a "pergunte antes",
  dado o risco de regressão silenciosa sem forma de testar interativamente aqui.

### PC-19 — Diálogo de propriedades usa `typeId` literal em vez do metadado ABI v2 já migrado

- **Arquivo/função**: `extension/src/ui/webview/main.ts:4503-4504`.
- **Evidência**:
  ```ts
  if ((component.typeId === "switches.switch" || component.typeId === "switches.switch_dip") && field.key === "closed") updateRenderedToggleState(component);
  if (component.typeId === "sources.fixed_volt" && field.key === "out") updateRenderedFixedVoltState(component);
  ```
  já existe `interactionKindFor(typeId)` (linha 2618-2624) e `componentVisualFlags(component).isToggleClickable`/`isFixedVolt`
  (linha 3431-3451) cobrindo exatamente esses typeIds — usado em outros pontos do mesmo arquivo (ex:
  `canToggle`, linha 3948), mas não aqui.
- **Por que é problema**: violação direta da regra do skill ("nunca hardcode lógica de um typeId
  específico fora do módulo daquele device quando existe caminho de metadata genérico") — inconsistente
  com o resto do arquivo, que já foi migrado.
- **Relação com `.spec`/`.skill`**: `.spec/lasecsimul-native-devices.spec` §22.4/22.8 declara esses
  typeIds como migrados pro ABI v2 nesta mesma linha de trabalho.
- **Impacto atual**: baixo em termos de bug ativo (os 3 typeIds cobertos hoje são exatamente os mesmos que
  o metadado cobriria) — o risco é de **drift futuro**: um typeId novo com o mesmo padrão de interação não
  seria pego aqui, só nos outros pontos já migrados.
- **Risco de corrigir**: baixo — troca mecânica, comportamento idêntico para os typeIds atuais.
- **Proposta**: `if (componentVisualFlags(component).isToggleClickable && field.key === "closed") ...` e
  equivalente para `isFixedVolt`.
- **Disruptivo**: não.
- **Camadas**: UI (`main.ts`).

### SPEC-3 — `.spec/lasecsimul.spec` §13.4 contradiz §17: undo/redo/copiar-colar/flip

- **Arquivo**: `.spec/lasecsimul.spec:1462-1465` (§13.4) vs `.spec/lasecsimul.spec` §17 (linhas 1651+).
- **Evidência**: §13.4 lista como "fora de escopo, não implementado": copiar/colar, flip
  horizontal/vertical, undo/redo ("o LasecSimul não tem NENHUM sistema de undo hoje"). §17, mais adiante
  no MESMO arquivo, título "Undo/Redo (Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z) (2026-07-06/07)", documenta a
  implementação completa. No código: `main.ts:319` (`clipboardItems`), `:1760/1769`
  (`copySelectedItems`/`pasteClipboardItems`), `:1050-1053`+`3642-3643` (`flipSelectedComponents`),
  `:681-758` (`recordUndoTransition`/`snapshotOfProjectState`) — os três recursos existem de verdade.
- **Por que é problema**: um agente (humano ou de IA) que leia só §13.4 (seção intitulada "UI da
  Extension", nome razoável pra procurar isso) concluirá erroneamente que os três recursos não existem e
  pode tentar reimplementá-los do zero — duplicação/regressão real. É a contradição interna mais
  significativa encontrada nesta auditoria.
- **Relação com `.spec`/`.skill`**: a skill instrui "atualizar o spec relevante na mesma tarefa" quando uma
  decisão evolui — aqui a atualização (§17) foi adicionada, mas a seção anterior (§13.4) não foi
  revisitada/removida.
- **Impacto atual**: risco de retrabalho, não bug de runtime.
- **Risco de corrigir**: nenhum — é edição de documentação.
- **Proposta**: remover os três itens da lista "fora de escopo" de §13.4, ou substituir por um ponteiro
  pra §17.
- **Disruptivo**: não.
- **Camadas**: Spec.

### UI-DUP — Lógica de conexão de fio duplicada entre `extension.ts` e `main.ts` no modo de autoria

- **Arquivo/função**: `extension/src/ui/webview/main.ts:2185` (conectar pino a fio existente, com
  split+junção) e `:4113` (conectar pino a pino) vs `extension/src/extension.ts:1135-1177` e `:684-696`
  (handlers `requestConnectPinToWire`/`requestConnectPins`).
- **Evidência**: durante autoria de subcircuito, `send()` é no-op (o mesmo mecanismo que já causou o
  "Symbol-authoring wire edit bug" corrigido em 2026-07-06, ver memória do projeto) — então `main.ts`
  reimplementa client-side, verbatim, a mesma lógica que `extension.ts` executa nos handlers do lado host.
  Hoje as duas cópias estão idênticas linha a linha.
- **Por que é problema**: é exatamente o padrão de duplicação que já causou um bug real neste projeto.
  Qualquer evolução futura da lógica de conexão do lado host (ex: nova regra de validação, novo tipo de
  nó) não se propaga automaticamente pro ramo de autoria — drift silencioso garantido na próxima mudança.
- **Relação com `.spec`/`.skill`**: a skill diz explicitamente que renderização/lógica de
  subcircuito/símbolo deve "passar por tradutor/parser único... e evoluir esse pipeline, não espalhar
  heurística por componente" — o princípio se aplica igualmente a lógica de interação duplicada por modo
  (normal vs. autoria), não só por typeId.
- **Impacto atual**: nenhum bug ativo hoje (as duas cópias estão sincronizadas), mas é uma bomba-relógio
  de manutenção.
- **Risco de corrigir**: médio — exige extrair a lógica de conexão para uma função pura compartilhada
  chamável tanto do host (via IPC) quanto do webview (local, quando `send()` é no-op), o que pode exigir
  reorganizar onde essa lógica mora (hoje ela pertence ao handler do lado extension.ts).
  Mudança de interação sem GUI de teste disponível — mudança de baixo risco lógico, mas precisa validação
  manual depois.
- **Proposta**: extrair a lógica de conexão de pino (split de fio, criação de junção, etc.) para uma
  função pura, testável, importável tanto por `extension.ts` quanto por `main.ts` (ou centralizar tudo do
  lado do webview, já que ele já tem que rodar local durante autoria de qualquer forma).
- **Disruptivo**: não quebra formato/API externa, é refatoração interna.
- **Camadas**: Extension + UI.

### HARD-1 — Normalização de manifesto duplicada em `registeredSources.ts`

- **Arquivo/função**: `extension/src/catalog/registeredSources.ts`.
  - Extração de ícone (`icon`/`iconSvgInline`/`iconFilePath`): `parseSubcircuitManifest:260-264` vs
    `resolveRegisteredItem` (branch abi-device/mcu-adapter) `:402-408`.
  - Extração de `folderPath`: `parseSubcircuitManifest:257-259` vs `resolveRegisteredItem:388-390`, e
    repetida em `UnifiedCatalog.ts:118-119` (`entryToWebview`) com a mesma fórmula
    `folderPath[0] ?? fallback`.
  - `defaultProperties` com prefixo `logicSymbol: false`: `parseSubcircuitManifest:276-278` vs
    `resolveRegisteredItem:421-423`.
- **Por que é problema**: são os mesmos ~5 blocos de lógica copiados 2-3x no mesmo arquivo (e um deles
  também em `UnifiedCatalog.ts`) — qualquer correção futura (ex: um bug de trim, um novo formato de
  ícone) exige replicação manual em todos os pontos, com risco real de esquecer um.
  `knownPinIdsForManifest`/`sanitizePackage`/`sanitizeManifestDefaultProperties` já foram corretamente
  extraídos como helpers compartilhados — estes três blocos ficaram de fora dessa extração.
- **Relação com `.spec`/`.skill`**: item EX-2 da auditoria anterior, deixado explicitamente "não
  iniciado" — agora confirmado e localizado com precisão.
- **Impacto atual**: nenhum bug ativo hoje (os caminhos ainda coincidem), risco é de drift silencioso.
- **Risco de corrigir**: baixo — refatoração pura, mesmo output, testável por unidade.
- **Proposta**: extrair `extractManifestIcon(json, manifestDir)`, `extractManifestFolderPath(json)`, e
  `withLogicSymbolDefault(logicSymbolPackage, sanitizeManifestDefaultProperties(json.defaultProperties))`
  como funções puras compartilhadas, usadas nos 2-3 pontos (e em `UnifiedCatalog.ts` pro caso de
  `folderPath`).
- **Disruptivo**: não.
- **Camadas**: Extension.

### HARD-2 — `extractPackageForEditing` reimplementa `sanitizePackage` com validação mais fraca

- **Arquivo/função**: `extension/src/extension.ts:1887-1932` (`extractPackageForEditing`) vs
  `extension/src/catalog/packageSanitizers.ts:736-808` (`sanitizePackage`).
- **Evidência**: as duas funções extraem os mesmos 15 campos de `PackageDescriptor`. Duas diferenças
  reais: (1) `extractPackageForEditing` só filtra `null`/não-objeto em `shapes`/`pins`/`viewSpec.paint`
  (via `sanitizeJsonObjectArray`), sem validar campos internos como `sanitizePackage` faz (via
  `sanitizePackageShape`/`sanitizeSimulidePaintSpec`/etc.) — parcialmente intencional (a edição precisa
  aceitar `pins: []`, que a paleta descartaria), mas sem a validação de tipo por campo; (2)
  `extractPackageForEditing` **não recebe `assetBasePath`** e não resolve `background.asset` para base64
  como `sanitizePackageBackground` faz — repassa o objeto cru sem `data`.
- **Por que é problema**: um pino malformado (`x`/`y` ausente ou string) passa direto sem erro e só quebra
  mais tarde em `seedSymbolAuthoringComponents` (posição vira `NaN`, pino invisível/quebrado, sem
  mensagem de erro). Para `background.asset`: abrir "Editar Símbolo" de um device cujo `package.background`
  usa `{kind: "image", asset: "bg.png"}` (referência externa, não base64 inline) mostraria o fundo sem
  imagem no editor, mesmo que o mesmo device renderize corretamente na paleta.
- **Relação com `.spec`/`.skill`**: mesma classe dos bugs de perda de dado já corrigidos (TR-4/TR-5,
  PC-16) — fallback silencioso escondendo erro real, exatamente o padrão que o escopo desta auditoria
  pediu pra procurar.
- **Impacto atual**: **latente** — nenhum arquivo real no repo (`devices/`, `subcircuits/`,
  `project/schema`) usa `background.asset` hoje (todos usam `data`/`value` inline), então não há bug
  ativo, mas o gap existe e vai quebrar silenciosamente no dia em que alguém usar essa combinação.
- **Risco de corrigir**: médio — a função é chamada em 3 pontos de autoria de símbolo; qualquer mudança de
  comportamento aqui é candidata a validação manual (sem GUI de teste disponível).
- **Proposta**: passar `manifestDir` como `assetBasePath` e reusar `sanitizePackageBackground`; avaliar se
  `extractPackageForEditing` pode virar uma variante fina de `sanitizePackage` (aceitando `pins: []`) em
  vez de reimplementar os 15 campos do zero — eliminaria o risco de drift quando `PackageDescriptor`
  ganhar um 16º campo.
- **Disruptivo**: baixo/médio.
- **Camadas**: Extension.

### DOC-1 — `docs/11-qemu-esp32.md` desatualizado sobre "Criar Subcircuito da Seleção"

- **Arquivo**: `docs/11-qemu-esp32.md:233-238,283-286` ("não existe o comando 'Criar Subcircuito a partir
  da Seleção'") vs `docs/16-roadmap-pendencias-spec.md:312,360,379,501` ("implementado em 2026-07-03") vs
  código real (`createSubcircuitFromSelectionCommand` existe em `extension.ts`/`main.ts`).
- **Por que é problema**: mesmo padrão de staleness que o handoff anterior já corrigiu em `docs/16`, mas
  não varreu para outros docs numerados.
- **Proposta**: atualizar/anotar `docs/11` apontando pra `docs/16`.
- **Disruptivo**: não. **Camadas**: Docs.

### DOC-2 — `docs/08-ui-webview.md` inteiro descreve design pré-reversão, sem aviso

- **Arquivo**: `docs/08-ui-webview.md:14-15` ("Paleta... é um TreeView nativo do VSCode"), `:26`
  ("Painel de propriedades — persistente, nunca modal") — exatamente as duas decisões que
  `.spec/lasecsimul.spec` §13 documenta como revertidas na prática.
- **Por que é problema**: a Fase 2 do handoff corrigiu `.skill`/`.spec`, mas não tocou neste doc de
  planejamento inicial (docs 00-14 parecem não terem sido atualizados desde o MVP original) — real risco
  de confundir um agente que leia `docs/08` (nome mais "óbvio" pra UI/Webview que `.spec` §13).
- **Proposta**: aviso no topo do doc ("planejamento inicial, decisões revertidas — ver `.spec` §13") ou
  reescrever.
- **Disruptivo**: não. **Camadas**: Docs.

### EX-B — `registerAdhocSubcircuit` payload desperdiçado

- **Arquivo**: `extension/src/extension.ts:401,730`; `extension/src/ipc/CoreClient.ts:204-207`.
- **Evidência**: os dois call sites chamam `registerAdhocSubcircuit` sem capturar o retorno
  (`RegisteredSubcircuitInfo`, que inclui `package`/`logicSymbolPackage`, potencialmente com imagens
  base64) — o Core lê+parseia+serializa, o valor trafega pelo IPC inteiro e é jogado fora; a Extension
  relê o MESMO arquivo do disco logo em seguida.
- **Por que é problema**: exatamente o padrão que a Fase 7 (PC-1/EX-7) tentou eliminar em outro fluxo
  ("objetos grandes trafegando sem necessidade") reaparecendo aqui.
- **Impacto atual**: baixo/médio — arquivos `.lssubcircuit` tendem a ser pequenos, mas um `package` com
  `background` tipo imagem+base64 pode não ser.
- **Proposta**: verbo IPC mais barato que não devolva o manifesto completo, ou documentar por que o
  desperdício é aceitável.
- **Disruptivo**: baixo. **Camadas**: Extension + Core (se mudar protocolo).

### TR-8 — Entradas hardcoded mortas em `componentSymbols.ts`

- **Arquivo**: `componentSymbols.ts:1002-1057` (`builtinComponentBox`) e `:1502-2040`
  (`componentSymbolSvg`).
- **Evidência**: `componentBox()`/`componentSymbolSvg()` sempre checam `resolvedPackageFor(typeId, ...)`
  primeiro. Confirmado (via cruzamento com `component-catalog.json`) que ~18 typeIds no switch já têm
  `package.pins.length > 0`, ou seja, o case correspondente nunca é alcançado: `passive.resistor`,
  `passive.capacitor`, `passive.inductor`, `other.ground`, `instruments.voltmeter`, `meters.probe`,
  `meters.ampmeter`, `meters.freqmeter`, `meters.oscope`, `meters.logic_analyzer`,
  `sources.fixed_volt`, `sources.clock`, `sources.wave_gen`, `sources.voltage_source`,
  `sources.current_source`, `sources.controlled_source`, `sources.battery`, `sources.rail`. Há um
  precedente exato de limpeza já feito certo (comentário nas linhas 1020-1024, sobre `switches.*`/`relay`
  removidos quando migraram).
- **Por que é problema**: código morto volumoso, risco de confusão/manutenção (alguém pode "corrigir" um
  desenho ali sem perceber que não roda mais).
- **Proposta**: deletar os cases confirmados mortos, seguindo o padrão já usado nas linhas 1020-1024.
- **Disruptivo**: não (remove código inalcançável). **Camadas**: UI.

### UI-TXT — `selectedTextLabel` sem auto-cura

- **Arquivo**: `main.ts:301-342` (declaração das 3 variáveis módulo-locais de seleção fora do
  state/undo), `:1545-1546` (`normalizeSelectedWireSegment`/`normalizeSelectedWireCorner`, chamadas a
  cada `render()`).
- **Por que é problema**: `selectedWireSegment`/`selectedWireCorner` têm auto-cura completa contra
  referências obsoletas após undo/redo; `selectedTextLabel` não tem equivalente — fica com referência a
  componente removido até o usuário clicar em outra coisa. Não crasha (acessos guardam com `.find()`),
  mas é inconsistência real entre os três irmãos deliberadamente fora do undo.
- **Proposta**: adicionar `normalizeSelectedTextLabel()` no mesmo ponto de `render()`.
- **Disruptivo**: não. **Camadas**: UI.

### EX-A — Função órfã `registeredSubcircuitInfoToParsedManifest`

- **Arquivo**: `extension/src/catalog/registeredSources.ts:290-348` + import não usado de
  `RegisteredSubcircuitInfo` (linha 4).
- **Evidência**: o diff **não commitado** atual de `extension.ts` (linhas 397-410, 726-737) trocou os 2
  únicos call sites por uma chamada direta a `parseSubcircuitManifest(readJsonFile(...))`. Não há mais
  nenhum call site da função em `extension/src`. Bônus: a função tinha um bug documentado nela mesma
  (linhas 342-345 — `RegisteredSubcircuitInfo` não devolve `components[]`/`chipId`, então
  `manifestHostsMcu` sempre caía em `false` nesse caminho) — a troca corrige esse bug de graça, só ficou
  incompleta (não removeu a função morta).
- **Nota**: isso é resultado do trabalho em andamento do próprio usuário (`git status` mostra
  `extension.ts` modificado, não commitado) — reportado para que a limpeza (deletar a função + import)
  seja incluída junto quando esse WIP for finalizado, não como achado independente de uma sessão passada.
- **Proposta**: apagar a função e o import órfão.
- **Disruptivo**: não. **Camadas**: Extension.

### PC-20 — Contribuição `view/item/context` morta em `package.json`

- **Arquivo**: `extension/package.json:138-144`.
- **Evidência**: `lasecsimul.componentPalette` é `"type": "webview"` — VSCode só aplica
  `view/item/context` a `TreeItem`s de `TreeView`; webview view não expõe `contextValue`. Confirmado que
  `lasecsimul.palette.component.registered`/`.disabled` não é atribuído em lugar nenhum do código atual —
  herança do `ComponentPaletteProvider.ts` já deletado (PC-6).
- **Proposta**: remover o bloco. **Disruptivo**: não. **Camadas**: manifesto da extensão.

### PC-21 — Mensagem de erro com mojibake

- **Arquivo**: `extension/src/extension.ts:1859` — `"Esse item faz parte do catÃ¡logo integrado e nÃ£o
  pode ser removido pela paleta."` (encoding duplo, deveria ser "catálogo"/"não").
- **Proposta**: corrigir a string. **Disruptivo**: não. **Camadas**: Extension.

### SPEC-1 — Auto-contradição de extensão de arquivo em `.spec/lasecsimul-subcircuits.spec`

- **Arquivo**: `.spec/lasecsimul-subcircuits.spec:37` ("salvo em disco como `.json`") vs `:64` ("definido
  por um único arquivo `*.lssubcircuit`") — resquício de antes da migração de extensões (2026-07-06).
- **Proposta**: corrigir linha 37 para `.lssubcircuit`. **Disruptivo**: não. **Camadas**: Spec.

### SPEC-2 — Spec referencia `TreeItem.iconPath`, API não mais usada

- **Arquivo**: `.spec/lasecsimul.spec:1296-1298` vs código real (`paletteTree.ts:4-5,135-136`,
  `palette.ts:53`) que resolve ícone via `iconLightUri`/`iconDarkUri` (URIs de webview).
- **Proposta**: trocar a referência. **Disruptivo**: não. **Camadas**: Spec.

### DOC-3 — `docs/07` referencia `ui/commands/` inexistente

- **Arquivo**: `docs/07-extension-typescript.md:33` vs `.spec/lasecsimul.spec:1276` (já correto: "não
  existe `ui/commands/` como diretório separado").
- **Proposta**: atualizar `docs/07` pra apontar pro `.spec`. **Disruptivo**: não. **Camadas**: Docs.

### SPEC-4 — Mojibake em `.spec/lasecsimul-native-devices.spec` (WIP não commitado)

- **Nota informativa**: o diff não commitado atual tem `"cada perifÃ©rico UART/USART... pinos fÃ­sicos"`
  (corrupção de encoding). É trabalho do próprio usuário ainda não commitado — reportado só para não
  passar despercebido antes do commit.

### PERF-1 — `updateWiresTouchingComponent` scan O(n)

- **Arquivo**: `main.ts:2568`. Faz scan de todos os fios a cada `pointermove` durante drag de componente
  (a Fase 6 anterior otimizou o lookup de elemento DOM via Map, mas não indexou "fios que tocam este
  componente" por Map). **Proposta**: indexar fios por componente tocado. **Disruptivo**: não.

### PERF-2 — `render()` com 5 passes separados

- **Arquivo**: `main.ts:1585`. Itera `state.components` inteiro 5 vezes em `.filter()` separados em vez de
  um loop único. **Proposta**: consolidar em um loop. **Disruptivo**: não.

### OPT-1 — `loadUnifiedCatalog` sem cache

- **Arquivo**: `extension.ts` (7+ call sites: linhas 1469, 1722, 1821, 1851, 2053, 2272, 2559) relendo e
  reparseando `component-catalog.json` do disco a cada chamada. Não é bug (sempre reflete o disco), só
  oportunidade de performance se algum call site acontecer em sequência quente. Vale revisitar se EX-9
  passar por ali de qualquer forma.

### OPT-2 — Contador de pinos na paleta ignora idioma

- **Arquivo**: `palette.ts:114` — `"pinos"` hardcoded pt-BR mesmo com `state.language === "en"`.
  **Proposta**: chave `UI_TEXT` nova para os dois idiomas.

---

## 5. Pontos de hardcoded que devem virar translator/parser

- **TR-9** (keypad) é o caso mais sério: a geometria/pinos do keypad precisam ser genuinamente derivados
  da instância (`rows`×`columns`), não fixos por typeId — hoje só o desenho visual (`simulidePaint`) é
  dinâmico, bounds e pinos não são. Requer decidir se `package` vira algo computável por instância (hoje
  é só por typeId).
- **PC-19** (diálogo de propriedades) é hardcoded residual isolado, fácil de trocar pro metadado já
  existente (`componentVisualFlags`).
- **TR-8** não é hardcoded "ativo" (é código morto inalcançável), mas simbolicamente é o mesmo padrão —
  vale limpar junto com qualquer trabalho nessa área.

Fora esses três pontos, **os agentes não encontraram novos casos de mapeamento visual hardcoded por
typeId fora do módulo do device** — o trabalho da auditoria anterior (TR-1/2/3/4/5/7) parece ter coberto
bem esse eixo. `simulidePaint.ts` cobre um conjunto razoável de primitivas do SimulIDE (line, rect,
roundedRect, ellipse, arc, path, polygon, polyline, text, image, repeat, gradientes) sem lacuna óbvia
identificada dentro do tempo desta investigação.

---

## 6. Código morto/legado encontrado

- TR-8 — ~18 entradas mortas em `componentSymbols.ts`.
- EX-A — `registeredSubcircuitInfoToParsedManifest` (órfã por causa de WIP não commitado).
- PC-20 — contribuição `view/item/context` morta em `package.json`.
- Nenhum resquício de `.lsconfig`/`.lssub.json`/JSON solto de device, nem de `worker_threads`/WASM, foi
  encontrado em código vivo — a migração de extensões e o abandono do caminho WASM estão limpos.

---

## 7. Melhorias de performance possíveis

- PERF-1, PERF-2 (acima) — pequenas, não em hot-path crítico.
- OPT-1 — cache de `loadUnifiedCatalog`, só relevante se um caminho de código chamar em sequência quente.
- EX-B — evitar round-trip de payload descartado em `registerAdhocSubcircuit`.
- Nenhum recálculo pesado, listener duplicado real (fora do que já foi corrigido), ou redraw global
  desnecessário foi encontrado além do já mencionado — a Fase 6 da auditoria anterior parece ter coberto
  bem os pontos mais caros (reconciliação incremental de fios/componentes, drag cirúrgico, undo com
  dirty-check antes do clone).

---

## 8. Inconsistências com o SimulIDE

Nenhuma inconsistência de comportamento visual/funcional foi encontrada nos pontos comparados
diretamente contra `C:\SourceCode\simulide_2` (grid de fio 8px/`snapToGrid4`, seleção por marquee com
interseção simples — não direcional AutoCAD-like —, fórmula de zoom por scroll com limite próprio do
LasecSimul). A única divergência de comportamento real encontrada é o TR-9 (keypad), que não é uma
divergência do SimulIDE em si, mas uma quebra da paridade "package genérico reflete a instância real" que
o próprio LasecSimul se propôs a ter.

---

## 9. Inconsistências com o princípio de arquivo único

- **FMT-1** é a inconsistência real: o fluxo de criação de subcircuito hoje efetivamente *depende* de um
  `library.json` de pasta (um índice compartilhado, não um sidecar por item, mas na prática funciona como
  bloqueio se ausente) que o próprio spec diz não ser obrigatório para subcircuito avulso.
- Fora isso, `.lsdevice`/`.lssubcircuit` não apontam para nenhum outro JSON de configuração (só para
  artefatos binários/imagem, conforme o princípio), e `.lsproj` referencia subcircuitos só via
  `subcircuitRef.path`, sem caminho legado. **Não há necessidade de migração de formato** — o princípio de
  arquivo único já está implementado corretamente na esmagadora maioria dos casos; o único ponto de
  atrito é lógico (FMT-1), não de formato.

---

## 10. Mudanças disruptivas recomendadas

Nenhum achado desta rodada exige quebrar formato de arquivo (`.lsdevice`/`.lssubcircuit`/`.lsproj`) ou
API pública. As únicas mudanças com risco arquitetural real são:

1. **TR-9** — se a decisão for "package computável por instância" (não só por typeId), é uma mudança de
   arquitetura no pipeline de `package`/`registerPackage` (hoje 1:1 com typeId). Precisa de decisão do
   usuário sobre o escopo antes de implementar.
2. **EX-E** — unificar as filas de mutação do Core é uma refatoração de fluxo interno, moderadamente
   arriscada por não ser testável interativamente aqui.
3. **EX-9** (modularização de `extension.ts`, herdada da rodada anterior, ainda pendente) — não é um
   achado novo desta auditoria, mas continua sendo a maior mudança estrutural pendente no projeto.

---

## 11. Plano de refatoração por fases

**Fase A — Correções pontuais de baixo risco, sem GUI necessária (validável por compilação/teste)**
- PC-19 (troca de hardcoded por metadado já existente)
- TR-8 (remover código morto)
- EX-A (remover função órfã do WIP em andamento)
- PC-20 (remover contribuição morta de `package.json`)
- PC-21 (corrigir mojibake)
- UI-TXT (adicionar auto-cura de `selectedTextLabel`)
- HARD-1 (extrair helpers compartilhados de normalização de manifesto)
- OPT-2 (chave de tradução pro contador de pinos)

**Fase B — Documentação (custo zero, sem risco de regressão)**
- SPEC-1, SPEC-2, SPEC-3, DOC-1, DOC-2, DOC-3
- SPEC-4 é responsabilidade do próprio usuário ao commitar o WIP atual (só um lembrete).

**Fase C — Correções de lógica com impacto funcional real, risco baixo/médio**
- FMT-1 (subcircuito nascendo desabilitado — crítico, mas correção é localizada e de baixo risco)
- HARD-2 (`extractPackageForEditing` — bug latente, ainda não exercitado, mas vale corrigir antes que
  algum device real use `background.asset`)
- EX-B (evitar round-trip desperdiçado)
- PERF-1, PERF-2, OPT-1 (performance incremental)

**Fase D — Mudanças arquiteturais, precisam de decisão do usuário antes de implementar**
- TR-9 (keypad — decidir entre package dinâmico por instância vs. fixar 4×4)
- EX-E (unificar filas de mutação do Core)
- UI-DUP (extrair lógica de conexão de fio compartilhada entre host e webview)
- EX-9 (continuar modularização de `extension.ts`, herdada da rodada anterior — ver
  `docs/21-handoff-auditoria-61-achados.md` seção "Fase 8" pro plano de extração já detalhado:
  `project/projectCommands.ts`, `symbolAuthoring/symbolCommands.ts`, `mcu/mcuCommands.ts`, e um quinto
  cluster novo identificado nesta rodada: `catalog/catalogCommands.ts` — linhas 1612-1882 de
  `extension.ts`, ~270 linhas de `registerCatalogFileCommand`/`removeRegisteredCatalogItemCommand`/
  `refreshUnifiedCatalogState`/`attachPropertySchemas`/`inferSourcesFromSelectedFile`).

> Pós-implementação: a decisão explícita do usuário já foi dada para TR-9, EX-E e EX-9; estes itens, junto
> de UI-DUP, foram implementados na sequência registrada no topo deste documento. Esta lista permanece como
> histórico do plano original da auditoria.

---

## 12. Ordem recomendada de execução

1. Fase A (baixo risco, alto volume de limpeza — fecha rapidamente).
2. Fase B (custo zero, evita retrabalho de futuras sessões que leiam spec desatualizada).
3. **FMT-1 isolado, prioridade máxima dentro da Fase C** (é o único achado crítico — bloqueia um fluxo
   principal documentado do produto).
4. Resto da Fase C.
5. Fase D, item por item, cada um com uma rodada de `AskUserQuestion` antes de implementar (como já é o
   padrão estabelecido na sessão anterior) — não hoje, quando o usuário decidir avançar.

---

## 13. Testes necessários por fase

- **Fase A/B**: `npx tsc -p tsconfig.json --noEmit`, `npx tsc -p tsconfig.webview.json --noEmit`,
  `npx tsc -p tsconfig.test.json`, `npx mocha "out-test/src/**/*.test.js" --recursive` (rodar do
  diretório `extension/`). Fase B não tem impacto em build/teste (só markdown), mas rodar mesmo assim por
  segurança se algum spec for referenciado por teste de conformidade.
- **Fase C**:
  - FMT-1: os 4 comandos acima + teste de regressão novo cobrindo "criar subcircuito da seleção → item
    aparece habilitado na paleta sem `library.json`" (hoje não existe, precisa ser escrito).
  - HARD-2: teste de regressão cobrindo `extractPackageForEditing` com `background.asset` populado,
    confirmando que falha sem o fix e passa com o fix (padrão já usado no projeto).
  - EX-B, PERF-1, PERF-2, OPT-1: os 4 comandos padrão bastam (mudança comportalmente idêntica).
- **Fase D**:
  - TR-9: se mudar Core (package dinâmico), rebuild completo (`node scripts/build-core.js --config=Debug`)
    + `ctest` (excluindo `esp32_devkitc_subcircuit`, falha pré-existente conhecida) + os 4 comandos de
    TS/teste + **validação manual interativa explícita** (colocar keypad, mudar `rows`/`columns`,
    conferir visualmente) — não há GUI de teste automatizado aqui, então isso precisa ser feito pelo
    usuário ou reportado como pendente.
  - EX-E: os 4 comandos padrão + validação manual interativa explícita (drag rápido + save concorrente) —
    mesma ressalva, sem harness de interação automatizado neste projeto.
  - UI-DUP: os 4 comandos padrão + validação manual (criar/editar fio dentro de "Abrir Subcircuito"),
    comparando com o comportamento do modo normal.
  - EX-9: os 4 comandos padrão a cada módulo extraído (não em lote), como já documentado no handoff
    anterior — reverter e tentar de novo é mais barato que consertar em cima de um estado confuso.

---

## Referência: achados da rodada anterior confirmados como já corrigidos (não repetidos acima)

Confirmado por leitura ativa do código atual, não só por confiar no handoff: TR-1/2/3/4/5/5b/7, PC-1, PC-4,
PC-6, PC-16, PC-18, EX-3.1, EX-4.1, EX-4.2, EX-6.1/6.2/6.3, EX-7, UI-1 a UI-11 (exceto a ressalva UI-TXT
acima, que é um resíduo pequeno dentro do escopo de UI-12). Ver `docs/21-handoff-auditoria-61-achados.md`
para o detalhe de cada um.

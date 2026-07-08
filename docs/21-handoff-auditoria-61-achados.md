# 21 — Handoff: implementação dos 61 achados da auditoria de UI/Extension/Core

> **Para o próximo agente**: este documento existe porque a sessão que implementou isto pode ter
> ficado sem contexto/tokens no meio da FASE 8. Leia isto ANTES de continuar. O pedido original do
> usuário foi (verbatim, maiúsculas dele): *"QUERO QUE IMPLEMENTE TODAS NA ORDEM CERTA E NÃO DEIXE
> NADA PARA TRAZ MAS NÃO PERCA FUNCIONALIDADE HOJE EXISTENTES"* — implementar TODOS os 61 achados,
> na ordem do plano faseado, sem pular nenhum, sem quebrar nada que já funciona.

## Contexto: de onde isto veio

Uma auditoria completa da UI/Extension/Core do LasecSimul (pedida em turno anterior, texto original
não persistido em arquivo — só existiu na conversa, que foi resumida/perdida) encontrou 61 achados,
classificados por severidade, e propôs um plano de 8 fases. O usuário pediu para implementar TODAS
na ordem certa. Os achados têm ids curtos tipo `TR-4`, `UI-7`, `PC-16`, `EX-9` (provavelmente:
TR=tradutor/render, UI=interface da Webview, PC=protocolo/core, EX=extension.ts). Não existe mais um
arquivo com a lista completa dos 61 — o que sobrevive é o rastro de trabalho feito (git log, TodoWrite
history) e este documento.

## Regras de execução que se aplicam ao trabalho restante (aprenda com o que já foi feito)

1. **A cada item, valide de verdade antes de seguir**: `npx tsc -p tsconfig.json --noEmit` (extension
   host), `npx tsc -p tsconfig.webview.json --noEmit` (Webview), `npx tsc -p tsconfig.test.json`
   (compila os testes) e `npx mocha "out-test/src/**/*.test.js" --recursive` (roda tudo). Rode os 4 a
   cada mudança não-trivial. Todos os comandos abaixo assumem `cd c:/SourceCode/LasecSimul/extension`
   primeiro.
2. **Mudanças no Core (C++) exigem rebuild + ctest**: `node scripts/build-core.js --config=Debug`
   (na raiz do repo) e depois `ctest --test-dir core/build -C Debug --output-on-failure` (sem `-E`
   nenhum -- `esp32_devkitc_subcircuit` foi corrigido em 2026-07-08, ver seção "Armadilhas
   conhecidas" abaixo; a exclusão só fazia sentido antes disso).
3. **Não há GUI/harness de teste de interação** neste ambiente — não dá pra abrir o VSCode de verdade
   e testar drag-and-drop/undo/render visualmente. Por isso: (a) prefira mudanças que sejam
   comportamentalmente idênticas e só verificáveis por compilação+teste (refatoração pura, mover
   código sem mudar lógica), e (b) quando um achado exigir uma mudança arquitetural grande com risco
   real de regressão silenciosa (proto colo de sync, undo/redo, drag), PARE e pergunte ao usuário antes
   de prosseguir, apresentando as opções de escopo (ver exemplos de perguntas feitas nas Fases 5-8, o
   padrão usado foi a ferramenta AskUserQuestion com 2-3 opções, a recomendada primeiro).
4. **O usuário, quando perguntado sobre itens grandes/arriscados nesta sessão, escolheu "fazer
   completo, risco assumido" quase toda vez** (EX-4.2, PC-1/EX-7, PC-16, EX-9). Ele está confortável
   com risco calculado DESDE QUE eu valide exaustivamente por compilação/teste. Não precisa ficar
   perguntando de novo pra cada item do MESMO tamanho — só pergunte quando a decisão for genuinamente
   nova/ambígua (ex: qual de duas arquiteturas concorrentes usar).
5. **Nunca usar `git checkout`/`reset --hard` pra desfazer os próprios erros** (memória permanente do
   usuário: quase apagou trabalho não commitado uma vez). Se precisar desfazer algo, use edição
   reversa ou `git stash`.
6. **Sempre criar testes de regressão novos pra bugs REAIS encontrados no caminho** (não só pro achado
   em si) — padrão usado a sessão inteira: escrever o teste, confirmar que FALHA sem o fix (reverter
   temporariamente), confirmar que passa COM o fix, then seguir.
7. **Sem comentários explicando O QUE o código faz — só POR QUÊ, quando não-óbvio.** Sem emojis. Sem
   commits automáticos (só se o usuário pedir explicitamente).

## Estado atual: o que já foi implementado (Fases 1-7 completas, Fase 8 em andamento)

Todas as Fases 1-7 (ver lista completa de sub-itens abaixo) estão **implementadas, testadas e
validadas** — zero regressão na suite inteira (`npx mocha "out-test/src/**/*.test.js" --recursive`
mostra 0 falhas em todos os arquivos de teste). Não é preciso revisitar nada das Fases 1-7 a menos que
um teste comece a falhar.

### Fase 1 — Correções de perda de dados (crítico)
- TR-4/TR-5: round-trip de `PackagePin` e preservação de `shapes[]` não suportados no editor de símbolo.
- PC-14: `label`/`showId`/`showValue` de componente interno de subcircuito não persistiam.
- Arquivos principais: `extension/src/catalog/symbolAuthoring.ts`, `extension/src/extension.ts`.

### Fase 2 — Documentação (`.skill`, `.spec`, `docs/`)
- Correções de divergência entre `.skill`/`.spec` e o código real (paleta, painel de propriedades,
  organização de pastas). Ver `.skill/lasecsimul.skill` e `.spec/lasecsimul.spec` seção 5/13.

### Fase 3 — Arquitetura duplicada
- PC-6: paleta duplicada — `extension/src/ui/tree/ComponentPaletteProvider.ts` (nunca usado) foi
  DELETADO via `git rm`. A paleta real é a Webview (`palette.ts`).
- TR-5b: editor de símbolo agora lê `package.viewSpec.paint` pra semear componentes de referência
  visual, e `compileSymbolAuthoringComponents` preserva `viewSpec`/`simulidePaint`/`qtWidget` verbatim
  (bug mais grave descoberto no caminho: salvar um símbolo destruía esses 3 campos por completo).

### Fase 4 — Código morto
- TR-1/2/3: ~130 linhas de entradas mortas em `extension/src/ui/webview/componentSymbols.ts`
  (typeIds que migraram pra `package` real via `devices/library.json` — a tabela hardcoded antiga
  nunca mais era alcançada). Helpers órfãos removidos junto (`ioComponentBox`, `logicComponentBox`,
  `TRANSISTOR_BOX`, `labelBox`).
- UI-10: 3 funções mortas em `main.ts` (`getSelectedWires`, `nearestPointOnWire`, `refreshWireColors`)
  removidas; `refreshReadouts()` (também morta) foi RECONECTADA no handler de `componentReadout` —
  agora só faz `render()` completo quando algum componente do circuito precisa de leitura embutida no
  próprio SVG (medidores), senão usa o caminho barato (`refreshReadouts`).
- EX-3.1: tipo morto `ProjectVisualComponent`/`ProjectVisualPin` removido de
  `extension/src/project/ProjectTypes.ts` (campo `visual.components` do `.lsproj` nunca era lido, só
  salvo vazio — a posição real vive em `ProjectComponent.visual`, campo aninhado por componente).
- PC-18: `.js` compilados soltos no `src/` removidos (`git rm`); descoberta maior no caminho: a pasta
  `dist/` inteira (build/empacotamento) e `packaging/*/obj/` estavam rastreadas no git por engano —
  `git rm -r --cached` + entradas novas no `.gitignore` (arquivos continuam no disco, só saíram do
  versionamento).

### Fase 5 — Hardcoded → metadado genérico
- UI-7: `readoutFormat.kind` (ABI v2) agora decide forma de histórico/popup de instrumento em 4 pontos
  de `main.ts` (antes comparava `typeId === "meters.oscope"` direto) via novo helper
  `instrumentHistoryKind()`.
- EX-4.1: `manifestHostsMcu` não usa mais prefixo `"espressif."` hardcoded — agora recebe um
  `Set<string>` de typeIds de mcu-adapter REAIS (`collectMcuAdapterTypeIds`, pré-varre as fontes antes
  de resolver subcircuitos).
- EX-4.2: **mudança no Core C++**. `pinIds` canônicos de builtins sem `package` (resistor, ground,
  tunnel, rail, fixed_volt, battery) agora vêm do Core via `getPropertySchemas` (novo mapa
  `pinIdsByTypeId` no payload IPC), não de uma tabela JS duplicada
  (`canonicalBuiltinPinIds`, removida). Ver `core/src/app/CoreApplication.cpp` (`registerBuiltinMetadata`
  ganhou parâmetro `canonicalPinIds`) e `core/src/session/SimulationSession.*`.
- UI-6: `effectiveShowValue()` — função única em `main.ts`, antes duplicada 2x idêntica.
- UI-11/PC-12: `componentVisualFlags()` — função única em `main.ts` que computa
  `isPushButton`/`isSwitchToggle`/`isFixedVolt`/etc. de uma vez, antes duplicada entre
  `createComponentElement`/`updateComponentElement`.
- TR-7: `TUNNEL_TYPE_ID`/`JUNCTION_TYPE_ID` — constantes únicas em `ui/webview/model.ts`, usadas nos
  ~10 lugares que antes tinham o literal `"connectors.tunnel"`/`"connectors.junction"` espalhado (a
  LÓGICA de cada exceção continua onde estava — só a string virou constante compartilhada).

### Fase 6 — Performance de renderização
- UI-4: reconciliação incremental de fios — `wirePolylineElementsById: Map` em `main.ts`, o
  `<polyline>` de cada fio agora é REAPROVEITADO entre renders (não recriado do zero), igual ao padrão
  já existente pra componentes (`componentElementsById`).
- UI-2/UI-3: drag de canto/segmento de fio agora chama `updateWireVisual(wireId)` (atualização
  cirúrgica só daquele fio) em vez de `render()` completo a cada `pointermove`; drag de componente e
  `updateWiresTouchingComponent` agora usam lookup O(1) via Map em vez de `document.querySelector`.
- UI-1: guarda de render concorrente generalizada — `isInteractiveGestureInProgress()` (cobre drag de
  componente E drag de fio) substituiu `isDraggingComponent` sozinho nos 3 pontos que decidem se um
  tick de telemetria pode disparar `render()`.
- UI-5: `persistState`/undo — a comparação de conteúdo (`undoContentKey`) agora roda ANTES do
  `structuredClone` caro (`recordUndoTransition` foi refatorado pra receber `(key, captureFn)` em vez
  de um snapshot já pronto) — clona só quando o conteúdo REALMENTE mudou. Decisão importante: o
  usuário pediu uma "dirty-flag manual" mas foi implementada uma versão mais segura que não precisa de
  auditoria de todo ponto de mutação (ver `extension/src/ui/webview/main.ts::recordUndoTransition`).
- EX-6.3: `queueCoreRebuild()` agora COALESCE chamadas concorrentes (`rebuildScheduled` flag) — N
  chamadas em rajada (ex: apagar N fios selecionados) viram só 1 rebuild agendado, não N sequenciais.

### Fase 7 — Protocolo IPC e Core
- EX-6.1/EX-6.2: **mudança no Core C++**. Novo verbo IPC `disconnectWire` (espelha `connectWire`) —
  `Netlist::disconnectWire` já existia mas nunca tinha sido exposto; agora
  `SimulationSession::disconnectWire` + handler IPC em `CoreApplication.cpp` + `CoreClient.ts`
  (`disconnectWire()`) + `extension.ts` (`pushRemoveWireToCore`, com fallback pro rebuild completo se
  os dois lados do fio não tiverem instância resolvida no Core). Remover 1 fio não precisa mais
  reconstruir o circuito inteiro.
- PC-1/EX-7: **protocolo de sync Extension↔Webview mudou**. Nova mensagem `"syncStatePatch"` (ao lado
  de `"syncState"`/`"init"`, que continuam existindo pra ressync completa) — manda só os campos de
  `WebviewProjectState` que mudaram desde o último sync (comparação por referência, barata,
  `lastSyncedProjectState` em `extension.ts`). Bug real encontrado e corrigido no caminho:
  `pendingConnection` (campo opcional) precisa de um sentinela `null` explícito pra "limpar" — `undefined`
  desaparece silenciosamente de um `JSON.stringify`. Ver `computeProjectStatePatch`
  em `extension.ts` e o handler `syncStatePatch` em `main.ts`.
- PC-16: validação de schema em entradas externas — 3 pontos corrigidos (não um subsistema novo de
  validação, um audit prévio mostrou que quase tudo já era defensivo): `extractPackageForEditing`
  (extension.ts) agora filtra elementos `null` de `pins[]`/`shapes[]`/`viewSpec.paint[]`;
  `registeredSubcircuitInfoToParsedManifest` filtra `null` em `interface[]`; `UnifiedCatalog.ts`
  ganhou `sanitizeStringArray`/`entryToWebview` exportados e usados pra proteger `pinIds` malformado
  vindo de `component-catalog.json`.
- PC-4: **mudança em `CoreClient.ts`**. `_onData` trocou `data.toString("utf8")` (corrompia
  caracteres multi-byte cortados na fronteira entre 2 chunks de socket — praticamente todo texto
  acentuado deste app, que é majoritariamente pt-BR) por `StringDecoder` do Node (decodifica
  incrementalmente, nunca corrompe). Teste de regressão em `CoreClient.test.ts` prova o bug
  (confirmado falhando sem o fix, revertido e re-testado antes de finalizar).

## Fase 8 — EM ANDAMENTO (é AQUI que o próximo agente continua)

Esta é a fase de MAIOR risco do plano inteiro (mudança estrutural grande em vez de correção
pontual). O usuário JÁ escolheu "fazer completo, risco assumido" pra EX-9 quando perguntado — não
precisa perguntar de novo a menos que surja uma decisão genuinamente nova.

### EX-9: Modularizar `extension.ts` em módulos por domínio — PARCIALMENTE FEITO

`extension.ts` tinha 4387 linhas antes de eu começar. Está em **2592 linhas agora** (41% de redução,
depois de 5 extrações). O ALICERCE (`state.ts`) já existe e já está em uso — o próximo módulo de
domínio (`project/projectCommands.ts` ou similar) NÃO precisa mais inventar o padrão, só seguir o
mesmo já estabelecido abaixo.

**O que já foi extraído (e está validado, compilando e testando limpo — 152 asserções, 0 falhas):**
1. `extension/src/pathUtils.ts` (novo) — `normalizeAbsolutePath`/`fileExists`/`readJsonFile`, usados
   em `extension.ts`, `packageSanitizers.ts` E `catalog/registeredSources.ts`.
2. `extension/src/catalog/packageSanitizers.ts` (novo, ~700 linhas) — toda a sanitização de
   `package`/`viewSpec`/`simulidePaint`/`qtWidget` vinda de JSON externo (`.lsdevice`/`.lssubcircuit`).
   Único bloco do arquivo inteiro que era 100% livre de estado mutável de módulo (verificado por
   grep antes de mexer — nenhuma referência a `coreClient`/`schematicState`/etc. dentro do bloco).
   Superfície pública real: só `sanitizePackage`/`sanitizeManifestDefaultProperties` são chamadas de
   fora; o resto é máquina interna, exportado por uniformidade/testabilidade.
3. `extension/src/currentLanguage.ts` (novo) — wrapper impuro (`vscode.workspace`/`vscode.env`) em
   volta de `resolveLasecSimulLanguage` (que fica em `language.ts`, deliberadamente sem import de
   `vscode`, pra continuar testável). Existe como arquivo PRÓPRIO (não dentro de `pathUtils.ts` nem
   `language.ts`) só pra evitar import circular: tanto `extension.ts` quanto
   `catalog/registeredSources.ts` precisam dele.
4. `extension/src/catalog/registeredSources.ts` (novo, ~530 linhas) — TUDO relacionado a resolver
   fontes registradas do catálogo (`RegisteredSource` → `ResolvedRegisteredItem`): parsing de
   manifesto (`.lsdevice`/`.lssubcircuit`), inferência de pasta/biblioteca, mensagens localizadas de
   erro/pasta, `manifestHostsMcu`/`collectMcuAdapterTypeIds`, `resolveRegisteredItem(s)`. Esta
   extração foi mais complexa que as duas primeiras porque o bloco original NÃO era contíguo em
   `extension.ts` — havia funções que MEXEM em `schematicState`/etc. intercaladas no meio do range de
   linhas (`nextId`, `cloneState`, `syncSchematicPanel`, etc.) que tiveram que ficar pra trás; a
   extração foi feita em 3 blocos separados de deleção em vez de um só. Superfície que `extension.ts`
   ainda importa de lá (as outras ~15 exports viraram máquina 100% interna do módulo, sem call site
   fora dele): `RegisteredItemKind`, `inferLibraryPathForDevice`, `sanitizeFolderPathSegments`,
   `folderPathFromManifestFile`, `localizedAbiFailure`, `knownPinIdsForManifest`,
   `parseSubcircuitManifest`, `registeredSubcircuitInfoToParsedManifest`, `resolveRegisteredItem`,
   `resolveRegisteredItems`.
5. `extension/src/state.ts` (novo, O ALICERCE) — resolve o problema de `export let X` do ES module
   (só o módulo que declara `X` pode reatribuí-lo; um importador só pode LER). Padrão escolhido: um
   ÚNICO objeto `export const state = { coreProc, coreClient, schematicPanel, schematicState,
   currentProjectFilePath, simulationStatus, paletteViewProvider, extensionContext, trustStore,
   lastSyncedProjectState, voltageReadoutTimer }` — qualquer módulo importador PODE fazer
   `state.coreClient = x` (é mutação de PROPRIEDADE do objeto, não reatribuição do binding `state`
   em si, então o ES module não bloqueia). As 3 Maps (`coreInstanceIdByComponentId`,
   `mcuTargetCoreIdByComponentId`, `mcuSerialMonitorByKey`) e `projectSerializer` ficam FORA do
   objeto `state` (são `const`, mutam via método — `.set()`/`.get()` —, nunca precisaram de proteção
   contra reatribinição). A migração de `extension.ts` inteiro (todo `coreClient` virou
   `state.coreClient`, 278 linhas afetadas) foi feita com um script Node.js descartável (NÃO um
   `sed`/regex manual linha a linha) -- ver "Armadilha" abaixo sobre um bug real que esse script
   introduziu e como foi pego.
6. `extension/src/core/coreLifecycle.ts` (novo, ~510 linhas) — toda a comunicação com o Core:
   push de mutações (`pushComponentToCore`/`pushWireToCore`/`pushRemoveWireToCore`/
   `pushPropertyToCore`/`pushRemoveToCore`), decodificação de leituras (`decodeComponentReadout`/
   `decodeInstrumentHistory`), polling (`pollInstrumentReadouts`/`pollWireVoltages`/
   `start|stopVoltageReadoutPolling`), ciclo de vida da simulação (`run|pause|stopSimulation`,
   `setSimulationStatus`) e reconstrução completa (`queueCoreRebuild`/`rebuildCoreFromSchematicState`).
   Importa `pinsForTypeId` DE VOLTA de `extension.ts` (import circular deliberado e seguro -- só usado
   dentro de corpo de função, nunca em tempo de avaliação de módulo; `pinsForTypeId` é usado por
   3 outros lugares fora do domínio core-lifecycle, então não fazia sentido duplicá-lo nem movê-lo).
   `extension.ts` importa de volta ~18 símbolos deste módulo (`reportCoreWarning` sozinho tem 12 call
   sites espalhados por praticamente todo domínio -- mcu, project, symbolAuthoring -- confirmando que
   é uma utility genuinamente compartilhada, não específica de core).

**Armadilha real descoberta e corrigida durante a extração de `state.ts` (LEIA antes de repetir o
padrão do script de rename em outro módulo):** o script Node.js que renomeou `coreClient` →
`state.coreClient` etc. em todo `extension.ts` usa regex `\bSYMBOL\b` — isso não distingue
IDENTIFICADOR de STRING LITERAL. Duas ocorrências de `type: "simulationStatus"` (uma constante de
protocolo IPC real, usada em `main.ts` pra rotear a mensagem, ver `messages.ts`) foram corrompidas
pra `type: "state.simulationStatus"` -- e o `tsc` NÃO acusou erro nenhum, porque
`SchematicPanel.postMessage(message: unknown)` não tipa o payload (gap de tipagem pré-existente, fora
de escopo consertar agora). Só foi pego por auditoria manual (`grep` procurando por `"state\.` dentro
de strings) DEPOIS do compile limpo -- ou seja, **`tsc` limpo não é suficiente pra confiar num rename
em massa feito por regex; sempre gre pelo padrão `['"]state\.SYMBOL` extra depois de qualquer rename
similar, mesmo com 0 erros de compilação.** Se for repetir esse padrão de "objeto `state` único" pra
outro conjunto de variáveis no futuro (não deveria ser necessário -- `state.ts` já existe e está
completo), rode essa auditoria extra.

**Estado da validação no momento em que este documento foi atualizado:** todos os 4 comandos de
validação rodados e limpos (`tsc` extension host, `tsc` webview, `tsc` test compile, `mocha` — 152
passando, 0 falhando).

**O que falta em EX-9 (o grosso do trabalho):**

`extension.ts` ainda tem ~150 funções e ~15 variáveis de estado mutável de nível de módulo
(`coreClient`, `schematicState`, `schematicPanel`, `coreProc`, `currentProjectFilePath`,
`simulationStatus`, `paletteViewProvider`, `extensionContext`, `trustStore`,
`coreInstanceIdByComponentId`, `mcuTargetCoreIdByComponentId`, `mcuSerialMonitorByKey`,
`lastSyncedProjectState`, `voltageReadoutTimer`, `rebuildQueue`, `rebuildScheduled` — ver topo do
arquivo). A questão arquitetural central pra qualquer extração futura: **como o estado mutável
compartilhado atravessa módulos**.

**Padrão JÁ IMPLEMENTADO em `state.ts` (não é mais teórico — leia o código real em vez desta seção se
houver divergência):** um objeto único `export const state = {...}` com todos os campos mutáveis
como PROPRIEDADES — qualquer módulo importador pode fazer `state.coreClient = x` livremente (mutar
propriedade de um objeto `const` não esbarra na restrição de `export let` do ES module, que só proíbe
REBINDING do próprio `state`). Mais simples que getters/setters individuais por campo (que era o
plano original abaixo, DESCARTADO por trabalhoso demais em escala — 278 linhas de call sites só pra
`extension.ts`). Pra estender: só adicionar o campo em `state.ts` e usar `state.novoCampo` em
qualquer módulo, sem cerimônia nenhuma.

**Plano de extração sugerido (na ordem de risco crescente — fazer nesta ordem, validar a cada
passo):**

1. ~~`extension/src/state.ts`~~ — **FEITO**, ver seção acima ("O ALICERCE"). Todos os ~11 campos
   mutáveis reatribuíveis (`coreProc`/`coreClient`/`schematicPanel`/`schematicState`/
   `currentProjectFilePath`/`simulationStatus`/`paletteViewProvider`/`extensionContext`/`trustStore`/
   `lastSyncedProjectState`/`voltageReadoutTimer`) + as 3 Maps + `projectSerializer` já moraram lá.
   Não precisa mexer de novo — só importar `{ state, ... } from "./state"` (ou `"../state"` de dentro
   de uma subpasta) em qualquer módulo novo que precisar ler/escrever.
2. Domínios candidatos, do mais isolado pro mais entrelaçado (ver a lista completa de ~150 funções
   rodando `grep -n "^function \|^async function " src/extension.ts` no início desta sessão — os
   nomes de função abaixo são os que existiam no momento deste handoff):
   - ~~`catalog/registeredSources.ts`~~ — **FEITO**, ver seção acima.
   - ~~`core/coreLifecycle.ts`~~ — **FEITO**, ver seção acima. `extension.ts`: 4387 → 2592 linhas.
   - `project/projectCommands.ts` (PRÓXIMO PASSO SUGERIDO) — `saveProjectCommand`, `openProjectCommand`,
     `projectWithRelativeSubcircuitRefs`, `absoluteSubcircuitRefPath`, `projectToWebviewState`,
     `webviewComponentToProjectComponent`, `pushProjectToCore`, `resolveProjectSubcircuitReferences`.
   - `symbolAuthoring/symbolCommands.ts` — `editPackageSymbolCommand`, `switchSymbolViewCommand`,
     `saveSymbolCommand`, `loadPackageCommand`/`savePackageCommand`, `extractPackageForEditing`,
     `extractSubcircuitInterfaceMap`, `extractInternalTunnelNames`,
     `applySubcircuitInterfaceToPackageComponents`, `extractInternalCircuit`,
     `compileSubcircuitInterface`, `serializeSubcircuitSceneComponent`/`serializeSubcircuitSceneWire`,
     `persistSubcircuitAuthoringScene`, `gatherInternalComponentSnapshots`.
   - `mcu/mcuCommands.ts` — `chooseMcuFirmwareCommand`/`chooseExposedMcuFirmwareCommand`,
     `reloadMcuFirmwareCommand`/`reloadExposedMcuFirmwareCommand`, `openMcuSerialMonitorCommand`/
     `openExposedMcuSerialMonitorCommand`, `closeMcuSerialMonitor`/`closeAllMcuSerialMonitors`,
     `resolveMcuTargetCoreId`, `resolveSubcircuitChildCoreId`, `updateBoardOverlayPropertyCommand`,
     `updateExposedComponentPropertyCommand`, `updateBoardOverlayVisualCommand`,
     `requestBoardOverlayDataCommand`.
   - O RESTO fica em `extension.ts` (que vira um orquestrador mais fino): `activate()`/`deactivate()`
     (registro de comandos do VSCode), `handleWebviewMessage` (o dispatcher gigante de mensagens —
     este é o MAIS arriscado de mexer, ele tem ~350 linhas e toca praticamente todo estado; considere
     deixá-lo por ÚLTIMO ou até fora do escopo se o tempo/risco não compensar), `syncSchematicPanel`/
     `computeProjectStatePatch`/`cloneState` (útil manter perto de `handleWebviewMessage`).
3. **Depois de CADA módulo extraído**: rodar os 4 comandos de validação da seção "Regras de execução"
   acima. Se algo quebrar, é mais barato reverter aquele módulo específico e tentar de novo do que
   tentar consertar em cima de um estado já confuso.
4. **Sinal de que está pronto pra parar (ou perguntar ao usuário se deve continuar)**: se o arquivo
   `extension.ts` cair abaixo de ~1500-2000 linhas com os domínios principais claramente separados,
   isso já é uma modularização "por domínio" genuína — não precisa necessariamente zerar o arquivo.

### EX-2: Consolidar normalização de manifesto duplicada — NÃO INICIADO

Achado ainda não investigado nesta sessão. Contexto provável (não confirmado): pode haver lógica de
normalização de manifesto (`.lsdevice`/`.lssubcircuit`) duplicada entre `extension.ts` e
`UnifiedCatalog.ts`, ou entre o caminho de "registro" (`resolveRegisteredItem`) e o caminho de "edição"
(`extractPackageForEditing`) — ambos leem campos parecidos do mesmo tipo de arquivo com código
ligeiramente diferente. **Primeiro passo pro próximo agente**: grep por padrões repetidos tipo
`typeof X.folderPath === ...`/`localizedManifestName(` entre esses arquivos, comparar
`resolveRegisteredItem` vs `parseSubcircuitManifest` vs `extractPackageForEditing` campo a campo, e
decidir se dá pra extrair uma função `normalizeManifestCommonFields()` compartilhada sem quebrar
nenhum dos 3 caminhos (que têm requisitos ligeiramente diferentes — um é "pra registro no catálogo",
outro é "pra edição visual", campos obrigatórios diferem).

### UI-12: Modelo de seleção único dentro de state — NÃO INICIADO

Achado ainda não investigado nesta sessão. Contexto provável (não confirmado): em `main.ts`, a seleção
hoje é espalhada entre `state.selectedComponentIds`/`state.selectedWireIds` (dentro do estado
sincronizado com a Extension) E variáveis módulo-locais como `selectedWireSegment`/`selectedWireCorner`/
`selectedTextLabel` (fora de `state`, nunca sincronizadas, perdidas em undo/redo?). **Primeiro passo
pro próximo agente**: grep por `selectedWireSegment\|selectedWireCorner\|selectedTextLabel` em
`main.ts`, confirmar se elas deveriam estar dentro de `WebviewProjectState` (e portanto dentro do
sistema de undo/sync) ou se ficarem fora é intencional (documentado em algum comentário existente —
CUIDADO, pode haver uma razão deliberada, ver o comentário perto de `undoContentKey`: "só
components/wires, NUNCA seleção" sugere que seleção é deliberadamente efêmera/fora do undo. Investigar
ANTES de mudar, pode ser que "unificar" signifique só mover essas 3 variáveis pra dentro de um objeto
`state.selection` sem necessariamente jogá-las no undo).

### Testar e validar Fase 8 (suite completa final) — PENDENTE

Depois que EX-9/EX-2/UI-12 estiverem completos: rodar TODOS os 4 comandos de validação (seção
"Regras de execução"), MAIS um rebuild+ctest completo do Core (mesmo que Fase 8 não mexa no Core, por
garantia), MAIS uma releitura cuidadosa do diff final antes de considerar a auditoria de 61 achados
encerrada.

## Armadilhas conhecidas (não são bugs seus, não tente "consertar")

1. ~~**`esp32_devkitc_subcircuit_test` sempre falha com `abort()`**~~ **CORRIGIDO em 2026-07-08**
   (investigando por que `.github/workflows/package-installers.yml` falhava sempre no passo de
   testes). Causa real: o teste não registrava a factory local `sources.rail` (usada 2x no
   subcircuito real) -- exceção não capturada -> `std::terminate()`/`abort()`; o `0xc0000409` que
   aparecia no Windows Release NÃO é um buffer overflow de verdade, é só o exit code padrão do
   MSVC/UCRT pra `abort()` sem handler SEH. Corrigir isso revelou um bug maior no PRÓPRIO
   `subcircuits/esp32_devkitc_v4.lssubcircuit` real: 11 túneis de GPIO + o túnel de GND + todo o
   circuito EN/BOOT (pull-ups + botões) nunca tinham fio nenhum -- ficavam eletricamente flutuando,
   mascarados pelo `abort()` anterior. Ambos corrigidos (`core/test/esp32_devkitc_subcircuit_test.cpp`
   + o `.lssubcircuit`, usando `subcircuits/esp32_wroom32.lssubcircuit` como referência do padrão
   correto). **`-E "esp32_devkitc_subcircuit"` não é mais necessário** -- `ctest` completo (29/29,
   Debug e Release) passa sem exclusão nenhuma. Ver
   [[project_lasecsimul_esp32_devkitc_subcircuit_wiring_fix]] na memória do projeto.
2. **`union_find_test` às vezes aparece como "Not Run"** (`.exe` não encontrado no diretório de build)
   mesmo depois de compilar com sucesso — quirk de ambiente, não relacionado ao código, também
   pré-existente.
3. **Rodar um `.exe` de teste do Core DIRETAMENTE (fora do `ctest`) que crasha pode disparar um dialog
   modal do Windows** que trava o terminal até ser fechado — evite rodar executáveis de teste
   individualmente fora do `ctest`; se precisar, avise o usuário que pode aparecer um popup.
4. **Comandos em background**: o ambiente às vezes coloca comandos em background mesmo sem pedir
   (`run_in_background`) quando a saída demora um pouco — se um `Bash`/`PowerShell` parecer não
   retornar, verifique se ele foi promovido a background em vez de assumir que travou.

## Referência rápida de comandos

```bash
# Validação TS/testes (rodar sempre, do diretório extension/)
npx tsc -p tsconfig.json --noEmit          # extension host
npx tsc -p tsconfig.webview.json --noEmit  # Webview
npx tsc -p tsconfig.test.json              # compila os testes
npx mocha "out-test/src/**/*.test.js" --recursive

# Core C++ (rodar da raiz do repo, só quando mexer em core/)
node scripts/build-core.js --config=Debug
ctest --test-dir core/build -C Debug --output-on-failure -E "esp32_devkitc_subcircuit"
```

## Arquivos-chave tocados nesta sessão (pra referência rápida de onde procurar)

- `extension/src/extension.ts` — o arquivo sendo modularizado (EX-9), 4387→2592 linhas até agora.
- `extension/src/pathUtils.ts` — NOVO nesta sessão.
- `extension/src/currentLanguage.ts` — NOVO nesta sessão.
- `extension/src/catalog/packageSanitizers.ts` — NOVO nesta sessão.
- `extension/src/catalog/registeredSources.ts` — NOVO nesta sessão.
- `extension/src/state.ts` — NOVO nesta sessão, O ALICERCE (objeto `state` único p/ todo estado mutável).
- `extension/src/core/coreLifecycle.ts` — NOVO nesta sessão (push/poll/decode/simulação/rebuild).
- `extension/src/ui/webview/main.ts` — Webview (render incremental, undo, sync).
- `extension/src/ui/webview/model.ts` — tipos compartilhados + `TUNNEL_TYPE_ID`/`JUNCTION_TYPE_ID`.
- `extension/src/ui/webview/messages.ts` — protocolo IPC Extension↔Webview (`syncStatePatch` novo).
- `extension/src/ipc/CoreClient.ts` — cliente IPC do Core (`disconnectWire`, `StringDecoder`).
- `extension/src/catalog/UnifiedCatalog.ts` — catálogo unificado (`sanitizeStringArray`/`entryToWebview`).
- `core/src/app/CoreApplication.cpp` — handlers IPC do Core (`disconnectWire`, `pinIdsByTypeId`).
- `core/src/session/SimulationSession.{hpp,cpp}` — `disconnectWire`.
- `test/core/simulation/NetlistTest.cpp` — testes novos de `disconnectWire`.

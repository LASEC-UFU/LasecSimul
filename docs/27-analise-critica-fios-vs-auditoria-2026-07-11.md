# 27 - Análise crítica: implementação do sistema de fios vs. auditoria técnica (2026-07-11)

Método: leitura integral de `docs/auditoria-tecnica-fios-simulide-2026-07-11.md`, leitura do código
atual (não só diffs) de `topologyDocument.ts`, `wireTopology.ts`, `wireSpatialIndex.ts`, `main.ts`,
`extension.ts`, `coreLifecycle.ts`, `ProjectSerializer.ts`/`ProjectTypes.ts`, `Netlist.hpp`,
`SimulationSession.cpp/hpp`, `CoreApplication.cpp`; execução real do benchmark de índice espacial;
`git log`/`git status` para checar histórico de commits. Toda esta implementação está no working tree,
**sem nenhum commit ainda** — não há mensagem de commit pra investigar intenção; a única fonte de
intenção documentada é comentário de código e as seções 24/19 que eu mesmo escrevi nas `.spec` na
rodada anterior desta sessão (portanto: registram o que foi construído, não uma decisão prévia
independente).

## Resumo executivo

A simplificação em relação à arquitetura-alvo da auditoria foi **parcialmente deliberada e
parcialmente um corte incompleto** — as duas coisas ao mesmo tempo, em partes diferentes do sistema:

- **Deliberada e bem justificada**: manter `Netlist::rebuildTopology` como oracle sempre-do-zero no
  Core (não incremental) — decisão testada, documentada com motivo técnico real (union-find não é
  desfazível; componentes ativos podem precisar de reestabilização completa), registrada na spec.
  Isso é o modelo do que uma simplificação deliberada deveria parecer.
- **Corte incompleto, não documentado como decisão**: a transação atômica que o Core já oferece
  (`applyWireTopologyTransaction`) fica **inatingível na prática** para qualquer projeto que tenha
  pelo menos um nó de topologia em qualquer lugar do esquemático — a Extension cai num branch de
  **reconstrução completa do circuito no Core** (`queueCoreRebuild`, remoção+recriação sequencial de
  TODOS os componentes e fios, um IPC round-trip de cada vez) para praticamente toda edição de fio a
  partir daí. Isso não está em nenhum comentário como uma limitação aceita — é uma consequência de
  ordem de verificação em `syncProjectSnapshotToCore` que ninguém parece ter percebido como
  desabilitando o próprio mecanismo que acabou de ser construído pra resolver o P0 #1 da auditoria
  ("operação composta não atômica no Core"). Isto é o achado central deste relatório (seção "Análise
  de desempenho").
- `topologyDocument.ts` é, de fato, só uma ponte de borda (save/load/compile de subcircuito) — nunca
  usado no caminho vivo de edição, confirmado por rastreamento de código, não suposição. O modelo vivo
  real é o trio `components`+`wires`+`topologyNodes` manipulado por funções puras em `wireTopology.ts`
  — uma SEGUNDA representação do mesmo domínio, mantida sincronizada só por convenção/funções de
  tradução, nunca por um único tipo.
- Não existe FSM. Encontrei um bug real, reproduzível por leitura de código (não suposição): entrar em
  modo de posicionamento de componente (`enterPlacementMode`) enquanto uma derivação de fio está em
  andamento (`state.pendingConnection` setado) não é bloqueado nem cancela o draft — e o handler de
  Esc tem um `return` antecipado que, nesse estado combinado, sai do modo de posicionamento mas
  **deixa o draft de fio pendurado**, exigindo um segundo Esc. Ver seção "Análise da FSM".
- O índice espacial cumpre integralmente o que a auditoria pediu — medido nesta sessão (não estimado):
  81 ms de build e ~4,7 µs de query média a 50.000 segmentos. Esta parte da auditoria foi resolvida de
  verdade, sem ressalva.

**Recomendação principal** (detalhada na seção 11): não é nem "manter como está" nem "reescrever o
motor inteiro". É consolidar a representação dupla (matar `topologyNodes` como array paralelo,
promover o modelo canônico a modelo vivo) **e** consertar o roteamento que torna a transação atômica
inatingível **e** adicionar uma máquina de estados explícita leve pra ferramenta de fios. Não há
evidência de que um Command Bus genérico ou um kernel com API incompatível do zero (Alternativa C /
"Opção 3" pura) sejam necessários — o primitivo de atomicidade que a auditoria pedia **já existe e
funciona** quando alcançado; o problema é que ele quase nunca é alcançado.

---

## O que a auditoria recomendou

Da leitura integral de `docs/auditoria-tecnica-fios-simulide-2026-07-11.md`:

- **Alternativa D** ("reconstruir toda a cadeia", por substituição controlada e fatiada, sem
  compatibilidade obrigatória de arquivo) — decisão registrada na seção "Decisão arquitetural
  recomendada".
- **Arquitetura-alvo** (diagrama mermaid, seção "Arquitetura-alvo proposta"): `Wire Tool FSM` →
  `Transactional Command Bus` → `Canonical Circuit Document` → `Topology Graph` (nós/portas/arestas) +
  `Geometry` (vértices/rotas/estilos) → `Spatial Index`; `Invariant Validator` sobre o documento;
  `Inverse command history` (undo/redo por comando, não snapshot); patch versionado pra Webview; delta
  atômico de topologia pro Core.
- **Modelo de dados proposto**: `TopologyNode{id}`, `PortRef{componentId,pinId}`,
  `Conductor{id,nodeA,nodeB}`, `Route{id,conductorId,vertexIds}`, `RouteVertex{id,x,y,kind}`,
  `JunctionView{nodeId,position}` **derivada, nunca componente**.
- **Máquina de estados formal** (diagrama `stateDiagram-v2`): `Idle → Preview → Routing → Committing →
  Idle`, com `Cancelled` a partir de `Preview`/`Routing` por Esc/botão-direito/troca de
  ferramenta/saída de sessão, sempre "discard draft, zero model mutation".
- **Fluxo transacional**: `CommitWireCommand(baseRevision, draft)` → host valida invariantes → Core
  `ApplyTopologyTransaction(txId, delta)` → commit/reject com `newRevision`; draft nunca é aplicado ao
  documento antes da confirmação do Core.
- **Plano de ação em 9 fases** (0 a 8): instrumentação → kernel canônico headless → comandos/FSM →
  índice espacial → IPC transacional → redes incrementais → persistência v2 → migração da Webview +
  remoção do legado → UX avançada.
- **Metas de aceite mensuráveis**: "IPC | 1 request + 1 response + 1 patch por comando; **zero
  snapshots completos em edição**"; "cancelamento <5 ms e zero diferença no documento/Core"; "Core
  nunca recebe rede parcial"; "uma fonte de verdade".

---

## O que foi realmente implementado

Evidência por arquivo (todos no working tree, sem commit):

| Peça | Onde | Natureza |
|---|---|---|
| `topologyNodes: Array<{id,x,y}>` | `model.ts` (`WebviewProjectState`), `extension/src/state.ts` | Array paralelo a `components`/`wires`, não um tipo unificado |
| `topologyDocument.ts` (novo) | `extension/src/ui/webview/topologyDocument.ts` | `CanonicalTopologyDocument`, `assertTopologyInvariants`, `canonicalTopologyFromLegacy`/`legacyTopologyFromCanonical` — usado só em 2 call sites de borda (ver seção dedicada) |
| `wireSpatialIndex.ts` (novo) | `extension/src/ui/webview/wireSpatialIndex.ts` | Spatial hash real, integrado em `findAtPosition`/`main.ts::render()` |
| `applyWireTopologyTransaction` | `SimulationSession.hpp/cpp`, `CoreApplication.cpp`, `CoreClient.ts`, `coreLifecycle.ts::pushWireTopologyTransaction` | Transação atômica real com revisão otimista e rollback — existe e funciona, mas é pouco alcançada (ver "Análise de desempenho") |
| `requestConnectEndpoints` | `extension.ts` handler, `main.ts` emissores | Substitui `requestConnectPins`/`requestConnectPinToWire`; usa `baseRevision`/`topologyRevision` como CAS otimista fraco (rejeita republishing o estado, não faz merge) |
| `connectors.junction` removido do Core | `Junction.hpp` deletado, `CoreApplication.cpp` | Achatamento N-1 arestas, tanto no projeto principal (`electricalEdgesForProject`) quanto em subcircuitos |
| Persistência v2 | `ProjectTypes.ts` (`schemaVersion:2`), `ProjectSerializer.ts`, `lsproj.schema.json` | `topology{revision,nodes,conductors}` substitui `wires[]`/`visual.wires` no arquivo |
| `Netlist::rebuildTopology` | `Netlist.hpp` | Full-rebuild mantido de propósito (cache incremental testado e revertido) |
| FSM formal | — | **Não existe.** Estado disperso em `pendingConnection` + 4+ variáveis de módulo independentes |
| Command Bus | — | **Não existe.** Handlers diretos em `extension.ts`, um `case` por verbo |
| Invariant Validator central | `assertTopologyInvariants` | Existe, mas só roda nos 2 call sites de borda de `topologyDocument.ts` — nunca durante edição vivo |
| Redes incrementais no Core | `Netlist.hpp` | Decidido NÃO fazer (full-rebuild é o oracle, seção 24.5 da spec) |
| "zero snapshots completos em edição" | `queueCoreRebuild` | **Não alcançado** — é o caminho DEFAULT pra edição assim que existe 1 nó de topologia no projeto |

---

## Diferenças entre proposta e implementação (matriz completa)

| Proposta da auditoria | Implementação atual | Status | Consequência |
|---|---|---|---|
| Documento canônico vivo (`CircuitDocument`) | `topologyDocument.ts` só em save/load/compile; edição vive em `components+wires+topologyNodes` | **Substituído/parcial** | 2 representações do mesmo domínio, sincronizadas por convenção, não por tipo único |
| `TopologyGraph` (nós/portas/arestas explícito) | `topologyNodes[]` + endpoints de `wires[]` que podem apontar pra um nó OU um pino, distinguidos só por presença em `topologyNodes` | **Parcial/substituído** | Sem tipo de endpoint marcado no modelo vivo (o marcador `kind:"node"/"port"` só existe no `CanonicalTopologyDocument`, não no modelo vivo) |
| `GeometryStore` separado | `wire.points` embutido no próprio `WebviewWireModel` (como já era antes da auditoria) | **Não implementado** | Geometria e conectividade continuam no mesmo objeto, como a auditoria já apontava como limitação |
| `Spatial Index` | `WireSpatialIndex` (spatial hash, cellSize 64) | **Implementado integralmente** | Medido: 81 ms build / 4,7 µs query a 50k segmentos — resolve o P1 de hit-test |
| `Wire Tool FSM` | `pendingConnection` (union type) + `pendingWireRoute`/`pendingWireBendLengths`/`pendingWirePreviewTarget`/`placingTypeId`/estado de marquee/estado de drag de segmento, todos independentes | **Não implementado** | Bug real confirmado por leitura de código (Esc precisa de 2 cliques após trocar de ferramenta em modo de derivação) |
| `Transactional Command Bus` | Handlers diretos por `case` em `extension.ts::handleWebviewMessage` | **Não implementado** | Sem despacho central, sem histórico de comando inverso |
| `ApplyTopologyTransaction` (Core) | `applyWireTopologyTransaction` (revisão otimista, rollback) | **Implementado, mas subutilizado** | Só alcançado pelo diff genérico (`syncProjectSnapshotToCore`) quando NÃO há nó de topologia no projeto — na prática, quase nunca |
| `Inverse command history` (undo por comando) | Snapshot completo clonado (`structuredClone`) por transição de conteúdo | **Não implementado** (mantém o modelo pré-auditoria) | Undo/redo funciona, mas não é O(mudança); memória O(histórico × tamanho do documento) |
| Persistência v2 (`nodes/conductors/routes`) | `topology{revision,nodes,conductors}`, sem `Route`/`RouteVertex` separados (vértices embutidos no condutor) | **Implementado, parcial** | Atende ao essencial (endpoints tipados, sem `wires[]` legado); não separa geometria de conectividade como o modelo-alvo sugeria |
| `Invariant Validator` sobre cada comando | `assertTopologyInvariants` só em save/load | **Parcial** | Uma edição vivo pode passar por um estado transitório inválido sem ser pego até salvar |
| `Redes incrementais` no Core (Netlist) | Full-rebuild mantido deliberadamente | **Descartado, com justificativa técnica registrada** | Decisão correta (ver seção 24.5 da spec) — risco de correção > ganho de performance nesse ponto específico |
| Zero snapshots completos em edição (meta de aceite) | `queueCoreRebuild` full-teardown é o caminho DEFAULT assim que há 1 nó de topologia | **Não alcançado — regressão em relação à própria meta que a auditoria definiu** | Ver "Análise de desempenho" |
| Cancelamento sem resíduo (`Cancelled → discard draft, zero model mutation`) | `requestStartWireFromWire` = draft puro, `clearPendingWire()` = reset local puro, confirmados por leitura de código | **Implementado para o caso feliz** | Falha no caso combinado com troca de ferramenta (ver FSM) |
| `JunctionView` derivada, nunca componente | `connectors.junction` removido do Core; `topologyNodes` é visual/webview, nunca vira componente | **Implementado integralmente** | Resolve o P0 "junction como componente artificial" |

---

## Evidências de decisão deliberada ou implementação incompleta

**Fatos comprovados** (por leitura direta de código):
- `topologyDocument.ts:49`: comentário explícito "Ponte determinística temporária: junction deixa de
  ser componente no documento canônico." — não diz até quando, não referencia uma fase seguinte, não
  aponta pra nenhum documento de plano.
- `grep` por `canonicalTopologyFromLegacy|legacyTopologyFromCanonical` em `extension/src`: exatamente 2
  call sites de PRODUÇÃO (`extension.ts:1482`, dentro do compile de "Abrir Subcircuito";
  `projectCommands.ts:79`, dentro de `projectToWebviewState`, o LOAD de `.lsproj`) + 1 em
  `projectCommands.ts:334` (SAVE). Nenhum call site em `main.ts` (webview) nem no handler de
  `requestConnectEndpoints`/`connectEndpointToNode` (o caminho vivo de edição).
- Em `projectCommands.ts:79-118`, `legacyTopologyFromCanonical(project.topology)` devolve
  `{junctions, wires}`, mas a função que o chama (`projectToWebviewState`) **descarta `.junctions`
  inteiramente** e deriva `topologyNodes` de novo, direto de `project.topology.nodes` (linha 118) —
  ou seja, metade da saída da "ponte" nem é usada nesse call site. Isso não é um bug funcional (o
  resultado final está correto), mas é evidência concreta de que a API da ponte não foi desenhada
  contra o uso real dela — indício de trabalho não totalmente fechado, não uma escolha deliberada
  documentada em lugar nenhum.
- Nenhum commit existe para este trabalho (`git log --oneline --all` não mostra nada além dos commits
  anteriores a esta sessão; `git status` mostra 39 arquivos modificados/novos no working tree). Não há
  mensagem de commit, ADR ou branch pra investigar intenção — só o comentário citado acima e o que eu
  mesmo registrei nas seções 24/19 das `.spec` na rodada anterior (documentação DEPOIS do fato, não
  uma decisão prévia).
- `Netlist.hpp` (comentário de classe, linhas 49-62): decisão de manter full-rebuild é justificada
  tecnicamente por escrito ("união via union-find não é desfazível... componentes ativos podem
  precisar de reestabilização completa") e tem teste de regressão dedicado
  (`core/test/diode_test.cpp`, settle depois de split/restauração transacional). **Este é o único
  ponto do sistema com evidência de decisão deliberada e justificada por escrito**, contra tudo mais
  que é simplificação silenciosa.

**Indícios** (não fatos comprovados, mas padrões consistentes):
- O padrão geral — construir o primitivo certo (`applyWireTopologyTransaction`) mas não terminar de
  ligá-lo ao caminho principal de edição — é mais consistente com "implementação interrompida no meio"
  do que com "decisão de escopo". Se fosse deliberado, seria razoável esperar um comentário do tipo
  "por ora todo `requestConnectEndpoints` cai em rebuild completo; a transação atômica cobre só o diff
  genérico" — esse comentário não existe em lugar nenhum do código.
- O comentário em `extension.ts` perto do full-rebuild de `requestConnectEndpoints` ("Publica a revisão
  visual somente depois de o Core reconstruir o snapshot completo. Isso evita expor a sequência
  intermediária junction/metades/ramo dos verbos antigos.") justifica a escolha **localmente**
  (por que rebuild em vez de commit direto) mas não reconhece a consequência **global** (que isso
  desliga a transação atômica pro resto da sessão assim que existe 1 nó de topologia). Isso é
  consistente com quem resolveu o problema imediato na frente e não conectou os pontos com o
  `syncProjectSnapshotToCore` mais abaixo no mesmo arquivo.

**Pontos que não puderam ser confirmados**:
- Se havia um plano documentado (fora deste repositório, ex: conversa/planejamento externo) prevendo
  fases futuras pra fechar essa lacuna — não há artefato no repositório que confirme ou negue isso.
- Se a pessoa que implementou tinha ciência do efeito cascata em `syncProjectSnapshotToCore` ao
  escrever o full-rebuild em `requestConnectEndpoints` — não há como inferir isso só do código.

---

## Análise de `topologyNodes` como array paralelo

Quesito a quesito (seção 3 do pedido):

- **Fonte única de verdade**: comprometida. Existem DUAS representações do mesmo domínio
  (`components+wires+topologyNodes` vivo; `topology{nodes,conductors}` persistido/canônico), unidas só
  por funções de tradução manuais (`canonicalTopologyFromLegacy`/`legacyTopologyFromCanonical`).
  Qualquer nova operação de edição precisa saber lidar com a representação viva; qualquer novo
  consumidor de persistência precisa saber lidar com a canônica. Isso é exatamente o padrão "três
  autoridades sem revisão" que a auditoria original apontava como P0 — reduzido de 3 pra 2, não
  eliminado.
- **Identidade estável dos nós**: OK — ids gerados por `nextId("junction")`, nunca reciclados, nunca
  derivados de coordenada.
- **Consistência fio↔nó**: garantida só por convenção de string (`wire.from.componentId` bate com
  `topologyNode.id`) — nada no sistema de tipos força isso; `assertTopologyInvariants` pegaria uma
  violação, mas só roda nos 2 call sites de borda, não durante edição.
- **Consistência geometria↔topologia**: geometria (`wire.points`) e conectividade continuam no mesmo
  objeto `WebviewWireModel` — não separadas como o modelo-alvo (`Route`/`RouteVertex`) propunha; não é
  um problema novo introduzido por `topologyNodes`, é uma limitação que sobrevive do desenho anterior.
- **Sincronização durante edição**: só acontece em pontos discretos e coordenados manualmente
  (`connectEndpointToNode` devolve `newNodes`+`newWires`+`replacedWireIds` juntos, aplicados numa
  única atribuição de `state.schematicState` em `extension.ts`) — funciona hoje, mas cada handler novo
  de edição de fio precisa reimplementar essa coordenação manualmente; não há uma função central que
  garanta isso.
- **Integridade referencial**: não reforçada em tempo de edição (só verificada em save/load).
- **Operações atômicas no lado Webview/host**: sim, no nível de objeto JS (uma atribuição só) — mas
  sem GARANTIA equivalente do lado Core (ver desempenho).
- **Undo/redo**: `topologyNodes` está incluído no `UndoSnapshot` (`main.ts::snapshotOfProjectState`,
  confirmado por leitura direta) — undo/redo do array funciona.
- **Persistência**: funciona (mapeado por `topologyDocument.ts` nos dois sentidos).
- **Desempenho**: buscas como `state.topologyNodes?.find(...)` (usadas em `pinScenePosition`,
  `wirePolylinePoints`) são O(N) lineares sobre `topologyNodes` — aceitável hoje (contagem de nós de
  topologia é tipicamente pequena mesmo em circuitos grandes), mas é mais um lugar de busca linear
  além dos já existentes em `components`.
- **Testabilidade**: boa — `wireTopology.test.ts`/`topologyDocument.test.ts` cobrem os casos puros.
- **Manutenção/extensibilidade**: qualquer feature nova que precise "saber o que é um nó de topologia"
  precisa verificar presença em `topologyNodes` (não um discriminador de tipo no próprio wire), espalhando
  esse `if` por vários arquivos (`wireTopology.ts`, `main.ts`, `coreLifecycle.ts` todos reimplementam
  essa checagem de forma um pouco diferente — `nodeIds.has(ref.componentId)` em 3 lugares distintos com
  nomes de variável e formas ligeiramente diferentes).

**Busca pelos casos específicos pedidos**: não encontrei, no código atual, um caminho que produza nó
sem fio, fio referenciando nó inexistente, ou nó duplicado na mesma coordenada — `connectEndpointToNode`
sempre cria nó+fios juntos numa única estrutura de retorno, e `findExistingJunctionAt` reusa por posição
antes de criar um novo. O RISCO estrutural (falta de reforço de integridade em tempo de edição) existe;
uma instância ATIVA do bug não foi encontrada nos caminhos hoje exercidos pelos testes/código.

**Veredito**: `topologyNodes` paralelo é uma **cache/representação derivada controlável hoje, mas é um
risco estrutural, não uma solução definitiva** — funciona porque a superfície de mutação ainda é
pequena (poucos pontos de entrada, todos escritos com cuidado manual). Cresce mal: cada novo tipo de
edição de fio que alguém adicionar vai ter que redescobrir as mesmas regras de coordenação.

---

## Análise de `topologyDocument.ts`

**Mapeamento completo de entradas/saídas** (arquivo inteiro tem 74 linhas):
- `assertTopologyInvariants(document, componentIds?)` — validação pura, sem I/O.
- `canonicalTopologyFromLegacy(components, wires, revision, topologyNodes)` → `CanonicalTopologyDocument`.
  Chamado em: `extension.ts:1482` (compile de subcircuito, ao SALVAR uma sessão de "Abrir
  Subcircuito"); `projectCommands.ts:334` (SAVE de `.lsproj`).
- `legacyTopologyFromCanonical(document)` → `{junctions, wires}`. Chamado em: `projectCommands.ts:79`
  (LOAD de `.lsproj`, dentro de `projectToWebviewState`).

**Confirmação direta**: as três chamadas de produção são save/load/compile. **Zero** chamadas em
`main.ts` (webview) ou nos handlers de edição vivo (`requestConnectEndpoints`,
`requestStartWireFromWire`, drag de componente, remoção de fio/componente). O papel real de
`topologyDocument.ts` é exatamente o que o comentário diz: conversão nas bordas.

**Rastreamento das operações vivas pedidas** (estrutura modificada primeiro / autoritativa / quando
`topologyNodes` atualiza / quando a rede elétrica atualiza / estado parcial / sincronização
posterior / risco de falha entre etapas):

| Operação | Estrutura modificada primeiro | Autoritativa | `topologyNodes` atualiza | Rede elétrica (Core) atualiza | Estado parcial possível? | Falha entre etapas deixa inconsistência? |
|---|---|---|---|---|---|---|
| Iniciar fio em pino | `state.pendingConnection` (webview, local) | webview | não aplicável | não | não (nada persistido) | não |
| Iniciar fio no MEIO de outro fio | `state.pendingConnection = {kind:"wire",...}` (webview, local) | webview | não | não | não — **confirmado**: zero split, zero Core, `requestStartWireFromWire` só seta o draft (`extension.ts:875-880`) | não |
| Adicionar ponto intermediário (bend) | `pendingWireRoute`/`pendingWireBendLengths` (módulo, webview) | webview | não | não | sim, mas nunca sai do processo (não serializado) | não |
| Finalizar (em pino, em fio, criando/reusando junção) | `schematicState` no HOST (`extension.ts`, `requestConnectEndpoints`) via `connectEndpointToNode` puro | host, otimisticamente | sim, junto com `wires`, numa única atribuição | depois, via `queueCoreRebuild()` (assíncrono) | **sim** — visual já mostra o resultado ANTES do Core confirmar | **sim, mas com rollback**: se o rebuild falhar, `state.schematicState = previous` desfaz o otimismo (confirmado, `extension.ts:854-866`) — porém o Core já pode ter ficado parcialmente reconstruído no meio do rebuild que falhou (só é "tentado de novo" via `void queueCoreRebuild()` best-effort, sem garantia) |
| Mover componente conectado | `component.x/y` local, depois `maybeAutoJunctionForDraggedComponents` pode disparar o MESMO `requestConnectEndpoints` | host | possível, se overlap detectado | via mesmo caminho acima | sim | mesmo caso acima |
| Mover nó de topologia | não há handler dedicado — nó de topologia não aparece como algo arrastável separadamente no código revisado (a "bola" é só renderizada, `isJunctionVisible`; não há listener de drag específico para `topologyNodes` neste levantamento) | — | — | — | — | **não verificável neste levantamento** (ver seção de testes funcionais) |
| Apagar ramo (fio) | `schematicState.wires` filtrado local, depois `normalizeRuntimeTopology` | host | sim | condicional: full rebuild se topologia mudou além da remoção direta, senão incremental (`pushRemoveWireToCore`) | sim | risco baixo — remoção é mais simples que criação |
| Cancelar (Esc/botão direito) | `clearPendingWire()` — reset local puro | webview | não muda | não | não | não — **confirmado por leitura direta**, sem `send()` nenhum |
| Desfazer/Refazer | snapshot completo (`components`+`wires`+`topologyNodes`+seleção) trocado, depois `persistState()` → `projectChanged` → diff genérico no host | host (mesmo caminho de qualquer diff) | sim, snapshot inclui | via `syncProjectSnapshotToCore`, que CAI no full-rebuild se há qualquer `topologyNodes` no snapshot (ver desempenho) | sim, brevemente | mesma proteção genérica do diff |

**Avaliação das 3 alternativas**:

- **Alternativa A (manter como ponte)**: perpetua a representação dupla. Funciona hoje porque a
  superfície de mutação é pequena e cuidadosamente coordenada à mão — mas qualquer feature nova de
  edição de fio (rótulos de rede, barramentos tipados, roteamento automático — tudo que a própria
  auditoria lista como "oportunidades de superar o SimulIDE") vai ter que decidir de novo "em qual das
  duas representações eu mexo primeiro". Não recomendado como estado final.
- **Alternativa B (promover a canônico vivo)**: o modelo `CanonicalTopologyDocument` já existe, já tem
  validação de invariantes, já é o formato de persistência. Trocar o modelo vivo (`main.ts`/`extension.ts`)
  pra operar direto sobre `{nodes, conductors}` em vez de `{components, wires, topologyNodes}` elimina
  a tradução dupla SEM inventar uma API nova incompatível — reaproveita o trabalho já feito.
  `endpoint.kind` já resolve o problema de "wire aponta pra nó ou pra pino" que hoje é resolvido por
  convenção de string. **Esta é a alternativa recomendada.**
- **Alternativa C (kernel novo, API incompatível)**: não há evidência concreta de que o modelo de dados
  atual (nós/portas/condutores/vértices) seja insuficiente — o que falta é ele ser usado
  consistentemente, não trocado por outra coisa. Reescrever do zero pagaria o custo de uma migração
  completa sem resolver um problema que a Alternativa B já resolve mais barato. Não recomendado.

---

## Análise do modelo vivo de edição

Já coberta em detalhe na tabela da seção anterior. Resumo dos achados adicionais:

- **Nenhuma operação de edição de fio observada usa `applyWireTopologyTransaction` diretamente** — só
  o diff genérico (`syncProjectSnapshotToCore`) a alcança, e só quando NENHUM `topologyNodes` existe
  no projeto (ver "Análise de desempenho" pra por que isso quase nunca acontece na prática).
- O padrão "muta local otimisticamente, depois confirma/reverte com o Core" é usado de forma
  consistente e é uma boa decisão de UX (feedback imediato) — o problema não é o padrão em si, é o
  MECANISMO de confirmação escolhido (rebuild completo em vez de transação incremental).

---

## Análise do Command Bus

**Não existe Command Bus.** Operações compostas (dividir segmento + criar nó + conectar ramo +
atualizar rede) são: uma função pura que calcula o resultado completo
(`connectEndpointToNode`/`splitSegmentAtPoint`) + uma única atribuição de estado local + uma chamada
assíncrona de sincronização com o Core (`queueCoreRebuild()` ou, no caminho genérico,
`pushWireTopologyTransaction`). Isso é mais próximo de **"operações puras sobre o documento" + "unidade
de trabalho"** do que de "múltiplos comandos independentes" — na verdade, o desenho de
`connectEndpointToNode` devolvendo um resultado composto (`newNodes`+`newWires`+`replacedWireIds`) já é
funcionalmente equivalente a um "comando" bem definido, só sem um objeto `Command` reificado nem um
`CommandBus` despachando.

**Um Command Bus completo seria vantajoso?** Não há evidência concreta que justifique. Os benefícios
que um bus traria — atomicidade (já resolvida no nível de objeto JS pela atribuição única + já existe
primitivo atômico no Core), undo/redo (já funciona por snapshot, e não há sinal de que o snapshot esteja
custando caro o suficiente pra justificar trocar por comando-inverso), logs/depuração (poderiam ser
adicionados como um wrapper fino em volta dos handlers existentes, sem precisar de um bus genérico),
colaboração futura (não há requisito atual pra isso neste projeto) — todos têm alternativas mais baratas
que entregam o mesmo ganho sem a complexidade de um despachante genérico. **Recomendação**: não
construir um Command Bus. Em vez disso, um "serviço transacional" fino e explícito — uma função por
operação de fio (já existem: `connectEndpointToNode`, `splitSegmentAtPoint`) que SEMPRE devolve um
delta a ser aplicado atomicamente tanto no documento canônico quanto no Core, via
`applyWireTopologyTransaction` estendido (ver plano de ação) — entrega o mesmo resultado prático.

---

## Análise da FSM

**Inventário do estado disperso** (confirmado por leitura direta de `main.ts`):

| Variável | Escopo | Persistida/undoable? |
|---|---|---|
| `state.pendingConnection?: {kind?:"pin",...}\|{kind:"wire",...}` | `state` (webview), enviado ao host | Não está no `UndoSnapshot` (correto — é estado de ferramenta, não de conteúdo) |
| `pendingWireRoute: Point[]` | módulo (`main.ts:308`) | Não |
| `pendingWireBendLengths: number[]` | módulo (`main.ts:309`) | Não |
| `pendingWirePreviewTarget: Point\|undefined` | módulo (`main.ts:307`) | Não |
| `placingTypeId` | módulo | Não |
| `marqueeStart`/`marqueeStartScreen`/`marqueeRectEl`/`marqueeJustFinished` | fechamento local de `installCanvasEventHandlers` | Não |
| `selectedWireSegment`/`selectedWireCorner` | módulo | Não |

Sete variáveis/grupos independentes, sem um tipo soma único, sem transições centralizadas — **estado
implícito distribuído**, confirmando a suspeita da auditoria original.

**Estados impossíveis encontrados (fato comprovado por leitura de código, não suposição)**:

1. `enterPlacementMode(typeId)` (`main.ts:5440`) **não verifica nem limpa** `state.pendingConnection`.
   Nada no código impede entrar em modo de posicionamento de componente enquanto uma derivação de fio
   está em andamento.
2. O handler de `keydown` pra Escape (`main.ts:5779-5788`) tem dois `if` **separados**, o primeiro com
   `return` interno:
   ```ts
   if (event.key === "Escape") {
     hideContextMenu();
     if (placingTypeId) { exitPlacementMode(); return; }
   }
   if (event.key === "Escape" && state.pendingConnection) {
     clearPendingWire(); persistState(); render();
   }
   ```
   Se os dois estados coexistirem (achado 1), o primeiro Esc só sai do modo de posicionamento e
   **retorna imediatamente** — o segundo `if` nunca roda. O draft de fio (`pendingConnection` +
   `pendingWireRoute`/preview) continua pendurado, exigindo um SEGUNDO Esc pra realmente limpar.
   Consequência prática: preview de fio (polilinha `wire-layer__wire--preview`) continua visível na tela
   sobrepondo o componente recém-posicionado, e o pino de origem do draft continua marcado como ativo
   (`pin-terminal--active`) até o segundo Esc.
3. O handler de `click` no canvas (`main.ts:1228-1257`) verifica `placingTypeId` **antes** de
   `state.pendingConnection` — no mesmo estado combinado do achado 1, um clique no fundo do canvas
   POSICIONA um componente novo e nunca chega no branch que trataria o clique como bend do fio pendente
   — o componente é colocado, e o draft de fio permanece intocado (mesma inconsistência visual do
   achado 2, chegada por um caminho diferente).

Não encontrei (no código revisado) uma forma de os dados persistidos ficarem corrompidos por esses três
casos — o problema é inteiramente de UX/apresentação (marcadores visuais órfãos até o segundo Esc),
não de integridade de dado. Ainda assim, são bugs reais, reproduzíveis, que uma FSM explícita com
transições exaustivas (`switch` sobre um discriminador único, TypeScript reclamaria de caso não tratado)
teria pego em tempo de compilação.

**A adoção de uma FSM formal resolveria isso?** Sim, objetivamente, para os 3 casos acima — trocar as
7 variáveis por um único `type ToolMode = {kind:"idle"} | {kind:"wireDraft",...} | {kind:"placing",...}
| {kind:"marquee",...} | {kind:"draggingSegment",...}` com uma função de transição central que decide,
pra cada evento (clique, Esc, botão direito, `enterPlacementMode`), qual é o PRÓXIMO modo — tornaria os
3 casos acima erros de tipo (branch não tratado) em vez de bugs de runtime. Isso **não** exige um
framework de FSM nem um motor genérico — é um `switch` exaustivo sobre uma união discriminada, o próprio
TypeScript já safa a maior parte do trabalho de verificação.

---

## Resultados dos testes funcionais

**Limitação honesta, igual à auditoria original**: não há GUI disponível neste ambiente pra confirmar
interativamente no VSCode real. Onde a auditoria original já classificava algo como "não comprovado por
execução ponta a ponta", esta análise mantém a mesma classificação, salvo onde consegui uma prova mais
forte por rastreamento direto de código (equivalente, não superior, a uma prova de GUI).

| Cenário pedido | Status | Evidência |
|---|---|---|
| Iniciar fio no meio de outro fio | Confirmado por código — draft puro, zero mutação | `extension.ts:870-882` |
| Terminar fio no meio de outro fio | Confirmado por código — via `requestConnectEndpoints`, split calculado em `connectEndpointToNode`/`splitSegmentAtPoint` | `wireTopology.ts` |
| Criar derivação em T | Confirmado por teste unitário puro (`wireTopology.test.ts`) | suíte de testes (30 casos em `wireTopology.test.ts`, todos passando) |
| Criar junção com 4 ramos | Confirmado por teste unitário puro | idem — grau arbitrário é o mesmo mecanismo do T |
| Reutilizar junção existente | Confirmado por código (`findExistingJunctionAt`) + teste | `wireTopology.ts` |
| Conectar em pino | Confirmado por código + teste | `main.ts:4548-4582` |
| Mover componente conectado | Confirmado por código (recalcula endpoint via posição do componente; auto-junção via `WireSpatialIndex`) | `main.ts:2699-2745` |
| Mover nó | **Não verificável neste levantamento** — não encontrei um handler de drag dedicado a `topologyNodes` isolado do componente | risco: recomendo confirmação manual explícita |
| Apagar um ramo | Confirmado por código | `extension.ts`, handler `requestRemoveWire` |
| Apagar o segmento principal | **Não verificável sem GUI** — a auditoria original já classificava isto como "implementado de forma limitada"; nada nesta rodada mudou esse mecanismo | — |
| Cancelar com Esc | Confirmado, COM a ressalva do bug de FSM (achado 2 acima) | `main.ts:5779-5788` |
| Cancelar com botão direito | Confirmado por código (mesmo padrão de `clearPendingWire`) | `main.ts:1258-1275` |
| Trocar de ferramenta durante a criação | **Confirmado bug** — ver "Análise da FSM" | `main.ts:5440-5451` |
| Desfazer e refazer | Confirmado por código — `topologyNodes` incluído no snapshot | `main.ts:594-598`, `snapshotOfProjectState` |
| Salvar e reabrir | Confirmado por teste (`ProjectSerializer.test.ts`) + build limpo | suíte de testes |
| Reconstruir topologia | Confirmado — `queueCoreRebuild`/`rebuildCoreFromSchematicStateNow` | `coreLifecycle.ts:616-677` |
| Igualdade visual×Core | **Parcialmente comprometida** — durante o intervalo entre a atualização otimista local e a confirmação assíncrona do Core, a tela mostra um estado que o Core ainda não tem (mitigado por rollback em caso de falha, não eliminado) | `extension.ts:851-867` |
| Nós duplicados | Não encontrado nenhum caminho que produza isso nos testes/código revisado | `assertTopologyInvariants` pegaria se acontecesse |
| Segmentos de comprimento zero | `assertTopologyInvariants` rejeita explicitamente (`condutor de comprimento topológico zero`) — mas só roda em save/load, não durante edição | `topologyDocument.ts:40` |
| Objetos temporários órfãos | Não encontrados no caminho principal (`pendingConnection`/`pendingWireRoute` nunca são serializados) | — |
| "Bola laranja" (bug histórico) | Estruturalmente eliminada como classe de bug — junção não é mais componente do Core, `topologyNodes` é puramente visual | ver `.spec/lasecsimul.spec` seção 24.1 |
| Acúmulo de estado em operações repetidas | **Não testado nesta rodada** — recomendo teste de estresse manual (repetir criar/apagar centenas de vezes e monitorar memória/handles do Core) | — |
| Circuitos com centenas/milhares de segmentos | **Testado o índice espacial isoladamente** (ver desempenho) — o caminho completo de edição (com `queueCoreRebuild`) NÃO foi medido em escala nesta rodada, mas o comportamO(componentes+fios) já é suficiente pra prever degradação severa | ver "Análise de desempenho" |

---

## Análise de desempenho

**Medido nesta sessão** (`node scripts/benchmark-wire-topology.mjs 100 1000 10000 50000`, isolando só
`WireSpatialIndex`):

| Segmentos | build (ms) | query média (µs) |
|---:|---:|---:|
| 100 | 0,70 | 2,36 |
| 1.000 | 2,39 | 2,91 |
| 10.000 | 16,94 | 1,49 |
| 50.000 | 81,33 | 4,70 |

Comparado ao benchmark ORIGINAL da auditoria (scan linear: 132,88 ms de hit-test médio a só 5.000
segmentos) — o índice espacial é uma melhoria real de ordens de grandeza pro hit-test. **Esta parte da
auditoria foi resolvida de verdade.**

**Achado crítico, medido por leitura de código, não estimativa vaga**: `rebuildCoreFromSchematicStateNow`
(`coreLifecycle.ts:616-677`) — pra CADA reconstrução do Core:
1. Remove TODAS as instâncias de componente existentes, um `await state.coreClient.removeComponent(id)`
   por vez, **sequencial** (`for...of` com `await`, não `Promise.all`).
2. Recria TODOS os componentes do zero, um `await addComponent(...)` por vez, sequencial.
3. Reconecta TODAS as arestas elétricas (já achatadas por `electricalEdgesForProject`), um
   `await connectWire(...)` por vez, sequencial.

Isso é O(componentes + fios) round-trips de IPC **sequenciais** — contradiz diretamente a meta de
aceite da própria auditoria ("IPC: 1 request + 1 response + 1 patch por comando; zero snapshots
completos em edição").

**E o pior: este é o caminho DEFAULT, não uma exceção rara.** Rastreei `syncProjectSnapshotToCore`
(`extension.ts`) linha a linha:

```ts
if (((previous.topologyNodes?.length ?? 0) > 0 || (next.topologyNodes?.length ?? 0) > 0) &&
    (geometricTopologyChanged || componentSetChanged)) {
  await queueCoreRebuild();   // <- full teardown+rebuild
  return;                      // <- NUNCA chega no branch de pushWireTopologyTransaction abaixo
}
...
if (!componentSetChanged && (removedWireEdges.length > 0 || addedWireEdges.length > 0)) {
  const applied = await pushWireTopologyTransaction([...]);   // <- caminho atômico incremental
  ...
}
```

`topologyNodes.length > 0` é verdadeiro assim que existir **UM** nó de topologia em **QUALQUER LUGAR**
do esquemático (não precisa ser perto do fio editado). `geometricTopologyChanged` é verdadeiro
praticamente sempre que qualquer fio muda. Ou seja: **assim que um projeto tem um T ou uma junção de
4 ramos em qualquer lugar, todo e qualquer diff subsequente de fio no projeto inteiro cai no
full-rebuild, e o branch de `pushWireTopologyTransaction` (o primitivo atômico que resolve o P0 da
auditoria) fica inatingível pelo resto da sessão de edição daquele projeto.** E o handler mais usado na
prática, `requestConnectEndpoints` (o clique-pra-conectar/derivar), **nem passa por
`syncProjectSnapshotToCore`** — ele SEMPRE chama `queueCoreRebuild()` diretamente
(`extension.ts:857`), independentemente de haver nó de topologia ou não.

**Estimativa de impacto** (não medida em GUI real, mas O(n) é um fato do código, não uma suposição):
um circuito com 500 componentes / 700 fios — nem exageradamente grande — dispara ~1.200 round-trips de
IPC sequenciais **a cada única ação de conectar um fio**. Mesmo a 1 ms por round-trip (otimista pra um
named pipe/socket local com serialização JSON), isso é >1 segundo de travamento perceptível por
EDIÇÃO. Isso é pior, não melhor, do que a "operação composta" que a auditoria original criticava (que
envolvia no máximo 4 chamadas — 1 junção + até 3 fios).

**Outros custos identificados**:
- `electricalEdgesForProject`/`voltageProbesForProject` fazem BFS O(V+E) — desprezível comparado ao
  custo de IPC acima, mas rodam a CADA full-rebuild, então o custo se acumula com a frequência do
  rebuild, não com o tamanho da mudança.
- Undo/redo: `structuredClone` de `components`+`wires`+`topologyNodes` a cada mudança de conteúdo —
  O(tamanho do documento) por transição, não O(mudança). Aceitável pra documentos pequenos/médios,
  degrada linear com o tamanho do projeto a cada Ctrl+Z.
- `state.topologyNodes?.find(...)` espalhado (`pinScenePosition`, `wirePolylinePoints`) — O(N) linear,
  mas N (nós de topologia) tende a ser pequeno mesmo em circuitos grandes; não é o gargalo dominante.

**Conclusão desta seção**: o modelo atual **não é mais enxuto em tempo de execução** pro caso comum de
edição com junção presente — é uma REGRESSÃO de latência percebida em relação ao que a auditoria
original já classificava como insuficiente ("circuitos grandes: não atende"). "Menos abstrações" aqui
literalmente significou "mais chamadas de rede por edição", confirmando o alerta do próprio pedido do
usuário: menos código não é sinônimo de mais rápido.

---

## Riscos da arquitetura atual

1. **Performance/escalabilidade** (crítico, evidenciado): full-rebuild como caminho default de edição
   assim que há qualquer junção — o cenário mais comum em circuitos reais, não o excepcional.
2. **Representação dupla** (`topologyNodes` vivo vs. `topology{nodes,conductors}` canônico): funciona
   hoje por disciplina manual; qualquer feature nova de fio precisa reconciliar as duas.
3. **Ausência de FSM**: bugs de UX confirmados (não corrupção de dado) quando ferramentas se combinam
   de forma não prevista.
4. **Validação de invariante só na borda**: um bug futuro na lógica de edição pode produzir um estado
   transitório inválido que só seria pego ao salvar — tarde demais pra dar feedback útil ao usuário no
   momento do erro.
5. **Geometria e conectividade não separadas** (herdado, não piorado nesta rodada): `wire.points`
   embutido no mesmo objeto que `from`/`to` — limita features futuras de roteamento/seleção parcial de
   segmento, exatamente como a auditoria original já apontava.

---

## Comparação das alternativas

| Critério | Opção 1 — manter atual | Opção 2 — consolidar (recomendada, com correção de roteamento) | Opção 3 — reescrever o motor |
|---|---|---|---|
| Arquitetura | `components+wires+topologyNodes` + ponte pra `topology{}` só em save/load | `topology{nodes,conductors}` promovido a modelo vivo único; `applyWireTopologyTransaction` estendido e roteado corretamente; FSM leve pra ferramenta | Kernel novo, API incompatível, Command Bus, undo por comando inverso |
| Vantagens | Zero esforço imediato | Elimina representação dupla; conserta o bug de performance crítico usando peças já existentes; FSM elimina bugs de estado confirmados | Resolveria tudo "de uma vez", inclusive geometria/conectividade separadas |
| Desvantagens | Perpetua o bug de performance crítico (não é cosmético — é regressão medida) e a representação dupla | Exige migrar `main.ts`/`extension.ts` pra um novo shape de estado — trabalho real, não trivial | Custo alto, reintroduz risco de regressão em tudo que já funciona (T, grau-4, split, índice espacial, persistência v2) sem evidência de que o modelo de DADOS atual seja insuficiente |
| Risco | Alto (bug de performance em produção, silencioso até alguém abrir um circuito grande com uma junção) | Médio — migração mecânica, mas escopo conhecido e testável incrementalmente | Alto — reescrever testado/funcionando sem necessidade comprovada |
| Impacto Frontend | Nenhum | `main.ts`/`extension.ts`/`wireTopology.ts` mudam de shape de estado | Total |
| Impacto Core | Nenhum | Estender `applyWireTopologyTransaction` pra cobrir o caso "novo nó" (achatamento incremental) | Possível reescrita de `Netlist`/IPC |
| Impacto IPC | Nenhum | Um verbo estendido, sem quebrar o protocolo existente | Provável verbo novo/versão de protocolo |
| Impacto persistência | Nenhum | Nenhum — v2 já é o formato canônico, só passa a ser também o formato vivo | Provável v3 |
| Impacto undo/redo | Nenhum | Nenhum necessário no curto prazo (snapshot continua funcionando sobre o novo shape) | Reescrita pra comando-inverso, se decidido fazer |
| Esforço estimado | Zero | Médio (dias, não semanas — a maior parte das peças já existe) | Alto (semanas) |
| Adequação de longo prazo | Ruim (débito visível cresce) | Boa | Excessiva pro problema real identificado |

Não encontrei, nesta investigação, um "ganho concreto significativo" que justifique a Opção 3 sobre a
Opção 2 — a diferença entre elas não é "modelo de dados insuficiente" (o modelo atual, quando promovido
a vivo, já cobre nós/portas/condutores/vértices/redes), é "o modelo certo não está sendo usado de forma
consistente nem roteado corretamente pro Core". Reescrever o motor inteiro pagaria um custo alto pra
resolver um problema que é, na raiz, um problema de **consolidação e roteamento**, não de desenho de
dados.

---

## Recomendação arquitetural

Respostas diretas (seção 11 do pedido):

1. **A implementação atual é arquiteturalmente boa?** Parcialmente. O índice espacial e a remoção de
   `connectors.junction` do Core são bem executados e resolvem P0/P1 reais da auditoria. O modelo de
   edição vivo (representação dupla + full-rebuild como caminho default) não é bom — tem um bug de
   performance crítico e não resolve o P0 #1 da própria auditoria (atomicidade) no caso comum.
2. **`topologyNodes` deve continuar como array paralelo?** Não. Deve ser absorvido pelo modelo canônico
   (`CanonicalTopologyDocument`), que já existe e já tem o tipo certo (`nodes`+`conductors` com
   endpoints tipados).
3. **`topologyDocument.ts` deve continuar sendo uma ponte?** Não no sentido atual (só bordas). Deve
   virar o modelo vivo (Alternativa B da seção dedicada) — as funções de tradução somem porque deixa
   de haver duas representações pra traduzir entre si.
4. **A implementação atual concluiu a proposta da auditoria?** Não. Concluiu a parte de índice espacial
   e removeu o componente artificial do Core integralmente. Não concluiu: FSM, Command Bus (mas ver
   resposta 8), modelo canônico como fonte única vivo, e — mais grave — não atingiu a própria meta de
   aceite "zero snapshots completos em edição" que a auditoria definiu.
5. **A simplificação foi deliberada ou um corte incompleto?** As duas coisas, em partes diferentes:
   deliberada e bem documentada pro `Netlist::rebuildTopology` (seção 24.5 da spec); um corte
   incompleto, sem documentação de decisão, pro roteamento que torna `applyWireTopologyTransaction`
   inatingível na prática.
6. **Há problemas que não podem ser resolvidos adequadamente sem reestruturação?** Sim — o bug de
   performance (full-rebuild como default) não tem correção pontual honesta: uma correção pontual seria
   "estender a condição do `if` em `syncProjectSnapshotToCore`", mas isso não resolve o caso mais comum
   (`requestConnectEndpoints`, que nem passa por ali) — exige tocar no fluxo de criação de fio pra
   também emitir um delta transacional em vez de sempre pedir rebuild completo. Isso é uma
   reestruturação real, mas ESCOPADA (não é reescrever o motor inteiro).
7. **Um kernel canônico vivo traria benefício real?** Sim, mensurável: elimina a tradução dupla e
   fornece o TIPO certo (`endpoint.kind`) pra parar de resolver "isto é nó ou pino" por convenção de
   string espalhada em 3 arquivos.
8. **Um Command Bus completo é necessário?** Não. O primitivo atômico que importa
   (`applyWireTopologyTransaction`) já existe no Core; falta estendê-lo pra cobrir o caso "conexão com
   nó novo/reusado" e ROTEAR as operações de edição pra ele em vez de pro rebuild completo. Um bus
   genérico de comandos não agrega nada que essa extensão pontual não entregue.
9. **Uma FSM formal é necessária?** Sim, mas leve — uma união discriminada + um `switch` exaustivo pro
   estado da ferramenta de fios, não um framework de máquina de estados. Justificada por bugs REAIS
   confirmados (não hipotéticos), não pela auditoria ter mencionado FSM.
10. **Manter, evoluir ou substituir?** **Evoluir por consolidação dirigida** — Opção 2 da comparação:
    promover o canônico a vivo, estender a transação atômica pro caso de nó novo, adicionar FSM leve.
    Não é "manter como está" (o bug de performance é real e precisa ser corrigido) nem "substituir do
    zero" (não há evidência de que o modelo de dados atual seja insuficiente).
11. **Ganhos concretos que justificam a mudança**: eliminar o full-rebuild como caminho default
    (ganho de performance medido em ordens de grandeza pra circuitos com >100 componentes); eliminar a
    classe de bug de sincronização dupla antes que ela se manifeste numa feature futura; eliminar os 3
    bugs de FSM confirmados nesta análise.
12. **Riscos de não fazer a mudança**: degradação perceptível de UX em qualquer circuito realista com
    uma junção (a maioria) assim que crescer além de dezenas de componentes; acúmulo de trabalho de
    reconciliação manual toda vez que uma feature nova de fio for adicionada; os 3 bugs de FSM
    continuam existindo até alguém tropeçar neles em uso real.

---

## Arquitetura-alvo

```
main.ts / extension.ts (edição)          topologyDocument.ts (promovido)
  ToolMode (união discriminada,     -->   CanonicalTopologyDocument
   único estado de ferramenta)             { revision, nodes[], conductors[] }
  gestos (clique/arrasto/Esc)       -->   funções puras de comando
                                            (connect/split/move/remove)
                                            cada uma devolve um DELTA
                                                    |
                                                    v
                                     applyWireTopologyTransaction (Core)
                                       -- estendido pra aceitar delta com
                                          nó novo/reusado, não só
                                          connect/disconnect de aresta crua --
                                       revisão otimista + rollback (já existe)
```

Sem invenção de camada nova (Command Bus, kernel incompatível) — reaproveita `CanonicalTopologyDocument`,
`assertTopologyInvariants` e `applyWireTopologyTransaction`, todos já implementados nesta sessão, só
promovendo o primeiro a modelo vivo e estendendo o alcance do último.

---

## Plano de ação disruptivo

Disruptivo no sentido de remover a representação paralela e mudar o shape de estado vivo — não no
sentido de reescrever o motor inteiro. Cada fase tem condição de remoção explícita pra qualquer ponte
criada, conforme pedido.

### Fase 1 — Estender `applyWireTopologyTransaction` pro caso de nó novo/reusado

- **Objetivo**: o Core aceitar, numa única transação, um delta que inclui achatamento em torno de um
  nó de topologia novo ou reusado (hoje só aceita `connect`/`disconnect` de arestas já resolvidas).
- **Justificativa**: sem isso, `requestConnectEndpoints` não tem como parar de chamar
  `queueCoreRebuild()` — é o pré-requisito de tudo mais.
- **Arquivos**: `core/src/session/SimulationSession.hpp/cpp` (`WireTopologyOperation` ganha uma
  variante que carrega o achatamento pré-computado, mesma lógica de `electricalEdgesForProject`
  reaproveitada do lado Core ou recebida já achatada do host), `CoreApplication.cpp` (handler IPC).
- **Testes**: diferencial contra `queueCoreRebuild` completo (mesmo resultado elétrico, medido por
  `getNodeVoltage` em cenários de T/grau-4) + o teste de regressão de `diode_test.cpp` continua
  passando.
- **Risco**: baixo — extensão aditiva de uma API que já existe e já é testada.
- **Paralelizável** com a Fase 2.

### Fase 2 — Promover `CanonicalTopologyDocument` a modelo vivo

- **Objetivo**: `main.ts`/`extension.ts` passam a manter `topology: CanonicalTopologyDocument` em vez
  de `components`(parte elétrica)+`wires`+`topologyNodes` separados. `components` continua existindo
  só pra dados NÃO-topológicos (propriedades, posição, tipo).
- **O que fazer com `topologyNodes`**: REMOVIDO como array separado — vira `topology.nodes`.
- **O que fazer com `topologyDocument.ts`**: deixa de ser "ponte" — `canonicalTopologyFromLegacy`/
  `legacyTopologyFromCanonical` são removidas (não há mais "legado" pra converter DE/PARA, o vivo já é
  o canônico). `assertTopologyInvariants` passa a ser chamado a cada comando de edição (Fase 3), não só
  em save/load.
- **Migração das operações de edição**: `connectEndpointToNode`/`splitSegmentAtPoint` (`wireTopology.ts`)
  passam a operar sobre `CanonicalTopologyDocument` diretamente (assinatura muda de
  `{components,wires,nodes}` pra `{topology, components}`).
- **Arquivos**: `model.ts` (`WebviewProjectState.topology` substitui `.wires`+`.topologyNodes`),
  `main.ts` (todo uso de `state.wires`/`state.topologyNodes` reescrito), `extension.ts` (idem em
  `schematicState`), `wireTopology.ts`, `coreLifecycle.ts` (`electricalEdgesForProject` passa a ler
  `topology.conductors` direto).
- **Testes**: toda a suíte `wireTopology.test.ts`/`topologyDocument.test.ts` adaptada pro novo shape —
  nenhum caso de teste é removido, todos continuam validando o mesmo comportamento.
- **Persistência**: nenhuma mudança de schema — `.lsproj`/`.lssubcircuit` v2 já é esse shape.
- **Risco**: médio — é uma migração mecânica mas tocando em muitos call sites; mitigar com o `tsc`
  como rede de segurança (mudar o tipo de `WebviewProjectState` primeiro, deixar o compilador apontar
  todo call site que precisa mudar).
- **Depende de**: nada (pode começar em paralelo com a Fase 1).

### Fase 3 — Validação de invariante em toda edição, não só em save/load

- **Objetivo**: `assertTopologyInvariants` roda depois de CADA comando de edição de fio (connect,
  split, remove), não só em save/load.
- **Justificativa**: fecha o "Invariant Validator" que a auditoria pedia sobre cada comando, elimina a
  janela onde um estado transitório inválido só seria pego ao salvar.
- **Arquivos**: `extension.ts` (handlers de `requestConnectEndpoints`/`requestRemoveWire`/etc chamam
  `assertTopologyInvariants` antes de aplicar o novo `topology` a `schematicState`, revertem se falhar).
- **Testes**: casos de invariante violada (nó duplicado, condutor de comprimento zero, endpoint órfão)
  cobertos por teste que confirma que a mutação é REJEITADA e o estado anterior é preservado.
- **Risco**: baixo.
- **Depende de**: Fase 2.

### Fase 4 — Roteamento: eliminar `queueCoreRebuild()` do caminho de edição interativa

- **Objetivo**: `requestConnectEndpoints`/drag-de-componente com auto-junção/remoção de fio passam a
  chamar a transação estendida da Fase 1 em vez de `queueCoreRebuild()`. `queueCoreRebuild()` continua
  existindo só pra load inicial/recuperação de erro (uso legítimo, não uso de edição comum).
- **Justificativa**: é o achado central deste relatório — sem isso, nada do resto muda o comportamento
  medido.
- **Arquivos**: `extension.ts` (handlers de edição), `coreLifecycle.ts` (`pushWireTopologyTransaction`
  estendido pra aceitar o delta com nó novo da Fase 1).
- **Benchmarks**: medir round-trips de IPC por gesto de conexão ANTES/DEPOIS num circuito sintético de
  500 componentes/700 fios com pelo menos 1 junção — meta: 1 request/response por gesto (igual à meta
  de aceite original da auditoria), não O(componentes+fios).
- **Risco**: médio — é a mudança de maior impacto em comportamento observável; mitigar com testes de
  regressão elétrica (mesma tensão resultante entre o caminho antigo de rebuild completo e o novo
  caminho transacional, nos mesmos cenários de T/grau-4/reuso de junção).
- **Depende de**: Fases 1, 2 e 3.

### Fase 5 — FSM leve pra ferramenta de fios

- **Objetivo**: substituir as 7 variáveis dispersas (`pendingConnection`, `pendingWireRoute`,
  `pendingWireBendLengths`, `pendingWirePreviewTarget`, `placingTypeId`, estado de marquee, estado de
  drag de segmento) por um único `type ToolMode` (união discriminada) + uma função de transição central.
- **Como representar**: `ToolMode = {kind:"idle"} | {kind:"wireDraft", origin, route, bendLengths,
  previewTarget} | {kind:"placingComponent", typeId} | {kind:"marquee", ...} | {kind:"draggingSegment",
  ...}` — um `switch` exaustivo em cada handler de evento (clique, Esc, botão direito, entrada de novo
  modo) decide a transição, e o TypeScript aponta qualquer combinação não tratada.
- **Correção direta dos 3 bugs confirmados**: `enterPlacementMode` passa a checar o modo atual e SÓ
  transiciona se `mode.kind === "idle"` (ou explicitamente cancela o draft antes, decisão de produto a
  confirmar com o usuário); o handler de Esc vira um único `switch` sem `return` antecipado que esconde
  o segundo caso.
- **Arquivos**: `main.ts` (novo tipo + refatoração dos handlers já mapeados nesta análise).
- **Testes**: os 3 cenários de estado combinado desta análise viram teste de regressão explícito
  (mesmo sem DOM — testável como transição pura de `ToolMode`).
- **Risco**: baixo — mudança isolada na Webview, não toca Core/IPC/persistência.
- **Depende de**: nada tecnicamente, mas faz mais sentido depois da Fase 2 (o `wireDraft` mode já
  referenciaria o `CanonicalTopologyDocument` novo).

### Fase 6 — Remoção de código legado

- **O que remover**: `canonicalTopologyFromLegacy`/`legacyTopologyFromCanonical` (Fase 2 já elimina a
  necessidade); qualquer `if (nodeIds.has(...))` duplicado que hoje existe em 3 arquivos por conta da
  falta de discriminador de tipo (Fase 2 resolve com `endpoint.kind`).
- **Condição de remoção**: só depois que TODOS os call sites de produção (Fases 2-4) e TODOS os testes
  estiverem migrados pro shape novo — nenhuma ponte fica "temporária" indefinidamente; se a Fase 2 não
  puder ser concluída por algum motivo descoberto durante a implementação, isso deve virar uma decisão
  registrada em ADR/`.spec`, não um silêncio.
- **Risco**: baixo, é limpeza depois que tudo mais já validou.

### Critérios de aceite (todas as fases)

- Nenhum teste da suíte atual (TS: 208 casos; Core: 36 testes) regride.
- Benchmark de conexão de fio num circuito de 500/700 (componentes/fios) com 1+ junção: 1
  request/response de IPC por gesto de conexão, não O(componentes+fios).
- `assertTopologyInvariants` roda em toda mutação de topologia, não só save/load.
- Os 3 cenários de FSM inválida desta análise têm teste de regressão explícito e passam.
- Zero uso de `topologyNodes` como array separado no código final (só `topology.nodes`).
- `.spec` atualizada com a decisão final (ADR + seção nova), antes de fechar a última fase — mesma
  disciplina normativa já usada nas seções 24/19 escritas nesta sessão.

---

## Conclusão

A implementação real ficou mais enxuta em contagem de arquivos e camadas do que a arquitetura-alvo da
auditoria, mas **não ficou mais enxuta em custo de execução** — pelo contrário, o caminho de edição
interativa mais comum hoje é MAIS caro (full-rebuild sequencial) do que a "operação composta" que a
auditoria original já criticava. A causa raiz não é o tamanho do modelo de dados escolhido (que está
correto e é reaproveitável) — é que o trabalho parece ter parado a meio caminho entre "construir os
primitivos certos" (índice espacial, transação atômica, documento canônico, achatamento de junção — tudo
isso está bem feito) e "rotear as operações de edição de fato através deles" (não está feito; o
full-rebuild ficou como o caminho padrão de fato, silenciosamente). Isso não é uma preferência por manter
menos código — é uma lacuna de conclusão, evidenciada por um bug de performance concreto e medível, e
por três bugs de estado reproduzíveis por leitura de código. A correção recomendada (Opção 2, consolidar
+ estender + FSM leve) resolve os dois sem descartar o trabalho já feito nesta sessão — que, nas partes
em que foi terminado, é de boa qualidade.

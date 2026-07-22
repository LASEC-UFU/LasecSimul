import { WebviewComponentModel, WebviewProjectState, WebviewWireModel } from "./model";
import { ConnectionEndpoint } from "./wireTopology";

/** Mesma forma de `ConnectionEndpoint` (`wireTopology.ts`) -- eram dois tipos idênticos definidos em
 * paralelo (achado real de duplicação: "regras de conexão repetidas em diferentes arquivos").
 * Alias, não redefinição, pra que os dois lados do protocolo (mensagem IPC e motor de topologia)
 * nunca possam divergir de novo por acidente. */
type WireEndpoint = ConnectionEndpoint;

export const WEBVIEW_MESSAGE_VERSION = 1 as const;

export type SimulationStatus = "stopped" | "running" | "paused";
export type ComponentReadoutValue = number | number[];

export interface AnalyzerChannelDescriptor {
  channelId: string;
  label: string;
  source: string;
  kind: "analog" | "digital" | "unsigned";
  width: number;
  msb: number;
  lsb: number;
}

export interface AnalyzerVectorHistory {
  formatVersion: 2;
  channels: AnalyzerChannelDescriptor[];
  timestampsNs: number[];
  /** Uma linha por amostra e uma coluna por canal. Decimal textual preserva uint64 sem a perda de
   * precisão de `number` no structured-clone Webview. */
  values: string[][];
}

/** Histórico REAL (tempo simulado de verdade, `Scheduler::nowNs()` do Core -- ver `core/src/
 * components/meters/Oscope.hpp`/`LogicAnalyzer.hpp`) pra janela "Expande" -- diferente do
 * `ComponentReadoutValue` acima, que só carrega a ÚLTIMA leitura (usado pela pré-visualização
 * pequena no canvas, que acumula seu PRÓPRIO histórico no cliente por poll de IPC, sem precisão de
 * tempo real -- ver `main.ts::updateReadoutHistories`). Buscado só quando uma janela "Expande" está
 * aberta pra aquele componente (`requestInstrumentHistory`), não a cada poll de TODOS os
 * instrumentos -- histórico real pode ter centenas de amostras, não compensa mandar pra quem não
 * pediu. */
export interface InstrumentHistoryPayload {
  componentId: string;
  oscope?: { channels: Array<{ timestampsNs: number[]; values: number[] }> };
  logic?: AnalyzerVectorHistory;
}

/** Um componente do circuito INTERNO de um `.lssubcircuit` -- alimenta o overlay de Modo Placa no
 * circuito principal E o submenu por componente exposto no menu de contexto da instância (ver
 * `subpackage.cpp::mainComp()`/`setBoardMode()` no SimulIDE real). `boardVisual` ausente significa
 * que o componente nunca foi posicionado em Modo Placa (sem posição pra desenhar no overlay, cai
 * num padrão calculado, ver `main.ts::fallbackBoardVisualPosition`). `properties` é o último valor
 * SALVO no `.lssubcircuit` (não necessariamente o estado ao vivo do Core) -- suficiente pro dialog de
 * propriedades do componente exposto, mesmo princípio de como o dialog de Propriedades de fora já
 * lê de `WebviewComponentModel.properties` em vez de reconsultar o Core toda vez. */
export interface InternalComponentSnapshot {
  id: string;
  typeId: string;
  /** Nome REAL salvo no `.lssubcircuit` (mesmo campo top-level de `ProjectComponent.label`) --
   * ausente no arquivo cai em `id` (mesmo default de sempre pra quem nunca teve um label
   * customizado). Fix "label de componente exposto não aparecia no overlay de Modo Placa"
   * (2026-07-18): antes este campo vinha sempre igual a `id`, nunca o texto de verdade. */
  label: string;
  graphical: boolean;
  exposed: boolean;
  /** Independente de `exposed` -- pedido real: "componente exposto e propriedade exportada devem
   * ser conceitos independentes". Só quando `true` este componente ganha o submenu "Propriedades"
   * na instância do subcircuito no schematic principal (`main.ts::buildExposedComponentMenuItems`).
   * Ver `SubcircuitDocument.exportedPropertyComponentIds`. */
  exported: boolean;
  /** Visibilidade do rótulo id/value (mesmos campos top-level de `ProjectComponent`/
   * `WebviewComponentModel`) -- sem isto, `main.ts::renderBoardOverlaysFor` não tinha como saber se
   * devia desenhar o label no overlay (2026-07-18). */
  showId?: boolean;
  showValue?: boolean;
  showDialValue?: boolean;
  valueLabelPropertyKey?: string;
  boardVisual?: { x: number; y: number; rotation: 0 | 90 | 180 | 270; flipH?: boolean; flipV?: boolean };
  properties: Record<string, string | number | boolean>;
}

export type HostToWebviewMessage =
  | { version: number; type: "init"; project: WebviewProjectState }
  | { version: number; type: "selectComponent"; componentId: string | null }
  | { version: number; type: "beginComponentPlacement"; typeId: string }
  | { version: number; type: "syncState"; project: WebviewProjectState }
  /** PC-1/EX-7 (.spec/lasecsimul-native-devices.spec) -- versão incremental de "syncState": só os
   * campos de nível superior de `WebviewProjectState` que MUDARAM desde o último sync (comparação
   * por referência no lado da Extension, ver `extension.ts::syncSchematicPanel`). A Webview funde
   * (`state = {...state, ...patch}`), nunca substitui por inteiro -- um campo ausente aqui significa
   * "sem mudança", não "esvaziar". `catalog` em especial quase nunca muda, então a maioria dos
   * patches nem chega a incluí-lo (nem re-clonar do lado da Extension, nem re-registrar pacotes do
   * lado da Webview). "syncState"/"init" continuam existindo tal como antes pros casos de
   * ressincronização completa (painel recriado, carga inicial). `pendingConnection` usa `null`
   * (nunca `undefined`) pra "limpar" -- `undefined` some silenciosamente de um `JSON.stringify`
   * (chave nem aparece no objeto resultante), então "voltou a `undefined`" ficaria indistinguível de
   * "não mudou" se não fosse por um sentinela serializável; `null` sobrevive o round-trip inteiro. */
  | {
      version: number;
      type: "syncStatePatch";
      patch: Omit<Partial<WebviewProjectState>, "pendingConnection" | "subcircuitEditingContext" | "symbolCanvas" | "iconCanvas"> & {
        pendingConnection?: WebviewProjectState["pendingConnection"] | null;
        subcircuitEditingContext?: WebviewProjectState["subcircuitEditingContext"] | null;
        symbolCanvas?: WebviewProjectState["symbolCanvas"] | null;
        iconCanvas?: WebviewProjectState["iconCanvas"] | null;
      };
    }
  | { version: number; type: "componentReadout"; readoutsByComponentId: Record<string, ComponentReadoutValue> }
  | { version: number; type: "wireVoltages"; voltagesByWireId: Record<string, number> }
  | { version: number; type: "simulationStatus"; status: SimulationStatus }
  | { version: number; type: "lasecPlotStatus"; componentId: string; opened: boolean; clients: number; error?: string }
  | { version: number; type: "serialTerminalStatus"; componentId: string; opened: boolean; online: boolean; error?: string }
  | { version: number; type: "serialTerminalData"; componentId: string; dataHex: string; simulationTimeNs: number }
  | { version: number; type: "serialTerminalLoadedFile"; componentId: string; dataHex: string }
  | { version: number; type: "serialPortStatus"; componentId: string; opened: boolean; online: boolean; rxBytes: number; txBytes: number; error?: string }
  /** Painel "Abrir monitor serial UARTx" de um `QemuDevice` (ver `mcuCommands.ts::openSerialMonitor`,
   * `main.ts::renderMcuSerialMonitorWindows`) -- réplica visual/funcional do `SerialMonitor` real do
   * SimulIDE (`gui/serial/serialmon.cpp`: painéis Input/Output, Pause, modo de impressão), mas SEM
   * envio (o real usa `send=false` pro monitor por USART do MCU -- só o Serial Terminal cabeado tem
   * `send=true`). `key` é o mesmo de `mcuSerialMonitorByKey` (`state.ts`):
   * `${componentId}:${usartIndex}` ou `${outerComponentId}:${innerComponentId}:${usartIndex}`. */
  | { version: number; type: "mcuSerialMonitorStatus"; key: string; label: string; portLabel: string; opened: boolean; online: boolean; error?: string }
  /** Delta de texto já decodificado (`getMcuLogs()` devolve string, não bytes/hex -- diferente de
   * `serialTerminalData`) -- a Webview acumula e formata via `serialFormatBytes` sobre os bytes UTF-8
   * do texto quando o modo de impressão não é ASCII. */
  | { version: number; type: "mcuSerialMonitorData"; key: string; text: string }
  | { version: number; type: "pauseConditionTriggered"; ownerId: string; simulationTimeNs: number; expression: string; resolvedValues: Record<string, number | boolean | string>; error?: string }
  | { version: number; type: "pauseConditionValidation"; componentId: string; valid: boolean; error?: string; column?: number }
  /** Taxa real alcançada (`(ms simulados)/(ms de parede)`, ver `coreLifecycle.ts::pollSimulationRate`)
   * -- `undefined` quando parado/sem amostra suficiente ainda (achado de auditoria de UI 2026-07-09,
   * paridade com `InfoWidget::setRate()` do SimulIDE real). */
  | { version: number; type: "simulationRate"; rate: number | undefined }
  /** Resposta a `requestInstrumentHistory` -- histórico REAL (tempo simulado), ver
   * `InstrumentHistoryPayload`. */
  | ({ version: number; type: "instrumentHistory" } & InstrumentHistoryPayload)
  /** Resposta a `requestBoardOverlayData` -- alimenta o overlay de Modo Placa E o submenu por
   * componente exposto no menu de contexto da instância (ver `main.ts::renderBoardOverlaysFor`/
   * `buildExposedComponentMenuItems`). */
  | { version: number; type: "boardOverlayData"; componentId: string; items: InternalComponentSnapshot[] }
  /** Leitura AO VIVO (corrente/etc, ABI v2 `readoutFormat`) de um componente interno exposto e
   * graficamente visível no overlay de Modo Placa (`main.ts::renderBoardOverlaysFor`) -- diferente de
   * `boardOverlayData` acima, que só traz `properties` ESTÁTICAS lidas do arquivo `.lssubcircuit`
   * (nunca o estado real da simulação rodando). Sem isto, um LED onboard exposto (`outputs.led`/
   * `outputs.led_bar` com `size:1`) nunca acendia de verdade quando o subcircuito estava colocado
   * como bloco -- só dentro do próprio modo de edição do subcircuito (que usa `runtimeSymbolProperties`
   * normalmente). Chave = `${outerComponentId}:${innerComponentId}` (ver
   * `coreLifecycle.ts::pollBoardOverlayReadouts`). */
  | { version: number; type: "boardOverlayReadouts"; readoutsByKey: Record<string, ComponentReadoutValue> }
  /** Vem de `lasecsimul.rotateSelectionCw`/`Ccw` (`extension.ts`), disparado por keybinding do
   * VSCode com `when: activeWebviewPanelId == 'lasecsimul.schematic'` -- sobrepõe o `Ctrl+R`/
   * `Ctrl+Shift+R` nativo do VSCode SÓ enquanto o painel está em foco (`when` reverte sozinho ao
   * trocar de foco, sem lógica de restauração manual). A Webview não trata mais `Ctrl+R` no próprio
   * `keydown` -- esse é o caminho confiável agora, ver `.spec/lasecsimul.spec` seção 13.4. */
  | { version: number; type: "requestRotateSelection"; direction: "cw" | "ccw" }
  /** Mesmo caminho de `requestRotateSelection`, mas pra flip -- ver `lasecsimul.flipSelectionHorizontal`/
   * `Vertical` em `extension.ts`. */
  | { version: number; type: "requestFlipSelection"; axis: "horizontal" | "vertical" }
  /** Mesmo caminho de `requestRotateSelection`, mas pra desfazer/refazer -- ver `lasecsimul.undo`/
   * `lasecsimul.redo` em `extension.ts`. Undo/redo é 100% local à Webview (pilha de snapshots de
   * `components`/`wires`/seleção mantida em `main.ts`, ver `recordUndoSnapshotIfChanged`) -- ao
   * aplicar um snapshot, `persistState()` roda normalmente e o `"projectChanged"` de sempre já
   * sincroniza o Core via diff (sem verbo IPC dedicado pra desfazer). */
  | { version: number; type: "requestUndo" }
  | { version: number; type: "requestRedo" }
  /** Solicita à Webview que empacote a seleção atual e envie `requestCreateSubcircuitFromSelection`
   * de volta -- disparado pelo comando `lasecsimul.newSubcircuit` quando o painel está aberto, como
   * alternativa ao item do menu de contexto (que só aparece quando já há uma multi-seleção). */
  | { version: number; type: "triggerCreateSubcircuitFromSelection" };

export type WebviewToHostMessage =
  | { version: number; type: "webviewReady" }
  | { version: number; type: "projectChanged"; project: WebviewProjectState }
  | { version: number; type: "requestAddComponent"; typeId: string }
  /** `scope` -- em qual cena inserir (`main.ts::subcircuitEditorMode`, traduzido pro vocabulário do
   * modelo canônico do host, `core/schematicModel.ts::ElementScope`) -- sem isto, colar/duplicar
   * (Ctrl+Shift-arrastar) um pino/forma em Modo Símbolo/Ícone inseria erradamente no circuito
   * interno real E tentava sincronizar com o Core (bug real: nunca deveria acontecer, símbolo/ícone
   * nunca têm presença no Core). `wires` só é significativo quando `scope === "schematic"` (Símbolo/
   * Ícone nunca têm fios/topologia). */
  | { version: number; type: "requestInsertItems"; scope: "schematic" | "symbol" | "icon"; components: WebviewComponentModel[]; wires: WebviewWireModel[] }
  | { version: number; type: "requestRemoveComponent"; componentId: string }
  | { version: number; type: "requestRemoveWire"; wireId: string }
  | { version: number; type: "requestRotateComponent"; componentId: string; rotation: 0 | 90 | 180 | 270 }
  | { version: number; type: "requestFlipComponent"; componentId: string; flipH: boolean; flipV: boolean }
  | { version: number; type: "requestRenameComponent"; componentId: string; label: string }
  | { version: number; type: "requestUpdateLabelVisibility"; componentId: string; showId: boolean; showValue: boolean; showDialValue?: boolean; valueLabelPropertyKey?: string }
  /** Commit único de uma conexão cujo início pode ser um segmento ainda não dividido. O host
   * materializa todos os splits, nós e o ramo somente depois deste verbo. */
  | { version: number; type: "requestConnectEndpoints"; baseRevision: number; from: WireEndpoint; to: WireEndpoint; points?: Array<{ x: number; y: number }> }
  | { version: number; type: "requestUpdateProperty"; componentId: string; name: string; value: string | number | boolean }
  /** Atualiza o Core durante um gesto sem alterar/ecoar o documento. O commit persistente é enviado
   * uma única vez no pointerup, evitando confirmações antigas disputarem com o valor local. */
  | { version: number; type: "requestPreviewProperty"; componentId: string; name: string; value: string | number | boolean }
  | { version: number; type: "requestToggleLasecPlot"; componentId: string }
  | { version: number; type: "requestToggleSerialTerminal"; componentId: string }
  | { version: number; type: "requestSerialTerminalWrite"; componentId: string; dataHex: string }
  | { version: number; type: "requestSerialTerminalLoadFile"; componentId: string }
  | { version: number; type: "requestSerialTerminalSaveLog"; text: string }
  | { version: number; type: "requestToggleSerialPort"; componentId: string }
  /** Bloco genérico de subcircuito por caminho -- abre um seletor de `.lssubcircuit`, resolve
   * typeId/pinos/package do arquivo escolhido e registra no Core (verbo IPC avulso, sem
   * `library.json`). Mesmo comando serve pra escolha inicial e pra "relink" (arquivo ausente ou
   * trocar de arquivo depois de já resolvido) -- ver `.spec/lasecsimul-subcircuits.spec` seção 12. */
  | { version: number; type: "requestChooseSubcircuitFile"; componentId: string }
  /** Device genérico por caminho; não adiciona o manifesto ao catálogo permanente. */
  | { version: number; type: "requestChooseDeviceFile"; componentId: string }
  /** Editor de propriedade `filePath` GENÉRICO -- ao contrário de `requestChooseSubcircuitFile`
   * (caso especial único, nunca grava em `properties`, troca typeId/pinos/package da instância),
   * este comando serve QUALQUER `propertySchema` com `editor: "filePath"` cujo campo NÃO seja
   * `subcircuitPath`: abre o seletor, lê o arquivo e grava o resultado direto em
   * `component.properties[propertyKey]` (mais campos auxiliares resolvidos quando aplicável, ex:
   * `imageData`/`imageMime` pra `graphics.image.path` -- ver `extension.ts`). Usado hoje pelo objeto
   * Figura/ícone da autoria de Package (`.spec/lasecsimul.spec`), reaproveitável por qualquer futuro
   * campo `filePath` sem precisar de mais um caso especial. */
  | { version: number; type: "requestChooseFile"; componentId: string; propertyKey: string; filters?: Record<string, string[]> }
  /** Abre URL no browser externo — disparado pelo botão "Ajuda" do diálogo de propriedades quando
   * o componente tem `help.url` declarado no catálogo. */
  | { version: number; type: "requestOpenExternal"; url: string }
  | { version: number; type: "requestRunSimulation" }
  | { version: number; type: "requestPauseSimulation" }
  | { version: number; type: "requestSetPauseCondition"; componentId: string; expression: string }
  | { version: number; type: "requestStopSimulation" }
  /** Grava direto no arquivo já associado ao projeto (`state.currentProjectFilePath`); cai pro
   * fluxo de "Salvar Como" (diálogo de arquivo) só quando ainda não há nenhum arquivo associado
   * (projeto novo, nunca salvo) -- ver `projectCommands.ts::saveProjectCommand`. */
  | { version: number; type: "requestSaveProject" }
  /** Sempre mostra o diálogo de arquivo, mesmo que o projeto já tenha um arquivo associado --
   * botão "Salvar Como" da toolbar (substituiu "Salvar como SVG" 2026-07-17, exportação de imagem
   * removida). */
  | { version: number; type: "requestSaveProjectAs" }
  | { version: number; type: "requestOpenProject" }
  /** "Importar Circuito" (achado de auditoria de UI 2026-07-09) -- mescla outro `.lsproj` no
   * esquemático aberto, ver `projectCommands.ts::importProjectCommand`. */
  | { version: number; type: "requestImportCircuit" }
  | { version: number; type: "requestChooseMcuFirmware"; componentId: string }
  | { version: number; type: "requestOpenMcuSerialMonitor"; componentId: string; usartIndex: 0 | 1 | 2 }
  /** Mesmas ações do MCU de topo, mas disparadas a partir do submenu de um componente INTERNO
   * exposto de um subcircuito no esquemático principal. `outerComponentId` é a instância do
   * subcircuito colocada no circuito; `innerComponentId` é o id local salvo no `.lssubcircuit`
   * (ex: "mcu1"). O host resolve isso para a instância real do filho no Core.
   * "Recarregar firmware" (manual) removido 2026-07-09 -- ver `mcuCommands.ts::
   * ensureAllMcuFirmwareUpToDate`, chamado automaticamente antes de "Run" (`extension.ts::
   * runSimulationWithFirmwareCheck`), nunca mais uma ação exposta ao usuário. */
  | { version: number; type: "requestChooseExposedMcuFirmware"; outerComponentId: string; innerComponentId: string }
  | { version: number; type: "requestOpenExposedMcuSerialMonitor"; outerComponentId: string; innerComponentId: string; usartIndex: 0 | 1 | 2 }
  /** Botão "×" de um painel `mcuSerialMonitorStatus` -- pára o polling e libera `mcuSerialMonitorByKey`
   * (ver `mcuCommands.ts::closeMcuSerialMonitorByKey`). A Webview já remove o painel localmente ao
   * clicar (otimista); este pedido só limpa o lado Extension, sem resposta esperada. */
  | { version: number; type: "requestCloseMcuSerialMonitor"; key: string }
  /** "Exportar Dados" da janela "Expande" do osciloscópio/analisador lógico -- o CSV já vem PRONTO
   * (formatado em main.ts, que é quem tem o histórico/configuração de canais) pra extension.ts só
   * abrir `showSaveDialog`/escrever o arquivo, sem precisar conhecer o formato do instrumento. */
  | { version: number; type: "requestExportInstrumentData"; suggestedFileName: string; csvContent: string }
  /** Pedido de histórico REAL pra janela "Expande" -- ver `InstrumentHistoryPayload`. Mandado ao
   * abrir a janela e a cada `componentReadout` enquanto ela continuar aberta (mesmo ritmo de
   * atualização do resto da telemetria, ~300ms, ver `pollInstrumentReadouts`). */
  | { version: number; type: "requestInstrumentHistory"; componentId: string }
  /** Pedido de dados pro overlay de Modo Placa E pro submenu por componente exposto do menu de
   * contexto -- ver `boardOverlayData`. */
  | { version: number; type: "requestBoardOverlayData"; componentId: string; sourceId: string }
  /** Arrastar um componente do overlay de Modo Placa direto no circuito principal -- grava
   * `boardVisual` em `components[]` do `.lssubcircuit` (`sourceId`), mesmo campo que "Abrir
   * Subcircuito"/Modo Placa interno já usa (`compileSubcircuitInternalComponents`), só que editado
   * SEM precisar entrar na sessão de edição. `x`/`y` já vêm RELATIVOS à instância (não posição de
   * tela). */
  | { version: number; type: "requestUpdateBoardOverlayVisual"; sourceId: string; innerComponentId: string; x: number; y: number }
  /** Edita uma propriedade real de um componente INTERNO exposto sem entrar em "Open Subcircuit" --
   * usado pelo diálogo dedicado de propriedades do submenu externo. Persiste no `.lssubcircuit` e,
   * se a instância já estiver expandida no Core, tenta aplicar em runtime também. */
  | { version: number; type: "requestUpdateExposedComponentProperty"; outerComponentId: string; sourceId: string; innerComponentId: string; name: string; value: string | number | boolean }
  /** Clique num componente do overlay de Modo Placa no circuito principal -- `outerComponentId` é a
   * instância do subcircuito colocada no circuito do usuário, `innerComponentId` é o id LOCAL do
   * componente dentro do `.lssubcircuit` (ex: "button_en"). extension.ts traduz isso pro índice real
   * do componente Core dentro da instância expandida (ver `SimulationSession::
   * setSubcircuitChildProperty`, novo). */
  | { version: number; type: "requestUpdateBoardOverlayProperty"; outerComponentId: string; innerComponentId: string; name: string; value: string | number | boolean }
  /** Envia a seleção atual pro host pra criar um `.lssubcircuit` — disparado pelo item do menu de
   * contexto de multi-seleção OU pela resposta da Webview a `triggerCreateSubcircuitFromSelection`.
   * `componentIds`: IDs dos componentes selecionados. */
  | { version: number; type: "requestCreateSubcircuitFromSelection"; componentIds: string[] }
  /** "Abrir Subcircuito" no menu de contexto de uma instância `subcircuit-file` já registrada --
   * troca `components`/`wires` no painel pelo circuito INTERNO do `.lssubcircuit` apontado por
   * `sourceId` (mesmo `RegisteredSource.id` do catálogo), empilhando o circuito atual pra restaurar
   * depois. Ver `extension.ts::openSubcircuitForEditingCommand`/`WebviewProjectState.
   * subcircuitEditingContext`. */
  | { version: number; type: "requestOpenSubcircuit"; sourceId: string }
  /** "Voltar ao Circuito Principal" -- grava `components`/`wires` atuais de volta no `.lssubcircuit`
   * da sessão em andamento (topo da pilha) e restaura o circuito empilhado. No-op se nenhuma sessão
   * estiver ativa. */
  | { version: number; type: "requestCloseSubcircuitEditor" };

export function isHostMessage(value: unknown): value is HostToWebviewMessage {
  return typeof value === "object" && value !== null && "type" in value && "version" in value;
}

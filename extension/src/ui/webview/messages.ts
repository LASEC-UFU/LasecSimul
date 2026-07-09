import { WebviewComponentModel, WebviewProjectState, WebviewWireModel } from "./model";

export const WEBVIEW_MESSAGE_VERSION = 1 as const;

export type SimulationStatus = "stopped" | "running" | "paused";
export type ComponentReadoutValue = number | number[];

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
  logic?: { timestampsNs: number[]; masks: number[] };
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
  label: string;
  graphical: boolean;
  exposed: boolean;
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
  | { version: number; type: "syncStatePatch"; patch: Omit<Partial<WebviewProjectState>, "pendingConnection"> & { pendingConnection?: WebviewProjectState["pendingConnection"] | null } }
  | { version: number; type: "componentReadout"; readoutsByComponentId: Record<string, ComponentReadoutValue> }
  | { version: number; type: "wireVoltages"; voltagesByWireId: Record<string, number> }
  | { version: number; type: "simulationStatus"; status: SimulationStatus }
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
  | { version: number; type: "requestInsertItems"; components: WebviewComponentModel[]; wires: WebviewWireModel[] }
  | { version: number; type: "requestRemoveComponent"; componentId: string }
  | { version: number; type: "requestRemoveWire"; wireId: string }
  | { version: number; type: "requestRotateComponent"; componentId: string; rotation: 0 | 90 | 180 | 270 }
  | { version: number; type: "requestFlipComponent"; componentId: string; flipH: boolean; flipV: boolean }
  | { version: number; type: "requestRenameComponent"; componentId: string; label: string }
  | { version: number; type: "requestUpdateLabelVisibility"; componentId: string; showId: boolean; showValue: boolean; valueLabelPropertyKey?: string }
  | {
      version: number;
      type: "requestConnectPinToWire";
      from: { componentId: string; pinId: string };
      wireId: string;
      point: { x: number; y: number };
      points?: Array<{ x: number; y: number }>;
      existingWireFirstPoints?: Array<{ x: number; y: number }>;
      existingWireSecondPoints?: Array<{ x: number; y: number }>;
    }
  | { version: number; type: "requestConnectPins"; from: { componentId: string; pinId: string }; to: { componentId: string; pinId: string }; points?: Array<{ x: number; y: number }> }
  | { version: number; type: "requestUpdateProperty"; componentId: string; name: string; value: string | number | boolean }
  /** Bloco genérico de subcircuito por caminho -- abre um seletor de `.lssubcircuit`, resolve
   * typeId/pinos/package do arquivo escolhido e registra no Core (verbo IPC avulso, sem
   * `library.json`). Mesmo comando serve pra escolha inicial e pra "relink" (arquivo ausente ou
   * trocar de arquivo depois de já resolvido) -- ver `.spec/lasecsimul-subcircuits.spec` seção 12. */
  | { version: number; type: "requestChooseSubcircuitFile"; componentId: string }
  /** Abre URL no browser externo — disparado pelo botão "Ajuda" do diálogo de propriedades quando
   * o componente tem `help.url` declarado no catálogo. */
  | { version: number; type: "requestOpenExternal"; url: string }
  | { version: number; type: "requestRunSimulation" }
  | { version: number; type: "requestPauseSimulation" }
  | { version: number; type: "requestStopSimulation" }
  | { version: number; type: "requestSaveProject" }
  | { version: number; type: "requestOpenProject" }
  /** "Importar Circuito" (achado de auditoria de UI 2026-07-09) -- mescla outro `.lsproj` no
   * esquemático aberto, ver `projectCommands.ts::importProjectCommand`. */
  | { version: number; type: "requestImportCircuit" }
  /** "Salvar Esquemático como Imagem" (achado de auditoria de UI 2026-07-09, paridade com
   * SimulIDE real que exporta PNG/JPEG/BMP/SVG do menu de contexto) -- Webview monta o SVG (clona
   * `canvas-content` real dentro de um `<foreignObject>`, com o CSS da própria página embutido
   * inline, pra reaproveitar 100% do rendering já visualmente correto em vez de reconstruir posição/
   * rotação/flip do zero); a Extension só mostra o diálogo de salvar e grava o arquivo (mesmo
   * padrão de `requestSaveProject`, sem acesso a `fs` na Webview). Só SVG -- rasterizar pra PNG/
   * JPEG/BMP dentro da Webview arriscaria "tainted canvas" com um `<foreignObject>`, não
   * implementado nesta rodada (documentado como limitação, não bug). */
  | { version: number; type: "requestExportSchematicImage"; svg: string }
  | { version: number; type: "requestChooseMcuFirmware"; componentId: string }
  | { version: number; type: "requestReloadMcuFirmware"; componentId: string }
  | { version: number; type: "requestOpenMcuSerialMonitor"; componentId: string; usartIndex: 0 | 1 | 2 }
  /** Mesmas ações do MCU de topo, mas disparadas a partir do submenu de um componente INTERNO
   * exposto de um subcircuito no esquemático principal. `outerComponentId` é a instância do
   * subcircuito colocada no circuito; `innerComponentId` é o id local salvo no `.lssubcircuit`
   * (ex: "mcu1"). O host resolve isso para a instância real do filho no Core. */
  | { version: number; type: "requestChooseExposedMcuFirmware"; outerComponentId: string; innerComponentId: string }
  | { version: number; type: "requestReloadExposedMcuFirmware"; outerComponentId: string; innerComponentId: string }
  | { version: number; type: "requestOpenExposedMcuSerialMonitor"; outerComponentId: string; innerComponentId: string; usartIndex: 0 | 1 | 2 }
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
  | { version: number; type: "requestCreateSubcircuitFromSelection"; componentIds: string[] };

export function isHostMessage(value: unknown): value is HostToWebviewMessage {
  return typeof value === "object" && value !== null && "type" in value && "version" in value;
}

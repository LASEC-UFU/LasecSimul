import { WebviewComponentModel, WebviewProjectState, WebviewWireModel } from "./model";

/** Mesmo `RegisteredItemKind` de `extension.ts` -- duplicado aqui de propósito (mensagens não devem
 * importar de `extension.ts`, que tem `vscode` e roda só no host). `device.json` (`abi-device`) não
 * tem circuito interno nem variante Logic Symbol ("Package ≠ Subcircuit", ver `.spec/
 * lasecsimul-subcircuits.spec` seção 4) -- só listado aqui pra completar o tipo. */
export type SymbolAuthoringKind = "abi-device" | "mcu-adapter" | "subcircuit-file";

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

/** Um componente do circuito INTERNO de um `.lssub.json` -- alimenta o overlay de Modo Placa no
 * circuito principal E o submenu por componente exposto no menu de contexto da instância (ver
 * `subpackage.cpp::mainComp()`/`setBoardMode()` no SimulIDE real). `boardVisual` ausente significa
 * que o componente nunca foi posicionado em Modo Placa (sem posição pra desenhar no overlay, cai
 * num padrão calculado, ver `main.ts::fallbackBoardVisualPosition`). `properties` é o último valor
 * SALVO no `.lssub.json` (não necessariamente o estado ao vivo do Core) -- suficiente pro dialog de
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
  | { version: number; type: "componentReadout"; readoutsByComponentId: Record<string, ComponentReadoutValue> }
  | { version: number; type: "wireVoltages"; voltagesByWireId: Record<string, number> }
  | { version: number; type: "simulationStatus"; status: SimulationStatus }
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
  /** Solicita à Webview que empacote a seleção atual e envie `requestCreateSubcircuitFromSelection`
   * de volta -- disparado pelo comando `lasecsimul.newSubcircuit` quando o painel está aberto, como
   * alternativa ao item do menu de contexto (que só aparece quando já há uma multi-seleção). */
  | { version: number; type: "triggerCreateSubcircuitFromSelection" }
  /** Entra no modo de autoria de símbolo (Épico G, parte de escrita) -- ver `.spec/
   * lasecsimul-native-devices.spec` seção 21.3 e `docs/16-roadmap-pendencias-spec.md` Épico G:
   * mesmo princípio do SimulIDE real (`SubPackage`/`Rectangle`/`Ellipse`/.../`PackagePin` são
   * `Component`s comuns na MESMA cena do circuito, não um editor separado). `main.ts` troca
   * `state` por uma sessão nova semeada com `components` (um `other.package` + um `graphics.*` por
   * forma + um `other.package_pin` por pino, todos reconstruídos a partir do `package` atual do
   * manifesto pela Extension, ver `extension.ts::seedSymbolAuthoringComponents`) -- o circuito real
   * do usuário (se houver um aberto) nunca é tocado, só fica "escondido" até "Salvar Símbolo"/
   * "Cancelar" devolver `state` pro original. Pra `subcircuit-file`, `components`/`wires` TAMBÉM
   * incluem o circuito interno real (não só o `package`) -- "Open Subcircuit" do SimulIDE real
   * mostra os dois juntos na mesma cena (ver `.spec/lasecsimul-subcircuits.spec` seção 4). `view`
   * diz qual aparência está sendo editada agora ("logicSymbol" só pra `mcu-adapter`/
   * `subcircuit-file`, ver seção 21.3 do spec de plugins nativos). */
  | {
      version: number;
      type: "enterSymbolAuthoring";
      filePath: string;
      typeId: string;
      kind: SymbolAuthoringKind;
      view: "default" | "logicSymbol";
      components: WebviewComponentModel[];
      wires: WebviewWireModel[];
    };

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
  | { version: number; type: "requestUpdateLabelVisibility"; componentId: string; showId: boolean; showValue: boolean }
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
  /** Abre URL no browser externo — disparado pelo botão "Ajuda" do diálogo de propriedades quando
   * o componente tem `help.url` declarado no catálogo. */
  | { version: number; type: "requestOpenExternal"; url: string }
  | { version: number; type: "requestRunSimulation" }
  | { version: number; type: "requestPauseSimulation" }
  | { version: number; type: "requestStopSimulation" }
  | { version: number; type: "requestSaveProject" }
  | { version: number; type: "requestOpenProject" }
  /** Sai do modo de autoria com "Salvar Símbolo"/"Salvar Subcircuito" -- `components`/`wires` é a
   * sessão de autoria completa no momento do clique (não o circuito real, ver
   * `enterSymbolAuthoring`). A Extension compila isso num `PackageDescriptor`
   * (`extension.ts::compileSymbolAuthoringComponents`) e escreve de volta na chave certa
   * (`package`/`logicSymbolPackage`, conforme `view`) do `filePath` original -- pra
   * `subcircuit-file`, TAMBÉM compila e grava `components[]`/`wires[]`/`interface[]` reais
   * (`compileSubcircuitInternalComponents`), preservando todas as outras chaves do manifesto. */
  | { version: number; type: "requestSaveSymbol"; filePath: string; typeId: string; kind: SymbolAuthoringKind; view: "default" | "logicSymbol"; components: WebviewComponentModel[]; wires: WebviewWireModel[] }
  /** Botão direito numa instância JÁ COLOCADA no circuito -- "Editar Símbolo Visual"/"Abrir
   * Subcircuito" no menu de contexto (`main.ts`, mesmo princípio do "Open Subcircuit" do SimulIDE).
   * `sourceId` é o mesmo `RegisteredSource.id` que o botão "✎" da paleta já usa -- reaproveita
   * `extension.ts::editPackageSymbolCommand` tal qual, só com outro ponto de entrada. */
  | { version: number; type: "requestEditSymbol"; sourceId: string }
  | { version: number; type: "requestChooseMcuFirmware"; componentId: string }
  | { version: number; type: "requestReloadMcuFirmware"; componentId: string }
  | { version: number; type: "requestOpenMcuSerialMonitor"; componentId: string; usartIndex: 0 | 1 | 2 }
  /** Mesmas ações do MCU de topo, mas disparadas a partir do submenu de um componente INTERNO
   * exposto de um subcircuito no esquemático principal. `outerComponentId` é a instância do
   * subcircuito colocada no circuito; `innerComponentId` é o id local salvo no `.lssub.json`
   * (ex: "mcu1"). O host resolve isso para a instância real do filho no Core. */
  | { version: number; type: "requestChooseExposedMcuFirmware"; outerComponentId: string; innerComponentId: string }
  | { version: number; type: "requestReloadExposedMcuFirmware"; outerComponentId: string; innerComponentId: string }
  | { version: number; type: "requestOpenExposedMcuSerialMonitor"; outerComponentId: string; innerComponentId: string; usartIndex: 0 | 1 | 2 }
  /** Toggle "Ver: Físico / Símbolo Lógico" na barra da sessão de autoria -- descarta sem salvar a
   * vista atual (mesmo aviso já mostrado na UI, ver `main.ts::toggleLogicSymbolView`) e reabre a
   * sessão semeada a partir da OUTRA chave (`package`/`logicSymbolPackage`), preservando o circuito
   * interno (`internalComponents`/`internalWires`, não relidos do disco -- só o `package` troca). */
  | {
      version: number;
      type: "requestSwitchSymbolView";
      filePath: string;
      typeId: string;
      kind: SymbolAuthoringKind;
      toView: "default" | "logicSymbol";
      internalComponents: WebviewComponentModel[];
      internalWires: WebviewWireModel[];
    }
  /** "Exportar Dados" da janela "Expande" do osciloscópio/analisador lógico -- o CSV já vem PRONTO
   * (formatado em main.ts, que é quem tem o histórico/configuração de canais) pra extension.ts só
   * abrir `showSaveDialog`/escrever o arquivo, sem precisar conhecer o formato do instrumento. */
  | { version: number; type: "requestExportInstrumentData"; suggestedFileName: string; csvContent: string }
  /** Pedido de histórico REAL pra janela "Expande" -- ver `InstrumentHistoryPayload`. Mandado ao
   * abrir a janela e a cada `componentReadout` enquanto ela continuar aberta (mesmo ritmo de
   * atualização do resto da telemetria, ~300ms, ver `pollInstrumentReadouts`). */
  | { version: number; type: "requestInstrumentHistory"; componentId: string }
  /** "Carregar pacote" do menu de contexto -- abre um arquivo JSON escolhido pelo usuário e aplica
   * como `package` do `sourceId` (mesmo formato gravado por `requestSavePackage`). Reaproveita
   * `editPackageSymbolCommand` internamente pra abrir a sessão de edição já com esse conteúdo. */
  | { version: number; type: "requestLoadPackage"; sourceId: string }
  /** "Salvar pacote" -- exporta só a chave `package` do `.lssub.json`/`device.json`/`mcu.json` do
   * `sourceId` pra um arquivo `.pkg.json` separado escolhido pelo usuário (formato espelha
   * `PackageDescriptor`, mesmo schema usado internamente). */
  | { version: number; type: "requestSavePackage"; sourceId: string }
  /** Pedido de dados pro overlay de Modo Placa E pro submenu por componente exposto do menu de
   * contexto -- ver `boardOverlayData`. "Exposto" é marcado/desmarcado DENTRO da sessão "Abrir
   * Subcircuito" (menu de contexto de cada componente interno, ver `main.ts::renderComponent`) e
   * persiste via "Salvar Subcircuito" (`requestSaveSymbol`/`compileSubcircuitInternalComponents`),
   * não por uma mensagem dedicada daqui de fora. */
  | { version: number; type: "requestBoardOverlayData"; componentId: string; sourceId: string }
  /** Arrastar um componente do overlay de Modo Placa direto no circuito principal -- grava
   * `boardVisual` em `components[]` do `.lssub.json` (`sourceId`), mesmo campo que "Abrir
   * Subcircuito"/Modo Placa interno já usa (`compileSubcircuitInternalComponents`), só que editado
   * SEM precisar entrar na sessão de edição. `x`/`y` já vêm RELATIVOS à instância (não posição de
   * tela). */
  | { version: number; type: "requestUpdateBoardOverlayVisual"; sourceId: string; innerComponentId: string; x: number; y: number }
  /** Edita uma propriedade real de um componente INTERNO exposto sem entrar em "Open Subcircuit" --
   * usado pelo diálogo dedicado de propriedades do submenu externo. Persiste no `.lssub.json` e,
   * se a instância já estiver expandida no Core, tenta aplicar em runtime também. */
  | { version: number; type: "requestUpdateExposedComponentProperty"; outerComponentId: string; sourceId: string; innerComponentId: string; name: string; value: string | number | boolean }
  /** Clique num componente do overlay de Modo Placa no circuito principal -- `outerComponentId` é a
   * instância do subcircuito colocada no circuito do usuário, `innerComponentId` é o id LOCAL do
   * componente dentro do `.lssub.json` (ex: "button_en"). extension.ts traduz isso pro índice real
   * do componente Core dentro da instância expandida (ver `SimulationSession::
   * setSubcircuitChildProperty`, novo). */
  | { version: number; type: "requestUpdateBoardOverlayProperty"; outerComponentId: string; innerComponentId: string; name: string; value: string | number | boolean }
  /** Envia a seleção atual pro host pra criar um `.lssub.json` — disparado pelo item do menu de
   * contexto de multi-seleção OU pela resposta da Webview a `triggerCreateSubcircuitFromSelection`.
   * `componentIds`: IDs dos componentes selecionados. */
  | { version: number; type: "requestCreateSubcircuitFromSelection"; componentIds: string[] };

export function isHostMessage(value: unknown): value is HostToWebviewMessage {
  return typeof value === "object" && value !== null && "type" in value && "version" in value;
}

import { WebviewComponentModel, WebviewProjectState } from "./model";

export const WEBVIEW_MESSAGE_VERSION = 1 as const;

export type SimulationStatus = "stopped" | "running" | "paused";

export type HostToWebviewMessage =
  | { version: number; type: "init"; project: WebviewProjectState }
  | { version: number; type: "selectComponent"; componentId: string | null }
  | { version: number; type: "requestAddComponent"; typeId: string }
  | { version: number; type: "syncState"; project: WebviewProjectState }
  | { version: number; type: "componentReadout"; readoutsByComponentId: Record<string, number> }
  | { version: number; type: "wireVoltages"; voltagesByWireId: Record<string, number> }
  | { version: number; type: "simulationStatus"; status: SimulationStatus }
  /** Vem de `lasecsimul.rotateSelectionCw`/`Ccw` (`extension.ts`), disparado por keybinding do
   * VSCode com `when: activeWebviewPanelId == 'lasecsimul.schematic'` -- sobrepõe o `Ctrl+R`/
   * `Ctrl+Shift+R` nativo do VSCode SÓ enquanto o painel está em foco (`when` reverte sozinho ao
   * trocar de foco, sem lógica de restauração manual). A Webview não trata mais `Ctrl+R` no próprio
   * `keydown` -- esse é o caminho confiável agora, ver `.spec/lasecsimul.spec` seção 13.4. */
  | { version: number; type: "requestRotateSelection"; direction: "cw" | "ccw" }
  /** Mesmo caminho de `requestRotateSelection`, mas pra flip -- ver `lasecsimul.flipSelectionHorizontal`/
   * `Vertical` em `extension.ts`. */
  | { version: number; type: "requestFlipSelection"; axis: "horizontal" | "vertical" }
  /** Entra no modo de autoria de símbolo (Épico G, parte de escrita) -- ver `.spec/
   * lasecsimul-native-devices.spec` seção 21.3 e `docs/16-roadmap-pendencias-spec.md` Épico G:
   * mesmo princípio do SimulIDE real (`SubPackage`/`Rectangle`/`Ellipse`/.../`PackagePin` são
   * `Component`s comuns na MESMA cena do circuito, não um editor separado). `main.ts` troca
   * `state` por uma sessão nova semeada com `components` (um `other.package` + um `graphics.*` por
   * forma + um `other.package_pin` por pino, todos reconstruídos a partir do `package` atual do
   * manifesto pela Extension, ver `extension.ts::seedSymbolAuthoringComponents`) -- o circuito real
   * do usuário (se houver um aberto) nunca é tocado, só fica "escondido" até "Salvar Símbolo"/
   * "Cancelar" devolver `state` pro original. */
  | {
      version: number;
      type: "enterSymbolAuthoring";
      filePath: string;
      typeId: string;
      components: WebviewComponentModel[];
    };

export type WebviewToHostMessage =
  | { version: number; type: "webviewReady" }
  | { version: number; type: "projectChanged"; project: WebviewProjectState }
  | { version: number; type: "requestAddComponent"; typeId: string }
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
  | { version: number; type: "requestRunSimulation" }
  | { version: number; type: "requestPauseSimulation" }
  | { version: number; type: "requestStopSimulation" }
  | { version: number; type: "requestSaveProject" }
  | { version: number; type: "requestOpenProject" }
  /** Sai do modo de autoria com "Salvar Símbolo" -- `components` é a sessão de autoria completa no
   * momento do clique (não o circuito real, ver `enterSymbolAuthoring`). A Extension compila isso
   * num `PackageDescriptor` (`extension.ts::compileSymbolAuthoringComponents`) e escreve de volta no
   * `package` do `filePath` original, preservando todas as outras chaves do manifesto. */
  | { version: number; type: "requestSaveSymbol"; filePath: string; typeId: string; components: WebviewComponentModel[] };

export function isHostMessage(value: unknown): value is HostToWebviewMessage {
  return typeof value === "object" && value !== null && "type" in value && "version" in value;
}

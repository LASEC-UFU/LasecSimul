import type { WebviewComponentCatalogEntry } from "../ui/webview/model";
import { HMI_SCREEN_TYPE_ID } from "../ui/webview/visualDocument";

/**
 * Ferramentas COLOCÁVEIS de Controle › Ferramentas que não são blocos do Core (`pinCount: 0`, logo
 * `shouldSyncComponentToCore` é falso por construção). Hoje: o botão "Tela HMI" (docs/62 §5), que
 * abre a tela (documento visual) associada pelo `screenId`. As ações de paleta SisoTools/Ident ficam
 * em `ComponentPaletteViewProvider` porque não colocam nada no circuito.
 */
const SCREEN_WIDTH = 176;
const SCREEN_HEIGHT = 64;

export const HMI_SCREEN_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v3M8 20h8"/><path d="M6 13l3-3 2.5 2 4-5 2.5 2"/></svg>';

export const hmiScreenCatalogEntry: WebviewComponentCatalogEntry = {
  typeId: HMI_SCREEN_TYPE_ID,
  label: "Tela HMI",
  category: "Ferramentas",
  folderPath: ["Ferramentas"],
  workspaceSection: "control",
  icon: "package",
  iconSvgInline: HMI_SCREEN_ICON_SVG,
  hidden: false,
  graphical: true,
  pinCount: 0,
  pinIds: [],
  defaultProperties: { title: "Tela HMI", screenId: "", width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
  propertySchema: [
    { id: "title", label: "Título da tela", group: "Componente", unit: "", editor: "text", default: "Tela HMI" },
    { id: "screenId", label: "Documento", group: "Componente", unit: "", editor: "display", default: "" },
  ],
  help: { description: "Abre uma Tela HMI do projeto: acoplada ao VS Code, numa janela flutuante ou em tela cheia. Duplo clique abre; com a simulação rodando, um clique basta." },
  package: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    border: false,
    background: { kind: "none" },
    dynamicLayout: { width: { prop: "width", fallback: SCREEN_WIDTH }, height: { prop: "height", fallback: SCREEN_HEIGHT } },
    pins: [],
    simulidePaint: {
      version: 1,
      bounds: { x: 0, y: 0, w: SCREEN_WIDTH, h: SCREEN_HEIGHT },
      aspect: "fixed",
      referenceSize: { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
      defaultStroke: "currentColor",
      defaultFill: "none",
      defaultStrokeWidth: 1.5,
      primitives: [
        { kind: "roundedRect", x: 2, y: 2, w: SCREEN_WIDTH - 4, h: SCREEN_HEIGHT - 4, rx: 8, ry: 8, fill: "#0b1f3a", stroke: "#2563eb", strokeWidth: 1.5 },
        { kind: "rect", x: 12, y: 14, w: 38, h: 26, rx: 2, ry: 2, fill: "#10294d", stroke: "#93c5fd", strokeWidth: 1.4 },
        { kind: "polyline", points: [{ x: 15, y: 34 }, { x: 22, y: 27 }, { x: 28, y: 31 }, { x: 36, y: 20 }, { x: 47, y: 25 }], stroke: "#38bdf8", strokeWidth: 1.6 },
        { kind: "line", x1: 31, y1: 40, x2: 31, y2: 46, stroke: "#93c5fd", strokeWidth: 1.4 },
        { kind: "line", x1: 22, y1: 48, x2: 40, y2: 48, stroke: "#93c5fd", strokeWidth: 1.6 },
        {
          kind: "text", x: 60, y: 30, value: "", fontSize: 14, maxWidth: SCREEN_WIDTH - 82, textAnchor: "start", fill: "#f8fafc", fontWeight: 600,
          stateText: { kind: "property", prop: "title" },
        },
        { kind: "text", x: 60, y: 48, value: "Tela HMI", fontSize: 10, textAnchor: "start", fill: "#93c5fd" },
        {
          kind: "ellipse", cx: SCREEN_WIDTH - 16, cy: 15, rx: 5, ry: 5, strokeWidth: 1, stroke: "#0b1f3a",
          stateFill: { prop: "__screen_state", map: { closed: "#475569", docked: "#22c55e", floating: "#38bdf8", fullscreen: "#f59e0b" }, fallback: "#475569" },
        },
      ],
    },
  },
};

export const toolsCatalog: WebviewComponentCatalogEntry[] = [hmiScreenCatalogEntry];

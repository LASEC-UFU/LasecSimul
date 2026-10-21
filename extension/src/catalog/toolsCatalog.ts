import type { WebviewComponentCatalogEntry } from "../ui/webview/model";
import { HMI_SCREEN_TYPE_ID, HMI_3D_SCREEN_TYPE_ID } from "../ui/webview/visualDocument";

/**
 * Ferramentas COLOCÁVEIS de Miscelâneos › HMI que não são blocos do Core (`pinCount: 0`, logo
 * `shouldSyncComponentToCore` é falso por construção). O botão HMI 2D continua com seu ID estável.
 * abre a tela (documento visual) associada pelo `screenId`. As ações de paleta SisoTools/Ident ficam
 * em `ComponentPaletteViewProvider` porque não colocam nada no circuito.
 */
const SCREEN_WIDTH = 176;
const SCREEN_HEIGHT = 64;

export const HMI_SCREEN_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v3M8 20h8"/><path d="M6 13l3-3 2.5 2 4-5 2.5 2"/></svg>';

export const hmiScreenCatalogEntry: WebviewComponentCatalogEntry = {
  typeId: HMI_SCREEN_TYPE_ID,
  label: "Tela HMI 2D",
  category: "HMI",
  folderPath: ["HMI"],
  workspaceSection: "misc",
  icon: "package",
  iconSvgInline: HMI_SCREEN_ICON_SVG,
  hidden: false,
  graphical: true,
  pinCount: 0,
  pinIds: [],
  defaultProperties: { title: "Tela HMI 2D", screenId: "", width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
  propertySchema: [
    { id: "title", label: "Título da tela", group: "Componente", unit: "", editor: "text", default: "Tela HMI 2D" },
    { id: "screenId", label: "Documento", group: "Componente", unit: "", editor: "display", default: "" },
  ],
  help: { description: "Tela HMI 2D do projeto. Duplo clique abre o editor/operação; a tela pode ser acoplada, desacoplada para outro monitor ou maximizada." },
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
        { kind: "text", x: 60, y: 48, value: "Tela HMI 2D", fontSize: 10, textAnchor: "start", fill: "#93c5fd" },
        {
          kind: "ellipse", cx: SCREEN_WIDTH - 16, cy: 15, rx: 5, ry: 5, strokeWidth: 1, stroke: "#0b1f3a",
          stateFill: { prop: "__screen_state", map: { closed: "#475569", docked: "#22c55e", floating: "#38bdf8", fullscreen: "#f59e0b" }, fallback: "#475569" },
        },
      ],
    },
  },
};

const hmi3dWidth = 176;
const hmi3dHeight = 64;
const hmi3dScreenCatalogEntry: WebviewComponentCatalogEntry = {
  typeId: HMI_3D_SCREEN_TYPE_ID,
  label: "Tela HMI 3D",
  category: "HMI",
  folderPath: ["HMI"],
  workspaceSection: "misc",
  icon: "package",
  iconSvgInline: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 2 9 5v10l-9 5-9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10M7.5 4.5l9 5"/></svg>',
  hidden: false,
  graphical: true,
  pinCount: 0,
  pinIds: [],
  defaultProperties: { title: "Tela HMI 3D", width: hmi3dWidth, height: hmi3dHeight },
  propertySchema: [{ id: "title", label: "Título da tela", group: "Componente", unit: "", editor: "text", default: "Tela HMI 3D" }],
  help: { description: "Tela 3D do projeto. Duplo clique abre a cena 3D associada a este componente." },
  package: {
    width: hmi3dWidth, height: hmi3dHeight, border: false,
    background: { kind: "none" },
    dynamicLayout: { width: { prop: "width", fallback: hmi3dWidth }, height: { prop: "height", fallback: hmi3dHeight } },
    pins: [],
    simulidePaint: {
      version: 1,
      bounds: { x: 0, y: 0, w: hmi3dWidth, h: hmi3dHeight },
      aspect: "fixed", referenceSize: { width: hmi3dWidth, height: hmi3dHeight },
      defaultStroke: "currentColor", defaultFill: "none", defaultStrokeWidth: 1.5,
      primitives: [
        { kind: "roundedRect", x: 2, y: 2, w: hmi3dWidth - 4, h: hmi3dHeight - 4, rx: 8, ry: 8, fill: "#101820", stroke: "#0ea5e9", strokeWidth: 1.5 },
        { kind: "polygon", points: [{ x: 31, y: 13 }, { x: 45, y: 21 }, { x: 31, y: 29 }, { x: 17, y: 21 }], fill: "#38bdf8", stroke: "#e0f2fe", strokeWidth: 1 },
        { kind: "polygon", points: [{ x: 17, y: 21 }, { x: 31, y: 29 }, { x: 31, y: 45 }, { x: 17, y: 37 }], fill: "#0369a1", stroke: "#e0f2fe", strokeWidth: 1 },
        { kind: "polygon", points: [{ x: 45, y: 21 }, { x: 31, y: 29 }, { x: 31, y: 45 }, { x: 45, y: 37 }], fill: "#0c4a6e", stroke: "#e0f2fe", strokeWidth: 1 },
        { kind: "text", x: 58, y: 30, value: "", fontSize: 14, maxWidth: hmi3dWidth - 78, textAnchor: "start", fill: "#f8fafc", fontWeight: 600, stateText: { kind: "property", prop: "title" } },
        { kind: "text", x: 58, y: 48, value: "Tela HMI 3D", fontSize: 10, textAnchor: "start", fill: "#7dd3fc" },
      ],
    },
  },
};

export const toolsCatalog: WebviewComponentCatalogEntry[] = [hmiScreenCatalogEntry, hmi3dScreenCatalogEntry];

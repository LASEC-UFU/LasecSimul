/**
 * Documento visual (docs/62 §4, ADR 0017): a Tela HMI é um documento próprio do projeto, inserido no
 * esquemático por um botão `tools.hmi_screen` (paleta Controle › Ferramentas) e aberto num Painel
 * Visual que pode ficar acoplado ao VS Code, flutuar numa janela própria ou ocupar a tela cheia.
 *
 * O documento é um SUPERCONJUNTO de `HmiApplication`: páginas, elementos, navegação, STALE e
 * auditoria continuam com o mesmo formato, para que o motor de cena que já edita/opera a HMI
 * (`main.ts`) trabalhe sobre ele sem um segundo editor. Tudo aqui é puro (sem `vscode`/Node): usado
 * pela Webview e pelo Host.
 */
import type { HmiApplication, HmiPage } from "./model.js";

export const HMI_SCREEN_TYPE_ID = "tools.hmi_screen";
export const VISUAL_DOCUMENT_SCHEMA_VERSION = 1 as const;

/** Casca de apresentação (docs/62 §7): editor/operação da HMI ou a organização do Laboratório de Cálculo. */
export type PresentationContext = "hmi" | "lab";
/** Contexto adotado ao entrar em tela cheia: o pedido original é o Laboratório; "keep" não troca. */
export type FullscreenContextPolicy = "lab" | "hmi" | "keep";

export interface VisualPresentation {
  fullscreenContext: FullscreenContextPolicy;
  /** Contexto em que a tela abre pela primeira vez (padrão `hmi`; telas do Laboratório: `lab`). */
  defaultContext?: PresentationContext;
  /** Abre direto em operação (telas do Laboratório: a aula começa no modo aluno). */
  startInOperation?: boolean;
}

export interface VisualDocument extends HmiApplication {
  schemaVersion: typeof VISUAL_DOCUMENT_SCHEMA_VERSION;
  /** Identidade estável: `properties.screenId` do botão (tela) ou `faceplate:<typeId do subsistema>`. */
  id: string;
  /** `screen`: Tela HMI do projeto. `faceplate`: painel de operação de um subsistema interno (docs/62 §8),
   * um documento da DEFINIÇÃO aberto no contexto de cada instância (caminhos relativos à instância). */
  kind: "screen" | "faceplate";
  title: string;
  presentation: VisualPresentation;
}

const FACEPLATE_PREFIX = "faceplate:";

/**
 * Ligações de um elemento colado noutro contexto (docs/62 §13.1, `VisualClipboard`): o id `interno` de
 * um Faceplate aberto na instância X vira o caminho `X:interno` numa Tela HMI; `Y:interno` de uma tela
 * vira `interno` no Faceplate da instância Y. Entre Faceplates (ids relativos) e entre telas nada muda.
 */
export function remapBindingPaths<T extends Record<string, unknown>>(properties: T, fromInstance: string | undefined, toInstance: string | undefined): T {
  const next: Record<string, unknown> = { ...properties };
  for (const key of ["bindSource", "bindSourceB", "bindSourceC"]) {
    const value = next[key];
    if (typeof value !== "string" || !value) continue;
    if (fromInstance && !toInstance && !value.includes(":")) next[key] = `${fromInstance}:${value}`;
    else if (!fromInstance && toInstance && value.startsWith(`${toInstance}:`)) next[key] = value.slice(toInstance.length + 1);
  }
  return next as T;
}

/** Documento do Faceplate de um subsistema interno: um por definição, compartilhado pelas instâncias. */
export function faceplateDocumentId(subsystemTypeId: string): string {
  return `${FACEPLATE_PREFIX}${subsystemTypeId}`;
}

export function subsystemTypeIdOfFaceplate(documentId: string): string | undefined {
  return documentId.startsWith(FACEPLATE_PREFIX) ? documentId.slice(FACEPLATE_PREFIX.length) : undefined;
}

/** Faceplate novo: uma página 960×540 com o nome do subsistema; os elementos ligam-se aos componentes
 * internos por id (o mesmo id em todas as instâncias). */
export function createFaceplateDocument(subsystemTypeId: string, name: string): VisualDocument {
  const id = faceplateDocumentId(subsystemTypeId);
  const pageId = "faceplate-operacao";
  return {
    schemaVersion: VISUAL_DOCUMENT_SCHEMA_VERSION,
    id,
    kind: "faceplate",
    title: name,
    presentation: { fullscreenContext: "hmi" },
    startPageId: pageId,
    pages: [{ id: pageId, name: "Operação", width: 960, height: 540, elements: [] }],
  };
}

/** Onde a tela está agora (docs/61 §5): desenhado como indicador no botão do esquemático. */
export type ScreenViewState = "closed" | "docked" | "floating" | "fullscreen";
export type DockingState = "docked" | "undocked";
export type WindowState = "normal" | "maximized" | "fullscreen";

/** Geometria reportada pela Webview (docs/61 §6.3): é a única fonte do estado da janela do SO. */
export interface WebviewGeometry {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  screen: { width: number; height: number; availWidth: number; availHeight: number; availLeft: number; availTop: number };
}

/** Estado de uma vista (Painel Visual) que sobrevive à recriação da Webview (troca de janela). */
export interface VisualSession {
  pageId?: string;
  viewport?: { x: number; y: number; zoom: number };
  editing: boolean;
  context: PresentationContext;
  /** Modo Apresentação das atividades do Laboratório (letras maiores, casca `lab`). */
  labPresentation?: boolean;
}

/** O que o Host diz à vista sobre a janela dela (o menu de contexto mostra só o que se aplica). */
export interface VisualWindowInfo {
  docking: DockingState;
  window: WindowState;
  /** Comandos de janela do workbench disponíveis nesta versão do VS Code (feature detection). */
  canUndock: boolean;
  canFullscreen: boolean;
  /** A simulação do projeto está suspensa porque um modelo interno de subsistema está em edição. */
  projectSimulationSuspended?: boolean;
}

export const DEFAULT_SCREEN_PAGE_SIZE = { width: 1920, height: 1080 } as const;

export function defaultScreenPage(id: string, name = "Página 1"): HmiPage {
  return { id, name, width: DEFAULT_SCREEN_PAGE_SIZE.width, height: DEFAULT_SCREEN_PAGE_SIZE.height, elements: [], navigation: [] };
}

export function createScreenDocument(id: string, title: string): VisualDocument {
  const pageId = `${id}-pagina-1`;
  return {
    schemaVersion: VISUAL_DOCUMENT_SCHEMA_VERSION,
    id,
    kind: "screen",
    title,
    presentation: { fullscreenContext: "lab" },
    startPageId: pageId,
    pages: [defaultScreenPage(pageId)],
  };
}

/** `tela-1`, `tela-2`… (ids estáveis e legíveis, nunca reaproveitados enquanto existirem). */
export function uniqueScreenId(taken: ReadonlySet<string>, base = "tela"): string {
  const root = base.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "tela";
  for (let index = 1; ; index += 1) {
    const candidate = `${root}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Título único entre as telas do projeto ("Tela HMI", "Tela HMI (2)"…). */
export function uniqueScreenTitle(title: string, taken: ReadonlySet<string>): string {
  const base = title.trim() || "Tela HMI";
  if (!taken.has(base)) return base;
  const stripped = base.replace(/ \(\d+\)$/, "");
  for (let index = 2; ; index += 1) {
    const candidate = `${stripped} (${index})`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function screenIdOf(component: { typeId?: string; properties?: Record<string, unknown> } | undefined): string | undefined {
  if (!component || component.typeId !== HMI_SCREEN_TYPE_ID) return undefined;
  const value = component.properties?.screenId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Cópia independente (novos ids de documento e de páginas, elementos preservados). */
export function duplicateScreenDocument(source: VisualDocument, id: string, title: string): VisualDocument {
  const pageIdMap = new Map(source.pages.map((page, index) => [page.id, `${id}-pagina-${index + 1}`]));
  const pages = source.pages.map((page) => ({
    ...structuredClone(page),
    id: pageIdMap.get(page.id)!,
    elements: page.elements.map((element) => ({ ...structuredClone(element), id: `${id}-${element.id}` })),
    navigation: page.navigation?.map((item) => ({ ...item, id: `${id}-${item.id}`, targetPageId: pageIdMap.get(item.targetPageId) ?? item.targetPageId })),
  }));
  return {
    ...structuredClone(source),
    id,
    title,
    pages,
    startPageId: pageIdMap.get(source.startPageId) ?? pages[0]!.id,
    auditExceptions: undefined,
  };
}

/** Classificação da janela pela geometria (docs/61 §6.3, regras medidas no experimento da PoC):
 * `inner*` contra `screen.*` porque, em tela cheia vinda de maximizada, o Windows reporta `outer`
 * deslocado em 8 px; a faixa de título compacta restante (≤ 32 px) ainda conta como tela cheia. */
export function classifyWindowState(geometry: WebviewGeometry): WindowState {
  const { screen } = geometry;
  const outerCoversScreen = geometry.outerWidth >= screen.width && geometry.outerHeight >= screen.height;
  const innerCoversScreen = geometry.innerWidth >= screen.width && geometry.innerHeight >= screen.height - 32;
  if (outerCoversScreen || innerCoversScreen) return "fullscreen";
  const maximized = Math.abs(geometry.outerWidth - screen.availWidth) <= 20 && Math.abs(geometry.outerHeight - screen.availHeight) <= 20;
  return maximized ? "maximized" : "normal";
}

/** A vista está numa janela diferente da principal? Compara com a geometria da janela principal
 * (reportada pela paleta lateral, que sempre vive nela). */
export function isOtherWindow(view: WebviewGeometry, main: WebviewGeometry | undefined): boolean {
  if (!main) return false;
  return view.screenX !== main.screenX || view.screenY !== main.screenY || view.outerWidth !== main.outerWidth || view.outerHeight !== main.outerHeight;
}

import { buildPaletteTree, PaletteComponentNode, PaletteRenderableEntry, PaletteTreeNode } from "./paletteTree.js";
import { normalizeWorkspaceSelection, WORKSPACE_SECTION_ORDER, WorkspaceSection } from "./workspace.js";
import { watchWebviewGeometry } from "./windowGeometry.js";

interface PaletteState {
  catalog: PaletteRenderableEntry[];
  language: "pt-BR" | "en";
}

interface WindowWithPaletteState extends Window {
  __LASECSIMUL_PALETTE_STATE__?: PaletteState;
}

declare const acquireVsCodeApi: undefined | (() => { postMessage(message: unknown): void; setState(state: unknown): void; getState(): unknown });

const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const app = document.getElementById("app");

const injectedInitialState = (window as WindowWithPaletteState).__LASECSIMUL_PALETTE_STATE__;
const initialState: PaletteState = injectedInitialState ?? {
  catalog: [],
  language: "pt-BR" as const,
};
const persisted = (vscode?.getState() as { query?: string; section?: unknown } | undefined) ?? {};

let state: PaletteState = initialState;
let query = persisted.query ?? "";
/** Aba ativa da paleta -- filtra o catalogo por dominio (Analogico/Digital/Controle/Miscelaneos).
 * Estado puramente local da paleta (nunca compartilhado com o editor, ver FEAT-011): o editor mostra
 * o circuito inteiro sempre, essas abas so existem aqui pra organizar a busca por componente.
 * `normalizeWorkspaceSelection` aceita o que qualquer versao gravou -- inclusive `"process"`, a aba
 * Processo removida, que volta como Controle. */
let section: WorkspaceSection = normalizeWorkspaceSelection(persisted.section).section;

function persistNavigationState(): void {
  vscode?.setState({ query, section });
}

// Regrava ja migrado (ex.: `"process"` -> `"control"`) para o estado antigo nao ser relido a cada abertura.
if (persisted.section !== undefined && persisted.section !== section) persistNavigationState();

const UI_TEXT = {
  "pt-BR": {
    searchPlaceholder: "Search Components",
    unavailable: "indisponivel",
    visual: "visual",
    pinSingular: "pino",
    pinPlural: "pinos",
    noResults: "Nenhum componente encontrado para este filtro.",
    removeRegistered: "Remover item registrado",
    addHint: "Clique para adicionar",
    workspaceAnalog: "Analógico",
    workspaceDigital: "Digital",
    workspaceControl: "Controle",
    workspaceMisc: "Miscelâneos",
  },
  en: {
    searchPlaceholder: "Search Components",
    unavailable: "unavailable",
    visual: "visual",
    pinSingular: "pin",
    pinPlural: "pins",
    noResults: "No components match this filter.",
    removeRegistered: "Remove registered item",
    addHint: "Click to add",
    workspaceAnalog: "Analog",
    workspaceDigital: "Digital",
    workspaceControl: "Control",
    workspaceMisc: "Miscellaneous",
  },
} as const;

const WORKSPACE_SECTION_LABEL_KEY: Record<WorkspaceSection, keyof typeof UI_TEXT["pt-BR"]> = {
  analog: "workspaceAnalog",
  digital: "workspaceDigital",
  control: "workspaceControl",
  misc: "workspaceMisc",
};

function t(key: keyof typeof UI_TEXT["pt-BR"]): string {
  return UI_TEXT[state.language][key];
}

function isDarkTheme(): boolean {
  return document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
}

function currentIcon(node: PaletteComponentNode): string | undefined {
  return isDarkTheme() ? (node.iconDarkUri ?? node.iconLightUri) : (node.iconLightUri ?? node.iconDarkUri);
}

const SVG_NS = "http://www.w3.org/2000/svg";

function renderWorkspaceTabIcon(tabSection: WorkspaceSection): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("palette-tabs__icon");

  switch (tabSection) {
    case "analog":
      svg.innerHTML = '<path d="M2 16c3-12 7-12 10 0s7 12 10-8"></path>';
      break;
    case "digital":
      svg.innerHTML = '<path d="M2 16h4V8h4v8h4V8h4v8h4"></path>';
      break;
    // Controle: resposta ao degrau com overshoot assentando no setpoint (tracejado) -- o par
    // Analogico(senoide)/Digital(onda quadrada) ja usa a forma de onda como identidade da aba, e
    // esta segue a mesma linguagem em vez de um simbolo generico (seta circular), que nao dizia
    // nada sobre malha de controle.
    case "control":
      svg.innerHTML = '<path d="M3 9h18" stroke-dasharray="2.5 2.5" opacity="0.6"></path><path d="M3 19h3c3 0 2-15 6-15 3 0 2 9 5 9h4"></path>';
      break;
    case "misc":
      svg.innerHTML = '<circle cx="5" cy="12" r="1.8" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"></circle><circle cx="19" cy="12" r="1.8" fill="currentColor" stroke="none"></circle>';
      break;
  }

  return svg;
}

function workspaceTabButton(tabSection: WorkspaceSection, active: boolean): HTMLButtonElement {
  const label = t(WORKSPACE_SECTION_LABEL_KEY[tabSection]);
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "tab");
  button.className = `palette-tabs__button${active ? " palette-tabs__button--active" : ""}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-selected", String(active));
  button.tabIndex = active ? 0 : -1;
  button.appendChild(renderWorkspaceTabIcon(tabSection));
  button.addEventListener("click", () => {
    if (tabSection === section) return;
    section = tabSection;
    persistNavigationState();
    render();
  });
  return button;
}

/** Setas movem foco+seleção entre as abas (padrão `role="tablist"`), com wrap nas pontas. */
function handleWorkspaceTabsKeydown(event: KeyboardEvent, navigation: HTMLElement): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const currentIndex = WORKSPACE_SECTION_ORDER.indexOf(section);
  const delta = event.key === "ArrowRight" ? 1 : -1;
  const nextIndex = (currentIndex + delta + WORKSPACE_SECTION_ORDER.length) % WORKSPACE_SECTION_ORDER.length;
  const nextSection = WORKSPACE_SECTION_ORDER[nextIndex];
  if (!nextSection || nextSection === section) return;
  event.preventDefault();
  section = nextSection;
  persistNavigationState();
  render();
  (app?.querySelector(".palette-tabs [aria-selected=\"true\"]") as HTMLElement | null)?.focus();
}

function renderWorkspaceTabs(): HTMLElement {
  const navigation = document.createElement("nav");
  navigation.className = "palette-tabs";
  navigation.setAttribute("role", "tablist");
  navigation.setAttribute("aria-label", "Workspace");
  navigation.addEventListener("keydown", (event) => handleWorkspaceTabsKeydown(event, navigation));

  const row = document.createElement("div");
  row.className = "palette-tabs__row";
  for (const tabSection of WORKSPACE_SECTION_ORDER) {
    row.appendChild(workspaceTabButton(tabSection, section === tabSection));
  }
  navigation.appendChild(row);
  return navigation;
}

function pinCountLabel(count: number): string {
  return `${count} ${count === 1 ? t("pinSingular") : t("pinPlural")}`;
}

function collectVisibleComponents(nodes: PaletteTreeNode[]): PaletteComponentNode[] {
  const items: PaletteComponentNode[] = [];
  for (const node of nodes) {
    if (node.kind === "component") {
      items.push(node);
      continue;
    }
    items.push(...collectVisibleComponents(node.children));
  }
  return items;
}

const PALETTE_INDENT_STEP_PX = 12;

function renderTreeNode(node: PaletteTreeNode, depth: number): HTMLElement {
  const indent = `${depth * PALETTE_INDENT_STEP_PX}px`;
  if (node.kind === "folder") {
    const details = document.createElement("details");
    details.className = `palette-folder${depth === 0 ? " palette-folder--depth-0" : ""}`;
    details.style.setProperty("--palette-indent", indent);
    // Com busca ativa, toda pasta com resultado abre: o item achado nunca fica escondido numa subpasta.
    details.open = depth === 0 || query.trim().length > 0;

    const summary = document.createElement("summary");
    summary.className = "palette-folder__summary";
    const caret = document.createElement("span");
    caret.className = "palette-folder__caret";
    caret.textContent = ">";
    const text = document.createElement("span");
    text.textContent = node.label;
    summary.append(caret, text);
    details.appendChild(summary);

    const children = document.createElement("div");
    children.className = "palette-folder__children";
    for (const child of node.children) {
      children.appendChild(renderTreeNode(child, depth + 1));
    }
    details.appendChild(children);
    return details;
  }

  const rowTag = node.disabled ? "div" : "button";
  const row = document.createElement(rowTag);
  row.className = `palette-item${node.disabled ? " palette-item--disabled" : " palette-item--button"}`;
  row.dataset.typeId = node.typeId;
  row.style.setProperty("--palette-indent", indent);
  if (!node.disabled) {
    row.setAttribute("type", "button");
    row.addEventListener("click", () => vscode?.postMessage(node.paletteActionCommand
      ? { type: "runPaletteAction", command: node.paletteActionCommand }
      : { type: "startPlacingComponent", typeId: node.typeId }));
  }

  const icon = document.createElement("img");
  icon.className = "palette-item__icon";
  const iconSrc = currentIcon(node);
  if (iconSrc) icon.src = iconSrc;
  icon.alt = "";

  const text = document.createElement("div");
  text.className = "palette-item__text";
  const label = document.createElement("div");
  label.className = "palette-item__label";
  label.textContent = node.label;
  const meta = document.createElement("div");
  meta.className = "palette-item__meta";
  meta.textContent = node.paletteActionCommand ? "Abrir ferramenta" : node.disabled ? (node.disabledReason ?? t("unavailable")) : node.pinCount === 0 ? t("visual") : pinCountLabel(node.pinCount);
  text.append(label, meta);

  row.title = node.typeId === "action.ident"
    ? "Identificar modelos dinâmicos a partir de dados de entrada e saída"
    : node.disabled
    ? `${node.typeId}\n${node.pathSegments.join(" > ")}\n${node.disabledReason ?? t("unavailable")}`
    : node.paletteActionCommand ? "Abrir o ambiente de projeto e análise de controladores" : `${node.typeId}\n${node.pathSegments.join(" > ")}\n${t("addHint")}`;

  row.append(icon, text);

  if (node.isRegistered && node.registeredSourceRemovable && node.registeredSourceId) {
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "palette-item__remove";
    removeButton.title = t("removeRegistered");
    removeButton.textContent = "x";
    removeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      vscode?.postMessage({ type: "removeRegistered", sourceId: node.registeredSourceId });
    });
    row.appendChild(removeButton);
  }

  return row;
}

function render(): void {
  if (!app) return;
  const activeElement = document.activeElement;
  const shouldRestoreSearchFocus = activeElement instanceof HTMLInputElement && activeElement.classList.contains("palette__search-input");
  const selectionStart = shouldRestoreSearchFocus ? activeElement.selectionStart : null;
  const selectionEnd = shouldRestoreSearchFocus ? activeElement.selectionEnd : null;
  const tree = buildPaletteTree(state.catalog, query, section, state.language);
  const visibleComponents = collectVisibleComponents(tree).filter((node) => !node.disabled);
  app.innerHTML = "";

  const shell = document.createElement("section");
  shell.className = "palette";

  const tabs = renderWorkspaceTabs();

  const search = document.createElement("div");
  search.className = "palette__search";

  const input = document.createElement("input");
  input.className = "palette__search-input";
  input.type = "search";
  input.placeholder = t("searchPlaceholder");
  input.value = query;
  input.addEventListener("input", () => {
    query = input.value;
    persistNavigationState();
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && visibleComponents.length === 1) {
      event.preventDefault();
      const singleMatch = visibleComponents[0];
      if (singleMatch) vscode?.postMessage(singleMatch.paletteActionCommand
        ? { type: "runPaletteAction", command: singleMatch.paletteActionCommand }
        : { type: "startPlacingComponent", typeId: singleMatch.typeId });
    }
  });

  search.append(input);

  const treeRoot = document.createElement("div");
  treeRoot.className = "palette__tree";
  if (tree.length === 0) {
    const empty = document.createElement("p");
    empty.className = "palette__empty";
    empty.textContent = t("noResults");
    treeRoot.appendChild(empty);
  } else {
    for (const node of tree) {
      treeRoot.appendChild(renderTreeNode(node, 0));
    }
  }

  shell.append(tabs, search, treeRoot);
  app.appendChild(shell);

  if (shouldRestoreSearchFocus) {
    input.focus();
    if (selectionStart !== null && selectionEnd !== null) input.setSelectionRange(selectionStart, selectionEnd);
  }
}

window.addEventListener("message", (event: MessageEvent<{ type: string; state?: PaletteState }>) => {
  if (event.data?.type !== "sync" || !event.data.state) return;
  state = event.data.state;
  render();
});

render();
vscode?.postMessage({ type: "webviewReady" });

// A paleta lateral nunca sai da janela PRINCIPAL do VS Code: a geometria dela é a referência para
// saber se uma Tela HMI está acoplada ou numa janela flutuante (docs/61 §6.3).
watchWebviewGeometry((geometry) => vscode?.postMessage({ type: "windowGeometry", geometry }));

import { buildPaletteTree, PaletteComponentNode, PaletteRenderableEntry, PaletteTreeNode } from "./paletteTree.js";

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

const initialState = (window as WindowWithPaletteState).__LASECSIMUL_PALETTE_STATE__ ?? { catalog: [], language: "pt-BR" as const };
const persisted = (vscode?.getState() as { query?: string } | undefined) ?? {};

let state: PaletteState = initialState;
let query = persisted.query ?? "";

const UI_TEXT = {
  "pt-BR": {
    searchPlaceholder: "Search Components",
    clear: "Limpar busca",
    unavailable: "indisponivel",
    visual: "visual",
    noResults: "Nenhum componente encontrado para este filtro.",
    removeRegistered: "Remover item registrado",
    editSymbol: "Editar símbolo visual",
    addHint: "Clique para adicionar",
  },
  en: {
    searchPlaceholder: "Search Components",
    clear: "Clear search",
    unavailable: "unavailable",
    visual: "visual",
    noResults: "No components match this filter.",
    removeRegistered: "Remove registered item",
    editSymbol: "Edit visual symbol",
    addHint: "Click to add",
  },
} as const;

function t(key: keyof typeof UI_TEXT["pt-BR"]): string {
  return UI_TEXT[state.language][key];
}

function isDarkTheme(): boolean {
  return document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
}

function currentIcon(node: PaletteComponentNode): string | undefined {
  return isDarkTheme() ? (node.iconDarkUri ?? node.iconLightUri) : (node.iconLightUri ?? node.iconDarkUri);
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

function renderTreeNode(node: PaletteTreeNode, depth: number): HTMLElement {
  if (node.kind === "folder") {
    const details = document.createElement("details");
    details.className = `palette-folder palette-folder--depth-${Math.min(depth, 3)}`;
    details.open = true;

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
  row.className = `palette-item palette-item--depth-${Math.min(depth, 3)}${node.disabled ? " palette-item--disabled" : " palette-item--button"}`;
  if (!node.disabled) {
    row.setAttribute("type", "button");
    row.addEventListener("click", () => vscode?.postMessage({ type: "addComponent", typeId: node.typeId }));
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
  meta.textContent = node.disabled ? (node.disabledReason ?? t("unavailable")) : node.pinCount === 0 ? t("visual") : `${node.pinCount} pinos`;
  text.append(label, meta);

  row.title = node.disabled
    ? `${node.typeId}\n${node.pathSegments.join(" > ")}\n${node.disabledReason ?? t("unavailable")}`
    : `${node.typeId}\n${node.pathSegments.join(" > ")}\n${t("addHint")}`;

  row.append(icon, text);

  if (node.isRegistered && node.registeredSourceId) {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "palette-item__edit";
    editButton.title = t("editSymbol");
    editButton.textContent = "✎";
    editButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      vscode?.postMessage({ type: "editSymbol", sourceId: node.registeredSourceId });
    });
    row.appendChild(editButton);
  }

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
  const tree = buildPaletteTree(state.catalog, query);
  const visibleComponents = collectVisibleComponents(tree).filter((node) => !node.disabled);
  app.innerHTML = "";

  const shell = document.createElement("section");
  shell.className = "palette";

  const search = document.createElement("div");
  search.className = "palette__search";

  const input = document.createElement("input");
  input.className = "palette__search-input";
  input.type = "search";
  input.placeholder = t("searchPlaceholder");
  input.value = query;
  input.addEventListener("input", () => {
    query = input.value;
    vscode?.setState({ query });
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && visibleComponents.length === 1) {
      event.preventDefault();
      const singleMatch = visibleComponents[0];
      if (singleMatch) vscode?.postMessage({ type: "addComponent", typeId: singleMatch.typeId });
    }
  });

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "palette__clear";
  clearButton.title = t("clear");
  clearButton.textContent = "x";
  clearButton.disabled = query.length === 0;
  clearButton.addEventListener("click", () => {
    query = "";
    vscode?.setState({ query });
    render();
  });

  search.append(input, clearButton);

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

  shell.append(search, treeRoot);
  app.appendChild(shell);
}

window.addEventListener("message", (event: MessageEvent<{ type: string; state?: PaletteState }>) => {
  if (event.data?.type !== "sync" || !event.data.state) return;
  state = event.data.state;
  render();
});

render();
vscode?.postMessage({ type: "webviewReady" });

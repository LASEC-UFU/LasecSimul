import { WebviewComponentCatalogEntry } from "./model.js";
import { WorkspaceSection, workspaceSectionForCatalogEntry } from "./workspace.js";

export interface PaletteRenderableEntry extends WebviewComponentCatalogEntry {
  iconLightUri?: string;
  iconDarkUri?: string;
}

export interface PaletteFolderNode {
  kind: "folder";
  key: string;
  label: string;
  pathSegments: string[];
  children: PaletteTreeNode[];
}

export interface PaletteComponentNode {
  kind: "component";
  key: string;
  typeId: string;
  label: string;
  category: string;
  subcategory?: string;
  pinCount: number;
  disabled: boolean;
  disabledReason?: string;
  pathSegments: string[];
  iconLightUri?: string;
  iconDarkUri?: string;
  isRegistered: boolean;
  registeredSourceId?: string;
  registeredSourceRemovable: boolean;
}

export type PaletteTreeNode = PaletteFolderNode | PaletteComponentNode;

interface MutableFolderNode extends PaletteFolderNode {
  folderIndex: Map<string, MutableFolderNode>;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/** `folderPath: []` EXPLÍCITO é "sem pasta, componente direto na raiz da aba" -- distinto de
 * `folderPath` AUSENTE, que cai no fallback category/subcategory de sempre. Checar presença de
 * array (não tamanho) é o que preserva essa distinção -- ver `registeredSources.ts::resolveFolderPath`
 * pra a mesma regra do lado da resolução do manifesto. */
export function resolvePaletteFolderPath(entry: Pick<WebviewComponentCatalogEntry, "folderPath" | "category" | "subcategory">): string[] {
  if (Array.isArray(entry.folderPath)) {
    return entry.folderPath.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  }
  return [entry.category, ...(entry.subcategory ? [entry.subcategory] : [])].filter((segment) => segment.length > 0);
}

function entryMatchesQuery(entry: PaletteRenderableEntry, query: string): boolean {
  if (!query) return true;
  const haystack = normalizeSearchText(
    [
      entry.label,
      entry.typeId,
      entry.category,
      entry.subcategory,
      ...resolvePaletteFolderPath(entry),
    ]
      .filter(Boolean)
      .join(" ")
  );
  return query
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .every((token) => haystack.includes(token));
}

function createFolderNode(pathSegments: string[]): MutableFolderNode {
  return {
    kind: "folder",
    key: `folder:${pathSegments.join("/")}`,
    label: pathSegments[pathSegments.length - 1] ?? "",
    pathSegments,
    children: [],
    folderIndex: new Map<string, MutableFolderNode>(),
  };
}

function stripMutableNodes(nodes: Array<MutableFolderNode | PaletteComponentNode>): PaletteTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === "component") return node;
    return {
      kind: "folder",
      key: node.key,
      label: node.label,
      pathSegments: node.pathSegments,
      children: stripMutableNodes(node.children as Array<MutableFolderNode | PaletteComponentNode>),
    };
  });
}

/**
 * Sem isto, a ordem das pastas de topo dentro de uma aba é só a ordem de PRIMEIRA APARIÇÃO na
 * lista mesclada de catálogo (estático + devices/subcircuits registrados, ver
 * `catalogCommands.ts::refreshUnifiedCatalogState`) -- nunca alfabética nem configurável. Pastas
 * listadas aqui (nesta ordem) vêm sempre antes das demais dentro da mesma aba; a ordem relativa
 * de todo o resto permanece exatamente a de sempre (sort estável). Ausente == comportamento
 * legado, sem prioridade nenhuma.
 */
const ROOT_FOLDER_PRIORITY: Partial<Record<WorkspaceSection, readonly string[]>> = {
  analog: ["Microcontroladores"],
  // PLC-IEC, Protocolos Industriais, Modelos -- nesta ordem -- dentro de Processo.
  process: ["PLC IEC 61131-3", "Protocolos Industriais", "Modelos"],
};

function applyRootFolderPriority(
  roots: Array<MutableFolderNode | PaletteComponentNode>,
  workspaceSection: WorkspaceSection | undefined
): Array<MutableFolderNode | PaletteComponentNode> {
  const priority = workspaceSection ? ROOT_FOLDER_PRIORITY[workspaceSection] : undefined;
  if (!priority || priority.length === 0) return roots;
  const prioritized: Array<MutableFolderNode | PaletteComponentNode> = [];
  const rest: Array<MutableFolderNode | PaletteComponentNode> = [];
  for (const node of roots) {
    const isPriorityFolder = node.kind === "folder" && priority.includes(node.label);
    (isPriorityFolder ? prioritized : rest).push(node);
  }
  // Ordem relativa DENTRO do grupo priorizado segue `priority[]`; múltiplas pastas com o mesmo
  // nome nunca coexistem no mesmo nível (chave única por segmento, ver `createFolderNode`).
  prioritized.sort((a, b) => priority.indexOf(a.label) - priority.indexOf(b.label));
  return [...prioritized, ...rest];
}

export function buildPaletteTree(entries: PaletteRenderableEntry[], rawQuery: string, workspaceSection?: WorkspaceSection): PaletteTreeNode[] {
  const roots: Array<MutableFolderNode | PaletteComponentNode> = [];
  const rootFolders = new Map<string, MutableFolderNode>();
  const query = normalizeSearchText(rawQuery);

  for (const entry of entries) {
    if (entry.hidden || (workspaceSection && workspaceSectionForCatalogEntry(entry) !== workspaceSection) || !entryMatchesQuery(entry, query)) continue;
    const pathSegments = resolvePaletteFolderPath(entry);

    let targetChildren = roots;
    let targetFolderIndex = rootFolders;
    const currentPath: string[] = [];

    for (const segment of pathSegments) {
      currentPath.push(segment);
      let folderNode = targetFolderIndex.get(segment);
      if (!folderNode) {
        folderNode = createFolderNode([...currentPath]);
        targetFolderIndex.set(segment, folderNode);
        targetChildren.push(folderNode);
      }
      targetChildren = folderNode.children as Array<MutableFolderNode | PaletteComponentNode>;
      targetFolderIndex = folderNode.folderIndex;
    }

    targetChildren.push({
      kind: "component",
      key: `component:${entry.typeId}`,
      typeId: entry.typeId,
      label: entry.label,
      category: entry.category,
      subcategory: entry.subcategory,
      pinCount: entry.pinCount,
      disabled: Boolean(entry.disabled),
      disabledReason: entry.disabledReason,
      pathSegments,
      iconLightUri: entry.iconLightUri,
      iconDarkUri: entry.iconDarkUri,
      isRegistered: Boolean(entry.isRegistered),
      registeredSourceId: entry.registeredSourceId,
      registeredSourceRemovable: entry.registeredSourceRemovable !== false,
    });
  }

  return stripMutableNodes(applyRootFolderPriority(roots, workspaceSection));
}

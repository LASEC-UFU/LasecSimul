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
export type PaletteLanguage = "pt-BR" | "en";

/** Uma pasta de topo prioritária e os nomes com que ela chega do catálogo: o da língua base
 * (pt-BR) e, quando existe, o traduzido. A pasta é A MESMA nos dois casos. */
interface RootFolderName {
  readonly "pt-BR": string;
  readonly en?: string;
}

const ROOT_FOLDER_PRIORITY: Partial<Record<WorkspaceSection, readonly RootFolderName[]>> = {
  analog: [{ "pt-BR": "Microcontroladores" }],
  // PLC-IEC, Protocolos Industriais, Modelos -- nesta ordem -- dentro de Processo.
  process: [
    { "pt-BR": "PLC IEC 61131-3", en: "IEC 61131-3 PLC" },
    { "pt-BR": "Protocolos Industriais", en: "Industrial Protocols" },
    { "pt-BR": "Modelos", en: "Models" },
  ],
  misc: [{ "pt-BR": "peripherals" }],
};

function rootFolderPriorityIndex(workspaceSection: WorkspaceSection | undefined, label: string): number {
  const priority = workspaceSection ? ROOT_FOLDER_PRIORITY[workspaceSection] : undefined;
  return priority ? priority.findIndex((name) => name["pt-BR"] === label || name.en === label) : -1;
}

/** Nome de uma pasta de topo conhecida na língua da paleta. Só PARTE do catálogo traduz
 * `folderPath` (`component-catalog.json::translations`): em inglês o PLC e o Modbus chegam com a
 * pasta traduzida, e HART e os modelos (subcircuitos) chegam em português. Sem unificar aqui, a
 * paleta em inglês mostrava "Protocolos Industriais" (HART) e "Industrial Protocols" (Modbus) como
 * duas pastas, e a do PLC -- com o nome traduzido, fora da lista de prioridade -- ia parar depois
 * de "Modelos". Sem `language`, o nome fica como veio. */
function localizedRootFolder(segment: string, workspaceSection: WorkspaceSection | undefined, language: PaletteLanguage | undefined): string {
  if (!language || !workspaceSection) return segment;
  const name = ROOT_FOLDER_PRIORITY[workspaceSection]?.[rootFolderPriorityIndex(workspaceSection, segment)];
  if (!name) return segment;
  return (language === "en" ? name.en : undefined) ?? name["pt-BR"];
}

function applyRootFolderPriority(
  roots: Array<MutableFolderNode | PaletteComponentNode>,
  workspaceSection: WorkspaceSection | undefined
): Array<MutableFolderNode | PaletteComponentNode> {
  const priority = workspaceSection ? ROOT_FOLDER_PRIORITY[workspaceSection] : undefined;
  if (!priority || priority.length === 0) return roots;
  const indexOf = (node: MutableFolderNode | PaletteComponentNode): number =>
    node.kind === "folder" ? rootFolderPriorityIndex(workspaceSection, node.label) : -1;
  const prioritized: Array<MutableFolderNode | PaletteComponentNode> = [];
  const rest: Array<MutableFolderNode | PaletteComponentNode> = [];
  for (const node of roots) (indexOf(node) >= 0 ? prioritized : rest).push(node);
  // Ordem relativa DENTRO do grupo priorizado segue a lista; múltiplas pastas com o mesmo
  // nome nunca coexistem no mesmo nível (chave única por segmento, ver `createFolderNode`).
  prioritized.sort((a, b) => indexOf(a) - indexOf(b));
  return [...prioritized, ...rest];
}

export function buildPaletteTree(entries: PaletteRenderableEntry[], rawQuery: string, workspaceSection?: WorkspaceSection, language?: PaletteLanguage): PaletteTreeNode[] {
  const roots: Array<MutableFolderNode | PaletteComponentNode> = [];
  const rootFolders = new Map<string, MutableFolderNode>();
  const query = normalizeSearchText(rawQuery);

  for (const entry of entries) {
    if (entry.hidden || entry.paletteHidden || (workspaceSection && workspaceSectionForCatalogEntry(entry) !== workspaceSection) || !entryMatchesQuery(entry, query)) continue;
    const pathSegments = resolvePaletteFolderPath(entry);
    if (pathSegments.length > 0) pathSegments[0] = localizedRootFolder(pathSegments[0]!, workspaceSection, language);

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

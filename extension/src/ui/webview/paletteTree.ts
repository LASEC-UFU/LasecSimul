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
  paletteActionCommand?: string;
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

function entryMatchesQuery(entry: PaletteRenderableEntry, query: string, folderPath: readonly string[]): boolean {
  if (!query) return true;
  const haystack = normalizeSearchText(
    [
      entry.label,
      entry.typeId,
      entry.category,
      entry.subcategory,
      ...folderPath,
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
export interface RootFolderName {
  readonly "pt-BR": string;
  readonly en?: string;
}

/** Subseção principal de Controle para as bibliotecas funcionais Simulink e a pasta TDPS. */
export const FUNCTION_BLOCKS_FOLDER: RootFolderName = { "pt-BR": "Blocos Funcionais", en: "Function Blocks" };

const ROOT_FOLDER_PRIORITY: Partial<Record<WorkspaceSection, readonly RootFolderName[]>> = {
  analog: [{ "pt-BR": "Microcontroladores" }],
  // PLC-IEC, Protocolos Industriais, Ferramentas e Blocos Funcionais -- nesta ordem -- dentro de
  // Controle. Os três primeiros vieram da antiga aba Processo, sem mudar de subseção.
  control: [
    { "pt-BR": "PLC IEC 61131-3", en: "IEC 61131-3 PLC" },
    { "pt-BR": "Protocolos Industriais", en: "Industrial Protocols" },
    { "pt-BR": "Ferramentas", en: "Tools" },
    FUNCTION_BLOCKS_FOLDER,
    // Ordem das subseções Simulink e TDPS dentro de Blocos Funcionais.
    { "pt-BR": "Contínuos", en: "Continuous" },
    { "pt-BR": "Descontinuidades", en: "Discontinuities" },
    { "pt-BR": "Discretos", en: "Discrete" },
    { "pt-BR": "Lógica e operações de bits", en: "Logic and Bit Operations" },
    { "pt-BR": "Tabelas de consulta", en: "Lookup Tables" },
    { "pt-BR": "Operações Matemáticas", en: "Math Operations" },
    { "pt-BR": "Atributos de sinal", en: "Signal Attributes" },
    { "pt-BR": "Roteamento de Sinais", en: "Signal Routing" },
    { "pt-BR": "Visualizadores (Sinks)", en: "Sinks" },
    { "pt-BR": "Fontes", en: "Sources" },
    { "pt-BR": "Funções Definidas pelo Usuário", en: "User-Defined Functions" },
    { "pt-BR": "Matemática Adicional e Discreto", en: "Additional Math & Discrete" },
    { "pt-BR": "TDPS", en: "TDPS" },
  ],
  // Conectores logo depois dos periféricos. Os conectores do catálogo canônico chegam em inglês
  // ("Connectors", tradução) e o túnel de sinal (`controlGraphCatalog.ts`, sem tradução) em
  // português: listar os dois nomes aqui é o que os junta numa pasta só, na língua da paleta.
  misc: [{ "pt-BR": "peripherals" }, { "pt-BR": "Conectores", en: "Connectors" }, { "pt-BR": "HMI" }],
};

function rootFolderPriorityIndex(workspaceSection: WorkspaceSection | undefined, label: string): number {
  const priority = workspaceSection ? ROOT_FOLDER_PRIORITY[workspaceSection] : undefined;
  return priority ? priority.findIndex((name) => name["pt-BR"] === label || name.en === label) : -1;
}

/**
 * Caminho de pasta de uma entrada DENTRO da sua aba. Igual a `resolvePaletteFolderPath`, exceto em
 * Controle: um item declarado `workspaceSection: "control"` que não esteja já numa das subseções
 * conhecidas (PLC, Protocolos Industriais, Ferramentas, Blocos Funcionais) vai para Blocos
 * Funcionais -- é o que antes aparecia direto na raiz de Controle (o catálogo e os manifestos
 * gravados continuam com `folderPath: []`; só a apresentação muda, IDs/pinos/propriedades não). O
 * legado `"process"` (antiga aba Processo) mantém a subseção que já declarava.
 */
export function paletteFolderPathForEntry(entry: Pick<PaletteRenderableEntry, "folderPath" | "category" | "subcategory" | "typeId" | "workspaceSection">): string[] {
  const segments = resolvePaletteFolderPath(entry);
  // Elementos gráficos pertencem à coleção HMI na aba Miscelâneos. Normalize os nomes
  // antigos/localizados da pasta sem alterar metadados gravados nem a classificação da aba.
  if (entry.typeId.startsWith("graphics.") && workspaceSectionForCatalogEntry(entry) === "misc") {
    const graphicFolders = new Set(["Grafico", "Gráfico", "Graficos", "Gráficos", "Graphical", "Graphics"]);
    return ["HMI", ...(segments.length > 0 && graphicFolders.has(segments[0]!) ? segments.slice(1) : segments)];
  }
  if (entry.workspaceSection !== "control") return segments;
  // Bibliotecas Simulink ficam dentro de Blocos Funcionais, cada uma em sua subseção.
  if (entry.typeId.startsWith("sl.")) {
    return segments[0] === FUNCTION_BLOCKS_FOLDER["pt-BR"] ? segments : [FUNCTION_BLOCKS_FOLDER["pt-BR"], ...segments];
  }
  if (segments.length > 0 && rootFolderPriorityIndex("control", segments[0]!) >= 0 && rootFolderPriorityIndex("control", segments[0]!) < 4) return segments;
  return [FUNCTION_BLOCKS_FOLDER["pt-BR"], ...segments];
}

/** Nome de uma pasta de topo conhecida na língua da paleta. Só PARTE do catálogo traduz
 * `folderPath` (`component-catalog.json::translations`): em inglês o PLC e o Modbus chegam com a
 * pasta traduzida, e HART e os blocos (subcircuitos) chegam em português. Sem unificar aqui, a
 * paleta em inglês mostrava "Protocolos Industriais" (HART) e "Industrial Protocols" (Modbus) como
 * duas pastas, e a do PLC -- com o nome traduzido, fora da lista de prioridade -- saía do topo.
 * Sem `language`, o nome fica como veio. */
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
    if (entry.hidden || entry.paletteHidden || (workspaceSection && workspaceSectionForCatalogEntry(entry) !== workspaceSection)) continue;
    const pathSegments = paletteFolderPathForEntry(entry);
    if (!entryMatchesQuery(entry, query, pathSegments)) continue;
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
      paletteActionCommand: entry.paletteActionCommand,
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

  const orderedRoots = applyRootFolderPriority(roots, workspaceSection);
  if (workspaceSection === "control") {
    const functionBlocks = orderedRoots.find((node) => node.kind === "folder" && node.label === FUNCTION_BLOCKS_FOLDER["pt-BR"]);
    if (functionBlocks?.kind === "folder") {
      functionBlocks.children = applyRootFolderPriority(
        functionBlocks.children as Array<MutableFolderNode | PaletteComponentNode>,
        workspaceSection
      );
    }
  }
  if (workspaceSection === "misc") {
    const hmi = orderedRoots.find((node) => node.kind === "folder" && node.label === "HMI");
    if (hmi?.kind === "folder") {
      const priority = (node: PaletteTreeNode): number => node.kind === "component"
        ? node.typeId === "tools.hmi_screen" ? 0 : node.typeId === "tools.hmi3d_screen" ? 1 : 2
        : 3;
      hmi.children = hmi.children.map((node, index) => ({ node, index }))
        .sort((a, b) => priority(a.node) - priority(b.node) || a.index - b.index)
        .map(({ node }) => node);
    }
  }
  return stripMutableNodes(orderedRoots);
}

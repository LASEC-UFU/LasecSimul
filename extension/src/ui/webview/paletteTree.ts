import { WebviewComponentCatalogEntry } from "./model";

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

export function resolvePaletteFolderPath(entry: Pick<WebviewComponentCatalogEntry, "folderPath" | "category" | "subcategory">): string[] {
  const normalized = Array.isArray(entry.folderPath)
    ? entry.folderPath.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
    : [];
  if (normalized.length > 0) return normalized;
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

export function buildPaletteTree(entries: PaletteRenderableEntry[], rawQuery: string): PaletteTreeNode[] {
  const roots: Array<MutableFolderNode | PaletteComponentNode> = [];
  const rootFolders = new Map<string, MutableFolderNode>();
  const query = normalizeSearchText(rawQuery);

  for (const entry of entries) {
    if (entry.hidden || !entryMatchesQuery(entry, query)) continue;
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

  return stripMutableNodes(roots);
}

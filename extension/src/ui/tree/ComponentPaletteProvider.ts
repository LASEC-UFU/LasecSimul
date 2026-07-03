import * as fs from "fs";
import * as vscode from "vscode";
import { WebviewComponentCatalogEntry } from "../webview/model";

type IconUriPair = { light: vscode.Uri; dark: vscode.Uri };

interface CatalogWithPath extends WebviewComponentCatalogEntry {
  folderPathNormalized: string[];
}

class PaletteFolderItem extends vscode.TreeItem {
  constructor(public readonly pathSegments: string[], icon?: IconUriPair) {
    const isTopLevel = pathSegments.length === 1;
    super(
      pathSegments[pathSegments.length - 1] ?? "",
      isTopLevel ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.id = "lasecsimul.palette.folder." + pathSegments.join("/");
    this.contextValue = "lasecsimul.palette.folder";
    if (icon) this.iconPath = icon;
  }
}

class PaletteComponentItem extends vscode.TreeItem {
  constructor(
    public readonly sourceId: string | undefined,
    public readonly typeId: string,
    label: string,
    public readonly category: string,
    public readonly pinCount: number,
    public readonly disabled: boolean,
    public readonly disabledReason: string | undefined,
    public readonly isRegistered: boolean,
    public readonly registeredSourceRemovable: boolean,
    icon: IconUriPair | undefined,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    const behavesAsRemovableRegistered = isRegistered && registeredSourceRemovable;
    this.description = disabled ? "indisponível" : `${pinCount} pinos`;
    this.tooltip = disabled
      ? `${typeId}\nCategoria: ${category}\nIndisponível: ${disabledReason ?? "erro desconhecido"}`
      : `${typeId}\nCategoria: ${category}`;
    if (disabled) {
      this.contextValue = behavesAsRemovableRegistered
        ? "lasecsimul.palette.component.registered.disabled"
        : "lasecsimul.palette.component.disabled";
      this.iconPath = new vscode.ThemeIcon("ghost");
    } else {
      this.contextValue = behavesAsRemovableRegistered
        ? "lasecsimul.palette.component.registered"
        : "lasecsimul.palette.component";
      if (icon) this.iconPath = icon;
      this.command = {
        command: "lasecsimul.palette.addComponent",
        title: "Adicionar componente",
        arguments: [typeId],
      };
    }
  }
}

/** TreeDataProvider nativo do VSCode pra paleta de componentes — categoria > subcategoria (opcional)
 * > item, com ícone antes do nome, replicando exatamente a árvore do SimulIDE (`itemlibrary.cpp`,
 * ver docs/15-taxonomia-paleta.md). Ordem das categorias é a ordem de primeira aparição no catálogo
 * (`catalog.ts`), não alfabética — catalog.ts já lista na mesma ordem do SimulIDE. */
export class ComponentPaletteProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly catalog: CatalogWithPath[];

  constructor(private readonly extensionUri: vscode.Uri, catalog: WebviewComponentCatalogEntry[]) {
    this.catalog = this.normalizeCatalog(catalog);
  }

  setCatalog(catalog: WebviewComponentCatalogEntry[]): void {
    this.catalog.splice(0, this.catalog.length, ...this.normalizeCatalog(catalog));
    this.refresh();
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      return Promise.resolve(this.childrenForPath([]));
    }

    if (element instanceof PaletteFolderItem) {
      return Promise.resolve(this.childrenForPath(element.pathSegments));
    }

    return Promise.resolve([]);
  }

  private static readonly FOLDER_ICONS: Record<string, string> = {
    "Logicos/Portas": "gates",
    "Logicos/Aritmeticos": "2to2",
    "Logicos/Memorias": "package",
    "Logicos/Conversores": "1to2",
    "Logicos/Outros logicos": "2to3",
    "Passivos/Resistores": "resistors",
    "Passivos/Reativo": "reactive",
  };

  private childrenForPath(pathSegments: string[]): vscode.TreeItem[] {
    const depth = pathSegments.length;
    const visibleEntries = this.catalog.filter((entry) => this.startsWith(entry.folderPathNormalized, pathSegments));

    const nextFolders: string[] = [];
    for (const entry of visibleEntries) {
      if (entry.folderPathNormalized.length <= depth) continue;
      const next = entry.folderPathNormalized[depth];
      if (next && !nextFolders.includes(next)) nextFolders.push(next);
    }

    const folderItems = nextFolders.map((folderName) => {
      const fullPath = [...pathSegments, folderName];
      const iconName = ComponentPaletteProvider.FOLDER_ICONS[fullPath.join("/")];
      const icon = iconName ? this.resolveFolderIcon(iconName) : undefined;
      return new PaletteFolderItem(fullPath, icon);
    });

    const directItems = visibleEntries
      .filter((entry) => entry.folderPathNormalized.length === depth)
      .map((entry) => this.makeComponentItem(entry));

    return [...folderItems, ...directItems];
  }

  private makeComponentItem(entry: CatalogWithPath): PaletteComponentItem {
    return new PaletteComponentItem(
      entry.registeredSourceId,
      entry.typeId,
      entry.label,
      entry.category,
      entry.pinCount,
      Boolean(entry.disabled),
      entry.disabledReason,
      Boolean(entry.isRegistered),
      entry.registeredSourceRemovable !== false,
      this.resolveIcon(entry)
    );
  }

  private normalizeCatalog(catalog: WebviewComponentCatalogEntry[]): CatalogWithPath[] {
    return catalog
      .filter((entry) => !entry.hidden)
      .map((entry) => ({
      ...entry,
      folderPathNormalized: this.resolveFolderPath(entry),
    }));
  }

  private resolveFolderPath(entry: WebviewComponentCatalogEntry): string[] {
    const normalized = Array.isArray(entry.folderPath)
      ? entry.folderPath.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
      : [];
    if (normalized.length > 0) return normalized;
    return [entry.category, ...(entry.subcategory ? [entry.subcategory] : [])];
  }

  private startsWith(path: string[], prefix: string[]): boolean {
    if (prefix.length > path.length) return false;
    for (let index = 0; index < prefix.length; index += 1) {
      if (path[index] !== prefix[index]) return false;
    }
    return true;
  }

  private equalsPath(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return false;
    }
    return true;
  }

  private resolveFolderIcon(iconName: string): IconUriPair | undefined {
    const iconRef = this.resolveIconReference(iconName);
    return {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "components", "light", `${iconRef.name}.${iconRef.extension}`),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "components", "dark", `${iconRef.name}.${iconRef.extension}`),
    };
  }

  private resolveIcon(entry: WebviewComponentCatalogEntry): IconUriPair {
    if (entry.iconFilePath) {
      const iconUri = vscode.Uri.file(entry.iconFilePath);
      return { light: iconUri, dark: iconUri };
    }
    const iconRef = this.resolveIconReference(entry.icon);
    return {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "components", "light", `${iconRef.name}.${iconRef.extension}`),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "components", "dark", `${iconRef.name}.${iconRef.extension}`),
    };
  }

  private resolveIconReference(icon: string | undefined): { name: string; extension: "png" | "svg" } {
    if (icon) {
      if (this.iconAssetExists(icon, "png")) return { name: icon, extension: "png" };
      if (this.iconAssetExists(icon, "svg")) return { name: icon, extension: "svg" };
    }
    return { name: "generic-component", extension: "svg" };
  }

  private iconAssetExists(icon: string, extension: "png" | "svg"): boolean {
    const lightPath = vscode.Uri.joinPath(this.extensionUri, "media", "components", "light", `${icon}.${extension}`).fsPath;
    const darkPath = vscode.Uri.joinPath(this.extensionUri, "media", "components", "dark", `${icon}.${extension}`).fsPath;
    return fs.existsSync(lightPath) && fs.existsSync(darkPath);
  }
}

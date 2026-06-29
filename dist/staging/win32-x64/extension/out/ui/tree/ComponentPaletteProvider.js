"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComponentPaletteProvider = void 0;
const fs = __importStar(require("fs"));
const vscode = __importStar(require("vscode"));
class PaletteFolderItem extends vscode.TreeItem {
    pathSegments;
    constructor(pathSegments) {
        super(pathSegments[pathSegments.length - 1] ?? "", vscode.TreeItemCollapsibleState.Expanded);
        this.pathSegments = pathSegments;
        this.contextValue = "lasecsimul.palette.folder";
    }
}
class PaletteComponentItem extends vscode.TreeItem {
    sourceId;
    typeId;
    category;
    pinCount;
    disabled;
    disabledReason;
    isRegistered;
    registeredSourceRemovable;
    constructor(sourceId, typeId, label, category, pinCount, disabled, disabledReason, isRegistered, registeredSourceRemovable, icon) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.sourceId = sourceId;
        this.typeId = typeId;
        this.category = category;
        this.pinCount = pinCount;
        this.disabled = disabled;
        this.disabledReason = disabledReason;
        this.isRegistered = isRegistered;
        this.registeredSourceRemovable = registeredSourceRemovable;
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
        }
        else {
            this.contextValue = behavesAsRemovableRegistered
                ? "lasecsimul.palette.component.registered"
                : "lasecsimul.palette.component";
            if (icon)
                this.iconPath = icon;
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
class ComponentPaletteProvider {
    extensionUri;
    onDidChangeTreeDataEmitter = new vscode.EventEmitter();
    onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    catalog;
    constructor(extensionUri, catalog) {
        this.extensionUri = extensionUri;
        this.catalog = this.normalizeCatalog(catalog);
    }
    setCatalog(catalog) {
        this.catalog.splice(0, this.catalog.length, ...this.normalizeCatalog(catalog));
        this.refresh();
    }
    refresh() {
        this.onDidChangeTreeDataEmitter.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            return Promise.resolve(this.childrenForPath([]));
        }
        if (element instanceof PaletteFolderItem) {
            return Promise.resolve(this.childrenForPath(element.pathSegments));
        }
        return Promise.resolve([]);
    }
    childrenForPath(pathSegments) {
        const depth = pathSegments.length;
        const visibleEntries = this.catalog.filter((entry) => this.startsWith(entry.folderPathNormalized, pathSegments));
        const nextFolders = [];
        for (const entry of visibleEntries) {
            if (entry.folderPathNormalized.length <= depth)
                continue;
            const next = entry.folderPathNormalized[depth];
            if (next && !nextFolders.includes(next))
                nextFolders.push(next);
        }
        const folderItems = nextFolders.map((folderName) => {
            const fullPath = [...pathSegments, folderName];
            return new PaletteFolderItem(fullPath);
        });
        const directItems = visibleEntries
            .filter((entry) => entry.folderPathNormalized.length === depth)
            .map((entry) => this.makeComponentItem(entry));
        return [...folderItems, ...directItems];
    }
    makeComponentItem(entry) {
        return new PaletteComponentItem(entry.registeredSourceId, entry.typeId, entry.label, entry.category, entry.pinCount, Boolean(entry.disabled), entry.disabledReason, Boolean(entry.isRegistered), entry.registeredSourceRemovable !== false, this.resolveIcon(entry));
    }
    normalizeCatalog(catalog) {
        return catalog
            .filter((entry) => !entry.hidden)
            .map((entry) => ({
            ...entry,
            folderPathNormalized: this.resolveFolderPath(entry),
        }));
    }
    resolveFolderPath(entry) {
        const normalized = Array.isArray(entry.folderPath)
            ? entry.folderPath.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
            : [];
        if (normalized.length > 0)
            return normalized;
        return [entry.category, ...(entry.subcategory ? [entry.subcategory] : [])];
    }
    startsWith(path, prefix) {
        if (prefix.length > path.length)
            return false;
        for (let index = 0; index < prefix.length; index += 1) {
            if (path[index] !== prefix[index])
                return false;
        }
        return true;
    }
    equalsPath(a, b) {
        if (a.length !== b.length)
            return false;
        for (let index = 0; index < a.length; index += 1) {
            if (a[index] !== b[index])
                return false;
        }
        return true;
    }
    resolveIcon(entry) {
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
    resolveIconReference(icon) {
        if (icon) {
            if (this.iconAssetExists(icon, "png"))
                return { name: icon, extension: "png" };
            if (this.iconAssetExists(icon, "svg"))
                return { name: icon, extension: "svg" };
        }
        return { name: "generic-component", extension: "svg" };
    }
    iconAssetExists(icon, extension) {
        const lightPath = vscode.Uri.joinPath(this.extensionUri, "media", "components", "light", `${icon}.${extension}`).fsPath;
        const darkPath = vscode.Uri.joinPath(this.extensionUri, "media", "components", "dark", `${icon}.${extension}`).fsPath;
        return fs.existsSync(lightPath) && fs.existsSync(darkPath);
    }
}
exports.ComponentPaletteProvider = ComponentPaletteProvider;
//# sourceMappingURL=ComponentPaletteProvider.js.map
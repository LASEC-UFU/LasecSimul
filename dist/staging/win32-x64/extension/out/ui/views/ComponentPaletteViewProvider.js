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
exports.ComponentPaletteViewProvider = void 0;
const fs = __importStar(require("fs"));
const vscode = __importStar(require("vscode"));
class ComponentPaletteViewProvider {
    extensionUri;
    language;
    onAddComponent;
    onRemoveRegistered;
    onEditSymbol;
    view;
    catalog;
    constructor(extensionUri, catalog, language, onAddComponent, onRemoveRegistered, onEditSymbol) {
        this.extensionUri = extensionUri;
        this.language = language;
        this.onAddComponent = onAddComponent;
        this.onRemoveRegistered = onRemoveRegistered;
        this.onEditSymbol = onEditSymbol;
        this.catalog = [...catalog];
    }
    setCatalog(catalog) {
        this.catalog = [...catalog];
        void this.postState();
    }
    setLanguage(language) {
        this.language = language;
        void this.postState();
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, "media", "components"),
                vscode.Uri.joinPath(this.extensionUri, "src", "ui", "palette"),
                vscode.Uri.joinPath(this.extensionUri, "out-webview"),
            ],
        };
        webviewView.webview.html = this.renderHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    }
    handleMessage(message) {
        if (message.type === "webviewReady") {
            void this.postState();
            return;
        }
        if (message.type === "addComponent") {
            this.onAddComponent(message.typeId);
            return;
        }
        if (message.type === "removeRegistered") {
            void this.onRemoveRegistered({ sourceId: message.sourceId });
            return;
        }
        if (message.type === "editSymbol") {
            void this.onEditSymbol({ sourceId: message.sourceId });
        }
    }
    postState() {
        if (!this.view)
            return Promise.resolve(false);
        return this.view.webview.postMessage({
            type: "sync",
            state: this.currentState(),
        });
    }
    currentState() {
        return {
            catalog: this.catalog.map((entry) => this.decorateCatalogEntry(entry)),
            language: this.language,
        };
    }
    renderHtml(webview) {
        const nonce = String(Date.now());
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out-webview", "palette.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "src", "ui", "palette", "styles.css"));
        const initialStateJson = JSON.stringify(this.currentState());
        return `
      <!doctype html>
      <html lang="${this.language}">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
          <link rel="stylesheet" href="${styleUri}" />
          <title>LasecSimul Palette</title>
        </head>
        <body>
          <main id="app"></main>
          <script nonce="${nonce}">window.__LASECSIMUL_PALETTE_STATE__ = ${initialStateJson};</script>
          <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>
    `;
    }
    decorateCatalogEntry(entry) {
        const icon = this.resolveIcon(entry);
        return {
            ...entry,
            iconLightUri: this.view?.webview.asWebviewUri(icon.light).toString() ?? icon.light.toString(),
            iconDarkUri: this.view?.webview.asWebviewUri(icon.dark).toString() ?? icon.dark.toString(),
        };
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
exports.ComponentPaletteViewProvider = ComponentPaletteViewProvider;
//# sourceMappingURL=ComponentPaletteViewProvider.js.map
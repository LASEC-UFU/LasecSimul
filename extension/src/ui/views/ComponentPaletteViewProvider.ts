import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { LasecSimulLanguage } from "../../language";
import { WebviewComponentCatalogEntry } from "../webview/model";

interface PaletteWebviewCatalogEntry extends WebviewComponentCatalogEntry {
  iconLightUri: string;
  iconDarkUri: string;
}

interface PaletteHostState {
  catalog: PaletteWebviewCatalogEntry[];
  language: LasecSimulLanguage;
}

type PaletteWebviewMessage =
  | { type: "webviewReady" }
  | { type: "startPlacingComponent"; typeId: string }
  | { type: "removeRegistered"; sourceId: string };

type IconUriPair = { light: vscode.Uri; dark: vscode.Uri };

export class ComponentPaletteViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private catalog: WebviewComponentCatalogEntry[];

  constructor(
    private readonly extensionUri: vscode.Uri,
    catalog: WebviewComponentCatalogEntry[],
    private language: LasecSimulLanguage,
    private readonly onAddComponent: (typeId: string) => void,
    private readonly onRemoveRegistered: (item: { sourceId?: string }) => void | Promise<void>,
  ) {
    this.catalog = [...catalog];
  }

  setCatalog(catalog: WebviewComponentCatalogEntry[]): void {
    this.catalog = [...catalog];
    this.updateWebviewOptions();
    void this.postState();
  }

  setLanguage(language: LasecSimulLanguage): void {
    this.language = language;
    void this.postState();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    this.updateWebviewOptions();
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: PaletteWebviewMessage) => this.handleMessage(message));
  }

  private updateWebviewOptions(): void {
    if (!this.view) return;
    const iconRoots = new Set<string>();
    for (const entry of this.catalog) {
      if (!entry.iconFilePath) continue;
      iconRoots.add(path.dirname(entry.iconFilePath));
    }
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media", "components"),
        vscode.Uri.joinPath(this.extensionUri, "src", "ui", "palette"),
        vscode.Uri.joinPath(this.extensionUri, "out-webview"),
        ...[...iconRoots].map((root) => vscode.Uri.file(root)),
      ],
    };
  }

  private handleMessage(message: PaletteWebviewMessage): void {
    if (message.type === "webviewReady") {
      void this.postState();
      return;
    }
    if (message.type === "startPlacingComponent") {
      this.onAddComponent(message.typeId);
      return;
    }
    if (message.type === "removeRegistered") {
      void this.onRemoveRegistered({ sourceId: message.sourceId });
      return;
    }
  }

  private postState(): Thenable<boolean> {
    if (!this.view) return Promise.resolve(false);
    return this.view.webview.postMessage({
      type: "sync",
      state: this.currentState(),
    });
  }

  private currentState(): PaletteHostState {
    return {
      catalog: this.catalog.map((entry) => this.decorateCatalogEntry(entry)),
      language: this.language,
    };
  }

  private renderHtml(webview: vscode.Webview): string {
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
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';" />
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

  private decorateCatalogEntry(entry: WebviewComponentCatalogEntry): PaletteWebviewCatalogEntry {
    if (entry.iconSvgInline) {
      const dataUri = `data:image/svg+xml,${encodeURIComponent(entry.iconSvgInline)}`;
      return { ...entry, iconLightUri: dataUri, iconDarkUri: dataUri };
    }
    const icon = this.resolveIcon(entry);
    return {
      ...entry,
      iconLightUri: this.view?.webview.asWebviewUri(icon.light).toString() ?? icon.light.toString(),
      iconDarkUri: this.view?.webview.asWebviewUri(icon.dark).toString() ?? icon.dark.toString(),
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

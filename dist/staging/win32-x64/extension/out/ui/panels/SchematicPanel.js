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
exports.SchematicPanel = void 0;
const vscode = __importStar(require("vscode"));
const messages_1 = require("../webview/messages");
function localizedPanelTitle(language) {
    return language === "en" ? "LasecSimul - Schematic" : "LasecSimul - Esquemático";
}
class SchematicPanel {
    extensionUri;
    initialState;
    onMessage;
    onDispose;
    static current;
    panel;
    ready = false;
    pendingMessages = [];
    constructor(panel, extensionUri, initialState, onMessage, onDispose) {
        this.extensionUri = extensionUri;
        this.initialState = initialState;
        this.onMessage = onMessage;
        this.onDispose = onDispose;
        this.panel = panel;
        this.panel.onDidDispose(() => {
            SchematicPanel.current = undefined;
            this.onDispose();
        });
        this.panel.webview.onDidReceiveMessage((message) => {
            if (message.type === "webviewReady") {
                this.ready = true;
                this.flushPendingMessages();
                return;
            }
            this.onMessage(message);
        });
    }
    static createOrShow(extensionUri, initialState, onMessage, onDispose) {
        const existing = SchematicPanel.current;
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.One);
            existing.setLanguage(initialState.locale ?? "pt-BR");
            existing.postMessage({ version: messages_1.WEBVIEW_MESSAGE_VERSION, type: "syncState", project: initialState });
            return existing;
        }
        const panel = vscode.window.createWebviewPanel("lasecsimul.schematic", localizedPanelTitle(initialState.locale ?? "pt-BR"), vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, "src", "ui", "webview"),
                vscode.Uri.joinPath(extensionUri, "out-webview"),
            ],
        });
        SchematicPanel.current = new SchematicPanel(panel, extensionUri, initialState, onMessage, onDispose);
        SchematicPanel.current.render();
        return SchematicPanel.current;
    }
    postMessage(message) {
        if (!this.ready) {
            this.pendingMessages.push(message);
            return Promise.resolve(true);
        }
        return this.panel.webview.postMessage(message);
    }
    setLanguage(language) {
        this.panel.title = localizedPanelTitle(language);
    }
    flushPendingMessages() {
        while (this.pendingMessages.length > 0) {
            const next = this.pendingMessages.shift();
            if (next !== undefined) {
                void this.panel.webview.postMessage(next);
            }
        }
    }
    render() {
        const webview = this.panel.webview;
        const scriptPath = vscode.Uri.joinPath(this.extensionUri, "out-webview", "main.js");
        const stylePath = vscode.Uri.joinPath(this.extensionUri, "src", "ui", "webview", "styles.css");
        const nonce = String(Date.now());
        const initialStateJson = JSON.stringify(this.initialState);
        const locale = this.initialState.locale ?? "pt-BR";
        webview.html = `
      <!doctype html>
      <html lang="${locale}">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
          <title>${localizedPanelTitle(locale)}</title>
          <link rel="stylesheet" href="${webview.asWebviewUri(stylePath)}" />
        </head>
        <body>
          <main id="app"></main>
          <script nonce="${nonce}">window.__LASECSIMUL_INITIAL_STATE__ = ${initialStateJson};</script>
          <script type="module" nonce="${nonce}" src="${webview.asWebviewUri(scriptPath)}"></script>
        </body>
      </html>
    `;
    }
}
exports.SchematicPanel = SchematicPanel;
//# sourceMappingURL=SchematicPanel.js.map
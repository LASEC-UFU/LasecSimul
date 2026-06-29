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
exports.CoreClient = void 0;
const net = __importStar(require("net"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const protocol_1 = require("./protocol");
function toPipePath(name) {
    return process.platform === "win32"
        ? `\\\\.\\pipe\\${name}`
        : path.join(os.tmpdir(), `${name}.sock`);
}
/**
 * Único ponto da Extension que sabe que existe um processo LasecSimul Core nativo.
 * Toda a UI fala com CoreClient; nenhum outro módulo abre socket/pipe diretamente.
 */
class CoreClient {
    pipeName;
    socket;
    pending = new Map();
    notificationHandlers = [];
    requestCounter = 0;
    lineBuffer = "";
    requestTimeoutMs;
    constructor(pipeName, opts = {}) {
        this.pipeName = pipeName;
        this.requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
    }
    /** Estabelece conexão com o Core e realiza o handshake de protocolo. */
    async start() {
        await this._connect();
        await this._handshake();
    }
    /** Envia shutdown ao Core e encerra o socket. Rejeita todas as requisições pendentes. */
    async stop() {
        try {
            await this.request("shutdown", {});
        }
        catch {
            // best-effort: Core pode já ter encerrado
        }
        this._destroy(new Error("CoreClient encerrado"));
    }
    /** Envia uma requisição ao Core e aguarda a resposta. */
    async request(type, payload) {
        if (!this.socket) {
            throw new Error("CoreClient não está conectado");
        }
        const id = String(++this.requestCounter);
        const envelope = { id, type, payload, protocolVersion: protocol_1.PROTOCOL_VERSION };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Requisição "${type}" (id=${id}) expirou após ${this.requestTimeoutMs}ms`));
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.write(JSON.stringify(envelope) + "\n");
        });
    }
    /** Registra um handler para notificações assíncronas enviadas pelo Core. */
    onNotification(handler) {
        this.notificationHandlers.push(handler);
    }
    // ── controle de simulação ──────────────────────────────────────────────────
    async run() { await this.request("start", {}); }
    async pause() { await this.request("pause", {}); }
    async step() { await this.request("step", {}); }
    /** Para a simulação sem encerrar a conexão IPC. */
    async stopSimulation() { await this.request("stop", {}); }
    // ── controle do esquemático ────────────────────────────────────────────────
    /** `pins`: built-ins ignoram o id (cada factory já tem o seu hardcoded, ex: "p1"/"p2") e só leem
     * x/y; plugins (NativeDeviceProxy) usam estes ids DIRETAMENTE como os pinos da instância — sem
     * isso, connectWire nunca acertaria o pino certo de um componente vindo de um plugin (ver
     * .spec/lasecsimul.spec sobre instrumentos como plugin ABI). */
    async addComponent(typeId, properties, pins = []) {
        const resp = await this.request("addComponent", { typeId, properties, pins });
        return resp.instanceId;
    }
    /** `requiresRestart: true` quando a propriedade alterada tem essa flag no schema (`Core` já
     * aplicou a mudança normalmente; reinício automático não é feito aqui — ver Épico A do roadmap de
     * pendências, decisão A3). Quem chama decide como avisar o usuário. */
    async setProperty(instanceId, name, value) {
        const resp = (await this.request("setProperty", { instanceId, name, value }));
        return { requiresRestart: Boolean(resp?.requiresRestart) };
    }
    async connectWire(componentA, pinIdA, componentB, pinIdB) {
        await this.request("connectWire", { componentA, pinIdA, componentB, pinIdB });
    }
    async removeComponent(instanceId) {
        await this.request("removeComponent", { instanceId });
    }
    async loadDeviceLibrary(libraryJsonPath) {
        // só deve ser chamado depois do fluxo de confiança/consentimento
        await this.request("loadDeviceLibrary", { path: libraryJsonPath });
    }
    /** Bytes opacos de `IComponentModel::getState()` de uma instância (built-in ou plugin),
     * devolvidos como hex — quem chama decide o que os bytes significam (ex: "instruments.voltmeter"
     * é sempre 1 double little-endian = a última tensão medida). */
    async getComponentState(instanceId) {
        const resp = await this.request("getComponentState", { instanceId });
        const stateHex = resp.stateHex;
        return Buffer.from(stateHex, "hex");
    }
    /** Saúde operacional da instância (`"ok" | "lagging" | "faulted"`) -- watchdog/CrashGuard do
     * lado do plugin nativo, ver `.spec/lasecsimul-native-devices.spec` seção 13. Built-ins sempre
     * respondem `"ok"`. */
    async getComponentHealth(instanceId) {
        const resp = await this.request("getComponentHealth", { instanceId });
        return resp.status;
    }
    /** Corrente elétrica no "ramo principal" da instância na última solve() -- convenção PASSIVA
     * (positiva entrando no primeiro pino/saindo no segundo; fonte fornecendo energia aparece
     * negativa). `undefined` quando o componente não implementa isso (Ground, Tunnel, etc.) --
     * nunca lança por esse motivo. Opção de baixo custo do plano de leitura de corrente: sem
     * incógnita nova no Core, lida sob demanda do estado já cacheado. */
    async getComponentCurrent(instanceId) {
        const resp = await this.request("getComponentCurrent", { instanceId });
        const payload = resp;
        return payload.hasCurrent ? payload.current : undefined;
    }
    /** Tensão atual do nó ao qual `pinId` da instância `instanceId` está resolvido -- usado pra
     * colorir/animar fios na Webview (vermelho/azul conforme tensão, ver ConnectorLine do SimulIDE),
     * sem precisar de um instrumento. Lê o mesmo valor que `IComponentModel`/instrumentos já leem
     * internamente via `getNodeVoltage()` do solver. */
    async getNodeVoltage(instanceId, pinId) {
        const resp = await this.request("getNodeVoltage", { instanceId, pinId });
        return resp.voltage;
    }
    /** Schema rico de propriedades (grupo/editor/min/max/opções/flags) de TODO typeId já registrado
     * no Core neste momento — built-in (sempre presente) e plugin (só depois de `loadDeviceLibrary`
     * bem-sucedido). Por `typeId`, nunca por instância — chamar de novo depois de carregar uma
     * library nova pega os typeIds que acabaram de ficar disponíveis. `language` (BCP-47, opcional):
     * pede `label`/`group`/opções traduzidos quando o `device.json`/built-in tiver essa tradução
     * declarada (`translations`); sem isso (ou sem tradução pra essa língua), devolve na língua-base
     * do componente -- nunca falha, ver `lasecsimul.spec` seção 6.3.3. */
    async getPropertySchemas(language) {
        const resp = await this.request("getPropertySchemas", { language });
        return resp.schemasByTypeId;
    }
    onTelemetry(callback) {
        // assina notificações de telemetria pelo canal de controle (alta frequência usa shm)
        this.onNotification((n) => {
            if (n.type === "telemetry")
                callback(n.payload);
        });
    }
    // ── privado ────────────────────────────────────────────────────────────────
    _connect() {
        const maxAttempts = 20;
        const retryDelayMs = 150;
        let attempt = 0;
        const tryOnce = () => new Promise((resolve, reject) => {
            const socket = net.createConnection(toPipePath(this.pipeName));
            socket.once("connect", () => {
                this.socket = socket;
                socket.on("data", (d) => this._onData(d));
                socket.once("close", () => this._destroy(new Error("Conexão com Core encerrada inesperadamente")));
                resolve();
            });
            socket.once("error", reject);
        });
        const retry = () => tryOnce().catch((err) => {
            attempt++;
            if (attempt >= maxAttempts) {
                throw new Error(`Não foi possível conectar ao Core após ${maxAttempts} tentativas: ${err}`);
            }
            return new Promise((r) => setTimeout(r, retryDelayMs)).then(retry);
        });
        return retry();
    }
    async _handshake() {
        const resp = (await this.request("hello", { clientVersion: "0.1.0" }));
        if (resp.protocolVersion !== protocol_1.PROTOCOL_VERSION) {
            throw new Error(`Versão de protocolo incompatível: cliente=${protocol_1.PROTOCOL_VERSION}, servidor=${resp.protocolVersion}`);
        }
    }
    _onData(data) {
        this.lineBuffer += data.toString("utf8");
        const lines = this.lineBuffer.split("\n");
        this.lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
            const t = line.trim();
            if (t)
                this._dispatch(t);
        }
    }
    _dispatch(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (typeof msg !== "object" || msg === null)
            return;
        if ("id" in msg) {
            const r = msg;
            const p = this.pending.get(r.id);
            if (!p)
                return;
            clearTimeout(p.timer);
            this.pending.delete(r.id);
            r.ok ? p.resolve(r.payload) : p.reject(new protocol_1.IpcError(r.error ?? "Erro no Core", (0, protocol_1.errorCodeFromPayload)(r.payload)));
        }
        else {
            const n = msg;
            this.notificationHandlers.forEach((h) => h(n));
        }
    }
    _destroy(err) {
        this.socket?.destroy();
        this.socket = undefined;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
    }
}
exports.CoreClient = CoreClient;
//# sourceMappingURL=CoreClient.js.map
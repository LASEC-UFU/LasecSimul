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
exports.CoreProcess = void 0;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
/**
 * Gerencia o ciclo de vida do processo Core nativo.
 * Separado de CoreClient para permitir testes com servidores mock sem processo real.
 */
class CoreProcess {
    opts;
    child;
    _exitListeners = [];
    _errorListeners = [];
    constructor(opts) {
        this.opts = opts;
    }
    get isRunning() {
        return this.child !== undefined && this.child.exitCode === null;
    }
    start() {
        if (this.child) {
            throw new Error("CoreProcess já iniciado");
        }
        const spawnOpts = {
            stdio: ["ignore", "pipe", "pipe"],
            cwd: this.opts.cwd ?? path.dirname(this.opts.executablePath),
        };
        this.child = (0, child_process_1.spawn)(this.opts.executablePath, ["--pipe", this.opts.pipeName], spawnOpts);
        this.child.on("exit", (code) => {
            for (const l of this._exitListeners)
                l(code);
            this.child = undefined;
        });
        // Sem isso, ENOENT (binário não encontrado) ou EACCES virariam exceção não tratada na thread
        // do Node e derrubariam o Extension Host inteiro em vez de só este processo — 'error' é
        // assíncrono e sempre precisa de listener próprio (não basta o try/catch de quem chamou start()).
        this.child.on("error", (err) => {
            for (const l of this._errorListeners)
                l(err);
            this.child = undefined;
        });
        // Encaminha stderr do Core para o console do processo host
        this.child.stderr?.on("data", (data) => {
            process.stderr.write(`[LasecSimul Core] ${data.toString()}`);
        });
    }
    onExit(listener) {
        this._exitListeners.push(listener);
    }
    /** Falha ao iniciar o processo (ex: binário não encontrado) — ver comentário em start(). */
    onError(listener) {
        this._errorListeners.push(listener);
    }
    kill() {
        this.child?.kill();
        this.child = undefined;
    }
    /** Nome de pipe padrão para esta instância do processo host. */
    static defaultPipeName() {
        return `lasecsimul-core-${process.pid}`;
    }
}
exports.CoreProcess = CoreProcess;
//# sourceMappingURL=CoreProcess.js.map
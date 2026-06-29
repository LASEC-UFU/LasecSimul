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
exports.MockCoreServer = void 0;
exports.serverPath = serverPath;
exports.cleanupServerPath = cleanupServerPath;
exports.createTestRunner = createTestRunner;
exports.assert = assert;
const net = __importStar(require("net"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const protocol_1 = require("../protocol");
function serverPath(name) {
    return process.platform === "win32"
        ? `\\\\.\\pipe\\${name}`
        : path.join(os.tmpdir(), `${name}.sock`);
}
function cleanupServerPath(name) {
    if (process.platform !== "win32") {
        try {
            fs.unlinkSync(serverPath(name));
        }
        catch { /* ignore */ }
    }
}
/** Servidor mock mínimo de IPC do Core, reutilizável por qualquer teste da Extension que precise
 * de um Core falso (handshake + dispatch configurável). */
class MockCoreServer {
    name;
    protocolVersion;
    handler;
    server;
    socket;
    lineBuffer = "";
    constructor(name, protocolVersion = protocol_1.PROTOCOL_VERSION, handler) {
        this.name = name;
        this.protocolVersion = protocolVersion;
        this.handler = handler;
        this.server = net.createServer((s) => {
            this.socket = s;
            s.on("data", (d) => this._onData(d));
        });
    }
    start() {
        cleanupServerPath(this.name);
        return new Promise((resolve) => this.server.listen(serverPath(this.name), resolve));
    }
    stop() {
        this.socket?.destroy();
        return new Promise((resolve) => this.server.close(() => { cleanupServerPath(this.name); resolve(); }));
    }
    _onData(data) {
        this.lineBuffer += data.toString("utf8");
        const lines = this.lineBuffer.split("\n");
        this.lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
            const t = line.trim();
            if (t)
                this._handle(t);
        }
    }
    _handle(raw) {
        const msg = JSON.parse(raw);
        const resp = this._dispatch(msg);
        this.socket?.write(JSON.stringify(resp) + "\n");
        if (msg.type === "shutdown")
            this.socket?.destroy();
    }
    _dispatch(msg) {
        if (msg.type === "hello") {
            return {
                id: msg.id,
                ok: true,
                payload: { serverVersion: "0.1.0", protocolVersion: this.protocolVersion },
            };
        }
        if (this.handler)
            return this.handler(msg);
        return { id: msg.id, ok: true, payload: {} };
    }
}
exports.MockCoreServer = MockCoreServer;
function createTestRunner(suiteName) {
    let passed = 0;
    let failed = 0;
    console.log(`\n${suiteName}\n`);
    return {
        test: async (name, fn) => {
            try {
                await fn();
                console.log(`  ✓ ${name}`);
                passed++;
            }
            catch (e) {
                console.error(`  ✗ ${name}: ${e.message}`);
                failed++;
            }
        },
        finish: () => {
            console.log(`\nResultado: ${passed} passaram, ${failed} falharam\n`);
            return { passed, failed };
        },
    };
}
function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}
//# sourceMappingURL=MockCoreServer.js.map
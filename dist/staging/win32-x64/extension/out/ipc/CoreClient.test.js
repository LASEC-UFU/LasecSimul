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
const net = __importStar(require("net"));
const CoreClient_1 = require("./CoreClient");
const protocol_1 = require("./protocol");
const MockCoreServer_1 = require("./testSupport/MockCoreServer");
// ── suite de testes ───────────────────────────────────────────────────────────
const { test, finish } = (0, MockCoreServer_1.createTestRunner)("CoreClient — testes de IPC");
(async () => {
    await test("Extension inicia Core (mock) e conecta", async () => {
        const name = `lasecsimul-test-start-${process.pid}`;
        const server = new MockCoreServer_1.MockCoreServer(name);
        await server.start();
        const client = new CoreClient_1.CoreClient(name, { requestTimeoutMs: 1_000 });
        await client.start();
        await client.stop();
        await server.stop();
    });
    await test("Handshake compatível passa", async () => {
        const name = `lasecsimul-test-compat-${process.pid}`;
        const server = new MockCoreServer_1.MockCoreServer(name, protocol_1.PROTOCOL_VERSION);
        await server.start();
        const client = new CoreClient_1.CoreClient(name, { requestTimeoutMs: 1_000 });
        await client.start(); // não deve lançar
        await client.stop();
        await server.stop();
    });
    await test("Handshake incompatível falha com erro de versão", async () => {
        const name = `lasecsimul-test-incompat-${process.pid}`;
        const server = new MockCoreServer_1.MockCoreServer(name, protocol_1.PROTOCOL_VERSION + 99);
        await server.start();
        const client = new CoreClient_1.CoreClient(name, { requestTimeoutMs: 1_000 });
        let threw = false;
        try {
            await client.start();
        }
        catch {
            threw = true;
        }
        await server.stop();
        (0, MockCoreServer_1.assert)(threw, "deveria lançar erro de protocolo incompatível");
    });
    await test("Timeout retorna erro de requisição", async () => {
        const name = `lasecsimul-test-timeout-${process.pid}`;
        (0, MockCoreServer_1.cleanupServerPath)(name);
        // Servidor que responde ao hello mas ignora requisições seguintes
        let acceptedSocket;
        const srv = net.createServer((s) => {
            acceptedSocket = s;
            let buf = "";
            let handshakeDone = false;
            s.on("data", (d) => {
                buf += d.toString();
                const lines = buf.split("\n");
                buf = lines.pop() ?? "";
                for (const line of lines) {
                    const t = line.trim();
                    if (!t)
                        continue;
                    const msg = JSON.parse(t);
                    if (!handshakeDone && msg.type === "hello") {
                        handshakeDone = true;
                        const r = {
                            id: msg.id, ok: true,
                            payload: { serverVersion: "0.1.0", protocolVersion: protocol_1.PROTOCOL_VERSION },
                        };
                        s.write(JSON.stringify(r) + "\n");
                    }
                    // demais requisições são ignoradas → timeout
                }
            });
        });
        await new Promise((r) => srv.listen((0, MockCoreServer_1.serverPath)(name), r));
        const client = new CoreClient_1.CoreClient(name, { requestTimeoutMs: 200 }); // timeout curto para o teste
        await client.start();
        let threw = false;
        try {
            await client.request("pausar", {});
        }
        catch {
            threw = true;
        }
        (0, MockCoreServer_1.assert)(threw, "request sem resposta deve expirar com erro");
        acceptedSocket?.destroy();
        await new Promise((r) => srv.close(() => { (0, MockCoreServer_1.cleanupServerPath)(name); r(); }));
    });
    await test("Shutdown limpa socket e rejeita requisições futuras", async () => {
        const name = `lasecsimul-test-shutdown-${process.pid}`;
        const server = new MockCoreServer_1.MockCoreServer(name);
        await server.start();
        const client = new CoreClient_1.CoreClient(name, { requestTimeoutMs: 1_000 });
        await client.start();
        await client.stop();
        let threw = false;
        try {
            await client.request("hello", {});
        }
        catch {
            threw = true;
        }
        (0, MockCoreServer_1.assert)(threw, "request após stop() deve lançar erro");
        await server.stop();
    });
    await test("Core encerrado inesperadamente rejeita requisições pendentes", async () => {
        const name = `lasecsimul-test-crash-${process.pid}`;
        (0, MockCoreServer_1.cleanupServerPath)(name);
        const srv = net.createServer((s) => {
            let buf = "";
            s.on("data", (d) => {
                buf += d.toString();
                const lines = buf.split("\n");
                buf = lines.pop() ?? "";
                for (const line of lines) {
                    const t = line.trim();
                    if (!t)
                        continue;
                    const msg = JSON.parse(t);
                    if (msg.type === "hello") {
                        const r = {
                            id: msg.id, ok: true,
                            payload: { serverVersion: "0.1.0", protocolVersion: protocol_1.PROTOCOL_VERSION },
                        };
                        s.write(JSON.stringify(r) + "\n");
                    }
                    else {
                        s.destroy(); // simula crash
                    }
                }
            });
        });
        await new Promise((r) => srv.listen((0, MockCoreServer_1.serverPath)(name), r));
        const client = new CoreClient_1.CoreClient(name, { requestTimeoutMs: 2_000 });
        await client.start();
        let threw = false;
        try {
            await client.request("start", {});
        }
        catch {
            threw = true;
        }
        (0, MockCoreServer_1.assert)(threw, "requisição pendente deve ser rejeitada quando Core fecha conexão");
        await new Promise((r) => srv.close(() => { (0, MockCoreServer_1.cleanupServerPath)(name); r(); }));
    });
    const { failed } = finish();
    process.exitCode = failed > 0 ? 1 : 0;
})();
//# sourceMappingURL=CoreClient.test.js.map
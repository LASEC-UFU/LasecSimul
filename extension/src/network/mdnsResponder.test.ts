import * as dgram from "dgram";
import Module = require("module");
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";

// mdnsResponder logs through the VS Code Output channel; outside VS Code the
// `vscode` module is replaced by a stand-in that records the logged lines.
const logged: string[] = [];
const moduleInternals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolveFilename = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "vscode" ? "vscode" : resolveFilename.call(this, request, ...rest);
};
const noop = (): void => undefined;
const statusBarItem = { show: noop, hide: noop, dispose: noop };
require.cache["vscode"] = { id: "vscode", filename: "vscode", loaded: true, exports: {
  window: {
    createOutputChannel: () => ({ appendLine: (line: string) => logged.push(line), show: noop, dispose: noop }),
    createStatusBarItem: () => statusBarItem,
    showWarningMessage: noop, showErrorMessage: noop, showInformationMessage: noop,
  },
  languages: { createDiagnosticCollection: () => ({ set: noop, delete: noop, clear: noop, dispose: noop }) },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class { constructor(public readonly id: string) {} },
} } as unknown as NodeJS.Module;
/* eslint-disable @typescript-eslint/no-var-requires */
const { initSimulationLog } = require("../diagnostics/simulationLog") as typeof import("../diagnostics/simulationLog");
const { startMdnsResponder } = require("./mdnsResponder") as typeof import("./mdnsResponder");
/* eslint-enable @typescript-eslint/no-var-requires */

/** DNS name in wire format. */
function encodeName(name: string): Buffer {
  const parts = name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** mDNS response announcing `name` -> `ip` (one A record). */
function announcement(name: string, ip: string): Buffer {
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  const fixed = Buffer.from([0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4]);
  return Buffer.concat([header, encodeName(name), fixed, Buffer.from(ip.split(".").map(Number))]);
}

/** mDNS query for the A record of `name`. */
function query(name: string): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), encodeName(name), Buffer.from([0, 1, 0, 1])]);
}

(async () => {
  const { test, finish } = createTestRunner("mDNS responder (lab-router): a lab full of other PCs");
  initSimulationLog({ subscriptions: [] } as unknown as Parameters<typeof initSimulationLog>[0]);
  // Packets are handed straight to the responder's socket (several sockets share
  // 5353 on Windows, so delivery through the network is not deterministic), and
  // everything it sends is recorded.
  const sockets: dgram.Socket[] = [];
  const bind = dgram.Socket.prototype.bind;
  dgram.Socket.prototype.bind = function (this: dgram.Socket, ...args: unknown[]) {
    if (args[0] === 5353) sockets.push(this);
    return (bind as (...values: unknown[]) => dgram.Socket).apply(this, args);
  } as typeof dgram.Socket.prototype.bind;
  const sent: Array<{ message: Buffer; port: number; address: string }> = [];
  const send = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (message: unknown, ...rest: unknown[]) {
    const port = rest.find((value) => typeof value === "number") as number;
    const address = rest.find((value) => typeof value === "string") as string;
    sent.push({ message: Buffer.from(message as Buffer), port, address });
  } as typeof dgram.Socket.prototype.send;
  const responder = startMdnsResponder({ loopbackOnly: false });
  const socket = sockets[0]!;
  const peer = { address: "10.0.67.50", family: "IPv4", port: 5353, size: 0 };
  try {
    await test("announcements of other lab PCs are learned silently: no multicast repeat, no Output line", () => {
      assert(responder !== undefined, "responder iniciado");
      for (let pc = 1; pc <= 20; pc += 1) socket.emit("message", announcement(`desktop-${pc}.local`, `10.0.67.${100 + pc}`), peer);
      assert(sent.length === 0, `não deve reenviar o nome de outras máquinas (${sent.length} envios)`);
      assert(!logged.some((line) => line.includes("desktop-")), `não deve registrar a sala inteira no Output (${logged.length} linhas)`);
    });

    await test("a name this PC asks for is answered (unicast) and logged once", () => {
      socket.emit("message", query("desktop-7.local"), peer);
      socket.emit("message", query("desktop-7.local"), peer);
      const answers = sent.filter((entry) => entry.address === peer.address && entry.port === peer.port);
      assert(answers.length === 2 && answers[0]!.message.subarray(-4).equals(Buffer.from([10, 0, 67, 107])), "resposta 10.0.67.107");
      assert(sent.every((entry) => entry.address !== "224.0.0.251"), "nenhum multicast");
      assert(logged.filter((line) => line.includes("desktop-7.local -> 10.0.67.107")).length === 1, "uma linha no Output");
    });
  } finally {
    responder?.dispose();
    dgram.Socket.prototype.send = send;
    dgram.Socket.prototype.bind = bind;
  }
  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

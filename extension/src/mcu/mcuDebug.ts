import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import { state } from "../state";
import { collectMcuFirmwareTargets, McuCommandOptions } from "./mcuCommands";

const activeDebugSessions = new Set<string>();
const stoppedDebugSessions = new Set<string>();

function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("porta GDB indisponível")); return; }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function selectSymbolFile(firmwarePath: string): Promise<string | undefined> {
  if (path.extname(firmwarePath).toLowerCase() === ".elf") return firmwarePath;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Selecionar ELF com símbolos",
    filters: { "Firmware ELF": ["elf", "axf", "out"] },
  });
  return picked?.[0]?.fsPath;
}

export async function debugMcuFirmwareCommand(options: McuCommandOptions): Promise<void> {
  if (!state.coreClient) { void vscode.window.showErrorMessage("LasecSimul Core não está conectado."); return; }
  const targets = collectMcuFirmwareTargets(options);
  if (targets.length === 0) { void vscode.window.showErrorMessage("Nenhum MCU com firmware configurado."); return; }
  const selected = targets.length === 1 ? targets[0] : await vscode.window.showQuickPick(
    targets.map((target) => ({ label: target.label, description: target.firmwarePath, target })),
    { placeHolder: "Selecione o MCU para depurar" }
  ).then((item) => item?.target);
  if (!selected) return;
  const instanceId = await selected.resolveCoreId();
  if (!instanceId) { void vscode.window.showErrorMessage("A instância do MCU ainda não existe no Core."); return; }
  const symbolFile = await selectSymbolFile(selected.firmwarePath);
  if (!symbolFile) return;

  const cpptools = vscode.extensions.getExtension("ms-vscode.cpptools");
  if (!cpptools) {
    void vscode.window.showErrorMessage("Instale a extensão Microsoft C/C++ para usar o depurador GDB do LasecSimul.");
    return;
  }
  const port = await freeTcpPort();
  await state.coreClient.loadMcuFirmware(instanceId, selected.firmwarePath, selected.qemuBinaryOverride,
    { gdbPort: port, startPaused: true });

  const debugSettings = vscode.workspace.getConfiguration("lasecsimul.debug");
  const gdbPath = debugSettings.get<string>("gdbPath", "xtensa-esp32-elf-gdb");
  const configuration: vscode.DebugConfiguration = {
    name: `LasecSimul: ${selected.label}`,
    type: "cppdbg",
    request: "launch",
    program: symbolFile,
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(symbolFile),
    MIMode: "gdb",
    miDebuggerPath: gdbPath,
    miDebuggerServerAddress: `127.0.0.1:${port}`,
    stopAtEntry: true,
    externalConsole: false,
    lasecsimulMcuInstanceId: instanceId,
  };
  const started = await vscode.debug.startDebugging(undefined, configuration);
  if (!started) {
    await state.coreClient.stopMcuFirmware(instanceId).catch(() => undefined);
    void vscode.window.showErrorMessage("O VS Code não conseguiu iniciar a sessão GDB.");
  }
}

export function registerMcuDebugTracking(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory("cppdbg", {
    createDebugAdapterTracker(session) {
      const instanceId = session.configuration.lasecsimulMcuInstanceId;
      if (typeof instanceId !== "string") return undefined;
      activeDebugSessions.add(session.id);
      stoppedDebugSessions.add(session.id); // QEMU nasceu com -S
      let instructionStep = false;
      return {
        onWillReceiveMessage(message: { type?: string; command?: string }) {
          if (message.type === "request") {
            instructionStep = message.command === "next" || message.command === "stepIn" || message.command === "stepOut";
          }
        },
        onDidSendMessage(message: { type?: string; event?: string }) {
          if (message.type !== "event" || !state.coreClient) return;
          if (message.event === "stopped") {
            stoppedDebugSessions.add(session.id);
            void state.coreClient.pause().then(() => state.coreClient?.settleMcuDebug(instanceId));
            instructionStep = false;
          }
          else if (message.event === "continued" && !instructionStep) {
            stoppedDebugSessions.delete(session.id);
            if (stoppedDebugSessions.size === 0) void state.coreClient.resume();
          }
          else if (message.event === "terminated" || message.event === "exited") {
            activeDebugSessions.delete(session.id);
            stoppedDebugSessions.delete(session.id);
            void state.coreClient.stopMcuFirmware(instanceId);
            if (activeDebugSessions.size > 0 && stoppedDebugSessions.size === 0) void state.coreClient.resume();
            else void state.coreClient.pause();
          }
        },
      };
    },
  }));
}

import * as fs from "fs";
import * as vscode from "vscode";
import { coreInstanceIdByComponentId, state } from "../state";
import { CoreUartTransport } from "../uart/CoreUartTransport";

const TYPE_ID = "peripherals.serialterm";

export class SerialTerminalManager implements vscode.Disposable {
  private readonly open = new Set<string>();
  private readonly transport = new CoreUartTransport();
  private readonly hiddenData = new Map<string, number[]>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor() {}

  toggle(componentId: string): void {
    const component = state.schematicState.components.find((entry) => entry.id === componentId && entry.typeId === TYPE_ID);
    if (!component) throw new Error("Serial Terminal não encontrado.");
    if (this.open.delete(componentId)) this.status(componentId, false);
    else {
      this.open.add(componentId); this.status(componentId, true);
      const buffered = this.hiddenData.get(componentId);
      if (buffered?.length) {
        state.schematicPanel?.postMessage({ version: 1, type: "serialTerminalData", componentId,
          dataHex: Buffer.from(buffered).toString("hex"), simulationTimeNs: 0 });
        this.hiddenData.delete(componentId);
      }
    }
  }

  close(componentId: string): void { if (this.open.delete(componentId)) this.status(componentId, false); }
  isOpen(componentId: string): boolean { return this.open.has(componentId); }

  async write(componentId: string, data: Uint8Array): Promise<void> {
    if (!this.open.has(componentId)) throw new Error("Abra o Serial Terminal antes de enviar dados.");
    if (state.simulationStatus === "stopped" || !coreInstanceIdByComponentId.has(componentId)) throw new Error("Inicie a simulação antes de enviar dados.");
    await this.transport.write(componentId, data);
  }

  async loadFile(componentId: string): Promise<void> {
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { "Todos os arquivos": ["*"] } });
    if (!selected?.[0]) return;
    const bytes = fs.readFileSync(selected[0].fsPath);
    state.schematicPanel?.postMessage({ version: 1, type: "serialTerminalLoadedFile", componentId, dataHex: bytes.toString("hex") });
  }

  async saveLog(text: string): Promise<void> {
    const selected = await vscode.window.showSaveDialog({ filters: { "Texto": ["txt"], "Todos os arquivos": ["*"] } });
    if (selected) fs.writeFileSync(selected.fsPath, text, "utf8");
  }

  sync(): void {
    const present = new Set(state.schematicState.components.filter((entry) => entry.typeId === TYPE_ID).map((entry) => entry.id));
    for (const id of [...this.open]) if (!present.has(id)) this.open.delete(id);
    for (const id of [...this.hiddenData.keys()]) if (!present.has(id)) this.hiddenData.delete(id);
    for (const id of present) if (this.open.has(id)) this.status(id, true);
    this.updatePolling();
  }

  private status(componentId: string, opened: boolean, error?: string): void {
    state.schematicPanel?.postMessage({ version: 1, type: "serialTerminalStatus", componentId, opened,
      online: state.simulationStatus !== "stopped" && coreInstanceIdByComponentId.has(componentId), ...(error ? { error } : {}) });
  }

  private async poll(): Promise<void> {
    if (this.polling) return; this.polling = true;
    try {
      for (const componentId of state.schematicState.components.filter((entry) => entry.typeId === TYPE_ID).map((entry) => entry.id)) {
        if (state.simulationStatus !== "running" || !coreInstanceIdByComponentId.has(componentId)) continue;
        try {
          const batch = await this.transport.read(componentId);
          // Achado 2026-07-22 (baud alto perdendo dados): overflow do buffer RX não lança mais (ver
          // `CoreUartTransport.read`) -- reporta o drop como aviso, mas continua processando os
          // bytes que sobreviveram em `batch.data` (antes, o lote inteiro era descartado junto).
          if (batch.droppedBytes > 0) this.status(componentId, true, `Buffer UART RX excedido: ${batch.droppedBytes} byte(s) perdido(s).`);
          if (!batch.data.byteLength) continue;
          if (this.open.has(componentId)) state.schematicPanel?.postMessage({ version: 1, type: "serialTerminalData", componentId,
            dataHex: Buffer.from(batch.data).toString("hex"), simulationTimeNs: batch.simulationTimeNs });
          else {
            const hidden = this.hiddenData.get(componentId) ?? [];
            hidden.push(...batch.data); if (hidden.length > 100_000) hidden.splice(0, hidden.length - 100_000);
            this.hiddenData.set(componentId, hidden);
          }
        } catch (error) { this.status(componentId, true, error instanceof Error ? error.message : String(error)); }
      }
    } finally { this.polling = false; }
  }

  updateSimulationState(): void {
    for (const id of this.open) this.status(id, true);
    this.updatePolling();
  }
  private updatePolling(): void {
    const shouldPoll = state.simulationStatus === "running" &&
      state.schematicState.components.some((entry) => entry.typeId === TYPE_ID);
    if (shouldPoll && !this.timer) this.timer = setInterval(() => void this.poll(), 10);
    else if (!shouldPoll && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
  dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.open.clear(); }
}

export let serialTerminalManager: SerialTerminalManager | undefined;
export function initializeSerialTerminal(context: vscode.ExtensionContext): SerialTerminalManager {
  serialTerminalManager = new SerialTerminalManager(); context.subscriptions.push(serialTerminalManager); return serialTerminalManager;
}

import * as vscode from "vscode";
import { coreInstanceIdByComponentId, state } from "../state";

const TYPE_ID = "peripherals.serialport";

interface SerialPortStatus {
  opened: boolean;
  online: boolean;
  rxBytes: number;
  txBytes: number;
  error?: string;
}

/** Controla somente o ciclo de vida/UI da porta. O transporte COM/TTY permanece no plugin nativo,
 * junto do UART simulado, para que bytes do host sejam temporizados pelos pinos TX/RX. */
export class SerialPortManager implements vscode.Disposable {
  private readonly statusByComponentId = new Map<string, SerialPortStatus>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor() {}

  async toggle(componentId: string): Promise<void> {
    const component = state.schematicState.components.find((entry) => entry.id === componentId && entry.typeId === TYPE_ID);
    if (!component) throw new Error("Serial Port não encontrado.");
    const client = state.coreClient;
    const coreId = coreInstanceIdByComponentId.get(componentId);
    if (!client || !coreId || state.simulationStatus === "stopped") throw new Error("Inicie a simulação antes de abrir a porta serial.");
    const opened = Boolean(await client.getProperty(coreId, "port_is_open"));
    await client.setProperty(coreId, "port_open", !opened);
    await this.refresh(componentId, coreId);
  }

  sync(): void {
    const present = new Set(state.schematicState.components.filter((entry) => entry.typeId === TYPE_ID).map((entry) => entry.id));
    for (const id of [...this.statusByComponentId.keys()]) if (!present.has(id)) this.statusByComponentId.delete(id);
    for (const id of present) {
      const coreId = coreInstanceIdByComponentId.get(id);
      if (coreId && state.simulationStatus !== "stopped") void this.refresh(id, coreId);
      else this.publish(id, { opened: false, online: false, rxBytes: 0, txBytes: 0 });
    }
    this.updatePolling();
  }

  updateSimulationState(): void { this.sync(); }

  private updatePolling(): void {
    const shouldPoll = state.simulationStatus !== "stopped" &&
      state.schematicState.components.some((entry) => entry.typeId === TYPE_ID);
    if (shouldPoll && !this.timer) this.timer = setInterval(() => void this.poll(), 250);
    else if (!shouldPoll && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private async poll(): Promise<void> {
    if (this.polling || state.simulationStatus === "stopped") return;
    this.polling = true;
    try {
      for (const component of state.schematicState.components.filter((entry) => entry.typeId === TYPE_ID)) {
        const coreId = coreInstanceIdByComponentId.get(component.id);
        if (coreId) await this.refresh(component.id, coreId);
      }
    } finally { this.polling = false; }
  }

  private async refresh(componentId: string, coreId: string): Promise<void> {
    try {
      const client = state.coreClient;
      if (!client) return;
      const [openedValue, errorValue, rxBytesValue, txBytesValue] = await Promise.all([
        client.getProperty(coreId, "port_is_open"),
        client.getProperty(coreId, "port_error"),
        client.getProperty(coreId, "port_rx_bytes"),
        client.getProperty(coreId, "port_tx_bytes"),
      ]);
      const error = String(errorValue ?? "").trim();
      this.publish(componentId, { opened: Boolean(openedValue), online: true, rxBytes: Number(rxBytesValue) || 0, txBytes: Number(txBytesValue) || 0, ...(error ? { error } : {}) });
    } catch (cause) {
      this.publish(componentId, { opened: false, online: true, rxBytes: 0, txBytes: 0, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  private publish(componentId: string, status: SerialPortStatus): void {
    const previous = this.statusByComponentId.get(componentId);
    if (previous?.opened === status.opened && previous.online === status.online && previous.rxBytes === status.rxBytes && previous.txBytes === status.txBytes && previous.error === status.error) return;
    this.statusByComponentId.set(componentId, status);
    state.schematicPanel?.postMessage({ version: 1, type: "serialPortStatus", componentId, ...status });
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.statusByComponentId.clear(); }
}

export let serialPortManager: SerialPortManager | undefined;
export function initializeSerialPort(context: vscode.ExtensionContext): SerialPortManager {
  serialPortManager = new SerialPortManager();
  context.subscriptions.push(serialPortManager);
  return serialPortManager;
}

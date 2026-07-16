import type * as vscode from "vscode";
import {
  LASECSIMUL_INTEROP_API_VERSION, LasecPlotCloseEvent, LasecPlotConnection,
  LasecPlotDataPacket, LasecPlotEndpointDescriptor, LasecPlotMode, LasecSimulInteropApi,
} from "./api";

type Listener<T> = (value: T) => unknown;
class Signal<T> {
  private listeners = new Set<Listener<T>>();
  readonly event: vscode.Event<T> = ((listener: Listener<T>, thisArgs?: unknown, disposables?: vscode.Disposable[]) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    this.listeners.add(bound);
    const disposable = { dispose: () => this.listeners.delete(bound) };
    disposables?.push(disposable);
    return disposable;
  }) as vscode.Event<T>;
  fire(value: T): void { for (const listener of [...this.listeners]) listener(value); }
  clear(): void { this.listeners.clear(); }
}

export interface LasecPlotTransport {
  read(componentId: string): Promise<{ data: Uint8Array; simulationTimeNs: number }>;
  write(componentId: string, data: Uint8Array): Promise<void>;
}

export interface EndpointRegistration {
  id: string;
  componentId: string;
  name: string;
  projectId?: string;
  simulationId: string;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  mode: LasecPlotMode;
}

interface EndpointState {
  registration: EndpointRegistration;
  published: boolean;
  online: boolean;
  sequence: number;
  connections: Set<Connection>;
  writer?: Connection;
}

class Connection implements LasecPlotConnection {
  private closed = false;
  private readonly dataSignal = new Signal<Uint8Array>();
  private readonly packetSignal = new Signal<LasecPlotDataPacket>();
  private readonly closeSignal = new Signal<LasecPlotCloseEvent>();
  readonly onData = this.dataSignal.event;
  readonly onPacket = this.packetSignal.event;
  readonly onDidClose = this.closeSignal.event;

  constructor(private broker: LasecPlotBroker, private state: EndpointState, readonly writable: boolean) {}
  get endpoint(): LasecPlotEndpointDescriptor { return this.broker.describe(this.state); }
  deliver(packet: LasecPlotDataPacket): void {
    if (this.closed) return;
    this.packetSignal.fire(packet);
    this.dataSignal.fire(packet.data.slice());
  }
  async write(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("A conexão LasecPlot está fechada.");
    if (!this.writable) throw new Error("Este endpoint LasecPlot está em modo somente leitura.");
    await this.broker.write(this.state, this, data);
  }
  async close(): Promise<void> { this.finish("client-closed"); }
  dispose(): void { this.finish("disposed"); }
  finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.broker.detach(this.state, this);
    this.closeSignal.fire({ reason });
    this.dataSignal.clear(); this.packetSignal.clear(); this.closeSignal.clear();
  }
}

export class LasecPlotBroker implements LasecSimulInteropApi, vscode.Disposable {
  readonly apiVersion = LASECSIMUL_INTEROP_API_VERSION;
  private readonly changed = new Signal<void>();
  readonly onDidChangeLasecPlotEndpoints = this.changed.event;
  private readonly endpoints = new Map<string, EndpointState>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(private readonly transport: LasecPlotTransport, pollIntervalMs = 10) {
    this.timer = setInterval(() => void this.poll(), pollIntervalMs);
  }

  register(registration: EndpointRegistration): void {
    const current = this.endpoints.get(registration.id);
    if (current) {
      const changed = JSON.stringify(current.registration) !== JSON.stringify(registration);
      current.registration = registration;
      if (changed && current.published) this.changed.fire();
    }
    else this.endpoints.set(registration.id, { registration, published: false, online: false, sequence: 0, connections: new Set() });
  }
  remove(id: string): void {
    const state = this.endpoints.get(id);
    if (!state) return;
    this.closeConnections(state, "device-removed");
    this.endpoints.delete(id);
    if (state.published) this.changed.fire();
  }
  publish(id: string): void {
    const state = this.required(id);
    if (!state.registration.name.trim()) throw new Error("Nome da fonte não pode ficar vazio.");
    if (!state.online) throw new Error("Inicie a simulação antes de abrir o LasecPlot.");
    if (state.published) throw new Error("O endpoint LasecPlot já está aberto.");
    state.published = true; state.sequence = 0; this.changed.fire();
  }
  unpublish(id: string, reason = "device-closed"): void {
    const state = this.required(id);
    if (!state.published) return;
    state.published = false; this.closeConnections(state, reason); this.changed.fire();
  }
  setOnline(id: string, online: boolean): void {
    const state = this.endpoints.get(id); if (!state || state.online === online) return;
    state.online = online;
    if (!online && state.published) { state.published = false; this.closeConnections(state, "simulation-stopped"); }
    this.changed.fire();
  }
  isPublished(id: string): boolean { return this.endpoints.get(id)?.published === true; }
  describe(state: EndpointState): LasecPlotEndpointDescriptor {
    const r = state.registration;
    const duplicateName = [...this.endpoints.values()].some((other) => other !== state && other.registration.name === r.name);
    return { id: r.id, name: r.name, displayName: duplicateName ? `LasecSimul — ${r.name} — ${r.componentId}` : `LasecSimul — ${r.name}`, projectId: r.projectId,
      simulationId: r.simulationId, componentId: r.componentId, baudRate: r.baudRate, dataBits: r.dataBits,
      stopBits: r.stopBits, parity: "none", readable: true, writable: r.mode === "bidirectional",
      online: state.online, opened: state.published, connectedClients: state.connections.size };
  }
  async listLasecPlotEndpoints(): Promise<LasecPlotEndpointDescriptor[]> {
    return [...this.endpoints.values()].filter((state) => state.published).map((state) => this.describe(state));
  }
  async openLasecPlotEndpoint(id: string, options: { writable?: boolean } = {}): Promise<LasecPlotConnection> {
    const state = this.required(id);
    if (!state.published || !state.online) throw new Error("O endpoint LasecPlot não está disponível.");
    const wantsWriter = options.writable === true;
    if (wantsWriter && state.registration.mode !== "bidirectional") throw new Error("Este endpoint LasecPlot está em modo somente leitura.");
    if (wantsWriter && state.writer) throw new Error("Já existe um cliente escritor conectado a este endpoint.");
    const connection = new Connection(this, state, wantsWriter);
    state.connections.add(connection); if (wantsWriter) state.writer = connection; this.changed.fire();
    return connection;
  }
  async write(state: EndpointState, connection: Connection, data: Uint8Array): Promise<void> {
    if (state.writer !== connection) throw new Error("O cliente não possui a reserva de escrita deste endpoint.");
    if (!state.online || !state.published) throw new Error("O endpoint LasecPlot está fechado.");
    if (data.byteLength === 0) return;
    await this.transport.write(state.registration.componentId, data.slice());
  }
  detach(state: EndpointState, connection: Connection): void {
    state.connections.delete(connection); if (state.writer === connection) state.writer = undefined; this.changed.fire();
  }
  private required(id: string): EndpointState { const state = this.endpoints.get(id); if (!state) throw new Error(`Endpoint LasecPlot desconhecido: ${id}`); return state; }
  private closeConnections(state: EndpointState, reason: string): void { for (const c of [...state.connections]) c.finish(reason); state.writer = undefined; }
  private async poll(): Promise<void> {
    if (this.polling) return; this.polling = true;
    try {
      for (const state of this.endpoints.values()) {
        if (!state.published || !state.online || state.connections.size === 0) continue;
        let batch: { data: Uint8Array; simulationTimeNs: number };
        try { batch = await this.transport.read(state.registration.componentId); }
        catch {
          state.published = false;
          this.closeConnections(state, "transport-error");
          this.changed.fire();
          continue;
        }
        if (batch.data.byteLength === 0) continue;
        const packet: LasecPlotDataPacket = { endpointId: state.registration.id, sequence: state.sequence++,
          simulationTimeNs: batch.simulationTimeNs, direction: "mcu-to-client", encoding: "binary", data: batch.data.slice() };
        for (const connection of state.connections) connection.deliver(packet);
      }
    } finally { this.polling = false; }
  }
  dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; for (const state of this.endpoints.values()) this.closeConnections(state, "extension-deactivated"); this.endpoints.clear(); this.changed.clear(); }
}

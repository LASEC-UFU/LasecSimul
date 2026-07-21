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

/** Achado 2026-07-21: `displayName` chegava ao consumidor como "LasecSimul — LasecPlot-1" e, com o
 * prefixo extra que a própria LasecPlot ainda adicionava (`endpointToSourceOption` no repositório
 * LasecPlot), aparecia como "LasecSimul: LasecSimul — LasecPlot-1@115200" na UI -- origem, ID interno
 * e baud rate junto do nome, quando só o nome amigável era esperado. O rótulo padrão de um
 * componente novo segue "<NomeDoCatálogo><contador>" sem separador (ver
 * `catalog/catalogMerge.ts`/`ui/webview/main.ts::nextComponentLabel`, ex: "LasecPlot-1") -- insere
 * espaço na fronteira minúscula->maiúscula e ao redor do hífen antes do número, deixando
 * "LasecPlot-1" -> "Lasec Plot - 1". Nomes customizados pelo usuário sem essas fronteiras (ex:
 * "Temperatura") passam inalterados. */
function humanizeDeviceName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/-(\d+)\s*$/, " - $1");
}

export interface LasecPlotTransport {
  read(componentId: string): Promise<{ data: Uint8Array; simulationTimeNs: number }>;
  write(componentId: string, data: Uint8Array): Promise<number>;
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
  parity: "none" | "even" | "odd";
  mode: LasecPlotMode;
}

interface EndpointState {
  registration: EndpointRegistration;
  published: boolean;
  online: boolean;
  sequence: number;
  connections: Set<Connection>;
  writer?: Connection;
  /** Diagnóstico: últimos bytes LIDOS do Core pra este endpoint (independente de estar publicado ou
   * ter cliente conectado, ver `poll()`) -- só existe pra responder "o problema é aqui (LasecSimul)
   * ou na outra extensão (LasecPlot)?" (comando "LasecSimul: List LasecPlot Endpoints"). Buffer
   * circular limitado por `RECENT_BYTES_CAP`. */
  recentBytes: Uint8Array;
}
const RECENT_BYTES_CAP = 256;
function appendCapped(previous: Uint8Array, incoming: Uint8Array, cap: number): Uint8Array {
  const combined = new Uint8Array(previous.length + incoming.length);
  combined.set(previous, 0);
  combined.set(incoming, previous.length);
  return combined.length <= cap ? combined : combined.slice(combined.length - cap);
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
    if (packet.direction === "mcu-to-client") this.dataSignal.fire(packet.data.slice());
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
  private readonly pollIntervalMs: number;

  constructor(private readonly transport: LasecPlotTransport, pollIntervalMs = 10) {
    this.pollIntervalMs = pollIntervalMs;
  }

  register(registration: EndpointRegistration): void {
    const current = this.endpoints.get(registration.id);
    if (current) {
      const changed = JSON.stringify(current.registration) !== JSON.stringify(registration);
      current.registration = registration;
      if (changed && current.published) this.changed.fire();
    }
    else this.endpoints.set(registration.id, { registration, published: false, online: false, sequence: 0, connections: new Set(), recentBytes: new Uint8Array(0) });
  }
  remove(id: string): void {
    const state = this.endpoints.get(id);
    if (!state) return;
    this.closeConnections(state, "device-removed");
    this.endpoints.delete(id);
    if (state.published) this.changed.fire();
    this.updatePolling();
  }
  publish(id: string): void {
    const state = this.required(id);
    if (!state.registration.name.trim()) throw new Error("Nome da fonte não pode ficar vazio.");
    // Abrir o endpoint (pra outras extensões do VSCode conseguirem se conectar) é INDEPENDENTE de a
    // simulação estar rodando -- pedido real: "o sistema não precisa estar em run para ele abrir a
    // comunicação com outras extensões do vscode". `describe()`/`online` continua reportando
    // separadamente se há dado ao vivo fluindo agora (`state.online`, ligado a
    // `simulationStatus`/`coreInstanceIdByComponentId` em `manager.ts::sync`) -- só a PUBLICAÇÃO em
    // si (o endpoint existir/aceitar conexão) não devia depender disso.
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
    this.updatePolling();
  }
  isPublished(id: string): boolean { return this.endpoints.get(id)?.published === true; }
  describe(state: EndpointState): LasecPlotEndpointDescriptor {
    const r = state.registration;
    const duplicateName = [...this.endpoints.values()].some((other) => other !== state && other.registration.name === r.name);
    const friendlyName = humanizeDeviceName(r.name);
    return { id: r.id, name: r.name, displayName: duplicateName ? `${friendlyName} (${r.componentId})` : friendlyName, projectId: r.projectId,
      simulationId: r.simulationId, componentId: r.componentId, baudRate: r.baudRate, dataBits: r.dataBits,
      stopBits: r.stopBits, parity: r.parity, readable: true, writable: r.mode === "bidirectional",
      online: state.online, opened: state.published, connectedClients: state.connections.size };
  }
  async listLasecPlotEndpoints(): Promise<LasecPlotEndpointDescriptor[]> {
    return [...this.endpoints.values()].filter((state) => state.published).map((state) => this.describe(state));
  }
  /** MESMOS descritores de `listLasecPlotEndpoints()`, mas sem o filtro `published` -- só pra
   * diagnóstico interno (comando "LasecSimul: List LasecPlot Endpoints", ver `extension.ts`), nunca
   * exposto na `LasecSimulInteropApi` pública: um endpoint registrado mas NUNCA aberto ainda mostra
   * `opened:false` aqui, deixando claro se o problema é "o dispositivo nem chegou a existir pro
   * broker" (registro ausente) vs. "existe mas 'Abrir' nunca publicou" (registrado, `opened:false`)
   * vs. "publicou certo, quem não está achando é o consumidor externo" (`opened:true` aqui). */
  debugListAllEndpoints(): LasecPlotEndpointDescriptor[] {
    return [...this.endpoints.values()].map((state) => this.describe(state));
  }
  /** Diagnóstico (achado 2026-07-18: conexão funciona, mas os caracteres chegam corrompidos no
   * consumidor externo) -- devolve os últimos bytes que este broker LEU do Core pra este endpoint,
   * pra comparar com o que o consumidor externo mostra. Se os bytes aqui já saem estranhos, o
   * problema é do lado do LasecSimul (UART/firmware/hex-encoding); se saem corretos aqui mas
   * aparecem corrompidos do outro lado, o problema é do consumidor externo. */
  debugRecentBytes(id: string): Uint8Array | undefined {
    return this.endpoints.get(id)?.recentBytes;
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
    const simulationTimeNs = await this.transport.write(state.registration.componentId, data.slice());
    const packet: LasecPlotDataPacket = { endpointId: state.registration.id, sequence: state.sequence++, simulationTimeNs,
      direction: "client-to-mcu", encoding: "binary", data: data.slice() };
    for (const client of state.connections) client.deliver(packet);
  }
  detach(state: EndpointState, connection: Connection): void {
    state.connections.delete(connection); if (state.writer === connection) state.writer = undefined; this.changed.fire();
  }
  private required(id: string): EndpointState { const state = this.endpoints.get(id); if (!state) throw new Error(`Endpoint LasecPlot desconhecido: ${id}`); return state; }
  private updatePolling(): void {
    const shouldPoll = [...this.endpoints.values()].some((state) => state.online);
    if (shouldPoll && !this.timer) this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    else if (!shouldPoll && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
  private closeConnections(state: EndpointState, reason: string): void { for (const c of [...state.connections]) c.finish(reason); state.writer = undefined; }
  private async poll(): Promise<void> {
    if (this.polling) return; this.polling = true;
    try {
      for (const state of this.endpoints.values()) {
        if (!state.online) continue;
        let batch: { data: Uint8Array; simulationTimeNs: number };
        try { batch = await this.transport.read(state.registration.componentId); }
        catch {
          // Bug real corrigido 2026-07-18 ("Abrir parece travado, aberto volta pra false sozinho"):
          // um erro de leitura (ex: overflow do buffer RX -- ESPERADO enquanto ninguém está lendo
          // ainda, ver `CoreUartTransport.read`) fechava o endpoint inteiro aqui. Como o poll roda a
          // cada `pollIntervalMs` (10ms) sempre que `online=true`, isso formava um loop "Abrir
          // publica -> próximo tick de poll acha overflow -> despublica de novo" -- na prática o
          // endpoint nunca ficava aberto tempo suficiente pra UI/consumidor externo perceberem.
          // `serialterm/manager.ts::poll` já trata o MESMO erro assim (reporta, mas mantém aberto) --
          // só este lote de bytes foi perdido, não é motivo pra fechar a conexão inteira. Fechamento
          // de verdade continua acontecendo por `setOnline(id,false)` quando o Core realmente cai.
          continue;
        }
        if (batch.data.byteLength === 0) continue;
        // Diagnóstico (ver `debugRecentBytes`) -- captura ANTES do "sem cliente: descarta" abaixo,
        // pra sempre refletir o que o LasecSimul de fato leu do Core, independente de ter alguém
        // ouvindo agora.
        state.recentBytes = appendCapped(state.recentBytes, batch.data, RECENT_BYTES_CAP);
        if (!state.published || state.connections.size === 0) continue; // fechado/sem cliente: drena e descarta
        const packet: LasecPlotDataPacket = { endpointId: state.registration.id, sequence: state.sequence++,
          simulationTimeNs: batch.simulationTimeNs, direction: "mcu-to-client", encoding: "binary", data: batch.data.slice() };
        for (const connection of state.connections) connection.deliver(packet);
      }
    } finally { this.polling = false; }
  }
  dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; for (const state of this.endpoints.values()) this.closeConnections(state, "extension-deactivated"); this.endpoints.clear(); this.changed.clear(); }
}

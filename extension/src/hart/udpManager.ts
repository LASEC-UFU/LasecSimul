import * as dgram from "dgram";
import * as vscode from "vscode";
import { coreInstanceIdByComponentId, state } from "../state";

const HART_UDP_TYPE = "peripherals.udp";

interface BoundEndpoint {
  socket: dgram.Socket;
  address: string;
  port: number;
}

/** External UDP adapter for the same HART endpoint already used by the
 * schematic. It owns only sockets; command execution stays in the canonical
 * Core HART engine through `hartTransact`. */
export class HartUdpManager implements vscode.Disposable {
  private readonly endpoints = new Map<string, BoundEndpoint>();

  sync(): void {
    const wanted = state.simulationStatus === "stopped" ? [] : state.schematicState.components
      .filter((component) => component.typeId === HART_UDP_TYPE);
    const wantedIds = new Set(wanted.map((component) => component.id));
    for (const [componentId, endpoint] of this.endpoints) {
      if (wantedIds.has(componentId)) continue;
      endpoint.socket.close();
      this.endpoints.delete(componentId);
    }
    for (const component of wanted) this.ensureBound(component.id, String(component.properties.endpoint ?? "127.0.0.1"), Number(component.properties.udpPort ?? 5094));
  }

  private ensureBound(componentId: string, address: string, port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const existing = this.endpoints.get(componentId);
    if (existing?.address === address && existing.port === port) return;
    if (existing) { existing.socket.close(); this.endpoints.delete(componentId); }
    const socket = dgram.createSocket("udp4");
    socket.on("message", (frame, remote) => void this.respond(componentId, socket, frame, remote));
    socket.on("error", (error) => {
      vscode.window.showWarningMessage(`UDP Port ${address}:${port}: ${error.message}`);
      socket.close();
      this.endpoints.delete(componentId);
    });
    socket.bind(port, address, () => this.endpoints.set(componentId, { socket, address, port }));
  }

  private async respond(componentId: string, socket: dgram.Socket, frame: Buffer, remote: dgram.RemoteInfo): Promise<void> {
    const transport = state.schematicState.components.find((entry) => entry.id === componentId && entry.typeId === HART_UDP_TYPE);
    const targetId = String(transport?.properties.hart_device_id ?? "").trim();
    const target = state.schematicState.components.find((entry) => entry.id === targetId && entry.typeId.startsWith("protocol.hart.device."));
    const coreId = target ? coreInstanceIdByComponentId.get(target.id) : undefined;
    const client = state.coreClient;
    if (!client || !coreId || frame.length === 0 || frame.length > 272) return;
    try {
      const response = await client.hartTransact(coreId, frame.toString("hex"));
      const reply = Buffer.from(response.frameHex, "hex");
      socket.send(reply, remote.port, remote.address);
    } catch {
      // A malformed request receives no fabricated reply. The Core is the
      // only authority for HART response status and frame construction.
    }
  }

  dispose(): void {
    for (const endpoint of this.endpoints.values()) endpoint.socket.close();
    this.endpoints.clear();
  }
}

export let hartUdpManager: HartUdpManager | undefined;
export function initializeHartUdp(context: vscode.ExtensionContext): HartUdpManager {
  hartUdpManager = new HartUdpManager();
  context.subscriptions.push(hartUdpManager);
  return hartUdpManager;
}

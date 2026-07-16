import * as crypto from "crypto";
import * as vscode from "vscode";
import { coreInstanceIdByComponentId, state } from "../state";
import { LasecSimulInteropApi } from "./api";
import { EndpointRegistration, LasecPlotBroker, LasecPlotTransport } from "./broker";

const TYPE_ID = "peripherals.lasecplot";

function shortHash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 20); }
function contextId(): string {
  const workspace = vscode.workspace.workspaceFile?.fsPath ?? vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).join("|") ?? "untitled";
  return shortHash(`${process.env.USERDOMAIN ?? ""}/${process.env.USERNAME ?? process.env.USER ?? "user"}/${workspace}`);
}

class CoreTransport implements LasecPlotTransport {
  async read(componentId: string): Promise<{ data: Uint8Array; simulationTimeNs: number }> {
    const client = state.coreClient; const coreId = coreInstanceIdByComponentId.get(componentId);
    if (!client || !coreId) return { data: new Uint8Array(), simulationTimeNs: 0 };
    const hex = String(await client.getProperty(coreId, "interop_rx_hex") ?? "");
    const time = await client.getSimulationTime();
    return { data: Uint8Array.from(Buffer.from(hex, "hex")), simulationTimeNs: time };
  }
  async write(componentId: string, data: Uint8Array): Promise<void> {
    const client = state.coreClient; const coreId = coreInstanceIdByComponentId.get(componentId);
    if (!client || !coreId) throw new Error("Dispositivo LasecPlot não está inicializado no Core.");
    for (let offset = 0; offset < data.byteLength; offset += 4096) {
      const chunk = data.slice(offset, offset + 4096);
      await client.setProperty(coreId, "interop_tx_hex", Buffer.from(chunk).toString("hex"));
    }
  }
}

export class LasecPlotManager implements vscode.Disposable {
  private readonly simulationId = `session-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  private readonly projectId = contextId();
  readonly broker = new LasecPlotBroker(new CoreTransport());
  readonly api: LasecSimulInteropApi = {
    apiVersion: this.broker.apiVersion,
    onDidChangeLasecPlotEndpoints: this.broker.onDidChangeLasecPlotEndpoints,
    listLasecPlotEndpoints: () => { this.sync(); return this.broker.listLasecPlotEndpoints(); },
    openLasecPlotEndpoint: (id, options) => { this.sync(); return this.broker.openLasecPlotEndpoint(id, options); },
  };
  private knownEndpointIds = new Set<string>();

  constructor() {
    this.broker.onDidChangeLasecPlotEndpoints(() => {
      void this.broker.listLasecPlotEndpoints().then((endpoints) => {
        const byComponent = new Map(endpoints.map((endpoint) => [endpoint.componentId, endpoint]));
        for (const component of state.schematicState.components.filter((entry) => entry.typeId === TYPE_ID)) {
          const endpoint = byComponent.get(component.id);
          state.schematicPanel?.postMessage({ version: 1, type: "lasecPlotStatus", componentId: component.id,
            opened: Boolean(endpoint), clients: endpoint?.connectedClients ?? 0 });
        }
      });
    });
  }

  sync(): Map<string, string> {
    const ids = new Map<string, string>();
    const present = new Set<string>();
    for (const component of state.schematicState.components.filter((c) => c.typeId === TYPE_ID)) {
      const endpointId = `lasecsimul://workspace/${this.projectId}/simulation/${this.simulationId}/lasecplot/${encodeURIComponent(component.id)}`;
      present.add(endpointId); ids.set(component.id, endpointId);
      const registration: EndpointRegistration = {
        id: endpointId, componentId: component.id,
        // O rótulo do bloco é a identidade visível canônica; `source_name` é sincronizado com ele
        // pela UI para que painel de propriedades, schematic e extensão consumidora nunca divirjam.
        name: String(component.label ?? component.properties.source_name ?? "LasecPlot").trim(),
        projectId: this.projectId, simulationId: this.simulationId,
        baudRate: Number(component.properties.baudrate ?? 115200), dataBits: Number(component.properties.data_bits ?? 8),
        stopBits: Number(component.properties.stop_bits ?? 1),
        mode: component.properties.mode === "bidirectional" ? "bidirectional" : "read-only",
      };
      this.broker.register(registration);
      this.broker.setOnline(endpointId, state.simulationStatus !== "stopped" && coreInstanceIdByComponentId.has(component.id));
    }
    for (const oldId of this.knownEndpointIds) if (!present.has(oldId)) this.broker.remove(oldId);
    this.knownEndpointIds = present;
    return ids;
  }
  toggle(componentId: string): { opened: boolean; clients: number } {
    const id = this.sync().get(componentId); if (!id) throw new Error("Componente LasecPlot não encontrado.");
    const component = state.schematicState.components.find((c) => c.id === componentId)!;
    if (component.properties.expose === false) throw new Error("Ative “Expor para LasecPlot” nas propriedades.");
    if (this.broker.isPublished(id)) this.broker.unpublish(id);
    else this.broker.publish(id);
    return { opened: this.broker.isPublished(id), clients: 0 };
  }
  updateSimulationState(): void { this.sync(); }
  dispose(): void { this.broker.dispose(); }
}

export let lasecPlotManager: LasecPlotManager | undefined;
export function initializeLasecPlot(context: vscode.ExtensionContext): LasecPlotManager {
  lasecPlotManager = new LasecPlotManager(); context.subscriptions.push(lasecPlotManager); return lasecPlotManager;
}

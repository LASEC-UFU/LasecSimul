import * as crypto from "crypto";
import * as vscode from "vscode";
import { coreInstanceIdByComponentId, state } from "../state";
import { CoreUartTransport } from "../uart/CoreUartTransport";
import { LasecSimulInteropApi } from "./api";
import { EndpointRegistration, LasecPlotBroker, LasecPlotTransport } from "./broker";

const TYPE_ID = "peripherals.lasecplot";

function shortHash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 20); }
function contextId(): string {
  const workspace = vscode.workspace.workspaceFile?.fsPath ?? vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).join("|") ?? "untitled";
  return shortHash(`${process.env.USERDOMAIN ?? ""}/${process.env.USERNAME ?? process.env.USER ?? "user"}/${workspace}`);
}

export class LasecPlotManager implements vscode.Disposable {
  private readonly simulationId = `session-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  private readonly projectId = contextId();
  private readonly transport = new CoreUartTransport();
  // Bug real de performance corrigido 2026-07-18 ("depois dos logs a simulação caiu pra 1-2%"): o
  // default de `LasecPlotBroker` (10ms/100Hz) já fazia `transport.read()` (round-trip de IPC com o
  // Core) nessa cadência SEMPRE que o endpoint estava online -- só que, com o bug do overflow de
  // UART fechando o endpoint a cada erro (ver `broker.ts::poll`, corrigido no mesmo dia), a conexão
  // raramente ficava aberta tempo suficiente pra chegar na parte cara (montar pacote + entregar
  // pro `Connection`, que dispara SÍNCRONO o callback da extensão LasecPlot externa). Corrigido o
  // overflow, o endpoint passou a ficar publicado de verdade com um cliente conectado, e as 100
  // entregas/segundo (cada uma cruzando pra outra extensão) viraram um custo real, roubando tempo de
  // CPU do processo do Core. Telemetria/plot não precisa de latência sub-10ms -- `drainUart` sempre
  // devolve TUDO que acumulou desde a última chamada, então espaçar o poll não perde bytes, só
  // agrupa mais por entrega. 50ms (20Hz) é imperceptível pra um gráfico e corta o tráfego de IPC/
  // callbacks em 5x -- esse valor agora é só o TETO (`maxPollIntervalMs`, ver `broker.ts`), usado
  // sem mudança em baud baixo. Achado 2026-07-22 (921600 baud perdendo dados): em baud alto, um
  // teto fixo de 50ms deixava o anel RX de `peripherals.lasecplot` encher antes do próximo poll --
  // `LasecPlotBroker` agora encurta o intervalo automaticamente por baud (`computeDesiredPollIntervalMs`).
  readonly broker = new LasecPlotBroker(this.transport, 50);
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
        parity: component.properties.parity === "even" || component.properties.parity === "odd" ? component.properties.parity : "none",
        mode: component.properties.mode === "bidirectional" ? "bidirectional" : "read-only",
      };
      this.broker.register(registration);
      this.broker.setOnline(endpointId, state.simulationStatus !== "stopped" && coreInstanceIdByComponentId.has(component.id));
    }
    for (const oldId of this.knownEndpointIds) if (!present.has(oldId)) this.broker.remove(oldId);
    this.knownEndpointIds = present;
    return ids;
  }
  async toggle(componentId: string): Promise<{ opened: boolean; clients: number }> {
    const id = this.sync().get(componentId); if (!id) throw new Error("Componente LasecPlot não encontrado.");
    const component = state.schematicState.components.find((c) => c.id === componentId)!;
    if (component.properties.expose === false) throw new Error("Ative “Expor para LasecPlot” nas propriedades.");
    if (this.broker.isPublished(id)) {
      this.broker.unpublish(id);
      await this.transport.read(componentId).catch(() => ({ data: new Uint8Array(), simulationTimeNs: 0 }));
    } else {
      // `.catch` (bug real 2026-07-18, mesma causa do "Abrir parece travado" -- ver `broker.ts::poll`):
      // um overflow do buffer RX ACUMULADO enquanto o endpoint estava fechado (ninguém drenando) é
      // justamente o que este read existe pra descartar -- não deveria impedir "Abrir" de completar.
      await this.transport.read(componentId).catch(() => ({ data: new Uint8Array(), simulationTimeNs: 0 })); // endpoint novo começa sem bytes antigos/buffer temporário
      this.broker.publish(id);
    }
    return { opened: this.broker.isPublished(id), clients: 0 };
  }
  updateSimulationState(): void { this.sync(); }
  /** Único gatilho automático de fechamento além do próprio usuário fechando o painel LasecPlot
   * (`unpublish()`/`remove()` já cobrem isso) -- chamado quando o ESQUEMÁTICO é fechado (ver
   * `extension.ts::openSchematicEditor`, callback `onDispose` do `SchematicPanel`). Pausar/parar a
   * simulação nunca chega aqui (ver `broker.ts::setOnline`). */
  closeAllForSchematicClose(): void {
    for (const id of this.knownEndpointIds) {
      if (this.broker.isPublished(id)) this.broker.unpublish(id, "schematic-closed");
    }
  }
  dispose(): void { this.broker.dispose(); }
}

export let lasecPlotManager: LasecPlotManager | undefined;
export function initializeLasecPlot(context: vscode.ExtensionContext): LasecPlotManager {
  lasecPlotManager = new LasecPlotManager(); context.subscriptions.push(lasecPlotManager); return lasecPlotManager;
}

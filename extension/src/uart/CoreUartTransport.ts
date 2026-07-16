import { coreInstanceIdByComponentId, state } from "../state";

/** Canal UART byte-oriented comum. A codificação hex existe apenas porque o IPC é JSON; acima
 * desta classe Serial Terminal e LasecPlot trabalham exclusivamente com Uint8Array. */
export class CoreUartTransport {
  private readonly rxDropped = new Map<string, number>();
  private readonly txDropped = new Map<string, number>();

  async read(componentId: string): Promise<{ data: Uint8Array; simulationTimeNs: number }> {
    const client = state.coreClient; const coreId = coreInstanceIdByComponentId.get(componentId);
    if (!client || !coreId) return { data: new Uint8Array(), simulationTimeNs: 0 };
    const batch = await client.drainUart(coreId);
    const dropped = Number(batch.dropped ?? 0);
    const previousDropped = this.rxDropped.get(componentId) ?? 0;
    this.rxDropped.set(componentId, dropped);
    if (dropped > previousDropped) throw new Error(`Buffer UART RX excedido: ${dropped - previousDropped} byte(s) perdido(s).`);
    const hex = batch.dataHex;
    const simulationTimeNs = batch.simulationTimeNs;
    return { data: Uint8Array.from(Buffer.from(hex, "hex")), simulationTimeNs };
  }

  async write(componentId: string, data: Uint8Array): Promise<number> {
    const client = state.coreClient; const coreId = coreInstanceIdByComponentId.get(componentId);
    if (!client || !coreId) throw new Error("Dispositivo UART não está inicializado no Core.");
    let offset = 0;
    let simulationTimeNs = 0;
    const deadline = Date.now() + 5000;
    while (offset < data.byteLength) {
      const status = await client.getUartStatus(coreId);
      const pending = Number(status.pending ?? 0);
      const available = Math.max(0, 4096 - pending);
      if (available === 0) {
        if (state.simulationStatus !== "running") throw new Error("Buffer UART TX cheio enquanto a simulação não está rodando.");
        if (Date.now() >= deadline) throw new Error("Timeout aguardando espaço no buffer UART TX.");
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const size = Math.min(available, data.byteLength - offset);
      const write = await client.writeUart(coreId, Buffer.from(data.slice(offset, offset + size)).toString("hex"));
      simulationTimeNs = write.simulationTimeNs;
      offset += size;
    }
    const dropped = Number((await client.getUartStatus(coreId)).dropped ?? 0);
    const previousDropped = this.txDropped.get(componentId) ?? 0;
    this.txDropped.set(componentId, dropped);
    if (dropped > previousDropped) throw new Error(`Buffer UART TX excedido: ${dropped - previousDropped} byte(s) perdido(s).`);
    return simulationTimeNs;
  }
}

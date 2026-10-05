import { coreInstanceIdByComponentId, state } from "../state";
import { IpcError } from "../ipc/protocol";

/** Canal UART byte-oriented comum. A codificação hex existe apenas porque o IPC é JSON; acima
 * desta classe Serial Terminal e LasecPlot trabalham exclusivamente com Uint8Array. */
export class CoreUartTransport {
  private readonly rxDropped = new Map<string, number>();
  private readonly txDropped = new Map<string, number>();

  async read(componentId: string): Promise<{ data: Uint8Array; simulationTimeNs: number; droppedBytes: number }> {
    const client = state.coreClient; const coreId = coreInstanceIdByComponentId.get(componentId);
    if (!client || !coreId) return { data: new Uint8Array(), simulationTimeNs: 0, droppedBytes: 0 };
    const batch = await client.drainUart(coreId);
    const dropped = Number(batch.dropped ?? 0);
    const previousDropped = this.rxDropped.get(componentId) ?? 0;
    this.rxDropped.set(componentId, dropped);
    // Achado 2026-07-22 (baud alto, ex. 921600, perdendo dados): um overflow do buffer RX do Core
    // (ex. poll do consumidor mais lento que o preenchimento do anel a este baud) é uma condição
    // RECUPERÁVEL -- os bytes que SOBREVIVERAM no anel continuam válidos e devem ser entregues.
    // Antes, lançar aqui descartava o LOTE INTEIRO (inclusive bytes bons já lidos), não só os
    // poucos bytes efetivamente perdidos -- amplificando artificialmente a perda percebida bem além
    // da contagem real de `dropped`. Devolve os bytes junto com a contagem, deixa quem chama decidir
    // só reportar/logar.
    const droppedBytes = Math.max(0, dropped - previousDropped);
    const hex = batch.dataHex;
    const simulationTimeNs = batch.simulationTimeNs;
    return { data: Uint8Array.from(Buffer.from(hex, "hex")), simulationTimeNs, droppedBytes };
  }

  async write(componentId: string, data: Uint8Array): Promise<number> {
    const client = state.coreClient; const coreId = coreInstanceIdByComponentId.get(componentId);
    if (!client || !coreId) throw new Error("Dispositivo UART não está inicializado no Core.");
    let offset = 0;
    let simulationTimeNs = 0;
    // [FIX] getUartStatus serial-IPC head-of-line blocking (2026-08-28): a transiently busy
    // Scheduler mutex now surfaces as IpcError{code:"busy"} instead of blocking until it clears.
    // Reuses this SAME deadline for the busy-retry below -- no new independent timeout -- so a
    // sustained busy condition still terminates boundedly, exactly like the pre-existing
    // "buffer full" wait already did.
    const deadline = Date.now() + 5000;
    while (offset < data.byteLength) {
      let status: Awaited<ReturnType<typeof client.getUartStatus>>;
      try {
        status = await client.getUartStatus(coreId);
      } catch (err) {
        if (err instanceof IpcError && err.code === "busy") {
          // BUSY here means we never learned a real pending count -- never fabricate one (e.g.
          // treat it as 0/full-buffer-available) and never call writeUart() this iteration:
          // zero bytes are sent while busy, so there is no risk of a duplicate/short chunk.
          if (Date.now() >= deadline) throw new Error("Timeout aguardando espaço no buffer UART TX.");
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        throw err;
      }
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
    // [FIX] final status BUSY policy (2026-08-28): dropped is a cumulative, monotonically
    // increasing counter on the Core side, and txDropped stores the last SUCCESSFULLY observed
    // value -- so skipping this one sample on busy defers drop detection to the next successful
    // read (which compares against the same, unchanged baseline) rather than losing it. All
    // chunks above are already committed by this point; failing/retrying here would risk turning
    // an already-successful write into a spurious failure for callers that might resend.
    try {
      const dropped = Number((await client.getUartStatus(coreId)).dropped ?? 0);
      const previousDropped = this.txDropped.get(componentId) ?? 0;
      this.txDropped.set(componentId, dropped);
      if (dropped > previousDropped) throw new Error(`Buffer UART TX excedido: ${dropped - previousDropped} byte(s) perdido(s).`);
    } catch (err) {
      if (!(err instanceof IpcError && err.code === "busy")) throw err;
    }
    return simulationTimeNs;
  }
}

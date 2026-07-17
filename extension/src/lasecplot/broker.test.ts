import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { LasecPlotBroker, LasecPlotTransport } from "./broker";
const { test, finish } = createTestRunner("LasecPlot broker");
class MemoryTransport implements LasecPlotTransport {
  reads: Uint8Array[] = []; writes: Uint8Array[] = [];
  async read(): Promise<{ data: Uint8Array; simulationTimeNs: number }> { return { data: this.reads.shift() ?? new Uint8Array(), simulationTimeNs: 123456 }; }
  async write(_componentId: string, data: Uint8Array): Promise<number> { this.writes.push(data); return 654321; }
}
const registration = { id: "lasecsimul://workspace/w/simulation/s/lasecplot/component-42", componentId: "component-42", name: "Temperatura", projectId: "w", simulationId: "s", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none" as const, mode: "bidirectional" as const };
(async () => {
await test("publica, descobre e renomeia sem alterar o ID", async () => {
  const broker = new LasecPlotBroker(new MemoryTransport(), 1000); broker.register(registration); broker.setOnline(registration.id, true); broker.publish(registration.id);
  const first = (await broker.listLasecPlotEndpoints())[0]!; assert(first.id === registration.id, "ID incorreto"); assert(first.displayName === "LasecSimul — Temperatura", "displayName incorreto");
  broker.register({ ...registration, name: "Motor" }); const renamed = (await broker.listLasecPlotEndpoints())[0]!; assert(renamed.id === first.id && renamed.name === "Motor", "renomear deve preservar ID"); broker.dispose();
});
await test("lista várias instâncias pelo nome do schematic e mantém streams independentes", async () => {
  const broker = new LasecPlotBroker(new MemoryTransport(), 1000);
  const second = { ...registration, id: registration.id.replace("component-42", "component-43"), componentId: "component-43", name: "Corrente" };
  broker.register(registration); broker.register(second);
  broker.setOnline(registration.id, true); broker.setOnline(second.id, true);
  broker.publish(registration.id); broker.publish(second.id);
  const endpoints = await broker.listLasecPlotEndpoints();
  assert(endpoints.length === 2, "as duas instâncias deveriam ser publicadas");
  assert(endpoints.some((item) => item.displayName === "LasecSimul — Temperatura"), "fonte Temperatura ausente");
  assert(endpoints.some((item) => item.displayName === "LasecSimul — Corrente"), "fonte Corrente ausente");
  assert(endpoints[0]?.id !== endpoints[1]?.id, "instâncias diferentes compartilharam o ID");
  broker.dispose();
});
await test("entrega bytes binários e metadados sem interpretar fragmentos", async () => {
  const transport = new MemoryTransport(); const broker = new LasecPlotBroker(transport, 2); broker.register(registration); broker.setOnline(registration.id, true); broker.publish(registration.id);
  const connection = await broker.openLasecPlotEndpoint(registration.id); let bytes: Uint8Array | undefined; let sequence = -1; let timestamp = 0;
  connection.onData((value) => { bytes = value; }); connection.onPacket((packet) => { sequence = packet.sequence; timestamp = packet.simulationTimeNs; }); transport.reads.push(Uint8Array.of(0, 255, 13, 10));
  await new Promise((resolve) => setTimeout(resolve, 15)); assert(bytes?.join(",") === "0,255,13,10", "bytes foram alterados"); assert(sequence === 0 && timestamp === 123456, "sequência/timestamp incorretos"); broker.dispose();
});
await test("permite vários leitores e somente um escritor", async () => {
  const broker = new LasecPlotBroker(new MemoryTransport(), 1000); broker.register(registration); broker.setOnline(registration.id, true); broker.publish(registration.id); await broker.openLasecPlotEndpoint(registration.id);
  const writer = await broker.openLasecPlotEndpoint(registration.id, { writable: true }); let rejected = false; try { await broker.openLasecPlotEndpoint(registration.id, { writable: true }); } catch { rejected = true; }
  assert(rejected, "segundo escritor deveria ser rejeitado"); await writer.close(); const replacement = await broker.openLasecPlotEndpoint(registration.id, { writable: true }); assert(replacement.writable, "reserva não foi liberada"); broker.dispose();
});
await test("rejeita escrita read-only e fecha ao parar simulação", async () => {
  const broker = new LasecPlotBroker(new MemoryTransport(), 1000); broker.register({ ...registration, mode: "read-only" }); broker.setOnline(registration.id, true); broker.publish(registration.id); const connection = await broker.openLasecPlotEndpoint(registration.id);
  let rejected = false; try { await connection.write(Uint8Array.of(1)); } catch { rejected = true; } let reason = ""; connection.onDidClose((event) => { reason = event.reason; }); broker.setOnline(registration.id, false);
  assert(rejected, "read-only aceitou escrita"); assert(reason === "simulation-stopped", "fechamento não foi notificado"); assert((await broker.listLasecPlotEndpoints()).length === 0, "endpoint parado continuou publicado"); broker.dispose();
});
await test("publica com sucesso mesmo com a simulação parada (offline) -- abrir o endpoint não depende de Run", () => {
  const broker = new LasecPlotBroker(new MemoryTransport(), 1000);
  broker.register(registration); // NUNCA chama setOnline(true) -- endpoint continua offline
  broker.publish(registration.id); // não deveria lançar
  assert(broker.isPublished(registration.id), "endpoint deveria estar publicado mesmo offline");
  broker.dispose();
});
const { failed } = finish(); process.exitCode = failed > 0 ? 1 : 0;
})();

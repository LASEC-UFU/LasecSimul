import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { LasecPlotBroker, LasecPlotTransport } from "./broker";
const { test, finish } = createTestRunner("LasecPlot broker");
class MemoryTransport implements LasecPlotTransport {
  reads: Uint8Array[] = []; writes: Uint8Array[] = [];
  async read(): Promise<{ data: Uint8Array; simulationTimeNs: number }> { return { data: this.reads.shift() ?? new Uint8Array(), simulationTimeNs: 123456 }; }
  async write(_componentId: string, data: Uint8Array): Promise<number> { this.writes.push(data); return 654321; }
}
/** Simula `CoreUartTransport.read` lançando "Buffer UART RX excedido" (overflow -- ESPERADO enquanto
 * ninguém está lendo ainda) em toda leitura, pra testar que o poll NÃO fecha o endpoint por causa
 * disso (bug real 2026-07-18, ver `broker.ts::poll`). */
class AlwaysOverflowingTransport implements LasecPlotTransport {
  async read(): Promise<{ data: Uint8Array; simulationTimeNs: number }> { throw new Error("Buffer UART RX excedido: 4 byte(s) perdido(s)."); }
  async write(): Promise<number> { throw new Error("não usado neste teste"); }
}
const registration = { id: "lasecsimul://workspace/w/simulation/s/lasecplot/component-42", componentId: "component-42", name: "Temperatura", projectId: "w", simulationId: "s", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none" as const, mode: "bidirectional" as const };
(async () => {
await test("publica, descobre e renomeia sem alterar o ID", async () => {
  const broker = new LasecPlotBroker(new MemoryTransport(), 1000); broker.register(registration); broker.setOnline(registration.id, true); broker.publish(registration.id);
  const first = (await broker.listLasecPlotEndpoints())[0]!; assert(first.id === registration.id, "ID incorreto"); assert(first.displayName === "Temperatura", "displayName incorreto");
  broker.register({ ...registration, name: "Motor" }); const renamed = (await broker.listLasecPlotEndpoints())[0]!; assert(renamed.id === first.id && renamed.name === "Motor", "renomear deve preservar ID"); broker.dispose();
});
await test("displayName mostra só o nome amigável, sem prefixo de origem/baud/IDs (achado 2026-07-21)", async () => {
  const broker = new LasecPlotBroker(new MemoryTransport(), 1000);
  const autoLabeled = { ...registration, id: registration.id.replace("component-42", "component-99"), componentId: "component-99", name: "LasecPlot-1" };
  broker.register(autoLabeled); broker.setOnline(autoLabeled.id, true); broker.publish(autoLabeled.id);
  const endpoint = (await broker.listLasecPlotEndpoints())[0]!;
  assert(endpoint.displayName === "Lasec Plot - 1", `rótulo padrão "LasecPlot-1" deveria virar "Lasec Plot - 1", veio "${endpoint.displayName}"`);
  broker.dispose();
});
await test("lista várias instâncias pelo nome do schematic e mantém streams independentes", async () => {
  const broker = new LasecPlotBroker(new MemoryTransport(), 1000);
  const second = { ...registration, id: registration.id.replace("component-42", "component-43"), componentId: "component-43", name: "Corrente" };
  broker.register(registration); broker.register(second);
  broker.setOnline(registration.id, true); broker.setOnline(second.id, true);
  broker.publish(registration.id); broker.publish(second.id);
  const endpoints = await broker.listLasecPlotEndpoints();
  assert(endpoints.length === 2, "as duas instâncias deveriam ser publicadas");
  assert(endpoints.some((item) => item.displayName === "Temperatura"), "fonte Temperatura ausente");
  assert(endpoints.some((item) => item.displayName === "Corrente"), "fonte Corrente ausente");
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
await test("debugListAllEndpoints (comando 'LasecSimul: List LasecPlot Endpoints') mostra registrados NÃO publicados, ao contrário de listLasecPlotEndpoints", async () => {
  const broker = new LasecPlotBroker(new MemoryTransport(), 1000);
  broker.register(registration); // registrado, mas "Abrir" nunca foi clicado -- nunca publicado
  assert((await broker.listLasecPlotEndpoints()).length === 0, "API pública não deveria listar endpoint não publicado");
  const all = broker.debugListAllEndpoints();
  assert(all.length === 1, "diagnóstico deveria enxergar o registro mesmo sem publicar");
  assert(all[0]?.id === registration.id && all[0]?.opened === false, "deveria refletir aberto=false pro registro ainda não publicado");
  broker.publish(registration.id);
  const allAfterPublish = broker.debugListAllEndpoints();
  assert(allAfterPublish[0]?.opened === true, "deveria refletir aberto=true depois de publicar");
  broker.dispose();
});
await test("poll() NÃO despublica o endpoint quando a leitura falha (overflow é esperado sem cliente conectado, bug real 2026-07-18: 'Abrir' parecia travado)", async () => {
  const broker = new LasecPlotBroker(new AlwaysOverflowingTransport(), 5);
  broker.register(registration);
  broker.setOnline(registration.id, true); // liga o poll (a cada 5ms) -- toda leitura vai falhar
  broker.publish(registration.id);
  assert(broker.isPublished(registration.id), "publish() inicial deveria ter sucesso");
  await new Promise((resolve) => setTimeout(resolve, 40)); // várias janelas de poll se passam, todas com erro
  assert(broker.isPublished(registration.id), "endpoint NÃO deveria fechar sozinho por causa de erros de leitura repetidos");
  broker.dispose();
});
await test("debugRecentBytes (comando 'LasecSimul: List LasecPlot Endpoints') captura os bytes lidos do Core mesmo SEM cliente conectado, e limita o tamanho", async () => {
  const transport = new MemoryTransport();
  const broker = new LasecPlotBroker(transport, 5);
  broker.register(registration);
  assert((broker.debugRecentBytes(registration.id) ?? new Uint8Array()).byteLength === 0, "sem leitura nenhuma ainda, buffer deveria começar vazio");
  broker.setOnline(registration.id, true); // liga o poll -- NUNCA publica, então nunca teria cliente
  transport.reads.push(Uint8Array.of(72, 105)); // "Hi"
  await new Promise((resolve) => setTimeout(resolve, 20));
  const captured = broker.debugRecentBytes(registration.id);
  assert(captured !== undefined && Buffer.from(captured).toString() === "Hi", `deveria capturar 'Hi' mesmo sem cliente/publicação, capturado: ${captured ? Buffer.from(captured).toString("hex") : "undefined"}`);
  broker.dispose();
});
const { failed } = finish(); process.exitCode = failed > 0 ? 1 : 0;
})();

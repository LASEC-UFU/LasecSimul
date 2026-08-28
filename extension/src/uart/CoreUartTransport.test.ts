import { MockCoreServer, createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { CoreClient } from "../ipc/CoreClient";
import { PROTOCOL_VERSION, RequestEnvelope, ResponseEnvelope } from "../ipc/protocol";
import { state, coreInstanceIdByComponentId } from "../state";
import { CoreUartTransport } from "./CoreUartTransport";

/**
 * [FIX] getUartStatus serial-IPC head-of-line blocking (2026-08-28) -- CoreUartTransport.write()'s
 * client-side handling of errorCode="busy". Mocks the Core side (MockCoreServer, same technique
 * CoreClient.test.ts already uses) so these run fast/deterministically without a real Core/QEMU
 * process, scripting getUartStatus/writeUart responses precisely per scenario.
 */
const { test, finish } = createTestRunner("CoreUartTransport -- getUartStatus BUSY handling");

const COMPONENT_ID = "webview-component-uart-transport-test";
const CORE_ID = "7";

(async () => {
  await test("mid-loop BUSY, BUSY, then success -- zero bytes sent while busy, exactly one writeUart call, no duplicate/short chunk", async () => {
    const name = `lasecsimul-test-uart-midloop-busy-${process.pid}`;
    let getUartStatusCalls = 0;
    const writeUartPayloads: string[] = [];
    const server = new MockCoreServer(name, PROTOCOL_VERSION, (msg: RequestEnvelope): ResponseEnvelope => {
      if (msg.type === "getUartStatus") {
        getUartStatusCalls++;
        if (getUartStatusCalls <= 2) {
          return { id: msg.id, ok: false, error: "simulacao ocupada; status UART adiado", payload: { errorCode: "busy" } };
        }
        return { id: msg.id, ok: true, payload: { pending: 0, dropped: 0 } };
      }
      if (msg.type === "writeUart") {
        writeUartPayloads.push((msg.payload as { dataHex: string }).dataHex);
        return { id: msg.id, ok: true, payload: { pending: 0, dropped: 0, simulationTimeNs: 999 } };
      }
      return { id: msg.id, ok: true, payload: {} };
    });
    await server.start();
    const client = new CoreClient(name);
    await client.start();
    state.coreClient = client;
    state.simulationStatus = "running";
    coreInstanceIdByComponentId.set(COMPONENT_ID, CORE_ID);

    const transport = new CoreUartTransport();
    const data = Uint8Array.from(Buffer.from("0041ff", "hex"));
    const start = Date.now();
    const simulationTimeNs = await transport.write(COMPONENT_ID, data);
    const elapsedMs = Date.now() - start;

    assert(simulationTimeNs === 999, "write() deveria devolver o simulationTimeNs do writeUart bem-sucedido");
    assert(writeUartPayloads.length === 1, `writeUart deveria ser chamado exatamente 1 vez (BUSY nao deve gerar chamada nenhuma) -- foi chamado ${writeUartPayloads.length} vez(es)`);
    assert(writeUartPayloads[0] === "0041ff", "os 3 bytes deveriam chegar num unico chunk, sem duplicacao/particionamento");
    assert(getUartStatusCalls >= 3, "getUartStatus deveria ter sido tentado pelo menos 3 vezes (2 BUSY + 1 sucesso) antes do primeiro writeUart");
    assert(elapsedMs < 2000, `2 retries de 5ms nao deveriam levar perto de 2s -- levou ${elapsedMs}ms (nao deveria ter esperado o deadline de 5s)`);

    await client.stop();
    await server.stop();
  });

  await test("BUSY sustentado ate o deadline -- termina de forma limitada, sem escrever a partir de um pending fabricado", async () => {
    const name = `lasecsimul-test-uart-sustained-busy-${process.pid}`;
    let writeUartCalls = 0;
    const server = new MockCoreServer(name, PROTOCOL_VERSION, (msg: RequestEnvelope): ResponseEnvelope => {
      if (msg.type === "getUartStatus") {
        return { id: msg.id, ok: false, error: "simulacao ocupada; status UART adiado", payload: { errorCode: "busy" } };
      }
      if (msg.type === "writeUart") {
        writeUartCalls++;
        return { id: msg.id, ok: true, payload: { pending: 0, dropped: 0, simulationTimeNs: 1 } };
      }
      return { id: msg.id, ok: true, payload: {} };
    });
    await server.start();
    const client = new CoreClient(name);
    await client.start();
    state.coreClient = client;
    state.simulationStatus = "running";
    coreInstanceIdByComponentId.set(COMPONENT_ID, CORE_ID);

    const transport = new CoreUartTransport();
    const data = Uint8Array.from(Buffer.from("ff", "hex"));
    const start = Date.now();
    let threw = false;
    let message = "";
    try {
      await transport.write(COMPONENT_ID, data);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    const elapsedMs = Date.now() - start;

    assert(threw, "BUSY sustentado indefinidamente deveria eventualmente rejeitar, nao travar para sempre");
    assert(message.includes("Timeout"), `mensagem deveria indicar timeout (reaproveitando o deadline existente) -- veio "${message}"`);
    assert(elapsedMs >= 4500 && elapsedMs < 8000,
      `deveria terminar perto do deadline de 5s existente, nem antes nem muito depois -- levou ${elapsedMs}ms`);
    assert(writeUartCalls === 0, "nenhum byte deveria ser enviado -- BUSY nunca deve fabricar um pending e prosseguir para writeUart");

    await client.stop();
    await server.stop();
  });

  await test("status final BUSY -- write() resolve normalmente, txDropped preservado, sem reenvio; deteccao de drop e' adiada, nao perdida", async () => {
    const name = `lasecsimul-test-uart-final-busy-${process.pid}`;
    let finalStatusBusy = true; // primeira chamada final = BUSY; controla a proxima chamada explicitamente
    let getUartStatusCallsInFlight = 0;
    const server = new MockCoreServer(name, PROTOCOL_VERSION, (msg: RequestEnvelope): ResponseEnvelope => {
      if (msg.type === "getUartStatus") {
        getUartStatusCallsInFlight++;
        // Chamada #1 de cada write(): status ANTES do (unico) chunk -- sempre sucesso, buffer livre.
        // Chamada #2: status FINAL, apos o loop -- controlada por `finalStatusBusy`.
        if (getUartStatusCallsInFlight % 2 === 1) {
          return { id: msg.id, ok: true, payload: { pending: 0, dropped: 0 } };
        }
        if (finalStatusBusy) {
          return { id: msg.id, ok: false, error: "simulacao ocupada; status UART adiado", payload: { errorCode: "busy" } };
        }
        // Segunda chamada de write(): dropped cumulativo aumentou desde a ULTIMA OBSERVACAO VALIDA
        // (que continua sendo a baseline 0 de antes do primeiro write(), porque a leitura final
        // dele foi pulada) -- prova que o delta acumulado ainda e' detectado corretamente.
        return { id: msg.id, ok: true, payload: { pending: 0, dropped: 5 } };
      }
      if (msg.type === "writeUart") {
        return { id: msg.id, ok: true, payload: { pending: 0, dropped: 0, simulationTimeNs: 42 } };
      }
      return { id: msg.id, ok: true, payload: {} };
    });
    await server.start();
    const client = new CoreClient(name);
    await client.start();
    state.coreClient = client;
    state.simulationStatus = "running";
    coreInstanceIdByComponentId.set(COMPONENT_ID, CORE_ID);

    const transport = new CoreUartTransport();
    const data = Uint8Array.from(Buffer.from("aa", "hex"));

    let threwOnFirstWrite = false;
    try {
      const result = await transport.write(COMPONENT_ID, data);
      assert(result === 42, "write() deveria resolver normalmente com o simulationTimeNs do chunk, mesmo com status final BUSY");
    } catch {
      threwOnFirstWrite = true;
    }
    assert(!threwOnFirstWrite, "write() NAO deveria rejeitar so porque a telemetria final estava temporariamente ocupada");

    // Segundo write(): a leitura final agora sucede com dropped=5 cumulativo -- como a baseline
    // (txDropped) nunca avancou no primeiro write() (leitura pulada), o delta contra a baseline
    // original (0) ainda e' 5, e o erro esperado de "buffer excedido" e' lancado normalmente.
    finalStatusBusy = false;
    let threwOnSecondWrite = false;
    let secondMessage = "";
    try {
      await transport.write(COMPONENT_ID, data);
    } catch (err) {
      threwOnSecondWrite = true;
      secondMessage = err instanceof Error ? err.message : String(err);
    }
    assert(threwOnSecondWrite, "o proximo status bem-sucedido deveria detectar o delta acumulado de 5 bytes perdidos, nao silenciar");
    assert(secondMessage.includes("5 byte"), `mensagem deveria reportar o delta acumulado correto (5) -- veio "${secondMessage}"`);

    await client.stop();
    await server.stop();
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { state, coreInstanceIdByComponentId } from "../state";
import { CoreUartTransport } from "../uart/CoreUartTransport";
import { LasecPlotBroker, EndpointRegistration } from "./broker";

/**
 * Achado 2026-07-21 (relato ao vivo: "conexão abriu mas o gráfico não recebeu nada"): a suíte
 * existente (`broker.test.ts`) só exercita `LasecPlotBroker` contra um `MemoryTransport` falso, e
 * `CoreClient.test.ts` só contra um `MockCoreServer` de respostas prontas -- nenhum teste
 * automatizado provava que `CoreUartTransport`/`LasecPlotBroker` (as classes REAIS que
 * `lasecplot/manager.ts` usa em produção) conseguem, de ponta a ponta, tirar bytes de um processo
 * Core DE VERDADE (decodificados eletricamente pelo plugin `peripherals.lasecplot`, ver
 * `devices/simulide-peripherals/src/lib.c`) e entregá-los a um consumidor externo via
 * `connection.onData`/`onPacket` -- exatamente o limite que a LasecPlot (extensão consumidora)
 * usa. `scripts/test-uart-devices.js` já prova a decodificação elétrica em si (bit-banging real,
 * vários baud/bits/paridade/stop); este teste prova a camada de cima, que faltava.
 *
 * Deliberadamente FORA da cadeia `npm test` (mesmo motivo de `test:uart`/`test:core`): spawna um
 * processo Core real, precisa do binário compilado primeiro. Rodar direto:
 *   npm run compile && node out/lasecplot/broker.realCore.test.js
 */
const { test, finish } = createTestRunner("LasecPlot broker (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const corePath = resolveCoreExecutablePath(extensionRoot);
const libraryPath = path.join(repoRoot, "devices", "library.json");
const pins = [{ id: "tx", x: 0, y: 8 }, { id: "rx", x: 0, y: 24 }];
const PLOT_COMPONENT_ID = "webview-component-lasecplot-broker-test";

(async () => {
  const pipeName = `lasecsimul-broker-realcore-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: corePath, pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 10_000 });
  processManager.start();
  // Mesmo estado global que a extensão real popula em produção (ver extension.ts::activate() /
  // coreLifecycle.ts) -- CoreUartTransport/LasecPlotBroker leem `state.coreClient` e
  // `coreInstanceIdByComponentId` diretamente, sem depender de nenhuma API do host VS Code (os
  // dois módulos só importam `vscode` como TIPO, nunca como valor -- por isso rodam fora de um
  // Extension Host de verdade).
  state.coreClient = client;
  state.simulationStatus = "running";

  try {
    await client.start();
    await client.loadDeviceLibrary(libraryPath);
    const defaults = { baudrate: 115200, data_bits: 8, stop_bits: 1, parity: "none" };
    const terminal = await client.addComponent("peripherals.serialterm", defaults, pins, "Serial Terminal (broker test)");
    const plot = await client.addComponent(
      "peripherals.lasecplot",
      { ...defaults, source_name: "LasecPlot broker test", mode: "bidirectional", expose: true },
      pins,
      "LasecPlot (broker test)",
    );
    await client.connectWire(terminal.instanceId, "tx", plot.instanceId, "rx");
    await client.connectWire(plot.instanceId, "tx", terminal.instanceId, "rx");
    await client.step(10_000); // estabelece idle alto antes do primeiro start bit (mesma técnica de test-uart-devices.js)

    // Mesma ligação que coreLifecycle.ts::registerCoreIdsForComponent faz em produção pra cada
    // componente adicionado -- sem isto CoreUartTransport.read()/write() nunca acham o instanceId
    // real do Core (ver CoreUartTransport.ts:10, retorna sempre vazio em silêncio).
    coreInstanceIdByComponentId.set(PLOT_COMPONENT_ID, plot.instanceId);

    const transport = new CoreUartTransport();
    const broker = new LasecPlotBroker(transport, 10);
    const registration: EndpointRegistration = {
      id: "lasecsimul://test/lasecplot/" + PLOT_COMPONENT_ID,
      componentId: PLOT_COMPONENT_ID,
      name: "LasecPlot broker test",
      simulationId: "s",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      mode: "bidirectional",
    };

    await test("broker real: bytes escritos no Core (via peripherals.serialterm) chegam a um cliente conectado via onData/onPacket", async () => {
      broker.register(registration);
      broker.setOnline(registration.id, true);
      broker.publish(registration.id);

      const connection = await broker.openLasecPlotEndpoint(registration.id, { writable: false });
      let received: Uint8Array | undefined;
      let packetDirection: string | undefined;
      connection.onData((bytes) => { received = bytes; });
      connection.onPacket((packet) => { packetDirection = packet.direction; });

      const payload = Buffer.from("Ola LasecPlot\r\n", "utf8");
      await client.writeUart(terminal.instanceId, payload.toString("hex"));
      const frameBits = 1 + 8 + 1; // start + 8 bits de dado + 1 stop, sem paridade (defaults acima)
      await client.step(Math.ceil((payload.length * frameBits * 1e9) / 115200) + 2_000_000);

      // O broker drena o Core no seu próprio timer (10ms aqui) -- espera algumas janelas em vez de
      // assumir que a primeira já pegou tudo (mesma disciplina de poll-com-timeout já usada nos
      // testes de McuController/QEMU real desta sessão).
      const deadline = Date.now() + 3000;
      while (received === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      assert(received !== undefined, "nenhum pacote chegou ao consumidor via onData -- broker real não entregou bytes do Core");
      assert(
        Buffer.from(received!).toString("utf8") === payload.toString("utf8"),
        `bytes divergem: esperado "${payload.toString("utf8")}", recebido "${received ? Buffer.from(received).toString("utf8") : "undefined"}"`,
      );
      assert(packetDirection === "mcu-to-client", `direção incorreta: esperado "mcu-to-client", veio "${packetDirection}"`);

      broker.unpublish(registration.id);
    });

    broker.dispose();
    await client.stop();
  } finally {
    processManager.kill();
  }
  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

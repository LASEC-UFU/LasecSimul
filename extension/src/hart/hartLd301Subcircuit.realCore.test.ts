import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { decodeSegmentLcd } from "../ui/webview/segmentLcd";

/**
 * The SMAR LD301 is the subcircuit `subcircuits/hart_smar_ld301.lssubcircuit`
 * around one standard HART device. This drives a REAL Core process: load the
 * subcircuit library, place the LD301, resolve its inner HART device exactly
 * like the HART transports do (`getSubcircuitChildInstanceId`) and answer
 * frames copied from the reference capture (ld301/).
 *
 * Outside `npm test` (needs the compiled Core), like the other realCore tests:
 *   npm run compile && node out/hart/hartLd301Subcircuit.realCore.test.js
 */
const { test, finish } = createTestRunner("LD301 subcircuit on the standard HART device (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const pins = ["high", "low", "loop_plus", "loop_minus"].map((id, index) => ({ id, x: 0, y: index * 12 }));

function body(frameHex: string): string {
  // Strip preambles; the slave delimiter starts the frame.
  const index = frameHex.search(/(86|06)/);
  return frameHex.slice(index);
}

(async () => {
  const pipeName = `lasecsimul-ld301-realcore-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 10_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    const ld301 = await client.addComponent("subcircuits.hart.smar_ld301", {}, pins, "LD301 (real Core test)");
    const inner = await client.getSubcircuitChildInstanceId(ld301.instanceId, "ld301");

    await test("the inner standard HART device answers Command 0 with the captured LD301 identity (status 0x64)", async () => {
      const reply = await client.hartTransact(inner, "ffffffffff0280000082");
      assert(body(reply.frameHex) === "0680000e0064fe3e0105050572200605f04dc4", `Command 0: ${reply.frameHex}`);
    });

    await test("Command 15 and the vendor Command 140 match the capture byte for byte", async () => {
      const output = await client.hartTransact(inner, "ffffffffff82be0105f04d0f008a");
      assert(body(output.frameHex) === "86be0105f04d0f13004401000444d34000433e000000000000003e48", `Command 15: ${output.frameHex}`);
      const pid = await client.hartTransact(inner, "ffffffffff82be0105f04d8c0009");
      assert(body(pid.frameHex) === "86be0105f04d8c187044" + "39c14aaaaa394248000039bfa00000ff003900000000" + "40",
             `Command 140: ${pid.frameHex}`);
    });

    await test("the inner device publishes its local display (LCD) in the live telemetry", async () => {
      const frame = await client.getTelemetryFrame({ items: [{ key: "lcd", instanceId: inner }], probes: [] }, 0);
      const bytes = frame.componentStates["lcd"];
      assert(Boolean(bytes) && bytes!.length >= 36, `telemetria de ${bytes?.length ?? 0} bytes`);
      assert(Math.abs(bytes!.readDoubleLE(0) - 3.8) < 1e-6, `corrente de laço ${bytes!.readDoubleLE(0)} mA`);
      assert(bytes!.readUInt32LE(8) === 0x4c434431, "marcador LCD1");
      const lcd = decodeSegmentLcd(new Uint8Array(bytes!), 12);
      assert(lcd?.enabled === true && lcd.alpha === "LD301" && lcd.numeric === "  5 00", `vidro: '${lcd?.numeric}' '${lcd?.alpha}'`);
    });

    await test("Command 20 (HART 6+) is not implemented: RC 64", async () => {
      const reply = await client.hartTransact(inner, "ffffffffff82be0105f04d140091");
      assert(body(reply.frameHex) === "86be0105f04d1402404493", `Command 20: ${reply.frameHex}`);
    });

    await test("os sinais HIGH e LOW persistem na transacao de fios e PV mede a diferenca", async () => {
      const highInput = ld301.exposedSignalPins?.high;
      const lowInput = ld301.exposedSignalPins?.low;
      assert(Boolean(highInput && lowInput), "LD301 deve expor HIGH e LOW como sinais");
      if (!highInput || !lowInput) return;
      const highSlider = await client.addComponent("graphics.slider", { value: 1190, actionMin: 0, actionMax: 2000 }, [{ id: "out", x: 0, y: 0 }], "HIGH");
      const lowSlider = await client.addComponent("graphics.slider", { value: 1000, actionMin: 0, actionMax: 2000 }, [{ id: "out", x: 0, y: 0 }], "LOW");
      await client.applyWireTopologyTransaction([
        { kind: "connect", from: { componentId: highSlider.instanceId, pinId: "out" },
          to: { componentId: highInput.instanceId, pinId: highInput.pinId } },
        { kind: "connect", from: { componentId: lowSlider.instanceId, pinId: "out" },
          to: { componentId: lowInput.instanceId, pinId: lowInput.pinId } },
      ]);
      await client.step(1_000_000);
      const liveCurrent = async (): Promise<number> => {
        const frame = await client.getTelemetryFrame({ items: [{ key: "live-lcd", instanceId: inner }], probes: [] }, 0);
        const bytes = frame.componentStates["live-lcd"];
        assert(Boolean(bytes), "telemetria do LCD deve estar disponivel sem comando HART");
        return bytes!.readDoubleLE(0);
      };
      const currentAtLowerRange = await liveCurrent();
      assert(Math.abs(currentAtLowerRange - 4) < 0.05,
        `PV 190 deve atualizar a corrente sem transacao HART: ${currentAtLowerRange} mA`);
      const readPressure = async (): Promise<number> => {
        const reply = await client.hartTransact(inner, "ffffffffff82be0105f04d010084");
        const frame = Buffer.from(reply.frameHex, "hex");
        assert(frame[11] === 1 && frame[13] === 0, `Command 1 inesperado: ${reply.frameHex}`);
        return frame.readFloatBE(16);
      };
      const low = await readPressure();
      assert(Math.abs(low - 190) < 0.01, `PRESSAO 190 deveria chegar a PV: ${low}`);
      await client.setProperty(highSlider.instanceId, "value", 1690);
      await client.step(1_000_000);
      const liveChangedCurrent = await liveCurrent();
      assert(Math.abs(liveChangedCurrent - (4 + 16 * 500 / 1500)) < 0.05,
        `mudanca do slider deve atualizar a corrente sem transacao HART: ${liveChangedCurrent} mA`);
      await client.setProperty(highSlider.instanceId, "value", 1500);
      await client.step(1_000_000);
      const secondCurrent = await liveCurrent();
      assert(Math.abs(secondCurrent - (4 + 16 * 310 / 1500)) < 0.05,
        `segunda mudanca consecutiva do slider deve atualizar a corrente: ${secondCurrent} mA`);
      await client.setProperty(highSlider.instanceId, "value", 1690);
      await client.step(1_000_000);
      const restoredCurrent = await liveCurrent();
      assert(Math.abs(restoredCurrent - liveChangedCurrent) < 0.05,
        `terceira mudanca consecutiva deve restaurar a corrente: ${restoredCurrent} mA`);
      const high = await readPressure();
      assert(Math.abs(high - 690) < 0.01, `HIGH 1690 menos LOW 1000 deveria produzir PV 690: ${high}`);
      await client.setProperty(lowSlider.instanceId, "value", 0);
      await client.step(1_000_000);
      const zeroLow = await readPressure();
      assert(Math.abs(zeroLow - 1690) < 0.01, `LOW 0 deveria produzir PV 1690: ${zeroLow}`);
      await client.setProperty(highSlider.instanceId, "value", 2500);
      await client.step(1_000_000);
      const capped = await readPressure();
      assert(Math.abs(capped - 2000) < 0.01, `OUT do slider deve parar no maximo configurado 2000: ${capped}`);
      await client.setProperty(highSlider.instanceId, "actionMax", 1800);
      await client.step(1_000_000);
      const loweredLimit = await readPressure();
      assert(Math.abs(loweredLimit - 1800) < 0.01, `alterar limite do slider deve corrigir OUT para 1800: ${loweredLimit}`);

      // Reproduce the schematic: HIGH 1500, LOW 1000 and the HART range
      // -1690..1690. The LCD/current must update during simulation, without
      // waiting for another HART read to sample the process inputs.
      const rangePayload = Buffer.alloc(9);
      rangePayload[0] = 4; // mmH2O @ 20 C
      rangePayload.writeFloatBE(1690, 1); // URV
      rangePayload.writeFloatBE(-1690, 5); // LRV
      const requestBody = Buffer.concat([Buffer.from("82be0105f04d2309", "hex"), rangePayload]);
      const checksum = requestBody.reduce((xor, octet) => xor ^ octet, 0);
      const rangeReply = await client.hartTransact(inner,
        Buffer.concat([Buffer.alloc(5, 0xff), requestBody, Buffer.from([checksum])]).toString("hex"));
      assert(Buffer.from(rangeReply.frameHex, "hex")[13] === 0,
        `gravar faixa -1690..1690: ${rangeReply.frameHex}`);
      await client.setProperty(highSlider.instanceId, "actionMax", 1690);
      await client.setProperty(highSlider.instanceId, "value", 1500);
      await client.setProperty(lowSlider.instanceId, "value", 1000);
      await client.step(1_000_000);
      const expectedCurrent = 4 + 16 * (500 + 1690) / 3380;
      const rangedCurrent = await liveCurrent();
      assert(Math.abs(rangedCurrent - expectedCurrent) < 0.05,
        `HIGH 1500 LOW 1000 na faixa -1690..1690 deve dar 64,79%: ${rangedCurrent} mA`);
      const differential = await readPressure();
      assert(Math.abs(differential - 500) < 0.01, `pressao diferencial esperada 500: ${differential}`);
    });

    await test("a montagem de 24 V sem terra ainda conduz a corrente do LD301", async () => {
      const field = await client.addComponent("subcircuits.hart.smar_ld301", {}, pins, "LD301 loop");
      const plus = field.exposedPins?.loop_plus;
      const minus = field.exposedPins?.loop_minus;
      assert(Boolean(plus && minus), "terminais de loop expostos");
      if (!plus || !minus) return;
      const source = await client.addComponent("sources.dc_voltage", { voltage: 24 },
        [{ id: "pin-1", x: 0, y: 0 }, { id: "pin-2", x: 0, y: 0 }], "24 V");
      const ammeter = await client.addComponent("meters.ampmeter", { resistance: 0.000001 },
        ["pin-1", "pin-2", "pin-3"].map((id) => ({ id, x: 0, y: 0 })), "mA");
      const resistor = await client.addComponent("passive.resistor", { resistance: 1000 },
        [{ id: "pin-1", x: 0, y: 0 }, { id: "pin-2", x: 0, y: 0 }], "1k");
      const modem = await client.addComponent("protocol.hart.modem", { senseResistance: 250 },
        [{ id: "loop_plus", x: 0, y: 0 }, { id: "loop_minus", x: 0, y: 0 }], "modem");
      const edge = (a: string, ap: string, b: string, bp: string) => ({ kind: "connect" as const,
        from: { componentId: a, pinId: ap }, to: { componentId: b, pinId: bp } });
      await client.applyWireTopologyTransaction([
        edge(source.instanceId, "pin-1", ammeter.instanceId, "pin-1"),
        edge(ammeter.instanceId, "pin-2", plus.instanceId, plus.pinId),
        edge(minus.instanceId, minus.pinId, resistor.instanceId, "pin-1"),
        edge(resistor.instanceId, "pin-2", modem.instanceId, "loop_minus"),
        edge(modem.instanceId, "loop_plus", source.instanceId, "pin-2"),
      ]);
      await client.step(10_000);
      const state = await client.getComponentState(ammeter.instanceId);
      assert(Math.abs(state.readDoubleLE(0)) >= 0.003, `corrente do loop ausente: ${state.readDoubleLE(0)} A`);
      await client.setSimulationConfig({ realTimeRate: 1, adaptiveTimeStep: true,
        initialStepNs: 100, minimumStepNs: 1, maximumStepNs: 100_000 });
      const before = (await client.getSimulationTime()).simulatedNs;
      await client.run();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = (await client.getSimulationTime()).simulatedNs;
      const metrics = await client.getPerformanceMetrics();
      await client.stopSimulation();
      assert(after > before, `tempo simulado não avançou: ${before} -> ${after} ns`);
      assert(after - before >= 2_500_000, `simulação abaixo de 0,5%: ${after - before} ns em 500 ms; ${JSON.stringify(metrics)}`);
      process.stdout.write(`    taxa do laço: ${Math.round((after - before) / 5_000_000)}% do tempo real\n`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

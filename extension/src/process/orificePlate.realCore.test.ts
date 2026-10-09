import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";

/**
 * Orifice plate (`subcircuits/process_orifice_flow_dp.lssubcircuit`) wired to the LD301 on a REAL
 * Core: valve opening from a slider, HIGH/LOW taps into the transmitter, ISO 5167-2 differential
 * pressure, the square-root transfer function of the LD301 (Command 47) turning dP into a current
 * proportional to the flow, and parameters (control.constant) changed with the simulation running.
 * Expected values come from the `fluids` library (see docs/placa-orificio-ld301.md).
 *
 * Outside `npm test` (needs the compiled Core):
 *   npm run compile && node out/process/orificePlate.realCore.test.js
 */
const { test, finish } = createTestRunner("Placa de orifício + LD301 (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const ld301Pins = ["high", "low", "loop_plus", "loop_minus"].map((id, index) => ({ id, x: 0, y: index * 12 }));
const near = (actual: number, expected: number, tolerance: number) => Math.abs(actual - expected) <= tolerance;
const DP_AT_15 = 3376.285174987; // mmH2O, water 20 C, D 52.5 mm, d 31.5 mm, flange taps
const DP_AT_7_5 = 836.081491565;

/** HART frame to the LD301 (long address BE 01 05 F0 4D). */
function hartRequest(command: number, data: Buffer = Buffer.alloc(0)): string {
  const body = Buffer.concat([Buffer.from([0x82, 0xbe, 0x01, 0x05, 0xf0, 0x4d, command, data.length]), data]);
  const checksum = body.reduce((xor, octet) => xor ^ octet, 0);
  return Buffer.concat([Buffer.alloc(5, 0xff), body, Buffer.from([checksum])]).toString("hex");
}

(async () => {
  const pipeName = `lasecsimul-orifice-plate-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 20_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    const plant = await client.addComponent("subcircuits.process.orifice_flow_dp", {}, [], "Placa (teste)");
    const ld301 = await client.addComponent("subcircuits.hart.smar_ld301", {}, ld301Pins, "LD301 (teste)");
    const inner = await client.getSubcircuitChildInstanceId(ld301.instanceId, "ld301");
    const valve = await client.addComponent("graphics.slider", { value: 100, actionMin: 0, actionMax: 100 }, [{ id: "out", x: 0, y: 0 }], "Válvula");
    const pin = (component: typeof plant, id: string) => {
      const exposed = component.exposedSignalPins?.[id];
      assert(Boolean(exposed), `${id} deve ser um pino de sinal exposto`);
      return { componentId: exposed!.instanceId, pinId: exposed!.pinId };
    };
    await client.applyWireTopologyTransaction([
      { kind: "connect", from: { componentId: valve.instanceId, pinId: "out" }, to: pin(plant, "valve") },
      { kind: "connect", from: pin(plant, "high"), to: pin(ld301, "high") },
      { kind: "connect", from: pin(plant, "low"), to: pin(ld301, "low") },
    ]);
    const child = async (localId: string) => client.getSubcircuitChildInstanceId(plant.instanceId, localId);
    const read = async (localId: string): Promise<number> => (await client.getComponentState(await child(localId))).readDoubleLE(0);
    const pv = async (): Promise<number> => {
      const frame = Buffer.from((await client.hartTransact(inner, hartRequest(1))).frameHex, "hex");
      return frame.readFloatBE(16);
    };
    const loop = async (): Promise<{ milliamps: number; percent: number }> => {
      const frame = Buffer.from((await client.hartTransact(inner, hartRequest(2))).frameHex, "hex");
      return { milliamps: frame.readFloatBE(15), percent: frame.readFloatBE(19) };
    };
    await client.step(20_000_000_000);

    await test("válvula 100 %: 15 m³/h e ΔP = 3376,3 mmH2O (ISO 5167-2, fluids)", async () => {
      assert(near(await read("q"), 15, 1e-6), `vazão ${await read("q")} m³/h`);
      assert(near(await read("c_iso"), 0.612422441827, 1e-8), `C ${await read("c_iso")}`);
      assert(near(await read("dp_mm"), DP_AT_15, 0.01), `ΔP ${await read("dp_mm")} mmH2O`);
      assert(near((await read("p_high")) - (await read("p_low")), DP_AT_15, 0.01), "HIGH − LOW = ΔP");
    });

    await test("o LD301 mede HIGH − LOW: PV = ΔP da placa", async () => {
      assert(near(await pv(), DP_AT_15, 0.05), `PV ${await pv()}`);
    });

    await test("faixa 0…3376,3 mmH2O (Comando 35) + raiz quadrada (Comando 47): 20 mA a 15 m³/h", async () => {
      const range = Buffer.alloc(9);
      range[0] = 4; // mmH2O @ 20 C
      range.writeFloatBE(DP_AT_15, 1); // URV: ΔP na vazão máxima
      range.writeFloatBE(0, 5); // LRV
      const rangeReply = Buffer.from((await client.hartTransact(inner, hartRequest(35, range))).frameHex, "hex");
      assert(rangeReply[13] === 0, `Comando 35 rejeitado: RC ${rangeReply[13]}`);
      const sqrtReply = Buffer.from((await client.hartTransact(inner, hartRequest(47, Buffer.from([1])))).frameHex, "hex");
      assert(sqrtReply[13] === 0, `Comando 47 rejeitado: RC ${sqrtReply[13]}`);
      await client.step(50_000_000);
      const { milliamps } = await loop();
      assert(near(milliamps, 20, 0.01), `corrente ${milliamps} mA`);
    });

    await test("válvula 50 %: ΔP cai a ~1/4 e a raiz devolve ~50 % da vazão (C muda com Re)", async () => {
      await client.setProperty(valve.instanceId, "value", 50);
      await client.step(20_000_000_000);
      assert(near(await read("q"), 7.5, 1e-6), `vazão ${await read("q")} m³/h`);
      assert(near(await read("dp_mm"), DP_AT_7_5, 0.01), `ΔP ${await read("dp_mm")} mmH2O`);
      const expectedPercent = 10 * Math.sqrt((100 * DP_AT_7_5) / DP_AT_15);
      const { milliamps, percent } = await loop();
      assert(near(percent, expectedPercent, 0.02), `saída ${percent} %, esperado ${expectedPercent}`);
      assert(near(milliamps, 4 + 0.16 * expectedPercent, 0.01), `corrente ${milliamps} mA`);
    });

    await test("User Unit em m³/h e display em PV (sequência do PACTware): o LD301 indica a vazão", async () => {
      const send = async (command: number, data: Buffer) => {
        const reply = Buffer.from((await client.hartTransact(inner, hartRequest(command, data))).frameHex, "hex");
        assert(reply[13] === 0, `Comando ${command} rejeitado: RC ${reply[13]}`);
      };
      const float = (value: number) => { const b = Buffer.alloc(4); b.writeFloatBE(value, 0); return b; };
      await send(191, Buffer.from([0])); // corte abrupto
      await send(157, float(6)); // corte em 6 %
      await send(180, Buffer.from([0])); // User Unit On
      await send(177, Buffer.concat([Buffer.from([19]), Buffer.from("m3/h", "ascii"), Buffer.alloc(8)])); // m³/h (código 19)
      await send(179, Buffer.concat([float(15), float(0)])); // 100 % = 15 m³/h, 0 % = 0
      await send(165, Buffer.from([4, 0])); // display: PV e OUT
      await client.step(50_000_000);
      const reading = Buffer.from((await client.hartTransact(inner, hartRequest(33, Buffer.from([4])))).frameHex, "hex");
      const indicated = reading.readFloatBE(17);
      // O transmissor assume C constante: 7,5 m³/h reais aparecem como 15·√(ΔP/ΔPmax) = 7,46 m³/h.
      const expected = 15 * Math.sqrt(DP_AT_7_5 / DP_AT_15);
      assert(reading[15] === 4 && reading[16] === 19, `DV ${reading[15]} unidade ${reading[16]}`);
      assert(near(indicated, expected, 0.005), `vazão indicada ${indicated} m³/h, esperado ${expected}`);
      await client.setProperty(valve.instanceId, "value", 100);
      await client.step(20_000_000_000);
      const full = Buffer.from((await client.hartTransact(inner, hartRequest(33, Buffer.from([4])))).frameHex, "hex");
      assert(near(full.readFloatBE(17), 15, 0.005), `vazão indicada a 100 %: ${full.readFloatBE(17)} m³/h`);
    });

    await test("tomada D e D/2 e trecho a montante curto mudam C com a simulação rodando", async () => {
      await client.setProperty(valve.instanceId, "value", 100);
      await client.step(20_000_000_000);
      await client.setSubcircuitChildProperty(plant.instanceId, "c_tap", "value", 2);
      await client.step(50_000_000);
      assert(near(await read("c_iso"), 0.612965722556, 1e-8), `C D e D/2 ${await read("c_iso")}`);
      await client.setSubcircuitChildProperty(plant.instanceId, "c_tap", "value", 1);
      await client.setSubcircuitChildProperty(plant.instanceId, "c_lup", "value", 10);
      await client.step(50_000_000);
      assert((await read("ok_up")) === 0, "montante de 10 D (exige 42 D com β 0,6) não é conforme");
      assert(near(await read("dp_mm"), 3319.865147240, 0.01), `ΔP com o C desviado ${await read("dp_mm")}`);
    });

    await test("material e temperatura: inox a 80 °C dilata o orifício e reduz o ΔP", async () => {
      await client.setSubcircuitChildProperty(plant.instanceId, "c_lup", "value", 44);
      await client.step(50_000_000);
      const before = await read("dp_mm");
      await client.setSubcircuitChildProperty(plant.instanceId, "c_T", "value", 80);
      await client.step(50_000_000);
      assert(near(await read("d_T"), 31.5 * (1 + 16e-6 * 60), 1e-9), `d a 80 °C ${await read("d_T")}`);
      assert(near(await read("D_T"), 52.5 * (1 + 11.2e-6 * 60), 1e-9), `D a 80 °C ${await read("D_T")}`);
      assert((await read("dp_mm")) < before, `ΔP ${await read("dp_mm")} deve ficar abaixo de ${before}`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

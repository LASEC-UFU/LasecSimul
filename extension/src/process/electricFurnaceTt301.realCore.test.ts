import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";

/**
 * Electric furnace with a type K thermocouple (`subcircuits/process_electric_furnace_tc.lssubcircuit`)
 * wired to the terminals 2 (+) and 3 (-) of the TT301 (1, 3 and 4 jumpered, manual Fig. 1.9), on a REAL
 * Core. The TT301 is configured like PACTware does (Cmd 131 TC K, Cmd 186 cold junction enabled).
 *
 * Outside `npm test` (needs the compiled Core):
 *   npm run compile && node out/process/electricFurnaceTt301.realCore.test.js
 */
const { test, finish } = createTestRunner("Forno elétrico + termopar K + TT301 (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const tt301Pins = ["s1", "s2", "s3", "s4", "loop_plus", "loop_minus"].map((id, index) => ({ id, x: 0, y: index * 12 }));
const longAddress = "82be02010c3a";

function request(command: number, data: number[] = []): string {
  const frame = Buffer.concat([Buffer.from(longAddress, "hex"), Buffer.from([command, data.length, ...data])]);
  const checksum = frame.reduce((xor, octet) => xor ^ octet, 0);
  return Buffer.concat([Buffer.alloc(5, 0xff), frame, Buffer.from([checksum])]).toString("hex");
}

/** The plant's model with its 10 ms Euler step: furnace and measuring junction temperature. */
function simulate(seconds: number, heaterPercent: number, start = { furnace: 25, sensor: 25 }) {
  const capacity = 1500;
  let { furnace, sensor } = start;
  for (let step = 0; step < Math.round(seconds / 0.01); step++) {
    const gain = (3000 * heaterPercent / 100) / capacity;
    const loss = 2.5 * (furnace - 25) / capacity;
    const next = Math.max(0, furnace + 0.01 * (gain - loss));
    sensor = Math.max(0, sensor + 0.01 * (furnace - sensor) / 20);
    furnace = next;
  }
  return { furnace, sensor };
}

(async () => {
  const pipeName = `lasecsimul-furnace-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    const plant = await client.addComponent("subcircuits.process.electric_furnace_tc", {}, [], "Forno (teste)");
    const tt301 = await client.addComponent("subcircuits.hart.smar_tt301", {}, tt301Pins, "TT301 (teste)");
    const inner = await client.getSubcircuitChildInstanceId(tt301.instanceId, "tt301");
    const heater = await client.addComponent("graphics.slider", { value: 0, actionMin: 0, actionMax: 100 }, [{ id: "out", x: 0, y: 0 }], "Aquecimento");
    const signal = plant.exposedSignalPins?.heater;
    assert(Boolean(signal), "pino de aquecimento exposto");
    const port = (component: typeof plant, id: string) => {
      const exposed = component.exposedPins?.[id];
      assert(Boolean(exposed), `${id} exposto`);
      return { componentId: exposed!.instanceId, pinId: exposed!.pinId };
    };
    await client.applyWireTopologyTransaction([
      { kind: "connect", from: { componentId: heater.instanceId, pinId: "out" }, to: { componentId: signal!.instanceId, pinId: signal!.pinId } },
      { kind: "connect", from: port(plant, "tc_p"), to: port(tt301, "s2") },
      { kind: "connect", from: port(plant, "tc_n"), to: port(tt301, "s3") },
      { kind: "connect", from: port(tt301, "s1"), to: port(tt301, "s3") },
      { kind: "connect", from: port(tt301, "s3"), to: port(tt301, "s4") },
    ]);
    const child = async (localId: string) => client.getSubcircuitChildInstanceId(plant.instanceId, localId);
    const read = async (localId: string): Promise<number> => (await client.getComponentState(await child(localId))).readDoubleLE(0);
    const transact = async (command: number, data: number[] = []) => {
      const frame = Buffer.from((await client.hartTransact(inner, request(command, data))).frameHex, "hex");
      return frame.subarray(frame.findIndex((octet) => octet === 0x86));
    };
    const pv = async (): Promise<number> => (await transact(1)).readFloatBE(11);
    const current = async (): Promise<number> => {
      const frame = await client.getTelemetryFrame({ items: [{ key: "live", instanceId: inner }], probes: [] }, 0);
      return frame.componentStates["live"]!.readDoubleLE(0);
    };
    const setParameter = (id: string, value: number) => client.setSubcircuitChildProperty(plant.instanceId, id, "value", value);

    await test("em repouso: forno a 25 °C, FEM 0 mV; com o TT301 em termopar K (Cmd 131/186) a leitura é 25 °C", async () => {
      assert((await transact(131, [0x00, 0x83, 0x03, 0x01]))[8] === 0, "Cmd 131");
      assert((await transact(186, [0x00, 0x00]))[8] === 0, "Cmd 186");
      await client.step(2_000_000_000);
      assert(Math.abs(await read("temp") - 25) < 1e-9, `forno ${await read("temp")}`);
      assert(Math.abs(await read("e_tc")) < 1e-9, `FEM ${await read("e_tc")}`);
      assert(Math.abs((await pv()) - 25) < 0.06, `PV ${await pv()}`);
    });

    await test("aquecimento a 100 % por 120 s: forno e junta de medição seguem o modelo e o TT301 acompanha", async () => {
      await client.setProperty(heater.instanceId, "value", 100);
      await client.step(120_000_000_000);
      const expected = simulate(120, 100);
      const furnace = await read("temp");
      const sensor = await read("sensor_temp");
      assert(Math.abs(furnace - expected.furnace) < 0.2, `forno ${furnace}, esperado ${expected.furnace}`);
      assert(Math.abs(sensor - expected.sensor) < 0.2, `termopar ${sensor}, esperado ${expected.sensor}`);
      assert(sensor < furnace - 5, `o tubo atrasa a leitura: forno ${furnace}, termopar ${sensor}`);
      assert(Math.abs((await pv()) - sensor) < 0.1, `TT301 ${await pv()} x termopar ${sensor}`);
      await client.setProperty(heater.instanceId, "value", 0);
    });

    await test("desvio do termopar de +2 °C aparece no TT301 (o erro que a calibração encontra)", async () => {
      const sensor = await read("sensor_temp");
      await setParameter("c_dev", 2);
      await client.step(20_000_000);
      const now = await read("sensor_temp");
      assert(Math.abs((await pv()) - (now + 2)) < 0.1, `PV ${await pv()} x termopar ${now} (+2; antes ${sensor})`);
      await setParameter("c_dev", 0);
    });

    await test("cabo de cobre a partir do cabeçote a 60 °C: a leitura fica ~35 °C abaixo (junta de referência errada)", async () => {
      await setParameter("c_cable", 1);
      await client.step(20_000_000);
      const error = (await read("sensor_temp")) - (await pv());
      assert(error > 32 && error < 38, `erro ${error} °C`);
      await setParameter("c_cable", 0);
    });

    await test("polaridade invertida: a temperatura lida fica abaixo do ambiente", async () => {
      await setParameter("c_reverse", 1);
      await client.step(20_000_000);
      assert((await pv()) < 0, `PV ${await pv()}`);
      await setParameter("c_reverse", 0);
    });

    await test("termopar rompido: o TT301 vai ao burnout (21 mA) e volta quando religado", async () => {
      await setParameter("c_broken", 1);
      await client.step(50_000_000);
      assert(Math.abs((await current()) - 21) < 0.01, `burnout ${await current()} mA`);
      await setParameter("c_broken", 0);
      await client.step(50_000_000);
      assert((await current()) < 20.5, `religado: ${await current()} mA`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

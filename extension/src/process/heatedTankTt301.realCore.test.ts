import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";

/**
 * Heated tank with a Pt100 (`subcircuits/process_heated_tank_pt100.lssubcircuit`) wired with a 4-wire
 * cable to the terminals 1-4 of the TT301, on a REAL Core: the transmitter measures the element and
 * the cable as resistances (bridges.controlled_resistor) and must read the sensor temperature.
 *
 * Outside `npm test` (needs the compiled Core):
 *   npm run compile && node out/process/heatedTankTt301.realCore.test.js
 */
const { test, finish } = createTestRunner("Tanque aquecido + Pt100 + TT301 a 4 fios (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const tt301Pins = ["s1", "s2", "s3", "s4", "loop_plus", "loop_minus"].map((id, index) => ({ id, x: 0, y: index * 12 }));
const longAddress = "be02010c3a";

function request(command: number): string {
  const frame = Buffer.concat([Buffer.from("82" + longAddress, "hex"), Buffer.from([command, 0])]);
  const checksum = frame.reduce((xor, octet) => xor ^ octet, 0);
  return Buffer.concat([Buffer.alloc(5, 0xff), frame, Buffer.from([checksum])]).toString("hex");
}

/** The same model, integrated here with the plant's 10 ms Euler step: water and sensor temperature. */
function simulate(seconds: number, heaterPercent: number, start = { water: 25, sensor: 25 }) {
  const mc = 4186 * 10;
  let { water, sensor } = start;
  for (let step = 0; step < Math.round(seconds / 0.01); step++) {
    const gain = (6000 * heaterPercent / 100) / mc;
    const loss = 80 * (water - 25) / mc;
    const nextWater = Math.max(0, water + 0.01 * (gain - loss));
    sensor = Math.max(0, sensor + 0.01 * (water - sensor) / 15);
    water = nextWater;
  }
  return { water, sensor };
}

(async () => {
  const pipeName = `lasecsimul-heated-tank-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 30_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    const plant = await client.addComponent("subcircuits.process.heated_tank_pt100", {}, [], "Tanque aquecido (teste)");
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
      ...[1, 2, 3, 4].map((n) => ({ kind: "connect" as const, from: port(plant, `rtd${n}`), to: port(tt301, `s${n}`) })),
    ]);
    const child = async (localId: string) => client.getSubcircuitChildInstanceId(plant.instanceId, localId);
    const read = async (localId: string): Promise<number> => (await client.getComponentState(await child(localId))).readDoubleLE(0);
    const pv = async (): Promise<number> => Buffer.from((await client.hartTransact(inner, request(1))).frameHex, "hex").readFloatBE(16);
    const current = async (): Promise<number> => {
      const frame = await client.getTelemetryFrame({ items: [{ key: "live", instanceId: inner }], probes: [] }, 0);
      return frame.componentStates["live"]!.readDoubleLE(0);
    };

    await test("em repouso: água e sensor a 25 °C, Pt100 com 109,73 Ω e o TT301 lê 25,00 °C pelos bornes 1-4", async () => {
      await client.step(2_000_000_000);
      assert(Math.abs((await read("temp")) - 25) < 1e-9, `água ${await read("temp")}`);
      assert(Math.abs((await read("r_pt100")) - 109.7347) < 0.001, `R ${await read("r_pt100")}`);
      assert(Math.abs((await pv()) - 25) < 0.01, `PV ${await pv()}`);
    });

    await test("aquecimento a 100 % por 60 s: a água e o sensor seguem o balanço de energia e o atraso do poço", async () => {
      await client.setProperty(heater.instanceId, "value", 100);
      await client.step(60_000_000_000);
      const expected = simulate(60, 100);
      const water = await read("temp");
      const sensor = await read("sensor_temp");
      assert(Math.abs(water - expected.water) < 0.05, `água ${water}, esperado ${expected.water}`);
      assert(Math.abs(sensor - expected.sensor) < 0.05, `sensor ${sensor}, esperado ${expected.sensor}`);
      assert(sensor < water - 1, `o poço atrasa a leitura: água ${water}, sensor ${sensor}`);
      assert(Math.abs((await pv()) - sensor) < 0.02, `TT301 ${await pv()} x sensor ${sensor}`);
    });

    await test("desvio do sensor de +0,5 °C aparece no TT301 (o erro que a calibração encontra)", async () => {
      await client.setProperty(heater.instanceId, "value", 0);
      const before = await read("sensor_temp");
      await client.setSubcircuitChildProperty(plant.instanceId, "c_dev", "value", 0.5);
      await client.step(20_000_000);
      const sensor = await read("sensor_temp");
      assert(Math.abs((await pv()) - (sensor + 0.5)) < 0.02, `PV ${await pv()} x sensor ${sensor} (+0,5; antes ${before})`);
      await client.setSubcircuitChildProperty(plant.instanceId, "c_dev", "value", 0);
    });

    await test("sensor rompido: o TT301 vai ao burnout (21 mA) e volta quando o sensor é religado", async () => {
      await client.setSubcircuitChildProperty(plant.instanceId, "c_broken", "value", 1);
      await client.step(50_000_000);
      assert(Math.abs((await current()) - 21) < 0.01, `burnout ${await current()} mA`);
      await client.setSubcircuitChildProperty(plant.instanceId, "c_broken", "value", 0);
      await client.step(50_000_000);
      assert((await current()) < 20, `sensor religado: ${await current()} mA`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

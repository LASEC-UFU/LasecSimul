import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";

/**
 * Pressurized tank (`subcircuits/process_pressurized_tank_dp.lssubcircuit`) wired to the LD301 on a
 * REAL Core: valve openings from two sliders, HIGH/LOW legs into the transmitter, level dynamics,
 * parameters (control.constant) changed with the simulation running, and the LD301 reading the
 * elevated-zero differential pressure.
 *
 * Outside `npm test` (needs the compiled Core):
 *   npm run compile && node out/process/pressurizedTank.realCore.test.js
 */
const { test, finish } = createTestRunner("Tanque pressurizado + LD301 (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const ld301Pins = ["high", "low", "loop_plus", "loop_minus"].map((id, index) => ({ id, x: 0, y: index * 12 }));
const near = (actual: number, expected: number, tolerance: number) => Math.abs(actual - expected) <= tolerance;

/** HART frame to the LD301 (long address BE 01 05 F0 4D). */
function hartRequest(command: number, data: Buffer = Buffer.alloc(0)): string {
  const body = Buffer.concat([Buffer.from([0x82, 0xbe, 0x01, 0x05, 0xf0, 0x4d, command, data.length]), data]);
  const checksum = body.reduce((xor, octet) => xor ^ octet, 0);
  return Buffer.concat([Buffer.alloc(5, 0xff), body, Buffer.from([checksum])]).toString("hex");
}

(async () => {
  const pipeName = `lasecsimul-pressurized-tank-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 20_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    const plant = await client.addComponent("subcircuits.process.pressurized_tank_dp", {}, [], "Tanque (teste)");
    const ld301 = await client.addComponent("subcircuits.hart.smar_ld301", {}, ld301Pins, "LD301 (teste)");
    const inner = await client.getSubcircuitChildInstanceId(ld301.instanceId, "ld301");
    const valveIn = await client.addComponent("graphics.slider", { value: 0, actionMin: 0, actionMax: 100 }, [{ id: "out", x: 0, y: 0 }], "Válvula entrada");
    const valveOut = await client.addComponent("graphics.slider", { value: 0, actionMin: 0, actionMax: 100 }, [{ id: "out", x: 0, y: 0 }], "Válvula saída");
    const pin = (component: typeof plant, id: string) => {
      const exposed = component.exposedSignalPins?.[id];
      assert(Boolean(exposed), `${id} deve ser um pino de sinal exposto`);
      return { componentId: exposed!.instanceId, pinId: exposed!.pinId };
    };
    await client.applyWireTopologyTransaction([
      { kind: "connect", from: { componentId: valveIn.instanceId, pinId: "out" }, to: pin(plant, "valve_in") },
      { kind: "connect", from: { componentId: valveOut.instanceId, pinId: "out" }, to: pin(plant, "valve_out") },
      { kind: "connect", from: pin(plant, "high"), to: pin(ld301, "high") },
      { kind: "connect", from: pin(plant, "low"), to: pin(ld301, "low") },
    ]);
    const child = async (localId: string) => client.getSubcircuitChildInstanceId(plant.instanceId, localId);
    const read = async (localId: string): Promise<number> => (await client.getComponentState(await child(localId))).readDoubleLE(0);
    const pv = async (): Promise<number> => {
      const frame = Buffer.from((await client.hartTransact(inner, hartRequest(1))).frameHex, "hex");
      return frame.readFloatBE(16);
    };
    await client.step(200_000_000);

    await test("nível inicial 1,5 m: HIGH = 1000·(1,5 + 0,2) + 101,97·50 e LOW = 1000·(3 + 0,2) + 101,97·50 mmH2O", async () => {
      const gas = 101.972 * 50;
      assert(near(await read("tank"), 1.5, 1e-6), `nível ${await read("tank")} m`);
      assert(near(await read("p_high"), 1700 + gas, 0.01), `HIGH ${await read("p_high")}`);
      assert(near(await read("p_low"), 3200 + gas, 0.01), `LOW ${await read("p_low")}`);
      assert(near(await read("dp"), -1500, 0.01), `ΔP ${await read("dp")}`);
      assert(near(await read("level_percent"), 50, 1e-6), `nível ${await read("level_percent")} %`);
    });

    await test("o LD301 mede HIGH − LOW: PV = −1500 mmH2O (zero elevado pela perna molhada)", async () => {
      assert(near(await pv(), -1500, 0.05), `PV ${await pv()}`);
    });

    await test("com a faixa −3000…0 mmH2O (Comando 35) o laço vai a 12 mA = 50 % do nível", async () => {
      const range = Buffer.alloc(9);
      range[0] = 4; // mmH2O @ 20 C
      range.writeFloatBE(0, 1); // URV: tanque cheio
      range.writeFloatBE(-3000, 5); // LRV: tanque vazio
      const reply = Buffer.from((await client.hartTransact(inner, hartRequest(35, range))).frameHex, "hex");
      assert(reply[13] === 0, `Comando 35 rejeitado: RC ${reply[13]}`);
      await client.step(50_000_000);
      const current = Buffer.from((await client.hartTransact(inner, hartRequest(2))).frameHex, "hex");
      assert(near(current.readFloatBE(15), 12, 0.01), `corrente ${current.readFloatBE(15)} mA`);
      assert(near(current.readFloatBE(19), 50, 0.05), `% da faixa ${current.readFloatBE(19)}`);
    });

    await test("válvula de entrada 100 %: 36 m³/h em 0,785 m² sobem o nível 12,7 mm/s", async () => {
      await client.setProperty(valveIn.instanceId, "value", 100);
      await client.step(10_000_000_000);
      const rise = (await read("tank")) - 1.5;
      assert(near(await read("q_in"), 36, 0.01), `vazão de entrada ${await read("q_in")} m³/h`);
      assert(near(rise, 10 * 36 / 3600 / (Math.PI / 4), 0.002), `subida em 10 s: ${rise} m`);
      assert((await read("q_out")) === 0, "saída fechada não escoa");
    });

    await test("abrir a saída: a vazão depende da coluna e do gás e o nível passa a cair", async () => {
      await client.setProperty(valveIn.instanceId, "value", 0);
      await client.setProperty(valveOut.instanceId, "value", 100);
      await client.step(100_000_000);
      const h = await read("tank");
      const expected = 36 * Math.sqrt((h + 0.101972 * 50) / (3 + 0.101972 * 50));
      assert(near(await read("q_out"), expected, 0.05), `vazão de saída ${await read("q_out")}, esperado ${expected}`);
      await client.step(5_000_000_000);
      assert((await read("tank")) < h, "o nível deve cair");
    });

    await test("parâmetros mudam com a simulação rodando: densidade do selo e pressão do gás", async () => {
      const lowBefore = await read("p_low");
      const dpBefore = await read("dp");
      await client.setSubcircuitChildProperty(plant.instanceId, "c_sg_seal", "value", 0.9);
      await client.step(50_000_000);
      const gas = 101.972 * 50;
      assert(near(await read("p_low"), 0.9 * 3200 + gas, 0.01), `LOW com selo 0,9: ${await read("p_low")} (antes ${lowBefore})`);
      assert(near((await read("dp")) - dpBefore, 320, 1), `o zero elevado diminui 320 mmH2O: ${(await read("dp")) - dpBefore}`);
      const dp = await read("dp");
      await client.setSubcircuitChildProperty(plant.instanceId, "c_gas", "value", 200);
      await client.step(50_000_000);
      assert(near(await read("dp"), dp, 30), `a pressão do gás age nas duas pernas e se cancela no ΔP: ${await read("dp")} vs ${dp}`);
    });

    await test("altura e capilar configuráveis: H 2 m e Lcap 0,5 m mudam LOW para 1000·SGselo·2,5", async () => {
      await client.setSubcircuitChildProperty(plant.instanceId, "c_height", "value", 2);
      await client.setSubcircuitChildProperty(plant.instanceId, "c_capillary", "value", 0.5);
      await client.step(50_000_000);
      assert(near(await read("p_low"), 1000 * 0.9 * 2.5 + 101.972 * 200, 0.05), `LOW ${await read("p_low")}`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

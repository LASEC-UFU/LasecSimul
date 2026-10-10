import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";

/**
 * TT301 with a thermocouple, on a REAL Core: the palette thermocouple (`sensors.thermocouple`, native
 * device in devices/simulide-sensors) wired as in Fig. 1.9 of the TT301 manual (+ on terminal 2, - on
 * terminal 3, terminals 1, 3 and 4 jumpered), the sensor configured through HART like PACTware does
 * (Cmd 131 TC / type, Cmd 186 cold junction). Expected values come from the NIST ITS-90 tables.
 *
 * Outside `npm test` (needs the compiled Core and the sensors device DLL):
 *   npm run compile && node out/hart/hartTt301Thermocouple.realCore.test.js
 */
const { test, finish } = createTestRunner("TT301 com termopar nos bornes 2 e 3 (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const tt301Pins = ["s1", "s2", "s3", "s4", "loop_plus", "loop_minus"].map((id, index) => ({ id, x: 0, y: index * 12 }));
const longAddress = "82be02010c3a";

function request(command: number, data: number[] = []): string {
  const frame = Buffer.concat([Buffer.from(longAddress, "hex"), Buffer.from([command, data.length, ...data])]);
  const checksum = frame.reduce((xor, octet) => xor ^ octet, 0);
  return Buffer.concat([Buffer.alloc(5, 0xff), frame, Buffer.from([checksum])]).toString("hex");
}

// NIST ITS-90 type K (mV, reference junction at 0 degC).
const K = { 25: 1.0, 40: 1.612, 500: 20.644 };

(async () => {
  const pipeName = `lasecsimul-tt301-tc-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 30_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "devices", "library.json"));
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    const tt301 = await client.addComponent("subcircuits.hart.smar_tt301", {}, tt301Pins, "TT301 (teste)");
    const inner = await client.getSubcircuitChildInstanceId(tt301.instanceId, "tt301");
    const tc = await client.addComponent("sensors.thermocouple", { temp: 500, ref_temp: 25, tc_type: 3, r_loop: 5 },
      [{ id: "p", x: 0, y: 0 }, { id: "n", x: 64, y: 0 }], "Termopar K (teste)");
    const port = (id: string) => {
      const exposed = tt301.exposedPins?.[id];
      assert(Boolean(exposed), `${id} exposto`);
      return { componentId: exposed!.instanceId, pinId: exposed!.pinId };
    };
    await client.applyWireTopologyTransaction([
      { kind: "connect", from: { componentId: tc.instanceId, pinId: "p" }, to: port("s2") },
      { kind: "connect", from: { componentId: tc.instanceId, pinId: "n" }, to: port("s3") },
      { kind: "connect", from: port("s1"), to: port("s3") },
      { kind: "connect", from: port("s3"), to: port("s4") },
    ]);
    const transact = async (command: number, data: number[] = []) => {
      const frame = Buffer.from((await client.hartTransact(inner, request(command, data))).frameHex, "hex");
      const start = frame.findIndex((octet) => octet === 0x86);
      return frame.subarray(start);
    };
    const pv = async (): Promise<number> => (await transact(1)).readFloatBE(11);
    const current = async (): Promise<number> => {
      const frame = await client.getTelemetryFrame({ items: [{ key: "live", instanceId: inner }], probes: [] }, 0);
      return frame.componentStates["live"]!.readDoubleLE(0);
    };

    await test("o termopar K da paleta gera E(500) − E(25) = 19,644 mV (NIST ITS-90)", async () => {
      await client.step(20_000_000);
      const emf = Number(await client.getProperty(tc.instanceId, "emf_mv"));
      assert(Math.abs(emf - (K[500] - K[25])) < 0.0006, `EMF ${emf} mV`);
    });

    await test("Cmd 131 TC K (83 03) + Cmd 186 junta fria habilitada: o TT301 lê 500 °C", async () => {
      const write = await transact(131, [0x00, 0x83, 0x03, 0x01]);
      assert(write[8] === 0, `Cmd 131 RC ${write[8]}`);
      const cold = await transact(186, [0x00, 0x00]);
      assert(cold[8] === 0, `Cmd 186 RC ${cold[8]}`);
      await client.step(50_000_000);
      const value = await pv();
      assert(Math.abs(value - 500) < 0.06, `PV ${value}`);
    });

    await test("bornes e junta de referência a 40 °C: a compensação acompanha e a leitura continua 500 °C", async () => {
      await client.setProperty(tc.instanceId, "ref_temp", 40);
      await client.setSubcircuitChildProperty(tt301.instanceId, "c_tterm", "value", 40);
      await client.step(50_000_000);
      const value = await pv();
      assert(Math.abs(value - 500) < 0.06, `PV ${value}`);
      await client.setProperty(tc.instanceId, "ref_temp", 25);
      await client.setSubcircuitChildProperty(tt301.instanceId, "c_tterm", "value", 25);
    });

    await test("junta fria desabilitada: falta E(25) = 1,000 mV e a leitura cai para 476,5 °C", async () => {
      await transact(186, [0x00, 0x01]);
      await client.step(50_000_000);
      const value = await pv();
      // NIST type K: 19.644 mV = 476.52 degC.
      assert(Math.abs(value - 476.52) < 0.06, `PV ${value}`);
      await transact(186, [0x00, 0x00]);
    });

    await test("termopar rompido: o TT301 vai ao burnout (21 mA)", async () => {
      await client.setProperty(tc.instanceId, "broken", true);
      await client.step(50_000_000);
      assert(Math.abs((await current()) - 21) < 0.01, `burnout ${await current()} mA`);
      await client.setProperty(tc.instanceId, "broken", false);
      await client.step(50_000_000);
      assert((await current()) < 20.5, `religado: ${await current()} mA`);
    });

    await test("tipo J configurado com um termopar K ligado: leitura errada (o erro de tipo trocado)", async () => {
      await transact(131, [0x00, 0x83, 0x02, 0x01]);
      await client.step(50_000_000);
      const value = await pv();
      assert(Math.abs(value - 500) > 20, `PV ${value} deveria ficar longe de 500 °C`);
      await transact(131, [0x00, 0x83, 0x03, 0x01]);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

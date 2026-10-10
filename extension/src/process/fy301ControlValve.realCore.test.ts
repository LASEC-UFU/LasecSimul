import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";

/**
 * FY301 valve positioner (`subcircuits/hart_smar_fy301.lssubcircuit`) on a globe valve with a
 * spring-diaphragm actuator (`subcircuits/process_control_valve.lssubcircuit`), on a REAL Core.
 * The controller's analog output (a current source) WRITES the 4-20 mA; the FY301 reads it (loop
 * powered, ~550 ohm), drives OUT1 and reads the stem travel through the magnet.
 *
 * Outside `npm test` (needs the compiled Core):
 *   npm run compile && node out/process/fy301ControlValve.realCore.test.js
 */
const { test, finish } = createTestRunner("FY301 + válvula de controle (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const fyPins = ["supply", "out1", "position", "loop_plus", "loop_minus"].map((id, index) => ({ id, x: 0, y: index * 12 }));
const longAddress = "82be030b2a61"; // Smar (3E | 0x80), FY301 device type 03, ID 0B 2A 61

function request(command: number, data: number[] = []): string {
  const frame = Buffer.concat([Buffer.from(longAddress, "hex"), Buffer.from([command, data.length, ...data])]);
  const checksum = frame.reduce((xor, octet) => xor ^ octet, 0);
  return Buffer.concat([Buffer.alloc(5, 0xff), frame, Buffer.from([checksum])]).toString("hex");
}

(async () => {
  const pipeName = `lasecsimul-fy301-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    const valve = await client.addComponent("subcircuits.process.control_valve", {}, [], "Válvula (teste)");
    const fy = await client.addComponent("subcircuits.hart.smar_fy301", {}, fyPins, "FY301 (teste)");
    const inner = await client.getSubcircuitChildInstanceId(fy.instanceId, "fy301");
    const command = await client.addComponent("control.constant", { value: 0.012 }, [{ id: "out", x: 0, y: 0 }], "Saída do controlador (A)");
    // The palette passes every catalog pin (the signal port first), as the editor does.
    const ao = await client.addComponent("bridges.controlled_current_source", {}, [{ id: "command", x: 0, y: 0 }, { id: "p", x: 0, y: 10 }, { id: "n", x: 0, y: 20 }],
      "Saída analógica 4-20 mA");
    const ground = await client.addComponent("other.ground", {}, [{ id: "pin", x: 0, y: 0 }], "GND");
    const port = (component: typeof fy, id: string) => {
      const exposed = component.exposedPins?.[id] ?? component.exposedSignalPins?.[id];
      assert(Boolean(exposed), `${id} exposto`);
      return { componentId: exposed!.instanceId, pinId: exposed!.pinId };
    };
    await client.applyWireTopologyTransaction([
      { kind: "connect", from: { componentId: command.instanceId, pinId: "out" }, to: { componentId: ao.instanceId, pinId: "command" } },
      { kind: "connect", from: { componentId: ao.instanceId, pinId: "p" }, to: port(fy, "loop_plus") },
      { kind: "connect", from: port(fy, "loop_minus"), to: { componentId: ao.instanceId, pinId: "n" } },
      { kind: "connect", from: { componentId: ao.instanceId, pinId: "n" }, to: { componentId: ground.instanceId, pinId: "pin" } },
      { kind: "connect", from: port(fy, "out1"), to: port(valve, "out1") },
      { kind: "connect", from: port(valve, "supply"), to: port(fy, "supply") },
      { kind: "connect", from: port(valve, "position"), to: port(fy, "position") },
    ]);
    const childOf = async (owner: string, localId: string) => client.getSubcircuitChildInstanceId(owner, localId);
    const read = async (owner: string, localId: string): Promise<number> =>
      (await client.getComponentState(await childOf(owner, localId))).readDoubleLE(0);
    const opening = () => read(valve.instanceId, "opening");
    const fyPosition = () => read(fy.instanceId, "pos");
    const setFy = (id: string, value: number) => client.setSubcircuitChildProperty(fy.instanceId, id, "value", value);
    const milliamps = async (value: number) => client.setProperty(command.instanceId, "value", value / 1000);
    const transact = async (cmd: number, data: number[] = []) => {
      const frame = Buffer.from((await client.hartTransact(inner, request(cmd, data))).frameHex, "hex");
      return frame.subarray(frame.findIndex((octet) => octet === 0x86));
    };

    await test("12 mA antes do Auto Setup: o FY301 lê 12 mA e posiciona pela escala de fábrica do sensor (abertura real ≠ 50 %)", async () => {
      await client.step(20_000_000_000);
      const position = await fyPosition();
      const real = await opening();
      assert(Math.abs(position - 50) < 1.5, `FY301 posição ${position}`);
      assert(Math.abs(real - 75) < 3, `abertura real ${real} (escala de fábrica de 30 mm num curso de 20 mm)`);
    });

    await test("Auto Setup: grava a posição sem ar e com ar total; depois 12 mA → 50 % de abertura", async () => {
      await setFy("c_setup", 1);
      await client.step(60_000_000_000);
      const rest = await read(fy.instanceId, "hold_rest");
      const full = await read(fy.instanceId, "hold_full");
      assert(Math.abs(rest - 0) < 0.3 && Math.abs(full - 20) < 0.3, `sem ar ${rest} mm, ar total ${full} mm`);
      await client.step(20_000_000_000);
      const real = await opening();
      assert(Math.abs(real - 50) < 1.5 && Math.abs((await fyPosition()) - 50) < 1.5, `abertura ${real}, FY ${await fyPosition()}`);
    });

    await test("HART: Cmd 2 informa a corrente lida (12,000 mA, 50 %); Cmd 33 lê a posição (variável 1) e a corrente (variável 2)", async () => {
      const cmd2 = await transact(2);
      const current = cmd2.readFloatBE(10);
      const percent = cmd2.readFloatBE(14);
      assert(Math.abs(current - 12) < 0.01 && Math.abs(percent - 50) < 0.1, `Cmd 2: ${current} mA, ${percent} %`);
      const cmd33 = await transact(33, [1, 2]);
      const position = cmd33.readFloatBE(12);
      const input = cmd33.readFloatBE(18);
      assert(cmd33[10] === 1 && cmd33[11] === 0x39 && Math.abs(position - (await fyPosition())) < 0.5, `Cmd 33 posição ${position}`);
      assert(cmd33[16] === 2 && cmd33[17] === 0x27 && Math.abs(input - 12) < 0.01, `Cmd 33 corrente ${input} mA`);
    });

    await test("4 mA fecha e 20 mA abre totalmente (ar para abrir, ação direta)", async () => {
      await milliamps(4);
      await client.step(15_000_000_000);
      const closed = await opening();
      await milliamps(20);
      await client.step(15_000_000_000);
      const open = await opening();
      assert(closed < 1 && open > 99, `4 mA ${closed} %, 20 mA ${open} %`);
    });

    await test("CHAR igual porcentagem 1:50: 12 mA → 12,4 % de abertura", async () => {
      await milliamps(12);
      await setFy("c_char", 3);
      await client.step(20_000_000_000);
      const real = await opening();
      assert(Math.abs(real - 12.39) < 1.2, `abertura ${real}`);
      await setFy("c_char", 0);
    });

    await test("modo manual: SP 30 % → 30 % de abertura, independente da corrente", async () => {
      await setFy("c_sp", 30);
      await setFy("c_mode", 1);
      await client.step(20_000_000_000);
      assert(Math.abs((await opening()) - 30) < 1.5, `abertura ${await opening()}`);
      await setFy("c_mode", 0);
    });

    await test("split range 4-12 mA: 8 mA → 50 %", async () => {
      await setFy("c_shi", 12);
      await milliamps(8);
      await client.step(20_000_000_000);
      assert(Math.abs((await opening()) - 50) < 1.5, `abertura ${await opening()}`);
      await setFy("c_shi", 20);
    });

    await test("sem sinal (2 mA, abaixo de 3,8 mA): o FY301 desliga, OUT1 esvazia e a mola leva a válvula à posição de falha (fechada)", async () => {
      await milliamps(2);
      await client.step(10_000_000_000);
      assert((await opening()) < 1 && (await read(fy.instanceId, "out1_bar")) < 0.01, `abertura ${await opening()}`);
      await milliamps(12);
      await client.step(10_000_000_000);
    });

    await test("AIR_T trocado (AIR_CLOSED num atuador ar-para-abrir): realimentação positiva, a válvula vai a um extremo", async () => {
      await milliamps(12);
      await setFy("c_air", 1);
      await client.step(20_000_000_000);
      const real = await opening();
      assert(real < 2 || real > 98, `abertura ${real}`);
      await setFy("c_air", 0);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { materializeEmbeddedSubcircuit } from "../project/embeddedSubcircuits";
import { createPlantTemplateLookup } from "../project/plantTemplates";

/**
 * FY301 valve positioner (`subcircuits/hart_smar_fy301.lssubcircuit`) on a globe valve with a
 * spring-diaphragm actuator (`subcircuits/process_control_valve.lssubcircuit`), on a REAL Core.
 * The controller's analog output (a current source) WRITES the 4-20 mA; the FY301 reads it (loop
 * powered, ~550 ohm), drives OUT1 and reads the stem travel through the magnet.
 *
 * The positioner is configured ONLY through HART, with the commands of the Smar FY301 DD (device
 * revision 2) exactly as the Smar FY301 DTM 3.02 sends them (docs/fy301-dtm-engenharia-reversa.md).
 *
 * Outside `npm test` (needs the compiled Core):
 *   npm run compile && node out/process/fy301ControlValve.realCore.test.js
 */
const { test, finish } = createTestRunner("FY301 + válvula de controle (Core real, configuração por HART)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const fyPins = ["supply", "out1", "position", "loop_plus", "loop_minus"].map((id, index) => ({ id, x: 0, y: index * 12 }));
const longAddress = "82be030b2a61"; // Smar (3E | 0x80), FY301 device type 03, ID 0B 2A 61

function request(command: number, data: number[] = []): string {
  const frame = Buffer.concat([Buffer.from(longAddress, "hex"), Buffer.from([command, data.length, ...data])]);
  const checksum = frame.reduce((xor, octet) => xor ^ octet, 0);
  return Buffer.concat([Buffer.alloc(5, 0xff), frame, Buffer.from([checksum])]).toString("hex");
}

function float(value: number): number[] {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatBE(value, 0);
  return [...bytes];
}

(async () => {
  const pipeName = `lasecsimul-fy301-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    // Plantas não são registradas globalmente (fora de library.json): como num projeto, a definição
    // incorporada da planta é registrada avulsa (ver project/plantTemplates.ts).
    const plantTemplate = createPlantTemplateLookup(path.join(repoRoot, "subcircuits"));
    await client.registerAdhocSubcircuitDefinition(materializeEmbeddedSubcircuit(plantTemplate("subcircuits.process.control_valve")!.manifest));
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
    const milliamps = async (value: number) => client.setProperty(command.instanceId, "value", value / 1000);
    const seconds = (s: number) => client.step(Math.round(s * 1e9));
    /** Response data bytes (after response code and device status) and the response code. */
    const transact = async (cmd: number, data: number[] = []) => {
      const frame = Buffer.from((await client.hartTransact(inner, request(cmd, data))).frameHex, "hex");
      const start = frame.findIndex((octet) => octet === 0x86);
      const count = frame[start + 7]!;
      return { rc: frame[start + 8]!, data: frame.subarray(start + 10, start + 8 + count) };
    };
    const cmd33 = async (codes: number[]) => {
      const { data } = await transact(33, codes);
      return codes.map((code, index) => ({ code: data[index * 6]!, units: data[index * 6 + 1]!, value: data.readFloatBE(index * 6 + 2) }));
    };
    const position = async () => (await cmd33([1]))[0]!.value;

    await test("Cmd 0: Smar FY301, HART 5, revisão do dispositivo 2 (DD 0202)", async () => {
      const { data } = await transact(0);
      assert(data[1] === 0x3e && data[2] === 0x03 && data[4] === 5 && data[5] === 2, `Cmd 0 ${data.toString("hex")}`);
    });

    await test("12 mA antes do Auto Setup: posiciona pela escala de fábrica do sensor (abertura real ≠ 50 %)", async () => {
      await seconds(20);
      const fyPosition = await position();
      const real = await opening();
      assert(Math.abs(fyPosition - 50) < 1.5, `FY301 posição ${fyPosition}`);
      assert(Math.abs(real - 75) < 3, `abertura real ${real} (escala de fábrica de 30 mm num curso de 20 mm)`);
    });

    await test("Auto Setup pelo Cmd 152: Cmd 48 byte 1 = 15 (em andamento), Cmd 33 código 17 = progresso; depois 12 mA → 50 %", async () => {
      const start = await transact(152);
      assert(start.rc === 0, `Cmd 152 RC ${start.rc}`);
      await seconds(10);
      const status = await transact(48);
      const progress = (await cmd33([17]))[0]!.value;
      assert(status.data[1] === 15 && progress > 15 && progress < 25, `Cmd 48 ${status.data.toString("hex")}, progresso ${progress}`);
      await seconds(45);
      const done = await transact(48);
      const finalProgress = (await cmd33([17]))[0]!.value;
      assert(done.data[1] === 0 && finalProgress === 100, `fim: Cmd 48 ${done.data.toString("hex")}, progresso ${finalProgress}`);
      await seconds(20);
      const real = await opening();
      assert(Math.abs(real - 50) < 1.5 && Math.abs((await position()) - 50) < 1.5, `abertura ${real}, FY ${await position()}`);
    });

    // What the extension saves in the .lsproj after the Auto Setup: the same property list, in the same order, as
    // `syncHartSubcircuitPropertiesFromRuntime` (extension/src/core/coreLifecycle.ts).
    let savedVariablesJson = "";
    const saved: Array<[string, unknown]> = [];
    await test("a calibração do Auto Setup fica nas variáveis salvas com o projeto (setup.rest/setup.full, EEPROM)", async () => {
      await transact(18, [...Buffer.from("196b71c32820" + "820820820820820820820820", "hex"), 26, 11, 126]);   // Cmd 18: tag FV-102 (ASCII empacotado), descritor, data
      await transact(48);   // any transaction refreshes the persisted JSON
      for (const name of ["hartVariablesJson", "hartAdditionalJson", "hartBurstJson", "hartDynamicVariableAssignments", "tag", "unit",
        "pollingAddress", "message", "descriptor", "dateDay", "dateMonth", "dateYear", "finalAssemblyNumber", "longTag", "loopCurrentMode",
        "alarmSelectionCode", "writeProtectCode", "hartConfigChangeCounter", "configurationChangedFlags"]) {
        const value = await client.getProperty(inner, name);
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") saved.push([name, value]);
      }
      savedVariablesJson = String(await client.getProperty(inner, "hartVariablesJson"));
      const variables = JSON.parse(savedVariablesJson) as Array<{ id: string; value: number }>;
      const rest = variables.find((variable) => variable.id === "setup.rest")?.value ?? NaN;
      const full = variables.find((variable) => variable.id === "setup.full")?.value ?? NaN;
      assert(Math.abs(rest - 0) < 0.2 && Math.abs(full - 20) < 0.2, `setup.rest ${rest} mm, setup.full ${full} mm (curso de 20 mm)`);
    });

    await test("Cmd 2 = corrente medida e % do split range; Cmd 15 = split range em mA; Cmd 33 do DTM (0, 2, 1, 6)", async () => {
      const cmd2 = await transact(2);
      const current = cmd2.data.readFloatBE(0);
      const percent = cmd2.data.readFloatBE(4);
      assert(Math.abs(current - 12) < 0.01 && Math.abs(percent - 50) < 0.1, `Cmd 2: ${current} mA, ${percent} %`);
      const cmd15 = await transact(15);
      assert(cmd15.data[1] === 0 && cmd15.data[2] === 39 && cmd15.data.readFloatBE(3) === 20 && cmd15.data.readFloatBE(7) === 4,
        `Cmd 15 ${cmd15.data.toString("hex")}`);
      const [input, inputPercent, pv, sp] = await cmd33([0, 2, 1, 6]);
      assert(input!.units === 39 && Math.abs(input!.value - 12) < 0.01, `entrada ${input!.value} mA`);
      assert(inputPercent!.units === 57 && Math.abs(inputPercent!.value - 50) < 0.1, `entrada ${inputPercent!.value} %`);
      assert(pv!.units === 57 && Math.abs(pv!.value - 50) < 0.5 && Math.abs(sp!.value - 50) < 0.1, `PV ${pv!.value}, SP ${sp!.value}`);
    });

    await test("4 mA fecha e 20 mA abre totalmente (ar para abrir, ação direta)", async () => {
      await milliamps(4);
      await seconds(15);
      const closed = await opening();
      await milliamps(20);
      await seconds(15);
      const open = await opening();
      assert(closed < 1 && open > 99, `4 mA ${closed} %, 20 mA ${open} %`);
      await milliamps(12);
    });

    await test("Cmd 47 = 1 (igual porcentagem 1:50): 12 mA → 12,4 % de abertura; Cmd 15 informa o código; código 8 é recusado (RC 2)", async () => {
      const set = await transact(47, [1]);
      assert(set.rc === 0 && set.data[0] === 1, `Cmd 47 RC ${set.rc}`);
      await seconds(20);
      const real = await opening();
      assert(Math.abs(real - 12.39) < 1.2, `abertura ${real}`);
      assert((await transact(15)).data[1] === 1, "Cmd 15 código da curva");
      assert((await transact(47, [8])).rc === 2, "código 8 recusado");
      await transact(47, [0]);
    });

    await test("SP local (Cmd 224 00 01 + Cmd 226 SP 30 %): 30 % de abertura, independente da corrente; Cmd 225 lê o SP", async () => {
      await transact(224, [0, 1]);
      await transact(226, [0x39, ...float(30), 0]);
      await seconds(20);
      assert(Math.abs((await opening()) - 30) < 1.5, `abertura ${await opening()}`);
      const sp = (await transact(225)).data.readFloatBE(1);
      assert(Math.abs(sp - 30) < 0.1, `Cmd 225 ${sp}`);
      await transact(224, [1, 1]);
      await seconds(15);
    });

    await test("split range pelo Cmd 35 (4-12 mA, unidade mA): 8 mA → 50 %; Cmd 2 = 8 mA e 50 %", async () => {
      const set = await transact(35, [39, ...float(12), ...float(4)]);
      assert(set.rc === 0, `Cmd 35 RC ${set.rc}`);
      await milliamps(8);
      await seconds(20);
      assert(Math.abs((await opening()) - 50) < 1.5, `abertura ${await opening()}`);
      const cmd2 = await transact(2);
      assert(Math.abs(cmd2.data.readFloatBE(0) - 8) < 0.01 && Math.abs(cmd2.data.readFloatBE(4) - 50) < 0.1, "Cmd 2 no split range");
      await transact(35, [39, ...float(20), ...float(4)]);
      await milliamps(12);
      await seconds(15);
    });

    await test("TIME de abertura 10 s (Cmd 222): 4 → 20 mA leva ~10 s", async () => {
      await milliamps(4);
      await seconds(15);
      await transact(222, [...float(10), ...float(0), ...float(0), ...float(100), ...float(0), ...float(0)]);
      await milliamps(20);
      await seconds(5);
      const half = await opening();
      await seconds(10);
      const full = await opening();
      assert(half > 35 && half < 60 && full > 99, `5 s: ${half} %, 15 s: ${full} %`);
      await transact(222, [...float(0), ...float(0), ...float(0), ...float(100), ...float(0), ...float(0)]);
      await milliamps(12);
      await seconds(15);
    });

    await test("TSO 5 % (Cmd 222): abaixo de 5 % de sinal a válvula fecha estanque", async () => {
      await transact(222, [...float(0), ...float(0), ...float(5), ...float(100), ...float(0), ...float(0)]);
      await milliamps(4.6); // 3,75 %
      await seconds(15);
      assert((await opening()) < 0.5, `abertura ${await opening()}`);
      await transact(222, [...float(0), ...float(0), ...float(0), ...float(100), ...float(0), ...float(0)]);
      await milliamps(12);
      await seconds(15);
    });

    await test("tabela (Cmd 135 + 134): 2 pontos (0;0) e (100;50), curva 3 → 20 mA = 50 %; Cmd 133 lê o grupo 0", async () => {
      await transact(135, [2]);
      await transact(134, [0, ...float(0)]);
      await transact(134, [1, ...float(100)]);
      await transact(134, [16, ...float(0)]);
      await transact(134, [17, ...float(50)]);
      await transact(47, [3]);
      await milliamps(20);
      await seconds(20);
      assert(Math.abs((await opening()) - 50) < 1.5, `abertura ${await opening()}`);
      const group = await transact(133, [0]);
      assert(group.data[0] === 0 && group.data[1] === 2 && group.data.readFloatBE(2) === 0 && group.data.readFloatBE(6) === 100,
        `Cmd 133 ${group.data.toString("hex")}`);
      await transact(47, [0]);
      await milliamps(12);
      await seconds(15);
    });

    await test("ação reversa (Cmd 157 = 1) com AIR_CLOSED (Cmd 129 = 1, manual seção 4: ação reversa + ar para abrir): 4 mA abre, 20 mA fecha", async () => {
      await transact(157, [1]);
      await transact(129, [1]);
      await milliamps(4);
      await seconds(15);
      const at4 = await opening();
      await milliamps(20);
      await seconds(15);
      const at20 = await opening();
      assert(at4 > 99 && at20 < 1, `4 mA ${at4} %, 20 mA ${at20} %`);
      await transact(157, [0]);
      await transact(129, [0]);
      await milliamps(12);
      await seconds(15);
    });

    await test("AIR_T trocado (Cmd 129 = Close num atuador ar-para-abrir): realimentação positiva, a válvula vai a um extremo", async () => {
      await transact(129, [1]);
      await seconds(20);
      const real = await opening();
      assert(real < 2 || real > 98, `abertura ${real}`);
      await transact(129, [0]);
      await seconds(15);
    });

    await test("KP pelo Cmd 218 incrementa o contador de operações (Cmd 166, 19 bytes); Cmd 217 lê KP e TR", async () => {
      const before = (await transact(166)).data;
      await transact(218, float(35));
      const after = (await transact(166)).data;
      assert(before.length === 19 && after[4] === before[4]! + 1, `contadores ${before.toString("hex")} → ${after.toString("hex")}`);
      const params = (await transact(217)).data;
      assert(params.readFloatBE(0) === 35 && params.readFloatBE(4) === 2, `Cmd 217 ${params.toString("hex")}`);
      await transact(218, float(40));
    });

    await test("Cmd 242 (leitura de fábrica do DTM) devolve a chave 03 10", async () => {
      const { rc, data } = await transact(242, [3, 0x10]);
      assert(rc === 0 && data[0] === 3 && data[1] === 0x10, `Cmd 242 ${data.toString("hex")}`);
    });

    await test("sem sinal (2 mA, abaixo de 3,8 mA): o FY301 desliga, OUT1 esvazia e a mola leva a válvula à posição de falha (fechada)", async () => {
      await milliamps(2);
      await seconds(10);
      assert((await opening()) < 1 && (await read(fy.instanceId, "out1_bar")) < 0.01, `abertura ${await opening()}`);
      await milliamps(12);
      await seconds(10);
    });

    await test("projeto reaberto: um FY301 com as variáveis salvas posiciona pela calibração gravada, sem novo Auto Setup", async () => {
      const valve2 = await client.addComponent("subcircuits.process.control_valve", {}, [], "Válvula (reaberta)");
      const fy2 = await client.addComponent("subcircuits.hart.smar_fy301", {}, fyPins, "FY301 (reaberto)");
      for (const [name, value] of saved) await client.setSubcircuitChildProperty(fy2.instanceId, "fy301", name, value);
      const inner2 = await client.getSubcircuitChildInstanceId(fy2.instanceId, "fy301");
      assert(String(await client.getProperty(inner2, "hartVariablesStatus")) === "OK",
        `configuração salva aceita: ${await client.getProperty(inner2, "hartVariablesStatus")}`);
      assert(String(await client.getProperty(inner2, "tag")).trim() === "FV-102", `tag ${await client.getProperty(inner2, "tag")}`);
      const command2 = await client.addComponent("control.constant", { value: 0.012 }, [{ id: "out", x: 0, y: 0 }], "Saída 2 (A)");
      const ao2 = await client.addComponent("bridges.controlled_current_source", {}, [{ id: "command", x: 0, y: 0 }, { id: "p", x: 0, y: 10 }, { id: "n", x: 0, y: 20 }],
        "Saída analógica 2");
      await client.applyWireTopologyTransaction([
        { kind: "connect", from: { componentId: command2.instanceId, pinId: "out" }, to: { componentId: ao2.instanceId, pinId: "command" } },
        { kind: "connect", from: { componentId: ao2.instanceId, pinId: "p" }, to: port(fy2, "loop_plus") },
        { kind: "connect", from: port(fy2, "loop_minus"), to: { componentId: ao2.instanceId, pinId: "n" } },
        { kind: "connect", from: { componentId: ao2.instanceId, pinId: "n" }, to: { componentId: ground.instanceId, pinId: "pin" } },
        { kind: "connect", from: port(fy2, "out1"), to: port(valve2, "out1") },
        { kind: "connect", from: port(valve2, "supply"), to: port(fy2, "supply") },
        { kind: "connect", from: port(valve2, "position"), to: port(fy2, "position") },
      ]);
      await seconds(20);
      const real = await read(valve2.instanceId, "opening");
      assert(Math.abs(real - 50) < 1.5, `abertura ${real} (sem a calibração seria ~75 %)`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

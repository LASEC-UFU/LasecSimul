import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { IecProjectAuthoring } from "./iecProject";
import { starterIecProject } from "./plcProjectTemplate";
import { PlcBuildOptions, buildIecProject, parsePlcVariableReply, plcExportedIoFromProject, resolvePlcToolchain } from "./plcBuild";

/**
 * Etapa 1 do CLP de ponta a ponta, num Core REAL: projeto IEC com um PROGRAM em ST -> STruCpp ->
 * g++ -> executável do worker -> bloco "plc.instance" -> pinos no circuito -> LED.
 *
 * Fora do `npm test` (precisa do Core compilado, do STruCpp baixado e de um g++):
 *   npm run compile && node out/plc/plcEndToEnd.realCore.test.js
 */
const { test, finish } = createTestRunner("CLP IEC 61131-3 em ST de ponta a ponta (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const MS = 1_000_000;

/** Partida/parada com selo, lâmpada e pisca de 500 ms. TOGGLE também existe na OSCAT do pacote da
 * STruCpp: o FB do aluno precisa compilar sem colidir com ela. */
function lessonProject(mainText: string): IecProjectAuthoring {
  const project = starterIecProject("partida-pisca");
  project.tasks = [{ name: "MAIN_TASK", intervalMs: 10, priority: 1 }];
  project.pous = [
    {
      pouId: "pou-main",
      name: "MAIN",
      kind: "program",
      interface: {
        variables: [
          { ioId: "START", name: "START", class: "input", type: "BOOL" },
          { ioId: "STOP", name: "STOP", class: "input", type: "BOOL" },
          { ioId: "LAMP", name: "LAMP", class: "output", type: "BOOL" },
          { ioId: "BLINK", name: "BLINK", class: "output", type: "BOOL" },
          { name: "RUN", class: "local", type: "BOOL" },
          { name: "COUNT", class: "local", type: "INT" },
          { name: "T1", class: "local", type: "TON" },
          { name: "FLIP", class: "local", type: "TOGGLE" },
        ],
      },
      implementation: { language: "st", text: mainText },
    },
    {
      pouId: "pou-toggle",
      name: "TOGGLE",
      kind: "functionBlock",
      interface: {
        variables: [
          { ioId: "CLK", name: "CLK", class: "input", type: "BOOL" },
          { ioId: "Q", name: "Q", class: "output", type: "BOOL" },
          { name: "EDGE", class: "local", type: "R_TRIG" },
        ],
      },
      implementation: { language: "st", text: "EDGE(CLK := CLK);\nIF EDGE.Q THEN\n  Q := NOT Q;\nEND_IF;" },
    },
  ];
  return project;
}

const MAIN_ST = [
  "(* selo: START liga, STOP desliga *)",
  "RUN := (START OR RUN) AND NOT STOP;",
  "LAMP := RUN;",
  "T1(IN := RUN AND NOT T1.Q, PT := T#500ms);",
  "FLIP(CLK := T1.Q);",
  "BLINK := FLIP.Q;",
  "IF T1.Q THEN",
  "  COUNT := COUNT + 1;",
  "END_IF;",
].join("\n");

(async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-plc-e2e-"));
  const options: PlcBuildOptions = { toolchain: resolvePlcToolchain(extensionRoot), cacheRoot };
  const pipeName = `lasecsimul-plc-e2e-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });
  const project = lessonProject(MAIN_ST);
  let built: Awaited<ReturnType<typeof buildIecProject>> | undefined;

  try {
    await test("Compilar: ST -> C++ -> executável; pinos = entradas e saídas do PROGRAM com os ioIds do projeto", async () => {
      built = await buildIecProject(project, options);
      assert(built.ok, `compilação falhou: ${!built.ok ? JSON.stringify(built.diagnostics) : ""}`);
      if (!built.ok) return;
      const io = built.module.exportedIo.map(item => `${item.direction}:${item.ioId}:${item.iecType}`);
      assert(JSON.stringify(io) === JSON.stringify(["input:START:BOOL", "input:STOP:BOOL", "output:LAMP:BOOL", "output:BLINK:BOOL"]), io.join(","));
      const fromProject = plcExportedIoFromProject(project).map(item => `${item.direction}:${item.ioId}:${item.iecType}`);
      assert(JSON.stringify(fromProject) === JSON.stringify(io), "pinos do esquemático (sem compilar) = exportedIo compilado");
      assert(built.entry.taskIntervalMs === 10 && built.entry.taskName === "MAIN_TASK", "tarefa do projeto");
      assert(fs.existsSync(built.module.nativeBinaryRef), "executável do worker existe");
    });

    await test("Compilar de novo o mesmo programa usa o build anterior (sem chamar o compilador)", async () => {
      const again = await buildIecProject(project, options);
      assert(again.ok && again.cached && built?.ok === true && again.module.artifactHash === built.module.artifactHash, "cache por hash do ST");
    });

    await test("Erro de sintaxe aponta o POU e a linha que o aluno escreveu", async () => {
      const broken = lessonProject(MAIN_ST.replace("LAMP := RUN;", "LAMP := RUN AND ;"));
      const result = await buildIecProject(broken, options);
      assert(!result.ok, "devia falhar");
      if (result.ok) return;
      const error = result.diagnostics.find(item => item.severity === "error");
      assert(error?.pouName === "MAIN" && error.line === 3, `diagnóstico ${JSON.stringify(result.diagnostics)}`);
    });

    await test("Variável não declarada aponta o POU e a linha", async () => {
      const broken = lessonProject(`${MAIN_ST}\nMOTOR := TRUE;`);
      const result = await buildIecProject(broken, options);
      assert(!result.ok, "devia falhar");
      if (result.ok) return;
      const error = result.diagnostics.find(item => item.severity === "error");
      assert(error?.pouName === "MAIN" && error.line === 10 && /MOTOR/.test(error.message), `diagnóstico ${JSON.stringify(result.diagnostics)}`);
    });

    if (!built?.ok) throw new Error("sem artefato, os testes no Core não rodam");
    const module = built.module;

    processManager.start();
    await client.start();
    const pins = module.exportedIo.map((io, index) => ({ id: io.ioId, x: 0, y: index * 12 }));
    const plc = await client.addComponent("plc.instance", {}, pins, "CLP (teste)");
    await client.setPlcTaskInterval(plc.instanceId, built.entry.taskIntervalMs * MS);
    await client.loadPlcArtifact(plc.instanceId, module);
    await test("Falha no rebuild mantém o artefato válido executando no worker ativo", async () => {
      const before = parsePlcVariableReply(await client.plcGet(plc.instanceId, "MAIN.LAMP")).value;
      const invalid = await buildIecProject(lessonProject(MAIN_ST.replace("LAMP := RUN;", "LAMP := RUN AND ;")), options);
      assert(!invalid.ok, "o rebuild com erro de sintaxe precisa falhar");
      await client.step(20 * MS);
      const after = parsePlcVariableReply(await client.plcGet(plc.instanceId, "MAIN.LAMP")).value;
      assert(before === "FALSE" && after === "FALSE", `o artefato anterior continuou executando: ${before} -> ${after}`);
    });
    const supply = await client.addComponent("sources.dc_voltage", { voltage: 5 }, [{ id: "pin-1", x: 0, y: 0 }, { id: "pin-2", x: 0, y: 10 }], "24 V (5 V)");
    const startButton = await client.addComponent("switches.switch", { closed: false }, [{ id: "pin-1", x: 0, y: 0 }, { id: "pin-2", x: 0, y: 10 }], "Botão liga");
    const stopButton = await client.addComponent("switches.switch", { closed: false }, [{ id: "pin-1", x: 0, y: 0 }, { id: "pin-2", x: 0, y: 10 }], "Botão desliga");
    const pullStart = await client.addComponent("passive.resistor", { resistance: 10_000 }, [{ id: "pin-1", x: 0, y: 0 }, { id: "pin-2", x: 0, y: 10 }], "R start");
    const pullStop = await client.addComponent("passive.resistor", { resistance: 10_000 }, [{ id: "pin-1", x: 0, y: 0 }, { id: "pin-2", x: 0, y: 10 }], "R stop");
    const lampResistor = await client.addComponent("passive.resistor", { resistance: 330 }, [{ id: "pin-1", x: 0, y: 0 }, { id: "pin-2", x: 0, y: 10 }], "R lâmpada");
    const lamp = await client.addComponent("outputs.led", {}, [{ id: "anode", x: 0, y: 0 }, { id: "cathode", x: 0, y: 10 }], "Lâmpada");
    const blinkResistor = await client.addComponent("passive.resistor", { resistance: 330 }, [{ id: "pin-1", x: 0, y: 0 }, { id: "pin-2", x: 0, y: 10 }], "R pisca");
    const blink = await client.addComponent("outputs.led", {}, [{ id: "anode", x: 0, y: 0 }, { id: "cathode", x: 0, y: 10 }], "Pisca");
    const ground = await client.addComponent("other.ground", {}, [{ id: "pin", x: 0, y: 0 }], "GND");
    const at = (component: { instanceId: string }, pinId: string) => ({ componentId: component.instanceId, pinId });
    await client.applyWireTopologyTransaction([
      { kind: "connect", from: at(supply, "pin-2"), to: at(ground, "pin") },
      { kind: "connect", from: at(supply, "pin-1"), to: at(startButton, "pin-1") },
      { kind: "connect", from: at(supply, "pin-1"), to: at(stopButton, "pin-1") },
      { kind: "connect", from: at(startButton, "pin-2"), to: at(plc, "START") },
      { kind: "connect", from: at(stopButton, "pin-2"), to: at(plc, "STOP") },
      { kind: "connect", from: at(plc, "START"), to: at(pullStart, "pin-1") },
      { kind: "connect", from: at(pullStart, "pin-2"), to: at(ground, "pin") },
      { kind: "connect", from: at(plc, "STOP"), to: at(pullStop, "pin-1") },
      { kind: "connect", from: at(pullStop, "pin-2"), to: at(ground, "pin") },
      { kind: "connect", from: at(plc, "LAMP"), to: at(lampResistor, "pin-1") },
      { kind: "connect", from: at(lampResistor, "pin-2"), to: at(lamp, "anode") },
      { kind: "connect", from: at(lamp, "cathode"), to: at(ground, "pin") },
      { kind: "connect", from: at(plc, "BLINK"), to: at(blinkResistor, "pin-1") },
      { kind: "connect", from: at(blinkResistor, "pin-2"), to: at(blink, "anode") },
      { kind: "connect", from: at(blink, "cathode"), to: at(ground, "pin") },
    ]);
    /** Corrente no LED (mA) pela queda no resistor de 330 ohm. */
    const ledMilliamps = async (output: string, resistor: { instanceId: string }, led: { instanceId: string }) => {
      const high = await client.getNodeVoltage(plc.instanceId, output);
      const anode = await client.getNodeVoltage(led.instanceId, "anode");
      void resistor;
      return (high - anode) / 330 * 1000;
    };
    const lampMilliamps = () => ledMilliamps("LAMP", lampResistor, lamp);
    const blinkMilliamps = () => ledMilliamps("BLINK", blinkResistor, blink);
    const value = async (name: string) => parsePlcVariableReply(await client.plcGet(plc.instanceId, name)).value;
    const press = async (button: { instanceId: string }) => {
      await client.setProperty(button.instanceId, "closed", true);
      await client.step(50 * MS);
      await client.setProperty(button.instanceId, "closed", false);
      await client.step(50 * MS);
    };

    await test("Sem apertar nada a lâmpada fica apagada", async () => {
      await client.step(200 * MS);
      const current = await lampMilliamps();
      assert(Math.abs(current) < 0.1, `lâmpada ${current} mA`);
    });

    await test("Botão liga: a lâmpada acende e continua acesa depois de soltar (selo em ST)", async () => {
      await press(startButton);
      await client.step(100 * MS);
      const current = await lampMilliamps();
      assert(current > 6 && current < 10, `lâmpada ${current} mA (5 V, 330 ohm, LED 2,4 V)`);
      assert(await value("MAIN.RUN") === "TRUE", "RUN = TRUE no monitor");
    });

    await test("TON de 500 ms no tempo da simulação: o pisca troca a cada ~0,5 s e COUNT conta", async () => {
      const before = Number(await value("MAIN.COUNT"));
      const samples: boolean[] = [];
      for (let index = 0; index < 20; index += 1) {
        await client.step(100 * MS);
        samples.push((await blinkMilliamps()) > 3);
      }
      const after = Number(await value("MAIN.COUNT"));
      const transitions = samples.slice(1).filter((value, index) => value !== samples[index]).length;
      assert(after - before >= 3 && after - before <= 5, `COUNT ${before} -> ${after} em 2 s`);
      assert(transitions >= 3 && transitions <= 5, `pisca trocou ${transitions} vezes em 2 s: ${samples.map(Number).join("")}`);
    });

    await test("Forçar LAMP = FALSE apaga a lâmpada; liberar volta ao valor do programa", async () => {
      await client.plcForce(plc.instanceId, "MAIN.LAMP", "FALSE");
      await client.step(50 * MS);
      const forced = await lampMilliamps();
      await client.plcUnforce(plc.instanceId, "MAIN.LAMP");
      await client.step(50 * MS);
      const released = await lampMilliamps();
      assert(Math.abs(forced) < 0.1 && released > 6, `forçada ${forced} mA, liberada ${released} mA`);
    });

    await test("Botão desliga: a lâmpada apaga", async () => {
      await press(stopButton);
      await client.step(100 * MS);
      const current = await lampMilliamps();
      assert(Math.abs(current) < 0.1, `lâmpada ${current} mA`);
      assert(await value("MAIN.RUN") === "FALSE", "RUN = FALSE no monitor");
    });

    await test("Forçar a entrada START liga o programa como se o botão estivesse apertado", async () => {
      await client.plcForce(plc.instanceId, "MAIN.START", "TRUE");
      await client.step(100 * MS);
      const on = await lampMilliamps();
      await client.plcUnforce(plc.instanceId, "MAIN.START");
      await press(stopButton);
      await client.step(100 * MS);
      const off = await lampMilliamps();
      assert(on > 6 && Math.abs(off) < 0.1, `forçado ${on} mA, depois do desliga ${off} mA`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

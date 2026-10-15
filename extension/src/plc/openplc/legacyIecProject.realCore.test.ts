import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert, createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../../ipc/CoreProcess";
import { CoreClient } from "../../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../../core/coreExecutable";
import { IecProjectAuthoring, IecVariable, LdCell, LdRung } from "../iecProject";
import { starterIecProject } from "../plcProjectTemplate";
import { PlcBuildOptions, PlcBuildResult, buildIecProject, parsePlcVariableReply, resolvePlcToolchain } from "../plcBuild";
import { buildOpenPlcProject } from "./openPlcBuild";
import { loadOpenPlcHost } from "./openPlcHost";
import { readLsplc } from "./lsplcFile";
import { convertLegacyIecProjectFile, lsplcPathForLegacy, retargetSchematic, schematicReferences } from "./legacyIecProject";

/**
 * Projeto IEC antigo (`*.iec.json`) convertido para `.lsplc` (editor OpenPLC) roda igual: o projeto
 * antigo (build do LasecSimul) e o convertido (transpilador do OpenPLC) carregam no mesmo Core real,
 * recebem as mesmas entradas e as saídas são comparadas a cada passo.
 *
 * Fora do `npm test`: npm run compile && node out/plc/openplc/legacyIecProject.realCore.test.js
 */
const { test, finish } = createTestRunner("Projetos IEC antigos convertidos para .lsplc rodam igual no Core real");

const extensionRoot = path.resolve(__dirname, "..", "..", "..");
const exampleDir = path.resolve(extensionRoot, "..", "trm", "plc");
const MS = 1_000_000;

const io = (name: string, variableClass: IecVariable["class"], type = "BOOL"): IecVariable =>
  variableClass === "input" || variableClass === "output" ? { ioId: name, name, class: variableClass, type } : { name, class: variableClass, type };
const no = (variable: string): LdCell => ({ kind: "contact", contact: "no", variable });
const nc = (variable: string): LdCell => ({ kind: "contact", contact: "nc", variable });
const coil = (variable: string, kind: "coil" | "negated" | "set" | "reset" | "p" | "n" = "coil"): LdCell => ({ kind: "coil", coil: kind, variable });
const wire: LdCell = { kind: "wire" };
let rungs = 0;
const rung = (rows: Array<Array<LdCell | null>>, verticals: Array<[number, number]> = [], label?: string): LdRung =>
  ({ rungId: `rung-${++rungs}`, rows, verticals: verticals.map(([row, column]) => ({ row, column })), ...(label ? { label } : {}) });

function ldProject(id: string, variables: IecVariable[], body: LdRung[]): IecProjectAuthoring {
  const project = starterIecProject(id);
  project.pous = [{ pouId: "pou-main", name: "MAIN", kind: "program", interface: { variables }, implementation: { language: "ld", networks: [], rungs: body } }];
  return project;
}

/** Gerador pseudoaleatório fixo (mesma sequência a cada execução). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-legacy-iec-"));
  const toolchain = resolvePlcToolchain(extensionRoot);
  const options: PlcBuildOptions = { toolchain, cacheRoot: path.join(work, "cache") };
  const host = loadOpenPlcHost({ extensionPath: extensionRoot, storageDir: path.join(work, "storage"), toolchain });
  const pipeName = `lasecsimul-legacy-iec-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });

  const load = async (built: PlcBuildResult, label: string, programName: string) => {
    if (!built.ok) throw new Error(`${label}: ${JSON.stringify(built.diagnostics)}\n${built.log}`);
    const pins = built.module.exportedIo.map((item, index) => ({ id: item.ioId, x: 0, y: index * 12 }));
    const plc = await client.addComponent("plc.instance", {}, pins, label);
    await client.setPlcTaskInterval(plc.instanceId, 10 * MS);
    await client.loadPlcArtifact(plc.instanceId, built.module);
    return {
      force: async (name: string, value: boolean) => client.plcForce(plc.instanceId, `${programName}.${name}`, value ? "TRUE" : "FALSE"),
      get: async (name: string) => parsePlcVariableReply(await client.plcGet(plc.instanceId, `${programName}.${name}`)).value,
    };
  };

  /** Converte `sourceFile`, compila os dois e compara as saídas com entradas pseudoaleatórias. */
  const lockstep = async (sourceFile: string, inputs: string[], outputs: string[], steps = 80, stepMs = 30) => {
    const project = JSON.parse(fs.readFileSync(sourceFile, "utf8")) as IecProjectAuthoring;
    const target = path.join(work, `${path.basename(lsplcPathForLegacy(sourceFile))}`);
    const { warnings } = convertLegacyIecProjectFile(host, sourceFile, target);
    const main = project.pous.find(pou => pou.kind === "program")!;
    const legacy = await load(await buildIecProject(project, options), `${project.projectId}-legacy`, main.name);
    const converted = await load(await buildOpenPlcProject(target, { host, ...options }), `${project.projectId}-lsplc`, main.name);
    const next = random(7);
    const state = Object.fromEntries(inputs.map(name => [name, false]));
    for (let step = 0; step < steps; step += 1) {
      for (const name of inputs) {
        if (next() < 0.3) state[name] = !state[name];
        await legacy.force(name, state[name]!);
        await converted.force(name, state[name]!);
      }
      await client.step(stepMs * MS);
      for (const name of outputs) {
        const [a, b] = [await legacy.get(name), await converted.get(name)];
        assert(a === b, `${path.basename(sourceFile)} passo ${step} (${JSON.stringify(state)}): ${name} antigo ${a} x convertido ${b}`);
      }
    }
    return { warnings, bundle: readLsplc(target), target };
  };

  const writeProject = (project: IecProjectAuthoring) => {
    const file = path.join(work, `${project.projectId}.iec.json`);
    fs.writeFileSync(file, JSON.stringify(project, null, 2));
    return file;
  };

  try {
    processManager.start();
    await client.start();

    await test("Exemplos trm/plc em ST, IL, LD e SFC: mesmas saídas que o projeto antigo; LD e SFC continuam gráficos", async () => {
      const cases: Array<[string, string[], string[], string]> = [
        ["partida_pisca.iec.json", ["START", "STOP"], ["LAMP", "BLINK", "COUNT"], ".st"],
        ["partida_pisca_il.iec.json", ["START", "STOP"], ["LAMP", "BLINK", "COUNT"], ".il"],
        ["partida_pisca_ld.iec.json", ["START", "STOP"], ["LAMP", "BLINK", "COUNT"], ".ld"],
        ["semaforo_sfc.iec.json", ["BOTAO"], ["VERMELHO", "AMARELO", "VERDE", "CICLOS"], ".sfc"],
      ];
      for (const [name, inputs, outputs, extension] of cases) {
        const { warnings, bundle } = await lockstep(path.join(exampleDir, name), inputs, outputs, name.startsWith("semaforo") ? 120 : 80, name.startsWith("semaforo") ? 100 : 30);
        // A OSCAT Basic do OpenPLC tem um TOGGLE: o do exemplo vira TOGGLE_1.
        const expected = name.startsWith("partida_pisca") ? 1 : 0;
        assert(warnings.length === expected && warnings.every(item => /TOGGLE_1/.test(item)), `${name}: avisos ${warnings.join(" | ")}`);
        if (expected) assert(Object.keys(bundle.files).some(file => /function-blocks\/TOGGLE_1\./.test(file)), `${name}: ${Object.keys(bundle.files).join(", ")}`);
        const main = Object.keys(bundle.files).find(file => /pous\/programs\/MAIN\./i.test(file));
        assert(main?.endsWith(extension) === true, `${name}: programa principal em ${main}, esperado ${extension}`);
      }
    });

    await test("LD em grade -> degraus do OpenPLC: série, selo, ramo no meio, paralelos aninhados, bobinas em paralelo, ramos com bobinas diferentes", async () => {
      const inputs = ["A", "B", "C", "D", "E"];
      const outputs = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"];
      const project = ldProject("ld_topologias", [...inputs.map(name => io(name, "input")), ...outputs.map(name => io(name, "output"))], [
        rung([[no("A"), nc("B"), coil("Q1")]]),
        rung([[no("A"), nc("B"), coil("Q2")], [no("Q2"), null, null]], [[0, 0]]),
        rung([[no("A"), no("B"), no("C"), coil("Q3")], [null, no("D"), null, null]], [[0, 0], [0, 1]]),
        rung([[no("A"), no("B"), wire, coil("Q4")], [no("D"), null, null, null], [null, no("E"), null, null]], [[0, 0], [1, 0], [0, 1], [1, 1]]),
        rung([[no("A"), coil("Q5")], [null, coil("Q6")]], [[0, 0]]),
        rung([[no("C"), no("B"), coil("Q7")], [null, nc("D"), coil("Q8")]], [[0, 0]]),
      ]);
      const { warnings, bundle } = await lockstep(writeProject(project), inputs, outputs);
      assert(warnings.length === 0, `avisos: ${warnings.join(" | ")}`);
      const ld = bundle.files["pous/programs/MAIN.ld"] ?? "";
      const rungsJson = JSON.parse(ld.slice(ld.indexOf("{"), ld.lastIndexOf("}") + 1)) as { rungs: Array<{ nodes: Array<{ type: string }> }> };
      const parallels = rungsJson.rungs.map(item => item.nodes.filter(node => node.type === "parallel").length / 2);
      assert(JSON.stringify(parallels) === JSON.stringify([0, 1, 1, 2, 1, 1]), `paralelos por degrau: ${JSON.stringify(parallels)}`);
    });

    await test("LD: set/reset, bordas, bobina negada, TON e ADD com EN/ENO convertem como degraus", async () => {
      const project = ldProject("ld_blocos", [
        io("A", "input"), io("B", "input"), io("Q1", "output"), io("Q2", "output"), io("Q3", "output"), io("Q4", "output"),
        io("CNT", "output", "INT"), io("T1", "local", "TON"),
      ], [
        rung([[{ kind: "contact", contact: "p", variable: "A" }, coil("Q1", "set")]]),
        rung([[{ kind: "contact", contact: "n", variable: "B" }, coil("Q1", "reset")]]),
        rung([[no("A"), coil("Q2", "p")]]),
        rung([[no("B"), coil("Q3", "negated")]]),
        rung([[no("A"), { kind: "block", typeName: "TON", instanceName: "T1", powerInput: "IN", powerOutput: "Q", inputs: { PT: "T#100ms" }, outputs: {} }, coil("Q4")]]),
        rung([[no("B"), { kind: "block", typeName: "ADD", powerInput: "EN", powerOutput: "ENO", inputs: { IN1: "CNT", IN2: "1" }, outputs: { OUT: "CNT" } }]]),
      ]);
      const { warnings, bundle } = await lockstep(writeProject(project), ["A", "B"], ["Q1", "Q2", "Q3", "Q4", "CNT"], 100, 20);
      assert(warnings.length === 0, `avisos: ${warnings.join(" | ")}`);
      assert(Object.keys(bundle.files).includes("pous/programs/MAIN.ld"), `arquivos: ${Object.keys(bundle.files).join(", ")}`);
    });

    await test("LD com salto e contato de comparação: vira ST (com aviso) e roda igual", async () => {
      const project = ldProject("ld_salto", [io("A", "input"), io("B", "input"), io("Q1", "output"), io("Q2", "output"), io("N", "local", "INT")], [
        rung([[no("A"), { kind: "jump", label: "FIM" }]]),
        rung([[no("B"), coil("Q1")]]),
        rung([[{ kind: "compare", operator: ">=", left: "N", right: "0" }, coil("Q2")]], [], "FIM"),
      ]);
      const { warnings, bundle } = await lockstep(writeProject(project), ["A", "B"], ["Q1", "Q2"]);
      assert(warnings.length === 1 && /convertido para ST/.test(warnings[0]!), `avisos: ${warnings.join(" | ")}`);
      assert(Object.keys(bundle.files).includes("pous/programs/MAIN.st"), `arquivos: ${Object.keys(bundle.files).join(", ")}`);
    });

    await test("Esquemático do exemplo passa a apontar para o .lsplc e mantém os pinos", async () => {
      // O esquemático do exemplo como era antes da conversão: bloco CLP no projeto antigo.
      const schematic = path.join(work, "partida_pisca_ld.lsproj");
      const original = JSON.parse(fs.readFileSync(path.join(exampleDir, "partida_pisca_ld.lsproj"), "utf8")) as { components: Array<{ typeId: string; properties: Record<string, unknown>; plc: Record<string, unknown> }> };
      for (const component of original.components.filter(item => item.typeId === "plc.instance")) {
        component.properties = { ...component.properties, plcIecProjectRef: "partida_pisca_ld.iec.json", plcEntryConfiguration: "CONFIGURATION_1" };
        component.plc = { ...component.plc, iecProjectRef: "partida_pisca_ld.iec.json", entryConfiguration: "CONFIGURATION_1" };
      }
      fs.writeFileSync(schematic, JSON.stringify(original, null, 2));
      const legacy = path.join(work, "partida_pisca_ld.iec.json");
      fs.copyFileSync(path.join(exampleDir, "partida_pisca_ld.iec.json"), legacy);
      const target = lsplcPathForLegacy(legacy);
      convertLegacyIecProjectFile(host, legacy, target);
      assert(schematicReferences(schematic, legacy), "o esquemático devia usar o projeto antigo");
      assert(retargetSchematic(schematic, legacy, target), "nada atualizado");
      const document = JSON.parse(fs.readFileSync(schematic, "utf8")) as { components: Array<{ typeId: string; properties: Record<string, unknown>; plc: Record<string, unknown> }> };
      const plc = document.components.find(component => component.typeId === "plc.instance")!;
      assert(plc.plc.iecProjectRef === "partida_pisca_ld.lsplc" && plc.properties.plcIecProjectRef === "partida_pisca_ld.lsplc", JSON.stringify(plc.plc));
      assert(plc.plc.entryConfiguration === undefined && Array.isArray(plc.plc.exportedIo) && (plc.plc.exportedIo as unknown[]).length === 4, JSON.stringify(plc.plc));
      assert(!schematicReferences(schematic, legacy) && schematicReferences(schematic, target), "referência não trocada");
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

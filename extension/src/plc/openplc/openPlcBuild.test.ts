import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mapCompilerOutput } from "../plcBuild";
import { openPlcStOrigins } from "./openPlcBuild";
import { driverMonitorVariables } from "./openPlcDebug";
import { prepareOpenPlcSfc } from "./openPlcSfc";
import {
  LSPLC_FORMAT,
  applyWrite,
  bundleFromRaw,
  isLsplcFile,
  rawProjectFiles,
  readLsplc,
  readVirtualFile,
  virtualRelativePath,
  writeLsplc,
  writeVirtualFile,
} from "./lsplcFile";
import { OpenPlcProjectData } from "./openPlcHost";

/** ST no formato que o transpilador do OpenPLC Editor 4.2.8 emite (POU inteiro, depois CONFIGURATION). */
const PROGRAM_ST = [
  "FUNCTION_BLOCK blinker",
  "  VAR_INPUT",
  "    EN : BOOL;",
  "  END_VAR",
  "",
  "  Q := EN;",
  "END_FUNCTION_BLOCK",
  "",
  "PROGRAM main",
  "  VAR_INPUT",
  "    DI0 : BOOL;",
  "  END_VAR",
  "  VAR_OUTPUT",
  "    DO0 : BOOL;",
  "  END_VAR",
  "",
  "  DO0 := NOT DI0;",
  "  DO0 := DI0 +;",
  "END_PROGRAM",
  "",
  "CONFIGURATION Config0",
  "  RESOURCE Res0 ON PLC",
  "    TASK task0(INTERVAL := T#20ms,PRIORITY := 1);",
  "    PROGRAM instance0 WITH task0 : main;",
  "  END_RESOURCE",
  "END_CONFIGURATION",
].join("\n");

function origins(): void {
  const lines = openPlcStOrigins(PROGRAM_ST);
  assert.equal(lines.length, PROGRAM_ST.split("\n").length);
  assert.deepEqual(lines[0], { pouId: "blinker", pouName: "blinker", section: "header" });
  assert.equal(lines[2]!.section, "declaration");
  // A linha em branco que o transpilador põe depois do END_VAR não é linha do editor.
  assert.equal(lines[4]!.section, "header");
  assert.deepEqual(lines[5], { pouId: "blinker", pouName: "blinker", section: "body", bodyLine: 1 });
  // Linha 18 do ST gerado = segunda linha do corpo do main no editor.
  assert.deepEqual(lines[17], { pouId: "main", pouName: "main", section: "body", bodyLine: 2 });
  // CONFIGURATION fica fora de qualquer POU: o PROGRAM dentro dela não abre um POU novo.
  assert.equal(lines[23]!.pouName, "");

  const diagnostics = mapCompilerOutput("main.st:18:14: error: Expected expression", lines, "strucpp");
  assert.deepEqual(diagnostics, [{ severity: "error", stage: "strucpp", message: "Expected expression", column: 14,
    pouId: "main", pouName: "main", line: 2 }]);
}

const variable = (name: string, kind: string, type = "bool") =>
  ({ name, class: kind, type: { definition: "base-type", value: type }, location: "", documentation: "" });

/** Semáforo: VM (inicial) -> VD -> AM -> VM; VD liga VERDE (N) e conta com uma ação P1. */
function trafficLight(): OpenPlcProjectData {
  return {
    dataTypes: [],
    libraries: [],
    configurations: { resource: { tasks: [], instances: [{ name: "instance0", program: "main", task: "task0" }], globalVariables: [] } },
    pous: [{
      name: "main",
      pouType: "program",
      interface: { variables: [variable("BOTAO", "input"), variable("VERDE", "output"), variable("CICLOS", "local", "int")] },
      body: {
        language: "sfc",
        value: {
          name: "main",
          steps: [
            { stepId: "s-vm", name: "VM", initial: true, actions: [] },
            { stepId: "s-vd", name: "VD", actions: [{ actionId: "a1", qualifier: "N", actionName: "VERDE" }, { actionId: "a2", qualifier: "P1", actionName: "CONTA" }] },
            { stepId: "s-am", name: "AM", actions: [] },
          ],
          transitions: [
            { transitionId: "t1", fromStepIds: ["s-vm"], toStepIds: ["s-vd"], condition: "VM.T >= T#3s" },
            { transitionId: "t2", fromStepIds: ["s-vd"], toStepIds: ["s-am"], condition: "BOTAO" },
            { transitionId: "t3", fromStepIds: ["s-am"], toStepIds: ["s-vm"], condition: "AM.T >= T#1s" },
          ],
          actions: [{ name: "CONTA", language: "st", text: "CICLOS := CICLOS + 1;" }],
          layout: {},
        },
      },
    }],
  } as unknown as OpenPlcProjectData;
}

function sfc(): void {
  const prepared = prepareOpenPlcSfc(trafficLight());
  assert.deepEqual(prepared.diagnostics, []);
  const pou = prepared.data.pous[0]!;
  assert.equal(pou.body.language, "st");
  const text = String(pou.body.value);
  assert.match(text, /__SFC_VM_X/);
  assert.match(text, /IF __SFC_AC_CONTA\.A THEN/);
  const names = (pou.interface?.variables as Array<{ name: string; class: string; type: { definition: string; value: string }; initialValue?: string | null }>);
  const vmX = names.find(item => item.name === "__SFC_VM_X");
  assert.deepEqual([vmX?.class, vmX?.type, vmX?.initialValue], ["local", { definition: "base-type", value: "bool" }, "TRUE"]);
  assert.equal(names.find(item => item.name === "__SFC_AC_CONTA")?.type.definition, "derived");
  assert.match(prepared.prelude, /FUNCTION_BLOCK __SFC_ACTION_CONTROL/);
  const elements = prepared.elementsByPou.get("main") ?? [];
  assert.ok(elements.some(item => item.element?.label.includes("VM")), "linhas do corpo apontam o passo");

  const broken = trafficLight();
  const body = (broken.pous[0]!.body.value as { steps: Array<{ initial?: boolean }> });
  body.steps[0]!.initial = false;
  const failed = prepareOpenPlcSfc(broken);
  assert.ok(failed.diagnostics.some(item => item.severity === "error" && /passo inicial/.test(item.message)));

  const noSfc = prepareOpenPlcSfc({ ...trafficLight(), pous: [] } as unknown as OpenPlcProjectData);
  assert.equal(noSfc.prelude, "");
}

function lsplc(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-lsplc-test-"));
  try {
    const file = path.join(root, "semaforo.lsplc");
    const bundle = bundleFromRaw({
      projectJson: JSON.stringify({ meta: { name: "semaforo", type: "plc-project" }, data: { pous: [] } }),
      deviceConfig: "{\"deviceBoard\":\"OpenPLC Simulator\"}",
      pinMapping: "[]",
      libraryManifest: "",
      pouFiles: [{ relativePath: "pous\\programs\\main.sfc", content: "PROGRAM main\nEND_PROGRAM" }],
      serverFiles: [],
      remoteDeviceFiles: [],
    });
    writeLsplc(file, bundle);
    assert.equal(isLsplcFile(file), true);
    assert.equal(isLsplcFile(path.join(root, "x.iec.json")), false);
    const read = readLsplc(file);
    assert.equal(read.format, LSPLC_FORMAT);
    assert.deepEqual(Object.keys(read.files), ["pous/programs/main.sfc"]);

    const raw = rawProjectFiles(file, read);
    assert.equal(raw.projectPath, file);
    assert.equal(raw.pouFiles.length, 1);
    assert.equal(JSON.parse(raw.projectJson).meta.name, "semaforo");

    const saved = applyWrite(read, {
      projectJson: JSON.stringify({ meta: { name: "semaforo", type: "plc-project" }, data: { pous: [] } }),
      pouFiles: [{ relativePath: "pous/function-blocks/pisca.st", content: "FUNCTION_BLOCK pisca\nEND_FUNCTION_BLOCK" }],
      deletions: ["pous/programs/main.sfc"],
    });
    assert.deepEqual(Object.keys(saved.files), ["pous/function-blocks/pisca.st"]);
    assert.equal(readVirtualFile(saved, "devices/configuration.json"), JSON.stringify({ deviceBoard: "OpenPLC Simulator" }, null, 2));
    assert.equal(readVirtualFile(writeVirtualFile(saved, "pous/programs/x.il", "LD TRUE"), "pous/programs/x.il"), "LD TRUE");

    assert.equal(virtualRelativePath(file, `${file}/pous/programs/main.ld`), "pous/programs/main.ld");
    assert.equal(virtualRelativePath(file, file), "");
    assert.equal(virtualRelativePath(file, path.join(root, "outro.lsplc", "pous", "a.st")), undefined);
    assert.equal(virtualRelativePath(file, `${file}/pous/../../segredo.txt`), undefined);
    assert.throws(() => { fs.writeFileSync(path.join(root, "x.lsplc"), "{}"); readLsplc(path.join(root, "x.lsplc")); }, /não é um projeto PLC/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Tabela allVars do driver gerado pelo Core: escalares, membros de FB (aninhados), vetor e struct. */
function debugVariables(): void {
  const driver = [
    "int main() {",
    "    std::vector<VarDescriptor> allVars = {",
    '        {"START", VarTypeTag::BOOL, &g_configuration.MAIN_INSTANCE.START},',
    '        {"COUNT", VarTypeTag::INT, &g_configuration.MAIN_INSTANCE.COUNT},',
    '        {"T1.ET", VarTypeTag::TIME, &g_configuration.MAIN_INSTANCE.T1.ET},',
    '        {"FLIP.EDGE.CLK", VarTypeTag::BOOL, &g_configuration.MAIN_INSTANCE.FLIP.EDGE.CLK},',
    '        {"ARR[2]", VarTypeTag::REAL, &g_configuration.MAIN_INSTANCE.ARR[2]},',
    '        {"S.NAME", VarTypeTag::STRING, &g_configuration.MAIN_INSTANCE.S.NAME},',
    '        {"P", VarTypeTag::OTHER, &g_configuration.MAIN_INSTANCE.P},',
    "    };",
    "    std::vector<VarDescriptor> inputVars = {",
    '        {"START", VarTypeTag::BOOL, &g_configuration.MAIN_INSTANCE.START},',
    "    };",
  ].join("\n");
  assert.deepEqual(driverMonitorVariables(driver), [
    { name: "START", type: "BOOL" },
    { name: "COUNT", type: "INT" },
    { name: "T1.ET", type: "TIME" },
    { name: "FLIP.EDGE.CLK", type: "BOOL" },
    { name: "ARR[2]", type: "REAL" },
    { name: "S.NAME", type: "STRING" },
  ]);
  assert.deepEqual(driverMonitorVariables("int main() {}"), []);
}

function main(): void {
  origins();
  sfc();
  lsplc();
  debugVariables();
  console.log("PLC project .lsplc (OpenPLC editor: ST line origins, SFC -> ST, project file, debug variables): OK");
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }

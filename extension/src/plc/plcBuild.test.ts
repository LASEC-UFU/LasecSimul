import { strict as assert } from "assert";
import * as path from "path";
import { IecProjectStore } from "./iecProject";
import { generateCanonicalSt } from "./lowering";
import { updatePouVariables, updateProjectRuntimeConfiguration, updateTaskConfiguration } from "./iecEditorWorkspace";
import { starterIecProject } from "./plcProjectTemplate";
import {
  mapCompilerOutput,
  parsePlcVariableReply,
  plcExportedIoFromProject,
  plcWatchVariables,
  resolvePlcEntryPoint,
  resolvePlcToolchain,
} from "./plcBuild";

function main(): void {
  // Configuração: CONFIGURATION -> RESOURCE -> TASK -> instância -> PROGRAM.
  const project = starterIecProject("demo");
  const entry = resolvePlcEntryPoint(project);
  assert.equal(entry.pou.pouId, "pou-main");
  assert.equal(entry.taskName, "MAIN_TASK");
  assert.equal(entry.taskIntervalMs, 10);
  assert.equal(entry.programInstanceName, "MAIN_INSTANCE");
  assert.deepEqual(plcExportedIoFromProject(project).map(io => `${io.direction}:${io.ioId}:${io.iecType}`), ["input:DI0:BOOL", "output:DO0:BOOL"]);

  // Tabela de variáveis: ioId estável no rename (os fios do esquemático continuam ligados).
  const renamed = updatePouVariables(project, "pou-main", [
    { name: "START", class: "input", type: "bool", ioId: "DI0" },
    { name: "DO0", class: "output", type: "BOOL", ioId: "DO0" },
    { name: "COUNT", class: "local", type: "int", initialValue: "5" },
    { name: "T1", class: "local", type: "TON" },
    { name: "LEVEL", class: "output", type: "REAL" },
  ]);
  const variables = renamed.pous[0]!.interface.variables;
  assert.equal(variables[0]!.ioId, "DI0", "renomear mantém o ioId (pino)");
  assert.equal(variables[0]!.type, "BOOL", "tipo em maiúsculas");
  assert.equal(variables[2]!.ioId, undefined, "local não vira pino");
  assert.equal(variables[2]!.initialValue, "5");
  assert.equal(variables[4]!.ioId, "LEVEL", "nova saída ganha o próprio nome como ioId");
  assert.throws(() => updatePouVariables(project, "pou-main", [{ name: "1X", class: "local", type: "BOOL" }]), /inválido/);
  const watch = plcWatchVariables(renamed.pous[0]!);
  assert.deepEqual(watch.map(item => `${item.role}:${item.qualifiedName}`),
    ["input:MAIN.START", "output:MAIN.DO0", "local:MAIN.COUNT", "local:MAIN.T1.IN", "local:MAIN.T1.PT", "local:MAIN.T1.Q", "local:MAIN.T1.ET", "output:MAIN.LEVEL"], "campos públicos de FB padrão e locais escalares são monitoráveis");

  // Tarefa: renomear e mudar o período mantém a ligação recurso/instância.
  const retimed = updateTaskConfiguration(project, { name: "FAST", intervalMs: 2.5, priority: 0 }, { name: "MAIN_1", pouId: "pou-main" });
  const retimedEntry = resolvePlcEntryPoint(retimed);
  assert.equal(retimedEntry.taskName, "FAST");
  assert.equal(retimedEntry.taskIntervalMs, 2.5);
  assert.equal(retimedEntry.programInstanceName, "MAIN_1");
  assert.deepEqual((retimed.resources[0] as { tasks: string[] }).tasks, ["FAST"]);
  assert.throws(() => updateTaskConfiguration(project, { name: "T", intervalMs: 0, priority: 1 }, { name: "I", pouId: "pou-main" }), /maior que zero/);

  const multipleTasks = updateProjectRuntimeConfiguration(project, JSON.stringify({
    entryConfiguration: "CONFIGURATION_1",
    configurations: [{ name: "CONFIGURATION_1", resource: "RESOURCE_1" }],
    resources: [{ name: "RESOURCE_1", tasks: ["FAST", "SLOW"] }],
    tasks: [{ name: "FAST", intervalMs: 5, priority: 2 }, { name: "SLOW", intervalMs: 10, priority: 1 }],
    programInstances: [
      { name: "MAIN_FAST", pouId: "pou-main", task: "FAST" },
      { name: "MAIN_SLOW", pouId: "pou-main", task: "SLOW" },
    ],
  }));
  const multiEntry = resolvePlcEntryPoint(multipleTasks);
  assert.equal(multiEntry.taskName, "FAST");
  const multiSt = generateCanonicalSt(new IecProjectStore(multipleTasks), multipleTasks.projectId, "pou-main").text;
  assert.match(multiSt, /TASK FAST\(INTERVAL := T#5ms, PRIORITY := 2\)/);
  assert.match(multiSt, /TASK SLOW\(INTERVAL := T#10ms, PRIORITY := 1\)/);
  assert.match(multiSt, /PROGRAM MAIN_FAST WITH FAST : MAIN/);
  assert.match(multiSt, /PROGRAM MAIN_SLOW WITH SLOW : MAIN/);
  const eventTaskProject = updateProjectRuntimeConfiguration(project, {
    entryConfiguration: "CFG", configurations: [{ name: "CFG", resource: "RES" }],
    resources: [{ name: "RES", tasks: ["ON_INPUT"] }],
    tasks: [{ name: "ON_INPUT", intervalMs: 0, priority: 4, eventVariable: "DI0" }],
    programInstances: [{ name: "MAIN_EVENT", pouId: "pou-main", task: "ON_INPUT" }],
  });
  const eventSt = generateCanonicalSt(new IecProjectStore(eventTaskProject), eventTaskProject.projectId, "pou-main").text;
  assert.match(eventSt, /TASK ON_INPUT\(SINGLE := DI0, PRIORITY := 4\)/);
  assert.throws(() => updateProjectRuntimeConfiguration(project, {
    configurations: [{ name: "CFG", resource: "RES" }], resources: [{ name: "RES", tasks: ["ON_INPUT"] }],
    tasks: [{ name: "ON_INPUT", intervalMs: 0, eventVariable: "DO0" }],
    programInstances: [{ name: "MAIN_EVENT", pouId: "pou-main", task: "ON_INPUT" }],
  }), /entrada BOOL/);
  assert.throws(() => updateProjectRuntimeConfiguration(project, {
    configurations: [], resources: [], tasks: [{ name: "FAST", intervalMs: 0 }], programInstances: [],
  }), /maior que zero/);

  // Mapa de linhas: erro na linha 3 do corpo do MAIN, depois de um FB declarado antes.
  const withFb = structuredClone(project);
  withFb.pous[0]!.implementation = { language: "st", text: "(* comentário *)\nDO0 := DI0;\nDO0 := DI0 AND ;" };
  withFb.pous.push({
    pouId: "pou-fb", name: "FB1", kind: "functionBlock",
    interface: { variables: [{ ioId: "X", name: "X", class: "input", type: "BOOL" }] },
    implementation: { language: "st", text: "\n\nX := X;" },
  });
  const canonical = generateCanonicalSt(new IecProjectStore(withFb), "demo", "pou-main");
  assert.equal(canonical.origins.length, canonical.text.trimEnd().split("\n").length, "uma origem por linha");
  const badLine = canonical.text.split("\n").findIndex(line => line === "DO0 := DI0 AND ;") + 1;
  const fbLine = canonical.text.split("\n").findIndex(line => line === "X := X;") + 1;
  const diagnostics = mapCompilerOutput([
    `main.st:${badLine}:16: error: Unexpected \`;\` after \`AND\` while parsing an expression.`,
    `C:/tmp/build/main.st:${fbLine}:1: error: something`,
    "   3 | DO0 := DI0 AND ;",
  ].join("\n"), canonical.origins, "strucpp");
  assert.equal(diagnostics.length, 2);
  assert.deepEqual([diagnostics[0]!.pouName, diagnostics[0]!.line, diagnostics[0]!.column], ["MAIN", 3, 16]);
  assert.deepEqual([diagnostics[1]!.pouName, diagnostics[1]!.line], ["FB1", 3], "linhas em branco no início do corpo contam");
  const declarationLine = canonical.text.split("\n").findIndex(line => line.trim() === "DI0 : BOOL;") + 1;
  const declaration = mapCompilerOutput(`main.st:${declarationLine}:3: error: bad type`, canonical.origins, "strucpp")[0]!;
  assert.equal(declaration.variableName, "DI0", "erro numa declaração aponta a variável");

  // Resposta do monitor.
  assert.deepEqual(parsePlcVariableReply("MAIN.DI0 : BOOL = TRUE [FORCED]"), { value: "TRUE", forced: true });
  assert.deepEqual(parsePlcVariableReply("MAIN.COUNT : INT = 12"), { value: "12", forced: false });

  // Ferramentas: instalação usa bundled/plc; checkout usa plc/strucpp/build e core/src/plc.
  const extensionPath = path.join(path.sep, "ext");
  const bundled = resolvePlcToolchain(extensionPath, "win32", "x64", candidate => candidate.includes(`${path.sep}bundled${path.sep}`));
  assert.ok(bundled.strucppBinary.endsWith(path.join("bundled", "plc", "strucpp", "strucpp.exe")));
  assert.ok(bundled.runtimeIncludeDir.endsWith(path.join("bundled", "plc", "runtime", "include")));
  assert.ok(bundled.cxxCompiler?.endsWith(path.join("bundled", "plc", "ucrt64", "bin", "g++.exe")));
  const dev = resolvePlcToolchain(extensionPath, "linux", "x64", () => false);
  assert.ok(dev.strucppBinary.endsWith(path.join("plc", "strucpp", "build", "linux-x64", "strucpp", "strucpp")));
  assert.ok(dev.plcSrcDir.endsWith(path.join("core", "src", "plc")));
  assert.equal(dev.cxxCompiler, undefined, "Linux usa o g++ do sistema");

  console.log("PLC build (entry point, pins, variables table, task, line map, monitor reply, toolchain): OK");
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }

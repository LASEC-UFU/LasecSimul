import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { IEC_LANGUAGES, IecLanguage, IecProjectAuthoring, IecVariable, LdCell, PouDefinition, signatureOf } from "./iecProject";
import { starterIecProject } from "./plcProjectTemplate";
import { PlcBuildOptions, buildIecProject, parsePlcVariableReply, resolvePlcToolchain } from "./plcBuild";

/** Runs the complete 5×5 POU language interoperability matrix in the actual Core PLC worker. */
const { test, finish } = createTestRunner("Matriz IEC 61131-3 5×5 no Core real");
const extensionRoot = path.resolve(__dirname, "..", "..");
const MS = 1_000_000;
const v = (name: string, cls: IecVariable["class"]): IecVariable =>
  cls === "input" || cls === "output" ? { ioId: name, name, class: cls, type: "BOOL" } : { name, class: cls, type: "BOOL" };
const fbName = (language: IecLanguage) => `FB_${language.toUpperCase()}`;
const instanceName = (language: IecLanguage) => `I_${language.toUpperCase()}`;
const inputName = (language: IecLanguage) => `X_${language.toUpperCase()}`;
const outputName = (language: IecLanguage) => `Y_${language.toUpperCase()}`;

function callee(language: IecLanguage): PouDefinition {
  let implementation: PouDefinition["implementation"];
  if (language === "st") implementation = { language, text: "Q := IN;" };
  else if (language === "il") implementation = { language, text: "LD IN\nST Q" };
  else if (language === "ld") implementation = { language, networks: [], rungs: [{ rungId: "r1", rows: [[
    { kind: "contact", contact: "no", variable: "IN" }, { kind: "coil", coil: "coil", variable: "Q" },
  ]], verticals: [] }] };
  else if (language === "fbd") implementation = { language, networks: [{ networkId: "n1", nodes: [
    { nodeId: "in", kind: "input", symbol: "IN" }, { nodeId: "out", kind: "output", symbol: "Q" },
  ], edges: [{ edgeId: "e1", fromNodeId: "in", fromPort: "OUT", toNodeId: "out", toPort: "IN" }] }] };
  else implementation = { language, steps: [{ stepId: "s1", name: "Run", initial: true, actions: [{ actionId: "a1", text: "Q := IN;" }] }], transitions: [], actions: [] };
  return { pouId: `pou-${language}`, name: fbName(language), kind: "functionBlock",
    interface: { variables: [v("IN", "input"), v("Q", "output")] }, implementation };
}

function caller(language: IecLanguage, callees: PouDefinition[]): PouDefinition {
  const variables = callees.flatMap(target => [
    { name: inputName(target.implementation.language), class: "local" as const, type: "BOOL", initialValue: "TRUE" },
    v(outputName(target.implementation.language), "output"),
  ]);
  const references = callees.map(target => ({ referenceId: `ref-${target.pouId}`, targetPouId: target.pouId,
    instanceName: instanceName(target.implementation.language), expectedSignature: signatureOf(target) }));
  let implementation: PouDefinition["implementation"];
  if (language === "st") implementation = { language, text: callees.map(target => {
    const tag = target.implementation.language;
    return `${instanceName(tag)}.IN := ${inputName(tag)};\n${instanceName(tag)}();\n${outputName(tag)} := ${instanceName(tag)}.Q;`;
  }).join("\n") };
  else if (language === "il") implementation = { language, text: callees.map(target => {
    const tag = target.implementation.language, instance = instanceName(tag);
    return `LD ${inputName(tag)}\nST ${instance}.IN\nCAL ${instance}\nLD ${instance}.Q\nST ${outputName(tag)}`;
  }).join("\n") };
  else if (language === "ld") implementation = { language, networks: [], rungs: callees.map(target => {
    const tag = target.implementation.language;
    const contact: LdCell = { kind: "contact", contact: "no", variable: inputName(tag) };
    const block: LdCell = { kind: "block", typeName: fbName(tag), instanceName: instanceName(tag), powerInput: "IN", powerOutput: "Q", inputs: {}, outputs: {} };
    const coil: LdCell = { kind: "coil", coil: "coil", variable: outputName(tag) };
    return { rungId: `r-${tag}`, rows: [[contact, block, coil]], verticals: [] };
  }) };
  else if (language === "fbd") {
    const nodes = [], edges = [];
    for (const target of callees) {
      const tag = target.implementation.language, suffix = tag;
      nodes.push({ nodeId: `x-${suffix}`, kind: "input" as const, symbol: inputName(tag) });
      nodes.push({ nodeId: `fb-${suffix}`, kind: "block" as const, referencedPouId: target.pouId, instanceName: instanceName(tag) });
      nodes.push({ nodeId: `y-${suffix}`, kind: "output" as const, symbol: outputName(tag) });
      edges.push({ edgeId: `in-${suffix}`, fromNodeId: `x-${suffix}`, fromPort: "OUT", toNodeId: `fb-${suffix}`, toPort: "IN" });
      edges.push({ edgeId: `out-${suffix}`, fromNodeId: `fb-${suffix}`, fromPort: "Q", toNodeId: `y-${suffix}`, toPort: "IN" });
    }
    implementation = { language, networks: [{ networkId: "cross-language", nodes, edges }] };
  } else implementation = { language, steps: [{ stepId: "s1", name: "Run", initial: true, actions: callees.map(target => {
    const tag = target.implementation.language, instance = instanceName(tag);
    return { actionId: `a-${tag}`, text: `${instance}.IN := ${inputName(tag)}; ${instance}(); ${outputName(tag)} := ${instance}.Q;` };
  }) }], transitions: [], actions: [] };
  const main: PouDefinition = { pouId: "main", name: "MAIN", kind: "program", interface: { variables }, implementation, references };
  return main;
}

(async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-plc-5x5-"));
  const options: PlcBuildOptions = { toolchain: resolvePlcToolchain(extensionRoot), cacheRoot };
  const pipeName = `lasecsimul-plc-5x5-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });
  try {
    processManager.start();
    await client.start();
    await test("cada linguagem de chamador executa FBs implementados nas cinco linguagens", async () => {
      const targets = IEC_LANGUAGES.map(callee);
      for (const callerLanguage of IEC_LANGUAGES) {
        const main = caller(callerLanguage, targets);
        const project: IecProjectAuthoring = { ...starterIecProject(`matrix-${callerLanguage}`), pous: [...targets, main] };
        const built = await buildIecProject(project, options);
        if (!built.ok) throw new Error(`${callerLanguage}: ${JSON.stringify(built.diagnostics)}\n${built.log}`);
        const pins = built.module.exportedIo.map((io, index) => ({ id: io.ioId, x: 0, y: index * 12 }));
        const plc = await client.addComponent("plc.instance", {}, pins, project.projectId);
        await client.setPlcTaskInterval(plc.instanceId, 10 * MS);
        await client.loadPlcArtifact(plc.instanceId, built.module);
        await client.step(20 * MS);
        for (const target of targets) {
          const name = outputName(target.implementation.language);
          const received = parsePlcVariableReply(await client.plcGet(plc.instanceId, `MAIN.${name}`)).value;
          assert(received === "TRUE",
            `${callerLanguage} chamando ${target.implementation.language}; MAIN.${name}=${received}`);
        }
      }
    });
  } finally {
    await client.stop();
    processManager.kill();
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    const result = finish();
    if (result.failed > 0) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

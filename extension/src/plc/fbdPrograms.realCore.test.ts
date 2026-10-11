import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { IecProjectAuthoring, IecVariable, PouDefinition, signatureOf } from "./iecProject";
import { starterIecProject } from "./plcProjectTemplate";
import { PlcBuildOptions, buildIecProject, parsePlcVariableReply, resolvePlcToolchain } from "./plcBuild";

/** FBD translated to ST/C++ and executed in the actual isolated Core PLC worker. */
const { test, finish } = createTestRunner("CLP em FBD executado no Core real");
const extensionRoot = path.resolve(__dirname, "..", "..");
const MS = 1_000_000;
const v = (name: string, cls: IecVariable["class"], type: string): IecVariable =>
  cls === "input" || cls === "output" ? { ioId: name, name, class: cls, type } : { name, class: cls, type };

function projectWith(pous: PouDefinition[], id: string): IecProjectAuthoring {
  const project = starterIecProject(id);
  project.pous = pous;
  return project;
}

(async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-plc-fbd-"));
  const options: PlcBuildOptions = { toolchain: resolvePlcToolchain(extensionRoot), cacheRoot };
  const pipeName = `lasecsimul-plc-fbd-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });
  const load = async (project: IecProjectAuthoring) => {
    const built = await buildIecProject(project, options);
    if (!built.ok) throw new Error(`compilação: ${JSON.stringify(built.diagnostics)}\n${built.log}`);
    const pins = built.module.exportedIo.map((io, index) => ({ id: io.ioId, x: 0, y: index * 12 }));
    const plc = await client.addComponent("plc.instance", {}, pins, project.projectId);
    await client.setPlcTaskInterval(plc.instanceId, 10 * MS);
    await client.loadPlcArtifact(plc.instanceId, built.module);
    const force = async (values: Record<string, boolean | number>) => {
      for (const [name, value] of Object.entries(values)) await client.plcForce(plc.instanceId, `MAIN.${name}`,
        typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value));
    };
    const get = async (name: string) => parsePlcVariableReply(await client.plcGet(plc.instanceId, `MAIN.${name}`)).value;
    return { force, get, plc };
  };

  try {
    processManager.start();
    await client.start();
    await test("operador AND do diagrama FBD determina a saída em todas as combinações", async () => {
      const main: PouDefinition = {
        pouId: "main", name: "MAIN", kind: "program",
        interface: { variables: [v("A", "input", "BOOL"), v("B", "input", "BOOL"), v("Q", "output", "BOOL")] },
        implementation: { language: "fbd", networks: [{ networkId: "logic", nodes: [
          { nodeId: "a", kind: "input", symbol: "A" }, { nodeId: "b", kind: "input", symbol: "B" },
          { nodeId: "and", kind: "operator", operator: "AND" }, { nodeId: "q", kind: "output", symbol: "Q" },
        ], edges: [
          { edgeId: "a-and", fromNodeId: "a", fromPort: "OUT", toNodeId: "and", toPort: "A" },
          { edgeId: "b-and", fromNodeId: "b", fromPort: "OUT", toNodeId: "and", toPort: "B" },
          { edgeId: "and-q", fromNodeId: "and", fromPort: "OUT", toNodeId: "q", toPort: "IN" },
        ] }] },
      };
      const plc = await load(projectWith([main], "fbd-and"));
      for (const [a, b, expected] of [[false, false, false], [false, true, false], [true, false, false], [true, true, true]] as const) {
        await plc.force({ A: a, B: b });
        await client.step(20 * MS);
        assert((await plc.get("Q")) === (expected ? "TRUE" : "FALSE"), `AND(${a}, ${b})`);
      }
    });

    await test("FBD chama um FUNCTION_BLOCK escrito em ST pela mesma interface e instância", async () => {
      const gate: PouDefinition = {
        pouId: "gate", name: "FB_GATE", kind: "functionBlock",
        interface: { variables: [v("Enable", "input", "BOOL"), v("Q", "output", "BOOL")] },
        implementation: { language: "st", text: "Q := Enable;" },
      };
      const main: PouDefinition = {
        pouId: "main", name: "MAIN", kind: "program",
        interface: { variables: [v("A", "input", "BOOL"), v("Q", "output", "BOOL")] },
        implementation: { language: "fbd", networks: [{ networkId: "call", nodes: [
          { nodeId: "a", kind: "input", symbol: "A" },
          { nodeId: "gate", kind: "block", referencedPouId: gate.pouId, instanceName: "gate_instance" },
          { nodeId: "q", kind: "output", symbol: "Q" },
        ], edges: [
          { edgeId: "enable", fromNodeId: "a", fromPort: "OUT", toNodeId: "gate", toPort: "Enable" },
          { edgeId: "result", fromNodeId: "gate", fromPort: "Q", toNodeId: "q", toPort: "IN" },
        ] }] },
      };
      main.references = [{ referenceId: "ref-gate", targetPouId: gate.pouId, instanceName: "gate_instance", expectedSignature: signatureOf(gate) }];
      const plc = await load(projectWith([gate, main], "fbd-cross-language"));
      await plc.force({ A: true });
      await client.step(20 * MS);
      assert(await plc.get("Q") === "TRUE", "FB_GATE implements the FBD output");
      await plc.force({ A: false });
      await client.step(20 * MS);
      assert(await plc.get("Q") === "FALSE", "the same FB instance reflects the next scan input");
    });

    await test("FBD chama uma FUNCTION em outra linguagem com argumentos formais", async () => {
      const scale: PouDefinition = {
        pouId: "scale", name: "FC_SCALE", kind: "function",
        interface: { returnType: "REAL", variables: [v("Value", "input", "REAL")] },
        implementation: { language: "st", text: "FC_SCALE := Value * 2.0;" },
      };
      const main: PouDefinition = {
        pouId: "main", name: "MAIN", kind: "program",
        interface: { variables: [v("X", "input", "REAL"), v("Y", "output", "REAL")] },
        implementation: { language: "fbd", networks: [{ networkId: "call", nodes: [
          { nodeId: "x", kind: "input", symbol: "X" },
          { nodeId: "scale", kind: "block", referencedPouId: scale.pouId },
          { nodeId: "y", kind: "output", symbol: "Y" },
        ], edges: [
          { edgeId: "arg", fromNodeId: "x", fromPort: "OUT", toNodeId: "scale", toPort: "Value" },
          { edgeId: "result", fromNodeId: "scale", fromPort: "OUT", toNodeId: "y", toPort: "IN" },
        ] }] },
      };
      main.references = [{ referenceId: "ref-scale", targetPouId: scale.pouId, expectedSignature: signatureOf(scale) }];
      const plc = await load(projectWith([scale, main], "fbd-function"));
      await plc.force({ X: 3 });
      await client.step(20 * MS);
      assert(Number(await plc.get("Y")) === 6, `FC_SCALE(3.0) = ${await plc.get("Y")}`);
    });

    await test("duas instâncias FBD do mesmo FB stateful preservam memória independente", async () => {
      const toggle: PouDefinition = {
        pouId: "toggle", name: "FB_TOGGLE", kind: "functionBlock",
        interface: { variables: [v("EN", "input", "BOOL"), v("Q", "output", "BOOL")] },
        implementation: { language: "st", text: "IF EN THEN Q := NOT Q; END_IF;" },
      };
      const main: PouDefinition = {
        pouId: "main", name: "MAIN", kind: "program",
        interface: { variables: [v("E1", "input", "BOOL"), v("E2", "input", "BOOL"), v("Q1", "output", "BOOL"), v("Q2", "output", "BOOL")] },
        implementation: { language: "fbd", networks: [{ networkId: "two-instances", nodes: [
          { nodeId: "e1", kind: "input", symbol: "E1" }, { nodeId: "fb1", kind: "block", referencedPouId: toggle.pouId, instanceName: "first" }, { nodeId: "q1", kind: "output", symbol: "Q1" },
          { nodeId: "e2", kind: "input", symbol: "E2" }, { nodeId: "fb2", kind: "block", referencedPouId: toggle.pouId, instanceName: "second" }, { nodeId: "q2", kind: "output", symbol: "Q2" },
        ], edges: [
          { edgeId: "e1-fb1", fromNodeId: "e1", toNodeId: "fb1", toPort: "EN" }, { edgeId: "fb1-q1", fromNodeId: "fb1", fromPort: "Q", toNodeId: "q1", toPort: "IN" },
          { edgeId: "e2-fb2", fromNodeId: "e2", toNodeId: "fb2", toPort: "EN" }, { edgeId: "fb2-q2", fromNodeId: "fb2", fromPort: "Q", toNodeId: "q2", toPort: "IN" },
        ] }] },
      };
      main.references = [
        { referenceId: "ref-first", targetPouId: toggle.pouId, instanceName: "first", expectedSignature: signatureOf(toggle) },
        { referenceId: "ref-second", targetPouId: toggle.pouId, instanceName: "second", expectedSignature: signatureOf(toggle) },
      ];
      const plc = await load(projectWith([toggle, main], "fbd-instance-isolation"));
      await plc.force({ E1: true, E2: false });
      await client.step(10 * MS);
      const firstScan = [await plc.get("Q1"), await plc.get("Q2")].join(",");
      assert(firstScan === "TRUE,FALSE", `only first instance toggles: ${firstScan}`);
      await plc.force({ E1: false, E2: true });
      await client.step(10 * MS);
      const secondScan = [await plc.get("Q1"), await plc.get("Q2")].join(",");
      assert(secondScan === "TRUE,TRUE", `second instance toggles without changing first instance state: ${secondScan}`);
    });

    await test("realimentação FBD usa valor inicial e avança um scan por ciclo", async () => {
      const increment: PouDefinition = {
        pouId: "increment", name: "FB_INCREMENT", kind: "functionBlock",
        interface: { variables: [v("IN", "input", "DINT"), v("Q", "output", "DINT")] },
        implementation: { language: "st", text: "Q := IN + 1;" },
      };
      const main: PouDefinition = {
        pouId: "main", name: "MAIN", kind: "program",
        interface: { variables: [v("Q", "output", "DINT")] },
        implementation: { language: "fbd", networks: [{ networkId: "feedback", nodes: [
          { nodeId: "counter", kind: "block", referencedPouId: increment.pouId, instanceName: "counter" },
          { nodeId: "q", kind: "output", symbol: "Q" },
        ], edges: [
          { edgeId: "loop", fromNodeId: "counter", fromPort: "Q", toNodeId: "counter", toPort: "IN", feedback: true, feedbackInitialValue: "0" },
          { edgeId: "result", fromNodeId: "counter", fromPort: "Q", toNodeId: "q", toPort: "IN" },
        ] }] },
      };
      main.references = [{ referenceId: "ref-increment", targetPouId: increment.pouId, instanceName: "counter", expectedSignature: signatureOf(increment) }];
      const plc = await load(projectWith([increment, main], "fbd-feedback"));
      await client.step(10 * MS);
      assert(Number(await plc.get("Q")) === 1, `initial feedback value advances to one: ${await plc.get("Q")}`);
      await client.step(10 * MS);
      assert(Number(await plc.get("Q")) === 2, `feedback carries previous scan value: ${await plc.get("Q")}`);
    });
  } finally {
    await client.stop();
    processManager.kill();
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    const result = finish();
    if (result.failed > 0) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

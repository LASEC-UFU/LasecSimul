import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { SeriesStore } from "../lab/SeriesStore";
import { ProjectSerializer } from "./ProjectSerializer";
import { createEmptyProject, ProjectComponent, ProjectDocument } from "./ProjectTypes";
import { materializeEmbeddedSubcircuit } from "./embeddedSubcircuits";
import { childPropertyKey } from "../ui/webview/childPropertyOverrides";
import {
  exportSubsystemAsExternal,
  flattenExternalSystem,
  importExternalAsSubsystem,
  subsystemTopologicalOrder,
  SubsystemDefinition,
} from "../ui/webview/subsystemModel";

/**
 * Subsistemas internos x sistemas externos no Core REAL, pelo mesmo protocolo do host
 * (`project/subsystemRuntime.ts`): definições da tabela materializadas e registradas com dependências
 * antes; sistema externo com subsistemas internos registrado em espaço de nomes do arquivo.
 *
 * Fora do `npm test` (precisa do Core compilado):
 *   npm run compile && node out/project/subsystems.realCore.test.js
 */
const { test, finish } = createTestRunner("Subsistemas internos e sistemas externos (Core real)");
const extensionRoot = path.resolve(__dirname, "..", "..");
const MS = 1_000_000;

/** Bloco de sinal in -> estágios em série -> out (mesmo formato dos blocos `subcircuits/control_*`). */
function signalSubsystem(typeId: string, name: string, stages: Array<{ id: string; typeId: string; properties?: Record<string, unknown> }>): SubsystemDefinition {
  const tunnel = (id: string, pinId: string, direction: "Input" | "Output") => ({ id, typeId: "connectors.signal_tunnel", properties: { name: pinId, pinId, direction, valueType: "Real", ...(direction === "Input" ? { defaultValue: 0 } : {}) }, visual: { x: 0, y: 0, rotation: 0 } });
  const chain = ["in-tunnel", ...stages.map((stage) => stage.id), "out-tunnel"];
  const conductors = chain.slice(0, -1).map((from, index) => ({
    id: `w${index}`,
    from: { kind: "port", componentId: from, pinId: from === "in-tunnel" ? "value" : "out" },
    to: { kind: "port", componentId: chain[index + 1]!, pinId: chain[index + 1] === "out-tunnel" ? "value" : "in" },
    vertices: [],
  }));
  return {
    schemaVersion: 3, typeId, name,
    components: [tunnel("in-tunnel", "in", "Input"), ...stages.map((stage) => ({ id: stage.id, typeId: stage.typeId, properties: { samplePeriodNs: 10 * MS, ...(stage.properties ?? {}) }, visual: { x: 100, y: 0, rotation: 0 } })), tunnel("out-tunnel", "out", "Output")] as SubsystemDefinition["components"],
    topology: { revision: 0, nodes: [], conductors },
    interface: [
      { pinId: "in", label: "IN", internalTunnel: "in", domain: "signal", direction: "in", valueType: "Real", width: 1 },
      { pinId: "out", label: "OUT", internalTunnel: "out", domain: "signal", direction: "out", valueType: "Real", width: 1 },
    ],
    symbolMode: "generic", exposedComponents: [], exportedPropertyComponentIds: stages.map((stage) => stage.id),
  };
}

/** "Controle de Temperatura": Planta contém o subsistema Sensor; Controlador e Instrumentação ao lado. */
function temperatureControlTable(): SubsystemDefinition[] {
  return [
    signalSubsystem("subsystem.sensor", "Sensor", [{ id: "k", typeId: "control.gain", properties: { gain: 1 } }]),
    signalSubsystem("subsystem.planta", "Planta", [{ id: "fo", typeId: "control.first_order", properties: { gain: 2, tau: 1, initial: 0 } }, { id: "s", typeId: "subsystem.sensor" }]),
    signalSubsystem("subsystem.controlador", "Controlador", [{ id: "k", typeId: "control.gain", properties: { gain: 3 } }]),
    signalSubsystem("subsystem.instrumentacao", "Instrumentação", [{ id: "k", typeId: "control.gain", properties: { gain: 0.5 } }]),
  ];
}

const component = (id: string, typeId: string, properties: Record<string, unknown> = {}): ProjectComponent => ({ id, typeId, properties, visual: { x: 0, y: 0, rotation: 0 } });
const wire = (id: string, from: [string, string], to: [string, string]) => ({ id, from: { kind: "port" as const, componentId: from[0], pinId: from[1] }, to: { kind: "port" as const, componentId: to[0], pinId: to[1] }, vertices: [] });

function temperatureControlProject(): ProjectDocument {
  return {
    ...createEmptyProject(),
    subsystems: temperatureControlTable(),
    components: [
      component("c", "control.constant", { value: 1 }), component("C", "subsystem.controlador"), component("P", "subsystem.planta"), component("I", "subsystem.instrumentacao"),
      // Segunda malha: OUTRA instância de Controlador (K = 5 só nesta instância) e de Planta.
      component("c2", "control.constant", { value: 1 }), component("C2", "subsystem.controlador", { [childPropertyKey("k", "gain")]: 5 }), component("P2", "subsystem.planta"),
    ],
    topology: { revision: 0, nodes: [], conductors: [
      wire("w1", ["c", "out"], ["C", "in"]), wire("w2", ["C", "out"], ["P", "in"]), wire("w3", ["P", "out"], ["I", "in"]),
      wire("w4", ["c2", "out"], ["C2", "in"]), wire("w5", ["C2", "out"], ["P2", "in"]),
    ] },
  };
}

interface RunningCore { client: CoreClient; processManager: CoreProcess }
async function startCore(tag: string): Promise<RunningCore> {
  const pipeName = `lasecsimul-subsystems-${tag}-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });
  processManager.start();
  await client.start();
  return { client, processManager };
}
async function stopCore(core: RunningCore): Promise<void> {
  await core.client.stop().catch(() => undefined);
  core.processManager.kill();
}

/** Mesmo protocolo de `subsystemRuntime.registerSubsystemsInCore`. */
async function registerTable(client: CoreClient, table: readonly SubsystemDefinition[]): Promise<void> {
  for (const definition of subsystemTopologicalOrder(table)) await client.registerAdhocSubcircuitDefinition(materializeEmbeddedSubcircuit(definition), { replace: true });
}
/** Mesmo protocolo de `subsystemRuntime.registerExternalSystemFile`. */
async function registerExternalFile(client: CoreClient, filePath: string): Promise<void> {
  const { definitions, main } = flattenExternalSystem(JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>);
  for (const definition of definitions) await client.registerAdhocSubcircuitDefinition(materializeEmbeddedSubcircuit(definition), { replace: true });
  await client.registerAdhocSubcircuitDefinition(materializeEmbeddedSubcircuit(main), { replace: true });
}

/** Instancia o projeto no Core (instâncias, parâmetros por instância, fios por pino de fronteira). */
async function instantiate(client: CoreClient, project: ProjectDocument): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const boundary = new Map<string, Record<string, { instanceId: string; pinId: string }>>();
  for (const item of project.components) {
    const plain = Object.fromEntries(Object.entries(item.properties).filter(([key]) => !key.startsWith("@")));
    const created = await client.addComponent(item.typeId, plain, [], item.id);
    ids.set(item.id, created.instanceId);
    boundary.set(item.id, { ...(created.exposedPins ?? {}), ...(created.exposedSignalPins ?? {}) });
    for (const [key, value] of Object.entries(item.properties)) {
      if (!key.startsWith("@")) continue;
      const [child, name] = key.slice(1).split(".") as [string, string];
      await client.setSubcircuitChildProperty(created.instanceId, child, name, value as number);
    }
  }
  const endpoint = (componentId: string, pinId: string) => boundary.get(componentId)?.[pinId] ?? { instanceId: ids.get(componentId)!, pinId };
  for (const conductor of project.topology.conductors) {
    if (conductor.from.kind !== "port" || conductor.to.kind !== "port") continue;
    const a = endpoint(conductor.from.componentId, conductor.from.pinId);
    const b = endpoint(conductor.to.componentId, conductor.to.pinId);
    await client.connectWire(a.instanceId, a.pinId, b.instanceId, b.pinId);
  }
  return ids;
}

/** Valor da saída `out` do componente interno `localId` da instância, após simular `seconds`. */
async function sample(client: CoreClient, ids: Map<string, string>, probes: Array<{ name: string; componentId: string; localId?: string }>, seconds: number): Promise<Record<string, number>> {
  const channels: Array<{ instanceId: string; port: string }> = [];
  for (const probe of probes) channels.push({ instanceId: probe.localId ? await client.getSubcircuitChildInstanceId(ids.get(probe.componentId)!, probe.localId) : ids.get(probe.componentId)!, port: "out" });
  const store = new SeriesStore(await client.subscribeSeries(channels, { periodNs: 10 * MS }), probes.map((probe) => probe.name));
  await client.step(Math.round(seconds * 1000) * MS);
  for (let guard = 0; guard < 500; guard++) {
    const frame = await client.getTelemetryFrame({ items: [], probes: [], series: [store.request()] });
    store.ingest(frame.series[0]!);
    if (!frame.series[0]!.more) break;
  }
  await client.unsubscribeSeries(store.subscriptionId);
  const times = store.timesView();
  const last = times.length - 1;
  return Object.fromEntries(probes.map((probe) => [probe.name, store.column(probe.name)[last]!]));
}

const STEP = 1 - Math.exp(-1);
const near = (actual: number, expected: number, tolerance = 2e-2) => Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));
const PROBES = [
  { name: "C", componentId: "C", localId: "k" }, { name: "C2", componentId: "C2", localId: "k" },
  { name: "P", componentId: "P", localId: "fo" }, { name: "P2", componentId: "P2", localId: "fo" },
  { name: "I", componentId: "I", localId: "k" },
];

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-subsystems-realcore-"));
  const serializer = new ProjectSerializer();
  let reference: Record<string, number> | undefined;
  try {
    await test("três subsistemas internos ligados (Planta contém Sensor) simulam; instâncias têm parâmetros e estados próprios", async () => {
      const core = await startCore("a");
      try {
        const project = temperatureControlProject();
        await registerTable(core.client, project.subsystems!);
        const ids = await instantiate(core.client, project);
        reference = await sample(core.client, ids, PROBES, 1);
        assert(near(reference.C!, 3) && near(reference.C2!, 5), `parâmetro por instância: C=${reference.C} C2=${reference.C2}`);
        assert(near(reference.P!, 6 * STEP) && near(reference.P2!, 10 * STEP), `estado próprio de cada Planta (1ª ordem): P=${reference.P} P2=${reference.P2}`);
        assert(near(reference.I!, 0.5 * 6 * STEP), `Planta -> Sensor (aninhado) -> Instrumentação: I=${reference.I}`);
      } finally {
        await stopCore(core);
      }
    });

    await test("salvar, copiar o .lsproj para OUTRA pasta e reabrir: mesma estrutura e mesmos resultados, sem arquivo externo", async () => {
      const original = path.join(work, "projeto", "controle_temperatura.lsproj");
      await serializer.save(original, temperatureControlProject());
      const copyDir = path.join(work, "copia", "outra", "pasta");
      fs.mkdirSync(copyDir, { recursive: true });
      const copied = path.join(copyDir, "controle_temperatura.lsproj");
      fs.copyFileSync(original, copied);
      fs.rmSync(path.join(work, "projeto"), { recursive: true, force: true });
      const reopened = await serializer.load(copied);
      assert(reopened.subsystems?.length === 4 && reopened.components.length === 7, "definições e instâncias reconstruídas");
      const core = await startCore("b");
      try {
        await registerTable(core.client, reopened.subsystems!);
        const ids = await instantiate(core.client, reopened);
        const values = await sample(core.client, ids, PROBES, 1);
        for (const key of Object.keys(reference!)) assert(near(values[key]!, reference![key]!, 1e-6), `${key}: ${values[key]} vs ${reference![key]}`);
      } finally {
        await stopCore(core);
      }
    });

    await test("exportar a Planta (com o Sensor interno) como .lssubcircuit e usá-la em outro projeto por referência", async () => {
      const exported = exportSubsystemAsExternal(temperatureControlTable(), "subsystem.planta", "subcircuits.planta_exportada")!;
      const file = path.join(work, "biblioteca", "planta_exportada.lssubcircuit");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(exported, null, 2)}\n`);
      // Outro projeto com um subsistema interno "subsystem.sensor" DIFERENTE (ganho 10): não pode colidir.
      const otherTable = [signalSubsystem("subsystem.sensor", "Sensor", [{ id: "k", typeId: "control.gain", properties: { gain: 10 } }])];
      const other: ProjectDocument = { ...createEmptyProject(), subsystems: otherTable, components: [
        component("c", "control.constant", { value: 1 }), component("X", "subcircuits.planta_exportada"), component("S", "subsystem.sensor"),
        // Saída da planta externa DEPOIS do Sensor aninhado dela (ganho 1, não o 10 do projeto).
        component("xo", "control.gain", { gain: 1, samplePeriodNs: 10 * MS }),
      ], topology: { revision: 0, nodes: [], conductors: [wire("w1", ["c", "out"], ["X", "in"]), wire("w2", ["c", "out"], ["S", "in"]), wire("w3", ["X", "out"], ["xo", "in"])] } };
      const core = await startCore("c");
      try {
        await registerExternalFile(core.client, file);
        await registerTable(core.client, otherTable);
        const ids = await instantiate(core.client, other);
        const values = await sample(core.client, ids, [{ name: "X", componentId: "X", localId: "fo" }, { name: "XO", componentId: "xo" }, { name: "S", componentId: "S", localId: "k" }], 1);
        assert(near(values.X!, 2 * STEP), `planta externa simula no outro projeto: ${values.X}`);
        assert(near(values.XO!, 2 * STEP), `Sensor aninhado da planta externa é o DELA (ganho 1), não o do projeto: ${values.XO}`);
        assert(near(values.S!, 10), `o Sensor interno do outro projeto continua o dele (sem colisão): ${values.S}`);
      } finally {
        await stopCore(core);
      }
    });

    await test("incorporar o sistema externo como cópia interna: funciona depois de apagar o arquivo de origem", async () => {
      const file = path.join(work, "biblioteca", "planta_exportada.lssubcircuit");
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const imported = importExternalAsSubsystem([], manifest, { file });
      fs.rmSync(file);
      const project: ProjectDocument = { ...createEmptyProject(), subsystems: imported.table, components: [component("c", "control.constant", { value: 1 }), component("P", imported.typeId)], topology: { revision: 0, nodes: [], conductors: [wire("w1", ["c", "out"], ["P", "in"])] } };
      const saved = path.join(work, "incorporado.lsproj");
      await serializer.save(saved, project);
      const reopened = await serializer.load(saved);
      const core = await startCore("d");
      try {
        await registerTable(core.client, reopened.subsystems!);
        const ids = await instantiate(core.client, reopened);
        const values = await sample(core.client, ids, [{ name: "P", componentId: "P", localId: "fo" }], 1);
        assert(near(values.P!, 2 * STEP), `cópia interna simula sem o arquivo: ${values.P}`);
        assert(reopened.subsystems!.find((entry) => entry.typeId === imported.typeId)?.origin?.typeId === "subcircuits.planta_exportada", "origem registrada só como informação");
      } finally {
        await stopCore(core);
      }
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

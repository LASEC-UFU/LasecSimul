/**
 * Validação numérica ANTES x DEPOIS da migração dos blocos legados (docs/69). Para cada diagrama do
 * repositório com bloco legado (manifesto de subcircuito, definições internas e diagrama principal de
 * projeto), roda o MESMO estímulo em dois Cores reais:
 *   - antes: Core de referência congelado no commit anterior à biblioteca (ab4c1efb7), com o arquivo
 *     ORIGINAL lido do git;
 *   - depois: Core atual com o arquivo MIGRADO (`migrateControlDocument`).
 * Grava a saída de cada bloco legado (o bloco novo que a publica mantém o id) e as saídas expostas, e
 * compara: erro absoluto máximo, erro relativo à faixa, RMSE, NRMSE e deslocamento de eventos.
 *
 * Fora do `npm test` (precisa dos dois Cores compilados):
 *   npx tsc -p ./tsconfig.test.json && node out-test/src/migration/controlLibrary/validateMigration.js \
 *     --legacy ../core/build-legacy-reference/bin/lasecsimul-core.exe --current ../core/build-main/Release/lasecsimul-core.exe \
 *     --out ../docs/data/control-migration-validation.json [--only <trecho do caminho>] [--seconds 40]
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CoreProcess } from "../../ipc/CoreProcess";
import { CoreClient, type SeriesChannel } from "../../ipc/CoreClient";
import { migrateLegacyTankBlocks } from "../../catalog/legacyTankMigration";
import type { ProjectComponent } from "../../project/ProjectTypes";
import { flattenExternalSystem, hoistEmbeddedSubsystems, manifestSubsystems, SubsystemComponentLike } from "../../ui/webview/subsystemModel";
import { Conversion, convertLegacyBlock } from "./conversions";
import { LEGACY_CONTROL_TYPE_IDS } from "./legacyBlocks";
import { LEGACY_LIBRARY_EXPORTS } from "./legacyLibraryExports";
import { migrateControlDocument } from "./migrateDocument";

type Json = Record<string, unknown>;
const REVISION = "ab4c1efb7";
const MS = 1_000_000;

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const legacyExe = path.resolve(option("legacy", path.join(repoRoot, "core", "build-legacy-reference", "bin", "lasecsimul-core.exe"))!);
const currentExe = path.resolve(option("current", path.join(repoRoot, "core", "build-main", "Release", "lasecsimul-core.exe"))!);
const outFile = path.resolve(option("out", path.join(repoRoot, "docs", "data", "control-migration-validation.json"))!);
const only = option("only");
const skips = args.flatMap((arg, index) => arg === "--skip" && args[index + 1] ? [args[index + 1]!] : []);
const append = args.includes("--append");
const seconds = Number(option("seconds", "40"));
const gridNs = Number(option("grid-ms", "50")) * MS;

const git = (...gitArgs: string[]) => execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const parse = (text: string) => JSON.parse(text.replace(/^﻿/, "")) as Json;
const isLegacy = (typeId: unknown): typeId is string => typeof typeId === "string" && LEGACY_CONTROL_TYPE_IDS.has(typeId);

// ------------------------------------------------------------------ alvos

interface Target {
  /** Arquivo (relativo ao repositório) e diagrama dentro dele. */
  file: string;
  diagram: string;
  /** Manifestos a registrar (dependências antes) e o typeId instanciado. */
  legacy: { definitions: Json[]; main: Json };
  current: { definitions: Json[]; main: Json };
  /** Blocos legados do diagrama principal (id -> conversão aplicada). */
  blocks: Array<{ id: string; typeId: string; conversion: Conversion }>;
}

/** Diagrama de projeto filtrado ao que o Core instancia (blocos, túneis de sinal, subsistemas). */
const SIGNAL_PREFIXES = ["control.", "process.", "sl.", "subsystem.", "subcircuits.", "connectors.signal_tunnel"];
function signalOnly(manifest: Json): Json {
  const components = (Array.isArray(manifest.components) ? manifest.components as Json[] : [])
    .filter((component) => typeof component.typeId === "string" && SIGNAL_PREFIXES.some((prefix) => (component.typeId as string).startsWith(prefix)));
  const ids = new Set(components.map((component) => component.id));
  const topology = (manifest.topology ?? { revision: 0, nodes: [], conductors: [] }) as Json;
  const conductors = (Array.isArray(topology.conductors) ? topology.conductors as Json[] : []).filter((conductor) => {
    const from = conductor.from as Json, to = conductor.to as Json;
    return from.kind === "port" && to.kind === "port" && ids.has(from.componentId) && ids.has(to.componentId);
  });
  return { ...manifest, components, topology: { revision: 0, nodes: [], conductors } };
}

function asSystem(document: Json, typeId: string): { definitions: Json[]; main: Json } {
  const components = Array.isArray(document.components) ? document.components as SubsystemComponentLike[] : [];
  const hoisted = hoistEmbeddedSubsystems(components, manifestSubsystems(document));
  const tankMigrated = migrateLegacyTankBlocks(hoisted.components as unknown as ProjectComponent[]).components as unknown as Json[];
  const table = hoisted.table.map((definition) => signalOnly({
    ...definition, components: migrateLegacyTankBlocks((definition.components ?? []) as unknown as ProjectComponent[]).components,
  }) as unknown as typeof definition);
  const main = signalOnly({ ...document, schemaVersion: 3, typeId, components: tankMigrated, interface: document.interface ?? [], subsystems: table });
  const flat = flattenExternalSystem(main);
  return { definitions: flat.definitions as Json[], main: flat.main as Json };
}

function targetsOf(file: string, original: Json): Target[] {
  const isProject = file.endsWith(".lsproj");
  const baseType = isProject ? `validation.${path.basename(file, ".lsproj").replace(/[^a-zA-Z0-9_]/g, "_")}` : String(original.typeId);
  const migrated = migrateControlDocument(original, { librarySnapshot: LEGACY_LIBRARY_EXPORTS }).document;
  const targets: Target[] = [];
  const add = (diagram: string, legacyDoc: Json, currentDoc: Json, typeId: string) => {
    const blocks = (Array.isArray(legacyDoc.components) ? legacyDoc.components as Json[] : [])
      .filter((component) => isLegacy(component.typeId) && typeof component.id === "string")
      .map((component) => ({ id: component.id as string, typeId: component.typeId as string, conversion: convertLegacyBlock(component.id as string, component.typeId as string, (component.properties ?? {}) as Json) }))
      .filter((block) => block.conversion.kind !== "keep");
    if (blocks.length === 0) return;
    targets.push({ file, diagram, legacy: asSystem(legacyDoc, typeId), current: asSystem(currentDoc, typeId), blocks });
  };
  add("principal", original, migrated, baseType);
  // Definições internas: cada uma vira um alvo próprio, instanciada sozinha (com a tabela do arquivo).
  const originalTable = manifestSubsystems(original);
  const migratedTable = manifestSubsystems(migrated);
  for (const definition of originalTable) {
    const after = migratedTable.find((entry) => entry.typeId === definition.typeId);
    if (!after) continue;
    add(`subsystems/${definition.typeId}`, { ...definition, subsystems: originalTable }, { ...after, subsystems: migratedTable }, `${baseType}.${definition.typeId.replace(/[^a-zA-Z0-9_]/g, "_")}`);
  }
  return targets;
}

// ------------------------------------------------------------------ execução

interface Run {
  error?: string;
  channels: Record<string, { t: number[]; v: number[] }>;
}

class CoreSession {
  readonly client: CoreClient;
  private readonly process: CoreProcess;
  private readonly directory: string;
  private serial = 0;

  constructor(readonly label: string, executable: string) {
    const pipeName = `lasecsimul-validate-${label}-${process.pid}-${Date.now()}`;
    this.process = new CoreProcess({ executablePath: executable, pipeName });
    this.client = new CoreClient(pipeName, { requestTimeoutMs: 120_000 });
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), `lasecsimul-validate-${label}-`));
  }
  async start() { this.process.start(); await this.client.start(); }
  async stop() { await this.client.stop().catch(() => undefined); this.process.kill(); }

  async register(manifest: Json): Promise<void> {
    const file = path.join(this.directory, `m${++this.serial}.lssubcircuit`);
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    await this.client.registerAdhocSubcircuit(file, { replace: true });
  }
}

/** Estímulo determinístico nas entradas expostas: 0 -> 1 -> 10 -> 0.5 em quartos do tempo. */
const STIMULUS = [0, 1, 10, 0.5];

async function runTarget(session: CoreSession, system: { definitions: Json[]; main: Json }, target: Target, side: "legacy" | "current"): Promise<Run> {
  const client = session.client;
  const run: Run = { channels: {} };
  const channels: Array<{ key: string; channel: SeriesChannel }> = [];
  try {
    for (const definition of system.definitions) await session.register(definition);
    await session.register(system.main);
    const instance = await client.addComponent(String(system.main.typeId), {}, [], "alvo");
    const sources: string[] = [];
    for (const [pin, exposed] of Object.entries(instance.exposedSignalPins ?? {})) {
      const iface = (system.main.interface as Json[] | undefined)?.find((entry) => entry.pinId === pin);
      if (iface?.direction !== "in") continue;
      const constant = await client.addComponent("control.constant", { value: STIMULUS[0] }, [{ id: "out", x: 0, y: 0 }], `estimulo_${pin}`);
      await client.applyWireTopologyTransaction([{ kind: "connect", from: { componentId: constant.instanceId, pinId: "out" }, to: { componentId: exposed.instanceId, pinId: exposed.pinId } }]);
      sources.push(constant.instanceId);
    }
    for (const [pin, exposed] of Object.entries(instance.exposedSignalPins ?? {})) {
      const iface = (system.main.interface as Json[] | undefined)?.find((entry) => entry.pinId === pin);
      if (iface?.direction === "out") channels.push({ key: `saida:${pin}`, channel: { instanceId: exposed.instanceId, port: exposed.pinId } });
    }
    for (const block of target.blocks) {
      try {
        const child = await client.getSubcircuitChildInstanceId(instance.instanceId, block.id);
        if (side === "legacy") {
          const outputs = block.typeId === "control.accumulator"
            ? ["out", "inActual", "outActual", "overflow", "unmet", "cumIn", "cumOut", "cumOverflow", "cumUnmet", "cumSpill", "upperContactTime", "lowerContactTime"]
            : ["out"];
          outputs.forEach((port) => channels.push({ key: block.typeId === "control.accumulator" ? `bloco:${block.id}:${port}` : `bloco:${block.id}`, channel: { instanceId: child, port } }));
          continue;
        }
        const conversion = block.conversion;
        if (conversion.kind === "single" || conversion.kind === "inline") {
          const out = conversion.outputs.out;
          if (out) channels.push({ key: `bloco:${block.id}`, channel: { instanceId: await client.getSubcircuitChildInstanceId(instance.instanceId, out.componentId), port: out.port } });
        } else if (conversion.kind === "rename") {
          const outputs = block.typeId === "control.accumulator"
            ? ["out", "inActual", "outActual", "overflow", "unmet", "cumIn", "cumOut", "cumOverflow", "cumUnmet", "cumSpill", "upperContactTime", "lowerContactTime"]
            : ["out"];
          outputs.forEach((port) => channels.push({ key: `bloco:${block.id}:${port}`, channel: { instanceId: child, port } }));
        } else if (conversion.kind === "subsystem") {
          const feeding = conversion.definition.wires.find((wire) => wire.to.componentId === "out:out");
          if (feeding) channels.push({ key: `bloco:${block.id}`, channel: { instanceId: await client.getSubcircuitChildInstanceId(child, feeding.from.componentId), port: feeding.from.port } });
        }
      } catch {
        // Bloco sem saída "out" (Sonda) ou não instanciado: fora da comparação.
      }
    }
    if (channels.length === 0) return run;
    const subscription = await client.subscribeSeries(channels.map((entry) => entry.channel), { periodNs: gridNs, capacityRows: Math.ceil((seconds * 1e9) / gridNs) + 16 });
    const rows: { t: number[]; columns: number[][] } = { t: [], columns: channels.map(() => []) };
    let sinceSeq = 0, sinceEventSeq = 0;
    let generation: number | undefined;
    const drain = async () => {
      for (let guard = 0; guard < 10_000; guard++) {
        const frame = await client.getTelemetryFrame({ items: [], probes: [], series: [{ subscriptionId: subscription, generation, sinceSeq, sinceEventSeq, columns: channels.length }] });
        const chunk = frame.series.find((item) => item.subscriptionId === subscription);
        if (!chunk || chunk.missing) return;
        if (generation !== undefined && chunk.generation !== generation) { rows.t.length = 0; rows.columns.forEach((column) => (column.length = 0)); }
        generation = chunk.generation;
        rows.t.push(...chunk.tNs);
        chunk.columns.forEach((column, index) => rows.columns[index]!.push(...column.map((value) => (value === null ? NaN : value))));
        sinceSeq = chunk.toSeq;
        sinceEventSeq = chunk.nextEventSeq;
        if (!chunk.more) return;
      }
    };
    const quarter = Math.round((seconds * 1e9) / 4);
    for (let phase = 0; phase < 4; phase++) {
      if (phase > 0) for (const source of sources) await client.setProperty(source, "value", STIMULUS[phase]);
    // Alinha cada avanço tanto à grade de telemetria quanto aos sample hits discretos.
    // Períodos não alinhados podem deixar o solver contínuo tentando cruzar um hit (ex.: 25 ms
    // de grade com um bloco de 10 ms); usar o MDC produz uma grade comum para a integração.
    const properties = (target.legacy.main.components as Json[] | undefined) ?? [];
    const periods = properties.flatMap((block) => {
      const props = block.properties as Json | undefined;
      const period = props?.samplePeriodNs;
      return typeof period === "number" && Number.isSafeInteger(period) && period > 0 ? [period] : [];
    });
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    const gridAligned = periods.every((period) => gridNs % period === 0);
    const alignedStep = gridAligned ? gridNs : periods.reduce(gcd, gridNs);
    const adaptiveStep = Math.min(1000 * MS, Math.max(gridNs, Math.floor((seconds * 1e9) / 400)));
    const stepNs = periods.length > 0 ? alignedStep : adaptiveStep;
    for (let done = 0; done < quarter; done += stepNs) {
        if (process.env.CONTROL_MIGRATION_TRACE === "1") console.log(`[trace] ${target.file} ${side} phase=${phase} t=${done}/${quarter} before-step`);
        await client.step(Math.min(stepNs, quarter - done));
        if (process.env.CONTROL_MIGRATION_TRACE === "1") console.log(`[trace] ${target.file} ${side} phase=${phase} t=${done}/${quarter} after-step`);
        await drain();
      }
    }
    await drain();
    const gridIndices = rows.t.map((time, index) => ({ time, index })).filter(({ time }) => time % gridNs === 0);
    channels.forEach((entry, index) => {
      run.channels[entry.key] = { t: gridIndices.map(({ time }) => time), v: gridIndices.map(({ index: row }) => rows.columns[index]![row]!) };
    });
  } catch (error) {
    run.error = `${error instanceof Error ? error.message : String(error)} (channels: ${channels.map((item) => `${item.key}=${item.channel.instanceId}.${item.channel.port}`).join(", ")})`;
  }
  return run;
}

// ------------------------------------------------------------------ métricas

export interface ChannelComparison {
  channel: string;
  samples: number;
  unmatchedSamples: number;
  mismatchedNonFinite: number;
  range: number;
  maxAbs: number;
  maxRelToRange: number;
  rmse: number;
  nrmse: number;
  /** Maior deslocamento (s) entre eventos (variação > 5% da faixa entre amostras) casados. */
  eventShiftS: number;
  eventCount: number;
  eventCountAfter: number;
  firstSamples: Array<{ t: number; before: number; after: number }>;
  mismatchSamples: Array<{ t: number; before: number; after: number }>;
  verdict: "identico" | "equivalente" | "divergente";
}

export function compareSeries(channel: string, before: { t: number[]; v: number[] }, after: { t: number[]; v: number[] }): ChannelComparison {
  const byTime = new Map(after.t.map((t, i) => [t, after.v[i]!]));
  const pairs: Array<[number, number, number]> = [];
  let unmatchedSamples = 0;
  before.t.forEach((t, i) => { if (!byTime.has(t)) { unmatchedSamples++; return; } pairs.push([t, before.v[i]!, byTime.get(t)!]); });
  unmatchedSamples += after.t.filter((t) => !before.t.includes(t)).length;
  const finite = pairs.flatMap(([, a, b]) => [a, b]).filter(Number.isFinite);
  const minimum = finite.length ? Math.min(...finite) : 0, maximum = finite.length ? Math.max(...finite) : 0;
  const range = finite.length > 0 ? Math.max(maximum - minimum, Math.abs(maximum), Math.abs(minimum), 1e-12) : 1;
  let maxAbs = 0, sumSq = 0, mismatchedNonFinite = 0;
  for (const [, a, b] of pairs) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) { if (!(Number.isNaN(a) && Number.isNaN(b)) && a !== b) mismatchedNonFinite++; continue; }
    const e = Math.abs(a - b);
    maxAbs = Math.max(maxAbs, e);
    sumSq += e * e;
  }
  const rmse = pairs.length > 0 ? Math.sqrt(sumSq / pairs.length) : 0;
  const events = (series: Array<[number, number]>) => {
    const list: number[] = [];
    for (let i = 1; i < series.length; i++) if (Math.abs(series[i]![1] - series[i - 1]![1]) > 0.05 * range) list.push(series[i]![0]);
    return list;
  };
  const eventsBefore = events(pairs.map(([t, a]) => [t, a])), eventsAfter = events(pairs.map(([t, , b]) => [t, b]));
  let eventShiftS = 0;
  for (const t of eventsBefore) {
    const nearest = eventsAfter.reduce((best, u) => (Math.abs(u - t) < Math.abs(best - t) ? u : best), Number.POSITIVE_INFINITY);
    eventShiftS = Math.max(eventShiftS, Number.isFinite(nearest) ? Math.abs(nearest - t) / 1e9 : Number.POSITIVE_INFINITY);
  }
  if (eventsAfter.length !== eventsBefore.length) eventShiftS = Math.max(eventShiftS, Number.POSITIVE_INFINITY);
  const nrmse = rmse / range;
  const maxRelToRange = maxAbs / range;
  const verdict = mismatchedNonFinite > 0 || unmatchedSamples > 0 || pairs.length === 0 || !Number.isFinite(eventShiftS) ? "divergente" : maxAbs === 0 ? "identico" : nrmse <= 1e-3 && maxRelToRange <= 1e-2 ? "equivalente" : "divergente";
  return { channel, samples: pairs.length, unmatchedSamples, mismatchedNonFinite, range, maxAbs, maxRelToRange, rmse, nrmse, eventShiftS, eventCount: eventsBefore.length, eventCountAfter: eventsAfter.length, firstSamples: pairs.slice(0, 12).map(([t, beforeValue, afterValue]) => ({ t, before: beforeValue, after: afterValue })), mismatchSamples: pairs.filter(([, a, b]) => !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > 1e-10).slice(0, 16).map(([t, beforeValue, afterValue]) => ({ t, before: beforeValue, after: afterValue })), verdict };
}

// ------------------------------------------------------------------ principal

function legacyFiles(): string[] {
  const tracked = git("ls-tree", "-r", "--name-only", REVISION).split("\n").filter((file) => /\.(lsproj|lssubcircuit)$/.test(file));
  return tracked.filter((file) => {
    const text = git("show", `${REVISION}:${file}`);
    return /"typeId":\s*"control\./.test(text) && (!only || file.includes(only)) && !skips.some((skip) => file.includes(skip));
  });
}

(async () => {
  const files = legacyFiles();
  const results: Json[] = [];
  const previous = append && fs.existsSync(outFile) ? parse(fs.readFileSync(outFile, "utf8")) : {};
  const combined = new Map<string, Json>();
  for (const result of Array.isArray(previous.results) ? previous.results as Json[] : []) combined.set(`${result.file}|${result.diagram}`, result);
  const persistResults = () => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify({ ...previous, revisionBefore: REVISION, legacyExe: path.relative(repoRoot, legacyExe), currentExe: path.relative(repoRoot, currentExe), seconds, gridMs: gridNs / MS, stimulus: STIMULUS, generatedAt: new Date().toISOString(), results: [...combined.values()] }, null, 1)}\n`);
  };
  const isolated = async (label: string, executable: string, body: (session: CoreSession) => Promise<Run>): Promise<Run> => {
    const session = new CoreSession(label, executable);
    try {
      await session.start();
      return await body(session);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), channels: {} };
    } finally {
      await session.stop();
    }
  };
  {
    for (const file of files) {
      const original = parse(git("show", `${REVISION}:${file}`));
      for (const target of targetsOf(file, original)) {
        // Cada alvo em Cores novos: registros e estado isolados entre alvos.
        const legacyRun = await isolated("antes", legacyExe, (session) => runTarget(session, target.legacy, target, "legacy"));
        const currentRun = await isolated("depois", currentExe, (session) => runTarget(session, target.current, target, "current"));
        const legacyKeys = Object.keys(legacyRun.channels), currentKeys = Object.keys(currentRun.channels);
        const missingChannels = legacyKeys.filter((key) => !currentRun.channels[key]);
        const extraChannels = currentKeys.filter((key) => !legacyRun.channels[key]);
        const comparisons = legacyKeys.filter((key) => currentRun.channels[key])
          .map((key) => compareSeries(key, legacyRun.channels[key]!, currentRun.channels[key]!));
        // Trace do bloco interno é diagnóstico; o veredito do diagrama usa primeiro as saídas expostas
        // (a interface observável por projetos que instanciam o subsistema). Sem saídas expostas,
        // todos os blocos instrumentados continuam sendo o critério.
        const judged = comparisons.some((c) => c.channel.startsWith("saida:")) ? comparisons.filter((c) => c.channel.startsWith("saida:")) : comparisons;
        const verdict = legacyRun.error || currentRun.error ? "erro" : missingChannels.some((key) => key.startsWith("saida:")) || extraChannels.some((key) => key.startsWith("saida:")) || judged.some((c) => c.verdict === "divergente") ? "divergente" : judged.every((c) => c.verdict === "identico") ? "identico" : "equivalente";
        const result = { file, diagram: target.diagram, seconds, gridMs: gridNs / MS, verdict, legacyError: legacyRun.error, currentError: currentRun.error, missingChannels, extraChannels, comparisons };
        results.push(result);
        combined.set(`${file}|${target.diagram}`, result);
        persistResults();
        console.log(`${verdict.padEnd(11)} ${file} :: ${target.diagram} (${comparisons.length} sinais)${legacyRun.error ? ` [antes: ${legacyRun.error}]` : ""}${currentRun.error ? ` [depois: ${currentRun.error}]` : ""}`);
      }
    }
  }
  const finalResults = [...combined.values()];
  persistResults();
  const count = (verdict: string) => finalResults.filter((result) => result.verdict === verdict).length;
  console.log(`\n${finalResults.length} diagramas: ${count("identico")} identicos, ${count("equivalente")} equivalentes, ${count("divergente")} divergentes, ${count("erro")} com erro -> ${outFile}`);
})().catch((error) => { console.error(error); process.exit(1); });

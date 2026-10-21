import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert, createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import { convertLegacyBlock } from "./conversions";
import { convertLegacyExpression, evaluateLegacyAst, parseLegacyExpression } from "./legacyExpression";
import { LEGACY_CONTROL_TYPE_IDS, LEGACY_WRAPPER_STAGE, legacyInputPorts } from "./legacyBlocks";
import { LEGACY_LIBRARY_EXPORTS } from "./legacyLibraryExports";
import { migrateControlDocument, needsControlMigration } from "./migrateDocument";
import { backupOriginal, persistDocumentMigration, writeMigrationReport } from "./migrationFiles";
import { ProjectSerializer } from "../../project/ProjectSerializer";
import { createHash } from "crypto";

/**
 * Migração dos blocos legados `control.*` (docs/68-69): conversor de expressões, regras por bloco,
 * migração de documento (portas, subsistemas, overrides), determinismo e idempotência, e a varredura
 * de TODOS os arquivos de projeto do repositório.
 */
const { test, finish } = createTestRunner("Migracao da biblioteca de controle");
const extensionRoot = path.resolve(__dirname, "..", "..", "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
type Json = Record<string, unknown>;

/** Arquivos de projeto do repositório (mesmo critério do inventário docs/69). */
function projectFiles(): string[] {
  const skip = new Set(["node_modules", ".git", "dist", "out", "out-test", "external-research", ".vscode-test", "tools", "_deps"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || entry.name.startsWith("build")) continue;
        walk(path.join(dir, entry.name));
      } else if (/\.(lsproj|lssubcircuit)$/.test(entry.name)) files.push(path.join(dir, entry.name));
    }
  };
  walk(repoRoot);
  return files.sort();
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as Json;

/** Todas as expressões legadas gravadas (com as entradas declaradas do bloco). */
function storedExpressions(): Array<{ file: string; id: string; expression: string; inputs: string[] }> {
  const result: Array<{ file: string; id: string; expression: string; inputs: string[] }> = [];
  for (const file of projectFiles()) {
    const visit = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (typeof node !== "object" || node === null) return;
      const record = node as Json;
      if (record.typeId === "control.calc_expression" && typeof record.properties === "object" && record.properties !== null) {
        const properties = record.properties as Json;
        if (typeof properties.expression === "string")
          result.push({ file: path.relative(repoRoot, file), id: String(record.id), expression: properties.expression, inputs: legacyInputPorts("control.calc_expression", properties) });
      }
      for (const value of Object.values(record)) visit(value);
    };
    visit(readJson(file));
  }
  return result;
}

(async () => {
  await test("expressao legada: precedencia legada preservada com parenteses do Fcn", () => {
    const cases: Array<[string, string[], string]> = [
      ["-x^2", ["x"], "(-u(1))^2"],
      ["a^b^c", ["a", "b", "c"], "u(1)^(u(2)^u(3))"],
      ["a-b-c", ["a", "b", "c"], "u(1) - u(2) - u(3)"],
      ["a-(b-c)", ["a", "b", "c"], "u(1) - (u(2) - u(3))"],
      ["x^-y", ["x", "y"], "u(1)^(-u(2))"],
      ["(m<0.5)*qo+(m>0.5)*(m<1.5)*k", ["m", "qo", "k"], "(u(1) < 0.5)*u(2) + (u(1) > 0.5)*(u(1) < 1.5)*u(3)"],
      ["a > b > c", ["a", "b", "c"], "u(1) > u(2) > u(3)"],
      ["2*-x", ["x"], "2*-u(1)"],
      ["x0*15*(1+(8790/x1/x2))^(-5.01625)", ["x0", "x1", "x2"], "u(1)*15*(1 + 8790/u(2)/u(3))^(-5.01625)"],
      ["1.5e-3*x", ["x"], "0.0015*u(1)"],
    ];
    for (const [legacy, inputs, expected] of cases) {
      const actual = convertLegacyExpression(legacy, inputs);
      assert(actual === expected, `${legacy} -> ${actual} (esperado ${expected})`);
    }
    for (const [bad, inputs] of [["x +", ["x"]], ["y", ["x"]], ["(x", ["x"]], ["x\ny", ["x", "y"]], ["sin(x)", ["x"]]] as Array<[string, string[]]>) {
      let threw = false;
      try { convertLegacyExpression(bad, inputs); } catch { threw = true; }
      assert(threw, `expressao invalida recusada como no Core legado: ${JSON.stringify(bad)}`);
    }
  });

  await test("todas as expressoes gravadas no repositorio convertem; fixture de equivalencia para o Core", () => {
    const expressions = storedExpressions();
    assert(expressions.length >= 400, `expressoes encontradas: ${expressions.length}`);
    const fixture: Array<{ expression: string; inputs: string[]; fcn: string; samples: number[][]; legacy: number[] }> = [];
    const seen = new Set<string>();
    let seed = 12345;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (const item of expressions) {
      const fcn = convertLegacyExpression(item.expression, item.inputs);
      const key = `${item.expression}\u0000${item.inputs.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ast = parseLegacyExpression(item.expression, item.inputs);
      // Amostras: valores típicos de processo, negativos, zero e frações (cobre comparações e potências).
      const samples: number[][] = [];
      for (let k = 0; k < 6; k++) samples.push(item.inputs.map(() => (k === 0 ? 0 : k === 1 ? 1 : (random() - 0.3) * Math.pow(10, Math.floor(random() * 5) - 1))));
      fixture.push({ expression: item.expression, inputs: item.inputs, fcn, samples, legacy: samples.map((u) => evaluateLegacyAst(ast, u)) });
    }
    const out = path.join(repoRoot, "test", "fixtures", "block-library", "calc-expression-conversions.json");
    const body = `${JSON.stringify({ note: "Gerado por migration.test.ts: expressao legada, conversao Fcn e valores do interpretador legado (TS) para o teste do Core comparar CalcExpression x Fcn.", cases: fixture }, null, 1)}\n`;
    if (!fs.existsSync(out) || fs.readFileSync(out, "utf8") !== body) fs.writeFileSync(out, body);
    assert(fixture.length > 50, `expressoes distintas: ${fixture.length}`);
  });

  await test("cada tipo legado tem regra (ou motivo documentado)", () => {
    for (const typeId of LEGACY_CONTROL_TYPE_IDS) {
      const conversion = convertLegacyBlock("b", typeId, typeId === "control.calc_expression" ? { expression: "in" } : {});
      assert(conversion.kind !== "unsupported", `${typeId}: ${conversion.rule}`);
    }
    const tf = convertLegacyBlock("fo", "control.first_order", { gain: 2, tau: 5, initial: 0 });
    assert(tf.kind === "single" && tf.blocks[0]!.typeId === "sl.discrete_transfer_fcn" && tf.blocks[0]!.properties.Numerator === `[${2 * (1 - Math.exp(-0.1 / 5))}]` && tf.blocks[0]!.properties.Denominator === `[1 ${-Math.exp(-0.1 / 5)}]` && tf.blocks[0]!.properties.SampleTime === "0.1", JSON.stringify(tf));
    const ss = convertLegacyBlock("fo", "control.first_order", { gain: 2, tau: 5, initial: 1 });
    assert(ss.kind === "single" && ss.blocks[0]!.typeId === "sl.discrete_transfer_fcn" && ss.blocks[0]!.properties.InitialStates === "1", JSON.stringify(ss));
    const fopdt = convertLegacyBlock("p", "control.fopdt", { gain: 1, tau: 2, delay: 0.5 });
    assert(fopdt.kind === "inline" && fopdt.blocks[0]!.id === "p__delay" && fopdt.blocks[0]!.typeId === "sl.transport_delay" && fopdt.blocks[0]!.properties.DelayTime === "0.5" && fopdt.blocks[1]!.id === "p" && fopdt.blocks[1]!.typeId === "sl.discrete_transfer_fcn" && fopdt.inputs.in!.componentId === "p__delay", JSON.stringify(fopdt));
    const valve = convertLegacyBlock("v", "control.valve_characteristic", { coefficient: 2, exponent: 1.5, samplePeriodNs: 20_000_000 });
    assert(valve.kind === "single" && valve.blocks[0]!.typeId === "sl.fcn" && valve.blocks[0]!.properties.SampleTime === "0.02" && valve.blocks[0]!.properties.Expr === "2*((u(1)+abs(u(1)))/2)^1.5", "característica de válvula preserva a cadência discreta e os parâmetros");
    const derivative = convertLegacyBlock("d", "control.filtered_derivative", { gain: 2, filterTau: 0.5, initial: 1, samplePeriodNs: 20_000_000 });
    assert(derivative.kind === "inline" && derivative.blocks[0]!.typeId === "sl.state_space" && derivative.blocks[1]!.typeId === "sl.unit_delay" && derivative.blocks[1]!.properties.SampleTime === "0.02", "derivada preserva o filtro contínuo e a fase de publicação da saída");
    const secondOrder = convertLegacyBlock("so", "control.second_order", { gain: 2, omega: 3, zeta: 0.7, samplePeriodNs: 20_000_000 });
    assert(secondOrder.kind === "inline" && secondOrder.blocks[0]!.typeId === "sl.state_space" && secondOrder.blocks[1]!.typeId === "sl.unit_delay" && secondOrder.blocks[1]!.properties.SampleTime === "0.02", "segunda ordem preserva estado contínuo e fase de publicação legada");
    const rateLimiter = convertLegacyBlock("rl", "control.rate_limiter", { riseRate: 2, fallRate: 3, initial: 1, samplePeriodNs: 20_000_000 });
    assert(rateLimiter.kind === "subsystem" && rateLimiter.definition.blocks.some((block) => block.id === "limiter" && block.typeId === "sl.rate_limiter") && rateLimiter.definition.blocks.some((block) => block.id === "sampled_input" && block.typeId === "sl.unit_delay" && block.properties.SampleTime === "0.02") && rateLimiter.overrides["@limiter.InitialCondition"] === "1" && rateLimiter.definition.blocks.length === 2, "limitador de taxa preserva a fase amostrada e a condição inicial legada");
    const sum = convertLegacyBlock("s", "control.sum", { inputs: ["a", "b", "c"] });
    assert(sum.kind === "single" && sum.inputs.c!.port === "in3" && sum.blocks[0]!.properties.Inputs === "+++", JSON.stringify(sum));
    const calc = convertLegacyBlock("c", "control.calc_expression", { inputs: ["x", "y"], expression: "x*y", upperLimitEnabled: true, upperLimit: 3 });
    assert(calc.kind === "inline" && calc.blocks.map((b) => b.typeId).join(",") === "sl.mux,sl.fcn,sl.saturation" && calc.outputs.out!.componentId === "c", JSON.stringify(calc));
    assert(convertLegacyBlock("k", "control.constant", { value: 3 }).kind === "keep", "constante de modelo mantida");
    assert(convertLegacyBlock("a", "control.accumulator", {}).kind === "rename", "acumulador renomeado para process.accumulator");
    const station = convertLegacyBlock("station", "control.pid_station", { samplePeriodNs: 100_000_000, kc: 3, ti: 0.8, td: 0.2, manualOutput: 140 });
    assert(station.kind === "subsystem" && station.definition.inputs.map((pin) => pin.pinId).join(",") === "sp,pv,am,lr", "estação PID migra como subsistema com os quatro sinais de entrada");
    assert(station.kind === "subsystem" && station.definition.blocks.some((block) => block.typeId === "sl.discrete_pid_controller_2dof") && station.definition.blocks.some((block) => block.typeId === "sl.zero_order_hold"), "estação PID usa controlador 2DOF e amostra AM/LR");
    assert(station.kind === "subsystem" && station.overrides["@manual_output.Value"] === "100" && station.definition.blocks.find((block) => block.id === "pid")!.properties.ExternalReset === "either", "saída manual respeita saturação e mantém reset manual/automático sem salto");
    const observer = convertLegacyBlock("obs", "control.observer", {});
    assert(observer.kind === "single" && observer.blocks[0]!.id === "obs" && observer.blocks[0]!.typeId === "sl.gain" && observer.outputs.out!.port === "out1", "observador preserva o sinal e evita uma conexão inválida a sl.display");
  });

  await test("documento: portas remapeadas, ids preservados, composição dinâmica e idempotente", () => {
    const document: Json = {
      schemaVersion: 2,
      components: [
        { id: "k", typeId: "control.constant", properties: { value: 1 }, visual: { x: 0, y: 0, rotation: 0 } },
        { id: "g", typeId: "control.gain", label: "Ganho", properties: { gain: 3 }, visual: { x: 100, y: 0, rotation: 0 } },
        { id: "p1", typeId: "control.fopdt", properties: { gain: 1, tau: 2, delay: 0.5 }, visual: { x: 200, y: 0, rotation: 0 } },
        { id: "p2", typeId: "control.fopdt", properties: { gain: 4, tau: 1, delay: 0.1 }, visual: { x: 300, y: 0, rotation: 0 } },
        { id: "c", typeId: "control.calc_expression", properties: { inputs: ["a", "b"], expression: "a-b" }, visual: { x: 400, y: 0, rotation: 0 } },
      ],
      topology: {
        revision: 3, nodes: [],
        conductors: [
          { id: "w1", from: { kind: "port", componentId: "k", pinId: "out" }, to: { kind: "port", componentId: "g", pinId: "in" }, vertices: [] },
          { id: "w2", from: { kind: "port", componentId: "g", pinId: "out" }, to: { kind: "port", componentId: "p1", pinId: "in" }, vertices: [] },
          { id: "w3", from: { kind: "port", componentId: "p1", pinId: "out" }, to: { kind: "port", componentId: "c", pinId: "a" }, vertices: [] },
          { id: "w4", from: { kind: "port", componentId: "p2", pinId: "out" }, to: { kind: "port", componentId: "c", pinId: "b" }, vertices: [] },
        ],
      },
    };
    const { document: migrated, report } = migrateControlDocument(document);
    assert(report.changed, "mudou");
    assert(JSON.stringify(document).includes("control.gain"), "original intacto");
    const components = migrated.components as Json[];
    const byId = new Map(components.map((c) => [c.id, c]));
    assert(byId.get("g")!.typeId === "sl.gain" && byId.get("g")!.label === "Ganho", "ganho mantem id e rotulo");
    assert(byId.get("p1")!.typeId === "sl.discrete_transfer_fcn" && byId.get("p2")!.typeId === "sl.discrete_transfer_fcn", "FOPDT preserva o bloco de planta sob o ID legado");
    assert(components.some((component) => component.id === "p1__delay" && component.typeId === "sl.transport_delay") && components.some((component) => component.id === "p2__delay" && component.typeId === "sl.transport_delay"), "cada FOPDT ganha seu atraso explícito no mesmo diagrama");
    assert((components.find((component) => component.id === "p2__delay")!.properties as Json).DelayTime === "0.1" && (migrated.subsystems as Json[] | undefined ?? []).length === 0, "atrasos por instância não dependem de override aninhado");
    const conductors = (migrated.topology as Json).conductors as Json[];
    const w1 = conductors.find((w) => w.id === "w1")! as { from: Json; to: Json };
    assert(w1.from.pinId === "out" && w1.to.pinId === "in1", `constante mantida (out), ganho in1: ${JSON.stringify(w1)}`);
    const w3 = conductors.find((w) => w.id === "w3")! as { from: Json; to: Json };
    assert(w3.from.pinId === "out1" && w3.to.componentId === "c__mux" && w3.to.pinId === "in1", `FOPDT inline mantem a porta out1; calc via Mux: ${JSON.stringify(w3)}`);
    assert(conductors.some((w) => w.id === "c__w1"), "fio Mux -> Fcn criado");
    const again = migrateControlDocument(migrated);
    assert(!again.report.changed && JSON.stringify(again.document) === JSON.stringify(migrated), "segunda passada nao muda nada (idempotente)");
    const repeat = migrateControlDocument(document);
    assert(JSON.stringify(repeat.document) === JSON.stringify(migrated), "deterministica");
  });

  await test("wrappers antigos subcircuits.control.* migram para blocos sl.* antes de salvar", () => {
    const document: Json = {
      schemaVersion: 2,
      components: [
        { id: "legacyGain", typeId: "subcircuits.control.gain", properties: { "@stage.gain": 4 } },
        { id: "sink", typeId: "sl.scope", properties: {} },
      ],
      topology: { revision: 0, nodes: [], conductors: [{ id: "w", from: { componentId: "legacyGain", pinId: "out" }, to: { componentId: "sink", pinId: "in1" }, vertices: [] }] },
    };
    const { document: migrated, report } = migrateControlDocument(document, { librarySnapshot: LEGACY_LIBRARY_EXPORTS });
    const gain = (migrated.components as Json[]).find((component) => component.id === "legacyGain")!;
    assert(report.changed && gain.typeId === "sl.gain", `wrapper removido do projeto: ${String(gain.typeId)}`);
    assert((gain.properties as Json).Gain === "4", `override preservado: ${JSON.stringify(gain.properties)}`);
    const wire = ((migrated.topology as Json).conductors as Json[])[0]! as Json;
    assert((wire.from as Json).pinId === "out1" && (wire.to as Json).pinId === "in1", "portas do wrapper remapeadas para as portas reais Simulink");
    assert(!needsControlMigration(migrated), "documento migrado nao pede nova migracao");
  });

  await test("os 24 wrappers antigos migram e deixam de exigir manifestos de biblioteca", () => {
    const wrappers = Object.keys(LEGACY_WRAPPER_STAGE);
    assert(wrappers.length === 24, `tabela de migração deve cobrir 24 wrappers: ${wrappers.length}`);
    const document: Json = { schemaVersion: 2, components: wrappers.map((slug, index) => ({
      id: `old_${slug}`, typeId: `subcircuits.control.${slug}`, properties: {}, subcircuitRef: { libraryPath: `control_${slug}.lssubcircuit` },
      visual: { x: index * 20, y: 0, rotation: 0 },
    })), topology: { revision: 0, nodes: [], conductors: [] } };
    const { document: migrated, report } = migrateControlDocument(document, { librarySnapshot: LEGACY_LIBRARY_EXPORTS });
    const components = migrated.components as Json[];
    assert(report.changed && components.length >= wrappers.length, "todos os wrappers devem ser convertidos sem perder instâncias");
    assert(!components.some((component) => String(component.typeId).startsWith("subcircuits.control.")), "nenhum wrapper antigo permanece no projeto salvo");
    assert(components.filter((component) => component.subcircuitRef !== undefined).length === 0, "refs de biblioteca antigas são removidas");
    assert(!needsControlMigration(migrated), "migração completa e idempotente");
  });

  await test("overrides de wrappers antigos dentro de subsistemas acompanham a conversao do filho", () => {
    const document: Json = {
      schemaVersion: 2,
      subsystems: [{ schemaVersion: 3, typeId: "subsystem.old_model", name: "Modelo", components: [
        { id: "g", typeId: "subcircuits.control.gain", properties: { "@stage.gain": 2 } },
      ], topology: { revision: 0, nodes: [], conductors: [] }, interface: [], exportedPropertyComponentIds: ["g"] }],
      components: [{ id: "M", typeId: "subsystem.old_model", properties: { "@g.gain": 8 } }],
      topology: { revision: 0, nodes: [], conductors: [] },
    };
    const { document: migrated, report } = migrateControlDocument(document, { librarySnapshot: LEGACY_LIBRARY_EXPORTS });
    const model = (migrated.subsystems as Json[])[0]!;
    const child = (model.components as Json[])[0]!;
    const instance = (migrated.components as Json[])[0]!;
    assert(child.typeId === "sl.gain", `filho migrado: ${String(child.typeId)}`);
    assert((instance.properties as Json)["@g.Gain"] === "8" && (instance.properties as Json)["@g.gain"] === undefined,
      `override acompanha o parâmetro Simulink: ${JSON.stringify(instance.properties)}`);
    assert(report.overrides.length === 1, "remapeamento relatado");
  });

  await test("overrides por instancia (@filho.prop) remapeados pela definicao legada", () => {
    const document: Json = {
      schemaVersion: 2,
      subsystems: [{ schemaVersion: 3, typeId: "subsystem.lab", name: "Lab", components: [{ id: "fo", typeId: "control.first_order", properties: { gain: 2, tau: 5, initial: 0 } }], topology: { revision: 0, nodes: [], conductors: [] }, interface: [], exportedPropertyComponentIds: ["fo"] }],
      components: [{ id: "x", typeId: "subsystem.lab", properties: { "@fo.tau": 3 } }],
      topology: { revision: 0, nodes: [], conductors: [] },
    };
    const { document: migrated, report } = migrateControlDocument(document);
    const props = ((migrated.components as Json[])[0]!.properties) as Json;
    assert(props["@fo.Denominator"] === `[1 ${-Math.exp(-0.1 / 3)}]` && props["@fo.Numerator"] === `[${2 * (1 - Math.exp(-0.1 / 3))}]` && props["@fo.SampleTime"] === "0.1" && props["@fo.tau"] === undefined, JSON.stringify(props));
    assert(report.overrides.length === 1, "remapeamento relatado");
    // Instância de subcircuito da BIBLIOTECA: usa o instantâneo congelado.
    const libraryType = Object.keys(LEGACY_LIBRARY_EXPORTS).find((typeId) => Object.values(LEGACY_LIBRARY_EXPORTS[typeId]!).some((child) => child.typeId === "control.first_order"));
    assert(libraryType !== undefined, "instantaneo contem um first_order exportado");
    const child = Object.entries(LEGACY_LIBRARY_EXPORTS[libraryType!]!).find(([, value]) => value.typeId === "control.first_order")![0];
    const legacyChild = LEGACY_LIBRARY_EXPORTS[libraryType!]![child]!;
    const libraryDoc: Json = { schemaVersion: 2, components: [{ id: "i", typeId: libraryType, properties: { [`@${child}.gain`]: 7 } }], topology: { revision: 0, nodes: [], conductors: [] } };
    const migratedLibrary = migrateControlDocument(libraryDoc, { librarySnapshot: LEGACY_LIBRARY_EXPORTS });
    const migratedComponent = (migratedLibrary.document.components as Json[])[0]!;
    assert(migratedComponent.typeId === "sl.discrete_transfer_fcn", `wrapper first_order substituido pelo bloco novo: ${String(migratedComponent.typeId)}`);
    const libraryProps = migratedComponent.properties as Json;
    const expectedLibraryConversion = convertLegacyBlock(child, legacyChild.typeId, { ...legacyChild.properties, gain: 7 });
    assert(expectedLibraryConversion.kind === "single" && libraryProps.Numerator === expectedLibraryConversion.blocks[0]!.properties.Numerator && libraryProps.Denominator === expectedLibraryConversion.blocks[0]!.properties.Denominator && libraryProps.SampleTime === expectedLibraryConversion.blocks[0]!.properties.SampleTime, JSON.stringify(libraryProps));
  });

  await test("varredura: todos os arquivos de projeto do repositorio migram, deterministicos e idempotentes", () => {
    let migratedFiles = 0;
    const pending = new Map<string, number>();
    for (const file of projectFiles()) {
      const original = readJson(file);
      if (!needsControlMigration(original)) continue;
      const first = migrateControlDocument(original, { librarySnapshot: LEGACY_LIBRARY_EXPORTS });
      const second = migrateControlDocument(first.document, { librarySnapshot: LEGACY_LIBRARY_EXPORTS });
      assert(!second.report.changed, `${path.relative(repoRoot, file)}: idempotente`);
      assert(JSON.stringify(migrateControlDocument(original, { librarySnapshot: LEGACY_LIBRARY_EXPORTS }).document) === JSON.stringify(first.document), `${path.relative(repoRoot, file)}: deterministica`);
      for (const entry of first.report.entries) if (entry.kind === "unsupported") pending.set(entry.legacyTypeId, (pending.get(entry.legacyTypeId) ?? 0) + 1);
      if (first.report.changed) migratedFiles++;
    }
    assert(migratedFiles > 50, `arquivos migrados: ${migratedFiles}`);
    assert(pending.size === 0, `projetos versionados nao devem conter conversoes recusadas: ${JSON.stringify([...pending])}`);
  });

  await test("abrir projeto legado: backup verificado, arquivo regravado, relatorio; reabrir nao migra de novo", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-migration-open-"));
    try {
      const source = path.join(repoRoot, "examples", "calculo", "primeira-ordem.lsproj");
      const projectPath = path.join(temp, "primeira-ordem.lsproj");
      // Original do git (o arquivo do repositório pode já estar migrado).
      const legacyText = fs.readFileSync(source, "utf8").includes("control.first_order")
        ? fs.readFileSync(source, "utf8")
        : JSON.stringify({ schemaVersion: 2, components: [{ id: "g", typeId: "control.gain", properties: { gain: 2 } }], topology: { revision: 0, nodes: [], conductors: [] }, visual: { viewport: { x: 0, y: 0, zoom: 1 } }, simulationSettings: {} });
      fs.writeFileSync(projectPath, legacyText);
      const serializer = new ProjectSerializer();
      const loaded = await serializer.loadWithMigration(projectPath);
      assert(loaded.controlMigration?.changed === true, "projeto legado migrado na abertura");
      const result = await persistDocumentMigration(projectPath, loaded.controlMigration!, () => serializer.save(projectPath, loaded.project));
      assert(fs.readFileSync(result.backupPath, "utf8") === legacyText, "backup identico ao original");
      assert(createHash("sha256").update(fs.readFileSync(result.backupPath)).digest("hex") === result.sha256, "hash do backup conferido");
      const report = JSON.parse(fs.readFileSync(result.reportPath, "utf8")) as Json;
      assert(report.migrationId === "control-library-simulink" && (report.summary as Json).converted as number > 0, JSON.stringify(report.summary));
      assert(!fs.readFileSync(projectPath, "utf8").includes("\"control.first_order\"") && !fs.readFileSync(projectPath, "utf8").includes("\"control.gain\""), "arquivo regravado no formato novo");
      const reopened = await serializer.loadWithMigration(projectPath);
      assert(reopened.controlMigration === undefined, "reabrir nao migra de novo (idempotente)");
      // Segunda migração do MESMO original não sobrescreve o backup existente.
      const again = await backupOriginal(projectPath, Buffer.from(legacyText));
      assert(again.backupPath === result.backupPath, "backup com mesmo conteudo reaproveitado, nunca sobrescrito");
      const different = await backupOriginal(projectPath, Buffer.from(`${legacyText} `));
      assert(different.backupPath !== result.backupPath && fs.existsSync(result.backupPath), "conteudo diferente ganha outro nome; o primeiro backup continua");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  void test("relatorio preserva id e versao da migracao depois de mesclar os detalhes", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-migration-report-"));
    try {
      const { document, report } = migrateControlDocument({ schemaVersion: 2, components: [], topology: { revision: 0, nodes: [], conductors: [] } });
      const backupPath = path.join(temp, `project.${report.migrationId}-v${report.version}.original.lsproj`);
      const reportPath = await writeMigrationReport(path.join(temp, "project.lsproj"), { backupPath, sha256: "test-hash" }, report, JSON.stringify(document));
      const saved = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Json;
      assert(saved.migrationId === report.migrationId && saved.version === report.version, JSON.stringify(saved));
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }).then(() => {
    const result = finish();
    if (result.failed > 0) process.exitCode = 1;
  });
})();

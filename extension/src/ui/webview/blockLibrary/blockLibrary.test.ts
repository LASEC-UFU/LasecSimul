import * as fs from "fs";
import * as path from "path";
import { assert, createTestRunner } from "../../../ipc/testSupport/MockCoreServer";
import { loadBlockLibrary } from "../../../catalog/blockLibraryLoader";
import { blockCatalogEntries } from "./blockCatalog";
import { blockPackage, polynomialMarkup } from "./blockSymbol";
import { evaluateParam, ParamValue } from "./paramExpr";
import { resolveBlockPorts } from "./ports";
import { BlockSpec, blockTypeId } from "./spec";

/**
 * Biblioteca de blocos equivalente ao Simulink (docs/66), lado Extension: o avaliador de parâmetros
 * e as regras de porta passam pelos MESMOS vetores que o Core (`param_expr_test`,
 * `library_block_session_test`); símbolo e catálogo gerados da especificação.
 */
const { test, finish } = createTestRunner("Biblioteca de blocos (Extension)");
const extensionRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const fixtures = path.join(repoRoot, "test", "fixtures", "block-library");
const library = loadBlockLibrary(extensionRoot);
const specs = new Map<string, BlockSpec>(library.flatMap((file) => file.blocks.map((spec) => [blockTypeId(spec), spec] as const)));

const expectedNumber = (value: number | string): number => (value === "Inf" ? Infinity : value === "-Inf" ? -Infinity : value === "NaN" ? Number.NaN : Number(value));
const sameNumber = (actual: number, expected: number) =>
  Number.isNaN(expected) ? Number.isNaN(actual) : !Number.isFinite(expected) ? actual === expected : Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected));

(async () => {
  await test("avaliador de parametros: vetores compartilhados com o Core", () => {
    const root = JSON.parse(fs.readFileSync(path.join(fixtures, "param-expr-vectors.json"), "utf8")) as {
      vectors: Array<{ expr: string; error?: boolean; rows?: number; cols?: number; value?: Array<number | string>; vars?: Record<string, { rows: number; cols: number; value: Array<number | string> }> }>;
    };
    for (const vector of root.vectors) {
      const workspace = new Map<string, ParamValue>(Object.entries(vector.vars ?? {}).map(([name, v]) => [name, { rows: v.rows, cols: v.cols, data: v.value.map(expectedNumber) }]));
      let result: ParamValue | undefined;
      let error: unknown;
      try { result = evaluateParam(vector.expr, workspace); } catch (e) { error = e; }
      if (vector.error) { assert(error !== undefined, `deveria recusar: ${JSON.stringify(vector.expr)}`); continue; }
      assert(result !== undefined, `erro inesperado em ${JSON.stringify(vector.expr)}: ${String(error)}`);
      assert(result!.rows === vector.rows && result!.cols === vector.cols, `dimensao de ${JSON.stringify(vector.expr)}: ${result!.rows}x${result!.cols}`);
      const expected = vector.value!.map(expectedNumber);
      assert(result!.data.length === expected.length && result!.data.every((x, i) => sameNumber(x, expected[i]!)), `valor de ${JSON.stringify(vector.expr)}: ${JSON.stringify(result!.data)}`);
    }
  });

  await test("regras de porta: casos compartilhados com o Core", () => {
    // Um arquivo `port-vectors*.json` por família de blocos; o Core lê os mesmos.
    const files = fs.readdirSync(fixtures).filter((name) => name.startsWith("port-vectors") && name.endsWith(".json")).sort();
    assert(files.length > 0, "arquivos de casos de porta existem");
    const cases = files.flatMap((name) => (JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8")) as {
      cases: Array<{ typeId: string; properties: Record<string, string | number | boolean>; inputs: string[]; outputs: string[] }>;
    }).cases);
    for (const item of cases) {
      const spec = specs.get(item.typeId);
      assert(spec !== undefined, `especificacao existe: ${item.typeId}`);
      const ports = resolveBlockPorts(spec!, item.properties);
      assert(JSON.stringify(ports.inputs.map((p) => p.id)) === JSON.stringify(item.inputs) && JSON.stringify(ports.outputs.map((p) => p.id)) === JSON.stringify(item.outputs),
        `portas de ${item.typeId} ${JSON.stringify(item.properties)}: ${JSON.stringify(ports)}`);
    }
  });

  await test("simbolo de cada bloco tem exatamente os pinos das portas resolvidas", () => {
    assert(specs.size >= 30, `especificacao carregada (${specs.size} blocos)`);
    for (const [typeId, spec] of specs) {
      const pkg = blockPackage(spec, {});
      const ports = resolveBlockPorts(spec, {});
      const expected = [...ports.inputs, ...ports.outputs].map((p) => p.id).sort();
      const actual = pkg.pins.map((p) => p.id).sort();
      assert(JSON.stringify(expected) === JSON.stringify(actual), `${typeId}: pinos ${JSON.stringify(actual)} != portas ${JSON.stringify(expected)}`);
      const shape = pkg.shapes?.[0];
      assert(pkg.shapes?.length === 1 && shape?.kind === "svg" && (shape.value ?? "").length > 0, `${typeId}: desenho vetorial presente`);
      assert(!/<script|javascript:|on[a-z]+=/i.test(shape?.value ?? ""), `${typeId}: svg sem conteudo ativo`);
    }
  });

  await test("Sum redondo '|++' coloca as entradas a esquerda e embaixo; saida a direita", () => {
    const pkg = blockPackage(specs.get("sl.sum")!, { IconShape: "round", Inputs: "|++" });
    const pin = (id: string) => pkg.pins.find((p) => p.id === id)!;
    assert(pin("in1").angle === 180 && pin("in2").angle === 270 && pin("out1").angle === 0, `angulos ${JSON.stringify(pkg.pins)}`);
    assert(Number(pin("in2").y) > Number(pin("in1").y), "entrada 2 abaixo");
  });

  await test("ícones mostram o parametro como no Simulink (texto do Gain, polinomios da Transfer Fcn)", () => {
    const gain = blockPackage(specs.get("sl.gain")!, { Gain: "2*l" }).shapes![0]!.value!;
    assert(gain.includes(">2*l<"), "Gain mostra a expressao digitada");
    const long = blockPackage(specs.get("sl.gain")!, { Gain: "[1 2 3 4 5 6 7 8 9]" }).shapes![0]!.value!;
    assert(long.includes("-K-"), "Gain longo vira -K-");
    const tf = blockPackage(specs.get("sl.transfer_fcn")!, { Numerator: "[1]", Denominator: "[1 2 1]" }).shapes![0]!.value!;
    assert(tf.includes("baseline-shift=\"super\"") && tf.includes(">2<"), "denominador s^2 + 2s + 1 com expoente");
    assert(polynomialMarkup([1, -0.5], "z").plain === "z - 0.5", `polinomio ${polynomialMarkup([1, -0.5], "z").plain}`);
    assert(polynomialMarkup([2, 0, 1], "s").plain === "2s^2 + 1", `polinomio ${polynomialMarkup([2, 0, 1], "s").plain}`);
  });

  await test("catalogo: presets criam o typeId real com os padroes do preset", () => {
    const entries = blockCatalogEntries(library, "pt-BR");
    const add = entries.find((entry) => entry.instanceTypeId === "sl.sum" && entry.label === "Adição");
    assert(add !== undefined && add.defaultProperties.Inputs === "++" && add.defaultProperties.IconShape === "rectangular", "preset Add");
    const base = entries.findIndex((entry) => entry.typeId === "sl.sum");
    assert(base >= 0 && base < entries.indexOf(add!), "entrada-base antes do preset");
    assert(entries.every((entry) => entry.workspaceSection === "control" && entry.folderPath?.[0] === "Blocos Funcionais"), "todos em Controle > Blocos Funcionais");
    const integrator = entries.find((entry) => entry.typeId === "sl.integrator")!;
    const upper = integrator.propertySchema!.find((schema) => schema.id === "UpperSaturationLimit")!;
    assert(JSON.stringify(upper.visibleWhen) === JSON.stringify({ LimitOutput: [true] }), "campo condicional preserva visibleWhen");
  });

  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

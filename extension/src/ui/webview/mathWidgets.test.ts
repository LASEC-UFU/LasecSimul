import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
  MATH_EQUATION_TYPE_ID, MATH_PARAMETER_TYPE_ID, MATH_PLOT_TYPE_ID, MATH_TABLE_TYPE_ID, MATH_TREND_TYPE_ID,
  clampParameter, compileInScope, equationSvg, evaluateAt, functionPlotSvg, mathScopeOf, mathWidgetSvg, parameterSvg,
  parameterValueAt, trendSvg, valueTableSvg,
} from "./mathWidgets";

const parameter = (name: string, value: number, extra: Record<string, unknown> = {}) =>
  ({ typeId: MATH_PARAMETER_TYPE_ID, properties: { name, value, min: -10, max: 10, step: 0.5, ...extra } });

(async () => {
  const { test, finish } = createTestRunner("mathWidgets");

  await test("escopo da página: um valor por nome, autorado ou da sessão", () => {
    const scope = mathScopeOf([
      parameter("a", 2), parameter("b", -1), parameter("a", 9), parameter("1x", 3),
      { typeId: MATH_PLOT_TYPE_ID, properties: { name: "c", value: 5 } },
    ], { b: 4 });
    assert(scope.a === 2, "primeiro parâmetro com o nome vale");
    assert(scope.b === 4, "valor da sessão prevalece");
    assert(!("1x" in scope) && !("c" in scope), "nome inválido e outros elementos ficam fora");
  });

  await test("parâmetro preso à faixa e ao passo", () => {
    const properties = { min: 0, max: 1, step: 0.25 };
    assert(clampParameter(properties, 0.3) === 0.25, "arredonda ao passo");
    assert(clampParameter(properties, 7) === 1 && clampParameter(properties, -2) === 0, "faixa");
    assert(parameterValueAt(properties, 0.5) === 0.5 && parameterValueAt(properties, 1.4) === 1, "posição no trilho");
    assert(clampParameter({ min: -3, max: 3, step: 0 }, 1.234) === 1.234, "passo 0 = contínuo");
  });

  await test("expressão compila com os parâmetros e avalia como o Laboratório", () => {
    const compiled = compileInScope("a x^2 + b", "x", { a: 2, b: 1 });
    assert(!("error" in compiled), "compila");
    if ("error" in compiled) return;
    assert(evaluateAt(compiled, 3) === 19, "2·3² + 1 = 19");
    assert(Number.isNaN(evaluateAt(compileInScope("1/x", "x", {}) as never, 0)), "indefinido = NaN");
    const error = compileInScope("a x + k", "x", { a: 1 });
    assert("error" in error && error.error.length > 0, "símbolo desconhecido vira mensagem");
  });

  await test("gráfico de função: curva, eixos e raízes", () => {
    const svg = functionPlotSvg({ expression: "x^2 - a", xMin: -3, xMax: 3, yMin: -2, yMax: 8, showRoots: true }, { width: 400, height: 260 }, { a: 1 });
    assert(/<path d="M-?[\d.]+,-?[\d.]+L/.test(svg), "curva amostrada");
    // Em pixels da área (342 × 214 aqui): x = −3 é a borda esquerda; f(−3) = 8 é o topo da faixa (y = 0).
    const [x0, y0] = (/<path d="M(-?[\d.]+),(-?[\d.]+)L/.exec(svg) ?? []).slice(1).map(Number);
    assert(Math.abs(x0!) < 1 && Math.abs(y0!) < 1, "curva em pixels da área de desenho, não em coordenadas do mundo");
    assert((svg.match(/raiz ≈/g) ?? []).length === 2, "duas raízes (±1)");
    assert(svg.includes("f(x) = x^2 - a"), "legenda");
    const bad = functionPlotSvg({ expression: "x +" }, { width: 300, height: 200 }, {});
    assert(bad.includes("f:"), "erro de sintaxe aparece no elemento");
    const derivative = functionPlotSvg({ expression: "x^3", showDerivative: true }, { width: 300, height: 200 }, {});
    assert(derivative.includes('stroke-dasharray="6 4"'), "f′ tracejada");
  });

  await test("equação em MathML, com e sem substituição; valor sem variável livre", () => {
    const symbolic = equationSvg({ lhs: "f(x)", expression: "a x + b", variable: "x" }, { width: 300, height: 60 }, { a: 2, b: 3 });
    assert(symbolic.includes("<math") && symbolic.includes("<mi>a</mi>"), "parâmetro por nome");
    const numeric = equationSvg({ lhs: "f(x)", expression: "a x + b", variable: "x", substitute: true }, { width: 300, height: 60 }, { a: 2, b: 3 });
    assert(numeric.includes("<mn>2</mn>") && !numeric.includes("<mi>a</mi>"), "parâmetros substituídos");
    const value = equationSvg({ lhs: "k", expression: "a + b", variable: "" }, { width: 300, height: 60 }, { a: 2, b: 3 });
    assert(value.includes("= 5"), "valor mostrado");
    const negative = equationSvg({ lhs: "f(x)", expression: "x^2 + c", variable: "x", substitute: true }, { width: 300, height: 60 }, { c: -2 });
    assert(negative.includes("<mo>−</mo><mn>2</mn>") && !negative.includes("<mo>+</mo><mn>−2</mn>"), "x + (−2) escrito como x − 2");
  });

  await test("tabela de valores e slider", () => {
    const table = valueTableSvg({ expression: "2x", start: 0, step: 1, rows: 3 }, { width: 200, height: 200 }, {});
    assert(table.includes(">4<") && table.includes(">2<") && table.includes(">0<"), "linhas x | 2x");
    const slider = parameterSvg({ name: "a", min: 0, max: 10, value: 5 }, { width: 260, height: 64 }, 2.5);
    assert(slider.includes("2,5") && slider.includes("math-parameter-thumb"), "valor atual e cursor");
  });

  await test("tendência desenha a janela e marca leitura ausente", () => {
    const samples = [[0, 1], [1, 2], [2, 3]] as const;
    const svg = trendSvg({ windowSeconds: 10, bindSource: "k1", bindUnit: "V" }, { width: 400, height: 220 }, samples, "bound");
    assert(svg.includes("<polyline") && svg.includes("3 V"), "linha e leitura atual");
    const missing = trendSvg({ windowSeconds: 10, bindSource: "k1" }, { width: 400, height: 220 }, [], "missing");
    assert(missing.includes("sem leitura"), "estado do binding");
  });

  await test("despacho por typeId usa o estado injetado __math_*", () => {
    const box = { width: 300, height: 200 };
    assert(mathWidgetSvg(MATH_PLOT_TYPE_ID, { expression: "a x", __math_scope: { a: 1 } }, box)!.includes("<path"), "gráfico");
    assert(mathWidgetSvg(MATH_PARAMETER_TYPE_ID, { name: "a", min: 0, max: 4, __math_value: 3 }, box)!.includes(">3<"), "slider");
    assert(mathWidgetSvg(MATH_EQUATION_TYPE_ID, { expression: "a", variable: "", __math_scope: { a: 7 } }, box)!.includes("= 7"), "equação");
    assert(mathWidgetSvg(MATH_TABLE_TYPE_ID, { expression: "x", rows: 2 }, box)!.includes("<text"), "tabela");
    assert(mathWidgetSvg(MATH_TREND_TYPE_ID, { __math_samples: [[0, 1], [1, 2]] }, box)!.includes("<polyline"), "tendência");
    assert(mathWidgetSvg("graphics.label", {}, box) === undefined, "outros tipos não");
  });

  finish();
})();

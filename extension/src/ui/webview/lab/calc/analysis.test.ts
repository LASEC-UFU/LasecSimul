import { createTestRunner, assert as assertWithMessage } from "../../../../ipc/testSupport/MockCoreServer";
import { asymptotes, epsilonDelta, findIntersections, findRoots, piecewisePoints } from "./analysis";
import { parseExpression } from "./ast";
import { compileExpression, Evaluation } from "./compile";
import { antiderivative } from "./integral";
import { astToMathML } from "./mathml";

const assert = (condition: boolean, message = "falhou"): void => assertWithMessage(condition, message);
const close = (a: number, b: number, tol = 1e-10): boolean => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const calc = (text: string, symbols: string[] = [], env: number[] = []): Evaluation =>
  compileExpression(parseExpression(text, symbols), symbols).evaluate(env);
const value = (e: Evaluation): number => (e.kind === "finite" ? e.value : NaN);
const reason = (e: Evaluation): string => (e.kind === "undefined" ? e.reason : "");
const methods = (e: Evaluation): string => e.methods.join(" | ");

(async () => {
  const { test, finish } = createTestRunner("Laboratório de Cálculo — por partes, integrais simbólicas e análise");

  await test("função por partes: se(x < 2, x², 4) avalia cada trecho e a fronteira", () => {
    const f = (x: number) => value(calc("se(x < 2, x^2, 4)", ["x"], [x]));
    assert(f(1) === 1 && f(2) === 4 && f(3) === 4, `${f(1)} ${f(2)} ${f(3)}`);
    assert(value(calc("se(x <= 0, -x, x)", ["x"], [-3])) === 3 && value(calc("se(x ≥ 1, 1, 0)", ["x"], [1])) === 1, "≤ e ≥");
    let rejected = false;
    try { parseExpression("se(x, 1, 2)", ["x"]); } catch { rejected = true; }
    assert(rejected, "condição precisa ser comparação");
  });

  await test("derivada na fronteira: contínua e lisa existe; canto e salto são não diferenciáveis", () => {
    const smooth = calc("D(x, se(x < 1, x^2, 2x - 1))", ["x"], [1]);
    assert(value(smooth) === 2, `lisa: ${JSON.stringify(smooth)}`);
    const corner = calc("D(x, se(x < 1, x, 2x - 1))", ["x"], [1]);
    assert(corner.kind === "undefined" && /derivadas laterais diferentes/.test(reason(corner)), `canto: ${reason(corner)}`);
    const jump = calc("D(x, se(x < 1, x, x + 1))", ["x"], [1]);
    assert(jump.kind === "undefined" && /salta/.test(reason(jump)), `salto: ${reason(jump)}`);
    assert(value(calc("D(x, se(x < 1, x, x + 1))", ["x"], [0.5])) === 1, "fora da fronteira a derivada existe");
  });

  await test("antiderivadas por regras: exp, sen, cos, potências e 1/u de argumento linear", () => {
    const cases: Array<[string, number]> = [
      ["Integrate(x, 0, 1, exp(2x))", (Math.exp(2) - 1) / 2],
      ["Integrate(x, 0, pi, sin(x))", 2],
      ["Integrate(x, 0, pi/2, cos(3x))", -1 / 3],
      ["Integrate(x, 1, 4, sqrt(x))", 14 / 3],
      ["Integrate(x, 0, 1, 1/(2x+1))", Math.log(3) / 2],
      ["Integrate(x, 1, 2, x^-2)", 0.5],
      ["Integrate(x, 0, 1, 2^x)", 1 / Math.log(2)],
    ];
    for (const [text, expected] of cases) {
      const r = calc(text);
      assert(r.kind === "finite" && close(r.value, expected) && r.exact && /antiderivada/.test(methods(r)), `${text}: ${JSON.stringify(r)}`);
    }
  });

  await test("integração por partes: x·eˣ, x·sen x, x²·cos x, ln x e x·ln x (exatas)", () => {
    const cases: Array<[string, number]> = [
      ["Integrate(x, 0, 1, x exp(x))", 1],
      ["Integrate(x, 0, pi, x sin(x))", Math.PI],
      ["Integrate(x, 0, pi/2, x^2 cos(x))", (Math.PI ** 2) / 4 - 2],
      ["Integrate(x, 1, e, ln(x))", 1],
      ["Integrate(x, 1, 2, x ln(x))", 2 * Math.log(2) - 0.75],
      ["Integrate(x, 0, 1, x exp(2x))", (Math.exp(2) + 1) / 4],
    ];
    for (const [text, expected] of cases) {
      const r = calc(text);
      assert(r.kind === "finite" && close(r.value, expected) && /partes/.test(methods(r)), `${text}: ${JSON.stringify(r)}`);
    }
    const anti = antiderivative(parseExpression("x exp(x)", ["x"]), "x");
    assert(Boolean(anti) && /partes/.test(anti!.methods.join()), "antiderivada simbólica disponível para exibição");
    assert(astToMathML(anti!.ast).includes("exp"), "antiderivada em MathML");
  });

  await test("integral imprópria não usa F(b) − F(a): 1/x em [−1, 1] e ln x em [0, 1]", () => {
    const r = calc("Integrate(x, -1, 1, 1/x)");
    assert(r.kind === "undefined" && /imprópria|indefinido/.test(reason(r)), `1/x: ${JSON.stringify(r)}`);
    const parametric = calc("Integrate(x, 0, 1, a exp(a x))", ["a"], [2]);
    assert(close(value(parametric), Math.exp(2) - 1) && /antiderivada/.test(methods(parametric)), `coeficiente simbólico: ${JSON.stringify(parametric)}`);
  });

  await test("integral de função por partes divide o intervalo na fronteira", () => {
    const r = calc("Integrate(x, 0, 3, se(x < 2, x^2, 4))");
    assert(close(value(r), 8 / 3 + 4, 1e-9) && /fronteiras/.test(methods(r)), `${JSON.stringify(r)}`);
  });

  await test("assíntotas: racional com buraco, horizontal, oblíqua; tg numérica", () => {
    const f = parseExpression("(x^2 - 1)/((x - 1)(x + 2))", ["x"]);
    const a = asymptotes(f, "x", compileExpression(f, ["x"]), [-5, 5]);
    assert(a.exact && a.vertical.length === 1 && close(a.vertical[0]!, -2, 1e-8) && a.horizontal[0] === 1, `buraco em 1, assíntota em −2: ${JSON.stringify(a)}`);
    const g = parseExpression("(x^2 + 1)/(x - 1)", ["x"]);
    const b = asymptotes(g, "x", compileExpression(g, ["x"]), [-5, 5]);
    assert(Boolean(b.oblique) && close(b.oblique!.slope, 1) && close(b.oblique!.intercept, 1), `oblíqua y = x + 1: ${JSON.stringify(b)}`);
    const t = parseExpression("tan(x)", ["x"]);
    const c = asymptotes(t, "x", compileExpression(t, ["x"]), [0, 3]);
    assert(!c.exact && c.vertical.length === 1 && Math.abs(c.vertical[0]! - Math.PI / 2) < 1e-6, `tg: ${JSON.stringify(c)}`);
    const linear = parseExpression("x/2", ["x"]);
    assert(asymptotes(linear, "x", compileExpression(linear, ["x"]), [-5, 5]).oblique === undefined, "reta não tem assíntota oblíqua");
  });

  await test("raízes e interseções; polo não é raiz", () => {
    const f = parseExpression("x^3 - 2x", ["x"]);
    const roots = findRoots(compileExpression(f, ["x"]), -3, 3);
    assert(roots.length === 3 && close(roots[2]!, Math.SQRT2, 1e-12), JSON.stringify(roots));
    const pole = parseExpression("1/x", ["x"]);
    assert(findRoots(compileExpression(pole, ["x"]), -1, 1).length === 0, "1/x não tem raiz em 0");
    const cross = findIntersections(parseExpression("x^2", ["x"]), parseExpression("x + 2", ["x"]), "x", ["x"], [0], -5, 5);
    assert(cross.length === 2 && close(cross[0]![0], -1) && close(cross[1]![1], 4), JSON.stringify(cross));
  });

  await test("ε–δ: δ para x² em 2 e contraexemplo para o salto", () => {
    const f = parseExpression("x^2", ["x"]);
    const r = epsilonDelta(compileExpression(f, ["x"]), 2, 4, 0.1, 1);
    assert(r.kind === "delta" && Math.abs(r.delta - (Math.sqrt(4.1) - 2)) < 1e-3, JSON.stringify(r));
    const step = parseExpression("se(x < 0, 0, 1)", ["x"]);
    const s = epsilonDelta(compileExpression(step, ["x"]), 0, 0, 0.5, 1);
    assert(s.kind === "none" && s.gap >= 0.5, JSON.stringify(s));
  });

  await test("fronteiras de por partes: valores laterais e continuidade", () => {
    const points = piecewisePoints(parseExpression("se(x < 1, x, x + 1)", ["x"]), "x", ["x"], [0]);
    assert(points.length === 1 && points[0]!.x === 1 && !points[0]!.continuous && close(points[0]!.left, 1, 1e-6) && points[0]!.value === 2, JSON.stringify(points));
  });

  await test("MathML de por partes e comparações", () => {
    const ml = astToMathML(parseExpression("se(x <= 2, x^2, 4)", ["x"]));
    assert(ml.includes("<mo>{</mo>") && ml.includes("≤") && ml.includes("caso contrário"), ml);
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

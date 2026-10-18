import { createTestRunner, assert as assertWithMessage } from "../../../../ipc/testSupport/MockCoreServer";
import { parseExpression, UserFunction } from "./ast";
import { compileExpression, Evaluation } from "./compile";
import { differentiate, simplify } from "./derivative";
import { astToMathML } from "./mathml";
import { differenceQuotient, sampleFunction } from "./numeric";
import { differenceQuotientPolynomial, formatPolynomial, toPolynomial } from "./poly";

const assert = (condition: boolean, message = "falhou"): void => assertWithMessage(condition, message);

const close = (a: number, b: number, tol = 1e-12): boolean => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const h: Record<string, UserFunction> = { h: { param: "t", ast: parseExpression("0.5t^2", ["t"]) } };
const calc = (text: string, symbols: string[] = [], env: number[] = []): Evaluation =>
  compileExpression(parseExpression(text, symbols, { functions: h }), symbols).evaluate(env);
const value = (e: Evaluation): number => (e.kind === "finite" ? e.value : NaN);
const reason = (e: Evaluation): string => (e.kind === "undefined" ? e.reason : "");

(async () => {
  const { test, finish } = createTestRunner("Laboratório de Cálculo — núcleo matemático");

  await test("0.5t^2 vira AST com multiplicação implícita e potência", () => {
    assert(JSON.stringify(parseExpression("0.5t^2", ["t"])) === JSON.stringify(["Multiply", 0.5, ["Power", "t", 2]]));
  });
  await test("símbolo fora da allowlist e identificador desconhecido são rejeitados", () => {
    let rejected = 0;
    for (const text of ["x+y", "constructor(1)"]) { try { parseExpression(text, ["x"]); } catch { rejected++; } }
    assert(rejected === 2);
  });
  await test("tabela bilateral de h(t)=0,5t² em a=4 confere com a meta (4,5/3,5 · 4,05/3,95 · 4,005/3,995)", () => {
    const fn = compileExpression(parseExpression("0.5t^2", ["t"]), ["t"]);
    const expected = [[1, 4.5, 3.5], [0.1, 4.05, 3.95], [0.01, 4.005, 3.995]] as const;
    for (const [dt, right, left] of expected) {
      const r = differenceQuotient(fn, 4, dt), l = differenceQuotient(fn, 4, -dt);
      assert(r.kind === "finite" && close(r.value, right, 1e-11) && l.kind === "finite" && close(l.value, left, 1e-11), `Δt=${dt}`);
    }
  });
  await test("Δt = 0 é indefinido; Δt abaixo da resolução é limite de precisão", () => {
    const fn = compileExpression(parseExpression("0.5t^2", ["t"]), ["t"]);
    assert(differenceQuotient(fn, 4, 0).kind === "undefined");
    assert(differenceQuotient(fn, 4, 1e-17).kind === "precision-limit");
  });
  await test("quociente exato de polinômio: 4 + 0,5Δt", () => {
    const q = differenceQuotientPolynomial(toPolynomial(parseExpression("0.5t^2", ["t"]), "t") ?? [], 4);
    assert(formatPolynomial(q, "Δt") === "4 + 0,5Δt", formatPolynomial(q, "Δt"));
  });
  await test("domínio: 1/x em 0, ln(−1) e √(−1) informam o motivo", () => {
    assert(/divisão/.test(reason(calc("1/x", ["x"], [0]))));
    assert(/logaritmo/.test(reason(calc("ln(x)", ["x"], [-1]))));
    assert(/raiz/.test(reason(calc("sqrt(x)", ["x"], [-1]))));
  });
  await test("lim do quociente de h em 4 = 4, exato por cancelamento de fator comum", () => {
    const r = calc("Limit(Δt, 0, 0, (h(4+Δt)-h(4))/Δt)");
    assert(r.kind === "finite" && r.value === 4 && r.exact, JSON.stringify(r));
  });
  await test("lim (x²−1)/(x−1) em 1 = 2 (removível); lim sen x/x = 1 só como evidência numérica", () => {
    const a = calc("Limit(x, 1, 0, (x^2-1)/(x-1))"), b = calc("Limit(x, 0, 0, sin(x)/x)");
    assert(a.kind === "finite" && a.value === 2 && a.exact);
    assert(b.kind === "finite" && close(b.value, 1, 1e-9) && !b.exact);
  });
  await test("lim |x|/x: laterais −1 e +1, bilateral não existe", () => {
    assert(/laterais diferentes/.test(reason(calc("Limit(x, 0, 0, abs(x)/x)"))));
    assert(value(calc("Limit(x, 0, 1, abs(x)/x)")) === 1 && value(calc("Limit(x, 0, -1, abs(x)/x)")) === -1);
  });
  await test("lim 1/x: +∞ pela direita; laterais opostos no bilateral; graus em ∞; sen(1/x) sem convergência", () => {
    assert(/\+∞/.test(reason(calc("Limit(x, 0, 1, 1/x)"))));
    assert(/não existe/.test(reason(calc("Limit(x, 0, 0, 1/x)"))));
    assert(value(calc("Limit(x, ∞, 0, (3x^2+1)/(x^2-5))")) === 3);
    assert(/sem convergência/.test(reason(calc("Limit(x, 0, 0, sin(1/x))"))));
  });
  await test("∫₀⁴ h = 32/3 exato; ∫₀^π sen = 2 exato (antiderivada); ∫₀¹ e^(x²) numérico; ∫₋₁¹ x = 0", () => {
    const a = calc("Integrate(t, 0, 4, h(t))"), b = calc("Integrate(x, 0, π, sin(x))"), c = calc("Integrate(x, 0, 1, exp(x^2))");
    assert(a.kind === "finite" && close(a.value, 32 / 3) && a.exact);
    assert(b.kind === "finite" && Math.abs(b.value - 2) < 1e-12 && b.exact);
    assert(c.kind === "finite" && Math.abs(c.value - 1.4626517459071816) < 1e-9 && !c.exact, "sem antiderivada elementar: Simpson");
    assert(Math.abs(value(calc("Integrate(x, -1, 1, x)"))) < 1e-15);
  });
  await test("Σ e Π finitos; Riemann à esquerda de h em [0,4] com n=8 = 8,75", () => {
    assert(value(calc("Sum(k, 1, 100, k)")) === 5050 && value(calc("Product(k, 1, 5, k)")) === 120);
    assert(close(value(calc("Sum(k, 0, 7, h(k/2)*0.5)")), 8.75));
  });
  await test("derivadas: d/dt h = t; TFC d/dx ∫₀ˣ s² = x²; |x| não diferenciável em 0", () => {
    assert(JSON.stringify(simplify(differentiate(parseExpression("h(t)", ["t"], { functions: h }), "t"))) === '"t"');
    assert(value(calc("D(t, h(t))", ["t"], [4])) === 4);
    assert(value(calc("D(x, Integrate(s, 0, x, s^2))", ["x"], [3])) === 9);
    assert(/canto/.test(reason(calc("D(x, abs(x))", ["x"], [0]))));
  });
  await test("amostragem para desenho separa os ramos de 1/x e mantém 0,5t² contínua", () => {
    const recip = compileExpression(parseExpression("1/x", ["x"]), ["x"]);
    const segments = sampleFunction(recip, -2, 2, (x, y) => [((x + 2) / 4) * 800, 300 - y * 20]);
    const bridges = segments.some((s) => s.some((p, i) => i > 0 && Math.sign((s[i - 1] as number[])[0] as number) !== Math.sign(p[0])));
    assert(segments.length >= 2 && !bridges, `${segments.length} segmentos`);
    const quad = sampleFunction(compileExpression(parseExpression("0.5t^2", ["t"]), ["t"]), 0, 6, (x, y) => [x * 100, 400 - y * 20]);
    assert(quad.length === 1);
  });
  await test("MathML: chamada de função preservada, integral e limite lateral", () => {
    const ml = astToMathML(parseExpression("Limit(Δt, 0, 1, (h(4+Δt)-h(4))/Δt)", [], { functions: h, keepCalls: true }));
    assert(ml.includes("<mo movablelimits=\"false\">lim</mo>") && ml.includes("<mo>+</mo>") && ml.includes("<mi>h</mi>"), ml);
  });

  finish();
})();

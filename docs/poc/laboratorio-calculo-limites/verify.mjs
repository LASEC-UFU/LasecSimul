// PoC isolada: verificações automáticas do núcleo (node verify.mjs). Não é suíte de produção.
import { readFileSync } from "node:fs";
import {
  parseExpression, compileExpression, toPolynomial, differenceQuotientPolynomial, formatPolynomial,
  differenceQuotient, DependencyGraph, sampleFunction,
  differentiate, simplify,
} from "./engine.mjs";
import { MathEditor } from "./editor.mjs";
import { TankSim, LITER } from "./tank-sim.mjs";
import { riemannOnSteps } from "./series.mjs";

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!cond) failures++;
};
const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// --- modelo da atividade --------------------------------------------------------------------
const ast = parseExpression("0.5t^2", ["t"]);
const h = compileExpression(ast, ["t"]);
check(JSON.stringify(ast) === JSON.stringify(["Multiply", 0.5, ["Power", "t", 2]]), "AST de 0.5t^2", JSON.stringify(ast));
check(h.evaluate([4]).value === 8, "h(4) = 8 cm");
check(h.evaluate([4.5]).value === 10.125, "Q(4,5) = 10,125 cm (valor da imagem)");

const rows = [1, 0.1, 0.01].map((dt) => ({ dt, right: differenceQuotient(h, 4, dt).value, left: differenceQuotient(h, 4, -dt).value }));
const expected = [[4.5, 3.5], [4.05, 3.95], [4.005, 3.995]];
rows.forEach((row, i) => check(close(row.right, expected[i][0], 1e-11) && close(row.left, expected[i][1], 1e-11),
  `tabela Δt=${row.dt}: direita ${row.right} / esquerda ${row.left}`));

const poly = toPolynomial(ast, "t");
const quotient = differenceQuotientPolynomial(poly, 4);
check(close(quotient[0], 4) && close(quotient[1], 0.5) && quotient.length === 2, "quociente exato = 4 + 0,5Δt", formatPolynomial(quotient, "Δt"));
check(close(quotient[0], 4), "limite exato (termo constante do polinômio em Δt) = 4 cm/s");

const atZero = differenceQuotient(h, 4, 0);
check(atZero.kind === "undefined", "Δt = 0 -> indefinido (não 0, não NaN exibido como número)", atZero.reason);
const tiny = differenceQuotient(h, 4, 1e-17);
check(tiny.kind === "precision-limit", "Δt = 1e-17 -> limite de precisão (4+Δt == 4 em float64)", tiny.reason);
const small = differenceQuotient(h, 4, 1e-9);
check(small.kind === "finite" && small.warning !== undefined, "Δt = 1e-9 -> finito com aviso de cancelamento", `${small.value}`);

// --- domínio e erros de sintaxe -------------------------------------------------------------
const recip = compileExpression(parseExpression("1/x", ["x"]), ["x"]);
check(recip.evaluate([0]).kind === "undefined" && /divisão/.test(recip.evaluate([0]).reason), "1/x em 0 -> divisão por zero");
const ln = compileExpression(parseExpression("ln(x)", ["x"]), ["x"]);
check(/logaritmo/.test(ln.evaluate([-1]).reason ?? ""), "ln(-1) -> fora do domínio");
let rejected = false;
try { parseExpression("constructor(1)", ["x"]); } catch { rejected = true; }
check(rejected, "identificador fora da allowlist é rejeitado");
rejected = false;
try { parseExpression("x+y", ["x"]); } catch { rejected = true; }
check(rejected, "símbolo não declarado é rejeitado");

// --- grafo incremental: arrastar Q não recalcula o que não depende de Q --------------------------
const g = new DependencyGraph();
g.source("expr", "0.5t^2", { kind: "authoring" });
g.source("a", 4, { kind: "authoring" });
g.source("dt", 0.5, { kind: "inspection" });
g.derived("fn", ["expr"], (e) => compileExpression(parseExpression(e, ["t"]), ["t"]), { equals: Object.is });
g.derived("P", ["fn", "a"], (fn, a) => ({ t: a, h: fn.value([a]) }));
g.derived("Q", ["fn", "a", "dt"], (fn, a, dt) => ({ t: a + dt, h: fn.value([a + dt]) }));
g.derived("deltaH", ["P", "Q"], (P, Q) => Q.h - P.h);
g.derived("quotient", ["fn", "a", "dt"], (fn, a, dt) => differenceQuotient(fn, a, dt));
g.derived("table", ["fn", "a"], (fn, a) => [1, 0.1, 0.01].map((d) => [differenceQuotient(fn, a, d).value, differenceQuotient(fn, a, -d).value]));
g.derived("curve", ["fn"], () => "path");
g.derived("side", ["dt"], (dt) => (dt > 0 ? "direita" : dt < 0 ? "esquerda" : "nenhum"));

const before = Object.fromEntries(["fn", "P", "Q", "deltaH", "quotient", "table", "curve", "side"].map((id) => [id, g.computeCount(id)]));
for (const dt of [0.4, 0.3, 0.2, 0.1, 0.05]) g.set("dt", dt);
const after = (id) => g.computeCount(id) - before[id];
check(after("Q") === 5 && after("quotient") === 5 && after("deltaH") === 5, "5 arrastos -> Q, Δh e quociente recalculados 5x");
check(after("P") === 0 && after("table") === 0 && after("curve") === 0 && after("fn") === 0, "P, tabela, curva e compilação NÃO recalculados ao arrastar Q");
check(after("side") === 5, "lado recalculado (barato) mas não muda de valor", `side=${g.get("side")}`);
const sideComputes = g.computeCount("side");
g.set("dt", 0.05);
check(g.computeCount("side") === sideComputes, "mesmo valor de Δt -> nenhuma propagação");

let notifications = 0;
const changedSets = [];
g.onChange((changed) => { notifications++; changedSets.push([...changed]); });
g.batch(() => { g.set("dt", -0.1); g.set("a", 4); });
check(notifications === 1, "batch -> uma notificação para o renderizador");
check(changedSets[0].includes("side") && !changedSets[0].includes("table"), "conjunto alterado informa só o que mudou (invalidação de desenho seletiva)", changedSets[0].join(","));
g.set("expr", "0.5t^2+1");
check(after("table") === 1 && after("curve") === 1 && after("P") === 1, "mudar a expressão recompila e recalcula dependentes uma vez");

// --- separação inspeção x processo: nenhum nó do grafo escreve no Core -------------------------
const kinds = new Set([...g.nodes.values()].map((n) => n.kind));
check(!kinds.has("parameter"), "PoC não declara parâmetro de processo; inspeção não tem caminho de escrita no Core");

// --- amostragem para desenho -----------------------------------------------------------------
const toPx = (x, y) => [((x + 2) / 4) * 800, 300 - y * 20];
const segRecip = sampleFunction(recip, -2, 2, toPx);
const bridges = segRecip.some((s) => s.some((p, i) => i > 0 && Math.sign(s[i - 1][0]) !== Math.sign(p[0]) && s[i - 1][0] !== 0 && p[0] !== 0));
check(segRecip.length >= 2 && !bridges, "1/x: ramos separados na assíntota, sem segmento ligando x<0 a x>0", `${segRecip.length} segmentos`);
const segQuad = sampleFunction(h, 0, 6, (x, y) => [x * 100, 400 - y * 20]);
check(segQuad.length === 1 && segQuad[0].length < 600, "0,5t²: 1 segmento contínuo com poucos pontos", `${segQuad[0].length} pontos`);

// --- CSP: o núcleo não usa avaliação dinâmica de código ---------------------------------------
const source = ["engine.mjs", "math.mjs", "editor.mjs", "palette.mjs", "icons.mjs", "app.mjs"]
  .map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8")).join("\n").replace(/\/\/.*$/gm, "");
check(!/\beval\s*\(|new\s+Function\s*\(/.test(source), "módulos da PoC sem eval/new Function (compatível com CSP sem 'unsafe-eval')");

// --- operadores de Cálculo (∫, d/dx, lim, Σ, Π) com proveniência ----------------------------------
const hFn = { h: { param: "t", ast: parseExpression("0.5t^2", ["t"]) } };
const calc = (text, syms = [], env = []) => compileExpression(parseExpression(text, syms, { functions: hFn }), syms).evaluate(env);
let r = calc("Limit(Δt, 0, 0, (h(4+Δt)-h(4))/Δt)");
check(r.kind === "finite" && r.value === 4 && r.exact, "lim Δt→0 [h(4+Δt)−h(4)]/Δt = 4, exato (cancelamento)", r.methods.join());
r = calc("Limit(x, 1, 0, (x^2-1)/(x-1))");
check(r.value === 2 && r.exact, "lim x→1 (x²−1)/(x−1) = 2 (descontinuidade removível), exato");
r = calc("Limit(x, 0, 0, sin(x)/x)");
check(Math.abs(r.value - 1) < 1e-9 && !r.exact, "lim sen x/x = 1 como evidência numérica (não exata)", r.methods.join());
r = calc("Limit(x, 0, 0, abs(x)/x)");
check(r.kind === "undefined" && /laterais diferentes/.test(r.reason), "lim |x|/x em 0: laterais diferentes, não existe", r.reason);
check(calc("Limit(x, 0, 1, abs(x)/x)").value === 1 && calc("Limit(x, 0, -1, abs(x)/x)").value === -1, "limites laterais de |x|/x: +1 e −1");
r = calc("Limit(x, 0, 1, 1/x)");
check(/\+∞/.test(r.reason ?? ""), "lim x→0⁺ 1/x diverge para +∞", r.reason);
check(/não existe/.test(calc("Limit(x, 0, 0, 1/x)").reason ?? ""), "lim x→0 1/x: laterais infinitos opostos, não existe");
check(calc("Limit(x, ∞, 0, (3x^2+1)/(x^2-5))").value === 3, "lim x→∞ (3x²+1)/(x²−5) = 3 (graus)");
check(/sem convergência/.test(calc("Limit(x, 0, 0, sin(1/x))").reason ?? ""), "lim sen(1/x) em 0: sem convergência observada (não afirma limite)");
r = calc("Integrate(t, 0, 4, h(t))");
check(close(r.value, 32 / 3) && r.exact, "∫₀⁴ 0,5t² dt = 32/3, antiderivada exata");
r = calc("Integrate(x, 0, π, sin(x))");
check(Math.abs(r.value - 2) < 1e-9 && !r.exact, "∫₀^π sen = 2 por Simpson adaptativo (numérico)");
check(Math.abs(calc("Integrate(x, -1, 1, x)").value) < 1e-15, "∫₋₁¹ x dx = 0 (integral com sinal)");
check(calc("Sum(k, 1, 100, k)").value === 5050 && calc("Product(k, 1, 5, k)").value === 120, "Σ k (1..100) = 5050; Π k (1..5) = 120");
r = calc("Sum(k, 0, 7, h(k/2)*0.5)");
check(close(r.value, 8.75), "Σ de Riemann à esquerda de h em [0,4], n = 8: 8,75 (< 32/3)", String(r.value));
check(calc("D(t, h(t))", ["t"], [4]).value === 4, "d/dt h em t = 4: 4 (regras)");
check(JSON.stringify(simplify(differentiate(parseExpression("h(t)", ["t"], { functions: hFn }), "t"))) === '"t"', "d/dt 0,5t² simplifica para t");
check(calc("D(x, Integrate(s, 0, x, s^2))", ["x"], [3]).value === 9, "TFC: d/dx ∫₀ˣ s² ds = x² (Leibniz) em x = 3");
check(/canto/.test(calc("D(x, abs(x))", ["x"], [0]).reason ?? ""), "d/dx |x| em 0: não diferenciável (canto)");

// --- editor estruturado (host simulado, sem DOM) -----------------------------------------------
const fakeHost = () => ({ tabIndex: 0, setAttribute() {}, classList: { add() {} }, addEventListener() {}, focus() {}, innerHTML: "" });
const typed = (keys, variable = "t") => { const ed = new MathEditor(fakeHost(), { variable }); for (const k of keys) { if (k.length === 1) ed.typeText(k); else if (k.startsWith("@")) { const [kind, dir] = k.slice(1).split(":"); ed.insertTemplate(kind, dir === undefined ? {} : { dir: Number(dir) }); } else ed.key(k); } return ed; };
let ed = typed([..."0.5t^2"]);
check(JSON.stringify(parseExpression(ed.text(), ["t"])) === JSON.stringify(["Multiply", 0.5, ["Power", "t", 2]]), "digitar 0.5t^2 gera o mesmo AST", ed.text());
ed = typed([..."1/t+1"]);
check(ed.text() === "((1)/(t+1))", "'/' cria fração; o que se digita depois vai para o denominador", ed.text());
ed = typed([..."x+2t/3"], "x");
check(ed.text() === "x+((2t)/(3))", "'/' leva só o operando à esquerda (2t) para o numerador", ed.text());
ed = typed([..."sin", "t", "ArrowRight", "+", "1"]);
check(ed.text() === "sin(t)+1", "digitar 'sin' vira template de função; seta sai do argumento", ed.text());
ed = typed(["@int", "0", "Tab", "4", "Tab", ..."t^2"]);
r = compileExpression(parseExpression(ed.text(), []), []).evaluate([]);
check(close(r.value, 64 / 3), "template ∫: limites 0..4, corpo t² -> 64/3", ed.text());
ed = typed(["@lim:1", "0", "Tab", ..."1/t"]);
check(/\+∞/.test(compileExpression(parseExpression(ed.text(), []), []).evaluate([]).reason ?? ""), "template lim⁺ com 1/t -> +∞", ed.text());
ed = typed(["@sum", ..."10", "Tab", "k"]);
check(compileExpression(parseExpression(ed.text(), []), []).evaluate([]).value === 55, "template Σ k=1..10 de k -> 55", ed.text());
ed = typed(["@deriv", ..."t^3"]);
check(compileExpression(parseExpression(ed.text(), ["t"]), ["t"]).evaluate([2]).value === 12, "template d/dt de t³ em t = 2 -> 12", ed.text());
ed = typed(["(", "t", "+", "1", "Home", "Backspace"]);
check(ed.text() === "t+1", "Backspace no início de parênteses desfaz o template e mantém o conteúdo", ed.text());
ed = typed(["@frac"]);
check(ed.emptyFields() === 2, "fração recém-criada tem 2 campos vazios (placeholders)");
ed = new MathEditor(fakeHost(), { variable: "t" });
ed.setAst(parseExpression("Limit(Δt, 0, 0, (h(4+Δt)-h(4))/Δt)", [], { functions: hFn, keepCalls: true }));
check(compileExpression(parseExpression(ed.text(), [], { functions: hFn }), []).evaluate([]).value === 4, "AST carregado no editor mantém h(...) e avalia para 4", ed.text());

// --- tanque: acumulador conservativo + A ao vivo (aceites de docs/53 §2.6) --------------------------
const Lt = LITER, steps = (s) => Math.round(s / 0.01);
const maxResidual = (sim) => { let m = 0; for (let i = 0; i < sim.rec.length; i++) m = Math.max(m, Math.abs(sim.rec.data.residual[i])); return m; };
let sim = new TankSim(); sim.start(); sim.advance(steps(10));
check(Math.abs(sim.acc.x - 26 * Lt) <= 1e-12 && Math.abs(sim.acc.x / 0.1 - 0.26) < 1e-12, "bomba 1/0,4 L/s por 10 s: ΔV = 6 L, Δh = 0,06 m", `${(sim.acc.x / Lt).toFixed(12)} L`);
sim = new TankSim({ qIn: 0, qOut: 0 }); sim.start(); sim.advance(steps(30));
check(sim.acc.x === 20 * Lt, "V0 = 20 L com vazões zero permanece 20 L");
sim = new TankSim(); sim.start(); sim.advance(steps(140));
const up = sim.events.find((e) => e.kind === "boundary:upper");
check(up && Math.abs(up.tNs - 133_333_333_333) <= 1, "transbordo de 20 L a 100 L com 0,6 L/s em 133,333… s (±1 ns)", up && String(up.tNs));
check(Math.abs(sim.acc.overflow - 0.6 * Lt) < 1e-15 && sim.acc.x === 100 * Lt, "no topo: overflow = 0,6 L/s e V = Vmax (sem volume virtual)");
sim = new TankSim({ qIn: 0, qOut: 2 * Lt }); sim.start(); sim.advance(steps(12));
const low = sim.events.find((e) => e.kind === "boundary:lower");
check(low && Math.abs(low.tNs - 10_000_000_000) <= 1 && sim.acc.outActual === 0 && Math.abs(sim.acc.unmet - 2 * Lt) < 1e-15, "esvazia em 10 s; depois outActual = 0 e unmet = 2 L/s", low && String(low.tNs));
check(sim.acc.x === 0 && maxResidual(sim) <= 1e-12 * 0.1, "V nunca negativo; resíduo de balanço ≤ 1e-12·Vmax", String(maxResidual(sim)));
sim = new TankSim({ mode: "valve" }); sim.start(); sim.advance(steps(200));
let worst = 0;
for (let i = 0; i < sim.rec.length; i += 500) { const t = sim.rec.t[i], exact = 50 * Lt + (20 - 50) * Lt * Math.exp(-t / 50); worst = Math.max(worst, Math.abs(sim.rec.data.V[i] - exact) / exact); }
check(worst <= 5e-4, "válvula q_out = k·h: V(t) contra exponencial analítica (τ = 50 s), erro relativo ≤ 5e-4", worst.toExponential(2));
const exactInt = sim.rec.stepIntegral("q", 0, 50), dV = sim.rec.linearAt("V", 50).value - sim.rec.linearAt("V", 0).value;
check(Math.abs(exactInt - dV) <= 1e-15, "∫ da vazão gravada (degraus) = ΔV medido em [0, 50 s]", `${exactInt} vs ${dV}`);
const errs = [5, 50, 500].map((n) => Math.abs(riemannOnSteps(sim.rec, "q", 0, 50, n, "left").sum - dV));
const errMid = [50, 500, 5000].map((n) => Math.abs(riemannOnSteps(sim.rec, "q", 0, 50, n, "midpoint").sum - dV));
const errTrap = Math.abs(riemannOnSteps(sim.rec, "q", 0, 50, 50, "trapezoid").sum - dV);
check(errs[0] / errs[1] > 8 && errs[1] / errs[2] > 8, "Riemann à esquerda sobre dados gravados converge ~1/n", errs.map((e) => e.toExponential(1)).join(" / "));
check(errs[1] / errMid[0] > 50 && errs[1] / errTrap > 50, "ponto médio e trapézio ~100× melhores que a esquerda com n = 50", `${errMid[0].toExponential(1)} / ${errTrap.toExponential(1)}`);
check(errMid[1] > 0.5 * errMid[0] && errMid[1] < 1e-4 * dV && errMid[2] < 1e-15, "piso de ~7e-5·ΔV pela amostragem de 10 ms; some quando cada retângulo = 1 passo", errMid.map((e) => e.toExponential(1)).join(" / "));
// A ao vivo
sim = new TankSim(); sim.start(); sim.advance(steps(50)); // V = 50 L
const before50 = Array.from(sim.rec.data.V.subarray(0, 100));
const applied = sim.setParameter("A", 0.04); sim.advance(1); // Vmax = 40 L: derrama 10 L
const spill = sim.events.find((e) => e.kind === "spill");
check(applied === 50_000_000_000 && sim.events.some((e) => e.kind === "parameter" && e.name === "A" && e.tNs === applied), "A ao vivo: evento de parâmetro em appliedAtNs = 50 s");
check(spill && Math.abs(spill.volume - 10 * Lt) < 1e-12 * 0.1, "A 0,1 → 0,04 m² com h_max = 1 m: derrama 10 L como volume discreto (não vazão)", spill && `${spill.volume / Lt} L`);
check(maxResidual(sim) <= 1e-12 * 0.1, "balanço fecha com o derramamento contabilizado em cumOverflow");
const iJump = sim.rec.upperBound(50) - 1;
check(sim.rec.t[iJump] === sim.rec.t[iJump - 1] && Math.abs(sim.rec.data.h[iJump] - 1.0) < 1e-12 && Math.abs(sim.rec.data.h[iJump - 1] - 0.5) < 1e-12, "duas linhas no mesmo instante: h salta de 0,5 m para 1,0 m (descontinuidade marcada)");
check(before50.every((v, i) => v === sim.rec.data.V[i]), "mudar parâmetro não reescreve amostras passadas");
sim = new TankSim(); sim.start(); sim.advance(steps(50)); sim.setParameter("A", 0.2); sim.advance(steps(10));
check(!sim.events.some((e) => e.kind === "spill") && Math.abs(sim.rec.linearAt("h", 50).value - 0.25) < 1e-12 && Math.abs(sim.acc.x - 56 * Lt) < 1e-12, "A 0,1 → 0,2 m²: V preservado, h cai à metade, sem derramamento; dV/dt inalterado");
let refused = false;
try { sim.setParameter("V0", 0.03); } catch (e) { refused = /requires_stop/.test(e.message); }
check(refused, "V0 é stop-required: recusado em execução");
sim.pause(); sim.setParameter("qIn", 0.5 * Lt);
check(sim.params.qIn === 0.5 * Lt && sim.events.at(-1).name === "qIn", "em pausa o parâmetro live é aplicado na hora (fila drenada em pausa)");

console.log(failures === 0 ? "\nTODAS AS VERIFICAÇÕES PASSARAM" : `\n${failures} FALHA(S)`);
process.exitCode = failures === 0 ? 0 : 1;

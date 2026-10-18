import { createTestRunner, assert as assertWithMessage } from "../../../../ipc/testSupport/MockCoreServer";
import { parseExpression, UserFunction } from "../calc/ast";
import { compileExpression } from "../calc/compile";
import { EditorModel, TemplateKind } from "./EditorModel";

const assert = (condition: boolean, message = "falhou"): void => assertWithMessage(condition, message);

const h: Record<string, UserFunction> = { h: { param: "t", ast: parseExpression("0.5t^2", ["t"]) } };
/** Sequência de entradas: caractere único = digitar; "@tipo" ou "@tipo:lado" = template; demais = tecla. */
function typed(keys: string[], variable = "t"): EditorModel {
  const m = new EditorModel(variable);
  for (const k of keys) {
    if (k.length === 1) m.typeText(k);
    else if (k.startsWith("@")) { const [kind, dir] = k.slice(1).split(":"); m.insertTemplate(kind as TemplateKind, dir === undefined ? {} : { dir: Number(dir) }); }
    else m.key({ key: k });
  }
  return m;
}
const evalText = (text: string, symbols: string[] = [], env: number[] = []): number => {
  const r = compileExpression(parseExpression(text, symbols, { functions: h }), symbols).evaluate(env);
  return r.kind === "finite" ? r.value : NaN;
};

(async () => {
  const { test, finish } = createTestRunner("Laboratório de Cálculo — editor de equações");

  await test("digitar 0.5t^2 produz o mesmo AST do texto linear", () => {
    const m = typed([..."0.5t^2"]);
    assert(JSON.stringify(parseExpression(m.text(), ["t"])) === JSON.stringify(["Multiply", 0.5, ["Power", "t", 2]]), m.text());
  });
  await test("'/' cria fração; o que vem depois vai para o denominador", () => {
    assert(typed([..."1/t+1"]).text() === "((1)/(t+1))");
  });
  await test("'/' leva só o operando à esquerda (até o operador) para o numerador", () => {
    assert(typed([..."x+2t/3"], "x").text() === "x+((2t)/(3))");
  });
  await test("nome de função digitado vira template; seta à direita sai do argumento", () => {
    assert(typed([..."sin", "t", "ArrowRight", "+", "1"]).text() === "sin(t)+1");
  });
  await test("template ∫ com Tab entre limites e corpo avalia 64/3", () => {
    const m = typed(["@int", "0", "Tab", "4", "Tab", ..."t^2"]);
    assert(Math.abs(evalText(m.text()) - 64 / 3) < 1e-12, m.text());
  });
  await test("template lim pela direita de 1/t diverge para +∞", () => {
    const m = typed(["@lim:1", "0", "Tab", ..."1/t"]);
    const r = compileExpression(parseExpression(m.text(), []), []).evaluate([]);
    assert(r.kind === "undefined" && /\+∞/.test(r.reason), m.text());
  });
  await test("template Σ k=1..10 de k = 55 e d/dt t³ em t = 2 = 12", () => {
    assert(evalText(typed(["@sum", ..."10", "Tab", "k"]).text()) === 55);
    assert(evalText(typed(["@deriv", ..."t^3"]).text(), ["t"], [2]) === 12);
  });
  await test("Backspace no início de parênteses desfaz o template mantendo o conteúdo", () => {
    assert(typed(["(", "t", "+", "1", "Home", "Backspace"]).text() === "t+1");
  });
  await test("Ctrl+A seguido de Backspace limpa; seguido de digitação substitui", () => {
    const m = typed([..."t+1"]);
    m.key({ key: "a", ctrl: true });
    m.key({ key: "Backspace" });
    assert(m.text() === "");
    m.typeText("t");
    m.key({ key: "a", ctrl: true });
    m.key({ key: "5" });
    assert(m.text() === "5", m.text());
  });
  await test("fração recém-criada tem 2 campos vazios; Tab sem template não é consumido", () => {
    const m = typed(["@frac"]);
    assert(m.emptyFields() === 2);
    assert(new EditorModel().key({ key: "Tab" }) === false);
  });
  await test("AST carregado mantém h(...) e o texto volta a avaliar 4", () => {
    const m = new EditorModel("t");
    m.setAst(parseExpression("Limit(Δt, 0, 0, (h(4+Δt)-h(4))/Δt)", [], { functions: h, keepCalls: true }));
    assert(m.text().includes("h(4+Δt)") && evalText(m.text()) === 4, m.text());
  });
  await test("render produz MathML com cursor e placeholder", () => {
    const m = typed(["@frac"]);
    const ml = m.render();
    assert(ml.includes('class="caret"') && ml.includes('class="ph"') && ml.startsWith("<math"));
  });

  await test("digitar se( cria o template por partes; <= vira ≤; texto avalia nos dois trechos", () => {
    const m = typed([..."se(", ..."x^2", "Tab", "Tab", ..."x<=2", "Tab", ..."4"], "x"); // 1º Tab sai do expoente
    assert(m.text().startsWith("se(") && m.text().includes("<=") && m.render().includes("caso contrário") && m.render().includes("≤"), m.text());
    assert(evalText(m.text(), ["x"], [1]) === 1 && evalText(m.text(), ["x"], [3]) === 4, m.text());
    assert(m.emptyFields() === 0, "três campos preenchidos");
  });
  await test("AST por partes volta ao editor (fromAst) e preserva o texto", () => {
    const m = new EditorModel("x");
    m.setAst(parseExpression("se(x >= 0, x, -x)", ["x"]));
    assert(evalText(m.text(), ["x"], [-2]) === 2 && m.render().includes("≥"), m.text());
  });
  await test("\"sen\" continua virando seno (o gatilho de por partes exige o parêntese)", () => {
    const m = typed([..."sen", ..."x"], "x");
    assert(m.text() === "sin(x)", m.text());
  });

  finish();
})();

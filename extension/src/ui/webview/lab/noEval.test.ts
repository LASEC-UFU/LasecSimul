import * as fs from "fs";
import * as path from "path";
import { assert, createTestRunner } from "../../../ipc/testSupport/MockCoreServer";

/**
 * O Laboratório roda sob CSP sem 'unsafe-eval' (docs/52 §6, ADR 0013): o calc-core compila a árvore
 * sintática para closures, nunca para texto avaliado. Este teste estático falha se alguém reintroduzir
 * eval, new Function, Function(...) ou setTimeout/setInterval com string nas fontes ou no JS emitido.
 */
const { test, finish } = createTestRunner("Laboratório de Cálculo — sem eval/new Function (CSP)");
const extensionRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");

function filesUnder(dir: string, extension: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extension);
    return entry.name.endsWith(extension) && !entry.name.includes(".test.") ? [full] : [];
  });
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/(?<![\w$])eval\s*\(/, "eval("],
  [/\bnew\s+Function\b/, "new Function"],
  [/(?<![\w$])Function\s*\(/, "Function("],
  [/\bset(?:Timeout|Interval)\s*\(\s*["'`]/, "setTimeout/setInterval com string"],
];

/** Tira comentários e literais de texto (o calc-core cita "eval" em mensagens e documentação). */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, "\"\"");
}

function offenders(files: string[]): string[] {
  return files.flatMap((file) => {
    const text = code(fs.readFileSync(file, "utf8"));
    return FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, label]) => `${path.relative(extensionRoot, file)}: ${label}`);
  });
}

void (async () => {
  await test("fontes do Laboratório não usam eval nem Function", () => {
    const files = filesUnder(path.join(extensionRoot, "src", "ui", "webview", "lab"), ".ts");
    assert(files.length > 20, `fontes encontradas: ${files.length}`);
    const found = offenders(files);
    assert(found.length === 0, found.join("; "));
  });

  await test("o JS emitido para a Webview do Laboratório também não", () => {
    const files = filesUnder(path.join(extensionRoot, "out-webview", "lab"), ".js");
    const found = offenders(files);
    assert(found.length === 0, found.join("; "));
  });

  await test("o detector pega os casos proibidos (sanidade)", () => {
    const sample = ["const f = new Function('x', 'return x');", "eval(text);", "window.Function(src)();", "setTimeout(\"go()\", 5);"];
    for (const line of sample) {
      const text = code(line);
      assert(FORBIDDEN.some(([pattern]) => pattern.test(text)), `não detectou: ${line}`);
    }
    assert(!FORBIDDEN.some(([pattern]) => pattern.test(code("sampleFunction(fn, a, b); x.evaluate(t);"))), "falso positivo");
  });

  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

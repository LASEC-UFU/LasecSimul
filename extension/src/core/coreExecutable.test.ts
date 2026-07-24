import * as assert from "assert";
import * as path from "path";
import { coreExecutableCandidates, resolveCoreExecutablePath } from "./coreExecutable";

const root = path.resolve("C:/fixture/extension");
const candidates = coreExecutableCandidates(root, "win32");
const release = candidates.find((candidate) => candidate.includes(`${path.sep}Release${path.sep}`))!;
const debug = candidates.find((candidate) => candidate.includes(`${path.sep}Debug${path.sep}`))!;

assert.strictEqual(
  resolveCoreExecutablePath(
    root,
    (candidate) => candidate === release || candidate === debug,
    "win32",
    (candidate) => candidate === debug ? 200 : 100,
    () => 0,
  ),
  debug,
  "o Core compilado mais recentemente precisa vencer uma configuração obsoleta",
);
assert.strictEqual(
  resolveCoreExecutablePath(
    root,
    (candidate) => candidate === release || candidate === debug,
    "win32",
    () => 100,
    () => 0,
  ),
  release,
  "Release continua vencendo Debug quando os timestamps empatam",
);
assert.strictEqual(
  resolveCoreExecutablePath(root, (candidate) => candidate === debug, "win32", undefined, () => 0),
  debug,
  "Debug continua sendo fallback quando é a única configuração compilada",
);

assert.throws(
  () => resolveCoreExecutablePath(
    root,
    (candidate) => candidate === release || candidate === debug,
    "win32",
    (candidate) => candidate === debug ? 200 : 100,
    () => 300,
  ),
  /Core local está desatualizado/,
  "um merge de fontes posterior a todos os binários deve falhar de forma explícita",
);

console.log("coreExecutable tests passed");

import * as assert from "assert";
import * as path from "path";
import { coreExecutableCandidates, resolveCoreExecutablePath } from "./coreExecutable";

const root = path.resolve("C:/fixture/extension");
const candidates = coreExecutableCandidates(root, "win32");
const release = candidates.find((candidate) => candidate.includes(`${path.sep}Release${path.sep}`))!;
const debug = candidates.find((candidate) => candidate.includes(`${path.sep}Debug${path.sep}`))!;

assert.strictEqual(
  resolveCoreExecutablePath(root, (candidate) => candidate === release || candidate === debug, "win32"),
  release,
  "Release precisa vencer Debug quando ambos existem",
);
assert.strictEqual(
  resolveCoreExecutablePath(root, (candidate) => candidate === debug, "win32"),
  debug,
  "Debug continua sendo fallback quando é a única configuração compilada",
);

console.log("coreExecutable tests passed");

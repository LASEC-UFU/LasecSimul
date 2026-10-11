#!/usr/bin/env node
"use strict";

/**
 * Gate pós-empacotamento do CLP IEC 61131-3: reextrai o VSIX FINAL num caminho com espaço, fora do
 * repositório, e compila um projeto IEC pelo MESMO código da extensão instalada
 * (`out/plc/plcBuild.js`: resolvePlcToolchain + buildIecProject), com o Core, o STruCpp, o runtime
 * e (Windows) o g++ que estão dentro do pacote. No Windows o PATH fica só com System32, como na
 * máquina de um aluno sem MSYS2.
 *
 * Uso: node scripts/test-bundled-plc.js [caminho-para-o.vsix]
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const target = process.platform === "win32" ? "win32-x64" : "linux-x64";

function fail(message) {
  console.error(`[bundled-plc] FALHOU: ${message}`);
  process.exit(1);
}

function resolveVsixPath() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const extensionPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "extension", "package.json"), "utf8"));
  return path.join(repoRoot, "dist", "release", target, `${extensionPackage.name}-${extensionPackage.version || "0.0.0"}-${target}.vsix`);
}

function extractVsix(vsixPath) {
  const workDir = path.join(os.tmpdir(), `LasecSimul PLC Gate ${process.pid}-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const [command, args] = process.platform === "win32"
    ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", vsixPath, "-C", workDir]]
    : ["unzip", ["-q", vsixPath, "-d", workDir]];
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, shell: false });
  if (result.error || result.status !== 0) fail(`não foi possível reextrair ${vsixPath}: ${result.error ? result.error.message : result.stderr}`);
  return path.join(workDir, "extension");
}

async function main() {
  const vsixPath = resolveVsixPath();
  if (!fs.existsSync(vsixPath)) fail(`VSIX final não encontrado: ${vsixPath}`);
  const extensionPath = extractVsix(vsixPath);
  console.log(`[bundled-plc] VSIX reextraído em ${extensionPath}`);
  if (process.platform === "win32") {
    const windowsRoot = process.env.SystemRoot || "C:\\Windows";
    process.env.PATH = [path.join(windowsRoot, "System32"), windowsRoot].join(path.delimiter);
  }

  const plcBuild = require(path.join(extensionPath, "out", "plc", "plcBuild.js"));
  const { starterIecProject } = require(path.join(extensionPath, "out", "plc", "plcProjectTemplate.js"));
  const toolchain = plcBuild.resolvePlcToolchain(extensionPath);
  for (const [label, file] of Object.entries({ core: toolchain.coreExecutable, strucpp: toolchain.strucppBinary,
    runtime: toolchain.runtimeIncludeDir, driver: toolchain.plcSrcDir, ...(toolchain.cxxCompiler ? { cxx: toolchain.cxxCompiler } : {}) })) {
    if (!fs.existsSync(file) || !file.startsWith(extensionPath)) fail(`${label} não vem do pacote: ${file}`);
  }
  if (process.platform === "win32" && !toolchain.cxxCompiler) fail("g++ empacotado ausente (bundled/plc/ucrt64)");

  const project = starterIecProject("gate");
  project.pous[0].interface.variables.push({ name: "T1", class: "local", type: "TON" }, { name: "COUNT", class: "local", type: "INT" });
  project.pous[0].implementation = { language: "st", text: "T1(IN := DI0 AND NOT T1.Q, PT := T#100ms);\nIF T1.Q THEN COUNT := COUNT + 1; END_IF;\nDO0 := DI0;" };
  const cacheRoot = path.join(path.dirname(extensionPath), "plc builds");
  const result = await plcBuild.buildIecProject(project, { toolchain, cacheRoot, log: (line) => console.log(`[bundled-plc] ${line}`) });
  if (!result.ok) fail(`compilação: ${JSON.stringify(result.diagnostics, null, 2)}\n${result.log}`);
  if (!fs.existsSync(result.module.nativeBinaryRef)) fail("executável do worker ausente");
  console.log(`[bundled-plc] OK: ${result.module.programName} compilado com ${result.module.cxxToolchainVersion || "g++"} ` +
    `em ${(result.durationMs / 1000).toFixed(1)} s (STruCpp ${result.module.strucppVersion})`);
  fs.rmSync(path.dirname(extensionPath), { recursive: true, force: true });
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));

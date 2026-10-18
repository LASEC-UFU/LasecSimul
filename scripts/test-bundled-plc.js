#!/usr/bin/env node
"use strict";

/**
 * Gate pós-empacotamento do CLP IEC 61131-3: reextrai o VSIX FINAL num caminho com espaço, fora do
 * repositório, cria projetos PLC `.lsplc` com o host do editor OpenPLC empacotado e os compila pelo
 * MESMO código da extensão instalada (`out/plc/openplc/openPlcBuild.js`), com o Core, o STruCpp, as
 * bibliotecas, o runtime e (Windows) o g++ que estão dentro do pacote: um programa ST com TON e o SFC
 * de um projeto novo (tradução SFC -> ST). No Windows o PATH fica só com System32, como na máquina de
 * um aluno sem MSYS2.
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
  const { buildOpenPlcProject } = require(path.join(extensionPath, "out", "plc", "openplc", "openPlcBuild.js"));
  const { loadOpenPlcHost } = require(path.join(extensionPath, "out", "plc", "openplc", "openPlcHost.js"));
  const lsplc = require(path.join(extensionPath, "out", "plc", "openplc", "lsplcFile.js"));
  const toolchain = plcBuild.resolvePlcToolchain(extensionPath);
  for (const [label, file] of Object.entries({ core: toolchain.coreExecutable, strucpp: toolchain.strucppBinary,
    runtime: toolchain.runtimeIncludeDir, driver: toolchain.plcSrcDir, ...(toolchain.cxxCompiler ? { cxx: toolchain.cxxCompiler } : {}) })) {
    if (!fs.existsSync(file) || !file.startsWith(extensionPath)) fail(`${label} não vem do pacote: ${file}`);
  }
  if (process.platform === "win32" && !toolchain.cxxCompiler) fail("g++ empacotado ausente (bundled/plc/ucrt64)");

  const work = path.dirname(extensionPath);
  const host = loadOpenPlcHost({ extensionPath, storageDir: path.join(work, "storage"), toolchain });
  const io = [{ name: "DI0", direction: "input", type: "BOOL" }, { name: "DO0", direction: "output", type: "BOOL" }];
  const projects = {
    // ST com um FB da biblioteca padrão.
    st: (raw) => ({
      ...raw,
      pouFiles: raw.pouFiles.map((file) => ({
        ...file,
        content: [
          "PROGRAM main",
          "  VAR_INPUT", "    DI0 : BOOL;", "  END_VAR",
          "  VAR_OUTPUT", "    DO0 : BOOL;", "  END_VAR",
          "  VAR", "    T1 : TON;", "    COUNT : INT;", "  END_VAR",
          "",
          "T1(IN := DI0 AND NOT T1.Q, PT := T#100ms);",
          "IF T1.Q THEN COUNT := COUNT + 1; END_IF;",
          "DO0 := DI0;",
          "",
          "END_PROGRAM",
        ].join("\n"),
      })),
    }),
    // SFC de um projeto novo (Init -> DI0 -> S1 com DO0 -> NOT DI0 -> Init).
    sfc: (raw) => raw,
  };
  const cacheRoot = path.join(work, "plc builds");
  for (const [language, prepare] of Object.entries(projects)) {
    const file = path.join(work, `gate ${language}.lsplc`);
    const { projectPath: _projectPath, ...raw } = prepare(host.newProjectFiles({ name: `gate_${language}`, language, io }));
    lsplc.writeLsplc(file, lsplc.bundleFromRaw(raw));
    const result = await buildOpenPlcProject(file, { host, toolchain, cacheRoot, log: (line) => console.log(`[bundled-plc] ${line}`) });
    if (!result.ok) fail(`compilação ${language.toUpperCase()}: ${JSON.stringify(result.diagnostics, null, 2)}\n${result.log}`);
    if (!fs.existsSync(result.module.nativeBinaryRef)) fail(`executável do worker ausente (${language})`);
    const pins = result.module.exportedIo.map((item) => `${item.direction}:${item.name}`).join(",");
    if (pins !== "input:DI0,output:DO0") fail(`pinos ${language}: ${pins}`);
    console.log(`[bundled-plc] OK ${language.toUpperCase()}: ${result.module.programName} compilado com ${result.module.cxxToolchainVersion || "g++"} ` +
      `em ${(result.durationMs / 1000).toFixed(1)} s (STruCpp ${result.module.strucppVersion})`);
  }
  // Limpeza do temporário não faz parte do portão: no runner Windows um arquivo do worker ainda pode estar
  // preso logo depois da compilação (ENOTEMPTY derrubou a v0.0.94 com tudo aprovado). Tenta de novo e só avisa.
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    console.warn(`[bundled-plc] aviso: não removeu ${work}: ${error && error.message ? error.message : error}`);
  }
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));

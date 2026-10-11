#!/usr/bin/env node
"use strict";

/**
 * Empacota o que o botão Compilar do editor IEC 61131-3 precisa numa instalação sem nada além do
 * VS Code (layout lido por extension/src/plc/plcBuild.ts::resolvePlcToolchain):
 *
 *   bundled/plc/strucpp/   STruCpp (ST -> C++17) + licenças + só as bibliotecas da norma
 *   bundled/plc/runtime/   headers de runtime da MESMA release do STruCpp (core/src/plc/runtime)
 *   bundled/plc/src/       PlcScanSession.{hpp,cpp} + PlcVariableCommands.hpp (driver do worker)
 *   bundled/plc/ucrt64/   Windows: g++ mínimo do MSYS2 UCRT64 (Linux usa o g++ do sistema)
 *
 * O MinGW não é copiado inteiro (350 MB com todas as import libs e headers do SDK): uma compilação
 * real de um programa de CLP com `-H` e `-Wl,--trace` diz quais headers e bibliotecas o worker usa
 * (o código gerado inclui sempre o mesmo runtime, então o conjunto não depende do programa do
 * aluno). Os headers C++ e os internos do GCC vão inteiros, por segurança. No fim, o Core
 * empacotado compila um programa de teste usando só o que foi copiado, com PATH limpo.
 *
 * Uso isolado: node scripts/stage-plc-toolchain.js <destino/bundled/plc> [caminho do lasecsimul-core]
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const IEC_LIBRARIES = ["iec-standard-fb.stlib", "iec-std-functions.stlib", "additional-function-blocks.stlib"];
const DRIVER_SOURCES = ["PlcScanSession.cpp", "PlcScanSession.hpp", "PlcVariableCommands.hpp"];
const MINGW_PROGRAMS = ["bin/g++.exe", "bin/as.exe", "bin/ld.exe", "bin/ld.bfd.exe"];
const GCC_PROGRAMS = ["cc1plus.exe", "collect2.exe", "lto-wrapper.exe", "liblto_plugin.dll"];

/** Programa de verificação: FB do aluno com nome que existe na OSCAT, TON, R_TRIG, REAL, TIME,
 * STRING e funções da norma -- puxa o runtime inteiro que o código gerado usa. */
const FIXTURE_ST = [
  "FUNCTION_BLOCK TOGGLE",
  "VAR_INPUT", "  CLK : BOOL;", "END_VAR",
  "VAR_OUTPUT", "  Q : BOOL;", "END_VAR",
  "VAR", "  EDGE : R_TRIG;", "END_VAR",
  "EDGE(CLK := CLK);",
  "IF EDGE.Q THEN Q := NOT Q; END_IF;",
  "END_FUNCTION_BLOCK",
  "",
  "PROGRAM MAIN",
  "VAR_INPUT", "  START : BOOL;", "  LEVEL : REAL;", "END_VAR",
  "VAR_OUTPUT", "  LAMP : BOOL;", "  OUT : REAL;", "  COUNT : INT;", "END_VAR",
  "VAR", "  T1 : TON;", "  FLIP : TOGGLE;", "  NAME : STRING := 'CLP';", "  ELAPSED : TIME;", "END_VAR",
  "T1(IN := START AND NOT T1.Q, PT := T#500ms);",
  "FLIP(CLK := T1.Q);",
  "LAMP := FLIP.Q;",
  "ELAPSED := T1.ET;",
  "OUT := LIMIT(0.0, SQRT(ABS(LEVEL)) * 2.0, 100.0);",
  "IF T1.Q THEN COUNT := COUNT + 1; NAME := CONCAT(NAME, '!'); END_IF;",
  "END_PROGRAM",
  "",
].join("\n");

function log(message) {
  console.log(`[stage-plc] ${message}`);
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function dirSize(dirPath) {
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, shell: false, maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  return result;
}

function ensureStrucpp() {
  const strucppDir = path.join(repoRoot, "plc", "strucpp", "build", platformKey(), "strucpp");
  const binary = path.join(strucppDir, process.platform === "win32" ? "strucpp.exe" : "strucpp");
  if (!fs.existsSync(binary)) {
    log("STruCpp ausente: baixando pela versão fixada em scripts/strucpp-pin.json");
    const result = run(process.execPath, [path.join(__dirname, "build-strucpp.js")], { cwd: repoRoot, stdio: "inherit" });
    if (result.status !== 0 || !fs.existsSync(binary)) throw new Error("não foi possível obter o STruCpp (scripts/build-strucpp.js)");
  }
  return { strucppDir, binary };
}

function findOnPath(fileName) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Raiz UCRT64 do MSYS2 (a que tem bin/g++.exe): variável, g++ do PATH ou o MSYS2 ao lado do repo. */
function resolveMingwRoot() {
  const candidates = [
    process.env.LASECSIMUL_PLC_MINGW_ROOT,
    (() => { const gxx = findOnPath("g++.exe"); return gxx ? path.dirname(path.dirname(gxx)) : null; })(),
    path.resolve(repoRoot, "..", "tools", "msys64", "ucrt64"),
  ].filter(Boolean);
  const root = candidates.find((candidate) => fs.existsSync(path.join(candidate, "bin", "g++.exe")));
  if (!root) throw new Error("MinGW UCRT64 (bin/g++.exe) não encontrado; defina LASECSIMUL_PLC_MINGW_ROOT");
  const gccRoot = path.join(root, "lib", "gcc", "x86_64-w64-mingw32");
  const version = fs.readdirSync(gccRoot).find((name) => fs.existsSync(path.join(gccRoot, name, "cc1plus.exe")));
  if (!version) throw new Error(`cc1plus.exe não encontrado em ${gccRoot}`);
  return { root: path.resolve(root), version, gccDir: path.join(gccRoot, version) };
}

function withPath(env, dir) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") || "PATH";
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] || ""}` };
}

function cleanWindowsEnv(extraDir) {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return {
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    ComSpec: process.env.ComSpec || path.join(windowsRoot, "System32", "cmd.exe"),
    PATH: [extraDir, path.join(windowsRoot, "System32"), windowsRoot].filter(Boolean).join(path.delimiter),
  };
}

/** Compila o programa de teste pelo Core (`--plc-compile`). Devolve o diretório de trabalho. */
function compileFixture({ coreExecutable, strucppBinary, libraryDir, runtimeIncludeDir, plcSrcDir, cxxCompiler, env, label }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-plc-stage-"));
  const stPath = path.join(workDir, "main.st");
  fs.writeFileSync(stPath, FIXTURE_ST, "utf8");
  const requestPath = path.join(workDir, "request.json");
  fs.writeFileSync(requestPath, JSON.stringify({
    stSourcePath: stPath,
    workDir,
    strucppBinaryPath: strucppBinary,
    strucppLibraryDirs: [libraryDir],
    runtimeIncludeDir,
    lasecsimulPlcSrcDir: plcSrcDir,
    manifestPath: path.join(workDir, "artifact.json"),
    ...(cxxCompiler ? { cxxCompilerPath: cxxCompiler } : {}),
  }, null, 2));
  const result = run(coreExecutable, ["--plc-compile", requestPath], { env, cwd: workDir, timeout: 300_000 });
  const reply = String(result.stdout || "").trim().split(/\r?\n/).pop() || "";
  let parsed;
  try { parsed = JSON.parse(reply); } catch { parsed = undefined; }
  if (result.status !== 0 || !parsed || !parsed.ok) {
    throw new Error(`compilação de verificação do CLP falhou (${label}): exit=${result.status}\n${reply}\n${result.stderr || ""}`);
  }
  return workDir;
}

/** Headers (-H) e entradas do linker (--trace) de uma compilação real do worker. */
function traceWorkerBuild(workDir, mingw, runtimeIncludeDir, plcSrcDir) {
  const generated = fs.readdirSync(workDir).find((name) => name.endsWith(".cpp") && name !== "driver.cpp");
  const args = [
    "-std=c++17", "-O2", "-H",
    "-I", runtimeIncludeDir, "-I", plcSrcDir, "-I", workDir,
    path.join(workDir, "driver.cpp"), path.join(workDir, generated), path.join(plcSrcDir, "PlcScanSession.cpp"),
    "-o", path.join(workDir, "trace.exe"),
    "-Wl,--no-insert-timestamp", "-static", "-Wl,--trace",
  ];
  const gxx = path.join(mingw.root, "bin", "g++.exe");
  const result = run(gxx, args, { cwd: workDir, env: withPath(process.env, path.join(mingw.root, "bin")), timeout: 300_000 });
  if (result.status !== 0) throw new Error(`g++ de rastreamento falhou:\n${result.stderr}`);
  const files = new Set();
  const inside = (candidate) => {
    const resolved = path.resolve(candidate.replace(/\//g, path.sep));
    return resolved.toLowerCase().startsWith(mingw.root.toLowerCase() + path.sep) ? resolved : null;
  };
  for (const line of String(result.stderr || "").split(/\r?\n/)) {
    const header = /^\.+\s+(.+)$/.exec(line);
    if (header) { const hit = inside(header[1].trim()); if (hit) files.add(hit); }
  }
  for (const line of `${result.stdout || ""}\n${result.stderr || ""}`.split(/\r?\n/)) {
    // ld --trace: "C:/.../crt2.o" ou "(C:/.../libmingwex.a)membro.o"
    const match = /^\(?([A-Za-z]:[\\/][^()]+?\.(?:a|o))\)?/.exec(line.trim());
    if (match) { const hit = inside(match[1]); if (hit) files.add(hit); }
  }
  return files;
}

function readPeImports(objdump, filePath) {
  const result = run(objdump, ["-p", filePath]);
  if (result.status !== 0) throw new Error(`objdump falhou em ${filePath}`);
  return [...String(result.stdout || "").matchAll(/DLL Name:\s*([^\s]+)/gi)].map((match) => match[1]);
}

function isSystemDll(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith("api-ms-win-") || lower.startsWith("ext-ms-win-")) return true;
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return fs.existsSync(path.join(windowsRoot, "System32", name));
}

function stageMingw(mingw, destination, traced) {
  fs.rmSync(destination, { recursive: true, force: true });
  const relativeFiles = new Set();
  const add = (absolute) => relativeFiles.add(path.relative(mingw.root, absolute));
  for (const program of MINGW_PROGRAMS) add(path.join(mingw.root, ...program.split("/")));
  for (const program of GCC_PROGRAMS) add(path.join(mingw.gccDir, program));
  for (const file of traced) add(file);
  for (const relative of relativeFiles) {
    const source = path.join(mingw.root, relative);
    if (!fs.existsSync(source)) throw new Error(`arquivo do MinGW ausente: ${source}`);
    copyFile(source, path.join(destination, relative));
  }
  // Headers C++ e internos do GCC inteiros: um std:: que o rastreamento não viu não pode faltar.
  for (const dir of [path.join("include", "c++", mingw.version), path.relative(mingw.root, path.join(mingw.gccDir, "include")),
    path.relative(mingw.root, path.join(mingw.gccDir, "include-fixed"))]) {
    const source = path.join(mingw.root, dir);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(destination, dir), { recursive: true });
  }
  // DLLs de g++/cc1plus/as/ld (gmp, mpfr, mpc, isl, zstd, zlib, libintl...) em bin/.
  const objdump = path.join(mingw.root, "bin", "objdump.exe");
  const queue = [...MINGW_PROGRAMS.map((program) => path.join(destination, ...program.split("/"))),
    ...GCC_PROGRAMS.map((program) => path.join(destination, path.relative(mingw.root, mingw.gccDir), program))];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current.toLowerCase())) continue;
    seen.add(current.toLowerCase());
    for (const dll of readPeImports(objdump, current)) {
      if (isSystemDll(dll)) continue;
      const staged = path.join(destination, "bin", dll);
      if (!fs.existsSync(staged)) {
        const source = path.join(mingw.root, "bin", dll);
        if (!fs.existsSync(source)) throw new Error(`DLL do MinGW não encontrada: ${dll} (de ${path.basename(current)})`);
        copyFile(source, staged);
      }
      queue.push(staged);
    }
  }
  fs.writeFileSync(path.join(destination, "MINGW-NOTICE.txt"), [
    `GCC ${mingw.version} e binutils do MSYS2 (UCRT64), sem modificações: https://www.msys2.org/`,
    "GCC: GPL-3.0 com GCC Runtime Library Exception; binutils: GPL-3.0; mingw-w64: ZPL/licenças do projeto.",
    "Fontes: https://packages.msys2.org/base/mingw-w64-gcc e https://packages.msys2.org/base/mingw-w64-binutils",
    "Só o necessário para o LasecSimul compilar o programa do CLP (IEC 61131-3) num executável estático.",
    "",
  ].join("\n"));
}

function stagePlcToolchain({ destRoot, coreExecutable }) {
  const { strucppDir, binary } = ensureStrucpp();
  fs.rmSync(destRoot, { recursive: true, force: true });

  const strucppDest = path.join(destRoot, "strucpp");
  copyFile(binary, path.join(strucppDest, path.basename(binary)));
  if (process.platform !== "win32") fs.chmodSync(path.join(strucppDest, path.basename(binary)), 0o755);
  for (const notice of ["LICENSE", "COPYING", "COPYING.RUNTIME"]) {
    if (fs.existsSync(path.join(strucppDir, notice))) copyFile(path.join(strucppDir, notice), path.join(strucppDest, notice));
  }
  for (const library of IEC_LIBRARIES) copyFile(path.join(strucppDir, "libs", library), path.join(strucppDest, "libs", library));

  const runtimeSource = path.join(repoRoot, "core", "src", "plc", "runtime", "include");
  fs.cpSync(runtimeSource, path.join(destRoot, "runtime", "include"), { recursive: true });
  for (const source of DRIVER_SOURCES) copyFile(path.join(repoRoot, "core", "src", "plc", source), path.join(destRoot, "src", source));

  const staged = {
    strucppBinary: path.join(strucppDest, path.basename(binary)),
    libraryDir: path.join(strucppDest, "libs"),
    runtimeIncludeDir: path.join(destRoot, "runtime", "include"),
    plcSrcDir: path.join(destRoot, "src"),
  };

  if (process.platform === "win32") {
    const mingw = resolveMingwRoot();
    log(`MinGW de origem: ${mingw.root} (GCC ${mingw.version})`);
    const traceDir = compileFixture({ coreExecutable, ...staged, cxxCompiler: path.join(mingw.root, "bin", "g++.exe"),
      env: withPath(process.env, path.join(mingw.root, "bin")), label: "MinGW de origem" });
    const traced = traceWorkerBuild(traceDir, mingw, staged.runtimeIncludeDir, staged.plcSrcDir);
    fs.rmSync(traceDir, { recursive: true, force: true });
    const mingwDest = path.join(destRoot, "ucrt64");
    stageMingw(mingw, mingwDest, traced);
    log(`MinGW mínimo: ${traced.size} arquivos rastreados, ${(dirSize(mingwDest) / 1e6).toFixed(1)} MB`);
    const verifyDir = compileFixture({ coreExecutable, ...staged, cxxCompiler: path.join(mingwDest, "bin", "g++.exe"),
      env: cleanWindowsEnv(path.join(mingwDest, "bin")), label: "MinGW empacotado, PATH limpo" });
    fs.rmSync(verifyDir, { recursive: true, force: true });
    log("compilação do CLP com o MinGW empacotado e PATH limpo: PASS");
  } else {
    const verifyDir = compileFixture({ coreExecutable, ...staged, env: process.env, label: "g++ do sistema" });
    fs.rmSync(verifyDir, { recursive: true, force: true });
    log("compilação do CLP com o g++ do sistema: PASS");
  }
  log(`bundled/plc: ${(dirSize(destRoot) / 1e6).toFixed(1)} MB`);
}

module.exports = { stagePlcToolchain, IEC_LIBRARIES };

if (require.main === module) {
  const destRoot = path.resolve(process.argv[2] || path.join(repoRoot, "dist", "staging", "plc"));
  const coreExecutable = path.resolve(process.argv[3] || path.join(repoRoot, "core", "build", "Release",
    process.platform === "win32" ? "lasecsimul-core.exe" : "lasecsimul-core"));
  try {
    stagePlcToolchain({ destRoot, coreExecutable });
  } catch (error) {
    console.error(`[stage-plc] ${error.message}`);
    process.exit(1);
  }
}

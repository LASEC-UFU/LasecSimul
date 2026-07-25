#!/usr/bin/env node
"use strict";

/**
 * Script agregado de configure + build do Core (C++ nativo).
 *
 * Equivale exatamente a:
 *   cmake -S core -B core/build
 *   cmake --build core/build
 *
 * No Windows força Visual Studio/x64 (2026 quando instalado, senão 2022): o Core usa SEH
 * (`__try`/`__except`) e não é compilável pelo GCC/MinGW. Deixar o PATH decidir já selecionou o
 * CMake do Strawberry/Ninja durante uma release. Linux/macOS continuam usando o generator padrão.
 *
 * Uso: node scripts/build-core.js [--clean]
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const buildDir = path.join(repoRoot, "core", "build");
const clean = process.argv.includes("--clean");
const configArg = process.argv.find((arg) => arg.startsWith("--config="));
const configIndex = process.argv.indexOf("--config");
const config =
  (configArg ? configArg.slice("--config=".length) : undefined) ??
  (configIndex >= 0 ? process.argv[configIndex + 1] : undefined);

function resolveCmakeCommand() {
  if (process.platform !== "win32") return "cmake";
  const candidates = [
    "C:\\Program Files\\CMake\\bin\\cmake.exe",
    "C:\\Program Files (x86)\\CMake\\bin\\cmake.exe",
    "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "cmake";
}

const cmakeCommand = resolveCmakeCommand();

function resolveWindowsGenerator() {
  // windows-latest migrou para Visual Studio 2026 em junho/2026. Detectar a instalação evita
  // fixar o gerador 17 num runner que só possui o 18, sem quebrar estações ainda em VS 2022.
  const vs2026Roots = [
    "C:\\Program Files\\Microsoft Visual Studio\\18",
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\18",
  ];
  return vs2026Roots.some((candidate) => fs.existsSync(candidate))
    ? "Visual Studio 18 2026"
    : "Visual Studio 17 2022";
}

function run(command, args, cwd) {
  console.log(`[build-core] ${command} ${args.join(" ")} (cwd=${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    console.error(`[build-core] falha ao executar ${command}:`, result.error.message);
    console.error(
      "[build-core] verifique se 'cmake' está no PATH (e, em Windows, um compilador C++20 -- " +
        "MSVC Build Tools, ou execute a partir de um 'Developer Command Prompt')."
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}

if (clean && fs.existsSync(buildDir)) {
  console.log(`[build-core] removendo ${buildDir}`);
  fs.rmSync(buildDir, { recursive: true, force: true });
}

// Caminhos relativos à raiz do repositório -- equivalente direto ao par de comandos exigido pelo
// teste obrigatório do agente 01 ("cmake -S core -B core/build" / "cmake --build core/build").
const configureArgs = ["-S", "core", "-B", path.join("core", "build")];
if (process.platform === "win32") configureArgs.push("-G", resolveWindowsGenerator(), "-A", "x64");
else if (config) configureArgs.push(`-DCMAKE_BUILD_TYPE=${config}`);

const buildArgs = ["--build", path.join("core", "build")];
if (config) buildArgs.push("--config", config);
// O projeto possui dezenas de executáveis de teste. Um limite pequeno evita recompilá-los
// estritamente em série sem esgotar a RAM de runners/estações com paralelismo irrestrito.
buildArgs.push("--parallel", "4");

run(cmakeCommand, configureArgs, repoRoot);
run(cmakeCommand, buildArgs, repoRoot);

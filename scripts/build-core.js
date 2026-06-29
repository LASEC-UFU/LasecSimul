#!/usr/bin/env node
"use strict";

/**
 * Script agregado de configure + build do Core (C++ nativo).
 *
 * Equivale exatamente a:
 *   cmake -S core -B core/build
 *   cmake --build core/build
 *
 * Sem opinião de generator: deixa o CMake escolher o default da plataforma (em Windows isso
 * resolve o Visual Studio instalado mais recente, com ambiente MSVC já configurado pelo próprio
 * CMake — não exige vcvarsall manual; em Linux/macOS, Makefiles/Ninja conforme o que estiver
 * disponível). Quem quiser um generator específico usa os presets em core/CMakePresets.json
 * diretamente (cmake --preset <nome>), este script é o caminho mínimo cobrindo os comandos de
 * verificação obrigatórios do agente 01.
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

function run(command, args, cwd) {
  console.log(`[build-core] ${command} ${args.join(" ")} (cwd=${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
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
if (config) configureArgs.push(`-DCMAKE_BUILD_TYPE=${config}`);

const buildArgs = ["--build", path.join("core", "build")];
if (config) buildArgs.push("--config", config);

run("cmake", configureArgs, repoRoot);
run("cmake", buildArgs, repoRoot);

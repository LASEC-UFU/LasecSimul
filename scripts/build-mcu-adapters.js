#!/usr/bin/env node
"use strict";

/**
 * Configura + builda cada adaptador de MCU em mcu-adapters/<nome>/ (plugin nativo DLL/SO, projeto
 * CMake próprio, detectado por ter um CMakeLists.txt) e copia o artefato pra build/<plataforma>/
 * que mcu.json espera (nativeEntry.win32-x64 etc) -- mesmo papel de build-devices.js, só que pra
 * adaptador de MCU (lsdn_get_mcu_vtable, ver mcu_abi.h) em vez de dispositivo
 * (lsdn_get_vtable, ver device_abi.h).
 *
 * Uso: node scripts/build-mcu-adapters.js [--clean]
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const adaptersRoot = path.join(repoRoot, "mcu-adapters");
const clean = process.argv.includes("--clean");
const configArg = process.argv.find((arg) => arg.startsWith("--config="));
const configIndex = process.argv.indexOf("--config");
const config =
  (configArg ? configArg.slice("--config=".length) : undefined) ??
  (configIndex >= 0 ? process.argv[configIndex + 1] : undefined);

const platformTarget = {
  win32: { dir: "win-x64", file: "adapter.dll", artifactNames: ["adapter.dll", "libadapter.dll"] },
  linux: { dir: "linux-x64", file: "adapter.so", artifactNames: ["libadapter.so", "adapter.so"] },
  darwin: { dir: "macos-universal", file: "adapter.dylib", artifactNames: ["libadapter.dylib", "adapter.dylib"] },
}[process.platform];

if (!platformTarget) {
  console.error(`[build-mcu-adapters] plataforma não suportada: ${process.platform}`);
  process.exit(1);
}

function resolveCmakeCommand() {
  if (process.platform !== "win32") return "cmake";

  const candidates = [
    "C:\\Program Files\\CMake\\bin\\cmake.exe",
    "C:\\Program Files (x86)\\CMake\\bin\\cmake.exe",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe",
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe",
  ];

  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return "cmake";
}

const cmakeCommand = resolveCmakeCommand();

function run(command, args, cwd) {
  console.log(`[build-mcu-adapters] ${command} ${args.join(" ")} (cwd=${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`[build-mcu-adapters] falha ao executar ${command}:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status === null ? 1 : result.status);
}

function findArtifact(rootDir, names) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (names.includes(entry.name)) return full;
    }
  }
  return null;
}

function buildAdapter(adapterDir) {
  const name = path.basename(adapterDir);
  const buildDir = path.join(adapterDir, "build_cmake");

  if (clean && fs.existsSync(buildDir)) {
    console.log(`[build-mcu-adapters] [${name}] removendo ${buildDir}`);
    fs.rmSync(buildDir, { recursive: true, force: true });
  }

  const configureArgs = ["-S", adapterDir, "-B", buildDir];
  if (config) configureArgs.push(`-DCMAKE_BUILD_TYPE=${config}`);
  const buildArgs = ["--build", buildDir];
  if (config) buildArgs.push("--config", config);

  run(cmakeCommand, configureArgs, repoRoot);
  run(cmakeCommand, buildArgs, repoRoot);

  const artifactPath = findArtifact(buildDir, platformTarget.artifactNames);
  if (!artifactPath) {
    console.error(
      `[build-mcu-adapters] [${name}] não encontrei o artefato compilado (procurei por ${platformTarget.artifactNames.join(", ")} em ${buildDir})`
    );
    process.exit(1);
  }

  const destDir = path.join(adapterDir, "build", platformTarget.dir);
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, platformTarget.file);
  fs.copyFileSync(artifactPath, destPath);
  console.log(`[build-mcu-adapters] [${name}] ${artifactPath} -> ${destPath}`);
}

const adapterDirs = fs
  .readdirSync(adaptersRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(adaptersRoot, entry.name))
  .filter((dir) => fs.existsSync(path.join(dir, "CMakeLists.txt")));

if (adapterDirs.length === 0) {
  console.error(`[build-mcu-adapters] nenhum adaptador com CMakeLists.txt encontrado em ${adaptersRoot}`);
  process.exit(1);
}

for (const adapterDir of adapterDirs) buildAdapter(adapterDir);

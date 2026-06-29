#!/usr/bin/env node
"use strict";

/**
 * Configura + builda cada device em devices/<nome>/ (plugin nativo DLL/SO, projeto CMake próprio,
 * detectado por ter um CMakeLists.txt) e copia o artefato pra build/<plataforma>/ que device.json
 * espera (nativeEntry.win32-x64 etc) — ver .spec/lasecsimul-native-devices.spec, seção 18.
 *
 * Devices são projetos CMake separados do Core de propósito (build independente do binário do
 * Core, igual um plugin de terceiros faria) — este script só automatiza o que "lasecsimul-cli
 * build" faria no futuro, sem introduzir essa ferramenta agora.
 *
 * Uso: node scripts/build-devices.js [--clean]
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const devicesRoot = path.join(repoRoot, "devices");
const clean = process.argv.includes("--clean");
const configArg = process.argv.find((arg) => arg.startsWith("--config="));
const configIndex = process.argv.indexOf("--config");
const config =
  (configArg ? configArg.slice("--config=".length) : undefined) ??
  (configIndex >= 0 ? process.argv[configIndex + 1] : undefined);

const platformTarget = {
  win32: { dir: "win-x64", file: "device.dll", artifactNames: ["device.dll", "libdevice.dll"] },
  linux: { dir: "linux-x64", file: "device.so", artifactNames: ["libdevice.so", "device.so"] },
  darwin: { dir: "macos-universal", file: "device.dylib", artifactNames: ["libdevice.dylib", "device.dylib"] },
}[process.platform];

if (!platformTarget) {
  console.error(`[build-devices] plataforma não suportada: ${process.platform}`);
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
  console.log(`[build-devices] ${command} ${args.join(" ")} (cwd=${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`[build-devices] falha ao executar ${command}:`, result.error.message);
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

function buildDevice(deviceDir) {
  const name = path.basename(deviceDir);
  const buildDir = path.join(deviceDir, "build_cmake");

  if (clean && fs.existsSync(buildDir)) {
    console.log(`[build-devices] [${name}] removendo ${buildDir}`);
    fs.rmSync(buildDir, { recursive: true, force: true });
  }

  const configureArgs = ["-S", deviceDir, "-B", buildDir];
  if (config) configureArgs.push(`-DCMAKE_BUILD_TYPE=${config}`);
  const buildArgs = ["--build", buildDir];
  if (config) buildArgs.push("--config", config);

  run(cmakeCommand, configureArgs, repoRoot);
  run(cmakeCommand, buildArgs, repoRoot);

  const artifactPath = findArtifact(buildDir, platformTarget.artifactNames);
  if (!artifactPath) {
    console.error(
      `[build-devices] [${name}] não encontrei o artefato compilado (procurei por ${platformTarget.artifactNames.join(", ")} em ${buildDir})`
    );
    process.exit(1);
  }

  const destDir = path.join(deviceDir, "build", platformTarget.dir);
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, platformTarget.file);
  fs.copyFileSync(artifactPath, destPath);
  console.log(`[build-devices] [${name}] ${artifactPath} -> ${destPath}`);
}

const deviceDirs = fs
  .readdirSync(devicesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(devicesRoot, entry.name))
  .filter((dir) => fs.existsSync(path.join(dir, "CMakeLists.txt")));

if (deviceDirs.length === 0) {
  console.error(`[build-devices] nenhum device com CMakeLists.txt encontrado em ${devicesRoot}`);
  process.exit(1);
}

for (const deviceDir of deviceDirs) buildDevice(deviceDir);

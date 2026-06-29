#!/usr/bin/env node
"use strict";

/**
 * Roda os testes nativos do Core (CTest) contra o build já existente em core/build.
 * Não builda sozinho -- rode scripts/build-core.js (ou "npm run build:core" na raiz) antes.
 *
 * Uso: node scripts/test-core.js
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const buildDir = path.join(repoRoot, "core", "build");
const cachePath = path.join(buildDir, "CMakeCache.txt");
const configArg = process.argv.find((arg) => arg.startsWith("--config="));
const configIndex = process.argv.indexOf("--config");
const requestedConfig =
  (configArg ? configArg.slice("--config=".length) : undefined) ??
  (configIndex >= 0 ? process.argv[configIndex + 1] : undefined);

if (!fs.existsSync(buildDir)) {
  console.error(
    `[test-core] diretório de build não existe (${buildDir}). Rode "npm run build:core" primeiro.`
  );
  process.exit(1);
}
const ctestArgs = ["--test-dir", buildDir, "--output-on-failure"];
if (fs.existsSync(cachePath)) {
  const cache = fs.readFileSync(cachePath, "utf8");
  if (cache.includes("CMAKE_CONFIGURATION_TYPES:STRING=")) {
    ctestArgs.push("-C", requestedConfig ?? "Debug");
  }
}

const result = spawnSync("ctest", ctestArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) {
  console.error("[test-core] falha ao executar ctest:", result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);

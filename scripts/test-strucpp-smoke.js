#!/usr/bin/env node
"use strict";

/**
 * Smoke test do binario STruCpp vendorizado (F9.1) -- prova que `node scripts/build-strucpp.js`
 * de fato produz um compilador funcional: compila a fixture core/test/core/plc/fixtures/hello.st
 * ate C++ e confere que a saida referencia TIME()/o TON gerado (prova rasa de que o pipeline
 * ST->C++ funciona, nao uma prova semantica completa -- essa fica pros testes de F9.2 em diante,
 * quando o driver/worker existir).
 *
 * Nao builda o STruCpp nem baixa nada -- rode `node scripts/build-strucpp.js` antes.
 *
 * Uso: node scripts/test-strucpp-smoke.js
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const pin = JSON.parse(fs.readFileSync(path.join(__dirname, "strucpp-pin.json"), "utf8"));

function detectPlatformKey() {
  const archMap = { x64: "x64", arm64: "arm64" };
  const arch = archMap[process.arch];
  if (!arch) return null;
  if (process.platform === "win32") return `win32-${arch}`;
  if (process.platform === "linux") return `linux-${arch}`;
  if (process.platform === "darwin") return `darwin-${arch}`;
  return null;
}

function resolveBinary() {
  if (process.env.LASECSIMUL_STRUCPP_BINARY) return process.env.LASECSIMUL_STRUCPP_BINARY;
  const platformKey = detectPlatformKey();
  const asset = platformKey && pin.assets[platformKey];
  if (!asset) {
    console.error(`[test-strucpp-smoke] plataforma nao suportada: ${process.platform}/${process.arch}`);
    process.exit(1);
  }
  return path.join(repoRoot, "plc", "strucpp", "build", platformKey, asset.binaryPath);
}

const binary = resolveBinary();
if (!fs.existsSync(binary)) {
  console.error(`[test-strucpp-smoke] binario STruCpp nao encontrado em ${binary}.`);
  console.error("[test-strucpp-smoke] rode 'node scripts/build-strucpp.js' primeiro.");
  process.exit(1);
}

const fixture = path.join(repoRoot, "core", "test", "core", "plc", "fixtures", "hello.st");
const outputDir = path.join(repoRoot, "dist", "cache", "strucpp-smoke");
fs.mkdirSync(outputDir, { recursive: true });
const outputCpp = path.join(outputDir, "hello.cpp");
const outputHpp = path.join(outputDir, "hello.hpp");
for (const stale of [outputCpp, outputHpp]) if (fs.existsSync(stale)) fs.rmSync(stale);

console.log(`[test-strucpp-smoke] ${binary} ${fixture} -o ${outputCpp} --debug --source-comments`);
const result = spawnSync(binary, [fixture, "-o", outputCpp, "--debug", "--source-comments"], {
  stdio: "inherit",
  shell: false,
});
if (result.error || result.status !== 0) {
  console.error("[test-strucpp-smoke] FALHA: compilacao ST->C++ nao completou com sucesso.");
  process.exit(1);
}

let failures = 0;
function check(condition, message) {
  if (!condition) {
    console.error(`[test-strucpp-smoke] FAIL: ${message}`);
    failures++;
  }
}

check(fs.existsSync(outputCpp), "hello.cpp nao foi gerado");
check(fs.existsSync(outputHpp), "hello.hpp nao foi gerado");

const cppSource = fs.existsSync(outputCpp) ? fs.readFileSync(outputCpp, "utf8") : "";
const hppSource = fs.existsSync(outputHpp) ? fs.readFileSync(outputHpp, "utf8") : "";

check(cppSource.includes("CURRENT_TIME = TIME()"), "saida gerada nao chama TIME() (achado real de F9: TON deve ler __CURRENT_TIME_NS via TIME(), nunca wall clock)");
check(hppSource.includes("class Program_HELLO : public ProgramBase"), "Program_HELLO nao herda de ProgramBase (contrato de scan esperado por PlcWorkerDriver, F9.2)");
check(hppSource.includes("void run() override"), "Program_HELLO::run() nao encontrado (entrypoint de UM scan que o driver do worker precisa chamar)");

if (failures > 0) {
  console.error(`[test-strucpp-smoke] ${failures} verificacao(oes) falharam.`);
  process.exit(1);
}

console.log("[test-strucpp-smoke] OK: STruCpp vendorizado compila ST->C++ com o contrato de scan esperado.");

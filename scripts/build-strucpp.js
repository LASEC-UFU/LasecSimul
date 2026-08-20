#!/usr/bin/env node
"use strict";

/**
 * Baixa e verifica (hash SHA-256 fixado) o binário oficial do STruCpp (compilador ST->C++17,
 * IEC 61131-3) pra plataforma atual, seguindo o mesmo padrão de download-e-fixação já usado por
 * `downloadVerified()`/`stageTapWindowsPayload()` em `scripts/package-release.js` -- nunca builda
 * STruCpp do zero (é um projeto TypeScript com toolchain próprio, fora de escopo vendorizar/buildar
 * aqui) e nunca commita o binário no git.
 *
 * Fonte única de verdade de versão/asset/hash: `scripts/strucpp-pin.json` (ver ADR-0007,
 * .spec/features/iec61131-plc.md) -- não duplicar esses valores em outro script.
 *
 * Também extrai `runtime/include/*.hpp` do MESMO pacote baixado para `core/src/plc/runtime/`,
 * garantindo que os headers de runtime vendorizados venham sempre da mesma build que o
 * compilador (nunca buscados separadamente da árvore git do STruCpp).
 *
 * Uso: node scripts/build-strucpp.js [--platform <win32-x64|linux-x64|...>]
 */

const { spawnSync } = require("child_process");
const crypto = require("crypto");
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

const platformArg = process.argv.find((arg) => arg.startsWith("--platform="));
const platformKey = platformArg ? platformArg.slice("--platform=".length) : detectPlatformKey();

if (!platformKey || !pin.assets[platformKey]) {
  console.error(
    `[build-strucpp] plataforma nao suportada ou nao reconhecida: ${platformKey ?? `${process.platform}/${process.arch}`}. ` +
      `Plataformas conhecidas: ${Object.keys(pin.assets).join(", ")}`
  );
  process.exit(1);
}

const asset = pin.assets[platformKey];
const cacheDir = path.join(repoRoot, "dist", "cache", "strucpp", pin.version);
const archivePath = path.join(cacheDir, asset.file);
const extractDir = path.join(repoRoot, "plc", "strucpp", "build", platformKey);
const runtimeIncludeDest = path.join(repoRoot, "core", "src", "plc", "runtime", "include");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(command, args, options = {}) {
  console.log(`[build-strucpp] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", shell: false, ...options });
  if (result.error) {
    console.error(`[build-strucpp] falha ao executar ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[build-strucpp] '${command} ${args.join(" ")}' saiu com codigo ${result.status}`);
    process.exit(result.status === null ? 1 : result.status);
  }
}

function downloadVerified(url, destination, expectedSha256) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination) || sha256(destination) !== expectedSha256) {
    if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
    run(process.platform === "win32" ? "curl.exe" : "curl", ["--fail", "--location", "--output", destination, url]);
  }
  const actual = sha256(destination);
  if (actual !== expectedSha256) {
    console.error(
      `[build-strucpp] SHA-256 invalido para ${path.basename(destination)}: esperado ${expectedSha256}, obtido ${actual}. ` +
        "Pacote corrompido/adulterado, ou scripts/strucpp-pin.json esta desatualizado -- nao prosseguindo."
    );
    process.exit(1);
  }
}

downloadVerified(asset.url, archivePath, asset.sha256);

fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
// bsdtar extrai .zip e .tar.gz pelo mesmo comando -- mesmo utilitario ja usado em
// package-release.js pra extrair o payload .zip do TAP-Windows6. Achado real: rodando este script
// via Git Bash no Windows, `tar.exe` resolvido por PATH pode ser o GNU tar de /usr/bin/ (bundlado
// com o Git for Windows) em vez do bsdtar nativo do System32 -- GNU tar nao entende .zip ("This
// does not look like a tar archive") e, pior, interpreta um caminho `C:\...` como sintaxe remota
// `host:path` ("Cannot connect to C: resolve failed"). Resolver o bsdtar do System32 explicitamente
// no Windows evita os dois problemas, sem depender de qual `tar.exe` o shell de quem chama coloca
// primeiro no PATH.
function resolveTarCommand() {
  if (process.platform !== "win32") return "tar";
  const systemTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return fs.existsSync(systemTar) ? systemTar : "tar.exe";
}
run(resolveTarCommand(), ["-xf", archivePath, "-C", extractDir]);

const binaryPath = path.join(extractDir, asset.binaryPath);
if (!fs.existsSync(binaryPath)) {
  console.error(`[build-strucpp] binario esperado nao encontrado apos extracao: ${binaryPath}`);
  process.exit(1);
}

// Headers de runtime vendorizados a partir do MESMO pacote (nunca da arvore git separada) --
// preserva o cabecalho SPDX/copyright de cada arquivo, so copia (nunca reescreve).
const runtimeIncludeSrc = path.join(path.dirname(binaryPath), "runtime", "include");
if (fs.existsSync(runtimeIncludeSrc)) {
  fs.rmSync(runtimeIncludeDest, { recursive: true, force: true });
  fs.mkdirSync(runtimeIncludeDest, { recursive: true });
  for (const entry of fs.readdirSync(runtimeIncludeSrc, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(runtimeIncludeSrc, entry.name), path.join(runtimeIncludeDest, entry.name));
  }
  console.log(`[build-strucpp] runtime headers vendorizados em ${runtimeIncludeDest} (${fs.readdirSync(runtimeIncludeDest).length} arquivos)`);
}

// Licencas preservadas junto do binario extraido -- exigido por ADR-0007 (COPYING/COPYING.RUNTIME
// originais junto ao binario relocavel, mesmo padrao ja usado pro payload do TAP-Windows6).
const strucppRoot = path.dirname(binaryPath);
for (const licenseFile of ["COPYING", "COPYING.RUNTIME", "LICENSE"]) {
  const src = path.join(strucppRoot, licenseFile);
  if (!fs.existsSync(src)) {
    console.warn(`[build-strucpp] AVISO: ${licenseFile} nao encontrado no pacote extraido -- verificar release upstream.`);
  }
}

console.log(`[build-strucpp] binario STruCpp ${pin.version} (${platformKey}) pronto em ${binaryPath}`);
console.log(`[build-strucpp] defina LASECSIMUL_STRUCPP_BINARY=${binaryPath} para uso local, ou deixe o resolvedor padrao encontra-lo em plc/strucpp/build/${platformKey}/`);

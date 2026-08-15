#!/usr/bin/env node
"use strict";

/**
 * Compila fpga/ghdl-vpi/lasecsimul_vpi.c num binario carregavel por `ghdl -r ... --vpi=...`.
 *
 * Diferente de build-devices.js/build-mcu-adapters.js (que usam CMake + MSVC), este script NAO
 * usa CMake nem MSVC -- GHDL (pelo menos a build winget.ghdl.ucrt64.mcode usada no Spike 0, ver
 * .claude/plans/golden-puzzling-quasar.md) distribui `libghdlvpi` como biblioteca de importacao
 * MinGW/UCRT; MSVC nao consegue linkar contra ela de forma confiavel. O modulo VPI e carregado
 * pelo processo GHDL, nao pelo PluginLoader do Core -- entao seu toolchain e independente do
 * resto do projeto (mesma logica de por que McuController nao exige que o binario QEMU vendorizado
 * seja MSVC).
 *
 * Toolchain esperado: `ghdl` e um `gcc` compativel (mesma familia MinGW/UCRT do GHDL -- testado
 * com WinLibs UCRT no Spike 0) no PATH, ou apontados via LASECSIMUL_GHDL_PATH/LASECSIMUL_FPGA_VPI_CC.
 *
 * Uso: node scripts/build-fpga-vpi.js
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const vpiDir = path.join(repoRoot, "fpga", "ghdl-vpi");
const sourcePath = path.join(vpiDir, "lasecsimul_vpi.c");
const includeDir = path.join(repoRoot, "core", "include");

const platformTarget = {
  win32: { dir: "win-x64", file: "lasecsimul_vpi.dll" },
  linux: { dir: "linux-x64", file: "liblasecsimul_vpi.so" },
  darwin: { dir: "macos-universal", file: "liblasecsimul_vpi.dylib" },
}[process.platform];

if (!platformTarget) {
  console.error(`[build-fpga-vpi] plataforma nao suportada: ${process.platform}`);
  process.exit(1);
}

function resolveGhdlCommand() {
  return process.env.LASECSIMUL_GHDL_PATH || "ghdl";
}

function resolveCcCommand() {
  return process.env.LASECSIMUL_FPGA_VPI_CC || "gcc";
}

function run(command, args, options = {}) {
  console.log(`[build-fpga-vpi] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"], shell: false, ...options });
  if (result.error) {
    console.error(`[build-fpga-vpi] falha ao executar ${command}: ${result.error.message}`);
    if (result.error.code === "ENOENT") {
      console.error(
        `[build-fpga-vpi] '${command}' nao encontrado no PATH. Instale GHDL (winget install ghdl.ghdl.ucrt64.mcode ` +
          "ou equivalente) e um GCC MinGW/UCRT compativel, ou configure LASECSIMUL_GHDL_PATH/LASECSIMUL_FPGA_VPI_CC."
      );
    }
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[build-fpga-vpi] '${command} ${args.join(" ")}' saiu com codigo ${result.status}`);
    process.exit(result.status === null ? 1 : result.status);
  }
  return result.stdout.toString("utf8").trim();
}

function ghdlFlag(ghdl, flag) {
  return run(ghdl, [flag]);
}

const ghdl = resolveGhdlCommand();
const cc = resolveCcCommand();

const vpiCflags = ghdlFlag(ghdl, "--vpi-cflags");
const vpiLdflags = ghdlFlag(ghdl, "--vpi-ldflags");
const vpiLibraryDir = ghdlFlag(ghdl, "--vpi-library-dir");

const destDir = path.join(vpiDir, "build", platformTarget.dir);
fs.mkdirSync(destDir, { recursive: true });
const destPath = path.join(destDir, platformTarget.file);

const compileArgs = [
  ...vpiCflags.split(/\s+/).filter(Boolean),
  "-I", includeDir,
  "-Wall",
  "-O2",
];
if (process.platform === "win32") {
  // Mesma licao documentada em build-mcu-adapters.js: um build MinGW puro pode importar
  // libgcc/libwinpthread que nao existem numa instalacao normal, quebrando o carregamento em
  // silencio. -static-libgcc remove essa dependencia; este modulo nao usa threads (loop de
  // comando roda dentro do proprio callback VPI, ver comentario de topo de lasecsimul_vpi.c),
  // entao libwinpthread nunca chega a ser referenciada em primeiro lugar.
  compileArgs.push("-static-libgcc");
}
compileArgs.push("-o", destPath, sourcePath, ...vpiLdflags.split(/\s+/).filter(Boolean));

run(cc, compileArgs);

if (process.platform === "win32") {
  const binaryText = fs.readFileSync(destPath).toString("latin1");
  const forbidden = ["libwinpthread-1.dll", "libstdc++-6.dll", "libgcc_s_seh-1.dll"].filter((dependency) =>
    binaryText.toLowerCase().includes(dependency.toLowerCase())
  );
  if (forbidden.length > 0) {
    console.error(
      `[build-fpga-vpi] lasecsimul_vpi.dll depende de runtime MinGW nao redistribuivel: ${forbidden.join(", ")}`
    );
    process.exit(1);
  }

  // O processo GHDL busca `libghdlvpi.dll` (import do nosso modulo) no diretorio do proprio
  // modulo VPI carregado -- confirmado empiricamente no Spike 0 (LoadLibrary falhava com "modulo
  // nao encontrado" ate copiar essa DLL pro lado da nossa). Copiar aqui deixa build/win-x64/
  // autocontido; quem lanca o processo (GhdlProcessManager/FpgaController, Step 5) ainda decide
  // como apontar PATH/cwd em producao.
  if (vpiLibraryDir) {
    const libghdlvpiSrc = path.join(vpiLibraryDir, "libghdlvpi.dll");
    if (fs.existsSync(libghdlvpiSrc)) {
      fs.copyFileSync(libghdlvpiSrc, path.join(destDir, "libghdlvpi.dll"));
    } else {
      console.warn(`[build-fpga-vpi] AVISO: libghdlvpi.dll nao encontrada em ${vpiLibraryDir}`);
    }
  }
}

console.log(`[build-fpga-vpi] ${sourcePath} -> ${destPath}`);

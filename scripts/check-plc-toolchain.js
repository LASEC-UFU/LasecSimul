#!/usr/bin/env node
"use strict";

/**
 * Gate de toolchain nativo do pipeline PLC (F9) num checkout de desenvolvimento. O STruCpp (ver
 * scripts/build-strucpp.js) só gera C++17; o executável do worker sai de um compilador C++.
 *
 * Instalação (VSIX): o Windows leva um g++ mínimo do MSYS2 UCRT64 em bundled/plc/ucrt64
 * (scripts/stage-plc-toolchain.js, verificado com PATH limpo); o .deb depende do g++ do sistema.
 * Desenvolvimento: LASECSIMUL_PLC_CXX, o MSYS2 em ../tools/msys64/ucrt64 (o que a extensão usa,
 * extension/src/plc/plcBuild.ts::resolvePlcToolchain) ou g++/gcc no PATH.
 *
 * Uso: node scripts/check-plc-toolchain.js
 * Saida: exit 0 + caminho do compilador encontrado, ou exit 1 + diagnostico.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");

function isCompilerAvailable(command) {
  const env = { ...process.env };
  if (path.isAbsolute(command)) env.PATH = `${path.dirname(command)}${path.delimiter}${env.PATH || ""}`;
  const result = spawnSync(command, ["--version"], { stdio: "ignore", shell: false, env });
  return !result.error && result.status === 0;
}

const msysGxx = path.resolve(repoRoot, "..", "tools", "msys64", "ucrt64", "bin", "g++.exe");
const candidates = [
  process.env.LASECSIMUL_PLC_CXX,
  process.platform === "win32" && fs.existsSync(msysGxx) ? msysGxx : undefined,
  "g++",
  "gcc",
].filter(Boolean);
const found = candidates.find((command) => isCompilerAvailable(command));

if (!found) {
  console.error(
    "[check-plc-toolchain] Nenhum compilador C++ compativel com o STruCpp encontrado " +
      `(tentado: ${candidates.join(", ")}).\n` +
      "[check-plc-toolchain] Windows: instale o MSYS2 (pacote mingw-w64-ucrt-x86_64-gcc) em ../tools/msys64 " +
      "ou configure LASECSIMUL_PLC_CXX. Linux: instale g++.\n" +
      "[check-plc-toolchain] A instalacao empacotada nao precisa disto: o Windows leva bundled/plc/ucrt64 " +
      "(scripts/stage-plc-toolchain.js) e o .deb depende de g++."
  );
  process.exit(1);
}

console.log(`[check-plc-toolchain] compilador C++ compativel encontrado: ${found}`);
process.exit(0);

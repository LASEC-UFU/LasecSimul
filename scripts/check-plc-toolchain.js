#!/usr/bin/env node
"use strict";

/**
 * Gate de toolchain nativo pro pipeline PLC (F9). O binario vendorizado do STruCpp (ver
 * scripts/build-strucpp.js) compila ST pra C++17 texto -- ele mesmo NAO empacota nenhum
 * compilador C++ (confirmado lendo src/node/build-utils.ts::isCompilerAvailable() no
 * codigo-fonte real do STruCpp: so faz `execFileSync(cmd, ["--version"])`, assume g++/cc no PATH).
 * Uma instalacao limpa do LasecSimul (Windows sem MSYS2/MinGW/VS Build Tools) NAO tem hoje como
 * compilar o C++ gerado ate um PlcNativeModule.
 *
 * Este script e o gate explicito e testavel dessa dependencia (ver plano F9 Rodada 1, secao 3):
 * falha com diagnostico claro e acionavel quando nenhum compilador compativel e encontrado, em vez
 * de deixar PlcCompiler (F9.3) falhar de forma confusa mais tarde. NAO baixa/bundla nenhum
 * compilador -- decisao de empacotamento (ex.: MinGW-w64 bundled no Windows, mesmo precedente do
 * modulo VPI da FPGA) fica registrada como pendente, nao implementada aqui.
 *
 * Uso: node scripts/check-plc-toolchain.js
 * Saida: exit 0 + caminho do compilador encontrado, ou exit 1 + diagnostico.
 */

const { spawnSync } = require("child_process");

function isCompilerAvailable(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", shell: false });
  return !result.error && result.status === 0;
}

const candidates = [process.env.LASECSIMUL_PLC_CXX, "g++", "gcc"].filter(Boolean);
const found = candidates.find((command) => isCompilerAvailable(command));

if (!found) {
  console.error(
    "[check-plc-toolchain] Nenhum compilador C++ compativel com o STruCpp encontrado " +
      `(tentado: ${candidates.join(", ")}).\n` +
      "[check-plc-toolchain] O STruCpp (compilador ST->C++17) nao empacota toolchain proprio -- " +
      "assume g++/gcc no PATH (--gpp/--cc, ver src/node/cli.ts do STruCpp).\n" +
      "[check-plc-toolchain] Instale um MinGW-w64/UCRT (ex.: winget install BrechtSanders.WinLibs.POSIX.UCRT " +
      "no Windows) ou configure LASECSIMUL_PLC_CXX apontando pro compilador.\n" +
      "[check-plc-toolchain] PENDENTE (nao implementado nesta rodada): bundlar um MinGW-w64 relocavel " +
      "junto do instalador do LasecSimul, mesmo precedente ja usado pro modulo VPI da FPGA " +
      "(package-installers.yml, passo \"Setup MSYS2 toolchain\") -- ver plano F9 Rodada 1, secao 3."
  );
  process.exit(1);
}

console.log(`[check-plc-toolchain] compilador C++ compativel encontrado: ${found}`);
process.exit(0);

#!/usr/bin/env node
"use strict";

/**
 * Recompila tudo que o Extension Development Host carrega durante o F5.
 *
 * Compilar apenas o TypeScript deixa DLLs antigas no Core, nos devices e nos
 * adaptadores de MCU. Isso é especialmente enganoso em mudanças de GPIO/I2C:
 * a interface nova aparece, mas a simulação continua executando código nativo
 * anterior.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

function run(command, args, cwd = repoRoot) {
  console.log(`[build-development] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`[build-development] falha ao executar ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const node = process.execPath;
run(node, [path.join("scripts", "build-core.js"), "--config", "Release", "--target", "lasecsimul-core"]);
run(node, [path.join("scripts", "build-devices.js"), "--config", "Release"]);
run(node, [path.join("scripts", "build-mcu-adapters.js"), "--config", "Release"]);
run(node, [path.join("scripts", "compile.js")], path.join(repoRoot, "extension"));

console.log("[build-development] F5 pronto: Core, devices, adaptadores e extensão estão atualizados.");

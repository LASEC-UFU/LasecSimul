#!/usr/bin/env node
"use strict";

/** Gate pós-empacotamento: prova que o Core compila/descobre/executa VHDL usando o GHDL copiado
 * para dentro da extensão, não o GHDL do runner por acidente. */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const target = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-x64" : "linux-x64";
const binaryName = process.platform === "win32" ? "ghdl.exe" : "ghdl";
const stagedBin = path.join(repoRoot, "dist", "staging", target, "extension", "bundled", "fpga", "ghdl", "bin");
const ghdl = path.join(stagedBin, binaryName);
const test = process.platform === "win32"
  ? path.join(repoRoot, "core", "build", "Release", "ghdl_backend_real_ghdl_test.exe")
  : path.join(repoRoot, "core", "build", "ghdl_backend_real_ghdl_test");

for (const [description, file] of [["GHDL integrado", ghdl], ["teste real do backend", test]]) {
  if (!fs.existsSync(file)) throw new Error(`${description} não encontrado: ${file}`);
}

function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { cwd: repoRoot, stdio: "inherit", env, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(ghdl, ["--version"]);
run(test, [], { ...process.env, PATH: `${stagedBin}${path.delimiter}${process.env.PATH || ""}` });
console.log(`[bundled-ghdl] OK: runtime relocável validado em ${stagedBin}`);

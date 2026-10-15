#!/usr/bin/env node
"use strict";

/**
 * Empacota o frontend do OpenPLC Editor (versão em scripts/openplc-workspace-pin.json) para rodar
 * dentro do LasecSimul: Webview (editores LD/FBD/ST/IL, explorer, variáveis, bibliotecas) e o
 * pacote do host (serviços de projeto/POU/biblioteca e transpilador), a partir do código-fonte
 * oficial na tag fixada, mais os arquivos de plc/openplc-workspace/overlay copiados em
 * `src/lasecsimul/`. Nada do OpenPLC é commitado aqui: só o overlay e este script.
 *
 * Saída: extension/media/openplc-workspace/{webview,host}/ (fora do git).
 *
 * Uso: node scripts/build-openplc-workspace.js [--source <árvore do OpenPLC já clonada>] [--dev] [--only host|webview]
 *   OPENPLC_EDITOR_SRC também indica a árvore. Sem nada, clona em dist/cache/openplc-editor/<tag>.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const pin = JSON.parse(fs.readFileSync(path.join(__dirname, "openplc-workspace-pin.json"), "utf8"));
const overlayDir = path.join(repoRoot, "plc", "openplc-workspace", "overlay");
const outDir = path.join(repoRoot, "extension", "media", "openplc-workspace");

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

const development = process.argv.includes("--dev");
const sourceDir = path.resolve(argValue("--source") || process.env.OPENPLC_EDITOR_SRC ||
  path.join(repoRoot, "dist", "cache", "openplc-editor", pin.tag));

function run(command, args, options = {}) {
  const shown = [command, ...args].join(" ");
  console.log(`[build-openplc-workspace] ${shown}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) {
    throw new Error(`falhou (${result.status ?? result.signal}): ${shown}`);
  }
}

function output(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function ensureSource() {
  if (!fs.existsSync(path.join(sourceDir, "package.json"))) {
    fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
    run("git", ["clone", "--depth", "1", "--branch", pin.tag, pin.repository, sourceDir]);
  }
  const head = output("git", ["rev-parse", "HEAD"], sourceDir);
  if (head && head !== pin.commit) {
    throw new Error(`${sourceDir} está em ${head}, esperado ${pin.commit} (${pin.tag}).`);
  }
}

function ensureDependencies() {
  const lock = path.join(sourceDir, "package-lock.json");
  const stamp = path.join(sourceDir, "node_modules", ".lasecsimul-lock");
  const lockStat = fs.statSync(lock);
  const wanted = `${lockStat.size}:${pin.commit}`;
  if (!fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== wanted) {
    // O package.json do OpenPLC pede Node <24 e roda postinstall do Electron (rebuild nativo);
    // nada disso é usado aqui: só os pacotes JavaScript do frontend.
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--engine-strict=false"], { cwd: sourceDir });
    fs.writeFileSync(stamp, wanted);
  }
  // Pacotes que o OpenPLC não traz no package-lock: a STruC++ (worker do LSP de ST; o OpenPLC baixa
  // o mesmo .tgz em scripts/download-binaries.ts) e as fontes Inter/Poppins (o OpenPLC as busca no
  // Google Fonts, que a CSP da Webview não deixa carregar). Tudo num único `npm install --no-save`:
  // installs separados apagam o que o anterior trouxe.
  const strucppVersion = pin.strucppNpm.replace(/^v/, "");
  const extras = {
    strucpp: [strucppVersion, `https://github.com/Autonomy-Logic/STruCpp/releases/download/${pin.strucppNpm}/strucpp-${strucppVersion}.tgz`],
    "@fontsource/inter": [pin.fonts.inter, `@fontsource/inter@${pin.fonts.inter}`],
    "@fontsource/poppins": [pin.fonts.poppins, `@fontsource/poppins@${pin.fonts.poppins}`],
  };
  const installedVersion = (name) => {
    const file = path.join(sourceDir, "node_modules", ...name.split("/"), "package.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).version : "";
  };
  if (Object.entries(extras).some(([name, [version]]) => installedVersion(name) !== version)) {
    run("npm", ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--engine-strict=false",
      ...Object.values(extras).map(([, spec]) => spec)], { cwd: sourceDir });
  }
}

function copyOverlay() {
  const target = path.join(sourceDir, "src", "lasecsimul");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(overlayDir, target, { recursive: true });
}

function bundle() {
  const webpackCli = path.join(sourceDir, "node_modules", "webpack", "bin", "webpack.js");
  const env = {
    ...process.env,
    NODE_ENV: development ? "development" : "production",
    LASECSIMUL_OPENPLC_OUT: outDir,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=8192"].filter(Boolean).join(" "),
  };
  const only = argValue("--only");
  const configs = ["webpack.host.cjs", "webpack.webview.cjs"].filter((config) => !only || config.includes(only));
  for (const config of configs) {
    run(process.execPath, [webpackCli, "--config", path.join("src", "lasecsimul", config)], { cwd: sourceDir, env, shell: false });
  }
  fs.writeFileSync(path.join(outDir, "build-info.json"), `${JSON.stringify({
    openplcEditor: pin.tag,
    commit: pin.commit,
    mode: development ? "development" : "production",
    builtAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

try {
  ensureSource();
  ensureDependencies();
  copyOverlay();
  bundle();
  console.log(`[build-openplc-workspace] pronto em ${outDir}`);
} catch (error) {
  console.error(`[build-openplc-workspace] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

#!/usr/bin/env node
"use strict";

/**
 * Gate pos-empacotamento que prova o handshake VNEXT_B completo sobre o VSIX FINAL, nao apenas
 * `qemu --version`. Fato que motivou este gate (v0.0.30): `verifyWindowsQemuWithCleanPath` em
 * package-release.js (e o passo homonimo do workflow) so provam que o QEMU carrega seus imports PE
 * estaticos -- nunca abriram `esp32-simul`, nunca criaram a mapping/eventos nomeados do vNext-B,
 * nunca observaram `artifact_state=READY`. Um pacote pode passar esse gate e ainda falhar no
 * handshake real (ABI incompativel, ROM ausente, DLL carregada so' dinamicamente por aquele caminho
 * de codigo, etc.).
 *
 * Este script:
 *   1. Reextrai o VSIX FINAL (nao dist/staging) para um caminho com espaco, fora do repositorio;
 *   2. valida o manifesto LASECSIMUL-QEMU-RUNTIME.json contra os arquivos fisicos extraidos;
 *   3. roda `--version`/`-machine help` com PATH limpo, igual ao gate antigo;
 *   4. roda o handshake vNext-B real (mapping/eventos nomeados, ABI v5, READY, RUNNING, GPIO/UART)
 *      usando o QEMU e as ROMs extraidos do VSIX, via vnext_b_attachment_test.exe;
 *   5. confirma que o Core empacotado (lasecsimul-core.exe) tambem carrega com PATH limpo;
 *   6. imprime os hashes efetivamente executados e garante teardown sem processo orfao.
 *
 * Uso: node scripts/test-bundled-qemu-vnext.js [caminho-para-o.vsix]
 * Sem argumento, resolve o VSIX final de dist/release/win32-x64 a partir de extension/package.json.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");

if (process.platform !== "win32") {
  console.log("[test-bundled-qemu-vnext] plataforma != win32: runtime QEMU/vNext-B e' Windows-only, nada a validar aqui.");
  process.exit(0);
}

const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
const cleanEnv = {
  SystemRoot: windowsRoot,
  WINDIR: windowsRoot,
  ComSpec: process.env.ComSpec || path.join(windowsRoot, "System32", "cmd.exe"),
  PATH: [path.join(windowsRoot, "System32"), windowsRoot].join(path.delimiter),
};
const tarExe = path.join(windowsRoot, "System32", "tar.exe");

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function fail(message) {
  console.error(`[test-bundled-qemu-vnext] FALHA: ${message}`);
  process.exit(1);
}

function ensureFile(filePath, description) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`${description} nao encontrado: ${filePath}`);
  }
}

function resolveVsixPath() {
  const override = process.argv[2];
  if (override) return path.resolve(override);
  const extensionPackage = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "extension", "package.json"), "utf8")
  );
  const version = extensionPackage.version || "0.0.0";
  return path.join(
    repoRoot, "dist", "release", "win32-x64",
    `${extensionPackage.name}-${version}-win32-x64.vsix`
  );
}

function extractVsix(vsixPath) {
  // Caminho com espaco e fora do repositorio de proposito: reproduz uma instalacao real do VS
  // Code (ex.: "C:\Users\<nome com espaco>\.vscode\extensions\...") em vez do ambiente de build.
  const workDir = path.join(
    os.tmpdir(),
    `LasecSimul VNEXT Gate ${process.pid}-${Date.now()}`
  );
  fs.mkdirSync(workDir, { recursive: true });
  const result = spawnSync(tarExe, ["-xf", vsixPath, "-C", workDir], {
    encoding: "utf8", windowsHide: true, shell: false, env: cleanEnv,
  });
  if (result.error || result.status !== 0) {
    fail(`nao foi possivel reextrair o VSIX final (${vsixPath}): ${result.error ? result.error.message : result.stderr}`);
  }
  return workDir;
}

function verifyRuntimeManifest(qemuBinDir) {
  const manifestPath = path.join(qemuBinDir, "LASECSIMUL-QEMU-RUNTIME.json");
  ensureFile(manifestPath, "manifesto LASECSIMUL-QEMU-RUNTIME.json (VSIX reextraido)");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const declared = String(manifest.sha256 || "").toUpperCase();

  const orchestratorManifestPath = path.join(repoRoot, "orchestrator", ".ai", "QEMU_RUNTIME.json");
  const orchestratorManifest = JSON.parse(fs.readFileSync(orchestratorManifestPath, "utf8"));
  const canonical = String(orchestratorManifest.canonical_executable_sha256 || "").toUpperCase();
  if (declared !== canonical) {
    fail(
      `QEMU embutido no VSIX final nao e' o runtime certificado: ` +
      `manifesto=${declared} canonico(orchestrator/.ai/QEMU_RUNTIME.json)=${canonical}`
    );
  }

  if (!Array.isArray(manifest.runtime_files) || manifest.runtime_files.length === 0) {
    fail("manifesto LASECSIMUL-QEMU-RUNTIME.json sem runtime_files[]");
  }
  for (const entry of manifest.runtime_files) {
    const filePath = path.join(qemuBinDir, entry.name);
    ensureFile(filePath, `arquivo do runtime QEMU declarado no manifesto (${entry.name})`);
    const actual = sha256(filePath);
    if (actual.toLowerCase() !== String(entry.sha256).toLowerCase()) {
      fail(`hash divergente no VSIX final para ${entry.name}: manifesto=${entry.sha256} atual=${actual}`);
    }
  }
  console.log(`[test-bundled-qemu-vnext] manifesto OK: ${manifest.runtime_files.length} arquivo(s), qemu sha256=${declared}`);
  return declared;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8", windowsHide: true, shell: false, env: cleanEnv, timeout: 120000, ...options,
  });
  return result;
}

function verifyVersionAndMachineHelp(qemuPath, qemuBinDir) {
  const versionResult = run(qemuPath, ["--version"], { cwd: qemuBinDir });
  if (versionResult.error || versionResult.status !== 0) {
    const status = versionResult.status === null ? "unavailable" : `0x${(versionResult.status >>> 0).toString(16)}`;
    fail(`qemu-system-xtensa.exe --version falhou com PATH limpo: exit=${status} ${versionResult.stderr || ""}`);
  }
  console.log(`[test-bundled-qemu-vnext] --version OK: ${String(versionResult.stdout).trim().split("\n")[0]}`);

  const machineHelpResult = run(qemuPath, ["-machine", "help"], { cwd: qemuBinDir });
  if (machineHelpResult.error || machineHelpResult.status !== 0) {
    fail(`qemu-system-xtensa.exe -machine help falhou com PATH limpo: ${machineHelpResult.stderr || ""}`);
  }
  if (!/^esp32-simul\s/m.test(String(machineHelpResult.stdout))) {
    fail("qemu-system-xtensa.exe -machine help nao lista 'esp32-simul' -- layout/build do QEMU incorreto");
  }
  console.log("[test-bundled-qemu-vnext] -machine help OK: esp32-simul presente");
}

function verifyRoms(qemuBinDir) {
  const romDir = path.join(qemuBinDir, "esp32", "rom", "bin");
  for (const romFile of ["esp32-v3-rom.bin", "esp32-v3-rom-app.bin"]) {
    ensureFile(path.join(romDir, romFile), `ROM ESP32 empacotada (${romFile})`);
  }
  console.log(`[test-bundled-qemu-vnext] ROMs OK em ${romDir}`);
  return romDir;
}

function locateAttachmentTest() {
  const candidate = path.join(repoRoot, "core", "build", "Release", "vnext_b_attachment_test.exe");
  if (!fs.existsSync(candidate)) {
    fail(
      `vnext_b_attachment_test.exe nao encontrado (${candidate}). ` +
      "Rode 'node scripts/build-core.js --config Release --target vnext_b_attachment_test' antes deste gate."
    );
  }
  return candidate;
}

function verifyVnextBHandshake(qemuPath, romDir, workDir) {
  const attachmentTest = locateAttachmentTest();
  const result = run(attachmentTest, [], {
    cwd: workDir,
    env: { ...cleanEnv, LASECSIMUL_TEST_QEMU_BINARY: qemuPath, LASECSIMUL_ESP32_ROM_DIR: romDir },
    timeout: 180000,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.error) fail(`vnext_b_attachment_test nao executou: ${result.error.message}`);
  if (/\bSKIP\b/.test(output)) {
    fail(
      "vnext_b_attachment_test reportou SKIP -- isso significa que o teste NAO usou o QEMU do VSIX " +
      `(fallback silencioso proibido neste gate). Saida:\n${output}`
    );
  }
  if (result.status !== 0) {
    fail(`vnext_b_attachment_test falhou (exit=${result.status}) contra o QEMU do VSIX final:\n${output}`);
  }
  if (!/\bPASS\b/.test(output)) {
    fail(`vnext_b_attachment_test terminou com exit=0 mas sem nenhum PASS visivel -- saida suspeita:\n${output}`);
  }
  const passCount = (output.match(/\bPASS\b/g) || []).length;
  console.log(`[test-bundled-qemu-vnext] handshake vNext-B real OK: ${passCount} etapa(s) PASS (mapping/eventos nomeados, ABI v5, READY, RUNNING, GPIO/UART)`);
}

function verifyPackagedCoreLoads(extensionDir, workDir) {
  const corePath = path.join(extensionDir, "bundled", "core", "build", "Release", "lasecsimul-core.exe");
  ensureFile(corePath, "Core empacotado (lasecsimul-core.exe)");
  const coreSha256 = sha256(corePath);
  const pipeName = `lasecsimul-gate-${process.pid}-${Date.now()}`;
  return new Promise((resolve) => {
    const child = spawn(corePath, ["--pipe", pipeName], {
      cwd: workDir, env: cleanEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let exited = false;
    let exitInfo = null;
    child.on("exit", (code, signal) => { exited = true; exitInfo = { code, signal }; });
    child.on("error", (err) => { exited = true; exitInfo = { error: err.message }; });
    setTimeout(() => {
      if (exited) {
        const detail = exitInfo && exitInfo.error
          ? exitInfo.error
          : `code=${exitInfo ? exitInfo.code : "?"} hex=0x${((exitInfo && exitInfo.code) >>> 0).toString(16)}`;
        fail(`Core empacotado (lasecsimul-core.exe) terminou sozinho em <1.5s com PATH limpo (${detail}) -- provavel DLL/loader ausente`);
      }
      console.log(`[test-bundled-qemu-vnext] Core empacotado OK: permaneceu vivo com PATH limpo, sha256=${coreSha256}`);
      // TerminateProcess() (Node kill() no Windows) e' assincrono: o processo so' some da tabela
      // do SO alguns ms depois. Sem esperar o proprio evento 'exit', verifyNoOrphans() logo em
      // seguida podia flagar este MESMO processo como orfao (falso positivo, visto ao vivo).
      child.once("exit", () => resolve(coreSha256));
      child.kill();
      setTimeout(() => resolve(coreSha256), 5000);
    }, 1500);
  });
}

function verifyNoOrphans() {
  const result = spawnSync("tasklist.exe", ["/fo", "csv", "/nh"], { encoding: "utf8", env: cleanEnv });
  const lines = String(result.stdout || "").split("\n");
  const orphans = lines.filter((line) => /qemu-system-xtensa\.exe|lasecsimul-core\.exe/i.test(line));
  if (orphans.length > 0) {
    fail(`processo(s) orfao(s) apos teardown do gate:\n${orphans.join("\n")}`);
  }
  console.log("[test-bundled-qemu-vnext] teardown OK: zero processos orfaos (qemu-system-xtensa.exe / lasecsimul-core.exe)");
}

async function main() {
  const vsixPath = resolveVsixPath();
  ensureFile(vsixPath, "VSIX final (dist/release/win32-x64)");
  const vsixSha256 = sha256(vsixPath);
  console.log(`[test-bundled-qemu-vnext] VSIX final: ${vsixPath} sha256=${vsixSha256}`);

  const workDir = extractVsix(vsixPath);
  console.log(`[test-bundled-qemu-vnext] reextraido em caminho com espaco, fora do repositorio: ${workDir}`);
  try {
    const extensionDir = path.join(workDir, "extension");
    const qemuBinDir = path.join(extensionDir, "bundled", "devices", "qemu-esp32", "bin");
    const qemuPath = path.join(qemuBinDir, "qemu-system-xtensa.exe");
    ensureFile(qemuPath, "qemu-system-xtensa.exe (VSIX reextraido)");

    const qemuSha256 = verifyRuntimeManifest(qemuBinDir);
    verifyVersionAndMachineHelp(qemuPath, qemuBinDir);
    const romDir = verifyRoms(qemuBinDir);
    verifyVnextBHandshake(qemuPath, romDir, workDir);
    const coreSha256 = await verifyPackagedCoreLoads(extensionDir, workDir);
    verifyNoOrphans();

    console.log("[test-bundled-qemu-vnext] hashes efetivamente executados:");
    console.log(`  vsix=${vsixSha256}`);
    console.log(`  qemu-system-xtensa.exe=${qemuSha256.toLowerCase()}`);
    console.log(`  lasecsimul-core.exe=${coreSha256}`);
    console.log("[test-bundled-qemu-vnext] OK: handshake vNext-B completo validado sobre o VSIX final");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack || error.message : String(error));
});

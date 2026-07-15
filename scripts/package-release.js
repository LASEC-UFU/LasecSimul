#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const extensionDir = path.join(repoRoot, "extension");
const extensionPackageJsonPath = path.join(extensionDir, "package.json");
const extensionPackage = JSON.parse(fs.readFileSync(extensionPackageJsonPath, "utf8"));

const packageName = "lasecsimul-vscode-extension";
const packageDescription = extensionPackage.description || "LasecSimul VS Code extension";
const packageVersion = extensionPackage.version || "0.0.0";

const targets = {
  win32: {
    vsceTarget: "win32-x64",
    coreBinaryName: "lasecsimul-core.exe",
    nativeInstallerExtension: ".exe",
    nativeInstallerName: `${extensionPackage.name}-${packageVersion}-win32-x64-setup.exe`,
  },
  linux: {
    vsceTarget: "linux-x64",
    coreBinaryName: "lasecsimul-core",
    nativeInstallerExtension: ".deb",
    nativeInstallerName: `${packageName}_${packageVersion}_amd64.deb`,
  },
};

const target = targets[process.platform];
if (!target) {
  console.error(`[package-release] plataforma nao suportada para empacotamento: ${process.platform}`);
  process.exit(1);
}

const releaseRoot = path.join(repoRoot, "dist", "release", target.vsceTarget);
const stagingRoot = path.join(repoRoot, "dist", "staging", target.vsceTarget);
const stagingExtensionDir = path.join(stagingRoot, "extension");
const bundledRoot = path.join(stagingExtensionDir, "bundled");

function run(command, args, cwd) {
  console.log(`[package-release] ${command} ${args.join(" ")} (cwd=${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`[package-release] falha ao executar ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}

function ensureFile(filePath, description) {
  if (!fs.existsSync(filePath)) {
    console.error(`[package-release] ${description} nao encontrado: ${filePath}`);
    process.exit(1);
  }
}

function ensureDir(dirPath, description) {
  if (!fs.existsSync(dirPath)) {
    console.error(`[package-release] ${description} nao encontrado: ${dirPath}`);
    process.exit(1);
  }
}

function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFileTo(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirFiltered(src, dest, excludedNames = new Set()) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return !excludedNames.has(base);
    },
  });
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  if (mode !== undefined) fs.chmodSync(filePath, mode);
}

function resolveLicenseSource() {
  const candidates = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md", "license.txt", "COPYING", "COPYING.txt"];
  for (const candidate of candidates) {
    const candidatePath = path.join(repoRoot, candidate);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }
  return null;
}

function createFallbackLicenseText() {
  const year = new Date().getFullYear();
  return [
    "LasecSimul",
    "",
    `Copyright (c) ${year} LasecSimul contributors.`,
    "",
    "All rights reserved.",
    "",
    "No license file was present in the repository at packaging time.",
    "Until the project maintainers publish a specific license grant, use, copying,",
    "modification, and redistribution of this software are not permitted except",
    "as allowed by applicable law or by prior written permission from the authors.",
    "",
  ].join("\n");
}

function stageLicenseFile() {
  const resolvedLicensePath = resolveLicenseSource();
  const stagedLicensePath = path.join(stagingExtensionDir, "LICENSE.txt");
  if (resolvedLicensePath) {
    copyFileTo(resolvedLicensePath, stagedLicensePath);
    return;
  }
  writeFile(stagedLicensePath, createFallbackLicenseText());
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function resolveCoreExecutable() {
  const coreBuildDir = path.join(repoRoot, "core", "build");
  const candidates = [
    path.join(coreBuildDir, target.coreBinaryName),
    path.join(coreBuildDir, "Release", target.coreBinaryName),
    path.join(coreBuildDir, "RelWithDebInfo", target.coreBinaryName),
    path.join(coreBuildDir, "Debug", target.coreBinaryName),
  ];
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (!existing) {
    console.error(
      `[package-release] executavel do Core nao encontrado. Rode o build antes (procurei por ${candidates.join(", ")}).`
    );
    process.exit(1);
  }
  return existing;
}

function stageExtensionFiles() {
  const filesToCopy = [
    "package.json",
    "package-lock.json",
    // `SchematicPanel.ts`/`ComponentPaletteViewProvider.ts` referenciam esses 2 CSS direto de
    // `src/ui/...` em tempo de execucao (vscode.Uri.joinPath(this.extensionUri, "src", "ui", ...)) --
    // nunca copiados/compilados pra `out`/`out-webview`/`media` por nenhum passo do `tsc` (que so
    // processa .ts). Sem isto aqui, o VSIX empacotado nunca tinha esses arquivos: o webview carregava
    // sem NENHUM CSS custom, caindo no layout padrao do navegador (ex: <button> vira inline-block e
    // "empilha" em grade, em vez da lista de 1 coluna esperada) -- bug real reportado pelo usuario
    // comparando a extensao instalada via workflow com o compile local (paleta em grade vs. lista).
    path.join("src", "ui", "webview", "styles.css"),
    path.join("src", "ui", "palette", "styles.css"),
  ];

  for (const relativePath of filesToCopy) {
    const sourcePath = path.join(extensionDir, relativePath);
    ensureFile(sourcePath, "arquivo da extension");
    copyFileTo(sourcePath, path.join(stagingExtensionDir, relativePath));
  }

  for (const dirName of ["out", "out-webview", "media"]) {
    const sourceDir = path.join(extensionDir, dirName);
    if (fs.existsSync(sourceDir)) {
      copyDirFiltered(sourceDir, path.join(stagingExtensionDir, dirName));
    }
  }

  writeFile(path.join(stagingExtensionDir, "README.md"), createReleaseReadme());
  stageLicenseFile();
}

function createReleaseReadme() {
  return [
    `# ${extensionPackage.displayName || extensionPackage.name}`,
    "",
    packageDescription,
    "",
    "## Conteudo do pacote",
    "",
    "- Extensao VS Code empacotada por plataforma",
    "- Core nativo embutido",
    "- Bibliotecas ABI/QEMU/subcircuitos embutidas",
    "",
    "## Instalacao",
    "",
    "Use o instalador nativo fornecido com esta release ou instale o `.vsix` manualmente via CLI do editor:",
    "",
    "```bash",
    "code --install-extension <arquivo.vsix> --force",
    "```",
    "",
  ].join("\n");
}

// Caminhos de `component-catalog.json` (dev) sao relativos a `extensionPath` (mesma convencao de
// `deviceLibraries`, ver `UnifiedCatalog.ts`/`catalogCommands.ts`) -- em dev isso e "../devices/...",
// em pacote instalado vira "./bundled/devices/...". So reescreve o prefixo "../", nunca inventa um
// caminho novo.
function rewriteToBundledPath(relativePath) {
  return relativePath.startsWith("../") ? `./bundled/${relativePath.slice(3)}` : relativePath;
}

function stageBundledCatalog() {
  const sourceCatalogPath = path.join(repoRoot, "project", "schema", "component-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(sourceCatalogPath, "utf8"));
  catalog.deviceLibraries = [
    "./bundled/devices/library.json",
    "./bundled/mcu-adapters/library.json",
    "./bundled/subcircuits/library.json",
  ];
  // Bug real corrigido aqui: isto ZERAVA os ~68 dispositivos embutidos (portas logicas, sensores,
  // displays, adaptador ESP32/QEMU -- tudo que nao esta em `items[]` estatico) toda vez que um
  // pacote era gerado -- eles so aparecem na paleta via `registeredSources[]`
  // (`catalogCommands.ts::refreshUnifiedCatalogState` le DAI, nunca de `deviceLibraries[]`, que so
  // manda o Core CARREGAR o plugin pra fins de simulacao). Reescreve os caminhos pro layout
  // empacotado em vez de descartar as entradas.
  catalog.registeredSources = Array.isArray(catalog.registeredSources)
    ? catalog.registeredSources.map((source) => ({
        ...source,
        ...(typeof source.filePath === "string" ? { filePath: rewriteToBundledPath(source.filePath) } : {}),
        ...(typeof source.libraryPath === "string" ? { libraryPath: rewriteToBundledPath(source.libraryPath) } : {}),
      }))
    : [];
  const destPath = path.join(bundledRoot, "project", "schema", "component-catalog.json");
  writeFile(destPath, `${JSON.stringify(catalog, null, 2)}\n`);
}

function stageBundledAssets() {
  const excluded = new Set(["build_cmake", "node_modules"]);
  copyDirFiltered(path.join(repoRoot, "devices"), path.join(bundledRoot, "devices"), excluded);
  copyDirFiltered(path.join(repoRoot, "mcu-adapters"), path.join(bundledRoot, "mcu-adapters"), excluded);
  copyDirFiltered(path.join(repoRoot, "subcircuits"), path.join(bundledRoot, "subcircuits"), excluded);

  const coreExecutable = resolveCoreExecutable();
  const coreRelative = path.relative(path.join(repoRoot, "core", "build"), coreExecutable);
  copyFileTo(coreExecutable, path.join(bundledRoot, "core", "build", coreRelative));
}

/** Extrai só `{typeId ou chipId, arquivo}` de cada dispositivo declarado num `library.json` --
 * versão MÍNIMA de `registeredSources.ts::expandLibraryJsonToSources` pra uso FORA do host da
 * Extension (este script roda em Node puro; o módulo real importa `currentLanguage.ts`, que exige
 * `vscode`, indisponível aqui). Não resolve ícone/folderPath/label -- só o suficiente pra checar
 * unicidade de ID, que é tudo que este gate precisa. */
function readDeviceIdsFromLibrary(absoluteLibraryPath) {
  const library = JSON.parse(fs.readFileSync(absoluteLibraryPath, "utf8"));
  const libraryDir = path.dirname(absoluteLibraryPath);
  const owners = [];
  const collect = (entries, idKey) => {
    for (const entry of entries || []) {
      if (!entry || typeof entry.manifest !== "string" || !entry.manifest.trim()) continue;
      const manifestPath = path.resolve(libraryDir, entry.manifest);
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const typeId = typeof manifest[idKey] === "string" ? manifest[idKey] : entry[idKey];
      if (typeId) owners.push({ typeId, sourceFile: manifestPath });
    }
  };
  collect(library.devices, "typeId");
  collect(library.mcus, "chipId");
  collect(library.subcircuits, "typeId");
  return owners;
}

/** Unicidade global de device ID (ver `.spec/lasecsimul-native-devices.spec` seção 14, `lasecsimul.spec`
 * seção 13.1.1 regra 16) -- gate de EMPACOTAMENTO: nenhum pacote deve sair com o mesmo typeId/chipId
 * declarado por dois arquivos canonicos diferentes (`items[]` estatico, `deviceLibraries[]` expandido,
 * `registeredSources[]` avulso). A checagem em si (`checkDeviceIdUniqueness`) é a MESMA função pura
 * que a Extension usa em runtime (`out/catalog/deviceUniqueness.js`, sem dependência de `vscode`) --
 * só a extração dos `owners` é uma versão mínima local (ver `readDeviceIdsFromLibrary`). Aborta o
 * empacotamento (não só avisa) quando encontra conflito -- "deve interromper... o empacotamento". */
function validateDeviceIdUniqueness() {
  const { checkDeviceIdUniqueness, formatDeviceIdConflict } = require(
    path.join(stagingExtensionDir, "out", "catalog", "deviceUniqueness.js")
  );

  const catalogPath = path.join(bundledRoot, "project", "schema", "component-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const owners = catalog.items.map((item) => ({ typeId: item.typeId, sourceFile: catalogPath }));

  for (const relativeLibraryPath of catalog.deviceLibraries || []) {
    const absoluteLibraryPath = path.join(stagingExtensionDir, relativeLibraryPath);
    if (!fs.existsSync(absoluteLibraryPath)) continue;
    owners.push(...readDeviceIdsFromLibrary(absoluteLibraryPath));
  }
  for (const source of catalog.registeredSources || []) {
    const absoluteFilePath = path.join(stagingExtensionDir, source.filePath);
    if (!fs.existsSync(absoluteFilePath)) continue;
    const manifest = JSON.parse(fs.readFileSync(absoluteFilePath, "utf8"));
    const typeId = source.kind === "mcu-adapter" ? manifest.chipId : manifest.typeId;
    if (typeId) owners.push({ typeId, sourceFile: absoluteFilePath });
  }

  const conflicts = checkDeviceIdUniqueness(owners);
  if (conflicts.length === 0) return;
  console.error(`[package-release] ${conflicts.length} conflito(s) de device ID -- empacotamento abortado:\n`);
  for (const conflict of conflicts) console.error(`${formatDeviceIdConflict(conflict)}\n`);
  process.exit(1);
}

function rewriteStagedPackageJson() {
  const stagedPackageJsonPath = path.join(stagingExtensionDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(stagedPackageJsonPath, "utf8"));
  if (pkg.contributes && Array.isArray(pkg.contributes["lasecsimul.deviceLibraries"])) {
    pkg.contributes["lasecsimul.deviceLibraries"] = [
      { libraryManifest: "./bundled/devices/library.json" },
      { libraryManifest: "./bundled/mcu-adapters/library.json" },
      { libraryManifest: "./bundled/subcircuits/library.json" },
    ];
  }
  pkg.license = "SEE LICENSE IN LICENSE.txt";
  pkg.files = ["out/**/*", "out-webview/**/*", "media/**/*", "bundled/**/*", "README.md", "LICENSE.txt", "src/ui/webview/styles.css", "src/ui/palette/styles.css"];
  writeFile(stagedPackageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function packageVsix(vsixPath) {
  run(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["--yes", "@vscode/vsce", "package", "--allow-missing-repository", "--target", target.vsceTarget, "--out", vsixPath],
    stagingExtensionDir
  );
}

function createWindowsNativeInstaller(vsixPath) {
  const bootstrapperTemplateDir = path.join(repoRoot, "packaging", "windows-bootstrapper");
  ensureDir(bootstrapperTemplateDir, "template do bootstrapper Windows");

  const bootstrapperStageDir = path.join(stagingRoot, "windows-bootstrapper");
  resetDir(bootstrapperStageDir);
  copyDirFiltered(bootstrapperTemplateDir, bootstrapperStageDir);
  copyFileTo(vsixPath, path.join(bootstrapperStageDir, "payload.vsix"));

  const publishDir = path.join(bootstrapperStageDir, "publish");
  run(
    "dotnet",
    [
      "publish",
      path.join(bootstrapperStageDir, "LasecSimul.Setup.csproj"),
      "-c",
      "Release",
      "-r",
      "win-x64",
      "--self-contained",
      "true",
      "-p:PublishSingleFile=true",
      "-p:PublishTrimmed=false",
      "-o",
      publishDir,
    ],
    repoRoot
  );

  const publishedExe = path.join(publishDir, "LasecSimul.Setup.exe");
  ensureFile(publishedExe, "instalador nativo Windows");
  const nativeInstallerPath = path.join(releaseRoot, target.nativeInstallerName);
  copyFileTo(publishedExe, nativeInstallerPath);
  return nativeInstallerPath;
}

function createLinuxInstallScript(vsixFileName) {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    `VSIX_PATH="$SCRIPT_DIR/${vsixFileName}"`,
    'if [ ! -f "$VSIX_PATH" ]; then',
    '  echo "VSIX nao encontrado: $VSIX_PATH" >&2',
    "  exit 1",
    "fi",
    'CANDIDATES="${LASECSIMUL_CODE_CLI:-} code code-insiders codium code-oss"',
    'RESOLVED=""',
    "for candidate in $CANDIDATES; do",
    '  [ -n "$candidate" ] || continue',
    '  if command -v "$candidate" >/dev/null 2>&1; then',
    '    RESOLVED="$candidate"',
    "    break",
    "  fi",
    "done",
    'if [ -z "$RESOLVED" ]; then',
    "  echo \"Nao encontrei a CLI do VS Code/VS Codium no PATH. Rode /usr/bin/lasecsimul-install-vscode-extension depois de instalar o comando 'code' ou defina LASECSIMUL_CODE_CLI.\" >&2",
    "  exit 1",
    "fi",
    '"$RESOLVED" --install-extension "$VSIX_PATH" --force',
    'echo "LasecSimul instalado com sucesso via $RESOLVED"',
    "",
  ].join("\n");
}

function createLinuxWrapperScript() {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    `exec /opt/${packageName}/install-extension.sh "$@"`,
    "",
  ].join("\n");
}

function createLinuxPostinst() {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    'if [ "${1:-configure}" = "configure" ]; then',
    `  if /opt/${packageName}/install-extension.sh; then`,
    "    :",
    "  else",
    '    echo "LasecSimul: nao foi possivel instalar automaticamente a extensao no VS Code." >&2',
    '    echo "LasecSimul: rode /usr/bin/lasecsimul-install-vscode-extension depois de configurar a CLI do editor." >&2',
    "  fi",
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

function createLinuxControlFile() {
  return [
    `Package: ${packageName}`,
    `Version: ${packageVersion}`,
    "Section: devel",
    "Priority: optional",
    "Architecture: amd64",
    "Maintainer: LasecSimul Team <noreply@lasecsimul.local>",
    "Depends: bash",
    `Description: ${packageDescription}`,
    " Instala o payload empacotado da extensao LasecSimul para VS Code, incluindo",
    " o Core nativo e as bibliotecas ABI/QEMU/subcircuitos embutidas no VSIX.",
    "",
  ].join("\n");
}

function createLinuxNativeInstaller(vsixPath) {
  const debStageDir = path.join(stagingRoot, "deb");
  resetDir(debStageDir);

  const debianDir = path.join(debStageDir, "DEBIAN");
  const optDir = path.join(debStageDir, "opt", packageName);
  const binDir = path.join(debStageDir, "usr", "bin");
  fs.mkdirSync(debianDir, { recursive: true });
  fs.mkdirSync(optDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const vsixFileName = path.basename(vsixPath);
  copyFileTo(vsixPath, path.join(optDir, vsixFileName));
  writeFile(path.join(optDir, "install-extension.sh"), createLinuxInstallScript(vsixFileName), 0o755);
  writeFile(path.join(binDir, "lasecsimul-install-vscode-extension"), createLinuxWrapperScript(), 0o755);
  writeFile(path.join(debianDir, "control"), createLinuxControlFile());
  writeFile(path.join(debianDir, "postinst"), createLinuxPostinst(), 0o755);

  const nativeInstallerPath = path.join(releaseRoot, target.nativeInstallerName);
  run("dpkg-deb", ["--build", "--root-owner-group", debStageDir, nativeInstallerPath], repoRoot);
  ensureFile(nativeInstallerPath, "pacote .deb");
  return nativeInstallerPath;
}

function createNativeInstaller(vsixPath) {
  if (process.platform === "win32") return createWindowsNativeInstaller(vsixPath);
  return createLinuxNativeInstaller(vsixPath);
}

resetDir(releaseRoot);
resetDir(stagingRoot);
stageExtensionFiles();
stageBundledCatalog();
stageBundledAssets();
validateDeviceIdUniqueness();
rewriteStagedPackageJson();

const vsixFileName = `${extensionPackage.name}-${packageVersion}-${target.vsceTarget}.vsix`;
const vsixPath = path.join(releaseRoot, vsixFileName);
packageVsix(vsixPath);

const nativeInstallerPath = createNativeInstaller(vsixPath);

const checksumLines = [
  `${sha256(vsixPath)}  ${path.basename(vsixPath)}`,
  `${sha256(nativeInstallerPath)}  ${path.basename(nativeInstallerPath)}`,
];
writeFile(path.join(releaseRoot, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`);

console.log(`[package-release] artefatos gerados em ${releaseRoot}`);

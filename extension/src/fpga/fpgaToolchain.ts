import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import * as vscode from "vscode";
import { fileExists } from "../pathUtils";
import { state } from "../state";

/** Caminho DEFAULT do módulo VPI (`lasecsimul_vpi.dll`/`.so`) construído por `npm run
 * build:fpga-vpi` -- mesmo princípio de `mcuCommands.ts::resolveDefaultQemuBinaryPath` (2 layouts
 * possíveis: repo de desenvolvimento, `extensionPath/../fpga/...`; pacote VSIX,
 * `extensionPath/bundled/fpga/...`). Calculado uma vez e cacheado -- `extensionPath` não muda
 * durante a sessão da Extension. */
let cachedVpiModulePath: string | undefined | null = null;

function vpiModuleRelativePath(): string {
  if (process.platform === "win32") return path.join("fpga", "ghdl-vpi", "build", "win-x64", "lasecsimul_vpi.dll");
  if (process.platform === "darwin") return path.join("fpga", "ghdl-vpi", "build", "macos-universal", "liblasecsimul_vpi.dylib");
  return path.join("fpga", "ghdl-vpi", "build", "linux-x64", "liblasecsimul_vpi.so");
}

export function resolveVpiModulePath(): string | undefined {
  if (cachedVpiModulePath !== null) return cachedVpiModulePath;
  const extensionPath = state.extensionContext?.extensionPath;
  if (!extensionPath) return undefined;
  const relative = vpiModuleRelativePath();
  const candidates = [
    path.join(extensionPath, "..", relative),
    path.join(extensionPath, "bundled", relative),
  ];
  cachedVpiModulePath = candidates.find((candidate) => fileExists(candidate));
  return cachedVpiModulePath;
}

/** Runtime GHDL integrado ao pacote, com a mesma política do QEMU: override explícito do usuário
 * ganha; sem override, a extensão instalada usa seu próprio binário e o checkout de desenvolvimento
 * cai para `ghdl` no PATH. */
let cachedBundledGhdlBinaryPath: string | undefined | null = null;

export function resolveBundledGhdlBinaryPath(): string | undefined {
  if (cachedBundledGhdlBinaryPath !== null) return cachedBundledGhdlBinaryPath;
  const extensionPath = state.extensionContext?.extensionPath;
  if (!extensionPath) return undefined;
  const binaryName = process.platform === "win32" ? "ghdl.exe" : "ghdl";
  const candidates = [
    path.join(extensionPath, "..", "fpga", "ghdl", "bin", binaryName),
    path.join(extensionPath, "bundled", "fpga", "ghdl", "bin", binaryName),
  ];
  cachedBundledGhdlBinaryPath = candidates.find((candidate) => fileExists(candidate));
  return cachedBundledGhdlBinaryPath;
}

export function resolveGhdlBinaryPath(): string {
  const settings = vscode.workspace.getConfiguration("lasecsimul.fpga");
  const configured = settings.get<string>("ghdlPath", "").trim();
  // `ghdl` era o default antigo. Trate-o como automático para instalações atualizadas também
  // migrarem ao runtime integrado, sem pedir que o usuário limpe a preferência manualmente.
  if (configured && configured !== "ghdl") return configured;
  return resolveBundledGhdlBinaryPath() ?? (configured || "ghdl");
}

function runExecutable(executable: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(String(stdout || stderr).trim());
    });
  });
}

async function probeGhdl(executable: string): Promise<string | undefined> {
  try {
    const output = await runExecutable(executable, ["--version"]);
    return output.split(/\r?\n/, 1)[0]?.trim() || "GHDL";
  } catch {
    return undefined;
  }
}

function discoverWingetGhdl(): string | undefined {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return undefined;
  const packagesRoot = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  try {
    const candidates = fs.readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith("ghdl.ghdl."))
      .map((entry) => path.join(packagesRoot, entry.name, "bin", "ghdl.exe"))
      .filter(fileExists);
    return candidates[0];
  } catch {
    return undefined;
  }
}

async function selectCustomGhdl(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false,
    filters: process.platform === "win32" ? { Executável: ["exe"] } : undefined,
    title: "Selecionar o executável GHDL",
    openLabel: "Usar este GHDL",
  });
  const executable = picked?.[0]?.fsPath;
  if (!executable) return undefined;
  const version = await probeGhdl(executable);
  if (!version) {
    void vscode.window.showErrorMessage("O arquivo selecionado não é um executável GHDL válido.");
    return undefined;
  }
  await vscode.workspace.getConfiguration("lasecsimul.fpga").update("ghdlPath", executable, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`${version} configurado com sucesso.`);
  return executable;
}

async function installGhdlOnWindows(): Promise<string | undefined> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Instalando o simulador GHDL…", cancellable: false },
      () => runExecutable(
        "winget",
        ["install", "--id", "ghdl.ghdl.ucrt64.mcode", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements"],
        10 * 60_000
      )
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`Não foi possível instalar o GHDL automaticamente: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const executable = discoverWingetGhdl();
  if (!executable || !(await probeGhdl(executable))) {
    void vscode.window.showErrorMessage("A instalação terminou, mas o executável GHDL não foi localizado. Use “Selecionar executável”.");
    return undefined;
  }
  await vscode.workspace.getConfiguration("lasecsimul.fpga").update("ghdlPath", executable, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage("GHDL instalado e configurado. A FPGA já pode ser utilizada.");
  return executable;
}

/** Garante um simulador utilizável sem expor terminal/PATH ao usuário. Releases normais sempre
 * chegam pelo primeiro caminho (runtime integrado); instalação/seleção são recuperação guiada para
 * checkout de desenvolvimento ou pacote danificado. */
export async function ensureGhdlToolchainReady(): Promise<string | undefined> {
  const executable = resolveGhdlBinaryPath();
  if (await probeGhdl(executable)) return executable;

  const installLabel = "Instalar automaticamente";
  const selectLabel = "Selecionar executável…";
  const choice = await vscode.window.showWarningMessage(
    "O simulador GHDL não está disponível. O LasecSimul pode configurá-lo sem usar o terminal.",
    ...(process.platform === "win32" ? [installLabel, selectLabel] : [selectLabel])
  );
  if (choice === installLabel) return installGhdlOnWindows();
  if (choice === selectLabel) return selectCustomGhdl();
  return undefined;
}

/** Janela de gerenciamento acessível pelas propriedades da FPGA. */
export async function configureGhdlToolchainCommand(): Promise<boolean> {
  const automatic = resolveBundledGhdlBinaryPath();
  const current = resolveGhdlBinaryPath();
  const version = await probeGhdl(current);
  const choices = [
    ...(automatic ? [{ label: "$(check) Usar GHDL integrado", description: "Recomendado; nenhuma instalação externa", action: "automatic" }] : []),
    { label: "$(folder-opened) Selecionar outro executável…", description: "Override avançado", action: "select" },
    ...(process.platform === "win32" && !automatic
      ? [{ label: "$(cloud-download) Instalar automaticamente", description: "Instala e configura sem terminal", action: "install" }]
      : []),
  ];
  const picked = await vscode.window.showQuickPick(choices, {
    title: `Simulador FPGA — ${version ?? "GHDL indisponível"}`,
    placeHolder: "Escolha como o LasecSimul deve localizar o GHDL",
  });
  if (picked?.action === "automatic") {
    await vscode.workspace.getConfiguration("lasecsimul.fpga").update("ghdlPath", "", vscode.ConfigurationTarget.Global);
    const integratedVersion = automatic ? await probeGhdl(automatic) : undefined;
    void vscode.window.showInformationMessage(integratedVersion ? `${integratedVersion} integrado selecionado.` : "GHDL integrado selecionado.");
    return true;
  } else if (picked?.action === "select") {
    return Boolean(await selectCustomGhdl());
  } else if (picked?.action === "install") {
    return Boolean(await installGhdlOnWindows());
  }
  return false;
}

/** Raiz do cache de compilação -- dentro da pasta do projeto (`.lasecsimul/fpga-cache/`, ao lado do
 * `.lsproj`), NUNCA um diretório temporário genérico do SO: precisa sobreviver entre sessões pra o
 * cache valer a pena, e não pode ser compartilhado entre projetos diferentes (Cache vNext,
 * `.spec/features/fpga-ghdl.md`). Cai pro diretório temporário do SO só se o projeto ainda não foi
 * salvo (sem `.lsproj` conhecido) -- caso raro, cache efêmero nesse caso (perdido ao reiniciar),
 * nunca uma falha. */
export function resolveFpgaCacheRootDir(): string {
  if (state.currentProjectFilePath) {
    return path.join(path.dirname(state.currentProjectFilePath), ".lasecsimul", "fpga-cache");
  }
  return path.join(os.tmpdir(), "lasecsimul-fpga-cache");
}

/** Resolvido FRESCO a cada chamada (nunca cacheado a nível de sessão, exceto o caminho do VPI que é
 * imutável por processo) -- ver `.lsproj`'s `ProjectFpgaConfig` (nunca persiste isto) e
 * `CoreClient.addComponent`'s parâmetro `fpga`. */
export function resolveFpgaToolchainConfig(): { ghdlBinary: string; vpiModulePath: string; cacheRootDir: string; sourceRootDir: string } {
  const sourceRootDir = state.currentProjectFilePath ? path.dirname(state.currentProjectFilePath) : process.cwd();
  return {
    ghdlBinary: resolveGhdlBinaryPath(),
    vpiModulePath: resolveVpiModulePath() ?? "",
    cacheRootDir: resolveFpgaCacheRootDir(),
    sourceRootDir,
  };
}

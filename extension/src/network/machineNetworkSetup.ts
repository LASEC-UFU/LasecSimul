import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawn } from "child_process";
import { fileExists, readJsonFile } from "../pathUtils";
import { logSimulation } from "../diagnostics/simulationLog";

/** Instala sob demanda (a partir da própria Extension, já rodando via Marketplace) o driver
 * TAP-Windows6, a Windows Network Bridge e o `LasecSimul.NetworkGateway.exe` que o modo de rede
 * "lab-bridge" (ver docs/17-modos-de-rede-esp32.md) precisa -- sem isso, publicar a extensão no
 * Marketplace não bastaria pra quem quer esse modo: o `.vsix` sozinho nunca poderia rodar
 * `pnputil`/`netsh bridge`/`schtasks` com elevação. Em vez de exigir que o usuário baixe e rode o
 * `LasecSimul.Setup.exe` manualmente antes de instalar a extensão, a extensão detecta a ausência da
 * infraestrutura, pergunta explicitamente (mesmo espírito da pergunta já feita pelo bootstrapper
 * nativo, `packaging/windows-bootstrapper/Program.cs::ShouldProvisionTapInfrastructure`) e, com
 * consentimento, baixa o `.exe` da release do GitHub correspondente à própria versão da extensão,
 * confere o SHA-256 publicado em `SHA256SUMS.txt` e o executa elevado só com `--provision-network`
 * (pula a reinstalação do `.vsix`, que já está satisfeita por definição -- este código só roda dentro
 * da extensão já instalada).
 *
 * Pré-requisito operacional: a release `vX.Y.Z` correspondente precisa existir publicamente no
 * GitHub (`RELEASE_REPO`) com `lasecsimul-X.Y.Z-win32-x64-setup.exe` e `SHA256SUMS.txt` anexados --
 * é o mesmo par que `scripts/package-release.js` já gera e que o workflow
 * `.github/workflows/package-installers.yml` já publica. Repo precisa ser público: download de asset
 * de release privada sem token autenticado retorna 404. */

const RELEASE_REPO = "josuemoraisgh/LasecSimul";
const DISMISSED_VERSION_KEY = "lasecsimul.network.setupDismissedForVersion";
/** Código de saída do Win32 (`ERROR_CANCELLED`) que o script PowerShell de elevação repassa quando o
 * usuário nega o prompt de UAC -- distinto de uma falha real do instalador, pra mostrar uma mensagem
 * apropriada em vez de "erro desconhecido". */
const UAC_CANCELLED_EXIT_CODE = 1223;

function machineProgramDataConfigPath(): string {
  return path.join(process.env.ProgramData ?? "C:\\ProgramData", "LasecSimul", "network.json");
}

/** Checagem leve (sem elevação, sem `netsh`/`schtasks`) só pra decidir se vale a pena OFERECER a
 * instalação -- não substitui a verificação completa que `LasecSimul.Setup.exe --machine-status` faz
 * (TAP, bridge, tarefa agendada, registro). Suficiente pro gate "nunca vi essa máquina instalada": se
 * `network.json` existe e bate a versão do schema/porta, assume-se saudável; qualquer inconsistência
 * mais sutil ainda pode ser reparada rodando `LasecSimul.Setup.exe --provision-network` (idempotente),
 * inclusive via o comando manual `lasecsimul.network.installMachineSetup`. */
function isMachineNetworkInfraPresent(expectedGatewayPort: number): boolean {
  const configPath = machineProgramDataConfigPath();
  if (!fileExists(configPath)) return false;
  try {
    const config = readJsonFile(configPath) as { schemaVersion?: number; gatewayPort?: number };
    return config.schemaVersion === 1 && config.gatewayPort === expectedGatewayPort;
  } catch {
    return false;
  }
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const packageJson = context.extension.packageJSON as { version?: string };
  return packageJson.version ?? "0.0.0";
}

function releaseAssetUrl(version: string, fileName: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${fileName}`;
}

/** `https.get` que segue redirecionamentos manualmente -- assets de release do GitHub sempre
 * redirecionam (302) pra `objects.githubusercontent.com`, e o `https` nativo do Node nunca segue
 * redirecionamento sozinho. */
function httpsGetFollowingRedirects(url: string, remainingRedirects = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "LasecSimul-Extension" } }, (response) => {
      const { statusCode, headers } = response;
      if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        if (remainingRedirects <= 0) {
          reject(new Error(`Muitos redirecionamentos ao baixar ${url}`));
          return;
        }
        httpsGetFollowingRedirects(new URL(headers.location, url).toString(), remainingRedirects - 1).then(resolve, reject);
        return;
      }
      if (!statusCode || statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${statusCode ?? "desconhecido"} ao baixar ${url}`));
        return;
      }
      resolve(response);
    });
    request.on("error", reject);
  });
}

async function downloadText(url: string): Promise<string> {
  const response = await httpsGetFollowingRedirects(url);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", reject);
  });
}

async function downloadToFile(url: string, destinationPath: string): Promise<void> {
  const response = await httpsGetFollowingRedirects(url);
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const fileStream = fs.createWriteStream(destinationPath);
    response.on("error", reject);
    fileStream.on("error", reject);
    fileStream.on("finish", () => fileStream.close(() => resolve()));
    response.pipe(fileStream);
  });
}

function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** Mesmo formato que `scripts/package-release.js` escreve: `"<hash>  <nome-do-arquivo>"`, uma linha
 * por artefato. */
function findExpectedHash(sumsText: string, fileName: string): string | undefined {
  for (const rawLine of sumsText.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length >= 2 && parts[parts.length - 1] === fileName) return parts[0]?.toLowerCase();
  }
  return undefined;
}

interface ElevatedRunResult {
  code: number;
  stderr: string;
}

/** Node não tem um equivalente de `ProcessStartInfo.Verb = "runas"` (usado pelo próprio
 * `Program.cs::RunElevated` em C#) -- o caminho padrão pra pedir elevação UAC a partir de um processo
 * Node no Windows é delegar a um `Start-Process -Verb RunAs` do PowerShell. Roda só com
 * `--provision-network` (nunca sem argumentos): a extensão já está instalada por definição -- este
 * fluxo cobre apenas a etapa de máquina (TAP/bridge/gateway), pulando a reinstalação do `.vsix` que o
 * `Program.cs::Main()` sem argumentos faria. */
function runElevatedProvisioning(exePath: string): Promise<ElevatedRunResult> {
  const escapedExePath = exePath.replace(/'/g, "''");
  const script = [
    "try {",
    `  $p = Start-Process -FilePath '${escapedExePath}' -ArgumentList '--provision-network' -Verb RunAs -Wait -PassThru -ErrorAction Stop;`,
    "  exit $p.ExitCode",
    "} catch {",
    "  Write-Error $_.Exception.Message",
    `  exit ${UAC_CANCELLED_EXIT_CODE}`,
    "}",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stderr: stderr.trim() }));
  });
}

async function downloadAndVerifySetupExe(context: vscode.ExtensionContext, version: string): Promise<string> {
  const assetName = `lasecsimul-${version}-win32-x64-setup.exe`;
  const sumsText = await downloadText(releaseAssetUrl(version, "SHA256SUMS.txt"));
  const expectedHash = findExpectedHash(sumsText, assetName);
  if (!expectedHash) {
    throw new Error(`SHA256SUMS.txt da release v${version} não tem uma entrada para "${assetName}".`);
  }

  const exePath = path.join(context.globalStorageUri.fsPath, "machine-setup", version, assetName);
  const cachedIsValid = fileExists(exePath) && (await sha256OfFile(exePath)) === expectedHash;
  if (!cachedIsValid) {
    await downloadToFile(releaseAssetUrl(version, assetName), exePath);
    const actualHash = await sha256OfFile(exePath);
    if (actualHash !== expectedHash) {
      await fs.promises.rm(exePath, { force: true });
      throw new Error(`Checksum SHA-256 não confere para "${assetName}" (esperado ${expectedHash}, obtido ${actualHash}).`);
    }
  }
  return exePath;
}

async function installMachineNetworkInfra(context: vscode.ExtensionContext, version: string): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "LasecSimul: instalando driver TAP e infraestrutura de rede",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: `Baixando lasecsimul-${version}-win32-x64-setup.exe...` });
      const exePath = await downloadAndVerifySetupExe(context, version);

      progress.report({ message: "Aguardando elevação administrativa (UAC)..." });
      const result = await runElevatedProvisioning(exePath);

      if (result.code === UAC_CANCELLED_EXIT_CODE) {
        logSimulation(
          "warning",
          "Elevação administrativa negada; driver TAP, bridge e gateway não foram instalados.",
          { stage: "network-setup" }
        );
        return;
      }
      if (result.code !== 0) {
        throw new Error(result.stderr || `LasecSimul.Setup.exe --provision-network retornou código ${result.code}.`);
      }
      logSimulation(
        "info",
        "Driver TAP, bridge de rede e gateway instalados/reparados com sucesso.",
        { stage: "network-setup", notify: true }
      );
    }
  );
}

/** Pergunta e, com consentimento, instala -- usado tanto pelo gatilho automático (`activate()`, só
 * quando `lasecsimul.network.mode` já está em "lab-bridge" e a infraestrutura está ausente) quanto
 * pelo comando manual `lasecsimul.network.installMachineSetup` (sempre pergunta, sem os gates de
 * modo/versão-dispensada -- ação explícita do usuário). */
async function offerInstall(context: vscode.ExtensionContext, version: string, options: { allowDismiss: boolean }): Promise<void> {
  const install = "Instalar agora";
  const later = "Mais tarde";
  const dontAskAgain = "Não perguntar novamente";
  const buttons = options.allowDismiss ? [install, later, dontAskAgain] : [install, later];

  const choice = await vscode.window.showInformationMessage(
    `O modo de rede "lab-bridge" precisa do driver TAP-Windows6, de uma Windows Network Bridge e do ` +
      `gateway central para esta máquina -- ainda não detectados. Deseja baixar e instalar agora ` +
      `(lasecsimul-${version}-win32-x64-setup.exe, a partir da release v${version} no GitHub)? ` +
      `Isso exige elevação administrativa (UAC). Sem isso, a extensão continua funcionando ` +
      `normalmente no modo "isolated".`,
    ...buttons
  );

  if (choice === dontAskAgain) {
    await context.globalState.update(DISMISSED_VERSION_KEY, version);
    return;
  }
  if (choice !== install) return;

  try {
    await installMachineNetworkInfra(context, version);
  } catch (err) {
    logSimulation(
      "error",
      `Falha ao instalar a infraestrutura de rede: ${err instanceof Error ? err.message : String(err)}`,
      { stage: "network-setup" }
    );
  }
}

/** Chamado (fire-and-forget) na ativação da extensão -- só age no Windows, só quando o usuário já
 * escolheu explicitamente o modo "lab-bridge" (o padrão é "disabled"; "isolated" nunca precisa de
 * TAP), só quando a infraestrutura global parece ausente, e só uma vez por versão dispensada. */
export function maybeOfferMachineNetworkSetup(context: vscode.ExtensionContext): void {
  if (process.platform !== "win32") return;
  const networkConfig = vscode.workspace.getConfiguration("lasecsimul.network");
  if (networkConfig.get<string>("mode", "disabled") !== "lab-bridge") return;

  const gatewayPort = networkConfig.get<number>("gatewayPort", 9011);
  if (isMachineNetworkInfraPresent(gatewayPort)) return;

  const version = extensionVersion(context);
  if (context.globalState.get<string>(DISMISSED_VERSION_KEY) === version) return;

  void offerInstall(context, version, { allowDismiss: true });
}

/** Comando manual (Command Palette) pra instalar/reparar a infraestrutura de rede mesmo fora do
 * gatilho automático -- por exemplo, depois de "Não perguntar novamente", ou pra reparar uma
 * instalação que ficou incompleta sem esperar o próximo restart do VS Code. */
export function registerMachineNetworkSetupCommand(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand("lasecsimul.network.installMachineSetup", async () => {
    if (process.platform !== "win32") {
      vscode.window.showInformationMessage("A infraestrutura de rede (TAP/bridge/gateway) só existe no Windows.");
      return;
    }
    await offerInstall(context, extensionVersion(context), { allowDismiss: false });
  });
}

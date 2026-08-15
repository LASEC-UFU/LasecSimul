import * as os from "os";
import * as path from "path";
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

/** `ghdl` é um toolchain de SISTEMA (como o GDB do MCU), não vendorizado -- mirror exato de
 * `lasecsimul.debug.gdbPath` (`mcuDebug.ts`). */
export function resolveGhdlBinaryPath(): string {
  const settings = vscode.workspace.getConfiguration("lasecsimul.fpga");
  return settings.get<string>("ghdlPath", "ghdl");
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
export function resolveFpgaToolchainConfig(): { ghdlBinary: string; vpiModulePath: string; cacheRootDir: string } {
  return {
    ghdlBinary: resolveGhdlBinaryPath(),
    vpiModulePath: resolveVpiModulePath() ?? "",
    cacheRootDir: resolveFpgaCacheRootDir(),
  };
}

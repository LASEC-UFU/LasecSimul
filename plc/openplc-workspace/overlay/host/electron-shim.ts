// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * O pouco do módulo `electron` que os serviços de projeto e biblioteca do OpenPLC usam no host.
 * O webpack do host troca `import ... from 'electron'` por este arquivo; a extensão do VS Code
 * informa a pasta de dados e os diálogos (configureElectronShim).
 */

export interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export interface ElectronShimOptions {
  userDataDir: string
  showOpenDialog?: (options: Record<string, unknown>) => Promise<OpenDialogResult>
  showMessageBox?: (options: Record<string, unknown>) => Promise<{ response: number }>
}

let options: ElectronShimOptions = { userDataDir: '' }

export function configureElectronShim(next: ElectronShimOptions): void {
  options = next
}

export const app = {
  getPath(_name: string): string {
    if (!options.userDataDir) throw new Error('Pasta de dados do OpenPLC no LasecSimul não configurada.')
    return options.userDataDir
  },
  getAppPath(): string {
    return options.userDataDir
  },
  isPackaged: true,
  getVersion(): string {
    return '4.2.8'
  },
}

export const dialog = {
  async showOpenDialog(...args: unknown[]): Promise<OpenDialogResult> {
    const dialogOptions = (args.length > 1 ? args[1] : args[0]) as Record<string, unknown>
    if (!options.showOpenDialog) return { canceled: true, filePaths: [] }
    return options.showOpenDialog(dialogOptions ?? {})
  },
  async showMessageBox(...args: unknown[]): Promise<{ response: number }> {
    const boxOptions = (args.length > 1 ? args[1] : args[0]) as Record<string, unknown>
    if (!options.showMessageBox) return { response: 0 }
    return options.showMessageBox(boxOptions ?? {})
  },
}

export class BrowserWindow {
  webContents = { send: (_channel: string, ..._args: unknown[]) => undefined }
  static getAllWindows(): BrowserWindow[] {
    return []
  }
}

export const shell = {
  async openExternal(_url: string): Promise<void> {
    return undefined
  },
}

export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system' }

export default { app, dialog, BrowserWindow, shell, nativeTheme }

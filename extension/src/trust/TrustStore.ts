import * as vscode from "vscode";

export type TrustDecision = "blocked" | "always";

const STORAGE_KEY = "lasecsimul.trustedPublishers";

/**
 * Persiste a decisão de confiança por publisher (`library.json::publisher`) em
 * `ExtensionContext.globalState` -- decisão sobrevive a reinícios do VSCode, mas é local à máquina
 * (não sincroniza), pois é uma decisão de segurança sobre código nativo sem sandbox (ver
 * `.spec/archive/legacy-v2/lasecsimul-native-devices.spec` seção 12, item 2). "Permitir uma vez" nunca passa por
 * aqui -- só "Bloquear"/"Sempre confiar" são persistidos.
 */
export class TrustStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  decisionFor(publisher: string): TrustDecision | undefined {
    const stored = this.context.globalState.get<Record<string, TrustDecision>>(STORAGE_KEY, {});
    return stored[publisher];
  }

  async setDecision(publisher: string, decision: TrustDecision): Promise<void> {
    const stored = this.context.globalState.get<Record<string, TrustDecision>>(STORAGE_KEY, {});
    await this.context.globalState.update(STORAGE_KEY, { ...stored, [publisher]: decision });
  }
}

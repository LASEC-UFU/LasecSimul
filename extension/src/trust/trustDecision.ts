import { TrustDecision } from "./TrustStore";

/** Lógica pura de decisão de confiança -- separada do diálogo (`vscode.window.*`) pra poder ser
 * testada sem mock de VSCode. `trust: "first-party"` (devices/mcu-adapters embutidos no próprio
 * LasecSimul, ver `devices/library.json`) nunca passa por consentimento. Ver
 * `.spec/archive/legacy-v2/lasecsimul-native-devices.spec` seção 12, item 2. */

export function isFirstParty(trust: string | undefined): boolean {
  return trust === "first-party";
}

/** `true` quando é preciso perguntar ao usuário agora (nenhuma decisão prévia persistida e não é
 * first-party). */
export function needsConsentPrompt(trust: string | undefined, stored: TrustDecision | undefined): boolean {
  return !isFirstParty(trust) && stored === undefined;
}

/** `true` quando o carregamento deve ser permitido SEM diálogo (first-party ou decisão
 * "always" já persistida). */
export function isPreApproved(trust: string | undefined, stored: TrustDecision | undefined): boolean {
  return isFirstParty(trust) || stored === "always";
}

/** `true` quando o carregamento deve ser bloqueado SEM diálogo (decisão "blocked" já persistida). */
export function isPreBlocked(trust: string | undefined, stored: TrustDecision | undefined): boolean {
  return !isFirstParty(trust) && stored === "blocked";
}

export type ConsentChoice = "allow-once" | "always-trust" | "block" | "dismissed";

/** Resolve a escolha do diálogo (texto do botão clicado, ou `undefined` se o usuário fechou sem
 * escolher) pro tipo de decisão -- `dismissed` (Esc/clique fora) é tratado como bloqueio só desta
 * vez, sem persistir nada (o usuário pode não ter visto a pergunta com atenção). */
export function resolveConsentChoice(buttonLabel: string | undefined): ConsentChoice {
  if (buttonLabel === "Permitir uma vez") return "allow-once";
  if (buttonLabel === "Sempre confiar") return "always-trust";
  if (buttonLabel === "Bloquear") return "block";
  return "dismissed";
}

export function shouldLoadLibrary(choice: ConsentChoice): boolean {
  return choice === "allow-once" || choice === "always-trust";
}

export function decisionToPersist(choice: ConsentChoice): TrustDecision | undefined {
  if (choice === "always-trust") return "always";
  if (choice === "block") return "blocked";
  return undefined; // allow-once e dismissed nunca persistem
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFirstParty = isFirstParty;
exports.needsConsentPrompt = needsConsentPrompt;
exports.isPreApproved = isPreApproved;
exports.isPreBlocked = isPreBlocked;
exports.resolveConsentChoice = resolveConsentChoice;
exports.shouldLoadLibrary = shouldLoadLibrary;
exports.decisionToPersist = decisionToPersist;
/** Lógica pura de decisão de confiança -- separada do diálogo (`vscode.window.*`) pra poder ser
 * testada sem mock de VSCode. `trust: "first-party"` (devices/mcu-adapters embutidos no próprio
 * LasecSimul, ver `devices/library.json`) nunca passa por consentimento. Ver
 * `.spec/lasecsimul-native-devices.spec` seção 12, item 2. */
function isFirstParty(trust) {
    return trust === "first-party";
}
/** `true` quando é preciso perguntar ao usuário agora (nenhuma decisão prévia persistida e não é
 * first-party). */
function needsConsentPrompt(trust, stored) {
    return !isFirstParty(trust) && stored === undefined;
}
/** `true` quando o carregamento deve ser permitido SEM diálogo (first-party ou decisão
 * "always" já persistida). */
function isPreApproved(trust, stored) {
    return isFirstParty(trust) || stored === "always";
}
/** `true` quando o carregamento deve ser bloqueado SEM diálogo (decisão "blocked" já persistida). */
function isPreBlocked(trust, stored) {
    return !isFirstParty(trust) && stored === "blocked";
}
/** Resolve a escolha do diálogo (texto do botão clicado, ou `undefined` se o usuário fechou sem
 * escolher) pro tipo de decisão -- `dismissed` (Esc/clique fora) é tratado como bloqueio só desta
 * vez, sem persistir nada (o usuário pode não ter visto a pergunta com atenção). */
function resolveConsentChoice(buttonLabel) {
    if (buttonLabel === "Permitir uma vez")
        return "allow-once";
    if (buttonLabel === "Sempre confiar")
        return "always-trust";
    if (buttonLabel === "Bloquear")
        return "block";
    return "dismissed";
}
function shouldLoadLibrary(choice) {
    return choice === "allow-once" || choice === "always-trust";
}
function decisionToPersist(choice) {
    if (choice === "always-trust")
        return "always";
    if (choice === "block")
        return "blocked";
    return undefined; // allow-once e dismissed nunca persistem
}
//# sourceMappingURL=trustDecision.js.map
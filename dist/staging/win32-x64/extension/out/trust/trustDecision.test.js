"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MockCoreServer_1 = require("../ipc/testSupport/MockCoreServer");
const trustDecision_1 = require("./trustDecision");
(async () => {
    const { test, finish } = (0, MockCoreServer_1.createTestRunner)("trustDecision — testes puros");
    await test("first-party nunca precisa de consentimento, mesmo sem decisão prévia", () => {
        (0, MockCoreServer_1.assert)((0, trustDecision_1.needsConsentPrompt)("first-party", undefined) === false, "first-party não deveria pedir consentimento");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.isPreApproved)("first-party", undefined) === true, "first-party deveria ser pré-aprovado");
    });
    await test("publisher desconhecido (sem trust, sem decisão prévia) precisa de consentimento", () => {
        (0, MockCoreServer_1.assert)((0, trustDecision_1.needsConsentPrompt)(undefined, undefined) === true, "deveria pedir consentimento");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.isPreApproved)(undefined, undefined) === false, "não deveria estar pré-aprovado");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.isPreBlocked)(undefined, undefined) === false, "não deveria estar pré-bloqueado");
    });
    await test("decisão 'always' persistida pré-aprova sem novo diálogo", () => {
        (0, MockCoreServer_1.assert)((0, trustDecision_1.needsConsentPrompt)("community", "always") === false, "não deveria pedir de novo");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.isPreApproved)("community", "always") === true, "deveria estar pré-aprovado");
    });
    await test("decisão 'blocked' persistida pré-bloqueia sem novo diálogo", () => {
        (0, MockCoreServer_1.assert)((0, trustDecision_1.needsConsentPrompt)("community", "blocked") === false, "não deveria pedir de novo");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.isPreBlocked)("community", "blocked") === true, "deveria estar pré-bloqueado");
    });
    await test("resolveConsentChoice mapeia o texto do botão pra cada escolha", () => {
        (0, MockCoreServer_1.assert)((0, trustDecision_1.resolveConsentChoice)("Permitir uma vez") === "allow-once", "permitir uma vez");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.resolveConsentChoice)("Sempre confiar") === "always-trust", "sempre confiar");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.resolveConsentChoice)("Bloquear") === "block", "bloquear");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.resolveConsentChoice)(undefined) === "dismissed", "fechado sem escolha == dismissed");
    });
    await test("shouldLoadLibrary só permite carregar em allow-once/always-trust", () => {
        (0, MockCoreServer_1.assert)((0, trustDecision_1.shouldLoadLibrary)("allow-once") === true, "allow-once carrega");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.shouldLoadLibrary)("always-trust") === true, "always-trust carrega");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.shouldLoadLibrary)("block") === false, "block não carrega");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.shouldLoadLibrary)("dismissed") === false, "dismissed não carrega");
    });
    await test("decisionToPersist só persiste always-trust/block, nunca allow-once/dismissed", () => {
        (0, MockCoreServer_1.assert)((0, trustDecision_1.decisionToPersist)("always-trust") === "always", "always-trust persiste 'always'");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.decisionToPersist)("block") === "blocked", "block persiste 'blocked'");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.decisionToPersist)("allow-once") === undefined, "allow-once nunca persiste");
        (0, MockCoreServer_1.assert)((0, trustDecision_1.decisionToPersist)("dismissed") === undefined, "dismissed nunca persiste");
    });
    const { failed } = finish();
    process.exitCode = failed > 0 ? 1 : 0;
})();
//# sourceMappingURL=trustDecision.test.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MockCoreServer_1 = require("./ipc/testSupport/MockCoreServer");
const language_1 = require("./language");
(async () => {
    const { test, finish } = (0, MockCoreServer_1.createTestRunner)("language — resolveLasecSimulLanguage");
    await test("configuração explícita pt-BR sempre vence, mesmo com sistema em inglês", () => {
        (0, MockCoreServer_1.assert)((0, language_1.resolveLasecSimulLanguage)("pt-BR", "en-US") === "pt-BR", "deveria respeitar pt-BR configurado");
    });
    await test("configuração explícita en sempre vence, mesmo com sistema em português", () => {
        (0, MockCoreServer_1.assert)((0, language_1.resolveLasecSimulLanguage)("en", "pt-BR") === "en", "deveria respeitar en configurado");
    });
    await test("'system' cai pro idioma do VSCode: prefixo 'pt' -> pt-BR", () => {
        (0, MockCoreServer_1.assert)((0, language_1.resolveLasecSimulLanguage)("system", "pt-PT") === "pt-BR", "pt-PT deveria resolver pra pt-BR");
        (0, MockCoreServer_1.assert)((0, language_1.resolveLasecSimulLanguage)("system", "PT-br") === "pt-BR", "case-insensitive");
    });
    await test("'system' cai pro idioma do VSCode: qualquer outro prefixo -> en", () => {
        (0, MockCoreServer_1.assert)((0, language_1.resolveLasecSimulLanguage)("system", "en-US") === "en", "en-US deveria resolver pra en");
        (0, MockCoreServer_1.assert)((0, language_1.resolveLasecSimulLanguage)("system", "es-ES") === "en", "idioma sem suporte cai pra en");
    });
    await test("valor de configuração desconhecido (nem pt-BR, nem en, nem system) cai pro idioma do sistema", () => {
        (0, MockCoreServer_1.assert)((0, language_1.resolveLasecSimulLanguage)("fr", "pt-BR") === "pt-BR", "config inválida degrada pro mesmo caminho de 'system'");
    });
    const { failed } = finish();
    process.exitCode = failed > 0 ? 1 : 0;
})();
//# sourceMappingURL=language.test.js.map
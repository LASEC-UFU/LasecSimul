"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const UnifiedCatalog_1 = require("./UnifiedCatalog");
// ── utilitários de teste (mesmo padrão de ipc/CoreClient.test.ts) ──────────────
let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    }
    catch (e) {
        console.error(`  ✗ ${name}: ${e.message}`);
        failed++;
    }
}
function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}
// ── suite de testes ─────────────────────────────────────────────────────────────
// resolveLocalizedItems implementa o algoritmo de fallback de `lasecsimul.spec` seção 6.3.3
// (idioma pedido -> idioma-base do catálogo -> item sem tradução cai pra base, nunca string vazia) --
// mesmo algoritmo que `resolvePropertySchemaForLanguage` implementa em C++ no Core.
const baseItems = [
    { typeId: "passive.resistor", label: "Resistor", pinCount: 2, folderPath: ["Passivos", "Resistores"] },
    { typeId: "other.ground", label: "Terra (0 V)", pinCount: 1, folderPath: ["Fontes"] },
];
const translations = {
    en: {
        items: {
            "passive.resistor": { label: "Resistor", folderPath: ["Passive", "Resistors"] },
        },
    },
};
console.log("\nUnifiedCatalog — resolveLocalizedItems\n");
test("sem requestedLanguage devolve os itens originais sem cópia", () => {
    const resolved = (0, UnifiedCatalog_1.resolveLocalizedItems)(baseItems, undefined, "pt-BR", translations);
    assert(resolved === baseItems, "caminho rápido: mesma referência, sem alocação");
});
test("requestedLanguage igual à base devolve os itens originais", () => {
    const resolved = (0, UnifiedCatalog_1.resolveLocalizedItems)(baseItems, "pt-BR", "pt-BR", translations);
    assert(resolved === baseItems, "língua pedida == língua-base: sem resolução nenhuma");
});
test("sem translations no arquivo devolve os itens originais", () => {
    const resolved = (0, UnifiedCatalog_1.resolveLocalizedItems)(baseItems, "en", "pt-BR", undefined);
    assert(resolved === baseItems, "sem bloco translations: cai pra base automaticamente");
});
test("item COM tradução pra a língua pedida resolve label/folderPath traduzidos", () => {
    const resolved = (0, UnifiedCatalog_1.resolveLocalizedItems)(baseItems, "en", "pt-BR", translations);
    const resistor = resolved.find((item) => item.typeId === "passive.resistor");
    assert(resistor?.label === "Resistor", "label traduzido (mesmo texto neste caso, mas resolvido)");
    assert(JSON.stringify(resistor?.folderPath) === JSON.stringify(["Passive", "Resistors"]), "folderPath traduzido");
});
test("item SEM tradução pra a língua pedida cai pra língua-base, nunca string vazia", () => {
    const resolved = (0, UnifiedCatalog_1.resolveLocalizedItems)(baseItems, "en", "pt-BR", translations);
    const ground = resolved.find((item) => item.typeId === "other.ground");
    assert(ground?.label === "Terra (0 V)", "ground não tem tradução 'en' -- mantém o label da base");
    assert(JSON.stringify(ground?.folderPath) === JSON.stringify(["Fontes"]), "folderPath da base preservado");
});
test("língua pedida sem nenhuma tradução no arquivo (ex: 'fr') cai pra base inteira", () => {
    const resolved = (0, UnifiedCatalog_1.resolveLocalizedItems)(baseItems, "fr", "pt-BR", translations);
    assert(resolved === baseItems, "'fr' não existe em translations -- devolve a base sem alteração");
});
console.log(`\nResultado: ${passed} passaram, ${failed} falharam\n`);
process.exitCode = failed > 0 ? 1 : 0;
//# sourceMappingURL=UnifiedCatalog.test.js.map
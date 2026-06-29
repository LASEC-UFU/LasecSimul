"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MockCoreServer_1 = require("../ipc/testSupport/MockCoreServer");
const catalogMerge_1 = require("./catalogMerge");
function component(typeId, label) {
    return { id: `${typeId}-${label}`, typeId, x: 0, y: 0, rotation: 0, label, pins: [], properties: {} };
}
function catalogEntry(typeId, overrides = {}) {
    return { typeId, label: typeId, category: "Passivos", pinCount: 2, defaultProperties: {}, ...overrides };
}
function schemaDto(overrides = {}) {
    return {
        id: "resistance",
        label: "Resistência",
        group: "Elétrico",
        unit: "Ω",
        valueKind: "number",
        editor: "number",
        default: 220,
        hidden: false,
        readOnly: false,
        noCopy: false,
        affectsTopology: false,
        requiresRestart: false,
        showOnSymbol: true,
        ...overrides,
    };
}
(async () => {
    const { test, finish } = (0, MockCoreServer_1.createTestRunner)("catalogMerge — testes puros");
    await test("nextIndexedLabel conta por typeId com tipos intercalados", () => {
        const existing = [
            component("core.resistor", "Resistor-1"),
            component("core.capacitor", "Capacitor-1"),
        ];
        (0, MockCoreServer_1.assert)((0, catalogMerge_1.nextIndexedLabel)("core.resistor", "Resistor", existing) === "Resistor-2", "deveria ser Resistor-2");
        (0, MockCoreServer_1.assert)((0, catalogMerge_1.nextIndexedLabel)("core.capacitor", "Capacitor", existing) === "Capacitor-2", "deveria ser Capacitor-2");
        (0, MockCoreServer_1.assert)((0, catalogMerge_1.nextIndexedLabel)("core.led", "LED", existing) === "LED-1", "tipo novo começa em 1");
    });
    await test("nextIndexedLabel ignora label renomeado manualmente fora do padrão", () => {
        const existing = [component("core.resistor", "Pull-up R1")];
        (0, MockCoreServer_1.assert)((0, catalogMerge_1.nextIndexedLabel)("core.resistor", "Resistor", existing) === "Resistor-1", "label fora do padrão não conta");
    });
    await test("hasShowOnSymbolProperty: true quando algum schema tem showOnSymbol", () => {
        const entry = catalogEntry("core.resistor", {
            propertySchema: [{ id: "resistance", label: "R", group: "g", unit: "Ω", editor: "number", default: 0, showOnSymbol: true }],
        });
        (0, MockCoreServer_1.assert)((0, catalogMerge_1.hasShowOnSymbolProperty)(entry) === true, "deveria detectar showOnSymbol");
    });
    await test("hasShowOnSymbolProperty: false sem schema ou sem showOnSymbol", () => {
        (0, MockCoreServer_1.assert)((0, catalogMerge_1.hasShowOnSymbolProperty)(undefined) === false, "undefined -> false");
        (0, MockCoreServer_1.assert)((0, catalogMerge_1.hasShowOnSymbolProperty)(catalogEntry("core.led")) === false, "sem propertySchema -> false");
    });
    await test("toWebviewPropertySchema espelha campos e zera default-objeto (point)", () => {
        const dto = schemaDto({ default: { x: 1, y: 2 }, valueKind: "point" });
        const entry = (0, catalogMerge_1.toWebviewPropertySchema)(dto);
        (0, MockCoreServer_1.assert)(entry.default === 0, "default do tipo point deve cair pra 0 na Webview");
        (0, MockCoreServer_1.assert)(entry.unit === "Ω", "unit deve ser preservado");
        (0, MockCoreServer_1.assert)(entry.showOnSymbol === true, "showOnSymbol deve ser preservado");
    });
    await test("mergePropertySchemas anexa schema por typeId quando presente no mapa", () => {
        const catalog = [catalogEntry("core.resistor"), catalogEntry("core.capacitor")];
        const merged = (0, catalogMerge_1.mergePropertySchemas)(catalog, { "core.resistor": [schemaDto()] });
        (0, MockCoreServer_1.assert)(merged[0]?.propertySchema?.length === 1, "resistor deveria ganhar schema");
        (0, MockCoreServer_1.assert)(merged[1]?.propertySchema === undefined, "capacitor sem entrada no mapa não deve ganhar schema");
    });
    await test("mergePropertySchemas usa o mapa passado (simula troca de idioma pt-BR/en)", () => {
        const catalog = [catalogEntry("core.resistor")];
        const ptBr = (0, catalogMerge_1.mergePropertySchemas)(catalog, { "core.resistor": [schemaDto({ label: "Resistência" })] });
        const en = (0, catalogMerge_1.mergePropertySchemas)(catalog, { "core.resistor": [schemaDto({ label: "Resistance" })] });
        (0, MockCoreServer_1.assert)(ptBr[0]?.propertySchema?.[0]?.label === "Resistência", "merge pt-BR deveria usar o mapa pt-BR");
        (0, MockCoreServer_1.assert)(en[0]?.propertySchema?.[0]?.label === "Resistance", "merge en deveria usar o mapa en, não o pt-BR anterior");
    });
    await test("mergePropertySchemas não modifica o catálogo original (imutável)", () => {
        const catalog = [catalogEntry("core.resistor")];
        (0, catalogMerge_1.mergePropertySchemas)(catalog, { "core.resistor": [schemaDto()] });
        (0, MockCoreServer_1.assert)(catalog[0]?.propertySchema === undefined, "catálogo original não deve ser mutado");
    });
    const { failed } = finish();
    process.exitCode = failed > 0 ? 1 : 0;
})();
//# sourceMappingURL=catalogMerge.test.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MockCoreServer_1 = require("../../ipc/testSupport/MockCoreServer");
const paletteTree_1 = require("./paletteTree");
const catalog = [
    {
        typeId: "sources.dc_voltage",
        label: "Fonte de Tensao",
        category: "Fontes",
        folderPath: ["Fontes"],
        pinCount: 2,
        defaultProperties: {},
    },
    {
        typeId: "passive.resistor",
        label: "Resistor",
        category: "Passivos",
        subcategory: "Resistores",
        folderPath: ["Passivos", "Resistores"],
        pinCount: 2,
        defaultProperties: {},
    },
    {
        typeId: "instruments.voltmeter",
        label: "Voltimetro",
        category: "Medidores",
        folderPath: ["Medidores"],
        pinCount: 2,
        defaultProperties: {},
    },
];
(async () => {
    const { test, finish } = (0, MockCoreServer_1.createTestRunner)("paletteTree");
    await test("resolvePaletteFolderPath usa folderPath explicito quando presente", () => {
        const resistorEntry = catalog[1];
        (0, MockCoreServer_1.assert)(Boolean(resistorEntry), "entrada de resistor deveria existir");
        const path = (0, paletteTree_1.resolvePaletteFolderPath)(resistorEntry);
        (0, MockCoreServer_1.assert)(JSON.stringify(path) === JSON.stringify(["Passivos", "Resistores"]), "deveria preservar o folderPath declarado");
    });
    await test("resolvePaletteFolderPath cai para category/subcategory quando folderPath nao existe", () => {
        const path = (0, paletteTree_1.resolvePaletteFolderPath)({
            category: "Interruptores",
            subcategory: "Chaves",
        });
        (0, MockCoreServer_1.assert)(JSON.stringify(path) === JSON.stringify(["Interruptores", "Chaves"]), "deveria montar o caminho hierarquico pelo fallback");
    });
    await test("buildPaletteTree filtra por texto ignorando maiusculas e acentos", () => {
        const tree = (0, paletteTree_1.buildPaletteTree)(catalog, "tensao");
        const root = tree[0];
        (0, MockCoreServer_1.assert)(root?.kind === "folder" && root.label === "Fontes", "deveria manter apenas a pasta Fontes");
        if (!root || root.kind !== "folder")
            throw new Error("raiz esperada ausente");
        const child = root.children[0];
        (0, MockCoreServer_1.assert)(child?.kind === "component" && child.label === "Fonte de Tensao", "deveria manter o componente correspondente");
    });
    await test("buildPaletteTree encontra por caminho de categoria e remove ramos sem match", () => {
        const tree = (0, paletteTree_1.buildPaletteTree)(catalog, "resistores");
        (0, MockCoreServer_1.assert)(tree.length === 1, "somente o ramo Passivos deveria permanecer");
        const root = tree[0];
        (0, MockCoreServer_1.assert)(root?.kind === "folder" && root.label === "Passivos", "a raiz deveria ser Passivos");
        if (!root || root.kind !== "folder")
            throw new Error("raiz Passivos ausente");
        const childFolder = root.children[0];
        (0, MockCoreServer_1.assert)(childFolder?.kind === "folder" && childFolder.label === "Resistores", "a subpasta Resistores deveria existir");
        const leaf = childFolder?.kind === "folder" ? childFolder.children[0] : undefined;
        (0, MockCoreServer_1.assert)(leaf?.kind === "component" && leaf.typeId === "passive.resistor", "o resistor deveria ser o unico item do resultado");
    });
    await test("buildPaletteTree ignora entradas hidden", () => {
        const tree = (0, paletteTree_1.buildPaletteTree)([
            ...catalog,
            {
                typeId: "connectors.junction",
                label: "Juncao",
                category: "Conectores",
                folderPath: ["Conectores"],
                pinCount: 1,
                defaultProperties: {},
                hidden: true,
            },
        ], "juncao");
        (0, MockCoreServer_1.assert)(tree.length === 0, "itens ocultos nao devem aparecer na busca");
    });
    const { failed } = finish();
    process.exitCode = failed > 0 ? 1 : 0;
})();
//# sourceMappingURL=paletteTree.test.js.map
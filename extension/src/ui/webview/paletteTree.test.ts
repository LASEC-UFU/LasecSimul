import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { buildPaletteTree, resolvePaletteFolderPath, PaletteRenderableEntry } from "./paletteTree";

const catalog: PaletteRenderableEntry[] = [
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
  const { test, finish } = createTestRunner("paletteTree");

  await test("resolvePaletteFolderPath usa folderPath explicito quando presente", () => {
    const resistorEntry = catalog[1];
    assert(Boolean(resistorEntry), "entrada de resistor deveria existir");
    const path = resolvePaletteFolderPath(resistorEntry!);
    assert(JSON.stringify(path) === JSON.stringify(["Passivos", "Resistores"]), "deveria preservar o folderPath declarado");
  });

  await test("resolvePaletteFolderPath cai para category/subcategory quando folderPath nao existe", () => {
    const path = resolvePaletteFolderPath({
      category: "Interruptores",
      subcategory: "Chaves",
    });
    assert(JSON.stringify(path) === JSON.stringify(["Interruptores", "Chaves"]), "deveria montar o caminho hierarquico pelo fallback");
  });

  await test("buildPaletteTree filtra por texto ignorando maiusculas e acentos", () => {
    const tree = buildPaletteTree(catalog, "tensao");
    const root = tree[0];
    assert(root?.kind === "folder" && root.label === "Fontes", "deveria manter apenas a pasta Fontes");
    if (!root || root.kind !== "folder") throw new Error("raiz esperada ausente");
    const child = root.children[0];
    assert(child?.kind === "component" && child.label === "Fonte de Tensao", "deveria manter o componente correspondente");
  });

  await test("buildPaletteTree encontra por caminho de categoria e remove ramos sem match", () => {
    const tree = buildPaletteTree(catalog, "resistores");
    assert(tree.length === 1, "somente o ramo Passivos deveria permanecer");
    const root = tree[0];
    assert(root?.kind === "folder" && root.label === "Passivos", "a raiz deveria ser Passivos");
    if (!root || root.kind !== "folder") throw new Error("raiz Passivos ausente");
    const childFolder = root.children[0];
    assert(childFolder?.kind === "folder" && childFolder.label === "Resistores", "a subpasta Resistores deveria existir");
    const leaf = childFolder?.kind === "folder" ? childFolder.children[0] : undefined;
    assert(leaf?.kind === "component" && leaf.typeId === "passive.resistor", "o resistor deveria ser o unico item do resultado");
  });

  await test("buildPaletteTree ignora entradas hidden", () => {
    const tree = buildPaletteTree(
      [
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
      ],
      "juncao"
    );
    assert(tree.length === 0, "itens ocultos nao devem aparecer na busca");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

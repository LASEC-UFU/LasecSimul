import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { buildPaletteTree, resolvePaletteFolderPath, PaletteRenderableEntry } from "./paletteTree";
import { defaultComponentCatalog } from "./catalog";
import { controlGraphCatalog } from "../../catalog/controlGraphCatalog";

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

  await test("buildPaletteTree separa Analog e Digital rigorosamente", () => {
    const mixed: PaletteRenderableEntry[] = [
      ...catalog,
      { typeId: "logic.and_gate", label: "AND", category: "Logicos", pinCount: 3, defaultProperties: {} },
      { typeId: "digital.generic_fpga", label: "FPGA", category: "Digital", pinCount: 0, defaultProperties: {} },
    ];
    const analog = JSON.stringify(buildPaletteTree(mixed, "", "analog"));
    const digital = JSON.stringify(buildPaletteTree(mixed, "", "digital"));
    assert(analog.includes("passive.resistor"), "Analog deveria conter o resistor");
    assert(!analog.includes("logic.and_gate") && !analog.includes("digital.generic_fpga"), "Analog não deveria conter itens digitais");
    assert(digital.includes("logic.and_gate") && digital.includes("digital.generic_fpga"), "Digital deveria conter lógica e FPGA");
    assert(!digital.includes("passive.resistor"), "Digital não deveria conter o resistor");
  });

  await test("seções futuras de Controle/Processo permanecem vazias sem itens declarados", () => {
    assert(buildPaletteTree(catalog, "", "control").length === 0, "Controle deveria iniciar vazia");
    assert(buildPaletteTree(catalog, "", "process").length === 0, "Processo deveria iniciar vazia");
  });

  await test("Microcontroladores e sempre a PRIMEIRA subpasta de Analogico, mesmo chegando depois de outras no catalogo", () => {
    const withMcu: PaletteRenderableEntry[] = [
      ...catalog, // Fontes/Passivos/Medidores primeiro na lista de entrada, de propósito
      { typeId: "subcircuits.esp32_devkitc_v4", label: "ESP32 DevKitC", category: "Microcontroladores", folderPath: ["Microcontroladores"], pinCount: 0, defaultProperties: {} },
    ];
    const tree = buildPaletteTree(withMcu, "", "analog");
    assert(tree.length > 1, "deveria haver mais de uma pasta de topo em Analogico neste fixture");
    const first = tree[0];
    assert(first?.kind === "folder" && first.label === "Microcontroladores", `a primeira pasta deveria ser Microcontroladores, veio ${first?.kind === "folder" ? first.label : first?.kind}`);
    // Ordem relativa das DEMAIS pastas permanece intocada (Fontes continua vindo antes de Medidores).
    const remainingLabels = tree.slice(1).filter((node) => node.kind === "folder").map((node) => node.label);
    assert(JSON.stringify(remainingLabels) === JSON.stringify(["Fontes", "Passivos", "Medidores"]), `ordem das demais pastas nao deveria mudar, veio ${JSON.stringify(remainingLabels)}`);
  });

  await test("prioridade de pasta so se aplica dentro da aba configurada (Digital nao e afetado)", () => {
    const mixed: PaletteRenderableEntry[] = [
      { typeId: "logic.and_gate", label: "AND", category: "Logicos", folderPath: ["Logicos"], pinCount: 3, defaultProperties: {} },
      { typeId: "subcircuits.esp32_devkitc_v4", label: "ESP32 DevKitC", category: "Microcontroladores", folderPath: ["Microcontroladores"], workspaceSection: "digital", pinCount: 0, defaultProperties: {} },
    ];
    const digitalTree = buildPaletteTree(mixed, "", "digital");
    const first = digitalTree[0];
    assert(first?.kind === "folder" && first.label === "Logicos", "Digital nao tem prioridade configurada; ordem de chegada deveria valer normalmente");
  });

  await test("Conectores/Grafico saem de Analogico e passam a existir só em Miscelaneos (catalogo default)", () => {
    const analogTree = JSON.stringify(buildPaletteTree(defaultComponentCatalog, "", "analog"));
    const miscTree = JSON.stringify(buildPaletteTree(defaultComponentCatalog, "", "misc"));
    for (const typeId of ["connectors.bus", "connectors.tunnel", "connectors.socket", "connectors.header", "graphics.image", "graphics.text", "graphics.rectangle", "graphics.ellipse", "graphics.line"]) {
      assert(!analogTree.includes(typeId), `${typeId} não deveria mais aparecer em Analógico`);
      assert(miscTree.includes(typeId), `${typeId} deveria aparecer em Miscelâneos`);
    }
    assert(analogTree.includes("passive.resistor"), "Analógico ainda deveria conter componentes eletricamente analógicos, ex. resistor");
  });

  await test("túnel elétrico e túnel de sinal ficam juntos em Miscelâneos > Conectores", () => {
    const tree = buildPaletteTree([...defaultComponentCatalog, ...controlGraphCatalog], "", "misc");
    const connectors = tree.find((node) => node.kind === "folder" && node.label === "Conectores");
    assert(connectors?.kind === "folder", "pasta Conectores não encontrada");
    if (connectors?.kind === "folder") {
      const types = connectors.children.filter((node) => node.kind === "component").map((node) => node.typeId);
      assert(types.includes("connectors.tunnel") && types.includes("connectors.signal_tunnel"),
        `ambos os túneis devem estar em Conectores: ${types.join(", ")}`);
    }
  });

  await test("catalogo real expoe Modbus e HART em Process/Protocolos Industriais", () => {
    const processTree = JSON.stringify(buildPaletteTree(defaultComponentCatalog, "", "process"));
    assert(processTree.includes("protocol.modbus.server") && processTree.includes("protocol.modbus.client"), "Processo deveria conter servidor e cliente Modbus");
    assert(!processTree.includes("protocol.hart.transmitter") && !processTree.includes("protocol.hart.communicator"),
      "os blocos HART de barramento virtual antigo não devem aparecer na paleta");
    const miscTree = JSON.stringify(buildPaletteTree(defaultComponentCatalog, "", "misc"));
    // O UDP direto no dispositivo saiu: o UDP agora é uma opção do Modem HART.
    assert(!miscTree.includes("peripherals.udp"), "a porta UDP direta (legado) não deveria aparecer na paleta");
    // LD301 e TT301 agora são os subcircuitos subcircuits/hart_smar_ld301 e
    // hart_smar_tt301 sobre o dispositivo HART padrão; os tipos built-in
    // antigos ficam ocultos.
    for (const typeId of ["protocol.hart.device.standard", "protocol.hart.device.smar_fy301"]) {
      assert(processTree.includes(typeId), `${typeId} deveria aparecer na paleta HART`);
    }
    assert(!processTree.includes("protocol.hart.device.smar_ld301"), "o LD301 built-in legado não deveria aparecer na paleta");
    assert(!processTree.includes("protocol.hart.device.smar_tt301"), "o TT301 built-in legado não deveria aparecer na paleta");
    // O PC fala HART pelo fio: o Modem HART (em série no laço) fica na mesma pasta.
    assert(processTree.includes("protocol.hart.modem"), "o Modem HART deveria aparecer na paleta HART");
    assert(processTree.includes("Protocolos Industriais"), "protocolos deveriam ficar sob Process/Protocolos Industriais");
  });

  await test("primitivos control.* somem da paleta de Processo e so os usados pelos modelos (e a Constante) aparecem na raiz de Controle", () => {
    const processTree = JSON.stringify(buildPaletteTree(controlGraphCatalog, "", "process"));
    assert(!processTree.includes("Controle"), "Processo nao deveria mais ter a subsecao Controle");
    assert(!processTree.includes("control."), "nenhum primitivo control.* deveria aparecer em Processo");

    const controlTree = buildPaletteTree(controlGraphCatalog, "", "control");
    const typeIds = controlTree.map((node) => (node.kind === "component" ? node.typeId : `folder:${node.label}`)).sort();
    assert(
      JSON.stringify(typeIds) === JSON.stringify(["control.calc_expression", "control.constant", "control.observer", "control.process"]),
      `Controle deveria expor so Sonda/Expressao/Processo/Constante na raiz, sem subpasta -- veio ${JSON.stringify(typeIds)}`
    );

    // `paletteHidden` some SO da paleta: `hidden` apagaria a instancia do render (ver
    // `model.ts::WebviewComponentCatalogEntry.paletteHidden`) e os modelos TDPS/os 24 blocos de
    // Controle ficariam com o conteudo invisivel no editor de subcircuito.
    for (const entry of controlGraphCatalog.filter((item) => item.typeId.startsWith("control."))) {
      assert(entry.hidden !== true, `${entry.typeId} nunca pode ser hidden -- e o conteudo visivel do editor de subcircuito`);
    }
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

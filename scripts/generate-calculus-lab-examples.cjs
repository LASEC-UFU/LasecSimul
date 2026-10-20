#!/usr/bin/env node
"use strict";

/**
 * Gera os projetos de exemplo do Laboratório de Cálculo em examples/calculo/ na modalidade das Telas HMI
 * (docs/62 §6, docs/64): cada projeto tem um botão "Laboratório de Cálculo" (Controle › Ferramentas) que
 * abre a tela do Laboratório -- uma página por atividade, montada pelos MESMOS modelos de página que o
 * produto oferece (`extension/src/visual/labScreens.ts` / `+ Página do Laboratório`), então exemplo e
 * produto não divergem. Os projetos sem planta ganham também uma página composta com os elementos
 * matemáticos da tela (parâmetros, gráfico de função, equações, tabela).
 *
 * Rode `npm run compile` em extension/ antes (usa out/). Cada planta vira um subsistema INTERNO do projeto
 * (tabela `subsystems`, a partir de subcircuits/plants.json). Nenhum JSON de exemplo é editado à mão.
 *
 * Uso: node scripts/generate-calculus-lab-examples.cjs
 */
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const out = (...parts) => require(path.join(repo, "extension", "out", ...parts));
const lab = out("ui", "webview", "lab", "activity.js");
const { createLabScreenDocument, LAB_SCREEN_TITLE } = out("visual", "labScreens.js");
const { createPlantTemplateLookup } = out("project", "plantTemplates.js");
const { importExternalAsSubsystem } = out("ui", "webview", "subsystemModel.js");
const plantTemplate = createPlantTemplateLookup(path.join(repo, "subcircuits"));

const PLANTS = {
  tank: { id: "tanque-lab", typeId: "subcircuits.process.hydraulic_tank", label: "Tanque do laboratório" },
  firstOrder: { id: "primeira-ordem-lab", typeId: "subcircuits.process.first_order_lab", label: "Primeira ordem do laboratório" },
  sensor: { id: "sensor-lab", typeId: "subcircuits.process.sensor_4_20", label: "Sensor 4–20 mA do laboratório" },
};

// O esquemático abre em zoom 1 com o painel de Propriedades cobrindo a direita: tudo fica numa coluna à
// esquerda (x = 40). O botão da tela fica onde ficava a nota de instrução (docs/64 §3.1).
const LEFT = 40;
const GAP = 40;
const SCREEN_ID = "laboratorio";

function screenButton() {
  return {
    id: "laboratorio-calculo", typeId: "tools.hmi_screen", label: LAB_SCREEN_TITLE, showValue: false, showDialValue: false,
    properties: { title: LAB_SCREEN_TITLE, screenId: SCREEN_ID, width: 176, height: 64 },
    visual: { x: LEFT, y: 20, rotation: 0 },
  };
}

const element = (id, typeId, x, y, width, height, properties) =>
  ({ id, typeId, label: id, properties: { width, height, ...properties }, visual: { x, y, width, height, rotation: 0 } });

/** Página composta só com elementos da tela (docs/62 §6.1): o professor muda qualquer um em edição. */
function functionElementsPage() {
  const light = "#e2e8f0";
  return {
    id: "pagina-funcoes-elementos",
    name: "Funções — elementos da tela",
    width: 1920,
    height: 1080,
    elements: [
      element("titulo", "graphics.label", 60, 36, 1400, 56, { text: "Como a, b e c mudam f(x) = a·x² + b·x + c? Arraste os parâmetros.", fontSize: 30, align: "start", stroke: light }),
      element("param-a", "graphics.math.parameter", 60, 140, 320, 72, { name: "a", min: -3, max: 3, step: 0.1, value: 1, decimals: 1 }),
      element("param-b", "graphics.math.parameter", 60, 232, 320, 72, { name: "b", min: -5, max: 5, step: 0.1, value: 0, decimals: 1 }),
      element("param-c", "graphics.math.parameter", 60, 324, 320, 72, { name: "c", min: -5, max: 5, step: 0.1, value: -2, decimals: 1 }),
      element("grafico", "graphics.math.function_plot", 420, 140, 1000, 600, {
        title: "Gráfico", expression: "a x^2 + b x + c", expression2: "x + 1", variable: "x", xMin: -5, xMax: 5, yMin: -6, yMax: 10,
        showGrid: true, showDerivative: false, showRoots: true,
      }),
      element("equacao-f", "graphics.math.equation", 420, 768, 1000, 84, { lhs: "f(x)", expression: "a x^2 + b x + c", variable: "x", substitute: true, fontSize: 26 }),
      element("equacao-df", "graphics.math.equation", 420, 872, 1000, 84, { lhs: "f′(x)", expression: "2 a x + b", variable: "x", substitute: true, fontSize: 26 }),
      element("tabela", "graphics.math.value_table", 1460, 140, 400, 600, { expression: "a x^2 + b x + c", variable: "x", header: "f(x)", start: -5, step: 1, rows: 11, decimals: 2 }),
    ],
  };
}

/** Faceplate (painel de operação) de cada planta (docs/62 §8, docs/64 §5.2): documento da DEFINIÇÃO,
 * aberto por instância ("Abrir Faceplate da instância"); os elementos ligam-se aos componentes internos
 * por id e os sliders comandam `@<interno>.value` da instância. */
const light = "#e2e8f0";
const display = (id, x, y, label, source, unit, decimals) =>
  element(id, "graphics.value_display", x, y, 200, 56, { label, bindSource: source, bindUnit: unit, bindDecimals: decimals });
const caption = (id, x, y, text) => element(id, "graphics.label", x, y, 400, 22, { text, fontSize: 14, align: "start", stroke: light });
const slider = (id, x, y, target, min, max, step, value) => element(id, "graphics.slider", x, y, 400, 40, {
  actionTarget: target, actionProperty: "value", actionMode: "set", actionMin: min, actionMax: max, actionStep: step, value, bindSource: target, bindMin: min, bindMax: max,
});
const FACEPLATES = {
  tank: (title) => [
    element("fp-titulo", "graphics.label", 20, 14, 700, 36, { text: title, fontSize: 22, align: "start", stroke: light }),
    element("fp-tanque", "graphics.tank_svg", 30, 70, 200, 300, { bindSource: "level_percent", bindMin: 0, bindMax: 100, bindUnit: "%" }),
    display("fp-volume", 260, 70, "Volume", "acc", "L", 2),
    display("fp-nivel", 260, 136, "Nível h", "h", "m", 3),
    display("fp-entrada", 260, 202, "Entrada", "c_qin", "L/s", 2),
    display("fp-saida", 260, 268, "Saída demandada", "q_out", "L/s", 2),
    display("fp-transbordo", 260, 334, "Transbordo", "obs_overflow", "L/s", 2),
    display("fp-area", 260, 400, "Área A", "c_area", "m²", 3),
    caption("fp-rotulo-entrada", 500, 60, "Vazão de entrada (L/s)"),
    slider("fp-slider-entrada", 500, 84, "c_qin", 0, 5, 0.1, 1),
    caption("fp-rotulo-area", 500, 140, "Área A (m²)"),
    slider("fp-slider-area", 500, 164, "c_area", 0.02, 0.5, 0.01, 0.1),
    element("fp-tendencia", "graphics.math.trend", 500, 226, 440, 290, { title: "Nível h(t)", bindSource: "h", bindUnit: "m", bindDecimals: 3, windowSeconds: 60 }),
  ],
  firstOrder: (title) => [
    element("fp-titulo", "graphics.label", 20, 14, 700, 36, { text: title, fontSize: 22, align: "start", stroke: light }),
    display("fp-u", 40, 70, "Entrada u", "c_u", "", 2),
    display("fp-y", 40, 136, "Saída y", "fo", "", 3),
    caption("fp-rotulo-u", 300, 60, "Entrada u (degrau)"),
    slider("fp-slider-u", 300, 84, "c_u", -10, 10, 0.5, 1),
    element("fp-tendencia", "graphics.math.trend", 40, 210, 880, 310, { title: "Resposta y(t)", bindSource: "fo", bindDecimals: 3, windowSeconds: 30 }),
  ],
  sensor: (title) => [
    element("fp-titulo", "graphics.label", 20, 14, 700, 36, { text: title, fontSize: 22, align: "start", stroke: light }),
    display("fp-p", 40, 70, "Pressão P", "c_p", "kPa", 1),
    display("fp-i", 40, 136, "Corrente I", "i_loop", "mA", 2),
    caption("fp-rotulo-p", 300, 60, "Pressão P (kPa)"),
    slider("fp-slider-p", 300, 84, "c_p", 0, 300, 5, 100),
    element("fp-tendencia", "graphics.math.trend", 40, 210, 880, 310, { title: "Corrente I(t)", bindSource: "i_loop", bindUnit: "mA", bindDecimals: 2, windowSeconds: 30 }),
  ],
};

function faceplate(kind, typeId, name) {
  const pageId = "faceplate-operacao";
  return {
    schemaVersion: 1, id: `faceplate:${typeId}`, kind: "faceplate", title: name,
    presentation: { fullscreenContext: "hmi", startInOperation: true },
    startPageId: pageId,
    pages: [{ id: pageId, name: "Operação", width: 960, height: 540, elements: FACEPLATES[kind](`${name} — operação`) }],
  };
}

function project(kinds) {
  const activities = lab.defaultActivities().filter((a) => kinds.includes(a.kind)).map((a) => (PLANTS[a.kind] ? { ...a, plantComponentId: PLANTS[a.kind].id } : a));
  const plants = Object.entries(PLANTS).filter(([kind]) => kinds.includes(kind));
  let y = 120;
  let subsystems = [];
  const kindByTypeId = new Map();
  const components = plants.map(([kind, p]) => {
    const template = plantTemplate(p.typeId);
    if (!template) throw new Error(`planta-modelo ausente em subcircuits/plants.json: ${p.typeId}`);
    const imported = importExternalAsSubsystem(subsystems, template.manifest, { reuseEquivalent: true });
    subsystems = imported.table;
    kindByTypeId.set(imported.typeId, kind);
    const component = {
      id: p.id, typeId: imported.typeId, properties: {}, label: p.label, showValue: false, showDialValue: false, visual: { x: LEFT, y, rotation: 0 },
    };
    y += (template.manifest.symbol?.height ?? 200) + GAP;
    return component;
  });
  subsystems = subsystems.map((definition) => (kindByTypeId.has(definition.typeId)
    ? { ...definition, faceplate: faceplate(kindByTypeId.get(definition.typeId), definition.typeId, definition.name) }
    : definition));
  const screen = createLabScreenDocument(SCREEN_ID, LAB_SCREEN_TITLE, lab.validateCalculusLab({ schemaVersion: 1, activities }).activities);
  if (kinds.includes("functions")) screen.pages.push(functionElementsPage());
  return {
    schemaVersion: 2,
    components: [screenButton(), ...components],
    topology: { revision: 0, nodes: [], conductors: [] },
    visual: { viewport: { x: 0, y: 0, zoom: 1 } },
    simulationSettings: {},
    visualDocuments: [screen],
    ...(subsystems.length > 0 ? { subsystems } : {}),
  };
}

const outputs = {
  "laboratorio-calculo.lsproj": ["functions", "sensor", "limits", "axis", "firstOrder", "tank"],
  "tanque.lsproj": ["tank"],
  "primeira-ordem.lsproj": ["firstOrder"],
  "sensor.lsproj": ["sensor"],
  "funcoes-e-limites.lsproj": ["functions", "limits", "axis"],
};
const dir = path.join(repo, "examples", "calculo");
fs.mkdirSync(dir, { recursive: true });
for (const [file, kinds] of Object.entries(outputs)) {
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(project(kinds), null, 2)}\n`);
  console.log(`${file}: ${kinds.join(", ")}`);
}

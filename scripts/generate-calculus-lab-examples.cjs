#!/usr/bin/env node
"use strict";

/**
 * Gera os projetos de exemplo do Laboratório de Cálculo em examples/calculo/ a partir das atividades-modelo
 * da extensão (rode `npm run compile` em extension/ antes: usa out/ui/webview/lab/activity.js e
 * out/project/plantTemplates.js). Cada planta vira um subsistema INTERNO do projeto (tabela
 * `subsystems`, a partir de subcircuits/plants.json): plantas não são registradas no catálogo/Core global.
 *
 * Uso: node scripts/generate-calculus-lab-examples.cjs
 */
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const lab = require(path.join(repo, "extension", "out", "ui", "webview", "lab", "activity.js"));
const { createPlantTemplateLookup } = require(path.join(repo, "extension", "out", "project", "plantTemplates.js"));
const { importExternalAsSubsystem } = require(path.join(repo, "extension", "out", "ui", "webview", "subsystemModel.js"));
const plantTemplate = createPlantTemplateLookup(path.join(repo, "subcircuits"));

const PLANTS = {
  tank: { id: "tanque-lab", typeId: "subcircuits.process.hydraulic_tank", label: "Tanque do laboratório" },
  firstOrder: { id: "primeira-ordem-lab", typeId: "subcircuits.process.first_order_lab", label: "Primeira ordem do laboratório" },
  sensor: { id: "sensor-lab", typeId: "subcircuits.process.sensor_4_20", label: "Sensor 4–20 mA do laboratório" },
};

// O esquemático abre em zoom 1 com o painel de Propriedades cobrindo a direita: tudo fica numa coluna à
// esquerda (x = 40), uma planta embaixo da outra pela altura real do símbolo. Antes as plantas iam para
// x = 760 e o projeto parecia vazio (primeira ordem, sensor) ou incompleto (só o tanque aparecia).
const LEFT = 40;
const GAP = 40;

function note(id, y, text) {
  return { id, typeId: "graphics.text", properties: { text, fontSize: 14, color: "#1f2937" }, label: id, showValue: false, showDialValue: false, visual: { x: LEFT, y, rotation: 0 } };
}

function project(kinds) {
  const activities = lab.defaultActivities().filter((a) => kinds.includes(a.kind)).map((a) => (PLANTS[a.kind] ? { ...a, plantComponentId: PLANTS[a.kind].id } : a));
  const plants = Object.entries(PLANTS).filter(([kind]) => kinds.includes(kind));
  // As atividades vivem no painel do laboratório, não no esquemático: o projeto diz como abri-lo.
  const notes = [note("nota-laboratorio", 20, "Atividades: Ctrl+Shift+P → LasecSimul: Laboratório de Cálculo")];
  if (plants.length === 0) notes.push(note("nota-analiticas", 50, "Este projeto só tem atividades analíticas: não há planta no esquemático."));
  let y = 80;
  let subsystems = [];
  const components = plants.map(([, p]) => {
    const template = plantTemplate(p.typeId);
    if (!template) throw new Error(`planta-modelo ausente em subcircuits/plants.json: ${p.typeId}`);
    const imported = importExternalAsSubsystem(subsystems, template.manifest, { reuseEquivalent: true });
    subsystems = imported.table;
    const component = {
      id: p.id, typeId: imported.typeId, properties: {}, label: p.label, showValue: false, showDialValue: false, visual: { x: LEFT, y, rotation: 0 },
    };
    y += (template.manifest.symbol?.height ?? 200) + GAP;
    return component;
  });
  return {
    schemaVersion: 2,
    components: [...notes, ...components],
    topology: { revision: 0, nodes: [], conductors: [] },
    visual: { viewport: { x: 0, y: 0, zoom: 1 } },
    simulationSettings: {},
    calculusLab: lab.validateCalculusLab({ schemaVersion: 1, activities }),
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

#!/usr/bin/env node
"use strict";

/**
 * Gera os projetos de exemplo do Laboratório de Cálculo em examples/calculo/ a partir das atividades-modelo
 * da extensão (rode `npm run compile` em extension/ antes: usa out/ui/webview/lab/activity.js e
 * out/project/plantTemplates.js). Cada planta vai INCORPORADA ao projeto (`subcircuitRef.embedded`, a
 * partir de subcircuits/plants.json): plantas não são registradas no catálogo/Core global.
 *
 * Uso: node scripts/generate-calculus-lab-examples.cjs
 */
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const lab = require(path.join(repo, "extension", "out", "ui", "webview", "lab", "activity.js"));
const { createPlantTemplateLookup, embeddedPlantRef } = require(path.join(repo, "extension", "out", "project", "plantTemplates.js"));
const plantTemplate = createPlantTemplateLookup(path.join(repo, "subcircuits"));

const PLANTS = {
  tank: { id: "tanque-lab", typeId: "subcircuits.process.hydraulic_tank", label: "Tanque do laboratório", x: 160, y: 80 },
  firstOrder: { id: "primeira-ordem-lab", typeId: "subcircuits.process.first_order_lab", label: "Primeira ordem do laboratório", x: 760, y: 80 },
  sensor: { id: "sensor-lab", typeId: "subcircuits.process.sensor_4_20", label: "Sensor 4–20 mA do laboratório", x: 760, y: 360 },
};

function project(kinds) {
  const activities = lab.defaultActivities().filter((a) => kinds.includes(a.kind)).map((a) => (PLANTS[a.kind] ? { ...a, plantComponentId: PLANTS[a.kind].id } : a));
  const components = Object.entries(PLANTS).filter(([kind]) => kinds.includes(kind)).map(([, p]) => {
    const template = plantTemplate(p.typeId);
    if (!template) throw new Error(`planta-modelo ausente em subcircuits/plants.json: ${p.typeId}`);
    return {
      id: p.id, typeId: p.typeId, properties: {}, label: p.label, showValue: false, showDialValue: false, visual: { x: p.x, y: p.y, rotation: 0 },
      subcircuitRef: embeddedPlantRef(template),
    };
  });
  return {
    schemaVersion: 2,
    components,
    topology: { revision: 0, nodes: [], conductors: [] },
    visual: { viewport: { x: 0, y: 0, zoom: 1 } },
    simulationSettings: {},
    calculusLab: lab.validateCalculusLab({ schemaVersion: 1, activities }),
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

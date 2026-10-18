#!/usr/bin/env node
"use strict";

/**
 * Gera um `.lsproj` independente para cada planta-modelo de `subcircuits/plants.json`: o projeto traz a
 * planta INCORPORADA (`subcircuitRef.embedded`) e abre sem depender de nenhum registro global -- é a
 * forma de guardar/reabrir/importar ("Importar Circuito") uma planta desde que elas saíram da paleta.
 *
 * Nunca sobrescreve: se `<nome>.lsproj` já existe com OUTRO conteúdo, grava `<nome> (2).lsproj`,
 * `(3)`...; se já existe um arquivo idêntico, não grava nada. Cada arquivo gravado é relido pelo
 * `ProjectSerializer` real antes de ser contado como criado.
 *
 * Uso: node scripts/generate-plant-projects.cjs <pasta-destino> [--dry-run]
 * (rode `npm run compile` em extension/ antes: usa out/project/plantTemplates.js e ProjectSerializer.js)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const { loadPlantTemplates, loadPlantTemplate, buildStandalonePlantProject } = require(path.join(repo, "extension", "out", "project", "plantTemplates.js"));
const { ProjectSerializer } = require(path.join(repo, "extension", "out", "project", "ProjectSerializer.js"));

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target) throw new Error("uso: node scripts/generate-plant-projects.cjs <pasta-destino> [--dry-run]");
  const targetDir = path.resolve(target);
  const templateDir = path.join(repo, "subcircuits");
  const serializer = new ProjectSerializer();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-plant-projects-"));
  if (!dryRun) fs.mkdirSync(targetDir, { recursive: true });

  const report = [];
  try {
    for (const template of loadPlantTemplates(templateDir)) {
      const loaded = loadPlantTemplate(templateDir, template);
      const staged = path.join(scratch, template.project);
      await serializer.save(staged, buildStandalonePlantProject(loaded));
      const content = fs.readFileSync(staged);

      const base = path.basename(template.project, ".lsproj");
      let destination = path.join(targetDir, template.project);
      let status = "criado";
      for (let index = 2; fs.existsSync(destination); index += 1) {
        if (fs.readFileSync(destination).equals(content)) { status = "já existia idêntico"; break; }
        destination = path.join(targetDir, `${base} (${index}).lsproj`);
      }
      if (status === "criado" && !dryRun) {
        fs.copyFileSync(staged, destination, fs.constants.COPYFILE_EXCL);
        const reloaded = await serializer.load(destination);
        const ref = reloaded.components[0] && reloaded.components[0].subcircuitRef;
        if (!ref || !ref.embedded || ref.embedded.typeId !== template.typeId) throw new Error(`${destination}: planta incorporada ausente após releitura`);
      }
      report.push({ typeId: template.typeId, file: destination, status: dryRun && status === "criado" ? "seria criado" : status, bytes: content.length });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  for (const entry of report) console.log(`${entry.status.padEnd(20)} ${entry.typeId.padEnd(52)} ${entry.file}`);
  console.log(`${report.filter((entry) => entry.status === "criado").length} criado(s), ${report.length} planta(s) no índice`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

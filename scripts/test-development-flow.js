#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));

const tasks = readJson(path.join("extension", ".vscode", "tasks.json"));
const defaultBuild = tasks.tasks.find(
  (task) => task.group && task.group.kind === "build" && task.group.isDefault === true
);
assert(defaultBuild, "o workspace da extensão precisa ter uma tarefa de build padrão");
assert.strictEqual(defaultBuild.command, "node");
assert(
  Array.isArray(defaultBuild.args) &&
    defaultBuild.args.includes("../scripts/build-development.js"),
  "F5 deve recompilar o runtime nativo por build-development.js"
);

const launch = readJson(path.join("extension", ".vscode", "launch.json"));
for (const configuration of launch.configurations) {
  assert.strictEqual(
    configuration.preLaunchTask,
    "${defaultBuildTask}",
    `${configuration.name} precisa executar o build completo antes de iniciar`
  );
}

const ssdRegression = launch.configurations.find(
  (configuration) => configuration.name === "Run SSD1306 regression (II1P04)"
);
assert(ssdRegression, "a configuração reproduzível do SSD1306 precisa existir");
assert(
  ssdRegression.env &&
    /II1P04_GPIO_Debug\/lasecSimul\/display\.lsproj$/.test(
      ssdRegression.env.LASECSIMUL_E2E_FIXTURE
    ),
  "a regressão SSD1306 deve abrir o display.lsproj correto, sem reutilizar a janela anterior"
);

const developmentBuild = fs.readFileSync(
  path.join(repoRoot, "scripts", "build-development.js"),
  "utf8"
);
for (const requiredBuild of [
  "build-core.js",
  "build-devices.js",
  "build-mcu-adapters.js",
  "compile.js",
]) {
  assert(
    developmentBuild.includes(requiredBuild),
    `build-development.js não executa ${requiredBuild}`
  );
}

const shippedSubcircuitsDir = path.join(repoRoot, "subcircuits");
for (const fileName of fs.readdirSync(shippedSubcircuitsDir).filter((name) => name.endsWith(".lssubcircuit"))) {
  const document = readJson(path.join("subcircuits", fileName));
  for (const component of document.components ?? []) {
    assert(
      !component.properties?.firmwarePath,
      `${fileName}:${component.id} não pode fixar firmware de um projeto na definição compartilhada`
    );
  }
}

const mcuCommands = fs.readFileSync(
  path.join(repoRoot, "extension", "src", "mcu", "mcuCommands.ts"),
  "utf8"
);
assert(
  mcuCommands.includes("__ui_exposedMcu_"),
  "firmware de MCU exposto deve ser persistido na instância do projeto"
);

console.log("OK: F5 recompila o runtime completo, abre o projeto correto e firmware de placa é isolado por projeto.");

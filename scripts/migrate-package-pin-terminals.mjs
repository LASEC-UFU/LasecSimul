#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fileArgument = process.argv.slice(2).find(argument => !argument.startsWith("--"));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = fileArgument
  ? path.resolve(fileArgument)
  : path.join(repositoryRoot, "project/schema/component-catalog.json");
const checkOnly = process.argv.includes("--check");
const document = JSON.parse(fs.readFileSync(file, "utf8"));
const convention = "simulide-terminal-v1";
const isCanonicalDocument = document.geometryConvention === convention;
let migrated = 0;
let canonical = 0;
let redundantStaticLayouts = 0;
let overlappingDynamicPins = 0;
let simulideLocalPackages = 0;

function shifted(value, delta) {
  if (delta === 0) return value;
  if (typeof value === "number") return Math.abs(value + delta) < 1e-12 ? 0 : value + delta;
  if (value && typeof value === "object") return { ...value, offset: (value.offset ?? 0) + delta };
  throw new Error(`Coordenada de pino inválida: ${JSON.stringify(value)}`);
}

function migratePin(pin, owner) {
  if (isCanonicalDocument) {
    if (pin.leadOrigin !== undefined) throw new Error(`${owner}: catálogo canônico não pode declarar leadOrigin`);
    canonical += 1;
    return;
  }
  if (pin.leadOrigin === "terminal") {
    delete pin.leadOrigin;
    canonical += 1;
    return;
  }
  if (pin.leadOrigin !== undefined && pin.leadOrigin !== "body") throw new Error(`${owner}: leadOrigin desconhecido`);
  if (typeof pin.angle !== "number" || typeof pin.length !== "number") {
    throw new Error(`${owner}: migração body→terminal exige angle/length numéricos`);
  }
  const radians = pin.angle * Math.PI / 180;
  pin.x = shifted(pin.x, Math.cos(radians) * pin.length);
  pin.y = shifted(pin.y, -Math.sin(radians) * pin.length);
  delete pin.leadOrigin;
  migrated += 1;
}

for (const item of document.items ?? []) {
  for (const packageKey of ["package", "logicSymbolPackage", "boardPackage"]) {
    const descriptor = item[packageKey];
    if (!descriptor) continue;
    if (descriptor.coordinateSpace === "simulide-local") {
      const bounds = descriptor.simulidePaint?.bounds;
      if (!bounds || ![bounds.x, bounds.y, bounds.w, bounds.h].every(Number.isFinite) || bounds.w <= 0 || bounds.h <= 0) {
        throw new Error(`${item.typeId}.${packageKey}: simulide-local exige simulidePaint.bounds finito e positivo`);
      }
      simulideLocalPackages += 1;
    }
    if (descriptor.dynamicLayout?.replacePins === true && (descriptor.pins?.length ?? 0) > 0) {
      redundantStaticLayouts += 1;
      if (!checkOnly) descriptor.pins = [];
    }
    const dynamicPrefixes = (descriptor.dynamicLayout?.pinGroups ?? [])
      .map(group => group.idPrefix)
      .filter(prefix => typeof prefix === "string" && prefix.length > 0);
    const overlappingPins = (descriptor.pins ?? [])
      .filter(pin => dynamicPrefixes.some(prefix => pin.id?.startsWith(prefix)));
    if (overlappingPins.length > 0) {
      overlappingDynamicPins += overlappingPins.length;
      if (!checkOnly) {
        const overlappingIds = new Set(overlappingPins.map(pin => pin.id));
        descriptor.pins = descriptor.pins.filter(pin => !overlappingIds.has(pin.id));
      }
    }
    for (const pin of descriptor.pins ?? []) migratePin(pin, `${item.typeId}.${packageKey}.${pin.id}`);
    for (const [index, group] of (descriptor.dynamicLayout?.pinGroups ?? []).entries()) {
      migratePin(group, `${item.typeId}.${packageKey}.pinGroups[${index}]`);
    }
  }
}

document.geometryConvention = convention;

if (checkOnly) {
  if (migrated > 0) throw new Error(`${migrated} pino(s) ainda usam a convenção legada body-contact`);
  if (redundantStaticLayouts > 0) throw new Error(`${redundantStaticLayouts} package(s) repetem pinos estáticos apesar de dynamicLayout.replacePins`);
  if (overlappingDynamicPins > 0) throw new Error(`${overlappingDynamicPins} pino(s) estáticos sobrepõem prefixos de dynamicLayout.pinGroups`);
  console.log(`${canonical} pino(s) canônicos; ${simulideLocalPackages} package(s) em espaço local SimulIDE; nenhuma duplicação legada encontrada`);
} else {
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`${migrated} body-contact→terminal; ${canonical} já eram terminais; ${redundantStaticLayouts} layout(s) estático(s) redundante(s) removido(s); ${overlappingDynamicPins} pino(s) sobreposto(s) removido(s); ${simulideLocalPackages} package(s) em espaço local SimulIDE`);
}

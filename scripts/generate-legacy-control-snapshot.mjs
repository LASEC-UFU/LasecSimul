#!/usr/bin/env node
// Instantâneo CONGELADO dos blocos legados `control.*` exportados pelos subcircuitos da biblioteca
// (`subcircuits/*.lssubcircuit`), lido da revisão git informada (padrão: o commit anterior à
// migração, ab4c1efb7) -- nunca do disco, que já está no formato novo. A migração de projetos usa
// este instantâneo para remapear `@filho.prop` gravados em instâncias de subcircuitos da biblioteca
// (ex.: o kc de um PID de exercício TDPS ajustado pelo aluno) para os parâmetros dos blocos novos.
//   node scripts/generate-legacy-control-snapshot.mjs [revisão]
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const revision = process.argv[2] ?? "ab4c1efb7";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const files = git("ls-tree", "-r", "--name-only", revision, "--", "subcircuits")
  .split("\n").filter((name) => name.endsWith(".lssubcircuit")).sort();
const snapshot = {};
for (const file of files) {
  const manifest = JSON.parse(git("show", `${revision}:${file}`).replace(/^﻿/, ""));
  const exported = new Set(manifest.exportedPropertyComponentIds ?? []);
  const children = {};
  for (const component of manifest.components ?? []) {
    if (!exported.has(component.id) || typeof component.typeId !== "string" || !component.typeId.startsWith("control.")) continue;
    children[component.id] = { typeId: component.typeId, properties: component.properties ?? {} };
  }
  if (Object.keys(children).length > 0) snapshot[manifest.typeId] = children;
}

const body = JSON.stringify(snapshot, null, 2);
const out = join(root, "extension", "src", "migration", "controlLibrary", "legacyLibraryExports.ts");
writeFileSync(out, `// Gerado por scripts/generate-legacy-control-snapshot.mjs a partir de ${revision} -- nao editar.
// Blocos legados exportados pelos subcircuitos da biblioteca ANTES da migração (docs/68-69).
import type { LegacyLibrarySnapshot } from "./migrateDocument";

export const LEGACY_LIBRARY_REVISION = ${JSON.stringify(revision)};
export const LEGACY_LIBRARY_EXPORTS: LegacyLibrarySnapshot = ${body};
`);
console.log(`${Object.keys(snapshot).length} subcircuitos, ${Object.values(snapshot).reduce((n, c) => n + Object.keys(c).length, 0)} blocos -> ${out}`);

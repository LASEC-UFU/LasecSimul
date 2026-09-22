/**
 * Porte da biblioteca de símbolos P&ID do IPD Studio para o catálogo do LasecSimul.
 *
 * `ADAPTED_PORT` — o desenho vem de `src/symbols/lib/*.ts` do IPD Studio (PolyForm Noncommercial
 * 1.0.0, © Praharsh Nagpure). Ver `docs/third-party/IPD_STUDIO_PROVENANCE.md`: este projeto é
 * acadêmico/não-comercial, e o aviso de licença é preservado em cada item gerado.
 *
 * O que é portado e o que NÃO é:
 *  - portado: a GEOMETRIA (`SymbolDef.render(cfg)` devolve markup SVG em espaço local `gridSize*8`),
 *    o nome, a categoria e as opções paramétricas (`configOptions`);
 *  - não portado: runtime, canvas, roteador, portas do IPD. As portas do IPD são de conectividade
 *    P&ID e não correspondem a pinos elétricos do LasecSimul -- por isso todo símbolo entra com
 *    `pinCount: 0`, como o resto da camada gráfica (fora do solver, ver FEAT-008).
 *
 * Nada é executado em tempo de execução: o `render(cfg)` roda AQUI, na geração, e só o SVG
 * resultante vai para `project/schema/component-catalog.json`.
 *
 * Uso: `node scripts/generate-ipd-symbol-library.mjs`
 * Exige o clone de referência em `external-research/ipd-studio-current`.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ipdRoot = path.join(repoRoot, "external-research", "ipd-studio-current");
const symbolsSrc = path.join(ipdRoot, "src", "symbols");
const buildDir = path.join(repoRoot, ".lasecsimul-cache", "ipd-symbols");
const catalogPath = path.join(repoRoot, "project", "schema", "component-catalog.json");

const IPD_SOURCE_COMMIT = "4b84fb8694bc89985872690366e8be2e32a8db2b";
const IPD_LICENSE = "PolyForm Noncommercial 1.0.0";
const IPD_LICENSE_URL = "https://polyformproject.org/licenses/noncommercial/1.0.0";
const IPD_REQUIRED_NOTICE = "Copyright © 2026 Praharsh Nagpure (https://github.com/Coldbari/IPD-Studio)";
const LICENSE_NOTE = `Desenho portado do IPD Studio (${IPD_LICENSE}, © Praharsh Nagpure) — uso não comercial.`;

if (!fs.existsSync(symbolsSrc)) {
  throw new Error(`clone de referência ausente: ${symbolsSrc} (ver docs/third-party/IPD_STUDIO_PROVENANCE.md)`);
}

// ---------------------------------------------------------------------------
// 1. Compila a biblioteca de símbolos do IPD para CommonJS num cache local.
//    `index.ts` fica de fora de propósito: ele importa o registry do IPD, que
//    arrasta o app inteiro; os módulos de `lib/` só dependem do tipo.
// ---------------------------------------------------------------------------
function compileSymbolLibrary() {
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(buildDir, "src", "symbols", "lib"), { recursive: true });
  fs.copyFileSync(path.join(symbolsSrc, "types.ts"), path.join(buildDir, "src", "symbols", "types.ts"));
  for (const file of fs.readdirSync(path.join(symbolsSrc, "lib"))) {
    if (!file.endsWith(".ts") || file === "index.ts") continue;
    fs.copyFileSync(path.join(symbolsSrc, "lib", file), path.join(buildDir, "src", "symbols", "lib", file));
  }
  const tsc = path.join(repoRoot, "extension", "node_modules", "typescript", "bin", "tsc");
  const sources = [
    path.join(buildDir, "src", "symbols", "types.ts"),
    ...fs.readdirSync(path.join(buildDir, "src", "symbols", "lib")).map((f) => path.join(buildDir, "src", "symbols", "lib", f)),
  ];
  execFileSync(process.execPath, [tsc, "--module", "commonjs", "--target", "es2020", "--skipLibCheck",
    "--outDir", path.join(buildDir, "out"), ...sources], { cwd: repoRoot, stdio: "pipe" });
  return path.join(buildDir, "out", "lib");
}

function loadSymbolDefs(libDir) {
  const defs = [];
  const seen = new Set();
  for (const file of fs.readdirSync(libDir).filter((f) => f.endsWith(".js"))) {
    const module = require(path.join(libDir, file));
    for (const exported of Object.values(module)) {
      if (!Array.isArray(exported)) continue;
      for (const def of exported) {
        if (!def || typeof def.id !== "string" || typeof def.render !== "function") continue;
        if (seen.has(def.id)) continue;
        seen.add(def.id);
        defs.push({ ...def, __sourceFile: `src/symbols/lib/${file.replace(/\.js$/, ".ts")}` });
      }
    }
  }
  return defs.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// 2. Mapeamento para o catálogo
// ---------------------------------------------------------------------------

/** Categoria do IPD -> subpasta da paleta, pt-BR e en. */
const CATEGORY_FOLDER = {
  instruments: ["Instrumentos P&ID", "P&ID Instruments"],
  valves: ["Válvulas P&ID", "P&ID Valves"],
  "control-valves": ["Válvulas de Controle P&ID", "P&ID Control Valves"],
  safety: ["Segurança P&ID", "P&ID Safety"],
  "flow-elements": ["Elementos de Vazão P&ID", "P&ID Flow Elements"],
  accessories: ["Acessórios P&ID", "P&ID Accessories"],
  rotating: ["Máquinas P&ID", "P&ID Rotating"],
  vessels: ["Vasos P&ID", "P&ID Vessels"],
  heat: ["Troca Térmica P&ID", "P&ID Heat Transfer"],
  inline: ["Em Linha P&ID", "P&ID Inline"],
  control: ["Controle P&ID", "P&ID Control"],
  annotation: ["Anotação P&ID", "P&ID Annotation"],
  custom: ["Personalizados P&ID", "P&ID Custom"],
};

const typeIdOf = (id) => `graphics.pid.${id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
const iconOf = (id) => `pid-${id.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

/** Produto cartesiano das opções paramétricas, limitado para não explodir o catálogo. */
function configCombinations(configOptions, defaults) {
  const keys = Object.keys(configOptions ?? {});
  if (keys.length === 0) return [{ cfg: { ...defaults }, when: undefined }];
  let combos = [{}];
  for (const key of keys) {
    const values = configOptions[key];
    combos = combos.flatMap((base) => values.map((value) => ({ ...base, [key]: value })));
    if (combos.length > 96) break; // teto de segurança; nenhum símbolo do IPD chega perto hoje
  }
  return combos.map((combo) => ({
    cfg: { ...defaults, ...combo },
    when: Object.fromEntries(Object.entries(combo).map(([key, value]) => [key, [String(value)]])),
  }));
}

function propertySchemaFor(def, width, height) {
  const schema = [
    { id: "width", label: "Largura", group: "Geometria", unit: "px", editor: "number", default: width, min: 4, max: 4000, step: 1 },
    { id: "height", label: "Altura", group: "Geometria", unit: "px", editor: "number", default: height, min: 4, max: 4000, step: 1 },
    { id: "opacity", label: "Opacidade", group: "Aparência", unit: "", editor: "number", default: 1, min: 0, max: 1, step: 0.05 },
  ];
  for (const [key, values] of Object.entries(def.configOptions ?? {})) {
    schema.push({
      id: key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      group: "Componente", unit: "", editor: "select",
      default: String(def.defaultConfig?.[key] ?? values[0]),
      options: values.map((value) => ({ value: String(value), label: String(value) })),
    });
  }
  return schema;
}

function catalogItemFor(def) {
  const width = def.gridSize.w * 8;
  const height = def.gridSize.h * 8;
  const combos = configCombinations(def.configOptions, def.defaultConfig ?? {});
  // Uma forma `svg` por combinação de opções, filtrada por `stateVisible` -- assim um símbolo
  // paramétrico é UMA entrada de catálogo, não N typeIds quase iguais.
  const shapes = combos.map(({ cfg, when }) => ({
    kind: "svg",
    value: def.render(cfg),
    ...(when ? { stateVisible: { when } } : {}),
  }));
  const schema = propertySchemaFor(def, width, height);
  const defaultProperties = Object.fromEntries(schema.map((entry) => [entry.id, entry.default]));
  const [folderPt] = CATEGORY_FOLDER[def.category] ?? ["Outros P&ID", "P&ID Other"];
  return {
    typeId: typeIdOf(def.id),
    label: def.name,
    pinCount: 0,
    icon: iconOf(def.id),
    graphical: true,
    folderPath: ["Grafico", "P&ID", folderPt],
    category: "Grafico",
    workspaceSection: "misc",
    defaultProperties,
    propertySchema: schema,
    package: {
      width, height, border: false, background: { kind: "none" }, pins: [], shapes,
      // Proporcao faz parte do desenho: as alcas de redimensionar travam o aspecto
      // (`main.ts::renderResizeHandles`), senao um simbolo P&ID estica e deforma.
      aspect: "fixed",
      // `width`/`height` do package sao o espaco de PROJETO do SVG portado (gridSize*8); o tamanho
      // na tela vem de `schematicWidth/Height`, dirigidos pelas propriedades da instancia -- e' o
      // que faz o redimensionamento realmente escalar o desenho, em vez de so' aumentar a caixa.
      dynamicLayout: {
        schematicWidth: { prop: "width", fallback: width },
        schematicHeight: { prop: "height", fallback: height },
      },
    },
    help: { description: `${def.name} — símbolo P&ID (${def.category}). ${LICENSE_NOTE}` },
    provenance: {
      source: "IPD Studio",
      sourceCommit: IPD_SOURCE_COMMIT,
      sourceFiles: [def.__sourceFile],
      adaptation: "direct execution of the upstream SymbolDef.render geometry into a LasecSimul fixed-aspect PackageDescriptor",
      license: IPD_LICENSE,
      licenseUrl: IPD_LICENSE_URL,
      requiredNotice: IPD_REQUIRED_NOTICE,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Ícones da paleta: o MESMO markup, num viewBox com folga.
// ---------------------------------------------------------------------------
function iconSvg(def, stroke) {
  const width = def.gridSize.w * 8;
  const height = def.gridSize.h * 8;
  const markup = def.render(def.defaultConfig ?? {});
  const metadata = JSON.stringify({
    source: "IPD Studio",
    sourceCommit: IPD_SOURCE_COMMIT,
    sourceFiles: [def.__sourceFile],
    license: IPD_LICENSE,
    licenseUrl: IPD_LICENSE_URL,
    requiredNotice: IPD_REQUIRED_NOTICE,
  }).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<svg viewBox="-2 -2 ${width + 4} ${height + 4}" xmlns="http://www.w3.org/2000/svg" color="${stroke}"><metadata>${metadata}</metadata>${markup}</svg>\n`;
}

// ---------------------------------------------------------------------------
// 4. Escrita
// ---------------------------------------------------------------------------
const libDir = compileSymbolLibrary();
const defs = loadSymbolDefs(libDir);
const items = defs.map(catalogItemFor);
const ownedTypeIds = new Set(items.map((item) => item.typeId));

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const kept = catalog.items.filter((item) => !ownedTypeIds.has(item.typeId));
catalog.items = [...kept, ...items];

catalog.translations = catalog.translations ?? {};
catalog.translations.en = catalog.translations.en ?? { items: {} };
catalog.translations.en.items = catalog.translations.en.items ?? {};
for (const def of defs) {
  const [, folderEn] = CATEGORY_FOLDER[def.category] ?? ["Outros P&ID", "P&ID Other"];
  catalog.translations.en.items[typeIdOf(def.id)] = { label: def.name, folderPath: ["Graphical", "P&ID", folderEn] };
}
fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

const iconDir = path.join(repoRoot, "extension", "media", "components");
let icons = 0;
for (const def of defs) {
  for (const [theme, stroke] of [["light", "#555"], ["dark", "#bbb"]]) {
    fs.writeFileSync(path.join(iconDir, theme, `${iconOf(def.id)}.svg`), iconSvg(def, stroke), "utf8");
    icons += 1;
  }
}

const byCategory = {};
for (const def of defs) byCategory[def.category] = (byCategory[def.category] ?? 0) + 1;
console.log(`[ipd-symbols] ${defs.length} simbolos portados, ${icons} icones`);
for (const [category, count] of Object.entries(byCategory).sort()) console.log(`  ${category.padEnd(16)} ${count}`);

/**
 * Entradas de catálogo/paleta da biblioteca de blocos equivalente ao Simulink (docs/66), geradas da
 * especificação. Uma entrada por bloco (`sl.<id>`) e uma por preset (Add/Subtract/Divide...: o
 * mesmo bloco com outros padrões, como na biblioteca do Simulink). Puro: host e testes.
 */
import type { PropertySchemaEntry, WebviewComponentCatalogEntry } from "../model.js";
import { blockPackage } from "./blockSymbol.js";
import { resolveBlockPorts } from "./ports.js";
import { FUNCTION_BLOCKS_FOLDER } from "../paletteTree.js";
import { BlockLibraryFile, BlockPresetSpec, BlockSpec, blockTypeId, localized, withDefaults } from "./spec.js";

function portAffectingParams(spec: BlockSpec): Set<string> {
  const names = new Set<string>();
  for (const rule of [...spec.inputs, ...spec.outputs]) {
    if (rule.repeat) names.add(rule.repeat.param);
    for (const name of Object.keys(rule.when ?? {})) names.add(name);
  }
  return names;
}

export function blockPropertySchema(spec: BlockSpec, language: string): PropertySchemaEntry[] {
  const affectsPorts = portAffectingParams(spec);
  const defaultGroup = language.startsWith("pt") ? "Parâmetros" : "Parameters";
  return spec.params.map((param) => ({
    id: param.name,
    label: localized(param.title, language, param.name),
    group: param.group ?? defaultGroup,
    unit: "",
    editor: param.type === "bool" ? "checkbox" : param.type === "enum" ? "select" : "text",
    default: param.default,
    options: param.options?.map((option) => typeof option === "string"
      ? { value: option, label: option }
      : { value: option.value, label: localized(option.title, language, option.value) }),
    affectsPinCount: affectsPorts.has(param.name) || undefined,
    visibleWhen: param.visibleWhen,
  }));
}

function defaultsOf(spec: BlockSpec, overrides: Record<string, string | number | boolean> = {}): Record<string, string | number | boolean> {
  return withDefaults(spec, overrides);
}

function entryFor(spec: BlockSpec, library: BlockLibraryFile, language: string, preset?: BlockPresetSpec): WebviewComponentCatalogEntry {
  const typeId = blockTypeId(spec);
  const defaults = defaultsOf(spec, preset?.defaults);
  const ports = resolveBlockPorts(spec, defaults);
  const pinIds = [...ports.inputs, ...ports.outputs].map((port) => port.id);
  const symbol = blockPackage(spec, defaults, preset?.size);
  const symbolSvg = symbol.shapes?.find((shape) => shape.kind === "svg")?.value;
  const sourceLibrary = spec.simulink?.sourceBlock?.replace(/\\/g, "/").split("/")[1];
  const libraryTitle = sourceLibrary === "Additional Math & Discrete"
    ? (language.startsWith("pt") ? "Matemática Adicional e Discreto" : sourceLibrary)
    : localized(library.title, language, library.name);
  const label = preset ? localized(preset.title, language, preset.name) : localized(spec.title, language, spec.name);
  return {
    typeId: preset ? `${typeId}#${preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : typeId,
    ...(preset ? { instanceTypeId: typeId } : {}),
    label,
    category: "Controle",
    folderPath: [FUNCTION_BLOCKS_FOLDER["pt-BR"], libraryTitle],
    workspaceSection: "control",
    icon: "package",
    iconSvgInline: symbolSvg
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${symbol.width}" height="${symbol.height}" viewBox="0 0 ${symbol.width} ${symbol.height}">${symbolSvg}</svg>`
      : undefined,
    hidden: false,
    graphical: true,
    pinCount: pinIds.length,
    pinIds,
    defaultProperties: defaults,
    readoutFormat: { kind: "scalar", unit: "" },
    package: symbol,
    propertySchema: blockPropertySchema(spec, language),
    blockSpec: spec,
    help: {
      description: `${spec.name}${language.startsWith("pt") ? " — bloco equivalente ao da biblioteca " : " — equivalent of the block in library "}${library.name}.`,
      url: preset?.doc ?? spec.doc,
    },
  } as WebviewComponentCatalogEntry;
}

/** Todas as entradas (base antes dos presets do mesmo bloco). */
export function blockCatalogEntries(files: readonly BlockLibraryFile[], language: string): WebviewComponentCatalogEntry[] {
  const entries: WebviewComponentCatalogEntry[] = [];
  const ordered = [...files].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const library of ordered) for (const spec of library.blocks) entries.push(entryFor(spec, library, language));
  for (const library of ordered) for (const spec of library.blocks) for (const preset of spec.presets ?? []) entries.push(entryFor(spec, library, language, preset));
  return entries;
}

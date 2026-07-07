import * as fs from "fs";
import * as path from "path";
import { McuSerialPortEntry, PackageDescriptor, PropertySchemaEntry, WebviewComponentCatalogEntry } from "../ui/webview/model";
import { defaultComponentCatalog } from "../ui/webview/catalog";
import { sanitizeMcuSerialPorts } from "./catalogMetadata";

export type RegisteredSourceKind = "abi-device" | "mcu-adapter" | "subcircuit-file";

export interface RegisteredSource {
  id: string;
  kind: RegisteredSourceKind;
  filePath: string;
  libraryPath?: string;
  folderPath?: string[];
  removable?: boolean;
}

export interface UnifiedCatalogItem {
  typeId: string;
  label: string;
  pinCount: number;
  pinIds?: string[];
  defaultProperties?: Record<string, string | number | boolean>;
  icon?: string;
  iconFilePath?: string;
  symbolSvg?: string;
  package?: PackageDescriptor;
  propertySchema?: PropertySchemaEntry[];
  folderPath?: string[];
  category?: string;
  subcategory?: string;
  hidden?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Igual ao `m_graphical` do SimulIDE real -- ver `model.ts::WebviewComponentCatalogEntry.
   * graphical` pro papel exato (visibilidade em Modo Placa). Sem isto aqui, o campo `"graphical":
   * true` já presente em `component-catalog.json` nunca chegava na Webview -- bug encontrado ao
   * implementar o overlay de Modo Placa no circuito principal. */
  graphical?: boolean;
  serialPorts?: McuSerialPortEntry[];
}

/** Tradução de um item do catálogo pra uma língua — subconjunto dos mesmos campos visíveis
 * (`label`/`folderPath`), mesmo princípio de `.lsdevice` (`lasecsimul.spec` seção 6.3,
 * ADR 0009): campo ausente cai pra `language`-base do arquivo, nunca string vazia. */
export interface UnifiedCatalogItemTranslation {
  label?: string;
  folderPath?: string[];
}

export interface UnifiedCatalogTranslation {
  items?: Record<string, UnifiedCatalogItemTranslation>;
}

interface UnifiedCatalogFile {
  schemaVersion: number;
  deviceLibraries?: string[];
  items: UnifiedCatalogItem[];
  registeredSources?: RegisteredSource[];
  /** Língua (BCP-47) em que `items[].label`/`folderPath` deste arquivo estão escritos —
   * obrigatório por contrato (RNF12 de `lasecsimul.spec`); ausente == "pt-BR" (compatibilidade
   * com catálogo anterior a esta rodada, que já era de fato escrito em português). */
  language?: string;
  /** Por língua adicional, tradução de cada item por `typeId` — ver `lasecsimul.spec` seção 6.3. */
  translations?: Record<string, UnifiedCatalogTranslation>;
}

export interface LoadedUnifiedCatalog {
  catalog: WebviewComponentCatalogEntry[];
  deviceLibraries: string[];
  registeredSources: RegisteredSource[];
  sourcePath: string;
}

const DEFAULT_DEVICE_LIBRARIES = ["../devices/library.json"];
const DEFAULT_CATALOG_FILE: UnifiedCatalogFile = {
  schemaVersion: 1,
  deviceLibraries: [...DEFAULT_DEVICE_LIBRARIES],
  items: defaultComponentCatalog.map((entry) => ({
    typeId: entry.typeId,
    label: entry.label,
    pinCount: entry.pinCount,
    pinIds: entry.pinIds,
    defaultProperties: entry.defaultProperties,
    icon: entry.icon,
    folderPath: entry.folderPath,
    category: entry.category,
    subcategory: entry.subcategory,
    disabled: entry.disabled,
    disabledReason: entry.disabledReason,
  })),
  registeredSources: [],
};

function sanitizeFolderPath(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const segment of input) {
    const normalized = String(segment).trim();
    if (normalized) out.push(normalized);
  }
  return out;
}

/** PC-16 (.spec/lasecsimul-native-devices.spec): `item` vem de JSON externo
 * (`component-catalog.json`/registro de device) só com o CONTAINER checado (`readUnifiedCatalogFile`
 * garante que `items` é array, nunca que cada `item.pinIds` de fato é `string[]`) -- sem isto, um
 * `pinIds` mal formado (ex: string em vez de array) passava direto pro tipo `WebviewComponentCatalogEntry`
 * e derrubava `extension.ts::pinsForTypeId` com `TypeError` ao criar um componente desse typeId. */
export function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

export function entryToWebview(item: UnifiedCatalogItem): WebviewComponentCatalogEntry {
  const folderPath = sanitizeFolderPath(item.folderPath);
  const category = folderPath[0] ?? item.category ?? "Outros";
  const subcategory = folderPath.length > 1 ? folderPath[1] : item.subcategory;
  return {
    typeId: item.typeId,
    label: item.label,
    category,
    subcategory,
    folderPath,
    icon: item.icon,
    iconFilePath: item.iconFilePath,
    symbolSvg: item.symbolSvg,
    package: item.package,
    propertySchema: item.propertySchema,
    pinCount: item.pinCount,
    pinIds: sanitizeStringArray(item.pinIds),
    defaultProperties: item.defaultProperties ?? {},
    hidden: item.hidden,
    disabled: item.disabled,
    disabledReason: item.disabledReason,
    graphical: item.graphical,
    serialPorts: sanitizeMcuSerialPorts(item.serialPorts),
  };
}

function normalizeUiLanguage(requestedLanguage: string | undefined): "pt-BR" | "en" | undefined {
  if (!requestedLanguage) return undefined;
  const normalized = requestedLanguage.toLowerCase();
  if (normalized.startsWith("pt")) return "pt-BR";
  if (normalized.startsWith("en")) return "en";
  return undefined;
}

/** Resolução por fallback (`lasecsimul.spec` seção 6.3.3, ADR 0009) — mesmo algoritmo do Core
 * (`resolvePropertySchemaForLanguage` em `CoreApplication.cpp`), implementado aqui em TS porque
 * `component-catalog.json` é lido direto pela Extension, sem o Core no meio. Língua pedida → língua-
 * base do arquivo → item sem tradução pra essa língua cai pra língua-base, nunca string vazia. */
export function resolveLocalizedItems(
  items: UnifiedCatalogItem[],
  requestedLanguage: string | undefined,
  baseLanguage: string,
  translations: Record<string, UnifiedCatalogTranslation> | undefined
): UnifiedCatalogItem[] {
  const normalizedRequested = normalizeUiLanguage(requestedLanguage);
  const normalizedBase = normalizeUiLanguage(baseLanguage) ?? "pt-BR";
  if (!normalizedRequested || normalizedRequested === normalizedBase || !translations) return items;
  const translation = translations[normalizedRequested];
  if (!translation?.items) return items;
  return items.map((item) => {
    const itemTranslation = translation.items?.[item.typeId];
    if (!itemTranslation) return item;
    return {
      ...item,
      label: itemTranslation.label ?? item.label,
      folderPath: itemTranslation.folderPath ?? item.folderPath,
    };
  });
}

function catalogPathCandidates(extensionPath: string): string[] {
  return [
    path.join(extensionPath, "..", "project", "schema", "component-catalog.json"),
    path.join(extensionPath, "bundled", "project", "schema", "component-catalog.json"),
  ];
}

function catalogPath(extensionPath: string): string {
  const candidates = catalogPathCandidates(extensionPath);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? path.join(extensionPath, "..", "project", "schema", "component-catalog.json");
}

function sanitizeRegisteredSources(input: unknown): RegisteredSource[] {
  if (!Array.isArray(input)) return [];
  const out: RegisteredSource[] = [];
  for (const value of input) {
    if (typeof value !== "object" || value === null) continue;
    const source = value as Partial<RegisteredSource>;
    if (typeof source.id !== "string" || !source.id.trim()) continue;
    if (source.kind !== "abi-device" && source.kind !== "mcu-adapter" && source.kind !== "subcircuit-file") continue;
    if (typeof source.filePath !== "string" || !source.filePath.trim()) continue;
    out.push({
      id: source.id,
      kind: source.kind,
      filePath: source.filePath,
      libraryPath: typeof source.libraryPath === "string" && source.libraryPath.trim() ? source.libraryPath : undefined,
      folderPath: sanitizeFolderPath(source.folderPath),
      removable: source.removable !== false,
    });
  }
  return out;
}

function readUnifiedCatalogFile(extensionPath: string): { sourcePath: string; file: UnifiedCatalogFile } {
  const sourcePath = catalogPath(extensionPath);
  try {
    const raw = fs.readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as UnifiedCatalogFile;
    if (!Array.isArray(parsed.items)) throw new Error("items precisa ser um array");
    return { sourcePath, file: parsed };
  } catch {
    return { sourcePath, file: DEFAULT_CATALOG_FILE };
  }
}

export function loadUnifiedCatalog(extensionPath: string, requestedLanguage?: string): LoadedUnifiedCatalog {
  const { sourcePath, file } = readUnifiedCatalogFile(extensionPath);
  const baseLanguage = typeof file.language === "string" && file.language.trim() ? file.language : "pt-BR";
  const resolvedItems = resolveLocalizedItems(file.items, requestedLanguage, baseLanguage, file.translations);
  const catalog = resolvedItems.map(entryToWebview);
  const deviceLibraries = Array.isArray(file.deviceLibraries)
    ? file.deviceLibraries.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : DEFAULT_DEVICE_LIBRARIES;
  const registeredSources = sanitizeRegisteredSources(file.registeredSources);

  return { catalog, deviceLibraries, registeredSources, sourcePath };
}

export function saveRegisteredSources(extensionPath: string, registeredSources: RegisteredSource[]): string {
  const { sourcePath, file } = readUnifiedCatalogFile(extensionPath);
  const output: UnifiedCatalogFile = {
    ...file,
    schemaVersion: typeof file.schemaVersion === "number" ? file.schemaVersion : 1,
    deviceLibraries: Array.isArray(file.deviceLibraries) ? file.deviceLibraries : [...DEFAULT_DEVICE_LIBRARIES],
    items: Array.isArray(file.items) ? file.items : DEFAULT_CATALOG_FILE.items,
    registeredSources,
  };

  fs.writeFileSync(sourcePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return sourcePath;
}

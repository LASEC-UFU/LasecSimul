import * as fs from "fs";
import * as path from "path";
import { RegisteredSource } from "./UnifiedCatalog";
import { InteractionKindEntry, PackageDescriptor, WebviewComponentCatalogEntry } from "../ui/webview/model";
import { LasecSimulLanguage } from "../language";
import { currentLasecSimulLanguage } from "../currentLanguage";
import { fileExists, normalizeAbsolutePath, readJsonFile } from "../pathUtils";
import { sanitizeManifestDefaultProperties, sanitizePackage } from "./packageSanitizers";
import { sanitizeMcuSerialPorts } from "./catalogMetadata";

/** EX-9 (.spec/lasecsimul-native-devices.spec): resolução de fontes registradas (`.lsdevice`/
 * `.lssubcircuit`/mcu-adapter) pra entradas de catálogo -- extraído de `extension.ts` por ser um
 * domínio autocontido (só toca `fs`/`path`/os tipos importados abaixo, NUNCA `coreClient`/
 * `schematicState`/`schematicPanel`/etc., os estados mutáveis que o resto de `extension.ts` ainda
 * compartilha). `currentLasecSimulLanguage` é a única dependência "impura" (lê config do VSCode ao
 * vivo), por isso mora em `currentLanguage.ts` -- um arquivo folha, sem risco de import circular de
 * volta pra `extension.ts`. */

export type RegisteredItemKind = "abi-device" | "mcu-adapter" | "subcircuit-file";

export interface ResolvedRegisteredItem {
  sourceId: string;
  kind: RegisteredItemKind;
  entry: WebviewComponentCatalogEntry;
  libraryPathToLoad?: string;
  adhocSubcircuitPathToRegister?: string;
}

/** Expande UM `library.json` (arquivo canônico que pode declarar 1 ou vários dispositivos, ver
 * princípio de unicidade global de device ID) nos `RegisteredSource[]` de cada dispositivo que ele
 * declara -- mesma lógica que `catalogCommands.ts::inferSourcesFromSelectedFile` já tinha só pro
 * fluxo interativo "Registrar arquivo..." (extraída pra cá pra ser reutilizada também
 * automaticamente por TODO `deviceLibraries[]`, ver `refreshUnifiedCatalogState`). `id` é
 * DETERMINÍSTICO (derivado do path absoluto do manifesto, não `Date.now()`) -- expansão roda de
 * novo a cada refresh do catálogo, um id instável quebraria qualquer estado de UI que dependa de
 * `registeredSourceId` entre refreshes. `removable: false` -- dispositivo vindo de uma biblioteca
 * empacotada nunca é removível individualmente pela paleta (só a biblioteca inteira, editando
 * `deviceLibraries[]`). */
export function expandLibraryJsonToSources(absoluteLibraryPath: string): RegisteredSource[] {
  const json = readJsonFile(absoluteLibraryPath) as Record<string, unknown>;
  const libraryDir = path.dirname(absoluteLibraryPath);
  const sources: RegisteredSource[] = [];

  const abiEntries = Array.isArray(json.devices) ? json.devices : [];
  for (const value of abiEntries) {
    if (typeof value !== "object" || value === null) continue;
    const deviceEntry = value as { manifest?: unknown };
    if (typeof deviceEntry.manifest !== "string" || !deviceEntry.manifest.trim()) continue;
    const manifestPath = path.resolve(libraryDir, deviceEntry.manifest);
    sources.push({
      id: `bundled:abi-device:${manifestPath}`,
      kind: "abi-device",
      filePath: manifestPath,
      libraryPath: absoluteLibraryPath,
      folderPath: folderPathFromManifestFile(manifestPath),
      removable: false,
    });
  }

  const mcuEntries = Array.isArray(json.mcus) ? json.mcus : [];
  for (const value of mcuEntries) {
    if (typeof value !== "object" || value === null) continue;
    const mcuEntry = value as { manifest?: unknown };
    if (typeof mcuEntry.manifest !== "string" || !mcuEntry.manifest.trim()) continue;
    const manifestPath = path.resolve(libraryDir, mcuEntry.manifest);
    sources.push({
      id: `bundled:mcu-adapter:${manifestPath}`,
      kind: "mcu-adapter",
      filePath: manifestPath,
      libraryPath: absoluteLibraryPath,
      folderPath: folderPathFromManifestFile(manifestPath),
      removable: false,
    });
  }

  const subEntries = Array.isArray(json.subcircuits) ? json.subcircuits : [];
  for (const value of subEntries) {
    if (typeof value !== "object" || value === null) continue;
    const subEntry = value as { manifest?: unknown };
    if (typeof subEntry.manifest !== "string" || !subEntry.manifest.trim()) continue;
    const manifestPath = path.resolve(libraryDir, subEntry.manifest);
    sources.push({
      id: `bundled:subcircuit-file:${manifestPath}`,
      kind: "subcircuit-file",
      filePath: manifestPath,
      folderPath: folderPathFromManifestFile(manifestPath),
      removable: false,
    });
  }

  return sources;
}

export function inferLibraryPathForDevice(deviceFilePath: string): string | undefined {
  const candidate = path.resolve(path.dirname(deviceFilePath), "..", "library.json");
  return fileExists(candidate) ? candidate : undefined;
}

/** Subcircuitos não têm pasta por item (ver .spec/lasecsimul-subcircuits.spec seção 7 — diferença
 * deliberada de devices/mcu-adapters: arquivo único, sem binário por plataforma) -- o
 * `library.json` fica na MESMA pasta do `.lssubcircuit`, não um nível acima. */
export function inferLibraryPathForSubcircuit(manifestFilePath: string): string | undefined {
  const candidate = path.join(path.dirname(manifestFilePath), "library.json");
  return fileExists(candidate) ? candidate : undefined;
}

export function sanitizeFolderPathSegments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((segment) => String(segment).trim()).filter((segment) => segment.length > 0);
}

export function folderPathFromManifestFile(filePath: string): string[] | undefined {
  try {
    const json = readJsonFile(filePath) as Record<string, unknown>;
    const folderPath = sanitizeFolderPathSegments(json.folderPath);
    return folderPath.length > 0 ? folderPath : undefined;
  } catch {
    return undefined;
  }
}

export function folderPathFromMalformedJsonText(filePath: string): string[] | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const match = /"folderPath"\s*:\s*\[([\s\S]*?)\]/.exec(raw);
    const arrayBody = match?.[1];
    if (!arrayBody) return undefined;
    const segments: string[] = [];
    for (const segmentMatch of arrayBody.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
      const rawSegment = segmentMatch[1] ?? "";
      let segment = rawSegment;
      try {
        segment = JSON.parse(`"${rawSegment}"`) as string;
      } catch {
        // Mantem o texto cru quando o proprio escape da string estiver quebrado.
      }
      segment = segment.trim();
      if (segment) segments.push(segment);
    }
    return segments.length > 0 ? segments : undefined;
  } catch {
    return undefined;
  }
}

export function resolveFolderPath(source: RegisteredSource, fallback: string[]): string[] {
  const sourceFolder = sanitizeFolderPathSegments(source.folderPath);
  if (sourceFolder.length > 0) return sourceFolder;
  return fallback;
}

export function localizedRegisteredFolder(kind: RegisteredItemKind, language: LasecSimulLanguage): string[] {
  if (kind === "abi-device") return language === "en" ? ["Registered", "ABI"] : ["Registrados", "ABI"];
  if (kind === "mcu-adapter") return language === "en" ? ["Registered", "QEMU"] : ["Registrados", "QEMU"];
  return language === "en" ? ["Registered", "Subcircuits"] : ["Registrados", "Subcircuitos"];
}

export function localizedRegisteredRoot(language: LasecSimulLanguage): string {
  return language === "en" ? "Registered" : "Registrados";
}

export function localizedAbiFailure(reason: string, language: LasecSimulLanguage): string {
  return language === "en" ? `ABI load failed: ${reason}` : `falha ao carregar ABI: ${reason}`;
}

export function localizedBaseCatalogConflict(language: LasecSimulLanguage): string {
  return language === "en" ? "typeId already exists in the base catalog" : "typeId já existe no catálogo base";
}

export function localizedManifestName(json: Record<string, unknown>, language: LasecSimulLanguage): string | undefined {
  if (language === "en") {
    const translations = json.translations;
    if (typeof translations === "object" && translations !== null) {
      const en = (translations as Record<string, unknown>).en;
      if (typeof en === "object" && en !== null && typeof (en as Record<string, unknown>).name === "string") {
        return (en as Record<string, string>).name;
      }
    }
  }
  return typeof json.name === "string" ? json.name : undefined;
}

export const EMPTY_MCU_ADAPTER_TYPE_IDS: ReadonlySet<string> = new Set();

/** `true` se este manifesto (mcu-adapter direto, OU subcircuito com um mcu-adapter dentro) hospeda
 * um MCU -- `mcuAdapterTypeIds` é o conjunto de typeIds REAIS de mcu-adapter conhecidos nesta
 * sessão (ver `collectMcuAdapterTypeIds`), nunca um prefixo de string fixo (ex: "espressif.") --
 * genérico pra qualquer família de MCU futura (ESP32 é a única hoje, mas nada aqui depende disso). */
export function manifestHostsMcu(json: Record<string, unknown>, mcuAdapterTypeIds: ReadonlySet<string>): boolean {
  if (typeof json.chipId === "string" && json.chipId.trim()) return true;
  if (!Array.isArray(json.components)) return false;
  return json.components.some((component) =>
    typeof component === "object" &&
    component !== null &&
    typeof (component as Record<string, unknown>).typeId === "string" &&
    mcuAdapterTypeIds.has(String((component as Record<string, unknown>).typeId))
  );
}

/** Pré-varre só as fontes `kind === "mcu-adapter"` (poucas, tipicamente 1) pra descobrir seus
 * `chipId` reais ANTES de resolver subcircuitos -- sem isto, `manifestHostsMcu` não teria como saber
 * "este typeId interno É um mcu-adapter" sem abrir mão da ordem de resolução (subcircuitos podem
 * aparecer em `sources[]` antes ou depois do mcu-adapter que citam). Leitura redundante com
 * `resolveRegisteredItem` (que lê o mesmo arquivo de novo pra resolver a entrada completa), mas são
 * arquivos pequenos, lidos só na (re)construção do catálogo -- não é um caminho quente. */
export function collectMcuAdapterTypeIds(extensionPath: string, sources: RegisteredSource[]): Set<string> {
  const typeIds = new Set<string>();
  for (const source of sources) {
    if (source.kind !== "mcu-adapter") continue;
    const absoluteFilePath = normalizeAbsolutePath(extensionPath, source.filePath);
    if (!fileExists(absoluteFilePath)) continue;
    try {
      const json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
      const chipId = typeof json.chipId === "string" ? json.chipId.trim() : "";
      if (chipId) typeIds.add(chipId);
    } catch {
      // arquivo inválido -- `resolveRegisteredItem` reporta o erro de verdade ao resolver a entrada
    }
  }
  return typeIds;
}

export function normalizeExistingFilePath(basePath: string, inputPath: string | undefined): string | undefined {
  if (!inputPath || !inputPath.trim()) return undefined;
  const absolutePath = normalizeAbsolutePath(basePath, inputPath);
  return fileExists(absolutePath) ? absolutePath : undefined;
}

export function createDisabledEntry(
  source: RegisteredSource,
  kind: RegisteredItemKind,
  typeId: string,
  label: string,
  folderPath: string[],
  reason: string
): ResolvedRegisteredItem {
  const category = folderPath[0] ?? localizedRegisteredRoot(currentLasecSimulLanguage());
  const subcategory = folderPath.length > 1 ? folderPath[1] : undefined;
  return {
    sourceId: source.id,
    kind,
    entry: {
      typeId,
      label,
      pinCount: 2,
      defaultProperties: {},
      category,
      subcategory,
      folderPath,
      disabled: true,
      disabledReason: reason,
      isRegistered: true,
      registeredSourceId: source.id,
      registeredSourceRemovable: source.removable !== false,
      registeredSourceKind: kind,
      icon: "fantasma",
    },
  };
}

/** Pinos elétricos REAIS de um manifesto, melhor-esforço, só pra avisar (não bloquear) quando um
 * `pinId` de um `other.package_pin` não bate com nada conhecido -- ver `extension.ts::saveSymbolCommand`.
 * `abi-device`: `pins[].id`. `mcu-adapter`: chaves
 * de `pinMap` (o mesmo campo estático que `resolveRegisteredItem` já usa como fallback de
 * `pinCount`, ver acima — não tem relação com o `get_pin_map()` em runtime do plugin).
 * `subcircuit-file`: `interface[].pinId`. */
export function knownPinIdsForManifest(json: Record<string, unknown>, kind: RegisteredItemKind): string[] {
  if (kind === "abi-device") {
    const pins = Array.isArray(json.pins) ? json.pins : [];
    return pins
      .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
      .map((pin) => pin.id)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  }
  if (kind === "mcu-adapter") {
    return typeof json.pinMap === "object" && json.pinMap !== null ? Object.keys(json.pinMap as Record<string, unknown>) : [];
  }
  const entries = Array.isArray(json.interface) ? json.interface : [];
  return entries
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((entry) => entry.pinId)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

export interface ParsedSubcircuitManifest {
  /** "" quando o manifesto não declara `typeId` -- cada chamador decide seu próprio fallback
   * (registro na paleta usa `registered.subcircuit.<sourceId>`, bloco genérico por caminho trata
   * como erro de parse). */
  typeId: string;
  /** Nome localizado cru, sem fallback pro typeId -- idem, cada chamador decide. */
  label: string | undefined;
  pinIds: string[];
  pinCount: number;
  package: PackageDescriptor | undefined;
  logicSymbolPackage: PackageDescriptor | undefined;
  icon: string | undefined;
  iconSvgInline: string | undefined;
  iconFilePath: string | undefined;
  defaultProperties: Record<string, string | number | boolean>;
  help?: WebviewComponentCatalogEntry["help"];
  folderPath: string[] | undefined;
  mcuHost: boolean;
  serialPorts: ReturnType<typeof sanitizeMcuSerialPorts>;
}

function manifestFolderPath(json: Record<string, unknown>): string[] | undefined {
  return Array.isArray(json.folderPath)
    ? (json.folderPath as unknown[]).filter((s): s is string => typeof s === "string")
    : undefined;
}

function manifestIconFields(json: Record<string, unknown>, manifestDir: string): Pick<ParsedSubcircuitManifest, "icon" | "iconSvgInline" | "iconFilePath"> {
  const manifestIcon = typeof json.icon === "string" ? json.icon.trim() : undefined;
  const iconSvgInline = manifestIcon?.startsWith("<svg") ? manifestIcon : undefined;
  const iconFilePath = !iconSvgInline && typeof json.iconPath === "string" && json.iconPath.trim()
    ? normalizeExistingFilePath(manifestDir, json.iconPath.trim())
    : undefined;
  return {
    icon: !iconSvgInline ? manifestIcon : undefined,
    iconSvgInline,
    iconFilePath,
  };
}

function manifestHelpFields(json: Record<string, unknown>): WebviewComponentCatalogEntry["help"] {
  const raw = json.help;
  if (typeof raw !== "object" || raw === null) return undefined;
  const help = raw as Record<string, unknown>;
  const description = typeof help.description === "string" && help.description.trim() ? help.description : undefined;
  const url = typeof help.url === "string" && help.url.trim() ? help.url : undefined;
  const file = typeof help.file === "string" && help.file.trim() ? help.file : undefined;
  return description || url || file ? { description, url, file } : undefined;
}

function manifestDefaultProperties(json: Record<string, unknown>, logicSymbolPackage: PackageDescriptor | undefined): Record<string, string | number | boolean> {
  return logicSymbolPackage
    ? { logicSymbol: false, ...sanitizeManifestDefaultProperties(json.defaultProperties) }
    : sanitizeManifestDefaultProperties(json.defaultProperties);
}

/** Deriva os campos "de conteúdo" de um `.lssubcircuit` já lido (typeId/label/pinos/package/ícone)
 * -- compartilhado entre `resolveRegisteredItem`'s subcircuit-file branch (registro na paleta) e a
 * resolução do bloco genérico de subcircuito por caminho (`extension.ts::chooseSubcircuitFileCommand`/
 * `resolveSubcircuitReferences`), pra nunca duplicar `knownPinIdsForManifest`/`sanitizePackage`/
 * derivação de ícone uma terceira vez (ver `.spec/lasecsimul-subcircuits.spec` seção 12). NÃO decide
 * nada específico do REGISTRO (libraryPath, fallback de `folderPath` de `RegisteredSource`,
 * disabled/gate) -- isso fica por conta de cada chamador. */
export function parseSubcircuitManifest(json: Record<string, unknown>, manifestDir: string, language: LasecSimulLanguage, mcuAdapterTypeIds: ReadonlySet<string>): ParsedSubcircuitManifest {
  const typeId = typeof json.typeId === "string" ? json.typeId.trim() : "";
  const label = localizedManifestName(json, language)?.trim();
  const pinIds = knownPinIdsForManifest(json, "subcircuit-file");
  const packageDescriptor = sanitizePackage(json.package, manifestDir);
  const packagePins =
    typeof json.package === "object" && json.package !== null && Array.isArray((json.package as { pins?: unknown[] }).pins)
      ? ((json.package as { pins: unknown[] }).pins.length || 2)
      : 2;
  const pinCount = pinIds.length > 0 ? pinIds.length : (packageDescriptor ? packageDescriptor.pins.length : packagePins);
  const folderPath = manifestFolderPath(json);
  const iconFields = manifestIconFields(json, manifestDir);
  const logicSymbolPackage = sanitizePackage(json.logicSymbolPackage, manifestDir);
  return {
    typeId,
    label,
    pinIds,
    pinCount,
    package: packageDescriptor,
    logicSymbolPackage,
    ...iconFields,
    defaultProperties: manifestDefaultProperties(json, logicSymbolPackage),
    help: manifestHelpFields(json),
    folderPath,
    mcuHost: manifestHostsMcu(json, mcuAdapterTypeIds),
    serialPorts: sanitizeMcuSerialPorts(json.serialPorts),
  };
}

export function resolveRegisteredItem(source: RegisteredSource, extensionPath: string, language: LasecSimulLanguage, mcuAdapterTypeIds: ReadonlySet<string>): ResolvedRegisteredItem {
  const absoluteFilePath = normalizeAbsolutePath(extensionPath, source.filePath);
  if (!fileExists(absoluteFilePath)) {
    const fallbackFolder = localizedRegisteredFolder(source.kind, language);
    return createDisabledEntry(
      source,
      source.kind,
      `registered.missing.${source.id}`,
      path.basename(absoluteFilePath),
      resolveFolderPath(source, fallbackFolder),
      "arquivo registrado não encontrado"
    );
  }

  try {
    const json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
    const packageDescriptor = sanitizePackage(json.package, path.dirname(absoluteFilePath));
    if (source.kind === "abi-device" || source.kind === "mcu-adapter") {
      // "Logic Symbol" (aparência alternativa, igual ao `SubPackage::Logic_Symbol` do SimulIDE
      // real) só pra `mcu-adapter` -- nunca `abi-device` puro, decisão explícita (ver `.spec/
      // lasecsimul-native-devices.spec` seção 21.3).
      const logicSymbolPackage = source.kind === "mcu-adapter" ? sanitizePackage(json.logicSymbolPackage, path.dirname(absoluteFilePath)) : undefined;
      const typeIdKey = source.kind === "mcu-adapter" ? "chipId" : "typeId";
      const typeId = typeof json[typeIdKey] === "string" && String(json[typeIdKey]).trim()
        ? String(json[typeIdKey]).trim()
        : `registered.${source.kind}.${source.id}`;
      const manifestLabel = localizedManifestName(json, language)?.trim();
      const label = manifestLabel || typeId;
      // Ids ELÉTRICOS reais (`pins[].id`/`pinMap` chaves) têm prioridade sobre `package.pins.length`
      // pra `pinCount` -- um `package` pode ter pinos puramente visuais/decorativos sem contrapartida
      // elétrica (ex: 14 dos 48 pinos do chip ESP32 nu), contá-los junto inflava `pinCount` e fazia
      // `component.pins[]` sintetizar ids genéricos (`pin-1`...) que nunca casavam com
      // `package.pins[].id` reais -- terminal de fio caía no algoritmo genérico (posição errada),
      // mesmo com o desenho do `package` certo. Ver `model.ts::WebviewComponentCatalogEntry.pinIds`.
      const pinIds = knownPinIdsForManifest(json, source.kind);
      const pinCount = pinIds.length > 0
        ? pinIds.length
        : (packageDescriptor ? packageDescriptor.pins.length : 2);
      const parsedFolderPath = manifestFolderPath(json);
      const folderPath = resolveFolderPath({
        ...source,
        folderPath: parsedFolderPath && parsedFolderPath.length > 0 ? parsedFolderPath : source.folderPath,
      }, localizedRegisteredFolder(source.kind, language));
      const category = folderPath[0] ?? localizedRegisteredRoot(language);
      const subcategory = folderPath.length > 1 ? folderPath[1] : undefined;
      const libraryPath = source.kind === "mcu-adapter"
        ? undefined
        : (source.libraryPath
          ? normalizeAbsolutePath(extensionPath, source.libraryPath)
          : inferLibraryPathForDevice(absoluteFilePath));
      const iconFields = manifestIconFields(json, path.dirname(absoluteFilePath));
      const EXTENSION_SIDE_INTERACTION_KINDS = new Set<string>(["joystick", "encoder", "touchpad"]);
      const manifestInteraction = typeof json.interaction === "string" ? json.interaction : undefined;
      const extensionInteractionKind: InteractionKindEntry | undefined =
        manifestInteraction && EXTENSION_SIDE_INTERACTION_KINDS.has(manifestInteraction)
          ? (manifestInteraction as InteractionKindEntry)
          : undefined;
      const serialPorts = sanitizeMcuSerialPorts(json.serialPorts);
      const entry: WebviewComponentCatalogEntry = {
        typeId,
        label,
        pinCount,
        pinIds: pinIds.length > 0 ? pinIds : undefined,
        defaultProperties: manifestDefaultProperties(json, logicSymbolPackage),
        category,
        subcategory,
        folderPath,
        ...iconFields,
        package: packageDescriptor,
        logicSymbolPackage,
        help: manifestHelpFields(json),
        disabled: false,
        isRegistered: true,
        registeredSourceId: source.id,
        registeredSourceRemovable: source.removable !== false,
        registeredSourceKind: source.kind,
        mcuHost: source.kind === "mcu-adapter",
        serialPorts,
        ...(extensionInteractionKind ? { interactionKind: extensionInteractionKind } : {}),
      };
      if (source.kind === "mcu-adapter" && !serialPorts) {
        return {
          sourceId: source.id,
          kind: source.kind,
          entry: {
            ...entry,
            disabled: true,
            disabledReason: "mcu-adapter sem serialPorts validos no manifesto",
            icon: "fantasma",
            iconFilePath: undefined,
          },
        };
      }
      if (source.kind === "abi-device" && (!libraryPath || !fileExists(libraryPath))) {
        return {
          sourceId: source.id,
          kind: source.kind,
          entry: {
            ...entry,
            disabled: true,
            disabledReason: "dispositivo registrado sem library.json valido associado",
            icon: "fantasma",
            iconFilePath: undefined,
          },
        };
      }

      return {
        sourceId: source.id,
        kind: source.kind,
        libraryPathToLoad: source.kind === "abi-device" ? libraryPath : undefined,
        entry,
      };
    }

    // subcircuit-file: Core já expande subcircuito de ponta a ponta (addComponent detecta
    // isSubcircuitType() e chama addSubcircuitInstance() -- ver CoreApplication.cpp) desde que o
    // library.json correspondente tenha sido carregado. Mesmo tratamento de disabled/libraryPath
    // que abi-device, não um gate fixo.
    const parsed = parseSubcircuitManifest(json, path.dirname(absoluteFilePath), language, mcuAdapterTypeIds);
    const typeId = parsed.typeId || `registered.subcircuit.${source.id}`;
    const label = parsed.label || typeId;
    const folderPath = resolveFolderPath({
      ...source,
      folderPath: parsed.folderPath && parsed.folderPath.length > 0 ? parsed.folderPath : source.folderPath,
    }, localizedRegisteredFolder("subcircuit-file", language));
    const category = folderPath[0] ?? localizedRegisteredRoot(language);
    const subcategory = folderPath.length > 1 ? folderPath[1] : undefined;
    const libraryPath = source.libraryPath
      ? normalizeAbsolutePath(extensionPath, source.libraryPath)
      : inferLibraryPathForSubcircuit(absoluteFilePath);
    const entry: WebviewComponentCatalogEntry = {
      typeId,
      label,
      pinCount: parsed.pinCount,
      pinIds: parsed.pinIds.length > 0 ? parsed.pinIds : undefined,
      defaultProperties: parsed.defaultProperties,
      category,
      subcategory,
      folderPath,
      icon: parsed.icon,
      iconFilePath: parsed.iconFilePath,
      iconSvgInline: parsed.iconSvgInline,
      package: parsed.package,
      logicSymbolPackage: parsed.logicSymbolPackage,
      help: parsed.help,
      disabled: false,
      isRegistered: true,
      registeredSourceId: source.id,
      registeredSourceRemovable: source.removable !== false,
      registeredSourceKind: source.kind,
      mcuHost: parsed.mcuHost,
      serialPorts: parsed.serialPorts,
    };
    return {
      sourceId: source.id,
      kind: source.kind,
      libraryPathToLoad: libraryPath && fileExists(libraryPath) ? libraryPath : undefined,
      adhocSubcircuitPathToRegister: libraryPath && fileExists(libraryPath) ? undefined : absoluteFilePath,
      entry,
    };
  } catch (err) {
    const fallbackFolder = folderPathFromMalformedJsonText(absoluteFilePath) ?? localizedRegisteredFolder(source.kind, language);
    return createDisabledEntry(
      source,
      source.kind,
      `registered.error.${source.id}`,
      path.basename(absoluteFilePath),
      resolveFolderPath(source, fallbackFolder),
      `arquivo inválido: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function resolveRegisteredItems(extensionPath: string, sources: RegisteredSource[]): ResolvedRegisteredItem[] {
  const language = currentLasecSimulLanguage();
  const mcuAdapterTypeIds = collectMcuAdapterTypeIds(extensionPath, sources);
  return sources.map((source) => resolveRegisteredItem(source, extensionPath, language, mcuAdapterTypeIds));
}

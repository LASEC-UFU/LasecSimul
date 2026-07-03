import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CoreClient } from "./ipc/CoreClient";
import { CoreProcess } from "./ipc/CoreProcess";
import { IpcError } from "./ipc/protocol";
import { TrustStore } from "./trust/TrustStore";
import { isPreApproved, isPreBlocked, resolveConsentChoice, shouldLoadLibrary, decisionToPersist } from "./trust/trustDecision";
import { SchematicPanel } from "./ui/panels/SchematicPanel";
import { createInitialWebviewState } from "./ui/webview/catalog";
import { PackageDescriptor, PackagePin, PackageShape, PropertySchemaEntry, WebviewComponentCatalogEntry, WebviewComponentModel, WebviewProjectState, WebviewWireModel } from "./ui/webview/model";
import { ComponentReadoutValue, InstrumentHistoryPayload, InternalComponentSnapshot, SimulationStatus, WebviewToHostMessage } from "./ui/webview/messages";
import { ComponentPaletteViewProvider } from "./ui/views/ComponentPaletteViewProvider";
import { ProjectSerializer } from "./project/ProjectSerializer";
import { ProjectComponent, ProjectDocument, createEmptyProject } from "./project/ProjectTypes";
import { loadUnifiedCatalog, RegisteredSource, saveRegisteredSources } from "./catalog/UnifiedCatalog";
import {
  compileSubcircuitInternalComponents,
  compileSymbolAuthoringComponents,
  InternalComponentSeed,
  InternalWireSeed,
  seedSubcircuitInternalComponents,
  seedSymbolAuthoringComponents,
  VisualPosition,
} from "./catalog/symbolAuthoring";
import { hasShowOnSymbolProperty, mergePropertySchemas, nextIndexedLabel } from "./catalog/catalogMerge";
import { LasecSimulLanguage, resolveLasecSimulLanguage } from "./language";

let coreProc: CoreProcess | undefined;
let coreClient: CoreClient | undefined;
let schematicPanel: SchematicPanel | undefined;
let schematicState: WebviewProjectState = createInitialWebviewState();
let simulationStatus: SimulationStatus = "stopped";
let paletteViewProvider: ComponentPaletteViewProvider | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let trustStore: TrustStore | undefined;
const projectSerializer = new ProjectSerializer();

function setSchematicOpenContext(isOpen: boolean): Thenable<void> {
  return vscode.commands.executeCommand("setContext", "lasecsimul.schematicOpen", isOpen);
}

function currentLasecSimulLanguage(): LasecSimulLanguage {
  const configured = vscode.workspace.getConfiguration("lasecsimul").get<string>("language", "system");
  return resolveLasecSimulLanguage(configured, vscode.env.language);
}

type RegisteredItemKind = "abi-device" | "mcu-adapter" | "subcircuit-file";

interface ResolvedRegisteredItem {
  sourceId: string;
  kind: RegisteredItemKind;
  entry: WebviewComponentCatalogEntry;
  libraryPathToLoad?: string;
}

/**
 * componentId da Webview -> instanceId devolvido pelo Core (resposta de "addComponent").
 * Sem entrada == o Core ainda não tem essa instância (typeId sem componente built-in/plugin
 * ainda, ou o Core não está conectado) — quem usa este mapa sempre trata a ausência como
 * "ignora silenciosamente", nunca como erro fatal (ver docs/mvp-limitacoes.md).
 */
const coreInstanceIdByComponentId = new Map<string, string>();
const mcuTargetCoreIdByComponentId = new Map<string, string>();
const mcuSerialMonitorByKey = new Map<string, { channel: vscode.OutputChannel; timer: ReturnType<typeof setInterval>; lastLength: number }>();

function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function cloneState(): WebviewProjectState {
  return JSON.parse(JSON.stringify(schematicState)) as WebviewProjectState;
}

function syncSchematicPanel(): void {
  schematicPanel?.setLanguage(schematicState.locale ?? currentLasecSimulLanguage());
  schematicPanel?.postMessage({ version: 1, type: "syncState", project: cloneState() });
  schematicPanel?.postMessage({ version: 1, type: "simulationStatus", status: simulationStatus });
}

function setSimulationStatus(status: SimulationStatus): void {
  simulationStatus = status;
  schematicPanel?.postMessage({ version: 1, type: "simulationStatus", status });
}

function openSchematicEditor(extensionUri: vscode.Uri): void {
  schematicPanel = SchematicPanel.createOrShow(extensionUri, cloneState(), handleWebviewMessage, () => {
    schematicPanel = undefined;
    void setSchematicOpenContext(false);
  });
  void setSchematicOpenContext(true);
  setSimulationStatus(simulationStatus);
}

/** Localiza o binário do Core dentro de `core/build/`. Geradores single-config (Ninja simples)
 * colocam o executável direto em `core/build/`; geradores multi-config (Visual Studio, Ninja Multi-
 * Config — os dois caminhos documentados no README para Windows) colocam em `core/build/Debug/` ou
 * `core/build/Release/`. Sem checar os dois, a extensão tenta abrir um arquivo que não existe em
 * qualquer build feito com o gerador padrão do Windows. */
function resolveCoreExecutablePath(extensionPath: string): string {
  const coreBin = process.platform === "win32" ? "lasecsimul-core.exe" : "lasecsimul-core";
  const buildDirs = [
    path.join(extensionPath, "..", "core", "build"),
    path.join(extensionPath, "bundled", "core", "build"),
  ];
  const candidates = buildDirs.flatMap((buildDir) => [
    path.join(buildDir, coreBin),
    path.join(buildDir, "Debug", coreBin),
    path.join(buildDir, "Release", coreBin),
    path.join(buildDir, "RelWithDebInfo", coreBin),
  ]);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function normalizeAbsolutePath(basePath: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.normalize(path.resolve(basePath, inputPath));
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as unknown;
}

function inferLibraryPathForDevice(deviceFilePath: string): string | undefined {
  const candidate = path.resolve(path.dirname(deviceFilePath), "..", "library.json");
  return fileExists(candidate) ? candidate : undefined;
}

/** Subcircuitos não têm pasta por item (ver .spec/lasecsimul-subcircuits.spec seção 7 — diferença
 * deliberada de devices/mcu-adapters: arquivo único, sem binário por plataforma) -- o
 * `library.json` fica na MESMA pasta do `.lssub.json`, não um nível acima. */
function inferLibraryPathForSubcircuit(manifestFilePath: string): string | undefined {
  const candidate = path.join(path.dirname(manifestFilePath), "library.json");
  return fileExists(candidate) ? candidate : undefined;
}

function resolveFolderPath(source: RegisteredSource, fallback: string[]): string[] {
  if (Array.isArray(source.folderPath) && source.folderPath.length > 0) {
    return source.folderPath.map((segment) => String(segment).trim()).filter((segment) => segment.length > 0);
  }
  return fallback;
}

function localizedRegisteredFolder(kind: RegisteredItemKind, language: LasecSimulLanguage): string[] {
  if (kind === "abi-device") return language === "en" ? ["Registered", "ABI"] : ["Registrados", "ABI"];
  if (kind === "mcu-adapter") return language === "en" ? ["Registered", "QEMU"] : ["Registrados", "QEMU"];
  return language === "en" ? ["Registered", "Subcircuits"] : ["Registrados", "Subcircuitos"];
}

function localizedRegisteredRoot(language: LasecSimulLanguage): string {
  return language === "en" ? "Registered" : "Registrados";
}

function localizedAbiFailure(reason: string, language: LasecSimulLanguage): string {
  return language === "en" ? `ABI load failed: ${reason}` : `falha ao carregar ABI: ${reason}`;
}

function localizedBaseCatalogConflict(language: LasecSimulLanguage): string {
  return language === "en" ? "typeId already exists in the base catalog" : "typeId já existe no catálogo base";
}

function localizedManifestName(json: Record<string, unknown>, language: LasecSimulLanguage): string | undefined {
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

const PACKAGE_SHAPE_KINDS = new Set(["rect", "text", "line", "ellipse"]);

/** Confia na mesma medida que `device.json`/`mcu.json`/`.lssub.json` já são confiados pelo resto
 * desta função (são manifestos de primeira parte ou já passaram por consentimento de plugin antes
 * de chegar aqui, ver `ensureLibraryTrusted`) — valida só a forma estrutural mínima (presença e tipo
 * dos campos numéricos obrigatórios), não cada combinação de campo por `kind`, mesmo nível de
 * validação que `readDeviceLsconfig` já aplica aos outros campos do manifesto. */
function sanitizePackage(value: unknown): PackageDescriptor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.width !== "number" || typeof raw.height !== "number" || !Array.isArray(raw.pins)) return undefined;

  const pins: PackagePin[] = [];
  for (const pinValue of raw.pins) {
    if (typeof pinValue !== "object" || pinValue === null) continue;
    const pin = pinValue as Record<string, unknown>;
    if (typeof pin.id !== "string" || !pin.id.trim()) continue;
    if (typeof pin.x !== "number" || typeof pin.y !== "number") continue;
    pins.push({
      id: pin.id,
      kind: typeof pin.kind === "string" ? pin.kind : undefined,
      x: pin.x,
      y: pin.y,
      angle: typeof pin.angle === "number" ? pin.angle : 0,
      length: typeof pin.length === "number" ? pin.length : 8,
      label: typeof pin.label === "string" ? pin.label : undefined,
      labelX: typeof pin.labelX === "number" ? pin.labelX : undefined,
      labelY: typeof pin.labelY === "number" ? pin.labelY : undefined,
    });
  }
  if (pins.length === 0) return undefined;

  const shapes: PackageShape[] = [];
  if (Array.isArray(raw.shapes)) {
    for (const shapeValue of raw.shapes) {
      if (typeof shapeValue !== "object" || shapeValue === null) continue;
      const shape = shapeValue as Record<string, unknown> & { kind?: unknown };
      if (typeof shape.kind !== "string" || !PACKAGE_SHAPE_KINDS.has(shape.kind)) continue;
      shapes.push(shape as unknown as PackageShape);
    }
  }

  const backgroundRaw = raw.background;
  const background =
    typeof backgroundRaw === "object" && backgroundRaw !== null && typeof (backgroundRaw as Record<string, unknown>).kind === "string"
      ? (backgroundRaw as PackageDescriptor["background"])
      : undefined;

  return {
    width: raw.width,
    height: raw.height,
    schematicWidth: typeof raw.schematicWidth === "number" ? raw.schematicWidth : undefined,
    schematicHeight: typeof raw.schematicHeight === "number" ? raw.schematicHeight : undefined,
    border: typeof raw.border === "boolean" ? raw.border : undefined,
    background,
    shapes,
    pins,
    pinLabelColor: typeof raw.pinLabelColor === "string" && raw.pinLabelColor.trim() ? raw.pinLabelColor : undefined,
  };
}

interface DeviceLsconfig {
  typeId?: string;
  label?: string;
  folderPath?: string[];
  icon?: string;
  iconPath?: string;
  symbolSvg?: string;
  package?: unknown;
  pinCount?: number;
  defaultProperties?: Record<string, string | number | boolean>;
}

function manifestHostsMcu(json: Record<string, unknown>): boolean {
  if (typeof json.chipId === "string" && json.chipId.trim()) return true;
  if (!Array.isArray(json.components)) return false;
  return json.components.some((component) =>
    typeof component === "object" &&
    component !== null &&
    typeof (component as Record<string, unknown>).typeId === "string" &&
    String((component as Record<string, unknown>).typeId).startsWith("espressif.")
  );
}

function inferLsconfigPath(manifestPath: string): string | undefined {
  const direct = path.join(path.dirname(manifestPath), "device.lsconfig");
  if (fileExists(direct)) return direct;
  const sibling = `${manifestPath}.lsconfig`;
  return fileExists(sibling) ? sibling : undefined;
}

function readDeviceLsconfig(source: RegisteredSource, extensionPath: string): { absolutePath?: string; config?: DeviceLsconfig } {
  const absoluteFilePath = normalizeAbsolutePath(extensionPath, source.filePath);
  const storedPath = source.lsconfigPath ? normalizeAbsolutePath(extensionPath, source.lsconfigPath) : undefined;
  const resolvedPath = (storedPath && fileExists(storedPath))
    ? storedPath
    : inferLsconfigPath(absoluteFilePath);
  if (!resolvedPath || !fileExists(resolvedPath)) return {};
  try {
    return {
      absolutePath: resolvedPath,
      config: readJsonFile(resolvedPath) as DeviceLsconfig,
    };
  } catch {
    return { absolutePath: resolvedPath };
  }
}

function normalizeExistingFilePath(basePath: string, inputPath: string | undefined): string | undefined {
  if (!inputPath || !inputPath.trim()) return undefined;
  const absolutePath = normalizeAbsolutePath(basePath, inputPath);
  return fileExists(absolutePath) ? absolutePath : undefined;
}

function createDisabledEntry(
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

function resolveRegisteredItem(source: RegisteredSource, extensionPath: string, language: LasecSimulLanguage): ResolvedRegisteredItem {
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
    const { absolutePath: absoluteLsconfigPath, config: lsconfig } = readDeviceLsconfig(source, extensionPath);
    const packageDescriptor = sanitizePackage(json.package) ?? sanitizePackage(lsconfig?.package);
    if (source.kind === "abi-device" || source.kind === "mcu-adapter") {
      // "Logic Symbol" (aparência alternativa, igual ao `SubPackage::Logic_Symbol` do SimulIDE
      // real) só pra `mcu-adapter` -- nunca `abi-device` puro, decisão explícita (ver `.spec/
      // lasecsimul-native-devices.spec` seção 21.3).
      const logicSymbolPackage = source.kind === "mcu-adapter" ? sanitizePackage(json.logicSymbolPackage) : undefined;
      const typeIdKey = source.kind === "mcu-adapter" ? "chipId" : "typeId";
      const typeId = typeof json[typeIdKey] === "string" && String(json[typeIdKey]).trim()
        ? String(json[typeIdKey]).trim()
        : `registered.${source.kind}.${source.id}`;
      const manifestLabel = localizedManifestName(json, language)?.trim();
      const label = typeof lsconfig?.label === "string" && lsconfig.label.trim() ? lsconfig.label.trim() : (manifestLabel || typeId);
      // Ids ELÉTRICOS reais (`pins[].id`/`pinMap` chaves) têm prioridade sobre `package.pins.length`
      // pra `pinCount` -- um `package` pode ter pinos puramente visuais/decorativos sem contrapartida
      // elétrica (ex: 14 dos 48 pinos do chip ESP32 nu), contá-los junto inflava `pinCount` e fazia
      // `component.pins[]` sintetizar ids genéricos (`pin-1`...) que nunca casavam com
      // `package.pins[].id` reais -- terminal de fio caía no algoritmo genérico (posição errada),
      // mesmo com o desenho do `package` certo. Ver `model.ts::WebviewComponentCatalogEntry.pinIds`.
      const pinIds = knownPinIdsForManifest(json, source.kind);
      const pinCount = pinIds.length > 0
        ? pinIds.length
        : (packageDescriptor
          ? packageDescriptor.pins.length
          : (typeof lsconfig?.pinCount === "number" && lsconfig.pinCount > 0 ? lsconfig.pinCount : 2));
      const manifestFolderPath = Array.isArray(json.folderPath)
        ? (json.folderPath as unknown[]).filter((s): s is string => typeof s === "string")
        : undefined;
      const folderPath = resolveFolderPath({
        ...source,
        folderPath: Array.isArray(lsconfig?.folderPath) && lsconfig.folderPath.length > 0
          ? lsconfig.folderPath
          : (manifestFolderPath && manifestFolderPath.length > 0 ? manifestFolderPath : source.folderPath),
      }, localizedRegisteredFolder(source.kind, language));
      const category = folderPath[0] ?? localizedRegisteredRoot(language);
      const subcategory = folderPath.length > 1 ? folderPath[1] : undefined;
      const libraryPath = source.kind === "mcu-adapter"
        ? undefined
        : (source.libraryPath
          ? normalizeAbsolutePath(extensionPath, source.libraryPath)
          : inferLibraryPathForDevice(absoluteFilePath));
      const manifestIcon = typeof json.icon === "string" ? json.icon.trim() : undefined;
      const iconSvgInline = manifestIcon?.startsWith("<svg") ? manifestIcon : undefined;
      const iconFilePath = !iconSvgInline && typeof lsconfig?.iconPath === "string" && lsconfig.iconPath.trim()
        ? normalizeExistingFilePath(path.dirname(absoluteLsconfigPath ?? absoluteFilePath), lsconfig.iconPath)
        : undefined;
      const entry: WebviewComponentCatalogEntry = {
        typeId,
        label,
        pinCount,
        pinIds: pinIds.length > 0 ? pinIds : undefined,
        defaultProperties: logicSymbolPackage ? { logicSymbol: false, ...(lsconfig?.defaultProperties ?? {}) } : (lsconfig?.defaultProperties ?? {}),
        category,
        subcategory,
        folderPath,
        icon: lsconfig?.icon ?? (!iconSvgInline ? manifestIcon : undefined),
        iconFilePath,
        iconSvgInline,
        symbolSvg: lsconfig?.symbolSvg,
        package: packageDescriptor,
        logicSymbolPackage,
        disabled: false,
        isRegistered: true,
        registeredSourceId: source.id,
        registeredSourceRemovable: source.removable !== false,
        registeredSourceKind: source.kind,
        mcuHost: source.kind === "mcu-adapter",
      };
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
    const typeId = typeof json.typeId === "string" && json.typeId.trim()
      ? json.typeId
      : `registered.subcircuit.${source.id}`;
    const manifestLabel = localizedManifestName(json, language)?.trim();
    const label = typeof lsconfig?.label === "string" && lsconfig.label.trim() ? lsconfig.label.trim() : (manifestLabel || typeId);
    // `interface[].pinId` é o contrato elétrico real de um subcircuito (ver
    // `.spec/lasecsimul-subcircuits.spec` seção 5) -- mesma prioridade sobre `package.pins.length`
    // que abi-device/mcu-adapter, mesma razão (ver comentário acima nesta função).
    const pinIds = knownPinIdsForManifest(json, "subcircuit-file");
    const packagePins =
      typeof json.package === "object" && json.package !== null && Array.isArray((json.package as { pins?: unknown[] }).pins)
        ? ((json.package as { pins: unknown[] }).pins.length || 2)
        : 2;
    const pinCount = pinIds.length > 0
      ? pinIds.length
      : (packageDescriptor
        ? packageDescriptor.pins.length
        : (typeof lsconfig?.pinCount === "number" && lsconfig.pinCount > 0 ? lsconfig.pinCount : packagePins));
    const manifestFolderPath2 = Array.isArray(json.folderPath)
      ? (json.folderPath as unknown[]).filter((s): s is string => typeof s === "string")
      : undefined;
    const folderPath = resolveFolderPath({
      ...source,
      folderPath: Array.isArray(lsconfig?.folderPath) && lsconfig.folderPath.length > 0
        ? lsconfig.folderPath
        : (manifestFolderPath2 && manifestFolderPath2.length > 0 ? manifestFolderPath2 : source.folderPath),
    }, localizedRegisteredFolder("subcircuit-file", language));
    const category = folderPath[0] ?? localizedRegisteredRoot(language);
    const subcategory = folderPath.length > 1 ? folderPath[1] : undefined;
    const libraryPath = source.libraryPath
      ? normalizeAbsolutePath(extensionPath, source.libraryPath)
      : inferLibraryPathForSubcircuit(absoluteFilePath);
    const manifestIcon2 = typeof json.icon === "string" ? json.icon.trim() : undefined;
    const iconSvgInline2 = manifestIcon2?.startsWith("<svg") ? manifestIcon2 : undefined;
    const iconFilePath = !iconSvgInline2 && typeof lsconfig?.iconPath === "string" && lsconfig.iconPath.trim()
      ? normalizeExistingFilePath(path.dirname(absoluteLsconfigPath ?? absoluteFilePath), lsconfig.iconPath)
      : undefined;
    // "Logic Symbol" também pra subcircuito (mesma decisão de escopo de mcu-adapter acima).
    const logicSymbolPackage = sanitizePackage(json.logicSymbolPackage);
    const entry: WebviewComponentCatalogEntry = {
      typeId,
      label,
      pinCount,
      pinIds: pinIds.length > 0 ? pinIds : undefined,
      defaultProperties: logicSymbolPackage ? { logicSymbol: false, ...(lsconfig?.defaultProperties ?? {}) } : (lsconfig?.defaultProperties ?? {}),
      category,
      subcategory,
      folderPath,
      icon: lsconfig?.icon ?? (!iconSvgInline2 ? manifestIcon2 : undefined),
      iconFilePath,
      iconSvgInline: iconSvgInline2,
      symbolSvg: lsconfig?.symbolSvg,
      package: packageDescriptor,
      logicSymbolPackage,
      disabled: false,
      isRegistered: true,
      registeredSourceId: source.id,
      registeredSourceRemovable: source.removable !== false,
      registeredSourceKind: source.kind,
      mcuHost: manifestHostsMcu(json),
    };
    if (!libraryPath || !fileExists(libraryPath)) {
      return {
        sourceId: source.id,
        kind: source.kind,
        entry: {
          ...entry,
          disabled: true,
          disabledReason: "subcircuito registrado sem library.json valido associado",
          icon: "fantasma",
          iconFilePath: undefined,
        },
      };
    }
    return {
      sourceId: source.id,
      kind: source.kind,
      libraryPathToLoad: libraryPath,
      entry,
    };
  } catch (err) {
    const fallbackFolder = localizedRegisteredFolder(source.kind, language);
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

function resolveRegisteredItems(extensionPath: string, sources: RegisteredSource[]): ResolvedRegisteredItem[] {
  const language = currentLasecSimulLanguage();
  return sources.map((source) => resolveRegisteredItem(source, extensionPath, language));
}

function setEffectiveCatalog(entries: WebviewComponentCatalogEntry[]): void {
  schematicState = { ...schematicState, catalog: entries };
  paletteViewProvider?.setCatalog(entries);
  syncSchematicPanel();
}

/** Lê `publisher`/`trust` do `library.json` e decide se o carregamento pode seguir -- nunca lança:
 * arquivo ilegível/sem esses campos é tratado como publisher "desconhecido", não first-party (o
 * próprio `loadDeviceLibrary` no Core reporta o erro real se o arquivo for inválido de verdade).
 * Ver `.spec/lasecsimul-native-devices.spec` seção 12, item 2 -- consentimento mora na Extension,
 * nunca no Core. */
async function ensureLibraryTrusted(libraryPath: string): Promise<boolean> {
  if (!extensionContext) return false;
  if (!trustStore) trustStore = new TrustStore(extensionContext);

  let manifest: { publisher?: string; trust?: string } = {};
  try {
    manifest = JSON.parse(fs.readFileSync(libraryPath, "utf8"));
  } catch {
    return true; // deixa o Core recusar o arquivo inválido com o erro real
  }
  const publisher = manifest.publisher ?? "desconhecido";
  const stored = trustStore.decisionFor(publisher);

  if (isPreApproved(manifest.trust, stored)) return true;
  if (isPreBlocked(manifest.trust, stored)) return false;

  const buttonLabel = await vscode.window.showWarningMessage(
    `Este pacote contém código nativo sem isolamento e pode travar ou comprometer o simulador. Confiar em "${publisher}"?`,
    { modal: true },
    "Permitir uma vez",
    "Sempre confiar",
    "Bloquear"
  );
  const choice = resolveConsentChoice(buttonLabel);
  const toPersist = decisionToPersist(choice);
  if (toPersist) await trustStore.setDecision(publisher, toPersist);
  return shouldLoadLibrary(choice);
}

/** Carrega no Core bibliotecas declaradas (base + registradas) e devolve mapa de erro por caminho.
 * Falha em uma biblioteca não bloqueia as demais. */
async function loadConfiguredDeviceLibraries(
  extensionPath: string,
  requests: Array<{ displayPath: string; absolutePath: string }>
): Promise<Map<string, string>> {
  const failures = new Map<string, string>();
  if (!coreClient) return failures;

  for (const request of requests) {
    const libraryPath = normalizeAbsolutePath(extensionPath, request.absolutePath);
    try {
      const trusted = await ensureLibraryTrusted(libraryPath);
      if (!trusted) {
        failures.set(libraryPath, "carregamento bloqueado: publisher não confiável (ver consentimento de plugin)");
        continue;
      }
      await coreClient.loadDeviceLibrary(libraryPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.set(libraryPath, reason);
      reportCoreWarning(`carregar biblioteca de dispositivos "${request.displayPath}"`, err);
    }
  }

  return failures;
}

function reportCoreWarning(action: string, err: unknown): void {
  const code = err instanceof IpcError && err.code ? ` [${err.code}]` : "";
  vscode.window.showWarningMessage(
    `LasecSimul Core: ${action} falhou${code}: ${err instanceof Error ? err.message : String(err)}`
  );
}

function registerCoreIdsForComponent(componentId: string, typeId: string, response: { instanceId: string; primaryMcuInstanceId?: string }): void {
  coreInstanceIdByComponentId.set(componentId, response.instanceId);
  if (response.primaryMcuInstanceId) {
    // Subcircuito hospedando MCU interno -- o alvo é o FILHO (primaryMcuInstanceId), não a
    // instância do subcircuito em si.
    mcuTargetCoreIdByComponentId.set(componentId, response.primaryMcuInstanceId);
    return;
  }
  // Genérico via `mcuHost` (.spec/lasecsimul-native-devices.spec): qualquer typeId que SEJA um
  // mcu-adapter direto (ex: espressif.esp32) não tem `primaryMcuInstanceId` próprio -- o
  // componente É o MCU, sua própria instância é o alvo. Nenhum hardcode de typeId aqui.
  const catalogEntry = schematicState.catalog.find((entry) => entry.typeId === typeId);
  if (catalogEntry?.mcuHost === true) mcuTargetCoreIdByComponentId.set(componentId, response.instanceId);
}

/** Cria a instância no Core de forma assíncrona (fire-and-forget) — usado pelo fluxo interativo da
 * Webview, onde cada ação do usuário já é, por natureza, sequencial no tempo humano. O carregamento
 * de um projeto inteiro usa `pushProjectToCore`, que aguarda cada chamada, exatamente para evitar a
 * corrida que esta versão aceita aqui. */
function pushComponentToCore(
  componentId: string,
  typeId: string,
  properties: Record<string, unknown>,
  pins: Array<{ id: string; x: number; y: number }>
): void {
  if (!coreClient || !shouldSyncComponentToCore(typeId)) return;
  coreClient
    .addComponent(typeId, properties, pins)
    .then((response) => registerCoreIdsForComponent(componentId, typeId, response))
    .catch((err) => reportCoreWarning(`criar "${typeId}"`, err));
}

function pushWireToCore(wire: WebviewWireModel): void {
  if (!coreClient) return;
  const coreA = coreInstanceIdByComponentId.get(wire.from.componentId);
  const coreB = coreInstanceIdByComponentId.get(wire.to.componentId);
  if (!coreA || !coreB) return; // um dos lados não existe no Core ainda (typeId não suportado)
  coreClient.connectWire(coreA, wire.from.pinId, coreB, wire.to.pinId).catch((err) => reportCoreWarning("conectar fio", err));
}

function isUiOnlyRuntimeProperty(component: WebviewComponentModel | undefined, name: string): boolean {
  if (name.startsWith("__ui_")) return true;
  // "Modo Placa" da instância (overlay no circuito principal) -- sem PropertyDescriptor no Core,
  // só controla renderização/interação na Webview (ver `toggleInstanceBoardMode`).
  if (name === "boardModeEnabled") return true;
  if (!component || (name !== "firmwarePath" && name !== "qemuBinaryOverride")) return false;
  const catalogEntry = schematicState.catalog.find((entry) => entry.typeId === component.typeId);
  return catalogEntry?.mcuHost === true;
}

function pushPropertyToCore(componentId: string, name: string, value: string | number | boolean): void {
  if (!coreClient) return;
  const component = schematicState.components.find((entry) => entry.id === componentId);
  if (isUiOnlyRuntimeProperty(component, name)) return;
  const coreId = coreInstanceIdByComponentId.get(componentId);
  if (!coreId) return;
  coreClient
    .setProperty(coreId, name, value)
    .then(({ requiresRestart }) => {
      if (requiresRestart) {
        vscode.window.showInformationMessage(
          `LasecSimul: a propriedade "${name}" só terá efeito completo depois que o componente for recriado.`
        );
      }
    })
    .catch((err) => reportCoreWarning(`atualizar propriedade "${name}"`, err));
}

function pushRemoveToCore(componentId: string): void {
  if (!coreClient) return;
  const coreId = coreInstanceIdByComponentId.get(componentId);
  if (!coreId) return;
  coreClient.removeComponent(coreId).catch((err) => reportCoreWarning("remover componente", err));
  mcuTargetCoreIdByComponentId.delete(componentId);
}

/** Clique num componente do overlay de Modo Placa (botão EN/BOOT etc. desenhados sobre a foto da
 * placa no circuito PRINCIPAL) -- `outerComponentId` é a instância do subcircuito já mapeada em
 * `coreInstanceIdByComponentId`; `innerComponentId` é o id LOCAL do `.lssub.json` (ex:
 * "button_en"), resolvido pelo Core via `findSubcircuitChildByLocalId` (ver
 * `CoreApplication.cpp::"setSubcircuitChildProperty"`). */
function updateBoardOverlayPropertyCommand(outerComponentId: string, innerComponentId: string, name: string, value: string | number | boolean): void {
  if (!coreClient) return;
  const coreId = coreInstanceIdByComponentId.get(outerComponentId);
  if (!coreId) return;
  coreClient
    .setSubcircuitChildProperty(coreId, innerComponentId, name, value)
    .catch((err) => reportCoreWarning(`atualizar "${innerComponentId}.${name}" (Modo Placa)`, err));
}

let voltageReadoutTimer: ReturnType<typeof setInterval> | undefined;

/** Lookup único de catálogo por typeId -- usado pelos 3 decodificadores genéricos abaixo (ABI v2,
 * .spec/lasecsimul-native-devices.spec) pra consultar `readoutFormat` sem repetir
 * `schematicState.catalog.find(...)` em cada um. */
function findCatalogEntry(typeId: string): WebviewComponentCatalogEntry | undefined {
  return schematicState.catalog.find((entry) => entry.typeId === typeId);
}

/** Decodifica `getComponentState()` SEM checar typeId quando o catálogo já declara
 * `readoutFormat` (ABI v2) -- mesmo formato binário de sempre (scalar = 1 double; channelHistory =
 * N doubles + contagem + histórico; bitmaskHistory = bitmask + contagem + histórico), só que a
 * FORMA vem do Core, não de um `if (typeId)` aqui. Fallback pros typeIds que ainda não declararam
 * (catálogo não carregou do Core ainda) preserva o comportamento de sempre, nunca quebra. */
function decodeComponentReadout(typeId: string, state: Buffer): ComponentReadoutValue | undefined {
  const readoutFormat = findCatalogEntry(typeId)?.readoutFormat;
  if (readoutFormat?.kind === "scalar") {
    return state.length >= 8 ? state.readDoubleLE(0) : undefined;
  }
  if (readoutFormat?.kind === "channelHistory") {
    if (state.length < readoutFormat.channels * 8) return undefined;
    return Array.from({ length: readoutFormat.channels }, (_, channel) => state.readDoubleLE(channel * 8));
  }
  if (readoutFormat?.kind === "bitmaskHistory") {
    return state.length >= 4 ? state.readUInt32LE(0) : undefined;
  }
  // Fallback legado -- typeId sem readoutFormat no catálogo ainda.
  if (
    typeId === "instruments.voltmeter" ||
    typeId === "meters.probe" ||
    typeId === "meters.ampmeter" ||
    typeId === "meters.freqmeter"
  ) {
    return state.length >= 8 ? state.readDoubleLE(0) : undefined;
  }
  if (typeId === "meters.oscope") {
    if (state.length < 32) return undefined;
    return [0, 1, 2, 3].map((channel) => state.readDoubleLE(channel * 8));
  }
  if (typeId === "meters.logic_analyzer") {
    return state.length >= 4 ? state.readUInt32LE(0) : undefined;
  }
  return undefined;
}

/** Decodifica o histórico REAL (tempo simulado, ver doc de `Oscope.hpp`/`LogicAnalyzer.hpp`) do
 * mesmo `getComponentState()` que `decodeComponentReadout` já usa pra última leitura -- formato:
 * channelHistory = [0..N*8) N doubles + [N*8..N*8+4) uint32 contagem + histórico CHANNEL-MAJOR,
 * cada amostra {uint64 timestampNs, double value}; bitmaskHistory = [0..4) uint32 + [4..8) uint32
 * contagem + histórico {uint64 timestampNs, uint32 bitmask}. `readoutFormat.channels` (ABI v2)
 * substitui o `4`/`8` hardcoded de antes -- espelha EXATAMENTE o `getState()` de cada classe, mudar
 * um lado sem o outro quebra silenciosamente (offsets batem por construção, não por validação em
 * runtime). Fallback legado preserva o comportamento de sempre pra typeId sem readoutFormat. */
function decodeInstrumentHistory(typeId: string, state: Buffer): InstrumentHistoryPayload["oscope"] | InstrumentHistoryPayload["logic"] | undefined {
  const readoutFormat = findCatalogEntry(typeId)?.readoutFormat;
  if (readoutFormat?.kind === "channelHistory") {
    const headerBytes = readoutFormat.channels * 8;
    if (state.length < headerBytes + 4) return undefined;
    const sampleCount = state.readUInt32LE(headerBytes);
    const channels: Array<{ timestampsNs: number[]; values: number[] }> = [];
    let offset = headerBytes + 4;
    for (let channel = 0; channel < readoutFormat.channels; channel++) {
      const timestampsNs: number[] = [];
      const values: number[] = [];
      for (let i = 0; i < sampleCount; i++) {
        timestampsNs.push(Number(state.readBigUInt64LE(offset)));
        values.push(state.readDoubleLE(offset + 8));
        offset += 16;
      }
      channels.push({ timestampsNs, values });
    }
    return { channels };
  }
  if (readoutFormat?.kind === "bitmaskHistory") {
    if (state.length < 8) return undefined;
    const sampleCount = state.readUInt32LE(4);
    const timestampsNs: number[] = [];
    const masks: number[] = [];
    let offset = 8;
    for (let i = 0; i < sampleCount; i++) {
      timestampsNs.push(Number(state.readBigUInt64LE(offset)));
      masks.push(state.readUInt32LE(offset + 8));
      offset += 12;
    }
    return { timestampsNs, masks };
  }
  // Fallback legado -- typeId sem readoutFormat no catálogo ainda.
  if (typeId === "meters.oscope") {
    if (state.length < 36) return undefined;
    const sampleCount = state.readUInt32LE(32);
    const channels: Array<{ timestampsNs: number[]; values: number[] }> = [];
    let offset = 36;
    for (let channel = 0; channel < 4; channel++) {
      const timestampsNs: number[] = [];
      const values: number[] = [];
      for (let i = 0; i < sampleCount; i++) {
        timestampsNs.push(Number(state.readBigUInt64LE(offset)));
        values.push(state.readDoubleLE(offset + 8));
        offset += 16;
      }
      channels.push({ timestampsNs, values });
    }
    return { channels };
  }
  if (typeId === "meters.logic_analyzer") {
    if (state.length < 8) return undefined;
    const sampleCount = state.readUInt32LE(4);
    const timestampsNs: number[] = [];
    const masks: number[] = [];
    let offset = 8;
    for (let i = 0; i < sampleCount; i++) {
      timestampsNs.push(Number(state.readBigUInt64LE(offset)));
      masks.push(state.readUInt32LE(offset + 8));
      offset += 12;
    }
    return { timestampsNs, masks };
  }
  return undefined;
}

async function sendInstrumentHistory(componentId: string): Promise<void> {
  if (!coreClient || !schematicPanel) return;
  const component = schematicState.components.find((entry) => entry.id === componentId);
  if (!component) return;
  const coreId = coreInstanceIdByComponentId.get(componentId);
  if (!coreId) return;
  try {
    const state = await coreClient.getComponentState(coreId);
    const decoded = decodeInstrumentHistory(component.typeId, state);
    if (!decoded) return;
    const payload: InstrumentHistoryPayload =
      component.typeId === "meters.oscope"
        ? { componentId, oscope: decoded as InstrumentHistoryPayload["oscope"] }
        : { componentId, logic: decoded as InstrumentHistoryPayload["logic"] };
    schematicPanel.postMessage({ version: 1, type: "instrumentHistory", ...payload });
  } catch {
    // instância ainda não assentou ou foi removida -- ignora, a próxima tentativa (popup ainda aberto) cobre
  }
}

function isReadableInstrument(typeId: string): boolean {
  if (findCatalogEntry(typeId)?.readoutFormat) return true;
  // Fallback legado -- typeId sem readoutFormat no catálogo ainda.
  return (
    typeId === "instruments.voltmeter" ||
    typeId === "meters.probe" ||
    typeId === "meters.ampmeter" ||
    typeId === "meters.freqmeter" ||
    typeId === "meters.oscope" ||
    typeId === "meters.logic_analyzer"
  );
}

/** Lê o estado de cada "instruments.voltmeter" no projeto e manda pra Webview — único instrumento
 * com leitura via Webview hoje (ver .spec/lasecsimul.spec sobre instrumentos como plugin ABI).
 * Generaliza naturalmente pra outros: basta interpretar getComponentState() conforme o typeId. */
async function pollInstrumentReadouts(): Promise<void> {
  if (!coreClient || !schematicPanel) return;
  const instruments = schematicState.components.filter((component) => isReadableInstrument(component.typeId));
  if (instruments.length === 0) return;

  const readoutsByComponentId: Record<string, ComponentReadoutValue> = {};
  for (const component of instruments) {
    const coreId = coreInstanceIdByComponentId.get(component.id);
    if (!coreId) continue;
    try {
      const state = await coreClient.getComponentState(coreId);
      const readout = decodeComponentReadout(component.typeId, state);
      if (readout !== undefined) readoutsByComponentId[component.id] = readout;
    } catch {
      // instância ainda não assentou ou foi removida nesse meio tempo -- ignora neste tick, tenta de novo no próximo
    }
  }
  schematicPanel.postMessage({ version: 1, type: "componentReadout", readoutsByComponentId });
}

/** Tensão de cada fio (lida em uma das duas pontas — são o mesmo nó elétrico por definição) pra
 * colorir/animar na Webview igual ao SimulIDE (`ConnectorLine::paint`: vermelho se >2.5V, azul
 * senão, só enquanto a simulação está "animada"/rodando). */
async function pollWireVoltages(): Promise<void> {
  if (!coreClient || !schematicPanel) return;
  if (schematicState.wires.length === 0) return;

  const voltagesByWireId: Record<string, number> = {};
  for (const wire of schematicState.wires) {
    const coreFrom = coreInstanceIdByComponentId.get(wire.from.componentId);
    const coreTo = coreInstanceIdByComponentId.get(wire.to.componentId);
    try {
      if (coreFrom) {
        voltagesByWireId[wire.id] = await coreClient.getNodeVoltage(coreFrom, wire.from.pinId);
      } else if (coreTo) {
        voltagesByWireId[wire.id] = await coreClient.getNodeVoltage(coreTo, wire.to.pinId);
      }
    } catch {
      // nó ainda não resolvido (settle loop não rodou pra esse trecho ainda) -- ignora neste tick
    }
  }
  schematicPanel.postMessage({ version: 1, type: "wireVoltages", voltagesByWireId });
}

function startVoltageReadoutPolling(): void {
  if (voltageReadoutTimer) return;
  voltageReadoutTimer = setInterval(() => {
    void pollInstrumentReadouts();
    void pollWireVoltages();
  }, 300);
}

function stopVoltageReadoutPolling(): void {
  if (!voltageReadoutTimer) return;
  clearInterval(voltageReadoutTimer);
  voltageReadoutTimer = undefined;
  // Sem simulação rodando não há tensão "atual" pra mostrar -- volta os fios pra cor neutra em vez
  // de deixar a última cor (vermelho/azul) congelada, o que pareceria que ainda está simulando.
  schematicPanel?.postMessage({ version: 1, type: "wireVoltages", voltagesByWireId: {} });
  schematicPanel?.postMessage({ version: 1, type: "componentReadout", readoutsByComponentId: {} });
}

/** Mesma geração de ids de pino que `projectToWebviewState`/a Webview usam ("pin-1".."pin-N", a
 * partir do pinCount do catálogo) — `ProjectComponent` (formato `.lsproj`) não guarda pinos, só
 * `ProjectVisualComponent` (camada visual) guarda posição; os IDS em si são sempre recalculados do
 * catálogo, nunca persistidos, então é isto que tem que mandar pro Core ao reabrir um projeto. */
function runSimulation(): void {
  if (!coreClient) return;
  coreClient
    .run()
    .then(() => {
      startVoltageReadoutPolling();
      setSimulationStatus("running");
      void pollInstrumentReadouts();
      void pollWireVoltages();
    })
    .catch((err) => reportCoreWarning("iniciar simulação", err));
}

function pauseSimulation(): void {
  if (!coreClient) return;
  coreClient
    .pause()
    .then(() => {
      stopVoltageReadoutPolling();
      setSimulationStatus("paused");
    })
    .catch((err) => reportCoreWarning("pausar simulação", err));
}

function stopSimulation(): void {
  if (!coreClient) {
    stopVoltageReadoutPolling();
    setSimulationStatus("stopped");
    return;
  }
  coreClient
    .stopSimulation()
    .catch((err) => reportCoreWarning("parar simulação", err))
    .finally(() => {
      stopVoltageReadoutPolling();
      setSimulationStatus("stopped");
    });
}

function getComponentById(componentId: string): WebviewComponentModel | undefined {
  return schematicState.components.find((component) => component.id === componentId);
}

function componentLabel(componentId: string): string {
  return getComponentById(componentId)?.label ?? componentId;
}

function resolveMcuTargetCoreId(componentId: string): string | undefined {
  return mcuTargetCoreIdByComponentId.get(componentId) ?? coreInstanceIdByComponentId.get(componentId);
}

function resolveSourceIdForComponent(componentId: string): string | undefined {
  const component = getComponentById(componentId);
  if (!component) return undefined;
  return schematicState.catalog.find((entry) => entry.typeId === component.typeId)?.registeredSourceId;
}

function resolveSubcircuitChildCoreId(outerComponentId: string, innerComponentId: string): Promise<string | undefined> {
  const outerCoreId = coreInstanceIdByComponentId.get(outerComponentId);
  if (!coreClient || !outerCoreId) return Promise.resolve(undefined);
  return coreClient.getSubcircuitChildInstanceId(outerCoreId, innerComponentId).catch(() => undefined);
}

function closeMcuSerialMonitor(componentId: string, usartIndex?: number): void {
  for (const [key, monitor] of mcuSerialMonitorByKey) {
    const parts = key.split(":");
    const currentComponentId = parts[0];
    const currentUsartIndex = parts[parts.length - 1];
    if (currentComponentId !== componentId) continue;
    if (usartIndex !== undefined && Number(currentUsartIndex) !== usartIndex) continue;
    clearInterval(monitor.timer);
    monitor.channel.dispose();
    mcuSerialMonitorByKey.delete(key);
  }
}

function closeAllMcuSerialMonitors(): void {
  for (const [key, monitor] of mcuSerialMonitorByKey) {
    clearInterval(monitor.timer);
    monitor.channel.dispose();
    mcuSerialMonitorByKey.delete(key);
  }
}

async function chooseMcuFirmwareCommand(componentId: string): Promise<void> {
  const component = getComponentById(componentId);
  if (!component) return;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { Firmware: ["bin", "elf", "hex"] },
    title: `Selecionar firmware para ${component.label}`,
  });
  const selected = picked?.[0];
  if (!selected) return;

  const firmwarePath = selected.fsPath;
  const qemuBinaryOverride = typeof component.properties.qemuBinaryOverride === "string" ? component.properties.qemuBinaryOverride : "";
  schematicState = {
    ...schematicState,
    components: schematicState.components.map((entry) =>
      entry.id === componentId
        ? { ...entry, properties: { ...entry.properties, firmwarePath } }
        : entry
    ),
  };
  syncSchematicPanel();

  if (simulationStatus === "running") {
    const targetCoreId = resolveMcuTargetCoreId(componentId);
    if (coreClient && targetCoreId) {
      try {
        await coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride || undefined);
      } catch (err) {
        reportCoreWarning(`carregar firmware de "${component.label}"`, err);
      }
    }
  }
}

async function chooseExposedMcuFirmwareCommand(outerComponentId: string, innerComponentId: string): Promise<void> {
  const sourceId = resolveSourceIdForComponent(outerComponentId);
  const inner = sourceId ? gatherInternalComponentSnapshots(sourceId)?.find((entry) => entry.id === innerComponentId) : undefined;
  const label = inner?.label ?? innerComponentId;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { Firmware: ["bin", "elf", "hex"] },
    title: `Selecionar firmware para ${label}`,
  });
  const selected = picked?.[0];
  if (!selected || !sourceId) return;

  const firmwarePath = selected.fsPath;
  const qemuBinaryOverride = typeof inner?.properties.qemuBinaryOverride === "string" ? inner.properties.qemuBinaryOverride : "";
  await updateExposedComponentPropertyCommand(outerComponentId, sourceId, innerComponentId, "firmwarePath", firmwarePath);

  if (simulationStatus === "running") {
    const targetCoreId = await resolveSubcircuitChildCoreId(outerComponentId, innerComponentId);
    if (coreClient && targetCoreId) {
      try {
        await coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride || undefined);
      } catch (err) {
        reportCoreWarning(`carregar firmware de "${label}"`, err);
      }
    }
  }
}

async function reloadMcuFirmwareCommand(componentId: string): Promise<void> {
  const component = getComponentById(componentId);
  if (!component) return;
  const firmwarePath = typeof component.properties.firmwarePath === "string" ? component.properties.firmwarePath.trim() : "";
  const qemuBinaryOverride = typeof component.properties.qemuBinaryOverride === "string" ? component.properties.qemuBinaryOverride.trim() : "";
  if (!firmwarePath) {
    vscode.window.showWarningMessage(`Defina o firmware do componente "${component.label}" primeiro.`);
    return;
  }
  const targetCoreId = resolveMcuTargetCoreId(componentId);
  if (!coreClient || !targetCoreId) {
    vscode.window.showWarningMessage(`O MCU de "${component.label}" ainda nao esta disponivel no Core.`);
    return;
  }
  try {
    await coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride || undefined);
  } catch (err) {
    reportCoreWarning(`recarregar firmware de "${component.label}"`, err);
  }
}

async function reloadExposedMcuFirmwareCommand(outerComponentId: string, innerComponentId: string): Promise<void> {
  const sourceId = resolveSourceIdForComponent(outerComponentId);
  const inner = sourceId ? gatherInternalComponentSnapshots(sourceId)?.find((entry) => entry.id === innerComponentId) : undefined;
  const label = inner?.label ?? innerComponentId;
  const firmwarePath = typeof inner?.properties.firmwarePath === "string" ? inner.properties.firmwarePath.trim() : "";
  const qemuBinaryOverride = typeof inner?.properties.qemuBinaryOverride === "string" ? inner.properties.qemuBinaryOverride.trim() : "";
  if (!firmwarePath) {
    vscode.window.showWarningMessage(`Defina o firmware do componente "${label}" primeiro.`);
    return;
  }
  const targetCoreId = await resolveSubcircuitChildCoreId(outerComponentId, innerComponentId);
  if (!coreClient || !targetCoreId) {
    vscode.window.showWarningMessage(`O MCU de "${label}" ainda nao esta disponivel no Core.`);
    return;
  }
  try {
    await coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride || undefined);
  } catch (err) {
    reportCoreWarning(`recarregar firmware de "${label}"`, err);
  }
}

function openMcuSerialMonitorCommand(componentId: string, usartIndex: 0 | 1 | 2): void {
  const targetCoreId = resolveMcuTargetCoreId(componentId);
  const component = getComponentById(componentId);
  if (!coreClient || !targetCoreId || !component) {
    vscode.window.showWarningMessage("Monitor serial indisponivel para este componente.");
    return;
  }
  const key = `${componentId}:${usartIndex}`;
  const existing = mcuSerialMonitorByKey.get(key);
  if (existing) {
    existing.channel.show(true);
    return;
  }

  const channel = vscode.window.createOutputChannel(`LasecSimul USART${usartIndex + 1} - ${component.label}`);
  channel.appendLine(`[${new Date().toLocaleString()}] Monitor serial aberto para ${component.label} (USART${usartIndex + 1}).`);
  channel.appendLine("Observacao: por enquanto o monitor espelha os logs/saida do QEMU expostos pelo Core.");

  const pollLogs = async (): Promise<void> => {
    try {
      const logs = await coreClient!.getMcuLogs(targetCoreId);
      const monitor = mcuSerialMonitorByKey.get(key);
      if (!monitor) return;
      const delta = logs.slice(monitor.lastLength);
      if (delta) {
        channel.append(delta);
        monitor.lastLength = logs.length;
      } else if (logs.length < monitor.lastLength) {
        channel.appendLine(`\n[${new Date().toLocaleTimeString()}] logs reiniciados`);
        if (logs) channel.append(logs);
        monitor.lastLength = logs.length;
      }
    } catch (err) {
      channel.appendLine(`\n[erro] ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const timer = setInterval(() => void pollLogs(), 500);
  mcuSerialMonitorByKey.set(key, { channel, timer, lastLength: 0 });
  channel.show(true);
  void pollLogs();
}

async function openExposedMcuSerialMonitorCommand(outerComponentId: string, innerComponentId: string, usartIndex: 0 | 1 | 2): Promise<void> {
  const sourceId = resolveSourceIdForComponent(outerComponentId);
  const inner = sourceId ? gatherInternalComponentSnapshots(sourceId)?.find((entry) => entry.id === innerComponentId) : undefined;
  const label = inner?.label ?? innerComponentId;
  const targetCoreId = await resolveSubcircuitChildCoreId(outerComponentId, innerComponentId);
  if (!coreClient || !targetCoreId) {
    vscode.window.showWarningMessage("Monitor serial indisponivel para este componente.");
    return;
  }
  const key = `${outerComponentId}:${innerComponentId}:${usartIndex}`;
  const existing = mcuSerialMonitorByKey.get(key);
  if (existing) {
    existing.channel.show(true);
    return;
  }

  const channel = vscode.window.createOutputChannel(`LasecSimul USART${usartIndex + 1} - ${label}`);
  channel.appendLine(`[${new Date().toLocaleString()}] Monitor serial aberto para ${label} (USART${usartIndex + 1}).`);
  channel.appendLine("Observacao: por enquanto o monitor espelha os logs/saida do QEMU expostos pelo Core.");

  const pollLogs = async (): Promise<void> => {
    try {
      const logs = await coreClient!.getMcuLogs(targetCoreId);
      const monitor = mcuSerialMonitorByKey.get(key);
      if (!monitor) return;
      const delta = logs.slice(monitor.lastLength);
      if (delta) {
        channel.append(delta);
        monitor.lastLength = logs.length;
      } else if (logs.length < monitor.lastLength) {
        channel.appendLine(`\n[${new Date().toLocaleTimeString()}] logs reiniciados`);
        if (logs) channel.append(logs);
        monitor.lastLength = logs.length;
      }
    } catch (err) {
      channel.appendLine(`\n[erro] ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const timer = setInterval(() => void pollLogs(), 500);
  mcuSerialMonitorByKey.set(key, { channel, timer, lastLength: 0 });
  channel.show(true);
  void pollLogs();
}

/** `pinIds` (quando presente) é o contrato elétrico REAL na ordem que o Core espera -- plugins usam
 * o id enviado aqui diretamente (`NativeDeviceProxy`/`McuComponent`, ver `CoreApplication.cpp`,
 * `addComponent`), nunca um `pin-N` genérico sem relação com nada real. Sem `pinIds` (built-ins sem
 * schema próprio), mantém o numerador genérico de sempre. Ver `model.ts::
 * WebviewComponentCatalogEntry.pinIds`. */
function pinsForTypeId(typeId: string): Array<{ id: string; x: number; y: number }> {
  const descriptor = schematicState.catalog.find((item) => item.typeId === typeId);
  const pinCount = descriptor?.pinCount ?? 2;
  if (descriptor?.pinIds && descriptor.pinIds.length === pinCount) {
    return descriptor.pinIds.map((id, index) => ({ id, x: 0, y: index * 12 }));
  }
  return Array.from({ length: pinCount }, (_, index) => ({ id: `pin-${index + 1}`, x: 0, y: index * 12 }));
}

/** `pinsForTypeId` cai pro numerador genérico (`pin-1`/`pin-2`...) quando o catálogo não tem
 * `pinIds` -- builtins sem `package` próprio (resistor, tunnel, ground, fonte fixa, switch). Isso
 * está OK pra fios criados pela própria UI (ela usa o id que `pinsForTypeId` deu na criação, sem
 * mismatch), mas quebra pra fios que já existem no disco com o id elétrico REAL do Core (`p1`/`p2`
 * de `passive.resistor`, `pin` de `connectors.tunnel`, `out` de `sources.fixed_volt` -- ver
 * `CoreApplication.cpp::registerBuiltinComponents`) -- exatamente o caso de `.lssub.json::wires[]`
 * de um subcircuito, escrito direto com esses ids. Sem essa correspondência, `pinScenePosition`
 * (main.ts) nunca acha o pino certo no componente seedado e a wire some da tela (raiz do "não tem
 * linha nenhuma" reportado ao abrir um subcircuito pra editar). Substitui cada id genérico pelo id
 * real encontrado em QUALQUER wire que toque este componente, na MESMA posição/índice (geometria
 * de `pinLocalPosition` é por índice pra typeIds sem `package`, então a troca de string não move
 * nada na tela -- só agora bate com o que a wire espera); típeIds COM `package` (ex:
 * `espressif.esp32`) já vinham com o id real certo de `pinsForTypeId`, então o id "real" encontrado
 * aqui é sempre redundante/igual pra eles, nunca pior. */
function pinsForInternalComponent(componentId: string, typeId: string, wires: InternalWireSeed[]): Array<{ id: string; x: number; y: number }> {
  const generic = pinsForTypeId(typeId);
  const realIds: string[] = [];
  for (const wire of wires) {
    if (wire.from.componentId === componentId && wire.from.pinId && !realIds.includes(wire.from.pinId)) realIds.push(wire.from.pinId);
    if (wire.to.componentId === componentId && wire.to.pinId && !realIds.includes(wire.to.pinId)) realIds.push(wire.to.pinId);
  }
  if (realIds.length === 0) return generic;

  const count = Math.max(generic.length, realIds.length);
  return Array.from({ length: count }, (_, index) => ({
    id: realIds[index] ?? generic[index]?.id ?? `pin-${index + 1}`,
    x: 0,
    y: index * 12,
  }));
}

function shouldSyncComponentToCore(typeId: string): boolean {
  const descriptor = schematicState.catalog.find((item) => item.typeId === typeId);
  return (descriptor?.pinCount ?? 2) > 0;
}

function junctionComponentAt(point: { x: number; y: number }): WebviewComponentModel {
  return {
    id: nextId("junction"),
    typeId: "connectors.junction",
    label: "Junction",
    hidden: true,
    x: point.x,
    y: point.y,
    rotation: 0,
    pins: [{ id: "pin-1", x: 0, y: 0 }],
    properties: {},
  };
}

/** Fila de execução serializada pra `rebuildCoreFromSchematicState` — sem isso, remover vários fios
 * em sequência rápida (ex: `deleteSelectedItems` da Webview, seleção múltipla) dispara várias
 * reconstruções CONCORRENTES, todas lendo/escrevendo `coreInstanceIdByComponentId` ao mesmo tempo:
 * uma reconstrução recria instâncias enquanto outra ainda usa os ids antigos pra `connectWire`,
 * gerando "recriar fio ... falhou: conexão" (sintoma observado, ver docs/mvp-limitacoes.md). Cada
 * chamada nova só começa depois que a anterior (sucesso ou erro) terminou. */
let rebuildQueue: Promise<void> = Promise.resolve();

function queueCoreRebuild(): Promise<void> {
  rebuildQueue = rebuildQueue.then(() => rebuildCoreFromSchematicState()).catch(() => {});
  return rebuildQueue;
}

async function rebuildCoreFromSchematicState(): Promise<void> {
  if (!coreClient) return;

  const runningBeforeRebuild = simulationStatus === "running";
  if (runningBeforeRebuild) {
    try {
      await coreClient.stopSimulation();
    } catch (err) {
      reportCoreWarning("parar simulação antes de reconstruir o circuito", err);
    }
    stopVoltageReadoutPolling();
    setSimulationStatus("stopped");
  }

  const existingInstanceIds = [...coreInstanceIdByComponentId.values()];
  for (const instanceId of existingInstanceIds) {
    try {
      await coreClient.removeComponent(instanceId);
    } catch {
      // Se a instância já sumiu do outro lado, seguimos e reconstruímos o snapshot atual.
    }
  }
  coreInstanceIdByComponentId.clear();
  mcuTargetCoreIdByComponentId.clear();

  for (const component of schematicState.components) {
    if (!shouldSyncComponentToCore(component.typeId)) continue;
    try {
      const response = await coreClient.addComponent(
        component.typeId,
        component.properties,
        pinsForTypeId(component.typeId)
      );
      registerCoreIdsForComponent(component.id, component.typeId, response);
    } catch (err) {
      reportCoreWarning(`recriar "${component.typeId}" (${component.id})`, err);
    }
  }

  for (const wire of schematicState.wires) {
    const coreA = coreInstanceIdByComponentId.get(wire.from.componentId);
    const coreB = coreInstanceIdByComponentId.get(wire.to.componentId);
    if (!coreA || !coreB) continue;
    try {
      await coreClient.connectWire(coreA, wire.from.pinId, coreB, wire.to.pinId);
    } catch (err) {
      reportCoreWarning(`recriar fio "${wire.id}"`, err);
    }
  }

  if (runningBeforeRebuild) {
    try {
      await coreClient.run();
      startVoltageReadoutPolling();
      setSimulationStatus("running");
      void pollInstrumentReadouts();
      void pollWireVoltages();
    } catch (err) {
      reportCoreWarning("reiniciar simulação após reconstruir o circuito", err);
    }
  }
}

/** Recria um projeto carregado de disco no Core, na ordem certa (todo componente antes de qualquer
 * fio) — diferente do caminho interativo, aqui é preciso aguardar cada chamada porque connectWire
 * depende do instanceId que addComponent ainda não tinha devolvido. */
async function pushProjectToCore(project: ProjectDocument): Promise<void> {
  if (!coreClient) return;
  coreInstanceIdByComponentId.clear();
  mcuTargetCoreIdByComponentId.clear();
  for (const component of project.components) {
    if (!shouldSyncComponentToCore(component.typeId)) continue;
    try {
      const response = await coreClient.addComponent(
        component.typeId,
        component.properties,
        pinsForTypeId(component.typeId)
      );
      registerCoreIdsForComponent(component.id, component.typeId, response);
    } catch (err) {
      reportCoreWarning(`criar "${component.typeId}" (${component.id})`, err);
    }
  }
  for (const wire of project.wires) {
    const coreA = coreInstanceIdByComponentId.get(wire.from.componentId);
    const coreB = coreInstanceIdByComponentId.get(wire.to.componentId);
    if (!coreA || !coreB) continue;
    try {
      await coreClient.connectWire(coreA, wire.from.pinId, coreB, wire.to.pinId);
    } catch (err) {
      reportCoreWarning(`conectar fio "${wire.id}"`, err);
    }
  }
}

function webviewComponentToProjectComponent(component: WebviewComponentModel): ProjectComponent {
  return {
    id: component.id,
    typeId: component.typeId,
    properties: component.properties,
    label: component.label,
    showId: component.showId,
    showValue: component.showValue,
    flipH: component.flipH,
    flipV: component.flipV,
    visual: { x: component.x, y: component.y, rotation: component.rotation },
  };
}

function validVisualPoints(points: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(points)) return [];
  return points
    .filter((point): point is { x: number; y: number } =>
      typeof point === "object" &&
      point !== null &&
      "x" in point &&
      "y" in point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y)
    )
    .map((point) => ({ x: point.x, y: point.y }));
}

function projectToWebviewState(project: ProjectDocument): WebviewProjectState {
  const catalog = schematicState.catalog;
  const visualWirePoints = new Map(
    project.visual.wires.map((wire) => [
      wire.id,
      validVisualPoints(wire.points),
    ])
  );
  const components: WebviewComponentModel[] = project.components.map((component) => {
    const descriptor = catalog.find((item) => item.typeId === component.typeId);
    return {
      id: component.id,
      typeId: component.typeId,
      // Projeto salvo antes desta versão não tem `label` -- cai pro catálogo, igual sempre foi.
      label: component.label ?? descriptor?.label ?? component.typeId,
      hidden: descriptor?.hidden ?? false,
      showId: component.showId,
      showValue: component.showValue ?? hasShowOnSymbolProperty(descriptor),
      flipH: component.flipH,
      flipV: component.flipV,
      x: component.visual?.x ?? 0,
      y: component.visual?.y ?? 0,
      rotation: component.visual?.rotation ?? 0,
      pins: pinsForTypeId(component.typeId),
      properties: component.properties as Record<string, string | number | boolean>,
    };
  });
  const wires: WebviewWireModel[] = project.wires.map((wire) => {
    const points = visualWirePoints.get(wire.id);
    return {
      id: wire.id,
      from: wire.from,
      to: wire.to,
      ...(points && points.length > 0 ? { points } : {}),
    };
  });
  return {
    locale: currentLasecSimulLanguage(),
    catalog,
    components,
    wires,
    viewport: project.visual.viewport,
    selectedComponentIds: [],
    selectedWireIds: [],
  };
}

function handleWebviewMessage(message: WebviewToHostMessage): void {
  if (message.version !== 1) {
    return;
  }
  switch (message.type) {
    case "projectChanged":
      schematicState = message.project;
      return;
    case "requestAddComponent": {
      const descriptor = schematicState.catalog.find((item) => item.typeId === message.typeId);
      const componentId = nextId("component");
      const pins = pinsForTypeId(message.typeId);
      const baseLabel = descriptor?.label ?? message.typeId;
      const component: WebviewComponentModel = {
        id: componentId,
        typeId: message.typeId,
        label: nextIndexedLabel(message.typeId, baseLabel, schematicState.components),
        hidden: descriptor?.hidden ?? false,
        showValue: hasShowOnSymbolProperty(descriptor),
        x: 140 + schematicState.components.length * 24,
        y: 140 + schematicState.components.length * 24,
        rotation: 0,
        pins,
        properties: { ...(descriptor?.defaultProperties ?? {}) },
      };
      schematicState = {
        ...schematicState,
        components: [...schematicState.components, component],
        selectedComponentIds: [componentId],
        selectedWireIds: [],
      };
      pushComponentToCore(componentId, component.typeId, component.properties, component.pins);
      syncSchematicPanel();
      return;
    }
    case "requestInsertItems": {
      const existingComponentIds = new Set(schematicState.components.map((component) => component.id));
      const existingWireIds = new Set(schematicState.wires.map((wire) => wire.id));
      const components = message.components.filter((component) => !existingComponentIds.has(component.id));
      const insertedComponentIds = new Set(components.map((component) => component.id));
      const wires = message.wires.filter((wire) =>
        !existingWireIds.has(wire.id) &&
        (existingComponentIds.has(wire.from.componentId) || insertedComponentIds.has(wire.from.componentId)) &&
        (existingComponentIds.has(wire.to.componentId) || insertedComponentIds.has(wire.to.componentId))
      );

      schematicState = {
        ...schematicState,
        components: [...schematicState.components, ...components],
        wires: [...schematicState.wires, ...wires],
        selectedComponentIds: components.map((component) => component.id),
        selectedWireIds: wires.map((wire) => wire.id),
      };
      for (const component of components) pushComponentToCore(component.id, component.typeId, component.properties, component.pins);
      for (const wire of wires) pushWireToCore(wire);
      syncSchematicPanel();
      return;
    }
    case "requestRemoveComponent": {
      closeMcuSerialMonitor(message.componentId);
      pushRemoveToCore(message.componentId);
      coreInstanceIdByComponentId.delete(message.componentId);
      mcuTargetCoreIdByComponentId.delete(message.componentId);
      const removedWireIds = new Set(
        schematicState.wires
          .filter((wire) => wire.from.componentId === message.componentId || wire.to.componentId === message.componentId)
          .map((wire) => wire.id)
      );
      schematicState = {
        ...schematicState,
        components: schematicState.components.filter((component) => component.id !== message.componentId),
        wires: schematicState.wires.filter((wire) => wire.from.componentId !== message.componentId && wire.to.componentId !== message.componentId),
        selectedComponentIds: schematicState.selectedComponentIds.filter((id) => id !== message.componentId),
        selectedWireIds: schematicState.selectedWireIds.filter((id) => !removedWireIds.has(id)),
        pendingConnection:
          schematicState.pendingConnection?.componentId === message.componentId ? undefined : schematicState.pendingConnection,
      };
      syncSchematicPanel();
      if (simulationStatus === "running") void pollWireVoltages();
      return;
    }
    case "requestRemoveWire": {
      schematicState = {
        ...schematicState,
        wires: schematicState.wires.filter((wire) => wire.id !== message.wireId),
        selectedWireIds: schematicState.selectedWireIds.filter((id) => id !== message.wireId),
      };
      syncSchematicPanel();
      void queueCoreRebuild().then(() => {
        if (simulationStatus === "running") {
          void pollInstrumentReadouts();
          void pollWireVoltages();
        }
      });
      return;
    }
    case "requestConnectPins": {
      const wire: WebviewWireModel = {
        id: nextId("wire"),
        from: message.from,
        to: message.to,
        points: message.points,
      };
      schematicState = {
        ...schematicState,
        wires: [...schematicState.wires, wire],
        selectedComponentIds: [],
        selectedWireIds: [wire.id],
        pendingConnection: undefined,
      };
      pushWireToCore(wire);
      syncSchematicPanel();
      if (simulationStatus === "running") void pollWireVoltages();
      return;
    }
    case "requestConnectPinToWire": {
      const existingWire = schematicState.wires.find((wire) => wire.id === message.wireId);
      if (!existingWire) return;
      const junction = junctionComponentAt(message.point);
      const firstWire: WebviewWireModel = {
        id: nextId("wire"),
        from: existingWire.from,
        to: { componentId: junction.id, pinId: "pin-1" },
        points: message.existingWireFirstPoints,
      };
      const secondWire: WebviewWireModel = {
        id: nextId("wire"),
        from: { componentId: junction.id, pinId: "pin-1" },
        to: existingWire.to,
        points: message.existingWireSecondPoints,
      };
      const newWire: WebviewWireModel = {
        id: nextId("wire"),
        from: message.from,
        to: { componentId: junction.id, pinId: "pin-1" },
        points: message.points,
      };
      schematicState = {
        ...schematicState,
        components: [...schematicState.components, junction],
        wires: [
          ...schematicState.wires.filter((wire) => wire.id !== message.wireId),
          firstWire,
          secondWire,
          newWire,
        ],
        selectedComponentIds: [],
        selectedWireIds: [newWire.id],
        pendingConnection: undefined,
      };
      syncSchematicPanel();
      void queueCoreRebuild().then(() => {
        if (simulationStatus === "running") {
          void pollInstrumentReadouts();
          void pollWireVoltages();
        }
      });
      return;
    }
    case "requestRotateComponent": {
      schematicState = {
        ...schematicState,
        components: schematicState.components.map((component) =>
          component.id === message.componentId ? { ...component, rotation: message.rotation } : component
        ),
      };
      syncSchematicPanel();
      return;
    }
    case "requestFlipComponent": {
      schematicState = {
        ...schematicState,
        components: schematicState.components.map((component) =>
          component.id === message.componentId
            ? { ...component, flipH: message.flipH, flipV: message.flipV }
            : component
        ),
      };
      syncSchematicPanel();
      return;
    }
    case "requestRenameComponent": {
      schematicState = {
        ...schematicState,
        components: schematicState.components.map((component) =>
          component.id === message.componentId ? { ...component, label: message.label } : component
        ),
      };
      syncSchematicPanel();
      return;
    }
    case "requestUpdateLabelVisibility": {
      // Puramente visual -- nunca toca o Core (ver `.spec/lasecsimul.spec` seção 6.1.2: visibilidade
      // de rótulo não é uma propriedade elétrica, não tem schema de plugin/built-in nenhum).
      schematicState = {
        ...schematicState,
        components: schematicState.components.map((component) =>
          component.id === message.componentId
            ? { ...component, showId: message.showId, showValue: message.showValue }
            : component
        ),
      };
      syncSchematicPanel();
      return;
    }
    case "requestUpdateProperty": {
      schematicState = {
        ...schematicState,
        components: schematicState.components.map((component) =>
          component.id === message.componentId
            ? { ...component, properties: { ...component.properties, [message.name]: message.value } }
            : component
        ),
      };
      pushPropertyToCore(message.componentId, message.name, message.value);
      syncSchematicPanel();
      if (simulationStatus === "running") {
        void pollInstrumentReadouts();
        void pollWireVoltages();
      }
      return;
    }
    case "requestRunSimulation":
      runSimulation();
      return;
    case "requestPauseSimulation":
      pauseSimulation();
      return;
    case "requestStopSimulation":
      stopSimulation();
      return;
    case "requestSaveProject":
      void saveProjectCommand();
      return;
    case "requestOpenProject":
      if (extensionContext) void openProjectCommand(extensionContext);
      return;
    case "requestSaveSymbol":
      void saveSymbolCommand(message.filePath, message.typeId, message.kind, message.view, message.components, message.wires);
      return;
    case "requestEditSymbol":
      void editPackageSymbolCommand({ sourceId: message.sourceId });
      return;
    case "requestChooseMcuFirmware":
      void chooseMcuFirmwareCommand(message.componentId);
      return;
    case "requestChooseExposedMcuFirmware":
      void chooseExposedMcuFirmwareCommand(message.outerComponentId, message.innerComponentId);
      return;
    case "requestReloadMcuFirmware":
      void reloadMcuFirmwareCommand(message.componentId);
      return;
    case "requestReloadExposedMcuFirmware":
      void reloadExposedMcuFirmwareCommand(message.outerComponentId, message.innerComponentId);
      return;
    case "requestOpenMcuSerialMonitor":
      openMcuSerialMonitorCommand(message.componentId, message.usartIndex);
      return;
    case "requestOpenExposedMcuSerialMonitor":
      void openExposedMcuSerialMonitorCommand(message.outerComponentId, message.innerComponentId, message.usartIndex);
      return;
    case "requestSwitchSymbolView":
      void switchSymbolViewCommand(message.filePath, message.typeId, message.kind, message.toView, message.internalComponents, message.internalWires);
      return;
    case "requestExportInstrumentData":
      void exportInstrumentDataCommand(message.suggestedFileName, message.csvContent);
      return;
    case "requestInstrumentHistory":
      void sendInstrumentHistory(message.componentId);
      return;
    case "requestLoadPackage":
      void loadPackageCommand(message.sourceId);
      return;
    case "requestSavePackage":
      void savePackageCommand(message.sourceId);
      return;
    case "requestUpdateBoardOverlayProperty":
      updateBoardOverlayPropertyCommand(message.outerComponentId, message.innerComponentId, message.name, message.value);
      return;
    case "requestBoardOverlayData":
      void requestBoardOverlayDataCommand(message.componentId, message.sourceId);
      return;
    case "requestUpdateBoardOverlayVisual":
      void updateBoardOverlayVisualCommand(message.sourceId, message.innerComponentId, message.x, message.y);
      return;
    case "requestUpdateExposedComponentProperty":
      void updateExposedComponentPropertyCommand(message.outerComponentId, message.sourceId, message.innerComponentId, message.name, message.value);
      return;
  }
}

/** "Exportar Dados" da janela "Expande" (osciloscópio/analisador lógico) -- o CSV já vem formatado
 * da Webview (main.ts, que tem o histórico/configuração de canais); aqui só o diálogo de salvar +
 * escrita do arquivo, igual a `saveProjectCommand`. */
async function exportInstrumentDataCommand(suggestedFileName: string, csvContent: string): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    filters: { "CSV": ["csv"] },
    defaultUri: vscode.Uri.file(suggestedFileName),
  });
  if (!uri) return;
  try {
    fs.writeFileSync(uri.fsPath, csvContent, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível exportar os dados: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function saveProjectCommand(): Promise<void> {
  const uri = await vscode.window.showSaveDialog({ filters: { "LasecSimul Project": ["lsproj"] } });
  if (!uri) return;
  const project: ProjectDocument = {
    ...createEmptyProject(),
    components: schematicState.components.map(webviewComponentToProjectComponent),
    wires: schematicState.wires.map((wire) => ({ id: wire.id, from: wire.from, to: wire.to })),
    visual: {
      components: [],
      wires: schematicState.wires
        .filter((wire) => wire.points && wire.points.length > 0)
        .map((wire) => ({ id: wire.id, points: wire.points })),
      viewport: schematicState.viewport,
    },
  };
  await projectSerializer.save(uri.fsPath, project);
  vscode.window.showInformationMessage(`Projeto LasecSimul salvo em ${uri.fsPath}`);
}

async function openProjectCommand(context: vscode.ExtensionContext): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    filters: { "LasecSimul Project": ["lsproj"] },
    canSelectMany: false,
  });
  const selected = uris?.[0];
  if (!selected) return;
  closeAllMcuSerialMonitors();
  const project = await projectSerializer.load(selected.fsPath);
  schematicState = projectToWebviewState(project);
  if (!schematicPanel) openSchematicEditor(context.extensionUri);
  syncSchematicPanel();
  await rebuildCoreFromSchematicState();
}

function nextSourceId(): string {
  return `registered-source-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function inferSourcesFromSelectedFile(extensionPath: string, selectedPath: string): RegisteredSource[] {
  const absoluteSelectedPath = normalizeAbsolutePath(extensionPath, selectedPath);
  const fileName = path.basename(absoluteSelectedPath).toLowerCase();
  const sources: RegisteredSource[] = [];

  const json = readJsonFile(absoluteSelectedPath) as Record<string, unknown>;

  if (fileName === "library.json") {
    const abiEntries = Array.isArray(json.devices) ? json.devices : [];
    for (const value of abiEntries) {
      if (typeof value !== "object" || value === null) continue;
      const deviceEntry = value as { manifest?: unknown };
      if (typeof deviceEntry.manifest !== "string" || !deviceEntry.manifest.trim()) continue;
      const manifestPath = path.resolve(path.dirname(absoluteSelectedPath), deviceEntry.manifest);
      sources.push({
        id: nextSourceId(),
        kind: "abi-device",
        filePath: manifestPath,
        libraryPath: absoluteSelectedPath,
        lsconfigPath: inferLsconfigPath(manifestPath),
      });
    }

    const mcuEntries = Array.isArray(json.mcus) ? json.mcus : [];
    for (const value of mcuEntries) {
      if (typeof value !== "object" || value === null) continue;
      const mcuEntry = value as { manifest?: unknown };
      if (typeof mcuEntry.manifest !== "string" || !mcuEntry.manifest.trim()) continue;
      const manifestPath = path.resolve(path.dirname(absoluteSelectedPath), mcuEntry.manifest);
      sources.push({
        id: nextSourceId(),
        kind: "mcu-adapter",
        filePath: manifestPath,
        libraryPath: absoluteSelectedPath,
        lsconfigPath: inferLsconfigPath(manifestPath),
      });
    }

    const subEntries = Array.isArray(json.subcircuits) ? json.subcircuits : [];
    for (const value of subEntries) {
      if (typeof value !== "object" || value === null) continue;
      const subEntry = value as { manifest?: unknown };
      if (typeof subEntry.manifest !== "string" || !subEntry.manifest.trim()) continue;
      const manifestPath = path.resolve(path.dirname(absoluteSelectedPath), subEntry.manifest);
      sources.push({
        id: nextSourceId(),
        kind: "subcircuit-file",
        filePath: manifestPath,
      });
    }

    return sources;
  }

  if (fileName.endsWith(".lssub.json")) {
    sources.push({
      id: nextSourceId(),
      kind: "subcircuit-file",
      filePath: absoluteSelectedPath,
    });
    return sources;
  }

  const hasChipId = typeof json.chipId === "string" && json.chipId.trim().length > 0;
  const hasNativeEntry = typeof json.nativeEntry === "object" && json.nativeEntry !== null;
  if (fileName === "mcu.json" || hasChipId) {
    sources.push({
      id: nextSourceId(),
      kind: "mcu-adapter",
      filePath: absoluteSelectedPath,
      libraryPath: inferLibraryPathForDevice(absoluteSelectedPath),
      lsconfigPath: inferLsconfigPath(absoluteSelectedPath),
    });
    return sources;
  }

  if (fileName === "device.json" || hasNativeEntry) {
    sources.push({
      id: nextSourceId(),
      kind: "abi-device",
      filePath: absoluteSelectedPath,
      libraryPath: inferLibraryPathForDevice(absoluteSelectedPath),
      lsconfigPath: inferLsconfigPath(absoluteSelectedPath),
    });
    return sources;
  }

  const looksLikeSubcircuit = Array.isArray(json.components) && Array.isArray(json.wires) && Array.isArray(json.interface);
  if (looksLikeSubcircuit) {
    sources.push({
      id: nextSourceId(),
      kind: "subcircuit-file",
      filePath: absoluteSelectedPath,
    });
  }

  return sources;
}

async function refreshUnifiedCatalogState(loadLibrariesInCore: boolean): Promise<void> {
  if (!extensionContext) return;
  const unifiedCatalog = loadUnifiedCatalog(extensionContext.extensionPath, currentLasecSimulLanguage());
  const resolved = resolveRegisteredItems(extensionContext.extensionPath, unifiedCatalog.registeredSources);

  const requests = new Map<string, { displayPath: string; absolutePath: string }>();
  for (const relativePath of unifiedCatalog.deviceLibraries) {
    const absolutePath = normalizeAbsolutePath(extensionContext.extensionPath, relativePath);
    requests.set(absolutePath, { displayPath: relativePath, absolutePath });
  }
  for (const item of resolved) {
    if (!item.libraryPathToLoad) continue;
    const absolutePath = normalizeAbsolutePath(extensionContext.extensionPath, item.libraryPathToLoad);
    if (!requests.has(absolutePath)) {
      requests.set(absolutePath, { displayPath: absolutePath, absolutePath });
    }
  }

  const failures = loadLibrariesInCore
    ? await loadConfiguredDeviceLibraries(extensionContext.extensionPath, [...requests.values()])
    : new Map<string, string>();

  const baseTypeIds = new Set(unifiedCatalog.catalog.map((entry) => entry.typeId));
  const registeredEntries = resolved.flatMap((item) => {
    const failedReason = item.libraryPathToLoad
      ? failures.get(normalizeAbsolutePath(extensionContext!.extensionPath, item.libraryPathToLoad))
      : undefined;
    if (failedReason) {
      return [{
        ...item.entry,
        disabled: true,
        disabledReason: localizedAbiFailure(failedReason, currentLasecSimulLanguage()),
      }];
    }
    if (baseTypeIds.has(item.entry.typeId)) {
      // Catálogo base vence: evita duplicata "registrada" com lápis/ícone externo quando o mesmo
      // typeId já existe como item nativo da paleta (caso do voltímetro).
      return [];
    }
    return [item.entry];
  });

  const mergedCatalog = [...unifiedCatalog.catalog, ...registeredEntries];
  setEffectiveCatalog(loadLibrariesInCore ? await attachPropertySchemas(mergedCatalog) : mergedCatalog);
}

/** Anexa o schema rico de propriedades (grupo/editor/min/max/opções/flags) de cada typeId, vindo do
 * Core via `getPropertySchemas` — só tentado quando `loadLibrariesInCore` (ou seja, quando o
 * `coreClient` já deveria estar conectado); best-effort: se falhar (Core ainda não respondeu, por
 * exemplo), o catálogo segue sem schema e o diálogo de propriedades cai pra inferência (ver
 * `resolvePropertyFields` na Webview). Schema é por typeId (catálogo), nunca por instância. */
async function attachPropertySchemas(
  catalog: WebviewComponentCatalogEntry[]
): Promise<WebviewComponentCatalogEntry[]> {
  if (!coreClient) return catalog;
  let resolved: Awaited<ReturnType<typeof coreClient.getPropertySchemas>>;
  try {
    resolved = await coreClient.getPropertySchemas(currentLasecSimulLanguage());
  } catch {
    return catalog; // Core ainda não respondeu -- catálogo sem schema, inferência cobre o resto
  }
  return mergePropertySchemas(catalog, resolved.schemasByTypeId, resolved.readoutFormatByTypeId, resolved.interactionKindByTypeId);
}

async function registerCatalogFileCommand(): Promise<void> {
  if (!extensionContext) return;
  const ctx = extensionContext;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: {
      JSON: ["json"],
    },
    title: "Registrar arquivo ABI/QEMU/Subcircuito no LasecSimul",
  });
  const selected = picked?.[0];
  if (!selected) return;

  let newSources: RegisteredSource[] = [];
  try {
    newSources = inferSourcesFromSelectedFile(ctx.extensionPath, selected.fsPath);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Não foi possível registrar arquivo: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (newSources.length === 0) {
    vscode.window.showWarningMessage("Arquivo não reconhecido como ABI, QEMU (mcu/library) nem subcircuito.");
    return;
  }

  const unifiedCatalog = loadUnifiedCatalog(ctx.extensionPath, currentLasecSimulLanguage());
  const existingKeys = new Set(
    unifiedCatalog.registeredSources.map((source) => `${source.kind}::${normalizeAbsolutePath(ctx.extensionPath, source.filePath)}`)
  );
  const deduped = newSources.filter((source) => {
    const key = `${source.kind}::${normalizeAbsolutePath(ctx.extensionPath, source.filePath)}`;
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });

  if (deduped.length === 0) {
    vscode.window.showInformationMessage("Esses itens já estavam registrados na paleta.");
    return;
  }

  const mergedSources = [...unifiedCatalog.registeredSources, ...deduped];
  const savedAt = saveRegisteredSources(ctx.extensionPath, mergedSources);
  await refreshUnifiedCatalogState(true);
  vscode.window.showInformationMessage(`Registro concluído (${deduped.length} item(ns)). Catálogo salvo em ${savedAt}.`);
}

async function removeRegisteredCatalogItemCommand(item?: { sourceId?: string }): Promise<void> {
  if (!extensionContext) return;
  const sourceId = typeof item?.sourceId === "string" ? item.sourceId : undefined;
  if (!sourceId) {
    vscode.window.showWarningMessage("Selecione um item registrado na paleta para remover.");
    return;
  }

  const unifiedCatalog = loadUnifiedCatalog(extensionContext.extensionPath, currentLasecSimulLanguage());
  const source = unifiedCatalog.registeredSources.find((value) => value.id === sourceId);
  if (!source) {
    vscode.window.showWarningMessage("Item registrado não encontrado no catálogo.");
    return;
  }

  if (source.removable === false) {
    vscode.window.showInformationMessage("Esse item faz parte do catÃ¡logo integrado e nÃ£o pode ser removido pela paleta.");
    return;
  }

  const decision = await vscode.window.showWarningMessage(
    "Remover item registrado da paleta?",
    { modal: true },
    "Remover"
  );
  if (decision !== "Remover") return;

  const nextSources = unifiedCatalog.registeredSources.filter((value) => value.id !== sourceId);
  saveRegisteredSources(extensionContext.extensionPath, nextSources);
  await refreshUnifiedCatalogState(true);
  vscode.window.showInformationMessage("Item removido da paleta de componentes.");
}

/** Pinos elétricos REAIS de um manifesto, melhor-esforço, só pra avisar (não bloquear) quando um
 * `pinId` de um `other.package_pin` não bate com nada conhecido -- ver `saveSymbolCommand`.
 * `abi-device`: `pins[].id`. `mcu-adapter`: chaves
 * de `pinMap` (o mesmo campo estático que `resolveRegisteredItem` já usa como fallback de
 * `pinCount`, ver acima — não tem relação com o `get_pin_map()` em runtime do plugin).
 * `subcircuit-file`: `interface[].pinId`. */
function knownPinIdsForManifest(json: Record<string, unknown>, kind: RegisteredItemKind): string[] {
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

/** Lê o bloco `package` do manifesto pra EDIÇÃO -- deliberadamente mais permissivo que
 * `sanitizePackage` (que descarta `pins: []` tratando como "sem package", certo pra decidir o que
 * mostrar na paleta, errado aqui: um symbol em construção começa vazio mesmo). Mesmo nível de
 * confiança que o resto desta função aplica ao manifesto (1ª parte ou já passou por consentimento
 * de plugin). Sem `package` no arquivo -> corpo em branco, pronto pra desenhar do zero. */
function extractPackageForEditing(json: Record<string, unknown>, key: "package" | "logicSymbolPackage" = "package"): PackageDescriptor {
  const raw = json[key];
  if (typeof raw === "object" && raw !== null) {
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.width === "number" && typeof candidate.height === "number") {
      return {
        width: candidate.width,
        height: candidate.height,
        schematicWidth: typeof candidate.schematicWidth === "number" ? candidate.schematicWidth : undefined,
        schematicHeight: typeof candidate.schematicHeight === "number" ? candidate.schematicHeight : undefined,
        border: typeof candidate.border === "boolean" ? candidate.border : undefined,
        background: typeof candidate.background === "object" && candidate.background !== null
          ? (candidate.background as PackageDescriptor["background"])
          : undefined,
        shapes: Array.isArray(candidate.shapes) ? (candidate.shapes as PackageShape[]) : [],
        pins: Array.isArray(candidate.pins) ? (candidate.pins as PackagePin[]) : [],
        pinLabelColor: typeof candidate.pinLabelColor === "string" ? candidate.pinLabelColor : undefined,
      };
    }
  }
  return { width: 80, height: 60, border: true, shapes: [], pins: [] };
}

function extractSubcircuitInterfaceMap(json: Record<string, unknown>): Map<string, { label?: string; internalTunnel?: string }> {
  const entries = Array.isArray(json.interface) ? json.interface : [];
  const result = new Map<string, { label?: string; internalTunnel?: string }>();
  for (const value of entries) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const pinId = typeof entry.pinId === "string" ? entry.pinId.trim() : "";
    if (!pinId) continue;
    result.set(pinId, {
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : undefined,
      internalTunnel: typeof entry.internalTunnel === "string" && entry.internalTunnel.trim() ? entry.internalTunnel.trim() : undefined,
    });
  }
  return result;
}

function extractInternalTunnelNames(json: Record<string, unknown>): Set<string> {
  const rawComponents = Array.isArray(json.components) ? json.components : [];
  return new Set(
    rawComponents
      .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
      .filter((component) => component.typeId === "connectors.tunnel")
      .map((component) => component.properties as Record<string, unknown> | undefined)
      .map((properties) => typeof properties?.name === "string" ? properties.name.trim() : "")
      .filter((name) => name.length > 0)
  );
}

function inferInternalTunnelForPin(pinId: string, tunnelNames: Set<string>, label?: string): string | undefined {
  if (tunnelNames.has(pinId)) return pinId;
  if (/^GND\d+$/i.test(pinId) && tunnelNames.has("GND")) return "GND";
  const normalizedLabel = typeof label === "string" ? label.trim().toUpperCase() : "";
  if (normalizedLabel && tunnelNames.has(normalizedLabel)) return normalizedLabel;
  return undefined;
}

function applySubcircuitInterfaceToPackageComponents(json: Record<string, unknown>, packageComponents: WebviewComponentModel[]): WebviewComponentModel[] {
  const interfaceByPinId = extractSubcircuitInterfaceMap(json);
  const tunnelNames = extractInternalTunnelNames(json);
  return packageComponents.map((component) => {
    if (component.typeId !== "other.package_pin") return component;
    const pinId = typeof component.properties.pinId === "string" ? component.properties.pinId.trim() : "";
    if (!pinId) return component;
    const current = interfaceByPinId.get(pinId);
    const inferredTunnel = current?.internalTunnel ?? inferInternalTunnelForPin(pinId, tunnelNames, current?.label);
    if (!inferredTunnel) return component;
    return {
      ...component,
      properties: {
        ...component.properties,
        internalTunnel: inferredTunnel,
      },
    };
  });
}

function sanitizeVisualPosition(value: unknown): VisualPosition | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.x !== "number" || typeof raw.y !== "number") return undefined;
  const rotation = raw.rotation === 90 || raw.rotation === 180 || raw.rotation === 270 ? raw.rotation : 0;
  return {
    x: raw.x,
    y: raw.y,
    rotation,
    flipH: typeof raw.flipH === "boolean" ? raw.flipH : undefined,
    flipV: typeof raw.flipV === "boolean" ? raw.flipV : undefined,
  };
}

/** Lê `components[]`/`wires[]` REAIS de um `.lssub.json` (`visual`/`boardVisual`/`points` são campos
 * novos, aditivos -- `core/src/registry/SubcircuitRegistry.hpp::SubcircuitComponentDef`/
 * `SubcircuitWireDef` só leem campos nomeados, ignoram o resto, então isto nunca quebra o Core, ver
 * `.spec/lasecsimul-subcircuits.spec`). Só usado pra "Abrir Subcircuito" (kind === "subcircuit-file"
 * -- `device.json`/`mcu.json` não têm circuito interno, "Package ≠ Subcircuit"). */
function extractInternalCircuit(json: Record<string, unknown>): { components: InternalComponentSeed[]; wires: InternalWireSeed[] } {
  const componentsRaw = Array.isArray(json.components) ? json.components : [];
  const components: InternalComponentSeed[] = componentsRaw
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((value) => ({
      id: typeof value.id === "string" ? value.id : "",
      typeId: typeof value.typeId === "string" ? value.typeId : "",
      properties: typeof value.properties === "object" && value.properties !== null ? (value.properties as Record<string, unknown>) : {},
      visual: sanitizeVisualPosition(value.visual),
      boardVisual: sanitizeVisualPosition(value.boardVisual),
      exposed: value.exposed === true,
    }))
    .filter((component) => component.id && component.typeId);

  const wiresRaw = Array.isArray(json.wires) ? json.wires : [];
  const wires: InternalWireSeed[] = wiresRaw
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((value) => {
      const from = value.from as Record<string, unknown> | undefined;
      const to = value.to as Record<string, unknown> | undefined;
      const points = Array.isArray(value.points)
        ? (value.points as unknown[])
            .filter((point): point is Record<string, unknown> => typeof point === "object" && point !== null && typeof (point as Record<string, unknown>).x === "number" && typeof (point as Record<string, unknown>).y === "number")
            .map((point) => ({ x: point.x as number, y: point.y as number }))
        : undefined;
      return {
        from: { componentId: typeof from?.componentId === "string" ? from.componentId : "", pinId: typeof from?.pinId === "string" ? from.pinId : "" },
        to: { componentId: typeof to?.componentId === "string" ? to.componentId : "", pinId: typeof to?.pinId === "string" ? to.pinId : "" },
        points,
      };
    })
    .filter((wire) => wire.from.componentId && wire.to.componentId);

  return { components, wires };
}

/** Resolve um `sourceId` (`RegisteredSource.id`, igual ao usado por `editPackageSymbolCommand`) pro
 * caminho absoluto do manifesto -- compartilhado pelos comandos de "Carregar/Salvar pacote" e
 * "Selecione os Componentes expostos", que precisam todos do mesmo `.lssub.json`/`device.json`/
 * `mcu.json` do item clicado. */
function resolveSourceFilePath(ctx: vscode.ExtensionContext, sourceId: string): string | undefined {
  const unifiedCatalog = loadUnifiedCatalog(ctx.extensionPath, currentLasecSimulLanguage());
  const source = unifiedCatalog.registeredSources.find((value) => value.id === sourceId);
  if (!source) {
    vscode.window.showWarningMessage("Item registrado não encontrado no catálogo.");
    return undefined;
  }
  return normalizeAbsolutePath(ctx.extensionPath, source.filePath);
}

/** "Carregar pacote" -- mesmo destino de "Abrir Subcircuito"/"Editar Símbolo" (reaproveita
 * `editPackageSymbolCommand` tal qual), só com rótulo de menu diferente (ver `subpackage.cpp::
 * loadPackage()` real, que também abre a edição do package ao "carregar"). */
async function loadPackageCommand(sourceId: string): Promise<void> {
  await editPackageSymbolCommand({ sourceId });
}

/** "Salvar pacote" -- exporta só a chave `package` do manifesto pra um arquivo separado escolhido
 * pelo usuário (mesmo papel de `SubPackage::slotSave()` real, formato simplificado pra JSON puro
 * em vez do `.package` binário do SimulIDE). */
async function savePackageCommand(sourceId: string): Promise<void> {
  if (!extensionContext) return;
  const ctx = extensionContext;
  const absoluteFilePath = resolveSourceFilePath(ctx, sourceId);
  if (!absoluteFilePath || !fileExists(absoluteFilePath)) return;

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const pkg = json.package;
  if (typeof pkg !== "object" || pkg === null) {
    vscode.window.showWarningMessage("Este item não tem um \"package\" pra salvar.");
    return;
  }

  const defaultName = `${path.basename(absoluteFilePath).replace(/\.json$/i, "")}.pkg.json`;
  const target = await vscode.window.showSaveDialog({
    filters: { JSON: ["json"] },
    defaultUri: vscode.Uri.file(path.join(path.dirname(absoluteFilePath), defaultName)),
    title: "Salvar pacote",
  });
  if (!target) return;

  try {
    fs.writeFileSync(target.fsPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    vscode.window.showInformationMessage(`Pacote salvo em ${target.fsPath}.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar ${target.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Lê o circuito interno do `.lssub.json` (`sourceId`) e monta a lista de componentes candidatos a
 * "expostos" -- alimenta o overlay de Modo Placa E o submenu por componente exposto do menu de
 * contexto (`main.ts::buildExposedComponentMenuItems`). "Exposto" é marcado/desmarcado DENTRO da
 * sessão "Abrir Subcircuito" (não daqui de fora) e persistido via "Salvar Subcircuito" -- esta
 * função só LÊ o que já foi salvo. Filtra `connectors.tunnel`/`connectors.junction` -- são fiação
 * interna, não "componentes" expostos úteis (mesmo critério de `m_graphical` do SimulIDE: só itens
 * com presença visual/funcional fazem sentido aqui). */
function gatherInternalComponentSnapshots(sourceId: string): InternalComponentSnapshot[] | undefined {
  if (!extensionContext) return undefined;
  const absoluteFilePath = resolveSourceFilePath(extensionContext, sourceId);
  if (!absoluteFilePath || !fileExists(absoluteFilePath)) return undefined;

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  const internal = extractInternalCircuit(json);
  return internal.components
    .filter((component) => component.typeId !== "connectors.tunnel" && component.typeId !== "connectors.junction")
    .map((component) => {
      const catalogEntry = schematicState.catalog.find((entry) => entry.typeId === component.typeId);
      return {
        id: component.id,
        typeId: component.typeId,
        label: component.id,
        graphical: catalogEntry?.graphical === true,
        exposed: component.exposed === true,
        boardVisual: component.boardVisual
          ? { x: component.boardVisual.x, y: component.boardVisual.y, rotation: component.boardVisual.rotation ?? 0, flipH: component.boardVisual.flipH, flipV: component.boardVisual.flipV }
          : undefined,
        properties: component.properties as Record<string, string | number | boolean>,
      };
    });
}

/** Dados pro overlay de Modo Placa no circuito principal E pro submenu por componente exposto do
 * menu de contexto -- pedido pela Webview ao renderizar qualquer instância de subcircuito (ver
 * `main.ts::ensureBoardOverlayData`) ou quando o catálogo muda. */
async function requestBoardOverlayDataCommand(componentId: string, sourceId: string): Promise<void> {
  if (!schematicPanel) return;
  const items = gatherInternalComponentSnapshots(sourceId);
  if (!items) return;
  schematicPanel.postMessage({ version: 1, type: "boardOverlayData", componentId, items });
}

/** Atualiza uma propriedade REAL de um componente interno exposto a partir do submenu externo do
 * subcircuito. Persiste no `.lssub.json` e, se a instância já estiver expandida no Core, tenta
 * aplicar em runtime também (mesmo mecanismo de `setSubcircuitChildProperty` usado pelo overlay de
 * Modo Placa). */
async function updateExposedComponentPropertyCommand(
  outerComponentId: string,
  sourceId: string | undefined,
  innerComponentId: string,
  name: string,
  value: string | number | boolean,
): Promise<void> {
  if (!extensionContext || !sourceId) return;
  const absoluteFilePath = resolveSourceFilePath(extensionContext, sourceId);
  if (!absoluteFilePath || !fileExists(absoluteFilePath)) return;

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (Array.isArray(json.components)) {
    json.components = json.components.map((entry) => {
      if (typeof entry !== "object" || entry === null) return entry;
      const component = entry as Record<string, unknown>;
      if (component.id !== innerComponentId) return component;
      const properties = typeof component.properties === "object" && component.properties !== null
        ? (component.properties as Record<string, unknown>)
        : {};
      return { ...component, properties: { ...properties, [name]: value } };
    });
  }

  try {
    fs.writeFileSync(absoluteFilePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  updateBoardOverlayPropertyCommand(outerComponentId, innerComponentId, name, value);
  await requestBoardOverlayDataCommand(outerComponentId, sourceId);
}

/** Arrastar um componente do overlay de Modo Placa direto no circuito principal -- grava
 * `boardVisual` em `components[]` do `.lssub.json` (`sourceId`), preservando `rotation`/`flipH`/
 * `flipV` já existentes (só `x`/`y` mudam; girar continua sendo coisa de "Abrir Subcircuito" por
 * enquanto). Edição cirúrgica, mesmo padrão de `updateExposedComponentsCommand`. */
async function updateBoardOverlayVisualCommand(sourceId: string, innerComponentId: string, x: number, y: number): Promise<void> {
  if (!extensionContext) return;
  const ctx = extensionContext;
  const absoluteFilePath = resolveSourceFilePath(ctx, sourceId);
  if (!absoluteFilePath || !fileExists(absoluteFilePath)) return;

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (Array.isArray(json.components)) {
    json.components = json.components.map((value) => {
      if (typeof value !== "object" || value === null) return value;
      const component = value as Record<string, unknown>;
      if (component.id !== innerComponentId) return component;
      const previousBoardVisual = typeof component.boardVisual === "object" && component.boardVisual !== null
        ? (component.boardVisual as Record<string, unknown>)
        : undefined;
      return {
        ...component,
        boardVisual: { x, y, rotation: previousBoardVisual?.rotation ?? 0, flipH: previousBoardVisual?.flipH, flipV: previousBoardVisual?.flipV },
      };
    });
  }

  try {
    fs.writeFileSync(absoluteFilePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await refreshUnifiedCatalogState(true);
}

function detectManifestKind(absoluteFilePath: string, json: Record<string, unknown>): RegisteredItemKind {
  const fileName = path.basename(absoluteFilePath).toLowerCase();
  if (fileName.endsWith(".lssub.json")) return "subcircuit-file";
  const hasChipId = typeof json.chipId === "string" && json.chipId.trim().length > 0;
  if (fileName === "mcu.json" || hasChipId) return "mcu-adapter";
  return "abi-device";
}

/** Comando "Editar Símbolo Visual"/"Abrir Subcircuito" (Épico G, parte de escrita) -- com
 * `item.sourceId`, edita o item JÁ registrado na paleta (botão "✎" em `palette.ts`, ou botão direito
 * numa instância já no circuito, `requestEditSymbol`); sem `sourceId` (botão da barra de título,
 * `lasecsimul.palette.editSymbol` sem argumento), abre um seletor de arquivo pra editar QUALQUER
 * `device.json`/`mcu.json`/`.lssub.json`, registrado ou não. Em todos os casos abre o MESMO webview
 * do esquemático (`openSchematicEditor`), só que numa sessão de autoria -- nunca um painel novo
 * (ver `.spec/lasecsimul-native-devices.spec` seção 21.3, `.spec/lasecsimul-subcircuits.spec`
 * seção 4). `view` escolhe qual aparência abrir ("logicSymbol" só existe pra `mcu-adapter`/
 * `subcircuit-file`, ver seção 21.3 -- ignorado silenciosamente pra `abi-device`, que não tem essa
 * variante). Subcircuito (`kind === "subcircuit-file"`) semeia TAMBÉM o circuito interno real
 * (`components[]`/`wires[]`) na MESMA sessão, junto com o `package` -- "Open Subcircuit" do
 * SimulIDE real mostra os dois juntos na mesma cena, não dois painéis separados. */
async function editPackageSymbolCommand(item?: { sourceId?: string; view?: "default" | "logicSymbol" }): Promise<void> {
  if (!extensionContext) return;
  const ctx = extensionContext;

  let absoluteFilePath: string | undefined;
  const sourceId = typeof item?.sourceId === "string" ? item.sourceId : undefined;
  if (sourceId) {
    const unifiedCatalog = loadUnifiedCatalog(ctx.extensionPath, currentLasecSimulLanguage());
    const source = unifiedCatalog.registeredSources.find((value) => value.id === sourceId);
    if (!source) {
      vscode.window.showWarningMessage("Item registrado não encontrado no catálogo.");
      return;
    }
    absoluteFilePath = normalizeAbsolutePath(ctx.extensionPath, source.filePath);
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { JSON: ["json"] },
      title: "Editar símbolo visual de um device.json/mcu.json/.lssub.json",
    });
    absoluteFilePath = picked?.[0]?.fsPath;
  }
  if (!absoluteFilePath) return;

  if (!fileExists(absoluteFilePath)) {
    vscode.window.showErrorMessage(`Arquivo não encontrado: ${absoluteFilePath}`);
    return;
  }

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(
      `Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const kind = detectManifestKind(absoluteFilePath, json);
  const typeIdKey = kind === "mcu-adapter" ? "chipId" : "typeId";
  const typeId = typeof json[typeIdKey] === "string" && String(json[typeIdKey]).trim() ? String(json[typeIdKey]).trim() : path.basename(absoluteFilePath);

  const view: "default" | "logicSymbol" = item?.view === "logicSymbol" && kind !== "abi-device" ? "logicSymbol" : "default";
  const packageKey = view === "logicSymbol" ? "logicSymbolPackage" : "package";
  let components = applySubcircuitInterfaceToPackageComponents(json, seedSymbolAuthoringComponents(extractPackageForEditing(json, packageKey)));
  let wires: WebviewWireModel[] = [];

  if (kind === "subcircuit-file") {
    const internal = extractInternalCircuit(json);
    const seededInternal = seedSubcircuitInternalComponents(internal.components, internal.wires);
    const componentsWithPins = seededInternal.components.map((component) => ({
      ...component,
      pins: pinsForInternalComponent(component.id, component.typeId, internal.wires),
    }));
    components = [...components, ...componentsWithPins];
    wires = seededInternal.wires;
  }

  if (!schematicPanel) openSchematicEditor(ctx.extensionUri);
  schematicPanel?.postMessage({
    version: 1,
    type: "enterSymbolAuthoring",
    filePath: absoluteFilePath,
    typeId,
    kind,
    view,
    components,
    wires,
  });
}

/** Handler de `requestSwitchSymbolView` (`messages.ts`) -- toggle "Ver: Físico/Símbolo Lógico" na
 * barra da sessão de autoria. Relê o `package`/`logicSymbolPackage` do disco (fresco, não confia no
 * que a Webview tinha) pra semear a NOVA vista, mas preserva o circuito interno EXATAMENTE como a
 * Webview mandou (`internalComponents`/`internalWires`, sessão atual em memória, não relido do
 * disco) -- trocar de vista nunca perde posição/propriedade de componente interno ainda não salvo,
 * só descarta o que foi editado no `package`/`logicSymbolPackage` da vista que está SAINDO (mesmo
 * aviso já mostrado na UI antes de mandar esta mensagem, ver `main.ts::toggleLogicSymbolView`). */
async function switchSymbolViewCommand(
  filePath: string,
  typeId: string,
  kind: RegisteredItemKind,
  toView: "default" | "logicSymbol",
  internalComponents: WebviewComponentModel[],
  internalWires: WebviewWireModel[]
): Promise<void> {
  if (!fileExists(filePath)) {
    vscode.window.showErrorMessage(`Arquivo não encontrado: ${filePath}`);
    return;
  }
  let json: Record<string, unknown>;
  try {
    json = readJsonFile(filePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível reler ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const packageKey = toView === "logicSymbol" ? "logicSymbolPackage" : "package";
  const packageComponents = applySubcircuitInterfaceToPackageComponents(json, seedSymbolAuthoringComponents(extractPackageForEditing(json, packageKey)));

  schematicPanel?.postMessage({
    version: 1,
    type: "enterSymbolAuthoring",
    filePath,
    typeId,
    kind,
    view: toView,
    components: [...packageComponents, ...internalComponents],
    wires: internalWires,
  });
}

/** `other.package_pin`'s `properties.internalTunnel` é o vínculo com o `connectors.tunnel` interno
 * (`properties.name`), igual a `interface[].internalTunnel` de sempre (ver
 * `subcircuits/esp32_devkitc_v4.lssub.json`) -- compilado aqui, não em `symbolAuthoring.ts`
 * (`compileSymbolAuthoringComponents` só sabe do `package`, nunca do circuito interno). Ordem de
 * `compiledPins` é GARANTIDA igual à de `pinComponents` (mesmo array `components`, mesmo filtro,
 * mesma ordem de iteração nos dois lugares). */
function compileSubcircuitInterface(
  components: WebviewComponentModel[],
  compiledPins: PackagePin[],
  existingInterfaceByPinId: Map<string, { label?: string; internalTunnel?: string }>
): Array<{ pinId: string; label: string; internalTunnel: string }> {
  const pinComponents = components.filter((component) => component.typeId === "other.package_pin");
  return compiledPins.map((pin, index) => ({
    pinId: pin.id,
    label: pin.label ?? pin.id,
    internalTunnel:
      (typeof pinComponents[index]?.properties.internalTunnel === "string" && (pinComponents[index]!.properties.internalTunnel as string).trim())
      || existingInterfaceByPinId.get(pin.id)?.internalTunnel
      || "",
  }));
}

/** Handler de `requestSaveSymbol` (`messages.ts`) -- relê o arquivo do disco (não confia no que a
 * Webview tinha em memória pras OUTRAS chaves, podem ter mudado por fora desde que a sessão de
 * autoria abriu), compila a sessão (`compileSymbolAuthoringComponents`) e substitui só a chave do
 * `package`/`logicSymbolPackage` (conforme `view`) — preservando tudo o mais. Pra subcircuito
 * (`kind === "subcircuit-file"`), TAMBÉM compila e grava `components[]`/`wires[]`/`interface[]`
 * reais (`compileSubcircuitInternalComponents`/`compileSubcircuitInterface`) -- mesmo arquivo que
 * um humano editaria à mão, nunca um formato/estado paralelo (ver `.spec/
 * lasecsimul-native-devices.spec` seção 21.3, `.spec/lasecsimul-subcircuits.spec` seção 4). Avisa
 * (sem bloquear o save) se algum `pinId` digitado num `other.package_pin` não bate com nenhum pino
 * elétrico conhecido (`knownPinIdsForManifest`, melhor-esforço -- vazio pra `mcu-adapter`, pinos
 * vêm do plugin em runtime). */
async function saveSymbolCommand(
  filePath: string,
  typeId: string,
  kind: RegisteredItemKind,
  view: "default" | "logicSymbol",
  components: WebviewComponentModel[],
  wires: WebviewWireModel[]
): Promise<void> {
  let json: Record<string, unknown>;
  try {
    json = readJsonFile(filePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível reler ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const packageKey = view === "logicSymbol" ? "logicSymbolPackage" : "package";
  const existingPackage = extractPackageForEditing(json, packageKey);
  const existingInterfaceByPinId = extractSubcircuitInterfaceMap(json);
  const existingBackground = existingPackage.background;
  const result = compileSymbolAuthoringComponents(components, existingBackground);
  if (!result.package) {
    vscode.window.showErrorMessage(result.error ?? "Não foi possível compilar o símbolo.");
    return;
  }

  const knownPinIds = knownPinIdsForManifest(json, kind);
  if (knownPinIds.length > 0) {
    const unknownIds = result.package.pins.map((pin) => pin.id).filter((id) => !knownPinIds.includes(id));
    if (unknownIds.length > 0) {
      vscode.window.showWarningMessage(`Pino(s) sem correspondência elétrica conhecida em "${typeId}": ${unknownIds.join(", ")}. Salvando assim mesmo.`);
    }
  }

  json[packageKey] = {
    ...result.package,
    ...(result.package.schematicWidth === undefined && existingPackage.schematicWidth !== undefined ? { schematicWidth: existingPackage.schematicWidth } : {}),
    ...(result.package.schematicHeight === undefined && existingPackage.schematicHeight !== undefined ? { schematicHeight: existingPackage.schematicHeight } : {}),
  };

  if (kind === "subcircuit-file") {
    const internal = compileSubcircuitInternalComponents(components, wires);
    json.components = internal.components.map((component) => ({ id: component.id, typeId: component.typeId, properties: component.properties, visual: component.visual, boardVisual: component.boardVisual, exposed: component.exposed }));
    json.wires = internal.wires.map((wire) => ({ from: wire.from, to: wire.to, points: wire.points }));
    json.interface = compileSubcircuitInterface(components, result.package.pins, existingInterfaceByPinId);
  }

  try {
    fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await refreshUnifiedCatalogState(true);
  vscode.window.showInformationMessage(`Símbolo visual de "${typeId}" salvo em ${filePath}.`);
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const unifiedCatalog = loadUnifiedCatalog(context.extensionPath, currentLasecSimulLanguage());
  const initialResolved = resolveRegisteredItems(context.extensionPath, unifiedCatalog.registeredSources);
  schematicState = createInitialWebviewState([
    ...unifiedCatalog.catalog,
    ...initialResolved.map((item) => item.entry),
  ]);
  schematicState.locale = currentLasecSimulLanguage();

  const corePath = resolveCoreExecutablePath(context.extensionPath);
  const pipeName = CoreProcess.defaultPipeName();

  coreProc = new CoreProcess({ executablePath: corePath, pipeName });
  coreProc.onError((err) => {
    vscode.window.showErrorMessage(
      `LasecSimul Core: não foi possível iniciar "${corePath}" (${err.message}). ` +
        `Compile o Core antes (npm run build:core) e confirme que o gerador usado coloca o binário ` +
        `em core/build/ ou core/build/<Config>/.`
    );
  });
  try {
    coreProc.start();
  } catch (err) {
    vscode.window.showErrorMessage(
      `LasecSimul Core: falha ao iniciar processo: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  coreProc.onExit((code) => {
    // RNF: Core caiu → reiniciar + restaurar snapshot (ver lasecsimul-native-devices.spec §12.5)
    vscode.window.showWarningMessage(`LasecSimul Core terminou (code ${code}). Reinicie a simulação.`);
    coreClient = undefined;
  });

  coreClient = new CoreClient(pipeName);
  // Conecta de forma assíncrona — não bloqueia a ativação da extensão
  coreClient
    .start()
    .then(() => refreshUnifiedCatalogState(true))
    .catch((err) => {
      vscode.window.showErrorMessage(
        `Falha ao conectar ao LasecSimul Core: ${err instanceof Error ? err.message : String(err)}`
      );
    });

  const addPaletteComponent = (typeId: string) => {
    if (!schematicPanel) openSchematicEditor(context.extensionUri);
    schematicPanel?.postMessage({ version: 1, type: "requestAddComponent", typeId });
  };

  paletteViewProvider = new ComponentPaletteViewProvider(
    context.extensionUri,
    schematicState.catalog,
    currentLasecSimulLanguage(),
    addPaletteComponent,
    (item) => removeRegisteredCatalogItemCommand(item),
    (item) => editPackageSymbolCommand(item)
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("lasecsimul.componentPalette", paletteViewProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("lasecsimul.language")) return;
      schematicState = { ...schematicState, locale: currentLasecSimulLanguage() };
      paletteViewProvider?.setLanguage(currentLasecSimulLanguage());
      void refreshUnifiedCatalogState(Boolean(coreClient));
      syncSchematicPanel();
    }),
    vscode.commands.registerCommand("lasecsimul.openSchematicEditor", () => openSchematicEditor(context.extensionUri)),
    vscode.commands.registerCommand("lasecsimul.newSubcircuit", () => {}),
    vscode.commands.registerCommand("lasecsimul.openSettings", () => {}),
    vscode.commands.registerCommand("lasecsimul.palette.addComponent", (typeId: string) => addPaletteComponent(typeId)),
    vscode.commands.registerCommand("lasecsimul.run", () => runSimulation()),
    vscode.commands.registerCommand("lasecsimul.pause", () => pauseSimulation()),
    vscode.commands.registerCommand("lasecsimul.stop", () => stopSimulation()),
    vscode.commands.registerCommand("lasecsimul.saveProject", () => saveProjectCommand()),
    vscode.commands.registerCommand("lasecsimul.openProject", () => openProjectCommand(context)),
    vscode.commands.registerCommand("lasecsimul.palette.registerFile", () => registerCatalogFileCommand()),
    vscode.commands.registerCommand("lasecsimul.palette.removeRegistered", (item: { sourceId?: string }) =>
      removeRegisteredCatalogItemCommand(item)
    ),
    vscode.commands.registerCommand("lasecsimul.palette.editSymbol", (item?: { sourceId?: string }) =>
      editPackageSymbolCommand(item)
    ),
    // Keybinding em contributes.keybindings ("when": activeWebviewPanelId == 'lasecsimul.schematic')
    // sobrepõe Ctrl+R/Ctrl+Shift+R do VSCode SÓ enquanto o painel do esquemático está em foco --
    // fora dele, o `when` deixa de casar e o atalho nativo do VSCode volta a funcionar sozinho, sem
    // nenhuma lógica de restauração aqui (ver `.spec/lasecsimul.spec` seção 13.4).
    vscode.commands.registerCommand("lasecsimul.rotateSelectionCw", () => {
      schematicPanel?.postMessage({ version: 1, type: "requestRotateSelection", direction: "cw" });
    }),
    vscode.commands.registerCommand("lasecsimul.rotateSelectionCcw", () => {
      schematicPanel?.postMessage({ version: 1, type: "requestRotateSelection", direction: "ccw" });
    }),
    vscode.commands.registerCommand("lasecsimul.flipSelectionHorizontal", () => {
      schematicPanel?.postMessage({ version: 1, type: "requestFlipSelection", axis: "horizontal" });
    }),
    vscode.commands.registerCommand("lasecsimul.flipSelectionVertical", () => {
      schematicPanel?.postMessage({ version: 1, type: "requestFlipSelection", axis: "vertical" });
    }),
  );

  void setSchematicOpenContext(false);
  void refreshUnifiedCatalogState(false);
}

export async function deactivate(): Promise<void> {
  closeAllMcuSerialMonitors();
  stopVoltageReadoutPolling();
  await coreClient?.stop().catch(() => {});
  coreProc?.kill(); // force-kill de segurança caso shutdown IPC não tenha chegado
}

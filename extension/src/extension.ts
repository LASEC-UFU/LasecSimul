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
import { SimulationStatus, WebviewToHostMessage } from "./ui/webview/messages";
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
import { PropertySchemaDto } from "./ipc/types";
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
    border: typeof raw.border === "boolean" ? raw.border : undefined,
    background,
    shapes,
    pins,
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

function inferLsconfigPath(manifestPath: string): string | undefined {
  const direct = path.join(path.dirname(manifestPath), "device.lsconfig");
  if (fileExists(direct)) return direct;
  const sibling = `${manifestPath}.lsconfig`;
  return fileExists(sibling) ? sibling : undefined;
}

function readDeviceLsconfig(source: RegisteredSource, extensionPath: string): { absolutePath?: string; config?: DeviceLsconfig } {
  const resolvedPath = source.lsconfigPath
    ? normalizeAbsolutePath(extensionPath, source.lsconfigPath)
    : inferLsconfigPath(normalizeAbsolutePath(extensionPath, source.filePath));
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
      const folderPath = resolveFolderPath({
        ...source,
        folderPath: Array.isArray(lsconfig?.folderPath) && lsconfig.folderPath.length > 0 ? lsconfig.folderPath : source.folderPath,
      }, localizedRegisteredFolder(source.kind, language));
      const category = folderPath[0] ?? localizedRegisteredRoot(language);
      const subcategory = folderPath.length > 1 ? folderPath[1] : undefined;
      const libraryPath = source.kind === "mcu-adapter"
        ? undefined
        : (source.libraryPath
          ? normalizeAbsolutePath(extensionPath, source.libraryPath)
          : inferLibraryPathForDevice(absoluteFilePath));
      const iconFilePath = typeof lsconfig?.iconPath === "string" && lsconfig.iconPath.trim()
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
        icon: lsconfig?.icon,
        iconFilePath,
        symbolSvg: lsconfig?.symbolSvg,
        package: packageDescriptor,
        logicSymbolPackage,
        disabled: false,
        isRegistered: true,
        registeredSourceId: source.id,
        registeredSourceRemovable: source.removable !== false,
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
    const folderPath = resolveFolderPath({
      ...source,
      folderPath: Array.isArray(lsconfig?.folderPath) && lsconfig.folderPath.length > 0 ? lsconfig.folderPath : source.folderPath,
    }, localizedRegisteredFolder("subcircuit-file", language));
    const category = folderPath[0] ?? localizedRegisteredRoot(language);
    const subcategory = folderPath.length > 1 ? folderPath[1] : undefined;
    const libraryPath = source.libraryPath
      ? normalizeAbsolutePath(extensionPath, source.libraryPath)
      : inferLibraryPathForSubcircuit(absoluteFilePath);
    const iconFilePath = typeof lsconfig?.iconPath === "string" && lsconfig.iconPath.trim()
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
      icon: lsconfig?.icon,
      iconFilePath,
      symbolSvg: lsconfig?.symbolSvg,
      package: packageDescriptor,
      logicSymbolPackage,
      disabled: false,
      isRegistered: true,
      registeredSourceId: source.id,
      registeredSourceRemovable: source.removable !== false,
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
    .then((instanceId) => coreInstanceIdByComponentId.set(componentId, instanceId))
    .catch((err) => reportCoreWarning(`criar "${typeId}"`, err));
}

function pushWireToCore(wire: WebviewWireModel): void {
  if (!coreClient) return;
  const coreA = coreInstanceIdByComponentId.get(wire.from.componentId);
  const coreB = coreInstanceIdByComponentId.get(wire.to.componentId);
  if (!coreA || !coreB) return; // um dos lados não existe no Core ainda (typeId não suportado)
  coreClient.connectWire(coreA, wire.from.pinId, coreB, wire.to.pinId).catch((err) => reportCoreWarning("conectar fio", err));
}

function pushPropertyToCore(componentId: string, name: string, value: string | number | boolean): void {
  if (!coreClient) return;
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
}

let voltageReadoutTimer: ReturnType<typeof setInterval> | undefined;

/** Lê o estado de cada "instruments.voltmeter" no projeto e manda pra Webview — único instrumento
 * com leitura via Webview hoje (ver .spec/lasecsimul.spec sobre instrumentos como plugin ABI).
 * Generaliza naturalmente pra outros: basta interpretar getComponentState() conforme o typeId. */
async function pollInstrumentReadouts(): Promise<void> {
  if (!coreClient || !schematicPanel) return;
  const voltmeters = schematicState.components.filter((component) => component.typeId === "instruments.voltmeter");
  if (voltmeters.length === 0) return;

  const readoutsByComponentId: Record<string, number> = {};
  for (const component of voltmeters) {
    const coreId = coreInstanceIdByComponentId.get(component.id);
    if (!coreId) continue;
    try {
      const state = await coreClient.getComponentState(coreId);
      if (state.length >= 8) readoutsByComponentId[component.id] = state.readDoubleLE(0);
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

  for (const component of schematicState.components) {
    if (!shouldSyncComponentToCore(component.typeId)) continue;
    try {
      const instanceId = await coreClient.addComponent(
        component.typeId,
        component.properties,
        pinsForTypeId(component.typeId)
      );
      coreInstanceIdByComponentId.set(component.id, instanceId);
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
  for (const component of project.components) {
    if (!shouldSyncComponentToCore(component.typeId)) continue;
    try {
      const instanceId = await coreClient.addComponent(
        component.typeId,
        component.properties,
        pinsForTypeId(component.typeId)
      );
      coreInstanceIdByComponentId.set(component.id, instanceId);
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
    case "requestRemoveComponent": {
      pushRemoveToCore(message.componentId);
      coreInstanceIdByComponentId.delete(message.componentId);
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
    case "requestSwitchSymbolView":
      void switchSymbolViewCommand(message.filePath, message.typeId, message.kind, message.toView, message.internalComponents, message.internalWires);
      return;
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
  const registeredEntries = resolved.map((item) => {
    const failedReason = item.libraryPathToLoad
      ? failures.get(normalizeAbsolutePath(extensionContext!.extensionPath, item.libraryPathToLoad))
      : undefined;
    if (failedReason) {
      return {
        ...item.entry,
        disabled: true,
        disabledReason: localizedAbiFailure(failedReason, currentLasecSimulLanguage()),
      };
    }
    if (baseTypeIds.has(item.entry.typeId)) {
      return {
        ...item.entry,
        disabled: true,
        disabledReason: localizedBaseCatalogConflict(currentLasecSimulLanguage()),
      };
    }
    return item.entry;
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
  let schemasByTypeId: Record<string, PropertySchemaDto[]>;
  try {
    schemasByTypeId = await coreClient.getPropertySchemas(currentLasecSimulLanguage());
  } catch {
    return catalog; // Core ainda não respondeu -- catálogo sem schema, inferência cobre o resto
  }
  return mergePropertySchemas(catalog, schemasByTypeId);
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
        border: typeof candidate.border === "boolean" ? candidate.border : undefined,
        background: typeof candidate.background === "object" && candidate.background !== null
          ? (candidate.background as PackageDescriptor["background"])
          : undefined,
        shapes: Array.isArray(candidate.shapes) ? (candidate.shapes as PackageShape[]) : [],
        pins: Array.isArray(candidate.pins) ? (candidate.pins as PackagePin[]) : [],
      };
    }
  }
  return { width: 80, height: 60, border: true, shapes: [], pins: [] };
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
  let components = seedSymbolAuthoringComponents(extractPackageForEditing(json, packageKey));
  let wires: WebviewWireModel[] = [];

  if (kind === "subcircuit-file") {
    const internal = extractInternalCircuit(json);
    const seededInternal = seedSubcircuitInternalComponents(internal.components, internal.wires);
    const componentsWithPins = seededInternal.components.map((component) => ({ ...component, pins: pinsForTypeId(component.typeId) }));
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
  const packageComponents = seedSymbolAuthoringComponents(extractPackageForEditing(json, packageKey));

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
function compileSubcircuitInterface(components: WebviewComponentModel[], compiledPins: PackagePin[]): Array<{ pinId: string; label: string; internalTunnel: string }> {
  const pinComponents = components.filter((component) => component.typeId === "other.package_pin");
  return compiledPins.map((pin, index) => ({
    pinId: pin.id,
    label: pin.label ?? pin.id,
    internalTunnel: typeof pinComponents[index]?.properties.internalTunnel === "string" ? (pinComponents[index]!.properties.internalTunnel as string) : "",
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
  const existingBackground = extractPackageForEditing(json, packageKey).background;
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

  json[packageKey] = result.package;

  if (kind === "subcircuit-file") {
    const internal = compileSubcircuitInternalComponents(components, wires);
    json.components = internal.components.map((component) => ({ id: component.id, typeId: component.typeId, properties: component.properties, visual: component.visual, boardVisual: component.boardVisual }));
    json.wires = internal.wires.map((wire) => ({ from: wire.from, to: wire.to, points: wire.points }));
    json.interface = compileSubcircuitInterface(components, result.package.pins);
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
  stopVoltageReadoutPolling();
  await coreClient?.stop().catch(() => {});
  coreProc?.kill(); // force-kill de segurança caso shutdown IPC não tenha chegado
}

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { currentLasecSimulLanguage } from "../currentLanguage";
import { fileExists, normalizeAbsolutePath, readJsonFile } from "../pathUtils";
import { state } from "../state";
import { extractSimulideSubcircuitScene, translateSimulideSubcircuitAuthoringScene } from "../catalog/simulideSceneTranslator";
import {
  compileSubcircuitInternalComponents,
  compileSymbolAuthoringComponents,
  InternalComponentSeed,
  InternalWireSeed,
  seedSubcircuitInternalComponents,
  seedSymbolAuthoringComponents,
  VisualPosition,
} from "../catalog/symbolAuthoring";
import { loadUnifiedCatalog } from "../catalog/UnifiedCatalog";
import { sanitizePackage } from "../catalog/packageSanitizers";
import { RegisteredItemKind, knownPinIdsForManifest } from "../catalog/registeredSources";
import { componentLocalOrigin } from "../ui/webview/componentSymbols";
import { InternalComponentSnapshot } from "../ui/webview/messages";
import {
  JUNCTION_TYPE_ID,
  PackageDescriptor,
  PackagePin,
  TUNNEL_TYPE_ID,
  WebviewComponentModel,
  WebviewWireModel,
} from "../ui/webview/model";

export interface SymbolCommandOptions {
  openSchematicEditor: (extensionUri: vscode.Uri) => void;
  pinsForInternalComponent: (componentId: string, typeId: string, wires: InternalWireSeed[]) => Array<{ id: string; x: number; y: number }>;
  refreshUnifiedCatalogState: (loadLibrariesInCore: boolean) => Promise<void>;
}

function extractPackageForEditing(json: Record<string, unknown>, key: "package" | "logicSymbolPackage" = "package", assetBasePath?: string): PackageDescriptor {
  const sanitized = sanitizePackage(json[key], assetBasePath);
  if (sanitized) return sanitized;
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
      .filter((component) => component.typeId === TUNNEL_TYPE_ID)
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
    return { ...component, properties: { ...component.properties, internalTunnel: inferredTunnel } };
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
      label: typeof value.label === "string" && value.label.trim() ? value.label : undefined,
      showId: typeof value.showId === "boolean" ? value.showId : undefined,
      showValue: typeof value.showValue === "boolean" ? value.showValue : undefined,
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

export function resolveSourceFilePath(sourceId: string): string | undefined {
  if (!state.extensionContext) return undefined;
  const unifiedCatalog = loadUnifiedCatalog(state.extensionContext.extensionPath, currentLasecSimulLanguage());
  const source = unifiedCatalog.registeredSources.find((value) => value.id === sourceId);
  if (!source) {
    vscode.window.showWarningMessage("Item registrado não encontrado no catálogo.");
    return undefined;
  }
  return normalizeAbsolutePath(state.extensionContext.extensionPath, source.filePath);
}

export async function loadPackageCommand(sourceId: string, options: SymbolCommandOptions): Promise<void> {
  await editPackageSymbolCommand({ sourceId }, options);
}

export async function savePackageCommand(sourceId: string): Promise<void> {
  if (!state.extensionContext) return;
  const absoluteFilePath = resolveSourceFilePath(sourceId);
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

export function gatherInternalComponentSnapshots(sourceId: string): InternalComponentSnapshot[] | undefined {
  const absoluteFilePath = resolveSourceFilePath(sourceId);
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
    .filter((component) => component.typeId !== TUNNEL_TYPE_ID && component.typeId !== JUNCTION_TYPE_ID)
    .map((component) => {
      const catalogEntry = state.schematicState.catalog.find((entry) => entry.typeId === component.typeId);
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

function detectManifestKind(absoluteFilePath: string, json: Record<string, unknown>): RegisteredItemKind {
  const fileName = path.basename(absoluteFilePath).toLowerCase();
  if (fileName.endsWith(".lssubcircuit")) return "subcircuit-file";
  const hasChipId = typeof json.chipId === "string" && json.chipId.trim().length > 0;
  if (fileName === "mcu.lsdevice" || hasChipId) return "mcu-adapter";
  return "abi-device";
}

export async function editPackageSymbolCommand(
  item: { sourceId?: string; view?: "default" | "logicSymbol" } | undefined,
  options: SymbolCommandOptions
): Promise<void> {
  if (!state.extensionContext) return;
  const ctx = state.extensionContext;

  let absoluteFilePath: string | undefined;
  const sourceId = typeof item?.sourceId === "string" ? item.sourceId : undefined;
  if (sourceId) {
    absoluteFilePath = resolveSourceFilePath(sourceId);
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "LasecSimul": ["lsdevice", "lssubcircuit"] },
      title: "Editar símbolo visual de um .lsdevice/.lssubcircuit",
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
  const packageComponents = applySubcircuitInterfaceToPackageComponents(
    json,
    seedSymbolAuthoringComponents(extractPackageForEditing(json, packageKey, path.dirname(absoluteFilePath)), kind === "subcircuit-file" ? 0 : 140, kind === "subcircuit-file" ? 0 : 140)
  );
  let components = packageComponents;
  let wires: WebviewWireModel[] = [];

  if (kind === "subcircuit-file") {
    const internal = extractInternalCircuit(json);
    const seededInternal = seedSubcircuitInternalComponents(internal.components, internal.wires);
    const componentsWithPins = seededInternal.components.map((component) => ({
      ...component,
      pins: options.pinsForInternalComponent(component.id, component.typeId, internal.wires),
    }));
    const translated = translateSimulideSubcircuitAuthoringScene(packageComponents, componentsWithPins, seededInternal.wires, extractSimulideSubcircuitScene(json));
    components = translated.components;
    wires = translated.wires;
  }

  if (!state.schematicPanel) options.openSchematicEditor(ctx.extensionUri);
  state.schematicPanel?.postMessage({
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

export async function switchSymbolViewCommand(
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
  const seededPackageComponents = applySubcircuitInterfaceToPackageComponents(
    json,
    seedSymbolAuthoringComponents(extractPackageForEditing(json, packageKey, path.dirname(filePath)), kind === "subcircuit-file" ? 0 : 140, kind === "subcircuit-file" ? 0 : 140)
  );
  const packageComponents = kind === "subcircuit-file"
    ? translateSimulideSubcircuitAuthoringScene(seededPackageComponents, internalComponents, internalWires, extractSimulideSubcircuitScene(json)).components.slice(0, seededPackageComponents.length)
    : seededPackageComponents;

  state.schematicPanel?.postMessage({
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

function isSymbolAuthoringSceneComponent(typeId: string): boolean {
  return typeId === "other.package" || typeId === "other.package_pin" || typeId.startsWith("graphics.");
}

function serializeSubcircuitSceneComponent(component: WebviewComponentModel): {
  componentId: string;
  x: number;
  y: number;
  rotation?: WebviewComponentModel["rotation"];
  flipH?: boolean;
  flipV?: boolean;
  properties?: Record<string, string | number | boolean>;
} {
  const localOrigin = componentLocalOrigin(component.typeId, component.properties);
  const sceneProperties: Record<string, string | number | boolean> = {};
  const qtOrigin = component.properties.__simulideQtOrigin;
  const scaleX = component.properties.__simulideSceneScaleX;
  const scaleY = component.properties.__simulideSceneScaleY;
  if (qtOrigin === true || Boolean(localOrigin)) sceneProperties.__simulideQtOrigin = true;
  if (typeof scaleX === "number" && Number.isFinite(scaleX) && scaleX > 0) sceneProperties.__simulideSceneScaleX = scaleX;
  if (typeof scaleY === "number" && Number.isFinite(scaleY) && scaleY > 0) sceneProperties.__simulideSceneScaleY = scaleY;
  const placement = {
    componentId: component.id,
    x: Math.round(component.x + (localOrigin?.x ?? 0)),
    y: Math.round(component.y + (localOrigin?.y ?? 0)),
    ...(component.rotation !== undefined ? { rotation: component.rotation } : {}),
    ...(Object.keys(sceneProperties).length > 0 ? { properties: sceneProperties } : {}),
  };
  if (component.typeId === TUNNEL_TYPE_ID) {
    const rotated = component.properties.__simulideTunnelRotated;
    if (typeof rotated === "boolean") {
      if (!placement.properties) placement.properties = {};
      placement.properties.__simulideTunnelRotated = rotated;
      return { ...placement, flipH: rotated };
    }
    return placement;
  }
  return {
    ...placement,
    ...(typeof component.flipH === "boolean" ? { flipH: component.flipH } : {}),
    ...(typeof component.flipV === "boolean" ? { flipV: component.flipV } : {}),
  };
}

function serializeSubcircuitSceneWire(wire: WebviewWireModel): {
  from: { componentId: string; pinId: string };
  to: { componentId: string; pinId: string };
  points: Array<{ x: number; y: number }>;
} | undefined {
  if (!wire.points || wire.points.length === 0) return undefined;
  return {
    from: wire.from,
    to: wire.to,
    points: wire.points.map((point) => ({ x: point.x, y: point.y })),
  };
}

function persistSubcircuitAuthoringScene(json: Record<string, unknown>, components: WebviewComponentModel[], wires: WebviewWireModel[]): void {
  const packageComponent = components.find((component) => component.typeId === "other.package");
  if (!packageComponent) return;
  const internalComponents = components
    .filter((component) => !isSymbolAuthoringSceneComponent(component.typeId))
    .map(serializeSubcircuitSceneComponent);
  const internalWires = wires.map(serializeSubcircuitSceneWire).filter((wire): wire is NonNullable<typeof wire> => Boolean(wire));
  const existing = typeof json.authoringScene === "object" && json.authoringScene !== null
    ? json.authoringScene as Record<string, unknown>
    : {};
  const { transform: _legacyTransform, ...existingWithoutTransform } = existing;
  json.authoringScene = {
    ...existingWithoutTransform,
    package: { x: packageComponent.x, y: packageComponent.y },
    components: internalComponents,
    wires: internalWires,
  };
}

export async function saveSymbolCommand(
  filePath: string,
  typeId: string,
  kind: RegisteredItemKind,
  view: "default" | "logicSymbol",
  components: WebviewComponentModel[],
  wires: WebviewWireModel[],
  options: SymbolCommandOptions
): Promise<void> {
  let json: Record<string, unknown>;
  try {
    json = readJsonFile(filePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível reler ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const packageKey = view === "logicSymbol" ? "logicSymbolPackage" : "package";
  const existingPackage = extractPackageForEditing(json, packageKey, path.dirname(filePath));
  const existingInterfaceByPinId = extractSubcircuitInterfaceMap(json);
  const existingBackground = existingPackage.background;
  const result = compileSymbolAuthoringComponents(components, existingBackground, existingPackage);
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
    ...(existingPackage.initialTransform !== undefined ? { initialTransform: existingPackage.initialTransform } : {}),
    ...(existingPackage.pinMarker !== undefined ? { pinMarker: existingPackage.pinMarker } : {}),
    ...(existingPackage.simulidePaint !== undefined ? { simulidePaint: existingPackage.simulidePaint } : {}),
    ...(existingPackage.qtWidget !== undefined ? { qtWidget: existingPackage.qtWidget } : {}),
    ...(existingPackage.viewSpec !== undefined ? { viewSpec: existingPackage.viewSpec } : {}),
    ...(existingPackage.valueLabel !== undefined ? { valueLabel: existingPackage.valueLabel } : {}),
  };

  if (kind === "subcircuit-file") {
    const internal = compileSubcircuitInternalComponents(components, wires);
    persistSubcircuitAuthoringScene(json, components, wires);
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
  await options.refreshUnifiedCatalogState(true);
  vscode.window.showInformationMessage(`Símbolo visual de "${typeId}" salvo em ${filePath}.`);
}

import * as path from "path";
import * as vscode from "vscode";
import { hasShowOnSymbolProperty } from "../catalog/catalogMerge";
import { parseSubcircuitManifest } from "../catalog/registeredSources";
import { currentLasecSimulLanguage } from "../currentLanguage";
import { fileExists, normalizeAbsolutePath, readJsonFile } from "../pathUtils";
import { state, projectSerializer } from "../state";
import { rebuildCoreFromSchematicState, pinsForProjectComponent } from "../core/coreLifecycle";
import { JUNCTION_TYPE_ID, WebviewComponentCatalogEntry, WebviewComponentModel, WebviewProjectState, WebviewWireModel } from "../ui/webview/model";
import { ProjectComponent, ProjectDocument, createEmptyProject } from "./ProjectTypes";

export function absoluteSubcircuitRefPath(refPath: string): string {
  if (path.isAbsolute(refPath)) return path.normalize(refPath);
  const baseDir = state.currentProjectFilePath ? path.dirname(state.currentProjectFilePath) : process.cwd();
  return path.resolve(baseDir, refPath);
}

function projectWithRelativeSubcircuitRefs(project: ProjectDocument, targetProjectPath: string): ProjectDocument {
  const targetDir = path.dirname(targetProjectPath);
  return {
    ...project,
    components: project.components.map((component) => {
      if (!component.subcircuitRef?.path) return component;
      const absolutePath = absoluteSubcircuitRefPath(component.subcircuitRef.path);
      const relativePath = path.relative(targetDir, absolutePath);
      const portablePath = relativePath && !path.isAbsolute(relativePath) ? relativePath : absolutePath;
      return {
        ...component,
        subcircuitRef: {
          ...component.subcircuitRef,
          path: portablePath,
        },
      };
    }),
  };
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
    subcircuitRef: component.subcircuitRef,
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
  const catalog = state.schematicState.catalog;
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
      label: component.label ?? descriptor?.label ?? component.typeId,
      hidden: component.typeId === JUNCTION_TYPE_ID ? true : (descriptor?.hidden ?? false),
      showId: component.showId,
      showValue: component.showValue ?? hasShowOnSymbolProperty(descriptor),
      flipH: component.flipH,
      flipV: component.flipV,
      x: component.visual?.x ?? 0,
      y: component.visual?.y ?? 0,
      rotation: component.visual?.rotation ?? 0,
      pins: pinsForProjectComponent(component),
      properties: component.properties as Record<string, string | number | boolean>,
      subcircuitRef: component.subcircuitRef,
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

async function resolveProjectSubcircuitReferences(projectDir: string): Promise<void> {
  const componentsWithRef = state.schematicState.components.filter((component) => component.subcircuitRef);
  if (componentsWithRef.length === 0) return;

  const language = currentLasecSimulLanguage();
  const newCatalogEntries: WebviewComponentCatalogEntry[] = [];
  const updatedComponents = new Map<string, WebviewComponentModel>();
  let missingCount = 0;

  for (const component of componentsWithRef) {
    const ref = component.subcircuitRef!;
    const absolutePath = normalizeAbsolutePath(projectDir, ref.path);
    if (!fileExists(absolutePath) || !state.coreClient) {
      missingCount++;
      continue;
    }

    try {
      await state.coreClient.registerAdhocSubcircuitDefinition(absolutePath);
    } catch {
      missingCount++;
      continue;
    }
    const parsed = parseSubcircuitManifest(
      readJsonFile(absolutePath) as Record<string, unknown>,
      path.dirname(absolutePath),
      language,
      new Set(state.schematicState.catalog.filter((entry) => entry.registeredSourceKind === "mcu-adapter").map((entry) => entry.typeId))
    );
    if (!parsed.typeId) {
      missingCount++;
      continue;
    }

    const newPinIds = parsed.pinIds.length > 0 ? parsed.pinIds : Array.from({ length: parsed.pinCount }, (_, index) => `pin-${index + 1}`);
    const label = parsed.label || parsed.typeId;
    newCatalogEntries.push({
      typeId: parsed.typeId,
      label,
      category: "Subcircuitos",
      hidden: true,
      pinCount: parsed.pinCount,
      pinIds: parsed.pinIds.length > 0 ? parsed.pinIds : undefined,
      defaultProperties: parsed.defaultProperties,
      icon: parsed.icon,
      iconFilePath: parsed.iconFilePath,
      iconSvgInline: parsed.iconSvgInline,
      package: parsed.package,
      logicSymbolPackage: parsed.logicSymbolPackage,
      disabled: false,
      mcuHost: parsed.mcuHost,
      serialPorts: parsed.serialPorts,
    });
    updatedComponents.set(component.id, {
      ...component,
      typeId: parsed.typeId,
      pins: newPinIds.map((id, index) => ({ id, x: 0, y: index * 12 })),
      subcircuitRef: { path: ref.path, lastKnownTypeId: parsed.typeId, lastKnownPinIds: newPinIds },
    });
  }

  if (newCatalogEntries.length > 0 || updatedComponents.size > 0) {
    const catalogTypeIds = new Set(newCatalogEntries.map((entry) => entry.typeId));
    state.schematicState = {
      ...state.schematicState,
      catalog: [...state.schematicState.catalog.filter((entry) => !catalogTypeIds.has(entry.typeId)), ...newCatalogEntries],
      components: state.schematicState.components.map((component) => updatedComponents.get(component.id) ?? component),
    };
  }

  if (missingCount > 0) {
    vscode.window.showWarningMessage(
      `${missingCount} subcircuito(s) não encontrado(s). Clique com o botão direito no bloco para localizar o arquivo.`
    );
  }
}

export async function saveProjectCommand(): Promise<void> {
  const uri = await vscode.window.showSaveDialog({ filters: { "LasecSimul Project": ["lsproj"] } });
  if (!uri) return;
  const project: ProjectDocument = projectWithRelativeSubcircuitRefs({
    ...createEmptyProject(),
    components: state.schematicState.components.map(webviewComponentToProjectComponent),
    wires: state.schematicState.wires.map((wire) => ({ id: wire.id, from: wire.from, to: wire.to })),
    visual: {
      wires: state.schematicState.wires
        .filter((wire) => wire.points && wire.points.length > 0)
        .map((wire) => ({ id: wire.id, points: wire.points })),
      viewport: state.schematicState.viewport,
    },
  }, uri.fsPath);
  await projectSerializer.save(uri.fsPath, project);
  state.currentProjectFilePath = uri.fsPath;
  vscode.window.showInformationMessage(`Projeto LasecSimul salvo em ${uri.fsPath}`);
}

export async function openProjectCommand(options: {
  extensionUri: vscode.Uri;
  beforeOpen?: () => void;
  openSchematicEditor: (extensionUri: vscode.Uri) => void;
  syncSchematicPanel: () => void;
}): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    filters: { "LasecSimul Project": ["lsproj"] },
    canSelectMany: false,
  });
  const selected = uris?.[0];
  if (!selected) return;
  options.beforeOpen?.();
  const project = await projectSerializer.load(selected.fsPath);
  state.currentProjectFilePath = selected.fsPath;
  state.schematicState = projectToWebviewState(project);
  await resolveProjectSubcircuitReferences(path.dirname(selected.fsPath));
  if (!state.schematicPanel) options.openSchematicEditor(options.extensionUri);
  options.syncSchematicPanel();
  await rebuildCoreFromSchematicState();
}

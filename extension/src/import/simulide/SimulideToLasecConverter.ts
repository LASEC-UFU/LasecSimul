import type { WebviewComponentCatalogEntry } from "../../ui/webview/model";
import {
  LS_PROJ_SCHEMA_VERSION,
  ProjectComponent,
  ProjectDocument,
  ProjectTopologyEndpoint,
  createEmptyProject,
} from "../../project/ProjectTypes";
import {
  resolveSimulideCatalogEntry,
  resolveSimulidePinId,
  splitSimulideEndpoint,
} from "./SimulideComponentMapper";
import {
  normalizeSimulideRotation,
  parseSimulidePoint,
  parseSimulidePosition,
  projectRotationForSimulide,
  simulideBoolean,
  simulideFlipEnabled,
  simulideLabelSceneRotation,
  simulideLocalPointToSceneDelta,
} from "./SimulideGeometry";
import { mapSimulideProperties } from "./SimulidePropertyMapper";
import {
  SimulideCircuitDocument,
  SimulideComponentRecord,
  SimulideConversionResult,
  SimulideImportReport,
} from "./SimulideTypes";

/**
 * TypeId deliberadamente sem implementação no Core. `coreLifecycle.ts::shouldSyncComponentToCore`
 * nunca envia esta instância ao Core, e o fallback genérico de `componentSymbols.ts` já desenha
 * qualquer typeId sem símbolo dedicado como um retângulo com leads -- não precisamos de um case
 * dedicado para ver o placeholder no esquemático.
 */
export const SIMULIDE_UNRESOLVED_TYPE_ID = "import.simulide.unresolved";

interface ComponentPlan {
  source: SimulideComponentRecord;
  component: ProjectComponent;
  catalogEntry?: WebviewComponentCatalogEntry;
  rawPinToProjectPin: Map<string, string>;
  placeholder: boolean;
}

function makeReport(document: SimulideCircuitDocument): SimulideImportReport {
  return {
    componentCount: document.components.length,
    convertedComponentCount: 0,
    fullyConvertedComponentCount: 0,
    partiallyConvertedComponentCount: 0,
    placeholderComponentCount: 0,
    nodeCount: document.nodes.length,
    connectorCount: document.connectors.length,
    convertedConnectorCount: 0,
    orphanEndpointCount: 0,
    issues: [...document.parseIssues],
  };
}

function ownerIds(document: SimulideCircuitDocument): string[] {
  return [
    ...document.components.map((component) => component.circId),
    ...document.nodes.map((node) => node.circId),
  ];
}

/** Pinos efetivamente referenciados pelos connectors. Isso é suficiente para preservar a topologia. */
function connectedLocalPins(
  document: SimulideCircuitDocument,
  sourceId: string,
  owners: readonly string[]
): string[] {
  const out = new Set<string>();
  for (const connector of document.connectors) {
    for (const endpoint of [connector.startPinId, connector.endPinId]) {
      const split = splitSimulideEndpoint(endpoint, owners);
      if (split?.ownerId === sourceId && split.localPinId) out.add(split.localPinId);
    }
  }
  return [...out];
}

function preserveRawAttributes(source: SimulideComponentRecord): Record<string, string | number | boolean> {
  const properties: Record<string, string | number | boolean> = {
    __ui_simulideUnsupported: true,
    __ui_simulideSourceType: source.itemType,
    __ui_simulideSourceId: source.circId,
    __ui_simulideRawAttributes: JSON.stringify(source.attributes),
  };
  if (source.mainCompProps) {
    properties.__ui_simulideMainCompProps = JSON.stringify(source.mainCompProps.attributes);
    const program = source.mainCompProps.attributes.Program?.trim();
    if (program) properties.__ui_simulideProgram = program;
  }
  return properties;
}

function placeholderComponent(
  source: SimulideComponentRecord,
  rawPinIds: readonly string[],
  suggestedEntry?: WebviewComponentCatalogEntry,
  suggestedProperties?: Record<string, string | number | boolean>
): ProjectComponent {
  const position = parseSimulidePosition(source.attributes);
  const rotation = normalizeSimulideRotation(source.attributes.rotation ?? source.attributes.Angle);
  const properties = preserveRawAttributes(source);
  properties.__ui_simulidePinIds = JSON.stringify(rawPinIds);
  if (suggestedEntry) properties.__ui_simulideSuggestedTypeId = suggestedEntry.typeId;
  if (suggestedProperties) properties.__ui_simulideSuggestedProperties = JSON.stringify(suggestedProperties);

  return {
    id: source.circId,
    typeId: SIMULIDE_UNRESOLVED_TYPE_ID,
    properties,
    label: source.attributes.label || source.circId,
    showId: true,
    showValue: false,
    flipH: simulideFlipEnabled(source.attributes.hflip),
    flipV: simulideFlipEnabled(source.attributes.vflip),
    visual: { x: position.x, y: position.y, rotation: rotation.rotation },
  };
}

function applySimulideLabelLayout(
  component: ProjectComponent,
  source: SimulideComponentRecord,
  report: SimulideImportReport
): void {
  const apply = (
    pointRaw: string | undefined,
    rotationRaw: string | undefined,
    prefix: "id" | "value"
  ) => {
    const point = parseSimulidePoint(pointRaw);
    if (point) {
      const scene = simulideLocalPointToSceneDelta(point, source.attributes);
      component.properties[`__ui_${prefix}LabelX`] = scene.x;
      component.properties[`__ui_${prefix}LabelY`] = scene.y;
    }
    if (rotationRaw !== undefined) {
      const rotation = simulideLabelSceneRotation(source.attributes, rotationRaw);
      component.properties[`__ui_${prefix}LabelRotation`] = rotation.rotation;
      if (rotation.rounded) {
        report.issues.push({
          severity: "warning",
          code: "label-rotation-rounded",
          message: `Rotação visual do rótulo ${prefix} (${rotation.original}°) arredondada para ${rotation.rotation}°`,
          sourceId: source.circId,
          sourceType: source.itemType,
          lineNumber: source.lineNumber,
        });
      }
    }
  };

  apply(source.attributes.idLabPos, source.attributes.labelrot, "id");
  apply(source.attributes.valLabPos, source.attributes.valLabRot, "value");
}

function applyRecognizedSubcircuitMetadata(
  component: ProjectComponent,
  source: SimulideComponentRecord
): void {
  if (component.typeId !== "subcircuits.esp32_devkitc_v4") return;
  const program = source.mainCompProps?.attributes.Program?.trim();
  if (program) component.properties.__ui_simulideProgram = program;
  const mainCompId = source.mainCompProps?.attributes.MainCompId?.trim();
  if (mainCompId) component.properties.__ui_simulideMainCompId = mainCompId;
}

function buildComponentPlan(
  source: SimulideComponentRecord,
  document: SimulideCircuitDocument,
  catalog: readonly WebviewComponentCatalogEntry[],
  owners: readonly string[],
  report: SimulideImportReport
): ComponentPlan {
  const rawPins = connectedLocalPins(document, source.circId, owners);
  const catalogEntry = resolveSimulideCatalogEntry(source.itemType, catalog, source);

  if (!catalogEntry) {
    const component = placeholderComponent(source, rawPins);
    applySimulideLabelLayout(component, source, report);
    report.placeholderComponentCount += 1;
    report.convertedComponentCount += 1;
    report.issues.push({
      severity: "warning",
      code: normalizeType(source.itemType) === "subcircuit" ? "unsupported-subcircuit" : "unsupported-component",
      message: `Sem equivalente no LasecSimul; preservado como placeholder: ${source.attributes.label || source.circId} (${source.itemType})`,
      sourceId: source.circId,
      sourceType: source.itemType,
      lineNumber: source.lineNumber,
    });
    return {
      source,
      component,
      rawPinToProjectPin: new Map(rawPins.map((pin) => [pin, pin])),
      placeholder: true,
    };
  }

  const mapped = mapSimulideProperties(catalogEntry, source.attributes, source.circId, source.lineNumber);
  report.issues.push(...mapped.issues);
  const rawPinToProjectPin = new Map<string, string>();
  const unresolvedPins: string[] = [];
  for (const rawPin of rawPins) {
    const canonical = resolveSimulidePinId(catalogEntry, rawPin);
    if (canonical) rawPinToProjectPin.set(rawPin, canonical);
    else unresolvedPins.push(rawPin);
  }

  // Pino conectado sem equivalente é estruturalmente mais importante do que manter o typeId ativo.
  // Rebaixamos SOMENTE este componente a placeholder, preservando todos os fios e também a sugestão
  // de conversão completa para o usuário/agente finalizar depois.
  if (unresolvedPins.length > 0) {
    const component = placeholderComponent(source, rawPins, catalogEntry, mapped.properties);
    applySimulideLabelLayout(component, source, report);
    report.placeholderComponentCount += 1;
    report.partiallyConvertedComponentCount += 1;
    report.convertedComponentCount += 1;
    report.issues.push({
      severity: "warning",
      code: "partial-component",
      message: `Componente conhecido (${catalogEntry.typeId}), mas com pino(s) sem alias: ${unresolvedPins.join(", ")}. Preservado como placeholder para não perder topologia.`,
      sourceId: source.circId,
      sourceType: source.itemType,
      lineNumber: source.lineNumber,
    });
    return {
      source,
      component,
      catalogEntry,
      rawPinToProjectPin: new Map(rawPins.map((pin) => [pin, pin])),
      placeholder: true,
    };
  }

  const position = parseSimulidePosition(source.attributes);
  const rotation = projectRotationForSimulide(source.attributes, catalogEntry);
  if (rotation.rounded) {
    report.issues.push({
      severity: "warning",
      code: "rotation-rounded",
      message: `Rotação de instância ${rotation.original}° arredondada para ${rotation.rotation}°`,
      sourceId: source.circId,
      sourceType: source.itemType,
      lineNumber: source.lineNumber,
    });
  }

  const component: ProjectComponent = {
    id: source.circId,
    typeId: catalogEntry.typeId,
    properties: mapped.properties,
    label: source.attributes.label || source.circId,
    showId: simulideBoolean(source.attributes.Show_id),
    showValue: simulideBoolean(source.attributes.Show_Val),
    valueLabelPropertyKey: mapped.valueLabelPropertyKey,
    flipH: simulideFlipEnabled(source.attributes.hflip),
    flipV: simulideFlipEnabled(source.attributes.vflip),
    visual: { x: position.x, y: position.y, rotation: rotation.rotation },
  };

  applySimulideLabelLayout(component, source, report);
  applyRecognizedSubcircuitMetadata(component, source);
  report.fullyConvertedComponentCount += 1;
  report.convertedComponentCount += 1;
  return { source, component, catalogEntry, rawPinToProjectPin, placeholder: false };
}

function normalizeType(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function syntheticNodeId(uid: string, side: "from" | "to", usedNodeIds: Set<string>): string {
  const base = `__simulide_orphan_${uid.replace(/[^A-Za-z0-9_.-]+/g, "_")}_${side}`;
  let id = base;
  let index = 2;
  while (usedNodeIds.has(id)) id = `${base}_${index++}`;
  usedNodeIds.add(id);
  return id;
}

function uniqueConductorId(raw: string, usedIds: Set<string>): { id: string; renamed: boolean } {
  if (!usedIds.has(raw)) {
    usedIds.add(raw);
    return { id: raw, renamed: false };
  }
  let index = 2;
  let candidate = `${raw}.imported-${index}`;
  while (usedIds.has(candidate)) candidate = `${raw}.imported-${++index}`;
  usedIds.add(candidate);
  return { id: candidate, renamed: true };
}

/**
 * Converte SimulIDE para ProjectDocument usando política BEST-EFFORT.
 *
 * Regra: componente/pino sem equivalente NUNCA cancela a conversão inteira. O componente vira
 * `import.simulide.unresolved`, seus pinos conectados e atributos são preservados e todos os fios
 * continuam no documento. Somente arquivo realmente ilegível (sem a tag `<circuit>`) impede o
 * workflow -- ver `SimulideParser.ts` para os demais casos (CircId duplicado/ausente etc.), que
 * viram warning + recuperação em vez de exceção.
 */
export function convertSimulideDocument(
  document: SimulideCircuitDocument,
  catalog: readonly WebviewComponentCatalogEntry[]
): SimulideConversionResult {
  const report = makeReport(document);
  const owners = ownerIds(document);
  const plans = new Map<string, ComponentPlan>();
  const components: ProjectComponent[] = [];

  for (const source of document.components) {
    const plan = buildComponentPlan(source, document, catalog, owners, report);
    plans.set(source.circId, plan);
    components.push(plan.component);
  }

  const nodes: ProjectDocument["topology"]["nodes"] = document.nodes.map((node) => ({
    id: node.circId,
    position: parseSimulidePosition(node.attributes),
  }));
  const usedNodeIds = new Set(nodes.map((node) => node.id));
  const nodeSourceIds = new Set(document.nodes.map((node) => node.circId));

  const resolveEndpoint = (
    fullPinId: string,
    point: { x: number; y: number } | undefined,
    uid: string,
    side: "from" | "to",
    lineNumber: number
  ): ProjectTopologyEndpoint => {
    const split = splitSimulideEndpoint(fullPinId, owners);
    if (split && nodeSourceIds.has(split.ownerId)) return { kind: "node", nodeId: split.ownerId };

    if (split) {
      const plan = plans.get(split.ownerId);
      if (plan) {
        const pinId = plan.placeholder
          ? split.localPinId || "pin-1"
          : plan.rawPinToProjectPin.get(split.localPinId);
        if (pinId) return { kind: "port", componentId: plan.component.id, pinId };
      }
    }

    // Última rede de segurança: não descartar o fio. Criamos um nó sintético na posição geométrica
    // da extremidade e deixamos warning explícito. Assim até circuitos parcialmente corrompidos
    // continuam visualmente recuperáveis no .lsproj.
    const orphanId = syntheticNodeId(uid, side, usedNodeIds);
    nodes.push({ id: orphanId, position: point ?? { x: 0, y: 0 } });
    report.orphanEndpointCount += 1;
    report.issues.push({
      severity: "warning",
      code: "orphan-endpoint-preserved",
      message: `Endpoint ${fullPinId} não pôde ser associado ao owner/pino original; fio preservado em nó sintético ${orphanId}.`,
      lineNumber,
    });
    return { kind: "node", nodeId: orphanId };
  };

  const conductors: ProjectDocument["topology"]["conductors"] = [];
  const usedConductorIds = new Set<string>();
  for (const connector of document.connectors) {
    const unique = uniqueConductorId(connector.uid, usedConductorIds);
    if (unique.renamed) {
      report.issues.push({
        severity: "warning",
        code: "duplicate-conductor-id",
        message: `uid de Connector duplicado (${connector.uid}); preservado como ${unique.id}.`,
        sourceId: connector.uid,
        sourceType: "Connector",
        lineNumber: connector.lineNumber,
      });
    }

    const from = resolveEndpoint(connector.startPinId, connector.points[0], unique.id, "from", connector.lineNumber);
    const to = resolveEndpoint(
      connector.endPinId,
      connector.points.length > 0 ? connector.points[connector.points.length - 1] : undefined,
      unique.id,
      "to",
      connector.lineNumber
    );
    const vertices = connector.points.length >= 2 ? connector.points.slice(1, -1) : [];
    conductors.push({ id: unique.id, from, to, vertices });
    report.convertedConnectorCount += 1;
  }

  const project = createEmptyProject();
  project.schemaVersion = LS_PROJ_SCHEMA_VERSION;
  project.components = components;
  project.wires = [];
  project.topology = { revision: 0, nodes, conductors };
  project.visual = { wires: [], viewport: { x: 0, y: 0, zoom: 1 } };

  // SimulIDE trabalha em picosegundos (Simulator::m_stepSize). Um stepSize fixo é representado no
  // LasecSimul como passo inicial/mínimo/máximo iguais e adaptiveTimeStep=false.
  const stepSeconds = document.settings.stepSize !== undefined
    ? document.settings.stepSize * 1e-12
    : undefined;
  const timeScale = document.settings.stepSize !== undefined && document.settings.stepsPerSecond !== undefined
    ? (document.settings.stepSize * document.settings.stepsPerSecond) / 1e12
    : undefined;
  project.simulationSettings = {
    ...(stepSeconds !== undefined ? {
      initialStepSeconds: stepSeconds,
      minimumStepSeconds: stepSeconds,
      maximumStepSeconds: stepSeconds,
      adaptiveTimeStep: false,
    } : {}),
    ...(timeScale !== undefined ? { timeScale } : {}),
    ...(document.settings.maxNonLinearSteps !== undefined
      ? { maximumNewtonIterations: document.settings.maxNonLinearSteps }
      : {}),
  };

  return { project, report };
}

/**
 * Migração automática de documentos (`.lsproj`, `.lssubcircuit`, manifestos embutidos) dos blocos
 * legados `control.*` para a biblioteca equivalente ao Simulink (docs/66-69). Determinística (mesma
 * entrada -> mesma saída, ids derivados dos ids legados) e idempotente (um documento já migrado não
 * tem mais tipos legados conversíveis: a segunda passada não muda nada). Pura: não lê nem grava
 * arquivo -- quem chama decide backup e gravação (`migrationFiles.ts`).
 *
 * Por diagrama (lista de componentes + topologia):
 *  - conversão `single`/`inline`: o bloco que publica a saída mantém o id legado (rótulo, posição,
 *    bindings de HMI/Lab por id continuam valendo); portas remapeadas nos condutores;
 *  - conversão `subsystem`: o componente vira instância de um subsistema interno com as MESMAS portas
 *    legadas; a definição (uma por estrutura) entra na tabela `subsystems` do arquivo;
 *  - `rename`/`keep`/`unsupported`: troca de typeId, nada, ou relatório (o bloco fica como estava).
 * Propriedades por instância (`@filho.prop`) sobre filhos convertidos são remapeadas a partir das
 * propriedades legadas do filho (definição do próprio arquivo ou o instantâneo da biblioteca).
 */
import { buildGenericSubcircuitPackage } from "../../ui/webview/genericSubcircuitPackage";
import { CompositeDefinition, Conversion, convertLegacyBlock, Endpoint } from "./conversions";
import { LEGACY_CONTROL_TYPE_IDS, LegacyProperties } from "./legacyBlocks";

export const CONTROL_MIGRATION_ID = "control-library-simulink";
export const CONTROL_MIGRATION_VERSION = 1;

type Json = Record<string, unknown>;

export interface MigrationEntry {
  /** "" = diagrama principal; `subsystems/<typeId>`; `embedded/<componentId>`. */
  location: string;
  componentId: string;
  legacyTypeId: string;
  kind: Conversion["kind"];
  rule: string;
  newTypeIds: string[];
  reason?: string;
}

export interface OverrideRemap {
  location: string;
  instanceId: string;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
  warning?: string;
}

export interface ControlMigrationReport {
  migrationId: typeof CONTROL_MIGRATION_ID;
  version: number;
  changed: boolean;
  entries: MigrationEntry[];
  definitionsAdded: string[];
  overrides: OverrideRemap[];
  warnings: string[];
}

/** Filho legado exportado de um subcircuito de biblioteca, como estava ANTES da migração
 * (`legacyLibraryExports.json`): permite remapear `@filho.prop` de projetos antigos. */
export interface LegacyChildSnapshot {
  typeId: string;
  properties: LegacyProperties;
}
export type LegacyLibrarySnapshot = Readonly<Record<string, Readonly<Record<string, LegacyChildSnapshot>>>>;

export interface MigrationOptions {
  /** typeId do subcircuito -> filhos legados (para instâncias de subcircuitos de biblioteca). */
  librarySnapshot?: LegacyLibrarySnapshot;
}

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isLegacy = (typeId: unknown): typeId is string => typeof typeId === "string" && LEGACY_CONTROL_TYPE_IDS.has(typeId);

/** O documento (ou algum manifesto aninhado) ainda tem bloco legado conversível? */
export function needsControlMigration(document: unknown): boolean {
  let found = false;
  const visit = (node: unknown) => {
    if (found) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isRecord(node)) return;
    if (isLegacy(node.typeId) && (node.id !== undefined || node.properties !== undefined)) {
      const conversion = convertLegacyBlock(String(node.id ?? ""), node.typeId, isRecord(node.properties) ? node.properties : {});
      if (conversion.kind !== "keep") { found = true; return; }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(document);
  return found;
}

// ------------------------------------------------------------------ definição de subsistema

const tunnelId = (side: "in" | "out", pinId: string) => `tunnel_${side}_${pinId}`;

function endpointOf(endpoint: Endpoint): { componentId: string; pinId: string } {
  if (endpoint.componentId.startsWith("in:")) return { componentId: tunnelId("in", endpoint.componentId.slice(3)), pinId: "value" };
  if (endpoint.componentId.startsWith("out:")) return { componentId: tunnelId("out", endpoint.componentId.slice(4)), pinId: "value" };
  return { componentId: endpoint.componentId, pinId: endpoint.port };
}

/** Manifesto (schemaVersion 3) do subsistema de conversão. */
export function compositeManifest(definition: CompositeDefinition): Json {
  const right = Math.max(200, ...definition.blocks.map((block) => block.x)) + 110;
  const components: Json[] = [
    ...definition.inputs.map((pin, index) => ({
      id: tunnelId("in", pin.pinId), typeId: "connectors.signal_tunnel",
      properties: { name: pin.pinId, pinId: pin.pinId, direction: "Input", valueType: "Real", defaultValue: 0 },
      visual: { x: 20, y: 60 + 60 * index, rotation: 0 },
    })),
    ...definition.blocks.map((block) => ({ id: block.id, typeId: block.typeId, properties: { ...block.properties }, visual: { x: block.x, y: block.y, rotation: 0 } })),
    ...definition.outputs.map((pin, index) => ({
      id: tunnelId("out", pin.pinId), typeId: "connectors.signal_tunnel",
      properties: { name: pin.pinId, pinId: pin.pinId, direction: "Output", valueType: "Real" },
      visual: { x: right, y: 60 + 60 * index, rotation: 180 },
    })),
  ];
  const interfaceEntries = [
    ...definition.inputs.map((pin) => ({ pinId: pin.pinId, label: pin.label, internalTunnel: pin.pinId, domain: "signal", direction: "in", valueType: "Real", width: 1 })),
    ...definition.outputs.map((pin) => ({ pinId: pin.pinId, label: pin.label, internalTunnel: pin.pinId, domain: "signal", direction: "out", valueType: "Real", width: 1 })),
  ];
  return {
    schemaVersion: 3,
    typeId: definition.typeId,
    name: definition.name,
    language: "pt-BR",
    folderPath: ["Convertidos"],
    workspaceSection: "control",
    help: { description: `${definition.name}: composição de blocos da biblioteca equivalente ao Simulink gerada pela migração dos blocos legados (docs/68).` },
    components,
    topology: {
      revision: 0,
      nodes: [],
      conductors: definition.wires.map((wire, index) => ({
        id: `wire-${index + 1}`,
        from: { kind: "port", ...endpointOf(wire.from) },
        to: { kind: "port", ...endpointOf(wire.to) },
        vertices: [],
      })),
    },
    interface: interfaceEntries,
    symbolMode: "generic",
    symbol: buildGenericSubcircuitPackage(definition.name, interfaceEntries.map((entry) => ({ id: entry.pinId, label: entry.label }))),
    exposedComponents: [],
    exportedPropertyComponentIds: definition.blocks.filter((block) => (block.perInstance ?? []).length > 0).map((block) => block.id),
    origin: { kind: "migration", migrationId: CONTROL_MIGRATION_ID, version: CONTROL_MIGRATION_VERSION },
  };
}

// ------------------------------------------------------------------ diagrama

interface Diagram {
  components: Json[];
  topology?: Json;
  wires?: Json[];
}

interface MigrationContext {
  report: ControlMigrationReport;
  /** Tabela `subsystems` onde as definições de conversão entram (por arquivo). */
  table: Json[];
  options: MigrationOptions;
}

/** Ponta de condutor/fio no formato do documento: `{kind:"port", componentId, pinId}` ou `{componentId, pinId}`. */
function remapEndpoint(endpoint: unknown, ports: Map<string, { componentId: string; pinId: string }>): void {
  if (!isRecord(endpoint) || typeof endpoint.componentId !== "string" || typeof endpoint.pinId !== "string") return;
  if (endpoint.kind !== undefined && endpoint.kind !== "port") return;
  const mapped = ports.get(`${endpoint.componentId}\u0000${endpoint.pinId}`);
  if (!mapped) return;
  endpoint.componentId = mapped.componentId;
  endpoint.pinId = mapped.pinId;
}

function ensureDefinition(context: MigrationContext, definition: CompositeDefinition): string {
  const existing = context.table.find((entry) => entry.typeId === definition.typeId);
  if (!existing) {
    context.table.push(compositeManifest(definition));
    context.report.definitionsAdded.push(definition.typeId);
  }
  return definition.typeId;
}

function migrateDiagram(diagram: Diagram, location: string, context: MigrationContext): void {
  const ports = new Map<string, { componentId: string; pinId: string }>();
  const added: Json[] = [];
  const newConductors: Json[] = [];
  const replaced = new Set<string>();
  for (const component of diagram.components) {
    if (!isLegacy(component.typeId) || typeof component.id !== "string") continue;
    const id = component.id;
    const legacyTypeId = component.typeId;
    const properties = isRecord(component.properties) ? component.properties : {};
    const conversion = convertLegacyBlock(id, legacyTypeId, properties);
    const entry: MigrationEntry = { location, componentId: id, legacyTypeId, kind: conversion.kind, rule: conversion.rule, newTypeIds: [] };
    switch (conversion.kind) {
      case "keep":
        entry.reason = conversion.reason;
        break;
      case "unsupported":
        entry.reason = conversion.reason;
        context.report.warnings.push(`${location || "(principal)"}/${id}: ${legacyTypeId} sem conversao (${conversion.reason})`);
        break;
      case "rename":
        component.typeId = conversion.typeId;
        entry.newTypeIds = [conversion.typeId];
        break;
      case "subsystem": {
        const typeId = ensureDefinition(context, conversion.definition);
        const kept = Object.fromEntries(Object.entries(properties).filter(([key]) => key.startsWith("@")));
        component.typeId = typeId;
        component.properties = { ...kept, ...conversion.overrides };
        entry.newTypeIds = [typeId];
        break;
      }
      case "single":
      case "inline": {
        const primary = conversion.blocks.find((block) => block.id === id);
        if (!primary) throw new Error(`conversao ${conversion.rule} sem bloco primario para ${id}`);
        for (const [legacyPort, target] of Object.entries(conversion.inputs)) ports.set(`${id}\u0000${legacyPort}`, { componentId: target.componentId, pinId: target.port });
        for (const [legacyPort, target] of Object.entries(conversion.outputs)) ports.set(`${id}\u0000${legacyPort}`, { componentId: target.componentId, pinId: target.port });
        component.typeId = primary.typeId;
        component.properties = { ...primary.properties };
        const visual = isRecord(component.visual) ? component.visual : { x: 0, y: 0, rotation: 0 };
        const baseX = Number(visual.x ?? 0), baseY = Number(visual.y ?? 0);
        for (const block of conversion.blocks) {
          if (block.id === id) continue;
          added.push({ id: block.id, typeId: block.typeId, properties: { ...block.properties }, visual: { x: baseX + (block.dx ?? 0), y: baseY + (block.dy ?? 0), rotation: 0 } });
        }
        conversion.wires.forEach((wire, index) => newConductors.push({
          id: `${id}__w${index + 1}`,
          from: { kind: "port", componentId: wire.from.componentId, pinId: wire.from.port },
          to: { kind: "port", componentId: wire.to.componentId, pinId: wire.to.port },
          vertices: [],
        }));
        entry.newTypeIds = conversion.blocks.map((block) => block.typeId);
        replaced.add(id);
        break;
      }
    }
    context.report.entries.push(entry);
    if (conversion.kind !== "keep" && conversion.kind !== "unsupported") context.report.changed = true;
  }
  if (ports.size > 0) {
    const conductors = isRecord(diagram.topology) && Array.isArray(diagram.topology.conductors) ? (diagram.topology.conductors as Json[]) : [];
    for (const conductor of conductors) { remapEndpoint(conductor.from, ports); remapEndpoint(conductor.to, ports); }
    for (const wire of diagram.wires ?? []) { remapEndpoint(wire.from, ports); remapEndpoint(wire.to, ports); }
  }
  if (added.length > 0) diagram.components.push(...added);
  if (newConductors.length > 0) {
    if (isRecord(diagram.topology) && Array.isArray(diagram.topology.conductors)) (diagram.topology.conductors as Json[]).push(...newConductors);
    else if (Array.isArray(diagram.wires)) diagram.wires.push(...newConductors.map((wire) => ({ id: wire.id, from: { componentId: (wire.from as Json).componentId, pinId: (wire.from as Json).pinId }, to: { componentId: (wire.to as Json).componentId, pinId: (wire.to as Json).pinId } })));
    else diagram.topology = { revision: 0, nodes: [], conductors: newConductors };
  }
}

// ------------------------------------------------------------------ propriedades por instância

/** `@filho.prop` -> {filho, prop}. */
function parseOverride(key: string): { child: string; name: string } | undefined {
  if (!key.startsWith("@")) return undefined;
  const dot = key.indexOf(".", 1);
  if (dot <= 1 || dot === key.length - 1) return undefined;
  return { child: key.slice(1, dot), name: key.slice(dot + 1) };
}

/** Propriedades novas do filho convertido, no formato de `@filho.X` (ou `@filho.@neto.X`). */
function convertedOverrides(child: string, conversion: Conversion): Record<string, unknown> | undefined {
  switch (conversion.kind) {
    case "single":
    case "inline": {
      const result: Record<string, unknown> = {};
      for (const block of conversion.blocks) for (const [name, value] of Object.entries(block.properties)) result[`@${block.id}.${name}`] = value;
      return result;
    }
    case "subsystem":
      return Object.fromEntries(Object.entries(conversion.overrides).map(([key, value]) => [`@${child}.${key}`, value]));
    default:
      return undefined;
  }
}

function conversionShape(conversion: Conversion): string {
  switch (conversion.kind) {
    case "subsystem": return `subsystem:${conversion.definition.key}`;
    case "single":
    case "inline": return `${conversion.kind}:${JSON.stringify(conversion.blocks.map((block) => [block.id, block.typeId]))}`;
    default: return `${conversion.kind}:${conversion.rule}`;
  }
}

/** Remapeia `@filho.legado` de uma instância cujos filhos legados são conhecidos. */
function remapInstanceOverrides(component: Json, children: Readonly<Record<string, LegacyChildSnapshot>>, location: string, context: MigrationContext): void {
  if (!isRecord(component.properties)) return;
  const properties = component.properties;
  const byChild = new Map<string, Record<string, unknown>>();
  for (const [key, value] of Object.entries(properties)) {
    const parsed = parseOverride(key);
    if (!parsed || !children[parsed.child]) continue;
    // `@filho.@neto.x` ou chave já no formato novo: não é override legado.
    if (parsed.name.startsWith("@")) continue;
    const map = byChild.get(parsed.child) ?? {};
    map[parsed.name] = value;
    byChild.set(parsed.child, map);
  }
  for (const [child, legacyOverrides] of byChild) {
    const snapshot = children[child]!;
    const reference = convertLegacyBlock(child, snapshot.typeId, snapshot.properties);
    const merged = convertLegacyBlock(child, snapshot.typeId, { ...snapshot.properties, ...legacyOverrides });
    if (reference.kind === "keep" || reference.kind === "rename") continue;
    const from = Object.fromEntries(Object.keys(legacyOverrides).map((name) => [`@${child}.${name}`, properties[`@${child}.${name}`]]));
    // Só dá para expressar por instância quando a ESTRUTURA convertida é a mesma da definição (mesmos
    // blocos, ou o mesmo subsistema): ex. um integrador legado com K=1 na definição e K=2 na
    // instância viraria Integrator num caso e Gain+Integrator no outro.
    const next = conversionShape(reference) === conversionShape(merged) ? convertedOverrides(child, merged) : undefined;
    const remap: OverrideRemap = { location, instanceId: String(component.id ?? ""), from, to: next ?? {} };
    if (!next) {
      remap.warning = `os valores por instancia de '${child}' mudam a estrutura da conversao (${reference.rule} -> ${merged.rule}); mantidos como estavam`;
      context.report.warnings.push(`${location || "(principal)"}/${String(component.id)}: ${remap.warning}`);
      context.report.overrides.push(remap);
      continue;
    }
    for (const key of Object.keys(from)) delete properties[key];
    Object.assign(properties, next);
    context.report.overrides.push(remap);
    context.report.changed = true;
  }
}

/** Filhos legados (antes da migração) de cada definição interna do arquivo. */
function legacyChildrenOf(manifest: Json): Record<string, LegacyChildSnapshot> {
  const result: Record<string, LegacyChildSnapshot> = {};
  for (const component of Array.isArray(manifest.components) ? (manifest.components as Json[]) : []) {
    if (isLegacy(component.typeId) && typeof component.id === "string")
      result[component.id] = { typeId: component.typeId, properties: structuredClone(isRecord(component.properties) ? component.properties : {}) };
  }
  return result;
}

// ------------------------------------------------------------------ documento

function diagramOf(node: Json): Diagram | undefined {
  if (!Array.isArray(node.components)) return undefined;
  return node as unknown as Diagram;
}

/**
 * Migra um documento (`.lsproj` ou manifesto `.lssubcircuit`). Devolve uma CÓPIA migrada e o
 * relatório; o original não é tocado.
 */
export function migrateControlDocument(document: Json, options: MigrationOptions = {}): { document: Json; report: ControlMigrationReport } {
  const migrated = structuredClone(document);
  const report: ControlMigrationReport = { migrationId: CONTROL_MIGRATION_ID, version: CONTROL_MIGRATION_VERSION, changed: false, entries: [], definitionsAdded: [], overrides: [], warnings: [] };
  migrateManifestLike(migrated, "", { report, table: [], options });
  return { document: migrated, report };
}

function migrateManifestLike(root: Json, location: string, base: MigrationContext): void {
  const table: Json[] = Array.isArray(root.subsystems) ? (root.subsystems as Json[]) : [];
  const context: MigrationContext = { ...base, table };
  // Filhos legados das definições do arquivo, ANTES de migrá-las (para `@filho.prop` das instâncias).
  const definitionChildren = new Map<string, Record<string, LegacyChildSnapshot>>();
  for (const definition of table) if (typeof definition.typeId === "string") definitionChildren.set(definition.typeId, legacyChildrenOf(definition));

  const remapInstances = (diagram: Diagram, where: string) => {
    for (const component of diagram.components) {
      if (typeof component.typeId !== "string") continue;
      const children = definitionChildren.get(component.typeId) ?? base.options.librarySnapshot?.[component.typeId];
      if (children && Object.keys(children).length > 0) remapInstanceOverrides(component, children, where, context);
    }
  };

  // Manifestos embutidos (instantâneo de `.lssubcircuit` externo): cada um é um arquivo à parte.
  const embeddedOwners: Diagram[] = [];
  const main = diagramOf(root);
  if (main) embeddedOwners.push(main);
  for (const definition of table) { const diagram = diagramOf(definition); if (diagram) embeddedOwners.push(diagram); }
  for (const owner of embeddedOwners) {
    for (const component of owner.components) {
      const ref = isRecord(component.subcircuitRef) ? component.subcircuitRef : undefined;
      if (ref && isRecord(ref.embedded)) migrateManifestLike(ref.embedded, `${location}embedded/${String(component.id)}/`, base);
    }
  }

  const initialDefinitions = [...table];
  for (const definition of initialDefinitions) {
    const diagram = diagramOf(definition);
    if (!diagram) continue;
    const where = `${location}subsystems/${String(definition.typeId)}`;
    remapInstances(diagram, where);
    migrateDiagram(diagram, where, context);
  }
  if (main) {
    remapInstances(main, location);
    migrateDiagram(main, location, context);
  }
  if (context.table.length > 0) root.subsystems = context.table;
}

import { PackageDescriptor } from "../ui/webview/model";
import { ProjectComponent, ProjectTopology, ProjectTopologyEndpoint } from "../project/ProjectTypes";
import { sanitizePackage } from "./packageSanitizers";

/** Refatoração completa do editor de subcircuitos (Subcircuito/Símbolo/Ícone) -- substitui o modelo
 * anterior (`other.package`/`other.package_pin` como objetos ocultos dentro de `components[]`, ver
 * `subcircuitPackageAuthoring.ts`, removido) por um documento com seções canônicas separadas: cada
 * conceito (circuito interno, pinos externos, túneis, símbolo, componentes expostos, ícone) tem
 * exatamente UM lugar no arquivo, nunca um objeto especial "disfarçado" de componente de cena.
 *
 * RUPTURA DELIBERADA de compatibilidade (autorizada explicitamente): `schemaVersion` anterior (1)
 * nunca é aceito aqui -- um arquivo antigo é REJEITADO de forma controlada (`parseSubcircuitDocument`
 * devolve `{ok:false, reason}`), nunca parcialmente aberto. Sem migração automática nesta etapa. */
export const SUBCIRCUIT_SCHEMA_VERSION = 3 as const;

/** Espelha `manifest.interface[]` -- CONTRATO DO CORE, inalterado
 * (`CoreApplication.cpp::registerSubcircuitFromManifestRich`, `SubcircuitInterfaceDef`). `internalTunnel`
 * é sempre o NOME do túnel (identidade elétrica no Core, `Netlist::m_tunnelGroups`), 100%
 * MÁQUINA-DERIVADO de `pinId` a cada save (`subcircuitPinModel.ts::renameCanonicalTunnelName` força
 * todo túnel ligado a um pino a ter `properties.name === properties.pinId === pinId`) -- nunca
 * hand-authored, nunca parcialmente corrigido. */
export interface SubcircuitInterfaceEntry {
  pinId: string;
  label: string;
  internalTunnel: string;
}

/** Uma projeção visual de um componente interno REAL no Símbolo (substitui "Modo Placa"/`exposed`+
 * `boardX/Y/...` flat fields -- unifica os dois formatos incompatíveis encontrados nesta auditoria:
 * escrita aninhada em `writeSubcircuitEditingSessionBack` vs. leitura plana em
 * `subcircuitInternals.ts`/`mcuCommands.ts`, nenhuma das duas efetivamente sobrevivia a
 * reabrir a sessão). `componentId` referencia `components[].id` por identificador PERSISTENTE, nunca
 * por índice -- nunca uma cópia independente do componente, só apresentação. Estado funcional
 * continua pertencendo exclusivamente ao componente interno real. */
export interface ExposedComponentEntry {
  componentId: string;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  scale: number;
  layer: number;
}

/** Documento completo, já validado/tipado, de um `.lssubcircuit` schemaVersion 3. Cada seção é a
 * ÚNICA fonte de verdade do conceito que representa -- nunca duplicada em outro lugar do arquivo ou
 * do catálogo. `symbol`/`icon` reaproveitam `PackageDescriptor` (mesmo tipo usado por QUALQUER
 * `.lsdevice` do catálogo, ver `model.ts`) -- não é um tipo novo, só a mesma estrutura declarativa já
 * madura, servindo como o "símbolo" e o "ícone" respectivamente. */
export interface SubcircuitDocument {
  schemaVersion: typeof SUBCIRCUIT_SCHEMA_VERSION;
  typeId: string;
  name: string;
  language?: string;
  translations?: Record<string, { name?: string }>;
  serialPorts?: Array<{ label: string; usartIndex: 0 | 1 | 2 }>;
  folderPath?: string[];
  icon?: PackageDescriptor;
  /** Metadados de catálogo -- passam intocados (o Core/paleta já entendem esses campos hoje,
   * inalterados por esta refatoração). */
  defaultProperties?: Record<string, unknown>;
  propertySchema?: unknown[];
  help?: { description?: string };

  /** Circuito interno (Modo Subcircuito) -- MESMO formato de sempre. */
  components: ProjectComponent[];
  topology: ProjectTopology;

  /** Contrato do Core, re-derivado a cada save -- ver doc de `SubcircuitInterfaceEntry`. */
  interface: SubcircuitInterfaceEntry[];

  /** Símbolo (Modo Símbolo) -- corpo + pinos externos (`symbol.pins[].id` é o pinId, ver
   * `model.ts::PackagePin`). Ausente == subcircuito ainda sem símbolo autorado (nenhum pino externo
   * também, nesse caso). */
  symbol?: PackageDescriptor;

  /** Componentes expostos (Modo Símbolo, absorve "Modo Placa"). */
  exposedComponents: ExposedComponentEntry[];
}

export type ParseSubcircuitDocumentResult =
  | { ok: true; document: SubcircuitDocument }
  | { ok: false; reason: string };

/** Mensagem de rejeição EXATA usada em todos os pontos de entrada (editor, catálogo, bloco genérico
 * de subcircuito por caminho) -- nunca abre parcialmente um arquivo de versão antiga. */
export function schemaVersionRejectionMessage(foundVersion: unknown): string {
  return `Este subcircuito usa uma versão de formato antiga (schemaVersion ${JSON.stringify(foundVersion)}) e precisa ser convertido para o novo modelo (schemaVersion ${SUBCIRCUIT_SCHEMA_VERSION}).`;
}

function parseInterfaceEntry(raw: unknown): SubcircuitInterfaceEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const entry = raw as Record<string, unknown>;
  const pinId = typeof entry.pinId === "string" ? entry.pinId.trim() : "";
  if (!pinId) return undefined;
  return {
    pinId,
    label: typeof entry.label === "string" ? entry.label : pinId,
    internalTunnel: typeof entry.internalTunnel === "string" ? entry.internalTunnel : pinId,
  };
}

function parseExposedComponentEntry(raw: unknown): ExposedComponentEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const entry = raw as Record<string, unknown>;
  const componentId = typeof entry.componentId === "string" ? entry.componentId.trim() : "";
  if (!componentId) return undefined;
  const rotation = entry.rotation === 90 || entry.rotation === 180 || entry.rotation === 270 ? entry.rotation : 0;
  return {
    componentId,
    x: typeof entry.x === "number" ? entry.x : 0,
    y: typeof entry.y === "number" ? entry.y : 0,
    rotation,
    flipH: entry.flipH === true,
    flipV: entry.flipV === true,
    scale: typeof entry.scale === "number" && entry.scale > 0 ? entry.scale : 1,
    layer: typeof entry.layer === "number" ? entry.layer : 0,
  };
}

/** `.lssubcircuit` grava os pontos de dobra de cada condutor sob a chave `points` (convenção histórica
 * do formato, distinta de `.lsproj`, que usa `vertices` -- Core nunca lê nenhuma das duas, é só
 * geometria visual). `ProjectTopology.conductors[].vertices` é o nome de campo CANÔNICO usado pelo
 * resto do código (`openSubcircuitForEditingCommand`, `wireTopology.ts`, etc.) -- sem esta conversão
 * explícita, um cast direto do JSON cru deixava `.vertices` sempre `undefined` (bug real: `.length`
 * de `undefined` derrubava "Abrir Subcircuito" com qualquer arquivo real). */
function parseTopologyConductor(raw: unknown): ProjectTopology["conductors"][number] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!id || typeof entry.from !== "object" || entry.from === null || typeof entry.to !== "object" || entry.to === null) return undefined;
  const rawVertices = Array.isArray(entry.points) ? entry.points : Array.isArray(entry.vertices) ? entry.vertices : [];
  const vertices = rawVertices.filter(
    (point): point is { x: number; y: number } =>
      typeof point === "object" && point !== null && typeof (point as { x?: unknown }).x === "number" && typeof (point as { y?: unknown }).y === "number"
  );
  return { id, from: entry.from as ProjectTopologyEndpoint, to: entry.to as ProjectTopologyEndpoint, vertices };
}

function parseTopology(raw: unknown): ProjectTopology {
  if (typeof raw !== "object" || raw === null) return { revision: 0, nodes: [], conductors: [] };
  const topology = raw as Record<string, unknown>;
  return {
    revision: typeof topology.revision === "number" ? topology.revision : 0,
    nodes: Array.isArray(topology.nodes) ? (topology.nodes as ProjectTopology["nodes"]) : [],
    conductors: Array.isArray(topology.conductors)
      ? topology.conductors.map(parseTopologyConductor).filter((conductor): conductor is ProjectTopology["conductors"][number] => conductor !== undefined)
      : [],
  };
}

/** Parseia/valida um `.lssubcircuit` cru -- `schemaVersion !== 3` é rejeitado IMEDIATAMENTE, antes de
 * qualquer outro campo ser lido (nunca um caminho de abertura parcial). Chamado por
 * `openSubcircuitForEditingCommand`/`registeredSources.ts` -- mesmo ponto único de verdade pra
 * "este arquivo é aceitável". Nunca lança exceção. */
export function parseSubcircuitDocument(raw: unknown, manifestDir: string): ParseSubcircuitDocumentResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "Documento inválido -- esperado um objeto JSON." };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== SUBCIRCUIT_SCHEMA_VERSION) {
    return { ok: false, reason: schemaVersionRejectionMessage(obj.schemaVersion) };
  }
  const typeId = typeof obj.typeId === "string" ? obj.typeId.trim() : "";
  if (!typeId) return { ok: false, reason: "Documento sem typeId." };

  const document: SubcircuitDocument = {
    schemaVersion: SUBCIRCUIT_SCHEMA_VERSION,
    typeId,
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name : typeId,
    language: typeof obj.language === "string" ? obj.language : undefined,
    translations: typeof obj.translations === "object" && obj.translations !== null ? (obj.translations as Record<string, { name?: string }>) : undefined,
    serialPorts: Array.isArray(obj.serialPorts) ? (obj.serialPorts as SubcircuitDocument["serialPorts"]) : undefined,
    folderPath: Array.isArray(obj.folderPath) ? (obj.folderPath as string[]) : undefined,
    defaultProperties: typeof obj.defaultProperties === "object" && obj.defaultProperties !== null ? (obj.defaultProperties as Record<string, unknown>) : undefined,
    propertySchema: Array.isArray(obj.propertySchema) ? (obj.propertySchema as unknown[]) : undefined,
    help: typeof obj.help === "object" && obj.help !== null ? (obj.help as { description?: string }) : undefined,
    components: Array.isArray(obj.components) ? (obj.components as ProjectComponent[]) : [],
    topology: parseTopology(obj.topology),
    interface: Array.isArray(obj.interface)
      ? (obj.interface as unknown[]).map(parseInterfaceEntry).filter((entry): entry is SubcircuitInterfaceEntry => entry !== undefined)
      : [],
    symbol: sanitizePackage(obj.symbol, manifestDir),
    icon: sanitizePackage(obj.icon, manifestDir),
    exposedComponents: Array.isArray(obj.exposedComponents)
      ? (obj.exposedComponents as unknown[]).map(parseExposedComponentEntry).filter((entry): entry is ExposedComponentEntry => entry !== undefined)
      : [],
  };
  return { ok: true, document };
}

/** Serializa de volta pro shape de arquivo -- determinístico (mesma ordem de chaves sempre),
 * independente de qualquer ordem circunstancial de array de entrada (quem monta `document` decide a
 * ordem dos arrays; esta função só not tenta reordenar sozinha -- ordem de array É significativa pra
 * `exposedComponents[].layer`/`symbol.shapes[]` z-order, nunca normalizada aqui). */
export function serializeSubcircuitDocument(document: SubcircuitDocument): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    schemaVersion: document.schemaVersion,
    typeId: document.typeId,
    name: document.name,
    ...(document.language ? { language: document.language } : {}),
    ...(document.translations ? { translations: document.translations } : {}),
    ...(document.serialPorts ? { serialPorts: document.serialPorts } : {}),
    components: document.components,
    topology: {
      revision: document.topology.revision,
      nodes: document.topology.nodes,
      // `points`, não `vertices` -- convenção de arquivo do `.lssubcircuit` (ver `parseTopologyConductor`).
      conductors: document.topology.conductors.map(({ id, from, to, vertices }) => ({ id, from, to, points: vertices })),
    },
    interface: document.interface,
    ...(document.symbol ? { symbol: document.symbol } : {}),
    exposedComponents: document.exposedComponents,
    ...(document.icon ? { icon: document.icon } : {}),
    ...(document.folderPath ? { folderPath: document.folderPath } : {}),
    ...(document.defaultProperties ? { defaultProperties: document.defaultProperties } : {}),
    ...(document.propertySchema ? { propertySchema: document.propertySchema } : {}),
    ...(document.help ? { help: document.help } : {}),
  };
  return raw;
}

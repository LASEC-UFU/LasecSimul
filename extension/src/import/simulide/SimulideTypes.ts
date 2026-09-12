import type { ProjectDocument } from "../../project/ProjectTypes";

export type SimulideAttributes = Record<string, string>;

export interface SimulideCircuitSettings {
  version?: string;
  revision?: number;
  /** Passo elétrico do SimulIDE em picosegundos. */
  stepSize?: number;
  /** Quantidade de passos de stepSize por segundo de parede (controle de velocidade). */
  stepsPerSecond?: number;
  maxNonLinearSteps?: number;
  raw: SimulideAttributes;
}

export interface SimulideNestedRecord {
  attributes: SimulideAttributes;
  lineNumber: number;
}

export interface SimulideComponentRecord {
  kind: "component";
  itemType: string;
  circId: string;
  attributes: SimulideAttributes;
  /** Subcircuitos do SimulIDE podem conter <mainCompProps .../> numa linha filha. */
  mainCompProps?: SimulideNestedRecord;
  lineNumber: number;
}

export interface SimulideNodeRecord {
  kind: "node";
  itemType: "Node";
  circId: string;
  attributes: SimulideAttributes;
  lineNumber: number;
}

export interface SimulideConnectorRecord {
  kind: "connector";
  itemType: "Connector";
  uid: string;
  startPinId: string;
  endPinId: string;
  points: Array<{ x: number; y: number }>;
  attributes: SimulideAttributes;
  lineNumber: number;
}

export interface SimulideCircuitDocument {
  settings: SimulideCircuitSettings;
  components: SimulideComponentRecord[];
  nodes: SimulideNodeRecord[];
  connectors: SimulideConnectorRecord[];
  /** Problemas recuperáveis encontrados durante o parse (linha ignorada, CircId duplicado
   * renomeado, etc.) -- nunca aborta o arquivo inteiro, ver `SimulideParser.ts`. Mesclado no
   * relatório final por `convertSimulideDocument`. */
  parseIssues: SimulideImportIssue[];
}

export type SimulideImportSeverity = "warning" | "error";

export interface SimulideImportIssue {
  severity: SimulideImportSeverity;
  code:
    | "parse-warning"
    | "unsupported-component"
    | "unsupported-subcircuit"
    | "placeholder-component"
    | "partial-component"
    | "unresolved-pin"
    | "unresolved-endpoint"
    | "orphan-endpoint-preserved"
    | "ignored-property"
    | "property-coercion"
    | "rotation-rounded"
    | "label-rotation-rounded"
    | "duplicate-id"
    | "duplicate-conductor-id"
    | "invalid-topology"
    | "image-file-missing"
    | "firmware-file-missing"
    | "simulation-setting-gap"
    | "semantic-gap";
  message: string;
  sourceId?: string;
  sourceType?: string;
  property?: string;
  lineNumber?: number;
}

export interface SimulideImportReport {
  sourcePath?: string;
  sourceExtension?: ".sim1" | ".sim2";
  componentCount: number;
  /** Componentes emitidos no ProjectDocument, incluindo placeholders. */
  convertedComponentCount: number;
  /** Componentes com equivalente estrutural/funcional conhecido no LasecSimul. */
  fullyConvertedComponentCount: number;
  /** Componentes conhecidos que precisaram cair para placeholder para não perder fios/dados. */
  partiallyConvertedComponentCount: number;
  /** Componentes sem equivalente, preservados como import.simulide.unresolved. */
  placeholderComponentCount: number;
  nodeCount: number;
  connectorCount: number;
  /** Condutores preservados no ProjectDocument. */
  convertedConnectorCount: number;
  /** Endpoints impossíveis de associar ao owner original e preservados em nós órfãos sintéticos. */
  orphanEndpointCount: number;
  issues: SimulideImportIssue[];
}

export interface SimulideConversionResult {
  project: ProjectDocument;
  report: SimulideImportReport;
}

/**
 * `error` fica reservado a falha realmente fatal/inconsistência que não pôde ser preservada
 * (arquivo sem a tag `<circuit>`, por exemplo). Elemento não suportado, propriedade não mapeada,
 * ID duplicado/ausente etc. NÃO são `error` -- viram placeholder/renomeação + warning.
 */
export function hasImportErrors(report: SimulideImportReport): boolean {
  return report.issues.some((issue) => issue.severity === "error");
}

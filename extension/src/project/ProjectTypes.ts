export const LS_PROJ_SCHEMA_VERSION = 2 as const;

export interface ProjectSimulationSettings {
  frequencyHz?: number;
  timeScale?: number;
  paused?: boolean;
  integrationMethod?: "automatic" | "backwardEuler" | "trapezoidal" | "gear2";
  initialStepSeconds?: number;
  minimumStepSeconds?: number;
  maximumStepSeconds?: number;
  relativeTolerance?: number;
  absoluteTolerance?: number;
  maximumNewtonIterations?: number;
  threadCount?: number;
  telemetryRateHz?: number;
  adaptiveTimeStep?: boolean;
}

export interface ProjectWire {
  id: string;
  from: { componentId: string; pinId: string };
  to: { componentId: string; pinId: string };
}

export type ProjectTopologyEndpoint =
  | { kind: "port"; componentId: string; pinId: string }
  | { kind: "node"; nodeId: string };

export interface ProjectTopology {
  revision: number;
  nodes: Array<{ id: string; position: { x: number; y: number } }>;
  conductors: Array<{
    id: string;
    from: ProjectTopologyEndpoint;
    to: ProjectTopologyEndpoint;
    vertices: Array<{ x: number; y: number }>;
  }>;
}

/** Referência do "bloco genérico de subcircuito" a um `.lssubcircuit` escolhido por caminho (fora
 * de `registeredSources[]` -- ver `.spec/lasecsimul-subcircuits.spec` seção 12). `path` é relativo
 * ao diretório do próprio `.lsproj` quando possível, senão absoluto. `lastKnownTypeId`/
 * `lastKnownPinIds` são a ÚNICA exceção deliberada à regra "nunca persistir pinos" (comentário em
 * `extension.ts::projectToWebviewState`): sem um `RegisteredSource` pra consultar, não há de onde
 * re-derivar os pinos quando o arquivo está ausente -- o snapshot preserva a integridade estrutural
 * dos fios (`ProjectWire.from/to.pinId`) até o usuário relocalizar o arquivo. */
export interface ProjectSubcircuitRef {
  path: string;
  lastKnownTypeId?: string;
  lastKnownPinIds?: string[];
}

/** Referência não registrada do componente genérico Externos/Device. */
export interface ProjectDeviceRef {
  path: string;
  lastKnownTypeId?: string;
  lastKnownPinIds?: string[];
  /** Permite reconstruir o placeholder e detectar alteração do arquivo entre sessões. */
  lastKnownMtimeMs?: number;
}

export interface ProjectComponent {
  id: string;
  typeId: string;
  properties: Record<string, unknown>;
  /** Nome com índice (ex: "Resistor-1") — ausente em projetos salvos antes desta versão; recalculado
   * a partir do catálogo nesse caso (mesmo comportamento de sempre, ver `projectToWebviewState`). */
  label?: string;
  showId?: boolean;
  showValue?: boolean;
  showDialValue?: boolean;
  /** Qual propriedade numérica aparece no rótulo de valor, quando o typeId tem mais de uma
   * candidata (achado de auditoria de UI 2026-07-09, ver `WebviewComponentModel.valueLabelPropertyKey`
   * em `ui/webview/model.ts`). Ausente == usa o default do catálogo. */
  valueLabelPropertyKey?: string;
  flipH?: boolean;
  flipV?: boolean;
  /** Bloqueio de edição em lote (ver `ui/webview/model.ts::WebviewComponentModel.locked`) --
   * distinto de qualquer conceito do Core, nunca sincronizado via `setProperty`. Ausente == `false`. */
  locked?: boolean;
  /** Visibilidade escolhida pelo usuário (ver `ui/webview/model.ts::WebviewComponentModel.hiddenByUser`)
   * -- distinto do `hidden` derivado do catálogo (nunca persistido, sempre recalculado do typeId).
   * Ausente == `false`. */
  hiddenByUser?: boolean;
  visual?: {
    x?: number;
    y?: number;
    rotation?: 0 | 90 | 180 | 270;
  };
  subcircuitRef?: ProjectSubcircuitRef;
  deviceRef?: ProjectDeviceRef;
}

export interface ProjectFirmwareConfig {
  chipId: string;
  firmwarePath: string;
  arguments?: string[];
}

export interface ProjectDocument {
  schemaVersion: number;
  components: ProjectComponent[];
  wires: ProjectWire[];
  /** Fonte canônica v2. `wires` permanece temporariamente apenas como projeção interna durante a
   * migração da Webview e não é gravado pelo serializer v2. */
  topology: ProjectTopology;
  visual: {
    wires: Array<{ id: string; selected?: boolean; points?: { x: number; y: number }[] }>;
    viewport: { x: number; y: number; zoom: number };
  };
  simulationSettings: ProjectSimulationSettings;
  mcuFirmware?: ProjectFirmwareConfig[];
}

export function createEmptyProject(): ProjectDocument {
  return {
    schemaVersion: LS_PROJ_SCHEMA_VERSION,
    components: [],
    wires: [],
    topology: { revision: 0, nodes: [], conductors: [] },
    visual: {
      wires: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    simulationSettings: {},
  };
}

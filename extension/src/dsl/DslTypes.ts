import type { CanonicalEndpoint, WebviewComponentModel, WebviewPoint, WebviewWireModel } from "../ui/webview/model.js";

export type DslValue = string | number | boolean | DslValue[];

export interface DslComponent {
  id: string;
  typeId: string;
  properties: Record<string, DslValue>;
}

export interface DslNode {
  id: string;
}

export type DslEndpoint = CanonicalEndpoint | { kind: "tunnel"; tunnelId: string } | { kind: "context"; direction: "in" | "out"; portId?: string };

/** Sentinel `pinId` the compact chain syntax (`A -> Type(...) -> B`) emits
 * for a bare component reference with no explicit `.pin` -- the parser has
 * no catalog access (by design: catalog resolution belongs to
 * `reconcileDsl`, which does), so it cannot know a real component's actual
 * pin ids (there is no universal "in"/"out" pin naming convention across
 * catalog entries; see `WebviewComponentCatalogEntry.pinIds`). Never a real
 * pin id on its own (empty string), so it can't collide with authored
 * content. `reconcileDsl` resolves it using that component's real, ordered
 * pin list once it has the catalog descriptor in hand. */
export const DEFAULT_PIN_SENTINEL = "";

export interface DslWire {
  id: string;
  from: DslEndpoint;
  to: DslEndpoint;
}

export interface DslTunnel { id: string; name: string; }

export interface DslDocument {
  name: string;
  components: DslComponent[];
  nodes: DslNode[];
  tunnels?: DslTunnel[];
  wires: DslWire[];
}

export interface DslDiagnostic {
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning";
}

export interface DslParseResult {
  document?: DslDocument;
  diagnostics: DslDiagnostic[];
}

export interface DslReconcileResult {
  state?: {
    components: WebviewComponentModel[];
    topology: {
      revision: number;
      nodes: Array<{ id: string; position: WebviewPoint }>;
      conductors: WebviewWireModel[];
    };
  };
  diagnostics: DslDiagnostic[];
}

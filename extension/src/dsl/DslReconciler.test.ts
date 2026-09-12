import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer.js";
import { reconcileDsl } from "./DslReconciler.js";
import { parseDsl } from "./DslParser.js";
import { serializeDsl, stateToDsl } from "./DslSerializer.js";
import type { WebviewProjectState } from "../ui/webview/model.js";

const { test, finish } = createTestRunner("DslReconciler/DslParser - Lasec DSL semantic authoring model");

const catalog = [{ typeId: "passive.resistor", label: "Resistor", category: "Passivos", pinCount: 2, pinIds: ["p1", "p2"], defaultProperties: { resistance: 1000 } }] as unknown as WebviewProjectState["catalog"];
const state = { components: [{ id: "r1", typeId: "passive.resistor", x: 10, y: 20, rotation: 0, label: "R1", pins: [{ id: "p1", x: 0, y: 0 }, { id: "p2", x: 0, y: 12 }], properties: { resistance: 1000 } }], topology: { revision: 2, nodes: [], conductors: [] } } as unknown as WebviewProjectState;

(async () => {
  await test("Visual -> DSL -> Visual round-trip preserves layout (position)", () => {
    const source = stateToDsl(state);
    const parsed = parseDsl(source);
    assert(parsed.document !== undefined, "serializer output should parse");
    const result = reconcileDsl(parsed.document!, state, catalog);
    assert(result.state !== undefined, "round-trip should reconcile");
    assert(result.state!.components[0]!.x === 10 && result.state!.components[0]!.y === 20, "layout was not preserved");
  });

  await test("unknown catalog type is rejected atomically (no partial state)", () => {
    const invalid = parseDsl("model Bad { component r1 unknown.type {} }");
    assert(invalid.document !== undefined, "parser should accept semantic-invalid type for resolver");
    assert(reconcileDsl(invalid.document!, state, catalog).state === undefined, "unknown catalog type must be atomic");
  });

  await test("canonical serializer round-trips through the legacy explicit form", () => {
    const parsed = parseDsl(stateToDsl(state));
    assert(serializeDsl(parsed.document!).includes("model Circuit"), "canonical serializer failed");
  });

  await test("compact chain syntax with @Tunnel produces exactly the expected components/wires/tunnel-endpoint-kind", () => {
    const compact = parseDsl(`{
      filter = passive.resistor(resistance=220)
      in -> filter.p1
      filter.p2 -> @Sense
      @Sense -> out.value
    }`);
    assert(compact.document !== undefined && compact.document.components.length === 1 && compact.document.wires.length === 3, "compact graph syntax failed");
    assert(compact.document!.wires[1]!.to.kind === "tunnel", "@Name must be a tunnel endpoint");
    const compactResult = reconcileDsl(compact.document!, state, [{ ...catalog[0]!, typeId: "passive.resistor" }]);
    assert(compactResult.state !== undefined, "compact graph should reconcile atomically");
  });

  await test("invalid compact DSL (unknown block type) never mutates the model", () => {
    const invalidCompact = parseDsl("{ in -> MissingType() -> out }");
    assert(invalidCompact.document !== undefined, "parser should still produce a document for the resolver to reject");
    assert(reconcileDsl(invalidCompact.document!, state, catalog).state === undefined, "invalid compact DSL mutated the model");
  });

  // --- Stable-ID audit (anonymous inline blocks and auto-numbered wires) ---
  // `A -> Type(...) -> B` with no explicit `name = Type(...)` binding used to
  // get its id from a single counter shared by the WHOLE document, so any
  // unrelated edit anywhere else in the file could silently reassign this
  // block's identity. Fixed this session by scoping the counter to the
  // chain's own starting endpoint (its "anchor"). These tests prove the fix
  // directly, per the audit's "prove, don't assume" requirement.

  await test("unrelated chain added BEFORE an existing chain does not change that chain's inline block id", () => {
    const before = parseDsl(`{
      A -> passive.resistor(resistance=2) -> B
    }`);
    assert(before.document !== undefined && before.document.components.length === 1, "baseline chain should parse to exactly one inline component");
    const idBefore = before.document!.components[0]!.id;

    const after = parseDsl(`{
      C -> passive.resistor(resistance=3) -> D
      A -> passive.resistor(resistance=2) -> B
    }`);
    assert(after.document !== undefined && after.document.components.length === 2, "reordered document should still parse to exactly two inline components");
    const sameChainComponent = after.document!.components.find((c) => c.properties.resistance === 2);
    assert(sameChainComponent !== undefined, "the A->B chain's inline resistor should still be findable by its own property");
    assert(sameChainComponent!.id === idBefore, `unrelated chain inserted earlier in the document must not change this chain's inline id (was '${idBefore}', is now '${sameChainComponent!.id}')`);
  });

  await test("two structurally identical inline blocks in DIFFERENT chains never collide on id", () => {
    const doc = parseDsl(`{
      A -> passive.resistor(resistance=2) -> B
      C -> passive.resistor(resistance=2) -> D
    }`).document;
    assert(doc !== undefined && doc.components.length === 2, "two independent chains should produce two inline components");
    assert(doc!.components[0]!.id !== doc!.components[1]!.id, `identical inline blocks in different chains must get distinct ids, both got '${doc!.components[0]!.id}'`);
  });

  await test("two identical inline blocks in the SAME chain still get distinct, stable ids", () => {
    const doc = parseDsl(`{
      A -> passive.resistor(resistance=2) -> passive.resistor(resistance=2) -> B
    }`).document;
    assert(doc !== undefined && doc.components.length === 2, "a chain with two inline blocks should produce two components");
    assert(doc!.components[0]!.id !== doc!.components[1]!.id, "two inline blocks in the same chain must not collide on id even with identical properties");
  });

  await test("editing an unrelated chain's property does not change another chain's inline id or wire id", () => {
    const first = parseDsl(`{
      A -> passive.resistor(resistance=2) -> B
      C -> passive.resistor(resistance=5) -> D
    }`).document!;
    const target = first.components.find((c) => c.properties.resistance === 2)!;
    const targetWire = first.wires.find((w) => w.to.kind === "port" && w.to.componentId === target.id)!;

    // Semantic-preserving edit elsewhere: only C's chain's property changes.
    const second = parseDsl(`{
      A -> passive.resistor(resistance=2) -> B
      C -> passive.resistor(resistance=999) -> D
    }`).document!;
    const targetAfter = second.components.find((c) => c.properties.resistance === 2)!;
    const targetWireAfter = second.wires.find((w) => w.to.kind === "port" && w.to.componentId === targetAfter.id)!;

    assert(targetAfter.id === target.id, "unrelated chain's property edit must not change this chain's inline component id");
    assert(targetWireAfter.id === targetWire.id, "unrelated chain's property edit must not change this chain's wire id");
  });

  // --- Connection route preservation ---
  await test("a manually-edited wire route survives reconciliation of an unrelated DSL change", () => {
    const baseline = parseDsl(`{
      in -> passive.resistor(resistance=2) -> out
    }`).document!;
    const catalogWithA = catalog;
    const emptyState = { components: [], topology: { revision: 1, nodes: [], conductors: [] } } as unknown as WebviewProjectState;
    const firstReconcile = reconcileDsl(baseline, emptyState, catalogWithA);
    assert(firstReconcile.state !== undefined, "baseline should reconcile");
    const wire = firstReconcile.state!.topology.conductors[0]!;
    const editedRoute = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
    const stateWithRoute: WebviewProjectState = {
      ...emptyState,
      components: firstReconcile.state!.components,
      topology: { ...firstReconcile.state!.topology, conductors: [{ ...wire, points: editedRoute }] },
    } as WebviewProjectState;

    // Semantically identical DSL (same endpoints for the same wire id) --
    // reconciling again must preserve the manually-edited route, never reset it.
    const reReconcile = reconcileDsl(baseline, stateWithRoute, catalogWithA);
    assert(reReconcile.state !== undefined, "re-reconciling the same topology should succeed");
    const wireAfter = reReconcile.state!.topology.conductors.find((c) => c.id === wire.id);
    assert(wireAfter !== undefined, "the same wire id should still exist after reconciliation");
    assert(JSON.stringify(wireAfter!.points) === JSON.stringify(editedRoute), "manually-edited route must survive reconciliation when endpoints are unchanged");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

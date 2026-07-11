import { createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import { JUNCTION_TYPE_ID, WebviewComponentModel, WebviewWireModel } from "./model";
import { assertTopologyInvariants, canonicalTopologyFromLegacy, legacyTopologyFromCanonical } from "./topologyDocument";

const { test, finish } = createTestRunner("topologyDocument — modelo canônico v2");
const component = (id: string): WebviewComponentModel => ({ id, typeId: "test.component", label: id, hidden: false, x: 0, y: 0, rotation: 0, pins: [{ id: "p", x: 0, y: 0 }], properties: {} });
const junction = (id: string): WebviewComponentModel => ({ id, typeId: JUNCTION_TYPE_ID, label: id, hidden: true, x: 40, y: 24, rotation: 0, pins: [{ id: "pin-1", x: 0, y: 0 }], properties: {} });

void (async () => {
  await test("conversão remove junction da lista de componentes e preserva nó/rotas", () => {
    const components = [component("a"), component("b"), junction("n")];
    const wires: WebviewWireModel[] = [
      { id: "w1", from: { componentId: "a", pinId: "p" }, to: { componentId: "n", pinId: "pin-1" } },
      { id: "w2", from: { componentId: "n", pinId: "pin-1" }, to: { componentId: "b", pinId: "p" }, points: [{ x: 56, y: 24 }] },
    ];
    const canonical = canonicalTopologyFromLegacy(components, wires, 3);
    if (canonical.nodes.length !== 1 || canonical.conductors.length !== 2 || canonical.revision !== 3) throw new Error("conversão canônica incompleta");
    const projected = legacyTopologyFromCanonical(canonical);
    if (projected.junctions.length !== 1 || projected.wires[1]?.points?.[0]?.x !== 56) throw new Error("round-trip perdeu geometria");
  });
  await test("invariantes rejeitam nó duplicado e endpoint órfão", () => {
    let duplicateRejected = false;
    try { assertTopologyInvariants({ revision: 0, nodes: [{ id: "n", position: { x: 0, y: 0 } }, { id: "n", position: { x: 1, y: 1 } }], conductors: [] }); } catch { duplicateRejected = true; }
    if (!duplicateRejected) throw new Error("nó duplicado aceito");
    let orphanRejected = false;
    try { assertTopologyInvariants({ revision: 0, nodes: [], conductors: [{ id: "w", from: { kind: "node", nodeId: "missing" }, to: { kind: "port", componentId: "a", pinId: "p" }, vertices: [] }] }); } catch { orphanRejected = true; }
    if (!orphanRejected) throw new Error("endpoint órfão aceito");
  });
  finish();
})();

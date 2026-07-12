import { createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import { CanonicalTopologyDocument } from "./model";
import { assertTopologyInvariants } from "./topologyDocument";

const { test, finish } = createTestRunner("topologyDocument — validação de invariantes (modelo canônico v2)");

void (async () => {
  await test("documento válido (T de 3 ramos) passa sem lançar", () => {
    const document: CanonicalTopologyDocument = {
      revision: 3,
      nodes: [{ id: "n", position: { x: 40, y: 24 } }],
      conductors: [
        { id: "w1", from: { kind: "port", componentId: "a", pinId: "p" }, to: { kind: "node", nodeId: "n" } },
        { id: "w2", from: { kind: "node", nodeId: "n" }, to: { kind: "port", componentId: "b", pinId: "p" }, points: [{ x: 56, y: 24 }] },
      ],
    };
    assertTopologyInvariants(document, new Set(["a", "b"]));
  });

  await test("invariantes rejeitam nó duplicado e endpoint órfão", () => {
    let duplicateRejected = false;
    try { assertTopologyInvariants({ revision: 0, nodes: [{ id: "n", position: { x: 0, y: 0 } }, { id: "n", position: { x: 1, y: 1 } }], conductors: [] }); } catch { duplicateRejected = true; }
    if (!duplicateRejected) throw new Error("nó duplicado aceito");
    let orphanRejected = false;
    try { assertTopologyInvariants({ revision: 0, nodes: [], conductors: [{ id: "w", from: { kind: "node", nodeId: "missing" }, to: { kind: "port", componentId: "a", pinId: "p" } }] }); } catch { orphanRejected = true; }
    if (!orphanRejected) throw new Error("endpoint órfão aceito");
  });

  await test("invariantes rejeitam endpoint de porta apontando pra componente fora do conjunto informado", () => {
    let rejected = false;
    try {
      assertTopologyInvariants(
        { revision: 0, nodes: [], conductors: [{ id: "w", from: { kind: "port", componentId: "a", pinId: "p" }, to: { kind: "port", componentId: "ghost", pinId: "p" } }] },
        new Set(["a"])
      );
    } catch { rejected = true; }
    if (!rejected) throw new Error("componente fora do conjunto informado foi aceito");
  });

  await test("invariantes rejeitam condutor de comprimento topológico zero (mesmo endpoint nas duas pontas)", () => {
    let rejected = false;
    try {
      assertTopologyInvariants({
        revision: 0,
        nodes: [],
        conductors: [{ id: "w", from: { kind: "port", componentId: "a", pinId: "p" }, to: { kind: "port", componentId: "a", pinId: "p" } }],
      }, new Set(["a"]));
    } catch { rejected = true; }
    if (!rejected) throw new Error("condutor de comprimento zero aceito");
  });

  finish();
})();

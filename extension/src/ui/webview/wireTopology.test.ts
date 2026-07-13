import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { PackageDescriptor, TopologyNode, WebviewComponentModel, WebviewWireModel, endpointId, endpointPinId, nodeEndpoint, portEndpoint } from "./model";
import { registerPackage } from "./componentSymbols";
import { WireSpatialIndex } from "./wireSpatialIndex";
import {
  connectEndpointToNode,
  diffElectricalEdges,
  electricalEdgesForProject,
  findExistingJunctionAt,
  isJunctionVisible,
  mergeCollinearSegments,
  movableTopologyNodeIds,
  normalizeWireGeometry,
  pinScenePosition,
  removeOrphanNodes,
  splitSegmentAtPoint,
  TopologySnapshot,
  wireDegree,
  wirePolylinePoints,
} from "./wireTopology";

function topologyNode(id: string, x: number, y: number): TopologyNode {
  return { id, position: { x, y } };
}

function resistorComponent(id: string, x: number, y: number): WebviewComponentModel {
  return {
    id,
    typeId: "passives.resistor",
    label: id,
    x,
    y,
    rotation: 0,
    pins: [
      { id: "pin-1", x: 0, y: 0 },
      { id: "pin-2", x: 0, y: 0 },
    ],
    properties: {},
  };
}

/** Fio entre dois NÓS de topologia (o caso comum nos testes deste arquivo -- um "ponto com posição
 * e um pino sintético", sem precisar de um componente real de verdade por trás). */
function nodeWire(id: string, fromNodeId: string, toNodeId: string, points?: { x: number; y: number }[]): WebviewWireModel {
  return { id, from: nodeEndpoint(fromNodeId), to: nodeEndpoint(toNodeId), points };
}

/** Fio entre dois pinos de componente REAL (`pin-1` por convenção nos fixtures deste arquivo). */
function portWire(id: string, fromComponentId: string, toComponentId: string, pinId = "pin-1"): WebviewWireModel {
  return { id, from: portEndpoint(fromComponentId, pinId), to: portEndpoint(toComponentId, pinId) };
}

(async () => {
  const { test, finish } = createTestRunner("wireTopology — fonte única de verdade");

  // Fixture base: dois pontos "a" (0,0) e "b" (100,0) ligados por um fio reto horizontal -- nós de
  // topologia puros (sem componente real por trás), só posição + pino sintético "pin-1".
  const baseSnapshot = (): TopologySnapshot => ({
    components: [],
    nodes: [topologyNode("a", 0, 0), topologyNode("b", 100, 0)],
    wires: [nodeWire("w1", "a", "b")],
  });

  await test("wirePolylinePoints resolve as duas extremidades reais", () => {
    const snapshot = baseSnapshot();
    const points = wirePolylinePoints(snapshot.components, snapshot.wires[0]!, snapshot.nodes);
    assert(points.length === 2, `esperado 2 pontos (reta), recebido ${points.length}`);
    assert(points[0]!.x === 0 && points[0]!.y === 0, "primeiro ponto deveria ser a extremidade 'a'");
    assert(points[1]!.x === 100 && points[1]!.y === 0, "último ponto deveria ser a extremidade 'b'");
  });

  await test("pinScenePosition usa o layout de PACKAGE registrado, não o fallback genérico (regressão 2026-07-11: host sem pacotes registrados quebrava split de fio)", () => {
    // Reproduz o bug real: `wireTopology.ts` roda tanto no host quanto na Webview, mas
    // `componentSymbols.ts` é compilado em DUAS instâncias de módulo separadas (`registerPackage`
    // só popula a instância deste processo) -- se o host nunca chamar `registerPackage`, toda
    // geometria de pino cai no algoritmo genérico, divergindo do que a Webview mostra. Este teste
    // fixa o CONTRATO: com um package real registrado, `pinScenePosition` reflete o layout real
    // (`x`/`y`/`angle`/`length` do pino), não a posição genérica de 2 pinos esquerda/direita.
    const pkg: PackageDescriptor = {
      width: 60,
      height: 40,
      pins: [
        { id: "out", x: 68, y: 20, angle: 0, length: 8, label: "OUT" },
        { id: "vcc", x: -8, y: 10, angle: 180, length: 8, label: "VCC" },
      ],
    };
    registerPackage("test.wireTopologyPackage", pkg);
    const component: WebviewComponentModel = {
      id: "pkg1",
      typeId: "test.wireTopologyPackage",
      label: "pkg1",
      x: 100,
      y: 100,
      rotation: 0,
      pins: [
        { id: "out", x: 0, y: 0 },
        { id: "vcc", x: 0, y: 0 },
      ],
      properties: {},
    };
    const outPos = pinScenePosition([component], "pkg1", "out")!;
    const genericFallbackWidth = 70; // DEFAULT_BOX -- se pinScenePosition caísse no fallback genérico, a posição dependeria disso, não do package
    assert(Math.abs(outPos.x - (100 + genericFallbackWidth)) > 1, "posição não pode bater com o box genérico -- sinal de que caiu no fallback em vez de usar o package");
    assert(Math.abs(outPos.x - 176) < 1e-6 && Math.abs(outPos.y - 120) < 1e-6, `esperado {176,120} (geometria real do package, verificado contra componentSymbols.ts), recebido {${outPos.x},${outPos.y}}`);
    registerPackage("test.wireTopologyPackage", undefined);
  });

  await test("wirePolylinePoints devolve vazio quando um endpoint é referência órfã", () => {
    const snapshot = baseSnapshot();
    const orphanWire = nodeWire("w2", "a", "nao-existe");
    assert(wirePolylinePoints(snapshot.components, orphanWire, snapshot.nodes).length === 0, "endpoint inexistente deveria devolver polilinha vazia");
  });

  await test("WireSpatialIndex: upsertWire indexa os segmentos, removeWire tira do índice (mesmo espírito da antiga cobertura via findAtPosition, removido por ser código morto -- ver .spec seção 25.10; classe continua em uso real por maybeAutoJunctionForDraggedComponents)", () => {
    const index = new WireSpatialIndex(32);
    index.upsertWire("w1", [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    const hit = index.queryPoint({ x: 50, y: 2 }, 8);
    assert(hit.length === 1 && hit[0]!.wireId === "w1", "ponto sobre o segmento indexado deveria achar w1");
    index.removeWire("w1");
    const afterRemoval = index.queryPoint({ x: 50, y: 2 }, 8);
    assert(afterRemoval.length === 0, "remoção deveria tirar o fio do índice");
  });

  await test("wireDegree conta fios distintos tocando o nó", () => {
    const wires: WebviewWireModel[] = [nodeWire("w1", "j", "a"), nodeWire("w2", "j", "b")];
    assert(wireDegree(wires, "j") === 2, "grau deveria ser 2 (dois fios distintos)");
    assert(wireDegree(wires, "a") === 1, "grau de 'a' deveria ser 1");
    assert(wireDegree(wires, "nada") === 0, "componente sem fios deveria ter grau 0");
  });

  await test("isJunctionVisible só é true a partir de grau 3", () => {
    const makeWires = (degree: number): WebviewWireModel[] =>
      Array.from({ length: degree }, (_, index) => nodeWire(`w${index}`, "j", `p${index}`));
    assert(isJunctionVisible(makeWires(0), "j") === false, "grau 0 não deveria ser visível");
    assert(isJunctionVisible(makeWires(1), "j") === false, "grau 1 não deveria ser visível");
    assert(isJunctionVisible(makeWires(2), "j") === false, "grau 2 (passagem reta) não deveria ser visível");
    assert(isJunctionVisible(makeWires(3), "j") === true, "grau 3 (T real) deveria ser visível");
    assert(isJunctionVisible(makeWires(4), "j") === true, "grau 4+ deveria ser visível");
  });

  await test("findExistingJunctionAt reusa nó coincidente, ignora um próximo mas não exato", () => {
    const nodes = [topologyNode("j1", 40, 40)];
    assert(findExistingJunctionAt(nodes, { x: 40, y: 40 }) === "j1", "ponto exatamente coincidente deveria reusar j1");
    assert(findExistingJunctionAt(nodes, { x: 40.2, y: 39.8 }) === "j1", "dentro da tolerância de samePoint deveria reusar j1");
    assert(findExistingJunctionAt(nodes, { x: 60, y: 60 }) === undefined, "ponto distante não deveria encontrar nada");
  });

  await test("movableTopologyNodeIds: nó com TODO fio selecionado é movable", () => {
    const snapshot: TopologySnapshot = {
      components: [],
      nodes: [topologyNode("j", 40, 40)],
      wires: [nodeWire("w1", "j", "a"), nodeWire("w2", "j", "b")],
    };
    const result = movableTopologyNodeIds(snapshot, new Set(["w1", "w2"]));
    assert(result.has("j"), "nó cujos 2 fios estão selecionados deveria ser movable");
  });

  await test("movableTopologyNodeIds: nó com fio de fora da seleção NUNCA é movable (T parcialmente selecionado)", () => {
    const snapshot: TopologySnapshot = {
      components: [],
      nodes: [topologyNode("j", 40, 40)],
      wires: [nodeWire("w1", "j", "a"), nodeWire("w2", "j", "b"), nodeWire("w3", "j", "c")],
    };
    const result = movableTopologyNodeIds(snapshot, new Set(["w1", "w2"]));
    assert(!result.has("j"), "mover só 2 dos 3 ramos rasgaria o 3º -- nó deve ficar parado");
  });

  await test("movableTopologyNodeIds: nó sem nenhum fio selecionado tocando não é movable", () => {
    const snapshot: TopologySnapshot = {
      components: [],
      nodes: [topologyNode("j", 40, 40)],
      wires: [nodeWire("w1", "j", "a")],
    };
    const result = movableTopologyNodeIds(snapshot, new Set(["outro-fio-qualquer"]));
    assert(!result.has("j"), "nó sem fio selecionado tocando nunca deveria ser movable");
  });

  await test("splitSegmentAtPoint divide o fio e cria um nó novo no meio", () => {
    const snapshot = baseSnapshot();
    const result = splitSegmentAtPoint(snapshot, "w1", { x: 48, y: 2 }, { junctionId: "j-new", firstWireId: "w1a", secondWireId: "w1b" });
    assert(result !== undefined, "split no meio do segmento deveria funcionar");
    assert(result!.node !== undefined && result!.node!.id === "j-new", "deveria criar um nó topológico novo");
    assert(result!.node!.position.x === 48 && result!.node!.position.y === 0, "nó deveria nascer projetado+snapado sobre o segmento");
    assert(endpointId(result!.firstWire.from) === "a" && endpointId(result!.firstWire.to) === "j-new", "primeira metade vai de 'a' até o nó");
    assert(endpointId(result!.secondWire.from) === "j-new" && endpointId(result!.secondWire.to) === "b", "segunda metade vai do nó até 'b'");
  });

  await test("splitSegmentAtPoint reusa um nó já existente no ponto exato, não cria duplicata", () => {
    const snapshot: TopologySnapshot = {
      components: [],
      nodes: [...baseSnapshot().nodes, topologyNode("existing", 48, 0)],
      wires: baseSnapshot().wires,
    };
    const result = splitSegmentAtPoint(snapshot, "w1", { x: 48, y: 0 }, { junctionId: "would-be-new", firstWireId: "w1a", secondWireId: "w1b" });
    assert(result !== undefined, "split deveria funcionar");
    assert(result!.node === undefined, "não deveria criar um nó novo quando já existe um no ponto");
    assert(endpointId(result!.firstWire.to) === "existing", "metade deveria apontar pro nó reusado");
    assert(endpointId(result!.secondWire.from) === "existing", "outra metade deveria apontar pro nó reusado");
  });

  await test("splitSegmentAtPoint devolve undefined quando o ponto não projeta sobre o fio", () => {
    const snapshot = baseSnapshot();
    const result = splitSegmentAtPoint(snapshot, "w1", { x: 500, y: 500 }, { junctionId: "j", firstWireId: "w1a", secondWireId: "w1b" });
    assert(result === undefined, "ponto fora do fio não deveria produzir split");
  });

  await test("splitSegmentAtPoint devolve undefined quando o ponto já é uma extremidade real", () => {
    const snapshot = baseSnapshot();
    const result = splitSegmentAtPoint(snapshot, "w1", { x: 0, y: 0 }, { junctionId: "j", firstWireId: "w1a", secondWireId: "w1b" });
    assert(result === undefined, "clique na própria extremidade não é uma divisão de segmento");
  });

  await test("connectEndpointToNode: pino->pino delega pra um fio direto, sem nó novo", () => {
    const snapshot = baseSnapshot();
    const result = connectEndpointToNode(
      snapshot,
      { kind: "pin", componentId: "a", pinId: "pin-1" },
      { kind: "pin", componentId: "b", pinId: "pin-1" },
      undefined,
      { newWireId: "w-new", nextJunctionId: () => "unused-j", nextWireId: () => "unused-w" }
    );
    assert(result.newNodes.length === 0, "pino->pino não deveria criar nenhum nó novo");
    assert(result.newWires.length === 1 && result.newWires[0]!.id === "w-new", "deveria criar exatamente 1 fio novo");
    assert(result.replacedWireIds.length === 0, "pino->pino não substitui nenhum fio existente");
  });

  await test("connectEndpointToNode: pino->meio-de-fio divide o fio de destino e conecta no nó novo", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("c", 0, 100)],
      nodes: baseSnapshot().nodes,
      wires: baseSnapshot().wires,
    };
    let junctionSeq = 0;
    let wireSeq = 0;
    const result = connectEndpointToNode(
      snapshot,
      { kind: "pin", componentId: "c", pinId: "pin-1" },
      { kind: "wire", wireId: "w1", point: { x: 48, y: 2 } },
      [{ x: 48, y: 50 }],
      { newWireId: "w-new", nextJunctionId: () => `j${++junctionSeq}`, nextWireId: () => `sw${++wireSeq}` }
    );
    assert(result.newNodes.length === 1, "deveria criar 1 nó novo pro split do fio de destino");
    assert(result.replacedWireIds.includes("w1"), "fio original deveria ser marcado pra substituição");
    assert(result.newWires.length === 3, "deveria produzir as 2 metades do split + o fio novo ligando 'c'");
    const connecting = result.newWires.find((entry) => entry.id === "w-new")!;
    assert(endpointId(connecting.from) === "c", "fio novo deveria sair de 'c'");
    assert(endpointId(connecting.to) === result.newNodes[0]!.id, "fio novo deveria terminar no nó recém-criado");
  });

  await test("connectEndpointToNode: meio-de-fio->meio-de-fio divide os dois fios e liga os dois nós", () => {
    const snapshot: TopologySnapshot = {
      components: [],
      nodes: [topologyNode("a", 0, 0), topologyNode("b", 100, 0), topologyNode("c", 0, 100), topologyNode("d", 100, 100)],
      wires: [nodeWire("w1", "a", "b"), nodeWire("w2", "c", "d")],
    };
    let junctionSeq = 0;
    let wireSeq = 0;
    const result = connectEndpointToNode(
      snapshot,
      { kind: "wire", wireId: "w1", point: { x: 48, y: 2 } },
      { kind: "wire", wireId: "w2", point: { x: 48, y: 98 } },
      [],
      { newWireId: "w-new", nextJunctionId: () => `j${++junctionSeq}`, nextWireId: () => `sw${++wireSeq}` }
    );
    assert(result.newNodes.length === 2, "deveria criar 2 nós (um por fio dividido)");
    assert(result.replacedWireIds.length === 2 && result.replacedWireIds.includes("w1") && result.replacedWireIds.includes("w2"), "os dois fios originais deveriam ser substituídos");
    assert(result.newWires.length === 5, "2 metades de w1 + 2 metades de w2 + o fio novo ligando os dois nós");
  });

  await test("mergeCollinearSegments simplifica pontos redundantes dentro de cada fio", () => {
    const snapshot: TopologySnapshot = {
      components: [],
      nodes: baseSnapshot().nodes,
      wires: [nodeWire("w1", "a", "b", [{ x: 30, y: 0 }, { x: 60, y: 0 }])],
    };
    const merged = mergeCollinearSegments(snapshot);
    assert((merged.wires[0]!.points?.length ?? 0) === 0 || merged.wires[0]!.points === undefined, "pontos colineares com as extremidades deveriam ser removidos");
  });

  await test("removeOrphanNodes: grau 0 remove o nó órfão", () => {
    const snapshot: TopologySnapshot = { components: [], nodes: [topologyNode("j", 10, 10)], wires: [] };
    const result = removeOrphanNodes(snapshot);
    assert(result.nodes.length === 0, "nó sem nenhum fio deveria ser removido");
  });

  await test("removeOrphanNodes: grau 1 remove o nó E o fio pendurado", () => {
    const snapshot: TopologySnapshot = {
      components: [],
      nodes: [topologyNode("j", 10, 10), topologyNode("a", 0, 0)],
      wires: [nodeWire("w1", "a", "j")],
    };
    const result = removeOrphanNodes(snapshot);
    assert(result.nodes.every((node) => node.id !== "j"), "nó de grau 1 deveria ser removido");
    assert(result.wires.length === 0, "fio pendurado no nó de grau 1 deveria ser removido em cascata");
  });

  await test("removeOrphanNodes: grau 2 colapsa num único fio contínuo, nó some", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), resistorComponent("b", 100, 0)],
      nodes: [topologyNode("j", 50, 0)],
      wires: [
        { id: "w1", from: portEndpoint("a", "pin-1"), to: nodeEndpoint("j") },
        { id: "w2", from: nodeEndpoint("j"), to: portEndpoint("b", "pin-1") },
      ],
    };
    const result = removeOrphanNodes(snapshot);
    assert(result.nodes.every((node) => node.id !== "j"), "nó de grau 2 deveria ser removido");
    assert(result.wires.length === 1, "os dois fios deveriam colapsar num único fio contínuo");
    const merged = result.wires[0]!;
    const endpoints = [endpointId(merged.from), endpointId(merged.to)].sort();
    assert(endpoints[0] === "a" && endpoints[1] === "b", "o fio mesclado deveria ligar diretamente 'a' a 'b'");
  });

  await test("removeOrphanNodes: grau 3+ permanece intocado", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), resistorComponent("b", 100, 0), resistorComponent("c", 50, 100)],
      nodes: [topologyNode("j", 50, 0)],
      wires: [
        { id: "w1", from: portEndpoint("a", "pin-1"), to: nodeEndpoint("j") },
        { id: "w2", from: nodeEndpoint("j"), to: portEndpoint("b", "pin-1") },
        { id: "w3", from: nodeEndpoint("j"), to: portEndpoint("c", "pin-1") },
      ],
    };
    const result = removeOrphanNodes(snapshot);
    assert(result.nodes.some((node) => node.id === "j"), "nó de grau 3 (T real) deveria permanecer");
    assert(result.wires.length === 3, "os 3 fios deveriam permanecer intocados");
  });

  await test("electricalEdgesForProject: cruzamento SEM nó compartilhado nunca gera aresta entre as duas redes (mesma garantia elétrica que a antiga rebuildElectricalNet checava -- código morto removido, ver .spec seção 25.10; invariante portado pra cima do mecanismo que de fato roda em produção)", () => {
    const edges = electricalEdgesForProject({
      topologyNodes: [],
      wires: [portWire("w1", "a", "b"), portWire("w2", "c", "d")],
    });
    const crossesNetworks = edges.some((edge) => {
      const fromInFirst = endpointId(edge.from) === "a" || endpointId(edge.from) === "b";
      const toInSecond = endpointId(edge.to) === "c" || endpointId(edge.to) === "d";
      const fromInSecond = endpointId(edge.from) === "c" || endpointId(edge.from) === "d";
      const toInFirst = endpointId(edge.to) === "a" || endpointId(edge.to) === "b";
      return (fromInFirst && toInSecond) || (fromInSecond && toInFirst);
    });
    assert(!crossesNetworks, "fios que só se cruzam visualmente (sem nó) nunca podem virar aresta elétrica entre si");
  });

  await test("normalizeWireGeometry: deduplica nós coincidentes e redireciona os fios", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), resistorComponent("b", 100, 0)],
      nodes: [topologyNode("j1", 50, 0), topologyNode("j2", 50, 0)],
      wires: [
        { id: "w1", from: portEndpoint("a", "pin-1"), to: nodeEndpoint("j1") },
        { id: "w2", from: nodeEndpoint("j2"), to: portEndpoint("b", "pin-1") },
      ],
    };
    const result = normalizeWireGeometry(snapshot);
    assert(result.nodes.length <= 1, `esperado no máximo 1 nó sobrevivente (dedup + possível colapso de grau 2), recebido ${result.nodes.length}`);
  });

  await test("normalizeWireGeometry: corta fio com referência órfã", () => {
    const snapshot: TopologySnapshot = {
      components: [],
      nodes: [topologyNode("a", 0, 0)],
      wires: [nodeWire("w1", "a", "fantasma")],
    };
    const result = normalizeWireGeometry(snapshot);
    assert(result.wires.length === 0, "fio com referência a nó/componente inexistente deveria ser removido");
  });

  await test("normalizeWireGeometry: corta fio de comprimento zero (mesmo endpoint nas duas pontas)", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), resistorComponent("b", 100, 0)],
      nodes: [],
      wires: [portWire("w1", "a", "b"), portWire("w2", "a", "a")],
    };
    const result = normalizeWireGeometry(snapshot);
    assert(result.wires.length === 1, "fio de comprimento zero deveria ser removido, mantendo só o fio válido");
  });

  await test("normalizeWireGeometry: colapsa nó de grau <= 2", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), resistorComponent("b", 100, 0)],
      nodes: [topologyNode("j", 50, 0)],
      wires: [
        { id: "w1", from: portEndpoint("a", "pin-1"), to: nodeEndpoint("j") },
        { id: "w2", from: nodeEndpoint("j"), to: portEndpoint("b", "pin-1") },
      ],
    };
    const result = normalizeWireGeometry(snapshot);
    assert(result.nodes.every((node) => node.id !== "j"), "nó de grau 2 deveria colapsar/sumir na normalização");
    assert(result.wires.length === 1, "deveria sobrar um único fio contínuo entre 'a' e 'b'");
  });

  await test("normalizeWireGeometry é idempotente (reaplicar não muda nada)", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), resistorComponent("b", 100, 0), resistorComponent("c", 50, 100)],
      nodes: [topologyNode("j", 50, 0)],
      wires: [
        { id: "w1", from: portEndpoint("a", "pin-1"), to: nodeEndpoint("j") },
        { id: "w2", from: nodeEndpoint("j"), to: portEndpoint("b", "pin-1") },
        { id: "w3", from: nodeEndpoint("j"), to: portEndpoint("c", "pin-1") },
      ],
    };
    const once = normalizeWireGeometry(snapshot);
    const twice = normalizeWireGeometry(once);
    assert(JSON.stringify(once) === JSON.stringify(twice), "reaplicar normalizeWireGeometry sobre a própria saída não deveria mudar nada");
  });

  await test("electricalEdgesForProject: sem nó de topologia, cada fio simples vira 1 aresta entre portas reais", () => {
    const edges = electricalEdgesForProject({
      wires: [portWire("w1", "a", "b")],
      topologyNodes: [],
    });
    assert(edges.length === 1, "1 fio sem nó deveria virar exatamente 1 aresta");
    assert(endpointId(edges[0]!.from) === "a" && endpointId(edges[0]!.to) === "b", "aresta deveria conectar as duas portas reais do fio original");
  });

  await test("electricalEdgesForProject: rede com nó de topologia (T de 3 ramos) achata em N-1 arestas entre portas reais, nunca referencia o nó", () => {
    const edges = electricalEdgesForProject({
      wires: [
        { id: "w1", from: portEndpoint("a", "pin-1"), to: nodeEndpoint("n1") },
        { id: "w2", from: nodeEndpoint("n1"), to: portEndpoint("b", "pin-1") },
        { id: "w3", from: nodeEndpoint("n1"), to: portEndpoint("c", "pin-1") },
      ],
      topologyNodes: [topologyNode("n1", 50, 0)],
    });
    assert(edges.length === 2, "T de 3 portas reais deveria achatar em N-1=2 arestas");
    const referencedComponentIds = new Set(edges.flatMap((edge) => [endpointId(edge.from), endpointId(edge.to)]));
    assert(!referencedComponentIds.has("n1"), "o nó de topologia nunca deveria aparecer como endpoint de uma aresta achatada (Core nunca vê nó)");
    assert(referencedComponentIds.has("a") && referencedComponentIds.has("b") && referencedComponentIds.has("c"), "as 3 portas reais deveriam estar cobertas pelas arestas achatadas");
  });

  await test("electricalEdgesForProject: junção de 5 ramos não tem limite artificial e achata em N-1 arestas", () => {
    const ports = ["a", "b", "c", "d", "e"];
    const edges = electricalEdgesForProject({
      wires: ports.map((componentId, index) => ({
        id: `w${index}`,
        from: portEndpoint(componentId, "pin-1"),
        to: nodeEndpoint("n1"),
      })),
      topologyNodes: [topologyNode("n1", 50, 50)],
    });
    assert(edges.length === 4, "5 portas na mesma junção devem produzir exatamente N-1=4 arestas no Core");
    const covered = new Set(edges.flatMap((edge) => [endpointId(edge.from), endpointId(edge.to)]));
    for (const port of ports) assert(covered.has(port), `porta ${port} deveria participar da rede achatada`);
    assert(!covered.has("n1"), "nó visual nunca deve vazar para o Core");
  });

  await test("diffElectricalEdges: adicionar um ramo a uma rede existente gera só 1 connect, nunca mexe numa rede não tocada", () => {
    const untouched = portWire("wxy", "x", "y");
    const before = electricalEdgesForProject({
      wires: [
        { id: "w1", from: portEndpoint("a", "pin-1"), to: nodeEndpoint("n1") },
        { id: "w2", from: nodeEndpoint("n1"), to: portEndpoint("b", "pin-1") },
        untouched,
      ],
      topologyNodes: [topologyNode("n1", 50, 0)],
    });
    const after = electricalEdgesForProject({
      wires: [
        { id: "w1", from: portEndpoint("a", "pin-1"), to: nodeEndpoint("n1") },
        { id: "w2", from: nodeEndpoint("n1"), to: portEndpoint("b", "pin-1") },
        { id: "w3", from: nodeEndpoint("n1"), to: portEndpoint("c", "pin-1") },
        untouched,
      ],
      topologyNodes: [topologyNode("n1", 50, 0)],
    });
    const diff = diffElectricalEdges(before, after);
    assert(diff.disconnect.length === 0, `adicionar um ramo não deveria exigir desconectar nada preexistente, recebido ${JSON.stringify(diff.disconnect)}`);
    assert(diff.connect.length === 1, `adicionar um ramo deveria gerar exatamente 1 connect, recebido ${diff.connect.length}`);
    const newEdge = diff.connect[0]!;
    assert([endpointId(newEdge.from), endpointId(newEdge.to)].includes("c"), "a única aresta nova deveria envolver a porta 'c' recém-conectada");
    assert(![endpointId(newEdge.from), endpointId(newEdge.to)].some((id) => id === "x" || id === "y"), "a rede não tocada (x-y) nunca deveria aparecer no diff");
  });

  await test("diffElectricalEdges: remover uma porta de um T colapsa pra fio direto, diff mostra só a diferença real", () => {
    // Simula requestRemoveComponent: 'b' foi removido, a rede restante (a, c) já colapsou (via
    // normalizeWireGeometry, testado à parte) num fio direto sem nó -- exatamente o padrão que
    // extension.ts monta pra chamar diffElectricalEdges.
    const beforeExcludingRemoved = electricalEdgesForProject({
      wires: [
        { id: "w1", from: portEndpoint("a", "pin-1"), to: nodeEndpoint("n1") },
        { id: "w3", from: nodeEndpoint("n1"), to: portEndpoint("c", "pin-1") },
      ],
      topologyNodes: [topologyNode("n1", 50, 0)],
    });
    const afterNormalized = electricalEdgesForProject({
      wires: [portWire("w1", "a", "c")],
      topologyNodes: [],
    });
    const diff = diffElectricalEdges(beforeExcludingRemoved, afterNormalized);
    assert(diff.connect.length === 0 && diff.disconnect.length === 0, "colapso de nó grau-2 em fio direto entre os MESMOS 2 pontos não deveria gerar nenhuma operação (já é a mesma aresta elétrica a-c)");
  });

  await test("diffElectricalEdges: root da estrela muda de porta -- diff ainda cobre a rede inteira corretamente (nunca perde conectividade)", () => {
    // Insere uma porta ANTES da que hoje é root (ordem de inserção no Map determina root) --
    // mesmo pior caso citado na análise: o diff pode não ser mínimo, mas tem que continuar correto.
    const before = electricalEdgesForProject({
      wires: [
        { id: "w1", from: portEndpoint("a", "pin-1"), to: nodeEndpoint("n1") },
        { id: "w2", from: nodeEndpoint("n1"), to: portEndpoint("b", "pin-1") },
      ],
      topologyNodes: [topologyNode("n1", 50, 0)],
    });
    const after = electricalEdgesForProject({
      wires: [
        { id: "w0", from: portEndpoint("z", "pin-1"), to: nodeEndpoint("n1") },
        { id: "w1", from: portEndpoint("a", "pin-1"), to: nodeEndpoint("n1") },
        { id: "w2", from: nodeEndpoint("n1"), to: portEndpoint("b", "pin-1") },
      ],
      topologyNodes: [topologyNode("n1", 50, 0)],
    });
    const diff = diffElectricalEdges(before, after);
    // Reconstrói a rede resultante (arestas sobreviventes + connect) e confere que a, b, z acabam
    // todos no mesmo componente conexo -- é essa a garantia de correção, não o tamanho do diff.
    const edgeKey = (w: WebviewWireModel) => `${endpointId(w.from)}::${endpointPinId(w.from)}|${endpointId(w.to)}::${endpointPinId(w.to)}`;
    const survivingKeys = new Set(before.map(edgeKey));
    for (const removed of diff.disconnect) survivingKeys.delete(edgeKey(removed));
    const finalEdges = [...diff.connect, ...before.filter((w) => survivingKeys.has(edgeKey(w)))];
    const parent = new Map<string, string>();
    const find = (x: string): string => (parent.get(x) === x || !parent.has(x) ? (parent.set(x, x), x) : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
    for (const edge of finalEdges) {
      const a = `${endpointId(edge.from)}::${endpointPinId(edge.from)}`; const b = `${endpointId(edge.to)}::${endpointPinId(edge.to)}`;
      parent.set(find(a), find(b));
    }
    assert(find("a::pin-1") === find("z::pin-1") && find("b::pin-1") === find("z::pin-1"), "a, b e z deveriam continuar todos na mesma rede elétrica depois de aplicar o diff, mesmo que a root da estrela tenha mudado");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

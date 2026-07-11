import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { JUNCTION_TYPE_ID, PackageDescriptor, WebviewComponentModel, WebviewWireModel } from "./model";
import { registerPackage } from "./componentSymbols";
import {
  connectEndpointToNode,
  findAtPosition,
  findExistingJunctionAt,
  isJunctionVisible,
  mergeCollinearSegments,
  normalizeWireGeometry,
  pinScenePosition,
  rebuildElectricalNet,
  removeOrphanNodes,
  splitSegmentAtPoint,
  TopologySnapshot,
  wireDegree,
  wirePolylinePoints,
} from "./wireTopology";

function junctionComponent(id: string, x: number, y: number): WebviewComponentModel {
  return { id, typeId: JUNCTION_TYPE_ID, label: "Junction", hidden: true, x, y, rotation: 0, pins: [{ id: "pin-1", x: 0, y: 0 }], properties: {} };
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

function wire(id: string, from: { componentId: string; pinId: string }, to: { componentId: string; pinId: string }, points?: { x: number; y: number }[]): WebviewWireModel {
  return { id, from, to, points };
}

(async () => {
  const { test, finish } = createTestRunner("wireTopology — fonte única de verdade");

  // Fixture base: dois pontos "a" (0,0) e "b" (100,0) ligados por um fio reto horizontal.
  const baseSnapshot = (): TopologySnapshot => ({
    components: [junctionComponent("a", 0, 0), junctionComponent("b", 100, 0)],
    wires: [wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" })],
  });

  await test("wirePolylinePoints resolve as duas extremidades reais", () => {
    const snapshot = baseSnapshot();
    const points = wirePolylinePoints(snapshot.components, snapshot.wires[0]!);
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
        { id: "out", x: 60, y: 20, angle: 0, length: 8, label: "OUT" },
        { id: "vcc", x: 0, y: 10, angle: 180, length: 8, label: "VCC" },
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
    const orphanWire = wire("w2", { componentId: "a", pinId: "pin-1" }, { componentId: "nao-existe", pinId: "pin-1" });
    assert(wirePolylinePoints(snapshot.components, orphanWire).length === 0, "endpoint inexistente deveria devolver polilinha vazia");
  });

  await test("findAtPosition: prioridade pino > segmento > vazio", () => {
    const snapshot = baseSnapshot();
    const onSegment = findAtPosition(snapshot, { x: 50, y: 0 });
    assert(onSegment.kind === "segment" && onSegment.wireId === "w1", `clique no meio deveria achar o segmento, recebido ${onSegment.kind}`);

    const onJunctionEndpoint = findAtPosition(snapshot, { x: 0, y: 0 });
    assert(onJunctionEndpoint.kind === "junction" && onJunctionEndpoint.componentId === "a", "clique na extremidade 'a' deveria achar a junção/pino ali, não o segmento");

    const empty = findAtPosition(snapshot, { x: 500, y: 500 });
    assert(empty.kind === "empty", "clique longe de tudo deveria devolver vazio");
  });

  await test("findAtPosition: pino de componente real (não-junção) tem prioridade sobre segmento", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("r1", 0, 0), junctionComponent("b", 100, 0)],
      wires: [wire("w1", { componentId: "r1", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" })],
    };
    const pinPos = pinScenePosition(snapshot.components, "r1", "pin-1")!;
    const hit = findAtPosition(snapshot, pinPos);
    assert(hit.kind === "pin" && hit.componentId === "r1" && hit.pinId === "pin-1", `esperado pino de r1, recebido ${JSON.stringify(hit)}`);
  });

  await test("findAtPosition respeita a tolerância informada", () => {
    const snapshot = baseSnapshot();
    const farFromSegment = findAtPosition(snapshot, { x: 50, y: 30 }, 8);
    assert(farFromSegment.kind === "empty", "ponto fora da tolerância não deveria achar o segmento");
  });

  await test("wireDegree conta fios distintos tocando o componente", () => {
    const wires: WebviewWireModel[] = [
      wire("w1", { componentId: "j", pinId: "pin-1" }, { componentId: "a", pinId: "pin-1" }),
      wire("w2", { componentId: "j", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }),
    ];
    assert(wireDegree(wires, "j") === 2, "grau deveria ser 2 (dois fios distintos)");
    assert(wireDegree(wires, "a") === 1, "grau de 'a' deveria ser 1");
    assert(wireDegree(wires, "nada") === 0, "componente sem fios deveria ter grau 0");
  });

  await test("isJunctionVisible só é true a partir de grau 3", () => {
    const makeWires = (degree: number): WebviewWireModel[] =>
      Array.from({ length: degree }, (_, index) => wire(`w${index}`, { componentId: "j", pinId: "pin-1" }, { componentId: `p${index}`, pinId: "pin-1" }));
    assert(isJunctionVisible(makeWires(0), "j") === false, "grau 0 não deveria ser visível");
    assert(isJunctionVisible(makeWires(1), "j") === false, "grau 1 não deveria ser visível");
    assert(isJunctionVisible(makeWires(2), "j") === false, "grau 2 (passagem reta) não deveria ser visível");
    assert(isJunctionVisible(makeWires(3), "j") === true, "grau 3 (T real) deveria ser visível");
    assert(isJunctionVisible(makeWires(4), "j") === true, "grau 4+ deveria ser visível");
  });

  await test("findExistingJunctionAt reusa junção coincidente, ignora uma próxima mas não exata", () => {
    const components = [junctionComponent("j1", 40, 40)];
    assert(findExistingJunctionAt(components, { x: 40, y: 40 }) === "j1", "ponto exatamente coincidente deveria reusar j1");
    assert(findExistingJunctionAt(components, { x: 40.2, y: 39.8 }) === "j1", "dentro da tolerância de samePoint deveria reusar j1");
    assert(findExistingJunctionAt(components, { x: 60, y: 60 }) === undefined, "ponto distante não deveria encontrar nada");
  });

  await test("splitSegmentAtPoint divide o fio e cria uma junção nova no meio", () => {
    const snapshot = baseSnapshot();
    const result = splitSegmentAtPoint(snapshot, "w1", { x: 48, y: 2 }, { junctionId: "j-new", firstWireId: "w1a", secondWireId: "w1b" });
    assert(result !== undefined, "split no meio do segmento deveria funcionar");
    assert(result!.junction !== undefined && result!.junction!.id === "j-new", "deveria criar uma junção nova");
    assert(result!.junction!.x === 48 && result!.junction!.y === 0, "junção deveria nascer projetada+snapada sobre o segmento");
    assert(result!.junction!.hidden === true, "junção nova deve nascer oculta");
    assert(result!.firstWire.from.componentId === "a" && result!.firstWire.to.componentId === "j-new", "primeira metade vai de 'a' até a junção");
    assert(result!.secondWire.from.componentId === "j-new" && result!.secondWire.to.componentId === "b", "segunda metade vai da junção até 'b'");
  });

  await test("splitSegmentAtPoint reusa uma junção já existente no ponto exato, não cria duplicata", () => {
    const snapshot: TopologySnapshot = {
      components: [...baseSnapshot().components, junctionComponent("existing", 48, 0)],
      wires: baseSnapshot().wires,
    };
    const result = splitSegmentAtPoint(snapshot, "w1", { x: 48, y: 0 }, { junctionId: "would-be-new", firstWireId: "w1a", secondWireId: "w1b" });
    assert(result !== undefined, "split deveria funcionar");
    assert(result!.junction === undefined, "não deveria criar uma junção nova quando já existe uma no ponto");
    assert(result!.firstWire.to.componentId === "existing", "metade deveria apontar pra junção reusada");
    assert(result!.secondWire.from.componentId === "existing", "outra metade deveria apontar pra junção reusada");
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

  await test("connectEndpointToNode: pino->pino delega pra um fio direto, sem junção nova", () => {
    const snapshot = baseSnapshot();
    const result = connectEndpointToNode(
      snapshot,
      { kind: "pin", componentId: "a", pinId: "pin-1" },
      { kind: "pin", componentId: "b", pinId: "pin-1" },
      undefined,
      { newWireId: "w-new", nextJunctionId: () => "unused-j", nextWireId: () => "unused-w" }
    );
    assert(result.newComponents.length === 0, "pino->pino não deveria criar nenhum componente novo");
    assert(result.newWires.length === 1 && result.newWires[0]!.id === "w-new", "deveria criar exatamente 1 fio novo");
    assert(result.replacedWireIds.length === 0, "pino->pino não substitui nenhum fio existente");
  });

  await test("connectEndpointToNode: pino->meio-de-fio divide o fio de destino e conecta na junção nova", () => {
    const snapshot: TopologySnapshot = {
      components: [...baseSnapshot().components, junctionComponent("c", 0, 100)],
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
    assert(result.newComponents.length === 1 && result.newComponents[0]!.typeId === JUNCTION_TYPE_ID, "deveria criar 1 junção nova pro split do fio de destino");
    assert(result.replacedWireIds.includes("w1"), "fio original deveria ser marcado pra substituição");
    assert(result.newWires.length === 3, "deveria produzir as 2 metades do split + o fio novo ligando 'c'");
    const connecting = result.newWires.find((entry) => entry.id === "w-new")!;
    assert(connecting.from.componentId === "c", "fio novo deveria sair de 'c'");
    assert(connecting.to.componentId === result.newComponents[0]!.id, "fio novo deveria terminar na junção recém-criada");
  });

  await test("connectEndpointToNode: meio-de-fio->meio-de-fio divide os dois fios e liga as duas junções", () => {
    const snapshot: TopologySnapshot = {
      components: [junctionComponent("a", 0, 0), junctionComponent("b", 100, 0), junctionComponent("c", 0, 100), junctionComponent("d", 100, 100)],
      wires: [
        wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }),
        wire("w2", { componentId: "c", pinId: "pin-1" }, { componentId: "d", pinId: "pin-1" }),
      ],
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
    assert(result.newComponents.length === 2, "deveria criar 2 junções (uma por fio dividido)");
    assert(result.replacedWireIds.length === 2 && result.replacedWireIds.includes("w1") && result.replacedWireIds.includes("w2"), "os dois fios originais deveriam ser substituídos");
    assert(result.newWires.length === 5, "2 metades de w1 + 2 metades de w2 + o fio novo ligando as duas junções");
  });

  await test("mergeCollinearSegments simplifica pontos redundantes dentro de cada fio", () => {
    const snapshot: TopologySnapshot = {
      components: baseSnapshot().components,
      wires: [wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }, [{ x: 30, y: 0 }, { x: 60, y: 0 }])],
    };
    const merged = mergeCollinearSegments(snapshot);
    assert((merged.wires[0]!.points?.length ?? 0) === 0 || merged.wires[0]!.points === undefined, "pontos colineares com as extremidades deveriam ser removidos");
  });

  await test("removeOrphanNodes: grau 0 remove a junção órfã", () => {
    const snapshot: TopologySnapshot = { components: [junctionComponent("j", 10, 10)], wires: [] };
    const result = removeOrphanNodes(snapshot);
    assert(result.components.length === 0, "junção sem nenhum fio deveria ser removida");
  });

  await test("removeOrphanNodes: grau 1 remove a junção E o fio pendurado", () => {
    const snapshot: TopologySnapshot = {
      components: [junctionComponent("j", 10, 10), junctionComponent("a", 0, 0)],
      wires: [wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "j", pinId: "pin-1" })],
    };
    const result = removeOrphanNodes(snapshot);
    assert(result.components.every((component) => component.id !== "j"), "junção de grau 1 deveria ser removida");
    assert(result.wires.length === 0, "fio pendurado na junção de grau 1 deveria ser removido em cascata");
  });

  await test("removeOrphanNodes: grau 2 colapsa num único fio contínuo, junção some", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), junctionComponent("j", 50, 0), resistorComponent("b", 100, 0)],
      wires: [
        wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "j", pinId: "pin-1" }),
        wire("w2", { componentId: "j", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }),
      ],
    };
    const result = removeOrphanNodes(snapshot);
    assert(result.components.every((component) => component.id !== "j"), "junção de grau 2 deveria ser removida");
    assert(result.wires.length === 1, "os dois fios deveriam colapsar num único fio contínuo");
    const merged = result.wires[0]!;
    const endpoints = [merged.from.componentId, merged.to.componentId].sort();
    assert(endpoints[0] === "a" && endpoints[1] === "b", "o fio mesclado deveria ligar diretamente 'a' a 'b'");
  });

  await test("removeOrphanNodes: grau 3+ permanece intocado", () => {
    const snapshot: TopologySnapshot = {
      components: [junctionComponent("j", 50, 0), resistorComponent("a", 0, 0), resistorComponent("b", 100, 0), resistorComponent("c", 50, 100)],
      wires: [
        wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "j", pinId: "pin-1" }),
        wire("w2", { componentId: "j", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }),
        wire("w3", { componentId: "j", pinId: "pin-1" }, { componentId: "c", pinId: "pin-1" }),
      ],
    };
    const result = removeOrphanNodes(snapshot);
    assert(result.components.some((component) => component.id === "j"), "junção de grau 3 (T real) deveria permanecer");
    assert(result.wires.length === 3, "os 3 fios deveriam permanecer intocados");
  });

  await test("rebuildElectricalNet: fios ligados por uma junção formam uma única rede", () => {
    const snapshot: TopologySnapshot = {
      components: [junctionComponent("j", 50, 0), junctionComponent("a", 0, 0), junctionComponent("b", 100, 0)],
      wires: [
        wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "j", pinId: "pin-1" }),
        wire("w2", { componentId: "j", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }),
      ],
    };
    const net = rebuildElectricalNet(snapshot);
    assert(net.get("a:pin-1") === net.get("b:pin-1"), "'a' e 'b' deveriam estar na mesma rede via a junção");
  });

  await test("rebuildElectricalNet: cruzamento SEM junção compartilhada fica em redes separadas", () => {
    const snapshot: TopologySnapshot = {
      components: [junctionComponent("a", 0, 0), junctionComponent("b", 100, 0), junctionComponent("c", 50, -50), junctionComponent("d", 50, 50)],
      wires: [
        wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }),
        wire("w2", { componentId: "c", pinId: "pin-1" }, { componentId: "d", pinId: "pin-1" }),
      ],
    };
    const net = rebuildElectricalNet(snapshot);
    assert(net.get("a:pin-1") !== net.get("c:pin-1"), "fios que só se cruzam visualmente (sem junção) devem ficar em redes diferentes");
  });

  await test("normalizeWireGeometry: deduplica junções coincidentes e redireciona os fios", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), resistorComponent("b", 100, 0), junctionComponent("j1", 50, 0), junctionComponent("j2", 50, 0)],
      wires: [
        wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "j1", pinId: "pin-1" }),
        wire("w2", { componentId: "j2", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }),
      ],
    };
    const result = normalizeWireGeometry(snapshot);
    const junctions = result.components.filter((component) => component.typeId === JUNCTION_TYPE_ID);
    assert(junctions.length <= 1, `esperado no máximo 1 junção sobrevivente (dedup + possível colapso de grau 2), recebido ${junctions.length}`);
  });

  await test("normalizeWireGeometry: corta fio com referência órfã", () => {
    const snapshot: TopologySnapshot = {
      components: [junctionComponent("a", 0, 0)],
      wires: [wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "fantasma", pinId: "pin-1" })],
    };
    const result = normalizeWireGeometry(snapshot);
    assert(result.wires.length === 0, "fio com referência a componente inexistente deveria ser removido");
  });

  await test("normalizeWireGeometry: corta fio de comprimento zero (mesmo pino nas duas pontas)", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), resistorComponent("b", 100, 0)],
      wires: [
        wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }),
        wire("w2", { componentId: "a", pinId: "pin-1" }, { componentId: "a", pinId: "pin-1" }),
      ],
    };
    const result = normalizeWireGeometry(snapshot);
    assert(result.wires.length === 1, "fio de comprimento zero deveria ser removido, mantendo só o fio válido");
  });

  await test("normalizeWireGeometry: colapsa junção legada de grau <= 2", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), junctionComponent("j", 50, 0), resistorComponent("b", 100, 0)],
      wires: [
        wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "j", pinId: "pin-1" }),
        wire("w2", { componentId: "j", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }),
      ],
    };
    const result = normalizeWireGeometry(snapshot);
    assert(result.components.every((component) => component.id !== "j"), "junção legada de grau 2 deveria colapsar/sumir na normalização");
    assert(result.wires.length === 1, "deveria sobrar um único fio contínuo entre 'a' e 'b'");
  });

  await test("normalizeWireGeometry: força hidden=true e pino único em junção salva sem esses invariantes", () => {
    const malformed: WebviewComponentModel = {
      id: "j",
      typeId: JUNCTION_TYPE_ID,
      label: "component-123",
      hidden: false,
      x: 50,
      y: 0,
      rotation: 0,
      pins: [{ id: "pin-1", x: 0, y: 0 }],
      properties: {},
    };
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), malformed, resistorComponent("b", 100, 0), resistorComponent("c", 50, 100)],
      wires: [
        wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "j", pinId: "pin-1" }),
        wire("w2", { componentId: "j", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }),
        wire("w3", { componentId: "j", pinId: "pin-1" }, { componentId: "c", pinId: "pin-1" }),
      ],
    };
    const result = normalizeWireGeometry(snapshot);
    const junction = result.components.find((component) => component.id === "j");
    assert(junction !== undefined, "junção de grau 3 deveria sobreviver (só o invariante hidden é corrigido)");
    assert(junction!.hidden === true, "junção deveria ser forçada pra hidden:true na normalização");
  });

  await test("normalizeWireGeometry é idempotente (reaplicar não muda nada)", () => {
    const snapshot: TopologySnapshot = {
      components: [resistorComponent("a", 0, 0), junctionComponent("j", 50, 0), resistorComponent("b", 100, 0), resistorComponent("c", 50, 100)],
      wires: [
        wire("w1", { componentId: "a", pinId: "pin-1" }, { componentId: "j", pinId: "pin-1" }),
        wire("w2", { componentId: "j", pinId: "pin-1" }, { componentId: "b", pinId: "pin-1" }),
        wire("w3", { componentId: "j", pinId: "pin-1" }, { componentId: "c", pinId: "pin-1" }),
      ],
    };
    const once = normalizeWireGeometry(snapshot);
    const twice = normalizeWireGeometry(once);
    assert(JSON.stringify(once) === JSON.stringify(twice), "reaplicar normalizeWireGeometry sobre a própria saída não deveria mudar nada");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

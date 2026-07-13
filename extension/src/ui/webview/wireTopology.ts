/** Fonte única de verdade pra topologia de fios/junções -- pontos, segmentos, nós de junção e redes
 * elétricas, tudo como funções puras sobre `{components, wires, nodes}` (sem DOM, sem `vscode.*`).
 * Importado tanto pela Webview (`main.ts`, interação/render) quanto pelo Extension host
 * (`extension.ts`, IPC + persistência) -- ver `.spec` seção 24/25 pra contexto completo do porquê
 * este módulo existe (bola laranja permanente, ausência de gesto "derivar do meio do fio", junção
 * órfã nunca limpa, etc).
 *
 * Nó de topologia (`TopologyNode`) NUNCA é um componente (Fase C completa, `.spec` seção 25.6) --
 * antes desta rodada este arquivo ainda tratava junção como `WebviewComponentModel{typeId:
 * JUNCTION_TYPE_ID}` internamente (`main.ts::normalizeRuntimeTopology` sintetizava componentes
 * falsos só pra poder chamar `normalizeWireGeometry`/`removeOrphanNodes`, depois desfazia a síntese)
 * -- essa ponte foi removida; as funções abaixo operam direto sobre `TopologyNode[]`.
 *
 * Cada nó de topologia tem SEMPRE exatamente 1 pino sintético (`"pin-1"`) compartilhado por N fios
 * -- desvio deliberado do `Node` de 3 pinos fixos do SimulIDE (que só existe lá por limitação de
 * `QGraphicsItem` filho fixo); aqui basta contar quantos fios referenciam aquele id pra saber o
 * grau, sem cap nenhum. */

import {
  Point,
  WIRE_GRID_SIZE,
  buildOrthogonalPath,
  nearestSnappedPointOnOrthogonalSegment,
  normalizeOrthogonalPath,
  samePoint,
  splitWireRouteAtPoint,
} from "./wireGeometry.js";
import { CanonicalEndpoint, TopologyNode, WebviewComponentModel, WebviewWireModel, endpointId, endpointPinId, nodeEndpoint, portEndpoint } from "./model.js";
import { componentBox, componentLocalOrigin, pinLocalPosition } from "./componentSymbols.js";
import { localToScene } from "./componentGeometry.js";

export interface TopologySnapshot {
  components: WebviewComponentModel[];
  wires: WebviewWireModel[];
  nodes: TopologyNode[];
}

/** A conversão local→cena abaixo usa `componentGeometry.ts`, a mesma fonte do renderer. */
/** Posição em cena (canvas) do pino `pinId` do componente `componentId`, ou do nó de topologia
 * `componentId` (quando não bate com nenhum componente real -- `pinId` precisa ser `"pin-1"` nesse
 * caso). `undefined` se nem componente nem nó existirem. */
export function pinScenePosition(components: WebviewComponentModel[], componentId: string, pinId: string, nodes: TopologyNode[] = []): Point | undefined {
  const component = components.find((entry) => entry.id === componentId);
  if (!component) {
    const node = nodes.find((entry) => entry.id === componentId);
    return node && pinId === "pin-1" ? { x: node.position.x, y: node.position.y } : undefined;
  }
  const pinIndex = component.pins.findIndex((pin) => pin.id === pinId);
  if (pinIndex < 0) return undefined;
  const box = componentBox(component.typeId, component.properties);
  const origin = componentLocalOrigin(component.typeId, component.properties);
  const base = pinLocalPosition(component.pins[pinIndex]?.id ?? "", pinIndex, component.pins.length, component.typeId, component.properties);
  return localToScene(base, {
    size: box,
    position: { x: component.x, y: component.y },
    rotation: component.rotation,
    flipH: Boolean(component.flipH),
    flipV: Boolean(component.flipV),
    origin,
  });
}

/** Posição em cena de um endpoint tipado -- mesma resolução acima, só que a partir de
 * `CanonicalEndpoint` em vez de `(componentId,pinId)` soltos. */
export function endpointScenePosition(components: WebviewComponentModel[], endpoint: CanonicalEndpoint, nodes: TopologyNode[] = []): Point | undefined {
  return pinScenePosition(components, endpointId(endpoint), endpointPinId(endpoint), nodes);
}

/** Polilinha completa do fio (com as duas extremidades reais resolvidas), ou `[]` se algum dos dois
 * pinos não existir mais (referência órfã -- ver `normalizeWireGeometry`). */
export function wirePolylinePoints(components: WebviewComponentModel[], wire: WebviewWireModel, nodes: TopologyNode[] = []): Point[] {
  const fromPos = endpointScenePosition(components, wire.from, nodes);
  const toPos = endpointScenePosition(components, wire.to, nodes);
  if (!fromPos || !toPos) return [];
  return buildOrthogonalPath([fromPos, ...(wire.points ?? []), toPos]);
}

/** Quantos fios distintos tocam `nodeOrComponentId` (como `from` ou `to`) -- a base de tudo
 * relacionado a grau de nó de topologia. Não é um valor armazenado: sempre recalculado a partir de
 * `wires`, pra nunca poder divergir da realidade (requisito explícito do usuário). */
export function wireDegree(wires: WebviewWireModel[], nodeOrComponentId: string): number {
  let count = 0;
  for (const wire of wires) {
    if (endpointId(wire.from) === nodeOrComponentId) count += 1;
    if (endpointId(wire.to) === nodeOrComponentId) count += 1;
  }
  return count;
}

/** Um nó de topologia só tem significado elétrico visível quando tem 3+ fios (T ou mais) -- grau
 * 0/1/2 são candidatos a `removeOrphanNodes` (órfão, ou passagem reta sem entroncamento real) e
 * NUNCA devem desenhar o marcador de nó (a "bola laranja" do bug original era desenhada
 * incondicionalmente, ignorando isso por completo). */
export function isJunctionVisible(wires: WebviewWireModel[], nodeId: string): boolean {
  return wireDegree(wires, nodeId) >= 3;
}

/** Reusa um nó de topologia já existente exatamente na posição `point` (mesma tolerância de
 * coincidência de `samePoint`), em vez de criar uma duplicata sobreposta. */
export function findExistingJunctionAt(nodes: TopologyNode[], point: Point): string | undefined {
  return nodes.find((node) => samePoint(node.position, point))?.id;
}

/** Nós de topologia seguros de transladar junto com um arrasto de grupo (componente(s) + fio(s)
 * selecionados se movendo pelo mesmo delta, ver `main.ts::applyGroupMoveDelta`) -- um nó só é
 * "movable" se TODO fio que o toca também está em `wireIds` (selecionado). Move um nó tocado por um
 * fio de fora da seleção rasgaria aquele outro ramo (ex: T-junction com só um dos 3 ramos
 * selecionado) -- por isso a regra é conservadora: ou o nó vem inteiro com o grupo, ou fica parado e
 * os fios selecionados que o tocam esticam até ele (mesmo espírito de pino de componente não
 * selecionado). Nó sem nenhum fio tocando (órfão, não deveria existir de verdade -- ver
 * `removeOrphanNodes`) nunca é considerado movable. */
export function movableTopologyNodeIds(snapshot: TopologySnapshot, wireIds: ReadonlySet<string>): Set<string> {
  const result = new Set<string>();
  for (const node of snapshot.nodes) {
    let touchesAny = false;
    let allSelected = true;
    for (const wire of snapshot.wires) {
      if (endpointId(wire.from) !== node.id && endpointId(wire.to) !== node.id) continue;
      touchesAny = true;
      if (!wireIds.has(wire.id)) { allSelected = false; break; }
    }
    if (touchesAny && allSelected) result.add(node.id);
  }
  return result;
}

export interface SplitSegmentIds {
  junctionId: string;
  firstWireId: string;
  secondWireId: string;
}

export interface SplitSegmentResult {
  /** `undefined` quando o nó topológico já existia exatamente no ponto de split. */
  node: TopologyNode | undefined;
  firstWire: WebviewWireModel;
  secondWire: WebviewWireModel;
}

/** Divide `wireId` em `rawPoint` (projetado+snapado pro segmento mais próximo primeiro). Cria uma
 * junção nova OU reusa uma já existente exatamente naquele ponto (`findExistingJunctionAt`) --
 * nunca cria nós duplicados sobrepostos. Devolve `undefined` se `rawPoint` não projeta sobre nenhum
 * segmento do fio (nada a dividir). Pura: não muta `snapshot`, quem chama decide se/como aplicar o
 * resultado. */
export function splitSegmentAtPoint(snapshot: TopologySnapshot, wireId: string, rawPoint: Point, ids: SplitSegmentIds): SplitSegmentResult | undefined {
  const wire = snapshot.wires.find((entry) => entry.id === wireId);
  if (!wire) return undefined;
  const fullPoints = wirePolylinePoints(snapshot.components, wire, snapshot.nodes);
  if (fullPoints.length < 2) return undefined;

  let splitPoint: Point | undefined;
  for (let index = 0; index < fullPoints.length - 1; index += 1) {
    const from = fullPoints[index]!;
    const to = fullPoints[index + 1]!;
    const isHorizontal = Math.abs(from.y - to.y) < 0.5;
    const isVertical = Math.abs(from.x - to.x) < 0.5;
    if (!isHorizontal && !isVertical) continue;
    const projected = nearestSnappedPointOnOrthogonalSegment(rawPoint, from, to, WIRE_GRID_SIZE);
    if (Math.hypot(projected.x - rawPoint.x, projected.y - rawPoint.y) <= WIRE_GRID_SIZE) {
      splitPoint = projected;
      break;
    }
  }
  if (!splitPoint) return undefined;

  if (samePoint(splitPoint, fullPoints[0]!) || samePoint(splitPoint, fullPoints[fullPoints.length - 1]!)) {
    // Clique exatamente numa extremidade real do fio -- não é uma divisão de segmento, é a própria
    // extremidade (o chamador deveria ter caído no caso "pin"/"junction" do findAtPosition).
    return undefined;
  }

  const split = splitWireRouteAtPoint(fullPoints, splitPoint);
  const existingJunctionId = findExistingJunctionAt(snapshot.nodes, splitPoint);
  const junctionId = existingJunctionId ?? ids.junctionId;
  const node: TopologyNode | undefined = existingJunctionId ? undefined : { id: junctionId, position: { x: splitPoint.x, y: splitPoint.y } };

  const firstWire: WebviewWireModel = {
    id: ids.firstWireId,
    from: wire.from,
    to: nodeEndpoint(junctionId),
    points: split.first.length > 0 ? split.first : undefined,
  };
  const secondWire: WebviewWireModel = {
    id: ids.secondWireId,
    from: nodeEndpoint(junctionId),
    to: wire.to,
    points: split.second.length > 0 ? split.second : undefined,
  };
  return { node, firstWire, secondWire };
}

export type ConnectionEndpoint = { kind: "pin"; componentId: string; pinId: string } | { kind: "wire"; wireId: string; point: Point };

export interface ConnectEndpointIds {
  newWireId: string;
  nextJunctionId: () => string;
  nextWireId: () => string;
}

export interface ConnectEndpointResult {
  newNodes: TopologyNode[];
  newWires: WebviewWireModel[];
  /** Ids de fios existentes que devem ser removidos (substituídos pelas duas metades do split). */
  replacedWireIds: string[];
}

/** Unifica pino→pino, pino→meio-de-fio e meio-de-fio→meio-de-fio numa única operação -- o terceiro
 * caso é o gesto que hoje não existe (terminar uma derivação iniciada no meio de um fio sobre OUTRO
 * fio). `routePoints` são os pontos intermediários (sem as duas extremidades) do NOVO fio que liga
 * `from` a `to`, já calculados pelo chamador (roteamento em si continua responsabilidade da Webview
 * interativa). Pura: devolve só as entidades NOVAS a adicionar + ids de fios substituídos; nunca
 * muta `snapshot`. */
export function connectEndpointToNode(
  snapshot: TopologySnapshot,
  from: ConnectionEndpoint,
  to: ConnectionEndpoint,
  routePoints: Point[] | undefined,
  ids: ConnectEndpointIds
): ConnectEndpointResult {
  const newNodes: TopologyNode[] = [];
  const newWires: WebviewWireModel[] = [];
  const replacedWireIds: string[] = [];
  let working: TopologySnapshot = snapshot;

  const resolveEndpoint = (endpoint: ConnectionEndpoint): CanonicalEndpoint => {
    if (endpoint.kind === "pin") return portEndpoint(endpoint.componentId, endpoint.pinId);
    const split = splitSegmentAtPoint(working, endpoint.wireId, endpoint.point, {
      junctionId: ids.nextJunctionId(),
      firstWireId: ids.nextWireId(),
      secondWireId: ids.nextWireId(),
    });
    if (!split) {
      // Ponto não caiu sobre um segmento real (ex: já é uma extremidade) -- trata como se já fosse a
      // junção/pino existente naquela posição.
      const existing = findExistingJunctionAt(working.nodes, endpoint.point);
      if (existing) return nodeEndpoint(existing);
      throw new Error("connectEndpointToNode: ponto do meio-de-fio não corresponde a nenhum segmento nem junção existente");
    }
    if (split.node) newNodes.push(split.node);
    newWires.push(split.firstWire, split.secondWire);
    replacedWireIds.push(endpoint.wireId);
    working = {
      components: working.components,
      wires: [...working.wires.filter((wire) => wire.id !== endpoint.wireId), split.firstWire, split.secondWire],
      nodes: split.node ? [...working.nodes, split.node] : working.nodes,
    };
    return nodeEndpoint(split.node?.id ?? findExistingJunctionAt(working.nodes, endpoint.point)!);
  };

  const fromRef = resolveEndpoint(from);
  const toRef = resolveEndpoint(to);
  const connectingWire: WebviewWireModel = { id: ids.newWireId, from: fromRef, to: toRef, points: routePoints };
  newWires.push(connectingWire);

  return { newNodes, newWires, replacedWireIds };
}

/** Funde segmentos colineares entre fios DIFERENTES que se encontram num nó de grau 2 (diferente de
 * `normalizeOrthogonalPath`, que só deduplica pontos DENTRO da polilinha de um único fio) -- chamado
 * por `removeOrphanNodes` no caso de colapso, e por `normalizeWireGeometry` no load. Devolve um novo
 * snapshot; nunca muta o parâmetro. */
export function mergeCollinearSegments(snapshot: TopologySnapshot): TopologySnapshot {
  // A fusão ENTRE fios diferentes acontece dentro de `removeOrphanNodes` (colapso de grau-2, que já
  // produz o fio único mesclado). Esta função cobre o caso mais comum: pontos intermediários de UM
  // fio que viraram colineares com as extremidades REAIS dele (não só entre si) -- por isso projeta
  // a polilinha completa (`wirePolylinePoints`, com os pinos resolvidos) antes de normalizar, em vez
  // de normalizar só `wire.points` isolado (que sozinho não tem informação suficiente pra saber se um
  // ponto intermediário é colinear com o pino real ao lado dele).
  return {
    components: snapshot.components,
    nodes: snapshot.nodes,
    wires: snapshot.wires.map((wire) => {
      const full = wirePolylinePoints(snapshot.components, wire, snapshot.nodes);
      if (full.length < 2) return wire; // referência órfã -- normalizeWireGeometry cuida disso
      const normalized = normalizeOrthogonalPath(full);
      const internal = normalized.slice(1, -1);
      const current = wire.points ?? [];
      if (internal.length === current.length && internal.every((point, index) => samePoint(point, current[index]!))) return wire;
      return { ...wire, points: internal.length > 0 ? internal : undefined };
    }),
  };
}

/** Espelha `Node::checkRemove()`/`joinConns()` do SimulIDE: grau 0-1 → nó de topologia + fio
 * remanescente removidos em cascata; grau exatamente 2 → nó removido, os dois fios colapsam num
 * único fio contínuo; grau ≥3 → intocado. Roda até estabilizar (uma cascata de remoção pode deixar
 * OUTRO nó em grau ≤2). Devolve um novo snapshot; nunca muta o parâmetro. */
export function removeOrphanNodes(snapshot: TopologySnapshot): TopologySnapshot {
  let nodes = snapshot.nodes;
  let wires = snapshot.wires;

  for (let guard = 0; guard < nodes.length + 1; guard += 1) {
    const nodeIds = nodes.map((node) => node.id);
    let changed = false;

    for (const nodeId of nodeIds) {
      const node = nodes.find((entry) => entry.id === nodeId);
      if (!node) continue; // já removido nesta passada
      const touching = wires.filter((wire) => endpointId(wire.from) === nodeId || endpointId(wire.to) === nodeId);

      if (touching.length >= 3) continue;

      if (touching.length <= 1) {
        const touchingIds = new Set(touching.map((wire) => wire.id));
        wires = wires.filter((wire) => !touchingIds.has(wire.id));
        nodes = nodes.filter((entry) => entry.id !== nodeId);
        changed = true;
        continue;
      }

      // grau exatamente 2: funde as duas metades num único fio contínuo, removendo o nó.
      const [wireA, wireB] = touching as [WebviewWireModel, WebviewWireModel];
      const aEndsAtNode = endpointId(wireA.to) === nodeId;
      const bEndsAtNode = endpointId(wireB.to) === nodeId;
      const outerFrom = aEndsAtNode ? wireA.from : wireA.to;
      const outerTo = bEndsAtNode ? wireB.from : wireB.to;
      const pointsA = aEndsAtNode ? (wireA.points ?? []) : [...(wireA.points ?? [])].reverse();
      const pointsB = bEndsAtNode ? [...(wireB.points ?? [])].reverse() : (wireB.points ?? []);
      const mergedPoints = normalizeOrthogonalPath([
        ...pointsA,
        { x: node.position.x, y: node.position.y },
        ...pointsB,
      ]);

      const mergedWire: WebviewWireModel = {
        id: wireA.id,
        from: outerFrom,
        to: outerTo,
        points: mergedPoints.length > 0 ? mergedPoints : undefined,
      };

      wires = [mergedWire, ...wires.filter((wire) => wire.id !== wireA.id && wire.id !== wireB.id)];
      nodes = nodes.filter((entry) => entry.id !== nodeId);
      changed = true;
    }

    if (!changed) break;
  }

  return { components: snapshot.components, wires, nodes };
}

/** Passe de migração/autocorreção aplicado em TODO carregamento (`.lsproj` e `.lssubcircuit`):
 * deduplica nós de topologia coincidentes (funde fios pra apontar pra um só), corta fios com
 * referência órfã (id que não existe mais nem como componente nem como nó), corta fios de
 * comprimento zero (mesmo endpoint nas duas pontas), e roda `removeOrphanNodes` +
 * `mergeCollinearSegments`. Idempotente -- reaplicar sobre a própria saída não muda nada, então
 * arquivos salvos depois deste refactor nunca "regridem". */
export function normalizeWireGeometry(snapshot: TopologySnapshot): TopologySnapshot {
  const componentIds = new Set(snapshot.components.map((component) => component.id));

  // Deduplica nós de topologia coincidentes: mantém o primeiro em cada posição, redireciona fios
  // dos demais.
  const canonicalNodeIdByPosition = new Map<string, string>();
  const nodeIdRemap = new Map<string, string>();
  const dedupedNodes: TopologyNode[] = [];
  for (const node of snapshot.nodes) {
    const posKey = `${Math.round(node.position.x)}:${Math.round(node.position.y)}`;
    const canonicalId = canonicalNodeIdByPosition.get(posKey);
    if (canonicalId) {
      nodeIdRemap.set(node.id, canonicalId);
      continue;
    }
    canonicalNodeIdByPosition.set(posKey, node.id);
    dedupedNodes.push(node);
  }

  const dedupedNodeIds = new Set(dedupedNodes.map((node) => node.id));
  const remapEndpointRef = (endpoint: CanonicalEndpoint): CanonicalEndpoint => {
    if (endpoint.kind !== "node") return endpoint;
    const canonical = nodeIdRemap.get(endpoint.nodeId);
    return canonical ? nodeEndpoint(canonical) : endpoint;
  };
  const endpointStillValid = (endpoint: CanonicalEndpoint): boolean =>
    endpoint.kind === "node" ? dedupedNodeIds.has(endpoint.nodeId) : componentIds.has(endpoint.componentId);
  const sameEndpoint = (a: CanonicalEndpoint, b: CanonicalEndpoint): boolean =>
    a.kind === b.kind && (a.kind === "node" ? a.nodeId === (b as { kind: "node"; nodeId: string }).nodeId
      : a.componentId === (b as { kind: "port"; componentId: string; pinId: string }).componentId && a.pinId === (b as { kind: "port"; componentId: string; pinId: string }).pinId);

  const cleanedWires: WebviewWireModel[] = [];
  for (const wire of snapshot.wires) {
    if (!endpointStillValid(wire.from) || !endpointStillValid(wire.to)) continue; // referência órfã
    const from = remapEndpointRef(wire.from);
    const to = remapEndpointRef(wire.to);
    if (!endpointStillValid(from) || !endpointStillValid(to)) continue; // remapeou pra algo que também sumiu
    if (sameEndpoint(from, to)) continue; // comprimento zero (mesmo endpoint nas duas pontas)
    const points = wire.points && wire.points.length > 0 ? normalizeOrthogonalPath(wire.points) : wire.points;
    cleanedWires.push({ ...wire, from, to, points: points && points.length > 0 ? points : undefined });
  }

  const merged = mergeCollinearSegments({ components: snapshot.components, wires: cleanedWires, nodes: dedupedNodes });
  return removeOrphanNodes(merged);
}

export interface ElectricalProject {
  wires: WebviewWireModel[];
  topologyNodes: TopologyNode[];
}

/** Achata o grafo canônico (portas + nós de topologia) numa árvore de arestas entre pinos reais. Nó
 * de topologia nunca vira componente/aresta crua enviada ao Core -- N portas na mesma rede exigem só
 * N-1 arestas (estrela a partir da primeira porta encontrada). Determinístico por rede não tocada:
 * uma rede cujos membros não mudaram produz sempre os mesmos N-1 arestas, o que é o que permite
 * `diffElectricalEdges` ficar restrito só à(s) rede(s) que uma edição de fato tocou (`.spec` seção
 * 25.1). */
export function electricalEdgesForProject(project: ElectricalProject): WebviewWireModel[] {
  const keyOf = (endpoint: CanonicalEndpoint): string => endpoint.kind === "node" ? `n:${endpoint.nodeId}` : `p:${JSON.stringify([endpoint.componentId, endpoint.pinId])}`;
  const vertices = new Map<string, CanonicalEndpoint>();
  const adjacency = new Map<string, Set<string>>();
  for (const wire of project.wires) {
    const ka = keyOf(wire.from); const kb = keyOf(wire.to);
    vertices.set(ka, wire.from); vertices.set(kb, wire.to);
    (adjacency.get(ka) ?? (adjacency.set(ka, new Set()), adjacency.get(ka)!)).add(kb);
    (adjacency.get(kb) ?? (adjacency.set(kb, new Set()), adjacency.get(kb)!)).add(ka);
  }
  const seen = new Set<string>(); const edges: WebviewWireModel[] = []; let edgeIndex = 0;
  for (const start of vertices.keys()) {
    if (seen.has(start)) continue;
    const queue = [start]; seen.add(start); const ports: CanonicalEndpoint[] = [];
    while (queue.length) {
      const key = queue.pop()!; const vertex = vertices.get(key)!;
      if (vertex.kind === "port") ports.push(vertex);
      for (const next of adjacency.get(key) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    const root = ports[0]; if (!root) continue;
    for (const port of ports.slice(1)) edges.push({ id: `electrical-${edgeIndex++}`, from: root, to: port });
  }
  return edges;
}

function electricalEdgeKey(wire: WebviewWireModel): string {
  const a = `${endpointId(wire.from)}::${endpointPinId(wire.from)}`;
  const b = `${endpointId(wire.to)}::${endpointPinId(wire.to)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Diff de duas listas JÁ ACHATADAS (saída de `electricalEdgesForProject`) por identidade de par de
 * pinos reais, não por id sintético (`electrical-N` muda de índice a cada recomputação, nunca é
 * estável entre chamadas). Usado pra rotear conexão/edição de fio pela transação atômica do Core
 * (`applyWireTopologyTransaction`) em vez de `queueCoreRebuild()` -- ver `.spec` seção 25.1: o diff
 * fica naturalmente restrito à(s) rede(s) tocada(s) pela edição. */
export function diffElectricalEdges(
  before: WebviewWireModel[],
  after: WebviewWireModel[]
): { connect: WebviewWireModel[]; disconnect: WebviewWireModel[] } {
  const beforeByKey = new Map(before.map((wire) => [electricalEdgeKey(wire), wire]));
  const afterByKey = new Map(after.map((wire) => [electricalEdgeKey(wire), wire]));
  const disconnect = [...beforeByKey.entries()].filter(([key]) => !afterByKey.has(key)).map(([, wire]) => wire);
  const connect = [...afterByKey.entries()].filter(([key]) => !beforeByKey.has(key)).map(([, wire]) => wire);
  return { connect, disconnect };
}

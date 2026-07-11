/** Fonte única de verdade pra topologia de fios/junções -- pontos, segmentos, nós de junção e redes
 * elétricas, tudo como funções puras sobre `{components, wires}` (sem DOM, sem `vscode.*`). Importado
 * tanto pela Webview (`main.ts`, interação/render) quanto pelo Extension host (`extension.ts`, IPC +
 * persistência) -- ver `.spec` seção sobre o refactor de fios pra contexto completo do porquê este
 * módulo existe (bola laranja permanente, ausência de gesto "derivar do meio do fio", junção órfã
 * nunca limpa, etc).
 *
 * Cada junção (`JUNCTION_TYPE_ID`) tem SEMPRE exatamente 1 pino (`"pin-1"`) compartilhado por N fios
 * -- desvio deliberado do `Node` de 3 pinos fixos do SimulIDE (que só existe lá por limitação de
 * `QGraphicsItem` filho fixo); aqui basta contar quantos fios referenciam aquele componentId pra saber
 * o grau, sem cap nenhum. */

import {
  Point,
  WIRE_GRID_SIZE,
  buildOrthogonalPath,
  nearestSnappedPointOnOrthogonalSegment,
  normalizeOrthogonalPath,
  samePoint,
  splitWireRouteAtPoint,
} from "./wireGeometry.js";
import { JUNCTION_TYPE_ID, WebviewComponentModel, WebviewWireModel } from "./model.js";
import { componentBox, componentLocalOrigin, pinLocalPosition } from "./componentSymbols.js";
import { WireSpatialIndex } from "./wireSpatialIndex.js";

export interface TopologySnapshot {
  components: WebviewComponentModel[];
  wires: WebviewWireModel[];
  nodes?: Array<{ id: string; x: number; y: number }>;
}

type WirePinRef = { componentId: string; pinId: string };

/** Espelha `componentPinLocalPosition`/`pinScenePosition` de `main.ts` (mesma matemática de
 * box/origem/flip/rotação), reimplementado aqui pra que este módulo funcione tanto no host
 * (`extension.ts`, sem os outros helpers locais de `main.ts`) quanto na Webview, sem forçar
 * `main.ts` a mudar a assinatura das suas próprias funções (usadas em dezenas de call sites já
 * testados). Pequena duplicação deliberada de ~15 linhas de matemática pura -- ver docstring do
 * módulo. */
function flipLocalPoint(local: Point, box: { width: number; height: number }, flipH: boolean, flipV: boolean, origin?: Point): Point {
  const pivot = origin ?? { x: box.width / 2, y: box.height / 2 };
  return {
    x: flipH ? pivot.x - (local.x - pivot.x) : local.x,
    y: flipV ? pivot.y - (local.y - pivot.y) : local.y,
  };
}

function rotateLocalPoint(local: Point, box: { width: number; height: number }, rotation: 0 | 90 | 180 | 270, origin?: Point): Point {
  const pivot = origin ?? { x: box.width / 2, y: box.height / 2 };
  const cx = pivot.x;
  const cy = pivot.y;
  const dx = local.x - cx;
  const dy = local.y - cy;
  switch (rotation) {
    case 90:
      return { x: cx - dy, y: cy + dx };
    case 180:
      return { x: cx - dx, y: cy - dy };
    case 270:
      return { x: cx + dy, y: cy - dx };
    default:
      return { x: cx + dx, y: cy + dy };
  }
}

/** Posição em cena (canvas) do pino `pinId` do componente `componentId`, ou `undefined` se o
 * componente/pino não existir em `components`. */
export function pinScenePosition(components: WebviewComponentModel[], componentId: string, pinId: string, nodes: TopologySnapshot["nodes"] = []): Point | undefined {
  const component = components.find((entry) => entry.id === componentId);
  if (!component) {
    const node = nodes?.find((entry) => entry.id === componentId);
    return node && pinId === "pin-1" ? { x: node.x, y: node.y } : undefined;
  }
  const pinIndex = component.pins.findIndex((pin) => pin.id === pinId);
  if (pinIndex < 0) return undefined;
  const box = componentBox(component.typeId, component.properties);
  const origin = componentLocalOrigin(component.typeId, component.properties);
  const base = pinLocalPosition(component.pins[pinIndex]?.id ?? "", pinIndex, component.pins.length, component.typeId, component.properties);
  const flipped = flipLocalPoint(base, box, Boolean(component.flipH), Boolean(component.flipV), origin);
  const rotated = rotateLocalPoint(flipped, box, component.rotation, origin);
  return { x: component.x + rotated.x, y: component.y + rotated.y };
}

/** Polilinha completa do fio (com as duas extremidades reais resolvidas), ou `[]` se algum dos dois
 * pinos não existir mais (referência órfã -- ver `normalizeWireGeometry`). */
export function wirePolylinePoints(components: WebviewComponentModel[], wire: WebviewWireModel, nodes: TopologySnapshot["nodes"] = []): Point[] {
  const fromPos = pinScenePosition(components, wire.from.componentId, wire.from.pinId, nodes);
  const toPos = pinScenePosition(components, wire.to.componentId, wire.to.pinId, nodes);
  if (!fromPos || !toPos) return [];
  return buildOrthogonalPath([fromPos, ...(wire.points ?? []), toPos]);
}

/** Quantos fios distintos tocam `componentId` (como `from` ou `to`) -- a base de tudo relacionado a
 * grau de junção. Não é um valor armazenado: sempre recalculado a partir de `wires`, pra nunca poder
 * divergir da realidade (requisito explícito do usuário). */
export function wireDegree(wires: WebviewWireModel[], componentId: string): number {
  let count = 0;
  for (const wire of wires) {
    if (wire.from.componentId === componentId) count += 1;
    if (wire.to.componentId === componentId) count += 1;
  }
  return count;
}

/** Uma junção só tem significado elétrico visível quando tem 3+ fios (T ou mais) -- grau 0/1/2 são
 * candidatos a `removeOrphanNodes` (órfã, ou passagem reta sem entroncamento real) e NUNCA devem
 * desenhar o marcador de nó (a "bola laranja" do bug original era desenhada incondicionalmente,
 * ignorando isso por completo). */
export function isJunctionVisible(wires: WebviewWireModel[], componentId: string): boolean {
  return wireDegree(wires, componentId) >= 3;
}

/** Reusa uma junção já existente exatamente na posição `point` (mesma tolerância de coincidência de
 * `samePoint`), em vez de criar uma duplicata sobreposta. */
export function findExistingJunctionAt(components: WebviewComponentModel[], point: Point, nodes: TopologySnapshot["nodes"] = []): string | undefined {
  const found = components.find((component) => component.typeId === JUNCTION_TYPE_ID && samePoint({ x: component.x, y: component.y }, point));
  return found?.id ?? nodes?.find((node) => samePoint({ x: node.x, y: node.y }, point))?.id;
}

export type HitTestResult =
  | { kind: "pin"; componentId: string; pinId: string; point: Point }
  | { kind: "junction"; componentId: string; point: Point }
  | { kind: "segment"; wireId: string; segmentIndex: number; point: Point }
  | { kind: "empty" };

/** Hit-test único com prioridade pino > junção/canto existente > segmento > vazio -- usado de forma
 * IDÊNTICA tanto pra iniciar quanto pra terminar uma derivação, pra que os dois gestos nunca possam
 * discordar sobre o que foi clicado (bug antigo: `wireConnectCornerIndexLikeSimulIDE` só era chamado
 * ao TERMINAR, nunca ao iniciar). `toleranceCanvasPx` casa com a tolerância de snap de canto já usada
 * em `main.ts` (`WIRE_GRID_SIZE` = 8px). */
export function buildWireSpatialIndex(snapshot: TopologySnapshot, cellSize = 64): WireSpatialIndex {
  const index = new WireSpatialIndex(cellSize);
  for (const component of snapshot.components) for (const pin of component.pins) {
    const point = pinScenePosition(snapshot.components, component.id, pin.id, snapshot.nodes);
    if (point) index.upsertConnectionPoint({ id: `${component.id}:${pin.id}`, kind: component.typeId === JUNCTION_TYPE_ID ? "junction" : "pin", componentId: component.id, pinId: pin.id, point });
  }
  for (const node of snapshot.nodes ?? []) index.upsertConnectionPoint({ id: `${node.id}:pin-1`, kind: "junction", componentId: node.id, pinId: "pin-1", point: { x: node.x, y: node.y } });
  for (const wire of snapshot.wires) index.upsertWire(wire.id, wirePolylinePoints(snapshot.components, wire, snapshot.nodes));
  return index;
}

export function findAtPosition(snapshot: TopologySnapshot, scenePoint: Point, toleranceCanvasPx: number = WIRE_GRID_SIZE, spatialIndex?: WireSpatialIndex): HitTestResult {
  if (spatialIndex) {
    const points = spatialIndex.queryConnectionPoints(scenePoint, toleranceCanvasPx).sort((a, b) => (a.kind === "pin" ? 0 : 1) - (b.kind === "pin" ? 0 : 1));
    const hit = points[0];
    if (hit) return hit.kind === "junction"
      ? { kind: "junction", componentId: hit.componentId, point: hit.point }
      : { kind: "pin", componentId: hit.componentId, pinId: hit.pinId!, point: hit.point };
  } else for (const component of snapshot.components) {
    for (const pin of component.pins) {
      const pos = pinScenePosition(snapshot.components, component.id, pin.id, snapshot.nodes);
      if (!pos) continue;
      if (Math.hypot(pos.x - scenePoint.x, pos.y - scenePoint.y) <= toleranceCanvasPx) {
        if (component.typeId === JUNCTION_TYPE_ID) return { kind: "junction", componentId: component.id, point: pos };
        return { kind: "pin", componentId: component.id, pinId: pin.id, point: pos };
      }
    }
  }

  const candidates = spatialIndex ? spatialIndex.queryPoint(scenePoint, toleranceCanvasPx) : snapshot.wires.flatMap((wire) => {
    const points = wirePolylinePoints(snapshot.components, wire, snapshot.nodes);
    return points.slice(0, -1).map((from, segmentIndex) => ({ wireId: wire.id, segmentIndex, from, to: points[segmentIndex + 1]! }));
  });
  for (const candidate of candidates) {
      const from = candidate.from;
      const to = candidate.to;
      const isHorizontal = Math.abs(from.y - to.y) < 0.5;
      const isVertical = Math.abs(from.x - to.x) < 0.5;
      if (!isHorizontal && !isVertical) continue;
      const projected = nearestSnappedPointOnOrthogonalSegment(scenePoint, from, to, WIRE_GRID_SIZE);
      if (Math.hypot(projected.x - scenePoint.x, projected.y - scenePoint.y) <= toleranceCanvasPx) {
        return { kind: "segment", wireId: candidate.wireId, segmentIndex: candidate.segmentIndex, point: projected };
      }
  }

  return { kind: "empty" };
}

export interface SplitSegmentIds {
  junctionId: string;
  firstWireId: string;
  secondWireId: string;
}

export interface SplitSegmentResult {
  /** `undefined` quando o nó topológico já existia exatamente no ponto de split. */
  node: { id: string; x: number; y: number } | undefined;
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
  const existingJunctionId = findExistingJunctionAt(snapshot.components, splitPoint, snapshot.nodes);
  const junctionId = existingJunctionId ?? ids.junctionId;
  const node = existingJunctionId ? undefined : { id: junctionId, x: splitPoint.x, y: splitPoint.y };

  const firstWire: WebviewWireModel = {
    id: ids.firstWireId,
    from: wire.from,
    to: { componentId: junctionId, pinId: "pin-1" },
    points: split.first.length > 0 ? split.first : undefined,
  };
  const secondWire: WebviewWireModel = {
    id: ids.secondWireId,
    from: { componentId: junctionId, pinId: "pin-1" },
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
  newNodes: Array<{ id: string; x: number; y: number }>;
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
  const newNodes: Array<{ id: string; x: number; y: number }> = [];
  const newWires: WebviewWireModel[] = [];
  const replacedWireIds: string[] = [];
  let working: TopologySnapshot = snapshot;

  const resolveEndpoint = (endpoint: ConnectionEndpoint): WirePinRef => {
    if (endpoint.kind === "pin") return { componentId: endpoint.componentId, pinId: endpoint.pinId };
    const split = splitSegmentAtPoint(working, endpoint.wireId, endpoint.point, {
      junctionId: ids.nextJunctionId(),
      firstWireId: ids.nextWireId(),
      secondWireId: ids.nextWireId(),
    });
    if (!split) {
      // Ponto não caiu sobre um segmento real (ex: já é uma extremidade) -- trata como se já fosse a
      // junção/pino existente naquela posição.
      const existing = findExistingJunctionAt(working.components, endpoint.point, working.nodes);
      if (existing) return { componentId: existing, pinId: "pin-1" };
      throw new Error("connectEndpointToNode: ponto do meio-de-fio não corresponde a nenhum segmento nem junção existente");
    }
    if (split.node) newNodes.push(split.node);
    newWires.push(split.firstWire, split.secondWire);
    replacedWireIds.push(endpoint.wireId);
    working = {
      components: working.components,
      wires: [...working.wires.filter((wire) => wire.id !== endpoint.wireId), split.firstWire, split.secondWire],
      nodes: split.node ? [...(working.nodes ?? []), split.node] : working.nodes,
    };
    return { componentId: split.node?.id ?? findExistingJunctionAt(working.components, endpoint.point, working.nodes)!, pinId: "pin-1" };
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
    wires: snapshot.wires.map((wire) => {
      const full = wirePolylinePoints(snapshot.components, wire);
      if (full.length < 2) return wire; // referência órfã -- normalizeWireGeometry cuida disso
      const normalized = normalizeOrthogonalPath(full);
      const internal = normalized.slice(1, -1);
      const current = wire.points ?? [];
      if (internal.length === current.length && internal.every((point, index) => samePoint(point, current[index]!))) return wire;
      return { ...wire, points: internal.length > 0 ? internal : undefined };
    }),
  };
}

/** Espelha `Node::checkRemove()`/`joinConns()` do SimulIDE: grau 0-1 → junção + fio remanescente
 * removidos em cascata; grau exatamente 2 → junção removida, os dois fios colapsam num único fio
 * contínuo; grau ≥3 → intocado. Roda até estabilizar (uma cascata de remoção pode deixar OUTRA
 * junção em grau ≤2). Devolve um novo snapshot; nunca muta o parâmetro. */
export function removeOrphanNodes(snapshot: TopologySnapshot): TopologySnapshot {
  let components = snapshot.components;
  let wires = snapshot.wires;

  for (let guard = 0; guard < components.length + 1; guard += 1) {
    const junctionIds = components.filter((component) => component.typeId === JUNCTION_TYPE_ID).map((component) => component.id);
    let changed = false;

    for (const junctionId of junctionIds) {
      if (!components.some((component) => component.id === junctionId)) continue; // já removida nesta passada
      const touching = wires.filter((wire) => wire.from.componentId === junctionId || wire.to.componentId === junctionId);

      if (touching.length >= 3) continue;

      if (touching.length <= 1) {
        const touchingIds = new Set(touching.map((wire) => wire.id));
        wires = wires.filter((wire) => !touchingIds.has(wire.id));
        components = components.filter((component) => component.id !== junctionId);
        changed = true;
        continue;
      }

      // grau exatamente 2: funde as duas metades num único fio contínuo, removendo a junção.
      const [wireA, wireB] = touching as [WebviewWireModel, WebviewWireModel];
      const aEndsAtJunction = wireA.to.componentId === junctionId;
      const bEndsAtJunction = wireB.to.componentId === junctionId;
      const outerFrom = aEndsAtJunction ? wireA.from : wireA.to;
      const outerTo = bEndsAtJunction ? wireB.from : wireB.to;
      const pointsA = aEndsAtJunction ? (wireA.points ?? []) : [...(wireA.points ?? [])].reverse();
      const pointsB = bEndsAtJunction ? [...(wireB.points ?? [])].reverse() : (wireB.points ?? []);
      const junctionComponent = components.find((component) => component.id === junctionId);
      const mergedPoints = normalizeOrthogonalPath([
        ...pointsA,
        ...(junctionComponent ? [{ x: junctionComponent.x, y: junctionComponent.y }] : []),
        ...pointsB,
      ]);

      const mergedWire: WebviewWireModel = {
        id: wireA.id,
        from: outerFrom,
        to: outerTo,
        points: mergedPoints.length > 0 ? mergedPoints : undefined,
      };

      wires = [mergedWire, ...wires.filter((wire) => wire.id !== wireA.id && wire.id !== wireB.id)];
      components = components.filter((component) => component.id !== junctionId);
      changed = true;
    }

    if (!changed) break;
  }

  return { components, wires };
}

/** União-busca pura sobre `(componentId,pinId)`, espelhando o `UnionFind` de `Netlist.hpp` do lado
 * TS -- usado pra validar que a rede que o Core recebeu bate com a conectividade exibida na tela, e
 * pros testes de "cruzamento sem junção fica eletricamente separado". Chave do mapa devolvido:
 * `${componentId}:${pinId}`. */
export function rebuildElectricalNet(snapshot: TopologySnapshot): Map<string, string> {
  const parent = new Map<string, string>();
  const key = (componentId: string, pinId: string): string => `${componentId}:${pinId}`;

  const find = (node: string): string => {
    let root = node;
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(node, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (const wire of snapshot.wires) {
    union(key(wire.from.componentId, wire.from.pinId), key(wire.to.componentId, wire.to.pinId));
  }

  const result = new Map<string, string>();
  for (const node of parent.keys()) result.set(node, find(node));
  return result;
}

/** Passe de migração/autocorreção aplicado em TODO carregamento (`.lsproj` e `.lssubcircuit`):
 * deduplica junções coincidentes (funde fios pra apontar pra uma só), corta fios com referência
 * órfã (componentId/pinId que não existe mais), corta fios de comprimento zero (mesmo pino nas duas
 * pontas), força os invariantes de junção (`hidden:true`, exatamente 1 pino `"pin-1"`), e roda
 * `removeOrphanNodes` + `mergeCollinearSegments`. Idempotente -- reaplicar sobre a própria saída não
 * muda nada, então arquivos salvos depois deste refactor nunca "regridem". */
export function normalizeWireGeometry(snapshot: TopologySnapshot): TopologySnapshot {
  const componentIds = new Set(snapshot.components.map((component) => component.id));

  const componentsWithFixedJunctions = snapshot.components.map((component) => {
    if (component.typeId !== JUNCTION_TYPE_ID) return component;
    if (component.hidden === true && component.pins.length === 1 && component.pins[0]?.id === "pin-1") return component;
    return { ...component, hidden: true, pins: [{ id: "pin-1", x: 0, y: 0 }] };
  });

  // Deduplica junções coincidentes: mantém a primeira em cada posição, redireciona fios das demais.
  const canonicalJunctionIdByPosition = new Map<string, string>();
  const junctionIdRemap = new Map<string, string>();
  const dedupedComponents: WebviewComponentModel[] = [];
  for (const component of componentsWithFixedJunctions) {
    if (component.typeId !== JUNCTION_TYPE_ID) {
      dedupedComponents.push(component);
      continue;
    }
    const posKey = `${Math.round(component.x)}:${Math.round(component.y)}`;
    const canonicalId = canonicalJunctionIdByPosition.get(posKey);
    if (canonicalId) {
      junctionIdRemap.set(component.id, canonicalId);
      continue;
    }
    canonicalJunctionIdByPosition.set(posKey, component.id);
    dedupedComponents.push(component);
  }

  const remapRef = (ref: { componentId: string; pinId: string }): { componentId: string; pinId: string } => {
    const canonical = junctionIdRemap.get(ref.componentId);
    return canonical ? { componentId: canonical, pinId: ref.pinId } : ref;
  };

  const dedupedComponentIds = new Set(dedupedComponents.map((component) => component.id));
  const cleanedWires: WebviewWireModel[] = [];
  for (const wire of snapshot.wires) {
    const from = remapRef(wire.from);
    const to = remapRef(wire.to);
    if (!componentIds.has(wire.from.componentId) || !componentIds.has(wire.to.componentId)) continue; // referência órfã
    if (!dedupedComponentIds.has(from.componentId) || !dedupedComponentIds.has(to.componentId)) continue;
    if (from.componentId === to.componentId && from.pinId === to.pinId) continue; // comprimento zero (mesmo pino nas duas pontas)
    const points = wire.points && wire.points.length > 0 ? normalizeOrthogonalPath(wire.points) : wire.points;
    cleanedWires.push({ ...wire, from, to, points: points && points.length > 0 ? points : undefined });
  }

  const merged = mergeCollinearSegments({ components: dedupedComponents, wires: cleanedWires });
  return removeOrphanNodes(merged);
}

export interface ElectricalProject {
  wires: WebviewWireModel[];
  topologyNodes?: Array<{ id: string; x: number; y: number }>;
}

/** Achata o grafo canônico (portas + nós de topologia) numa árvore de arestas entre pinos reais. Nó
 * de topologia nunca vira componente/aresta crua enviada ao Core -- N portas na mesma rede exigem só
 * N-1 arestas (estrela a partir da primeira porta encontrada). Determinístico por rede não tocada:
 * uma rede cujos membros não mudaram produz sempre os mesmos N-1 arestas, o que é o que permite
 * `diffElectricalEdges` ficar restrito só à(s) rede(s) que uma edição de fato tocou (EX-F). */
export function electricalEdgesForProject(project: ElectricalProject): WebviewWireModel[] {
  type Vertex = { kind: "port"; componentId: string; pinId: string } | { kind: "node"; nodeId: string };
  const vertices = new Map<string, Vertex>();
  const adjacency = new Map<string, Set<string>>();
  const nodeIds = new Set((project.topologyNodes ?? []).map((node) => node.id));
  const vertexFor = (ref: { componentId: string; pinId: string }): Vertex => nodeIds.has(ref.componentId)
    ? { kind: "node", nodeId: ref.componentId }
    : { kind: "port", componentId: ref.componentId, pinId: ref.pinId };
  const keyOf = (vertex: Vertex): string => vertex.kind === "node" ? `n:${vertex.nodeId}` : `p:${JSON.stringify([vertex.componentId, vertex.pinId])}`;
  for (const wire of project.wires) {
    const a = vertexFor(wire.from); const b = vertexFor(wire.to); const ka = keyOf(a); const kb = keyOf(b);
    vertices.set(ka, a); vertices.set(kb, b);
    (adjacency.get(ka) ?? (adjacency.set(ka, new Set()), adjacency.get(ka)!)).add(kb);
    (adjacency.get(kb) ?? (adjacency.set(kb, new Set()), adjacency.get(kb)!)).add(ka);
  }
  const seen = new Set<string>(); const edges: WebviewWireModel[] = []; let edgeIndex = 0;
  for (const start of vertices.keys()) {
    if (seen.has(start)) continue;
    const queue = [start]; seen.add(start); const ports: Array<{ componentId: string; pinId: string }> = [];
    while (queue.length) {
      const key = queue.pop()!; const vertex = vertices.get(key)!;
      if (vertex.kind === "port") ports.push({ componentId: vertex.componentId, pinId: vertex.pinId });
      for (const next of adjacency.get(key) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    const root = ports[0]; if (!root) continue;
    for (const port of ports.slice(1)) edges.push({ id: `electrical-${edgeIndex++}`, from: root, to: port });
  }
  return edges;
}

function electricalEdgeKey(wire: WebviewWireModel): string {
  const a = `${wire.from.componentId}::${wire.from.pinId}`;
  const b = `${wire.to.componentId}::${wire.to.pinId}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Diff de duas listas JÁ ACHATADAS (saída de `electricalEdgesForProject`) por identidade de par de
 * pinos reais, não por id sintético (`electrical-N` muda de índice a cada recomputação, nunca é
 * estável entre chamadas). Usado pra rotear conexão/edição de fio pela transação atômica do Core
 * (`applyWireTopologyTransaction`) em vez de `queueCoreRebuild()` -- ver `.spec` seção sobre o
 * roteamento EX-F: o diff fica naturalmente restrito à(s) rede(s) tocada(s) pela edição. */
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

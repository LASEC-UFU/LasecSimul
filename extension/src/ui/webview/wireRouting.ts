/** Motor de rota ortogonal dos fios -- puro (sem DOM, sem `vscode.*`), compartilhado pela Webview
 * (interação/render) e pelo Extension host (persistência/Core).
 *
 * O comportamento segue o do SimulIDE, levantado pela operação do programa e pela leitura de
 * `connector.cpp`/`connectorline.cpp`/`node.cpp` (ver `docs/48-reengenharia-conexoes-simulide.md`);
 * a implementação é própria. Três regras resumem tudo:
 *
 * 1. **Um fio é o que foi desenhado.** A rota é a lista de cantos gravada no fio. Nada é
 *    recalculado por um roteador automático a cada render.
 * 2. **O "L" tem memória.** Entre o último ponto fixo e o cursor existe no máximo um canto. O eixo da
 *    primeira perna é escolhido quando o cursor deixa de estar alinhado com esse ponto fixo (eixo
 *    dominante do deslocamento) e fica travado até o cursor realinhar -- o canto desliza, nunca
 *    "vira" sozinho no meio do movimento.
 * 3. **Mover uma ponta só mexe na ponta.** Quando um pino ou nó se move, o canto vizinho desliza ao
 *    longo do eixo do segmento seguinte para manter tudo ortogonal; o resto da rota fica onde está.
 */

import { Point, WIRE_GRID_SIZE } from "./wireGeometry.js";

export type LegAxis = "h" | "v";

const EPSILON = 0.5;

const sameX = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < EPSILON;
const sameY = (a: Point, b: Point): boolean => Math.abs(a.y - b.y) < EPSILON;
const coincident = (a: Point, b: Point): boolean => sameX(a, b) && sameY(a, b);
const copy = (point: Point): Point => ({ x: point.x, y: point.y });

/** `true` se todo segmento consecutivo é horizontal ou vertical. */
export function isOrthogonalPath(points: readonly Point[]): boolean {
  for (let index = 0; index + 1 < points.length; index += 1) {
    if (!sameX(points[index]!, points[index + 1]!) && !sameY(points[index]!, points[index + 1]!)) return false;
  }
  return true;
}

/** Remove pontos repetidos e cantos sem função (três pontos na mesma reta), preservando as duas
 * pontas. Repete até estabilizar: tirar um canto pode alinhar os vizinhos (ex.: um "dente" de ida e
 * volta sobre a mesma reta desaparece inteiro). */
export function simplifyWirePath(points: readonly Point[]): Point[] {
  let current = points.map(copy);
  for (let guard = 0; guard <= points.length; guard += 1) {
    const deduped: Point[] = [];
    for (let index = 0; index < current.length; index += 1) {
      const point = current[index]!;
      const previous = deduped[deduped.length - 1];
      if (previous && coincident(previous, point)) {
        // Mantém a coordenada exata da ÚLTIMA ponta (pino/nó real), nunca a de um canto vizinho.
        if (index === current.length - 1) deduped[deduped.length - 1] = point;
        continue;
      }
      deduped.push(point);
    }
    const next: Point[] = [];
    for (let index = 0; index < deduped.length; index += 1) {
      const point = deduped[index]!;
      const before = next[next.length - 1];
      const after = deduped[index + 1];
      if (before && after && ((sameX(before, point) && sameX(point, after)) || (sameY(before, point) && sameY(point, after)))) continue;
      next.push(point);
    }
    if (next.length === current.length) return next;
    current = next;
  }
  return current;
}

/** Rota padrão entre duas pontas sem nenhum canto gravado: reta se alinhadas, senão um "L" cuja
 * primeira perna sai pelo eixo pedido (ou pelo eixo dominante do deslocamento). */
export function defaultWirePath(from: Point, to: Point, firstAxis?: LegAxis): Point[] {
  if (sameX(from, to) || sameY(from, to)) return [copy(from), copy(to)];
  const axis = firstAxis ?? (Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? "h" : "v");
  const corner = axis === "h" ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
  return [copy(from), corner, copy(to)];
}

/** Desliza o canto vizinho de uma ponta que saiu do lugar. `corner` é o canto, `beyond` o ponto
 * seguinte (define o eixo do segmento que o canto pode percorrer). */
function slideCornerToward(end: Point, corner: Point, beyond: Point): Point {
  if (sameX(corner, beyond) && !sameY(corner, beyond)) return { x: corner.x, y: end.y };
  if (sameY(corner, beyond) && !sameX(corner, beyond)) return { x: end.x, y: corner.y };
  // Segmento seguinte degenerado: aproxima pelo eixo em que a ponta está mais perto do canto.
  return Math.abs(corner.x - end.x) >= Math.abs(corner.y - end.y) ? { x: corner.x, y: end.y } : { x: end.x, y: corner.y };
}

/** Polilinha completa de um fio a partir das duas pontas ATUAIS e dos cantos gravados.
 *
 * Os cantos gravados valem como estão; só os dois cantos vizinhos às pontas se ajustam quando a
 * ponta não está mais alinhada com eles (componente/nó movido, girado, espelhado). O resultado não
 * depende do caminho que a ponta percorreu -- arrastar e voltar devolve exatamente a rota original.
 * `firstAxis` só é usado quando não há canto gravado nenhum. */
export function resolveWirePath(from: Point, interior: readonly Point[] | undefined, to: Point, firstAxis?: LegAxis): Point[] {
  if (!interior || interior.length === 0) return defaultWirePath(from, to, firstAxis);
  const points = interior.map(copy);
  const direct = [copy(from), ...points, copy(to)];
  if (isOrthogonalPath(direct)) return simplifyWirePath(direct);

  if (points.length === 1) {
    const corner = points[0]!;
    if (coincident(corner, from) || coincident(corner, to)) return defaultWirePath(from, to, firstAxis);
    // O canto único guarda a orientação do "L": divide y com a origem (1ª perna horizontal) ou x.
    const horizontalFirst = sameY(from, corner) || sameX(corner, to);
    const verticalFirst = sameX(from, corner) || sameY(corner, to);
    const axis: LegAxis = horizontalFirst !== verticalFirst
      ? (horizontalFirst ? "h" : "v")
      : (Math.abs(corner.x - from.x) >= Math.abs(corner.y - from.y) ? "h" : "v");
    return simplifyWirePath(defaultWirePath(from, to, axis));
  }

  if (!sameX(from, points[0]!) && !sameY(from, points[0]!)) points[0] = slideCornerToward(from, points[0]!, points[1]!);
  const last = points.length - 1;
  if (!sameX(points[last]!, to) && !sameY(points[last]!, to)) points[last] = slideCornerToward(to, points[last]!, points[last - 1]!);

  // Diagonal ENTRE cantos gravados só existe em dado corrompido/legado -- insere um cotovelo
  // determinístico em vez de desenhar torto.
  const full: Point[] = [copy(from)];
  for (const point of [...points, copy(to)]) {
    const previous = full[full.length - 1]!;
    if (!sameX(previous, point) && !sameY(previous, point)) full.push({ x: point.x, y: previous.y });
    full.push(point);
  }
  return simplifyWirePath(full);
}

/** Cantos a gravar no fio para que ele continue com a forma de `full` (sem as duas pontas). */
export function interiorOfPath(full: readonly Point[]): Point[] {
  return simplifyWirePath(full).slice(1, -1).map(copy);
}

/** Translada os cantos de um fio que se move inteiro (as duas pontas pelo mesmo delta). */
export function translatePoints(points: readonly Point[], dx: number, dy: number): Point[] {
  return points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
}

// ── Rascunho de um fio em desenho ────────────────────────────────────────────────────────────────

export interface WireDraft {
  /** Pontos fixos: a origem e os cantos já confirmados por clique. Nunca vazio. */
  readonly anchors: readonly Point[];
  /** Eixo travado da primeira perna do "L" elástico; `undefined` enquanto o trecho é uma reta. */
  readonly axis?: LegAxis;
  /** Ponta livre (já encaixada na grade ou no alvo magnético). */
  readonly cursor: Point;
}

export function startWireDraft(origin: Point): WireDraft {
  return { anchors: [copy(origin)], cursor: copy(origin) };
}

/** Encaixa o cursor na grade RELATIVA ao último ponto fixo. Pinos nem sempre caem na grade
 * global (ex.: y=244,5); encaixar relativo garante que "alinhado com a origem" seja exato e que
 * nunca sobre um degrau de poucos pixels entre o fio e o pino de onde ele sai. */
export function snapToDraftGrid(draft: WireDraft, raw: Point, step: number = WIRE_GRID_SIZE): Point {
  const origin = draft.anchors[draft.anchors.length - 1]!;
  return {
    x: origin.x + Math.round((raw.x - origin.x) / step) * step,
    y: origin.y + Math.round((raw.y - origin.y) / step) * step,
  };
}

/** Move a ponta livre. Alinhado com o último ponto fixo -> reta (e o eixo é esquecido). Ao sair do
 * alinhamento, o eixo dominante do deslocamento vira a primeira perna e fica travado. */
export function moveWireDraft(draft: WireDraft, cursor: Point): WireDraft {
  const origin = draft.anchors[draft.anchors.length - 1]!;
  if (sameX(origin, cursor) || sameY(origin, cursor)) return { anchors: draft.anchors, cursor: copy(cursor) };
  const axis = draft.axis ?? (Math.abs(cursor.x - origin.x) > Math.abs(cursor.y - origin.y) ? "h" : "v");
  return { anchors: draft.anchors, axis, cursor: copy(cursor) };
}

/** Canto atual do "L" elástico, se houver. */
export function wireDraftCorner(draft: WireDraft): Point | undefined {
  const origin = draft.anchors[draft.anchors.length - 1]!;
  if (!draft.axis || sameX(origin, draft.cursor) || sameY(origin, draft.cursor)) return undefined;
  return draft.axis === "h" ? { x: draft.cursor.x, y: origin.y } : { x: origin.x, y: draft.cursor.y };
}

/** Polilinha completa do rascunho, da origem até o cursor. */
export function wireDraftPath(draft: WireDraft): Point[] {
  const corner = wireDraftCorner(draft);
  return [...draft.anchors.map(copy), ...(corner ? [corner] : []), copy(draft.cursor)];
}

/** Clique no vazio: confirma o canto atual (o trecho seguinte continua elástico a partir dele). Sem
 * canto (trecho reto), o próprio cursor vira ponto fixo -- um "passe por aqui". */
export function fixWireDraftCorner(draft: WireDraft): WireDraft {
  const origin = draft.anchors[draft.anchors.length - 1]!;
  const corner = wireDraftCorner(draft);
  if (corner) return { anchors: [...draft.anchors, corner], cursor: draft.cursor };
  if (coincident(origin, draft.cursor)) return draft;
  return { anchors: [...draft.anchors, copy(draft.cursor)], cursor: draft.cursor };
}

/** Desfaz o último ponto fixo (nunca a origem). `false` quando só resta a origem. */
export function undoWireDraftCorner(draft: WireDraft): WireDraft | undefined {
  if (draft.anchors.length <= 1) return undefined;
  return moveWireDraft({ anchors: draft.anchors.slice(0, -1), cursor: draft.cursor }, draft.cursor);
}

/** Fecha o rascunho em `target` (pino, nó ou ponto sobre outro fio) e devolve a polilinha final já
 * simplificada -- exatamente o que estava na tela com o cursor sobre o alvo. */
export function finishWireDraft(draft: WireDraft, target: Point): Point[] {
  return simplifyWirePath(wireDraftPath(moveWireDraft(draft, target)));
}

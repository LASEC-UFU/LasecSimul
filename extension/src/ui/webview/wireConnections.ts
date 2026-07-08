/** Montagem pura de fio/junção para os dois fluxos de conexão de pino (pino→pino, pino→fio
 * existente) — sem DOM, sem `vscode.*`, só transforma pontos/refs já calculados em
 * `WebviewComponentModel`/`WebviewWireModel`. Compilado tanto pelo host (`extension.ts`, via
 * `tsconfig.json`) quanto pela Webview (`main.ts`, via `tsconfig.webview.json`): o host usa isto nos
 * handlers `"requestConnectPins"`/`"requestConnectPinToWire"`; a Webview usa a MESMA lógica dentro de
 * `symbolAuthoringContext`, onde `send()` é no-op e a conexão precisa ser aplicada localmente ao
 * `state` em vez de delegada ao host. Extraído para eliminar a duplicação que já causou um bug real
 * (ver "Symbol-authoring wire edit bug", 2026-07-06) — qualquer mudança na regra de conexão só precisa
 * ser feita aqui, nunca replicada manualmente nos dois lados. */

import { JUNCTION_TYPE_ID, WebviewComponentModel, WebviewPoint, WebviewWireModel } from "./model";

export type WirePinRef = { componentId: string; pinId: string };

export function junctionComponentAt(point: WebviewPoint, id: string): WebviewComponentModel {
  return {
    id,
    typeId: JUNCTION_TYPE_ID,
    label: "Junction",
    hidden: true,
    x: point.x,
    y: point.y,
    rotation: 0,
    pins: [{ id: "pin-1", x: 0, y: 0 }],
    properties: {},
  };
}

export function buildPinToPinWire(params: {
  id: string;
  from: WirePinRef;
  to: WirePinRef;
  points: WebviewPoint[] | undefined;
}): WebviewWireModel {
  return { id: params.id, from: params.from, to: params.to, points: params.points };
}

export interface PinToWireConnectionResult {
  junction: WebviewComponentModel;
  firstWire: WebviewWireModel;
  secondWire: WebviewWireModel;
  newWire: WebviewWireModel;
}

/** Divide `existingWire` em duas metades ligadas por uma junção nova, e liga `from` a essa mesma
 * junção com um terceiro fio — a mesma regra usada tanto para o clique num segmento de fio existente
 * quanto para o handler IPC equivalente. Os três conjuntos de pontos já vêm calculados pelo chamador
 * (a geometria de roteamento em si continua responsabilidade exclusiva da Webview interativa, tanto em
 * modo normal quanto em autoria — só a MONTAGEM dos objetos de fio/junção é compartilhada aqui). */
export function buildPinToWireConnection(params: {
  existingWire: WebviewWireModel;
  junctionId: string;
  junctionPoint: WebviewPoint;
  from: WirePinRef;
  newWireId: string;
  firstWireId: string;
  secondWireId: string;
  existingWireFirstPoints: WebviewPoint[] | undefined;
  existingWireSecondPoints: WebviewPoint[] | undefined;
  newWirePoints: WebviewPoint[] | undefined;
}): PinToWireConnectionResult {
  const junction = junctionComponentAt(params.junctionPoint, params.junctionId);
  const firstWire: WebviewWireModel = {
    id: params.firstWireId,
    from: params.existingWire.from,
    to: { componentId: junction.id, pinId: "pin-1" },
    points: params.existingWireFirstPoints,
  };
  const secondWire: WebviewWireModel = {
    id: params.secondWireId,
    from: { componentId: junction.id, pinId: "pin-1" },
    to: params.existingWire.to,
    points: params.existingWireSecondPoints,
  };
  const newWire: WebviewWireModel = {
    id: params.newWireId,
    from: params.from,
    to: { componentId: junction.id, pinId: "pin-1" },
    points: params.newWirePoints,
  };
  return { junction, firstWire, secondWire, newWire };
}

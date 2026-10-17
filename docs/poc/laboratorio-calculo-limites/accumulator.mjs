// PoC isolada (NÃO é produção). Implementação de REFERÊNCIA do acumulador conservativo proposto
// para o Core (docs/53 §2.2). Serve de oráculo para os testes C++ de M4; não é um segundo motor.
//
// Entradas ZOH no passo [t, t+Δt]: o estado é linear por partes; o contato com a fronteira é
// analítico; o excesso vira overflow (topo) ou unmet (fundo). Acumulados fecham o balanço:
//   x − x0 = cumIn − cumOut − cumOverflow   (exato a menos de arredondamento)

export function createAccumulator({ initial, lower = 0, upper = Infinity }) {
  if (!(upper > lower)) throw new RangeError("upper deve ser maior que lower");
  const x = Math.min(upper, Math.max(lower, initial));
  return { x, x0: x, lower, upper, cumIn: 0, cumOut: 0, cumOverflow: 0, cumUnmet: 0, inActual: 0, outActual: 0, overflow: 0, unmet: 0, negativeDemands: 0 };
}

/** Um passo. Devolve evento de fronteira { kind, at } (at = segundos desde o início do passo) ou null. */
export function stepAccumulator(acc, demandIn, demandOut, dt) {
  let qIn = demandIn, qOut = demandOut;
  if (!(qIn >= 0)) { acc.negativeDemands++; qIn = 0; }   // Host rejeita; o Core só conta como diagnóstico
  if (!(qOut >= 0)) { acc.negativeDemands++; qOut = 0; }
  const net = qIn - qOut;
  let x = acc.x, overflowVol = 0, unmetVol = 0, event = null;
  if (net > 0 && Number.isFinite(acc.upper)) {
    const tc = (acc.upper - x) / net;
    if (tc < dt) { overflowVol = net * (dt - Math.max(tc, 0)); x = acc.upper; if (tc > 0) event = { kind: "boundary:upper", at: tc }; }
    else x += net * dt;
  } else if (net < 0) {
    const tc = (x - acc.lower) / -net;
    if (tc < dt) { unmetVol = -net * (dt - Math.max(tc, 0)); x = acc.lower; if (tc > 0) event = { kind: "boundary:lower", at: tc }; }
    else x += net * dt;
  } else x += net * dt;
  // arredondamento perto da fronteira: o excedente entra na contabilidade, nunca some
  if (x > acc.upper) { overflowVol += x - acc.upper; x = acc.upper; }
  if (x < acc.lower) { unmetVol += acc.lower - x; x = acc.lower; }
  acc.x = x;
  acc.cumIn += qIn * dt;
  acc.cumOut += qOut * dt - unmetVol;
  acc.cumOverflow += overflowVol;
  acc.cumUnmet += unmetVol;
  const atUpper = x >= acc.upper && net > 0, atLower = x <= acc.lower && net < 0;
  acc.inActual = qIn;
  acc.outActual = atLower ? qIn : qOut;
  acc.overflow = atUpper ? net : 0;
  acc.unmet = atLower ? -net : 0;
  return event;
}

/** Limite superior ao vivo (ex.: Vmax = A·hmax com A ajustável). Excesso = derramamento DISCRETO (volume, não vazão). */
export function setUpper(acc, upper) {
  if (!(upper > acc.lower)) throw new RangeError("upper deve ser maior que lower");
  acc.upper = upper;
  if (acc.x <= upper) return null;
  const volume = acc.x - upper;
  acc.x = upper;
  acc.cumOverflow += volume;
  return { kind: "spill", volume };
}

export const balanceResidual = (acc) => acc.x - acc.x0 - (acc.cumIn - acc.cumOut - acc.cumOverflow);

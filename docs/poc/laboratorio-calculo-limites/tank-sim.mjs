// PoC isolada (NÃO é produção). Substituto do Core APENAS para a PoC do tanque: reproduz o contrato
// proposto (passo fixo de 10 ms, parâmetros aplicados na fronteira do passo com appliedAtNs, eventos
// com tempo exato, gravação por passo). Em produção esta física roda no Core C++ (docs/51 §4.3).
import { createAccumulator, stepAccumulator, setUpper, balanceResidual } from "./accumulator.mjs";
import { Recorder } from "./series.mjs";

export const LITER = 1e-3; // m³
const LIVE = new Set(["qIn", "qOut", "k", "A"]);
const STOP_REQUIRED = new Set(["V0", "hMax", "mode"]);
const COLUMNS = ["V", "h", "A", "qIn", "qOutDemand", "inActual", "outActual", "overflow", "unmet", "q", "cumIn", "cumOut", "cumOverflow", "residual"];

export class TankSim {
  constructor(params = {}) {
    this.params = { A: 0.1, hMax: 1.0, V0: 20 * LITER, qIn: 1 * LITER, qOut: 0.4 * LITER, k: 2 * LITER, mode: "pump", ...params };
    this.periodNs = 10_000_000;
    this.status = "stopped";
    this.writes = 0;
    this.generation = 0;
    this.reset();
  }
  reset() {
    const p = this.params;
    this.generation++;
    this.tNs = 0;
    this.pending = [];
    this.events = [];
    this.acc = createAccumulator({ initial: p.V0, lower: 0, upper: p.A * p.hMax });
    this.rec = new Recorder(COLUMNS);
    this.#record(NaN);
  }
  /** Mesmo papel de setProperty: valida, enfileira e devolve o instante em que valerá (appliedAtNs). */
  setParameter(name, value) {
    if (!LIVE.has(name) && !STOP_REQUIRED.has(name)) throw new Error(`parâmetro desconhecido: ${name}`);
    if (STOP_REQUIRED.has(name) && this.status !== "stopped") throw new Error("requires_stop: pare a simulação para alterar " + name);
    if (name !== "mode" && !(Number.isFinite(value) && value >= 0)) throw new RangeError(`valor inválido para ${name}`);
    if ((name === "A" || name === "hMax") && !(value > 0)) throw new RangeError(`${name} deve ser positivo`);
    this.writes++;
    if (this.status === "stopped") { this.params[name] = value; this.reset(); return 0; }
    this.pending.push({ name, value });
    if (this.status === "paused") this.applyPending(); // o Core drena a fila de comandos também em pausa
    return this.tNs;
  }
  start() { this.status = "running"; }
  pause() { if (this.status === "running") this.status = "paused"; }
  resume() { if (this.status === "paused") this.status = "running"; }
  restart(initial) { this.status = "stopped"; if (initial) Object.assign(this.params, initial); this.reset(); }

  /** Avança n passos (o chamador decide o ritmo; o tempo é sempre simulado). Parâmetros também valem em pausa. */
  advance(n) {
    for (let s = 0; s < n; s++) this.#step();
  }
  applyPending() {
    if (!this.pending.length) return;
    const p = this.params;
    let geometry = false;
    for (const { name, value } of this.pending) {
      this.events.push({ tNs: this.tNs, kind: "parameter", name, from: p[name], to: value });
      p[name] = value;
      if (name === "A" || name === "hMax") geometry = true;
    }
    this.pending = [];
    if (geometry) {
      const spill = setUpper(this.acc, p.A * p.hMax);
      if (spill) this.events.push({ tNs: this.tNs, kind: "spill", volume: spill.volume });
      this.#record(NaN); // segunda linha no mesmo instante: h (e V, se derramou) mudam de forma descontínua
    }
  }
  #step() {
    this.applyPending();
    const p = this.params, dt = this.periodNs * 1e-9;
    const before = this.acc.x;
    const qOutDemand = p.mode === "pump" ? p.qOut : p.k * (before / p.A); // válvula: lê h no início do passo (ZOH)
    const event = stepAccumulator(this.acc, p.qIn, qOutDemand, dt);
    if (event) this.events.push({ tNs: this.tNs + Math.round(event.at * 1e9), kind: event.kind });
    this.tNs += this.periodNs;
    this.#record((this.acc.x - before) / dt, qOutDemand);
  }
  #record(q, qOutDemand = NaN) {
    const a = this.acc, p = this.params;
    this.rec.push(this.tNs * 1e-9, {
      V: a.x, h: a.x / p.A, A: p.A, qIn: p.qIn, qOutDemand, inActual: a.inActual, outActual: a.outActual,
      overflow: a.overflow, unmet: a.unmet, q, cumIn: a.cumIn, cumOut: a.cumOut, cumOverflow: a.cumOverflow, residual: balanceResidual(a),
    });
  }
}

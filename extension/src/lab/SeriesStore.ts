import type { SeriesChunkDto, SeriesDrainRequest, SeriesEventDto } from "../ipc/CoreClient";

/**
 * Lado Host das séries gravadas no Core (ADR 0012, docs/51 §4.2). Uma instância por assinatura:
 * guarda as linhas da geração corrente em `Float64Array` (tempo em segundos simulados), devolve o
 * pedido de escoamento do próximo tick (`request`) e transforma cada fatia do Core num delta
 * append-only para os painéis (`ingest`). Nada é reamostrado; a retenção descarta o mais antigo.
 */
export interface SeriesDelta {
  /** `true`: descartar o que o painel tinha (geração nova ou janela compactada) antes de anexar. */
  reset: boolean;
  generation: number;
  t: number[];
  columns: number[][];
  events: SeriesEventDto[];
  /** Linhas que o Core sobrescreveu antes de serem lidas (lacuna logo antes deste delta). */
  lost: number;
}

export class SeriesStore {
  private times: Float64Array;
  private data: Float64Array[];
  private size = 0;
  private generationId: number | undefined;
  private nextSeq = 0;
  private nextEventSeq = 0;
  private readonly eventLog: SeriesEventDto[] = [];

  constructor(readonly subscriptionId: number, readonly columnIds: readonly string[], private readonly retentionRows = 180_000) {
    if (!(retentionRows >= 16)) throw new RangeError("retenção mínima de 16 linhas");
    this.times = new Float64Array(1024);
    this.data = columnIds.map(() => new Float64Array(1024));
  }

  get length(): number { return this.size; }
  get generation(): number | undefined { return this.generationId; }
  get events(): readonly SeriesEventDto[] { return this.eventLog; }
  time(index: number): number { return this.times[index]!; }
  column(id: string): Float64Array {
    const index = this.columnIds.indexOf(id);
    if (index < 0) throw new RangeError(`coluna desconhecida: ${id}`);
    return this.data[index]!.subarray(0, this.size);
  }
  timesView(): Float64Array { return this.times.subarray(0, this.size); }

  request(): SeriesDrainRequest {
    return { subscriptionId: this.subscriptionId, generation: this.generationId, sinceSeq: this.nextSeq,
      sinceEventSeq: this.nextEventSeq, columns: this.columnIds.length };
  }

  /** Aplica uma fatia do Core; `undefined` quando não há nada novo para os painéis. */
  ingest(chunk: SeriesChunkDto): SeriesDelta | undefined {
    if (chunk.missing || chunk.subscriptionId !== this.subscriptionId) return undefined;
    let reset = false;
    if (chunk.generation !== this.generationId) {
      reset = true;
      this.generationId = chunk.generation;
      this.size = 0;
      this.nextSeq = 0;
      this.nextEventSeq = 0;
      this.eventLog.length = 0;
    }
    // Duas leituras concorrentes (tick + escoamento na pausa) podem trazer a mesma faixa: só o inédito entra.
    const skip = Math.max(0, Math.min(chunk.tNs.length, this.nextSeq - chunk.fromSeq));
    if (skip > 0) {
      chunk = { ...chunk, fromSeq: chunk.fromSeq + skip, tNs: chunk.tNs.slice(skip), columns: chunk.columns.map((column) => column.slice(skip)), lost: 0 };
    }
    chunk = { ...chunk, events: chunk.events.filter((event) => event.seq >= this.nextEventSeq) };
    if (chunk.toSeq <= this.nextSeq && chunk.events.length === 0 && !reset) return undefined;
    const rows = chunk.tNs.length;
    if (rows === 0 && chunk.events.length === 0 && !reset) {
      this.nextSeq = chunk.toSeq;
      this.nextEventSeq = chunk.nextEventSeq;
      return undefined;
    }
    if (this.size + rows > this.retentionRows) reset = this.compact(rows) || reset;
    this.reserve(this.size + rows);
    const t = chunk.tNs.map((ns) => ns * 1e-9);
    const columns = chunk.columns.map((column) => column.map((value) => (value === null ? NaN : value)));
    this.times.set(t, this.size);
    columns.forEach((column, index) => this.data[index]!.set(column, this.size));
    this.size += rows;
    this.eventLog.push(...chunk.events);
    this.nextSeq = chunk.toSeq;
    this.nextEventSeq = chunk.nextEventSeq;
    if (reset) return this.snapshot(chunk.lost);
    return { reset: false, generation: chunk.generation, t, columns, events: chunk.events, lost: chunk.lost };
  }

  /** Estado completo da geração corrente -- para um painel que acabou de se inscrever. */
  snapshot(lost = 0): SeriesDelta {
    return { reset: true, generation: this.generationId ?? 0, t: Array.from(this.timesView()),
      columns: this.data.map((column) => Array.from(column.subarray(0, this.size))), events: [...this.eventLog], lost };
  }

  /** Descarta o quarto mais antigo (ou o necessário) para caber `incoming` linhas novas. */
  private compact(incoming: number): boolean {
    const keep = Math.max(0, Math.min(this.size, Math.floor(this.retentionRows * 0.75) - incoming));
    const drop = this.size - keep;
    if (drop <= 0) return false;
    this.times.copyWithin(0, drop, this.size);
    for (const column of this.data) column.copyWithin(0, drop, this.size);
    this.size = keep;
    const firstTime = keep > 0 ? this.times[0]! : Infinity;
    const retained = this.eventLog.filter((event) => event.tNs * 1e-9 >= firstTime);
    this.eventLog.length = 0;
    this.eventLog.push(...retained);
    return true;
  }

  private reserve(rows: number): void {
    if (rows <= this.times.length) return;
    let capacity = this.times.length;
    while (capacity < rows) capacity *= 2;
    const grow = (source: Float64Array): Float64Array => { const next = new Float64Array(capacity); next.set(source.subarray(0, this.size)); return next; };
    this.times = grow(this.times);
    this.data = this.data.map(grow);
  }
}

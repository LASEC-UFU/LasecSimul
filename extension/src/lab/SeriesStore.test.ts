import { assert as assertWithMessage, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import type { SeriesChunkDto } from "../ipc/CoreClient";
import { SeriesStore } from "./SeriesStore";

const assert = (condition: boolean, message = "falhou"): void => assertWithMessage(condition, message);
const { test, finish } = createTestRunner("Laboratório de Cálculo — SeriesStore (Host)");

const MS = 1_000_000;
function chunk(generation: number, fromSeq: number, rows: number, startMs: number, extra: Partial<SeriesChunkDto> = {}): SeriesChunkDto {
  const tNs = Array.from({ length: rows }, (_, i) => (startMs + i * 10) * MS);
  return { subscriptionId: 7, generation, fromSeq, toSeq: fromSeq + rows, lost: 0, more: false, tNs,
    columns: [tNs.map((t) => t * 1e-9), tNs.map(() => null)], resolved: [1, 0], events: [], nextEventSeq: 0, ...extra };
}

void (async () => {
  await test("anexa linhas, converte para segundos e mantém NaN para canal não resolvido", () => {
    const store = new SeriesStore(7, ["V", "x"]);
    const first = store.ingest(chunk(3, 0, 5, 0, { events: [{ seq: 0, tNs: 0, kind: "start" }], nextEventSeq: 1 }))!;
    assert(first.reset && first.t.length === 5 && first.t[4] === 0.04, "primeira fatia é reset com 5 linhas em s");
    assert(Number.isNaN(first.columns[1]![0]!), "null vira NaN");
    const request = store.request();
    assert(request.generation === 3 && request.sinceSeq === 5 && request.sinceEventSeq === 1 && request.columns === 2, "próximo pedido continua de onde parou");
    const second = store.ingest(chunk(3, 5, 3, 50))!;
    assert(!second.reset && second.t.length === 3 && store.length === 8, "fatia seguinte é delta");
    assert(Math.abs(store.column("V")[7]! - 0.07) < 1e-15, "coluna acessível por id");
    assert(store.ingest(chunk(3, 8, 0, 80)) === undefined, "fatia vazia não gera mensagem");
  });

  await test("geração nova descarta a anterior e reinicia do zero", () => {
    const store = new SeriesStore(7, ["V", "x"]);
    store.ingest(chunk(1, 0, 10, 0));
    const restarted = store.ingest(chunk(2, 0, 2, 0))!;
    assert(restarted.reset && restarted.generation === 2 && store.length === 2, "reset na troca de geração");
  });

  await test("retenção compacta o mais antigo e avisa o painel com um snapshot", () => {
    const store = new SeriesStore(7, ["V", "x"], 100);
    store.ingest(chunk(1, 0, 90, 0));
    const delta = store.ingest(chunk(1, 90, 20, 900))!;
    assert(delta.reset, "compactação vira reset do painel");
    assert(store.length <= 100 && store.length >= 60, `retidas ${store.length}`);
    const times = store.timesView();
    assert(times[times.length - 1] === 1.09 && times.every((t, i) => i === 0 || t > times[i - 1]!), "ordem e últimas linhas preservadas");
  });

  await test("leituras sobrepostas (tick + escoamento na pausa) não duplicam linhas nem eventos", () => {
    const store = new SeriesStore(7, ["V", "x"]);
    store.ingest(chunk(1, 0, 5, 0, { events: [{ seq: 0, tNs: 0, kind: "start" }], nextEventSeq: 1 }));
    assert(store.ingest(chunk(1, 0, 5, 0, { events: [{ seq: 0, tNs: 0, kind: "start" }], nextEventSeq: 1 })) === undefined, "faixa repetida ignorada");
    const partial = store.ingest(chunk(1, 3, 4, 30, { events: [{ seq: 0, tNs: 0, kind: "start" }, { seq: 1, tNs: 40 * MS, kind: "parameter" }], nextEventSeq: 2 }))!;
    assert(partial.t.length === 2 && partial.t[0] === 0.05 && store.length === 7, `só as linhas novas: ${partial.t}`);
    assert(partial.events.length === 1 && partial.events[0]!.seq === 1 && store.events.length === 2, "só o evento novo");
  });

  await test("linhas perdidas no Core chegam ao painel como lacuna", () => {
    const store = new SeriesStore(7, ["V", "x"]);
    store.ingest(chunk(1, 0, 3, 0));
    const delta = store.ingest(chunk(1, 10, 2, 100, { lost: 7 }))!;
    assert(delta.lost === 7, "lost repassado");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

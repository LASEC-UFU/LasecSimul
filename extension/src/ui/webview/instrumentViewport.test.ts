import * as assert from "assert";
import { analogSampleHoldPath, clampInstrumentWindow, decodeInstrumentState, encodeInstrumentState, logicHistoryToVcd, panInstrumentTime, zoomInstrumentTimeAt } from "./instrumentViewport";

function anchor(pos: number, div: number, ratio: number): number { return pos - (1 - ratio) * div * 10; }

{
  const before = { timeDivMs: 1, timePosMs: 0 };
  const after = zoomInstrumentTimeAt(before, 0.25, true);
  assert.strictEqual(after.timeDivMs, 0.8);
  assert.ok(Math.abs(anchor(before.timePosMs, before.timeDivMs, 0.25) - anchor(after.timePosMs, after.timeDivMs, 0.25)) < 1e-12);
  assert.strictEqual(panInstrumentTime(0, 1, 100, 500), -2);
}

{
  const vcd = logicHistoryToVcd([0, 10, 20], [0, 1, 1], [0], "2026-07-13T00:00:00.000Z");
  assert.ok(vcd.includes("$timescale 1ns $end"));
  assert.ok(vcd.includes("$var wire 1 ! D0 $end"));
  assert.ok(vcd.includes("#10\n1!"));
  assert.ok(!vcd.includes("#20"), "amostra sem mudança não deve inflar o VCD");
}

{
  const path = analogSampleHoldPath([0, 5, 10], [0, 1, 0], 0, 10, 100, (v) => 10 - v * 10);
  assert.strictEqual(path, "M 0.0 10.0 L 50.0 10.0 L 50.0 0.0 L 100.0 0.0 L 100.0 10.0 L 100.0 10.0");
  assert.ok(!path.includes("L 50.0 0.0 L 100.0 10.0"), "transição não pode ser diagonal");
  const many = Array.from({ length: 10_000 }, (_, i) => i === 5001 ? 100 : 0);
  const reduced = analogSampleHoldPath(many.map((_, i) => i), many, 0, 9_999, 100, (v) => v);
  assert.ok(reduced.includes("100.0"), "decimação deve preservar picos");
  assert.ok(reduced.length < 20_000, "path deve ser limitado por pixels, não pelo total de amostras");
}

{
  assert.deepStrictEqual(clampInstrumentWindow(100, 5000), { width: 620, height: 1000 });
  const fallback = { width: 800, height: 500, timeDivMs: 1 };
  assert.deepStrictEqual(decodeInstrumentState(encodeInstrumentState({ width: 900 }), fallback), { ...fallback, width: 900 });
  assert.strictEqual(decodeInstrumentState("{inválido", fallback), fallback);
}

console.log("instrumentViewport tests passed");

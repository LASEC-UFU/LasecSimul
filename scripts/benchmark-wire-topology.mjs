import { performance } from "node:perf_hooks";
import { WireSpatialIndex } from "../extension/out-webview/wireSpatialIndex.js";

const sizes = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const targets = sizes.length ? sizes : [100, 1_000, 10_000, 50_000];
for (const count of targets) {
  const index = new WireSpatialIndex(64);
  const buildStart = performance.now();
  for (let i = 0; i < count; i += 1) {
    const y = (i % 100) * 16;
    const x = Math.floor(i / 100) * 32;
    index.upsertWire(`w${i}`, [{ x, y }, { x: x + 24, y }]);
    index.upsertConnectionPoint({ id: `p${i}`, kind: "pin", componentId: `c${i}`, pinId: "p", point: { x, y } });
  }
  const buildMs = performance.now() - buildStart;
  const samples = 2_000;
  const queryStart = performance.now();
  let candidates = 0;
  for (let i = 0; i < samples; i += 1) {
    const point = { x: ((i * 37) % Math.max(1, Math.ceil(count / 100))) * 32 + 8, y: ((i * 53) % 100) * 16 + 2 };
    candidates += index.queryPoint(point, 8).length + index.queryConnectionPoints(point, 8).length;
  }
  const queryUs = ((performance.now() - queryStart) * 1_000) / samples;
  console.log(JSON.stringify({ segments: count, buildMs: +buildMs.toFixed(3), queryMeanUs: +queryUs.toFixed(3), candidates }));
}

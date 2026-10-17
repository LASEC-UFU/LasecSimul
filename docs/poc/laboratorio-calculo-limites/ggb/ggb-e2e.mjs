// PoC isolada (estratégia C). Uso: GGB_BUNDLE_DIR=<pasta que contém deployggb.js> node ggb-e2e.mjs
// O bundle oficial (geogebra-math-apps-bundle) é baixado separadamente: licença não comercial, não versionar.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = process.env.GGB_BUNDLE_DIR;
if (!bundle) throw new Error("defina GGB_BUNDLE_DIR");
const require = createRequire(new URL("../../../../extension/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const POLICIES = {
  "webview-estrita": "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'",
  "+unsafe-eval": "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-eval'; font-src 'self' data:; connect-src 'self'",
  "+unsafe-eval+wasm+worker": "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob: data:",
  "nonce+strict-dynamic": "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'nonce-poc123' 'strict-dynamic' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob: data:",
  "+unsafe-inline+eval+wasm": "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob: data:",
  "+unsafe-inline-sem-eval": "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob: data:",
  "nonce+strict-dynamic+so-wasm": "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'nonce-poc123' 'strict-dynamic' 'wasm-unsafe-eval'; worker-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob: data:",
};
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : undefined;

for (const [name, csp] of Object.entries(POLICIES).filter(([n]) => !ONLY || ONLY.includes(n))) {
  const { server, url } = await serve({ "/GeoGebra/": bundle, "/": here }, () => ({ "content-security-policy": csp }));
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const external = new Set(); let bytes = 0; let requests = 0;
  await page.route("**/*", (route) => (route.request().url().startsWith(url) ? route.continue() : (external.add(new URL(route.request().url()).host), route.abort())));
  page.on("requestfinished", async (r) => { requests++; try { bytes += (await r.sizes()).responseBodySize; } catch {} });
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI || e.sourceFile || ""}`.slice(0, 160))));
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  console.log(`\n=== CSP ${name}`);
  try {
    await page.goto(`${url}/${name.startsWith("nonce") ? "ggb-nonce.html" : "ggb.html"}`);
    const loaded = await page.waitForFunction(() => window.__ggb?.loadedAt, null, { timeout: 60000 }).then(() => true, () => false);
    const s = await page.evaluate(() => ({ ...window.__ggb, csp: (window.__csp ?? []).slice(0, 8), cspCount: (window.__csp ?? []).length,
      heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined }));
    console.log(`carregou: ${loaded}; appletOnLoad em ${loaded ? Math.round(s.loadedAt - s.startedAt) : "-"} ms; requisições locais=${requests}, bytes=${(bytes / 1048576).toFixed(1)} MiB; heap JS=${s.heap} MiB`);
    console.log(`violações CSP: ${s.cspCount}${s.cspCount ? " -> " + [...new Set(s.csp)].join(" | ") : ""}`);
    if (pageErrors.length) console.log(`erros de página: ${[...new Set(pageErrors)].slice(0, 4).join(" | ")}`);
    if (external.size) console.log(`tentativas de rede externa bloqueadas: ${[...external].join(", ")}`);
    if (!loaded) continue;
    console.log(`comandos: ${s.commandResults.map(([c, ok]) => `${ok ? "ok" : "FALHOU"}: ${c}`).join("; ")}`);
    console.log(`Limit (CAS): definido=${s.limitDefined} valor=${s.limitValue} em ${Math.round(s.limitMs)} ms`);
    await page.waitForTimeout(3000); // dá tempo de o CAS assíncrono responder, se houver
    console.log(`Limit após 3 s: ${await page.evaluate(() => window.__api.getValue("L"))}`);
    console.log(`projeção de ponto sobre h: pedido ${JSON.stringify(s.projection.requested)} -> obtido ${JSON.stringify(s.projection.got.map((v) => Number(v.toFixed(4))))}`);
    // sincronização: alterar Δt por API; custo SÍNCRONO (cálculo + listener) e quadro seguinte
    const r = await page.evaluate(async () => {
      const api = window.__api, s = window.__ggb, sync = [], frame = [];
      const u0 = s.updates, byName0 = { ...s.updatesByName };
      for (let i = 0; i < 60; i++) {
        const d = 0.5 - (0.49 * (i + 1)) / 60;
        const t0 = performance.now();
        api.setValue("dt", d);
        const q = api.getValue("q");
        const t1 = performance.now();
        await new Promise((ok) => requestAnimationFrame(() => ok()));
        sync.push(t1 - t0); frame.push(performance.now() - t0);
        if (!(Math.abs(q - (4 + 0.5 * d)) < 1e-9)) s.errors.push(`q(${d})=${q}`);
      }
      const values = [1, 0.1, 0.01, 0, -0.01, -0.1, -1].map((d) => { api.setValue("dt", d); return [d, api.getValue("q"), api.isDefined("q"), api.getValueString("q")]; });
      const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
      const byName = Object.fromEntries(Object.entries(s.updatesByName).map(([k, v]) => [k, v - (byName0[k] ?? 0)]));
      return { syncP50: pct(sync, 0.5), syncP95: pct(sync, 0.95), frameP50: pct(frame, 0.5), updates: s.updates - u0, byName, values, errors: s.errors, table: document.getElementById("q").textContent };
    });
    console.log(`setValue(dt)+getValue(q) síncrono (n=60): p50=${r.syncP50.toFixed(2)} ms p95=${r.syncP95.toFixed(2)} ms; até o quadro seguinte p50=${r.frameP50.toFixed(1)} ms`);
    console.log(`eventos de update=${r.updates} (${(r.updates / 60).toFixed(1)} por mudança de Δt): ${JSON.stringify(r.byName)}; erros=${r.errors.length}`);
    console.log(`[Δt, q, definido, texto]: ${JSON.stringify(r.values)}`);
    // Capturas mostram a interface do GeoGebra (recursos CC BY-NC-SA): ficam fora do repositório.
    await page.screenshot({ path: join(tmpdir(), `ggb-${name.replace(/[^a-z0-9]+/gi, "_")}.png`) });
  } finally {
    await browser.close();
    server.close();
  }
}

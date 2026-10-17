// PoC isolada: tanque com área A ajustável durante a execução, num Chromium real (Edge) sob CSP restritivo.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { serve } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../../../extension/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const CSP = "default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'";
const { server, url } = await serve({ "/": here }, () => ({ "content-security-policy": CSP }));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [], external = [];
await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)));
page.on("pageerror", (e) => errors.push(String(e)));
page.on("request", (r) => { if (!r.url().startsWith(url) && !r.url().startsWith("data:")) external.push(r.url()); });
let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; };
const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const text = async (sel) => (await page.locator(sel).evaluate((n) => (n instanceof SVGElement ? [...n.querySelectorAll("text")].map((t) => t.textContent).join(" ") : n.innerText))).replace(/\s+/g, " ").trim();
const setRange = (sel, v) => page.$eval(sel, (el, val) => { el.value = String(val); el.dispatchEvent(new Event("input", { bubbles: true })); }, v);
const chartPoint = (id, t) => page.evaluate(([id, t]) => {
  const svg = document.getElementById(id), r = svg.getBoundingClientRect(), win = __tank.g.get("window");
  const px = 54 + ((t - win.t0) / (win.t1 - win.t0)) * (640 - 54 - 12);
  return { x: r.left + (px / 640) * r.width, y: r.top + r.height * 0.55 };
}, [id, t]);

try {
  await page.goto(`${url}/tanque.html`);
  await page.waitForFunction(() => window.__tank && window.__tank.stats.frames > 0);
  await page.evaluate(() => __tank.setSpeed(0)); // ritmo controlado pelo teste (tempo simulado determinístico)

  // --- executar 50 s com bomba 1 / 0,4 L/s -------------------------------------------------------
  await page.locator("#play").click();
  await page.evaluate(() => __tank.advance(50));
  await frames();
  check(/V = 50 L/.test(await text("#tankSvg")), "após 50 s: V = 50 L (20 + 0,6·50)", await text("#tankSvg"));
  // --- A ao vivo: 0,1 -> 0,04 m² (Vmax = 40 L) ------------------------------------------------------
  const writesBefore = await page.evaluate(() => __tank.sim.writes);
  await setRange("#A", 0.04);
  await page.evaluate(() => __tank.advance(5));
  await frames();
  const ev = await page.evaluate(() => __tank.sim.events.map((e) => ({ ...e })));
  const spill = ev.find((e) => e.kind === "spill");
  check(ev.some((e) => e.kind === "parameter" && e.name === "A" && e.tNs === 50e9) && spill && Math.abs(spill.volume - 0.01) < 1e-13,
    "slider A durante a execução: evento em t = 50 s e derramamento discreto de 10 L", JSON.stringify(spill));
  check(/derramamento instantâneo de 10 L/.test(await text("#eventsList")), "lista de eventos explica o derramamento");
  check(/transborda 0,6 L\/s/.test(await text("#tankSvg")), "no topo, o vertedouro mostra 0,6 L/s realizados");
  const hPaths = await page.locator('#chartH path[data-series="h"]').count();
  check(hPaths >= 2, "traçado de h quebrado no instante da mudança de A (sem segmento vertical falso)", `${hPaths} segmentos`);
  const residual = await page.evaluate(() => { let m = 0; const r = __tank.sim.rec; for (let i = 0; i < r.length; i++) m = Math.max(m, Math.abs(r.data.residual[i])); return m; });
  check(residual <= 1e-13, "resíduo de balanço em todas as linhas ≤ 1e-13 m³ com o derramamento", residual.toExponential(1));

  // --- inspeção: cursor, n, método e a/b não escrevem no simulador ---------------------------------
  const w0 = await page.evaluate(() => __tank.sim.writes);
  const baseRenders = await page.evaluate(() => __tank.stats.renders.baseH ?? 0);
  const p20 = await chartPoint("chartH", 20);
  await page.mouse.move(p20.x, p20.y); await page.mouse.down();
  for (let k = 1; k <= 30; k++) { const p = await chartPoint("chartH", 20 + k * 0.2); await page.mouse.move(p.x, p.y); await frames(); }
  await page.mouse.up();
  await frames();
  const tCur = await page.evaluate(() => __tank.g.get("cursor"));
  check(Math.abs(tCur - 26) < 0.6 && /inspeção/.test(await text("#modeBadge")), "arrastar no gráfico move o cursor (modo inspeção)", `t = ${tCur}`);
  check(/Inspeção em t = /.test(await text("#tankCaption")) && /V = 3[5-6],\d* L/.test(await text("#tankSvg")), "tanque reconstruído do passado (V ≈ 35,6 L em t ≈ 26 s)", await text("#tankSvg"));
  await page.locator("#method").selectOption("midpoint");
  await setRange("#n", 50);
  await frames();
  const bh = await page.locator('#chartQ circle[data-handle="b"]').boundingBox();
  const p45 = await chartPoint("chartQ", 53);
  await page.mouse.move(bh.x + bh.width / 2, bh.y + bh.height / 2); await page.mouse.down(); await page.mouse.move(p45.x, bh.y + bh.height / 2); await page.mouse.up();
  await frames();
  const w1 = await page.evaluate(() => __tank.sim.writes);
  check(await page.evaluate(() => __tank.stats.renders.baseH) === baseRenders, "mover cursor/a/b/n não redesenha a série (só a camada de marcadores)");
  check(w1 === w0 && w0 === writesBefore + 1, "cursor, método, n e marcador b: nenhuma escrita no simulador", `escritas ${writesBefore}→${w0}→${w1}`);
  const lat = await page.evaluate(() => __tank.stats.latencies.slice(-30).sort((a, b) => a - b));
  console.log(`latência entrada→fim do quadro na inspeção (n=${lat.length}): p50=${lat[Math.floor(lat.length / 2)]?.toFixed(1)} ms p95=${lat[Math.floor(lat.length * 0.95)]?.toFixed(1)} ms (indicativo)`);
  const rt = await text("#riemannResult");
  check(/V\(b\) − V\(a\) medido/.test(rt) && /derramamentos \(10 L\)/.test(rt), "Riemann entre a e b atravessando a mudança de A: ΔV = ∫q − derramamentos", rt);
  await page.locator("#live").click();
  await frames();
  check(/ao vivo/.test(await text("#modeBadge")), "botão Ao vivo encerra a inspeção");

  // --- stop-required, pausa e reinício -----------------------------------------------------------
  await page.$eval("#V0", (el) => { el.disabled = false; el.value = "30"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  check(/stop-required/.test(await text("#paramError")), "V0 recusado com a simulação em execução (stop-required)");
  await page.locator("#pause").click();
  const tPause = await page.evaluate(() => __tank.sim.tNs);
  await setRange("#qIn", 0.5);
  const lastEv = await page.evaluate(() => __tank.sim.events.at(-1));
  check(lastEv.kind === "parameter" && lastEv.name === "qIn" && lastEv.tNs === tPause, "em pausa, q_in é aplicado no tempo pausado", JSON.stringify(lastEv));
  await page.locator("#restart").click();
  await frames();
  check(await page.evaluate(() => __tank.sim.tNs === 0 && __tank.sim.params.A === 0.1 && __tank.sim.events.length === 0), "Reiniciar volta a t = 0 com A = 0,1 m² e sem eventos (nova geração)");

  // --- válvula: Riemann converge para ΔV ----------------------------------------------------------
  await page.locator("#mode").selectOption("valve");
  await page.locator("#play").click();
  await page.evaluate(() => { __tank.advance(60); __tank.g.batch(() => { __tank.g.set("a", 0); __tank.g.set("b", 50); __tank.g.set("method", "left"); __tank.g.set("n", 5); }); });
  await frames();
  const r5 = await page.evaluate(() => __tank.g.get("riemann"));
  await page.evaluate(() => __tank.g.set("n", 200));
  await frames();
  const r200 = await page.evaluate(() => __tank.g.get("riemann"));
  check(Math.abs(r200.sum - r200.dV) < Math.abs(r5.sum - r5.dV) / 20 && Math.abs(r200.exact - r200.dV) < 1e-15, "válvula: Riemann à esquerda converge para V(50) − V(0); ∫ dos dados = ΔV",
    `erro n=5 ${((r5.sum - r5.dV) * 1000).toFixed(4)} L, n=200 ${((r200.sum - r200.dV) * 1000).toFixed(5)} L`);
  await page.evaluate(() => __tank.g.set("cursor", 30));
  await frames();
  await page.screenshot({ path: `${here}/poc-tanque.png`, fullPage: true });

  const csp = await page.evaluate(() => window.__csp ?? []);
  check(csp.length === 0, "nenhuma violação de CSP", csp.join("; "));
  check(errors.length === 0, "nenhum erro de página", errors.join("; "));
  check(external.length === 0, "nenhuma requisição externa (offline)", external.join("; "));
} finally {
  await browser.close();
  server.close();
}
console.log(failures === 0 ? "\nE2E TANQUE OK" : `\n${failures} FALHA(S)`);
process.exitCode = failures === 0 ? 0 : 1;

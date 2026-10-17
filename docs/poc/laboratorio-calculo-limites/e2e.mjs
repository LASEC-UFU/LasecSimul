// PoC isolada: exercita index.html num Chromium real (Edge do sistema) sob CSP restritivo.
// Uso: node e2e.mjs   (requer extension/node_modules com @playwright/test e o Microsoft Edge instalado)
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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const violations = [], errors = [], external = [];
await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)));
page.on("pageerror", (e) => errors.push(String(e)));
page.on("request", (r) => { if (!r.url().startsWith(url) && !r.url().startsWith("data:")) external.push(r.url()); });

let failures = 0;
const check = (cond, label, detail = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`); if (!cond) failures++; };

try {
  const t0 = Date.now();
  await page.goto(`${url}/index.html`);
  await page.waitForFunction(() => window.__poc && window.__poc.stats.frames > 0);
  console.log(`carregamento até o 1º quadro: ${Date.now() - t0} ms; heap JS=${await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10)} MiB (indicativo, máquina local)`);

  const text = async (sel) => (await page.locator(sel).innerText()).replace(/\s+/g, " ").trim();
  const rows = await page.locator("#tableBody tr").allInnerTexts();
  check(/4,5\s+3,5/.test(rows[0]) && /4,05\s+3,95/.test(rows[1]) && /4,005\s+3,995/.test(rows[2]), "tabela renderizada confere com a imagem", rows.slice(0, 3).join(" | "));
  check(/→ 4 cm\/s ←/.test(await text("#limit")), "valor-limite exato exibido como 4 cm/s");
  check(/4 \+ 0,5Δt \(Δt ≠ 0\)/.test(await text("#equation")), "equação simplificada 4 + 0,5Δt (Δt ≠ 0)", await text("#equation"));

  const math = await page.evaluate(() => { const m = document.querySelector("#modelEditor math"); const r = m?.getBoundingClientRect(); return { supported: typeof MathMLElement === "function", w: r?.width ?? 0, h: r?.height ?? 0, sup: !!m?.querySelector("msup") }; });
  check(math.supported && math.w > 20 && math.h > 10 && math.sup, "editor do modelo renderiza h(t) em MathML Core nativo (sem biblioteca)", JSON.stringify(math));

  // --- arraste real de Q em direção a P ------------------------------------------------------
  const before = await page.evaluate(() => ({ curve: __poc.computeCount("curve"), table: __poc.computeCount("tableRows"), P: __poc.computeCount("P"), renders: { ...__poc.stats.renders } }));
  const q = await page.locator("#qHandle").boundingBox();
  const p = await page.evaluate(() => { const r = document.getElementById("plot").getBoundingClientRect(); const tr = __poc.graph.get("transform"); const [x, y] = tr.toPx(4, 8); return { x: r.left + (x / 600) * r.width, y: r.top + (y / 420) * r.height }; });
  await page.mouse.move(q.x + q.width / 2, q.y + q.height / 2);
  await page.mouse.down();
  const steps = 60;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await page.mouse.move(q.x + q.width / 2 + (p.x + 3 - (q.x + q.width / 2)) * k, q.y + q.height / 2);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  }
  await page.mouse.up();
  const after = await page.evaluate(() => ({ curve: __poc.computeCount("curve"), table: __poc.computeCount("tableRows"), P: __poc.computeCount("P"), Q: __poc.computeCount("Q"), renders: { ...__poc.stats.renders }, dt: __poc.graph.get("dt"), lat: __poc.stats.latencies.slice(), writes: __poc.coreBridge.writes }));
  check(after.dt > 0 && after.dt < 0.1, "arraste levou Q para perto de P pela direita", `Δt=${after.dt}`);
  check(after.curve === before.curve && after.table === before.table && after.P === before.P, "durante o arraste: curva, tabela fixa e P não recalculados");
  check((after.renders.curve ?? 0) === (before.renders.curve ?? 0) && (after.renders.axes ?? 0) === (before.renders.axes ?? 0), "durante o arraste: curva e eixos não redesenhados");
  check((after.renders.points ?? 0) - (before.renders.points ?? 0) <= steps, "pontos redesenhados no máximo 1x por quadro", `${(after.renders.points ?? 0) - (before.renders.points ?? 0)} redesenhos / ${steps} movimentos`);
  check(after.writes === 0, "inspeção não escreveu no 'Core' simulado");
  const lat = after.lat.slice(-steps).sort((a, b) => a - b);
  const pct = (x) => lat[Math.min(lat.length - 1, Math.floor(x * lat.length))];
  console.log(`latência entrada→fim do quadro (n=${lat.length}): p50=${pct(0.5)?.toFixed(1)} ms p95=${pct(0.95)?.toFixed(1)} ms máx=${lat.at(-1)?.toFixed(1)} ms (indicativo; Edge headless)`);

  // --- teclado, lado esquerdo, Δt=0 ------------------------------------------------------------
  await page.locator("input[name=side][value='-1']").check();
  await page.locator("#dtInput").fill("0.01");
  await page.locator("#dtInput").dispatchEvent("change");
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  check(/3,995/.test(await text("#tableBody tr.current")), "Δt=0,01 pela esquerda -> 3,995 cm/s na linha atual", await text("#tableBody tr.current"));
  await page.locator("#qHandle").focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const dtKey = await page.evaluate(() => __poc.graph.get("dt"));
  const focused = await page.evaluate(() => document.activeElement?.id);
  check(Math.abs(dtKey - -0.009) < 1e-9 && focused === "qHandle", "teclado move Q (Shift+→ = 0,001) e o foco permanece em Q", `Δt=${dtKey}, foco=${focused}`);
  await page.locator("#zeroBtn").click();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  check(/denominador do quociente é zero/.test(await text("#warning")) && /indefinido/.test(await text("#equation")), "Δt = 0 -> aviso e equação 'indefinido'", await text("#warning"));
  check(/→ 4 cm\/s ←/.test(await text("#limit")), "o limite continua exibido como objeto separado em Δt = 0");

  // --- zoom: só agora a curva é reamostrada ------------------------------------------------------
  const curveBefore = await page.evaluate(() => __poc.computeCount("curve"));
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, -200);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  check((await page.evaluate(() => __poc.computeCount("curve"))) === curveBefore + 1, "zoom reamostra a curva uma vez");

  // --- editor de equações: digitar um novo modelo -----------------------------------------------
  const frame2 = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.locator("#modelEditor").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("t^3");
  await frame2();
  const rows3 = await page.locator("#tableBody tr").allInnerTexts();
  check(/^1\s+61\s+37/.test(rows3[0]) && /49,21\s+46,81/.test(rows3[1]), "modelo digitado t³: tabela recalculada (61/37, 49,21/46,81)", rows3.slice(0, 2).join(" | "));
  check(/→ 48 cm\/s ←/.test(await text("#limit")), "limite exato passa a 48 cm/s");
  check(/48 \+ 12Δt \+ Δt\^2/.test(await text("#equation")), "quociente simplificado 48 + 12Δt + Δt²", await text("#equation"));
  check(/= 48/.test(await text("#calcResult")) && /exato/.test(await text("#calcResult")), "calculadora (lim do quociente) acompanha o novo modelo: 48, exato", await text("#calcResult"));

  // --- paleta: montar ∫₀¹ x² dx na calculadora -----------------------------------------------------
  await page.locator("#calcEditor").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  const focusedCalc = await page.evaluate(() => document.activeElement?.id);
  await page.locator(".palette-tabs button", { hasText: "Cálculo" }).click();
  await page.locator('.key[aria-label="integral definida"]').click();
  await page.keyboard.type("0");
  await page.keyboard.press("Tab");
  await page.keyboard.type("1");
  await page.keyboard.press("Tab");
  await page.keyboard.type("x^2");
  await frame2();
  check(focusedCalc === "calcEditor" && /0,333333333/.test(await text("#calcResult")) && /exato/.test(await text("#calcResult")), "paleta + teclado: ∫₀¹ x² dx = 0,333333333 (exato)", await text("#calcResult"));
  await page.locator(".examples button", { hasText: "d/dt h" }).click();
  await frame2();
  check(/em t = 4: 48/.test(await text("#calcResult")), "exemplo d/dt h com h = t³: derivada 3t², vale 48 em t = 4", await text("#calcResult"));
  await page.locator(".examples button", { hasText: "lim |x| / x" }).click();
  await frame2();
  check(/não existe/.test(await text("#calcResult")), "exemplo lim |x|/x: 'não existe' com laterais diferentes");
  await page.locator(".examples button", { hasText: "lim sen x / x" }).click();
  await frame2();
  check(/aproximação numérica/.test(await text("#calcResult")), "exemplo lim sen x/x rotulado como aproximação numérica");
  await page.screenshot({ path: `${here}/poc-editor.png`, fullPage: true });

  const csp = await page.evaluate(() => window.__csp ?? []);
  check(csp.length === 0, "nenhuma violação de CSP", csp.join("; "));
  check(errors.length === 0, "nenhum erro de página", errors.join("; "));
  check(external.length === 0, "nenhuma requisição fora do servidor local (offline)", external.join("; "));
  await page.screenshot({ path: `${here}/poc-limites.png` });
} finally {
  await browser.close();
  server.close();
}
console.log(failures === 0 ? "\nE2E OK" : `\n${failures} FALHA(S)`);
process.exitCode = failures === 0 ? 0 : 1;

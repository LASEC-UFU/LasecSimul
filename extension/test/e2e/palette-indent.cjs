const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");

const extensionRoot = path.resolve(__dirname, "../..");
const catalog = [
  ["P&ID", "Acessórios P&ID", "Subpasta", "Quarto nível", "Quinto nível"],
  ["HMI", "Indicadores", "Subpasta"],
].map((segments, index) => ({
  typeId: `test.palette.${index}`,
  label: `Componente ${index}`,
  category: "Gráfico",
  folderPath: ["Gráfico", ...segments],
  workspaceSection: "misc",
  pinCount: 0,
  defaultProperties: {},
}));

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.LASECSIMUL_BROWSER_EXECUTABLE || undefined,
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 700 } });
    page.on("pageerror", (error) => console.error("Erro da paleta:", error));
    page.on("requestfailed", (request) => console.error("Requisição da paleta:", request.url(), request.failure()?.errorText));
    await page.route("**/*", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/") {
        await route.fulfill({
          contentType: "text/html",
          body: `<html><head><link rel="stylesheet" href="/styles.css"></head><body><main id="app"></main><script>window.__LASECSIMUL_PALETTE_STATE__ = ${JSON.stringify({ catalog, language: "pt-BR" })};</script><script type="module" src="/palette.js"></script></body></html>`,
        });
        return;
      }
      const file = pathname === "/styles.css"
        ? path.join(extensionRoot, "src/ui/palette/styles.css")
        : path.join(extensionRoot, "out-webview", pathname.slice(1));
      await route.fulfill({
        contentType: pathname.endsWith(".css") ? "text/css" : "text/javascript",
        body: fs.readFileSync(file),
      });
    });
    await page.goto("http://palette.test/");
    await page.locator(".palette-tabs__button").last().click();
    await page.locator(".palette-folder__summary").first().waitFor({ timeout: 10000 });
    const positions = await page.evaluate(() => {
      for (const folder of document.querySelectorAll(".palette-folder")) folder.open = true;
      const root = document.querySelector(".palette__tree > .palette-folder");
      if (!root) throw new Error("Pasta raiz ausente");
      const rows = [];
      const visit = (folder, depth, parentLeft) => {
        const summary = folder.querySelector(":scope > .palette-folder__summary");
        const left = summary.getBoundingClientRect().left + parseFloat(getComputedStyle(summary).paddingLeft);
        rows.push({ label: summary.textContent.trim(), depth, left, parentLeft });
        for (const child of folder.querySelectorAll(":scope > .palette-folder__children > .palette-folder")) {
          visit(child, depth + 1, left);
        }
        for (const item of folder.querySelectorAll(":scope > .palette-folder__children > .palette-item")) {
          rows.push({ label: item.textContent.trim(), depth: depth + 1, left: item.querySelector(".palette-item__icon").getBoundingClientRect().left, parentLeft: left });
        }
      };
      visit(root, 0, null);
      return rows;
    });
    assert.equal(positions.length, 11, "As duas árvores e seus componentes devem ser renderizados");
    for (const row of positions.filter((item) => item.depth > 0)) {
      assert.equal(row.left - row.parentLeft, 12, `${row.label} deve avançar 12px por nível`);
    }
    console.log(`Recuo crescente confirmado em ${positions.length} pastas e itens, até ${Math.max(...positions.map((row) => row.depth))} níveis.`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

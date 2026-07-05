import fs from "node:fs";
import { packageSymbolSvg, registerPackage } from "../extension/out-webview/componentSymbols.js";

const catalog = JSON.parse(fs.readFileSync("project/schema/component-catalog.json", "utf8"));
const item = catalog.items.find((entry) => entry.typeId === "sources.controlled_source");
if (!item?.package) throw new Error("sources.controlled_source package nao localizado");

registerPackage("sources.controlled_source", item.package);
const svg = packageSymbolSvg(
  "sources.controlled_source",
  { controlPins: true, currSource: true, currControl: false },
  "controlled-closeup",
);

fs.writeFileSync(
  ".codex-validation/controlled-source-closeup.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="400" viewBox="0 0 48 40"><rect width="48" height="40" fill="#f8f8e8"/>${svg}</svg>`,
  "utf8",
);

fs.writeFileSync(
  ".codex-validation/controlled-source-closeup.html",
  `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#f8f8e8}
.stage{position:relative;width:620px;height:540px;overflow:hidden;background:#f8f8e8}
.component{position:absolute;left:40px;top:20px;width:48px;height:40px;overflow:visible;transform:scale(10);transform-origin:top left}
.component svg{position:absolute;left:0;top:0;width:48px;height:40px;overflow:visible}
.component-floating-label--value{position:absolute;left:${item.package.valueLabel?.x ?? 0}px;top:${item.package.valueLabel?.y ?? 42}px;color:#c0594a;font:600 11px "Segoe UI",Arial,sans-serif;white-space:nowrap}
</style><div class="stage"><div class="component"><svg viewBox="0 0 48 40">${svg}</svg><div class="component-floating-label--value">1.00</div></div></div>`,
  "utf8",
);

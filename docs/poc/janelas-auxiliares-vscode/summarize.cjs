// Summarizes a spike run directory (extension log + driver log).
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const read = (f) => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const ext = read("log.jsonl");
const drv = read("driver.jsonl");
const t0 = Math.min(ext[0]?.t ?? Infinity, drv[0]?.t ?? Infinity);
const rows = [...ext.map((l) => ({ ...l, src: "ext" })), ...drv.map((l) => ({ ...l, src: "drv", event: l.msg }))].sort((a, b) => a.t - b.t);
for (const l of rows) {
  const { t, event, src, msg, ...rest } = l;
  let s;
  if (rest.geo) {
    const g = rest.geo;
    s = `tag=${rest.tag || ""} boots=${g.boots} pos=${g.screenX},${g.screenY} outer=${g.outerWidth}x${g.outerHeight} inner=${g.innerWidth}x${g.innerHeight} ticks=${g.ticks} vis=${g.visibility}` + (rest.error ? " ERR=" + rest.error : "");
  } else if (rest.list) {
    s = "pages=" + rest.count + " " + rest.list.map((p) => `[${p.isMain ? "MAIN" : "aux"} ${p.size && p.size.outerWidth}x${p.size && p.size.outerHeight}]`).join(" ");
  } else s = JSON.stringify(rest).slice(0, 260);
  if (["viewState", "windowState", "tabGroupsChanged", "webview:resize", "webview:visibility"].includes(event)) continue;
  console.log(((t - t0) / 1000).toFixed(1).padStart(6), src, String(event).padEnd(28), s);
}

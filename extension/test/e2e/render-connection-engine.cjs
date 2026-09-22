const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const {
  routeOrthogonalConnection,
  orthogonalizeConnectionWaypoints,
} = require("../../out-test/src/ui/webview/connectionEngine.js");

const output = path.join(__dirname, "artifacts", "connection-engine-routing.png");
fs.mkdirSync(path.dirname(output), { recursive: true });

const scenes = [
  {
    title: "Rota automática com obstáculo",
    source: { x: 105, y: 105, direction: "right" },
    target: { x: 575, y: 105, direction: "left" },
    obstacles: [{ x: 280, y: 55, width: 120, height: 100 }],
  },
  {
    title: "Destino movido: reroteamento automático",
    source: { x: 105, y: 105, direction: "right" },
    target: { x: 575, y: 205, direction: "left" },
    obstacles: [{ x: 280, y: 80, width: 120, height: 110 }],
  },
];

function pointsAttr(points, dy) {
  return points.map((point) => `${point.x},${point.y + dy}`).join(" ");
}

function autoScene(scene, index) {
  const dy = index * 290;
  const route = routeOrthogonalConnection(scene.source, scene.target, scene.obstacles);
  return `
    <g>
      <text x="24" y="${dy + 30}" class="title">${scene.title}</text>
      <rect x="35" y="${dy + 70}" width="70" height="70" class="device"/><text x="70" y="${dy + 110}" class="tag">A</text>
      <rect x="575" y="${dy + 70 + (index ? 100 : 0)}" width="70" height="70" class="device"/><text x="610" y="${dy + 110 + (index ? 100 : 0)}" class="tag">B</text>
      ${scene.obstacles.map((rect) => `<rect x="${rect.x}" y="${rect.y + dy}" width="${rect.width}" height="${rect.height}" class="obstacle"/><text x="${rect.x + rect.width / 2}" y="${rect.y + rect.height / 2 + dy}" class="obstacle-label">equipamento</text>`).join("")}
      <polyline points="${pointsAttr(route, dy)}" class="route"/>
      ${route.slice(1, -1).map((point) => `<circle cx="${point.x}" cy="${point.y + dy}" r="4" class="bend"/>`).join("")}
      <circle cx="${scene.source.x}" cy="${scene.source.y + dy}" r="6" class="port"/>
      <circle cx="${scene.target.x}" cy="${scene.target.y + dy}" r="6" class="port dock"/>
    </g>`;
}

const manualDy = 580;
const manual = orthogonalizeConnectionWaypoints(
  [{ x: 105, y: 105 }, { x: 225, y: 205 }, { x: 455, y: 205 }, { x: 575, y: 105 }],
  []
);

(async () => {
  const installedBrowser = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(installedBrowser ? { executablePath: installedBrowser } : {}) });
  const page = await browser.newPage({ viewport: { width: 700, height: 900 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;background:#e7eef6;font-family:Segoe UI,Arial,sans-serif;color:#142033}
    svg{display:block;width:700px;height:900px;background:#f8fafc}
    .title{font-size:18px;font-weight:700}.device{fill:#edf2f7;stroke:#263746;stroke-width:2;rx:8}
    .tag,.obstacle-label{text-anchor:middle;dominant-baseline:middle;font-weight:700}.tag{font-size:20px}
    .obstacle{fill:#d9e2ec;stroke:#718096;stroke-width:2;stroke-dasharray:6 4}.obstacle-label{font-size:12px;fill:#53657a}
    .route{fill:none;stroke:#177fbd;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}
    .bend{fill:#f4b942;stroke:#805b08;stroke-width:1.5}.port{fill:#fff;stroke:#2463a6;stroke-width:3}.dock{fill:#b7f7c9;stroke:#169447}
    .waypoint{fill:#f4b942;stroke:#805b08;stroke-width:2}.caption{font-size:13px;fill:#53657a}
  </style></head><body><svg viewBox="0 0 700 900">
    ${scenes.map(autoScene).join("")}
    <g>
      <text x="24" y="${manualDy + 30}" class="title">Waypoints manuais persistentes</text>
      <rect x="35" y="${manualDy + 70}" width="70" height="70" class="device"/><text x="70" y="${manualDy + 110}" class="tag">A</text>
      <rect x="575" y="${manualDy + 70}" width="70" height="70" class="device"/><text x="610" y="${manualDy + 110}" class="tag">B</text>
      <polyline points="${pointsAttr(manual, manualDy)}" class="route"/>
      ${manual.slice(1, -1).map((point) => `<circle cx="${point.x}" cy="${point.y + manualDy}" r="6" class="waypoint"/>`).join("")}
      <text x="350" y="${manualDy + 255}" class="caption" text-anchor="middle">selecionar segmento/canto • mover • remover • redefinir automático</text>
    </g>
  </svg></body></html>`);
  await page.screenshot({ path: output, animations: "disabled" });
  await browser.close();
  process.stdout.write(`${output}\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

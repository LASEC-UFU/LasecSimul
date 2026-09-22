const { routeOrthogonalConnection } = require("../../out-test/src/ui/webview/connectionEngine.js");

const obstacles = [];
for (let row = 0; row < 10; row += 1) {
  for (let column = 0; column < 20; column += 1) {
    obstacles.push({ x: 80 + column * 70, y: 60 + row * 70, width: 38, height: 32 });
  }
}

const started = process.hrtime.bigint();
let pointCount = 0;
for (let index = 0; index < 120; index += 1) {
  const y = 25 + (index % 10) * 70;
  const route = routeOrthogonalConnection(
    { x: 10, y, direction: "right" },
    { x: 1500, y: y + ((index % 3) - 1) * 35, direction: "left" },
    obstacles,
  );
  pointCount += route.length;
  for (let point = 0; point + 1 < route.length; point += 1) {
    if (route[point].x !== route[point + 1].x && route[point].y !== route[point + 1].y) {
      throw new Error(`connection ${index} contains a diagonal segment`);
    }
  }
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

process.stdout.write(`${JSON.stringify({
  objects: obstacles.length,
  connections: 120,
  totalMs: Number(elapsedMs.toFixed(2)),
  averageMs: Number((elapsedMs / 120).toFixed(3)),
  pointCount,
})}\n`);

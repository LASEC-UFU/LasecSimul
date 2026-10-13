// Mede a experiência de desenhar/editar fios (não só o resultado): viradas de cotovelo na
// pré-visualização, fidelidade pré-visualização -> fio final, estabilidade da rota ao mover
// componentes/nós, latência do commit, quadros e custo dos handlers. Grava um JSON + capturas em
// test/e2e/artifacts/wire-interaction/<rótulo>/ para comparar versões (ex.: antes/depois).
//   node test/e2e/measure-wire-interaction.cjs <rótulo>
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch, firstLegOrientations, countChanges, isOrthogonal } = require("./wire-lab.cjs");

const label = process.argv[2] || "run";
const outDir = path.resolve(__dirname, "artifacts/wire-interaction", label);
fs.mkdirSync(outDir, { recursive: true });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bends = (points) => Math.max(0, (points?.length ?? 0) - 2);

function interiorSegment(wires) {
  let best;
  for (const wire of wires) {
    for (let index = 0; index + 1 < wire.points.length; index += 1) {
      const a = wire.points[index]; const b = wire.points[index + 1];
      const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      const interior = index > 0 && index + 2 < wire.points.length;
      const score = length + (interior ? 10000 : 0);
      if (!best || score > best.score) best = { score, wireId: wire.id, index, a, b, interior, horizontal: a.y === b.y };
    }
  }
  return best;
}

async function basicScenarios(report) {
  const session = await launch({ fixture: path.resolve(__dirname, "fixtures/wire-scenarios.lsproj") });
  const { lab } = session;
  try {
    const pin = (c, p) => lab.pinScene(c, p);
    const r3b = await pin("r3", "pin-2"); const r2a = await pin("r2", "pin-1"); const r4a = await pin("r4", "pin-1");
    const r6b = await pin("r6", "pin-2");
    if (!r3b || !r2a || !r4a || !r6b) throw new Error("pinos do fixture não encontrados");
    report.pins = { r3b, r2a, r4a };

    // A -- criação: varredura diagonal (o cotovelo vira?), dobra fixada, fecha num pino.
    lab.actions = 0;
    await lab.click(r3b);
    await lab.start("preview");
    await lab.move(add(r3b, { x: 150, y: -70 }), 12);
    await lab.move(add(r3b, { x: 80, y: -150 }), 12);
    await lab.move(add(r3b, { x: 160, y: -60 }), 12);
    const sweep = await lab.stop();
    const orientations = firstLegOrientations(sweep.shapes);
    await lab.shot(path.join(outDir, "A1-preview.png"));
    await lab.click(add(r3b, { x: 112, y: -56 }));
    await lab.move(add(r2a, { x: -40, y: 30 }), 8);
    await lab.move(r2a, 6);
    await lab.settle(120);
    const previewBeforeCommit = (await lab.read()).preview;
    await lab.start();
    await lab.click(r2a);
    const commitMs = await lab.waitWireCount(1);
    await lab.settle();
    const commitMetrics = await lab.stop();
    const wireA = (await lab.read()).wires[0];
    await lab.shot(path.join(outDir, "A2-fechado.png"));
    report.A_criacao = {
      acoes: lab.actions, viradasDoCotovelo: countChanges(orientations), orientacoes: orientations.join(""),
      preview: sweep, commitMs, patchesDoHostNoCommit: commitMetrics.hostPatches,
      previewAntesDoClique: previewBeforeCommit, fioFinal: wireA.points,
      fioFinalIgualAoPreview: same(previewBeforeCommit, wireA.points), ortogonal: isOrthogonal(wireA.points),
    };

    // B -- junção: termina um fio novo no meio de um fio existente.
    lab.actions = 0;
    const target = interiorSegment([wireA]);
    // Ponto no meio do segmento: só a coordenada livre vai pra grade; a fixa é a do próprio fio.
    const mid = target.horizontal
      ? { x: Math.round((target.a.x + target.b.x) / 16) * 8, y: target.a.y }
      : { x: target.a.x, y: Math.round((target.a.y + target.b.y) / 16) * 8 };
    await lab.takeSyncLog();
    const bStartedAt = await lab.now();
    await lab.click(r4a);
    await lab.move(add(r4a, { x: -24, y: -60 }), 8);
    const draftAliveAfterStart = Boolean((await lab.read()).preview);
    await lab.move(mid, 10);
    await lab.settle(120);
    const draftAliveBeforeClick = Boolean((await lab.read()).preview);
    await lab.shot(path.join(outDir, "B0-antes-da-juncao.png"));
    await lab.start();
    await lab.click(mid);
    let junctionMs; let junctionError;
    try { junctionMs = await lab.waitWireCount(3, 3000); } catch (error) { junctionError = String(error.message); }
    await lab.settle();
    const junctionMetrics = await lab.stop();
    const afterB = await lab.read();
    await lab.shot(path.join(outDir, "B1-juncao.png"));
    report.B_juncao = {
      acoes: lab.actions, commitMs: junctionMs, erro: junctionError, fios: afterB.wires.length, juncoes: afterB.junctions,
      rascunhoVivoAposIniciar: draftAliveAfterStart, rascunhoVivoAntesDoClique: draftAliveBeforeClick,
      mensagensDoHost: (await lab.takeSyncLog()).map((entry) => ({ ...entry, at: entry.at - bStartedAt })),
      formas: afterB.wires.map((wire) => wire.points),
      patchesDoHost: junctionMetrics.hostPatches, ortogonal: afterB.wires.every((wire) => isOrthogonal(wire.points)),
    };
    if (afterB.preview) await lab.key("Escape");

    // C -- arrastar um segmento (perpendicular ao próprio eixo).
    lab.actions = 0;
    const before = await lab.read();
    const segment = interiorSegment(before.wires);
    const grab = { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 };
    const delta = segment.horizontal ? { x: 0, y: 40 } : { x: -40, y: 0 };
    await lab.start(segment.wireId);
    await lab.drag(grab, add(grab, delta), { steps: 16 });
    await lab.settle();
    const segmentMetrics = await lab.stop();
    const afterC = await lab.read();
    await lab.shot(path.join(outDir, "C1-segmento.png"));
    report.C_segmento = {
      acoes: lab.actions, segmentoInterno: segment.interior, moveu: !same(before.wires, afterC.wires), metricas: { ...segmentMetrics, shapes: undefined },
      formasDistintas: segmentMetrics.shapes.length, ortogonal: afterC.wires.every((wire) => isOrthogonal(wire.points)),
      juncoes: afterC.junctions.length,
    };

    // D -- mover um componente conectado: a rota mantém a estrutura?
    lab.actions = 0;
    const r2 = await lab.componentScene("r2");
    const wireOnR2 = afterC.wires.find((wire) => wire.points.some((point) => Math.abs(point.x - r2a.x) < 1 && Math.abs(point.y - r2a.y) < 1));
    await lab.start(wireOnR2?.id);
    await lab.drag(r2, add(r2, { x: 72, y: 80 }), { steps: 20 });
    await lab.settle();
    const moveMetrics = await lab.stop();
    const afterD = await lab.read();
    await lab.shot(path.join(outDir, "D1-componente.png"));
    const bendCounts = moveMetrics.shapes.map(bends);
    report.D_componente = {
      acoes: lab.actions, metricas: { ...moveMetrics, shapes: undefined },
      dobrasAoLongoDoArrasto: bendCounts.join(","), mudancasDeEstrutura: countChanges(bendCounts),
      ortogonalSempre: moveMetrics.shapes.every((points) => !points || isOrthogonal(points)),
      formaFinal: afterD.wires.find((wire) => wire.id === wireOnR2?.id)?.points,
    };

    // E -- arrastar o nó de junção.
    lab.actions = 0;
    const node = afterD.junctions[0];
    if (node) {
      await lab.start(afterD.wires[0].id);
      await lab.drag(node, add(node, { x: -48, y: 48 }), { steps: 16 });
      await lab.settle();
      const nodeMetrics = await lab.stop();
      const afterE = await lab.read();
      await lab.shot(path.join(outDir, "E1-no.png"));
      report.E_no = {
        acoes: lab.actions, metricas: { ...nodeMetrics, shapes: undefined }, noDepois: afterE.junctions[0],
        moveu: !same(afterE.junctions[0], node), fios: afterE.wires.length,
        ortogonal: afterE.wires.every((wire) => isOrthogonal(wire.points)),
        dobrasPorFio: afterE.wires.map((wire) => bends(wire.points)).join(","),
      };
    } else report.E_no = { erro: "sem junção para arrastar" };

    // F -- desfazer/refazer.
    const beforeUndo = await lab.read();
    await lab.key("Control+z"); await lab.settle(250);
    const afterUndo1 = await lab.read();
    await lab.key("Control+z"); await lab.settle(250);
    const afterUndo2 = await lab.read();
    await lab.key("Control+y"); await lab.settle(250);
    await lab.key("Control+y"); await lab.settle(250);
    const afterRedo = await lab.read();
    report.F_undo = {
      desfez1: !same(beforeUndo, afterUndo1), desfez2: !same(afterUndo1, afterUndo2),
      refazerRestaurou: same({ w: beforeUndo.wires.map((wire) => wire.points), j: beforeUndo.junctions }, { w: afterRedo.wires.map((wire) => wire.points), j: afterRedo.junctions }),
    };

    // G -- movimento rápido do mouse com um fio em andamento.
    await lab.click(r6b);
    await lab.start("preview");
    for (const offset of [{ x: 260, y: -220 }, { x: -200, y: -300 }, { x: 320, y: 40 }, { x: -120, y: -40 }, { x: 240, y: -260 }]) {
      await lab.move(add(r6b, offset), 3);
    }
    const fast = await lab.stop();
    await lab.shot(path.join(outDir, "G1-rapido.png"));
    report.G_rapido = {
      metricas: { ...fast, shapes: undefined }, viradasDoCotovelo: countChanges(firstLegOrientations(fast.shapes)),
      ortogonalSempre: fast.shapes.every((points) => !points || isOrthogonal(points)),
    };
    await lab.key("Escape");
    await lab.settle(200);
    report.G_rapido.cancelouComEsc = !(await lab.read()).preview;
  } finally {
    await session.close();
  }
}

function denseFixture() {
  const components = []; const conductors = [];
  const columns = 9; const rows = 8;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      components.push({ id: `d${row}_${column}`, typeId: "passive.resistor", label: `D${row}${column}`, properties: { resistance: 100 }, visual: { x: 64 + column * 104, y: 56 + row * 88, rotation: 0 } });
    }
  }
  const port = (row, column, pinId) => ({ kind: "port", componentId: `d${row}_${column}`, pinId });
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column + 1 < columns; column += 1) {
      conductors.push({ id: `h${row}_${column}`, from: port(row, column, "pin-2"), to: port(row, column + 1, "pin-1"), vertices: [] });
    }
  }
  for (let row = 0; row + 1 < rows; row += 1) {
    for (let column = 0; column < columns; column += 3) {
      conductors.push({ id: `v${row}_${column}`, from: port(row, column, "pin-1"), to: port(row + 1, column, "pin-1"), vertices: [] });
    }
  }
  const file = path.join(os.tmpdir(), `lasecsimul-wire-dense-${process.pid}.lsproj`);
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 2, components, topology: { revision: 0, nodes: [], conductors },
    visual: { components: [], wires: [], viewport: { x: 0, y: 0, zoom: 1 } },
    simulationSettings: { frequencyHz: 1000, timeScale: 1, paused: false },
  }));
  return { file, components: components.length, wires: conductors.length };
}

async function denseScenarios(report) {
  const fixture = denseFixture();
  const session = await launch({ fixture: fixture.file });
  const { lab } = session;
  try {
    const loaded = await lab.read();
    report.H_denso = { componentes: fixture.components, fiosNoArquivo: fixture.wires, fiosDesenhados: loaded.wires.length };
    // Pré-visualização de um fio novo atravessando a região densa.
    const from = await lab.pinScene("d0_8", "pin-2");
    await lab.click(from);
    await lab.start("preview");
    await lab.move({ x: from.x - 500, y: from.y + 300 }, 25);
    await lab.move({ x: from.x - 100, y: from.y + 560 }, 25);
    const preview = await lab.stop();
    await lab.key("Escape");
    await lab.settle(200);
    report.H_denso.preview = { ...preview, shapes: undefined, viradasDoCotovelo: countChanges(firstLegOrientations(preview.shapes)) };
    // Arrasto de um componente do meio (2-3 fios presos).
    const body = await lab.componentScene("d3_3");
    const watched = loaded.wires.find((wire) => wire.id === "h3_3")?.id;
    await lab.start(watched);
    await lab.drag(body, add(body, { x: 40, y: 32 }), { steps: 24 });
    await lab.settle();
    const drag = await lab.stop();
    const bendCounts = drag.shapes.map(bends);
    report.H_denso.arrasteDeComponente = { ...drag, shapes: undefined, dobras: bendCounts.join(","), mudancasDeEstrutura: countChanges(bendCounts) };
    await lab.shot(path.join(outDir, "H1-denso.png"));
  } finally {
    await session.close();
    fs.rmSync(fixture.file, { force: true });
  }
}

(async () => {
  const report = { rotulo: label, data: new Date().toISOString() };
  await basicScenarios(report);
  await denseScenarios(report);
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  const brief = JSON.parse(JSON.stringify(report));
  for (const key of ["A_criacao"]) { delete brief[key].preview.shapes; }
  console.log(JSON.stringify(brief, null, 1));
})().catch((error) => { console.error(error); process.exitCode = 1; });

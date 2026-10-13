// Os 20 cenários de conexão comparados com o SimulIDE (docs/48-reengenharia-conexoes-simulide.md),
// executados no VS Code real com mouse e teclado de verdade. Cada cenário confere o RESULTADO
// (topologia e geometria) e a EXPERIÊNCIA (nº de ações, fio final == pré-visualização, latência).
//   node test/e2e/run-wire-scenarios-e2e.cjs [rótulo] [--report]
// `--report` não falha o processo: só registra o que passou (usado pra medir uma versão anterior).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch, sleep, isOrthogonal } = require("./wire-lab.cjs");

const args = process.argv.slice(2);
const reportOnly = args.includes("--report");
const label = args.find((arg) => !arg.startsWith("--")) || "run";
const outDir = path.resolve(__dirname, "artifacts/wire-scenarios", label);
fs.mkdirSync(outDir, { recursive: true });

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const near = (a, b, tolerance = 0.6) => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
const text = (points) => (points ?? []).map((point) => `${point.x},${point.y}`).join(" ");
const same = (a, b) => text(a) === text(b);
const check = (condition, message) => { if (!condition) throw new Error(message); };

function cleanPath(points) {
  for (let index = 0; index + 1 < points.length; index += 1) {
    if (near(points[index], points[index + 1], 0.01)) return false; // segmento de comprimento zero
  }
  for (let index = 0; index + 2 < points.length; index += 1) {
    const [a, b, c] = [points[index], points[index + 1], points[index + 2]];
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) return false; // canto sem função
  }
  return isOrthogonal(points);
}

/** Grade de 72 resistores ligados em linha (cada linha) e em coluna (a cada 3 colunas): 85 fios. */
function denseFixture() {
  const components = []; const conductors = [];
  const columns = 9; const rows = 8;
  const port = (row, column, pinId) => ({ kind: "port", componentId: `d${row}_${column}`, pinId });
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      components.push({ id: `d${row}_${column}`, typeId: "passive.resistor", label: `D${row}${column}`, properties: { resistance: 100 }, visual: { x: 64 + column * 104, y: 56 + row * 88, rotation: 0 } });
      if (column + 1 < columns) conductors.push({ id: `h${row}_${column}`, from: port(row, column, "pin-2"), to: port(row, column + 1, "pin-1"), vertices: [] });
      if (row + 1 < rows && column % 3 === 0) conductors.push({ id: `v${row}_${column}`, from: port(row, column, "pin-1"), to: port(row + 1, column, "pin-1"), vertices: [] });
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

(async () => {
  const session = await launch({ fixture: path.resolve(__dirname, "fixtures/wire-scenarios.lsproj") });
  const { lab, workbench } = session;
  const results = [];
  let failed = 0;

  const pin = async (componentId, pinId) => {
    const point = await lab.pinScene(componentId, pinId);
    if (!point) throw new Error(`pino ${componentId}/${pinId} não encontrado`);
    return point;
  };
  const read = () => lab.read();
  const wireTouching = (state, point) => state.wires.filter((wire) => near(wire.points[0], point) || near(wire.points[wire.points.length - 1], point));
  const assertAllClean = (state, context) => {
    for (const wire of state.wires) check(cleanPath(wire.points), `${context}: fio ${wire.id} com geometria suja [${text(wire.points)}]`);
  };
  /** Clique final de um fio: mede a latência até o fio aparecer e confere fio == pré-visualização. */
  const finishAt = async (point, expectedWires) => {
    await lab.move(point, 4);
    await lab.settle(60);
    const preview = (await read()).preview;
    await lab.click(point);
    const commitMs = await lab.waitWireCount(expectedWires, 4000);
    await lab.settle(120);
    return { preview, commitMs };
  };
  const withKey = async (key, action) => {
    await workbench.keyboard.down(key);
    try { await action(); } finally { await workbench.keyboard.up(key); }
  };

  async function scenario(id, title, body) {
    lab.actions = 0;
    const entry = { id, titulo: title, ok: false };
    try {
      Object.assign(entry, (await body()) ?? {});
      entry.ok = true;
    } catch (error) {
      entry.erro = String(error.message ?? error);
      failed += 1;
      await workbench.keyboard.press("Escape").catch(() => {});
    }
    entry.acoes = lab.actions;
    await lab.settle(150);
    await lab.shot(path.join(outDir, `${id}.png`)).catch(() => {});
    results.push(entry);
    console.log(`${entry.ok ? "ok  " : "FALHA"} ${id} ${title}${entry.erro ? " -- " + entry.erro : ""}`);
  }

  try {
    const r1b = await pin("r1", "pin-2"); const r2a = await pin("r2", "pin-1");
    const r3b = await pin("r3", "pin-2"); const r4a = await pin("r4", "pin-1"); const r4b = await pin("r4", "pin-2");
    const r5a = await pin("r5", "pin-1"); const r5b = await pin("r5", "pin-2");
    const r6a = await pin("r6", "pin-1"); const r6b = await pin("r6", "pin-2");
    const r7a = await pin("r7", "pin-1"); const r7b = await pin("r7", "pin-2");

    await scenario("01", "Conectar dois terminais próximos", async () => {
      await lab.click(r3b);
      const { preview, commitMs } = await finishAt(r4a, 1);
      const state = await read();
      const wire = state.wires[0];
      check(wire.points.length === 2 && near(wire.points[0], r3b) && near(wire.points[1], r4a), `esperava uma reta entre os pinos, veio [${text(wire.points)}]`);
      check(same(preview, wire.points), "fio final difere da pré-visualização");
      check(state.junctions.length === 0, "não deveria haver junção");
      return { commitMs, forma: text(wire.points) };
    });

    await scenario("02", "Conectar terminais distantes", async () => {
      await lab.click(r5b);
      await lab.move(add(r5b, { x: 0, y: 40 }), 4); // sai descendo: 1ª perna vertical
      await lab.move(add(r7b, { x: 40, y: -40 }), 10);
      const { preview, commitMs } = await finishAt(r7b, 2);
      const wire = wireTouching(await read(), r7b)[0];
      check(wire && wire.points.length === 3, `esperava um L (3 pontos), veio [${text(wire?.points)}]`);
      check(wire.points[1].x === r5b.x && wire.points[1].y === r7b.y, "o canto deveria manter a 1ª perna vertical escolhida no início");
      check(same(preview, wire.points) && cleanPath(wire.points), "fio final difere da pré-visualização ou não é ortogonal");
      return { commitMs, forma: text(wire.points) };
    });

    await scenario("03", "Criar conexão com mudança de direção", async () => {
      await lab.click(r1b);
      const waypoint = add(r1b, { x: 32, y: 0 });
      await lab.move(waypoint, 4);
      await lab.click(waypoint); // ponto de passagem
      await lab.move(add(waypoint, { x: 8, y: 120 }), 8);
      const { preview, commitMs } = await finishAt(r6a, 3);
      const wire = wireTouching(await read(), r6a)[0];
      const expected = [r1b, waypoint, { x: waypoint.x, y: r6a.y }, r6a];
      check(wire && same(wire.points, expected), `esperava [${text(expected)}], veio [${text(wire?.points)}]`);
      check(same(preview, wire.points), "fio final difere da pré-visualização");
      return { commitMs, forma: text(wire.points) };
    });

    await scenario("04", "Alterar uma dobra existente", async () => {
      const before = wireTouching(await read(), r6a)[0];
      const corner = before.points[2];
      await lab.drag(corner, add(corner, { x: -16, y: 0 }), { steps: 8 });
      await lab.settle();
      const after = wireTouching(await read(), r6a)[0];
      check(after.points.length === 4 && after.points[1].x === corner.x - 16 && after.points[2].x === corner.x - 16, `a perna vertical deveria ir para x=${corner.x - 16}: [${text(after.points)}]`);
      check(near(after.points[0], r1b) && near(after.points[3], r6a) && cleanPath(after.points), "pontas deveriam continuar nos pinos");
      return { forma: text(after.points) };
    });

    await scenario("05", "Arrastar segmento horizontal", async () => {
      await lab.click(r6b);
      const waypoint = add(r6b, { x: 0, y: -104 });
      await lab.move(waypoint, 6);
      await lab.click(waypoint);
      await lab.move(add(waypoint, { x: 160, y: -8 }), 8);
      await finishAt(r5a, 4);
      const created = wireTouching(await read(), r5a)[0];
      check(created.points.length === 4, `esperava V-H-V, veio [${text(created.points)}]`);
      const [a, b] = [created.points[1], created.points[2]];
      const grab = { x: (a.x + b.x) / 2, y: a.y };
      await lab.drag(grab, add(grab, { x: 0, y: 32 }), { steps: 10 });
      await lab.settle();
      const after = wireTouching(await read(), r5a)[0];
      // O segmento arrastado cai na grade GLOBAL (o fio saiu de um pino fora dela, em y=...,5).
      const landed = Math.round((a.y + 32) / 8) * 8;
      check(after.points.length === 4 && after.points[1].y === landed && after.points[2].y === landed, `segmento deveria descer para y=${landed}: [${text(after.points)}]`);
      check(after.points[1].x === a.x && after.points[2].x === b.x && cleanPath(after.points), "os vizinhos só deveriam esticar");
      return { forma: text(after.points) };
    });

    await scenario("06", "Arrastar segmento vertical", async () => {
      const before = wireTouching(await read(), r6a)[0];
      const [a, b] = [before.points[1], before.points[2]];
      const grab = { x: a.x, y: (a.y + b.y) / 2 + 40 };
      await lab.drag(grab, add(grab, { x: 24, y: 0 }), { steps: 10 });
      await lab.settle();
      const after = wireTouching(await read(), r6a)[0];
      check(after.points.length === 4 && after.points[1].x === a.x + 24 && after.points[2].x === a.x + 24, `segmento deveria ir 24 à direita: [${text(after.points)}]`);
      check(after.points[1].y === a.y && after.points[2].y === b.y && cleanPath(after.points), "os vizinhos só deveriam esticar");
      return { forma: text(after.points) };
    });

    await scenario("07", "Conectar uma linha ao meio de outra", async () => {
      const state = await read();
      const target = wireTouching(state, r5a)[0];
      const onWire = { x: r4b.x, y: target.points[1].y };
      await lab.click(r4b);
      await lab.move(add(r4b, { x: 0, y: 40 }), 4);
      const { preview, commitMs } = await finishAt(onWire, state.wires.length + 2);
      const after = await read();
      check(after.junctions.length === 1 && near(after.junctions[0], onWire), `esperava uma junção em ${text([onWire])}, há [${text(after.junctions)}]`);
      const branch = wireTouching(after, r4b)[0];
      check(branch.points.length === 2 && same(preview, branch.points), `ramo deveria ser a reta da pré-visualização: fio [${text(branch.points)}], pré-visualização [${text(preview)}]`);
      check(after.wires.filter((wire) => wire.points.some((point) => near(point, onWire))).length === 3, "três fios deveriam se encontrar na junção");
      assertAllClean(after, "07");
      return { commitMs, juncao: text(after.junctions) };
    });

    await scenario("08", "Criar uma ramificação em T (a partir de um fio)", async () => {
      const before = await read();
      const start = { x: r3b.x + 104, y: r3b.y };
      // Esc depois de começar no fio não pode deixar nó nem fio para trás.
      await lab.click(start);
      await lab.move(add(start, { x: 0, y: -40 }), 4);
      check(Boolean((await read()).preview), "clicar sobre um fio deveria iniciar uma derivação");
      await lab.key("Escape");
      await lab.settle(150);
      const cancelled = await read();
      check(cancelled.wires.length === before.wires.length && cancelled.junctions.length === before.junctions.length && !cancelled.preview, "Esc deveria cancelar sem deixar resíduo");
      await lab.click(start);
      await lab.move(add(start, { x: 0, y: -40 }), 4);
      const { preview, commitMs } = await finishAt(r2a, before.wires.length + 2);
      const after = await read();
      check(after.junctions.length === before.junctions.length + 1 && after.junctions.some((node) => near(node, start)), "deveria nascer um nó no ponto clicado");
      const branch = wireTouching(after, r2a)[0];
      check(same(branch.points, [start, { x: start.x, y: r2a.y }, r2a]) && same(preview, branch.points), `ramo inesperado: [${text(branch.points)}]`);
      assertAllClean(after, "08");
      return { commitMs, forma: text(branch.points) };
    });

    await scenario("09", "Criar múltiplas ramificações", async () => {
      const before = await read();
      const trunk = before.wires.find((wire) => near(wire.points[wire.points.length - 1], r5a));
      const onWire = { x: r7a.x, y: before.junctions.find((node) => node.x === r4b.x).y };
      check(trunk, "tronco não encontrado");
      // Arrastar do pino e soltar SOBRE o fio: conecta no solte, sem segundo clique.
      await lab.drag(r7a, onWire, { steps: 10 });
      const commitMs = await lab.waitWireCount(before.wires.length + 2, 4000);
      await lab.settle(150);
      const after = await read();
      check(after.junctions.length === before.junctions.length + 1 && after.junctions.some((node) => near(node, onWire)), "segunda junção no mesmo tronco");
      check(!after.preview, "soltar sobre o fio deveria encerrar o desenho");
      assertAllClean(after, "09");
      return { commitMs, juncoes: after.junctions.length };
    });

    await scenario("10", "Arrastar um nó com três conexões", async () => {
      const before = await read();
      const node = before.junctions.find((entry) => entry.x === r4b.x);
      const target = add(node, { x: 24, y: 24 });
      await lab.start(before.wires[0].id);
      await lab.drag(node, target, { steps: 12 });
      await lab.settle();
      const metrics = await lab.stop();
      const after = await read();
      check(after.junctions.some((entry) => near(entry, target)), `nó deveria ir para ${text([target])}: [${text(after.junctions)}]`);
      check(after.wires.length === before.wires.length && after.junctions.length === before.junctions.length, "arrastar o nó não pode criar nem remover fios/nós");
      check(after.wires.filter((wire) => wire.points.some((point) => near(point, target))).length === 3, "os três fios deveriam continuar presos ao nó");
      assertAllClean(after, "10");
      return { quadrosLentos: metrics.slowFrames, handlersMs: metrics.handlers };
    });

    await scenario("11", "Mover um componente conectado", async () => {
      const before = await read();
      const wire = wireTouching(before, r2a)[0];
      const body = await lab.componentScene("r2");
      await lab.start(wire.id);
      await lab.drag(body, add(body, { x: 48, y: 32 }), { steps: 16 });
      await lab.settle();
      const metrics = await lab.stop();
      const moved = add(r2a, { x: 48, y: 32 });
      const after = await read();
      const result = wireTouching(after, moved)[0];
      check(result, `o fio deveria acompanhar o pino até ${text([moved])}`);
      check(result.points.length === wire.points.length, `mover o componente não deveria criar/remover dobras: [${text(result.points)}]`);
      check(same(result.points.slice(0, 1), wire.points.slice(0, 1)) && result.points[1].x === wire.points[1].x, "só o canto vizinho ao pino deveria deslizar");
      check(metrics.shapes.every((points) => !points || isOrthogonal(points)), "rota diagonal durante o arrasto");
      const bends = metrics.shapes.filter(Boolean).map((points) => points.length);
      check(new Set(bends).size === 1, `a estrutura da rota mudou durante o arrasto: ${bends.join(",")}`);
      assertAllClean(after, "11");
      return { forma: text(result.points), quadrosLentos: metrics.slowFrames };
    });

    await scenario("12", "Mover dois componentes conectados", async () => {
      const before = await read();
      const between = before.wires.find((wire) => near(wire.points[0], r5b) && near(wire.points[wire.points.length - 1], r7b));
      check(between, "fio entre r5 e r7 não encontrado");
      const r5 = await lab.componentScene("r5");
      const r7 = await lab.componentScene("r7");
      await lab.click(r5);
      await withKey("Shift", () => lab.click(r7));
      await lab.drag(r7, add(r7, { x: 32, y: 16 }), { steps: 12 });
      await lab.settle();
      const after = await read();
      const moved = after.wires.find((wire) => near(wire.points[0], add(r5b, { x: 32, y: 16 })) && near(wire.points[wire.points.length - 1], add(r7b, { x: 32, y: 16 })));
      check(moved, "o fio entre os dois componentes deveria ter ido junto");
      check(same(moved.points, between.points.map((point) => add(point, { x: 32, y: 16 }))), `o fio deveria transladar rígido: [${text(moved.points)}]`);
      assertAllClean(after, "12");
      await lab.click({ x: 40, y: 500 }); // limpa a seleção
      return { forma: text(moved.points) };
    });

    await scenario("13", "Alterar o percurso de uma conexão existente", async () => {
      const before = wireTouching(await read(), r6a)[0];
      const [a, b] = [before.points[1], before.points[2]];
      const grab = { x: a.x, y: (a.y + b.y) / 2 + 60 };
      await lab.drag(grab, add(grab, { x: -24, y: 0 }), { steps: 8 });
      await lab.settle(200);
      const middle = wireTouching(await read(), r6a)[0];
      const corner = middle.points[1];
      await lab.drag(corner, add(corner, { x: 16, y: 0 }), { steps: 6 });
      await lab.settle();
      const after = wireTouching(await read(), r6a)[0];
      check(near(after.points[0], r1b) && near(after.points[after.points.length - 1], r6a), "as pontas não podem sair dos pinos");
      check(cleanPath(after.points) && after.points.length === 4, `rota deveria continuar limpa com 4 pontos: [${text(after.points)}]`);
      check(after.points[1].x === a.x - 24 + 16, `perna vertical deveria terminar em x=${a.x - 8}: [${text(after.points)}]`);
      return { forma: text(after.points) };
    });

    await scenario("14", "Desfazer e refazer operações", async () => {
      const now = await read();
      const snapshot = (state) => JSON.stringify([state.wires.map((wire) => text(wire.points)).sort(), state.junctions.map((node) => `${node.x},${node.y}`).sort()]);
      const trail = [snapshot(now)];
      for (let step = 0; step < 3; step += 1) {
        await lab.key("Control+z");
        await lab.settle(220);
        trail.push(snapshot(await read()));
        check(trail[trail.length - 1] !== trail[trail.length - 2], `Ctrl+Z nº ${step + 1} não mudou nada`);
      }
      for (let step = 0; step < 3; step += 1) {
        await lab.key("Control+y");
        await lab.settle(220);
        const current = snapshot(await read());
        check(current === trail[2 - step], `Ctrl+Y nº ${step + 1} não restaurou o estado correspondente`);
      }
      assertAllClean(await read(), "14");
      return { passos: 3 };
    });

    await scenario("15", "Excluir uma ramificação", async () => {
      const before = await read();
      const r7pin = add(r7a, { x: 32, y: 16 });
      const branch = wireTouching(before, r7pin)[0];
      check(branch, "ramo de r7 não encontrado");
      const grab = { x: (branch.points[0].x + branch.points[1].x) / 2, y: (branch.points[0].y + branch.points[1].y) / 2 };
      await lab.click({ x: 40, y: 500 }); // refazer restaura a seleção antiga; começa de seleção vazia
      await withKey("Control", () => lab.click(grab));
      await lab.key("Delete");
      await lab.settle(300);
      const after = await read();
      check(after.junctions.length === before.junctions.length - 1, `o nó de grau 2 deveria sumir: ${after.junctions.length} junções`);
      check(after.wires.length === before.wires.length - 2, `ramo removido + tronco refundido: ${before.wires.length} -> ${after.wires.length} fios`);
      assertAllClean(after, "15");
      return { fios: after.wires.length, juncoes: after.junctions.length };
    });

    await scenario("16", "Reconectar uma linha", async () => {
      const before = await read();
      const r7pin = add(r7a, { x: 32, y: 16 });
      const trunk = before.wires.find((wire) => wire.points.some((point, index) => index + 1 < wire.points.length && point.y === wire.points[index + 1].y && Math.min(point.x, wire.points[index + 1].x) < r7pin.x && Math.max(point.x, wire.points[index + 1].x) > r7pin.x && point.y < r7pin.y));
      check(trunk, "tronco para reconectar não encontrado");
      const segment = trunk.points.findIndex((point, index) => index + 1 < trunk.points.length && point.y === trunk.points[index + 1].y && Math.min(point.x, trunk.points[index + 1].x) < r7pin.x && Math.max(point.x, trunk.points[index + 1].x) > r7pin.x);
      const onWire = { x: r7pin.x, y: trunk.points[segment].y };
      await lab.click(r7pin);
      const { commitMs } = await finishAt(onWire, before.wires.length + 2);
      const after = await read();
      check(after.junctions.length === before.junctions.length + 1 && after.junctions.some((node) => near(node, onWire)), "a junção deveria voltar");
      assertAllClean(after, "16");
      return { commitMs };
    });

    await scenario("17", "Criar conexão próxima de vários segmentos (cruzar sem conectar)", async () => {
      const before = await read();
      const r3a = await pin("r3", "pin-1");
      const r1a = await pin("r1", "pin-1");
      // Sobe pela esquerda de tudo, passando a um passo de grade de outros fios, e fecha em r1.
      await lab.click(r3a);
      const left = add(r3a, { x: -24, y: 0 });
      await lab.move(left, 4);
      await lab.click(left);
      await lab.move(add(left, { x: 0, y: -80 }), 8);
      const { preview, commitMs } = await finishAt(r1a, before.wires.length + 1);
      const after = await read();
      check(after.junctions.length === before.junctions.length, "passar perto/cruzar outros fios não pode criar junção");
      const wire = wireTouching(after, r3a)[0];
      check(same(preview, wire.points) && cleanPath(wire.points), `rota inesperada: [${text(wire.points)}]`);
      assertAllClean(after, "17");
      return { commitMs, forma: text(wire.points) };
    });

    await scenario("19", "Realizar movimentos rápidos do mouse", async () => {
      const before = await read();
      const start = await pin("r2", "pin-2"); // posição ATUAL (r2 foi movido no cenário 11)
      await lab.click(start);
      await lab.start("preview");
      for (const offset of [{ x: 200, y: -160 }, { x: -300, y: 200 }, { x: 260, y: 240 }, { x: -80, y: -60 }, { x: 220, y: -200 }, { x: 16, y: 300 }]) {
        await lab.move(add(start, offset), 2);
      }
      const metrics = await lab.stop();
      check(metrics.shapes.length > 3, "a pré-visualização deveria acompanhar o cursor");
      check(metrics.shapes.every((points) => !points || cleanPath(points)), "pré-visualização suja durante movimento rápido");
      await lab.key("Escape");
      await lab.settle(150);
      const after = await read();
      check(!after.preview && after.wires.length === before.wires.length && after.junctions.length === before.junctions.length, "cancelar não pode deixar resíduo");
      return { handlersMs: metrics.handlers, quadrosLentos: metrics.slowFrames, formas: metrics.shapes.length };
    });

    await scenario("20", "Editar repetidamente uma conexão complexa", async () => {
      const before = await read();
      for (let round = 0; round < 6; round += 1) {
        const state = await read();
        const wire = wireTouching(state, r6a)[0];
        const [a, b] = [wire.points[1], wire.points[2]];
        const grab = { x: a.x, y: (a.y + b.y) / 2 + 60 };
        await lab.drag(grab, add(grab, { x: round % 2 === 0 ? 32 : -32, y: 0 }), { steps: 6 });
        await lab.settle(120);
        const node = (await read()).junctions[0];
        await lab.drag(node, add(node, { x: 0, y: round % 2 === 0 ? 16 : -16 }), { steps: 6 });
        await lab.settle(120);
      }
      const after = await read();
      check(after.wires.length === before.wires.length && after.junctions.length === before.junctions.length, "edições repetidas não podem criar/remover fios ou nós");
      assertAllClean(after, "20");
      const totalBends = (state) => state.wires.reduce((sum, wire) => sum + wire.points.length, 0);
      check(totalBends(after) <= totalBends(before) + 2, `as edições acumularam cantos: ${totalBends(before)} -> ${totalBends(after)}`);
      check(same(after.wires.map((wire) => wire.points).flat(), before.wires.map((wire) => wire.points).flat()), "ida e volta em passos iguais deveria devolver a geometria original");
      return { pontos: totalBends(after) };
    });
  } finally {
    await session.close();
  }

  // Cenário 18 roda num circuito próprio (72 componentes, 85 fios).
  const dense = denseFixture();
  const denseSession = await launch({ fixture: dense.file });
  try {
    const lab = denseSession.lab;
    const entry = { id: "18", titulo: "Fazer conexões em regiões densas", ok: false };
    try {
      const before = await lab.read();
      if (before.wires.length !== dense.wires) throw new Error(`esperava ${dense.wires} fios desenhados, há ${before.wires.length}`);
      const from = await lab.pinScene("d0_8", "pin-2");
      const trunk = before.wires.find((wire) => wire.id === "h3_7");
      const onWire = { x: (trunk.points[0].x + trunk.points[1].x) / 2, y: trunk.points[0].y };
      lab.actions = 0;
      await lab.click(from);
      await lab.start("preview");
      const first = { x: from.x + 24, y: from.y };
      await lab.move(first, 4);
      await lab.click(first);
      const second = { x: first.x, y: onWire.y - 32 };
      await lab.move(second, 16);
      await lab.click(second);
      await lab.move({ x: onWire.x + 16, y: second.y }, 8);
      await lab.move(onWire, 6);
      await lab.settle(80);
      const drawing = await lab.stop();
      const preview = (await lab.read()).preview;
      await lab.click(onWire);
      const commitMs = await lab.waitWireCount(before.wires.length + 2, 4000);
      await lab.settle(200);
      const after = await lab.read();
      const branch = after.wires.find((wire) => Math.abs(wire.points[0].x - from.x) < 1 && Math.abs(wire.points[0].y - from.y) < 1 && wire.id !== "h0_7");
      if (after.junctions.length !== 1) throw new Error(`esperava 1 junção, há ${after.junctions.length}`);
      if (!branch || text(branch.points) !== text(preview)) throw new Error(`fio final difere da pré-visualização: [${text(branch?.points)}] x [${text(preview)}]`);
      for (const wire of after.wires) if (!cleanPath(wire.points)) throw new Error(`fio ${wire.id} com geometria suja`);
      // Arrasto de um componente do meio, com três fios presos.
      const body = await lab.componentScene("d3_3");
      await lab.start("h3_3");
      await lab.drag(body, add(body, { x: 40, y: 32 }), { steps: 24 });
      await lab.settle();
      const drag = await lab.stop();
      const sizes = drag.shapes.filter(Boolean).map((points) => points.length);
      if (!drag.shapes.every((points) => !points || isOrthogonal(points))) throw new Error("rota diagonal durante o arrasto");
      if (new Set(sizes.slice(1)).size > 1) throw new Error(`a estrutura da rota mudou durante o arrasto: ${sizes.join(",")}`);
      if (commitMs > 250) throw new Error(`fio levou ${commitMs} ms para aparecer`);
      if (drawing.handlers.p95 > 12 || drag.handlers.p95 > 12) throw new Error(`handlers lentos: desenho p95 ${drawing.handlers.p95} ms, arrasto p95 ${drag.handlers.p95} ms`);
      Object.assign(entry, { ok: true, componentes: dense.components, fios: dense.wires, commitMs, desenhoHandlersMs: drawing.handlers, arrastoHandlersMs: drag.handlers, quadrosLentos: drawing.slowFrames + drag.slowFrames });
    } catch (error) {
      entry.erro = String(error.message ?? error);
      failed += 1;
    }
    entry.acoes = lab.actions;
    await lab.shot(path.join(outDir, "18.png")).catch(() => {});
    results.push(entry);
    results.sort((a, b) => a.id.localeCompare(b.id));
    console.log(`${entry.ok ? "ok  " : "FALHA"} 18 ${entry.titulo}${entry.erro ? " -- " + entry.erro : ""}`);
  } finally {
    await denseSession.close();
    fs.rmSync(dense.file, { force: true });
  }

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ rotulo: label, cenarios: results }, null, 2));
  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n${passed}/${results.length} cenários aprovados (rótulo: ${label})`);
  if (failed > 0 && !reportOnly) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });

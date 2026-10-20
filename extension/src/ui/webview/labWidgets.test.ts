import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { identifierToMathML } from "./lab/calc/mathml";
import { TANK_PLANT } from "./lab/plants";
import { SeriesBuffer } from "./lab/series/SeriesBuffer";
import { labComposedPage } from "./labComposedPages";
import {
  MATH_PROCESS_TANK_TYPE_ID, MATH_SERIES_CHART_TYPE_ID, cardSvg, fmt, labWidgetSvg, plantParameterSvg, plantParameterValueAt, processTankSvg, readoutSvg,
  seriesChartFrame, seriesChartSvg, simControlsLayout, simControlsSvg, wrapText,
} from "./labWidgets";
import { equationSvg, formulaMathML, mathWidgetSvg } from "./mathWidgets";

/** Tanque simulado: entra 1 L/s, sai 0,4 L/s, A = 0,1 m², V₀ = 20 L, 10 s em passos de 0,01 s. */
function tankBuffer(seconds = 10): SeriesBuffer {
  const buffer = new SeriesBuffer(true);
  const columns = ["V", "h", "A", "inActual", "outActual", "overflow", "unmet", "cumIn", "cumOut", "cumOverflow", "cumSpill"];
  const t: number[] = [], values: number[][] = columns.map(() => []);
  for (let i = 0; i <= seconds * 100; i++) {
    const time = i / 100, V = 20 + 0.6 * time;
    const row: Record<string, number> = { V, h: V / 1000 / 0.1, A: 0.1, inActual: 1, outActual: 0.4, overflow: 0, unmet: 0, cumIn: time, cumOut: 0.4 * time, cumOverflow: 0, cumSpill: 0 };
    t.push(time);
    columns.forEach((column, index) => values[index]!.push(row[column]!));
  }
  buffer.ingest({ reset: true, generation: 1, columns, t, values, events: [{ tS: 5, kind: "parameter", name: "qIn", value: 1 }], lost: 0 });
  return buffer;
}

const plant = (buffer: SeriesBuffer | undefined, status = "running") => ({
  plantComponentId: "tanque-lab", __plant_buffer: buffer, __plant_kind: "tank", __sim_status: status,
  __plant_params: { qIn: 1, qOut: 0.4, area: 0.1, k: 2, torr: 1.4, outlet: 0, hMax: 1, v0: 20 },
});

(async () => {
  const { test, finish } = createTestRunner("labWidgets");

  await test("formatação pt-BR e quebra de linha do cartão", () => {
    assert(fmt(0.006) === "0,006" && fmt(1234.5, 3) === "1.234,5" && fmt(NaN) === "—", `${fmt(0.006)} ${fmt(1234.5, 3)}`);
    const lines = wrapText("como a vazão altera a inclinação da curva", 120, 14);
    assert(lines.length >= 2 && lines.every((line) => line.length > 0), JSON.stringify(lines));
    const card = cardSvg({ title: "Explore:", icon: "bulb", text: "Arraste o cursor." }, { width: 300, height: 140 });
    assert(card.includes("Explore:") && card.includes("Arraste o cursor.") && card.includes("<linearGradient"), "título, texto e degradê");
  });

  await test("gráfico: eixo do tempo em passos bonitos, cursor no presente, intervalo a < b", () => {
    const buffer = tankBuffer(30);
    const frame = seriesChartFrame({ title: "Nível × tempo", channel: "h", a: 20, b: 4 }, { width: 640, height: 320 }, buffer);
    assert(frame.t0 === 0 && frame.t1 === 35, `t1 = ${frame.t1}`);
    assert(Math.abs(frame.cursor - 30) < 1e-9, "cursor −1 acompanha o presente");
    assert(frame.a === 4 && frame.b === 20, "a e b em ordem");
    assert(frame.y0 === 0 && frame.y1 > 0.38, `y em [${frame.y0}, ${frame.y1}] inclui 0 sem descer um passo`);
  });

  await test("gráfico: tangente = q/A, secante e Riemann = ∫ = ΔV", () => {
    const buffer = tankBuffer(10);
    const svg = seriesChartSvg({ ...plant(buffer), channel: "h", title: "Nível", showTangent: true, showSecant: true, a: 2, b: 8, cursor: 5 }, { width: 800, height: 360 });
    assert(svg.includes("dh/dt ≈ 0,006 m/s") && svg.includes("Δh/Δt = 0,006 m/s"), "tangente e secante = 0,6 L/s ÷ 0,1 m²");
    const flow = seriesChartSvg({ ...plant(buffer), channel: "q", showRiemann: true, riemannN: 12, a: 0, b: 10 }, { width: 800, height: 360 });
    assert(flow.includes("Σ esquerda, n = 12: 6 L") && flow.includes("∫ = 6 L"), "Riemann e integral exata = 0,6 L/s · 10 s");
    assert(flow.includes('line x1=') || flow.includes("<path"), "curva desenhada");
    const waiting = seriesChartSvg({ ...plant(undefined, "stopped"), channel: "h" }, { width: 640, height: 320 });
    assert(waiting.includes("Execute a simulação"), "sem série: convite para executar");
  });

  await test("tanque: nível, V, A, vazões; parado mostra V₀ e as vazões configuradas", () => {
    const running = processTankSvg(plant(tankBuffer(10)), { width: 340, height: 380 });
    assert(running.includes("V = 26 L") && running.includes("entrada 1 L/s") && running.includes("saída 0,4 L/s") && running.includes("m²"), "valores da série");
    assert(running.includes('class="lw-flow"') && running.includes('class="lw-wave"'), "água correndo e superfície animadas");
    const stopped = processTankSvg(plant(undefined, "stopped"), { width: 340, height: 380 });
    assert(stopped.includes("V = 20 L") && stopped.includes("entrada 1 L/s") && !stopped.includes('class="lw-flow"'), "parado: V₀ e sem jato");
    const generic = mathWidgetSvg(MATH_PROCESS_TANK_TYPE_ID, { value: 40 }, { width: 200, height: 240 });
    assert(Boolean(generic?.includes("40 %")), "sem planta: nível em % da fonte");
  });

  await test("parâmetro da planta: valor, trava estrutural e passo", () => {
    const qIn = plantParameterSvg({ ...plant(undefined), parameterId: "qIn" }, { width: 300, height: 72 });
    assert(qIn.includes("Vazão de entrada") && qIn.includes("1 L/s"), "rótulo e valor da planta");
    const locked = plantParameterSvg({ ...plant(undefined, "running"), parameterId: "hMax" }, { width: 300, height: 72 });
    assert(locked.includes("pare a simulação"), "estrutural travado com a simulação rodando");
    const spec = TANK_PLANT.parameters.find((parameter) => parameter.id === "qIn")!;
    assert(plantParameterValueAt(spec, 0.5) === 1 && plantParameterValueAt(spec, 0.51) === 1 && plantParameterValueAt(spec, 2) === 2, "passo de 0,05 e faixa");
  });

  await test("controles, leitura e despacho", () => {
    const layout = simControlsLayout({ width: 480, height: 64 });
    assert(layout.run.x < layout.pause.x && layout.pause.x < layout.restart.x, "Executar, Pausar, Reiniciar");
    const controls = simControlsSvg({ ...plant(tankBuffer(3)) }, { width: 480, height: 64 });
    assert(controls.includes("Simulação em tempo real") && controls.includes("3 s"), "estado e tempo simulado");
    const readout = readoutSvg({ ...plant(tankBuffer(10)), quantity: "V", decimals: 1 }, { width: 220, height: 60 });
    assert(readout.includes(">26<") && readout.includes("L"), "V = 26 L");
    assert(labWidgetSvg(MATH_SERIES_CHART_TYPE_ID, {}, { width: 300, height: 200 })?.includes("Escolha a planta") === true, "gráfico sem planta pede a planta");
  });

  await test("fórmula exibida: índices, gregas, frações e integral; equação com a planta", () => {
    assert(identifierToMathML("q_e") === "<msub><mi>q</mi><mi>e</mi></msub>" && identifierToMathML("V_0") === "<msub><mi>V</mi><mn>0</mn></msub>", "índices");
    assert(identifierToMathML("tau") === "<mi>τ</mi>" && identifierToMathML("dh").includes("<mi>d</mi><mi>h</mi>"), "grega e diferencial");
    const ml = formulaMathML("V = V_0 + Integrate(tau, 0, t, q)");
    assert(Boolean(ml?.includes("<msubsup><mo>∫</mo>") && ml.includes("<mo>=</mo>")), ml ?? "inválida");
    assert(Boolean(formulaMathML("dh/dt = q/A")?.includes("<mfrac>")), "fração");
    const live = equationSvg({ formula: "q = q_e - q_s", expression: "inActual - outActual", variable: "", unit: "L/s", decimals: 2, ...plant(tankBuffer(2)) }, { width: 420, height: 120 }, {});
    assert(live.includes("<msub>") && live.includes("0,6") && live.includes("L/s"), "fórmula + valor da planta");
  });

  await test("páginas compostas: só elementos, todos ligados à planta", () => {
    const page = labComposedPage("tank", "tanque-lab");
    assert(page.width === 1920 && page.height === 1080 && page.elements.every((element) => element.typeId?.startsWith("graphics.math.")), "1920×1080, elementos de tela");
    const bound = page.elements.filter((element) => typeof element.properties?.plantComponentId === "string" && element.properties.plantComponentId === "tanque-lab");
    assert(bound.length >= 10 && !page.elements.some((element) => element.typeId === "graphics.math.activity"), `${bound.length} ligados, sem atividade`);
    const ids = new Set(page.elements.map((element) => element.id));
    assert(ids.size === page.elements.length && !labComposedPage("tank", "x", "-2").elements.some((element) => ids.has(element.id)), "ids únicos e sufixo");
    for (const kind of ["firstOrder", "sensor"] as const) assert(labComposedPage(kind, "p").elements.length > 8, kind);
  });

  finish();
})();

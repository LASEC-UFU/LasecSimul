/**
 * Telas de processo dos modelos TDPS, montadas com a biblioteca gráfica nativa (`graphics.*`)
 * em vez do bitmap de referência.
 *
 * Substitui `apply-tdps-reference-symbols.mjs`, que gravava
 * `symbol.background = { kind:"image", asset: "<png>" }` -- ou seja, a tela de processo ERA a foto,
 * com os blocos de controle projetados por cima. Aqui a tela passa a ser uma composição de objetos
 * editáveis: cada elemento é um componente normal do subcircuito (`components[]`), exposto no
 * símbolo (`exposedComponents[]`) e, quando mostra um valor, ligado por `bindSource` ao id estável
 * da sonda que o mede.
 *
 * REGRA ARQUITETURAL (task §36): não existe "renderizador do processo N". Existe um COMPOSITOR
 * genérico que lê o próprio modelo -- seus `control.pid`, `control.process` e `control.observer`,
 * com os rótulos e unidades que o importador TDPS já preservou -- e escolhe símbolos por SEMÂNTICA
 * (unidade/rótulo), não por nome de arquivo. Os 24 processos são casos de validação do compositor.
 *
 * Uso: `node scripts/generate-tdps-process-screens.mjs [--only tdps_basic_flow_loop]`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const subcircuitsDir = path.join(repoRoot, "subcircuits");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, ".spec", "fixtures", "tdps-v771-library.json"), "utf8"));

/** Prefixo de TODO componente gerado por este script -- é o que torna a geração idempotente
 * (regenerar remove os antigos sem tocar em nada autorado à mão). */
const SCREEN_ID_PREFIX = "scr-";
/** Deslocamento da tela dentro do editor do subcircuito: o diagrama de controle fica em cima, a
 * tela de supervisório embaixo, sem sobreposição. Não afeta a posição no símbolo
 * (`exposedComponents[].x/y` é um espaço independente). */
const EDITOR_Y_OFFSET = 900;

// ---------------------------------------------------------------------------
// Semântica: unidade/rótulo do modelo -> papel no processo
// ---------------------------------------------------------------------------

const FLOW_UNITS = ["l/min", "nm3/h", "m3/h", "ton/h", "kg/h"];
const TEMP_UNITS = ["oc", "°c", "c", "of"];
const PRESSURE_UNITS = ["bar", "psig", "psi", "kpa"];

const norm = (value) => String(value ?? "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Rótulo TDPS pode vir bilíngue ("Nível|Level") -- a tela usa a primeira forma. */
const displayLabel = (raw) => String(raw ?? "").split("|")[0].trim();

/** Rótulo curto o bastante para caber na caixa de leitura sem vazar por cima do vizinho.
 * O texto completo continua no modelo (rótulo do componente) e no Inspector. */
const shortLabel = (raw, max = 20) => {
  const text = displayLabel(raw);
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};

/**
 * Papel de uma sonda, deduzido do que o PRÓPRIO modelo declara (unidade + rótulo). É esta função --
 * e só ela -- que decide qual símbolo representa cada medição; nenhum processo tem regra própria.
 */
function observerRole(observer) {
  const unit = norm(observer.unit);
  const label = norm(observer.label);
  const tag = /^([a-z]{2,4})[- ]?\d{0,5}$/.exec(label)?.[1] ?? "";

  // Unidade binaria do TDPS ("Fechada/Aberta", "Desligado/Ligado"): duas palavras separadas por
  // barra, sem digito. Testar so a presenca de "/" nao basta -- "L/min" tambem tem barra.
  if (/^[a-z]+\/[a-z]+$/.test(unit) && !FLOW_UNITS.includes(unit)) return "discrete";
  if (label.includes("porta") || label.includes("modo")) return "discrete";

  // Tag ISA tem prioridade sobre o texto livre: "LT01" e nivel mesmo sem a palavra "nivel", e e
  // assim que a maioria dos modelos TDPS nomeia as sondas.
  if (tag.startsWith("lt") || tag.startsWith("li")) return "level";
  if (tag.startsWith("ft") || tag.startsWith("fi")) return "flow";
  if (tag.startsWith("tt") || tag.startsWith("ti")) return "temperature";
  if (tag.startsWith("pt") || tag.startsWith("pi")) return "pressure";

  if (label.includes("nivel")) return "level";
  if (label.includes("abert") || label.includes("posic") || label.includes("valv")) return "valve";
  if (label.includes("veloc") || unit === "rpm") return "speed";
  if (TEMP_UNITS.includes(unit)) return "temperature";
  if (PRESSURE_UNITS.includes(unit)) return "pressure";
  if (FLOW_UNITS.includes(unit)) return "flow";
  if (label.includes("vazao")) return "flow";
  if (label.includes("temp")) return "temperature";
  if (label.includes("press")) return "pressure";
  return "value";
}

/** Tag ISA de duas linhas a partir do rótulo do modelo (ex: "FT104" -> "FT" / "104"). */
function isaTag(label, role) {
  const text = displayLabel(label).replace(/\s+/g, " ").trim();
  const match = /^([A-Z]{2,4})[- ]?(\d{1,5})$/.exec(text);
  if (match) return { tag: match[1], number: match[2] };
  const fallback = { level: "LT", flow: "FT", temperature: "TT", pressure: "PT", valve: "FCV", speed: "SI", discrete: "HS", value: "XI" }[role];
  return { tag: fallback, number: "" };
}

const UNIT_RANGE = {
  level: [0, 100], valve: [0, 100], speed: [0, 3600],
  temperature: [0, 400], pressure: [0, 20], flow: [0, 200], discrete: [0, 1], value: [0, 100],
};

// ---------------------------------------------------------------------------
// Compositor
// ---------------------------------------------------------------------------

class Screen {
  constructor() {
    this.items = [];
    this.seq = 0;
  }

  add(typeId, x, y, properties, rotation = 0) {
    const id = `${SCREEN_ID_PREFIX}${String(++this.seq).padStart(3, "0")}`;
    this.items.push({ id, typeId, x: Math.round(x), y: Math.round(y), rotation, properties });
    return id;
  }

  /**
   * Linha/tubo VERTICAL. Todo simbolo alongado da biblioteca e desenhado na horizontal e girado
   * pela instancia (o editor so tem 0/90/180/270, ver `ProjectComponent.visual.rotation`) -- a
   * rotacao pivota no CENTRO da caixa, entao a posicao nao girada precisa ser compensada aqui, uma
   * vez so, em vez de em cada chamada.
   */
  addVertical(typeId, cx, y0, length, properties) {
    const thickness = Number(properties.height ?? 10);
    return this.add(
      typeId,
      cx - length / 2,
      y0 + length / 2 - thickness / 2,
      { ...properties, width: length },
      90
    );
  }

  get bounds() {
    let maxX = 0;
    let maxY = 0;
    for (const item of this.items) {
      maxX = Math.max(maxX, item.x + Number(item.properties.width ?? 80));
      maxY = Math.max(maxY, item.y + Number(item.properties.height ?? 40));
    }
    return { width: maxX, height: maxY };
  }
}

/** Bloco de binding comum -- idêntico ao que o Inspector mostra, e é o contrato de `graphicsBinding.ts`. */
const bindTo = (observer, role, extra = {}) => {
  const [min, max] = UNIT_RANGE[role] ?? [0, 100];
  return {
    bindSource: observer.id, bindChannel: 0, bindScale: 1, bindOffset: 0,
    bindMin: min, bindMax: max,
    bindUnit: displayLabel(observer.unit), bindDecimals: role === "discrete" ? 0 : 1,
    ...extra,
  };
};

/** Distância do topo do desenho de `graphics.hmi.valve` até o eixo da gravata (`TOP + bodyH/2`,
 * ver `generate-ipd-hmi-library.mjs`). Quem posiciona a válvula sobre um tubo precisa deste número;
 * repeti-lo à mão em cada chamada é como as duas válvulas do piloto acabaram em alturas diferentes. */
const HMI_VALVE_AXIS = 46;

/** Trecho de tubulação com seta de fluxo. */
function pipeRun(screen, x, y, width, { color = "#cbd5e1", flowSource, showFlow = true } = {}) {
  return screen.add("graphics.pipe", x, y, {
    width, height: 16, fill: color, stroke: "currentColor", strokeWidth: 1.5, opacity: 1,
    showFlow, flowDirection: "forward", showFlanges: false,
    value: 100, bindSource: flowSource ?? "", bindChannel: 0, bindScale: 1, bindOffset: 0,
    bindMin: 0, bindMax: 100, bindUnit: "%", bindDecimals: 1, bindThreshold: 1, bindInvert: false,
  });
}

/**
 * Arquétipo "malha de controle": transmissor -> controlador -> válvula sobre um trecho de
 * tubulação. É o desenho que aparece, com variações, em praticamente todos os 24 processos --
 * por isso vive aqui uma vez só, e não 24 vezes.
 */
function controlLoop(screen, { x, y, width, pv, mv, controllerX }) {
  const pipeY = y;
  pipeRun(screen, x, pipeY, width, { flowSource: pv?.id });

  if (pv) {
    const role = observerRole(pv);
    const { tag, number } = isaTag(pv.label, role);
    const bubbleX = x + Math.round(width * 0.16);
    screen.add("graphics.instrument", bubbleX, pipeY - 98, {
      width: 64, height: 64, stroke: "currentColor", fill: "#f8fafc", strokeWidth: 1.5, opacity: 1,
      tag, tagNumber: number || (/(\d{2,})/.exec(pv.id)?.[1] ?? ""), housing: "circle", location: "field", showValue: true,
      value: 0, ...bindTo(pv, role),
    });
    // Tomada do transmissor até a linha de processo (linha cheia = processo, vertical).
    screen.addVertical("graphics.signal_line", bubbleX + 32, pipeY - 34, 42, {
      height: 10, stroke: "currentColor", strokeWidth: 1.4, opacity: 1, dash: "solid",
    });
    // Sinal do transmissor até o controlador (tracejado = instrumentação).
    if (controllerX !== undefined) {
      screen.add("graphics.signal_line", bubbleX + 64, pipeY - 72, {
        width: Math.max(12, controllerX - bubbleX - 64), height: 10,
        stroke: "currentColor", strokeWidth: 1.2, opacity: 1, dash: "dashed",
      });
    }
  }

  if (mv) {
    const valveX = x + Math.round(width * 0.66);
    // O corpo da válvula HMI fica em `TOP + bodyH/2 = 46` da borda de cima do seu desenho; subtrair
    // isso do eixo do tubo é o que mantém a gravata CENTRADA na linha, em vez de pendurada nela.
    screen.add("graphics.hmi.valve", valveX, pipeY + 8 - HMI_VALVE_AXIS, {
      width: 60, height: 86, stroke: "#4a4a4a", fill: "#c2c2c2", opacity: 1,
      throttle: true, tag: shortLabel(mv.label, 10) || "FCV",
      value: 0, ...bindTo(mv, "valve"), bindThreshold: 2, bindInvert: false,
    });
  }
  return pipeY;
}

/** Equipamento principal da tela, escolhido pelo que o modelo MEDE (nunca pelo nome do arquivo). */
function mainEquipment(screen, { x, y, roles, levelObserver, label }) {
  if (roles.has("level")) {
    screen.add("graphics.hmi.tank", x, y, {
      width: 110, height: 170, stroke: "#4a4a4a", fill: "#c2c2c2", opacity: 1,
      shape: "vertical", tag: shortLabel((levelObserver ?? {}).label ?? "", 10) || "LT",
      value: 0, ...bindTo(levelObserver ?? { id: "", unit: "%" }, "level"),
      limitLL: "", limitL: "", limitH: "", limitHH: "",
    });
    return { width: 110, height: 170 };
  }
  if (roles.has("temperature")) {
    screen.add("graphics.heat_exchanger", x, y + 20, {
      width: 160, height: 106, stroke: "currentColor", fill: "#f8fafc", strokeWidth: 1.5, opacity: 1,
    });
    return { width: 160, height: 126 };
  }
  screen.add("graphics.equipment", x, y + 30, {
    width: 150, height: 76, stroke: "currentColor", fill: "#f8fafc", strokeWidth: 1.5, opacity: 1,
    label, labelSize: 12,
  });
  return { width: 150, height: 106 };
}

/** Coluna/grade de leituras: uma por sonda do modelo, ligada por id. */
function readoutGrid(screen, observers, { x, y, columns }) {
  const cellW = 152;
  const cellH = 58;
  observers.forEach((observer, index) => {
    const role = observerRole(observer);
    const cx = x + (index % columns) * cellW;
    const cy = y + Math.floor(index / columns) * cellH;
    const label = shortLabel(observer.label) || observer.id.replace(/^readout-|^recorder-/, "#");
    if (role === "discrete") {
      screen.add("graphics.status_lamp", cx + 4, cy + 6, {
        width: 30, height: 38, stroke: "currentColor", fill: "#94a3b8", strokeWidth: 1.5, opacity: 1,
        onColor: "#22c55e", offColor: "#94a3b8", label: "",
        value: 0, ...bindTo(observer, role), bindThreshold: 0.5, bindInvert: false,
      });
      screen.add("graphics.label", cx + 38, cy + 14, {
        width: 106, height: 18, text: label, fontSize: 10, align: "start",
        stroke: "#0f172a", fill: "none", showBox: false, opacity: 1,
        value: 0, bindSource: "", bindChannel: 0, bindScale: 1, bindOffset: 0,
        bindMin: 0, bindMax: 100, bindUnit: "", bindDecimals: 1,
      });
      return;
    }
    if (role === "level" || role === "valve") {
      screen.add("graphics.level_bar", cx + 2, cy, {
        width: 26, height: 52, stroke: "currentColor", fill: "#ffffff", strokeWidth: 1.5, opacity: 1,
        barColor: role === "level" ? "#38bdf8" : "#f59e0b",
        highLimit: 90, lowLimit: 10, showLimits: false, showValue: false,
        value: 0, ...bindTo(observer, role),
      });
      screen.add("graphics.value_display", cx + 32, cy + 4, {
        width: 112, height: 44, stroke: "currentColor", fill: "#f8fafc", strokeWidth: 1.5, opacity: 1,
        label, valueColor: "#0f172a",
        value: 0, ...bindTo(observer, role),
      });
      return;
    }
    screen.add("graphics.value_display", cx, cy + 4, {
      width: 144, height: 46, stroke: "currentColor", fill: "#f8fafc", strokeWidth: 1.5, opacity: 1,
      label, valueColor: "#0f172a",
      value: 0, ...bindTo(observer, role), bindDecimals: role === "temperature" ? 1 : 2,
    });
  });
}

const staticBinding = (value = 0, unit = "", decimals = 1) => ({
  value, bindSource: "", bindChannel: 0, bindScale: 1, bindOffset: 0,
  bindMin: 0, bindMax: 100, bindUnit: unit, bindDecimals: decimals,
});

function screenLabel(screen, x, y, width, text, { size = 12, color = "#0f172a", align = "start", height = 22, bold = false } = {}) {
  return screen.add("graphics.label", x, y, {
    width, height, text, fontSize: bold ? size + 1 : size, align,
    stroke: color, fill: "none", showBox: false, opacity: 1,
    ...staticBinding(),
  });
}

/**
 * Tela curada do primeiro processo TDPS. O modelo funcional continua sendo o mesmo; somente a
 * composição exposta é especializada para reproduzir a linguagem do supervisório original.
 */
function composeBasicFlowScreen(model) {
  const screen = new Screen();
  const flow = model.observers.find((observer) => observerRole(observer) === "flow") ?? model.observers[0];
  const valve = model.observers.find((observer) => norm(observer.label).includes("abert"));
  const position = model.observers.find((observer) => norm(observer.label).includes("posic"));
  const controller = model.controllers[0];

  // Medidas tiradas do sinótico TDPS de referência. Tudo o que fica "em linha" sai de PIPE_AXIS e
  // do eixo do corpo dentro da caixa de projeto de cada símbolo -- nunca de número solto.
  const BG = "#eef1f4";
  const PIPE_TOP = 310;
  const PIPE_THICKNESS = 24;
  const PIPE_AXIS = PIPE_TOP + PIPE_THICKNESS / 2;
  const VALVE_BODY_AXIS = HMI_VALVE_AXIS;   // graphics.hmi.valve (caixa 60x86)
  const VALVE_ACTUATOR_TOP = 36;
  const HAND_VALVE_AXIS_X = 30;   // graphics.hmi.valve (caixa 60x86): eixo no meio da largura
  const HAND_VALVE_WHEEL_X = 93;
  const FT_BODY_CENTER_X = 60;    // flow_transmitter (caixa 120x150)
  const FT_BODY_TOP = 18;
  const ROUTE_Y = 145;            // altura da rota de sinal FT -> FIC -> FCV
  const ELBOW = 26;

  // Fundo liso, sem moldura: o original não tem borda em volta da tela, e a grade do editor não
  // pode aparecer atravessando o HMI.
  const SCREEN_W = 800;
  const SCREEN_H = 616;
  screen.canvas = { width: SCREEN_W, height: SCREEN_H };
  screen.add("graphics.equipment", 0, 0, {
    width: SCREEN_W, height: SCREEN_H, stroke: "#cbd5e1", fill: BG, strokeWidth: 1, opacity: 1,
    label: "", labelSize: 12, showBorder: false,
  });
  screenLabel(screen, 24, 14, 400, "Vazão Linear Simples", { size: 17, bold: true });

  // --- Painel de comando (group box com o título sobre a própria borda) ---------------------
  screen.add("graphics.group_box", 20, 34, {
    width: 214, height: 104, title: "Command Panel", titleSize: 12, titleWidth: 104,
    stroke: "#7f9db9", fill: "#dfe8f5", maskFill: BG, strokeWidth: 1.2, opacity: 1,
  });
  // Botões luminosos reais, não círculos decorativos. Binding mostra o retorno e os campos de
  // Ação ficam persistidos no próprio objeto para o usuário apontar ao comando correspondente.
  const lampButton = (y, onColor, offColor, on) => screen.add("graphics.hmi_lamp_button", 29, y, {
    width: 38, height: 38, stroke: "#475569", fill: "#cbd5e1", strokeWidth: 1.4, opacity: 1,
    onColor, offColor,
    ...staticBinding(on ? 100 : 0, "", 0), bindThreshold: 50, bindInvert: false,
    actionTarget: "", actionProperty: "", actionMode: "toggle", actionValue: "true", actionReleaseValue: "false",
    actionStep: 1, actionMin: 0, actionMax: 100,
  });
  lampButton(46, "#86efac", "#94a3b8", true);
  screenLabel(screen, 72, 48, 150, "Válvula FCV102", { size: 12, color: "#1d4ed8", bold: true });
  screenLabel(screen, 72, 66, 130, "Aberta", { size: 11, color: "#b91c1c" });
  lampButton(88, "#fde047", "#fbbf24", false);
  screenLabel(screen, 72, 90, 150, "Dist. Aleatório", { size: 12, color: "#1d4ed8", bold: true });
  screenLabel(screen, 72, 108, 130, "Desligado", { size: 11, color: "#b91c1c" });

  // --- Setpoint e desvio (canto superior direito) ------------------------------------------
  screen.add("graphics.group_box", 520, 16, {
    width: 214, height: 66, title: "SP de Vazão(L/min)", titleSize: 12, titleWidth: 130,
    stroke: "#7f9db9", fill: "#eef3f9", maskFill: BG, strokeWidth: 1.2, opacity: 1,
  });
  screen.add("graphics.value_display", 652, 22, {
    width: 74, height: 26, stroke: "#334155", fill: "#050505", strokeWidth: 1, opacity: 1,
    label: "", valueColor: "#ffffff", ...staticBinding(60, "", 2),
  });
  screen.add("graphics.slider", 526, 44, {
    width: 200, height: 32, stroke: "#475569", fill: "#ffffff", strokeWidth: 1.2, opacity: 1,
    showTicks: true, ...staticBinding(60, "", 0),
    actionTarget: "", actionProperty: "", actionMode: "set", actionValue: "60", actionReleaseValue: "0",
    actionStep: 1, actionMin: 0, actionMax: 100,
  });
  screen.add("graphics.group_box", 520, 94, {
    width: 234, height: 44, title: "Desvio Tolerado(L/min)", titleSize: 12, titleWidth: 156,
    stroke: "#7f9db9", fill: "#eef3f9", maskFill: BG, strokeWidth: 1.2, opacity: 1,
  });
  screen.add("graphics.value_display", 672, 100, {
    width: 74, height: 26, stroke: "#334155", fill: "#050505", strokeWidth: 1, opacity: 1,
    label: "", valueColor: "#ffffff", ...staticBinding(20, "", 2),
  });

  // --- Estação controladora e sua etiqueta -------------------------------------------------
  const ficX = 332;
  const ficW = 72;
  screen.add("graphics.group_box", ficX - 2, 48, {
    width: 86, height: 22, title: "", titleSize: 10, titleWidth: 0,
    stroke: "#7f9db9", fill: "#eef3f9", maskFill: BG, strokeWidth: 1.1, opacity: 1,
  });
  screen.add("graphics.gauge_bar", ficX + 3, 53, {
    width: 22, height: 13, stroke: "#475569", fill: "#ffffff", strokeWidth: 0.9, opacity: 1,
    barColor: "#22c55e", showValue: false, ...staticBinding(70, "", 0),
  });
  screenLabel(screen, ficX + 28, 52, 58, "FIC101", { size: 11, color: "#1d4ed8", bold: true });
  screen.add("graphics.controller_station", ficX, 78, {
    width: ficW, height: 104, stroke: "#334155", fill: "#d7dce2", strokeWidth: 1.5, opacity: 1,
    tag: "FIC-101", setpoint: 60, showValue: false,
    value: 0, bindSource: controller?.id ?? "", bindChannel: 0, bindScale: 1, bindOffset: 0,
    bindMin: Number(controller?.outputMin ?? 0), bindMax: Number(controller?.outputMax ?? 100), bindUnit: "%", bindDecimals: 1,
  });

  // --- Transmissor de vazão: a haste do próprio símbolo encosta no tubo --------------------
  const ftX = 214;
  const ftY = 150;
  screen.add("graphics.flow_transmitter", ftX, ftY, {
    width: 120, height: 150, stroke: "#334155", fill: "#d7dce2", strokeWidth: 1.5, opacity: 1,
    tag: "", showValue: false, value: 0, ...bindTo(flow, "flow", { bindDecimals: 1 }),
  });
  // Tomada do manifold ate a linha: o corpo do transmissor fica alto o bastante para os rotulos
  // caberem entre ele e o tubo, como no original.
  screen.addVertical("graphics.pipe", ftX + 97, ftY + 124, PIPE_TOP - ftY - 124 + 4, {
    height: 11, fill: "#d8dde3", stroke: "#475569", strokeWidth: 1.1, opacity: 1,
    showFlow: false, flowDirection: "forward", showFlanges: false,
    ...staticBinding(100, "%", 0), bindThreshold: 1, bindInvert: false,
  });
  screenLabel(screen, ftX + 4, 252, 112, "FT-101", { size: 13, bold: true, align: "middle" });

  // Posição da válvula de controle, EM LINHA com o tubo (o desenho vem mais abaixo, depois da
  // linha principal). A rota de sinal precisa destas coordenadas para terminar no atuador.
  const valveBodyCenterX = 522;
  const valveX = valveBodyCenterX - 55;
  const valveY = PIPE_AXIS - VALVE_BODY_AXIS;

  // --- Rota de sinal FT -> FIC -> FCV, com cantos arredondados e setas no destino -----------
  const sigStyle = { height: 10, stroke: "#475569", strokeWidth: 1.6, opacity: 1, dash: "solid" };
  const elbow = (cx, cy, corner) => screen.add("graphics.signal_elbow", cx - ELBOW / 2, cy - ELBOW / 2, {
    width: ELBOW, height: ELBOW, stroke: "#475569", strokeWidth: 1.6, opacity: 1, corner,
  });
  const ftSignalX = ftX + FT_BODY_CENTER_X;
  // Sobe do corpo do transmissor até a rota, dobra para a direita e entra no controlador.
  screen.addVertical("graphics.signal_line", ftSignalX, ROUTE_Y + ELBOW / 2, ftY + FT_BODY_TOP - ROUTE_Y - ELBOW / 2, { ...sigStyle, arrow: "none" });
  elbow(ftSignalX, ROUTE_Y, "rb");
  screen.add("graphics.signal_line", ftSignalX + ELBOW / 2, ROUTE_Y - 5, {
    ...sigStyle, width: ficX - ftSignalX - ELBOW / 2, arrow: "end",
  });
  // Sai do controlador, dobra para baixo e entra no atuador da válvula.
  screen.add("graphics.signal_line", ficX + ficW, ROUTE_Y - 5, {
    ...sigStyle, width: valveBodyCenterX - ELBOW / 2 - ficX - ficW, arrow: "none",
  });
  elbow(valveBodyCenterX, ROUTE_Y, "lb");
  screen.addVertical("graphics.signal_line", valveBodyCenterX, ROUTE_Y + ELBOW / 2, valveY + VALVE_ACTUATOR_TOP - ROUTE_Y - ELBOW / 2, { ...sigStyle, arrow: "end" });

  // --- Linha principal, flanges e saída ----------------------------------------------------
  pipeRun(screen, 46, PIPE_TOP, 580, { color: "#d8dde3", flowSource: flow?.id, showFlow: false });
  screen.items.at(-1).properties.height = PIPE_THICKNESS;
  for (const x of [362, 462, 566]) {
    screen.add("graphics.pipe_flange", x, PIPE_TOP - 3, {
      width: 16, height: PIPE_THICKNESS + 6, stroke: "#374151", fill: "#cbd5e1", strokeWidth: 1.4, opacity: 1,
    });
  }
  screen.add("graphics.flow_arrow", 636, PIPE_AXIS - 11, {
    width: 36, height: 22, stroke: "#2563eb", fill: "#3b82f6", strokeWidth: 1.2, opacity: 1,
  });

  // Desenhada DEPOIS do tubo: a ordem dos itens é a ordem de desenho, e no sinótico original o
  // corpo da válvula interrompe a linha, nunca fica atrás dela.
  screen.add("graphics.hmi.valve", valveX, valveY, {
    width: 60, height: 86, stroke: "#4a4a4a", fill: "#c2c2c2", opacity: 1,
    throttle: true, tag: "FCV-101",
    ...staticBinding(0, "%", 1), bindThreshold: 2, bindInvert: false,
  });

  // --- Ramal inferior: tê real saindo do eixo da linha principal ---------------------------
  const handValveX = 138;
  const handValveY = 372;
  const branchX = handValveX + HAND_VALVE_AXIS_X;
  screen.addVertical("graphics.pipe", branchX, PIPE_AXIS, 152, {
    height: 18, fill: "#d8dde3", stroke: "#475569", strokeWidth: 1.3, opacity: 1,
    showFlow: false, flowDirection: "forward", showFlanges: true,
    ...staticBinding(100, "%", 0), bindThreshold: 1, bindInvert: false,
  });
  screen.add("graphics.hmi.valve", handValveX, handValveY, {
    width: 60, height: 86, stroke: "#4a4a4a", fill: "#c2c2c2", opacity: 1,
    throttle: false, tag: "FCV-102",
    ...staticBinding(100, "", 0), bindThreshold: 50, bindInvert: false,
  });
  screen.add("graphics.flow_arrow", branchX - 17, 478, {
    width: 34, height: 22, stroke: "#2563eb", fill: "#3b82f6", strokeWidth: 1.2, opacity: 1,
  }, 90);
  // Chave manual: a seta aponta para o volante, como no original.
  screen.add("graphics.instrument", 286, 384, {
    width: 66, height: 66, stroke: "#475569", fill: "#f8fafc", strokeWidth: 1.4, opacity: 1,
    tag: "HS", tagNumber: "022", housing: "hexagon", location: "field", showValue: false,
    ...staticBinding(),
  });
  screen.add("graphics.signal_line", handValveX + HAND_VALVE_WHEEL_X + 10, 412, {
    ...sigStyle, width: 286 - handValveX - HAND_VALVE_WHEEL_X - 10, strokeWidth: 1.4, arrow: "start",
  });
  screenLabel(screen, 180, 462, 120, "FCV-102", { size: 12, bold: true });
  screenLabel(screen, 196, 482, 120, "Posição", { size: 11, bold: true });
  screenLabel(screen, 196, 498, 120, "Aberta", { size: 11, color: "#1d4ed8", bold: true });

  // --- Leituras vivas junto ao equipamento -------------------------------------------------
  screenLabel(screen, 150, 274, 190, "Vazão Linha Principal", { size: 12, bold: true });
  screen.add("graphics.label", 150, 290, {
    width: 190, height: 20, text: "", fontSize: 12, align: "start", stroke: "#1d4ed8", fill: "none", showBox: false, opacity: 1,
    value: 0, ...bindTo(flow, "flow", { bindDecimals: 1 }),
  });
  screenLabel(screen, 556, 212, 180, "Abertura FCV101", { size: 12, bold: true });
  screen.add("graphics.label", 556, 230, {
    width: 160, height: 20, text: "", fontSize: 12, align: "start", stroke: "#1d4ed8", fill: "none", showBox: false, opacity: 1,
    value: 0, ...bindTo(valve ?? position ?? flow, "valve", { bindDecimals: 1 }),
  });
  return screen;
}

/**
 * Monta a tela inteira de um modelo. Recebe SÓ o que o modelo declara -- nunca o nome do arquivo --,
 * então um modelo TDPS novo ganha tela sem tocar neste código.
 */
function composeScreen(model) {
  if (model.typeId === "subcircuits.tdps.basic_flow_loop") return composeBasicFlowScreen(model);
  const screen = new Screen();
  const observers = model.observers;
  const roles = new Set(observers.map(observerRole));
  const pick = (role) => observers.find((observer) => observerRole(observer) === role);
  const levelObserver = pick("level");
  const flowObserver = pick("flow");
  const valveObserver = pick("valve");
  const speedObserver = pick("speed");

  // Faixa 1: título da tela.
  screen.add("graphics.label", 16, 14, {
    width: 460, height: 24, text: model.title, fontSize: 15, align: "start",
    stroke: "#0f172a", fill: "none", showBox: false, opacity: 1,
    value: 0, bindSource: "", bindChannel: 0, bindScale: 1, bindOffset: 0,
    bindMin: 0, bindMax: 100, bindUnit: "", bindDecimals: 1,
  });

  // Faixa 2: linha de processo -- equipamento -> tubulação -> válvula, transmissor acima e
  // controlador(es) à direita, ligados por linhas de sinal.
  const PIPE_Y = 214;
  const equipment = mainEquipment(screen, {
    x: 20, y: 112, roles, levelObserver,
    label: shortLabel(model.processLabel, 18) || "Processo",
  });
  const pipeX = 20 + equipment.width + 10;
  // Trecho curto ligando o equipamento a linha principal -- sem ele a tela fica com dois desenhos
  // soltos em vez de um processo continuo.
  pipeRun(screen, 20 + equipment.width - 6, PIPE_Y, 18, { showFlow: false });
  const controllerX = 506;
  const pipeWidth = Math.max(180, controllerX - pipeX - 16);
  controlLoop(screen, {
    x: pipeX, y: PIPE_Y, width: pipeWidth,
    pv: flowObserver ?? observers[0], mv: valveObserver, controllerX,
  });

  let processBandBottom = PIPE_Y + 60;
  if (speedObserver) {
    processBandBottom = PIPE_Y + 118;
    screen.add("graphics.hmi.pump", 34, PIPE_Y + 26, {
      width: 72, height: 108, stroke: "#4a4a4a", fill: "#c2c2c2", opacity: 1,
      tag: shortLabel(speedObserver.label, 12) || "P-01",
      tripped: false, outOfService: false,
      value: 0, ...bindTo(speedObserver, "speed"), bindThreshold: 1, bindInvert: false,
    });
  }

  model.controllers.slice(0, 4).forEach((controller, index) => {
    screen.add("graphics.controller_faceplate", controllerX + index * 74, 100, {
      width: 66, height: 106, stroke: "currentColor", fill: "#f8fafc", strokeWidth: 1.5, opacity: 1,
      tag: shortLabel(controller.label, 10) || `PIC-${index + 1}`, setpoint: 50, barColor: "#0284c7",
      showValue: true,
      value: 0, bindSource: controller.id, bindChannel: 0, bindScale: 1, bindOffset: 0,
      bindMin: Number(controller.outputMin ?? 0), bindMax: Number(controller.outputMax ?? 100),
      bindUnit: "%", bindDecimals: 1,
    });
  });

  // Faixa 3: leituras -- uma por sonda do modelo, ligada por id estável.
  const columns = observers.length > 24 ? 5 : observers.length > 12 ? 4 : 3;
  readoutGrid(screen, observers, { x: 20, y: Math.max(306, processBandBottom + 12), columns });
  return screen;
}

// ---------------------------------------------------------------------------
// Leitura do modelo e escrita do documento
// ---------------------------------------------------------------------------

function readModel(document, entry) {
  const components = (document.components ?? []).filter((component) => !String(component.id).startsWith(SCREEN_ID_PREFIX));
  const observers = components
    .filter((component) => component.typeId === "control.observer")
    .map((component) => ({
      id: component.id,
      label: component.label ?? "",
      unit: (component.properties ?? {}).unit ?? "",
    }));
  const controllers = components
    .filter((component) => component.typeId === "control.pid")
    .map((component) => ({
      id: component.id,
      label: component.label ?? "",
      outputMin: (component.properties ?? {}).outputMin,
      outputMax: (component.properties ?? {}).outputMax,
    }));
  const processBlock = components.find((component) => component.typeId === "control.process");
  return { typeId: entry.typeId, title: entry.label, observers, controllers, components, processLabel: processBlock?.label ?? "Processo" };
}

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
let generated = 0;
const report = [];

for (const entry of manifest.entries) {
  if (only && !entry.file.startsWith(only)) continue;
  const filePath = path.join(subcircuitsDir, entry.file);
  if (!fs.existsSync(filePath)) throw new Error(`subcircuito ausente: ${filePath}`);
  const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const model = readModel(document, entry);
  const screen = composeScreen(model);

  const bounds = screen.bounds;
  // Uma tela CURADA declara a propria moldura (`screen.canvas`): a superficie desenhada JA e' o
  // limite da tela, entao acrescentar margem deixaria uma faixa vazia em volta. As telas geradas
  // pelo compositor generico continuam com a folga de 24 px em volta do conteudo.
  const canvasWidth = screen.canvas ? screen.canvas.width : Math.max(640, bounds.width + 24);
  const canvasHeight = screen.canvas ? screen.canvas.height : Math.max(420, bounds.height + 24);

  // Componentes: mantém tudo o que não foi gerado por este script e acrescenta a tela.
  const keptComponents = model.components;
  const screenComponents = screen.items.map((item) => ({
    id: item.id,
    typeId: item.typeId,
    label: item.typeId.replace("graphics.", ""),
    properties: item.properties,
    visual: { x: item.x, y: item.y + EDITOR_Y_OFFSET, rotation: item.rotation ?? 0 },
  }));
  document.components = [...keptComponents, ...screenComponents];

  // Só os elementos da TELA são expostos: os blocos de controle continuam internos (e continuam
  // exportando propriedades pelo mecanismo próprio, `exportedPropertyComponentIds`).
  document.exposedComponents = screen.items.map((item, layer) => ({
    componentId: item.id, x: item.x, y: item.y, rotation: item.rotation ?? 0, flipH: false, flipV: false, scale: 1, layer,
  }));

  document.symbolMode = "custom";
  document.symbol = {
    ...(document.symbol ?? {}),
    width: canvasWidth,
    height: canvasHeight,
    // O sinótico curado desenha a própria superfície; uma moldura extra do símbolo criaria a
    // borda dupla que o original não tem.
    border: entry.typeId !== "subcircuits.tdps.basic_flow_loop",
    // Sem bitmap: a tela é a composição de objetos acima. `shapes: []` porque nenhuma forma fica
    // "assada" no símbolo -- toda a tela é editável objeto a objeto.
    background: { kind: "none" },
    shapes: [],
    pins: document.symbol?.pins ?? [],
  };

  fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  generated += 1;
  report.push({ file: entry.file, elements: screen.items.length, observers: model.observers.length, controllers: model.controllers.length, canvas: `${canvasWidth}x${canvasHeight}` });
}

for (const row of report) {
  console.log(`[tdps-screen] ${row.file.padEnd(50)} ${String(row.elements).padStart(3)} elementos | ${String(row.observers).padStart(2)} sondas | ${String(row.controllers).padStart(2)} controladores | ${row.canvas}`);
}
console.log(`[tdps-screen] ${generated} telas geradas sem bitmap`);

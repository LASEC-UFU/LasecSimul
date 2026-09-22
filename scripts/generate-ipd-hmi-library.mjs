/**
 * Biblioteca de WIDGETS DE SUPERVISÓRIO herdada do HMI Studio do IPD -- `Gráfico > HMI`.
 *
 * ESCOPO, EXPLÍCITO: só a CAMADA VISUAL. O IPD traz junto um simulador de processo próprio
 * (`src/hmi/sim/`: rede hidráulica, modelo de processo, controlador PI, ciclo de vida de alarme
 * ISA-18.2, histórico, cenários, ruído). NADA disso foi portado, por decisão do usuário: "só da
 * parte visual e usando o motor que já temos". Quem simula continua sendo o Core do LasecSimul, e
 * estes widgets são projeção de telemetria -- a mesma regra da FEAT-008 que a biblioteca nativa já
 * segue (`pinCount: 0` mantém a instância fora do solver).
 *
 * TÉCNICA DE PORTE -- e por que não é a mesma do `generate-ipd-symbol-library.mjs`.
 *
 * Os símbolos P&ID do IPD são `SymbolDef.render(cfg)` retornando SVG puro, então lá dá pra executar
 * o renderizador upstream em tempo de geração e congelar o markup. Aqui não dá: um widget de HMI é
 * uma função da GEOMETRIA **e do valor ao vivo** -- `yOf(pv)`, `angOf(pv)`, a cor contra os limites.
 * Congelar o render produziria uma figura morta com um valor fixo, que é exatamente o oposto do
 * pedido. Então a geometria é TRANSCRITA das fórmulas do upstream para o IR declarativo
 * (`PackageNumberExpression`, `stateFill`, `stateVisible`, `stateText`, `ViewSpecProjection`), e o
 * que varia é dirigido pelo resolvedor único de binding (`ui/webview/graphicsBinding.ts`).
 * Classificação de proveniência: `ADAPTED_PORT`, não `DIRECT_PORT`.
 *
 * Uso: `node scripts/generate-ipd-hmi-library.mjs`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(repoRoot, "project", "schema", "component-catalog.json");
const iconDir = path.join(repoRoot, "extension", "media", "components");

const IPD_SOURCE_COMMIT = "4b84fb8694bc89985872690366e8be2e32a8db2b";
const IPD_LICENSE = "PolyForm-Noncommercial-1.0.0";
const IPD_LICENSE_URL = "https://polyformproject.org/licenses/noncommercial/1.0.0/";
const IPD_REQUIRED_NOTICE = "Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only; commercial use requires a paid license.";
const LICENSE_NOTE = `Widget adaptado do HMI Studio do IPD (${IPD_LICENSE}, © Praharsh Nagpure) — uso não comercial.`;

// ---------------------------------------------------------------------------
// 1. O DESIGN SYSTEM, portado como dado
// ---------------------------------------------------------------------------

/**
 * `src/hmi/theme.ts` → `THEMES.hp`, a paleta ISA-101 "high performance", copiada valor a valor.
 *
 * É a escolha certa para o nosso canvas, que é claro, e traz junto a regra que dá sentido a ela:
 * a operação normal RECUA (equipamento parado, linha sem fluxo e valor dentro dos limites usam só
 * tons de superfície e texto) e cor saturada fica reservada para o que exige ação. UM SIGNIFICADO
 * POR COR: vermelho é anormal em todo lugar, e um equipamento parado é neutro, nunca vermelho --
 * senão uma planta corretamente desligada parece uma emergência.
 */
const T = {
  bg: "#d4d4d4",
  surface: "#e2e2e2",
  surfaceRaised: "#ededed",
  surfaceSunken: "#cfcfcf",
  border: "#a8a8a8",
  borderStrong: "#8a8a8a",
  text: "#1a1a1a",
  textSecondary: "#454545",
  textMuted: "#6b6b6b",
  textOnAccent: "#ffffff",
  equipStroke: "#4a4a4a",
  equipFill: "#c2c2c2",
  processActive: "#3c3c3c",
  processInactive: "#e8e8e8",
  disabled: "#bdbdbd",
  liquid: "#9aa8b2",
  pipe: "#7a7a7a",
  alarmHigh: "#c62222",
  alarmMedium: "#c06a00",
  alarmLow: "#9a7d00",
  alarmAck: "#8c7a4a",
  bad: "#c62222",
  accent: "#1f6ab0",
  sp: "#1f4fb0",
  op: "#5a3fb0",
};

/** `src/hmi/theme.ts` → `SCALE`. Escalas independentes de tema: um passo de espaçamento e um corpo
 * de texto significam a mesma coisa nos dois temas. Conjuntos pequenos e FECHADOS -- a auditoria do
 * upstream achou onze tamanhos de fonte ad-hoc escolhidos independentemente entre os componentes. */
const F = { xs: 10, sm: 11, base: 12, md: 13, lg: 15, xl: 18, value: 20, valueLg: 26 };
const WT = { normal: 400, medium: 600, bold: 700 };

// ---------------------------------------------------------------------------
// 2. Helpers do IR
// ---------------------------------------------------------------------------

/** `PackageNumberExpression`: um número da primitiva derivado de uma propriedade da instância.
 * É LINEAR (`prop * multiplier + offset`) -- toda a transcrição abaixo existe dentro desse limite,
 * e onde a fórmula do upstream não era linear num único sinal (posição do limite, ângulo do
 * ponteiro) o cálculo foi para `graphicsBinding.ts`, que é onde ele pertence. */
const P = (prop, multiplier = 1, offset = 0, extra = {}) => ({ prop, multiplier, offset, ...extra });
const whenProp = (prop, ...values) => ({ when: { [prop]: values.map(String) } });
/** Qualidade ruim não desenha indicador: um preenchimento ou um ponteiro É um número, e um deixado
 * de antes da falha do instrumento se lê como leitura viva. Regra do upstream (`hasNumber`). */
const whenGood = whenProp("__g_quality", "ok");
const txt = (x, y, value, extra = {}) => ({ kind: "text", x, y, value, fontSize: F.sm, fill: T.text, textAnchor: "start", ...extra });
/** Texto que mostra o valor ligado, já com a qualidade aplicada. */
const boundText = (x, y, prop, extra = {}) => ({ kind: "text", x, y, value: "", stateText: { kind: "property", prop }, textAnchor: "start", ...extra });

// ---------------------------------------------------------------------------
// 3. Blocos de propriedades -- o contrato de `graphicsBinding.ts`
// ---------------------------------------------------------------------------

const geometry = (w, h) => [
  { id: "width", label: "Largura", group: "Geometria", unit: "px", editor: "number", default: w, min: 4, max: 4000, step: 1 },
  { id: "height", label: "Altura", group: "Geometria", unit: "px", editor: "number", default: h, min: 4, max: 4000, step: 1 },
];

/** Binding de um sinal. `suffix` vazio é o primário; `B`/`C` são os secundários que o faceplate usa
 * para setpoint e saída -- MESMO contrato, mesmo resolvedor, só outro prefixo de propriedade. */
const binding = (suffix, label, group, { unit = "%", min = 0, max = 100, value = 50, decimals = 1 } = {}) => [
  { id: `value${suffix}`, label, group, unit, editor: "number", default: value, min: -1e9, max: 1e9, step: 1 },
  { id: `bindSource${suffix}`, label: `${label} — fonte (id)`, group: "Binding", unit: "", editor: "text", default: "" },
  { id: `bindChannel${suffix}`, label: `${label} — canal`, group: "Binding", unit: "", editor: "number", default: 0, min: 0, max: 64, step: 1 },
  { id: `bindScale${suffix}`, label: `${label} — ganho`, group: "Binding", unit: "", editor: "number", default: 1, min: -1e6, max: 1e6, step: 0.1 },
  { id: `bindOffset${suffix}`, label: `${label} — offset`, group: "Binding", unit: "", editor: "number", default: 0, min: -1e9, max: 1e9, step: 1 },
  { id: `bindMin${suffix}`, label: `${label} — faixa mínima`, group: "Binding", unit: "", editor: "number", default: min, min: -1e9, max: 1e9, step: 1 },
  { id: `bindMax${suffix}`, label: `${label} — faixa máxima`, group: "Binding", unit: "", editor: "number", default: max, min: -1e9, max: 1e9, step: 1 },
  { id: `bindUnit${suffix}`, label: `${label} — unidade`, group: "Binding", unit: "", editor: "text", default: unit },
  { id: `bindDecimals${suffix}`, label: `${label} — casas decimais`, group: "Binding", unit: "", editor: "number", default: decimals, min: 0, max: 6, step: 1 },
];

const discrete = (threshold = 50) => [
  { id: "bindThreshold", label: "Limiar de ligado", group: "Binding", unit: "", editor: "number", default: threshold, min: -1e9, max: 1e9, step: 1 },
  { id: "bindInvert", label: "Inverter estado", group: "Binding", unit: "", editor: "checkbox", default: false },
];

/**
 * Limites de alarme em UNIDADE DE ENGENHARIA, como no IPD -- não em porcentagem.
 *
 * Vazio significa "não especificado", que é diferente de zero: um indicador sem limite declarado
 * não desenha marca nenhuma. É a mesma honestidade do upstream, que recusa inventar limites padrão
 * ("inventar quatro números aqui é como três arquivos diferentes passaram a ter três cópias de
 * 5/10/90/95").
 */
const limits = () => [
  { id: "limitLL", label: "Limite LL", group: "Limites", unit: "", editor: "text", default: "" },
  { id: "limitL", label: "Limite L", group: "Limites", unit: "", editor: "text", default: "" },
  { id: "limitH", label: "Limite H", group: "Limites", unit: "", editor: "text", default: "" },
  { id: "limitHH", label: "Limite HH", group: "Limites", unit: "", editor: "text", default: "" },
];

const tagProp = (def = "") => [
  { id: "tag", label: "TAG", group: "Componente", unit: "", editor: "text", default: def },
];

const colorProps = (extra = []) => [
  { id: "stroke", label: "Contorno", group: "Aparência", unit: "", editor: "color", default: T.equipStroke },
  { id: "fill", label: "Preenchimento", group: "Aparência", unit: "", editor: "color", default: T.equipFill },
  { id: "opacity", label: "Opacidade", group: "Aparência", unit: "", editor: "number", default: 1, min: 0, max: 1, step: 0.05 },
  ...extra,
];

// ---------------------------------------------------------------------------
// 4. Os widgets
// ---------------------------------------------------------------------------

/** Marcas de limite compartilhadas por indicador e vaso: a posição sai de `__g_*_pct` (calculado no
 * resolvedor a partir da unidade de engenharia) e a visibilidade de `__g_*_set`. */
const limitMarks = ({ x1, x2, labelX, mult, offset, size = 7, anchor = "end" }) =>
  [["LL", T.alarmHigh], ["L", T.alarmMedium], ["H", T.alarmMedium], ["HH", T.alarmHigh]].flatMap(([key, color]) => {
    const pctProp = `__g_${key.toLowerCase()}_pct`;
    const setProp = `__g_${key.toLowerCase()}_set`;
    return [
      { kind: "line", x1, x2, y1: P(pctProp, mult, offset), y2: P(pctProp, mult, offset), stroke: color, strokeWidth: 1.8, stateVisible: whenProp(setProp, true) },
      { kind: "text", x: labelX, y: P(pctProp, mult, offset + 2.5), value: key, fontSize: size, fontWeight: WT.bold, fill: color, textAnchor: anchor, stateVisible: whenProp(setProp, true) },
    ];
  });

const WIDGETS = [];

// ── Indicador analógico ISA-101 (src/hmi/widgets/bar.tsx) ────────────────────────────────────
// "O operador lê 'onde o valor está em relação ao normal' de relance, não um número."
(() => {
  const w = 80, h = 170;
  const top = 16, bottom = h - 22, scaleH = bottom - top;   // 16 .. 148, 132
  const bx = w / 2 - 12, bw = 24;                            // 28, 24
  const k = -scaleH / 100;                                   // pct -> y
  WIDGETS.push({
    id: "bar", label: "Indicador de barra", labelEn: "Bar Indicator", folder: ["Indicadores", "Indicators"],
    w, h, aspect: "fixed",
    sourceFiles: ["src/hmi/widgets/bar.tsx", "src/hmi/theme.ts"],
    help: "Indicador analógico ISA-101: escala vertical, valor como preenchimento e ponteiro, limites como marcas coloridas e setpoint como seta.",
    props: [
      ...geometry(w, h), ...tagProp("FIC-101"), ...colorProps(),
      ...binding("", "Valor (PV)", "Componente", { unit: "%" }),
      ...binding("B", "Setpoint (SP)", "Componente", { unit: "%", value: 60 }),
      ...limits(),
    ],
    shapes: [
      txt(w / 2, 10, "", { textAnchor: "middle", fill: T.textMuted, fontSize: F.xs, stateText: { kind: "property", prop: "tag" } }),
      { kind: "rect", x: bx, y: top, w: bw, h: scaleH, fill: T.surface, stroke: T.equipStroke, strokeWidth: 1.5 },
      // Preenchimento do PV: topo em yOf(pv), altura até a base da escala.
      { kind: "rect", x: bx + 2, y: P("__g_pct", k, bottom), w: bw - 4, h: P("__g_pct", scaleH / 100, -1, { min: 0 }), fill: T.liquid, opacity: 0.85, stateVisible: whenGood },
      ...limitMarks({ x1: bx - 4, x2: bx + bw, labelX: bx - 6, mult: k, offset: bottom }),
      // Seta de setpoint. No upstream é um `<path>` triangular; aqui o `d` de um path é estático no
      // IR, então a seta é o glifo "◀" posicionado por expressão -- mesma leitura, e continua uma
      // primitiva genérica em vez de um caso especial no renderizador.
      txt(bx + bw + 11, P("__g_b_pct", k, bottom + 4), "◀", { fill: T.sp, fontSize: 11, textAnchor: "middle" }),
      { kind: "line", x1: bx - 2, x2: bx + bw + 2, y1: P("__g_pct", k, bottom), y2: P("__g_pct", k, bottom), stroke: T.text, strokeWidth: 2, stateVisible: whenGood },
      boundText(w / 2, h - 6, "__g_text_q", { textAnchor: "middle", fill: T.text, fontSize: F.base, fontWeight: WT.bold }),
    ],
  });
})();

// ── Medidor radial (src/hmi/widgets/gauge.tsx) ───────────────────────────────────────────────
// Único widget que precisa de ROTAÇÃO por valor, e por isso o ponteiro é autorado como `viewSpec`:
// `simulidePaint` só tem `transform` estático, enquanto `ViewSpecProjection.rotate` mapeia
// `propRange -> angleRange` exatamente como o `angOf` do upstream (-120°..+120°).
(() => {
  // `bodyH` é o corpo do medidor; `h` acrescenta a faixa onde o TAG é escrito. O upstream desenha
  // esse rótulo em `y = h + 12`, ou seja FORA da caixa do widget -- lá isso funciona porque o SVG
  // da tela não recorta. Aqui a caixa do componente É o recorte, então a faixa precisa existir no
  // desenho, senão o rótulo encosta na borda ou some.
  const w = 120, bodyH = 118, h = bodyH + 18;
  const cx = w / 2, cy = bodyH * 0.58, r = Math.min(w, bodyH) * 0.42;
  // O arco do upstream mede a partir das 12h e cresce no sentido horário; a primitiva `arc` daqui
  // usa ângulo matemático (0° = leste, anti-horário). A conversão é A = 90 - a, então o fundo vai
  // de A=210 (a=-120) varrendo -240°. Com pct: A = 210 - 2.4*pct.
  const A0 = 210, K = -2.4;
  const ax = cx - r, ay = cy - r, aw = 2 * r, ah = 2 * r;
  const at = (a) => ({ x: cx + r * Math.cos(((a - 90) * Math.PI) / 180), y: cy + r * Math.sin(((a - 90) * Math.PI) / 180) });
  const lo = at(-120), hi = at(120);
  WIDGETS.push({
    id: "gauge", label: "Medidor radial", labelEn: "Radial Gauge", folder: ["Indicadores", "Indicators"],
    w, h, aspect: "fixed",
    sourceFiles: ["src/hmi/widgets/gauge.tsx", "src/hmi/theme.ts"],
    help: "Medidor radial: ponteiro varre -120°..+120° sobre a faixa do binding, com arcos de zona nos limites.",
    props: [
      ...geometry(w, h), ...tagProp("PI-201"), ...colorProps(),
      ...binding("", "Valor (PV)", "Componente", { unit: "%" }),
      ...limits(),
    ],
    shapes: [
      { kind: "arc", x: ax, y: ay, w: aw, h: ah, startDeg: A0, spanDeg: -240, stroke: T.equipStroke, strokeWidth: 4, strokeLinecap: "round" },
      // Zonas ancoradas nas PONTAS da escala (H..max, min..L), que é o que mantém start e span
      // lineares num único sinal. Desenhar H..max e depois HH..max por cima dá a mesma figura do
      // upstream, que termina a zona de atenção em `limits.HH ?? max`.
      { kind: "arc", x: ax, y: ay, w: aw, h: ah, startDeg: P("__g_h_pct", K, A0), spanDeg: P("__g_h_pct", 2.4, -240), stroke: T.alarmMedium, strokeWidth: 4, stateVisible: whenProp("__g_h_set", true) },
      { kind: "arc", x: ax, y: ay, w: aw, h: ah, startDeg: P("__g_hh_pct", K, A0), spanDeg: P("__g_hh_pct", 2.4, -240), stroke: T.alarmHigh, strokeWidth: 4, stateVisible: whenProp("__g_hh_set", true) },
      { kind: "arc", x: ax, y: ay, w: aw, h: ah, startDeg: A0, spanDeg: P("__g_l_pct", K, 0), stroke: T.alarmMedium, strokeWidth: 4, stateVisible: whenProp("__g_l_set", true) },
      { kind: "arc", x: ax, y: ay, w: aw, h: ah, startDeg: A0, spanDeg: P("__g_ll_pct", K, 0), stroke: T.alarmHigh, strokeWidth: 4, stateVisible: whenProp("__g_ll_set", true) },
      { kind: "ellipse", cx, cy, rx: 3.5, ry: 3.5, fill: T.text },
      txt(lo.x, lo.y + 12, "0", { textAnchor: "middle", fill: T.textMuted, fontSize: 8, stateText: { kind: "property", prop: "bindMin" } }),
      txt(hi.x, hi.y + 12, "100", { textAnchor: "middle", fill: T.textMuted, fontSize: 8, stateText: { kind: "property", prop: "bindMax" } }),
      boundText(cx, cy + r * 0.7, "__g_text_q", { textAnchor: "middle", fill: T.text, fontSize: F.base, fontWeight: WT.medium }),
      txt(cx, h - 4, "", { textAnchor: "middle", fill: T.textMuted, fontSize: F.xs, stateText: { kind: "property", prop: "tag" } }),
    ],
    viewSpec: {
      // Só o ponteiro. Desenhado em repouso apontando para cima; `stateProjection` o gira pelo
      // MESMO mapeamento do upstream (`angOf`): 0..100 % -> -120°..+120°.
      paint: [{ kind: "line", partId: "needle", x1: cx, y1: cy, x2: cx, y2: cy - r + 6, stroke: T.text, strokeWidth: 2.5, stateVisible: whenGood }],
      stateProjection: {
        needle: [{ kind: "rotate", prop: "__g_pct", stepsPerRev: 100, cx, cy, propRange: [0, 100], angleRange: [-120, 120] }],
      },
    },
  });
})();

// ── Display de valor de processo (src/hmi/widgets/display.tsx) ───────────────────────────────
// Duas linhas: TAG (e SP) em cima, valor + unidade embaixo -- "as linhas nunca colidem, por mais
// comprido que o número fique". A borda muda com o alarme; sem ciclo de vida, só a codificação.
(() => {
  const w = 150, h = 56;
  WIDGETS.push({
    id: "display", label: "Display de valor", labelEn: "Value Display", folder: ["Indicadores", "Indicators"],
    w, h, aspect: "fixed",
    sourceFiles: ["src/hmi/widgets/display.tsx", "src/hmi/theme.ts"],
    help: "Display de valor de processo em duas linhas, com borda que reage aos limites configurados.",
    props: [
      ...geometry(w, h), ...tagProp("TI-301"), ...colorProps(),
      ...binding("", "Valor (PV)", "Componente", { unit: "°C", value: 25, max: 200 }),
      ...binding("B", "Setpoint (SP)", "Componente", { unit: "", value: 0 }),
      { id: "showSp", label: "Mostrar setpoint", group: "Componente", unit: "", editor: "checkbox", default: false },
      ...limits(),
    ],
    shapes: [
      {
        kind: "roundedRect", x: 1, y: 1, w: w - 2, h: h - 2, rx: 4, ry: 4, fill: T.surface,
        stroke: T.equipStroke, strokeWidth: 1.5,
        stateFill: { prop: "__g_alarm", map: { none: T.equipStroke, low: T.alarmMedium, high: T.alarmHigh }, applyToStroke: true, fallback: T.equipStroke },
      },
      txt(8, 14, "", { fill: T.textMuted, fontSize: F.xs, stateText: { kind: "property", prop: "tag" } }),
      boundText(w - 8, 14, "__g_b_text", { textAnchor: "end", fill: T.sp, fontSize: 9, stateVisible: whenProp("showSp", true) }),
      boundText(w - 8, h - 8, "__g_text_q", { textAnchor: "end", fill: T.text, fontSize: F.lg, fontWeight: WT.bold }),
    ],
  });
})();

// ── Vaso / tanque (src/hmi/widgets/tank.tsx) ─────────────────────────────────────────────────
// `shape` preserva a silhueta do símbolo de origem para o operador reconhecer o equipamento.
(() => {
  // `bodyH` é o casco; `h` acrescenta a faixa do TAG, que no upstream fica em `y = h + 12`.
  const w = 110, bodyH = 150, h = bodyH + 20;
  const roofCone = Math.min(16, bodyH * 0.22);
  const shell = (shape, bodyTop, r) => ({
    kind: "roundedRect", x: 2, y: bodyTop, w: w - 4, h: bodyH - 2 - bodyTop, rx: r, ry: r,
    fill: T.equipFill, stroke: T.equipStroke, strokeWidth: 2, stateVisible: whenProp("shape", shape),
  });
  // Um único corpo "líquido" por silhueta seria mais simples, mas o topo do cone e a banda do motor
  // deslocam a caixa útil; cada silhueta tem o seu par (casca, líquido) com as suas constantes.
  const liquidFor = (shape, bodyTop) => {
    const innerTop = bodyTop + 2, innerBot = bodyH - 4, span = innerBot - innerTop;
    return [
      { kind: "rect", x: 4, y: P("__g_pct", -span / 100, innerBot), w: w - 8, h: P("__g_pct", span / 100, 0, { min: 0 }), fill: T.liquid, stateVisible: { when: { shape: [shape], __g_quality: ["ok"] } } },
      { kind: "line", x1: 4, x2: w - 4, y1: P("__g_pct", -span / 100, innerBot), y2: P("__g_pct", -span / 100, innerBot), stroke: T.liquid, strokeWidth: 2, stateVisible: { when: { shape: [shape], __g_quality: ["ok"] } } },
    ];
  };
  const innerTopV = 4, innerBotV = bodyH - 4, spanV = innerBotV - innerTopV;
  WIDGETS.push({
    id: "tank", label: "Vaso / tanque", labelEn: "Vessel / Tank", folder: ["Equipamentos", "Equipment"],
    w, h, aspect: "fixed",
    sourceFiles: ["src/hmi/widgets/tank.tsx", "src/hmi/theme.ts"],
    help: "Vaso com nível, marcas de 25/50/75 %, limites de alarme e silhueta escolhível (vertical, horizontal, cônico, agitado).",
    props: [
      ...geometry(w, h), ...tagProp("LT-401"), ...colorProps(),
      { id: "shape", label: "Silhueta", group: "Componente", unit: "", editor: "select", default: "vertical",
        options: [
          { value: "vertical", label: "Vertical" },
          { value: "horizontal", label: "Horizontal" },
          { value: "cone", label: "Cônico" },
          { value: "agitated", label: "Agitado" },
        ] },
      ...binding("", "Nível (PV)", "Componente", { unit: "%" }),
      ...limits(),
    ],
    shapes: [
      shell("vertical", 2, Math.min(12, w / 4)),
      shell("horizontal", 2, (bodyH - 4) / 2),
      shell("agitated", 12, Math.min(12, w / 4)),
      { kind: "path", d: `M2 ${roofCone + 2} L${w / 2} 2 L${w - 2} ${roofCone + 2} V${bodyH - 2} H2 Z`, fill: T.equipFill, stroke: T.equipStroke, strokeWidth: 2, strokeLinejoin: "round", stateVisible: whenProp("shape", "cone") },
      ...liquidFor("vertical", 2),
      ...liquidFor("horizontal", 2),
      ...liquidFor("agitated", 12),
      ...liquidFor("cone", roofCone + 2),
      // Agitador: motor, eixo e impelidor.
      { kind: "rect", x: w / 2 - 8, y: 1, w: 16, h: 10, fill: T.equipFill, stroke: T.equipStroke, strokeWidth: 2, stateVisible: whenProp("shape", "agitated") },
      { kind: "line", x1: w / 2, y1: 11, x2: w / 2, y2: bodyH * 0.68, stroke: T.equipStroke, strokeWidth: 2, stateVisible: whenProp("shape", "agitated") },
      { kind: "path", d: `M${w / 2 - 9} ${bodyH * 0.68} L${w / 2} ${bodyH * 0.68 - 8} L${w / 2 + 9} ${bodyH * 0.68}`, fill: "none", stroke: T.equipStroke, strokeWidth: 2, strokeLinejoin: "round", stateVisible: whenProp("shape", "agitated") },
      ...[25, 50, 75].map((tk) => ({
        kind: "line", x1: w - 12, x2: w - 5,
        y1: innerTopV + spanV * (1 - tk / 100), y2: innerTopV + spanV * (1 - tk / 100),
        stroke: T.equipStroke, strokeWidth: 1.5, opacity: 0.8,
      })),
      ...limitMarks({ x1: 2, x2: 10, labelX: 12, mult: -spanV / 100, offset: innerBotV, size: F.xs - 2, anchor: "start" }),
      boundText(w / 2, bodyH / 2 + 5, "__g_text_q", { textAnchor: "middle", fill: T.text, fontSize: F.lg, fontWeight: WT.bold }),
      txt(w / 2, h - 5, "", { textAnchor: "middle", fill: T.text, fontSize: F.sm, fontWeight: WT.medium, stateText: { kind: "property", prop: "tag" } }),
    ],
  });
})();

// ── Válvula (src/hmi/widgets/valve.tsx) ──────────────────────────────────────────────────────
(() => {
  // O upstream desenha a haste e a posição em `y` NEGATIVO e o tag em `h + 14`, ou seja os dois
  // fora da caixa. Aqui o corpo é deslocado para baixo (`TOP`) e a caixa cresce, para que haste,
  // posição e tag caibam no desenho em vez de serem recortados.
  const w = 60, TOP = 26, bodyH = 40, h = TOP + bodyH + 20;
  const midX = w / 2, midY = TOP + bodyH / 2, botY = TOP + bodyH;
  const bowtie = (points) => ({
    kind: "polygon", points, stroke: T.equipStroke, strokeWidth: 2, fill: T.processInactive,
    stateFill: { prop: "__g_on", map: { true: T.processActive, false: T.processInactive }, fallback: T.processInactive },
  });
  WIDGETS.push({
    id: "valve", label: "Válvula HMI", labelEn: "HMI Valve", folder: ["Equipamentos", "Equipment"],
    w, h, aspect: "fixed",
    sourceFiles: ["src/hmi/widgets/valve.tsx", "src/hmi/theme.ts"],
    help: "Válvula em gravata: corpo colorido pelo estado aberto/fechado e, no modo modulante, haste, castelo e posição em %.",
    props: [
      ...geometry(w, h), ...tagProp("FCV-102"), ...colorProps(),
      { id: "throttle", label: "Modulante", group: "Componente", unit: "", editor: "checkbox", default: true },
      ...binding("", "Posição", "Componente", { unit: "%" }), ...discrete(2),
    ],
    shapes: [
      { kind: "line", x1: midX, y1: midY, x2: midX, y2: TOP - 8, stroke: T.equipStroke, strokeWidth: 2, stateVisible: whenProp("throttle", true) },
      { kind: "line", x1: midX - 8, y1: TOP - 8, x2: midX + 8, y2: TOP - 8, stroke: T.equipStroke, strokeWidth: 3, strokeLinecap: "round", stateVisible: whenProp("throttle", true) },
      bowtie([{ x: 2, y: TOP }, { x: midX, y: midY }, { x: 2, y: botY }]),
      bowtie([{ x: w - 2, y: TOP }, { x: midX, y: midY }, { x: w - 2, y: botY }]),
      boundText(midX, TOP - 14, "__g_text_q", { textAnchor: "middle", fill: T.text, fontSize: F.sm, fontWeight: WT.medium, stateVisible: whenProp("throttle", true) }),
      txt(midX, h - 5, "", { textAnchor: "middle", fill: T.text, fontSize: F.sm, fontWeight: WT.medium, stateText: { kind: "property", prop: "tag" } }),
    ],
  });
})();

// ── Bomba / motor (src/hmi/widgets/pump.tsx) ─────────────────────────────────────────────────
// "A RESTRIÇÃO É O PONTO. Uma bomba parada é o caso normal na maioria das telas, então ela recua
// para os tons de equipamento e não carrega cor nenhuma -- antes era pintada de VERMELHO, o que
// fazia uma planta corretamente desligada parecer uma emergência."
(() => {
  // O upstream escreve o tag em `h + 12` e a palavra de estado em `h + 22`, os dois fora da caixa.
  // `bodyH` é o corpo; `h` acrescenta as duas linhas, senão elas caem em cima do rotor.
  const w = 72, bodyH = 72, h = bodyH + 36;
  const r = Math.min(w, bodyH) / 2 - 6, cx = w / 2, cy = bodyH / 2 - 2;
  const stateWord = (text, color, weight, when) =>
    txt(cx, h - 6, text, { textAnchor: "middle", fill: color, fontSize: F.xs, fontWeight: weight, stateVisible: when });
  WIDGETS.push({
    id: "pump", label: "Bomba / motor", labelEn: "Pump / Motor", folder: ["Equipamentos", "Equipment"],
    w, h, aspect: "fixed",
    sourceFiles: ["src/hmi/widgets/pump.tsx", "src/hmi/state.ts", "src/hmi/theme.ts"],
    help: "Bomba com estado em cor E em palavra (ISA-101: cor nunca é o único portador do estado). Parada é neutra; só o disparo recebe cor de alarme.",
    props: [
      ...geometry(w, h), ...tagProp("P-101"), ...colorProps(),
      ...binding("", "Em marcha", "Componente", { unit: "" }), ...discrete(),
      { id: "tripped", label: "Disparada", group: "Componente", unit: "", editor: "checkbox", default: false },
      { id: "outOfService", label: "Fora de serviço", group: "Componente", unit: "", editor: "checkbox", default: false },
    ],
    shapes: [
      { kind: "rect", x: cx - r - 2, y: cy + r - 1, w: 2 * r + 4, h: 5, fill: T.equipStroke, opacity: 0.7 },
      {
        kind: "ellipse", cx, cy, rx: r, ry: r, stroke: T.equipStroke, strokeWidth: 1.5, fill: T.processInactive,
        stateFill: { prop: "__g_on", map: { true: T.processActive, false: T.processInactive }, fallback: T.processInactive },
        stateVisible: { when: { tripped: ["false"], outOfService: ["false"] } },
      },
      { kind: "ellipse", cx, cy, rx: r, ry: r, fill: T.disabled, stroke: T.equipStroke, strokeWidth: 1.5, stateVisible: { when: { tripped: ["false"], outOfService: ["true"] } } },
      { kind: "ellipse", cx, cy, rx: r, ry: r, fill: T.alarmHigh, stroke: T.alarmHigh, strokeWidth: 2.5, stateVisible: whenProp("tripped", true) },
      { kind: "path", d: `M ${cx} ${cy} L ${cx + r * 0.72} ${cy - r * 0.4} L ${cx + r * 0.72} ${cy + r * 0.4} Z`, fill: T.equipStroke, opacity: 0.55, stateVisible: whenProp("__g_on", false) },
      { kind: "path", d: `M ${cx} ${cy} L ${cx + r * 0.72} ${cy - r * 0.4} L ${cx + r * 0.72} ${cy + r * 0.4} Z`, fill: T.bg, opacity: 0.9, stateVisible: whenProp("__g_on", true) },
      // Fora de serviço é HACHURADO: um acionamento desabilitado não pode se ler como um parado
      // saudável, e a textura diz isso sem depender de cor nenhuma.
      { kind: "line", x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r, stroke: T.textMuted, strokeWidth: 1, opacity: 0.8, stateVisible: whenProp("outOfService", true) },
      { kind: "line", x1: cx - r, y1: cy + r, x2: cx + r, y2: cy - r, stroke: T.textMuted, strokeWidth: 1, opacity: 0.8, stateVisible: whenProp("outOfService", true) },
      txt(cx, h - 20, "", { textAnchor: "middle", fill: T.text, fontSize: F.sm, fontWeight: WT.medium, stateText: { kind: "property", prop: "tag" } }),
      // O estado em PALAVRA, além da cor.
      stateWord("PARADA", T.textSecondary, WT.normal, { when: { tripped: ["false"], outOfService: ["false"], __g_on: ["false"] } }),
      stateWord("EM MARCHA", T.textSecondary, WT.normal, { when: { tripped: ["false"], outOfService: ["false"], __g_on: ["true"] } }),
      stateWord("FORA DE SERVIÇO", T.textMuted, WT.normal, { when: { tripped: ["false"], outOfService: ["true"] } }),
      stateWord("DISPARADA", T.alarmHigh, WT.bold, whenProp("tripped", true)),
    ],
  });
})();

// ── Lâmpada (src/hmi/widgets/lamp.tsx) ───────────────────────────────────────────────────────
(() => {
  // A caixa é mais larga que a lâmpada de proposito: o rótulo fica abaixo (`h + 12` no upstream) e
  // uma palavra como "FALHA BOMBA" não cabe em 40 px. O círculo continua centrado e circular.
  const w = 72, lampD = 34, h = lampD + 24;
  WIDGETS.push({
    id: "lamp", label: "Lâmpada HMI", labelEn: "HMI Lamp", folder: ["Indicadores", "Indicators"],
    w, h, aspect: "fixed",
    sourceFiles: ["src/hmi/widgets/lamp.tsx", "src/hmi/theme.ts"],
    help: "Lâmpada de estado com rótulo abaixo.",
    props: [
      ...geometry(w, h), ...colorProps(),
      { id: "label", label: "Rótulo", group: "Componente", unit: "", editor: "text", default: "ESTADO" },
      ...binding("", "Estado", "Componente", { unit: "" }), ...discrete(),
    ],
    shapes: [
      {
        kind: "ellipse", cx: w / 2, cy: 3 + lampD / 2, rx: lampD / 2, ry: lampD / 2, stroke: T.equipStroke, strokeWidth: 2, fill: T.surface,
        stateFill: { prop: "__g_on", map: { true: T.processActive, false: T.surface }, fallback: T.surface },
      },
      txt(w / 2, h - 6, "", { textAnchor: "middle", fill: T.textMuted, fontSize: F.xs, stateText: { kind: "property", prop: "label" } }),
    ],
  });
})();

// ── Moldura de painel (src/hmi/widgets/panel.tsx) ────────────────────────────────────────────
(() => {
  const w = 220, h = 140;
  WIDGETS.push({
    id: "panel", label: "Moldura de painel", labelEn: "Panel Frame", folder: ["Layout", "Layout"],
    w, h, aspect: "variable", elastic: true,
    sourceFiles: ["src/hmi/widgets/panel.tsx", "src/hmi/theme.ts"],
    help: "Moldura de agrupamento com título. Painéis industriais agrupam com réguas, não com cartões arredondados.",
    props: [
      ...geometry(w, h), ...colorProps(),
      { id: "title", label: "Título", group: "Componente", unit: "", editor: "text", default: "GRUPO" },
    ],
    shapes: [
      { kind: "rect", x: 0.5, y: 0.5, w: P("width", 1, -1, { fallback: w }), h: P("height", 1, -1, { fallback: h }), fill: T.surface, stroke: T.border, strokeWidth: 1 },
      { kind: "rect", x: 0.5, y: 0.5, w: P("width", 1, -1, { fallback: w }), h: 20, fill: T.surfaceSunken, stroke: T.border, strokeWidth: 1 },
      txt(8, 14, "", { fill: T.textSecondary, fontSize: F.sm, fontWeight: WT.medium, stateText: { kind: "property", prop: "title" } }),
    ],
  });
})();

// ── Faceplate de controlador (src/hmi/Faceplate.tsx) ─────────────────────────────────────────
// O widget que justifica os bindings secundários: uma malha mostra TRÊS variáveis.
(() => {
  // Os três números ficam sob as suas próprias barras. Alinhados à direita, como estavam, o de PV
  // atravessava a coluna de OP -- só há 22 px livres à direita das barras, e "62.0 %" precisa de
  // quase o dobro disso.
  const w = 180, h = 214;
  const top = 46, bottom = h - 46, scaleH = bottom - top;
  const k = -scaleH / 100;
  const barW = 26;
  const colX = { pv: 24, sp: 77, op: 130 };
  const column = (x, prop, textProp, color, caption) => [
    { kind: "rect", x, y: top, w: barW, h: scaleH, fill: T.surfaceSunken, stroke: T.border, strokeWidth: 1 },
    { kind: "rect", x: x + 2, y: P(prop, k, bottom), w: barW - 4, h: P(prop, scaleH / 100, 0, { min: 0 }), fill: color },
    txt(x + barW / 2, top - 8, caption, { textAnchor: "middle", fill: color === T.liquid ? T.textMuted : color, fontSize: F.xs }),
    boundText(x + barW / 2, bottom + 16, textProp, { textAnchor: "middle", fill: T.text, fontSize: F.sm, fontWeight: WT.medium }),
  ];
  WIDGETS.push({
    id: "faceplate", label: "Faceplate de malha", labelEn: "Loop Faceplate", folder: ["Controle", "Control"],
    w, h, aspect: "fixed",
    sourceFiles: ["src/hmi/Faceplate.tsx", "src/hmi/theme.ts"],
    help: "Faceplate de malha: PV, setpoint e saída lado a lado, cada um com o seu binding independente.",
    props: [
      ...geometry(w, h), ...tagProp("FIC-101"), ...colorProps(),
      ...binding("", "PV", "Componente", { unit: "%" }),
      ...binding("B", "SP", "Componente", { unit: "%", value: 60 }),
      ...binding("C", "OP", "Componente", { unit: "%", value: 40 }),
      { id: "mode", label: "Modo", group: "Componente", unit: "", editor: "select", default: "AUTO",
        options: [{ value: "AUTO", label: "AUTO" }, { value: "MAN", label: "MANUAL" }, { value: "CAS", label: "CASCATA" }] },
      ...limits(),
    ],
    shapes: [
      { kind: "rect", x: 0.5, y: 0.5, w: w - 1, h: h - 1, fill: T.surface, stroke: T.borderStrong, strokeWidth: 1.5 },
      { kind: "rect", x: 0.5, y: 0.5, w: w - 1, h: 22, fill: T.surfaceSunken, stroke: T.border, strokeWidth: 1 },
      txt(8, 16, "", { fill: T.text, fontSize: F.sm, fontWeight: WT.bold, stateText: { kind: "property", prop: "tag" } }),
      txt(w - 8, 16, "", { textAnchor: "end", fill: T.accent, fontSize: F.xs, fontWeight: WT.bold, stateText: { kind: "property", prop: "mode" } }),
      ...column(colX.pv, "__g_pct", "__g_text_q", T.liquid, "PV"),
      ...column(colX.sp, "__g_b_pct", "__g_b_text", T.sp, "SP"),
      ...column(colX.op, "__g_c_pct", "__g_c_text", T.op, "OP"),
      ...limitMarks({ x1: colX.pv - 6, x2: colX.pv + barW, labelX: colX.pv - 8, mult: k, offset: bottom }),
    ],
  });
})();

// ── Tarja de alarme (src/hmi/AlarmBanner.tsx) ────────────────────────────────────────────────
(() => {
  const w = 320, h = 34;
  WIDGETS.push({
    id: "alarm_banner", label: "Tarja de alarme", labelEn: "Alarm Banner", folder: ["Indicadores", "Indicators"],
    w, h, aspect: "variable", elastic: true,
    sourceFiles: ["src/hmi/AlarmBanner.tsx", "src/hmi/theme.ts"],
    help: "Tarja com a condição do valor contra os limites. É CODIFICAÇÃO VISUAL, não um motor de alarmes: não há reconhecer, silenciar nem inibir.",
    props: [
      ...geometry(w, h), ...tagProp("FIC-101"), ...colorProps(),
      { id: "message", label: "Mensagem", group: "Componente", unit: "", editor: "text", default: "FORA DE FAIXA" },
      ...binding("", "Valor (PV)", "Componente", { unit: "%" }),
      ...limits(),
    ],
    shapes: [
      {
        kind: "rect", x: 0.5, y: 0.5, w: P("width", 1, -1, { fallback: w }), h: P("height", 1, -1, { fallback: h }),
        fill: T.surface, stroke: T.border, strokeWidth: 1,
        stateFill: { prop: "__g_alarm", map: { none: T.surface, low: T.alarmMedium, high: T.alarmHigh }, fallback: T.surface },
      },
      txt(10, 15, "", { fill: T.text, fontSize: F.sm, fontWeight: WT.bold, stateText: { kind: "property", prop: "tag" }, stateFill: { prop: "__g_alarm", map: { none: T.text, low: T.textOnAccent, high: T.textOnAccent }, fallback: T.text } }),
      txt(10, 28, "NORMAL", { fill: T.textMuted, fontSize: F.xs, stateVisible: whenProp("__g_alarm", "none") }),
      txt(10, 28, "", { fill: T.textOnAccent, fontSize: F.xs, fontWeight: WT.bold, stateText: { kind: "property", prop: "message" }, stateVisible: whenProp("__g_alarm", "low", "high") }),
      boundText(P("width", 1, -10, { fallback: w }), 22, "__g_text_q", { textAnchor: "end", fill: T.text, fontSize: F.md, fontWeight: WT.bold, stateFill: { prop: "__g_alarm", map: { none: T.text, low: T.textOnAccent, high: T.textOnAccent }, fallback: T.text } }),
    ],
  });
})();

// ---------------------------------------------------------------------------
// 5. Catálogo
// ---------------------------------------------------------------------------

const typeIdOf = (id) => `graphics.hmi.${id}`;
const iconOf = (id) => `graphics-hmi-${id.replace(/_/g, "-")}`;

function catalogItemFor(widget) {
  const defaultProperties = Object.fromEntries(widget.props.map((entry) => [entry.id, entry.default]));
  const elastic = widget.elastic === true;
  // GEOMETRIA DINÂMICA EXIGE `simulidePaint`, não `shapes[]`.
  //
  // Os dois campos aceitam a mesma lista de primitivas, mas só o renderizador de `simulidePaint`
  // AVALIA `PackageNumberExpression`; em `shapes[]` a expressão é usada como está e o atributo sai
  // literalmente "[object Object]". Foi assim que estes widgets desenharam a primeira vez -- moldura
  // e texto certos, e todo elemento dirigido por valor mudo. `shapes[]` serve à biblioteca P&ID
  // portada, cujas primitivas são SVG estático; aqui, onde o desenho É função do valor, o caminho é
  // `simulidePaint`.
  const pkg = {
    width: widget.w,
    height: widget.h,
    border: false,
    background: { kind: "none" },
    pins: [],
    dynamicLayout: {
      width: { prop: "width", fallback: widget.w },
      height: { prop: "height", fallback: widget.h },
      // Elástico: a caixa de desenho acompanha a instância, então o traço e o texto não engordam
      // junto -- é o que uma moldura e uma tarja precisam.
      ...(elastic ? { simulideBounds: { w: { prop: "width", fallback: widget.w }, h: { prop: "height", fallback: widget.h } } } : {}),
    },
    simulidePaint: {
      version: 1,
      bounds: { x: 0, y: 0, w: widget.w, h: widget.h },
      aspect: widget.aspect,
      ...(elastic ? {} : { referenceSize: { width: widget.w, height: widget.h } }),
      defaultStroke: T.equipStroke,
      defaultFill: "none",
      defaultStrokeWidth: 1.5,
      primitives: widget.shapes,
    },
    // O medidor radial é o único que precisa de ROTAÇÃO por valor, e `simulidePaint` só tem
    // `transform` estático. `overlayPaint` desenha o ponteiro do ViewSpec POR CIMA do corpo já
    // pintado, em vez de obrigar o widget inteiro a mudar de renderizador.
    ...(widget.viewSpec ? { viewSpec: { overlayPaint: true, ...widget.viewSpec } } : {}),
  };
  return {
    typeId: typeIdOf(widget.id),
    label: widget.label,
    pinCount: 0,
    icon: iconOf(widget.id),
    graphical: true,
    folderPath: ["Grafico", "HMI", widget.folder[0]],
    category: "Grafico",
    workspaceSection: "misc",
    defaultProperties,
    propertySchema: widget.props,
    package: pkg,
    help: { description: `${widget.help} ${LICENSE_NOTE}` },
    provenance: {
      source: "IPD Studio (HMI Studio)",
      sourceCommit: IPD_SOURCE_COMMIT,
      sourceFiles: widget.sourceFiles,
      adaptation: "widget geometry, proportions and ISA-101 colour semantics transcribed from the upstream React renderer into a LasecSimul declarative PackageDescriptor; upstream process simulation, alarm lifecycle and history were deliberately NOT ported",
      license: IPD_LICENSE,
      licenseUrl: IPD_LICENSE_URL,
      requiredNotice: IPD_REQUIRED_NOTICE,
    },
  };
}

const items = WIDGETS.map(catalogItemFor);
const ownedTypeIds = new Set(items.map((item) => item.typeId));

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
catalog.items = [...catalog.items.filter((item) => !ownedTypeIds.has(item.typeId)), ...items];
catalog.translations = catalog.translations ?? {};
catalog.translations.en = catalog.translations.en ?? { items: {} };
catalog.translations.en.items = catalog.translations.en.items ?? {};
for (const widget of WIDGETS) {
  catalog.translations.en.items[typeIdOf(widget.id)] = { label: widget.labelEn, folderPath: ["Graphical", "HMI", widget.folder[1]] };
}
fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

// ---------------------------------------------------------------------------
// 6. Ícones da paleta
// ---------------------------------------------------------------------------

/** O ícone é um esboço do widget, não o widget renderizado: o desenho real depende de propriedades
 * de runtime que não existem na paleta. Mantém o mesmo par de temas dos outros ícones. */
const ICON_SKETCH = {
  bar: '<rect x="9" y="3" width="6" height="18" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="10" y="12" width="4" height="8.5" fill="currentColor" opacity="0.6"/><line x1="7" y1="12" x2="17" y2="12" stroke="currentColor" stroke-width="1.5"/>',
  gauge: '<path d="M4 17 A 8 8 0 1 1 20 17" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="12" y1="17" x2="8" y2="11" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="17" r="1.6" fill="currentColor"/>',
  display: '<rect x="2.5" y="6" width="19" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><text x="19" y="15.5" font-size="7" text-anchor="end" fill="currentColor">42</text><text x="5" y="11" font-size="4.5" fill="currentColor">TI</text>',
  tank: '<rect x="5" y="3" width="14" height="18" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 12 h12 v8 a2 2 0 0 1 -2 2 h-8 a2 2 0 0 1 -2 -2 Z" fill="currentColor" opacity="0.45"/>',
  valve: '<polygon points="3,6 12,12 3,18" fill="currentColor" opacity="0.6" stroke="currentColor" stroke-width="1.4"/><polygon points="21,6 12,12 21,18" fill="currentColor" opacity="0.6" stroke="currentColor" stroke-width="1.4"/><line x1="12" y1="12" x2="12" y2="4" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="4" x2="16" y2="4" stroke="currentColor" stroke-width="2"/>',
  pump: '<circle cx="12" cy="11" r="7.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 11 L18 8.5 L18 13.5 Z" fill="currentColor" opacity="0.7"/><rect x="4" y="19" width="16" height="2.5" fill="currentColor" opacity="0.6"/>',
  lamp: '<circle cx="12" cy="10" r="6.5" fill="currentColor" opacity="0.55" stroke="currentColor" stroke-width="1.8"/><line x1="6" y1="20" x2="18" y2="20" stroke="currentColor" stroke-width="1.5"/>',
  panel: '<rect x="2.5" y="4" width="19" height="16" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="2.5" y="4" width="19" height="4" fill="currentColor" opacity="0.35"/>',
  faceplate: '<rect x="3.5" y="2.5" width="17" height="19" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="2.5" width="17" height="4" fill="currentColor" opacity="0.35"/><rect x="6" y="9" width="3" height="10" fill="currentColor" opacity="0.7"/><rect x="10.5" y="12" width="3" height="7" fill="currentColor" opacity="0.5"/><rect x="15" y="14" width="3" height="5" fill="currentColor" opacity="0.35"/>',
  alarm_banner: '<rect x="1.5" y="7" width="21" height="10" rx="1.5" fill="currentColor" opacity="0.35" stroke="currentColor" stroke-width="1.4"/><path d="M12 9.5 v3.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="14.8" r="0.9" fill="currentColor"/>',
};

const metadata = JSON.stringify({
  source: "IPD Studio (HMI Studio)",
  sourceCommit: IPD_SOURCE_COMMIT,
  license: IPD_LICENSE,
  licenseUrl: IPD_LICENSE_URL,
  requiredNotice: IPD_REQUIRED_NOTICE,
}).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let iconCount = 0;
for (const [theme, stroke] of [["light", "#1f2933"], ["dark", "#e5e7eb"]]) {
  fs.mkdirSync(path.join(iconDir, theme), { recursive: true });
  for (const widget of WIDGETS) {
    const sketch = ICON_SKETCH[widget.id];
    if (!sketch) throw new Error(`sem esboço de ícone para ${widget.id}`);
    fs.writeFileSync(
      path.join(iconDir, theme, `${iconOf(widget.id)}.svg`),
      `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" color="${stroke}"><metadata>${metadata}</metadata>${sketch}</svg>\n`,
      "utf8",
    );
    iconCount += 1;
  }
}

console.log(`[ipd-hmi] ${items.length} widgets publicados, ${iconCount} ícones gerados`);

/**
 * Biblioteca gráfica de supervisório (HMI/SCADA) -- `Miscelâneos > Gráfico`.
 *
 * Cada símbolo é DADO: um `package.simulidePaint` declarativo (o mesmo IR já usado por 55
 * dispositivos do catálogo, ver `ui/webview/simulidePaint.ts`) publicado em
 * `project/schema/component-catalog.json`. Adicionar um símbolo novo é acrescentar uma entrada
 * nesta lista -- nunca um `case` novo no renderizador, nunca um editor novo, nunca um formato novo.
 * Ver `docs/44-biblioteca-grafica-supervisorio-fase0.md` para a auditoria que levou a este desenho.
 *
 * Regras que este gerador materializa:
 *  - `pinCount: 0` mantém todo elemento gráfico FORA do Core (`shouldSyncComponentToCore`), ou seja
 *    ele nunca participa do solver -- é a regra da FEAT-008 ("visualização é projeção de telemetria").
 *  - geometria dinâmica sai de `PackageNumberExpression` (`{prop, multiplier, offset}`) e cor/texto/
 *    visibilidade de `stateFill`/`stateText`/`stateVisible`; quem produz `__g_pct`/`__g_text`/`__g_on`
 *    é o resolvedor ÚNICO de binding em `ui/webview/graphicsBinding.ts`.
 *  - `bounds` FIXO quando a geometria depende do valor ligado (o desenho é escalado para a caixa da
 *    instância); `bounds` ELÁSTICO (= width/height da instância) quando o símbolo é esticado muito
 *    além da sua proporção natural (tubo, linha de sinal, caixa de equipamento), para o traço não
 *    engordar junto.
 *
 * Uso: `node scripts/generate-graphics-library.mjs`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(repoRoot, "project", "schema", "component-catalog.json");
const iconDir = path.join(repoRoot, "extension", "media", "components");

// ---------------------------------------------------------------------------
// Paleta e helpers
// ---------------------------------------------------------------------------

/** Cores de estado da biblioteca inteira -- um símbolo nunca inventa a sua. */
const C = {
  outline: "currentColor",
  body: "#e2e8f0",
  bodyDark: "#cbd5e1",
  liquid: "#38bdf8",
  metal: "#cbd5e1",
  open: "#22c55e",
  closed: "#94a3b8",
  partial: "#f59e0b",
  fault: "#ef4444",
  running: "#22c55e",
  stopped: "#94a3b8",
  panel: "#f8fafc",
  ink: "#0f172a",
  accent: "#0284c7",
};

/** `PackageNumberExpression`: valor de uma primitiva derivado de uma propriedade da instância. */
const P = (prop, multiplier = 1, offset = 0, extra = {}) => ({ prop, multiplier, offset, ...extra });
/** Largura/altura da instância, para símbolos de `bounds` elástico. */
const W = (multiplier = 1, offset = 0) => P("width", multiplier, offset, { fallback: 120 });
const H = (multiplier = 1, offset = 0) => P("height", multiplier, offset, { fallback: 60 });
/** Percentual resolvido pelo binding (0..100). */
const PCT = (multiplier = 1, offset = 0) => P("__g_pct", multiplier, offset, { fallback: 0 });

const onOff = (onColor, offColor) => ({ prop: "__g_on", map: { true: onColor, false: offColor }, fallback: offColor });
const whenProp = (prop, ...values) => ({ when: { [prop]: values.map(String) } });
const boundText = (extra = {}) => ({ kind: "text", stateText: { kind: "property", prop: "__g_text" }, value: "", ...extra });

// ---------------------------------------------------------------------------
// Blocos de propriedades reutilizáveis (Inspector: agrupados por `group`)
// ---------------------------------------------------------------------------

const geometry = (w, h) => [
  { id: "width", label: "Largura", group: "Geometria", unit: "px", editor: "number", default: w, min: 4, max: 4000, step: 1 },
  { id: "height", label: "Altura", group: "Geometria", unit: "px", editor: "number", default: h, min: 4, max: 4000, step: 1 },
];

const appearance = ({ stroke = C.outline, fill = C.body, strokeWidth = 1.5, withFill = true } = {}) => [
  { id: "stroke", label: "Contorno", group: "Aparência", unit: "", editor: "color", default: stroke },
  ...(withFill ? [{ id: "fill", label: "Preenchimento", group: "Aparência", unit: "", editor: "color", default: fill }] : []),
  { id: "strokeWidth", label: "Espessura do contorno", group: "Aparência", unit: "px", editor: "number", default: strokeWidth, min: 0, max: 20, step: 0.5 },
  { id: "opacity", label: "Opacidade", group: "Aparência", unit: "", editor: "number", default: 1, min: 0, max: 1, step: 0.05 },
];

/** Grupo "Binding" analógico: valor estático + fonte + transformação + faixa + formatação.
 * Idêntico em todo símbolo -- é o contrato de `graphicsBinding.ts`, não uma cópia por símbolo. */
const analogBinding = (valueLabel, unit = "%", { min = 0, max = 100, value = 50, decimals = 1 } = {}) => [
  { id: "value", label: valueLabel, group: "Componente", unit, editor: "number", default: value, min: -1e9, max: 1e9, step: 1 },
  { id: "bindSource", label: "Fonte (id do componente)", group: "Binding", unit: "", editor: "text", default: "" },
  { id: "bindChannel", label: "Canal da fonte", group: "Binding", unit: "", editor: "number", default: 0, min: 0, max: 64, step: 1 },
  { id: "bindScale", label: "Ganho", group: "Binding", unit: "", editor: "number", default: 1, min: -1e6, max: 1e6, step: 0.1 },
  { id: "bindOffset", label: "Offset", group: "Binding", unit: "", editor: "number", default: 0, min: -1e9, max: 1e9, step: 1 },
  { id: "bindMin", label: "Faixa mínima", group: "Binding", unit: "", editor: "number", default: min, min: -1e9, max: 1e9, step: 1 },
  { id: "bindMax", label: "Faixa máxima", group: "Binding", unit: "", editor: "number", default: max, min: -1e9, max: 1e9, step: 1 },
  { id: "bindUnit", label: "Unidade exibida", group: "Binding", unit: "", editor: "text", default: unit },
  { id: "bindDecimals", label: "Casas decimais", group: "Binding", unit: "", editor: "number", default: decimals, min: 0, max: 6, step: 1 },
];

/** Grupo "Binding" booleano: acrescenta limiar/inversão ao analógico (mesmo resolvedor). */
const stateBinding = (valueLabel, opts = {}) => [
  ...analogBinding(valueLabel, opts.unit ?? "%", opts),
  { id: "bindThreshold", label: "Limiar de ligado", group: "Binding", unit: "", editor: "number", default: opts.threshold ?? 50, min: -1e9, max: 1e9, step: 1 },
  { id: "bindInvert", label: "Inverter estado", group: "Binding", unit: "", editor: "checkbox", default: false },
];

/** Ação HMI genérica: aponta para o MESMO id/propriedade que o Inspector/Core já atualizam.
 * Valores ficam como texto para aceitar número, booleano e comandos enumerados sem criar editores
 * específicos por protocolo. `graphicsAction.ts` faz o parse tipado e a transição de estado. */
const action = (mode = "set", value = "true", releaseValue = "false") => [
  { id: "actionTarget", label: "Alvo (id do componente)", group: "Ação", unit: "", editor: "text", default: "" },
  { id: "actionProperty", label: "Propriedade do alvo", group: "Ação", unit: "", editor: "text", default: "" },
  { id: "actionMode", label: "Operação", group: "Ação", unit: "", editor: "select", default: mode,
    options: [
      { value: "set", label: "Definir valor" },
      { value: "toggle", label: "Alternar" },
      { value: "momentary", label: "Momentâneo" },
      { value: "increment", label: "Incrementar" },
    ] },
  { id: "actionValue", label: "Valor ativo", group: "Ação", unit: "", editor: "text", default: value },
  { id: "actionReleaseValue", label: "Valor ao soltar/desligar", group: "Ação", unit: "", editor: "text", default: releaseValue },
  { id: "actionStep", label: "Incremento", group: "Ação", unit: "", editor: "number", default: 1, min: -1e9, max: 1e9, step: 0.1 },
  { id: "actionMin", label: "Limite mínimo", group: "Ação", unit: "", editor: "number", default: 0, min: -1e9, max: 1e9, step: 1 },
  { id: "actionMax", label: "Limite máximo", group: "Ação", unit: "", editor: "number", default: 100, min: -1e9, max: 1e9, step: 1 },
];

const showValueProps = (defaultOn = false) => [
  { id: "showValue", label: "Mostrar valor", group: "Componente", unit: "", editor: "checkbox", default: defaultOn },
];

// ---------------------------------------------------------------------------
// Símbolos
// ---------------------------------------------------------------------------

/**
 * `elastic: true`  -> `bounds` acompanha width/height da instância (escala 1:1, traço constante).
 * `elastic: false` -> `bounds` é a caixa de projeto; o desenho inteiro é escalado para a instância.
 */
const SYMBOLS = [];
const symbol = (def) => { SYMBOLS.push(def); };

const DRAWIO_REFERENCE_COMMIT = "744cb5420fdf126efd7a09b1d7082ca3e12c0841";
const drawioRef = (stencil, names) => ({
  source: "drawio-reference",
  sourceStencil: `src/main/webapp/stencils/pid/${stencil}`,
  sourceNames: names,
  sourceCommit: DRAWIO_REFERENCE_COMMIT,
  adaptation: "independent native LasecSimul geometry; no draw.io XML or path copied",
});

const IPD_REFERENCE_COMMIT = "4b84fb8694bc89985872690366e8be2e32a8db2b";
/** Current IPD is PolyForm Noncommercial. These references therefore record behavior/layout
 * studied during the audit, never copied source or geometry. Production primitives below are an
 * independent PackageDescriptor implementation owned by LasecSimul. */
const withIpdConcept = (provenance, files, concepts) => ({
  ...provenance,
  conceptualReference: "IPD Studio",
  conceptualReferenceCommit: IPD_REFERENCE_COMMIT,
  conceptualReferenceFiles: files,
  conceptualReferenceTopics: concepts,
  conceptualReferenceReuse: "concept-only; no PolyForm source or geometry copied",
});

/** Direct adaptations explicitly requested for this noncommercial project. The source notice is
 * retained in the catalog and generated SVG metadata; these portions are not relicensed as if they
 * were original LasecSimul work.
 * Required Notice: Copyright © 2026 Praharsh Nagpure (https://github.com/Coldbari/IPD-Studio)
 * License: https://polyformproject.org/licenses/noncommercial/1.0.0
 */
const ipdPortRef = (files, details) => ({
  source: "IPD Studio",
  sourceCommit: IPD_REFERENCE_COMMIT,
  sourceFiles: files,
  adaptation: details,
  license: "PolyForm Noncommercial 1.0.0",
  licenseUrl: "https://polyformproject.org/licenses/noncommercial/1.0.0",
  requiredNotice: "Copyright © 2026 Praharsh Nagpure (https://github.com/Coldbari/IPD-Studio)",
});

// ---- Tubulação ------------------------------------------------------------

symbol({
  id: "pipe", label: "Tubulação", labelEn: "Pipe", folder: ["Tubulacao", "Pipes"],
  help: "Trecho reto de tubulação com espessura, flanges e seta de fluxo opcionais.",
  provenance: drawioRef("piping.xml", ["Flange", "Flexible Hose", "Welded Connection"]),
  w: 140, h: 18, elastic: true,
  props: [
    ...geometry(140, 18),
    { id: "fill", label: "Cor do tubo", group: "Aparência", unit: "", editor: "color", default: C.metal },
    { id: "stroke", label: "Contorno", group: "Aparência", unit: "", editor: "color", default: C.outline },
    { id: "strokeWidth", label: "Espessura do contorno", group: "Aparência", unit: "px", editor: "number", default: 1.5, min: 0, max: 20, step: 0.5 },
    { id: "opacity", label: "Opacidade", group: "Aparência", unit: "", editor: "number", default: 1, min: 0, max: 1, step: 0.05 },
    { id: "showFlow", label: "Seta de fluxo", group: "Componente", unit: "", editor: "checkbox", default: true },
    { id: "flowDirection", label: "Sentido do fluxo", group: "Componente", unit: "", editor: "select", default: "forward",
      options: [{ value: "forward", label: "Direto" }, { value: "reverse", label: "Reverso" }] },
    { id: "showFlanges", label: "Flanges nas pontas", group: "Componente", unit: "", editor: "checkbox", default: false },
    ...stateBinding("Fluxo (%)", { unit: "%", value: 100 }),
  ],
  paint: () => [
    // Casco cilindrico: o volume vem de FAIXAS horizontais sobrepostas ao corpo, nunca de
    // gradiente -- gradiente no IR usa `userSpaceOnUse` com coordenadas CONSTANTES, e este simbolo
    // e' elastico (bounds = width/height da instancia), entao a rampa nao acompanharia a espessura.
    // Faixas em fracao de H acompanham qualquer espessura e qualquer cor de tubo, porque sao
    // overlays de branco/preto e nao cores fixas.
    { kind: "rect", x: 0, y: 0, w: W(), h: H(), fill: { prop: "fill" }, stroke: "none" },
    { kind: "rect", x: 0, y: 0, w: W(), h: H(0.17), fill: "#000000", stroke: "none", opacity: 0.22 },
    { kind: "rect", x: 0, y: H(0.17), w: W(), h: H(0.13), fill: "#ffffff", stroke: "none", opacity: 0.34 },
    { kind: "rect", x: 0, y: H(0.30), w: W(), h: H(0.15), fill: "#ffffff", stroke: "none", opacity: 0.88 },
    { kind: "rect", x: 0, y: H(0.45), w: W(), h: H(0.13), fill: "#ffffff", stroke: "none", opacity: 0.30 },
    { kind: "rect", x: 0, y: H(0.62), w: W(), h: H(0.20), fill: "#000000", stroke: "none", opacity: 0.12 },
    { kind: "rect", x: 0, y: H(0.82), w: W(), h: H(0.18), fill: "#000000", stroke: "none", opacity: 0.26 },
    // `strokeWidth` no IR e numero puro (nao aceita expressao de propriedade, ao contrario de
    // x/y/w/h) -- passar um objeto aqui gera NaN no atributo do SVG.
    { kind: "line", x1: 0, y1: H(0.005), x2: W(), y2: H(0.005), strokeWidth: 1.4 },
    { kind: "line", x1: 0, y1: H(0.995), x2: W(), y2: H(0.995), strokeWidth: 1.4 },
    // Flanges: placa grossa + placa fina em cada extremidade, transbordando a secao (como no P&ID).
    { kind: "line", x1: 3, y1: H(0, -4), x2: 3, y2: H(1, 4), strokeWidth: 3.2, stateVisible: whenProp("showFlanges", true) },
    { kind: "line", x1: 8, y1: H(0, -1), x2: 8, y2: H(1, 1), strokeWidth: 1.6, stateVisible: whenProp("showFlanges", true) },
    { kind: "line", x1: W(1, -8), y1: H(0, -1), x2: W(1, -8), y2: H(1, 1), strokeWidth: 1.6, stateVisible: whenProp("showFlanges", true) },
    { kind: "line", x1: W(1, -3), y1: H(0, -4), x2: W(1, -3), y2: H(1, 4), strokeWidth: 3.2, stateVisible: whenProp("showFlanges", true) },
    // Seta de fluxo: cheurao por expressao, visivel so com fluxo ligado (`__g_on`).
    { kind: "line", x1: W(0.5, -8), y1: H(0.5, -6), x2: W(0.5, 2), y2: H(0.5), strokeWidth: 2.4,
      stroke: C.accent, stateVisible: { when: { showFlow: ["true"], flowDirection: ["forward"], __g_on: ["true"] } } },
    { kind: "line", x1: W(0.5, -8), y1: H(0.5, 6), x2: W(0.5, 2), y2: H(0.5), strokeWidth: 2.4,
      stroke: C.accent, stateVisible: { when: { showFlow: ["true"], flowDirection: ["forward"], __g_on: ["true"] } } },
    { kind: "line", x1: W(0.5, 8), y1: H(0.5, -6), x2: W(0.5, -2), y2: H(0.5), strokeWidth: 2.4,
      stroke: C.accent, stateVisible: { when: { showFlow: ["true"], flowDirection: ["reverse"], __g_on: ["true"] } } },
    { kind: "line", x1: W(0.5, 8), y1: H(0.5, 6), x2: W(0.5, -2), y2: H(0.5), strokeWidth: 2.4,
      stroke: C.accent, stateVisible: { when: { showFlow: ["true"], flowDirection: ["reverse"], __g_on: ["true"] } } },
  ],
});

symbol({
  id: "pipe_elbow", label: "Cotovelo 90°", labelEn: "Pipe Elbow 90°", folder: ["Tubulacao", "Pipes"],
  help: "Curva de 90° da tubulação; a rotação do componente escolhe o quadrante.",
  provenance: drawioRef("piping.xml", ["Flexible Hose", "Expansion Joint"]),
  w: 40, h: 40, elastic: false,
  props: [...geometry(40, 40), ...appearance({ fill: C.metal })],
  paint: () => [
    { kind: "path", d: "M 0 20 L 18 20 Q 30 20 30 32 L 30 40", fill: "none", stroke: { prop: "stroke" }, strokeWidth: 5, strokeLinecap: "round", strokeLinejoin: "round" },
    { kind: "path", d: "M 0 20 L 18 20 Q 30 20 30 32 L 30 40", fill: "none", stroke: { prop: "fill" }, strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" },
  ],
});

symbol({
  id: "pipe_tee", label: "Tê de tubulação", labelEn: "Pipe Tee", folder: ["Tubulacao", "Pipes"],
  help: "Derivação em T; a rotação escolhe para que lado sai o ramal.",
  provenance: drawioRef("piping.xml", ["In-Line Mixer", "Y-Type Strainer"]),
  w: 40, h: 40, elastic: false,
  props: [...geometry(40, 40), ...appearance({ fill: C.metal })],
  paint: () => [
    { kind: "line", x1: 0, y1: 20, x2: 40, y2: 20, stroke: { prop: "stroke" }, strokeWidth: 4 },
    { kind: "line", x1: 20, y1: 20, x2: 20, y2: 40, stroke: { prop: "stroke" }, strokeWidth: 4 },
  ],
});

symbol({
  id: "pipe_cross", label: "Cruzamento de tubulação", labelEn: "Pipe Crossing", folder: ["Tubulacao", "Pipes"],
  help: "Cruzamento sem conexão: o tubo horizontal salta por cima do vertical.",
  provenance: drawioRef("piping.xml", ["Coupling", "Flange"]),
  w: 40, h: 40, elastic: false,
  props: [...geometry(40, 40), ...appearance({ fill: C.metal })],
  paint: () => [
    { kind: "line", x1: 0, y1: 20, x2: 40, y2: 20, stroke: { prop: "stroke" }, strokeWidth: 4 },
    { kind: "path", d: "M 20 0 L 20 13 C 30 13 30 27 20 27 L 20 40", fill: "none", stroke: { prop: "stroke" }, strokeWidth: 4, strokeLinecap: "round", strokeLinejoin: "round" },
  ],
});

symbol({
  id: "pipe_flange", label: "Flange", labelEn: "Flange", folder: ["Tubulacao", "Pipes"],
  help: "Par de flanges/junta de tubulação.",
  provenance: drawioRef("piping.xml", ["Double Flange", "Flange"]),
  w: 18, h: 32, elastic: false,
  props: [...geometry(18, 32), ...appearance({ fill: C.metal })],
  paint: () => [
    { kind: "rect", x: 5, y: 8, w: 8, h: 16, fill: { prop: "fill" }, stroke: "none" },
    { kind: "line", x1: 4, y1: 2, x2: 4, y2: 30, strokeWidth: 3 },
    { kind: "line", x1: 14, y1: 2, x2: 14, y2: 30, strokeWidth: 3 },
  ],
});

// ---- Tanques e vasos ------------------------------------------------------





symbol({
  id: "hopper", label: "Silo / caixa de polpa", labelEn: "Hopper", folder: ["Tanques e Vasos", "Tanks & Vessels"],
  help: "Silo/caixa com fundo cônico e nível dinâmico (ex.: caixa de polpa).",
  provenance: drawioRef("vessels.xml", ["Bunker (Conical Bottom)", "Open Bulk Storage"]),
  w: 120, h: 130, dw: 100, dh: 100, elastic: false,
  props: [
    ...geometry(120, 130),
    ...appearance({ fill: C.panel }),
    { id: "liquidColor", label: "Cor do material", group: "Componente", unit: "", editor: "color", default: "#b45309" },
    ...showValueProps(true),
    ...analogBinding("Nível (%)"),
  ],
  paint: () => [
    { kind: "polygon", points: [{ x: 6, y: 6 }, { x: 94, y: 6 }, { x: 94, y: 58 }, { x: 62, y: 96 }, { x: 38, y: 96 }, { x: 6, y: 58 }], fill: { prop: "fill" } },
    { kind: "rect", x: 8, y: PCT(-0.52, 58), w: 84, h: PCT(0.52, 0), fill: { prop: "liquidColor" }, stroke: "none" },
    { kind: "polygon", points: [{ x: 6, y: 6 }, { x: 94, y: 6 }, { x: 94, y: 58 }, { x: 62, y: 96 }, { x: 38, y: 96 }, { x: 6, y: 58 }], fill: "none" },
    boundText({ x: 50, y: 40, fontSize: 11, textAnchor: "middle", fill: C.ink, stateVisible: whenProp("showValue", true) }),
  ],
});

symbol({
  id: "heat_exchanger", label: "Trocador de calor", labelEn: "Heat Exchanger", folder: ["Tanques e Vasos", "Tanks & Vessels"],
  help: "Trocador casco-e-serpentina, com bocais de entrada e saída.",
  provenance: drawioRef("heat_exchangers.xml", ["Shell and Tube Heat Exchanger 1", "Double Pipe Heat Exchanger", "Heat Exchanger (Coil Tubes)"]),
  w: 150, h: 100, dw: 100, dh: 100, elastic: false,
  props: [...geometry(150, 100), ...appearance({ fill: C.panel })],
  paint: () => [
    // Casco horizontal com dois tampos e feixe de tubos, convenção dos trocadores P&ID.
    { kind: "roundedRect", x: 18, y: 24, w: 64, h: 52, rx: 22, ry: 22, fill: { prop: "fill" } },
    { kind: "ellipse", cx: 18, cy: 50, rx: 12, ry: 26, fill: { prop: "fill" } },
    { kind: "ellipse", cx: 82, cy: 50, rx: 12, ry: 26, fill: { prop: "fill" } },
    { kind: "path", d: "M 28 34 C 42 24 58 44 72 34 M 28 50 C 42 40 58 60 72 50 M 28 66 C 42 56 58 76 72 66", fill: "none", stroke: "#dc2626", strokeWidth: 2 },
    { kind: "line", x1: 0, y1: 24, x2: 18, y2: 24, strokeWidth: 3 },
    { kind: "line", x1: 0, y1: 76, x2: 18, y2: 76, strokeWidth: 3 },
    { kind: "line", x1: 82, y1: 24, x2: 100, y2: 24, strokeWidth: 3 },
    { kind: "line", x1: 82, y1: 76, x2: 100, y2: 76, strokeWidth: 3 },
  ],
});

// ---- Válvulas -------------------------------------------------------------



symbol({
  id: "check_valve", label: "Válvula de retenção", labelEn: "Check Valve", folder: ["Valvulas", "Valves"],
  help: "Válvula de retenção (sentido único).",
  provenance: drawioRef("valves.xml", ["Check Valve 1", "Check Valve 2"]),
  w: 76, h: 76, dw: 76, dh: 80, elastic: false,
  props: [...geometry(76, 76), ...appearance({ fill: C.body }), { id: "tag", label: "Tag", group: "Componente", unit: "", editor: "text", default: "" }],
  paint: () => [
    { kind: "line", x1: 0, y1: 32, x2: 8, y2: 32, strokeWidth: 3 },
    { kind: "polygon", points: [{ x: 8, y: 12 }, { x: 8, y: 52 }, { x: 60, y: 32 }], fill: { prop: "fill" } },
    { kind: "line", x1: 68, y1: 8, x2: 68, y2: 56, strokeWidth: 2.5 },
    { kind: "line", x1: 68, y1: 32, x2: 76, y2: 32, strokeWidth: 3 },
    { kind: "text", x: 38, y: 72, value: "", fontSize: 10, textAnchor: "middle", stateText: { kind: "property", prop: "tag" }, fill: C.accent },
  ],
});

// ---- Bombas e motores -----------------------------------------------------



// ---- Dispositivos HMI detalhados ------------------------------------------

symbol({
  id: "flow_transmitter", label: "Transmissor de vazão industrial", labelEn: "Industrial Flow Transmitter", folder: ["Supervisório Industrial", "Industrial HMI"],
  help: "Conjunto transmissor FT com corpo, cápsula sensora, eletrônica, tomada de impulso e leitura dinâmica.",
  provenance: drawioRef("instruments.xml", ["Flow Transmitter", "Flow Transmitter 2", "Flow Recorder"]),
  w: 120, h: 150, elastic: false,
  props: [
    ...geometry(120, 150), ...appearance({ fill: "#d7dce2" }),
    { id: "tag", label: "Tag", group: "Componente", unit: "", editor: "text", default: "FT-101" },
    ...showValueProps(true), ...analogBinding("Vazão", "L/min", { decimals: 1, max: 200 }),
  ],
  paint: () => [
    { kind: "roundedRect", x: 14, y: 18, w: 76, h: 60, rx: 8, ry: 8, fill: "#aeb7c2", stroke: "#475569", strokeWidth: 2 },
    { kind: "rect", x: 20, y: 23, w: 64, h: 50, fill: { prop: "fill" }, stroke: "#64748b", strokeWidth: 1.2 },
    { kind: "ellipse", cx: 31, cy: 48, rx: 8, ry: 21, fill: "#374151", stroke: "#111827", strokeWidth: 1.5 },
    { kind: "ellipse", cx: 31, cy: 48, rx: 3.5, ry: 17, fill: "#e5e7eb", stroke: "none" },
    { kind: "line", x1: 42, y1: 26, x2: 42, y2: 70, stroke: "#64748b", strokeWidth: 2 },
    { kind: "roundedRect", x: 52, y: 35, w: 38, h: 26, rx: 4, ry: 4, fill: "#e5e7eb", stroke: "#475569", strokeWidth: 1.5 },
    { kind: "rect", x: 90, y: 41, w: 16, h: 14, fill: "#cbd5e1", stroke: "#475569", strokeWidth: 1.3 },
    { kind: "roundedRect", x: 25, y: 78, w: 58, h: 24, rx: 4, ry: 4, fill: "#9ca3af", stroke: "#374151", strokeWidth: 1.5 },
    // Bloco manifold (as tres valvulas de bloqueio/equalizacao) e a tomada saindo DELE ate o
    // processo -- e assim que um transmissor de vazao aparece no sinotico de referencia.
    { kind: "line", x1: 83, y1: 90, x2: 96, y2: 90, stroke: "#475569", strokeWidth: 3 },
    { kind: "roundedRect", x: 90, y: 80, w: 15, h: 20, rx: 2, ry: 2, fill: "#cbd5e1", stroke: "#374151", strokeWidth: 1.3 },
    { kind: "roundedRect", x: 104, y: 84, w: 11, h: 14, rx: 2, ry: 2, fill: "#e5e7eb", stroke: "#475569", strokeWidth: 1.2 },
    { kind: "line", x1: 97, y1: 100, x2: 97, y2: 127, stroke: "#475569", strokeWidth: 3 },
    { kind: "line", x1: 90, y1: 112, x2: 104, y2: 112, stroke: "#475569", strokeWidth: 2 },
    { kind: "text", x: 60, y: 139, value: "", fontSize: 13, fontWeight: "bold", textAnchor: "middle", fill: "#0f172a", stateText: { kind: "property", prop: "tag" } },
    boundText({ x: 112, y: 94, fontSize: 11, textAnchor: "end", fill: "#1d4ed8", stateVisible: whenProp("showValue", true) }),
  ],
});

symbol({
  id: "controller_station", label: "Estação controladora", labelEn: "Controller Station", folder: ["Supervisório Industrial", "Industrial HMI"],
  help: "Faceplate industrial vertical com três barras de processo e identificação do controlador.",
  provenance: drawioRef("instruments.xml", ["Flow Indicating Controller", "Flow Controller", "Flow Recorder"]),
  w: 92, h: 138, elastic: false,
  props: [
    ...geometry(92, 138), ...appearance({ fill: "#d7dce2" }),
    { id: "tag", label: "Tag", group: "Componente", unit: "", editor: "text", default: "FIC-101" },
    { id: "setpoint", label: "Setpoint", group: "Componente", unit: "%", editor: "number", default: 60, min: 0, max: 100, step: 1 },
    ...showValueProps(true), ...analogBinding("Saída", "%"),
  ],
  paint: () => [
    { kind: "roundedRect", x: 9, y: 4, w: 74, h: 108, rx: 5, ry: 5, fill: "#94a3b8", stroke: "#475569", strokeWidth: 2 },
    { kind: "rect", x: 15, y: 12, w: 62, h: 92, fill: { prop: "fill" }, stroke: "#e2e8f0", strokeWidth: 1 },
    { kind: "rect", x: 24, y: 27, w: 10, h: 62, fill: "#ef4444", stroke: "#1f2937", strokeWidth: 1.2 },
    { kind: "rect", x: 41, y: 19, w: 10, h: 70, fill: "#22c55e", stroke: "#1f2937", strokeWidth: 1.2 },
    { kind: "rect", x: 58, y: 33, w: 10, h: 56, fill: "#2563eb", stroke: "#1f2937", strokeWidth: 1.2 },
    { kind: "line", x1: 19, y1: 96, x2: 73, y2: 96, stroke: "#64748b", strokeWidth: 1 },
    { kind: "text", x: 46, y: 130, value: "", fontSize: 14, fontWeight: "bold", textAnchor: "middle", fill: "#0f172a", stateText: { kind: "property", prop: "tag" } },
    boundText({ x: 72, y: 101, fontSize: 9, textAnchor: "end", fill: "#0f172a", stateVisible: whenProp("showValue", true) }),
  ],
});



// ---- Instrumentos ---------------------------------------------------------

symbol({
  id: "instrument", label: "Instrumento (balão ISA)", labelEn: "Instrument (ISA bubble)", folder: ["Instrumentos", "Instruments"],
  help: "Balão de instrumento no padrão ISA: tag em duas linhas, invólucro e localização configuráveis, valor ao vivo opcional.",
  provenance: drawioRef("instruments.xml", ["Flow Indicator", "Level Indicator", "Pressure Indicator", "Temperature Indicator", "Flow Transmitter"]),
  w: 70, h: 70, dw: 100, dh: 100, elastic: false,
  props: [
    ...geometry(70, 70),
    ...appearance({ fill: C.panel }),
    { id: "tag", label: "Tag (1ª linha)", group: "Componente", unit: "", editor: "text", default: "LT" },
    { id: "tagNumber", label: "Tag (2ª linha)", group: "Componente", unit: "", editor: "text", default: "101" },
    { id: "housing", label: "Invólucro", group: "Componente", unit: "", editor: "select", default: "circle",
      options: [{ value: "circle", label: "Círculo" }, { value: "square", label: "Quadrado" }, { value: "hexagon", label: "Hexágono" }, { value: "diamond", label: "Losango" }] },
    { id: "location", label: "Localização", group: "Componente", unit: "", editor: "select", default: "field",
      options: [{ value: "field", label: "Campo (sem linha)" }, { value: "panel", label: "Painel (linha cheia)" }, { value: "behind", label: "Atrás do painel (tracejada)" }] },
    ...showValueProps(false),
    ...analogBinding("Valor", ""),
  ],
  paint: () => [
    { kind: "ellipse", cx: 50, cy: 42, rx: 34, ry: 34, fill: { prop: "fill" }, stateVisible: whenProp("housing", "circle") },
    { kind: "rect", x: 16, y: 8, w: 68, h: 68, fill: { prop: "fill" }, stateVisible: whenProp("housing", "square") },
    { kind: "polygon", points: [{ x: 26, y: 12 }, { x: 74, y: 12 }, { x: 88, y: 42 }, { x: 74, y: 72 }, { x: 26, y: 72 }, { x: 12, y: 42 }], fill: { prop: "fill" }, stateVisible: whenProp("housing", "hexagon") },
    { kind: "polygon", points: [{ x: 50, y: 6 }, { x: 88, y: 42 }, { x: 50, y: 78 }, { x: 12, y: 42 }], fill: { prop: "fill" }, stateVisible: whenProp("housing", "diamond") },
    { kind: "line", x1: 16, y1: 42, x2: 84, y2: 42, stateVisible: whenProp("location", "panel") },
    { kind: "line", x1: 16, y1: 42, x2: 84, y2: 42, strokeDasharray: "5,4", stateVisible: whenProp("location", "behind") },
    { kind: "text", x: 50, y: 36, value: "", fontSize: 16, textAnchor: "middle", fill: C.ink, stateText: { kind: "property", prop: "tag" } },
    { kind: "text", x: 50, y: 58, value: "", fontSize: 14, textAnchor: "middle", fill: C.ink, stateText: { kind: "property", prop: "tagNumber" } },
    boundText({ x: 50, y: 94, fontSize: 12, textAnchor: "middle", fill: C.accent, stateVisible: whenProp("showValue", true) }),
  ],
});

symbol({
  id: "controller_faceplate", label: "Faceplate de controlador", labelEn: "Controller Faceplate", folder: ["Instrumentos", "Instruments"],
  help: "Faceplate de controlador com barra de PV e marcador de SP.",
  provenance: drawioRef("instruments.xml", ["Level Controller 1", "Pressure Indicating Controller"]),
  w: 66, h: 106, dw: 100, dh: 162, elastic: false,
  props: [
    ...geometry(66, 106),
    ...appearance({ fill: C.panel }),
    { id: "tag", label: "Tag", group: "Componente", unit: "", editor: "text", default: "FIC-101" },
    { id: "setpoint", label: "Setpoint (%)", group: "Componente", unit: "%", editor: "number", default: 50, min: 0, max: 100, step: 1 },
    { id: "barColor", label: "Cor da barra", group: "Componente", unit: "", editor: "color", default: C.accent },
    ...showValueProps(true),
    ...analogBinding("PV (%)"),
  ],
  paint: () => [
    { kind: "roundedRect", x: 4, y: 4, w: 92, h: 152, rx: 6, ry: 6, fill: { prop: "fill" } },
    { kind: "rect", x: 20, y: 24, w: 26, h: 100, fill: "#ffffff" },
    { kind: "rect", x: 21, y: PCT(-0.98, 123), w: 24, h: PCT(0.98, 0), fill: { prop: "barColor" }, stroke: "none" },
    { kind: "rect", x: 20, y: 24, w: 26, h: 100, fill: "none" },
    { kind: "line", x1: 50, y1: P("setpoint", -0.98, 123, { fallback: 50 }), x2: 68, y2: P("setpoint", -0.98, 123, { fallback: 50 }), stroke: "#dc2626", strokeWidth: 2.5 },
    { kind: "text", x: 50, y: 18, value: "", fontSize: 12, textAnchor: "middle", fill: C.ink, stateText: { kind: "property", prop: "tag" } },
    boundText({ x: 50, y: 144, fontSize: 13, textAnchor: "middle", fill: C.ink, stateVisible: whenProp("showValue", true) }),
  ],
});

symbol({
  id: "summing_junction", label: "Junção somadora", labelEn: "Summing Junction", folder: ["Instrumentos", "Instruments"],
  help: "Círculo somador (⊕) usado nos diagramas de malha.",
  provenance: drawioRef("instruments.xml", ["Analyzer Transmitter", "Flow Element"]),
  w: 34, h: 34, dw: 40, dh: 40, elastic: false,
  props: [...geometry(34, 34), ...appearance({ fill: C.panel })],
  paint: () => [
    { kind: "ellipse", cx: 20, cy: 20, rx: 17, ry: 17, fill: { prop: "fill" } },
    { kind: "line", x1: 11, y1: 20, x2: 29, y2: 20, strokeWidth: 2 },
    { kind: "line", x1: 20, y1: 11, x2: 20, y2: 29, strokeWidth: 2 },
  ],
});

// ---- Indicadores ----------------------------------------------------------

symbol({
  id: "value_display", label: "Display numérico", labelEn: "Numeric Display", folder: ["Indicadores", "Indicators"],
  help: "Caixa de leitura com rótulo e valor ao vivo -- equivalente nativo do “texto animado” do TDPS.",
  provenance: drawioRef("instruments.xml", ["Flow Recorder", "Pressure Recorder", "Temperature Recorder"]),
  w: 110, h: 46, elastic: false,
  props: [
    ...geometry(110, 46),
    ...appearance({ fill: C.panel }),
    { id: "label", label: "Rótulo", group: "Componente", unit: "", editor: "text", default: "PV" },
    { id: "valueColor", label: "Cor do valor", group: "Componente", unit: "", editor: "color", default: C.ink },
    ...analogBinding("Valor", "", { decimals: 2 }),
  ],
  paint: () => [
    { kind: "roundedRect", x: 2, y: 2, w: 106, h: 42, rx: 5, ry: 5, fill: { prop: "fill" } },
    { kind: "text", x: 8, y: 16, value: "", fontSize: 10, textAnchor: "start", fill: C.accent, stateText: { kind: "property", prop: "label" } },
    boundText({ x: 102, y: 36, fontSize: 18, textAnchor: "end", fill: { prop: "valueColor" } }),
  ],
});

symbol({
  id: "level_bar", label: "Barra de nível", labelEn: "Level Bar", folder: ["Indicadores", "Indicators"],
  help: "Barra vertical 0..100 % com limites superior e inferior.",
  provenance: drawioRef("instruments.xml", ["Level Gauge", "Level Indicator"]),
  w: 36, h: 130, dw: 36, dh: 132, elastic: false,
  props: [
    ...geometry(36, 130),
    ...appearance({ fill: "#ffffff" }),
    { id: "barColor", label: "Cor da barra", group: "Componente", unit: "", editor: "color", default: C.liquid },
    { id: "highLimit", label: "Limite superior (%)", group: "Componente", unit: "%", editor: "number", default: 90, min: 0, max: 100, step: 1 },
    { id: "lowLimit", label: "Limite inferior (%)", group: "Componente", unit: "%", editor: "number", default: 10, min: 0, max: 100, step: 1 },
    { id: "showLimits", label: "Mostrar limites", group: "Componente", unit: "", editor: "checkbox", default: true },
    ...showValueProps(true),
    ...analogBinding("Valor (%)"),
  ],
  paint: () => [
    { kind: "rect", x: 4, y: 4, w: 28, h: 108, fill: { prop: "fill" } },
    { kind: "rect", x: 5, y: PCT(-1.06, 111), w: 26, h: PCT(1.06, 0), fill: { prop: "barColor" }, stroke: "none" },
    { kind: "rect", x: 4, y: 4, w: 28, h: 108, fill: "none" },
    { kind: "line", x1: 2, y1: P("highLimit", -1.06, 111, { fallback: 90 }), x2: 34, y2: P("highLimit", -1.06, 111, { fallback: 90 }), stroke: "#dc2626", strokeDasharray: "4,3", stateVisible: whenProp("showLimits", true) },
    { kind: "line", x1: 2, y1: P("lowLimit", -1.06, 111, { fallback: 10 }), x2: 34, y2: P("lowLimit", -1.06, 111, { fallback: 10 }), stroke: "#dc2626", strokeDasharray: "4,3", stateVisible: whenProp("showLimits", true) },
    boundText({ x: 18, y: 126, fontSize: 10, textAnchor: "middle", fill: C.ink, stateVisible: whenProp("showValue", true) }),
  ],
});

symbol({
  id: "gauge_bar", label: "Barra horizontal", labelEn: "Horizontal Gauge", folder: ["Indicadores", "Indicators"],
  help: "Indicador de barra horizontal 0..100 %.",
  provenance: drawioRef("flow_sensors.xml", ["Rotameter", "Venturi"]),
  w: 130, h: 30, elastic: false,
  props: [
    ...geometry(130, 30),
    ...appearance({ fill: "#ffffff" }),
    { id: "barColor", label: "Cor da barra", group: "Componente", unit: "", editor: "color", default: C.accent },
    ...showValueProps(true),
    ...analogBinding("Valor (%)"),
  ],
  paint: () => [
    { kind: "rect", x: 2, y: 6, w: 126, h: 18, fill: { prop: "fill" } },
    { kind: "rect", x: 3, y: 7, w: PCT(1.24, 0), h: 16, fill: { prop: "barColor" }, stroke: "none" },
    { kind: "rect", x: 2, y: 6, w: 126, h: 18, fill: "none" },
    boundText({ x: 65, y: 20, fontSize: 11, textAnchor: "middle", fill: C.ink, stateVisible: whenProp("showValue", true) }),
  ],
});

symbol({
  id: "status_lamp", label: "Lâmpada de status", labelEn: "Status Lamp", folder: ["Indicadores", "Indicators"],
  help: "Indicador booleano ligado/desligado com rótulo.",
  provenance: drawioRef("misc.xml", ["Firing System, Burner", "Flame Arrestor"]),
  w: 34, h: 42, dw: 34, dh: 52, elastic: false,
  props: [
    ...geometry(34, 42),
    ...appearance({ fill: C.stopped }),
    { id: "onColor", label: "Cor ligado", group: "Componente", unit: "", editor: "color", default: C.running },
    { id: "offColor", label: "Cor desligado", group: "Componente", unit: "", editor: "color", default: C.stopped },
    { id: "label", label: "Rótulo", group: "Componente", unit: "", editor: "text", default: "" },
    ...stateBinding("Estado (0/100)", { value: 0 }),
  ],
  paint: () => [
    // `stateFill.map` só mapeia CONSTANTES; como as duas cores são escolhidas pelo usuário, o
    // estado escolhe qual das DUAS primitivas aparece, cada uma com a sua cor property-driven.
    { kind: "ellipse", cx: 17, cy: 17, rx: 14, ry: 14, fill: { prop: "onColor" }, stateVisible: whenProp("__g_on", true) },
    { kind: "ellipse", cx: 17, cy: 17, rx: 14, ry: 14, fill: { prop: "offColor" }, stateVisible: whenProp("__g_on", false) },
    // Volume da lente: sombra embaixo e reflexo em cima. Sao overlays de preto/branco, nunca cores
    // fixas -- assim funcionam com qualquer par de cores escolhido pelo usuario.
    { kind: "ellipse", cx: 17, cy: 21, rx: 12, ry: 9, fill: "#000000", stroke: "none", opacity: 0.16 },
    { kind: "ellipse", cx: 13, cy: 12, rx: 6, ry: 4, fill: "#ffffff", stroke: "none", opacity: 0.62 },
    { kind: "text", x: 17, y: 46, value: "", fontSize: 10, textAnchor: "middle", fill: C.accent, stateText: { kind: "property", prop: "label" } },
  ],
});

// ---- Controles de operador HMI --------------------------------------------

symbol({
  id: "hmi_button", label: "Botão de comando", labelEn: "Command Button", folder: ["Controles HMI", "HMI Controls"],
  help: "Botão de operador. Em RUN escreve no alvo configurado; em EDIT continua selecionável e redimensionável.",
  provenance: ipdPortRef(["src/hmi/widgets/button.tsx"], "direct adaptation of the IPD PushButton panel/text composition"),
  w: 112, h: 42, elastic: false,
  props: [
    ...geometry(112, 42), ...appearance({ fill: "#e2e8f0" }),
    { id: "text", label: "Texto", group: "Componente", unit: "", editor: "text", default: "COMANDO" },
    ...action("momentary", "true", "false"),
  ],
  paint: () => [
    { kind: "roundedRect", x: 3, y: 3, w: 106, h: 36, rx: 5, ry: 5, fill: { prop: "fill" }, strokeWidth: 2 },
    { kind: "line", x1: 9, y1: 9, x2: 103, y2: 9, stroke: "#ffffff", strokeWidth: 1.5 },
    { kind: "text", x: 56, y: 26, value: "", fontSize: 12, textAnchor: "middle", fill: C.ink, stateText: { kind: "property", prop: "text" } },
  ],
});

symbol({
  id: "hmi_lamp_button", label: "Botão luminoso", labelEn: "Illuminated Pushbutton", folder: ["Controles HMI", "HMI Controls"],
  help: "Botão quadrado iluminado, próprio para painéis de comando TDPS. O binding mostra o retorno e a Ação envia o comando.",
  provenance: ipdPortRef(
    ["src/hmi/widgets/button.tsx", "src/hmi/widgets/lamp.tsx"],
    "direct composition of IPD push-button bezel and status-lamp state behavior",
  ),
  w: 44, h: 44, elastic: false,
  props: [
    ...geometry(44, 44), ...appearance({ fill: "#cbd5e1" }),
    { id: "onColor", label: "Cor ligado", group: "Componente", unit: "", editor: "color", default: "#86efac" },
    { id: "offColor", label: "Cor desligado", group: "Componente", unit: "", editor: "color", default: "#94a3b8" },
    ...stateBinding("Estado", { value: 0, threshold: 50 }),
    ...action("toggle", "true", "false"),
  ],
  paint: () => [
    { kind: "roundedRect", x: 1, y: 1, w: 42, h: 42, rx: 3, ry: 3, fill: { prop: "fill" }, stroke: "#64748b", strokeWidth: 1.3 },
    { kind: "rect", x: 5, y: 5, w: 34, h: 34, fill: "#e2e8f0", stroke: "#94a3b8", strokeWidth: 1 },
    { kind: "ellipse", cx: 22, cy: 22, rx: 13, ry: 13, fill: { prop: "onColor" }, stroke: "#64748b", strokeWidth: 1.2, stateVisible: whenProp("__g_on", true) },
    { kind: "ellipse", cx: 22, cy: 22, rx: 13, ry: 13, fill: { prop: "offColor" }, stroke: "#64748b", strokeWidth: 1.2, stateVisible: whenProp("__g_on", false) },
    { kind: "ellipse", cx: 18, cy: 17, rx: 5, ry: 4, fill: "#ffffff", stroke: "none", opacity: 0.42 },
  ],
});

symbol({
  id: "hmi_toggle", label: "Alternador HMI", labelEn: "HMI Toggle", folder: ["Controles HMI", "HMI Controls"],
  help: "Alterna dois valores no alvo configurado e pode usar o mesmo alvo como Binding para refletir o estado real.",
  provenance: ipdPortRef(["src/hmi/widgets/switchw.tsx"], "direct adaptation of IPD ToggleSwitch track, state fill, knob position and labels"),
  w: 78, h: 38, elastic: false,
  props: [
    ...geometry(78, 38), ...appearance({ fill: C.stopped }),
    { id: "onText", label: "Texto ligado", group: "Componente", unit: "", editor: "text", default: "ON" },
    { id: "offText", label: "Texto desligado", group: "Componente", unit: "", editor: "text", default: "OFF" },
    ...stateBinding("Estado", { value: 0 }),
    ...action("toggle", "true", "false"),
  ],
  paint: () => [
    { kind: "roundedRect", x: 2, y: 5, w: 74, h: 28, rx: 14, ry: 14, fill: C.stopped, stateFill: onOff(C.running, C.stopped) },
    { kind: "ellipse", cx: 61, cy: 19, rx: 11, ry: 11, fill: "#ffffff", stateVisible: whenProp("__g_on", true) },
    { kind: "ellipse", cx: 17, cy: 19, rx: 11, ry: 11, fill: "#ffffff", stateVisible: whenProp("__g_on", false) },
    { kind: "text", x: 25, y: 23, value: "", fontSize: 9, textAnchor: "middle", fill: "#ffffff", stateText: { kind: "property", prop: "onText" }, stateVisible: whenProp("__g_on", true) },
    { kind: "text", x: 53, y: 23, value: "", fontSize: 9, textAnchor: "middle", fill: C.ink, stateText: { kind: "property", prop: "offText" }, stateVisible: whenProp("__g_on", false) },
  ],
});

symbol({
  id: "hmi_switch", label: "Chave HMI", labelEn: "HMI Switch", folder: ["Controles HMI", "HMI Controls"],
  help: "Chave de duas posições para comandos mantidos no supervisório.",
  w: 58, h: 64, elastic: false,
  props: [...geometry(58, 64), ...appearance({ fill: C.body }), ...stateBinding("Estado", { value: 0 }), ...action("toggle", "true", "false")],
  paint: () => [
    { kind: "roundedRect", x: 8, y: 3, w: 42, h: 58, rx: 5, ry: 5, fill: { prop: "fill" } },
    { kind: "ellipse", cx: 29, cy: 49, rx: 7, ry: 7, fill: C.stopped },
    { kind: "line", x1: 29, y1: 49, x2: 29, y2: 17, stroke: C.running, strokeWidth: 5, strokeLinecap: "round", stateVisible: whenProp("__g_on", true) },
    { kind: "line", x1: 29, y1: 49, x2: 17, y2: 27, stroke: C.stopped, strokeWidth: 5, strokeLinecap: "round", stateVisible: whenProp("__g_on", false) },
  ],
});

symbol({
  id: "numeric_input", label: "Entrada numérica", labelEn: "Numeric Input", folder: ["Controles HMI", "HMI Controls"],
  help: "Entrada numérica de operador. Em RUN, clique duplo abre a edição e grava no alvo configurado.",
  w: 126, h: 48, elastic: false,
  props: [
    ...geometry(126, 48), ...appearance({ fill: "#ffffff" }),
    { id: "label", label: "Rótulo", group: "Componente", unit: "", editor: "text", default: "Entrada" },
    ...analogBinding("Valor", "", { value: 0, decimals: 2 }),
    ...action("set", "0", "0"),
  ],
  paint: () => [
    { kind: "roundedRect", x: 1, y: 1, w: 124, h: 46, rx: 4, ry: 4, fill: { prop: "fill" }, strokeWidth: 1.8 },
    { kind: "text", x: 7, y: 16, value: "", fontSize: 9, textAnchor: "start", fill: C.accent, stateText: { kind: "property", prop: "label" } },
    boundText({ x: 118, y: 37, fontSize: 18, textAnchor: "end", fill: C.ink }),
  ],
});

symbol({
  id: "slider", label: "Slider HMI", labelEn: "HMI Slider", folder: ["Controles HMI", "HMI Controls"],
    help: "Slider industrial com cursor e escala. Arraste em RUN; o valor final é persistido no alvo e no controle.",
    w: 212, h: 34, elastic: false,
    props: [
      ...geometry(212, 34), ...appearance({ fill: "#ffffff" }),
      { id: "showTicks", label: "Mostrar marcações", group: "Componente", unit: "", editor: "checkbox", default: true },
    ...analogBinding("Valor", "", { value: 50, decimals: 1 }), ...action("set", "50", "0"),
  ],
  paint: () => [
    // Trackbar de painel: calha fina e rebaixada + cursor RETANGULAR, como o controle do
    // supervisório de referência (não a barra de progresso arredondada de antes).
      { kind: "rect", x: 4, y: 3, w: 204, h: 17, fill: { prop: "fill" }, stroke: "#64748b", strokeWidth: 1.3 },
      { kind: "rect", x: 6, y: 5, w: PCT(1.98), h: 13, fill: "#cbd5e1", stroke: "none" },
    // Regua de marcacoes do trackbar -- `repeat` desloca o template, sem repetir 11 primitivas.
      { kind: "repeat", count: 11, indexName: "i", stepX: 19.8, stateVisible: whenProp("showTicks", true),
        primitives: [{ kind: "line", x1: 7, y1: 26, x2: 7, y2: 31, stroke: "#334155", strokeWidth: 1 }] },
      { kind: "rect", x: PCT(1.98, 5), y: 1, w: 4, h: 22, fill: "#f8fafc", stroke: "#475569", strokeWidth: 1.2 },
  ],
});

symbol({
  id: "setpoint", label: "Setpoint", labelEn: "Setpoint", folder: ["Controles HMI", "HMI Controls"],
  help: "Campo de setpoint com unidade. Em RUN, clique duplo permite informar o novo valor.",
  w: 154, h: 54, elastic: false,
  props: [
    ...geometry(154, 54), ...appearance({ fill: "#f8fafc" }),
    { id: "label", label: "Rótulo", group: "Componente", unit: "", editor: "text", default: "SP" },
    ...analogBinding("Setpoint", "", { value: 50, decimals: 2 }),
    ...action("set", "50", "0"),
  ],
  paint: () => [
    { kind: "rect", x: 1, y: 1, w: 152, h: 52, fill: { prop: "fill" }, strokeWidth: 1.8 },
    { kind: "text", x: 8, y: 20, value: "", fontSize: 12, textAnchor: "start", fill: C.accent, stateText: { kind: "property", prop: "label" } },
    { kind: "rect", x: 66, y: 9, w: 80, h: 34, fill: "#111827", stroke: "#64748b" },
    boundText({ x: 140, y: 34, fontSize: 18, textAnchor: "end", fill: "#ffffff" }),
  ],
});

symbol({
  id: "alarm_indicator", label: "Indicador de alarme", labelEn: "Alarm Indicator", folder: ["Indicadores", "Indicators"],
  help: "Indicador booleano de alarme com destaque vermelho e texto configurável.",
  w: 132, h: 42, elastic: false,
  props: [
    ...geometry(132, 42), ...appearance({ fill: C.panel }),
    { id: "text", label: "Texto", group: "Componente", unit: "", editor: "text", default: "ALARME" },
    ...stateBinding("Alarme", { value: 0, threshold: 0.5 }),
  ],
  paint: () => [
    { kind: "roundedRect", x: 1, y: 1, w: 130, h: 40, rx: 5, ry: 5, fill: C.fault, stateVisible: whenProp("__g_on", true) },
    { kind: "roundedRect", x: 1, y: 1, w: 130, h: 40, rx: 5, ry: 5, fill: C.bodyDark, stateVisible: whenProp("__g_on", false) },
    { kind: "polygon", points: [{ x: 15, y: 32 }, { x: 25, y: 9 }, { x: 35, y: 32 }], fill: "#ffffff" },
    { kind: "text", x: 82, y: 26, value: "", fontSize: 13, textAnchor: "middle", fill: "#ffffff", stateText: { kind: "property", prop: "text" } },
  ],
});

// ---- Elementos de fluxo ---------------------------------------------------

symbol({
  id: "flow_arrow", label: "Seta de fluxo", labelEn: "Flow Arrow", folder: ["Elementos de Fluxo", "Flow Elements"],
  help: "Seta de fluxo destacada; a rotação define o sentido.",
  provenance: drawioRef("piping.xml", ["Excess Flow Valve", "Vent"]),
  w: 56, h: 32, elastic: false,
  props: [...geometry(56, 32), ...appearance({ fill: C.accent, stroke: "none", strokeWidth: 0 })],
  paint: () => [
    { kind: "polygon", points: [{ x: 0, y: 10 }, { x: 34, y: 10 }, { x: 34, y: 2 }, { x: 56, y: 16 }, { x: 34, y: 30 }, { x: 34, y: 22 }, { x: 0, y: 22 }], fill: { prop: "fill" } },
  ],
});

symbol({
  id: "orifice_plate", label: "Placa de orifício", labelEn: "Orifice Plate", folder: ["Elementos de Fluxo", "Flow Elements"],
  help: "Elemento primário de vazão (placa de orifício) instalado na tubulação.",
  provenance: drawioRef("fittings.xml", ["Orifice Plate", "Orifice Plate2"]),
  w: 36, h: 40, elastic: false,
  props: [...geometry(36, 40), ...appearance({ fill: C.metal })],
  paint: () => [
    { kind: "rect", x: 0, y: 12, w: 36, h: 16, fill: { prop: "fill" }, stroke: "none" },
    { kind: "line", x1: 0, y1: 12, x2: 36, y2: 12 },
    { kind: "line", x1: 0, y1: 28, x2: 36, y2: 28 },
    { kind: "line", x1: 16, y1: 4, x2: 16, y2: 18, strokeWidth: 2.5 },
    { kind: "line", x1: 16, y1: 22, x2: 16, y2: 36, strokeWidth: 2.5 },
  ],
});

// ---- Equipamento de processo ---------------------------------------------

symbol({
  id: "equipment", label: "Equipamento genérico", labelEn: "Generic Equipment", folder: ["Equipamento de Processo", "Process Equipment"],
  help: "Caixa de equipamento com rótulo -- use para o que não tem símbolo dedicado (separador, reciclo, sprays…).",
  provenance: drawioRef("misc.xml", ["Air Separator", "Cyclone", "Cooler"]),
  w: 130, h: 64, elastic: true,
  props: [
    ...geometry(130, 64),
    ...appearance({ fill: C.panel }),
    { id: "label", label: "Rótulo", group: "Componente", unit: "", editor: "text", default: "Equipamento" },
    { id: "labelSize", label: "Tamanho do texto", group: "Componente", unit: "px", editor: "number", default: 12, min: 6, max: 48, step: 1 },
    { id: "showBorder", label: "Mostrar moldura", group: "Aparência", unit: "", editor: "checkbox", default: true },
  ],
  paint: () => [
    { kind: "roundedRect", x: 1, y: 1, w: W(1, -2), h: H(1, -2), rx: 5, ry: 5, fill: { prop: "fill" }, stroke: "none", stateVisible: whenProp("showBorder", false) },
    { kind: "roundedRect", x: 1, y: 1, w: W(1, -2), h: H(1, -2), rx: 5, ry: 5, fill: { prop: "fill" }, stateVisible: whenProp("showBorder", true) },
    { kind: "text", x: W(0.5), y: H(0.5, 4), value: "", fontSize: { prop: "labelSize", fallback: 12 }, textAnchor: "middle", fill: C.ink, stateText: { kind: "property", prop: "label" } },
  ],
});

symbol({
  id: "conveyor", label: "Correia transportadora", labelEn: "Belt Conveyor", folder: ["Equipamento de Processo", "Process Equipment"],
  help: "Correia transportadora com tambores; o estado ligado/desligado segue a simulação.",
  provenance: drawioRef("misc.xml", ["Conveyor (Belt)", "Roller Conveyor", "Bucket Elevator"]),
  w: 180, h: 44, elastic: false,
  props: [
    ...geometry(180, 44),
    ...appearance({ fill: C.metal }),
    ...stateBinding("Estado (0/100)", { value: 0 }),
  ],
  paint: () => [
    { kind: "ellipse", cx: 18, cy: 22, rx: 14, ry: 14, fill: { prop: "fill" }, stateFill: onOff(C.running, C.stopped) },
    { kind: "ellipse", cx: 162, cy: 22, rx: 14, ry: 14, fill: { prop: "fill" }, stateFill: onOff(C.running, C.stopped) },
    { kind: "line", x1: 18, y1: 8, x2: 162, y2: 8, strokeWidth: 2 },
    { kind: "line", x1: 18, y1: 36, x2: 162, y2: 36, strokeWidth: 2 },
    { kind: "repeat", count: 6, indexName: "i", stepX: 24, primitives: [{ kind: "ellipse", cx: 30, cy: 22, rx: 3, ry: 3, fill: C.outline }] },
  ],
});

// ---- Conexões -------------------------------------------------------------

symbol({
  id: "signal_line", label: "Linha de sinal", labelEn: "Signal Line", folder: ["Conexoes", "Connections"],
  help: "Linha tracejada de sinal de instrumentação (não é fio elétrico nem linha de processo).",
  provenance: drawioRef("instruments.xml", ["Flow Transmitter", "Pressure Transmitter 1"]),
  w: 120, h: 12, elastic: true,
  props: [
    ...geometry(120, 12),
    { id: "stroke", label: "Cor", group: "Aparência", unit: "", editor: "color", default: C.outline },
    { id: "strokeWidth", label: "Espessura", group: "Aparência", unit: "px", editor: "number", default: 1.2, min: 0.2, max: 10, step: 0.2 },
    { id: "opacity", label: "Opacidade", group: "Aparência", unit: "", editor: "number", default: 1, min: 0, max: 1, step: 0.05 },
    { id: "dash", label: "Traço", group: "Componente", unit: "", editor: "select", default: "dashed",
      options: [{ value: "dashed", label: "Tracejada (sinal)" }, { value: "solid", label: "Cheia" }, { value: "dotted", label: "Pontilhada (capilar)" }] },
    { id: "arrow", label: "Ponta de seta", group: "Componente", unit: "", editor: "select", default: "none",
      options: [{ value: "none", label: "Nenhuma" }, { value: "end", label: "No fim" }, { value: "start", label: "No início" }] },
  ],
  paint: () => [
    { kind: "line", x1: 0, y1: H(0.5), x2: W(), y2: H(0.5), strokeDasharray: "6,4", stateVisible: whenProp("dash", "dashed") },
    { kind: "line", x1: 0, y1: H(0.5), x2: W(), y2: H(0.5), stateVisible: whenProp("dash", "solid") },
    { kind: "line", x1: 0, y1: H(0.5), x2: W(), y2: H(0.5), strokeDasharray: "1.5,3", strokeLinecap: "round", stateVisible: whenProp("dash", "dotted") },
    // Ponta de seta no destino: num sinótico de instrumentação a seta é o que diz QUEM comanda
    // quem (transmissor -> controlador -> válvula). Desenhada por expressão, acompanha a rotação
    // da instância junto com o resto do símbolo.
    { kind: "line", x1: W(1, -9), y1: H(0.5, -5), x2: W(), y2: H(0.5), strokeLinecap: "round", stateVisible: whenProp("arrow", "end") },
    { kind: "line", x1: W(1, -9), y1: H(0.5, 5), x2: W(), y2: H(0.5), strokeLinecap: "round", stateVisible: whenProp("arrow", "end") },
    { kind: "line", x1: 9, y1: H(0.5, -5), x2: 0, y2: H(0.5), strokeLinecap: "round", stateVisible: whenProp("arrow", "start") },
    { kind: "line", x1: 9, y1: H(0.5, 5), x2: 0, y2: H(0.5), strokeLinecap: "round", stateVisible: whenProp("arrow", "start") },
  ],
});

symbol({
  id: "group_box", label: "Painel com título", labelEn: "Group Box", folder: ["Controles HMI", "HMI Controls"],
  help: "Moldura de painel com o título sobre a própria borda, como um group box de supervisório.",
  w: 220, h: 150, elastic: true,
  props: [
    ...geometry(220, 150),
    { id: "title", label: "Título", group: "Componente", unit: "", editor: "text", default: "Painel" },
    { id: "titleSize", label: "Tamanho do título", group: "Componente", unit: "px", editor: "number", default: 12, min: 6, max: 32, step: 1 },
    { id: "titleWidth", label: "Largura do recorte", group: "Componente", unit: "px", editor: "number", default: 96, min: 0, max: 600, step: 2 },
    { id: "stroke", label: "Contorno", group: "Aparência", unit: "", editor: "color", default: "#7f9db9" },
    { id: "fill", label: "Preenchimento", group: "Aparência", unit: "", editor: "color", default: "#dfe8f5" },
    { id: "maskFill", label: "Cor atrás do título", group: "Aparência", unit: "", editor: "color", default: "#eef1f4" },
    { id: "strokeWidth", label: "Espessura do contorno", group: "Aparência", unit: "px", editor: "number", default: 1.2, min: 0, max: 10, step: 0.2 },
    { id: "opacity", label: "Opacidade", group: "Aparência", unit: "", editor: "number", default: 1, min: 0, max: 1, step: 0.05 },
  ],
  // O título "sobre a borda" é feito interrompendo a borda com um retângulo da cor do FUNDO e
  // escrevendo por cima -- o IR não tem recorte/clip, e medir o texto para abrir a lacuna exata
  // não é possível aqui; por isso a largura do recorte é uma propriedade.
  paint: () => [
    { kind: "rect", x: 0.6, y: 7, w: W(1, -1.2), h: H(1, -7.6), fill: { prop: "fill" } },
    { kind: "rect", x: 11, y: 0, w: { prop: "titleWidth", fallback: 96 }, h: 15, fill: { prop: "maskFill" }, stroke: "none" },
    { kind: "text", x: 17, y: 12, value: "", fontSize: { prop: "titleSize", fallback: 12 }, textAnchor: "start",
      fill: "#1d4ed8", stateText: { kind: "property", prop: "title" } },
  ],
});

symbol({
  id: "signal_elbow", label: "Cotovelo de sinal", labelEn: "Signal Elbow", folder: ["Conexoes", "Connections"],
  help: "Canto arredondado de rota de sinal. `Quadrante` escolhe por onde a linha entra e sai.",
  w: 26, h: 26, elastic: false,
  props: [
    ...geometry(26, 26),
    { id: "stroke", label: "Cor", group: "Aparência", unit: "", editor: "color", default: C.outline },
    { id: "strokeWidth", label: "Espessura", group: "Aparência", unit: "px", editor: "number", default: 1.8, min: 0.2, max: 10, step: 0.2 },
    { id: "opacity", label: "Opacidade", group: "Aparência", unit: "", editor: "number", default: 1, min: 0, max: 1, step: 0.05 },
    { id: "corner", label: "Quadrante", group: "Componente", unit: "", editor: "select", default: "lb",
      options: [
        { value: "lb", label: "Entra pela esquerda, sai por baixo" },
        { value: "lt", label: "Entra pela esquerda, sai por cima" },
        { value: "rb", label: "Entra pela direita, sai por baixo" },
        { value: "rt", label: "Entra pela direita, sai por cima" },
      ] },
  ],
  // Quadrante por `stateVisible` em vez de rotação da instância: a rotação pivota no CENTRO da
  // caixa, então casar as pontas do arco com os segmentos vizinhos exigiria compensar o pivô em
  // cada chamada. Com quatro variantes o compositor só escolhe o canto e as pontas caem sempre nos
  // mesmos pontos (meio da borda), que é o que mantém a rota contínua.
  paint: () => [
    { kind: "path", d: "M 0 13 L 6 13 A 7 7 0 0 1 13 20 L 13 26", fill: "none", stateVisible: whenProp("corner", "lb") },
    { kind: "path", d: "M 0 13 L 6 13 A 7 7 0 0 0 13 6 L 13 0", fill: "none", stateVisible: whenProp("corner", "lt") },
    { kind: "path", d: "M 26 13 L 20 13 A 7 7 0 0 0 13 20 L 13 26", fill: "none", stateVisible: whenProp("corner", "rb") },
    { kind: "path", d: "M 26 13 L 20 13 A 7 7 0 0 1 13 6 L 13 0", fill: "none", stateVisible: whenProp("corner", "rt") },
  ],
});

symbol({
  id: "arrow", label: "Seta / conector", labelEn: "Arrow", folder: ["Conexoes", "Connections"],
  help: "Linha com ponta de seta, para indicar direção entre elementos da tela.",
  w: 110, h: 20, elastic: true,
  props: [
    ...geometry(110, 20),
    { id: "stroke", label: "Cor", group: "Aparência", unit: "", editor: "color", default: C.outline },
    { id: "strokeWidth", label: "Espessura", group: "Aparência", unit: "px", editor: "number", default: 1.6, min: 0.2, max: 10, step: 0.2 },
    { id: "opacity", label: "Opacidade", group: "Aparência", unit: "", editor: "number", default: 1, min: 0, max: 1, step: 0.05 },
  ],
  paint: () => [
    { kind: "line", x1: 0, y1: H(0.5), x2: W(1, -2), y2: H(0.5) },
    { kind: "line", x1: W(1, -10), y1: H(0.5, -6), x2: W(1, -1), y2: H(0.5) },
    { kind: "line", x1: W(1, -10), y1: H(0.5, 6), x2: W(1, -1), y2: H(0.5) },
  ],
});

symbol({
  id: "label", label: "Rótulo de tela", labelEn: "Screen Label", folder: ["Texto e Rotulos", "Text & Labels"],
  help: "Texto de tela com moldura opcional; mostra o valor ligado quando há binding.",
  w: 120, h: 30, elastic: true,
  props: [
    ...geometry(120, 30),
    { id: "text", label: "Texto", group: "Componente", unit: "", editor: "text", default: "Rótulo" },
    { id: "fontSize", label: "Tamanho do texto", group: "Componente", unit: "px", editor: "number", default: 13, min: 6, max: 64, step: 1 },
    { id: "align", label: "Alinhamento", group: "Componente", unit: "", editor: "select", default: "middle",
      options: [{ value: "start", label: "Esquerda" }, { value: "middle", label: "Centro" }, { value: "end", label: "Direita" }] },
    { id: "stroke", label: "Cor do texto", group: "Aparência", unit: "", editor: "color", default: C.ink },
    { id: "fill", label: "Fundo", group: "Aparência", unit: "", editor: "color", default: "none" },
    { id: "showBox", label: "Mostrar moldura", group: "Aparência", unit: "", editor: "checkbox", default: false },
    { id: "opacity", label: "Opacidade", group: "Aparência", unit: "", editor: "number", default: 1, min: 0, max: 1, step: 0.05 },
    ...analogBinding("Valor", "", { decimals: 1 }),
  ],
  paint: () => [
    { kind: "rect", x: 0.5, y: 0.5, w: W(1, -1), h: H(1, -1), fill: { prop: "fill" }, stateVisible: whenProp("showBox", true) },
    // Sem binding mostra o texto autorado; com binding mostra o valor -- duas primitivas
    // mutuamente exclusivas por `__g_bind`, nunca um ramo em código.
    // `textAnchor` é constante no IR (não aceita expressão), então o alinhamento é escolhido por
    // VISIBILIDADE entre três primitivas -- mesmo recurso que o atuador da válvula usa. Sem isto a
    // propriedade "Alinhamento" aparecia no Inspector e não fazia nada.
    ...([["start", 6], ["middle", 0.5], ["end", -6]]).flatMap(([align, pos]) => {
      const x = align === "middle" ? W(0.5) : align === "start" ? W(0, 6) : W(1, -6);
      return [
        { kind: "text", x, y: H(0.5, 4), value: "", fontSize: { prop: "fontSize", fallback: 13 }, textAnchor: align,
          fill: { prop: "stroke" }, stateText: { kind: "property", prop: "text" },
          stateVisible: { when: { align: [align], __g_bind: ["static"] } } },
        boundText({ x, y: H(0.5, 4), fontSize: { prop: "fontSize", fallback: 13 }, textAnchor: align,
          fill: { prop: "stroke" }, stateVisible: { when: { align: [align], __g_bind: ["bound", "missing"] } } }),
      ];
    }),
  ],
});

// ---------------------------------------------------------------------------
// Materialização
// ---------------------------------------------------------------------------

/** `stroke`/`fill` declarados como `{prop}` viram expressão de COR, que o IR não tem -- cor
 * property-driven é `stateFill` com `raw: true`. Esta função traduz o açúcar sintático acima
 * (`fill: {prop:"fill"}`) para o que o renderizador entende, sem cada símbolo ter que escrever isso. */
function materializePrimitive(primitive) {
  const out = { ...primitive };
  if (out.fill && typeof out.fill === "object" && out.fill.prop) {
    const prop = out.fill.prop;
    out.fill = undefined;
    // `stateFill` explícito do símbolo (cor de estado) SEMPRE vence a cor autorada pelo usuário.
    if (!out.stateFill) out.stateFill = { prop, raw: true };
    else if (out.stateFill.map) {
      out.stateFill = { ...out.stateFill, map: Object.fromEntries(Object.entries(out.stateFill.map).map(([k, v]) => [k, v])) };
    }
  }
  if (out.stroke && typeof out.stroke === "object" && out.stroke.prop) {
    const prop = out.stroke.prop;
    out.stroke = undefined;
    // Para linhas e caminhos P&ID, stroke é a cor semântica do elemento. Reutilize a mesma
    // projeção declarativa e aplique-a ao traço, sem renderer especial por símbolo.
    if (!out.stateFill) out.stateFill = { prop, raw: true, applyToStroke: true };
  }
  if (out.primitive) out.primitive = materializePrimitive(out.primitive);
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

/** Espaço de PROJETO do desenho (`dw`/`dh`), distinto do tamanho PADRÃO da instância (`w`/`h`).
 * O renderizador escala `bounds` -> caixa da instância (`simulidePaint.ts::transformFor`), então
 * confundir os dois faz o símbolo ser desenhado num canto da própria caixa. */
const designBounds = (def) => ({ w: def.dw ?? def.w, h: def.dh ?? def.h });

function packageFor(def) {
  const elastic = def.elastic === true;
  const design = designBounds(def);
  const bounds = elastic
    ? { x: 0, y: 0, w: def.w, h: def.h }
    : { x: 0, y: 0, w: design.w, h: design.h };
  const dynamicLayout = {
    width: { prop: "width", fallback: def.w },
    height: { prop: "height", fallback: def.h },
    ...(elastic ? { simulideBounds: { w: { prop: "width", fallback: def.w }, h: { prop: "height", fallback: def.h } } } : {}),
  };
  return {
    width: def.w,
    height: def.h,
    border: false,
    background: { kind: "none" },
    dynamicLayout,
    pins: [],
    simulidePaint: {
      version: 1,
      bounds,
      aspect: elastic ? "variable" : "fixed",
      ...(!elastic ? { referenceSize: { width: def.w, height: def.h } } : {}),
      defaultStroke: C.outline,
      defaultFill: "none",
      defaultStrokeWidth: 1.5,
      primitives: def.paint().map(materializePrimitive),
    },
  };
}

function defaultPropertiesFor(def) {
  const out = {};
  for (const schema of def.props) out[schema.id] = schema.default;
  return out;
}

function catalogItemFor(def) {
  return {
    typeId: `graphics.${def.id}`,
    label: def.label,
    pinCount: 0,
    icon: `graphic-${def.id.replace(/_/g, "-")}`,
    graphical: true,
    folderPath: ["Grafico", def.folder[0]],
    category: "Grafico",
    workspaceSection: "misc",
    defaultProperties: defaultPropertiesFor(def),
    propertySchema: def.props,
    package: packageFor(def),
    help: { description: def.help },
    provenance: def.provenance,
  };
}

// ---------------------------------------------------------------------------
// Ícones da paleta (SVG estático renderizado do MESMO paint spec)
// ---------------------------------------------------------------------------

const ICON_THEMES = {
  light: { outline: "#555", body: "#e8e8e8" },
  dark: { outline: "#bbb", body: "#404040" },
};

function iconNumber(value, properties, fallback = 0) {
  if (typeof value === "number") return value;
  if (!value || typeof value !== "object") return fallback;
  const base = value.prop !== undefined
    ? (typeof properties[value.prop] === "number" ? properties[value.prop] : (value.fallback ?? fallback))
    : (value.fallback ?? fallback);
  let out = base * (value.multiplier ?? 1) + (value.offset ?? 0);
  if (value.min !== undefined) out = Math.max(value.min, out);
  if (value.max !== undefined) out = Math.min(value.max, out);
  return out;
}

function iconVisible(primitive, properties) {
  if (!primitive.stateVisible) return true;
  return Object.entries(primitive.stateVisible.when).every(([prop, accepted]) => accepted.includes(String(properties[prop])));
}

function iconProjectedFill(primitive, properties) {
  if (primitive.stateFill?.raw) {
    const raw = properties[primitive.stateFill.prop];
    return typeof raw === "string" && raw ? raw : primitive.stateFill.fallback;
  }
  if (primitive.stateFill?.map) {
    const mapped = primitive.stateFill.map[String(properties[primitive.stateFill.prop])];
    if (mapped) return mapped;
  }
  if (primitive.stateFill?.numeric) {
    const value = Number(properties[primitive.stateFill.prop] ?? 0);
    for (const rule of primitive.stateFill.numeric) {
      const cmp = rule.value;
      if (cmp === undefined) continue;
      const hit = (rule.op === ">" && value > cmp) || (rule.op === ">=" && value >= cmp)
        || (rule.op === "<" && value < cmp) || (rule.op === "<=" && value <= cmp)
        || (rule.op === "==" && value === cmp) || (rule.op === "!=" && value !== cmp);
      if (hit) return rule.color;
    }
    if (primitive.stateFill.fallback) return primitive.stateFill.fallback;
  }
  return undefined;
}

function iconColor(value, theme) {
  return value === "currentColor" ? theme.outline : value;
}

function iconFill(primitive, properties, theme) {
  if (primitive.stateFill?.applyToStroke && typeof primitive.fill === "string") {
    return iconColor(primitive.fill, theme);
  }
  const projected = iconProjectedFill(primitive, properties);
  if (projected) return iconColor(projected, theme);
  if (typeof primitive.fill === "string") return primitive.fill === "currentColor" ? theme.outline : primitive.fill;
  return "none";
}

function iconText(primitive, properties) {
  if (primitive.stateText?.kind === "property") {
    const raw = properties[primitive.stateText.prop];
    return raw === undefined || raw === null ? "" : String(raw);
  }
  return primitive.value ?? "";
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Renderiza o símbolo no estado PADRÃO (propriedades default, sem binding) para o ícone da paleta.
 * Reusa o mesmo spec do componente -- o ícone nunca diverge do desenho real. */
function renderIconSvg(def, theme) {
  const pkg = packageFor(def);
  const properties = { ...defaultPropertiesFor(def), __g_pct: 62, __g_on: "true", __g_bind: "static", __g_text: "" };
  const stroke = (primitive) => {
    if (primitive.stateFill?.applyToStroke) {
      const projected = iconProjectedFill(primitive, properties);
      if (projected) return iconColor(projected, theme);
    }
    const value = primitive.stroke ?? pkg.simulidePaint.defaultStroke;
    if (typeof value !== "string") return theme.outline;
    return value === "currentColor" ? theme.outline : value;
  };
  const parts = [];
  const iconPrimitives = [];
  const expandForIcon = (raw, tx = 0, ty = 0) => {
    if (!iconVisible(raw, properties)) return;
    if (raw.kind !== "repeat") {
      iconPrimitives.push({ raw, tx, ty });
      return;
    }
    const count = Math.max(0, Math.floor(iconNumber(raw.count, properties, 0)));
    for (let index = 0; index < count; index += 1) {
      for (const primitive of raw.primitives ?? []) {
        expandForIcon(primitive, tx + index * (raw.stepX ?? 0), ty + index * (raw.stepY ?? 0));
      }
    }
  };
  for (const raw of pkg.simulidePaint.primitives) expandForIcon(raw);
  for (const item of iconPrimitives) {
    const { raw, tx, ty } = item;
    if (!iconVisible(raw, properties)) continue;
    const sw = raw.strokeWidth ?? pkg.simulidePaint.defaultStrokeWidth;
    const transform = tx || ty ? ` transform="translate(${tx} ${ty})"` : "";
    const opacity = raw.opacity === undefined ? "" : ` opacity="${raw.opacity}"`;
    const common = `stroke="${stroke(raw)}" stroke-width="${sw}" fill="${iconFill(raw, properties, theme)}"`
      + (raw.strokeDasharray ? ` stroke-dasharray="${raw.strokeDasharray}"` : "") + opacity + transform;
    const n = (value, fallback) => Math.round(iconNumber(value, properties, fallback) * 100) / 100;
    switch (raw.kind) {
      case "rect":
        parts.push(`<rect x="${n(raw.x)}" y="${n(raw.y)}" width="${n(raw.w)}" height="${n(raw.h)}" ${common}/>`); break;
      case "roundedRect":
        parts.push(`<rect x="${n(raw.x)}" y="${n(raw.y)}" width="${n(raw.w)}" height="${n(raw.h)}" rx="${n(raw.rx)}" ry="${n(raw.ry)}" ${common}/>`); break;
      case "line":
        parts.push(`<line x1="${n(raw.x1)}" y1="${n(raw.y1)}" x2="${n(raw.x2)}" y2="${n(raw.y2)}" stroke="${stroke(raw)}" stroke-width="${sw}"${raw.strokeDasharray ? ` stroke-dasharray="${raw.strokeDasharray}"` : ""}${opacity}${transform}/>`); break;
      case "ellipse":
        parts.push(`<ellipse cx="${n(raw.cx)}" cy="${n(raw.cy)}" rx="${n(raw.rx)}" ry="${n(raw.ry)}" ${common}/>`); break;
      case "polygon":
        parts.push(`<polygon points="${raw.points.map((p) => `${p.x},${p.y}`).join(" ")}" ${common}/>`); break;
      case "path":
        parts.push(`<path d="${raw.d}" ${common}/>`); break;
      case "arc": {
        const x = n(raw.x), y = n(raw.y), w = n(raw.w), h = n(raw.h);
        const sweep = raw.startDeg === 0 ? 1 : 0;
        parts.push(`<path d="M ${x} ${y + h} A ${w / 2} ${h} 0 0 ${sweep} ${x + w} ${y + h}" ${common}/>`); break;
      }
      case "text": {
        const value = iconText(raw, properties);
        if (!value) break;
        parts.push(`<text x="${n(raw.x)}" y="${n(raw.y)}" font-size="${n(raw.fontSize, 11)}" text-anchor="${raw.textAnchor ?? "start"}" fill="${typeof raw.fill === "string" ? raw.fill : theme.outline}"${opacity}${transform}>${escapeXml(value)}</text>`);
        break;
      }
      default: break;
    }
  }
  const pad = 2;
  const design = designBounds(def);
  const vb = `${-pad} ${-pad} ${design.w + pad * 2} ${design.h + pad * 2}`;
  const licenseMetadata = def.provenance?.license
    ? `<metadata>${escapeXml(JSON.stringify({
        source: def.provenance.source,
        sourceCommit: def.provenance.sourceCommit,
        sourceFiles: def.provenance.sourceFiles,
        adaptation: def.provenance.adaptation,
        license: def.provenance.license,
        licenseUrl: def.provenance.licenseUrl,
        requiredNotice: def.provenance.requiredNotice,
      }))}</metadata>`
    : "";
  return `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg">${licenseMetadata}${parts.join("")}</svg>\n`;
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const ownedTypeIds = new Set(SYMBOLS.map((def) => `graphics.${def.id}`));

// As 5 formas legadas (`rectangle`/`ellipse`/`line`/`text`/`image`) NÃO são tocadas: elas são
// desenhadas pelo caminho antigo e participam do round-trip de autoria de símbolo
// (`catalog/subcircuitSymbolScene.ts`). Só ganham a subpasta nova.
const LEGACY_FOLDER = { pt: ["Grafico", "Formas Basicas"], en: ["Graphical", "Basic Shapes"] };
const LEGACY_IDS = ["graphics.rectangle", "graphics.ellipse", "graphics.line", "graphics.text", "graphics.image"];

/** As 5 legadas estavam com rótulo em INGLÊS na língua-base do arquivo (que é pt-BR) -- a
 * tradução `en` já tinha o mesmo texto, então o item aparecia em inglês nas DUAS línguas. */
const LEGACY_PT_LABEL = {
  "graphics.rectangle": "Retângulo",
  "graphics.ellipse": "Elipse",
  "graphics.line": "Linha",
  "graphics.text": "Texto",
  "graphics.image": "Imagem",
};

// Este gerador é DONO do namespace `graphics.<id>` simples -- `graphics.pid.*` pertence ao porte
// P&ID e `graphics.hmi.*` ao porte do HMI Studio, cada um com o seu gerador. Filtrar só por
// `ownedTypeIds` deixava órfã toda entrada REMOVIDA da lista acima: o símbolo sumia da fonte e
// continuava no catálogo para sempre, porque nada mais o reivindicava. Podar o namespace inteiro
// faz "apagar daqui" significar de fato "apagar do catálogo".
const ownsNamespace = (typeId) => typeId.startsWith("graphics.")
  && !typeId.startsWith("graphics.pid.")
  && !typeId.startsWith("graphics.hmi.")
  && !LEGACY_IDS.includes(typeId);
const kept = catalog.items.filter((item) => !ownsNamespace(item.typeId) || ownedTypeIds.has(item.typeId))
  .filter((item) => !ownedTypeIds.has(item.typeId));
for (const item of kept) {
  if (!LEGACY_IDS.includes(item.typeId)) continue;
  item.folderPath = [...LEGACY_FOLDER.pt];
  item.label = LEGACY_PT_LABEL[item.typeId] ?? item.label;
  item.category = "Grafico";
}

const generated = SYMBOLS.map(catalogItemFor);
const firstGraphicsIndex = kept.findIndex((item) => item.typeId.startsWith("graphics."));
catalog.items = firstGraphicsIndex < 0
  ? [...kept, ...generated]
  : [...kept.slice(0, firstGraphicsIndex), ...generated, ...kept.slice(firstGraphicsIndex)];

catalog.translations = catalog.translations ?? {};
catalog.translations.en = catalog.translations.en ?? { items: {} };
catalog.translations.en.items = catalog.translations.en.items ?? {};
for (const def of SYMBOLS) {
  catalog.translations.en.items[`graphics.${def.id}`] = { label: def.labelEn, folderPath: ["Graphical", def.folder[1]] };
}
const LEGACY_EN_LABEL = {
  "graphics.rectangle": "Rectangle", "graphics.ellipse": "Ellipse", "graphics.line": "Line",
  "graphics.text": "Text", "graphics.image": "Image",
};
for (const typeId of LEGACY_IDS) {
  catalog.translations.en.items[typeId] = { label: LEGACY_EN_LABEL[typeId], folderPath: [...LEGACY_FOLDER.en] };
}

fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

let icons = 0;
for (const def of SYMBOLS) {
  for (const [theme, colors] of Object.entries(ICON_THEMES)) {
    const file = path.join(iconDir, theme, `graphic-${def.id.replace(/_/g, "-")}.svg`);
    fs.writeFileSync(file, renderIconSvg(def, colors), "utf8");
    icons += 1;
  }
}

console.log(`[graphics-library] ${SYMBOLS.length} simbolos publicados, ${icons} icones gerados`);

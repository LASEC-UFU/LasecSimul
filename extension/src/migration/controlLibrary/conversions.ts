/**
 * Matriz de equivalência em código (docs/68): bloco legado `control.*` -> estrutura da biblioteca
 * equivalente ao Simulink. Cada regra é derivada das equações do bloco legado (SignalMathBlock/
 * SignalEngine, commit ab4c1efb7) e das equações documentadas do bloco novo; a equivalência é
 * verificada numericamente pela comparação antes/depois (docs/69), nunca presumida pelo nome.
 *
 * Três formas de conversão:
 *  - `single`: um bloco novo com o MESMO id (portas remapeadas: in -> in1, out -> out1...);
 *  - `inline`: dois ou três blocos no mesmo diagrama (Mux -> Fcn [-> Saturation]); o bloco que
 *    publica a saída mantém o id legado;
 *  - `subsystem`: uma instância de subsistema interno com o id legado e as MESMAS portas legadas,
 *    cuja definição (compartilhada por estrutura) contém os blocos novos; os parâmetros da instância
 *    vão como `@bloco.Parametro`.
 *
 * Tempo de amostragem: bloco algébrico/discreto legado rodava amostrado no `samplePeriodNs` (saída
 * segurada entre ativações) -> o bloco novo recebe esse período explícito. Bloco legado de estado
 * contínuo -> bloco contínuo. Blocos algébricos DENTRO de uma composição contínua herdam (-1), que é
 * como o bloco contínuo legado lia a entrada (valor corrente do produtor).
 */
import {
  LegacyProperties, legacyBoolean, legacyDeclaredInputs, legacyInputPorts, legacyNumber, legacyPeriodNs, legacyText,
} from "./legacyBlocks";
import { convertLegacyExpression } from "./legacyExpression";

export type BlockValue = string | number | boolean;
export type BlockProps = Record<string, BlockValue>;
export interface Endpoint { componentId: string; port: string }

export interface NewBlock {
  id: string;
  typeId: string;
  properties: BlockProps;
  /** Deslocamento em relação à posição do bloco legado (diagramas inline). */
  dx?: number;
  dy?: number;
}

/** Bloco dentro da definição de um subsistema de conversão. */
export interface CompositeBlock {
  id: string;
  typeId: string;
  properties: BlockProps;
  x: number;
  y: number;
  /** Parâmetros que variam por instância (vão como `@id.Param` na instância). */
  perInstance?: string[];
}

export interface CompositeDefinition {
  /** Chave estrutural: instâncias com a mesma chave compartilham a definição. */
  key: string;
  typeId: string;
  name: string;
  inputs: Array<{ pinId: string; label: string }>;
  outputs: Array<{ pinId: string; label: string }>;
  blocks: CompositeBlock[];
  /** Fios internos; `in:<pin>`/`out:<pin>` são os túneis da interface. */
  wires: Array<{ from: Endpoint; to: Endpoint }>;
}

export type Conversion =
  | { kind: "single" | "inline"; rule: string; blocks: NewBlock[]; wires: Array<{ from: Endpoint; to: Endpoint }>; inputs: Record<string, Endpoint>; outputs: Record<string, Endpoint> }
  | { kind: "subsystem"; rule: string; definition: CompositeDefinition; overrides: BlockProps }
  | { kind: "rename"; rule: string; typeId: string }
  | { kind: "keep"; rule: string; reason: string }
  | { kind: "unsupported"; rule: string; reason: string };

// ------------------------------------------------------------------ formatação MATLAB exata

/** Menor texto que reproduz o double exatamente (o avaliador do Core lê com `strtod`). */
export const num = (value: number): string => (Number.isNaN(value) ? "NaN" : value === Infinity ? "inf" : value === -Infinity ? "-inf" : String(value));
export const vec = (values: number[]): string => `[${values.map(num).join(" ")}]`;
export const col = (values: number[]): string => `[${values.map(num).join("; ")}]`;
export const mat = (rows: number[][]): string => `[${rows.map((row) => row.map(num).join(" ")).join("; ")}]`;
const seconds = (ns: number): string => num(ns / 1e9);

// ------------------------------------------------------------------ construtores

function single(rule: string, id: string, typeId: string, properties: BlockProps, inputPorts: string[], newInputs: string[] = inputPorts.map((_, i) => `in${i + 1}`)): Conversion {
  const inputs: Record<string, Endpoint> = {};
  inputPorts.forEach((port, i) => { inputs[port] = { componentId: id, port: newInputs[i]! }; });
  return { kind: "single", rule, blocks: [{ id, typeId, properties }], wires: [], inputs, outputs: { out: { componentId: id, port: "out1" } } };
}

/** Bloco SISO de primeira ordem K/(tau s + 1) com estado inicial: Transfer Fcn sem estado inicial
 * (a documentação: estados iniciais nulos), State-Space com x0 quando ele existe. */
function firstOrderBlock(gain: number, tau: number, initial: number): { typeId: string; properties: BlockProps; rule: string } {
  if (initial === 0) return { typeId: "sl.transfer_fcn", properties: { Numerator: vec([gain]), Denominator: vec([tau, 1]) }, rule: "first_order->transfer_fcn" };
  return { typeId: "sl.state_space", properties: { A: num(-1 / tau), B: num(gain / tau), C: "1", D: "0", InitialCondition: num(initial) }, rule: "first_order->state_space(x0)" };
}

// ------------------------------------------------------------------ regras por bloco

type Rule = (id: string, p: LegacyProperties, typeId: string) => Conversion;

const sampled = (p: LegacyProperties): BlockProps => ({ SampleTime: seconds(legacyPeriodNs(p)) });

const rules: Record<string, Rule> = {
  "control.gain": (id, p) => single("gain->gain", id, "sl.gain", { Gain: num(legacyNumber(p, "gain", 1)), ...sampled(p) }, ["in"]),

  "control.bias": (id, p, typeId) => single("bias->bias", id, "sl.bias", { Bias: num(legacyNumber(p, "bias", 0)) }, legacyInputPorts(typeId, p)),

  "control.sum": (id, p, typeId) => {
    const ports = legacyInputPorts(typeId, p);
    return single("sum->sum", id, "sl.sum", { IconShape: "rectangular", Inputs: "+".repeat(ports.length), ...sampled(p) }, ports);
  },
  "control.subtract": (id, p, typeId) => {
    const ports = legacyInputPorts(typeId, p).slice(0, 2);
    return single("subtract->sum(+-)", id, "sl.sum", { IconShape: "rectangular", Inputs: "+-", ...sampled(p) }, ports);
  },
  "control.product": (id, p, typeId) => {
    const ports = legacyInputPorts(typeId, p);
    return single("product->product", id, "sl.product", { Inputs: "*".repeat(ports.length), ...sampled(p) }, ports);
  },
  "control.divide": (id, p, typeId) => {
    const ports = legacyInputPorts(typeId, p).slice(0, 2);
    return single("divide->product(*/)", id, "sl.product", { Inputs: "*/", ...sampled(p) }, ports);
  },

  // x' = K u, x(0) = x0. K = 1: Integrator; senão Gain -> Integrator (subsistema).
  "control.integrator": (id, p) => {
    const gain = legacyNumber(p, "gain", 1), initial = legacyNumber(p, "initial", 0);
    if (gain === 1) return single("integrator->integrator", id, "sl.integrator", { InitialCondition: num(initial) }, ["in"]);
    return {
      kind: "subsystem", rule: "integrator(K)->gain+integrator",
      definition: {
        key: "integrator-gain", typeId: "subsystem.legado_integrador_ganho", name: "Integrador com ganho (convertido)",
        inputs: [{ pinId: "in", label: "IN" }], outputs: [{ pinId: "out", label: "OUT" }],
        blocks: [
          { id: "k", typeId: "sl.gain", properties: { Gain: num(gain) }, x: 120, y: 60, perInstance: ["Gain"] },
          { id: "integrator", typeId: "sl.integrator", properties: { InitialCondition: num(initial) }, x: 220, y: 60, perInstance: ["InitialCondition"] },
        ],
        wires: [{ from: { componentId: "in:in", port: "value" }, to: { componentId: "k", port: "in1" } }, { from: { componentId: "k", port: "out1" }, to: { componentId: "integrator", port: "in1" } }, { from: { componentId: "integrator", port: "out1" }, to: { componentId: "out:out", port: "value" } }],
      },
      overrides: { "@k.Gain": num(gain), "@integrator.InitialCondition": num(initial) },
    };
  },

  // x' = (u - x)/tau, y = K (u - x)/tau  ==  K s/(tau s + 1) com estado x.
  "control.filtered_derivative": (id, p) => {
    const gain = legacyNumber(p, "gain", 1), tau = legacyNumber(p, "filterTau", 0.01), initial = legacyNumber(p, "initial", 0);
    if (initial === 0) return single("filtered_derivative->transfer_fcn", id, "sl.transfer_fcn", { Numerator: vec([gain, 0]), Denominator: vec([tau, 1]) }, ["in"]);
    return single("filtered_derivative->state_space(x0)", id, "sl.state_space", { A: num(-1 / tau), B: num(1 / tau), C: num(-gain / tau), D: num(gain / tau), InitialCondition: num(initial) }, ["in"]);
  },

  "control.unit_delay": (id, p) => single("unit_delay->unit_delay", id, "sl.unit_delay", { InitialCondition: num(legacyNumber(p, "initial", 0)), ...sampled(p) }, ["in"]),

  "control.dead_time": (id, p) => single("dead_time->transport_delay", id, "sl.transport_delay", { DelayTime: num(legacyNumber(p, "delay", 0.1)), InitialOutput: num(legacyNumber(p, "initial", 0)) }, ["in"]),

  "control.first_order": (id, p) => {
    const block = firstOrderBlock(legacyNumber(p, "gain", 1), legacyNumber(p, "tau", 1), legacyNumber(p, "initial", 0));
    return single(block.rule, id, block.typeId, block.properties, ["in"]);
  },

  // y'' + 2 zeta w y' + w^2 y = K w^2 u  ==  K w^2/(s^2 + 2 zeta w s + w^2); x = [y, y'].
  "control.second_order": (id, p) => {
    const k = legacyNumber(p, "gain", 1), w = legacyNumber(p, "omega", 1), z = legacyNumber(p, "zeta", 1);
    const y0 = legacyNumber(p, "initial", 0), dy0 = legacyNumber(p, "initialDerivative", 0);
    if (y0 === 0 && dy0 === 0) return single("second_order->transfer_fcn", id, "sl.transfer_fcn", { Numerator: vec([k * w * w]), Denominator: vec([1, 2 * z * w, w * w]) }, ["in"]);
    return single("second_order->state_space(x0)", id, "sl.state_space", { A: mat([[0, 1], [-w * w, -2 * z * w]]), B: col([0, k * w * w]), C: vec([1, 0]), D: "0", InitialCondition: col([y0, dy0]) }, ["in"]);
  },

  // x' = (u - x)/lag, y = K (r u + (1 - r) x), r = lead/lag  ==  K (lead s + 1)/(lag s + 1).
  "control.lead_lag": (id, p) => {
    const k = legacyNumber(p, "gain", 1), lead = legacyNumber(p, "leadTau", 0), lag = legacyNumber(p, "lagTau", 1), x0 = legacyNumber(p, "initial", 0);
    if (x0 === 0) return single("lead_lag->transfer_fcn", id, "sl.transfer_fcn", { Numerator: vec([k * lead, k]), Denominator: vec([lag, 1]) }, ["in"]);
    const r = lead / lag;
    return single("lead_lag->state_space(x0)", id, "sl.state_space", { A: num(-1 / lag), B: num(1 / lag), C: num(k * (1 - r)), D: num(k * r), InitialCondition: num(x0) }, ["in"]);
  },

  // Entrada atrasada (valor `initial` antes de theta) -> primeira ordem com x0 = initial.
  "control.fopdt": (id, p) => fopdtSubsystem(legacyNumber(p, "gain", 1), legacyNumber(p, "tau", 1), legacyNumber(p, "delay", 0.1), legacyNumber(p, "initial", 0)),

  "control.transfer_function": (id, p, typeId) => {
    const model = legacyText(p, "model", "first_order");
    if (model === "discrete_transfer_function") {
      const parse = (key: string) => legacyText(p, key, "").split(",").map((t) => Number(t.trim()));
      const numerator = parse("numeratorCoefficients"), denominator = parse("denominatorCoefficients");
      if (numerator.some((x) => !Number.isFinite(x)) || denominator.some((x) => !Number.isFinite(x)) || !p.samplePeriodNs)
        return { kind: "unsupported", rule: "transfer_function(discrete)", reason: "coeficientes ou samplePeriodNs invalidos no bloco legado (o Core legado tambem recusava)" };
      return single("transfer_function(discrete)->discrete_transfer_fcn", id, "sl.discrete_transfer_fcn", { Numerator: vec(numerator), Denominator: vec(denominator), SampleTime: seconds(legacyNumber(p, "samplePeriodNs", 0)) }, ["in"]);
    }
    const delegate = model === "second_order" ? "control.second_order" : model === "lead_lag" ? "control.lead_lag" : model === "fopdt" ? "control.fopdt" : "control.first_order";
    const converted = rules[delegate]!(id, p, typeId);
    return { ...converted, rule: `transfer_function(${model})->${converted.rule}` } as Conversion;
  },

  "control.state_space": (id, p) => {
    try {
      const a = JSON.parse(legacyText(p, "A", "[]")) as number[][];
      const b = JSON.parse(legacyText(p, "B", "[]")) as number[];
      const c = JSON.parse(legacyText(p, "C", "[]")) as number[];
      const x0 = JSON.parse(legacyText(p, "x0", "[]")) as number[];
      const props: BlockProps = { A: mat(a), B: col(b), C: vec(c), D: num(legacyNumber(p, "D", 0)), InitialCondition: x0.length === 0 ? "0" : col(x0) };
      if (legacyText(p, "domain", "continuous") === "discrete")
        return single("state_space(discrete)->discrete_state_space", id, "sl.discrete_state_space", { ...props, SampleTime: seconds(legacyNumber(p, "samplePeriodNs", 0)) }, ["in"]);
      return single("state_space->state_space", id, "sl.state_space", props, ["in"]);
    } catch {
      return { kind: "unsupported", rule: "state_space", reason: "matrizes A/B/C/x0 do bloco legado nao sao JSON validos" };
    }
  },

  // Estoque conservativo (ADR 0013): sem equivalente exato no Simulink (contabilidade compensada,
  // instante analítico de contato, derramamento por fronteira móvel). Continua bloco de processo do
  // LasecSimul, fora da biblioteca de controle; só o typeId muda.
  "control.accumulator": () => ({ kind: "rename", rule: "accumulator->process.accumulator (bloco de processo do LasecSimul)", typeId: "process.accumulator" }),

  // y = C max(0, u)^n: Saturation [0, inf) -> Fcn C*u^n.
  "control.valve_characteristic": (id, p): Conversion => {
    const c = legacyNumber(p, "coefficient", 1), n = legacyNumber(p, "exponent", 1);
    return {
      kind: "subsystem", rule: "valve_characteristic->saturation+fcn",
      definition: {
        key: "valve-characteristic", typeId: "subsystem.legado_caracteristica_valvula", name: "Característica de válvula (convertida)",
        inputs: [{ pinId: "in", label: "IN" }], outputs: [{ pinId: "out", label: "OUT" }],
        blocks: [
          { id: "positive", typeId: "sl.saturation", properties: { UpperLimit: "inf", LowerLimit: "0", SampleTime: "-1" }, x: 120, y: 60 },
          { id: "law", typeId: "sl.fcn", properties: { Expr: `${num(c)}*u(1)^${num(n)}`, SampleTime: "-1" }, x: 230, y: 60, perInstance: ["Expr"] },
        ],
        wires: [{ from: { componentId: "in:in", port: "value" }, to: { componentId: "positive", port: "in1" } }, { from: { componentId: "positive", port: "out1" }, to: { componentId: "law", port: "in1" } }, { from: { componentId: "law", port: "out1" }, to: { componentId: "out:out", port: "value" } }],
      },
      overrides: { "@law.Expr": `${num(c)}*u(1)^${num(n)}` },
    };
  },

  "control.saturation": (id, p) => single("saturation->saturation", id, "sl.saturation", { UpperLimit: num(legacyNumber(p, "maximum", 100)), LowerLimit: num(legacyNumber(p, "minimum", 0)), ...sampled(p) }, ["in"]),
  "control.limiter": (id, p) => single("limiter->saturation", id, "sl.saturation", { UpperLimit: num(legacyNumber(p, "maximum", 100)), LowerLimit: num(legacyNumber(p, "minimum", 0)), ...sampled(p) }, ["in"]),

  // |u| <= w/2 -> 0; senão u - sign(u) w/2  ==  Dead Zone [-w/2, w/2].
  "control.deadband": (id, p) => {
    const half = legacyNumber(p, "width", 0) / 2;
    return single("deadband->dead_zone", id, "sl.dead_zone", { LowerValue: num(-half), UpperValue: num(half), ...sampled(p) }, ["in"]);
  },

  // u <= low -> lowOutput; u >= high -> highOutput; senão mantém. Estado inicial "desligado" = Relay.
  "control.hysteresis": (id, p) => {
    const low = legacyNumber(p, "low", 0), high = legacyNumber(p, "high", 1);
    const lowOut = legacyNumber(p, "lowOutput", 0), highOut = legacyNumber(p, "highOutput", 1), initial = legacyNumber(p, "initial", 0);
    if (initial === lowOut) return single("hysteresis->relay", id, "sl.relay", { OnSwitchValue: num(high), OffSwitchValue: num(low), OnOutputValue: num(highOut), OffOutputValue: num(lowOut), ...sampled(p) }, ["in"]);
    // Saída inicial fora do estado "desligado" do Relay: memória explícita (Unit Delay com o valor inicial).
    const expr = `(u(1)>=${num(high)})*${num(highOut)} + (u(1)<=${num(low)})*${num(lowOut)} + (u(1)>${num(low)} && u(1)<${num(high)})*u(2)`;
    return memorySubsystem("hysteresis(initial)->mux+fcn+unit_delay", "hysteresis-memory", "subsystem.legado_histerese", "Histerese (convertida)", expr, initial, legacyPeriodNs(p));
  },

  // |u - y[k-1]| >= S -> y = u - J sign(u - y[k-1]); senão y = y[k-1].
  "control.stiction": (id, p) => {
    const s = legacyNumber(p, "breakaway", 0), j = legacyNumber(p, "slip", 0);
    const expr = `(abs(u(1)-u(2))>=${num(s)})*(u(1)-${num(j)}*sgn(u(1)-u(2))) + (abs(u(1)-u(2))<${num(s)})*u(2)`;
    return memorySubsystem("stiction->mux+fcn+unit_delay", "stiction-memory", "subsystem.legado_agarramento", "Agarramento/stiction (convertido)", expr, legacyNumber(p, "initial", 0), legacyPeriodNs(p));
  },

  // Rate Limiter contínuo: a condição inicial legada vira um IC na entrada (no modo contínuo o
  // Simulink ignora a condição inicial e parte de u(0)).
  "control.rate_limiter": (id, p): Conversion => {
    const rise = legacyNumber(p, "riseRate", 1), fall = legacyNumber(p, "fallRate", 1), initial = legacyNumber(p, "initial", 0);
    return {
      kind: "subsystem", rule: "rate_limiter->ic+rate_limiter",
      definition: {
        key: "rate-limiter", typeId: "subsystem.legado_limitador_taxa", name: "Limitador de taxa (convertido)",
        inputs: [{ pinId: "in", label: "IN" }], outputs: [{ pinId: "out", label: "OUT" }],
        blocks: [
          { id: "ic", typeId: "sl.ic", properties: { Value: num(initial) }, x: 120, y: 60, perInstance: ["Value"] },
          { id: "limiter", typeId: "sl.rate_limiter", properties: { RisingSlewLimit: num(rise), FallingSlewLimit: num(-fall), SampleTimeMode: "continuous", InitialCondition: num(initial) }, x: 230, y: 60, perInstance: ["RisingSlewLimit", "FallingSlewLimit", "InitialCondition"] },
        ],
        wires: [{ from: { componentId: "in:in", port: "value" }, to: { componentId: "ic", port: "in1" } }, { from: { componentId: "ic", port: "out1" }, to: { componentId: "limiter", port: "in1" } }, { from: { componentId: "limiter", port: "out1" }, to: { componentId: "out:out", port: "value" } }],
      },
      overrides: { "@ic.Value": num(initial), "@limiter.RisingSlewLimit": num(rise), "@limiter.FallingSlewLimit": num(-fall), "@limiter.InitialCondition": num(initial) },
    };
  },

  "control.calc_expression": (id, p, typeId) => convertCalcExpression(id, p, typeId),

  // Sonda/observador: leitura de sinal sem efeito no diagrama.
  "control.observer": (id) => single("observer->display", id, "sl.display", {}, ["in"]),
  "control.probe": (id, p) => single("probe->signal_conversion", id, "sl.signal_conversion", {}, ["in"]),

  // Parâmetro de modelo (SignalConstant): valor editável com a simulação rodando, unidade e lista de
  // opções, exportado como campo do subsistema. É o papel de um PARÂMETRO DE MÁSCARA do Simulink, não
  // do bloco Constant (que não tem unidade nem opções): continua bloco do LasecSimul, sem conversão.
  "control.constant": () => ({ kind: "keep", rule: "constant (parametro de modelo do LasecSimul, equivalente a parametro de mascara)", reason: "nao e bloco da biblioteca de controle" }),

  "control.process": (id, p) => processSubsystem(p),
};

// ------------------------------------------------------------------ composições

function fopdtSubsystem(gain: number, tau: number, delay: number, initial: number): Conversion {
  const plant = firstOrderBlock(gain, tau, initial);
  const plantPerInstance = plant.typeId === "sl.transfer_fcn" ? ["Numerator", "Denominator"] : ["A", "B", "InitialCondition"];
  const overrides: BlockProps = { "@delay.DelayTime": num(delay), "@delay.InitialOutput": num(initial) };
  for (const name of plantPerInstance) overrides[`@plant.${name}`] = plant.properties[name]!;
  return {
    kind: "subsystem", rule: `fopdt->transport_delay+${plant.typeId.slice(3)}`,
    definition: {
      key: `fopdt-${plant.typeId}`, typeId: plant.typeId === "sl.transfer_fcn" ? "subsystem.legado_fopdt" : "subsystem.legado_fopdt_x0",
      name: "FOPDT (convertido)", inputs: [{ pinId: "in", label: "IN" }], outputs: [{ pinId: "out", label: "OUT" }],
      blocks: [
        { id: "delay", typeId: "sl.transport_delay", properties: { DelayTime: num(delay), InitialOutput: num(initial) }, x: 120, y: 60, perInstance: ["DelayTime", "InitialOutput"] },
        { id: "plant", typeId: plant.typeId, properties: plant.properties, x: 240, y: 60, perInstance: plantPerInstance },
      ],
      wires: [{ from: { componentId: "in:in", port: "value" }, to: { componentId: "delay", port: "in1" } }, { from: { componentId: "delay", port: "out1" }, to: { componentId: "plant", port: "in1" } }, { from: { componentId: "plant", port: "out1" }, to: { componentId: "out:out", port: "value" } }],
    },
    overrides,
  };
}

/** Memória discreta explícita: y = f(u, y[k-1]) com Unit Delay de valor inicial `initial`. */
function memorySubsystem(rule: string, key: string, typeId: string, name: string, expr: string, initial: number, periodNs: number): Conversion {
  return {
    kind: "subsystem", rule,
    definition: {
      key, typeId, name, inputs: [{ pinId: "in", label: "IN" }], outputs: [{ pinId: "out", label: "OUT" }],
      blocks: [
        { id: "mux", typeId: "sl.mux", properties: { Inputs: "2" }, x: 110, y: 60 },
        { id: "law", typeId: "sl.fcn", properties: { Expr: expr, SampleTime: seconds(periodNs) }, x: 200, y: 60, perInstance: ["Expr", "SampleTime"] },
        { id: "memory", typeId: "sl.unit_delay", properties: { InitialCondition: num(initial), SampleTime: seconds(periodNs) }, x: 200, y: 140, perInstance: ["InitialCondition", "SampleTime"] },
      ],
      wires: [
        { from: { componentId: "in:in", port: "value" }, to: { componentId: "mux", port: "in1" } },
        { from: { componentId: "memory", port: "out1" }, to: { componentId: "mux", port: "in2" } },
        { from: { componentId: "mux", port: "out1" }, to: { componentId: "law", port: "in1" } },
        { from: { componentId: "law", port: "out1" }, to: { componentId: "memory", port: "in1" } },
        { from: { componentId: "law", port: "out1" }, to: { componentId: "out:out", port: "value" } },
      ],
    },
    overrides: { "@law.Expr": expr, "@law.SampleTime": seconds(periodNs), "@memory.InitialCondition": num(initial), "@memory.SampleTime": seconds(periodNs) },
  };
}

/** Expressão legada -> Fcn (u(i) no lugar dos nomes, precedência explícita), com Mux quando há mais de
 * uma entrada e Saturation quando há limites. Inline: o bloco final mantém o id legado. */
function convertCalcExpression(id: string, p: LegacyProperties, typeId: string): Conversion {
  const inputs = legacyInputPorts(typeId, p);
  let expr: string;
  try {
    expr = convertLegacyExpression(legacyText(p, "expression", ""), inputs);
  } catch (error) {
    return { kind: "unsupported", rule: "calc_expression->fcn", reason: `expressao legada invalida: ${error instanceof Error ? error.message : String(error)}` };
  }
  const upperEnabled = legacyBoolean(p, "upperLimitEnabled", false), lowerEnabled = legacyBoolean(p, "lowerLimitEnabled", false);
  const limited = upperEnabled || lowerEnabled;
  const time = seconds(legacyPeriodNs(p));
  const blocks: NewBlock[] = [];
  const wires: Array<{ from: Endpoint; to: Endpoint }> = [];
  const fcnId = limited ? `${id}__fcn` : id;
  const inputsMap: Record<string, Endpoint> = {};
  if (inputs.length > 1) {
    const muxId = `${id}__mux`;
    blocks.push({ id: muxId, typeId: "sl.mux", properties: { Inputs: String(inputs.length) }, dx: -80, dy: 0 });
    inputs.forEach((port, i) => { inputsMap[port] = { componentId: muxId, port: `in${i + 1}` }; });
    wires.push({ from: { componentId: muxId, port: "out1" }, to: { componentId: fcnId, port: "in1" } });
  } else {
    inputsMap[inputs[0]!] = { componentId: fcnId, port: "in1" };
  }
  blocks.push({ id: fcnId, typeId: "sl.fcn", properties: { Expr: expr, SampleTime: time }, dx: 0, dy: 0 });
  if (limited) {
    // Limites ausentes no legado valiam +-max double (sem corte).
    blocks.push({ id, typeId: "sl.saturation", properties: { UpperLimit: upperEnabled ? num(legacyNumber(p, "upperLimit", 0)) : "inf", LowerLimit: lowerEnabled ? num(legacyNumber(p, "lowerLimit", 0)) : "-inf", SampleTime: time }, dx: 90, dy: 0 });
    wires.push({ from: { componentId: fcnId, port: "out1" }, to: { componentId: id, port: "in1" } });
  }
  const rule = `calc_expression->${inputs.length > 1 ? "mux+" : ""}fcn${limited ? "+saturation" : ""}`;
  return { kind: blocks.length > 1 ? "inline" : "single", rule, blocks, wires, inputs: inputsMap, outputs: { out: { componentId: id, port: "out1" } } };
}

/** Processo TDPS: atuador (histerese -> stiction -> taxa -> tau) -> ganho -> atrasos dinâmicos ->
 * lead-lag -> tempo morto -> saturação, só os estágios ativos (SignalMathBlock::computeGraph). */
function processSubsystem(p: LegacyProperties): Conversion {
  const period = seconds(legacyPeriodNs(p));
  const hysteresis = legacyNumber(p, "hysteresis", 0), stiction = legacyNumber(p, "stiction", 0), rate = legacyNumber(p, "rateLimiter", 0);
  const actuatorTau = legacyNumber(p, "actuatorTau", 0), gain = legacyNumber(p, "gain", 1);
  const tau1 = legacyNumber(p, "tau1", 0), tau2 = legacyNumber(p, "tau2", 0), lead = legacyNumber(p, "lead", 0), lag = legacyNumber(p, "lag", 0);
  const deadTime = legacyNumber(p, "deadTime", 0), saturation = legacyBoolean(p, "saturationEnabled", false);
  const blocks: CompositeBlock[] = [];
  const wires: Array<{ from: Endpoint; to: Endpoint }> = [];
  const overrides: BlockProps = {};
  let previous: Endpoint = { componentId: "in:in", port: "value" };
  let x = 100;
  const add = (block: CompositeBlock, input = "in1") => {
    blocks.push(block);
    wires.push({ from: previous, to: { componentId: block.id, port: input } });
    for (const name of block.perInstance ?? []) overrides[`@${block.id}.${name}`] = block.properties[name]!;
    previous = { componentId: block.id, port: "out1" };
    x += 110;
  };
  const stages: string[] = [];
  if (hysteresis > 0) { stages.push("deadzone"); add({ id: "actuator_deadband", typeId: "sl.dead_zone", properties: { LowerValue: num(-hysteresis / 2), UpperValue: num(hysteresis / 2), SampleTime: period }, x, y: 80, perInstance: ["LowerValue", "UpperValue", "SampleTime"] }); }
  if (stiction > 0) {
    stages.push("stiction");
    const expr = `(abs(u(1)-u(2))>=${num(stiction)})*u(1) + (abs(u(1)-u(2))<${num(stiction)})*u(2)`;
    blocks.push({ id: "stiction_mux", typeId: "sl.mux", properties: { Inputs: "2" }, x, y: 80 });
    wires.push({ from: previous, to: { componentId: "stiction_mux", port: "in1" } });
    blocks.push({ id: "stiction", typeId: "sl.fcn", properties: { Expr: expr, SampleTime: period }, x: x + 40, y: 80, perInstance: ["Expr", "SampleTime"] });
    blocks.push({ id: "stiction_memory", typeId: "sl.unit_delay", properties: { InitialCondition: "0", SampleTime: period }, x: x + 40, y: 160, perInstance: ["SampleTime"] });
    wires.push({ from: { componentId: "stiction_mux", port: "out1" }, to: { componentId: "stiction", port: "in1" } });
    wires.push({ from: { componentId: "stiction_memory", port: "out1" }, to: { componentId: "stiction_mux", port: "in2" } });
    wires.push({ from: { componentId: "stiction", port: "out1" }, to: { componentId: "stiction_memory", port: "in1" } });
    overrides["@stiction.Expr"] = expr; overrides["@stiction.SampleTime"] = period; overrides["@stiction_memory.SampleTime"] = period;
    previous = { componentId: "stiction", port: "out1" };
    x += 150;
  }
  if (rate > 0) {
    stages.push("rate");
    add({ id: "rate_ic", typeId: "sl.ic", properties: { Value: "0" }, x, y: 80 });
    add({ id: "rate_limiter", typeId: "sl.rate_limiter", properties: { RisingSlewLimit: num(rate), FallingSlewLimit: num(-rate), SampleTimeMode: "continuous", InitialCondition: "0" }, x, y: 80, perInstance: ["RisingSlewLimit", "FallingSlewLimit"] });
  }
  const lag1 = (id: string, tau: number) => add({ id, typeId: "sl.transfer_fcn", properties: { Numerator: "[1]", Denominator: vec([tau, 1]) }, x, y: 80, perInstance: ["Denominator"] });
  if (actuatorTau > 0) { stages.push("actuator"); lag1("actuator", actuatorTau); }
  add({ id: "gain", typeId: "sl.gain", properties: { Gain: num(gain), SampleTime: period }, x, y: 80, perInstance: ["Gain", "SampleTime"] });
  if (tau1 > 0) { stages.push("tau1"); lag1("tau1", tau1); }
  if (tau2 > 0) { stages.push("tau2"); lag1("tau2", tau2); }
  if (lag > 0) { stages.push("leadlag"); add({ id: "lead_lag", typeId: "sl.transfer_fcn", properties: { Numerator: vec([Math.max(0, lead), 1]), Denominator: vec([lag, 1]) }, x, y: 80, perInstance: ["Numerator", "Denominator"] }); }
  if (deadTime > 0) { stages.push("deadtime"); add({ id: "dead_time", typeId: "sl.transport_delay", properties: { DelayTime: num(deadTime), InitialOutput: "0" }, x, y: 80, perInstance: ["DelayTime"] }); }
  if (saturation) { stages.push("saturation"); add({ id: "saturation", typeId: "sl.saturation", properties: { UpperLimit: num(legacyNumber(p, "outputMax", 100)), LowerLimit: num(legacyNumber(p, "outputMin", 0)), SampleTime: period }, x, y: 80, perInstance: ["UpperLimit", "LowerLimit", "SampleTime"] }); }
  wires.push({ from: previous, to: { componentId: "out:out", port: "value" } });
  const key = `process-${stages.join("-") || "gain"}`;
  return {
    kind: "subsystem", rule: `process->${["gain", ...stages].join("+")}`,
    definition: {
      key, typeId: `subsystem.legado_processo_${stages.join("_") || "ganho"}`, name: `Processo (convertido: ${["ganho", ...stages].join(", ")})`,
      inputs: [{ pinId: "in", label: "IN" }], outputs: [{ pinId: "out", label: "OUT" }], blocks, wires,
    },
    overrides,
  };
}

export function convertLegacyBlock(id: string, typeId: string, properties: LegacyProperties): Conversion {
  const rule = rules[typeId];
  if (!rule) return { kind: "unsupported", rule: typeId, reason: "bloco legado sem regra de conversao" };
  return rule(id, properties, typeId);
}

/** Tipos legados cuja conversão ainda depende de um bloco novo não implementado (relatório). */
export const PENDING_LEGACY_TYPES = new Set(["control.pid", "control.pid_station"]);

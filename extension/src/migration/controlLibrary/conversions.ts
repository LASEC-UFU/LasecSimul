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

/** Discretização ZOH exata de K/(tau s + 1) no período de ativação legado. */
function firstOrderBlock(gain: number, tau: number, initial: number, periodNs: number): { typeId: string; properties: BlockProps; rule: string } {
  const sampleTime = seconds(periodNs);
  const pole = Math.exp(-sampleTime / tau);
  return {
    typeId: "sl.discrete_transfer_fcn",
    properties: { Numerator: vec([gain * (1 - pole)]), Denominator: vec([1, -pole]), InitialStates: num(initial), SampleTime: sampleTime },
    rule: "first_order->discrete_transfer_fcn(zoh-exact)",
  };
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
    return single("integrator->discrete_time_integrator(forward-euler)", id, "sl.discrete_time_integrator", {
      IntegratorMethod: "Integration: Forward Euler", gainval: num(gain), InitialCondition: num(initial), SampleTime: seconds(legacyPeriodNs(p)),
    }, ["in"]);
  },

  // O motor legado publica a saída filtrada no passo seguinte. Atrasar a saída (com seu valor
  // inicial) preserva essa fase sem precisar adivinhar a condição inicial da entrada.
  "control.filtered_derivative": (id, p) => {
    const gain = legacyNumber(p, "gain", 1), tau = legacyNumber(p, "filterTau", 0.01), initial = legacyNumber(p, "initial", 0);
    const sampleTime = seconds(legacyPeriodNs(p));
    const stateId = `${id}__state`;
    const blocks: NewBlock[] = [
      { id: stateId, typeId: "sl.state_space", properties: { A: num(-1 / tau), B: num(1 / tau), C: num(-gain / tau), D: num(gain / tau), InitialCondition: num(initial) } },
      { id, typeId: "sl.unit_delay", properties: { InitialCondition: num(initial), SampleTime: sampleTime } },
    ];
    return {
      kind: "inline", rule: "filtered_derivative->state_space(continuous)+unit_delay(output-phase)",
      blocks,
      wires: [{ from: { componentId: stateId, port: "out1" }, to: { componentId: id, port: "in1" } }],
      inputs: { in: { componentId: stateId, port: "in1" } }, outputs: { out: { componentId: id, port: "out1" } },
    };
  },

  "control.unit_delay": (id, p) => single("unit_delay->unit_delay", id, "sl.unit_delay", { InitialCondition: num(legacyNumber(p, "initial", 0)), ...sampled(p) }, ["in"]),

  "control.dead_time": (id, p) => single("dead_time->transport_delay", id, "sl.transport_delay", { DelayTime: num(legacyNumber(p, "delay", 0.1)), InitialOutput: num(legacyNumber(p, "initial", 0)) }, ["in"]),

  "control.first_order": (id, p) => {
    const block = firstOrderBlock(legacyNumber(p, "gain", 1), legacyNumber(p, "tau", 1), legacyNumber(p, "initial", 0), legacyPeriodNs(p));
    return single(block.rule, id, block.typeId, block.properties, ["in"]);
  },

  // x' = [y', -w²y-2ζwy'+Kw²u]. O legado publica o estado no período
  // seguinte; Unit Delay mantém a fase observada sem alterar a dinâmica contínua.
  "control.second_order": (id, p) => {
    const k = legacyNumber(p, "gain", 1), w = legacyNumber(p, "omega", 1), z = legacyNumber(p, "zeta", 1);
    const y0 = legacyNumber(p, "initial", 0), dy0 = legacyNumber(p, "initialDerivative", 0);
    const stateId = `${id}__state`, sampleTime = seconds(legacyPeriodNs(p));
    const blocks: NewBlock[] = [
      { id: stateId, typeId: "sl.state_space", properties: { A: mat([[0, 1], [-w * w, -2 * z * w]]), B: col([0, k * w * w]), C: vec([1, 0]), D: "0", InitialCondition: col([y0, dy0]) } },
      { id, typeId: "sl.unit_delay", properties: { InitialCondition: num(y0), SampleTime: sampleTime } },
    ];
    return {
      kind: "inline", rule: "second_order->state_space(x0)+unit_delay(output-phase)",
      blocks,
      wires: [{ from: { componentId: stateId, port: "out1" }, to: { componentId: id, port: "in1" } }],
      inputs: { in: { componentId: stateId, port: "in1" } }, outputs: { out: { componentId: id, port: "out1" } },
    };
  },

  // x' = (u - x)/lag, y = K (r u + (1 - r) x), r = lead/lag  ==  K (lead s + 1)/(lag s + 1).
  "control.lead_lag": (id, p) => {
    const k = legacyNumber(p, "gain", 1), lead = legacyNumber(p, "leadTau", 0), lag = legacyNumber(p, "lagTau", 1), x0 = legacyNumber(p, "initial", 0);
    const sampleTime = seconds(legacyPeriodNs(p)), pole = Math.exp(-sampleTime / lag), r = lead / lag;
    return single("lead_lag->discrete_state_space(zoh-exact)", id, "sl.discrete_state_space", {
      A: num(pole), B: num(1 - pole), C: num(k * (1 - r)), D: num(k * r), InitialCondition: num(x0), SampleTime: sampleTime,
    }, ["in"]);
  },

  // Entrada atrasada (valor `initial` antes de theta) -> primeira ordem com x0 = initial.
  "control.fopdt": (id, p) => fopdtSubsystem(id, legacyNumber(p, "gain", 1), legacyNumber(p, "tau", 1), legacyNumber(p, "delay", 0.1), legacyNumber(p, "initial", 0), legacyPeriodNs(p)),

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
    if (delegate === "control.first_order") {
      const block = firstOrderBlock(legacyNumber(p, "gain", 1), legacyNumber(p, "tau", 1), legacyNumber(p, "initial", 0), legacyPeriodNs(p));
      return single(`transfer_function(${model})->${block.rule}`, id, block.typeId, block.properties, ["in"]);
    }
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

  // y = C max(0, u)^n. max(0,u) = (u + abs(u))/2, então Fcn reproduz a
  // característica sem introduzir um estágio de saturação no caminho de simulação.
  "control.valve_characteristic": (id, p) => {
    const expression = `${num(legacyNumber(p, "coefficient", 1))}*((u(1)+abs(u(1)))/2)^${num(legacyNumber(p, "exponent", 1))}`;
    return single("valve_characteristic->fcn(abs)", id, "sl.fcn", { Expr: expression, ...sampled(p) }, ["in"]);
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

  // O wrapper antigo lê e publica em tempos discretos, embora a rampa seja contínua entre amostras.
  // Retemos a entrada e a saída nos hits do período legado para conservar essa fase de publicação.
  "control.rate_limiter": (id, p): Conversion => {
    const rise = legacyNumber(p, "riseRate", 1), fall = legacyNumber(p, "fallRate", 1), initial = legacyNumber(p, "initial", 0);
    const period = seconds(legacyPeriodNs(p));
    return {
      kind: "subsystem", rule: "rate_limiter->unit_delay(input-phase)+rate_limiter(discrete)",
      definition: {
        key: "rate-limiter", typeId: "subsystem.legado_limitador_taxa", name: "Limitador de taxa (convertido)",
        inputs: [{ pinId: "in", label: "IN" }], outputs: [{ pinId: "out", label: "OUT" }],
        blocks: [
          { id: "sampled_input", typeId: "sl.unit_delay", properties: { InitialCondition: num(initial), SampleTime: period }, x: 120, y: 60, perInstance: ["InitialCondition", "SampleTime"] },
          { id: "limiter", typeId: "sl.rate_limiter", properties: { RisingSlewLimit: num(rise), FallingSlewLimit: num(-fall), InitialCondition: num(initial) }, x: 230, y: 60, perInstance: ["RisingSlewLimit", "FallingSlewLimit", "InitialCondition"] },
        ],
        wires: [{ from: { componentId: "in:in", port: "value" }, to: { componentId: "sampled_input", port: "in1" } }, { from: { componentId: "sampled_input", port: "out1" }, to: { componentId: "limiter", port: "in1" } }, { from: { componentId: "limiter", port: "out1" }, to: { componentId: "out:out", port: "value" } }],
      },
      overrides: { "@sampled_input.InitialCondition": num(initial), "@sampled_input.SampleTime": period, "@limiter.RisingSlewLimit": num(rise), "@limiter.FallingSlewLimit": num(-fall), "@limiter.InitialCondition": num(initial) },
    };
  },

  "control.calc_expression": (id, p, typeId) => convertCalcExpression(id, p, typeId),

  // O legado observava e repassava o sinal. O Core não permite derivar uma
  // conexão da porta de entrada de outro bloco; o ganho unitário preserva o
  // sinal nomeado e sua saída sem criar um ramo inválido para sl.display.
  "control.observer": (id) => single("observer->identity-gain", id, "sl.gain", { Gain: "1" }, ["in"]),
  "control.probe": (id, p) => single("probe->signal_conversion", id, "sl.signal_conversion", {}, ["in"]),

  // Parâmetro de modelo (SignalConstant): valor editável com a simulação rodando, unidade e lista de
  // opções, exportado como campo do subsistema. É o papel de um PARÂMETRO DE MÁSCARA do Simulink, não
  // do bloco Constant (que não tem unidade nem opções): continua bloco do LasecSimul, sem conversão.
  "control.constant": () => ({ kind: "keep", rule: "constant (parametro de modelo do LasecSimul, equivalente a parametro de mascara)", reason: "nao e bloco da biblioteca de controle" }),

  "control.process": (id, p) => processSubsystem(p),

  "control.pid": (id, p) => pidSubsystem(p),
  "control.pid_station": (id, p) => pidStationSubsystem(p),
};

// ------------------------------------------------------------------ PID

/**
 * PID legado (SignalEngine `Pid`, padrões do Core: kc 1, ti 0, td 0, bias 0, Tf 0.1, faixa 0..100,
 * action 1, derivada na PV, I0 0) -> Discrete PID Controller (2DOF), forma paralela, Backward Euler no
 * integrador e no filtro, condição inicial EXTERNA na saída do integrador (I0 = bias + integral
 * inicial: o bias entra no estado, como no legado, e por isso a saturação o inclui), clamping, b = 1,
 * c = 0 (derivada na PV) ou 1 (derivada do erro), D0 = D·(c·sp − pv). Mapeamento verificado contra o
 * bloco legado real em `core/test/core/library/PidBlocksTest.cpp::legacyPidMapping` (erro relativo
 * máximo 7e-16, com saturação, os dois sinais de ação e os dois modos de derivada).
 * As propriedades `remoteSpEnabled`/`feedForwardEnabled`/`autoMode` (importação TDPS) nunca foram
 * lidas pelo Core legado: não têm efeito a reproduzir.
 */
function pidSubsystem(p: LegacyProperties): Conversion {
  const kc = legacyNumber(p, "kc", 1), ti = legacyNumber(p, "ti", 0), td = legacyNumber(p, "td", 0);
  const bias = legacyNumber(p, "bias", 0), tf = legacyNumber(p, "derivativeFilter", 0.1);
  const minimum = legacyNumber(p, "outputMin", 0), maximum = legacyNumber(p, "outputMax", 100);
  const action = legacyNumber(p, "action", 1), derivativeOnPv = legacyBoolean(p, "derivativeOnPv", true);
  const initialIntegral = legacyNumber(p, "initialIntegral", 0);
  const manual = legacyBoolean(p, "manual", false), localMode = legacyBoolean(p, "localMode", false);
  const manualOutput = legacyNumber(p, "manualOutput", 0), localSetpoint = legacyNumber(p, "localSetpoint", 50);
  // Recusas do próprio Core legado: o bloco nunca simulou com estes valores.
  if (ti < 0 || td < 0 || (td > 0 && !(tf > 0)) || minimum > maximum || action === 0)
    return { kind: "unsupported", rule: "pid", reason: "parametros que o Core legado tambem recusava (ti/td negativos, td>0 sem filtro, min>max ou action=0)" };
  const period = seconds(legacyPeriodNs(p));
  const inputs = [{ pinId: "sp", label: "SP" }, { pinId: "pv", label: "PV" }];
  const outputs = [{ pinId: "out", label: "OUT" }];
  const tunnel = (pin: string): Endpoint => ({ componentId: `in:${pin}`, port: "value" });
  if (manual) {
    // Manual estático: saída = clamp(MO) a cada amostra; SP/PV sem efeito (Terminator).
    const value = Math.min(maximum, Math.max(minimum, manualOutput));
    return {
      kind: "subsystem", rule: "pid(manual)->constant",
      definition: {
        key: "pid-manual", typeId: "subsystem.legado_pid_manual", name: "PID em manual (convertido)", inputs, outputs,
        blocks: [
          { id: "manual_output", typeId: "sl.constant", properties: { Value: num(value), SampleTime: period }, x: 200, y: 60, perInstance: ["Value", "SampleTime"] },
          { id: "sp_unused", typeId: "sl.terminator", properties: {}, x: 120, y: 140 },
          { id: "pv_unused", typeId: "sl.terminator", properties: {}, x: 120, y: 200 },
        ],
        wires: [
          { from: tunnel("sp"), to: { componentId: "sp_unused", port: "in1" } },
          { from: tunnel("pv"), to: { componentId: "pv_unused", port: "in1" } },
          { from: { componentId: "manual_output", port: "out1" }, to: { componentId: "out:out", port: "value" } },
        ],
      },
      overrides: { "@manual_output.Value": num(value), "@manual_output.SampleTime": period },
    };
  }
  const P = action * kc;
  const I = ti > 0 ? action * kc / ti : 0;
  const D = td > 0 ? (derivativeOnPv ? kc * td : action * kc * td) : 0;
  const N = tf > 0 ? 1 / tf : 100;
  const blocks: CompositeBlock[] = [
    {
      id: "pid", typeId: "sl.discrete_pid_controller_2dof", x: 260, y: 80,
      properties: {
        Controller: "PID", Form: "Parallel", P: num(P), I: num(I), D: num(D), N: num(N), b: "1", c: derivativeOnPv ? "0" : "1",
        SampleTime: period, IntegratorMethod: "Backward Euler", FilterMethod: "Backward Euler",
        InitialConditionSource: "external", InitialConditionSetting: "Output",
        LimitOutput: true, UpperSaturationLimit: num(maximum), LowerSaturationLimit: num(minimum), AntiWindupMode: "clamping",
      },
      perInstance: ["P", "I", "D", "N", "SampleTime", "UpperSaturationLimit", "LowerSaturationLimit"],
    },
    { id: "i0", typeId: "sl.constant", properties: { Value: num(bias + initialIntegral), SampleTime: "inf" }, x: 140, y: 160, perInstance: ["Value"] },
    { id: "d0", typeId: "sl.gain", properties: { Gain: num(derivativeOnPv ? -D : D) }, x: 160, y: 220, perInstance: ["Gain"] },
  ];
  const reference: Endpoint = localMode ? { componentId: "local_sp", port: "out1" } : tunnel("sp");
  const wires: Array<{ from: Endpoint; to: Endpoint }> = [
    { from: reference, to: { componentId: "pid", port: "in1" } },
    { from: tunnel("pv"), to: { componentId: "pid", port: "in2" } },
    { from: { componentId: "i0", port: "out1" }, to: { componentId: "pid", port: "i0" } },
    { from: { componentId: "d0", port: "out1" }, to: { componentId: "pid", port: "d0" } },
    { from: { componentId: "pid", port: "out1" }, to: { componentId: "out:out", port: "value" } },
  ];
  if (localMode) {
    // SP local estático: a referência é uma Constant; o SP remoto não tem efeito.
    blocks.push({ id: "local_sp", typeId: "sl.constant", properties: { Value: num(localSetpoint), SampleTime: "inf" }, x: 100, y: 60, perInstance: ["Value"] });
    blocks.push({ id: "sp_unused", typeId: "sl.terminator", properties: {}, x: 100, y: 20 });
    wires.push({ from: tunnel("sp"), to: { componentId: "sp_unused", port: "in1" } });
  }
  if (derivativeOnPv) {
    wires.push({ from: tunnel("pv"), to: { componentId: "d0", port: "in1" } });
  } else {
    blocks.push({ id: "error", typeId: "sl.sum", properties: { IconShape: "rectangular", Inputs: "|+-" }, x: 100, y: 220 });
    wires.push({ from: reference, to: { componentId: "error", port: "in1" } });
    wires.push({ from: tunnel("pv"), to: { componentId: "error", port: "in2" } });
    wires.push({ from: { componentId: "error", port: "out1" }, to: { componentId: "d0", port: "in1" } });
  }
  const overrides: BlockProps = {};
  for (const block of blocks) for (const name of block.perInstance ?? []) overrides[`@${block.id}.${name}`] = block.properties[name]!;
  const variant = `${derivativeOnPv ? "dpv" : "derro"}${localMode ? "_local" : ""}`;
  return {
    kind: "subsystem", rule: `pid->discrete_pid_controller_2dof(${derivativeOnPv ? "D na PV" : "D no erro"}${localMode ? ", SP local" : ""})`,
    definition: { key: `pid-${variant}`, typeId: `subsystem.legado_pid_${variant}`, name: "PID (convertido)", inputs, outputs, blocks, wires },
    overrides,
  };
}

/** Estação PID legada: AM seleciona automático/manual e LR seleciona SP local/remoto.
 * A lógica reproduz as quatro portas do SignalMathBlock e mantém o ID do componente externo. */
function pidStationSubsystem(p: LegacyProperties): Conversion {
  const kc = legacyNumber(p, "kc", 1), ti = legacyNumber(p, "ti", 10), td = legacyNumber(p, "td", 0);
  const bias = legacyNumber(p, "bias", 0), tf = legacyNumber(p, "derivativeFilter", 0.1);
  const minimum = legacyNumber(p, "outputMin", 0), maximum = legacyNumber(p, "outputMax", 100);
  const action = legacyNumber(p, "action", 1), derivativeOnPv = legacyBoolean(p, "derivativeOnPv", true);
  const initialIntegral = legacyNumber(p, "initialIntegral", 0);
  const manualOutput = legacyNumber(p, "manualOutput", 0), localSetpoint = legacyNumber(p, "localSetpoint", 50);
  if (ti < 0 || td < 0 || (td > 0 && !(tf > 0)) || minimum > maximum || action === 0)
    return { kind: "unsupported", rule: "pid_station", reason: "parametros que o Core legado tambem recusava" };
  const period = seconds(legacyPeriodNs(p));
  const D = td > 0 ? (derivativeOnPv ? kc * td : action * kc * td) : 0;
  const clampedManual = Math.min(maximum, Math.max(minimum, manualOutput));
  const inputs = ["sp", "pv", "am", "lr"].map((pin) => ({ pinId: pin, label: pin.toUpperCase() }));
  const outputs = [{ pinId: "out", label: "OUT" }];
  const from = (componentId: string, port = "out1"): Endpoint => ({ componentId, port });
  const to = (componentId: string, port: string): Endpoint => ({ componentId, port });
  const tunnel = (pin: string): Endpoint => ({ componentId: `in:${pin}`, port: "value" });
  const sampled = ["am", "lr"].map((pin, i): CompositeBlock => ({
    id: `${pin}_hold`, typeId: "sl.zero_order_hold", properties: { SampleTime: period }, x: 60, y: 120 + i * 100,
    perInstance: ["SampleTime"],
  }));
  const blocks: CompositeBlock[] = [
    ...sampled,
    { id: "local_sp", typeId: "sl.constant", properties: { Value: num(localSetpoint), SampleTime: "inf" }, x: 120, y: 50, perInstance: ["Value"] },
    { id: "reference", typeId: "sl.switch", properties: { Criteria: "u2 >= Threshold", Threshold: "0.5" }, x: 200, y: 80 },
    { id: "error", typeId: "sl.sum", properties: { IconShape: "rectangular", Inputs: "+-", SampleTime: period }, x: 280, y: 80 },
    { id: "proportional", typeId: "sl.gain", properties: { Gain: num(action * kc) }, x: 360, y: 200, perInstance: ["Gain"] },
    { id: "manual_output", typeId: "sl.constant", properties: { Value: num(clampedManual), SampleTime: "inf" }, x: 360, y: 250, perInstance: ["Value"] },
    { id: "tracking_i0", typeId: "sl.sum", properties: { IconShape: "rectangular", Inputs: "+-", SampleTime: period }, x: 440, y: 210 },
    { id: "automatic_i0", typeId: "sl.constant", properties: { Value: num(bias + initialIntegral), SampleTime: "inf" }, x: 360, y: 310, perInstance: ["Value"] },
    { id: "i0", typeId: "sl.switch", properties: { Criteria: "u2 >= Threshold", Threshold: "0.5" }, x: 520, y: 210 },
    { id: "reset_memory", typeId: "sl.unit_delay", properties: { InitialCondition: "1", SampleTime: period }, x: 440, y: 390, perInstance: ["SampleTime"] },
    { id: "reset_invert", typeId: "sl.gain", properties: { Gain: "-1" }, x: 520, y: 390 },
    { id: "reset", typeId: "sl.switch", properties: { Criteria: "u2 >= Threshold", Threshold: "0.5" }, x: 600, y: 390 },
    { id: "d0", typeId: "sl.gain", properties: { Gain: num(derivativeOnPv ? -D : D) }, x: 440, y: 470, perInstance: ["Gain"] },
    { id: "pid", typeId: "sl.discrete_pid_controller_2dof", properties: {
      Controller: "PID", Form: "Parallel", P: num(action * kc), I: num(ti > 0 ? action * kc / ti : 0), D: num(D), N: num(tf > 0 ? 1 / tf : 100), b: "1", c: derivativeOnPv ? "0" : "1",
      SampleTime: period, IntegratorMethod: "Backward Euler", FilterMethod: "Backward Euler", InitialConditionSource: "external", InitialConditionSetting: "Output",
      ExternalReset: "either", LimitOutput: true, UpperSaturationLimit: num(maximum), LowerSaturationLimit: num(minimum), AntiWindupMode: "clamping",
    }, x: 700, y: 140, perInstance: ["P", "I", "D", "N", "SampleTime", "UpperSaturationLimit", "LowerSaturationLimit"] },
    { id: "output", typeId: "sl.switch", properties: { Criteria: "u2 >= Threshold", Threshold: "0.5" }, x: 820, y: 160 },
  ];
  const wires = [
    { from: tunnel("am"), to: to("am_hold", "in1") }, { from: tunnel("lr"), to: to("lr_hold", "in1") },
    { from: from("local_sp"), to: to("reference", "in1") }, { from: from("lr_hold"), to: to("reference", "in2") }, { from: tunnel("sp"), to: to("reference", "in3") },
    { from: from("reference"), to: to("error", "in1") }, { from: tunnel("pv"), to: to("error", "in2") },
    { from: from("error"), to: to("proportional", "in1") }, { from: from("manual_output"), to: to("tracking_i0", "in1") }, { from: from("proportional"), to: to("tracking_i0", "in2") },
    { from: from("automatic_i0"), to: to("i0", "in1") }, { from: from("am_hold"), to: to("i0", "in2") }, { from: from("tracking_i0"), to: to("i0", "in3") },
    { from: from("reset_memory"), to: to("reset_invert", "in1") }, { from: from("reset_memory"), to: to("reset", "in1") }, { from: from("am_hold"), to: to("reset", "in2") }, { from: from("reset_invert"), to: to("reset", "in3") },
    { from: from("reset"), to: to("reset_memory", "in1") },
    { from: derivativeOnPv ? tunnel("pv") : from("error"), to: to("d0", "in1") },
    { from: from("reference"), to: to("pid", "in1") }, { from: tunnel("pv"), to: to("pid", "in2") }, { from: from("reset"), to: to("pid", "reset") }, { from: from("i0"), to: to("pid", "i0") }, { from: from("d0"), to: to("pid", "d0") },
    { from: from("pid"), to: to("output", "in1") }, { from: from("am_hold"), to: to("output", "in2") }, { from: from("manual_output"), to: to("output", "in3") }, { from: from("output"), to: { componentId: "out:out", port: "value" } },
  ];
  return { kind: "subsystem", rule: "pid_station->sampled-2dof-pid-manual-local", definition: {
    key: "pid-station", typeId: "subsystem.legado_pid_station", name: "Estação PID (convertida)", inputs, outputs, blocks, wires,
  }, overrides: {
    "@am_hold.SampleTime": period, "@lr_hold.SampleTime": period, "@local_sp.Value": num(localSetpoint), "@proportional.Gain": num(action * kc),
    "@manual_output.Value": num(clampedManual), "@automatic_i0.Value": num(bias + initialIntegral), "@reset_memory.SampleTime": period,
    "@d0.Gain": num(derivativeOnPv ? -D : D), "@pid.P": num(action * kc), "@pid.I": num(ti > 0 ? action * kc / ti : 0), "@pid.D": num(D), "@pid.N": num(tf > 0 ? 1 / tf : 100), "@pid.SampleTime": period,
    "@pid.UpperSaturationLimit": num(maximum), "@pid.LowerSaturationLimit": num(minimum),
  } };
}

// ------------------------------------------------------------------ composições

function fopdtSubsystem(id: string, gain: number, tau: number, delay: number, initial: number, periodNs: number): Conversion {
  const plant = firstOrderBlock(gain, tau, initial, periodNs);
  const delayId = `${id}__delay`;
  return {
    kind: "inline", rule: `fopdt->transport_delay+${plant.typeId.slice(3)}`,
    blocks: [
      { id: delayId, typeId: "sl.transport_delay", properties: { DelayTime: num(delay), InitialOutput: num(initial) }, dx: -100 },
      { id, typeId: plant.typeId, properties: plant.properties },
    ],
    wires: [{ from: { componentId: delayId, port: "out1" }, to: { componentId: id, port: "in1" } }],
    inputs: { in: { componentId: delayId, port: "in1" } },
    outputs: { out: { componentId: id, port: "out1" } },
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
export const PENDING_LEGACY_TYPES = new Set<string>();

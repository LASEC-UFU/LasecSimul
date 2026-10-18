/**
 * Definição persistida do Laboratório de Cálculo (`calculusLab` no `.lsproj`; ADR 0015).
 *
 * Só a DEFINIÇÃO é persistida: expressões em texto, parâmetros e faixas, perguntas e etapas. Cursor, Δt,
 * vistas, séries e respostas de alunos são estado transitório da Webview. Atividades são tipadas por
 * `kind`; o editor de atividades (M6) edita estes mesmos tipos.
 */
import { PLANTS, validatePlantParameters, type ParameterValues, type ProcessKind } from "./plants.js";

export const CALCULUS_LAB_SCHEMA_VERSION = 1 as const;

export type StepPhase = "predict" | "explore" | "formalize" | "apply";
export const STEP_PHASES: readonly StepPhase[] = ["predict", "explore", "formalize", "apply"];
export const STEP_PHASE_LABEL: Readonly<Record<StepPhase, string>> = { predict: "Prever", explore: "Explorar", formalize: "Formalizar", apply: "Aplicar" };

/** Etapa da sequência do aluno (docs/51 §5): pergunta, fase e dicas. */
export interface ActivityStep { id: string; phase: StepPhase; prompt: string; hints: string[] }

interface ActivityBase { id: string; title: string; question: string; steps: ActivityStep[] }

/** "Limites": quociente incremental de um modelo h(t) em torno de t = a (+ ε–δ). */
export interface LimitsActivity extends ActivityBase {
  kind: "limits";
  /** Variável do modelo (ex.: "t"). */
  variable: string;
  units: { x: string; y: string };
  /** Modelo em sintaxe linear do núcleo (ex.: "0.5t^2"). */
  model: string;
  a: number;
  domain: [number, number];
  /** Linhas fixas da tabela de aproximação (|Δt|). */
  rows: number[];
  initialDelta: number;
  /** ε inicial do modo ε–δ. */
  epsilon: number;
}

export interface FunctionParameter { name: string; min: number; max: number; step: number; value: number }

/** Explorador de funções (pré-cálculo, docs/52 §4.7): f e g com parâmetros, derivada, integral, assíntotas. */
export interface FunctionsActivity extends ActivityBase {
  kind: "functions";
  variable: string;
  f: string;
  /** Segunda função para interseções; vazio = sem g. */
  g: string;
  parameters: FunctionParameter[];
  domain: [number, number];
  range: [number, number];
  show: { derivative: boolean; integral: boolean; asymptotes: boolean; roots: boolean; table: boolean };
  /** Limite inferior a da função integral F(x) = ∫ₐˣ f. */
  integralFrom: number;
  tableStep: number;
}

/** Experimento C (docs/53 §1): eixo com trajetória S x(t) = L(3τ² − 2τ³), τ = t/T. Só Webview. */
export interface AxisActivity extends ActivityBase { kind: "axis"; L: number; T: number; t0: number }

export type RiemannMethod = "left" | "right" | "midpoint" | "trapezoid";

/** Atividades com processo no Core (subcircuito do projeto) — ver `plants.ts`. */
interface ProcessActivityBase extends ActivityBase {
  /** Instância do subcircuito no projeto; ausente = a única encontrada (auditoria aponta ambiguidades). */
  plantComponentId?: string;
  /** Valores iniciais autorados (Reiniciar volta a eles). */
  parameters: ParameterValues;
}
export interface TankActivity extends ProcessActivityBase { kind: "tank"; riemann: { a: number; b: number; n: number; method: RiemannMethod } }
export interface FirstOrderActivity extends ProcessActivityBase { kind: "firstOrder" }
export interface SensorActivity extends ProcessActivityBase { kind: "sensor" }

export type ProcessActivity = TankActivity | FirstOrderActivity | SensorActivity;
export type LabActivity = LimitsActivity | FunctionsActivity | AxisActivity | ProcessActivity;
export type LabActivityKind = LabActivity["kind"];

export const isProcessActivity = (activity: LabActivity): activity is ProcessActivity =>
  activity.kind === "tank" || activity.kind === "firstOrder" || activity.kind === "sensor";

export const ACTIVITY_KIND_LABEL: Readonly<Record<LabActivityKind, string>> = {
  functions: "Funções", sensor: "Sensor 4–20 mA", limits: "Limites", axis: "Eixo (derivadas)", firstOrder: "Primeira ordem", tank: "Tanque (integrais)",
};

export interface CalculusLab {
  schemaVersion: typeof CALCULUS_LAB_SCHEMA_VERSION;
  activities: LabActivity[];
}

const step = (id: string, phase: StepPhase, prompt: string, hints: string[] = []): ActivityStep => ({ id, phase, prompt, hints });

/** Atividade da meta visual de Limites (docs/56): velocidade de subida da água aos 4 s. */
export function defaultLimitsActivity(): LimitsActivity {
  return {
    id: "limites-velocidade-4s", kind: "limits",
    title: "Limites — velocidade de subida aos 4 s",
    question: "Qual é a velocidade de subida da água aos 4 segundos?",
    variable: "t", units: { x: "s", y: "cm" }, model: "0.5t^2", a: 4, domain: [0, 6], rows: [1, 0.1, 0.01], initialDelta: 0.5, epsilon: 0.5,
    steps: [
      step("prever", "predict", "Antes de mexer: a velocidade aos 4 s é maior ou menor que a velocidade média entre 0 e 4 s?"),
      step("aproximar", "explore", "Aproxime Q de P pela direita e pela esquerda. O que acontece com a taxa média?", ["Use a tabela: compare as linhas com Δt = 0,1 e 0,01."]),
      step("formalizar", "formalize", "Escreva o limite do quociente incremental e calcule-o com a calculadora.", ["Teclado › Cálculo › lim"]),
      step("epsilon", "apply", "Modo ε–δ: para ε = 0,1, que δ garante |taxa − L| < ε?"),
    ],
  };
}

export function defaultFunctionsActivity(): FunctionsActivity {
  return {
    id: "funcoes-explorador", kind: "functions",
    title: "Funções — explorador",
    question: "Como os parâmetros a, b e c mudam o gráfico de f(x) = a·x² + b·x + c?",
    variable: "x", f: "a x^2 + b x + c", g: "x + 1",
    parameters: [
      { name: "a", min: -3, max: 3, step: 0.1, value: 1 },
      { name: "b", min: -5, max: 5, step: 0.1, value: 0 },
      { name: "c", min: -5, max: 5, step: 0.1, value: -2 },
    ],
    domain: [-5, 5], range: [-6, 10],
    show: { derivative: false, integral: false, asymptotes: true, roots: true, table: true },
    integralFrom: 0, tableStep: 1,
    steps: [
      step("prever", "predict", "Prever: o que acontece com a parábola quando a fica negativo?"),
      step("raizes", "explore", "Encontre valores de c para os quais f não tem raízes reais."),
      step("intersecao", "explore", "Onde f cruza g(x) = x + 1? Compare com a tabela."),
      step("derivada", "formalize", "Ligue f′: onde f′(x) = 0, o que acontece com f?"),
    ],
  };
}

export function defaultAxisActivity(): AxisActivity {
  return {
    id: "eixo-trajetoria", kind: "axis",
    title: "Eixo — posição, velocidade e aceleração",
    question: "Quando a velocidade do eixo é zero e onde a aceleração é máxima?",
    L: 200, T: 4, t0: 1,
    steps: [
      step("prever", "predict", "Prever: em que instante o eixo anda mais rápido?"),
      step("tangente", "explore", "Mova t₀: a reta tangente a x(t) aproxima a posição perto de t₀?"),
      step("derivadas", "formalize", "Compare v(t) com a inclinação de x(t) e a(t) com a inclinação de v(t)."),
    ],
  };
}

/** Vertical do tanque (docs/53 §2.5). */
export function defaultTankActivity(): TankActivity {
  return {
    id: "tanque-vazao-integral", kind: "tank",
    title: "Tanque — da vazão à integral",
    question: "Com 1 L/s entrando e 0,4 L/s saindo, quanto o volume aumenta em 10 s?",
    parameters: { ...PLANTS.tank.defaults },
    riemann: { a: 5, b: 25, n: 10, method: "left" },
    steps: [
      step("prever", "predict", "Com 1 L/s entrando e 0,4 L/s saindo, quanto o volume aumenta em 10 s?"),
      step("medir", "explore", "Execute e marque a = 0 s e b = 10 s: ΔV e a inclinação da secante batem com q?", ["Com q constante, qualquer Riemann é exato — por quê?"]),
      step("mudar", "explore", "Mude a vazão de entrada durante a execução: o que acontece com V e com q no instante da mudança?"),
      step("valvula", "formalize", "Reinicie com a válvula (q = k·h): compare Riemann à esquerda, à direita e trapézio com V(b) − V(a)."),
      step("area", "apply", "Mude a área A durante a execução: h salta, V não. Explique com h = V/A."),
    ],
  };
}

export function defaultFirstOrderActivity(): FirstOrderActivity {
  return {
    id: "primeira-ordem", kind: "firstOrder",
    title: "Primeira ordem — exponencial",
    question: "Em que instante a resposta alcança 63,2 % do salto?",
    parameters: { ...PLANTS.firstOrder.defaults },
    steps: [
      step("prever", "predict", "Prever: qual o valor final de y para K = 2 e u = 1?"),
      step("tau", "explore", "Ache o instante em que y cruza a linha de 63,2 %. Compare com τ."),
      step("tangente", "formalize", "A tangente em t = 0 cruza o valor final em t = τ? Verifique."),
      step("degrau", "apply", "Mude u durante a execução: só o futuro muda?"),
    ],
  };
}

export function defaultSensorActivity(): SensorActivity {
  return {
    id: "sensor-4-20", kind: "sensor",
    title: "Sensor 4–20 mA — função afim",
    question: "Que pressão produz 12 mA? O que acontece acima de Pmax?",
    parameters: { ...PLANTS.sensor.defaults },
    steps: [
      step("prever", "predict", "Prever: com faixa 0–200 kPa, quanto vale I em 50 kPa?"),
      step("doze", "explore", "Mova P até 12 mA. Escreva a inversa P(I)."),
      step("saturacao", "apply", "Passe de Pmax: o que a corrente faz? E o valor sem saturação?"),
    ],
  };
}

/** Uma atividade-modelo por tipo, na ordem pedagógica (docs/52 §1). */
export function defaultActivities(): LabActivity[] {
  return [defaultFunctionsActivity(), defaultSensorActivity(), defaultLimitsActivity(), defaultAxisActivity(), defaultFirstOrderActivity(), defaultTankActivity()];
}

export function defaultActivity(kind: LabActivityKind): LabActivity {
  return defaultActivities().find((activity) => activity.kind === kind)!;
}

export function defaultCalculusLab(): CalculusLab {
  return { schemaVersion: CALCULUS_LAB_SCHEMA_VERSION, activities: defaultActivities() };
}

// ------------------------------------------------------------------ validação
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 500): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRange = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]) && value[1] > value[0];
const KINDS: readonly LabActivityKind[] = ["functions", "sensor", "limits", "axis", "firstOrder", "tank"];
const RIEMANN_METHODS: readonly RiemannMethod[] = ["left", "right", "midpoint", "trapezoid"];

/**
 * Validação estrutural no load/save do projeto. Erros de forma rejeitam o campo com mensagem com caminho
 * (mesmo estilo de `validateHmiApplication`). Expressões malformadas NÃO derrubam o projeto: são
 * apontadas pela própria interface do laboratório ao abrir a atividade.
 */
export function validateCalculusLab(value: unknown): CalculusLab | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || value.schemaVersion !== CALCULUS_LAB_SCHEMA_VERSION || !Array.isArray(value.activities)) {
    throw new Error(`calculusLab inválido: esperado { schemaVersion: ${CALCULUS_LAB_SCHEMA_VERSION}, activities: [...] }`);
  }
  const ids = new Set<string>();
  const activities = value.activities.map((raw, index) => {
    const context = `calculusLab.activities[${index}]`;
    if (!isObject(raw) || !isText(raw.id, 80) || !KINDS.includes(raw.kind as LabActivityKind)) {
      throw new Error(`${context} precisa de id e kind (${KINDS.join(", ")})`);
    }
    if (ids.has(raw.id)) throw new Error(`calculusLab contém atividade duplicada: ${raw.id}`);
    ids.add(raw.id);
    if (!isText(raw.title, 200) || !isText(raw.question, 500)) throw new Error(`${context} precisa de title e question`);
    const base = { id: raw.id, title: raw.title, question: raw.question, steps: validateSteps(raw.steps, context) };
    switch (raw.kind as LabActivityKind) {
      case "limits": return validateLimits(raw, base, context);
      case "functions": return validateFunctions(raw, base, context);
      case "axis": return validateAxis(raw, base, context);
      default: return validateProcess(raw, base, context);
    }
  });
  return { schemaVersion: CALCULUS_LAB_SCHEMA_VERSION, activities };
}

function validateSteps(raw: unknown, context: string): ActivityStep[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new Error(`${context}.steps precisa ser uma lista de até 20 etapas`);
  const ids = new Set<string>();
  return raw.map((item, index) => {
    const at = `${context}.steps[${index}]`;
    if (!isObject(item) || !isText(item.id, 80) || !STEP_PHASES.includes(item.phase as StepPhase) || !isText(item.prompt, 600)) {
      throw new Error(`${at} precisa de id, phase (${STEP_PHASES.join(", ")}) e prompt`);
    }
    if (ids.has(item.id)) throw new Error(`${at}: id de etapa duplicado`);
    ids.add(item.id);
    const hints = item.hints === undefined ? [] : item.hints;
    if (!Array.isArray(hints) || hints.length > 8 || !hints.every((h) => isText(h, 400))) throw new Error(`${at}.hints precisa de até 8 textos`);
    return { id: item.id, phase: item.phase as StepPhase, prompt: item.prompt, hints: hints as string[] };
  });
}

type Base = Pick<ActivityBase, "id" | "title" | "question" | "steps">;

function validateLimits(raw: Record<string, unknown>, base: Base, context: string): LimitsActivity {
  const units = raw.units;
  const domain = raw.domain;
  if (!isText(raw.variable, 8) || !/^[A-Za-zΔ][A-Za-z0-9Δ_]*$/.test(raw.variable)) throw new Error(`${context}.variable inválida`);
  if (!isObject(units) || typeof units.x !== "string" || typeof units.y !== "string") throw new Error(`${context}.units precisa de x e y`);
  if (!isText(raw.model, 400)) throw new Error(`${context}.model precisa de uma expressão`);
  if (!isFiniteNumber(raw.a) || !isFiniteNumber(raw.initialDelta)) throw new Error(`${context} precisa de a e initialDelta numéricos`);
  if (!isRange(domain)) throw new Error(`${context}.domain precisa ser [min, max] com max > min`);
  if (!(raw.a >= domain[0] && raw.a <= domain[1])) throw new Error(`${context}.a precisa estar dentro do domínio`);
  if (!Array.isArray(raw.rows) || raw.rows.length > 8 || !raw.rows.every((r) => isFiniteNumber(r) && r > 0)) throw new Error(`${context}.rows precisa de até 8 valores positivos`);
  const epsilon = raw.epsilon === undefined ? 0.5 : raw.epsilon;
  if (!isFiniteNumber(epsilon) || !(epsilon > 0)) throw new Error(`${context}.epsilon precisa ser positivo`);
  return {
    ...base, kind: "limits", variable: raw.variable, units: { x: units.x, y: units.y }, model: raw.model, a: raw.a,
    domain: [domain[0], domain[1]], rows: raw.rows as number[], initialDelta: raw.initialDelta, epsilon,
  };
}

function validateFunctions(raw: Record<string, unknown>, base: Base, context: string): FunctionsActivity {
  if (!isText(raw.variable, 4) || !/^[a-z]$/.test(raw.variable)) throw new Error(`${context}.variable precisa ser uma letra minúscula`);
  if (!isText(raw.f, 400)) throw new Error(`${context}.f precisa de uma expressão`);
  if (typeof raw.g !== "string" || raw.g.length > 400) throw new Error(`${context}.g precisa ser texto (vazio = sem g)`);
  if (!Array.isArray(raw.parameters) || raw.parameters.length > 6) throw new Error(`${context}.parameters precisa de até 6 parâmetros`);
  const names = new Set<string>();
  const parameters = raw.parameters.map((p, index) => {
    const at = `${context}.parameters[${index}]`;
    if (!isObject(p) || typeof p.name !== "string" || !/^[a-z]$/.test(p.name) || p.name === raw.variable || p.name === "e") throw new Error(`${at}.name precisa ser uma letra (≠ variável, ≠ e)`);
    if (names.has(p.name)) throw new Error(`${at}: parâmetro repetido`);
    names.add(p.name);
    if (![p.min, p.max, p.step, p.value].every(isFiniteNumber) || !((p.max as number) > (p.min as number)) || !((p.step as number) > 0)
        || (p.value as number) < (p.min as number) || (p.value as number) > (p.max as number)) {
      throw new Error(`${at} precisa de min < max, step > 0 e valor dentro da faixa`);
    }
    return { name: p.name, min: p.min as number, max: p.max as number, step: p.step as number, value: p.value as number };
  });
  if (!isRange(raw.domain) || !isRange(raw.range)) throw new Error(`${context}.domain e .range precisam ser [min, max]`);
  const show = raw.show;
  if (!isObject(show) || !["derivative", "integral", "asymptotes", "roots", "table"].every((k) => typeof show[k] === "boolean")) {
    throw new Error(`${context}.show precisa dos booleanos derivative, integral, asymptotes, roots e table`);
  }
  if (!isFiniteNumber(raw.integralFrom) || !isFiniteNumber(raw.tableStep) || !(raw.tableStep > 0)) throw new Error(`${context} precisa de integralFrom e tableStep > 0`);
  return {
    ...base, kind: "functions", variable: raw.variable, f: raw.f, g: raw.g, parameters,
    domain: [raw.domain[0], raw.domain[1]], range: [raw.range[0], raw.range[1]],
    show: { derivative: show.derivative as boolean, integral: show.integral as boolean, asymptotes: show.asymptotes as boolean, roots: show.roots as boolean, table: show.table as boolean },
    integralFrom: raw.integralFrom, tableStep: raw.tableStep,
  };
}

function validateAxis(raw: Record<string, unknown>, base: Base, context: string): AxisActivity {
  if (!isFiniteNumber(raw.L) || !(raw.L > 0) || raw.L > 10000) throw new Error(`${context}.L precisa estar em (0, 10000] mm`);
  if (!isFiniteNumber(raw.T) || !(raw.T > 0) || raw.T > 600) throw new Error(`${context}.T precisa estar em (0, 600] s`);
  if (!isFiniteNumber(raw.t0) || raw.t0 < 0 || raw.t0 > raw.T) throw new Error(`${context}.t0 precisa estar em [0, T]`);
  return { ...base, kind: "axis", L: raw.L, T: raw.T, t0: raw.t0 };
}

function validateProcess(raw: Record<string, unknown>, base: Base, context: string): ProcessActivity {
  const kind = raw.kind as ProcessKind;
  if (raw.plantComponentId !== undefined && !isText(raw.plantComponentId, 200)) throw new Error(`${context}.plantComponentId inválido`);
  const parameters = validatePlantParameters(PLANTS[kind], raw.parameters);
  if (typeof parameters === "string") throw new Error(`${context}.parameters: ${parameters}`);
  const common = { ...base, ...(raw.plantComponentId !== undefined ? { plantComponentId: raw.plantComponentId as string } : {}), parameters };
  if (kind !== "tank") return { ...common, kind };
  const riemann = raw.riemann;
  if (!isObject(riemann) || !isFiniteNumber(riemann.a) || !isFiniteNumber(riemann.b) || !(riemann.b > riemann.a) || riemann.a < 0 ||
      !Number.isInteger(riemann.n) || (riemann.n as number) < 1 || (riemann.n as number) > 200 ||
      !RIEMANN_METHODS.includes(riemann.method as RiemannMethod)) {
    throw new Error(`${context}.riemann precisa de 0 <= a < b, n inteiro em [1, 200] e método left/right/midpoint/trapezoid`);
  }
  return { ...common, kind: "tank", riemann: { a: riemann.a, b: riemann.b, n: riemann.n as number, method: riemann.method as RiemannMethod } };
}

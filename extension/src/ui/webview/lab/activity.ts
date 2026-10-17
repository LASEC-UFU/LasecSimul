/**
 * Definição persistida do Laboratório de Cálculo (`calculusLab` no `.lsproj`; ADR 0015).
 *
 * Só a DEFINIÇÃO é persistida: expressões em texto, parâmetros e faixas, perguntas. Cursor, Δt, vistas,
 * séries e respostas de alunos são estado transitório da Webview. Atividades são tipadas por `kind`; o
 * contrato genérico de objetos/gráficos do editor de atividades (M6) estende esta união.
 */
import { DEFAULT_TANK_PARAMETERS, TANK_PARAMETERS, type TankParameterValues } from "./tankModel.js";

export const CALCULUS_LAB_SCHEMA_VERSION = 1 as const;

/** Atividade "Limites": quociente incremental de um modelo h(t) em torno de t = a. */
export interface LimitsActivity {
  id: string;
  kind: "limits";
  title: string;
  question: string;
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
}

export type RiemannMethod = "left" | "right" | "midpoint" | "trapezoid";

/** Atividade "Tanque — da vazão à integral" (docs/53 §2): processo no Core, séries gravadas. */
export interface TankActivity {
  id: string;
  kind: "tank";
  title: string;
  question: string;
  /** Instância de `subcircuits.process.hydraulic_tank` no projeto; ausente = a primeira encontrada. */
  plantComponentId?: string;
  /** Valores iniciais autorados (Reiniciar volta a eles). */
  parameters: TankParameterValues;
  riemann: { a: number; b: number; n: number; method: RiemannMethod };
}

export type LabActivity = LimitsActivity | TankActivity;
export type LabActivityKind = LabActivity["kind"];

export interface CalculusLab {
  schemaVersion: typeof CALCULUS_LAB_SCHEMA_VERSION;
  activities: LabActivity[];
}

/** Atividade da meta visual de Limites (docs/56): velocidade de subida da água aos 4 s. */
export function defaultLimitsActivity(): LimitsActivity {
  return {
    id: "limites-velocidade-4s",
    kind: "limits",
    title: "Limites — velocidade de subida aos 4 s",
    question: "Qual é a velocidade de subida da água aos 4 segundos?",
    variable: "t",
    units: { x: "s", y: "cm" },
    model: "0.5t^2",
    a: 4,
    domain: [0, 6],
    rows: [1, 0.1, 0.01],
    initialDelta: 0.5,
  };
}

/** Vertical do tanque (docs/53 §2.5, passos 1-2): prever e medir ΔV com vazões constantes. */
export function defaultTankActivity(): TankActivity {
  return {
    id: "tanque-vazao-integral",
    kind: "tank",
    title: "Tanque — da vazão à integral",
    question: "Com 1 L/s entrando e 0,4 L/s saindo, quanto o volume aumenta em 10 s?",
    parameters: { ...DEFAULT_TANK_PARAMETERS },
    riemann: { a: 5, b: 25, n: 10, method: "left" },
  };
}

/** Uma atividade-modelo por tipo; o laboratório mostra as que o projeto ainda não tem. */
export function defaultActivities(): LabActivity[] {
  return [defaultLimitsActivity(), defaultTankActivity()];
}

export function defaultCalculusLab(): CalculusLab {
  return { schemaVersion: CALCULUS_LAB_SCHEMA_VERSION, activities: defaultActivities() };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 500): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

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
    if (!isObject(raw) || !isText(raw.id, 80) || (raw.kind !== "limits" && raw.kind !== "tank")) {
      throw new Error(`${context} precisa de id e kind "limits" ou "tank"`);
    }
    if (ids.has(raw.id)) throw new Error(`calculusLab contém atividade duplicada: ${raw.id}`);
    ids.add(raw.id);
    return raw.kind === "tank" ? validateTankActivity(raw, context) : validateLimitsActivity(raw, context);
  });
  return { schemaVersion: CALCULUS_LAB_SCHEMA_VERSION, activities };
}

function validateLimitsActivity(raw: Record<string, unknown>, context: string): LimitsActivity {
  const units = raw.units;
  const domain = raw.domain;
  if (!isText(raw.title, 200) || !isText(raw.question, 500)) throw new Error(`${context} precisa de title e question`);
  if (!isText(raw.variable, 8) || !/^[A-Za-zΔ][A-Za-z0-9Δ_]*$/.test(raw.variable)) throw new Error(`${context}.variable inválida`);
  if (!isObject(units) || typeof units.x !== "string" || typeof units.y !== "string") throw new Error(`${context}.units precisa de x e y`);
  if (!isText(raw.model, 400)) throw new Error(`${context}.model precisa de uma expressão`);
  if (!isFiniteNumber(raw.a) || !isFiniteNumber(raw.initialDelta)) throw new Error(`${context} precisa de a e initialDelta numéricos`);
  if (!Array.isArray(domain) || domain.length !== 2 || !isFiniteNumber(domain[0]) || !isFiniteNumber(domain[1]) || !(domain[1] > domain[0])) {
    throw new Error(`${context}.domain precisa ser [min, max] com max > min`);
  }
  if (!(raw.a >= domain[0] && raw.a <= domain[1])) throw new Error(`${context}.a precisa estar dentro do domínio`);
  if (!Array.isArray(raw.rows) || raw.rows.length > 8 || !raw.rows.every((r) => isFiniteNumber(r) && r > 0)) throw new Error(`${context}.rows precisa de até 8 valores positivos`);
  return {
    id: raw.id as string, kind: "limits", title: raw.title, question: raw.question, variable: raw.variable,
    units: { x: units.x, y: units.y }, model: raw.model, a: raw.a, domain: [domain[0], domain[1]],
    rows: raw.rows as number[], initialDelta: raw.initialDelta,
  };
}

const RIEMANN_METHODS: readonly RiemannMethod[] = ["left", "right", "midpoint", "trapezoid"];

function validateTankActivity(raw: Record<string, unknown>, context: string): TankActivity {
  if (!isText(raw.title, 200) || !isText(raw.question, 500)) throw new Error(`${context} precisa de title e question`);
  if (raw.plantComponentId !== undefined && !isText(raw.plantComponentId, 200)) throw new Error(`${context}.plantComponentId inválido`);
  const parameters = raw.parameters;
  if (!isObject(parameters)) throw new Error(`${context}.parameters ausente`);
  const values = { ...DEFAULT_TANK_PARAMETERS };
  for (const spec of TANK_PARAMETERS) {
    const value = parameters[spec.id];
    if (!isFiniteNumber(value) || value < spec.min || value > spec.max) {
      throw new Error(`${context}.parameters.${spec.id} precisa estar em [${spec.min}, ${spec.max}]`);
    }
    values[spec.id] = value;
  }
  const riemann = raw.riemann;
  if (!isObject(riemann) || !isFiniteNumber(riemann.a) || !isFiniteNumber(riemann.b) || !(riemann.b > riemann.a) || riemann.a < 0 ||
      !Number.isInteger(riemann.n) || (riemann.n as number) < 1 || (riemann.n as number) > 200 ||
      !RIEMANN_METHODS.includes(riemann.method as RiemannMethod)) {
    throw new Error(`${context}.riemann precisa de 0 <= a < b, n inteiro em [1, 200] e método left/right/midpoint/trapezoid`);
  }
  return {
    id: raw.id as string, kind: "tank", title: raw.title, question: raw.question,
    ...(raw.plantComponentId !== undefined ? { plantComponentId: raw.plantComponentId as string } : {}),
    parameters: values,
    riemann: { a: riemann.a, b: riemann.b, n: riemann.n as number, method: riemann.method as RiemannMethod },
  };
}

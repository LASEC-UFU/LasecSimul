/**
 * Generic HMI action resolver.
 *
 * This module is intentionally unaware of the DOM, Core, HART, CTRL and TDPS.
 * It only converts persisted `graphics.*` action properties plus the current
 * target value into the next value. The Webview sends that result through the
 * existing `requestUpdateProperty` authority; no second variable system exists.
 */

export type GraphicalActionMode = "set" | "toggle" | "momentary" | "increment";
export type GraphicalActionPhase = "activate" | "press" | "release" | "input";
export type GraphicalActionValue = string | number | boolean;

export interface GraphicalActionConfig {
  targetId: string;
  property: string;
  mode: GraphicalActionMode;
  value: GraphicalActionValue;
  releaseValue: GraphicalActionValue;
  step: number;
  minimum?: number;
  maximum?: number;
}

const ACTION_TYPES = new Set([
  "graphics.hmi_button",
  "graphics.hmi_lamp_button",
  "graphics.hmi_toggle",
  "graphics.hmi_switch",
  "graphics.numeric_input",
  "graphics.slider",
  "graphics.setpoint",
]);

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function parseGraphicalActionValue(value: unknown): GraphicalActionValue {
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = String(value ?? "").trim();
  if (text === "true") return true;
  if (text === "false") return false;
  const numeric = Number(text);
  if (text !== "" && Number.isFinite(numeric)) return numeric;
  return text;
}

export function graphicalActionConfig(
  properties: Readonly<Record<string, string | number | boolean>>,
): GraphicalActionConfig | undefined {
  const targetId = String(properties.actionTarget ?? "").trim();
  const property = String(properties.actionProperty ?? "").trim();
  if (!targetId || !property) return undefined;
  const rawMode = String(properties.actionMode ?? "set");
  const mode: GraphicalActionMode = rawMode === "toggle" || rawMode === "momentary" || rawMode === "increment"
    ? rawMode
    : "set";
  const rawMinimum = properties.actionMin;
  const rawMaximum = properties.actionMax;
  const minimum = rawMinimum === "" || rawMinimum === undefined ? undefined : finiteNumber(rawMinimum, Number.NEGATIVE_INFINITY);
  const maximum = rawMaximum === "" || rawMaximum === undefined ? undefined : finiteNumber(rawMaximum, Number.POSITIVE_INFINITY);
  return {
    targetId,
    property,
    mode,
    value: parseGraphicalActionValue(properties.actionValue ?? true),
    releaseValue: parseGraphicalActionValue(properties.actionReleaseValue ?? false),
    step: finiteNumber(properties.actionStep, 1),
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
  };
}

function sameActionValue(a: unknown, b: GraphicalActionValue): boolean {
  if (typeof b === "number") return finiteNumber(a, Number.NaN) === b;
  if (typeof b === "boolean") return a === b || String(a) === String(b);
  return String(a ?? "") === b;
}

function clampActionNumber(value: number, config: GraphicalActionConfig): number {
  return Math.min(config.maximum ?? Number.POSITIVE_INFINITY, Math.max(config.minimum ?? Number.NEGATIVE_INFINITY, value));
}

/** Returns `undefined` when the phase does not commit a value for this mode. */
export function resolveGraphicalActionValue(
  config: GraphicalActionConfig,
  currentValue: unknown,
  phase: GraphicalActionPhase,
  inputValue?: GraphicalActionValue,
): GraphicalActionValue | undefined {
  if (inputValue !== undefined) {
    return typeof inputValue === "number" ? clampActionNumber(inputValue, config) : inputValue;
  }
  if (config.mode === "momentary") {
    if (phase === "press") return config.value;
    if (phase === "release") return config.releaseValue;
    return undefined;
  }
  if (phase !== "activate" && phase !== "input") return undefined;
  if (config.mode === "toggle") {
    return sameActionValue(currentValue, config.value) ? config.releaseValue : config.value;
  }
  if (config.mode === "increment") {
    return clampActionNumber(finiteNumber(currentValue, 0) + config.step, config);
  }
  return config.value;
}

export function isGraphicalActionTypeId(typeId: string): boolean {
  return ACTION_TYPES.has(typeId);
}

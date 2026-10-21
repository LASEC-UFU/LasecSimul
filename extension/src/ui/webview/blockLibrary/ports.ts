/**
 * Regras de porta da especificação (docs/66 §3) -- espelho de `BlockLibrary.cpp::resolvePorts` do
 * Core. As duas implementações passam pelos mesmos casos (`test/fixtures/block-library/
 * port-vectors.json`); divergir significaria pino desenhado num lugar e porta de sinal em outro.
 */
import { BlockPortRule, BlockProperties, BlockSpec, conditionsHold, propertyText, withDefaults } from "./spec.js";
import { tryEvaluateParam } from "./paramExpr.js";

export function repeatCount(rule: NonNullable<BlockPortRule["repeat"]>["rule"], value: unknown): number {
  const text = propertyText(value);
  if (rule === "signs" || rule === "ops") {
    let count = 0;
    let symbolic = false;
    for (const ch of text) {
      if (ch === "+" || ch === "-" || ch === "*" || ch === "/") { count++; symbolic = true; }
      else if (ch === "|" || ch === " ") symbolic = true;
    }
    if (symbolic) return count;
  }
  const parsed = tryEvaluateParam(text);
  if (!parsed) return 0;
  if (rule === "vectorLength" && parsed.data.length > 1) return parsed.data.length;
  if (parsed.data.length !== 1) return 0;
  const n = parsed.data[0]!;
  if (!(n >= 0) || n !== Math.floor(n) || n > 4096) return 0;
  return n;
}

export interface ResolvedPort {
  id: string;
  label?: string;
}

export function resolvePortRules(rules: readonly BlockPortRule[], properties: BlockProperties): ResolvedPort[] {
  const ports: ResolvedPort[] = [];
  for (const rule of rules) {
    if (rule.when && !conditionsHold(rule.when, properties)) continue;
    if (!rule.repeat) { ports.push({ id: rule.id!, label: rule.label }); continue; }
    const count = repeatCount(rule.repeat.rule, properties[rule.repeat.param]);
    const prefix = rule.prefix ?? "in";
    const start = rule.start ?? 1;
    for (let i = 0; i < count; i++) ports.push({ id: `${prefix}${start + i}` });
  }
  return ports;
}

export interface ResolvedBlockPorts {
  inputs: ResolvedPort[];
  outputs: ResolvedPort[];
}

export function resolveBlockPorts(spec: BlockSpec, properties: BlockProperties): ResolvedBlockPorts {
  const effective = withDefaults(spec, properties);
  return { inputs: resolvePortRules(spec.inputs, effective), outputs: resolvePortRules(spec.outputs, effective) };
}

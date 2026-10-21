/**
 * Especificação da biblioteca de blocos equivalente ao Simulink (docs/66 §3): os mesmos arquivos
 * `project/schema/block-library/*.json` que o Core embute. Este módulo é puro (sem `fs`/`vscode`) para
 * rodar também na Webview; a leitura dos arquivos fica em `blockLibraryLoader.ts` (host).
 */

export type LocalizedText = { en?: string; "pt-BR"?: string };
export type ConditionValue = string | number | boolean;
export type Conditions = Record<string, ConditionValue[]>;

export interface BlockParamSpec {
  name: string;
  type: "expr" | "enum" | "bool" | "string";
  default: string | number | boolean;
  options?: Array<string | { value: string; title?: LocalizedText }>;
  group?: string;
  visibleWhen?: Conditions;
  tunable?: boolean;
  title?: LocalizedText;
}

export interface BlockPortRule {
  id?: string;
  label?: string;
  when?: Conditions;
  repeat?: { param: string; rule: "signs" | "ops" | "count" | "vectorLength" };
  prefix?: string;
  start?: number;
}

export interface BlockPresetSpec {
  name: string;
  title?: LocalizedText;
  doc?: string;
  defaults: Record<string, string | number | boolean>;
  size?: [number, number];
}

export interface BlockSpec {
  id: string;
  name: string;
  title?: LocalizedText;
  doc?: string;
  description?: LocalizedText;
  simulink?: { blockType?: string; sourceBlock?: string; match?: Record<string, string> };
  sampleTime: { param?: string; fixed?: "continuous" | "inherited" | "constant" };
  size?: [number, number];
  presets?: BlockPresetSpec[];
  params: BlockParamSpec[];
  inputs: BlockPortRule[];
  outputs: BlockPortRule[];
}

export interface BlockLibraryFile {
  library: string;
  name: string;
  title?: LocalizedText;
  order?: number;
  blocks: BlockSpec[];
}

export const BLOCK_TYPE_PREFIX = "sl.";

export function blockTypeId(spec: Pick<BlockSpec, "id">): string {
  return `${BLOCK_TYPE_PREFIX}${spec.id}`;
}

export function isBlockLibraryTypeId(typeId: string): boolean {
  return typeId.startsWith(BLOCK_TYPE_PREFIX);
}

export function localized(text: LocalizedText | undefined, language: string, fallback: string): string {
  if (!text) return fallback;
  if (language.startsWith("pt")) return text["pt-BR"] ?? text.en ?? fallback;
  return text.en ?? fallback;
}

export type BlockProperties = Record<string, string | number | boolean | undefined>;

/** Valor de texto de uma propriedade como o diálogo o guarda (bool vira on/off). */
export function propertyText(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : value > 0 ? "inf" : value < 0 ? "-inf" : "NaN";
  return typeof value === "string" ? value : "";
}

/** Propriedades da instância completadas com os padrões (mesma normalização do Core). */
export function withDefaults(spec: BlockSpec, properties: BlockProperties): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) if (value !== undefined) result[key] = value;
  for (const param of spec.params) {
    const current = result[param.name];
    if (current === undefined) { result[param.name] = param.default; continue; }
    if (param.type === "bool") {
      if (typeof current === "string") result[param.name] = current === "on" || current === "true";
      else if (typeof current === "number") result[param.name] = current !== 0;
    } else if (typeof current === "number") {
      result[param.name] = propertyText(current);
    }
  }
  return result;
}

function sameValue(value: unknown, accepted: ConditionValue): boolean {
  if (typeof value === "boolean") {
    if (typeof accepted === "boolean") return value === accepted;
    if (typeof accepted === "string") return (value ? "on" : "off") === accepted;
    return false;
  }
  if (typeof value === "string") {
    if (typeof accepted === "string") return value === accepted;
    if (typeof accepted === "boolean") return (value === "on") === accepted;
    return false;
  }
  if (typeof value === "number") return typeof accepted === "number" && value === accepted;
  return false;
}

export function conditionsHold(conditions: Conditions | undefined, properties: BlockProperties): boolean {
  if (!conditions) return true;
  for (const [name, accepted] of Object.entries(conditions)) {
    const value = properties[name];
    if (value === undefined) return false;
    if (!accepted.some((candidate) => sameValue(value, candidate))) return false;
  }
  return true;
}

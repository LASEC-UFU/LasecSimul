import { WebviewComponentModel } from "./model.js";

/** Movido de `main.ts` (antes local) -- `batchProperties.ts` roda em Node nos testes (sem DOM), então
 * precisa ser a fonte canônica destes 2 tipos; `main.ts` importa de volta em vez de duplicar. */
export type PropertyFieldKind = "boolean" | "number" | "text" | "readonly" | "select" | "filePath" | "color" | "textarea";

export interface PropertyField {
  key: string;
  label: string;
  kind: PropertyFieldKind;
  value: string | number | boolean;
  readonly?: boolean;
  group: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  unit?: string;
}

export type SharedFieldValue = { state: "common"; value: string | number | boolean } | { state: "mixed" };

/** De onde vem o valor e pra onde `planBatchPropertyChange` escreve de volta: `"properties"` ==
 * `component.properties[key]` (schema/inferido, típico de cor/fontSize/valor -- precisa de
 * `requestUpdateProperty` por componente pra rodar `affectsPinCount`/rename de túnel no host);
 * `"instance"` == campo TOP-LEVEL de `WebviewComponentModel` (rotation/x/y/flipH/flipV/locked/
 * hiddenByUser -- já genérico pra qualquer typeId, sem verbo IPC dedicado, mesmo mecanismo de
 * `moveSelectedComponentsByArrow`). */
export type BatchFieldSource = "properties" | "instance";

export interface SharedPropertyField {
  key: string;
  label: string;
  kind: PropertyFieldKind;
  group: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  unit?: string;
  source: BatchFieldSource;
  value: SharedFieldValue;
  /** Campo resolvido de CADA componente selecionado (min/max/options PRÓPRIOS) -- nunca um único
   * schema "de referência" -- ver `validateValueForField`/`planBatchPropertyChange` (rule 8/10:
   * tipos heterogêneos podem compartilhar `key`+`kind` com faixas/opções diferentes). */
  perComponent: Map<string, PropertyField>;
}

const BATCH_EXCLUDED_KINDS: ReadonlySet<PropertyFieldKind> = new Set(["readonly", "filePath"]);

function commonOrMixed(values: ReadonlyArray<string | number | boolean>): SharedFieldValue {
  const first = values[0];
  return values.every((value) => value === first) ? { state: "common", value: first! } : { state: "mixed" };
}

/** Interseção por `key`+`kind` das listas de campo (`resolveFields`, tipicamente
 * `resolvePropertyFields`/`inferPropertyFields` de `main.ts`) de CADA componente selecionado -- só um
 * campo presente em TODOS, com o MESMO widget (`kind`), entra como "compartilhado" (rule 1/8).
 * `readonly`/`filePath` nunca entram (telemetria ao vivo e referências de arquivo são inerentemente de
 * um único alvo, ver limitações). Faixas/opções por componente são preservadas em `perComponent` --
 * exibição tolera diferença, `validateValueForField` que barra aplicar um valor que só ALGUNS
 * componentes aceitariam. */
export function computeSharedPropertyFields(
  components: readonly WebviewComponentModel[],
  resolveFields: (component: WebviewComponentModel) => PropertyField[]
): SharedPropertyField[] {
  if (components.length === 0) return [];
  const perComponentFields = components.map((component) => {
    const fields = new Map<string, PropertyField>();
    for (const field of resolveFields(component)) {
      if (BATCH_EXCLUDED_KINDS.has(field.kind)) continue;
      fields.set(field.key, field);
    }
    return fields;
  });

  const [firstFields, ...restFields] = perComponentFields;
  const shared: SharedPropertyField[] = [];
  for (const [key, referenceField] of firstFields!) {
    const perComponent = new Map<string, PropertyField>();
    perComponent.set(components[0]!.id, referenceField);
    let compatible = true;
    for (let i = 0; i < restFields.length; i++) {
      const candidate = restFields[i]!.get(key);
      if (!candidate || candidate.kind !== referenceField.kind) {
        compatible = false;
        break;
      }
      perComponent.set(components[i + 1]!.id, candidate);
    }
    if (!compatible) continue;
    shared.push({
      key,
      label: referenceField.label,
      kind: referenceField.kind,
      group: referenceField.group,
      min: referenceField.min,
      max: referenceField.max,
      step: referenceField.step,
      options: referenceField.options,
      unit: referenceField.unit,
      source: "properties",
      value: commonOrMixed(components.map((component) => perComponent.get(component.id)!.value)),
      perComponent,
    });
  }
  return shared;
}

interface GenericInstanceFieldSpec {
  key: "rotation" | "x" | "y" | "flipH" | "flipV" | "locked" | "hiddenByUser";
  label: string;
  kind: PropertyFieldKind;
  options?: { value: string; label: string }[];
  read: (component: WebviewComponentModel) => string | number | boolean;
}

const GENERIC_FIELD_GROUP = "generic";

const GENERIC_INSTANCE_FIELD_SPECS: GenericInstanceFieldSpec[] = [
  { key: "x", label: "X", kind: "number", read: (component) => component.x },
  { key: "y", label: "Y", kind: "number", read: (component) => component.y },
  {
    key: "rotation",
    label: "Rotation",
    kind: "select",
    options: [0, 90, 180, 270].map((degrees) => ({ value: String(degrees), label: `${degrees}°` })),
    read: (component) => component.rotation,
  },
  { key: "flipH", label: "Flip Horizontal", kind: "boolean", read: (component) => Boolean(component.flipH) },
  { key: "flipV", label: "Flip Vertical", kind: "boolean", read: (component) => Boolean(component.flipV) },
  { key: "locked", label: "Locked", kind: "boolean", read: (component) => Boolean(component.locked) },
  { key: "hiddenByUser", label: "Hidden", kind: "boolean", read: (component) => Boolean(component.hiddenByUser) },
];

/** Campos sempre disponíveis pra QUALQUER typeId -- já existem como campo TOP-LEVEL de
 * `WebviewComponentModel` (nunca em `properties[key]`), então nunca dependem de `propertySchema`/
 * inferência por typeId. Cobre rule 8 (seleção heterogênea sempre tem pelo menos estes em comum) e a
 * lista de propriedades genéricas da rule 9 (posição/rotação/espelhamento/bloqueio/visibilidade). */
export function computeGenericInstanceFields(components: readonly WebviewComponentModel[]): SharedPropertyField[] {
  if (components.length === 0) return [];
  return GENERIC_INSTANCE_FIELD_SPECS.map((spec) => {
    const perComponent = new Map<string, PropertyField>();
    for (const component of components) {
      perComponent.set(component.id, {
        key: spec.key,
        label: spec.label,
        kind: spec.kind,
        value: spec.read(component),
        group: GENERIC_FIELD_GROUP,
        options: spec.options,
      });
    }
    return {
      key: spec.key,
      label: spec.label,
      kind: spec.kind,
      group: GENERIC_FIELD_GROUP,
      options: spec.options,
      source: "instance" as const,
      value: commonOrMixed(components.map((component) => spec.read(component))),
      perComponent,
    };
  });
}

/** Valida UM valor contra o campo PRÓPRIO de UM componente -- nunca contra o schema de um componente
 * DIFERENTE (rule 8/10). `number`: finito + min/max PRÓPRIOS quando declarados. `select`: valor
 * precisa estar entre as `options` PRÓPRIAS quando declaradas -- sem `options` (campo inferido, sem
 * schema) aceita qualquer string/number, igual ao comportamento de hoje pra campos sem schema.
 * `boolean`/`color`/`text`/`textarea`: checagem de tipo. `readonly`/`filePath` nunca são aplicáveis
 * (já excluídos de `computeSharedPropertyFields`, mas a função continua total pra qualquer chamador). */
export function validateValueForField(field: PropertyField, value: string | number | boolean): boolean {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (field.min !== undefined && value < field.min) return false;
      if (field.max !== undefined && value > field.max) return false;
      return true;
    }
    case "select": {
      if (typeof value !== "string" && typeof value !== "number") return false;
      if (!field.options || field.options.length === 0) return true;
      return field.options.some((option) => option.value === String(value));
    }
    case "color":
    case "text":
    case "textarea":
      return typeof value === "string";
    case "readonly":
    case "filePath":
      return false;
    default:
      return false;
  }
}

export interface BatchPropertyPatch {
  componentId: string;
  source: BatchFieldSource;
  key: string;
  value: string | number | boolean;
}

export type BatchPropertyPlan = { ok: true; patches: BatchPropertyPatch[] } | { ok: false; invalidComponentIds: string[] };

/** Decide COMO aplicar `value` a `field` em todos os componentes selecionados -- tudo ou nada (rule
 * 10/11): valida contra o campo PRÓPRIO de cada componente ANTES de gerar qualquer patch; se QUALQUER
 * componente rejeitar, devolve `ok:false` e NENHUM patch (quem chama não escreve nada, nunca aplica
 * parcial silenciosamente). Não muta `components`/DOM/IPC -- só decide o que deveria mudar; quem
 * chama (`main.ts`) aplica de verdade e é quem decide como reportar `ok:false` ao usuário. */
export function planBatchPropertyChange(
  components: readonly WebviewComponentModel[],
  field: SharedPropertyField,
  value: string | number | boolean
): BatchPropertyPlan {
  const invalidComponentIds: string[] = [];
  for (const component of components) {
    const own = field.perComponent.get(component.id);
    if (!own || !validateValueForField(own, value)) invalidComponentIds.push(component.id);
  }
  if (invalidComponentIds.length > 0) return { ok: false, invalidComponentIds };

  return {
    ok: true,
    patches: components.map((component) => ({ componentId: component.id, source: field.source, key: field.key, value })),
  };
}

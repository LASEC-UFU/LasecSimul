/**
 * Propriedades exportadas POR INSTÂNCIA de um subcircuito.
 *
 * Um `.lssubcircuit` é o MODELO (LD301, TT301, tanque pressurizado...): editar a propriedade de um
 * componente interno exportado não pode reescrever o arquivo do modelo, senão dois LD301 no mesmo
 * projeto nunca teriam endereço/faixa/tag diferentes e a edição vazaria para todos os projetos. A
 * edição é guardada na própria instância, como uma propriedade comum da instância com a chave
 * `@<id do componente interno>.<nome da propriedade>`: entra no desfazer/refazer, é salva no
 * `.lsproj` e é aplicada ao Core com `setSubcircuitChildProperty` (ver `coreLifecycle.ts`).
 */
export const CHILD_PROPERTY_PREFIX = "@";

export interface ChildPropertyOverride {
  innerComponentId: string;
  name: string;
  value: string | number | boolean;
}

export function childPropertyKey(innerComponentId: string, name: string): string {
  return `${CHILD_PROPERTY_PREFIX}${innerComponentId}.${name}`;
}

/** `@ld301.tag` -> `{ innerComponentId: "ld301", name: "tag" }`; qualquer outra chave -> `undefined`. */
export function parseChildPropertyKey(key: string): { innerComponentId: string; name: string } | undefined {
  if (!key.startsWith(CHILD_PROPERTY_PREFIX)) return undefined;
  const dot = key.indexOf(".", CHILD_PROPERTY_PREFIX.length);
  if (dot <= CHILD_PROPERTY_PREFIX.length || dot === key.length - 1) return undefined;
  return { innerComponentId: key.slice(CHILD_PROPERTY_PREFIX.length, dot), name: key.slice(dot + 1) };
}

export function isChildPropertyKey(key: string): boolean {
  return parseChildPropertyKey(key) !== undefined;
}

export function childPropertyOverrides(properties: Record<string, unknown>): ChildPropertyOverride[] {
  const overrides: ChildPropertyOverride[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const parsed = parseChildPropertyKey(key);
    if (!parsed) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    overrides.push({ ...parsed, value });
  }
  return overrides;
}

/** As propriedades da instância sem as chaves por componente interno (o que vai no `addComponent`). */
export function withoutChildPropertyOverrides<T>(properties: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(properties).filter(([key]) => !isChildPropertyKey(key)));
}

/** Propriedades efetivas de um componente interno: as do modelo, com as da instância por cima. */
export function effectiveChildProperties<T>(
  modelProperties: Record<string, T>,
  instanceProperties: Record<string, unknown>,
  innerComponentId: string,
): Record<string, T | string | number | boolean> {
  const effective: Record<string, T | string | number | boolean> = { ...modelProperties };
  for (const override of childPropertyOverrides(instanceProperties)) {
    if (override.innerComponentId === innerComponentId) effective[override.name] = override.value;
  }
  return effective;
}

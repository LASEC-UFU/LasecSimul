/**
 * Subsistemas INTERNOS de um documento (projeto `.lsproj` ou sistema externo `.lssubcircuit`).
 *
 * Definição x instância (FEAT-004/SCHEMA-002): a DEFINIÇÃO é um manifesto schemaVersion 3 completo
 * (modelo interno, interface, Painel/símbolo, propriedades exportadas) guardado na tabela
 * `subsystems[]` do próprio documento; a INSTÂNCIA é um componente comum cujo `typeId` é o da
 * definição. O `typeId` (prefixo `subsystem.`) é a identidade estável -- renomear muda só `name`.
 * Parâmetros ficam nas propriedades de cada instância e o estado de simulação vem da expansão por
 * instância no Core: duas instâncias da mesma definição nunca compartilham estado.
 *
 * Tudo aqui é puro (sem Node/`vscode`): usado pela Webview (área de transferência) e pelo host
 * (persistência, Core, importação/exportação).
 */
export const SUBSYSTEM_TYPE_PREFIX = "subsystem.";
/** `registeredSourceId` das entradas de catálogo de definições internas ("Abrir Modelo Interno"). */
export const SUBSYSTEM_SOURCE_PREFIX = "subsystem:";

export interface SubsystemOrigin {
  /** `typeId` de onde a definição veio (sistema externo, planta-modelo, cópia incorporada antiga). */
  typeId?: string;
  /** Arquivo de onde foi importada -- só informativo: a cópia interna nunca volta a lê-lo. */
  file?: string;
}

export interface SubsystemComponentLike {
  id?: string;
  typeId?: string;
  properties?: unknown;
  subcircuitRef?: { path?: string; embedded?: Record<string, unknown> };
}

export interface SubsystemDefinition {
  typeId: string;
  name: string;
  components?: SubsystemComponentLike[];
  origin?: SubsystemOrigin;
  [key: string]: unknown;
}

export function isSubsystemTypeId(typeId: string | undefined): boolean {
  return typeof typeId === "string" && typeId.startsWith(SUBSYSTEM_TYPE_PREFIX) && typeId.length > SUBSYSTEM_TYPE_PREFIX.length;
}

export function subsystemSourceId(typeId: string): string {
  return `${SUBSYSTEM_SOURCE_PREFIX}${typeId}`;
}

export function typeIdFromSubsystemSourceId(sourceId: string | undefined): string | undefined {
  return sourceId?.startsWith(SUBSYSTEM_SOURCE_PREFIX) ? sourceId.slice(SUBSYSTEM_SOURCE_PREFIX.length) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function slugForSubsystem(text: string): string {
  const slug = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return slug || "subsistema";
}

/** Base legível de um `typeId` qualquer: `subcircuits.process.tank` -> `process.tank`. */
function typeIdBase(typeId: string): string {
  const bare = typeId.replace(/^subcircuits\./, "").replace(/^subsystem\./, "").replace(/@.*$/, "");
  return bare.split(".").map(slugForSubsystem).join(".") || "subsistema";
}

export function uniqueSubsystemTypeId(base: string, taken: ReadonlySet<string>): string {
  const root = `${SUBSYSTEM_TYPE_PREFIX}${typeIdBase(base)}`;
  if (!taken.has(root)) return root;
  for (let index = 2; ; index += 1) {
    const candidate = `${root}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function uniqueSubsystemName(name: string, taken: ReadonlySet<string>): string {
  const base = name.trim() || "Subsistema";
  if (!taken.has(base)) return base;
  const stripped = base.replace(/ \(\d+\)$/, "");
  for (let index = 2; ; index += 1) {
    const candidate = `${stripped} (${index})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** JSON com chaves ordenadas: igualdade VERIFICÁVEL de definições (não por nome). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Definições internas usadas DIRETAMENTE pela definição (sem repetição, na ordem em que aparecem). */
export function directDependencies(definition: Pick<SubsystemDefinition, "components">, table: readonly SubsystemDefinition[]): string[] {
  const known = new Set(table.map((entry) => entry.typeId));
  const out: string[] = [];
  for (const component of definition.components ?? []) {
    const typeId = component?.typeId;
    if (typeof typeId === "string" && known.has(typeId) && !out.includes(typeId)) out.push(typeId);
  }
  return out;
}

/** Fechamento transitivo das definições a partir de `roots`, dependências ANTES de quem as usa
 * (ordem de registro no Core e de importação). Ciclos são cortados (veja `findSubsystemCycle`). */
export function subsystemClosure(roots: readonly string[], table: readonly SubsystemDefinition[]): SubsystemDefinition[] {
  const byTypeId = new Map(table.map((entry) => [entry.typeId, entry]));
  const visited = new Set<string>();
  const ordered: SubsystemDefinition[] = [];
  const visit = (typeId: string, stack: Set<string>): void => {
    const definition = byTypeId.get(typeId);
    if (!definition || visited.has(typeId) || stack.has(typeId)) return;
    stack.add(typeId);
    for (const dependency of directDependencies(definition, table)) visit(dependency, stack);
    stack.delete(typeId);
    visited.add(typeId);
    ordered.push(definition);
  };
  for (const root of roots) visit(root, new Set());
  return ordered;
}

/** Ordem de toda a tabela, dependências primeiro. */
export function subsystemTopologicalOrder(table: readonly SubsystemDefinition[]): SubsystemDefinition[] {
  return subsystemClosure(table.map((entry) => entry.typeId), table);
}

/** Primeiro ciclo de referência entre definições (A contém B que contém A...), como caminho
 * `[A, B, A]`; `undefined` sem ciclo. Ciclo de DEFINIÇÕES torna a expansão impossível -- é diferente
 * de realimentação entre sinais, que continua permitida. */
export function findSubsystemCycle(table: readonly SubsystemDefinition[]): string[] | undefined {
  const byTypeId = new Map(table.map((entry) => [entry.typeId, entry]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (typeId: string): string[] | undefined => {
    if (state.get(typeId) === "done") return undefined;
    if (state.get(typeId) === "visiting") return [...path.slice(path.indexOf(typeId)), typeId];
    const definition = byTypeId.get(typeId);
    if (!definition) return undefined;
    state.set(typeId, "visiting");
    path.push(typeId);
    for (const dependency of directDependencies(definition, table)) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(typeId, "done");
    return undefined;
  };
  for (const entry of table) {
    const cycle = visit(entry.typeId);
    if (cycle) return cycle;
  }
  return undefined;
}

/** `true` quando a definição `from` contém `target` em algum nível (ou é ela mesma). */
export function subsystemDependsOn(table: readonly SubsystemDefinition[], from: string, target: string): boolean {
  if (from === target) return true;
  return subsystemClosure([from], table).some((entry) => entry.typeId === target);
}

export function rewriteComponentTypeIds<T extends SubsystemComponentLike>(components: readonly T[], typeIdMap: ReadonlyMap<string, string>): T[] {
  return components.map((component) => {
    const mapped = typeof component.typeId === "string" ? typeIdMap.get(component.typeId) : undefined;
    return mapped && mapped !== component.typeId ? { ...component, typeId: mapped } : component;
  });
}

/** Caminhos de sistemas externos usados por referência (`subcircuitRef.path`). Em memória ficam
 * ABSOLUTOS -- copiar/colar, exportar e criar subsistemas entre pastas nunca dependem do documento de
 * origem --; ao gravar um documento, relativos à pasta dele (`map` decide). */
export function mapComponentRefPaths<T extends SubsystemComponentLike>(components: readonly T[], map: (refPath: string) => string): T[] {
  return components.map((component) => {
    const refPath = component.subcircuitRef?.path;
    if (typeof refPath !== "string" || !refPath || isRecord(component.subcircuitRef?.embedded)) return component;
    const mapped = map(refPath);
    return mapped === refPath ? component : { ...component, subcircuitRef: { ...component.subcircuitRef, path: mapped } };
  });
}

/** `mapComponentRefPaths` em todas as definições de uma tabela. */
export function mapTableRefPaths(table: readonly SubsystemDefinition[], map: (refPath: string) => string): SubsystemDefinition[] {
  return table.map((definition) => (definition.components ? { ...definition, components: mapComponentRefPaths(definition.components, map) } : definition));
}

export interface SubsystemImportResult {
  table: SubsystemDefinition[];
  /** `typeId` de origem -> `typeId` no documento de destino (igual quando reaproveitada). */
  typeIdMap: Map<string, string>;
  /** `typeId`s criados no destino. */
  added: string[];
}

/**
 * Importa definições de OUTRO documento (colar, "Importar Circuito", cópia incorporada) sem
 * sobrescrever nada: uma definição só é reaproveitada quando o destino já tem o MESMO `typeId` com
 * conteúdo canônico idêntico (mesma identidade e equivalência verificável -- caso típico: colar no
 * próprio projeto). Caso contrário entra com `typeId` novo e, se o nome já existir, nome ajustado.
 * Dependências entram antes e as referências internas são reescritas; instâncias que compartilhavam
 * uma definição continuam compartilhando a cópia importada. `reservedTypeIds`: tipos que não podem
 * ser usados por uma definição interna (catálogo/sistemas externos).
 */
export function importSubsystemDefinitions(
  table: readonly SubsystemDefinition[],
  incoming: readonly SubsystemDefinition[],
  reservedTypeIds: ReadonlySet<string> = new Set(),
  options: { reuseEquivalentContent?: boolean } = {}
): SubsystemImportResult {
  const result = [...table];
  const byTypeId = new Map(result.map((entry) => [entry.typeId, entry]));
  const typeIdMap = new Map<string, string>();
  const added: string[] = [];
  // Cópia profunda: o destino nunca compartilha objetos com o documento de origem.
  for (const definition of subsystemTopologicalOrder(structuredClone([...incoming]))) {
    const rewritten: SubsystemDefinition = { ...definition, components: rewriteComponentTypeIds(definition.components ?? [], typeIdMap) };
    const existing = byTypeId.get(definition.typeId);
    if (existing && canonicalJson(existing) === canonicalJson(rewritten)) {
      typeIdMap.set(definition.typeId, definition.typeId);
      continue;
    }
    if (options.reuseEquivalentContent) {
      // Só por pedido explícito (planta-modelo/cópia incorporada repetida), nunca na colagem comum.
      const key = contentKeyWithoutIdentity(rewritten);
      const equivalent = result.find((entry) => contentKeyWithoutIdentity(entry) === key);
      if (equivalent) {
        typeIdMap.set(definition.typeId, equivalent.typeId);
        continue;
      }
    }
    const taken = new Set([...byTypeId.keys(), ...reservedTypeIds]);
    const typeId = !existing && isSubsystemTypeId(definition.typeId) && !reservedTypeIds.has(definition.typeId)
      ? definition.typeId
      : uniqueSubsystemTypeId(definition.typeId, taken);
    const names = new Set(result.map((entry) => entry.name));
    const name = names.has(definition.name) ? uniqueSubsystemName(definition.name, names) : definition.name;
    const imported: SubsystemDefinition = { ...rewritten, typeId, name };
    result.push(imported);
    byTypeId.set(typeId, imported);
    typeIdMap.set(definition.typeId, typeId);
    added.push(typeId);
  }
  return { table: result, typeIdMap, added };
}

function contentKeyWithoutIdentity(definition: Record<string, unknown>): string {
  return canonicalJson({ ...definition, typeId: undefined, name: undefined });
}

/** Uso de uma definição: instâncias no nível de cima do documento e definições que a contêm. */
export function subsystemUsage(typeId: string, components: readonly SubsystemComponentLike[], table: readonly SubsystemDefinition[]): { instanceIds: string[]; containingDefinitions: string[] } {
  return {
    instanceIds: components.filter((component) => component.typeId === typeId).map((component) => String(component.id ?? "")),
    containingDefinitions: table.filter((entry) => entry.typeId !== typeId && (entry.components ?? []).some((component) => component.typeId === typeId)).map((entry) => entry.typeId),
  };
}

/** Cópia independente de uma definição (mesmo conteúdo, `typeId` e nome novos). */
export function duplicateSubsystemDefinition(table: readonly SubsystemDefinition[], typeId: string, name?: string): { table: SubsystemDefinition[]; typeId: string } | undefined {
  const source = table.find((entry) => entry.typeId === typeId);
  if (!source) return undefined;
  const newTypeId = uniqueSubsystemTypeId(name ? slugForSubsystem(name) : `${source.typeId}_copia`, new Set(table.map((entry) => entry.typeId)));
  const newName = uniqueSubsystemName(name ?? `${source.name} (cópia)`, new Set(table.map((entry) => entry.name)));
  const copy: SubsystemDefinition = { ...structuredClone(source), typeId: newTypeId, name: newName };
  return { table: [...table, copy], typeId: newTypeId };
}

function stripSubsystemsTable(manifest: Record<string, unknown>): Record<string, unknown> {
  const { subsystems: _subsystems, ...rest } = manifest;
  return rest;
}

/** Sistema externo autossuficiente a partir de uma definição interna: o manifesto principal recebe
 * `externalTypeId` e leva junto, em `subsystems[]`, todas as definições internas de que depende. */
export function exportSubsystemAsExternal(table: readonly SubsystemDefinition[], typeId: string, externalTypeId: string): Record<string, unknown> | undefined {
  const root = table.find((entry) => entry.typeId === typeId);
  if (!root) return undefined;
  const dependencies = subsystemClosure([typeId], table).filter((entry) => entry.typeId !== typeId);
  const { origin: _origin, ...main } = structuredClone(root);
  return { ...main, typeId: externalTypeId, ...(dependencies.length > 0 ? { subsystems: structuredClone(dependencies) } : {}) };
}

/** Definições internas declaradas por um manifesto de sistema externo. */
export function manifestSubsystems(manifest: Record<string, unknown>): SubsystemDefinition[] {
  return Array.isArray(manifest.subsystems)
    ? manifest.subsystems.filter((entry): entry is SubsystemDefinition => isRecord(entry) && typeof entry.typeId === "string" && typeof entry.name === "string")
    : [];
}

/**
 * Cópia incorporada de um sistema externo: o manifesto (e as definições internas dele) entram na
 * tabela do documento como definições INTERNAS novas. Nada aponta de volta para o arquivo; alterações
 * posteriores nele não afetam a cópia. `reuseEquivalent`: reaproveita uma definição já incorporada
 * da mesma origem com conteúdo idêntico (inserir planta-modelo duas vezes).
 */
export function importExternalAsSubsystem(
  table: readonly SubsystemDefinition[],
  manifest: Record<string, unknown>,
  options: { file?: string; reservedTypeIds?: ReadonlySet<string>; reuseEquivalent?: boolean; name?: string } = {}
): { table: SubsystemDefinition[]; typeId: string } {
  manifest = structuredClone(manifest);
  const externalTypeId = typeof manifest.typeId === "string" ? manifest.typeId : "";
  const baseName = options.name ?? (typeof manifest.name === "string" && manifest.name.trim() ? manifest.name : (externalTypeId || "Subsistema"));
  const imported = importSubsystemDefinitions(table, manifestSubsystems(manifest), options.reservedTypeIds, { reuseEquivalentContent: options.reuseEquivalent });
  const body = stripSubsystemsTable(manifest);
  const components = rewriteComponentTypeIds(Array.isArray(body.components) ? (body.components as SubsystemComponentLike[]) : [], imported.typeIdMap);
  const origin: SubsystemOrigin = { ...(externalTypeId && !isSubsystemTypeId(externalTypeId) ? { typeId: externalTypeId } : {}), ...(options.file ? { file: options.file } : {}) };
  const contentKey = (definition: Record<string, unknown>) => canonicalJson({ ...definition, typeId: undefined, name: undefined, origin: undefined });
  const candidate: SubsystemDefinition = { ...body, components, typeId: "", name: baseName, ...(Object.keys(origin).length > 0 ? { origin } : {}) };
  if (options.reuseEquivalent) {
    const equivalent = imported.table.find((entry) => (entry.origin?.typeId ?? "") === (origin.typeId ?? "") && contentKey(entry) === contentKey(candidate));
    if (equivalent) return { table: imported.table, typeId: equivalent.typeId };
  }
  const typeId = uniqueSubsystemTypeId(externalTypeId || slugForSubsystem(baseName), new Set([...imported.table.map((entry) => entry.typeId), ...(options.reservedTypeIds ?? [])]));
  const name = uniqueSubsystemName(baseName, new Set(imported.table.map((entry) => entry.name)));
  return { table: [...imported.table, { ...candidate, typeId, name }], typeId };
}

/**
 * Migração de leitura: cópias incorporadas POR INSTÂNCIA (`subcircuitRef.embedded`, formato anterior)
 * viram definições da tabela, em qualquer nível (também dentro de outras definições). Instâncias com
 * o mesmo conteúdo passam a compartilhar uma definição; o `typeId` interno é derivado do antigo
 * (`subcircuits.local.x` -> `subsystem.local.x`), então a migração é determinística e idempotente.
 */
export function hoistEmbeddedSubsystems<T extends SubsystemComponentLike>(
  components: readonly T[],
  table: readonly SubsystemDefinition[],
  reservedTypeIds: ReadonlySet<string> = new Set()
): { components: T[]; table: SubsystemDefinition[]; migrated: number } {
  let current = [...table];
  let migrated = 0;
  const hoistList = <C extends SubsystemComponentLike>(list: readonly C[]): C[] => list.map((component) => {
    const embedded = component.subcircuitRef?.embedded;
    if (!isRecord(embedded)) return component;
    migrated += 1;
    const nested = isRecord(embedded) && Array.isArray(embedded.components) ? hoistList(embedded.components as SubsystemComponentLike[]) : [];
    const manifest = { ...embedded, components: nested };
    const oldTypeId = typeof embedded.typeId === "string" ? embedded.typeId : (component.typeId ?? "subsistema");
    const imported = importSubsystemDefinitions(current, manifestSubsystems(manifest), reservedTypeIds);
    current = imported.table;
    const body = stripSubsystemsTable(manifest);
    body.components = rewriteComponentTypeIds(nested, imported.typeIdMap);
    const preferred = uniqueSubsystemTypeId(oldTypeId, reservedTypeIds);
    const origin: SubsystemOrigin = { ...(!isSubsystemTypeId(oldTypeId) ? { typeId: oldTypeId } : {}), ...(typeof component.subcircuitRef?.path === "string" ? { file: component.subcircuitRef.path } : {}) };
    const name = typeof embedded.name === "string" && embedded.name.trim() ? embedded.name : oldTypeId;
    const definition: SubsystemDefinition = { ...body, typeId: preferred, name, ...(Object.keys(origin).length > 0 ? { origin } : {}) };
    // Mesmo conteúdo (inclusive origem) que uma definição já migrada: as instâncias compartilham.
    const equal = current.find((entry) => canonicalJson({ ...entry, typeId: preferred }) === canonicalJson(definition));
    let typeId = equal?.typeId ?? preferred;
    if (!equal) {
      if (current.some((entry) => entry.typeId === preferred)) typeId = uniqueSubsystemTypeId(oldTypeId, new Set([...current.map((entry) => entry.typeId), ...reservedTypeIds]));
      current = [...current, { ...definition, typeId }];
    }
    const { subcircuitRef: _ref, ...rest } = component;
    return { ...rest, typeId } as C;
  });
  const hoisted = hoistList(components);
  // Cópias incorporadas guardadas dentro de definições já existentes na tabela.
  let changed = true;
  while (changed) {
    changed = false;
    current = current.map((definition) => {
      if (!(definition.components ?? []).some((component) => isRecord(component.subcircuitRef?.embedded))) return definition;
      changed = true;
      return { ...definition, components: hoistList(definition.components ?? []) };
    });
  }
  return { components: hoisted, table: current, migrated };
}

/**
 * Registro de um sistema EXTERNO no Core: as definições internas dele ganham `typeId` no espaço de
 * nomes do arquivo (`subsystem.x@subcircuits.planta`), para nunca colidirem com as do projeto nem com
 * as de outro sistema externo; o manifesto principal é reescrito para apontar para elas.
 */
export function flattenExternalSystem(manifest: Record<string, unknown>): { definitions: Record<string, unknown>[]; main: Record<string, unknown> } {
  const internal = manifestSubsystems(manifest);
  const mainTypeId = typeof manifest.typeId === "string" ? manifest.typeId : "external";
  const map = new Map(internal.map((entry) => [entry.typeId, `${entry.typeId}@${mainTypeId}`]));
  const definitions = subsystemTopologicalOrder(internal).map((entry) => ({
    ...stripSubsystemsTable(entry),
    typeId: map.get(entry.typeId)!,
    components: rewriteComponentTypeIds(entry.components ?? [], map),
  }));
  const main = stripSubsystemsTable(manifest);
  main.components = rewriteComponentTypeIds(Array.isArray(main.components) ? (main.components as SubsystemComponentLike[]) : [], map);
  return { definitions, main };
}

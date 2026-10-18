import { ProjectComponent } from "../project/ProjectTypes";

export const LEGACY_TANK_TYPE_ID = "control.tank";
export const ACCUMULATOR_TYPE_ID = "control.accumulator";

/**
 * `control.tank` foi removido do Core (ADR 0013) em favor de `control.accumulator`; a troca foi feita
 * só nos arquivos do repositório ("sem leitor do typeId antigo"). Projetos de fora dele -- tipicamente
 * com a planta INCORPORADA (`subcircuitRef.embedded`), que carrega o bloco antigo por dentro -- deixaram
 * de abrir no Core ("Unknown component typeId: control.tank").
 *
 * Migração de leitura EXATA, a mesma aplicada aos projetos do repositório: o Tank integrava
 * `(in − outflow)/area` com recorte em zero; com `area` 1 (ou ausente, cujo padrão era 1) isso é o
 * acumulador com fronteira inferior 0 e superior +∞ -- os padrões de `control.accumulator` -- nas
 * mesmas portas `in`/`outflow`/`out`. Só `area` sai das propriedades; id, ligações e as demais
 * propriedades (`initial`, `samplePeriodNs`...) ficam. Com outra `area` não existe equivalente sem
 * mudar o diagrama: o bloco fica como está e o Core continua recusando com a mensagem explícita.
 */
function migrateTank(component: ProjectComponent): ProjectComponent | undefined {
  if (component.typeId !== LEGACY_TANK_TYPE_ID) return undefined;
  const { area, ...properties } = component.properties ?? {};
  if (area !== undefined && area !== 1) return undefined;
  return { ...component, typeId: ACCUMULATOR_TYPE_ID, properties };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Migra um manifesto `.lssubcircuit` incorporado (e os incorporados dentro dele). Devolve o mesmo
 * objeto quando nada muda; entradas que não são objeto ficam como estão. */
function migrateManifest(manifest: Record<string, unknown>, counter: { count: number }): Record<string, unknown> {
  if (!Array.isArray(manifest.components)) return manifest;
  const before = counter.count;
  const components = manifest.components.map((entry) => (isObject(entry) ? migrateComponent(entry as unknown as ProjectComponent, counter) : entry));
  return counter.count === before ? manifest : { ...manifest, components };
}

function migrateComponent(component: ProjectComponent, counter: { count: number }): ProjectComponent {
  let next = migrateTank(component);
  if (next) counter.count += 1;
  next ??= component;
  const embedded = next.subcircuitRef?.embedded;
  if (embedded) {
    const migrated = migrateManifest(embedded, counter);
    if (migrated !== embedded) next = { ...next, subcircuitRef: { ...next.subcircuitRef!, embedded: migrated } };
  }
  return next;
}

/** Componentes do projeto (inclusive os de dentro das plantas/subcircuitos incorporados). */
export function migrateLegacyTankBlocks(components: readonly ProjectComponent[]): { components: ProjectComponent[]; migrated: number } {
  const counter = { count: 0 };
  const migrated = components.map((component) => migrateComponent(component, counter));
  return { components: migrated, migrated: counter.count };
}

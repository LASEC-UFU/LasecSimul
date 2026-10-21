import * as path from "path";
import { parseSubcircuitManifest } from "../catalog/registeredSources";
import { currentLasecSimulLanguage } from "../currentLanguage";
import { readJsonFile } from "../pathUtils";
import { state } from "../state";
import { registerPackage, registerBlockSpec } from "../ui/webview/componentSymbols";
import type { WebviewComponentCatalogEntry } from "../ui/webview/model";
import {
  flattenExternalSystem,
  hoistEmbeddedSubsystems,
  isSubsystemTypeId,
  manifestSubsystems,
  mapComponentRefPaths,
  mapTableRefPaths,
  subsystemSourceId,
  subsystemTopologicalOrder,
  SubsystemComponentLike,
  SubsystemDefinition,
} from "../ui/webview/subsystemModel";
import { fileSourceId, materializeEmbeddedSubcircuit } from "./embeddedSubcircuits";
import { LEGACY_LIBRARY_EXPORTS } from "../migration/controlLibrary/legacyLibraryExports";
import { migrateControlDocument, needsControlMigration } from "../migration/controlLibrary/migrateDocument";
import { migrateFileInPlace } from "../migration/controlLibrary/migrationFiles";

/**
 * Ponte entre as definições de subsistemas (tabela do documento, `ui/webview/subsystemModel.ts`) e o
 * Core/catálogo. O Core continua com um único `SubcircuitRegistry` indexado por `typeId`; aqui se
 * garante que (1) as definições INTERNAS do documento aberto estejam registradas, dependências antes,
 * e tenham entrada de catálogo (fora da paleta) e (2) um sistema EXTERNO que traga subsistemas
 * internos próprios os registre em espaço de nomes do arquivo, sem colidir com os do projeto.
 */

function mcuTypeIds(): Set<string> {
  return new Set(state.schematicState.catalog.filter((entry) => entry.registeredSourceKind === "mcu-adapter").map((entry) => entry.typeId));
}

async function registerManifestFile(filePath: string, replace: boolean): Promise<void> {
  if (!state.coreClient) return;
  await state.coreClient.registerAdhocSubcircuitDefinition(filePath, { replace });
}

/** Caminho de sistema externo absoluto a partir da pasta do documento que o referencia. */
export function absoluteRefPath(baseDir: string): (refPath: string) => string {
  return (refPath) => (path.isAbsolute(refPath) ? path.normalize(refPath) : path.resolve(baseDir, refPath));
}

/** Caminho relativo à pasta do documento que será gravado, com "/" (portável entre sistemas);
 * absoluto quando não há caminho relativo (ex.: outra unidade). */
export function relativeRefPath(baseDir: string): (refPath: string) => string {
  return (refPath) => {
    const absolute = absoluteRefPath(baseDir)(refPath);
    const relative = path.relative(baseDir, absolute);
    return relative && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : absolute;
  };
}

/** Manifesto lido de `filePath` com os caminhos de sistemas externos (componentes e tabela) absolutos:
 * forma usada em memória ao editar ou incorporar o arquivo. */
export function manifestWithAbsoluteRefs(manifest: Record<string, unknown>, filePath: string): Record<string, unknown> {
  const toAbsolute = absoluteRefPath(path.dirname(filePath));
  return {
    ...manifest,
    components: mapComponentRefPaths(Array.isArray(manifest.components) ? manifest.components as SubsystemComponentLike[] : [], toAbsolute),
    ...(Array.isArray(manifest.subsystems) ? { subsystems: mapTableRefPaths(manifestSubsystems(manifest), toAbsolute) } : {}),
  };
}

/** Arquivos de sistemas externos referenciados por caminho num manifesto já com caminhos absolutos
 * (`manifestWithAbsoluteRefs`), no principal e na tabela. */
function nestedExternalFiles(manifest: Record<string, unknown>): string[] {
  const components = [
    ...(Array.isArray(manifest.components) ? manifest.components as SubsystemComponentLike[] : []),
    ...manifestSubsystems(manifest).flatMap((definition) => definition.components ?? []),
  ];
  return [...new Set(components.filter((component) => !isSubsystemTypeId(component.typeId) && typeof component.subcircuitRef?.path === "string" && !component.subcircuitRef?.embedded).map((component) => component.subcircuitRef!.path!))];
}

/** Registra um sistema externo (arquivo `.lssubcircuit`). Sem subsistemas internos, o próprio arquivo;
 * com eles, as definições internas (namespaced) e uma cópia do principal que aponta para elas. Cópias
 * incorporadas por instância de versões anteriores dentro do arquivo também são resolvidas. Sistemas
 * externos que ele usa por referência (caminho relativo ao arquivo) são registrados antes: o Core
 * resolve instâncias aninhadas só pelo `typeId`. */
export async function registerExternalSystemFile(filePath: string, options: { replace?: boolean } = {}, visiting: Set<string> = new Set()): Promise<void> {
  const key = path.resolve(filePath).toLowerCase();
  if (visiting.has(key)) return; // referência circular entre arquivos: o Core recusa o que faltar
  visiting.add(key);
  let manifest = readJsonFile(filePath) as Record<string, unknown>;
  // Blocos legados `control.*` (docs/69): o arquivo é migrado no disco (backup verificado + relatório);
  // sem permissão de escrita, migrado só em memória e registrado pela cópia materializada.
  let migratedInMemory = false;
  if (needsControlMigration(manifest)) {
    try {
      if (await migrateFileInPlace(filePath)) manifest = readJsonFile(filePath) as Record<string, unknown>;
    } catch {
      manifest = migrateControlDocument(manifest, { librarySnapshot: LEGACY_LIBRARY_EXPORTS }).document;
      migratedInMemory = true;
    }
  }
  for (const nested of nestedExternalFiles(manifestWithAbsoluteRefs(manifest, filePath))) {
    try {
      await registerExternalSystemFile(nested, { replace: true }, visiting);
    } catch {
      // Arquivo aninhado ausente/inválido: o registro do principal relata o tipo que faltar.
    }
  }
  const components = Array.isArray(manifest.components) ? manifest.components : [];
  const legacyEmbedded = components.some((component) => typeof component === "object" && component !== null && "subcircuitRef" in component && Boolean((component as { subcircuitRef?: { embedded?: unknown } }).subcircuitRef?.embedded));
  if (manifestSubsystems(manifest).length === 0 && !legacyEmbedded && !migratedInMemory) {
    await registerManifestFile(filePath, Boolean(options.replace));
    return;
  }
  const hoisted = hoistEmbeddedSubsystems(components as SubsystemComponentLike[], manifestSubsystems(manifest));
  const { definitions, main } = flattenExternalSystem({ ...manifest, components: hoisted.components, subsystems: hoisted.table });
  for (const definition of definitions) await registerManifestFile(materializeEmbeddedSubcircuit(definition), true);
  await registerManifestFile(materializeEmbeddedSubcircuit(main), Boolean(options.replace));
}

/** Tentativa antecipada (o Core pode estar subindo): a reconstrução registra de novo e relata. */
export async function tryRegisterExternalSystemFile(filePath: string): Promise<void> {
  try {
    await registerExternalSystemFile(filePath, { replace: true });
  } catch {
    // Core ainda não pronto ou manifesto recusado: `registerProjectSubcircuitsInCore` tenta de novo.
  }
}

/** Entrada de catálogo de um subcircuito DO PROJETO por arquivo (referência externa): fora da
 * paleta, registrada no Core a cada reconstrução e descartada ao abrir outro projeto. */
export function projectLocalCatalogEntry(parsed: ReturnType<typeof parseSubcircuitManifest>, absolutePath: string): WebviewComponentCatalogEntry {
  return {
    typeId: parsed.typeId,
    label: parsed.label || parsed.typeId,
    category: "Subsistemas",
    // Só fora da paleta: `hidden` do catálogo passa para a INSTÂNCIA ao reabrir o projeto
    // (`projectComponentToWebviewComponent`) e o bloco sumia do desenho na segunda abertura.
    paletteHidden: true,
    pinCount: parsed.pinCount,
    pinIds: parsed.pinIds.length > 0 ? parsed.pinIds : undefined,
    defaultProperties: parsed.defaultProperties,
    icon: parsed.icon,
    iconFilePath: parsed.iconFilePath,
    iconSvgInline: parsed.iconSvgInline,
    package: parsed.package,
    logicSymbolPackage: parsed.logicSymbolPackage,
    disabled: false,
    mcuHost: parsed.mcuHost,
    ...(parsed.hartDeviceComponentId ? { hartDeviceComponentId: parsed.hartDeviceComponentId } : {}),
    serialPorts: parsed.serialPorts,
    // Mesmo contrato dos subcircuitos da biblioteca: componentes internos expostos (gráficos ao
    // vivo, propriedades exportadas, "Abrir Modelo Interno") resolvidos pelo arquivo.
    registeredSourceKind: "subcircuit-file",
    registeredSourceId: fileSourceId(absolutePath),
    projectLocal: true,
  };
}

/** Entradas de catálogo das definições internas (dependências primeiro), fora da paleta global. */
export function subsystemCatalogEntries(table: readonly SubsystemDefinition[], assetDir: string): WebviewComponentCatalogEntry[] {
  const language = currentLasecSimulLanguage();
  const mcus = mcuTypeIds();
  return subsystemTopologicalOrder(table).flatMap((definition) => {
    const parsed = parseSubcircuitManifest(definition, assetDir, language, mcus);
    if (parsed.schemaVersionRejected || !parsed.typeId) return [];
    return [{
      ...projectLocalCatalogEntry(parsed, assetDir),
      label: definition.name,
      registeredSourceId: subsystemSourceId(definition.typeId),
      internalSubsystem: true,
    }];
  });
}

/** Registra no Core as definições internas (dependências primeiro). Sistemas externos usados por
 * referência DENTRO delas são registrados antes. Devolve as falhas (definição -> motivo). */
export async function registerSubsystemsInCore(table: readonly SubsystemDefinition[], documentDir?: string): Promise<Map<string, string>> {
  const failures = new Map<string, string>();
  if (!state.coreClient) return failures;
  for (const definition of subsystemTopologicalOrder(table)) {
    for (const component of definition.components ?? []) {
      const refPath = component.subcircuitRef?.path;
      if (component.subcircuitRef?.embedded || typeof refPath !== "string" || isSubsystemTypeId(component.typeId)) continue;
      const absolute = path.isAbsolute(refPath) ? refPath : documentDir ? path.resolve(documentDir, refPath) : undefined;
      if (absolute) await tryRegisterExternalSystemFile(absolute);
    }
    try {
      await registerManifestFile(materializeEmbeddedSubcircuit(definition), true);
    } catch (err) {
      failures.set(definition.typeId, err instanceof Error ? err.message : String(err));
    }
  }
  return failures;
}

/** Pasta do documento aberto (projeto ou sistema externo em edição): base de caminhos relativos. */
export function currentDocumentDir(): string {
  const session = state.subcircuitEditingStack[state.subcircuitEditingStack.length - 1];
  if (session?.documentFilePath) return path.dirname(session.documentFilePath);
  return state.currentProjectFilePath ? path.dirname(state.currentProjectFilePath) : process.cwd();
}

/**
 * Recalcula as entradas de catálogo das definições internas do documento ATUAL a partir da tabela
 * (`state.schematicState.subsystems`) e registra a tabela no Core. Chamado ao abrir/importar/colar,
 * depois de criar/duplicar/renomear/excluir definições e quando desfazer/refazer troca a tabela.
 */
export async function syncDocumentSubsystems(): Promise<Map<string, string>> {
  const table = state.schematicState.subsystems ?? [];
  const entries = subsystemCatalogEntries(table, currentDocumentDir());
  for (const entry of entries) {
    registerPackage(entry.typeId, entry.package, entry.logicSymbolPackage);
    registerBlockSpec(entry.typeId, entry.blockSpec);
  }
  // Pinos das instâncias seguem a interface da definição (ao abrir/importar/colar a instância pode ter
  // sido montada antes de a entrada existir; após editar a interface, ela muda).
  const pinIdsByTypeId = new Map(entries.map((entry) => [entry.typeId, entry.pinIds ?? []]));
  let componentsChanged = false;
  const components = state.schematicState.components.map((component) => {
    const pinIds = pinIdsByTypeId.get(component.typeId);
    if (!pinIds || (component.pins.length === pinIds.length && component.pins.every((pin, index) => pin.id === pinIds[index]))) return component;
    componentsChanged = true;
    return { ...component, pins: pinIds.map((id, index) => ({ id, x: 0, y: index * 12 })) };
  });
  state.schematicState = {
    ...state.schematicState,
    catalog: [...state.schematicState.catalog.filter((entry) => !entry.internalSubsystem), ...entries],
    ...(componentsChanged ? { components } : {}),
  };
  return registerSubsystemsInCore(table, currentDocumentDir());
}

/** Tipos que uma definição interna nunca pode usar: tudo do catálogo que não é definição interna. */
export function reservedSubsystemTypeIds(): Set<string> {
  return new Set(state.schematicState.catalog.filter((entry) => !entry.internalSubsystem).map((entry) => entry.typeId));
}

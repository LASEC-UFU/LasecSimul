import * as fs from "fs";
import * as path from "path";
import { LS_PROJ_SCHEMA_VERSION, ProjectComponent, ProjectDocument } from "./ProjectTypes";

/**
 * Plantas (modelos de processo) NÃO são registradas no catálogo, na paleta nem no Core: cada projeto
 * carrega a sua incorporada (`subcircuitRef.embedded`, ver `embeddedSubcircuits.ts`), e cada planta
 * existe também como um `.lsproj` independente que se abre ou se importa ("Importar Circuito").
 *
 * Os manifestos continuam versionados em `subcircuits/` só como MODELOS de origem, listados em
 * `subcircuits/plants.json` -- que deliberadamente não é um `library.json` (nenhum carregador de
 * biblioteca o lê). Usos: incorporar a planta ao abrir projetos de versões em que ela era registrada
 * globalmente (guardavam só o `typeId`), o Laboratório de Cálculo inserir a planta de uma atividade,
 * e `scripts/generate-plant-projects.cjs` gerar os `.lsproj` independentes. Sem `vscode`: usado por
 * testes e scripts Node.
 */
export const PLANT_TEMPLATE_INDEX_FILE = "plants.json";

export interface PlantTemplate {
  typeId: string;
  /** Arquivo `.lssubcircuit`, relativo à pasta do índice. */
  manifest: string;
  /** Nome sugerido do `.lsproj` independente da planta. */
  project: string;
}

export interface LoadedPlantTemplate {
  template: PlantTemplate;
  /** Manifesto pronto para incorporar: arte relativa já embutida (`inlinePlantAssets`). */
  manifest: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pasta dos modelos: `bundled/subcircuits` no pacote instalado, `../subcircuits` no repositório
 * (mesmas raízes que `scripts/package-release.js` usa para `deviceLibraries`). */
export function resolvePlantTemplateDir(extensionPath: string): string | undefined {
  const candidates = [path.join(extensionPath, "bundled", "subcircuits"), path.resolve(extensionPath, "..", "subcircuits")];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, PLANT_TEMPLATE_INDEX_FILE)));
}

export function loadPlantTemplates(templateDir: string): PlantTemplate[] {
  const parsed = JSON.parse(fs.readFileSync(path.join(templateDir, PLANT_TEMPLATE_INDEX_FILE), "utf8")) as unknown;
  const plants = isObject(parsed) && Array.isArray(parsed.plants) ? parsed.plants : [];
  return plants.filter(isObject).flatMap((entry) => {
    const { typeId, manifest, project } = entry;
    return typeof typeId === "string" && typeof manifest === "string" && typeof project === "string" && typeId && manifest && project
      ? [{ typeId, manifest, project }]
      : [];
  });
}

/** Mesma regra de `registeredSources.ts::knownPinIdsForManifest` para subcircuitos: `interface[].pinId`. */
export function plantPinIds(manifest: Record<string, unknown>): string[] {
  const entries = Array.isArray(manifest.interface) ? manifest.interface : [];
  return entries.filter(isObject).map((entry) => entry.pinId).filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

/** Arte referenciada por caminho relativo à pasta do modelo (fundo `image` do símbolo/ícone e
 * formas `image`) passa a viajar dentro do manifesto: incorporado, ele resolve caminhos relativos
 * a partir da pasta do PROJETO, onde esses arquivos não existem. Não altera o modelo em si. */
export function inlinePlantAssets(manifest: Record<string, unknown>, templateDir: string): Record<string, unknown> {
  const clone = structuredClone(manifest);
  const readAsset = (relative: unknown): { data: string; mime: string } | undefined => {
    if (typeof relative !== "string" || !relative.trim() || relative.startsWith("data:") || path.isAbsolute(relative)) return undefined;
    const absolute = path.resolve(templateDir, relative);
    return fs.existsSync(absolute) ? { data: fs.readFileSync(absolute).toString("base64"), mime: mimeFor(absolute) } : undefined;
  };
  for (const key of ["symbol", "icon", "package", "logicSymbol"]) {
    const descriptor = clone[key];
    if (!isObject(descriptor)) continue;
    const background = descriptor.background;
    if (isObject(background) && background.kind === "image" && typeof background.data !== "string") {
      const asset = readAsset(background.asset);
      if (asset) { background.data = asset.data; background.mime = background.mime ?? asset.mime; }
    }
    for (const shape of Array.isArray(descriptor.shapes) ? descriptor.shapes.filter(isObject) : []) {
      if (shape.kind !== "image") continue;
      const asset = readAsset(shape.href);
      if (asset) shape.href = `data:${asset.mime};base64,${asset.data}`;
    }
  }
  return clone;
}

export function loadPlantTemplate(templateDir: string, template: PlantTemplate): LoadedPlantTemplate {
  const raw = JSON.parse(fs.readFileSync(path.join(templateDir, template.manifest), "utf8")) as unknown;
  if (!isObject(raw) || raw.typeId !== template.typeId) {
    throw new Error(`${template.manifest}: o typeId do arquivo não corresponde a ${template.typeId}`);
  }
  return { template, manifest: inlinePlantAssets(raw, templateDir) };
}

/** Busca por typeId com cache de leitura (cada manifesto é lido no máximo uma vez por chamada). */
export function createPlantTemplateLookup(templateDir: string | undefined): (typeId: string) => LoadedPlantTemplate | undefined {
  if (!templateDir) return () => undefined;
  let templates: PlantTemplate[];
  try {
    templates = loadPlantTemplates(templateDir);
  } catch {
    return () => undefined;
  }
  const byTypeId = new Map(templates.map((template) => [template.typeId, template]));
  const loaded = new Map<string, LoadedPlantTemplate | undefined>();
  return (typeId) => {
    if (!loaded.has(typeId)) {
      const template = byTypeId.get(typeId);
      let value: LoadedPlantTemplate | undefined;
      try {
        value = template ? loadPlantTemplate(templateDir, template) : undefined;
      } catch {
        value = undefined;
      }
      loaded.set(typeId, value);
    }
    return loaded.get(typeId);
  };
}

/** Referência incorporada (mesmo formato que os projetos de `C:\...\0II2` já usam): `path` é só o
 * nome de referência; `embedded` é o modelo inteiro. */
export function embeddedPlantRef(loaded: LoadedPlantTemplate): NonNullable<ProjectComponent["subcircuitRef"]> {
  return {
    path: loaded.template.manifest,
    lastKnownTypeId: loaded.template.typeId,
    lastKnownPinIds: plantPinIds(loaded.manifest),
    embedded: structuredClone(loaded.manifest),
  };
}

export interface LegacyPlantMigration {
  components: ProjectComponent[];
  /** Instâncias que receberam a planta incorporada. */
  embedded: Array<{ componentId: string; typeId: string }>;
}

/**
 * Migração de leitura (retrocompatível, não destrutiva): um componente que guarda só o `typeId` de
 * uma planta antes registrada globalmente (`subcircuits.process.*`/`subcircuits.tdps.*`) e nenhuma
 * `subcircuitRef` recebe o modelo incorporado. O `typeId`, o id, as propriedades, os pinos e as
 * ligações ficam exatamente como estavam; ao salvar, o projeto passa a conter a planta. Componentes
 * que já têm `subcircuitRef` (por caminho ou incorporada) nunca são tocados.
 */
export function embedLegacyPlantReferences(components: readonly ProjectComponent[], lookup: (typeId: string) => LoadedPlantTemplate | undefined): LegacyPlantMigration {
  const embedded: LegacyPlantMigration["embedded"] = [];
  const migrated = components.map((component) => {
    if (component.subcircuitRef) return component;
    const loaded = lookup(component.typeId);
    if (!loaded) return component;
    embedded.push({ componentId: component.id, typeId: component.typeId });
    return { ...component, subcircuitRef: embeddedPlantRef(loaded) };
  });
  return { components: migrated, embedded };
}

/** Nome exibido do modelo (nome do manifesto, fallback no typeId). */
export function plantDisplayName(manifest: Record<string, unknown>): string {
  return typeof manifest.name === "string" && manifest.name.trim() ? manifest.name : String(manifest.typeId ?? "planta");
}

/** Projeto independente de UMA planta: só a instância incorporada, pronta para abrir, simular ou
 * importar em outro projeto ("Importar Circuito"). Não depende de nenhum registro global. */
export function buildStandalonePlantProject(loaded: LoadedPlantTemplate, componentId = "planta"): ProjectDocument {
  return {
    schemaVersion: LS_PROJ_SCHEMA_VERSION,
    components: [{
      id: componentId,
      typeId: loaded.template.typeId,
      properties: {},
      label: plantDisplayName(loaded.manifest),
      visual: { x: 200, y: 140, rotation: 0 },
      subcircuitRef: embeddedPlantRef(loaded),
    }],
    wires: [],
    topology: { revision: 0, nodes: [], conductors: [] },
    visual: { wires: [], viewport: { x: 0, y: 0, zoom: 1 }, wireRoutes: "explicit" },
    simulationSettings: {},
  };
}

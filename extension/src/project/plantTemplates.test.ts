import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { parseSubcircuitDocument } from "../catalog/subcircuitDocument";
import type * as RegisteredSourcesModule from "../catalog/registeredSources";
import { ProjectSerializer } from "./ProjectSerializer";
import type { ProjectComponent } from "./ProjectTypes";
import {
  buildStandalonePlantProject,
  createPlantTemplateLookup,
  embedLegacyPlantReferences,
  loadPlantTemplate,
  loadPlantTemplates,
  plantPinIds,
  resolvePlantTemplateDir,
} from "./plantTemplates";

// `registeredSources` lê a língua via `vscode` (mesmo stub de registeredSources.test.ts).
type ModuleLoader = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const moduleWithLoad = require("module") as { _load: ModuleLoader };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean): unknown {
  if (request === "vscode") return { env: { language: "pt-BR" }, workspace: { getConfiguration: () => ({ get: () => "system" }) } };
  return originalLoad.apply(this, [request, parent, isMain]);
};
const { expandLibraryJsonToSources } = require("../catalog/registeredSources") as typeof RegisteredSourcesModule;

/** As 33 plantas que até esta versão eram registradas globalmente (subcircuits/library.json,
 * paleta Processo › Modelos). Nenhuma pode se perder. */
const FORMERLY_REGISTERED_PLANTS = [
  "subcircuits.process.fopdt", "subcircuits.process.heated_tank_pt100", "subcircuits.process.electric_furnace_tc",
  "subcircuits.process.control_valve", "subcircuits.process.orifice_flow_dp", "subcircuits.process.pressurized_tank_dp",
  "subcircuits.process.hydraulic_tank", "subcircuits.process.first_order_lab", "subcircuits.process.sensor_4_20",
  "subcircuits.tdps.basic_flow_loop", "subcircuits.tdps.boiler", "subcircuits.tdps.combustion_cross_limits",
  "subcircuits.tdps.combustion_dynamic_cross_limits", "subcircuits.tdps.combustion_ratio", "subcircuits.tdps.combustion_two_fuels",
  "subcircuits.tdps.cooling_plant", "subcircuits.tdps.course_fine_flow_loop", "subcircuits.tdps.ethane_plant",
  "subcircuits.tdps.frequency_response", "subcircuits.tdps.furnace_master_slave", "subcircuits.tdps.furnace",
  "subcircuits.tdps.header_pressure_three_consumers", "subcircuits.tdps.heat_exchanger", "subcircuits.tdps.industrial_boiler",
  "subcircuits.tdps.linearized_ph", "subcircuits.tdps.ph_control", "subcircuits.tdps.nonlinear_flow_processes",
  "subcircuits.tdps.four_linear_processes", "subcircuits.tdps.reactor", "subcircuits.tdps.regulatory_level",
  "subcircuits.tdps.smith_predictor", "subcircuits.tdps.split_range", "subcircuits.tdps.surge_tank",
];

(async () => {
  const { test, finish } = createTestRunner("plant templates (plantas fora do registro global)");
  const extensionRoot = path.resolve(__dirname, "../../..");
  const repoRoot = path.resolve(extensionRoot, "..");
  const templateDir = resolvePlantTemplateDir(extensionRoot);
  if (!templateDir) throw new Error("subcircuits/plants.json não encontrado a partir da extensão");
  const templates = loadPlantTemplates(templateDir);
  const library = JSON.parse(fs.readFileSync(path.join(templateDir, "library.json"), "utf8")) as { subcircuits: Array<{ typeId: string; manifest: string }> };

  await test("library.json não registra nenhuma planta (nem por typeId nem por arquivo)", () => {
    const plantTypeIds = new Set(templates.map((template) => template.typeId));
    const plantFiles = new Set(templates.map((template) => template.manifest));
    for (const entry of library.subcircuits) {
      assert(!plantTypeIds.has(entry.typeId) && !plantFiles.has(entry.manifest), `${entry.typeId} é planta e não pode estar em library.json`);
      assert(!entry.typeId.startsWith("subcircuits.process.") && !entry.typeId.startsWith("subcircuits.tdps."), `${entry.typeId} não deveria ser registrado globalmente`);
    }
    // Wrappers legados de controle foram removidos; instrumentos e ESP32 continuam registrados.
    for (const typeId of ["subcircuits.hart.smar_ld301", "subcircuits.hart.smar_tt301", "subcircuits.hart.smar_fy301", "subcircuits.esp32_devkitc_v4"]) {
      assert(library.subcircuits.some((entry) => entry.typeId === typeId), `${typeId} deveria continuar em library.json`);
    }
    assert(!library.subcircuits.some((entry) => entry.typeId.startsWith("subcircuits.control.")), "wrappers antigos nao podem permanecer na biblioteca integrada");
  });

  await test("plants.json não é uma biblioteca: o carregador de library.json não extrai nada dele", () => {
    const sources = expandLibraryJsonToSources(path.join(templateDir, "plants.json"));
    assert(sources.length === 0, `plants.json nunca pode virar fonte registrada, veio ${sources.length}`);
  });

  await test("todas as plantas antes registradas estão preservadas no índice, com arquivo e typeId corretos", () => {
    const byTypeId = new Map(templates.map((template) => [template.typeId, template]));
    for (const typeId of FORMERLY_REGISTERED_PLANTS) {
      const template = byTypeId.get(typeId);
      assert(Boolean(template), `${typeId} sumiu do índice de plantas`);
      if (!template) continue;
      const loaded = loadPlantTemplate(templateDir, template);
      assert(loaded.manifest.typeId === typeId, `${template.manifest}: typeId divergente`);
      const parsed = parseSubcircuitDocument(loaded.manifest, templateDir);
      assert(parsed.ok, `${template.manifest} deveria continuar sendo um .lssubcircuit válido`);
      assert(plantPinIds(loaded.manifest).length > 0, `${typeId} deveria expor pinos`);
    }
    assert(templates.length === FORMERLY_REGISTERED_PLANTS.length, `índice com ${templates.length} plantas, esperava ${FORMERLY_REGISTERED_PLANTS.length}`);
    const projects = templates.map((template) => template.project);
    assert(new Set(projects.map((name) => name.toLowerCase())).size === projects.length, "nomes de .lsproj independentes precisam ser únicos");
    assert(projects.every((name) => /^[a-z0-9_]+\.lsproj$/.test(name)), `nomes de .lsproj deveriam ser simples: ${projects.join(", ")}`);
  });

  await test("arte relativa do modelo vai junto ao incorporar (fundo do símbolo da FOPDT)", () => {
    const fopdt = createPlantTemplateLookup(templateDir)("subcircuits.process.fopdt");
    const background = (fopdt?.manifest.symbol as { background?: { data?: string; mime?: string } } | undefined)?.background;
    assert(typeof background?.data === "string" && background.data.length > 1000 && background.mime === "image/png", "o PNG de fundo deveria estar embutido em base64");
  });

  await test("migração incorpora só plantas legadas sem subcircuitRef e preserva id/typeId/propriedades/posição", () => {
    const lookup = createPlantTemplateLookup(templateDir);
    const existingEmbedded = { path: "minha_planta.lssubcircuit", embedded: { typeId: "subcircuits.local.minha" } };
    const components: ProjectComponent[] = [
      { id: "tank", typeId: "subcircuits.process.hydraulic_tank", properties: { custom: 1 }, label: "Tanque-1", visual: { x: 10, y: 20, rotation: 90 } },
      { id: "local", typeId: "subcircuits.local.minha", properties: {}, subcircuitRef: existingEmbedded },
      { id: "byPath", typeId: "subcircuits.tdps.boiler", properties: {}, subcircuitRef: { path: "boiler_editado.lssubcircuit" } },
      { id: "ld301", typeId: "subcircuits.hart.smar_ld301", properties: {} },
      { id: "r1", typeId: "passive.resistor", properties: { resistance: 1000 } },
    ];
    const migration = embedLegacyPlantReferences(components, lookup);
    assert(JSON.stringify(migration.embedded) === JSON.stringify([{ componentId: "tank", typeId: "subcircuits.process.hydraulic_tank" }]), `só o tanque legado deveria migrar: ${JSON.stringify(migration.embedded)}`);
    const tank = migration.components[0]!;
    assert(tank.id === "tank" && tank.typeId === "subcircuits.process.hydraulic_tank" && tank.label === "Tanque-1", "identidade preservada");
    assert(JSON.stringify(tank.properties) === JSON.stringify({ custom: 1 }) && tank.visual?.rotation === 90, "propriedades e posição preservadas");
    assert(tank.subcircuitRef?.embedded?.typeId === "subcircuits.process.hydraulic_tank", "planta incorporada");
    assert(JSON.stringify(tank.subcircuitRef?.lastKnownPinIds) === JSON.stringify(["volume", "level", "level_pct", "overflow"]), `pinos do tanque: ${JSON.stringify(tank.subcircuitRef?.lastKnownPinIds)}`);
    assert(migration.components[1]!.subcircuitRef === existingEmbedded, "planta já incorporada não é tocada");
    assert(migration.components[2]!.subcircuitRef?.embedded === undefined, "referência por caminho do usuário não é trocada pelo modelo");
    assert(migration.components[3]!.subcircuitRef === undefined && migration.components[4]!.subcircuitRef === undefined, "instrumento HART e resistor não são plantas");
    assert(embedLegacyPlantReferences(migration.components, lookup).embedded.length === 0, "migração é idempotente");
  });

  await test("projeto independente de cada planta salva e reabre com a planta incorporada", async () => {
    const serializer = new ProjectSerializer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-plant-"));
    try {
      for (const template of templates) {
        const target = path.join(tmpDir, template.project);
        await serializer.save(target, buildStandalonePlantProject(loadPlantTemplate(templateDir, template)));
        const reopened = await serializer.load(target);
        const plant = reopened.components[0];
        const definition = reopened.subsystems?.find((entry) => entry.typeId === plant?.typeId);
        assert(reopened.components.length === 1 && Boolean(plant?.typeId.startsWith("subsystem.")), `${template.project}: uma instância de subsistema interno`);
        assert(definition?.origin?.typeId === template.typeId && !plant?.subcircuitRef, `${template.project}: planta como definição interna (origem ${template.typeId})`);
        assert(embedLegacyPlantReferences(reopened.components, () => undefined).embedded.length === 0, `${template.project}: não depende de migração`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test("exemplos do repositório que usam plantas já as trazem incorporadas", async () => {
    const serializer = new ProjectSerializer();
    const plantTypeIds = new Set(templates.map((template) => template.typeId));
    const examplesDir = path.join(repoRoot, "examples", "calculo");
    for (const file of fs.readdirSync(examplesDir).filter((name) => name.endsWith(".lsproj"))) {
      const project = await serializer.load(path.join(examplesDir, file));
      assert(project.components.every((component) => !plantTypeIds.has(component.typeId) && !component.subcircuitRef?.embedded), `${file}: nenhuma planta por tipo global nem cópia por instância`);
      for (const component of project.components.filter((candidate) => candidate.typeId.startsWith("subsystem."))) {
        const definition = project.subsystems?.find((entry) => entry.typeId === component.typeId);
        assert(Boolean(definition?.origin?.typeId && plantTypeIds.has(definition.origin.typeId)), `${file}/${component.id}: planta como subsistema interno do projeto`);
      }
    }
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

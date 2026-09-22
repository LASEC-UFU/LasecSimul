import * as fs from "fs";
import * as path from "path";
import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { parseSubcircuitDocument, serializeSubcircuitDocument } from "../catalog/subcircuitDocument";
import { loadUnifiedCatalog } from "../catalog/UnifiedCatalog";
import { componentBox, packageSymbolSvg, registerPackage } from "../ui/webview/componentSymbols";
import { graphicalRuntimeProperties } from "../ui/webview/graphicsBinding";

/**
 * Gate das telas de processo TDPS reconstruídas com a biblioteca gráfica nativa
 * (`scripts/generate-tdps-process-screens.mjs`).
 *
 * O que está sendo travado aqui é o objetivo da feature: **nenhuma tela é um bitmap**, cada objeto
 * é um componente editável e todo valor mostrado vem de um binding por id estável -- e tudo isso
 * sobrevive ao parse/serialize real do `.lssubcircuit`.
 */
const repoRoot = path.resolve(process.cwd(), "..");
const subcircuitsDir = path.join(repoRoot, "subcircuits");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, ".spec", "fixtures", "tdps-v771-library.json"), "utf8")) as {
  entries: Array<{ file: string; typeId: string; label: string }>;
};

const catalog = loadUnifiedCatalog(process.cwd(), "pt-BR").catalog;
for (const entry of catalog) registerPackage(entry.typeId, entry.package, entry.logicSymbolPackage, entry.boardPackage);
const catalogByTypeId = new Map(catalog.map((entry) => [entry.typeId, entry]));

interface RawComponent { id: string; typeId: string; properties?: Record<string, unknown> }
interface RawDocument {
  components: RawComponent[];
  exposedComponents: Array<{ componentId: string; x: number; y: number; layer: number; rotation: number }>;
  symbol: { width: number; height: number; background?: { kind: string }; shapes?: unknown[] };
}

const documents = manifest.entries.map((entry) => ({
  entry,
  raw: JSON.parse(fs.readFileSync(path.join(subcircuitsDir, entry.file), "utf8")) as RawDocument,
}));

(async () => {
  const { test, finish } = createTestRunner("tdpsProcessScreens");

  await test("os 24 processos TDPS existem e foram auditados (numero vem do inventario, nao de suposicao)", () => {
    assert(manifest.entries.length === 24, `esperado 24 processos no inventario, veio ${manifest.entries.length}`);
    for (const { entry } of documents) {
      assert(fs.existsSync(path.join(subcircuitsDir, entry.file)), `${entry.file} ausente`);
    }
  });

  await test("NENHUMA tela usa bitmap de fundo -- o processo e composicao de objetos", () => {
    for (const { entry, raw } of documents) {
      const kind = raw.symbol.background?.kind ?? "none";
      assert(kind === "none", `${entry.file} ainda usa background "${kind}" -- a tela precisa ser vetorial`);
      assert((raw.symbol.shapes ?? []).length === 0, `${entry.file} tem formas "assadas" no simbolo em vez de objetos editaveis`);
    }
  });

  await test("toda tela e composta por elementos da biblioteca grafica", () => {
    for (const { entry, raw } of documents) {
      const screen = raw.components.filter((component) => component.typeId.startsWith("graphics."));
      assert(screen.length >= 8, `${entry.file} tem so ${screen.length} objetos graficos -- tela vazia demais`);
      for (const component of screen) {
        assert(catalogByTypeId.has(component.typeId), `${entry.file}: ${component.typeId} nao existe no catalogo`);
      }
    }
  });

  await test("Vazao Linear Simples usa os quatro dispositivos HMI detalhados e tubulacao volumetrica", () => {
    const basic = documents.find(({ entry }) => entry.typeId === "subcircuits.tdps.basic_flow_loop");
    assert(Boolean(basic), "processo Vazao Linear Simples ausente");
    const types = new Set(basic!.raw.components.map((component) => component.typeId));
    for (const expected of [
      "graphics.flow_transmitter",
      "graphics.controller_station",
      // As duas válvulas desenhadas à mão saíram: duplicavam o acervo herdado do IPD, e a tela
      // passa a usar a válvula do HMI Studio, que é a mesma entrada para modulante e on/off.
      "graphics.hmi.valve",
      "graphics.hmi_lamp_button",
      "graphics.slider",
    ]) assert(types.has(expected), `Vazao Linear Simples nao usa ${expected}`);
    const valves = basic!.raw.components.filter((component) => component.typeId === "graphics.hmi.valve");
    assert(valves.length === 2, `a tela deveria ter a valvula modulante e a manual, veio ${valves.length}`);
    assert(valves.some((valve) => valve.properties?.throttle === true) && valves.some((valve) => valve.properties?.throttle === false),
      "uma valvula e' modulante e a outra on/off -- mesma entrada, propriedades diferentes");
    const commandButtons = basic!.raw.components.filter((component) => component.typeId === "graphics.hmi_lamp_button");
    assert(commandButtons.length === 2, `painel deveria ter dois botoes luminosos, veio ${commandButtons.length}`);
    assert(commandButtons.every((button) => button.properties?.actionMode === "toggle"), "botoes luminosos perderam a acao persistida");
    const sliders = basic!.raw.components.filter((component) => component.typeId === "graphics.slider");
    assert(sliders.length === 1 && sliders[0]!.properties?.actionMode === "set", "setpoint deveria usar slider operador real");
    const pipes = basic!.raw.components.filter((component) => component.typeId === "graphics.pipe");
    assert(pipes.some((pipe) => Number(pipe.properties?.height) >= 24), "linha principal deveria ter secao volumetrica, nao um traco fino");
    assert(basic!.raw.components.filter((component) => component.id.startsWith("scr-")).length >= 35, "sinotico curado perdeu detalhes do supervisório");
  });

  await test("so os objetos da TELA sao expostos; os blocos de controle ficam internos", () => {
    for (const { entry, raw } of documents) {
      const byId = new Map(raw.components.map((component) => [component.id, component]));
      for (const exposed of raw.exposedComponents) {
        const component = byId.get(exposed.componentId);
        assert(Boolean(component), `${entry.file}: exposicao orfa ${exposed.componentId}`);
        assert(component!.typeId.startsWith("graphics."), `${entry.file}: ${component!.typeId} exposto -- so a tela deveria ser`);
      }
    }
  });

  await test("todo binding aponta para um componente interno REAL, por id estavel", () => {
    for (const { entry, raw } of documents) {
      const ids = new Set(raw.components.map((component) => component.id));
      let bound = 0;
      for (const component of raw.components) {
        const source = component.properties?.bindSource;
        if (typeof source !== "string" || source.length === 0) continue;
        bound += 1;
        assert(ids.has(source), `${entry.file}: ${component.id}.bindSource="${source}" nao resolve para nenhum componente interno`);
      }
      assert(bound > 0, `${entry.file} nao tem nenhum objeto ligado a simulacao`);
    }
  });

  await test("z-order e serializado: `layer` acompanha a ordem de desenho, sem repetir", () => {
    for (const { entry, raw } of documents) {
      const layers = raw.exposedComponents.map((exposed) => exposed.layer);
      assert(new Set(layers).size === layers.length, `${entry.file} tem camadas duplicadas`);
      assert(layers.every((layer, index) => index === 0 || layer > layers[index - 1]!), `${entry.file} tem camadas fora de ordem`);
    }
  });

  await test("save -> reopen: parse/serialize real preserva objetos, bindings e camadas", () => {
    for (const { entry, raw } of documents) {
      const parsed = parseSubcircuitDocument(raw, subcircuitsDir);
      assert(parsed.ok, `${entry.file} nao passou na validacao do .lssubcircuit: ${parsed.ok ? "" : parsed.reason}`);
      if (!parsed.ok) continue;
      const reserialized = serializeSubcircuitDocument(parsed.document) as unknown as RawDocument;
      const before = raw.components.filter((component) => component.typeId.startsWith("graphics."));
      const after = reserialized.components.filter((component) => component.typeId.startsWith("graphics."));
      assert(after.length === before.length, `${entry.file}: ${before.length} objetos viraram ${after.length} ao reabrir`);
      for (const original of before) {
        const round = after.find((component) => component.id === original.id);
        assert(Boolean(round), `${entry.file}: objeto ${original.id} sumiu ao reabrir`);
        assert(round!.properties?.bindSource === original.properties?.bindSource, `${entry.file}: ${original.id} perdeu o binding ao reabrir`);
        assert(round!.properties?.width === original.properties?.width, `${entry.file}: ${original.id} perdeu a geometria ao reabrir`);
      }
      assert(reserialized.exposedComponents.length === raw.exposedComponents.length, `${entry.file} perdeu exposicoes ao reabrir`);
    }
  });

  await test("toda tela renderiza vetor real, sem NaN, e cabe na propria moldura", () => {
    for (const { entry, raw } of documents) {
      const byId = new Map(raw.components.map((component) => [component.id, component]));
      for (const exposed of raw.exposedComponents) {
        const component = byId.get(exposed.componentId)!;
        const properties = { ...component.properties, ...graphicalRuntimeProperties(component.properties ?? {}, () => undefined) };
        const svg = packageSymbolSvg(component.typeId, properties, component.id, "board") ?? "";
        assert(svg.length > 0, `${entry.file}: ${component.id} (${component.typeId}) nao desenhou nada`);
        assert(!svg.includes("NaN"), `${entry.file}: ${component.id} gerou NaN`);
        const box = componentBox(component.typeId, properties);
        const right = exposed.x + (exposed.rotation % 180 === 0 ? box.width : box.height);
        const bottom = exposed.y + (exposed.rotation % 180 === 0 ? box.height : box.width);
        assert(right <= raw.symbol.width + 1, `${entry.file}: ${component.id} vaza pela direita (${right} > ${raw.symbol.width})`);
        assert(bottom <= raw.symbol.height + 1, `${entry.file}: ${component.id} vaza por baixo (${bottom} > ${raw.symbol.height})`);
      }
    }
  });

  await test("a simulacao continua intacta: blocos de controle e topologia preservados", () => {
    for (const { entry, raw } of documents) {
      const control = raw.components.filter((component) => component.typeId.startsWith("control."));
      assert(control.length > 0, `${entry.file} perdeu os blocos de controle`);
      const tunnels = raw.components.filter((component) => component.typeId === "connectors.tunnel");
      assert(tunnels.length > 0, `${entry.file} perdeu os tuneis de interface`);
    }
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

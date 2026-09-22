import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer.js";
import { reconcileDsl } from "./DslReconciler.js";
import { parseDsl } from "./DslParser.js";
import { stateToDsl } from "./DslSerializer.js";
import { loadUnifiedCatalog } from "../catalog/UnifiedCatalog.js";
import type { WebviewProjectState } from "../ui/webview/model.js";

/**
 * Round-trip Canvas -> Lasec DSL -> Canvas dos elementos da biblioteca gráfica de supervisório.
 *
 * O contrato verificado aqui é o da task §19: o round-trip **não pode perder objeto gráfico
 * nenhum**, nem as propriedades que definem sua aparência e seu binding. O que o DSL hoje NÃO
 * carrega é geometria de tela (`x`/`y`/`rotation`) -- e isso vale para QUALQUER componente, não só
 * os gráficos: `DslSerializer` nunca emitiu posição. `reconcileDsl` preserva a posição anterior de
 * um id já existente; um id novo nasce numa posição de grade arbitrária. A limitação está
 * documentada em `docs/44-biblioteca-grafica-supervisorio-fase0.md` (§3/G5); estes testes fixam o
 * comportamento real para que uma mudança futura no DSL seja uma decisão consciente, não um
 * acidente.
 */
const catalog = loadUnifiedCatalog(process.cwd(), "pt-BR").catalog;

function stateWith(components: Array<Record<string, unknown>>): WebviewProjectState {
  return {
    components: components.map((component) => ({ pins: [], rotation: 0, ...component })),
    topology: { revision: 1, nodes: [], conductors: [] },
  } as unknown as WebviewProjectState;
}

const tankEntry = catalog.find((entry) => entry.typeId === "graphics.hmi.tank")!;
const tank = {
  id: "tanque-1", typeId: "graphics.hmi.tank", label: "Tanque", x: 120, y: 80,
  properties: { ...tankEntry.defaultProperties, width: 180, height: 240, value: 42, bindSource: "sonda-nivel", bindMax: 25, bindUnit: "kPa" },
};

(async () => {
  const { test, finish } = createTestRunner("graphicsDslRoundTrip");

  await test("objeto grafico sobrevive ao round-trip pelo DSL", () => {
    const state = stateWith([tank]);
    const parsed = parseDsl(stateToDsl(state));
    assert(parsed.document !== undefined, "o DSL gerado deveria ser analisavel");
    const result = reconcileDsl(parsed.document!, state, catalog);
    assert(result.diagnostics.filter((entry) => entry.severity === "error").length === 0,
      `round-trip nao deveria gerar erro: ${JSON.stringify(result.diagnostics)}`);
    assert(result.state !== undefined, "o round-trip deveria reconciliar");
    const round = result.state!.components.find((component) => component.id === "tanque-1");
    assert(Boolean(round), "o objeto grafico NAO pode sumir no round-trip");
    assert(round!.typeId === "graphics.hmi.tank", "o typeId deveria ser preservado");
  });

  await test("aparencia e binding sobrevivem com os mesmos valores", () => {
    const state = stateWith([tank]);
    const result = reconcileDsl(parseDsl(stateToDsl(state)).document!, state, catalog);
    const round = result.state!.components.find((component) => component.id === "tanque-1")!;
    assert(round.properties.width === 180 && round.properties.height === 240, "geometria do simbolo preservada");
    assert(round.properties.value === 42, "valor estatico preservado");
    assert(round.properties.bindSource === "sonda-nivel", "a FONTE do binding e o que nao pode se perder");
    assert(round.properties.bindMax === 25 && round.properties.bindUnit === "kPa", "faixa/unidade do binding preservadas");
  });

  await test("binding referencia id estavel: o DSL nao guarda rotulo nenhum como ligacao", () => {
    const source = stateToDsl(stateWith([tank]));
    assert(source.includes('bindSource = "sonda-nivel"'), "o DSL deveria emitir a fonte por id");
    assert(!source.includes("Tanque\""), "o rotulo visivel nao participa da ligacao");
  });

  await test("propriedade de UI (agrupamento) atravessa o DSL sem virar erro de schema", () => {
    const grouped = { ...tank, properties: { ...tank.properties, __ui_group: "g-1" } };
    const state = stateWith([grouped]);
    const result = reconcileDsl(parseDsl(stateToDsl(state)).document!, state, catalog);
    const errors = result.diagnostics.filter((entry) => entry.severity === "error");
    assert(errors.length === 0, `agrupamento nao deveria ser rejeitado: ${JSON.stringify(errors)}`);
    assert(result.state!.components[0]!.properties.__ui_group === "g-1", "o grupo deveria sobreviver");
  });

  await test("uma tela inteira (varios objetos) atravessa sem perder nenhum", () => {
    const screen = ["graphics.pipe", "graphics.hmi.tank", "graphics.hmi.valve", "graphics.hmi.pump", "graphics.instrument", "graphics.value_display"]
      .map((typeId, index) => ({
        id: `scr-${index}`, typeId, label: typeId, x: 40 * index, y: 60,
        properties: { ...catalog.find((entry) => entry.typeId === typeId)!.defaultProperties, bindSource: `obs-${index}` },
      }));
    const state = stateWith(screen);
    const result = reconcileDsl(parseDsl(stateToDsl(state)).document!, state, catalog);
    assert(result.state !== undefined, "a tela inteira deveria reconciliar");
    assert(result.state!.components.length === screen.length, `esperado ${screen.length} objetos, veio ${result.state!.components.length}`);
    for (const original of screen) {
      const round = result.state!.components.find((component) => component.id === original.id);
      assert(Boolean(round), `${original.id} sumiu no round-trip`);
      assert(round!.properties.bindSource === original.properties.bindSource, `${original.id} perdeu o binding`);
    }
  });

  await test("LIMITACAO CONHECIDA: o DSL nao carrega posicao -- preservada so para id ja existente", () => {
    const state = stateWith([tank]);
    const source = stateToDsl(state);
    assert(!source.includes("120"), "o DSL nao emite x/y de NENHUM componente (limitacao pre-existente, ver docs/44)");
    // Reconciliando contra um estado que JA tem o id, a posicao anterior e mantida.
    const kept = reconcileDsl(parseDsl(source).document!, state, catalog).state!.components[0]!;
    assert(kept.x === 120 && kept.y === 80, "posicao anterior deveria ser preservada para id existente");
    // Contra um estado vazio, o objeto nasce numa posicao de grade arbitraria -- nao se perde.
    const fresh = reconcileDsl(parseDsl(source).document!, stateWith([]), catalog).state!.components[0]!;
    assert(fresh.typeId === "graphics.hmi.tank", "o objeto continua existindo mesmo sem posicao no DSL");
    assert(Number.isFinite(fresh.x) && Number.isFinite(fresh.y), "posicao nova precisa ser um numero valido");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

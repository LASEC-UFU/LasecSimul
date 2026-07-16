import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { SYMBOL_PIN_TYPE_ID, TUNNEL_TYPE_ID, WebviewComponentModel, WebviewProjectState } from "../ui/webview/model";
import {
  categoryForTypeId,
  findDuplicateElementIds,
  getElement,
  getExposedComponentEntry,
  moveElement,
  removeElement,
  removeExposedComponentEntry,
  setExposedComponentEntry,
  updateElement,
} from "./schematicModel";

function makeComponent(id: string, typeId: string, overrides: Partial<WebviewComponentModel> = {}): WebviewComponentModel {
  return { id, typeId, label: id, x: 0, y: 0, rotation: 0, pins: [], properties: {}, ...overrides };
}

function baseState(): WebviewProjectState {
  return {
    topology: { revision: 0, nodes: [], conductors: [] },
    catalog: [],
    components: [makeComponent("r1", "passive.resistor"), makeComponent("tun1", TUNNEL_TYPE_ID, { properties: { name: "VCC", pinId: "VCC" } })],
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedComponentIds: [],
    selectedWireIds: [],
    symbolElements: [makeComponent("pin1", SYMBOL_PIN_TYPE_ID, { properties: { pinId: "VCC" } })],
    iconElements: [makeComponent("shape1", "graphics.rectangle")],
    exposedComponents: [],
  };
}

(async () => {
  const { test, finish } = createTestRunner("schematicModel - modelo canônico de elementos por id, qualquer escopo");

  await test("categoryForTypeId deriva categoria do typeId, nunca de um campo à parte", () => {
    assert(categoryForTypeId(TUNNEL_TYPE_ID) === "tunnel", "tunnel deveria ser categoria tunnel");
    assert(categoryForTypeId(SYMBOL_PIN_TYPE_ID) === "pin", "symbol.pin deveria ser categoria pin");
    assert(categoryForTypeId("graphics.rectangle") === "graphic", "graphics.* deveria ser categoria graphic");
    assert(categoryForTypeId("passive.resistor") === "component", "resto deveria cair em component");
  });

  await test("getElement acha um elemento em QUALQUER escopo sem quem chama saber qual array", () => {
    const state = baseState();
    const schematic = getElement(state, "r1");
    assert(schematic?.scope === "schematic" && schematic.category === "component", "r1 deveria ser achado no escopo schematic");
    const symbol = getElement(state, "pin1");
    assert(symbol?.scope === "symbol" && symbol.category === "pin", "pin1 deveria ser achado no escopo symbol");
    const icon = getElement(state, "shape1");
    assert(icon?.scope === "icon" && icon.category === "graphic", "shape1 deveria ser achado no escopo icon");
    assert(getElement(state, "nao-existe") === undefined, "id inexistente deveria devolver undefined, nunca lançar");
  });

  await test("findDuplicateElementIds detecta id usado em mais de um escopo ao mesmo tempo", () => {
    const state = baseState();
    const withDuplicate: WebviewProjectState = { ...state, symbolElements: [...state.symbolElements, makeComponent("r1", SYMBOL_PIN_TYPE_ID)] };
    const duplicates = findDuplicateElementIds(withDuplicate);
    assert(duplicates.includes("r1"), `esperava "r1" como duplicado entre escopos, recebido: ${duplicates.join(",")}`);
    assert(findDuplicateElementIds(state).length === 0, "estado sem duplicatas não deveria reportar nada");
  });

  await test("updateElement aplica patch em qualquer escopo, devolve o ref atualizado", () => {
    const state = baseState();
    const result = updateElement(state, "pin1", { x: 42, y: 24 });
    assert(result.ok === true, "update de elemento existente deveria ter sucesso");
    if (result.ok) {
      assert(result.value.ref.element.x === 42 && result.value.ref.element.y === 24, "ref devolvido deveria refletir o patch");
      const symbolElement = result.value.state.symbolElements.find((e) => e.id === "pin1");
      assert(symbolElement?.x === 42, "elemento no array symbolElements deveria ter sido atualizado");
      assert(state.symbolElements.find((e) => e.id === "pin1")?.x === 0, "estado original não deveria ser mutado (imutabilidade)");
    }
  });

  await test("updateElement de id inexistente devolve erro explícito, nunca no-op silencioso", () => {
    const result = updateElement(baseState(), "nao-existe", { x: 1 });
    assert(result.ok === false, "update de id inexistente deveria falhar explicitamente");
  });

  await test("removeElement de um pino cascateia: remove também TODO túnel interno ligado ao mesmo pinId", () => {
    const state = baseState();
    const result = removeElement(state, "pin1");
    assert(result.ok === true, "remover pino existente deveria ter sucesso");
    if (result.ok) {
      assert(result.value.state.symbolElements.length === 0, "pino deveria ter sido removido de symbolElements");
      assert(result.value.state.components.every((c) => c.id !== "tun1"), "túnel interno ligado ao mesmo pinId deveria ter sido removido em cascata");
    }
  });

  await test("removeElement BLOQUEIA apagar o único túnel de um pino, com mensagem acionável", () => {
    const state = baseState();
    const result = removeElement(state, "tun1");
    assert(result.ok === false, "deveria bloquear remover o único túnel do pino VCC");
    if (!result.ok) {
      assert(result.error.includes("VCC"), "mensagem deveria mencionar o pinId afetado");
    }
  });

  await test("removeElement permite apagar um túnel quando outro(s) ainda restam pro mesmo pino", () => {
    const state = baseState();
    const withExtraTunnel: WebviewProjectState = {
      ...state,
      components: [...state.components, makeComponent("tun2", TUNNEL_TYPE_ID, { properties: { name: "VCC", pinId: "VCC" } })],
    };
    const result = removeElement(withExtraTunnel, "tun1");
    assert(result.ok === true, "deveria permitir apagar 1 dos 2 túneis do mesmo pino");
    if (result.ok) {
      assert(result.value.state.components.some((c) => c.id === "tun2"), "o outro túnel deveria sobreviver");
      assert(result.value.state.symbolElements.some((e) => e.id === "pin1"), "apagar um túnel extra não deveria afetar o pino");
    }
  });

  await test("removeElement de um túnel comum (sem pinId) nunca é bloqueado", () => {
    const state = baseState();
    const withPlainTunnel: WebviewProjectState = { ...state, components: [...state.components, makeComponent("plain-tun", TUNNEL_TYPE_ID, { properties: { name: "NET1" } })] };
    const result = removeElement(withPlainTunnel, "plain-tun");
    assert(result.ok === true, "túnel interno comum (sem pinId) nunca deveria ser bloqueado ao apagar");
  });

  await test("removeElement de um componente schematic também remove sua exposição órfã em exposedComponents[]", () => {
    let state = baseState();
    const exposed = setExposedComponentEntry(state, { componentId: "r1", x: 0, y: 0, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    assert(exposed.ok === true, "expor r1 deveria ter sucesso");
    if (exposed.ok) state = exposed.value;
    assert(state.exposedComponents.length === 1, "deveria ter 1 exposição antes de remover");

    const result = removeElement(state, "r1");
    assert(result.ok === true, "remover r1 deveria ter sucesso");
    if (result.ok) {
      assert(result.value.state.exposedComponents.length === 0, "remover o componente exposto deveria remover a exposição órfã junto");
    }
  });

  await test("removeElement de id inexistente devolve erro explícito", () => {
    const result = removeElement(baseState(), "nao-existe");
    assert(result.ok === false, "remover id inexistente deveria falhar explicitamente");
  });

  await test("removeElement preserva elementos de OUTROS escopos intocados", () => {
    const state = baseState();
    const result = removeElement(state, "shape1");
    assert(result.ok === true, "remover shape1 deveria ter sucesso");
    if (result.ok) {
      assert(result.value.state.components.length === state.components.length, "components não deveria ser afetado ao remover um ícone");
      assert(result.value.state.symbolElements.length === state.symbolElements.length, "symbolElements não deveria ser afetado ao remover um ícone");
      assert(result.value.state.iconElements.length === 0, "iconElements deveria ter perdido o elemento removido");
    }
  });

  await test("moveElement rejeita mover um pino pra fora do escopo symbol", () => {
    const state = baseState();
    const result = moveElement(state, "pin1", "icon");
    assert(result.ok === false, "pino só pode existir no escopo symbol");
  });

  await test("moveElement rejeita colisão de id no escopo de destino", () => {
    const state = baseState();
    const collidingState: WebviewProjectState = { ...state, iconElements: [...state.iconElements, makeComponent("r1", "graphics.text")] };
    const result = moveElement(collidingState, "r1", "icon");
    assert(result.ok === false, "mover pra um escopo que já tem esse id deveria falhar, nunca sobrescrever silenciosamente");
  });

  await test("moveElement move um elemento não-pino entre escopos com sucesso", () => {
    const state = baseState();
    const result = moveElement(state, "shape1", "symbol");
    assert(result.ok === true, "mover uma forma comum entre escopos deveria funcionar");
    if (result.ok) {
      assert(result.value.state.iconElements.length === 0, "elemento deveria ter saído do escopo de origem");
      assert(result.value.state.symbolElements.some((e) => e.id === "shape1"), "elemento deveria estar no escopo de destino");
      assert(result.value.ref.scope === "symbol", "ref devolvido deveria refletir o novo escopo");
    }
  });

  await test("setExposedComponentEntry rejeita expor um componente inexistente ou fora do escopo schematic", () => {
    const state = baseState();
    const missing = setExposedComponentEntry(state, { componentId: "nao-existe", x: 0, y: 0, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    assert(missing.ok === false, "expor componente inexistente deveria falhar");
    const wrongScope = setExposedComponentEntry(state, { componentId: "pin1", x: 0, y: 0, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    assert(wrongScope.ok === false, "expor um pino do próprio Símbolo (fora do escopo schematic) deveria ser rejeitado");
  });

  await test("setExposedComponentEntry SUBSTITUI (nunca duplica) quando já há exposição pro mesmo componentId", () => {
    let state = baseState();
    const first = setExposedComponentEntry(state, { componentId: "r1", x: 1, y: 1, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    assert(first.ok === true, "primeira exposição deveria ter sucesso");
    if (first.ok) state = first.value;
    const second = setExposedComponentEntry(state, { componentId: "r1", x: 9, y: 9, rotation: 90, flipH: true, flipV: false, scale: 2, layer: 1 });
    assert(second.ok === true, "segunda exposição (substituição) deveria ter sucesso");
    if (second.ok) {
      assert(second.value.exposedComponents.length === 1, "deveria continuar com 1 entrada, nunca duplicar");
      assert(second.value.exposedComponents[0]!.x === 9, "entrada deveria refletir os novos valores");
    }
  });

  await test("getExposedComponentEntry/removeExposedComponentEntry redondos: adicionar, ler, remover", () => {
    let state = baseState();
    const added = setExposedComponentEntry(state, { componentId: "r1", x: 0, y: 0, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    assert(added.ok === true, "expor r1 deveria ter sucesso");
    if (added.ok) state = added.value;
    assert(getExposedComponentEntry(state, "r1") !== undefined, "deveria achar a exposição recém-criada");
    state = removeExposedComponentEntry(state, "r1");
    assert(getExposedComponentEntry(state, "r1") === undefined, "após remover, não deveria mais achar a exposição");
    assert(state.components.some((c) => c.id === "r1"), "remover a exposição nunca deveria afetar o componente interno em si");
  });

  finish();
})();

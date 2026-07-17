import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { TUNNEL_TYPE_ID } from "../ui/webview/model";
import { SUBCIRCUIT_SCHEMA_VERSION, SubcircuitDocument } from "./subcircuitDocument";
import { createPin } from "./subcircuitPinModel";
import { setExposedComponent } from "./subcircuitExposedComponents";
import { validateSubcircuitDocument } from "./subcircuitValidation";

function emptyDocument(): SubcircuitDocument {
  return {
    schemaVersion: SUBCIRCUIT_SCHEMA_VERSION,
    typeId: "subcircuits.demo",
    name: "Demo",
    components: [],
    topology: { revision: 0, nodes: [], conductors: [] },
    interface: [],
    exposedComponents: [],
    exportedPropertyComponentIds: [],
  };
}

function makeIdFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

(async () => {
  const { test, finish } = createTestRunner("subcircuitValidation - lista obrigatória de validação pré-save");

  await test("documento válido mínimo não produz erros nem warnings", () => {
    const created = createPin(emptyDocument(), { label: "VCC", x: 0, y: 8, angle: 180 }, makeIdFactory("id"));
    const result = validateSubcircuitDocument(created.document);
    assert(result.errors.length === 0, `não esperava erros, recebido: ${result.errors.join(" | ")}`);
    assert(result.warnings.length === 0, `não esperava warnings, recebido: ${result.warnings.join(" | ")}`);
  });

  await test("detecta id duplicado entre components[] e symbol.pins[] (mesmo namespace, checado junto)", () => {
    const doc: SubcircuitDocument = {
      ...emptyDocument(),
      components: [{ id: "dup", typeId: "passive.resistor", properties: {}, visual: { x: 0, y: 0, rotation: 0 } }],
      symbol: { width: 56, height: 40, pins: [{ id: "dup", label: "P1", x: 0, y: 8, angle: 180, length: 8 }] },
    };
    const result = validateSubcircuitDocument(doc);
    assert(result.errors.some((e) => e.includes("dup")), `esperava erro de id duplicado mencionando "dup", recebido: ${result.errors.join(" | ")}`);
  });

  await test("detecta pino sem nenhum túnel associado", () => {
    const doc: SubcircuitDocument = {
      ...emptyDocument(),
      symbol: { width: 56, height: 40, pins: [{ id: "P1", label: "P1", x: 0, y: 8, angle: 180, length: 8 }] },
    };
    const result = validateSubcircuitDocument(doc);
    assert(result.errors.some((e) => e.includes("P1") && e.includes("túnel")), `esperava erro de pino sem túnel, recebido: ${result.errors.join(" | ")}`);
  });

  await test("detecta túnel referenciando um pino inexistente", () => {
    const doc: SubcircuitDocument = {
      ...emptyDocument(),
      components: [{ id: "tun1", typeId: TUNNEL_TYPE_ID, properties: { name: "FANTASMA", pinId: "FANTASMA" }, visual: { x: 0, y: 0, rotation: 0 } }],
      symbol: { width: 56, height: 40, pins: [] },
    };
    const result = validateSubcircuitDocument(doc);
    assert(result.errors.some((e) => e.includes("FANTASMA")), `esperava erro de túnel referenciando pino inexistente, recebido: ${result.errors.join(" | ")}`);
  });

  await test("pino com pinId vazio/inválido gera erro", () => {
    const doc: SubcircuitDocument = {
      ...emptyDocument(),
      symbol: { width: 56, height: 40, pins: [{ id: "   ", label: "P1", x: 0, y: 8, angle: 180, length: 8 }] },
    };
    const result = validateSubcircuitDocument(doc);
    assert(result.errors.some((e) => e.includes("sem identificador")), `esperava erro de pino sem pinId válido, recebido: ${result.errors.join(" | ")}`);
  });

  await test("exposedComponents[] com referência órfã vira warning (auto-fix seguro) em vez de erro bloqueante", () => {
    const created = createPin(emptyDocument(), { label: "VCC", x: 0, y: 8, angle: 180 }, makeIdFactory("id"));
    const doc: SubcircuitDocument = { ...created.document, exposedComponents: [{ componentId: "nao-existe", x: 0, y: 0, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 }] };
    const result = validateSubcircuitDocument(doc);
    assert(result.errors.length === 0, "referência órfã em exposedComponents deveria ser corrigível automaticamente, não bloqueante");
    assert(result.warnings.some((w) => w.includes("nao-existe")), `esperava warning sobre a referência órfã, recebido: ${result.warnings.join(" | ")}`);
    assert(result.autoFixed !== undefined, "deveria oferecer autoFixed removendo a referência órfã");
    assert(result.autoFixed?.exposedComponents.length === 0, "documento auto-corrigido não deveria ter mais a referência órfã");
  });

  await test("exposição duplicada do mesmo componente vira warning + auto-fix, mantendo só a primeira (nunca escolhe arbitrariamente)", () => {
    const doc: SubcircuitDocument = {
      ...emptyDocument(),
      components: [{ id: "led1", typeId: "outputs.led", properties: {}, visual: { x: 0, y: 0, rotation: 0 } }],
      exposedComponents: [
        { componentId: "led1", x: 1, y: 1, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 },
        { componentId: "led1", x: 2, y: 2, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 1 },
      ],
    };
    const result = validateSubcircuitDocument(doc);
    assert(result.errors.length === 0, "duplicata de exposição deveria ser corrigível, não bloqueante");
    assert(result.autoFixed?.exposedComponents.length === 1, "auto-fix deveria manter só 1 exposição");
    assert(result.autoFixed?.exposedComponents[0]!.x === 1, "auto-fix deveria manter a PRIMEIRA ocorrência");
  });

  await test("detecta shape com kind não suportado no symbol/icon", () => {
    const doc: SubcircuitDocument = {
      ...emptyDocument(),
      symbol: { width: 56, height: 40, pins: [], shapes: [{ kind: "triangle" as never, x: 0, y: 0 }] },
    };
    const result = validateSubcircuitDocument(doc);
    assert(result.errors.some((e) => e.includes("triangle")), `esperava erro de kind não suportado, recebido: ${result.errors.join(" | ")}`);
  });

  await test("shape de imagem/svg sem href nem value gera warning (não bloqueante, elemento só ficará invisível)", () => {
    const doc: SubcircuitDocument = {
      ...emptyDocument(),
      icon: { width: 24, height: 24, pins: [], shapes: [{ kind: "image", x: 0, y: 0, w: 10, h: 10 }] },
    };
    const result = validateSubcircuitDocument(doc);
    assert(result.errors.length === 0, "imagem sem fonte não deveria ser erro bloqueante");
    assert(result.warnings.some((w) => w.includes("ícone")), `esperava warning mencionando o ícone, recebido: ${result.warnings.join(" | ")}`);
  });

  await test("propriedade não serializável (função) de um componente interno é erro bloqueante", () => {
    const doc: SubcircuitDocument = {
      ...emptyDocument(),
      components: [{ id: "c1", typeId: "passive.resistor", properties: { resistance: 220, badFn: () => {} }, visual: { x: 0, y: 0, rotation: 0 } }],
    };
    const result = validateSubcircuitDocument(doc);
    assert(result.errors.some((e) => e.includes("badFn") && e.includes("c1")), `esperava erro de propriedade não serializável, recebido: ${result.errors.join(" | ")}`);
  });

  await test("determinismo: validar o mesmo documento 2x produz exatamente os mesmos erros/warnings", () => {
    const created = createPin(emptyDocument(), { label: "VCC", x: 0, y: 8, angle: 180 }, makeIdFactory("id"));
    const withExposed = setExposedComponent(created.document, { componentId: "nao-existe", x: 0, y: 0, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 });
    const first = validateSubcircuitDocument(withExposed);
    const second = validateSubcircuitDocument(withExposed);
    assert(JSON.stringify(first.errors) === JSON.stringify(second.errors), "erros deveriam ser idênticos entre chamadas repetidas");
    assert(JSON.stringify(first.warnings) === JSON.stringify(second.warnings), "warnings deveriam ser idênticos entre chamadas repetidas");
  });

  await test("determinismo: ordem diferente de components[] não muda o CONJUNTO de erros produzidos", () => {
    const doc: SubcircuitDocument = {
      ...emptyDocument(),
      components: [
        { id: "a", typeId: "passive.resistor", properties: {}, visual: { x: 0, y: 0, rotation: 0 } },
        { id: "b", typeId: "passive.resistor", properties: {}, visual: { x: 0, y: 0, rotation: 0 } },
      ],
      symbol: { width: 56, height: 40, pins: [{ id: "a", label: "P1", x: 0, y: 8, angle: 180, length: 8 }] },
    };
    const reordered: SubcircuitDocument = { ...doc, components: [...doc.components].reverse() };
    const resultA = validateSubcircuitDocument(doc);
    const resultB = validateSubcircuitDocument(reordered);
    assert(JSON.stringify([...resultA.errors].sort()) === JSON.stringify([...resultB.errors].sort()), "conjunto de erros deveria ser o mesmo independente da ordem de components[]");
  });

  finish();
})();

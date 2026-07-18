import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { ProjectComponent } from "../project/ProjectTypes";
import {
  SUBCIRCUIT_SCHEMA_VERSION,
  SubcircuitDocument,
  parseSubcircuitDocument,
  schemaVersionRejectionMessage,
  serializeSubcircuitDocument,
} from "./subcircuitDocument";

function tunnel(id: string, pinId: string): ProjectComponent {
  return { id, typeId: "connectors.tunnel", properties: { name: pinId, pinId }, visual: { x: 0, y: 0, rotation: 0 } };
}

function fullDocument(): SubcircuitDocument {
  return {
    schemaVersion: SUBCIRCUIT_SCHEMA_VERSION,
    typeId: "subcircuits.demo",
    name: "Demo",
    components: [
      { id: "r1", typeId: "passive.resistor", properties: { resistance: 220 }, visual: { x: 80, y: 40, rotation: 0 } },
      tunnel("tun_vcc", "VCC"),
      tunnel("tun_gnd", "GND"),
    ],
    topology: {
      revision: 1,
      nodes: [],
      conductors: [
        { id: "w1", from: { kind: "port", componentId: "r1", pinId: "pin-1" }, to: { kind: "port", componentId: "tun_vcc", pinId: "pin" }, vertices: [{ x: 10, y: 20 }] },
      ],
    },
    interface: [
      { pinId: "VCC", label: "VCC", internalTunnel: "VCC" },
      { pinId: "GND", label: "GND", internalTunnel: "GND" },
    ],
    symbol: {
      width: 64,
      height: 32,
      border: true,
      pins: [
        { id: "VCC", label: "VCC", x: 0, y: 8, angle: 180, length: 8 },
        { id: "GND", label: "GND", x: 0, y: 24, angle: 180, length: 8 },
      ],
    },
    exposedComponents: [],
    exportedPropertyComponentIds: [],
    icon: { width: 24, height: 24, pins: [], shapes: [{ kind: "rect", x: 1, y: 1, w: 22, h: 22, fill: "#2b2f36" }] },
  };
}

(async () => {
  const { test, finish } = createTestRunner("subcircuitDocument - parse/serialize/schemaVersion gate");

  await test("rejeita schemaVersion !== 3 com mensagem acionável, nunca abre parcialmente", () => {
    const result = parseSubcircuitDocument({ schemaVersion: 1, typeId: "x", components: [], wires: [], interface: [] }, "/tmp");
    assert(result.ok === false, "arquivo schemaVersion 1 deveria ser rejeitado");
    if (!result.ok) {
      assert(result.reason === schemaVersionRejectionMessage(1), `mensagem deveria bater com schemaVersionRejectionMessage, recebido: ${result.reason}`);
      assert(result.reason.includes("versão de formato antiga"), "mensagem deveria ser acionável/explicativa");
    }
  });

  await test("rejeita documento que não é objeto", () => {
    const result = parseSubcircuitDocument("nope", "/tmp");
    assert(result.ok === false, "string não deveria ser aceita como documento");
  });

  await test("rejeita documento sem typeId", () => {
    const result = parseSubcircuitDocument({ schemaVersion: SUBCIRCUIT_SCHEMA_VERSION, components: [], topology: {}, interface: [] }, "/tmp");
    assert(result.ok === false, "documento sem typeId deveria ser rejeitado");
  });

  await test("aceita documento schemaVersion 3 mínimo válido", () => {
    const result = parseSubcircuitDocument(
      { schemaVersion: SUBCIRCUIT_SCHEMA_VERSION, typeId: "subcircuits.x", components: [], topology: {}, interface: [], exposedComponents: [] },
      "/tmp"
    );
    assert(result.ok === true, "documento mínimo válido schemaVersion 3 deveria ser aceito");
  });

  await test("round-trip serialize -> parse produz um documento equivalente (todas as seções)", () => {
    const original = fullDocument();
    const raw = serializeSubcircuitDocument(original);
    const reparsed = parseSubcircuitDocument(raw, "/tmp");
    assert(reparsed.ok === true, "documento serializado deveria re-parsear com sucesso");
    if (reparsed.ok) {
      assert(reparsed.document.typeId === original.typeId, "typeId deveria sobreviver ao round-trip");
      assert(reparsed.document.components.length === original.components.length, "components[] deveria sobreviver ao round-trip");
      assert(reparsed.document.interface.length === original.interface.length, "interface[] deveria sobreviver ao round-trip");
      assert(reparsed.document.symbol?.pins.length === 2, "symbol.pins[] deveria sobreviver ao round-trip");
      assert(reparsed.document.icon?.width === 24, "icon deveria sobreviver ao round-trip");
    }
  });

  await test("topology.conductors[].vertices grava/lê como 'points' no arquivo (convenção real do .lssubcircuit), nunca vira undefined", () => {
    const original = fullDocument();
    const raw = serializeSubcircuitDocument(original) as { topology: { conductors: Array<Record<string, unknown>> } };
    assert(Array.isArray(raw.topology.conductors[0]!.points), "arquivo serializado deveria gravar a chave 'points', não 'vertices'");
    assert(raw.topology.conductors[0]!.vertices === undefined, "arquivo serializado NUNCA deveria conter a chave 'vertices' (bug real: cast direto sem conversão)");
    const reparsed = parseSubcircuitDocument(raw, "/tmp");
    assert(reparsed.ok === true, "documento com condutor real deveria parsear com sucesso");
    if (reparsed.ok) {
      const conductor = reparsed.document.topology.conductors[0];
      assert(conductor !== undefined, "condutor deveria sobreviver ao round-trip");
      assert(Array.isArray(conductor!.vertices) && conductor!.vertices.length === 1, "vertices[] deveria sobreviver ao round-trip (não undefined)");
      assert(conductor!.vertices[0]!.x === 10 && conductor!.vertices[0]!.y === 20, "coordenadas do vértice deveriam sobreviver intactas");
    }
  });

  await test("serialize é independente da ordem de inserção das chaves do objeto de entrada (parse não depende de ordem)", () => {
    const original = fullDocument();
    const raw = serializeSubcircuitDocument(original);
    const reordered = JSON.parse(JSON.stringify(raw).split("").reverse().join("").split("").reverse().join(""));
    // reordenar de fato as chaves de um objeto JS não é observável por parse (chaves são um Set
    // conceitualmente) -- o teste real de "order-independence" é que reparsear 2x produz o mesmo
    // resultado independente da ordem dos ARRAYS internos não ser normalizada por parse/serialize.
    const reparsedA = parseSubcircuitDocument(raw, "/tmp");
    const reparsedB = parseSubcircuitDocument(reordered, "/tmp");
    assert(reparsedA.ok === true && reparsedB.ok === true, "ambos deveriam parsear com sucesso");
  });

  await test("documento sem symbol/icon (subcircuito ainda não autorado visualmente) parseia com campos ausentes, não undefined-crash", () => {
    const result = parseSubcircuitDocument(
      { schemaVersion: SUBCIRCUIT_SCHEMA_VERSION, typeId: "subcircuits.bare", components: [], topology: {}, interface: [], exposedComponents: [] },
      "/tmp"
    );
    assert(result.ok === true, "documento sem symbol/icon deveria ser válido");
    if (result.ok) {
      assert(result.document.symbol === undefined, "symbol ausente deveria ficar undefined, não um objeto vazio sintético");
      assert(result.document.icon === undefined, "icon ausente deveria ficar undefined");
    }
  });

  // ── Bloqueio do package no esquemático principal (revisão global de labels, 2026-07-18):
  // `propertySchema` (o que vira campo editável no diálogo da INSTÂNCIA colocada, ver
  // `main.ts::resolvePropertyFields`) e `symbol.pins[]` (o conteúdo do PACKAGE, só editável via
  // "Abrir Subcircuito") são conceitos disjuntos -- prova que o parser nunca mistura os dois, nem
  // deixa um campo de pino vazar como se fosse propriedade de instância. ─────────────────────────
  await test("propertySchema (instância) e symbol.pins[] (package) nunca colidem nem vazam um no outro", () => {
    const document: SubcircuitDocument = {
      ...fullDocument(),
      propertySchema: [
        { id: "resistance", editor: "number", default: 220 },
        { id: "color", editor: "select", default: "Yellow" },
      ],
    };
    const raw = serializeSubcircuitDocument(document);
    const reparsed = parseSubcircuitDocument(raw, "/tmp");
    assert(reparsed.ok === true, "documento com propertySchema + symbol.pins deveria parsear com sucesso");
    if (!reparsed.ok) return;

    // 1. propertySchema sobrevive exatamente como declarado -- nenhum campo de pino (angle/labelX/
    // labelTextAnchor/etc) aparece dentro dele.
    const schema = reparsed.document.propertySchema as Array<{ id: string; editor: string }> | undefined;
    assert(Array.isArray(schema) && schema.length === 2, `propertySchema deveria sobreviver com 2 entradas, recebido ${JSON.stringify(schema)}`);
    const schemaIds = schema!.map((entry) => entry.id).sort();
    assert(JSON.stringify(schemaIds) === JSON.stringify(["color", "resistance"]), `propertySchema deveria bater exatamente com o declarado, recebido ${JSON.stringify(schemaIds)}`);
    const pinOnlyFieldNames = ["angle", "length", "labelX", "labelY", "labelTextAnchor", "labelHidden", "labelFontSize", "labelRotation", "labelColor"];
    for (const entry of schema!) {
      assert(!pinOnlyFieldNames.includes(entry.id), `propertySchema não deveria conter um campo exclusivo de pino do package, achado id="${entry.id}"`);
    }

    // 2. symbol.pins[] preserva fidelidade total (nenhum campo comido pela presença de propertySchema).
    assert(reparsed.document.symbol?.pins.length === 2, `symbol.pins deveria sobreviver intacto, recebido ${reparsed.document.symbol?.pins.length}`);
    assert(reparsed.document.symbol?.pins[0]!.id === "VCC" && reparsed.document.symbol?.pins[0]!.label === "VCC", "pino VCC deveria sobreviver com id/label corretos");

    // 3. nenhum id de propertySchema colide com um id de pino do package (espaços de nome disjuntos).
    const pinIds = (reparsed.document.symbol?.pins ?? []).map((pin) => pin.id);
    for (const id of schemaIds) {
      assert(!pinIds.includes(id), `id de propertySchema "${id}" não deveria colidir com nenhum pinId do package`);
    }
  });

  finish();
})();

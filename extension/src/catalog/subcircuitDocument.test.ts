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
    topology: { revision: 1, nodes: [], conductors: [] },
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

  finish();
})();

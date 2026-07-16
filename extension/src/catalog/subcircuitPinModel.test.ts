import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { TUNNEL_TYPE_ID } from "../ui/webview/model";
import { SUBCIRCUIT_SCHEMA_VERSION, SubcircuitDocument } from "./subcircuitDocument";
import {
  createAdditionalTunnelForPin,
  createPin,
  deletePin,
  deriveInterfaceEntries,
  deleteTunnel,
  duplicatePin,
  finalizeSubcircuitDocumentForSave,
  renameCanonicalTunnelNames,
} from "./subcircuitPinModel";

function emptyDocument(): SubcircuitDocument {
  return {
    schemaVersion: SUBCIRCUIT_SCHEMA_VERSION,
    typeId: "subcircuits.demo",
    name: "Demo",
    components: [],
    topology: { revision: 0, nodes: [], conductors: [] },
    interface: [],
    exposedComponents: [],
  };
}

function makeIdFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

(async () => {
  const { test, finish } = createTestRunner("subcircuitPinModel - pino/túnel CRUD + cascata");

  await test("createPin cria 1 pino no symbol + 1 túnel obrigatório atomicamente, nunca um sem o outro", () => {
    const idFactory = makeIdFactory("id");
    const result = createPin(emptyDocument(), { label: "VCC", x: 0, y: 8, angle: 180 }, idFactory);
    const symbolPins = result.document.symbol?.pins ?? [];
    assert(symbolPins.length === 1, `esperado 1 pino no symbol, recebido ${symbolPins.length}`);
    assert(symbolPins[0]!.id === result.pinId, "pinId retornado deveria bater com o pino criado");

    const tunnels = result.document.components.filter((c) => c.typeId === TUNNEL_TYPE_ID);
    assert(tunnels.length === 1, `esperado 1 túnel criado junto, recebido ${tunnels.length}`);
    assert(tunnels[0]!.properties.pinId === result.pinId, "túnel deveria referenciar o pinId recém-criado");
    assert(tunnels[0]!.properties.name === result.pinId, "identidade elétrica do túnel (name) deveria já nascer igual ao pinId");
    assert(tunnels[0]!.id === result.tunnelComponentId, "tunnelComponentId retornado deveria bater com o componente criado");
  });

  await test("pinId nunca é derivado de posição/índice -- 2 pinos criados na mesma posição recebem ids distintos", () => {
    const idFactory = makeIdFactory("id");
    let doc = emptyDocument();
    const r1 = createPin(doc, { label: "A", x: 10, y: 10, angle: 0 }, idFactory);
    doc = r1.document;
    const r2 = createPin(doc, { label: "B", x: 10, y: 10, angle: 0 }, idFactory);
    assert(r1.pinId !== r2.pinId, "dois pinos, mesma posição, deveriam ter pinIds diferentes (nunca derivados de x/y/índice)");
  });

  await test("createAdditionalTunnelForPin adiciona um 2º túnel pro MESMO pinId, sem criar novo pino", () => {
    const idFactory = makeIdFactory("id");
    const created = createPin(emptyDocument(), { label: "GND", x: 0, y: 24, angle: 180 }, idFactory);
    const withExtra = createAdditionalTunnelForPin(created.document, created.pinId, idFactory, 40, 40);
    assert(!("error" in withExtra), "não deveria dar erro ao adicionar túnel a um pino existente");
    if (!("error" in withExtra)) {
      const tunnelsForPin = withExtra.components.filter((c) => c.typeId === TUNNEL_TYPE_ID && c.properties.pinId === created.pinId);
      assert(tunnelsForPin.length === 2, `esperado 2 túneis pro mesmo pino, recebido ${tunnelsForPin.length}`);
      const symbolPins = withExtra.symbol?.pins ?? [];
      assert(symbolPins.length === 1, "adicionar túnel extra não deveria criar nenhum pino novo");
    }
  });

  await test("createAdditionalTunnelForPin falha com erro (não lança) quando o pino não existe", () => {
    const result = createAdditionalTunnelForPin(emptyDocument(), "nao-existe", makeIdFactory("id"));
    assert("error" in result, "deveria devolver um erro, nunca lançar exceção");
  });

  await test("deleteTunnel BLOQUEIA apagar o único túnel de um pino, com mensagem acionável", () => {
    const created = createPin(emptyDocument(), { label: "VCC", x: 0, y: 8, angle: 180 }, makeIdFactory("id"));
    const result = deleteTunnel(created.document, created.tunnelComponentId);
    assert("blocked" in result, "deveria bloquear a exclusão do único túnel");
    if ("blocked" in result) {
      assert(result.blocked.includes(created.pinId), "mensagem deveria mencionar o pinId afetado");
      assert(result.blocked.length > 0, "mensagem de bloqueio deveria ser acionável (não vazia)");
    }
  });

  await test("deleteTunnel permite apagar um túnel quando outro(s) ainda restam pro mesmo pino", () => {
    const idFactory = makeIdFactory("id");
    const created = createPin(emptyDocument(), { label: "GND", x: 0, y: 24, angle: 180 }, idFactory);
    const withExtra = createAdditionalTunnelForPin(created.document, created.pinId, idFactory, 40, 40);
    assert(!("error" in withExtra), "não deveria dar erro ao adicionar túnel extra");
    if ("error" in withExtra) return;

    const result = deleteTunnel(withExtra, created.tunnelComponentId);
    assert("document" in result, "deveria permitir apagar 1 dos 2 túneis");
    if ("document" in result) {
      const remaining = result.document.components.filter((c) => c.typeId === TUNNEL_TYPE_ID && c.properties.pinId === created.pinId);
      assert(remaining.length === 1, `esperado 1 túnel sobrevivente, recebido ${remaining.length}`);
      const symbolPins = result.document.symbol?.pins ?? [];
      assert(symbolPins.length === 1, "apagar um túnel extra não deveria remover o pino");
    }
  });

  await test("deleteTunnel de um túnel comum (sem pinId, não ligado a pino externo) nunca é bloqueado", () => {
    const idFactory = makeIdFactory("id");
    const doc: SubcircuitDocument = { ...emptyDocument(), components: [{ id: "plain-tun", typeId: TUNNEL_TYPE_ID, properties: { name: "NET1" }, visual: { x: 0, y: 0, rotation: 0 } }] };
    const result = deleteTunnel(doc, "plain-tun");
    assert("document" in result, "túnel interno comum (sem pinId) nunca deveria ser bloqueado ao apagar");
  });

  await test("deletePin cascateia: remove o pino do symbol E todos os túneis ligados a ele, sem sobrar órfão", () => {
    const idFactory = makeIdFactory("id");
    const created = createPin(emptyDocument(), { label: "GND", x: 0, y: 24, angle: 180 }, idFactory);
    const withExtra = createAdditionalTunnelForPin(created.document, created.pinId, idFactory, 40, 40);
    assert(!("error" in withExtra), "não deveria dar erro ao adicionar túnel extra");
    if ("error" in withExtra) return;

    const afterDelete = deletePin(withExtra, created.pinId);
    const symbolPins = afterDelete.symbol?.pins ?? [];
    assert(symbolPins.length === 0, "pino deveria ter sido removido do symbol");
    const orphanTunnels = afterDelete.components.filter((c) => c.typeId === TUNNEL_TYPE_ID && c.properties.pinId === created.pinId);
    assert(orphanTunnels.length === 0, `nenhum túnel órfão deveria sobrar, recebido ${orphanTunnels.length}`);
  });

  await test("deletePin preserva túneis/componentes de OUTROS pinos intocados", () => {
    const idFactory = makeIdFactory("id");
    let doc = emptyDocument();
    const vcc = createPin(doc, { label: "VCC", x: 0, y: 8, angle: 180 }, idFactory);
    doc = vcc.document;
    const gnd = createPin(doc, { label: "GND", x: 0, y: 24, angle: 180 }, idFactory);
    doc = gnd.document;

    const afterDelete = deletePin(doc, vcc.pinId);
    const remainingPins = afterDelete.symbol?.pins ?? [];
    assert(remainingPins.length === 1 && remainingPins[0]!.id === gnd.pinId, "GND deveria sobreviver intocado à exclusão de VCC");
    const gndTunnels = afterDelete.components.filter((c) => c.typeId === TUNNEL_TYPE_ID && c.properties.pinId === gnd.pinId);
    assert(gndTunnels.length === 1, "túnel de GND deveria continuar existindo");
  });

  await test("duplicatePin (copiar/colar no Modo Símbolo) SEMPRE mina um pinId novo + túnel novo, nunca reaproveita o original", () => {
    const idFactory = makeIdFactory("id");
    const created = createPin(emptyDocument(), { label: "VCC", x: 0, y: 8, angle: 180, length: 8 }, idFactory);
    const copy = duplicatePin(created.document, created.pinId, idFactory);
    assert(!("error" in copy), "duplicar um pino existente não deveria dar erro");
    if ("error" in copy) return;
    assert(copy.pinId !== created.pinId, "pino duplicado deveria ter um pinId NOVO, nunca o original");
    assert(copy.tunnelComponentId !== created.tunnelComponentId, "pino duplicado deveria ter um túnel NOVO, nunca reaproveitar o original");

    const symbolPins = copy.document.symbol?.pins ?? [];
    assert(symbolPins.length === 2, `esperado 2 pinos após duplicar (original + cópia), recebido ${symbolPins.length}`);
    const originalStillThere = symbolPins.some((p) => p.id === created.pinId);
    assert(originalStillThere, "pino original deveria continuar existindo após a duplicação");
  });

  await test("duplicatePin devolve erro (não lança) quando o pino de origem não existe", () => {
    const result = duplicatePin(emptyDocument(), "nao-existe", makeIdFactory("id"));
    assert("error" in result, "duplicar um pino inexistente deveria devolver erro, nunca lançar");
  });

  await test("renameCanonicalTunnelNames força properties.name === properties.pinId, neutralizando edição manual do nome", () => {
    const idFactory = makeIdFactory("id");
    const created = createPin(emptyDocument(), { label: "VCC", x: 0, y: 8, angle: 180 }, idFactory);
    const tampered: SubcircuitDocument = {
      ...created.document,
      components: created.document.components.map((c) =>
        c.id === created.tunnelComponentId ? { ...c, properties: { ...c.properties, name: "NOME_EDITADO_A_MAO" } } : c
      ),
    };
    const fixed = renameCanonicalTunnelNames(tampered);
    const tunnel = fixed.components.find((c) => c.id === created.tunnelComponentId);
    assert(tunnel?.properties.name === created.pinId, `nome do túnel deveria voltar a ser o pinId (${created.pinId}), recebido ${tunnel?.properties.name}`);
  });

  await test("renameCanonicalTunnelNames preserva túneis sem pinId (túneis internos comuns) intocados", () => {
    const doc: SubcircuitDocument = { ...emptyDocument(), components: [{ id: "plain", typeId: TUNNEL_TYPE_ID, properties: { name: "NET_INTERNO" }, visual: { x: 0, y: 0, rotation: 0 } }] };
    const fixed = renameCanonicalTunnelNames(doc);
    assert(fixed.components[0]!.properties.name === "NET_INTERNO", "túnel comum sem pinId não deveria ser tocado");
  });

  await test("deriveInterfaceEntries re-deriva interface[] inteiro a partir de symbol.pins[] -- internalTunnel é sempre o próprio pinId", () => {
    const idFactory = makeIdFactory("id");
    let doc = emptyDocument();
    const vcc = createPin(doc, { label: "VCC", x: 0, y: 8, angle: 180 }, idFactory);
    doc = vcc.document;
    const gnd = createPin(doc, { label: "GND", x: 0, y: 24, angle: 180 }, idFactory);
    doc = gnd.document;

    const entries = deriveInterfaceEntries(doc);
    assert(entries.length === 2, `esperado 2 entradas de interface, recebido ${entries.length}`);
    const vccEntry = entries.find((e) => e.pinId === vcc.pinId);
    assert(vccEntry?.internalTunnel === vcc.pinId, "internalTunnel deveria ser sempre o próprio pinId");
  });

  await test("finalizeSubcircuitDocumentForSave é idempotente (rodar 2x produz o mesmo resultado)", () => {
    const idFactory = makeIdFactory("id");
    const created = createPin(emptyDocument(), { label: "VCC", x: 0, y: 8, angle: 180 }, idFactory);
    const once = finalizeSubcircuitDocumentForSave(created.document);
    const twice = finalizeSubcircuitDocumentForSave(once);
    assert(JSON.stringify(once.interface) === JSON.stringify(twice.interface), "interface[] deveria ser estável entre chamadas repetidas");
    assert(JSON.stringify(once.components) === JSON.stringify(twice.components), "components[] deveria ser estável entre chamadas repetidas");
  });

  finish();
})();

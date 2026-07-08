import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { hasShowOnSymbolProperty, mergePropertySchemas, nextIndexedLabel, toWebviewPropertySchema } from "./catalogMerge";
import { PropertySchemaDto } from "../ipc/types";
import { WebviewComponentCatalogEntry, WebviewComponentModel } from "../ui/webview/model";

function component(typeId: string, label: string): WebviewComponentModel {
  return { id: `${typeId}-${label}`, typeId, x: 0, y: 0, rotation: 0, label, pins: [], properties: {} };
}

function catalogEntry(typeId: string, overrides: Partial<WebviewComponentCatalogEntry> = {}): WebviewComponentCatalogEntry {
  return { typeId, label: typeId, category: "Passivos", pinCount: 2, defaultProperties: {}, ...overrides };
}

function schemaDto(overrides: Partial<PropertySchemaDto> = {}): PropertySchemaDto {
  return {
    id: "resistance",
    label: "Resistência",
    group: "Elétrico",
    unit: "Ω",
    valueKind: "number",
    editor: "number",
    default: 220,
    hidden: false,
    readOnly: false,
    noCopy: false,
    affectsTopology: false,
    affectsPinCount: false,
    requiresRestart: false,
    showOnSymbol: true,
    ...overrides,
  };
}

(async () => {
  const { test, finish } = createTestRunner("catalogMerge — testes puros");

  await test("nextIndexedLabel conta por typeId com tipos intercalados", () => {
    const existing = [
      component("core.resistor", "Resistor-1"),
      component("core.capacitor", "Capacitor-1"),
    ];
    assert(nextIndexedLabel("core.resistor", "Resistor", existing) === "Resistor-2", "deveria ser Resistor-2");
    assert(nextIndexedLabel("core.capacitor", "Capacitor", existing) === "Capacitor-2", "deveria ser Capacitor-2");
    assert(nextIndexedLabel("core.led", "LED", existing) === "LED-1", "tipo novo começa em 1");
  });

  await test("nextIndexedLabel ignora label renomeado manualmente fora do padrão", () => {
    const existing = [component("core.resistor", "Pull-up R1")];
    assert(nextIndexedLabel("core.resistor", "Resistor", existing) === "Resistor-1", "label fora do padrão não conta");
  });

  await test("hasShowOnSymbolProperty: true quando algum schema tem showOnSymbol", () => {
    const entry = catalogEntry("core.resistor", {
      propertySchema: [{ id: "resistance", label: "R", group: "g", unit: "Ω", editor: "number", default: 0, showOnSymbol: true }],
    });
    assert(hasShowOnSymbolProperty(entry) === true, "deveria detectar showOnSymbol");
  });

  await test("hasShowOnSymbolProperty: false sem schema ou sem showOnSymbol", () => {
    assert(hasShowOnSymbolProperty(undefined) === false, "undefined -> false");
    assert(hasShowOnSymbolProperty(catalogEntry("core.led")) === false, "sem propertySchema -> false");
  });

  await test("toWebviewPropertySchema espelha campos e zera default-objeto (point)", () => {
    const dto = schemaDto({ default: { x: 1, y: 2 }, valueKind: "point" });
    const entry = toWebviewPropertySchema(dto);
    assert(entry.default === 0, "default do tipo point deve cair pra 0 na Webview");
    assert(entry.unit === "Ω", "unit deve ser preservado");
    assert(entry.showOnSymbol === true, "showOnSymbol deve ser preservado");
  });

  await test("mergePropertySchemas anexa schema por typeId quando presente no mapa", () => {
    const catalog = [catalogEntry("core.resistor"), catalogEntry("core.capacitor")];
    const merged = mergePropertySchemas(catalog, { "core.resistor": [schemaDto()] });
    assert(merged[0]?.propertySchema?.length === 1, "resistor deveria ganhar schema");
    assert(merged[1]?.propertySchema === undefined, "capacitor sem entrada no mapa não deve ganhar schema");
  });

  await test("mergePropertySchemas usa o mapa passado (simula troca de idioma pt-BR/en)", () => {
    const catalog = [catalogEntry("core.resistor")];
    const ptBr = mergePropertySchemas(catalog, { "core.resistor": [schemaDto({ label: "Resistência" })] });
    const en = mergePropertySchemas(catalog, { "core.resistor": [schemaDto({ label: "Resistance" })] });
    assert(ptBr[0]?.propertySchema?.[0]?.label === "Resistência", "merge pt-BR deveria usar o mapa pt-BR");
    assert(en[0]?.propertySchema?.[0]?.label === "Resistance", "merge en deveria usar o mapa en, não o pt-BR anterior");
  });

  await test("mergePropertySchemas não modifica o catálogo original (imutável)", () => {
    const catalog = [catalogEntry("core.resistor")];
    mergePropertySchemas(catalog, { "core.resistor": [schemaDto()] });
    assert(catalog[0]?.propertySchema === undefined, "catálogo original não deve ser mutado");
  });

  // ABI v2 (.spec/lasecsimul-native-devices.spec) -- readoutFormat/interactionKind são mapas
  // irmãos aditivos, separados de schemasByTypeId.
  await test("mergePropertySchemas anexa readoutFormat/interactionKind por typeId quando presentes", () => {
    const catalog = [catalogEntry("meters.oscope"), catalogEntry("switches.push"), catalogEntry("passive.resistor")];
    const merged = mergePropertySchemas(
      catalog,
      {},
      { "meters.oscope": { kind: "channelHistory", channels: 4 } },
      { "switches.push": "momentary" }
    );
    assert(merged[0]?.readoutFormat?.kind === "channelHistory", "oscope deveria ganhar readoutFormat");
    assert(merged[1]?.interactionKind === "momentary", "push deveria ganhar interactionKind");
    assert(merged[2]?.readoutFormat === undefined && merged[2]?.interactionKind === undefined, "resistor não declara nenhum dos dois");
  });

  // P0.3: interactionKind="encoder" deve fluir do manifesto (interaction field) ao entry do catálogo
  // (via extensionInteractionKind em extension.ts → interactionKindByTypeId em mergePropertySchemas).
  await test("mergePropertySchemas porta interactionKind 'encoder' do manifesto ao entry do catálogo", () => {
    const catalog = [catalogEntry("peripherals.ky040")];
    const merged = mergePropertySchemas(catalog, {}, {}, { "peripherals.ky040": "encoder" });
    assert(merged[0]?.interactionKind === "encoder", "ky040 deveria ganhar interactionKind 'encoder' via interactionKindByTypeId");
  });

  await test("mergePropertySchemas porta interactionKind 'joystick' do manifesto ao entry do catálogo", () => {
    const catalog = [catalogEntry("peripherals.ky023")];
    const merged = mergePropertySchemas(catalog, {}, {}, { "peripherals.ky023": "joystick" });
    assert(merged[0]?.interactionKind === "joystick", "ky023 deveria ganhar interactionKind 'joystick' via interactionKindByTypeId");
  });

  await test("mergePropertySchemas porta interactionKind 'touchpad' do manifesto ao entry do catálogo", () => {
    const catalog = [catalogEntry("peripherals.touchpad")];
    const merged = mergePropertySchemas(catalog, {}, {}, { "peripherals.touchpad": "touchpad" });
    assert(merged[0]?.interactionKind === "touchpad", "touchpad deveria ganhar interactionKind 'touchpad' via interactionKindByTypeId");
  });

  await test("mergePropertySchemas sem readoutFormatByTypeId/interactionKindByTypeId (chamador antigo) preserva comportamento de sempre", () => {
    const catalog = [catalogEntry("core.resistor")];
    const merged = mergePropertySchemas(catalog, { "core.resistor": [schemaDto()] });
    assert(merged[0]?.propertySchema?.length === 1, "schema continua funcionando sem os mapas novos");
    assert(merged[0]?.readoutFormat === undefined, "sem mapa novo, readoutFormat fica ausente");
  });

  // EX-4.2 (.spec/lasecsimul-native-devices.spec) -- pinIdsByTypeId só PREENCHE builtins sem
  // pinIds próprio (ex: passive.resistor, sem package), nunca sobrescreve o que devices/mcu-
  // adapter/subcircuit-file já tinham resolvido direto do manifesto (mesma fonte, resolvida antes).
  await test("mergePropertySchemas preenche pinIds vindo do Core só quando o catalogo ainda nao tem (EX-4.2)", () => {
    const catalog = [
      catalogEntry("passive.resistor", { pinIds: undefined }),
      catalogEntry("espressif.esp32", { pinIds: ["G23", "GND"] }),
    ];
    const merged = mergePropertySchemas(catalog, {}, {}, {}, {
      "passive.resistor": ["p1", "p2"],
      "espressif.esp32": ["deveria-ser-ignorado"],
    });
    assert(
      merged[0]?.pinIds?.[0] === "p1" && merged[0]?.pinIds?.[1] === "p2",
      "resistor deveria ganhar pinIds canônicos do Core (p1/p2)"
    );
    assert(
      merged[1]?.pinIds?.[0] === "G23" && merged[1]?.pinIds?.[1] === "GND",
      "esp32 já tinha pinIds do manifesto -- pinIdsByTypeId do Core NUNCA deve sobrescrever"
    );
  });

  await test("mergePropertySchemas sem pinIdsByTypeId (chamador antigo) preserva comportamento de sempre", () => {
    const catalog = [catalogEntry("passive.resistor", { pinIds: undefined })];
    const merged = mergePropertySchemas(catalog, { "passive.resistor": [schemaDto()] });
    assert(merged[0]?.pinIds === undefined, "sem mapa novo, pinIds continua ausente");
  });

  await test("mergePropertySchemas anexa serialPorts declaradas por typeId", () => {
    const catalog = [catalogEntry("espressif.esp32", { mcuHost: true })];
    const merged = mergePropertySchemas(catalog, {}, {}, {}, {}, {
      "espressif.esp32": [
        { label: "UART0", usartIndex: 0 },
        { label: "UART2", usartIndex: 2 },
      ],
    });
    assert(merged[0]?.serialPorts?.length === 2, "esp32 deveria ganhar duas portas seriais");
    assert(merged[0]?.serialPorts?.[1]?.label === "UART2", "label da porta deve vir do metadata, sem fallback");
  });

  await test("mergePropertySchemas descarta serialPorts invalidas em vez de inventar label", () => {
    const catalog = [catalogEntry("espressif.esp32", { mcuHost: true })];
    const merged = mergePropertySchemas(catalog, {}, {}, {}, {}, {
      "espressif.esp32": [
        { label: "", usartIndex: 0 },
        { label: "UART9", usartIndex: 9 as 0 },
      ],
    });
    assert(merged[0]?.serialPorts === undefined, "portas sem label valido/indice valido nao devem chegar ao catalogo");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

import { entryToWebview, resolveLocalizedItems, sanitizeStringArray, UnifiedCatalogItem, UnifiedCatalogTranslation } from "./UnifiedCatalog";

// â”€â”€ utilitÃ¡rios de teste (mesmo padrÃ£o de ipc/CoreClient.test.ts) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import { loadUnifiedCatalog } from "./UnifiedCatalog";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  âœ“ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  âœ— ${name}: ${(e as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// â”€â”€ suite de testes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// resolveLocalizedItems implementa o algoritmo de fallback de `lasecsimul.spec` seÃ§Ã£o 6.3.3
// (idioma pedido -> idioma-base do catÃ¡logo -> item sem traduÃ§Ã£o cai pra base, nunca string vazia) --
// mesmo algoritmo que `resolvePropertySchemaForLanguage` implementa em C++ no Core.

const baseItems: UnifiedCatalogItem[] = [
  { typeId: "passive.resistor", label: "Resistor", pinCount: 2, folderPath: ["Passivos", "Resistores"] },
  { typeId: "other.ground", label: "Terra (0 V)", pinCount: 1, pinIds: ["pin"], folderPath: ["Fontes"] },
];

const translations: Record<string, UnifiedCatalogTranslation> = {
  en: {
    items: {
      "passive.resistor": { label: "Resistor", folderPath: ["Passive", "Resistors"] },
    },
  },
};

console.log("\nUnifiedCatalog â€” resolveLocalizedItems\n");

test("sem requestedLanguage devolve os itens originais sem cÃ³pia", () => {
  const resolved = resolveLocalizedItems(baseItems, undefined, "pt-BR", translations);
  assert(resolved === baseItems, "caminho rÃ¡pido: mesma referÃªncia, sem alocaÃ§Ã£o");
});

test("requestedLanguage igual Ã  base devolve os itens originais", () => {
  const resolved = resolveLocalizedItems(baseItems, "pt-BR", "pt-BR", translations);
  assert(resolved === baseItems, "lÃ­ngua pedida == lÃ­ngua-base: sem resoluÃ§Ã£o nenhuma");
});

test("sem translations no arquivo devolve os itens originais", () => {
  const resolved = resolveLocalizedItems(baseItems, "en", "pt-BR", undefined);
  assert(resolved === baseItems, "sem bloco translations: cai pra base automaticamente");
});

test("item COM traduÃ§Ã£o pra a lÃ­ngua pedida resolve label/folderPath traduzidos", () => {
  const resolved = resolveLocalizedItems(baseItems, "en", "pt-BR", translations);
  const resistor = resolved.find((item) => item.typeId === "passive.resistor");
  assert(resistor?.label === "Resistor", "label traduzido (mesmo texto neste caso, mas resolvido)");
  assert(JSON.stringify(resistor?.folderPath) === JSON.stringify(["Passive", "Resistors"]), "folderPath traduzido");
});

test("item SEM traduÃ§Ã£o pra a lÃ­ngua pedida cai pra lÃ­ngua-base, nunca string vazia", () => {
  const resolved = resolveLocalizedItems(baseItems, "en", "pt-BR", translations);
  const ground = resolved.find((item) => item.typeId === "other.ground");
  assert(ground?.label === "Terra (0 V)", "ground nÃ£o tem traduÃ§Ã£o 'en' -- mantÃ©m o label da base");
  assert(JSON.stringify(ground?.folderPath) === JSON.stringify(["Fontes"]), "folderPath da base preservado");
  assert(JSON.stringify(ground?.pinIds) === JSON.stringify(["pin"]), "pinIds reais devem sobreviver a resolucao de idioma");
});

test("lÃ­ngua pedida sem nenhuma traduÃ§Ã£o no arquivo (ex: 'fr') cai pra base inteira", () => {
  const resolved = resolveLocalizedItems(baseItems, "fr", "pt-BR", translations);
  assert(resolved === baseItems, "'fr' nÃ£o existe em translations -- devolve a base sem alteraÃ§Ã£o");
});

// ── sanitizeStringArray/entryToWebview (PC-16, .spec/archive/legacy-v2/lasecsimul-native-devices.spec) ──────────────
// component-catalog.json/registro de device é JSON externo -- só o container (`items` é array) era
// checado antes; um campo individual malformado (ex: "pinIds":"AB" em vez de array) passava direto
// pro tipo `WebviewComponentCatalogEntry` e derrubava `pinsForTypeId` (extension.ts) com TypeError.

console.log("\nUnifiedCatalog — sanitizeStringArray/entryToWebview (PC-16)\n");

test("sanitizeStringArray: array de strings passa intacto", () => {
  const result = sanitizeStringArray(["G23", "GND"]);
  assert(JSON.stringify(result) === JSON.stringify(["G23", "GND"]), "array de strings válido preservado");
});

test("sanitizeStringArray: valor não-array (string) vira undefined, não quebra", () => {
  assert(sanitizeStringArray("AB") === undefined, "string em vez de array deveria virar undefined");
});

test("sanitizeStringArray: array com elementos não-string é filtrado", () => {
  const result = sanitizeStringArray(["p1", 42, null, "p2"]);
  assert(JSON.stringify(result) === JSON.stringify(["p1", "p2"]), "só elementos string sobrevivem");
});

test("sanitizeStringArray: array vazio (após filtro) vira undefined, nunca [] fantasma", () => {
  assert(sanitizeStringArray([42, null, {}]) === undefined, "array sem nenhuma string válida vira undefined");
  assert(sanitizeStringArray(undefined) === undefined, "undefined permanece undefined");
});

test("entryToWebview: pinIds malformado (string em vez de array) não derruba a conversão", () => {
  const item = { typeId: "custom.device", label: "Device", pinCount: 2, pinIds: "AB" as unknown as string[] };
  const entry = entryToWebview(item);
  assert(entry.pinIds === undefined, "pinIds inválido deveria virar undefined, não propagar a string malformada");
  assert(entry.typeId === "custom.device", "typeId/label/pinCount continuam passando normalmente");
});

test("entryToWebview: pinIds válido sobrevive intacto", () => {
  const item = { typeId: "other.ground", label: "Terra", pinCount: 1, pinIds: ["pin"] };
  const entry = entryToWebview(item);
  assert(JSON.stringify(entry.pinIds) === JSON.stringify(["pin"]), "pinIds válido preservado");
});

test("catalogo canonico registra PLC, Modbus e HART nas areas visiveis", () => {
  const catalog = loadUnifiedCatalog(process.cwd(), "pt-BR").catalog;
  const byTypeId = new Map(catalog.map((entry) => [entry.typeId, entry]));
  assert(byTypeId.get("plc.instance")?.workspaceSection === "control", "PLC deve existir na aba Controle");
  for (const typeId of ["protocol.modbus.server", "protocol.modbus.client", "protocol.hart.transmitter", "protocol.hart.communicator"]) {
    const entry = byTypeId.get(typeId);
    assert(entry?.workspaceSection === "process", `${typeId} deve existir na aba Processo`);
    assert(entry?.folderPath?.[0] === "Process", `${typeId} deve ficar sob a pasta Process`);
  }
});

console.log(`\nResultado: ${passed} passaram, ${failed} falharam\n`);
process.exitCode = failed > 0 ? 1 : 0;


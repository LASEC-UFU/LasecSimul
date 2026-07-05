import { resolveLocalizedItems, UnifiedCatalogItem, UnifiedCatalogTranslation } from "./UnifiedCatalog";

// â”€â”€ utilitÃ¡rios de teste (mesmo padrÃ£o de ipc/CoreClient.test.ts) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

console.log(`\nResultado: ${passed} passaram, ${failed} falharam\n`);
process.exitCode = failed > 0 ? 1 : 0;


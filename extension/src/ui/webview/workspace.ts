// IDs internos ficam em ingles e estaveis; os rotulos em portugues (Analogico/Digital/Controle/
// Processo) existem so na camada de apresentacao (UI_TEXT em main.ts).
export type WorkspaceSection = "analog" | "digital" | "control" | "process";

// Fonte unica de verdade pra ordem fixa das 4 abas -- main.ts itera este array em vez de um
// literal local. Nao existe UI de reordenar; a ordem e garantida por vir sempre deste array.
export const WORKSPACE_SECTION_ORDER: readonly WorkspaceSection[] = ["analog", "digital", "control", "process"] as const;

export interface WorkspaceSelection {
  section: WorkspaceSection;
}
export const DEFAULT_WORKSPACE_SELECTION: WorkspaceSelection = { section: "analog" };

const VALID_SECTIONS = new Set<WorkspaceSection>(WORKSPACE_SECTION_ORDER);

// Formato legado (pre abas achatadas): { main: "circuit"|"process", circuit: "analog"|"digital",
// process: "ctrl"|"autom" }. Mapeado uma unica vez na leitura do `vscode.getState()` persistido --
// depois disso so o formato novo e gravado. Nao e suporte indefinido a dois formatos, e migracao
// de leitura unica do estado local da Webview.
interface LegacyWorkspaceSelection {
  main?: unknown;
  circuit?: unknown;
  process?: unknown;
}

function migrateLegacyWorkspaceSelection(candidate: LegacyWorkspaceSelection): WorkspaceSection | undefined {
  if (candidate.main === undefined && candidate.circuit === undefined && candidate.process === undefined) return undefined;
  if (candidate.main === "process") return candidate.process === "autom" ? "process" : "control";
  return candidate.circuit === "digital" ? "digital" : "analog";
}

export function normalizeWorkspaceSelection(value: unknown): WorkspaceSelection {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_WORKSPACE_SELECTION };
  const candidate = value as Partial<WorkspaceSelection> & LegacyWorkspaceSelection;
  if (typeof candidate.section === "string" && VALID_SECTIONS.has(candidate.section as WorkspaceSection)) {
    return { section: candidate.section as WorkspaceSection };
  }
  const migrated = migrateLegacyWorkspaceSelection(candidate);
  return { section: migrated ?? "analog" };
}

interface WorkspaceClassifiableCatalogEntry {
  typeId: string;
  workspaceSection?: WorkspaceSection;
  mcuHost?: boolean;
  registeredSourceKind?: "abi-device" | "mcu-adapter" | "subcircuit-file";
}

const DIGITAL_TYPE_IDS = new Set([
  "sources.clock",
  "switches.switch_dip",
  "switches.keypad",
  "connectors.bus",
  "meters.freqmeter",
  "meters.logic_analyzer",
  "outputs.led_bar",
  "outputs.led_matrix",
  "outputs.seven_segment",
  "outputs.ssd1306",
  "outputs.sh1107",
  "outputs.hd44780",
  "outputs.aip31068_i2c",
  "outputs.ili9341",
  "outputs.st7735",
  "outputs.st7789",
  "outputs.gc9a01a",
  "outputs.pcf8833",
  "outputs.pcd8544",
  "outputs.ks0108",
  "outputs.max72xx_matrix",
  "outputs.ws2812",
  "sensors.sr04",
  "sensors.dht22",
  "sensors.ds1621",
  "sensors.ds18b20",
]);

/**
 * Classifica cada entrada em exatamente uma área do workspace. `workspaceSection` é o contrato
 * extensível e tem prioridade; as regras por família mantêm catálogos/manifestações legados
 * compatíveis sem duplicar os itens em Analog e Digital.
 */
export function workspaceSectionForCatalogEntry(entry: WorkspaceClassifiableCatalogEntry): WorkspaceSection {
  if (entry.workspaceSection) return entry.workspaceSection;
  if (entry.mcuHost || entry.registeredSourceKind === "mcu-adapter") return "digital";
  if (
    entry.typeId.startsWith("logic.") ||
    entry.typeId.startsWith("digital.") ||
    entry.typeId.startsWith("peripherals.") ||
    DIGITAL_TYPE_IDS.has(entry.typeId)
  ) {
    return "digital";
  }
  return "analog";
}

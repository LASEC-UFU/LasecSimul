export type WorkspaceMainTab = "circuit" | "process";
export type CircuitWorkspaceTab = "analog" | "digital";
export type ProcessWorkspaceTab = "ctrl" | "autom";
export type WorkspaceSection = CircuitWorkspaceTab | ProcessWorkspaceTab;

export interface WorkspaceSelection {
  main: WorkspaceMainTab;
  circuit: CircuitWorkspaceTab;
  process: ProcessWorkspaceTab;
}
export const DEFAULT_WORKSPACE_SELECTION: WorkspaceSelection = {
  main: "circuit",
  circuit: "analog",
  process: "ctrl",
};

export function normalizeWorkspaceSelection(value: unknown): WorkspaceSelection {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_WORKSPACE_SELECTION };
  const candidate = value as Partial<WorkspaceSelection>;
  return {
    main: candidate.main === "process" ? "process" : "circuit",
    circuit: candidate.circuit === "digital" ? "digital" : "analog",
    process: candidate.process === "autom" ? "autom" : "ctrl",
  };
}

export function activeWorkspaceSection(selection: WorkspaceSelection): WorkspaceSection {
  return selection.main === "circuit" ? selection.circuit : selection.process;
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

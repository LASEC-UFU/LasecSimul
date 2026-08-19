// IDs internos ficam em ingles e estaveis; os rotulos em portugues (Analogico/Digital/Controle/
// Processo) existem so na camada de apresentacao (UI_TEXT em palette.ts).
export type WorkspaceSection = "analog" | "digital" | "control" | "process";

// Fonte unica de verdade pra ordem fixa das 4 abas -- palette.ts itera este array em vez de um
// literal local. Nao existe UI de reordenar; a ordem e garantida por vir sempre deste array. As
// abas filtram só a paleta (FEAT-011); o editor (main.ts) nunca le WorkspaceSection.
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
}

/**
 * Classifica cada entrada em exatamente uma área do workspace. `workspaceSection` é o contrato
 * extensível e tem prioridade. Sem ele, só os prefixos `logic.`/`digital.` (gates da pasta
 * `Portas`/`Aritmeticos`/etc. e o bloco `GHDL`) caem em Digital -- todo o resto do catálogo legado
 * (MCUs, periféricos digitais, displays, sensores digitais etc.) é Analógico por padrão, já que o
 * editor nunca restringe o que pode ser inserido por seção (ver FEAT-011).
 */
export function workspaceSectionForCatalogEntry(entry: WorkspaceClassifiableCatalogEntry): WorkspaceSection {
  if (entry.workspaceSection) return entry.workspaceSection;
  if (entry.typeId.startsWith("logic.") || entry.typeId.startsWith("digital.")) {
    return "digital";
  }
  return "analog";
}

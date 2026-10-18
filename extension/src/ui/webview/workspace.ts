// IDs internos ficam em ingles e estaveis; os rotulos em portugues (Analogico/Digital/Controle/
// Miscelaneos) existem so na camada de apresentacao (UI_TEXT em palette.ts).
export type WorkspaceSection = "analog" | "digital" | "control" | "misc";

/** Valor aceito em METADADO de catalogo/manifesto (`workspaceSection` de `.lssubcircuit`/`.lsdevice`,
 * `component-catalog.json`). `"process"` e o id da antiga aba "Processo", removida: o que morava la
 * (PLC IEC 61131-3, Protocolos Industriais, Ferramentas) passou para Controle, na MESMA subsecao.
 * Continua aceito na leitura para nao invalidar manifestos ja gravados (proprios ou de terceiros);
 * nunca e uma aba -- `workspaceSectionForCatalogEntry` o converte. */
export type CatalogWorkspaceSection = WorkspaceSection | "process";

// Fonte unica de verdade pra ordem fixa das abas -- palette.ts itera este array em vez de um
// literal local. Nao existe UI de reordenar; a ordem e garantida por vir sempre deste array. As
// abas filtram só a paleta (FEAT-011); o editor (main.ts) nunca le WorkspaceSection. "misc"
// (Miscelaneos/Miscellaneous) reune subsecoes que nao sao eletricamente "Analogico" de fato
// (Conectores/Graficos/Externos) -- ver `workspaceSectionForCatalogEntry`.
export const WORKSPACE_SECTION_ORDER: readonly WorkspaceSection[] = ["analog", "digital", "control", "misc"] as const;

export interface WorkspaceSelection {
  section: WorkspaceSection;
}
export const DEFAULT_WORKSPACE_SELECTION: WorkspaceSelection = { section: "analog" };

const VALID_SECTIONS = new Set<WorkspaceSection>(WORKSPACE_SECTION_ORDER);

/** Id de aba gravado por qualquer versao -> aba atual. `"process"` (aba Processo removida) abre em
 * Controle, onde estao agora PLC, protocolos e ferramentas que o usuario procurava ali. */
function migrateSectionId(value: string): WorkspaceSection | undefined {
  if (VALID_SECTIONS.has(value as WorkspaceSection)) return value as WorkspaceSection;
  if (value === "process") return "control";
  return undefined;
}

/** Metadado de catalogo/manifesto lido de arquivo -> valor aceito (inclui o legado `"process"`).
 * Ponto unico de validacao, compartilhado por `registeredSources.ts` e `subcircuitDocument.ts`. */
export function parseCatalogWorkspaceSection(value: unknown): CatalogWorkspaceSection | undefined {
  return value === "analog" || value === "digital" || value === "control" || value === "process" || value === "misc"
    ? value
    : undefined;
}

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
  // Controle e Automacao (antiga aba Processo) convergem para Controle.
  if (candidate.main === "process") return "control";
  return candidate.circuit === "digital" ? "digital" : "analog";
}

/** Aceita o estado persistido em qualquer formato ja gravado pela paleta: o id da aba sozinho
 * (`setState({ query, section })` grava a string), `{ section }` ou o formato legado aninhado. */
export function normalizeWorkspaceSelection(value: unknown): WorkspaceSelection {
  if (typeof value === "string") return { section: migrateSectionId(value) ?? DEFAULT_WORKSPACE_SELECTION.section };
  if (typeof value !== "object" || value === null) return { ...DEFAULT_WORKSPACE_SELECTION };
  const candidate = value as { section?: unknown } & LegacyWorkspaceSelection;
  const section = typeof candidate.section === "string" ? migrateSectionId(candidate.section) : undefined;
  if (section) return { section };
  const migrated = migrateLegacyWorkspaceSelection(candidate);
  return { section: migrated ?? DEFAULT_WORKSPACE_SELECTION.section };
}

interface WorkspaceClassifiableCatalogEntry {
  typeId: string;
  workspaceSection?: CatalogWorkspaceSection;
}

/**
 * Classifica cada entrada em exatamente uma área do workspace. `workspaceSection` é o contrato
 * extensível e tem prioridade (o legado `"process"` cai em Controle). Sem ele, só os prefixos
 * `logic.`/`digital.` (gates da pasta `Portas`/`Aritmeticos`/etc. e o bloco `GHDL`) caem em
 * Digital -- todo o resto do catálogo legado (MCUs, periféricos digitais, displays, sensores
 * digitais etc.) é Analógico por padrão, já que o editor nunca restringe o que pode ser inserido
 * por seção (ver FEAT-011).
 */
export function workspaceSectionForCatalogEntry(entry: WorkspaceClassifiableCatalogEntry): WorkspaceSection {
  if (entry.workspaceSection) return entry.workspaceSection === "process" ? "control" : entry.workspaceSection;
  if (entry.typeId.startsWith("logic.") || entry.typeId.startsWith("digital.")) {
    return "digital";
  }
  return "analog";
}

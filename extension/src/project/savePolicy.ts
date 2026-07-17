export type SaveDecision = { kind: "write"; filePath: string } | { kind: "saveAs" };

/** Política pura: Salvar só abre diálogo quando o projeto ainda não tem arquivo. */
export function decideSaveTarget(currentProjectFilePath: string | undefined): SaveDecision {
  return currentProjectFilePath ? { kind: "write", filePath: currentProjectFilePath } : { kind: "saveAs" };
}

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Subcircuitos INCORPORADOS ao projeto (`subcircuitRef.embedded`): o `.lsproj` carrega o manifesto
 * inteiro, então abrir o projeto não depende da biblioteca instalada nem de um arquivo ao lado.
 *
 * O resto do LasecSimul (Core `registerAdhocSubcircuit`, leitura de componentes internos, editor de
 * subcircuito) trabalha com ARQUIVO; por isso o manifesto é materializado num cache por conteúdo e
 * segue exatamente o caminho do "bloco genérico de subcircuito por caminho". Ao salvar o projeto, o
 * conteúdo desse arquivo volta para o `.lsproj` (edições feitas no editor de subcircuito incluídas).
 */
export const FILE_SOURCE_PREFIX = "file:";

export function embeddedSubcircuitCacheDir(): string {
  return path.join(os.tmpdir(), "lasecsimul-embedded-subcircuits");
}

/** Grava (se preciso) o manifesto num arquivo cujo nome depende do conteúdo e devolve o caminho. */
export function materializeEmbeddedSubcircuit(manifest: Record<string, unknown>): string {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  const typeId = typeof manifest.typeId === "string" ? manifest.typeId : "subcircuit";
  const safeName = typeId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const directory = embeddedSubcircuitCacheDir();
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${safeName}-${hash}.lssubcircuit`);
  if (!fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== text) fs.writeFileSync(filePath, text, "utf8");
  return filePath;
}

/** `sourceId` de um subcircuito carregado de arquivo (por caminho ou incorporado). */
export function fileSourceId(absolutePath: string): string {
  return `${FILE_SOURCE_PREFIX}${absolutePath}`;
}

export function filePathFromSourceId(sourceId: string): string | undefined {
  return sourceId.startsWith(FILE_SOURCE_PREFIX) ? sourceId.slice(FILE_SOURCE_PREFIX.length) : undefined;
}

/** Conteúdo atual do arquivo materializado (para incorporar de volta ao salvar). */
export function readMaterializedSubcircuit(absolutePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

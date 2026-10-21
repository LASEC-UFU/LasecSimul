/**
 * Arquivos da migração automática (docs/69): backup VERIFICADO do original e relatório, ao lado do
 * documento migrado, em `lasecsimul-migration-backup/`. Nunca apaga nem sobrescreve um backup: um
 * backup já existente com o mesmo conteúdo é reaproveitado; com conteúdo diferente, o novo ganha
 * sufixo numérico. O documento só é regravado depois que o backup foi relido e o hash conferido.
 */
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { CONTROL_MIGRATION_ID, CONTROL_MIGRATION_VERSION, ControlMigrationReport, migrateControlDocument } from "./migrateDocument";
import { LEGACY_LIBRARY_EXPORTS } from "./legacyLibraryExports";

export const MIGRATION_BACKUP_DIRECTORY = "lasecsimul-migration-backup";

export interface MigrationBackup {
  backupPath: string;
  reportPath: string;
  /** SHA-256 do original (igual ao do backup, conferido depois de gravar). */
  sha256: string;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(temporary, data, { flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Copia o original para o diretório de backup e confere o hash da cópia relida. */
export async function backupOriginal(filePath: string, original: Buffer): Promise<{ backupPath: string; sha256: string }> {
  const directory = path.join(path.dirname(filePath), MIGRATION_BACKUP_DIRECTORY);
  await fs.mkdir(directory, { recursive: true });
  const extension = path.extname(filePath);
  const base = `${path.basename(filePath, extension)}.${CONTROL_MIGRATION_ID}-v${CONTROL_MIGRATION_VERSION}.original`;
  const hash = sha256(original);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = path.join(directory, `${base}${attempt === 0 ? "" : `-${attempt}`}${extension}`);
    if (await exists(candidate)) {
      if (sha256(await fs.readFile(candidate)) === hash) return { backupPath: candidate, sha256: hash };
      continue;
    }
    try { await fs.writeFile(candidate, original, { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const reread = sha256(await fs.readFile(candidate));
    if (reread !== hash) throw new Error(`backup ${candidate} nao confere com o original (sha256 ${reread} != ${hash})`);
    return { backupPath: candidate, sha256: hash };
  }
  throw new Error(`sem nome livre para o backup de ${filePath}`);
}

/** Relatório JSON da migração de um arquivo (ao lado do backup). */
export async function writeMigrationReport(filePath: string, backup: { backupPath: string; sha256: string }, report: ControlMigrationReport, migratedText: string): Promise<string> {
  const reportPath = backup.backupPath.replace(/\.original(-\d+)?\.[^.]+$/, (_, suffix: string | undefined) => `.report${suffix ?? ""}.json`);
  const body = {
    ...report,
    file: path.basename(filePath),
    migrationId: report.migrationId,
    version: report.version,
    generatedAt: new Date().toISOString(),
    original: { backup: path.basename(backup.backupPath), sha256: backup.sha256 },
    migrated: { sha256: sha256(migratedText) },
    summary: summarizeReport(report),
  };
  await atomicWrite(reportPath, `${JSON.stringify(body, null, 2)}\n`);
  return reportPath;
}

export interface MigrationSummary {
  converted: number;
  kept: number;
  renamed: number;
  unsupported: number;
  definitionsAdded: number;
  overridesRemapped: number;
  byRule: Record<string, number>;
}

export function summarizeReport(report: ControlMigrationReport): MigrationSummary {
  const summary: MigrationSummary = { converted: 0, kept: 0, renamed: 0, unsupported: 0, definitionsAdded: report.definitionsAdded.length, overridesRemapped: report.overrides.filter((o) => !o.warning).length, byRule: {} };
  for (const entry of report.entries) {
    if (entry.kind === "keep") summary.kept++;
    else if (entry.kind === "rename") summary.renamed++;
    else if (entry.kind === "unsupported") summary.unsupported++;
    else summary.converted++;
    summary.byRule[entry.rule] = (summary.byRule[entry.rule] ?? 0) + 1;
  }
  return summary;
}

/**
 * Migra um arquivo `.lsproj`/`.lssubcircuit` NO DISCO: backup verificado, documento migrado gravado
 * (JSON com 2 espaços, como os serializadores) e relatório. Sem bloco legado conversível, não toca em
 * nada e devolve `undefined`.
 */
export async function migrateFileInPlace(filePath: string): Promise<FileMigrationResult | undefined> {
  const original = await fs.readFile(filePath);
  const text = original.toString("utf8");
  const document = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, unknown>;
  const { document: migrated, report } = migrateControlDocument(document, { librarySnapshot: LEGACY_LIBRARY_EXPORTS });
  if (!report.changed) return undefined;
  const backup = await backupOriginal(filePath, original);
  const migratedText = `${JSON.stringify(migrated, null, 2)}\n`;
  if (sha256(await fs.readFile(filePath)) !== sha256(original)) throw new Error(`arquivo mudou durante a migração; nenhuma alteração aplicada: ${filePath}`);
  const reportPath = await writeMigrationReport(filePath, backup, report, migratedText);
  await atomicWrite(filePath, migratedText);
  const result = { filePath, ...backup, reportPath, report };
  notifyFileMigrated(result);
  return result;
}

/**
 * Projeto aberto e migrado em memória (`ProjectSerializer.loadWithMigration`): backup verificado do
 * arquivo como está no disco, gravação no formato novo pelo próprio serializador (`save`) e relatório.
 */
export async function persistDocumentMigration(filePath: string, report: ControlMigrationReport, save: () => Promise<void>): Promise<FileMigrationResult> {
  const original = await fs.readFile(filePath);
  const backup = await backupOriginal(filePath, original);
  if (sha256(await fs.readFile(filePath)) !== sha256(original)) throw new Error(`arquivo mudou durante a migração; nenhuma alteração aplicada: ${filePath}`);
  await save();
  let reportPath: string;
  try {
    reportPath = await writeMigrationReport(filePath, backup, report, await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new MigrationReportWriteError(`documento migrado e salvo, mas o relatório não pôde ser escrito: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = { filePath, ...backup, reportPath, report };
  notifyFileMigrated(result);
  return result;
}

/** O arquivo foi salvo; apenas o artefato de auditoria falhou. */
export class MigrationReportWriteError extends Error {
  readonly documentSaved = true;
}

export interface FileMigrationResult extends MigrationBackup {
  filePath: string;
  report: ControlMigrationReport;
}

type FileMigrationListener = (result: FileMigrationResult) => void;
const listeners = new Set<FileMigrationListener>();

/** A interface (extension.ts) avisa o usuário de cada arquivo migrado, com o relatório. */
export function onFileMigrated(listener: FileMigrationListener): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}

function notifyFileMigrated(result: FileMigrationResult): void {
  for (const listener of listeners) {
    try { listener(result); } catch { /* aviso é acessório: a migração já foi gravada */ }
  }
}

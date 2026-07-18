import * as fs from "fs";
import * as path from "path";

/** Ordem deliberada: uma compilação Debug pode coexistir e estar mais velha que Release. */
export function coreExecutableCandidates(extensionPath: string, platform = process.platform): string[] {
  const coreBin = platform === "win32" ? "lasecsimul-core.exe" : "lasecsimul-core";
  const buildDirs = [
    path.join(extensionPath, "..", "core", "build"),
    path.join(extensionPath, "bundled", "core", "build"),
  ];
  return buildDirs.flatMap((buildDir) => [
    path.join(buildDir, coreBin),
    path.join(buildDir, "Release", coreBin),
    path.join(buildDir, "RelWithDebInfo", coreBin),
    path.join(buildDir, "Debug", coreBin),
  ]);
}

export function resolveCoreExecutablePath(
  extensionPath: string,
  exists: (candidate: string) => boolean = fs.existsSync,
  platform = process.platform,
  modifiedTimeMs: (candidate: string) => number = (candidate) => fs.statSync(candidate).mtimeMs,
): string {
  const candidates = coreExecutableCandidates(extensionPath, platform);
  const available = candidates.filter(exists);
  if (available.length === 0) return candidates[0]!;

  // Evita iniciar um Release obsoleto quando o Core acabou de ser recompilado em outra
  // configuração. A ordem original permanece como desempate para timestamps iguais.
  return available
    .map((candidate, order) => {
      try {
        return { candidate, order, modified: modifiedTimeMs(candidate) };
      } catch {
        return { candidate, order, modified: 0 };
      }
    })
    .sort((a, b) => b.modified - a.modified || a.order - b.order)[0]!.candidate;
}

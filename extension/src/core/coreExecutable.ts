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

function newestFileModifiedTimeMs(
  root: string,
  modifiedTimeMs: (candidate: string) => number,
): number {
  if (!fs.existsSync(root)) return 0;
  let newest = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile()) {
        newest = Math.max(newest, modifiedTimeMs(candidate));
      }
    }
  }
  return newest;
}

/**
 * Em checkout de desenvolvimento, detecta se houve pull/merge de fontes do Core depois do último
 * build. Instalações empacotadas não contêm `../core/src`, portanto retornam zero e não sofrem
 * nenhuma verificação baseada em timestamps locais.
 */
export function latestLocalCoreSourceModifiedTimeMs(
  extensionPath: string,
  modifiedTimeMs: (candidate: string) => number = (candidate) => fs.statSync(candidate).mtimeMs,
): number {
  const coreRoot = path.resolve(extensionPath, "..", "core");
  const sourceRoots = [
    path.join(coreRoot, "src"),
    path.join(coreRoot, "include"),
    path.join(coreRoot, "CMakeLists.txt"),
  ];
  let newest = 0;
  for (const sourceRoot of sourceRoots) {
    if (!fs.existsSync(sourceRoot)) continue;
    const stat = fs.statSync(sourceRoot);
    newest = Math.max(
      newest,
      stat.isDirectory()
        ? newestFileModifiedTimeMs(sourceRoot, modifiedTimeMs)
        : modifiedTimeMs(sourceRoot),
    );
  }
  return newest;
}

export function resolveCoreExecutablePath(
  extensionPath: string,
  exists: (candidate: string) => boolean = fs.existsSync,
  platform = process.platform,
  modifiedTimeMs: (candidate: string) => number = (candidate) => fs.statSync(candidate).mtimeMs,
  latestSourceModifiedTimeMs: (extensionPath: string) => number =
    (root) => latestLocalCoreSourceModifiedTimeMs(root, modifiedTimeMs),
): string {
  const candidates = coreExecutableCandidates(extensionPath, platform);
  const available = candidates.filter(exists);
  if (available.length === 0) return candidates[0]!;

  const binaryModifiedTimeMs = (candidate: string): number => {
    try {
      return modifiedTimeMs(candidate);
    } catch {
      return 0;
    }
  };
  const sourceModified = latestSourceModifiedTimeMs(extensionPath);
  const newestBinaryModified = Math.max(...available.map(binaryModifiedTimeMs));
  if (sourceModified > newestBinaryModified) {
    throw new Error(
      "O Core local está desatualizado em relação aos fontes. " +
      "Execute `npm run build:core -- --config Release` na raiz do LasecSimul e recarregue a janela.",
    );
  }

  // Evita iniciar um Release obsoleto quando o Core acabou de ser recompilado em outra
  // configuração. A ordem original permanece como desempate para timestamps iguais.
  return available
    .map((candidate, order) => ({ candidate, order, modified: binaryModifiedTimeMs(candidate) }))
    .sort((a, b) => b.modified - a.modified || a.order - b.order)[0]!.candidate;
}

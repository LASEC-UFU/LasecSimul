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
): string {
  const candidates = coreExecutableCandidates(extensionPath, platform);
  return candidates.find(exists) ?? candidates[0]!;
}

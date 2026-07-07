import * as fs from "fs";
import * as path from "path";

/** Resolve `inputPath` (absoluto ou relativo) contra `basePath`, sempre normalizado -- ponto único
 * usado tanto por `extension.ts` quanto por `catalog/packageSanitizers.ts` (EX-9,
 * .spec/lasecsimul-native-devices.spec) pra nunca duplicar a mesma lógica de resolução de caminho. */
export function normalizeAbsolutePath(basePath: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.normalize(path.resolve(basePath, inputPath));
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("raiz do arquivo JSON precisa ser um objeto");
  }
  return parsed;
}

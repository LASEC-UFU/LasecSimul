import * as fs from "fs/promises";
import * as path from "path";
import type { WebviewComponentCatalogEntry } from "../../ui/webview/model";
import { convertSimulideDocument } from "./SimulideToLasecConverter";
import { parseSimulideCircuit } from "./SimulideParser";
import type { SimulideConversionResult } from "./SimulideTypes";

export function isSimulideCircuitPath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".sim1" || extension === ".sim2";
}

export function defaultLsprojPathForSimulide(filePath: string): string {
  if (!isSimulideCircuitPath(filePath)) throw new Error(`Não é um circuito SimulIDE .sim1/.sim2: ${filePath}`);
  return filePath.replace(/\.sim[12]$/i, ".lsproj");
}

function mimeForPath(filePath: string, bytes: Buffer): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".webp") return "image/webp";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return "application/octet-stream";
}

/**
 * Se o SimulIDE salvou apenas Image_File (sem BckGndData), materializa a imagem no .lsproj como
 * imageData/imageMime. Isso evita que a figura suma ao abrir o projeto convertido e mantém o path
 * original como referência humana/externa.
 */
async function hydrateExternalImages(result: SimulideConversionResult, sourcePath: string): Promise<void> {
  const baseDir = path.dirname(sourcePath);
  for (const component of result.project.components) {
    if (component.typeId !== "graphics.image") continue;
    if (typeof component.properties.imageData === "string" && component.properties.imageData.length > 0) continue;
    const rawPath = typeof component.properties.path === "string" ? component.properties.path.trim() : "";
    if (!rawPath) continue;
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
    try {
      const bytes = await fs.readFile(resolved);
      component.properties.imageData = bytes.toString("base64");
      component.properties.imageMime = mimeForPath(resolved, bytes);
    } catch {
      result.report.issues.push({
        severity: "warning",
        code: "image-file-missing",
        message: `Imagem referenciada pelo SimulIDE não encontrada: ${rawPath}`,
        sourceId: component.id,
        sourceType: component.typeId,
        property: "Image_File",
      });
    }
  }
}

/**
 * O devkitC do SimulIDE persiste Program dentro de <mainCompProps>. No LasecSimul o MCU ESP32 é
 * interno ao subcircuito (id "mcu1") e o firmware por INSTÂNCIA fica numa propriedade UI-only do
 * componente externo. Resolva o caminho relativo ao diretório do .sim2 para que Run funcione logo
 * após a importação quando o .bin ainda existe no mesmo ambiente.
 */
async function hydrateRecognizedSubcircuitFirmware(result: SimulideConversionResult, sourcePath: string): Promise<void> {
  const baseDir = path.dirname(sourcePath);
  for (const component of result.project.components) {
    if (component.typeId !== "subcircuits.esp32_devkitc_v4") continue;
    const raw = typeof component.properties.__ui_simulideProgram === "string"
      ? component.properties.__ui_simulideProgram.trim()
      : "";
    if (!raw) continue;
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
    component.properties.__ui_exposedMcu_mcu1_firmwarePath = resolved;
    try {
      await fs.access(resolved);
    } catch {
      result.report.issues.push({
        severity: "warning",
        code: "firmware-file-missing",
        message: `Firmware referenciado pelo devkitC não encontrado neste caminho: ${raw}`,
        sourceId: component.id,
        sourceType: component.typeId,
        property: "Program",
      });
    }
  }
}

/** Preserva contexto externo também para placeholders (ex.: Arduino Uno ainda sem backend). */
async function hydratePlaceholderExternalReferences(result: SimulideConversionResult, sourcePath: string): Promise<void> {
  const baseDir = path.dirname(sourcePath);
  for (const component of result.project.components) {
    if (component.typeId !== "import.simulide.unresolved") continue;
    component.properties.__ui_simulideSourcePath = sourcePath;
    const rawProgram = typeof component.properties.__ui_simulideProgram === "string"
      ? component.properties.__ui_simulideProgram.trim()
      : "";
    if (!rawProgram) continue;
    const resolved = path.isAbsolute(rawProgram) ? rawProgram : path.resolve(baseDir, rawProgram);
    component.properties.__ui_simulideResolvedProgramPath = resolved;
    try {
      await fs.access(resolved);
    } catch {
      result.report.issues.push({
        severity: "warning",
        code: "firmware-file-missing",
        message: `Firmware/programa do componente não suportado não encontrado neste caminho: ${rawProgram}`,
        sourceId: component.id,
        sourceType: String(component.properties.__ui_simulideSourceType ?? component.typeId),
        property: "Program",
      });
    }
  }
}

export async function convertSimulideFile(
  filePath: string,
  catalog: readonly WebviewComponentCatalogEntry[]
): Promise<SimulideConversionResult> {
  if (!isSimulideCircuitPath(filePath)) throw new Error(`Extensão SimulIDE não suportada: ${path.extname(filePath)}`);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = parseSimulideCircuit(raw);
  const result = convertSimulideDocument(parsed, catalog);
  result.report.sourcePath = filePath;
  result.report.sourceExtension = path.extname(filePath).toLowerCase() as ".sim1" | ".sim2";
  await hydrateExternalImages(result, filePath);
  await hydrateRecognizedSubcircuitFirmware(result, filePath);
  await hydratePlaceholderExternalReferences(result, filePath);
  return result;
}

export async function nextAvailableImportedLsprojPath(preferredPath: string): Promise<string> {
  const directory = path.dirname(preferredPath);
  const extension = path.extname(preferredPath);
  const base = path.basename(preferredPath, extension);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = path.join(directory, `${base}.imported-${index}${extension}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`Não foi possível encontrar nome livre para ${preferredPath}`);
}

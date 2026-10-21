import * as fs from "fs/promises";
import * as path from "path";
import type { ProjectDocument } from "../../project/ProjectTypes";
import type { BlockLibraryFile } from "../../ui/webview/blockLibrary/spec";
import { parseMdl } from "./MdlParser";
import type { SlModel } from "./SimulinkModel";
import { convertSimulinkModel, SimulinkImportReport } from "./SimulinkToLasec";
import { parseSlx } from "./SlxParser";

export function isSimulinkModelPath(filePath: string): boolean {
  return /\.(slx|mdl)$/i.test(filePath);
}

/** Lê `.slx` (pacote ZIP) ou `.mdl` (texto); o conteúdo decide quando a extensão não bate. */
export function parseSimulinkModel(data: Buffer, filePath: string): SlModel {
  const name = path.basename(filePath).replace(/\.(slx|mdl)$/i, "");
  const isZip = data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;
  return isZip ? parseSlx(data, name) : parseMdl(data.toString("utf8"), name);
}

export async function convertSimulinkFile(filePath: string, library: readonly BlockLibraryFile[]): Promise<{ project: ProjectDocument; report: SimulinkImportReport }> {
  if (!isSimulinkModelPath(filePath)) throw new Error(`Não é um modelo Simulink .slx/.mdl: ${filePath}`);
  return convertSimulinkModel(parseSimulinkModel(await fs.readFile(filePath), filePath), library);
}

/** `<nome>.lsproj` ao lado do modelo. */
export function defaultLsprojPathForSimulink(filePath: string): string {
  return path.join(path.dirname(filePath), `${path.basename(filePath).replace(/\.(slx|mdl)$/i, "")}.lsproj`);
}

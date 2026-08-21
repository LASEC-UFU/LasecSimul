import * as fs from "fs/promises";
import * as path from "path";
import type { PlcNativeModuleDto } from "../ipc/CoreClient";

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${field} must be an integer`);
  return value;
}

export function parsePlcNativeModule(value: unknown, manifestDir?: string): PlcNativeModuleDto {
  const raw = object(value, "PLC artifact");
  if (!Array.isArray(raw.exportedIo)) throw new Error("PLC artifact exportedIo must be an array");
  const nativeBinaryRef = string(raw.nativeBinaryRef, "nativeBinaryRef");
  return {
    formatVersion: integer(raw.formatVersion, "formatVersion"),
    workerProtocolVersion: integer(raw.workerProtocolVersion, "workerProtocolVersion"),
    targetPlatform: string(raw.targetPlatform, "targetPlatform"),
    targetArch: string(raw.targetArch, "targetArch"),
    strucppVersion: string(raw.strucppVersion, "strucppVersion"),
    runtimeRevision: string(raw.runtimeRevision, "runtimeRevision"),
    cxxToolchainVersion: string(raw.cxxToolchainVersion, "cxxToolchainVersion"),
    sourceHash: string(raw.sourceHash, "sourceHash"),
    artifactHash: string(raw.artifactHash, "artifactHash"),
    nativeBinaryRef: manifestDir && !path.isAbsolute(nativeBinaryRef)
      ? path.resolve(manifestDir, nativeBinaryRef)
      : path.normalize(nativeBinaryRef),
    programName: string(raw.programName, "programName"),
    exportedIo: raw.exportedIo.map((entry, index) => {
      const io = object(entry, `exportedIo[${index}]`);
      if (io.direction !== "input" && io.direction !== "output") {
        throw new Error(`exportedIo[${index}].direction must be input or output`);
      }
      return {
        ioId: string(io.ioId, `exportedIo[${index}].ioId`),
        name: string(io.name, `exportedIo[${index}].name`),
        direction: io.direction,
        iecType: string(io.iecType, `exportedIo[${index}].iecType`),
      };
    }),
    debugMap: Array.isArray(raw.debugMap) ? raw.debugMap.map((entry, index) => {
      const line = object(entry, `debugMap[${index}]`);
      return {
        generatedLine: integer(line.generatedLine, `debugMap[${index}].generatedLine`),
        sourceFile: string(line.sourceFile, `debugMap[${index}].sourceFile`),
        sourceLine: integer(line.sourceLine, `debugMap[${index}].sourceLine`),
      };
    }) : undefined,
  };
}

export async function readPlcNativeModule(manifestPath: string): Promise<PlcNativeModuleDto> {
  const absolute = path.resolve(manifestPath);
  const encoded = JSON.parse(await fs.readFile(absolute, "utf8"));
  return parsePlcNativeModule(encoded, path.dirname(absolute));
}

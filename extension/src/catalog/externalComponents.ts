import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export type ExternalComponentKind = "device" | "subcircuit";
export type ExternalDeviceRuntimeKind = "abi-device" | "mcu-adapter";

export const EXTERNAL_ROOT_FOLDER = "Externos";
export const EXTERNAL_DEVICES_FOLDER = "Devices";
export const EXTERNAL_SUBCIRCUITS_FOLDER = "Subcircuitos";

/** Pasta da paleta: Device e Subcircuito ficam diretamente em Externos. */
export function externalFolderPath(_kind: ExternalComponentKind, language = "pt-BR"): string[] {
  return [language.toLowerCase().startsWith("en") ? "External" : EXTERNAL_ROOT_FOLDER];
}

export function externalStorageDirectory(globalStoragePath: string, kind: ExternalComponentKind): string {
  return path.join(
    globalStoragePath,
    EXTERNAL_ROOT_FOLDER,
    kind === "device" ? EXTERNAL_DEVICES_FOLDER : EXTERNAL_SUBCIRCUITS_FOLDER,
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`campo obrigatório "${field}" ausente`);
  return value.trim();
}

export interface ValidatedExternalManifest {
  kind: ExternalComponentKind;
  runtimeKind?: ExternalDeviceRuntimeKind;
  typeId: string;
  json: Record<string, unknown>;
}

/** Validação estrutural única, usada tanto pelo Device por referência quanto pela importação. */
export function validateExternalManifest(filePath: string, raw: unknown): ValidatedExternalManifest {
  const json = object(raw);
  if (!json) throw new Error("o conteúdo raiz precisa ser um objeto JSON");
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".lsdevice") {
    const hasChipId = typeof json.chipId === "string" && Boolean(json.chipId.trim());
    const runtimeKind: ExternalDeviceRuntimeKind = hasChipId ? "mcu-adapter" : "abi-device";
    const typeId = requiredId(hasChipId ? json.chipId : json.typeId, hasChipId ? "chipId" : "typeId");
    if (!hasChipId && !object(json.nativeEntry)) throw new Error("dispositivo ABI sem objeto nativeEntry");
    if (hasChipId && !object(json.nativeEntry)) throw new Error("adaptador QEMU/CPU sem objeto nativeEntry");
    if (!Array.isArray(json.pins) && !object(json.pinMap)) throw new Error("arquivo .lsdevice sem pins[] ou pinMap");
    return { kind: "device", runtimeKind, typeId, json };
  }
  if (extension === ".lssubcircuit") {
    const typeId = requiredId(json.typeId, "typeId");
    if (!Array.isArray(json.components)) throw new Error("subcircuito sem components[]");
    if (!Array.isArray(json.interface)) throw new Error("subcircuito sem interface[]");
    return { kind: "subcircuit", typeId, json };
  }
  throw new Error(`extensão não suportada: ${extension || "(sem extensão)"}`);
}

function collectAssetReferences(value: unknown, key: string | undefined, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectAssetReferences(entry, key, output);
    return;
  }
  const record = object(value);
  if (record) {
    for (const [childKey, child] of Object.entries(record)) collectAssetReferences(child, childKey, output);
    return;
  }
  if (typeof value !== "string" || !value.trim()) return;
  if (key === "asset" || key === "manifest" || key === "library" || key === "path") output.add(value);
}

/** Dependências de arquivo declaradas. nativeEntry é obrigatório; assets/dependencies são aditivos. */
export function manifestDependencyPaths(manifestPath: string, json: Record<string, unknown>): string[] {
  const references = new Set<string>();
  const nativeEntry = object(json.nativeEntry);
  if (nativeEntry) for (const value of Object.values(nativeEntry)) if (typeof value === "string") references.add(value);
  collectAssetReferences(json.dependencies, "dependencies", references);
  collectAssetReferences(json.package, "package", references);
  collectAssetReferences(json.logicSymbolPackage, "logicSymbolPackage", references);
  collectAssetReferences(json.icon, "icon", references);
  const base = path.dirname(manifestPath);
  return [...references]
    .filter((reference) => !reference.startsWith("data:") && !/^https?:\/\//i.test(reference))
    .map((reference) => path.resolve(base, reference));
}

export function missingManifestDependencies(manifestPath: string, json: Record<string, unknown>): string[] {
  const nativeEntry = object(json.nativeEntry);
  const platformKey = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-universal" : "linux-x64";
  const nonCurrentNative = new Set(Object.entries(nativeEntry ?? {})
    .filter(([key]) => key !== platformKey)
    .flatMap(([, value]) => typeof value === "string" ? [path.resolve(path.dirname(manifestPath), value)] : []));
  return manifestDependencyPaths(manifestPath, json)
    .filter((dependency) => !nonCurrentNative.has(dependency) && !fs.existsSync(dependency));
}

/** typeIds declarados por um pacote externo que precisam existir antes do registro. */
export function manifestComponentDependencies(manifest: ValidatedExternalManifest): string[] {
  const dependencies = new Set<string>();
  if (Array.isArray(manifest.json.dependencies)) {
    for (const dependency of manifest.json.dependencies) {
      if (typeof dependency === "string" && dependency.trim()) dependencies.add(dependency.trim());
      const dependencyObject = object(dependency);
      const typeId = dependencyObject?.typeId;
      if (typeof typeId === "string" && typeId.trim()) dependencies.add(typeId.trim());
    }
  }
  if (manifest.kind === "subcircuit" && Array.isArray(manifest.json.components)) {
    for (const component of manifest.json.components) {
      const typeId = object(component)?.typeId;
      if (typeof typeId === "string" && typeId.trim()) dependencies.add(typeId.trim());
    }
  }
  dependencies.delete(manifest.typeId);
  return [...dependencies];
}

function safeFolderName(typeId: string): string {
  return typeId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** Copia manifesto e dependências declaradas preservando caminhos relativos ao diretório de origem. */
export function copyExternalManifest(
  sourcePath: string,
  manifest: ValidatedExternalManifest,
  globalStoragePath: string,
): string {
  const destinationRoot = path.join(externalStorageDirectory(globalStoragePath, manifest.kind), safeFolderName(manifest.typeId));
  fs.mkdirSync(destinationRoot, { recursive: true });
  const sourceRoot = path.dirname(sourcePath);
  const destinationManifest = path.join(destinationRoot, path.basename(sourcePath));
  fs.copyFileSync(sourcePath, destinationManifest);
  for (const dependency of manifestDependencyPaths(sourcePath, manifest.json)) {
    if (!fs.existsSync(dependency)) continue; // binários de outras plataformas são opcionais
    const relative = path.relative(sourceRoot, dependency);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const destination = path.join(destinationRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(dependency, destination);
  }
  return destinationManifest;
}

/** library.json transitório para carregar um .lsdevice avulso sem registrá-lo permanentemente. */
export function writeAdhocDeviceLibrary(
  manifestPath: string,
  manifest: ValidatedExternalManifest,
  globalStoragePath: string,
): string {
  if (manifest.kind !== "device" || !manifest.runtimeKind) throw new Error("manifesto não é .lsdevice");
  const digest = crypto.createHash("sha256").update(path.resolve(manifestPath)).digest("hex").slice(0, 16);
  const directory = path.join(globalStoragePath, "adhoc-device-libraries", digest);
  fs.mkdirSync(directory, { recursive: true });
  const libraryPath = path.join(directory, "library.json");
  const publisher = typeof manifest.json.publisher === "string" ? manifest.json.publisher : `arquivo:${path.basename(manifestPath)}`;
  const entry = manifest.runtimeKind === "mcu-adapter"
    ? { chipId: manifest.typeId, manifest: path.resolve(manifestPath) }
    : { typeId: manifest.typeId, manifest: path.resolve(manifestPath) };
  const library = {
    schemaVersion: 1,
    publisher,
    trust: manifest.json.trust,
    ...(manifest.runtimeKind === "mcu-adapter" ? { mcus: [entry] } : { devices: [entry] }),
  };
  fs.writeFileSync(libraryPath, `${JSON.stringify(library, null, 2)}\n`, "utf8");
  return libraryPath;
}

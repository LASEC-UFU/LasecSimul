import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import {
  copyExternalManifest,
  externalFolderPath,
  externalStorageDirectory,
  manifestComponentDependencies,
  missingManifestDependencies,
  validateExternalManifest,
  writeAdhocDeviceLibrary,
} from "./externalComponents";

(async () => {
  const { test, finish } = createTestRunner("externalComponents - Device genérico e importação externa");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-external-"));
  const source = path.join(tmp, "source");
  const storage = path.join(tmp, "storage");
  fs.mkdirSync(path.join(source, "build", "win-x64"), { recursive: true });
  fs.writeFileSync(path.join(source, "build", "win-x64", "device.dll"), "test");
  const manifestPath = path.join(source, "custom.lsdevice");
  const json = {
    schemaVersion: 1,
    typeId: "external.custom",
    name: "Custom",
    nativeEntry: { "win32-x64": "build/win-x64/device.dll", "linux-x64": "build/linux-x64/device.so" },
    pins: [{ id: "a" }, { id: "b" }],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(json));

  await test("Device e Subcircuito ficam diretamente em Externos na paleta", () => {
    assert(JSON.stringify(externalFolderPath("device")) === JSON.stringify(["Externos"]), "pasta de Device incorreta");
    assert(JSON.stringify(externalFolderPath("subcircuit")) === JSON.stringify(["Externos"]), "pasta de subcircuito incorreta");
    assert(externalStorageDirectory(storage, "device").endsWith(path.join("Externos", "Devices")), "destino físico de Device incorreto");
  });

  await test("catálogo não cria subpastas e Device usa o mesmo fallback de ícone do antigo Blinker", () => {
    const candidates = [
      path.resolve(process.cwd(), "..", "project", "schema", "component-catalog.json"),
      path.resolve(process.cwd(), "project", "schema", "component-catalog.json"),
    ];
    const catalogPath = candidates.find((candidate) => fs.existsSync(candidate));
    assert(Boolean(catalogPath), "component-catalog.json não encontrado");
    const catalog = JSON.parse(fs.readFileSync(catalogPath!, "utf8")) as { items: Array<{ typeId: string; folderPath?: string[]; icon?: string }> };
    const device = catalog.items.find((entry) => entry.typeId === "devices.external");
    const subcircuit = catalog.items.find((entry) => entry.typeId === "subcircuits.external");
    assert(JSON.stringify(device?.folderPath) === JSON.stringify(["Externos"]), "Device não está diretamente em Externos");
    assert(JSON.stringify(subcircuit?.folderPath) === JSON.stringify(["Externos"]), "Subcircuito não está diretamente em Externos");
    assert(device?.icon === undefined, "Device deve usar o fallback SVG de chip usado pelo antigo Blinker");
  });

  await test("valida .lsdevice ABI e preserva typeId", () => {
    const parsed = validateExternalManifest(manifestPath, json);
    assert(parsed.kind === "device" && parsed.runtimeKind === "abi-device", "tipo de runtime incorreto");
    assert(parsed.typeId === "external.custom", "typeId não preservado");
  });

  await test("descobre dependências de typeId declaradas e de subcircuito", () => {
    const subcircuit = validateExternalManifest("board.lssubcircuit", {
      typeId: "external.board",
      interface: [],
      dependencies: ["devices.explicit", { typeId: "devices.object", path: "asset.bin" }],
      components: [{ typeId: "devices.internal" }, { typeId: "external.board" }],
    });
    const dependencies = manifestComponentDependencies(subcircuit).sort();
    assert(
      JSON.stringify(dependencies) === JSON.stringify(["devices.explicit", "devices.internal", "devices.object"]),
      `dependências inesperadas: ${dependencies.join(", ")}`,
    );
  });

  await test("rejeita extensão e manifesto inválidos com mensagem clara", () => {
    let unsupported = false;
    try { validateExternalManifest(path.join(source, "x.txt"), {}); } catch (err) { unsupported = String(err).includes("extensão não suportada"); }
    assert(unsupported, "extensão não suportada deveria ser rejeitada");
    let missingId = false;
    try { validateExternalManifest(path.join(source, "x.lsdevice"), { nativeEntry: {}, pins: [] }); } catch (err) { missingId = String(err).includes("typeId"); }
    assert(missingId, "typeId ausente deveria ser rejeitado");
  });

  await test("valida somente dependência nativa da plataforma atual", () => {
    const missing = missingManifestDependencies(manifestPath, json);
    if (process.platform === "win32") assert(missing.length === 0, "binário Windows existente deveria bastar no Windows");
  });

  await test("copia manifesto/dependência para Externos/Devices sem registrar a fonte original", () => {
    const parsed = validateExternalManifest(manifestPath, json);
    const copied = copyExternalManifest(manifestPath, parsed, storage);
    assert(copied.includes(path.join("Externos", "Devices", "external.custom")), "manifesto não foi para Externos/Devices");
    assert(fs.existsSync(path.join(path.dirname(copied), "build", "win-x64", "device.dll")), "dependência não foi copiada");
  });

  await test("wrapper ad-hoc aponta diretamente ao .lsdevice e não cria registro de catálogo", () => {
    const parsed = validateExternalManifest(manifestPath, json);
    const libraryPath = writeAdhocDeviceLibrary(manifestPath, parsed, storage);
    const library = JSON.parse(fs.readFileSync(libraryPath, "utf8"));
    assert(library.devices[0].typeId === "external.custom", "wrapper perdeu typeId");
    assert(path.normalize(library.devices[0].manifest) === path.normalize(manifestPath), "wrapper não aponta ao manifesto original");
    assert(library.registeredSources === undefined, "Device genérico não pode registrar permanentemente no catálogo");
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  finish();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import type { RegisteredSource } from "./UnifiedCatalog";
import type * as RegisteredSourcesModule from "./registeredSources";

type ModuleLoader = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const moduleWithLoad = require("module") as { _load: ModuleLoader };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean): unknown {
  if (request === "vscode") {
    return {
      env: { language: "pt-BR" },
      workspace: { getConfiguration: () => ({ get: () => "system" }) },
    };
  }
  return originalLoad.apply(this, [request, parent, isMain]);
};

const { resolveRegisteredItem } = require("./registeredSources") as typeof RegisteredSourcesModule;

function writeSubcircuitManifest(filePath: string): void {
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      typeId: "subcircuits.local_test",
      name: "Local Test",
      components: [],
      wires: [],
      interface: [{ pinId: "P1", label: "P1", internalTunnel: "P1" }],
    }, null, 2),
    "utf8"
  );
}

function sourceFor(filePath: string): RegisteredSource {
  return {
    id: "local-sub",
    kind: "subcircuit-file",
    filePath,
    folderPath: ["Meus Subcircuitos"],
  };
}

(async () => {
  const { test, finish } = createTestRunner("registeredSources - subcircuit-file");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-registered-sources-"));

  try {
    await test("subcircuito avulso sem library.json fica habilitado e registra via manifesto", () => {
      const manifestPath = path.join(tmpDir, "standalone.lssubcircuit");
      writeSubcircuitManifest(manifestPath);

      const resolved = resolveRegisteredItem(sourceFor(manifestPath), tmpDir, "pt-BR", new Set());

      assert(resolved.entry.disabled !== true, "subcircuito avulso nao deveria nascer desabilitado");
      assert(resolved.libraryPathToLoad === undefined, "sem library.json nao deveria tentar carregar biblioteca");
      assert(resolved.adhocSubcircuitPathToRegister === manifestPath, "deveria registrar o manifesto direto no Core");
      assert(resolved.entry.typeId === "subcircuits.local_test", "typeId deve vir do manifesto");
      assert(resolved.entry.pinIds?.[0] === "P1", "pinId deve vir de interface[].pinId");
    });

    await test("subcircuito com library.json preserva carregamento por biblioteca", () => {
      const withLibraryDir = path.join(tmpDir, "with-library");
      fs.mkdirSync(withLibraryDir);
      const manifestPath = path.join(withLibraryDir, "registered.lssubcircuit");
      const libraryPath = path.join(withLibraryDir, "library.json");
      writeSubcircuitManifest(manifestPath);
      fs.writeFileSync(libraryPath, JSON.stringify({ schemaVersion: 1, subcircuits: [] }), "utf8");

      const resolved = resolveRegisteredItem(sourceFor(manifestPath), tmpDir, "pt-BR", new Set());

      assert(resolved.entry.disabled !== true, "subcircuito com library.json tambem deve ficar habilitado");
      assert(resolved.libraryPathToLoad === libraryPath, "deveria continuar carregando library.json quando existir");
      assert(resolved.adhocSubcircuitPathToRegister === undefined, "com library.json nao precisa registro avulso");
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

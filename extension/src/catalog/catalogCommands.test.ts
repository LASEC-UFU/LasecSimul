import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import type { LoadedUnifiedCatalog } from "./UnifiedCatalog";
import type * as CatalogCommandsModule from "./catalogCommands";

// `catalogCommands.ts` importa `vscode` (transitivamente, via `currentLanguage.ts`) -- mesmo truque
// de mock que `registeredSources.test.ts` já usa, pra poder rodar como script Node puro fora do
// host da extensão.
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

const { findRegisteredSourceById } = require("./catalogCommands") as typeof CatalogCommandsModule;

(async () => {
  const { test, finish } = createTestRunner("catalogCommands - findRegisteredSourceById");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-catalog-commands-"));

  try {
    await test("acha um sourceId vindo de deviceLibraries[] expandido (bug real: 'Abrir Subcircuito'/'Remover da paleta' falhavam com 'não encontrado no catálogo' pra QUALQUER item vindo de library.json, já que registeredSources[] normalmente está vazio desde a unificação de device ID)", () => {
      const dir = path.join(tmpDir, "expanded");
      fs.mkdirSync(dir);
      const manifestPath = path.join(dir, "sub.lssubcircuit");
      fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, typeId: "subcircuits.local_test", components: [], wires: [], interface: [] }), "utf8");
      const libraryPath = path.join(dir, "library.json");
      fs.writeFileSync(libraryPath, JSON.stringify({ subcircuits: [{ typeId: "subcircuits.local_test", manifest: "sub.lssubcircuit" }] }), "utf8");

      const unifiedCatalog: LoadedUnifiedCatalog = {
        catalog: [],
        deviceLibraries: [libraryPath],
        registeredSources: [],
        sourcePath: path.join(tmpDir, "component-catalog.json"),
      };
      const expectedId = `bundled:subcircuit-file:${manifestPath}`;
      const found = findRegisteredSourceById(tmpDir, unifiedCatalog, expectedId);
      assert(found !== undefined, `deveria achar a fonte expandida de deviceLibraries[], id esperado ${expectedId}`);
      assert(found?.filePath === manifestPath, `filePath deveria apontar pro manifesto, recebido ${found?.filePath}`);
      assert(found?.removable === false, "fonte expandida de biblioteca nunca é removível individualmente");
    });

    await test("acha um sourceId vindo de registeredSources[] (registro manual/avulso, não de deviceLibraries[])", () => {
      const manifestPath = path.join(tmpDir, "standalone.lssubcircuit");
      fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, typeId: "subcircuits.standalone", components: [], wires: [], interface: [] }), "utf8");
      const unifiedCatalog: LoadedUnifiedCatalog = {
        catalog: [],
        deviceLibraries: [],
        registeredSources: [{ id: "manual-1", kind: "subcircuit-file", filePath: manifestPath, folderPath: ["Meus Subcircuitos"] }],
        sourcePath: path.join(tmpDir, "component-catalog.json"),
      };
      const found = findRegisteredSourceById(tmpDir, unifiedCatalog, "manual-1");
      assert(found?.filePath === manifestPath, "deveria achar a fonte registrada manualmente");
    });

    await test("sourceId inexistente em ambos retorna undefined", () => {
      const unifiedCatalog: LoadedUnifiedCatalog = { catalog: [], deviceLibraries: [], registeredSources: [], sourcePath: path.join(tmpDir, "component-catalog.json") };
      assert(findRegisteredSourceById(tmpDir, unifiedCatalog, "nao-existe") === undefined, "sourceId desconhecido deveria retornar undefined");
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  finish();
})();

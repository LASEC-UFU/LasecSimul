import * as fs from "fs";
import * as path from "path";
import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { parseSubcircuitDocument } from "./subcircuitDocument";
import { validateSubcircuitDocument } from "./subcircuitValidation";

/**
 * Gate de regressão pra `Load Device Library fail` (achado real: 24 blocos SignalEngine gerados
 * por `scripts/generate-control-block-library.mjs` tinham wires apontando pro id errado do túnel
 * de entrada -- ex. "in-tunnel" quando o componente nascia com id "in" -- e como TODOS os
 * subcircuitos de produção compartilham `subcircuits/library.json`, um único manifesto quebrado
 * derrubava `loadDeviceLibrary` inteiro: `core/src/app/CoreApplication.cpp::loadSubcircuitLibraryFile`
 * itera `library.json["subcircuits"]` SEM try/catch por item, então a primeira exceção
 * ("wire referencia componente inexistente: ...") propaga pra fora e marca a biblioteca INTEIRA
 * como falha -- mesmo os manifestos individualmente válidos ficam com `disabled:true` na paleta).
 *
 * Este teste roda a MESMA validação que o Core aplica (`validateSubcircuitDocument`, já usada por
 * `registeredSources.ts` antes de expor um subcircuito na paleta) contra TODO manifesto registrado
 * em `subcircuits/library.json` -- não só os arquivos que alguém lembrou de testar manualmente.
 */
(async () => {
  const { test, finish } = createTestRunner("subcircuitLibraryLoad -- toda a Device Library carrega sem erro");
  const repositoryRoot = path.resolve(__dirname, "../../../..");
  const subcircuitsDir = path.join(repositoryRoot, "subcircuits");
  const libraryPath = path.join(subcircuitsDir, "library.json");
  const library = JSON.parse(fs.readFileSync(libraryPath, "utf8")) as {
    subcircuits: Array<{ typeId: string; manifest: string }>;
  };

  await test("library.json não tem typeId nem manifest duplicado", () => {
    const typeIds = new Set<string>();
    const manifests = new Set<string>();
    for (const entry of library.subcircuits) {
      assert(!typeIds.has(entry.typeId), `typeId duplicado em library.json: ${entry.typeId}`);
      typeIds.add(entry.typeId);
      assert(!manifests.has(entry.manifest), `manifest duplicado em library.json: ${entry.manifest}`);
      manifests.add(entry.manifest);
    }
    assert(library.subcircuits.length > 0, "library.json deveria registrar pelo menos um subcircuito");
  });

  for (const entry of library.subcircuits) {
    await test(`${entry.manifest} (${entry.typeId}) carrega e valida sem erro`, () => {
      const filePath = path.join(subcircuitsDir, entry.manifest);
      assert(fs.existsSync(filePath), `manifesto ausente: ${filePath}`);
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const parsed = parseSubcircuitDocument(raw, path.dirname(filePath));
      assert(parsed.ok, `${entry.manifest}: schemaVersion/estrutura inválida (${!parsed.ok ? parsed.reason : ""})`);
      if (!parsed.ok) return;
      assert(parsed.document.typeId === entry.typeId, `${entry.manifest}: typeId do arquivo (${parsed.document.typeId}) diverge de library.json (${entry.typeId})`);
      const validation = validateSubcircuitDocument(parsed.document);
      assert(
        validation.errors.length === 0,
        `${entry.manifest} tem ${validation.errors.length} erro(s) de validação -- "Load Device Library fail" real: ${validation.errors.join(" | ")}`
      );
    });
  }

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

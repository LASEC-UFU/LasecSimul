// Telas HMI (`visualDocuments`) e Faceplates de subsistemas (`subsystems[].faceplate`) no .lsproj:
// ida e volta, ids derivados, validação e os exemplos de examples/calculo (docs/62 §12, docs/64 §7).
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ProjectSerializer } from "../../src/project/ProjectSerializer";
import { createEmptyProject } from "../../src/project/ProjectTypes";
import { createFaceplateDocument, createScreenDocument, faceplateDocumentId } from "../../src/ui/webview/visualDocument";

(async () => {
  const serializer = new ProjectSerializer();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasecsimul-visualdocs-"));
  let passed = 0;
  const test = async (label: string, body: () => Promise<void> | void) => {
    try {
      await body();
      passed += 1;
      console.log(`  ✓ ${label}`);
    } catch (error) {
      console.log(`  ✗ ${label}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  };
  console.log("\nProjectVisualDocuments\n");

  await test("tela e Faceplate fazem ida e volta; o id do Faceplate vem do typeId", async () => {
    const project = createEmptyProject();
    const screen = createScreenDocument("tela-1", "Painel");
    const faceplate = { ...createFaceplateDocument("subsystem.tanque", "Tanque"), id: "faceplate:outro" };
    project.visualDocuments = [screen];
    project.subsystems = [{ typeId: "subsystem.tanque", name: "Tanque", components: [], faceplate } as never];
    const file = path.join(tmpDir, "ida-e-volta.lsproj");
    await serializer.save(file, project);
    const loaded = await serializer.load(file);
    assert.strictEqual(loaded.visualDocuments?.[0]?.id, "tela-1");
    assert.strictEqual(loaded.visualDocuments?.[0]?.kind, "screen");
    const loadedFaceplate = (loaded.subsystems?.[0] as { faceplate?: { id: string; kind: string; presentation: { fullscreenContext: string } } }).faceplate;
    assert.strictEqual(loadedFaceplate?.id, faceplateDocumentId("subsystem.tanque"), "id derivado da definição, não do arquivo");
    assert.strictEqual(loadedFaceplate?.kind, "faceplate");
    assert.strictEqual(loadedFaceplate?.presentation.fullscreenContext, "hmi", "Faceplate não muda de contexto em tela cheia");
  });

  await test("Faceplate com kind de tela é recusado com mensagem do lugar", async () => {
    const file = path.join(tmpDir, "kind-errado.lsproj");
    const project = { ...createEmptyProject(), subsystems: [{ typeId: "subsystem.x", name: "X", components: [], faceplate: { ...createScreenDocument("a", "A") } }] };
    await fs.writeFile(file, JSON.stringify(project));
    await assert.rejects(() => serializer.load(file), /subsystems\[0\]\.faceplate\.kind/);
  });

  await test("página do Faceplate segue as regras da HMI (página sem id recusada)", async () => {
    const file = path.join(tmpDir, "pagina-invalida.lsproj");
    const broken = createFaceplateDocument("subsystem.x", "X");
    const project = { ...createEmptyProject(), subsystems: [{ typeId: "subsystem.x", name: "X", components: [], faceplate: { ...broken, pages: [{ name: "sem id" }] } }] };
    await fs.writeFile(file, JSON.stringify(project));
    await assert.rejects(() => serializer.load(file), /faceplate/);
  });

  await test("exemplos de examples/calculo: tela do Laboratório, Faceplates das plantas, sem calculusLab", async () => {
    const dir = path.resolve(__dirname, "../../../../examples/calculo");
    for (const file of ["laboratorio-calculo.lsproj", "tanque.lsproj", "primeira-ordem.lsproj", "sensor.lsproj", "funcoes-e-limites.lsproj"]) {
      const loaded = await serializer.load(path.join(dir, file));
      assert.ok(!loaded.calculusLab, `${file}: sem calculusLab`);
      const screen = loaded.visualDocuments?.[0];
      assert.ok(screen && screen.presentation.defaultContext === "lab" && screen.presentation.startInOperation === true, `${file}: tela do Laboratório`);
      assert.ok(loaded.components.some((component) => component.typeId === "tools.hmi_screen" && component.properties.screenId === screen.id), `${file}: botão abre a tela`);
      for (const definition of loaded.subsystems ?? []) {
        const faceplate = (definition as { faceplate?: { id: string; pages: Array<{ elements: unknown[] }> } }).faceplate;
        assert.ok(faceplate && faceplate.id === faceplateDocumentId(definition.typeId) && faceplate.pages[0]!.elements.length > 0, `${file}: Faceplate de ${definition.typeId}`);
      }
    }
  });

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log(`\nResultado: ${passed} passaram, ${process.exitCode ? "com falhas" : "0 falharam"}`);
})();

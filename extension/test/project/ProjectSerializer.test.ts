import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ProjectSerializer } from "../../src/project/ProjectSerializer";
import { createEmptyProject } from "../../src/project/ProjectTypes";

(async () => {
  const serializer = new ProjectSerializer();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasecsimul-lsproj-"));

  const emptyPath = path.join(tmpDir, "empty.lsproj");
  const project = createEmptyProject();
  await serializer.save(emptyPath, project);
  const loaded = await serializer.load(emptyPath);
  assert.strictEqual(loaded.schemaVersion, 1);
  assert.strictEqual(loaded.components.length, 0);
  assert.strictEqual(loaded.wires.length, 0);

  const invalidSchemaPath = path.join(tmpDir, "invalid-schema.lsproj");
  await fs.writeFile(invalidSchemaPath, JSON.stringify({ ...project, schemaVersion: 999 }), "utf8");
  await assert.rejects(serializer.load(invalidSchemaPath), /schemaVersion incompatível/);

  const invalidComponentPath = path.join(tmpDir, "invalid-component.lsproj");
  await fs.writeFile(
    invalidComponentPath,
    JSON.stringify({
      ...project,
      components: [{ id: "c1", properties: {} }],
    }),
    "utf8"
  );
  await assert.rejects(serializer.load(invalidComponentPath), /typeId ausente/);

  const passiveFixturePath = path.resolve(process.cwd(), "../test/fixtures/projects/basic-passive.lsproj");
  const passive = await serializer.load(passiveFixturePath);
  assert.strictEqual(passive.components.length, 3);
  assert.strictEqual(passive.wires.length, 2);

  const roundTripPath = path.join(tmpDir, "roundtrip.lsproj");
  await serializer.save(roundTripPath, passive);
  const roundTrip = await serializer.load(roundTripPath);
  assert.deepStrictEqual(roundTrip.components.map((component) => component.id), ["r1", "c1", "l1"]);
  assert.deepStrictEqual(roundTrip.wires.map((wire) => wire.id), ["w1", "w2"]);

  // Regressão: label/showId/showValue precisam sobreviver a um ciclo save→load (ver Épico E do
  // roadmap de pendências — `validateComponent` já dropou esses campos no passado).
  const labeledProject = createEmptyProject();
  labeledProject.components.push({
    id: "r1",
    typeId: "core.resistor",
    properties: { resistance: 220 },
    label: "Resistor-7",
    showId: true,
    showValue: false,
    flipH: true,
    flipV: false,
  });
  const labeledPath = path.join(tmpDir, "labeled.lsproj");
  await serializer.save(labeledPath, labeledProject);
  const labeledRoundTrip = await serializer.load(labeledPath);
  assert.strictEqual(labeledRoundTrip.components[0]?.label, "Resistor-7");
  assert.strictEqual(labeledRoundTrip.components[0]?.showId, true);
  assert.strictEqual(labeledRoundTrip.components[0]?.showValue, false);
  assert.strictEqual(labeledRoundTrip.components[0]?.flipH, true);
  assert.strictEqual(labeledRoundTrip.components[0]?.flipV, false);

  // `subcircuitRef` (bloco genérico de subcircuito por caminho, ver .spec/lasecsimul-subcircuits.spec
  // seção 9) precisa sobreviver a save→load igual label/showId/showValue -- é a ÚNICA exceção
  // deliberada à regra "nunca persistir pinos" (lastKnownPinIds), sem ela o componente perderia a
  // identidade elétrica dos fios ao reabrir com o arquivo ausente.
  const subcircuitRefProject = createEmptyProject();
  subcircuitRefProject.components.push({
    id: "sub1",
    typeId: "subcircuits.divisor_5v",
    properties: {},
    visual: { x: 10, y: 20, rotation: 0 },
    subcircuitRef: {
      path: "../subcircuits/divisor_5v.lssubcircuit",
      lastKnownTypeId: "subcircuits.divisor_5v",
      lastKnownPinIds: ["VIN", "VOUT", "GND"],
    },
  });
  const subcircuitRefPath = path.join(tmpDir, "subcircuit-ref.lsproj");
  await serializer.save(subcircuitRefPath, subcircuitRefProject);
  const subcircuitRefRoundTrip = await serializer.load(subcircuitRefPath);
  assert.deepStrictEqual(subcircuitRefRoundTrip.components[0]?.subcircuitRef, {
    path: "../subcircuits/divisor_5v.lssubcircuit",
    lastKnownTypeId: "subcircuits.divisor_5v",
    lastKnownPinIds: ["VIN", "VOUT", "GND"],
  });

  // Componente normal (sem `subcircuitRef`) continua sem o campo depois do load -- nunca inventa um
  // valor default pra quem nunca teve essa referência.
  assert.strictEqual(labeledRoundTrip.components[0]?.subcircuitRef, undefined);

  // `subcircuitRef` sem `path` (malformado) é ignorado, não quebra o load do resto do componente.
  const malformedRefPath = path.join(tmpDir, "malformed-subcircuit-ref.lsproj");
  await fs.writeFile(
    malformedRefPath,
    JSON.stringify({
      ...createEmptyProject(),
      components: [{ id: "sub1", typeId: "subcircuits.divisor_5v", properties: {}, subcircuitRef: { lastKnownTypeId: "x" } }],
    }),
    "utf8"
  );
  const malformedRefLoaded = await serializer.load(malformedRefPath);
  assert.strictEqual(malformedRefLoaded.components[0]?.subcircuitRef, undefined);

  // Ausência completa dos campos (projeto salvo antes desta versão) não deve quebrar o load.
  const legacyPath = path.join(tmpDir, "legacy.lsproj");
  await fs.writeFile(
    legacyPath,
    JSON.stringify({
      ...createEmptyProject(),
      components: [{ id: "r1", typeId: "core.resistor", properties: {} }],
    }),
    "utf8"
  );
  const legacyLoaded = await serializer.load(legacyPath);
  assert.strictEqual(legacyLoaded.components[0]?.label, undefined);
  assert.strictEqual(legacyLoaded.components[0]?.showId, undefined);
  assert.strictEqual(legacyLoaded.components[0]?.showValue, undefined);

  // Batch headless de todo .lsproj em test/fixtures/projects/ (Épico I do roadmap de pendências):
  // qualquer fixture nova adicionada ali já é coberta automaticamente, sem precisar editar este
  // arquivo -- convenção de nome decide a expectativa ("invalid" no nome == deveria rejeitar).
  const fixturesDir = path.resolve(process.cwd(), "../test/fixtures/projects");
  const fixtureFiles = (await fs.readdir(fixturesDir)).filter((name) => name.endsWith(".lsproj"));
  assert.ok(fixtureFiles.length > 0, "deveria haver ao menos um fixture .lsproj pra cobrir no batch");
  for (const fileName of fixtureFiles) {
    const fixturePath = path.join(fixturesDir, fileName);
    const expectInvalid = fileName.toLowerCase().includes("invalid");
    if (expectInvalid) {
      await assert.rejects(serializer.load(fixturePath), `fixture "${fileName}" deveria ser rejeitado no load`);
    } else {
      await serializer.load(fixturePath); // lança (e falha o teste) se não conseguir carregar
    }
  }
  console.log(`Batch headless: ${fixtureFiles.length} fixture(s) de test/fixtures/projects/ verificado(s).`);
})();

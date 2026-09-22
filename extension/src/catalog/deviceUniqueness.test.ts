import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { checkDeviceIdUniqueness, DeviceIdOwner, formatDeviceIdConflict } from "./deviceUniqueness";

(async () => {
  const { test, finish } = createTestRunner("deviceUniqueness - global device ID uniqueness");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-device-uniqueness-"));
  const fileA = path.join(tmpDir, "file-a.lsdevice");
  const fileB = path.join(tmpDir, "file-b.lsdevice");
  fs.writeFileSync(fileA, "{}");
  fs.writeFileSync(fileB, "{}");

  await test("um arquivo com um dispositivo: sem conflito", () => {
    const owners: DeviceIdOwner[] = [{ typeId: "device.a", sourceFile: fileA }];
    assert(checkDeviceIdUniqueness(owners).length === 0, "1 dono por typeId nunca deveria gerar conflito");
  });

  await test("um arquivo com vários dispositivos: cada um registrado individualmente, sem conflito entre si", () => {
    const owners: DeviceIdOwner[] = [
      { typeId: "device.a", sourceFile: fileA },
      { typeId: "device.b", sourceFile: fileA },
      { typeId: "device.c", sourceFile: fileA },
    ];
    assert(checkDeviceIdUniqueness(owners).length === 0, "vários typeIds distintos do MESMO arquivo nunca conflitam entre si");
  });

  await test("vários arquivos com dispositivos distintos: sem conflito", () => {
    const owners: DeviceIdOwner[] = [
      { typeId: "device.a", sourceFile: fileA },
      { typeId: "device.b", sourceFile: fileB },
    ];
    assert(checkDeviceIdUniqueness(owners).length === 0, "typeIds diferentes em arquivos diferentes nunca conflitam");
  });

  await test("mesmo device ID declarado em dois arquivos DIFERENTES: conflito reportado com os 2 caminhos", () => {
    const owners: DeviceIdOwner[] = [
      { typeId: "device.a", sourceFile: fileA },
      { typeId: "device.a", sourceFile: fileB },
    ];
    const conflicts = checkDeviceIdUniqueness(owners);
    assert(conflicts.length === 1, `esperado 1 conflito, recebido ${conflicts.length}`);
    assert(conflicts[0]!.typeId === "device.a", "conflito deveria ser sobre 'device.a'");
    assert(conflicts[0]!.firstSource === fs.realpathSync(fileA), "firstSource deveria ser o primeiro arquivo (canonicalizado)");
    assert(conflicts[0]!.conflictingSource === fs.realpathSync(fileB), "conflictingSource deveria ser o segundo arquivo (canonicalizado)");
  });

  await test("mesmo arquivo referenciado duas vezes (caminho idêntico): deduplicado, nunca conflito", () => {
    const owners: DeviceIdOwner[] = [
      { typeId: "device.a", sourceFile: fileA },
      { typeId: "device.a", sourceFile: fileA },
    ];
    assert(checkDeviceIdUniqueness(owners).length === 0, "o MESMO arquivo declarando o MESMO typeId duas vezes não é duplicidade entre fontes -- é o mesmo dono");
  });

  await test("caminhos diferentes pro MESMO arquivo (ex: com '..' no meio): normalizado por caminho real, sem conflito", () => {
    const equivalentPath = path.join(tmpDir, "sub", "..", "file-a.lsdevice");
    const owners: DeviceIdOwner[] = [
      { typeId: "device.a", sourceFile: fileA },
      { typeId: "device.a", sourceFile: equivalentPath },
    ];
    assert(checkDeviceIdUniqueness(owners).length === 0, "dois caminhos relativos equivalentes ao MESMO arquivo real não deveriam gerar conflito");
  });

  await test("biblioteca/runtime compartilhado entre dispositivos DIFERENTES não é duplicação", () => {
    // Dois devices distintos, cada um com seu próprio arquivo canônico, mas ambos "usando" o mesmo
    // binário/runtime na prática (aqui simulado só pelos typeIds distintos -- o nativeEntry
    // compartilhado não entra nesta checagem, que é inteiramente sobre canonical file por typeId).
    const owners: DeviceIdOwner[] = [
      { typeId: "logic.and_gate", sourceFile: fileA },
      { typeId: "logic.or_gate", sourceFile: fileA },
    ];
    assert(checkDeviceIdUniqueness(owners).length === 0, "dispositivos distintos compartilhando o mesmo arquivo/runtime nunca é conflito");
  });

  await test("formatDeviceIdConflict produz a mensagem no formato esperado (2 seções nomeadas)", () => {
    const message = formatDeviceIdConflict({ typeId: "logic.and", firstSource: fileA, conflictingSource: fileB });
    assert(message.includes("Duplicate device ID: logic.and"), "mensagem deveria nomear o typeId duplicado");
    assert(message.includes("First definition:") && message.includes(fileA), "mensagem deveria nomear a primeira definição");
    assert(message.includes("Conflicting definition:") && message.includes(fileB), "mensagem deveria nomear a definição conflitante");
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  await test("repositorio real: nenhum typeId e' declarado em duas fontes", () => {
    // Os testes acima exercitam a FUNCAO. Este exercita os DADOS, que e' onde o defeito estava:
    // `logic.adc` e `logic.dac` existiam ao mesmo tempo como item estatico do
    // `component-catalog.json` e como manifesto em `devices/simulide-logic/*.lsdevice`, e a unica
    // coisa que denunciava isso era um popup de erro ao abrir o editor.
    //
    // A convencao do repositorio e' inequivoca e foi confirmada contando: dos 80 dispositivos de
    // `devices/library.json`, os outros 78 NAO aparecem no catalogo estatico. Um dispositivo de
    // biblioteca pertence ao seu manifesto; o catalogo estatico so' declara o que nao tem manifesto.
    const repoRoot = [path.resolve(process.cwd(), ".."), process.cwd()]
      .find((candidate) => fs.existsSync(path.join(candidate, "project", "schema", "component-catalog.json")));
    assert(Boolean(repoRoot), "raiz do repositorio nao encontrada");

    const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot!, "project", "schema", "component-catalog.json"), "utf8")) as
      { items: Array<{ typeId: string }> };
    const owners: DeviceIdOwner[] = catalog.items.map((item) => ({
      typeId: item.typeId,
      sourceFile: path.join(repoRoot!, "project", "schema", "component-catalog.json"),
    }));

    for (const libraryDir of ["devices", "subcircuits"]) {
      const libraryPath = path.join(repoRoot!, libraryDir, "library.json");
      if (!fs.existsSync(libraryPath)) continue;
      const library = JSON.parse(fs.readFileSync(libraryPath, "utf8")) as
        { devices?: Array<{ typeId: string; manifest: string }>; subcircuits?: Array<{ typeId: string; manifest: string }> };
      for (const declared of [...(library.devices ?? []), ...(library.subcircuits ?? [])]) {
        owners.push({ typeId: declared.typeId, sourceFile: path.join(repoRoot!, libraryDir, declared.manifest) });
      }
    }

    const conflicts = checkDeviceIdUniqueness(owners);
    assert(conflicts.length === 0,
      `typeId duplicado entre fontes:\n${conflicts.map((conflict) => `  ${conflict.typeId}: ${conflict.firstSource} vs ${conflict.conflictingSource}`).join("\n")}`);

    // O catalogo estatico tambem nao pode repetir um typeId dentro de si mesmo -- isso nao geraria
    // conflito entre FONTES e passaria despercebido pela verificacao acima.
    const seen = new Set<string>();
    for (const item of catalog.items) {
      assert(!seen.has(item.typeId), `typeId repetido dentro do proprio component-catalog.json: ${item.typeId}`);
      seen.add(item.typeId);
    }
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

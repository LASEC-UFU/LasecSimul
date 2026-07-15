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
  finish();
})();

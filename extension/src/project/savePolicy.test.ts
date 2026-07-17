import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { decideSaveTarget } from "./savePolicy";

(async () => {
  const { test, finish } = createTestRunner("savePolicy - Salvar e Salvar como");
  await test("Salvar grava diretamente no arquivo associado", () => {
    const result = decideSaveTarget("C:/projetos/circuito.lsproj");
    assert(result.kind === "write" && result.filePath.endsWith("circuito.lsproj"), "Salvar não escolheu o arquivo atual");
  });
  await test("Salvar sem arquivo associado delega para Salvar como", () => {
    assert(decideSaveTarget(undefined).kind === "saveAs", "projeto novo deveria abrir Salvar como");
  });
  finish();
})().catch((error) => { console.error(error); process.exitCode = 1; });

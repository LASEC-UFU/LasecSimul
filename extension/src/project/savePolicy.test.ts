import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { decideSaveTarget } from "./savePolicy";
import * as fs from "fs";
import * as path from "path";

(async () => {
  const { test, finish } = createTestRunner("savePolicy - Salvar e Salvar como");
  await test("Salvar grava diretamente no arquivo associado", () => {
    const result = decideSaveTarget("C:/projetos/circuito.lsproj");
    assert(result.kind === "write" && result.filePath.endsWith("circuito.lsproj"), "Salvar não escolheu o arquivo atual");
  });
  await test("Salvar sem arquivo associado delega para Salvar como", () => {
    assert(decideSaveTarget(undefined).kind === "saveAs", "projeto novo deveria abrir Salvar como");
  });
  await test("Ctrl+S é capturado somente quando o esquemático/subcircuito está ativo", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      contributes?: { keybindings?: Array<{ command?: string; key?: string; mac?: string; when?: string }> };
    };
    const binding = manifest.contributes?.keybindings?.find((entry) => entry.command === "lasecsimul.saveProject" && entry.key === "ctrl+s");
    assert(Boolean(binding), "manifesto não registrou Ctrl+S para salvar");
    assert(binding?.mac === "cmd+s", "manifesto não registrou Cmd+S no macOS");
    assert(binding?.when === "activeWebviewPanelId == 'lasecsimul.schematic'", "Ctrl+S vazou para fora do editor LasecSimul");
  });
  finish();
})().catch((error) => { console.error(error); process.exitCode = 1; });

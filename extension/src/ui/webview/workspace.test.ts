import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
  activeWorkspaceSection,
  normalizeWorkspaceSelection,
  workspaceSectionForCatalogEntry,
} from "./workspace";

(async () => {
  const { test, finish } = createTestRunner("workspace");

  await test("seleção inválida volta para Circuit/Analog/Ctrl", () => {
    const selection = normalizeWorkspaceSelection({ main: "x", circuit: "x", process: "x" });
    assert(selection.main === "circuit", "Circuit deveria ser a aba principal padrão");
    assert(selection.circuit === "analog", "Analog deveria ser a subaba de circuito padrão");
    assert(selection.process === "ctrl", "Ctrl deveria ser a subaba de processo padrão");
  });

  await test("cada seleção resolve uma única seção ativa", () => {
    assert(activeWorkspaceSection({ main: "circuit", circuit: "digital", process: "autom" }) === "digital", "Circuit deveria usar sua subaba");
    assert(activeWorkspaceSection({ main: "process", circuit: "analog", process: "autom" }) === "autom", "Process deveria usar sua subaba");
  });

  await test("metadado explícito vence a classificação legada", () => {
    assert(workspaceSectionForCatalogEntry({ typeId: "custom.controller", workspaceSection: "ctrl" }) === "ctrl", "Ctrl explícito deveria ser preservado");
    assert(workspaceSectionForCatalogEntry({ typeId: "logic.custom", workspaceSection: "analog" }) === "analog", "override explícito deveria vencer o prefixo");
  });

  await test("famílias legadas são separadas sem duplicação", () => {
    assert(workspaceSectionForCatalogEntry({ typeId: "passive.resistor" }) === "analog", "resistor deveria ser analógico");
    assert(workspaceSectionForCatalogEntry({ typeId: "logic.and_gate" }) === "digital", "porta lógica deveria ser digital");
    assert(workspaceSectionForCatalogEntry({ typeId: "digital.generic_fpga" }) === "digital", "FPGA deveria ser digital");
    assert(workspaceSectionForCatalogEntry({ typeId: "custom.mcu", mcuHost: true }) === "digital", "host MCU deveria ser digital");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

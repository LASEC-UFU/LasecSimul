import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
  normalizeWorkspaceSelection,
  workspaceSectionForCatalogEntry,
  WORKSPACE_SECTION_ORDER,
} from "./workspace";

(async () => {
  const { test, finish } = createTestRunner("workspace");

  await test("ordem fixa das 4 abas", () => {
    assert(
      WORKSPACE_SECTION_ORDER.join(",") === "analog,digital,control,process",
      "ordem deveria ser Analógico, Digital, Controle, Processo"
    );
  });

  await test("seleção ausente/inválida volta para analog", () => {
    assert(normalizeWorkspaceSelection(undefined).section === "analog", "undefined deveria virar analog");
    assert(normalizeWorkspaceSelection(null).section === "analog", "null deveria virar analog");
    assert(normalizeWorkspaceSelection({ section: "bogus" }).section === "analog", "seção desconhecida deveria virar analog");
  });

  await test("seleção nova (flat) é preservada", () => {
    assert(normalizeWorkspaceSelection({ section: "digital" }).section === "digital", "digital deveria ser preservado");
    assert(normalizeWorkspaceSelection({ section: "control" }).section === "control", "control deveria ser preservado");
    assert(normalizeWorkspaceSelection({ section: "process" }).section === "process", "process deveria ser preservado");
  });

  await test("estado legado (main/circuit/process) migra pro formato achatado", () => {
    assert(normalizeWorkspaceSelection({ main: "circuit", circuit: "analog", process: "ctrl" }).section === "analog", "Circuit/Analog deveria migrar pra analog");
    assert(normalizeWorkspaceSelection({ main: "circuit", circuit: "digital", process: "ctrl" }).section === "digital", "Circuit/Digital deveria migrar pra digital");
    assert(normalizeWorkspaceSelection({ main: "process", circuit: "analog", process: "ctrl" }).section === "control", "Process/Ctrl deveria migrar pra control");
    assert(normalizeWorkspaceSelection({ main: "process", circuit: "analog", process: "autom" }).section === "process", "Process/Autom deveria migrar pra process");
  });

  await test("metadado explícito vence a classificação legada", () => {
    assert(workspaceSectionForCatalogEntry({ typeId: "custom.controller", workspaceSection: "control" }) === "control", "control explícito deveria ser preservado");
    assert(workspaceSectionForCatalogEntry({ typeId: "custom.tank", workspaceSection: "process" }) === "process", "process explícito deveria ser preservado");
    assert(workspaceSectionForCatalogEntry({ typeId: "logic.custom", workspaceSection: "analog" }) === "analog", "override explícito deveria vencer o prefixo");
  });

  await test("famílias legadas são separadas sem duplicação, nunca em control/process", () => {
    assert(workspaceSectionForCatalogEntry({ typeId: "passive.resistor" }) === "analog", "resistor deveria ser analógico");
    assert(workspaceSectionForCatalogEntry({ typeId: "logic.and_gate" }) === "digital", "porta lógica deveria ser digital");
    assert(workspaceSectionForCatalogEntry({ typeId: "digital.generic_fpga" }) === "digital", "FPGA/GHDL deveria ser digital");
    assert(workspaceSectionForCatalogEntry({ typeId: "outputs.hd44780" }) === "analog", "display legado sem workspaceSection deveria ser analógico (só logic./digital. ficam em Digital)");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
  normalizeWorkspaceSelection,
  workspaceSectionForCatalogEntry,
  WORKSPACE_SECTION_ORDER,
} from "./workspace";

(async () => {
  const { test, finish } = createTestRunner("workspace");

  await test("ordem fixa das 4 abas, sem a antiga Processo", () => {
    assert(
      WORKSPACE_SECTION_ORDER.join(",") === "analog,digital,control,misc",
      "ordem deveria ser Analógico, Digital, Controle, Miscelâneos"
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
    assert(normalizeWorkspaceSelection({ section: "misc" }).section === "misc", "misc deveria ser preservado");
  });

  await test("aba Processo gravada por versões anteriores abre em Controle", () => {
    assert(normalizeWorkspaceSelection({ section: "process" }).section === "control", "{ section: process } deveria migrar para control");
    // A paleta grava `setState({ query, section })`: a seção chega como string pura.
    assert(normalizeWorkspaceSelection("process").section === "control", "\"process\" (string) deveria migrar para control");
    assert(normalizeWorkspaceSelection("digital").section === "digital", "string de aba válida deveria ser preservada");
    assert(normalizeWorkspaceSelection("bogus").section === "analog", "string desconhecida deveria virar analog");
  });

  await test("estado legado (main/circuit/process) migra pro formato achatado", () => {
    assert(normalizeWorkspaceSelection({ main: "circuit", circuit: "analog", process: "ctrl" }).section === "analog", "Circuit/Analog deveria migrar pra analog");
    assert(normalizeWorkspaceSelection({ main: "circuit", circuit: "digital", process: "ctrl" }).section === "digital", "Circuit/Digital deveria migrar pra digital");
    assert(normalizeWorkspaceSelection({ main: "process", circuit: "analog", process: "ctrl" }).section === "control", "Process/Ctrl deveria migrar pra control");
    assert(normalizeWorkspaceSelection({ main: "process", circuit: "analog", process: "autom" }).section === "control", "Process/Autom deveria migrar pra control (aba Processo removida)");
  });

  await test("metadado explícito vence a classificação legada", () => {
    assert(workspaceSectionForCatalogEntry({ typeId: "custom.controller", workspaceSection: "control" }) === "control", "control explícito deveria ser preservado");
    assert(workspaceSectionForCatalogEntry({ typeId: "custom.tank", workspaceSection: "process" }) === "control", "metadado legado process deveria cair em Controle");
    assert(workspaceSectionForCatalogEntry({ typeId: "logic.custom", workspaceSection: "analog" }) === "analog", "override explícito deveria vencer o prefixo");
  });

  await test("famílias legadas são separadas sem duplicação", () => {
    assert(workspaceSectionForCatalogEntry({ typeId: "passive.resistor" }) === "analog", "resistor deveria ser analógico");
    assert(workspaceSectionForCatalogEntry({ typeId: "logic.and_gate" }) === "digital", "porta lógica deveria ser digital");
    assert(workspaceSectionForCatalogEntry({ typeId: "digital.generic_fpga" }) === "digital", "FPGA/GHDL deveria ser digital");
    assert(workspaceSectionForCatalogEntry({ typeId: "plc.instance", workspaceSection: "control" }) === "control", "PLC deveria ser controle");
    assert(workspaceSectionForCatalogEntry({ typeId: "protocol.modbus.server", workspaceSection: "control" }) === "control", "Modbus deveria estar em Controle");
    assert(workspaceSectionForCatalogEntry({ typeId: "protocol.hart.device.standard", workspaceSection: "process" }) === "control", "HART com metadado legado deveria estar em Controle");
    assert(workspaceSectionForCatalogEntry({ typeId: "outputs.hd44780" }) === "analog", "display legado sem workspaceSection deveria ser analógico (só logic./digital. ficam em Digital)");
  });

  await test("Conectores/Gráficos/Externos migraram de Analógico para Miscelâneos via workspaceSection explícito", () => {
    assert(workspaceSectionForCatalogEntry({ typeId: "connectors.bus", workspaceSection: "misc" }) === "misc", "Conectores deveria estar em Miscelâneos");
    assert(workspaceSectionForCatalogEntry({ typeId: "graphics.rectangle", workspaceSection: "misc" }) === "misc", "Gráfico/Gráfica deveria estar em Miscelâneos");
    assert(workspaceSectionForCatalogEntry({ typeId: "devices.external", workspaceSection: "misc" }) === "misc", "Externos deveria estar em Miscelâneos");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

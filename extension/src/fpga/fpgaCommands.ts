import * as path from "path";
import * as vscode from "vscode";
import { nextIndexedLabel } from "../catalog/catalogMerge";
import { logSimulation } from "../diagnostics/simulationLog";
import { reportVhdlDiagnostics } from "../diagnostics/fpgaDiagnostics";
import { coreInstanceIdByComponentId, state } from "../state";
import { endpointId, endpointPinId, WebviewComponentModel } from "../ui/webview/model";
import { pushComponentToCore, rebuildCoreFromSchematicState } from "../core/coreLifecycle";
import { buildFpgaPins, FpgaPortSpec } from "./fpgaPins";
import { resolveFpgaToolchainConfig } from "./fpgaToolchain";

export interface FpgaCommandOptions {
  syncSchematicPanel: () => void;
  reportCoreWarning: (action: string, err: unknown) => void;
}

const FPGA_TYPE_ID = "digital.generic_fpga";

function nextFpgaId(): string {
  return `component-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function getComponentById(componentId: string): WebviewComponentModel | undefined {
  return state.schematicState.components.find((component) => component.id === componentId);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `ghdlBinary`/`vpiModulePath`/`cacheRootDir` resolvidos frescos (ver `fpgaToolchain.ts`);
 * `vpiModulePath` vazio significa "módulo não construído/encontrado" -- sem ele nenhuma chamada de
 * Analyze/Run pode funcionar (Core precisa dele pra `--vpi=`), então falha aqui ANTES de gastar um
 * round-trip com o Core. */
function requireVpiModulePath(): string | undefined {
  const toolchain = resolveFpgaToolchainConfig();
  if (toolchain.vpiModulePath) return toolchain.vpiModulePath;
  vscode.window.showErrorMessage(
    "Módulo VPI do GHDL não encontrado. No repositório de desenvolvimento, rode 'npm run build:fpga-vpi'; " +
    "numa extensão instalada via VSIX isso indica um empacotamento incompleto."
  );
  return undefined;
}

async function promptForVhdlSources(): Promise<string[] | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    filters: { VHDL: ["vhd", "vhdl"] },
    title: "Selecionar arquivo(s) VHDL",
  });
  if (!picked || picked.length === 0) return undefined;
  return picked.map((uri) => uri.fsPath);
}

async function promptForTopEntity(defaultValue: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: "Entity top-level",
    value: defaultValue,
    prompt: "Nome da entity VHDL top-level a simular",
    validateInput: (input) => (input.trim() ? undefined : "Informe o nome da entity."),
  });
  return value?.trim() || undefined;
}

/** "LasecSimul: Adicionar FPGA Genérico" -- ao contrário de todo outro componente (arrastado da
 * paleta com um pinset FIXO do catálogo), o pinset de um FPGA só é conhecido depois de compilar o
 * VHDL. Por isso este comando resolve sources+top+ANALYZE ANTES de criar qualquer coisa na tela --
 * a instância nasce já com o pacote/pinos certos (`digital.generic_fpga` é `hidden:true` na paleta
 * de propósito, ver `component-catalog.json`; nunca arrastável com um pinset placeholder). */
export async function addGenericFpgaCommand(options: FpgaCommandOptions): Promise<void> {
  const sources = await promptForVhdlSources();
  if (!sources) return;

  const firstSource = sources[0] ?? "";
  const defaultTop = path.basename(firstSource, path.extname(firstSource));
  const topEntity = await promptForTopEntity(defaultTop);
  if (!topEntity) return;

  const vpiModulePath = requireVpiModulePath();
  if (!vpiModulePath) return;
  if (!state.coreClient) {
    vscode.window.showErrorMessage("O Core não está conectado.");
    return;
  }

  const standard = "08";
  const toolchain = { ...resolveFpgaToolchainConfig(), vpiModulePath };

  let ports: FpgaPortSpec[];
  try {
    const result = await state.coreClient.analyzeFpga({ sources, topEntity, standard, ...toolchain });
    ports = result.ports;
    reportVhdlDiagnostics(sources, undefined);
  } catch (err) {
    reportVhdlDiagnostics(sources, errorMessage(err));
    vscode.window.showErrorMessage(`Falha ao analisar VHDL: ${errorMessage(err)}`);
    return;
  }

  if (ports.length === 0) {
    vscode.window.showWarningMessage(`Nenhuma porta encontrada na entity "${topEntity}" -- confira a declaração VHDL.`);
    return;
  }

  const componentId = nextFpgaId();
  const pins = buildFpgaPins(ports);
  const fpgaConfig: WebviewComponentModel["fpga"] = { language: "vhdl", backend: "ghdl", standard, top: topEntity, sources, ports };

  const ok = await pushComponentToCore(componentId, FPGA_TYPE_ID, {}, pins, fpgaConfig);
  if (!ok) return; // Core recusou/falhou -- a tela nunca chega a mostrar um componente que o Core não tem.

  const component: WebviewComponentModel = {
    id: componentId,
    typeId: FPGA_TYPE_ID,
    label: nextIndexedLabel(FPGA_TYPE_ID, "FPGA", state.schematicState.components),
    showValue: false,
    showDialValue: false,
    x: 140 + state.schematicState.components.length * 24,
    y: 140 + state.schematicState.components.length * 24,
    rotation: 0,
    pins,
    properties: {},
    fpga: fpgaConfig,
  };
  state.schematicState = {
    ...state.schematicState,
    components: [...state.schematicState.components, component],
    selectedComponentIds: [componentId],
    selectedWireIds: [],
  };
  options.syncSchematicPanel();
  logSimulation("info", `FPGA "${component.label}" adicionado (${ports.length} porta(s)).`, { device: component.label, stage: "fpga" });
}

/** Recompila+redescobre portas contra o VHDL ATUAL da instância (mesmas `sources`/`top`/`standard`
 * já salvos) -- útil depois de editar o `.vhd` num editor de texto (portas podem ter mudado). Se o
 * pinset mudou, a contagem/nomes de pino no Core mudaram junto (`FpgaComponentConfig::ports` é
 * FIXO após a criação -- ver Core `FpgaComponent.hpp`), então a única forma segura de reconciliar é
 * um rebuild completo do Core a partir do novo estado (`rebuildCoreFromSchematicState`) -- mais
 * pesado que um patch cirúrgico de pinos, mas correto e simples de raciocinar sobre, e "Analyze
 * VHDL" não é um caminho quente (ação deliberada do usuário, não por-frame). Fios que tocavam um
 * pino removido somem (mesmo comportamento de qualquer troca de pinset dinâmico, ver
 * `extension.ts`'s `requestUpdateProperty`/`affectsPinCount`). */
export async function reanalyzeFpgaCommand(componentId: string, options: FpgaCommandOptions): Promise<void> {
  const component = getComponentById(componentId);
  if (!component || !component.fpga) return;
  const vpiModulePath = requireVpiModulePath();
  if (!vpiModulePath || !state.coreClient) return;

  const toolchain = { ...resolveFpgaToolchainConfig(), vpiModulePath };
  let ports: FpgaPortSpec[];
  try {
    const result = await state.coreClient.analyzeFpga({
      sources: component.fpga.sources,
      topEntity: component.fpga.top,
      standard: component.fpga.standard,
      ...toolchain,
    });
    ports = result.ports;
    reportVhdlDiagnostics(component.fpga.sources, undefined);
  } catch (err) {
    reportVhdlDiagnostics(component.fpga.sources, errorMessage(err));
    options.reportCoreWarning(`analisar VHDL de "${component.label}"`, err);
    return;
  }

  if (ports.length === 0) {
    vscode.window.showWarningMessage(`Nenhuma porta encontrada na entity "${component.fpga.top}" -- confira a declaração VHDL.`);
    return;
  }

  const newPins = buildFpgaPins(ports);
  const newPinIds = new Set(newPins.map((pin) => pin.id));
  const pinSetChanged = newPinIds.size !== component.pins.length || component.pins.some((pin) => !newPinIds.has(pin.id));
  const portMetadataChanged = JSON.stringify(component.fpga.ports) !== JSON.stringify(ports);

  const updatedComponent: WebviewComponentModel = {
    ...component,
    pins: newPins,
    fpga: { ...component.fpga, ports },
  };
  const remainingWires = pinSetChanged
    ? state.schematicState.topology.conductors.filter((wire) => {
        const touchesRemovedPin =
          (endpointId(wire.from) === componentId && !newPinIds.has(endpointPinId(wire.from))) ||
          (endpointId(wire.to) === componentId && !newPinIds.has(endpointPinId(wire.to)));
        return !touchesRemovedPin;
      })
    : state.schematicState.topology.conductors;

  state.schematicState = {
    ...state.schematicState,
    components: state.schematicState.components.map((entry) => (entry.id === componentId ? updatedComponent : entry)),
    topology: { ...state.schematicState.topology, conductors: remainingWires },
  };
  options.syncSchematicPanel();
  logSimulation("info", `VHDL de "${component.label}" reanalisado (${ports.length} porta(s)).`, { device: component.label, stage: "fpga" });

  if (pinSetChanged || portMetadataChanged) await rebuildCoreFromSchematicState();
}

function requireTargetCoreId(componentId: string): string | undefined {
  return coreInstanceIdByComponentId.get(componentId);
}

/** Compila (com cache) e inicia o processo GHDL da instância -- erro de compilação vira diagnóstico
 * REAL (arquivo/linha/coluna) via `reportVhdlDiagnostics`, não só um toast. */
export async function runFpgaCommand(componentId: string, options: FpgaCommandOptions): Promise<void> {
  const component = getComponentById(componentId);
  const targetCoreId = requireTargetCoreId(componentId);
  if (!component || !state.coreClient || !targetCoreId) return;
  try {
    await state.coreClient.runFpga(targetCoreId);
    reportVhdlDiagnostics(component.fpga?.sources ?? [], undefined);
    logSimulation("info", `FPGA "${component.label}" iniciado.`, { device: component.label, stage: "fpga" });
  } catch (err) {
    reportVhdlDiagnostics(component.fpga?.sources ?? [], errorMessage(err));
    options.reportCoreWarning(`iniciar FPGA "${component.label}"`, err);
  }
}

/** Prepara todos os FPGAs configurados antes do Run global. Falha de qualquer instância impede o
 * relógio de iniciar, evitando uma simulação aparentemente normal com parte do circuito inerte. */
export async function ensureAllFpgasReady(options: FpgaCommandOptions): Promise<boolean> {
  if (!state.coreClient) return false;
  for (const component of state.schematicState.components) {
    if (component.typeId !== FPGA_TYPE_ID || !component.fpga) continue;
    const targetCoreId = requireTargetCoreId(component.id);
    if (!targetCoreId) {
      options.reportCoreWarning(`iniciar FPGA "${component.label}"`, new Error("instância FPGA ausente no Core"));
      return false;
    }
    try {
      await state.coreClient.runFpga(targetCoreId);
      reportVhdlDiagnostics(component.fpga.sources, undefined);
    } catch (err) {
      reportVhdlDiagnostics(component.fpga.sources, errorMessage(err));
      options.reportCoreWarning(`iniciar FPGA "${component.label}"`, err);
      return false;
    }
  }
  return true;
}

export async function stopFpgaCommand(componentId: string, options: FpgaCommandOptions): Promise<void> {
  const component = getComponentById(componentId);
  const targetCoreId = requireTargetCoreId(componentId);
  if (!component || !state.coreClient || !targetCoreId) return;
  try {
    await state.coreClient.stopFpga(targetCoreId);
    logSimulation("info", `FPGA "${component.label}" parado.`, { device: component.label, stage: "fpga" });
  } catch (err) {
    options.reportCoreWarning(`parar FPGA "${component.label}"`, err);
  }
}

export async function restartFpgaCommand(componentId: string, options: FpgaCommandOptions): Promise<void> {
  const component = getComponentById(componentId);
  const targetCoreId = requireTargetCoreId(componentId);
  if (!component || !state.coreClient || !targetCoreId) return;
  try {
    await state.coreClient.restartFpga(targetCoreId);
    reportVhdlDiagnostics(component.fpga?.sources ?? [], undefined);
    logSimulation("info", `FPGA "${component.label}" reiniciado.`, { device: component.label, stage: "fpga" });
  } catch (err) {
    reportVhdlDiagnostics(component.fpga?.sources ?? [], errorMessage(err));
    options.reportCoreWarning(`reiniciar FPGA "${component.label}"`, err);
  }
}

export async function showFpgaLogsCommand(componentId: string, options: FpgaCommandOptions): Promise<void> {
  const component = getComponentById(componentId);
  const targetCoreId = requireTargetCoreId(componentId);
  if (!component || !state.coreClient || !targetCoreId) return;
  try {
    const logs = await state.coreClient.getFpgaLogs(targetCoreId);
    logSimulation("info", `Log do processo GHDL de "${component.label}":`, {
      device: component.label, stage: "fpga", detail: logs || "(vazio)", reveal: true, notify: false,
    });
  } catch (err) {
    options.reportCoreWarning(`obter log de "${component.label}"`, err);
  }
}

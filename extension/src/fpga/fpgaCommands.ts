import * as path from "path";
import * as vscode from "vscode";
import { nextIndexedLabel } from "../catalog/catalogMerge";
import { logSimulation } from "../diagnostics/simulationLog";
import { reportVhdlDiagnostics } from "../diagnostics/fpgaDiagnostics";
import { coreInstanceIdByComponentId, state } from "../state";
import { endpointId, endpointPinId, WebviewComponentModel } from "../ui/webview/model";
import { pushComponentToCore, rebuildCoreFromSchematicState } from "../core/coreLifecycle";
import { buildFpgaPins, FpgaPortSpec } from "./fpgaPins";
import { ensureGhdlToolchainReady, resolveFpgaToolchainConfig, resolveGhdlBinaryPath } from "./fpgaToolchain";

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
    "O módulo interno de comunicação com o GHDL está ausente. Reinstale ou atualize a extensão LasecSimul."
  );
  return undefined;
}

async function promptForVhdlSources(defaultUri?: vscode.Uri): Promise<string[] | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    filters: { VHDL: ["vhd", "vhdl"] },
    title: "Selecionar arquivo(s) VHDL",
    openLabel: "Usar arquivos selecionados",
    defaultUri,
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

/** Cria o bloco programável imediatamente, ainda sem fonte e sem terminais. O vínculo com VHDL é
 * uma segunda ação deliberada (`configureFpgaCommand`), que só então analisa a entity e materializa
 * seus pinos. */
export async function addGenericFpgaCommand(options: FpgaCommandOptions): Promise<void> {
  if (!state.coreClient) {
    vscode.window.showErrorMessage("O Core não está conectado.");
    return;
  }

  const componentId = nextFpgaId();
  const pins: WebviewComponentModel["pins"] = [];
  const ok = await pushComponentToCore(componentId, FPGA_TYPE_ID, {}, pins);
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
  };
  state.schematicState = {
    ...state.schematicState,
    components: [...state.schematicState.components, component],
    selectedComponentIds: [componentId],
    selectedWireIds: [],
  };
  options.syncSchematicPanel();
  logSimulation("info", `Bloco programável "${component.label}" adicionado sem terminais.`, { device: component.label, stage: "fpga" });
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
type EditableFpgaConfiguration = { sources: string[]; top: string; standard: string };

export async function reanalyzeFpgaCommand(
  componentId: string,
  options: FpgaCommandOptions,
  configuration?: EditableFpgaConfiguration
): Promise<void> {
  const component = getComponentById(componentId);
  if (!component || component.typeId !== FPGA_TYPE_ID) return;
  const currentConfig = component.fpga;
  const fpgaConfig: NonNullable<WebviewComponentModel["fpga"]> | undefined = configuration
    ? {
        language: "vhdl",
        backend: "ghdl",
        ports: currentConfig?.ports ?? [],
        standard: configuration.standard,
        top: configuration.top,
        sources: configuration.sources,
      }
    : currentConfig;
  if (!fpgaConfig) {
    void vscode.window.showInformationMessage("Carregue um código VHDL antes de analisar o bloco programável.");
    return;
  }
  if (!(await ensureGhdlToolchainReady())) return;
  const vpiModulePath = requireVpiModulePath();
  if (!vpiModulePath || !state.coreClient) return;

  const toolchain = { ...resolveFpgaToolchainConfig(), vpiModulePath };
  let ports: FpgaPortSpec[];
  try {
    const result = await state.coreClient.analyzeFpga({
      sources: fpgaConfig.sources,
      topEntity: fpgaConfig.top,
      standard: fpgaConfig.standard,
      ...toolchain,
    });
    ports = result.ports;
    reportVhdlDiagnostics(fpgaConfig.sources, undefined);
  } catch (err) {
    reportVhdlDiagnostics(fpgaConfig.sources, errorMessage(err));
    options.reportCoreWarning(`analisar VHDL de "${component.label}"`, err);
    return;
  }

  const newPins = buildFpgaPins(ports);
  const newPinIds = new Set(newPins.map((pin) => pin.id));
  const pinSetChanged = newPinIds.size !== component.pins.length || component.pins.some((pin) => !newPinIds.has(pin.id));
  const portMetadataChanged = JSON.stringify(currentConfig?.ports ?? []) !== JSON.stringify(ports);
  const configurationChanged =
    currentConfig?.top !== fpgaConfig.top ||
    currentConfig?.standard !== fpgaConfig.standard ||
    JSON.stringify(currentConfig?.sources ?? []) !== JSON.stringify(fpgaConfig.sources);

  const updatedComponent: WebviewComponentModel = {
    ...component,
    pins: newPins,
    fpga: { ...fpgaConfig, ports },
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

  if (pinSetChanged || portMetadataChanged || configurationChanged) await rebuildCoreFromSchematicState();
}

/** Abre o VHDL no editor de texto normal do VS Code; com várias fontes, mostra uma janela de
 * seleção pelos nomes em vez de exigir que o usuário procure arquivos no Explorer. */
export async function openFpgaSourceCommand(componentId: string): Promise<void> {
  const component = getComponentById(componentId);
  const sources = component?.fpga?.sources ?? [];
  if (sources.length === 0) return;
  let selected = sources[0];
  if (sources.length > 1) {
    const picked = await vscode.window.showQuickPick(
      sources.map((source) => ({ label: path.basename(source), description: source, source })),
      { title: `Abrir fonte VHDL de ${component?.label ?? "FPGA"}`, placeHolder: "Selecione o arquivo para editar" }
    );
    selected = picked?.source;
  }
  if (!selected) return;
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selected));
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    void vscode.window.showErrorMessage(`Não foi possível abrir o VHDL: ${errorMessage(error)}`);
  }
}

/** Wizard visual para trocar arquivos/entity/standard sem editar JSON nem usar Command Palette. */
export async function configureFpgaCommand(componentId: string, options: FpgaCommandOptions): Promise<void> {
  const component = getComponentById(componentId);
  if (!component || component.typeId !== FPGA_TYPE_ID) return;
  const firstSource = component.fpga?.sources[0];
  const sources = await promptForVhdlSources(firstSource ? vscode.Uri.file(path.dirname(firstSource)) : undefined);
  if (!sources) return;
  const selectedFirstSource = sources[0] ?? "";
  const defaultTop = component.fpga?.top || path.basename(selectedFirstSource, path.extname(selectedFirstSource));
  const top = await promptForTopEntity(defaultTop);
  if (!top) return;
  const standard = await vscode.window.showQuickPick(
    [
      { label: "VHDL 2008", value: "08" },
      { label: "VHDL 1993", value: "93" },
      { label: "VHDL 1987", value: "87" },
    ],
    { title: "Versão da linguagem VHDL", placeHolder: `Atual: VHDL ${component.fpga?.standard ?? "08"}` }
  );
  if (!standard) return;
  await reanalyzeFpgaCommand(componentId, options, { sources, top, standard: standard.value });
}

function requireTargetCoreId(componentId: string): string | undefined {
  return coreInstanceIdByComponentId.get(componentId);
}

/** Compila (com cache) e inicia o processo GHDL da instância -- erro de compilação vira diagnóstico
 * REAL (arquivo/linha/coluna) via `reportVhdlDiagnostics`, não só um toast. */
export async function runFpgaCommand(componentId: string, options: FpgaCommandOptions): Promise<void> {
  const component = getComponentById(componentId);
  if (!component?.fpga) {
    void vscode.window.showInformationMessage("Carregue e analise um código VHDL antes de executar o bloco programável.");
    return;
  }
  const before = resolveGhdlBinaryPath();
  const ready = await ensureGhdlToolchainReady();
  if (!ready) return;
  if (ready !== before) await rebuildCoreFromSchematicState();
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
  const configuredFpgas = state.schematicState.components.filter((component) => component.typeId === FPGA_TYPE_ID && component.fpga);
  if (configuredFpgas.length === 0) return true;
  const before = resolveGhdlBinaryPath();
  const ready = await ensureGhdlToolchainReady();
  if (!ready) return false;
  if (ready !== before) await rebuildCoreFromSchematicState();
  for (const component of configuredFpgas) {
    const fpga = component.fpga;
    if (!fpga) continue;
    const targetCoreId = requireTargetCoreId(component.id);
    if (!targetCoreId) {
      options.reportCoreWarning(`iniciar FPGA "${component.label}"`, new Error("instância FPGA ausente no Core"));
      return false;
    }
    try {
      await state.coreClient.runFpga(targetCoreId);
      reportVhdlDiagnostics(fpga.sources, undefined);
    } catch (err) {
      reportVhdlDiagnostics(fpga.sources, errorMessage(err));
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

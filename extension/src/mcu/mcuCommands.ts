import * as fs from "fs";
import * as vscode from "vscode";
import { fileExists, readJsonFile } from "../pathUtils";
import {
  coreInstanceIdByComponentId,
  lastLoadedFirmwareByCoreId,
  mcuSerialMonitorByKey,
  mcuTargetCoreIdByComponentId,
  state,
} from "../state";
import { InternalComponentSnapshot } from "../ui/webview/messages";
import { WebviewComponentModel } from "../ui/webview/model";

export interface McuCommandOptions {
  syncSchematicPanel: () => void;
  reportCoreWarning: (action: string, err: unknown) => void;
  gatherInternalComponentSnapshots: (sourceId: string) => InternalComponentSnapshot[] | undefined;
  resolveSourceFilePath: (sourceId: string) => string | undefined;
  refreshUnifiedCatalogState: (loadLibrariesInCore: boolean) => Promise<void>;
}

function getComponentById(componentId: string): WebviewComponentModel | undefined {
  return state.schematicState.components.find((component) => component.id === componentId);
}

export function resolveMcuTargetCoreId(componentId: string): string | undefined {
  return mcuTargetCoreIdByComponentId.get(componentId) ?? coreInstanceIdByComponentId.get(componentId);
}

function resolveSourceIdForComponent(componentId: string): string | undefined {
  const component = getComponentById(componentId);
  if (!component) return undefined;
  return state.schematicState.catalog.find((entry) => entry.typeId === component.typeId)?.registeredSourceId;
}

function resolveSubcircuitChildCoreId(outerComponentId: string, innerComponentId: string): Promise<string | undefined> {
  const outerCoreId = coreInstanceIdByComponentId.get(outerComponentId);
  if (!state.coreClient || !outerCoreId) return Promise.resolve(undefined);
  return state.coreClient.getSubcircuitChildInstanceId(outerCoreId, innerComponentId).catch(() => undefined);
}

/** Atualiza `lastLoadedFirmwareByCoreId` (ver `state.ts`) depois de um push BEM-SUCEDIDO de
 * `loadMcuFirmware` -- chamado tanto por "Carregar firmware" (push imediato, só quando a simulação já
 * está rodando) quanto por `ensureAllMcuFirmwareUpToDate` (antes de "Run"). Sem isto no caminho de
 * "Carregar firmware", trocar o `.bin` enquanto já rodando e depois Parar/Rodar de novo recarregaria
 * o MESMO arquivo à toa no próximo Run (a marca nunca teria sido registrada) -- inofensivo (mesmo
 * arquivo, sem efeito elétrico diferente), mas um refresh desnecessário que o pedido explicitamente
 * quer evitar. Falha silenciosa em `fs.statSync` (arquivo sumiu entre o push e aqui, janela minúscula)
 * -- não vale abortar um push que já teve sucesso por causa disso; o próximo Run só vai re-verificar.
 */
function recordFirmwareLoaded(coreId: string, firmwarePath: string): void {
  try {
    const stat = fs.statSync(firmwarePath);
    lastLoadedFirmwareByCoreId.set(coreId, { path: firmwarePath, mtimeMs: stat.mtimeMs, size: stat.size });
  } catch {
    lastLoadedFirmwareByCoreId.delete(coreId);
  }
}

export function closeMcuSerialMonitor(componentId: string, usartIndex?: number): void {
  for (const [key, monitor] of mcuSerialMonitorByKey) {
    const parts = key.split(":");
    const currentComponentId = parts[0];
    const currentUsartIndex = parts[parts.length - 1];
    if (currentComponentId !== componentId) continue;
    if (usartIndex !== undefined && Number(currentUsartIndex) !== usartIndex) continue;
    clearInterval(monitor.timer);
    monitor.channel.dispose();
    mcuSerialMonitorByKey.delete(key);
  }
}

export function closeAllMcuSerialMonitors(): void {
  for (const [key, monitor] of mcuSerialMonitorByKey) {
    clearInterval(monitor.timer);
    monitor.channel.dispose();
    mcuSerialMonitorByKey.delete(key);
  }
}

export function updateBoardOverlayPropertyCommand(
  outerComponentId: string,
  innerComponentId: string,
  name: string,
  value: string | number | boolean,
  options: McuCommandOptions
): void {
  if (!state.coreClient) return;
  const coreId = coreInstanceIdByComponentId.get(outerComponentId);
  if (!coreId) return;
  state.coreClient
    .setSubcircuitChildProperty(coreId, innerComponentId, name, value)
    .catch((err) => options.reportCoreWarning(`atualizar "${innerComponentId}.${name}" (Modo Placa)`, err));
}

export async function chooseMcuFirmwareCommand(componentId: string, options: McuCommandOptions): Promise<void> {
  const component = getComponentById(componentId);
  if (!component) return;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { Firmware: ["bin", "elf", "hex"] },
    title: `Selecionar firmware para ${component.label}`,
  });
  const selected = picked?.[0];
  if (!selected) return;

  const firmwarePath = selected.fsPath;
  const qemuBinaryOverride = typeof component.properties.qemuBinaryOverride === "string" ? component.properties.qemuBinaryOverride : "";
  state.schematicState = {
    ...state.schematicState,
    components: state.schematicState.components.map((entry) =>
      entry.id === componentId
        ? { ...entry, properties: { ...entry.properties, firmwarePath } }
        : entry
    ),
  };
  options.syncSchematicPanel();

  if (state.simulationStatus === "running") {
    const targetCoreId = resolveMcuTargetCoreId(componentId);
    if (state.coreClient && targetCoreId) {
      try {
        await state.coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride || undefined);
        recordFirmwareLoaded(targetCoreId, firmwarePath);
      } catch (err) {
        options.reportCoreWarning(`carregar firmware de "${component.label}"`, err);
      }
    }
  }
}

export async function chooseExposedMcuFirmwareCommand(
  outerComponentId: string,
  innerComponentId: string,
  options: McuCommandOptions
): Promise<void> {
  const sourceId = resolveSourceIdForComponent(outerComponentId);
  const inner = sourceId ? options.gatherInternalComponentSnapshots(sourceId)?.find((entry) => entry.id === innerComponentId) : undefined;
  const label = inner?.label ?? innerComponentId;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { Firmware: ["bin", "elf", "hex"] },
    title: `Selecionar firmware para ${label}`,
  });
  const selected = picked?.[0];
  if (!selected || !sourceId) return;

  const firmwarePath = selected.fsPath;
  const qemuBinaryOverride = typeof inner?.properties.qemuBinaryOverride === "string" ? inner.properties.qemuBinaryOverride : "";
  await updateExposedComponentPropertyCommand(outerComponentId, sourceId, innerComponentId, "firmwarePath", firmwarePath, options);

  if (state.simulationStatus === "running") {
    const targetCoreId = await resolveSubcircuitChildCoreId(outerComponentId, innerComponentId);
    if (state.coreClient && targetCoreId) {
      try {
        await state.coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride || undefined);
        recordFirmwareLoaded(targetCoreId, firmwarePath);
      } catch (err) {
        options.reportCoreWarning(`carregar firmware de "${label}"`, err);
      }
    }
  }
}

interface McuFirmwareTarget {
  label: string;
  firmwarePath: string;
  qemuBinaryOverride: string | undefined;
  resolveCoreId: () => Promise<string | undefined>;
}

function isMcuHostTypeId(typeId: string): boolean {
  return state.schematicState.catalog.find((entry) => entry.typeId === typeId)?.mcuHost === true;
}

/** Um alvo por MCU/CPU emulado no esquemático atual -- direto (`mcu-adapter` solto no circuito
 * principal) OU exposto dentro de uma instância de subcircuito (`registeredSourceKind ===
 * "subcircuit-file"`, ex: ESP32 dentro do DevKitC). Usado por `ensureAllMcuFirmwareUpToDate` (chamado
 * antes de "Run", ver `extension.ts::runSimulationWithFirmwareCheck`) -- substitui os antigos
 * comandos manuais "Recarregar firmware" (removidos do menu 2026-07-09): o recarregamento agora é
 * sempre automático, nunca uma ação que o usuário precisa lembrar de clicar. */
function collectMcuFirmwareTargets(options: McuCommandOptions): McuFirmwareTarget[] {
  const targets: McuFirmwareTarget[] = [];
  for (const component of state.schematicState.components) {
    const catalogEntry = state.schematicState.catalog.find((entry) => entry.typeId === component.typeId);
    if (catalogEntry?.registeredSourceKind === "subcircuit-file") {
      // Subcircuito que HOSPEDA um MCU interno (ex: ESP32 DevKitC) -- o firmware mora nas
      // `properties` do componente INTERNO exposto, nunca na instância de fora.
      const sourceId = catalogEntry.registeredSourceId;
      const innerComponents = sourceId ? options.gatherInternalComponentSnapshots(sourceId) : undefined;
      if (!innerComponents) continue;
      for (const inner of innerComponents) {
        if (!isMcuHostTypeId(inner.typeId)) continue;
        const firmwarePath = typeof inner.properties.firmwarePath === "string" ? inner.properties.firmwarePath.trim() : "";
        if (!firmwarePath) continue;
        const qemuBinaryOverride = typeof inner.properties.qemuBinaryOverride === "string" ? inner.properties.qemuBinaryOverride.trim() : "";
        targets.push({
          label: inner.label,
          firmwarePath,
          qemuBinaryOverride: qemuBinaryOverride || undefined,
          resolveCoreId: () => resolveSubcircuitChildCoreId(component.id, inner.id),
        });
      }
      continue;
    }
    if (!isMcuHostTypeId(component.typeId)) continue;
    const firmwarePath = typeof component.properties.firmwarePath === "string" ? component.properties.firmwarePath.trim() : "";
    if (!firmwarePath) continue;
    const qemuBinaryOverride = typeof component.properties.qemuBinaryOverride === "string" ? component.properties.qemuBinaryOverride.trim() : "";
    targets.push({
      label: component.label,
      firmwarePath,
      qemuBinaryOverride: qemuBinaryOverride || undefined,
      resolveCoreId: () => Promise.resolve(resolveMcuTargetCoreId(component.id)),
    });
  }
  return targets;
}

/** Roda ANTES de "Run" (`extension.ts::runSimulationWithFirmwareCheck`) -- pra cada MCU/CPU com
 * firmware configurado (direto ou exposto dentro de um subcircuito), confirma que o arquivo ainda
 * existe, compara `mtime`+tamanho contra o que foi efetivamente empurrado da ÚLTIMA vez pra ESSA
 * instância do Core (`lastLoadedFirmwareByCoreId`, ver `state.ts`) e só chama `loadMcuFirmware` de
 * novo quando algo mudou -- nunca a cada Run incondicionalmente (evitaria reiniciar o processo QEMU
 * sem necessidade, mais lento e reseta o estado do firmware à toa). MCU ainda sem instância no Core
 * (`resolveCoreId` undefined -- circuito nunca foi construído, ou subcircuito ainda não expandiu) é
 * silenciosamente ignorado aqui: nada pra recarregar ainda, `rebuildCoreFromSchematicState` não
 * carrega firmware sozinho (`firmwarePath`/`qemuBinaryOverride` são propriedades "UI-only", ver
 * `coreLifecycle.ts::isUiOnlyRuntimeProperty`) -- por isso mesmo TODA instância nova precisa passar
 * por aqui pelo menos uma vez, o que já acontece automaticamente (nunca está em
 * `lastLoadedFirmwareByCoreId` ainda). Devolve o motivo de falha em vez de lançar -- o chamador decide
 * se aborta o Run, sem depender de `try/catch` espalhado. */
export async function ensureAllMcuFirmwareUpToDate(options: McuCommandOptions): Promise<{ ok: true } | { ok: false; message: string }> {
  for (const target of collectMcuFirmwareTargets(options)) {
    if (!fileExists(target.firmwarePath)) {
      return { ok: false, message: `Firmware de "${target.label}" não encontrado: ${target.firmwarePath}` };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target.firmwarePath);
    } catch (err) {
      return { ok: false, message: `Não foi possível acessar o firmware de "${target.label}": ${err instanceof Error ? err.message : String(err)}` };
    }
    const targetCoreId = await target.resolveCoreId();
    if (!state.coreClient || !targetCoreId) continue;
    const previous = lastLoadedFirmwareByCoreId.get(targetCoreId);
    if (previous && previous.path === target.firmwarePath && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) continue;
    try {
      await state.coreClient.loadMcuFirmware(targetCoreId, target.firmwarePath, target.qemuBinaryOverride);
      lastLoadedFirmwareByCoreId.set(targetCoreId, { path: target.firmwarePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (err) {
      return { ok: false, message: `Falha ao recarregar firmware de "${target.label}": ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: true };
}

function serialPortLabelForTypeId(typeId: string | undefined, usartIndex: 0 | 1 | 2): string | undefined {
  if (!typeId) return undefined;
  const entry = state.schematicState.catalog.find((item) => item.typeId === typeId);
  return entry?.serialPorts?.find((port) => port.usartIndex === usartIndex)?.label;
}

/** Corpo compartilhado de `openMcuSerialMonitorCommand`/`openExposedMcuSerialMonitorCommand` --
 * diferiam só em como `key`/`label`/`targetCoreId` eram resolvidos, com o resto (canal de saída,
 * polling de log a cada 500ms, cálculo de delta) idêntico e duplicado (achado de auditoria
 * 2026-07-08). `state.coreClient` já verificado não-nulo pelos dois chamadores antes de entrar aqui. */
function openSerialMonitor(key: string, label: string, serialPortLabel: string, targetCoreId: string): void {
  const existing = mcuSerialMonitorByKey.get(key);
  if (existing) {
    existing.channel.show(true);
    return;
  }

  const channel = vscode.window.createOutputChannel(`LasecSimul ${serialPortLabel} - ${label}`);
  channel.appendLine(`[${new Date().toLocaleString()}] Monitor serial aberto para ${label} (${serialPortLabel}).`);
  channel.appendLine("Observacao: por enquanto o monitor espelha os logs/saida do QEMU expostos pelo Core.");

  const pollLogs = async (): Promise<void> => {
    try {
      const logs = await state.coreClient!.getMcuLogs(targetCoreId);
      const monitor = mcuSerialMonitorByKey.get(key);
      if (!monitor) return;
      const delta = logs.slice(monitor.lastLength);
      if (delta) {
        channel.append(delta);
        monitor.lastLength = logs.length;
      } else if (logs.length < monitor.lastLength) {
        channel.appendLine(`\n[${new Date().toLocaleTimeString()}] logs reiniciados`);
        if (logs) channel.append(logs);
        monitor.lastLength = logs.length;
      }
    } catch (err) {
      channel.appendLine(`\n[erro] ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const timer = setInterval(() => void pollLogs(), 500);
  mcuSerialMonitorByKey.set(key, { channel, timer, lastLength: 0 });
  channel.show(true);
  void pollLogs();
}

export function openMcuSerialMonitorCommand(componentId: string, usartIndex: 0 | 1 | 2): void {
  const targetCoreId = resolveMcuTargetCoreId(componentId);
  const component = getComponentById(componentId);
  const serialPortLabel = serialPortLabelForTypeId(component?.typeId, usartIndex);
  if (!state.coreClient || !targetCoreId || !component || !serialPortLabel) {
    vscode.window.showWarningMessage("Monitor serial indisponivel para este componente.");
    return;
  }
  openSerialMonitor(`${componentId}:${usartIndex}`, component.label, serialPortLabel, targetCoreId);
}

export async function openExposedMcuSerialMonitorCommand(
  outerComponentId: string,
  innerComponentId: string,
  usartIndex: 0 | 1 | 2,
  options: McuCommandOptions
): Promise<void> {
  const sourceId = resolveSourceIdForComponent(outerComponentId);
  const inner = sourceId ? options.gatherInternalComponentSnapshots(sourceId)?.find((entry) => entry.id === innerComponentId) : undefined;
  const label = inner?.label ?? innerComponentId;
  const serialPortLabel = serialPortLabelForTypeId(inner?.typeId, usartIndex);
  const targetCoreId = await resolveSubcircuitChildCoreId(outerComponentId, innerComponentId);
  if (!state.coreClient || !targetCoreId || !serialPortLabel) {
    vscode.window.showWarningMessage("Monitor serial indisponivel para este componente.");
    return;
  }
  openSerialMonitor(`${outerComponentId}:${innerComponentId}:${usartIndex}`, label, serialPortLabel, targetCoreId);
}

export async function requestBoardOverlayDataCommand(
  componentId: string,
  sourceId: string,
  options: McuCommandOptions
): Promise<void> {
  if (!state.schematicPanel) return;
  const items = options.gatherInternalComponentSnapshots(sourceId);
  if (!items) return;
  state.schematicPanel.postMessage({ version: 1, type: "boardOverlayData", componentId, items });
}

export async function updateExposedComponentPropertyCommand(
  outerComponentId: string,
  sourceId: string | undefined,
  innerComponentId: string,
  name: string,
  value: string | number | boolean,
  options: McuCommandOptions
): Promise<void> {
  if (!state.extensionContext || !sourceId) return;
  const absoluteFilePath = options.resolveSourceFilePath(sourceId);
  if (!absoluteFilePath || !fileExists(absoluteFilePath)) return;

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (Array.isArray(json.components)) {
    json.components = json.components.map((entry) => {
      if (typeof entry !== "object" || entry === null) return entry;
      const component = entry as Record<string, unknown>;
      if (component.id !== innerComponentId) return component;
      const properties = typeof component.properties === "object" && component.properties !== null
        ? (component.properties as Record<string, unknown>)
        : {};
      return { ...component, properties: { ...properties, [name]: value } };
    });
  }

  try {
    fs.writeFileSync(absoluteFilePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  updateBoardOverlayPropertyCommand(outerComponentId, innerComponentId, name, value, options);
  await requestBoardOverlayDataCommand(outerComponentId, sourceId, options);
}

export async function updateBoardOverlayVisualCommand(
  sourceId: string,
  innerComponentId: string,
  x: number,
  y: number,
  options: McuCommandOptions
): Promise<void> {
  if (!state.extensionContext) return;
  const absoluteFilePath = options.resolveSourceFilePath(sourceId);
  if (!absoluteFilePath || !fileExists(absoluteFilePath)) return;

  let json: Record<string, unknown>;
  try {
    json = readJsonFile(absoluteFilePath) as Record<string, unknown>;
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível ler ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Escreve nos MESMOS campos planos que `subcircuitBoardMode.ts::captureBoardTransforms` grava ao
  // sair do Modo Placa dentro da edição do subcircuito (`boardX`/`boardY`/`boardRotation`/
  // `boardFlipH`/`boardFlipV`, mesmo shape de `WebviewComponentModel`) -- nunca um campo `boardVisual`
  // aninhado à parte, que ficava permanentemente dessincronizado da posição real (bug corrigido,
  // ver `subcircuitInternals.ts::boardVisualFromFlatFields`). Preserva rotação/espelhamento já
  // salvos (idem ao comportamento anterior via `previousBoardVisual`), só x/y mudam aqui -- este
  // comando só cobre arrasto no overlay do circuito principal, nunca rotação/espelhamento.
  if (Array.isArray(json.components)) {
    json.components = json.components.map((value) => {
      if (typeof value !== "object" || value === null) return value;
      const component = value as Record<string, unknown>;
      if (component.id !== innerComponentId) return component;
      return { ...component, boardX: x, boardY: y };
    });
  }

  try {
    fs.writeFileSync(absoluteFilePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await options.refreshUnifiedCatalogState(true);
}

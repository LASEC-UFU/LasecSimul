import * as fs from "fs";
import * as path from "path";
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
import { logSimulation, reportFirmwareDiagnostic } from "../diagnostics/simulationLog";

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

/** Caminho DEFAULT do QEMU vendorizado (`devices/qemu-esp32/bin/`), calculado a partir de onde a
 * Extension foi carregada -- mesmo princípio de `extension.ts::resolveCoreExecutablePath` (2 layouts
 * possíveis: repo de desenvolvimento, `extensionPath/../devices/...`; pacote instalado via VSIX,
 * `extensionPath/bundled/devices/...`, ver `scripts/package-release.js::stageBundledAssets`). Sem
 * isto, `qemuBinaryOverride` ficava SEMPRE vazio a menos que o usuário colasse o caminho manualmente
 * por componente MCU -- bug real: o binário vinha corretamente empacotado (depois do fix de
 * `.gitignore`), mas o Core nunca sabia onde achá-lo, então caía no nome nu `"qemu-system-xtensa"`
 * (só resolve via PATH do SO, que nunca aponta pra dentro da pasta da extensão). Só binário Windows
 * é vendorizado hoje -- em outra plataforma isto sempre devolve `undefined` (sem candidato existe),
 * caindo pro comportamento de sempre (nome nu, depende do QEMU do sistema estar no PATH). Calculado
 * uma vez e cacheado -- `extensionPath` não muda durante a sessão da Extension. */
let cachedDefaultQemuBinaryPath: string | undefined | null = null;

function resolveDefaultQemuBinaryPath(): string | undefined {
  if (cachedDefaultQemuBinaryPath !== null) return cachedDefaultQemuBinaryPath;
  const extensionPath = state.extensionContext?.extensionPath;
  if (!extensionPath) return undefined;

  const binaryName = process.platform === "win32" ? "qemu-system-xtensa.exe" : "qemu-system-xtensa";
  const candidates = [
    path.join(extensionPath, "..", "devices", "qemu-esp32", "bin", binaryName),
    path.join(extensionPath, "bundled", "devices", "qemu-esp32", "bin", binaryName),
  ];
  cachedDefaultQemuBinaryPath = candidates.find((candidate) => fileExists(candidate));
  return cachedDefaultQemuBinaryPath;
}

/** Lê `qemuBinaryOverride` das `properties` de um componente MCU -- valor digitado manualmente pelo
 * usuário sempre ganha; vazio cai pro binário vendorizado default (`resolveDefaultQemuBinaryPath`)
 * em vez de ficar `undefined` (nome nu, dependente do PATH do SO). Centraliza a mesma leitura antes
 * duplicada em 4 lugares (`chooseMcuFirmwareCommand`, `chooseExposedMcuFirmwareCommand`,
 * `collectMcuFirmwareTargets` x2). */
function resolveQemuBinaryOverride(properties: Record<string, unknown>): string | undefined {
  const configured = typeof properties.qemuBinaryOverride === "string" ? properties.qemuBinaryOverride.trim() : "";
  return configured || resolveDefaultQemuBinaryPath();
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
  const qemuBinaryOverride = resolveQemuBinaryOverride(component.properties);
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
        await state.coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride);
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
  const qemuBinaryOverride = inner ? resolveQemuBinaryOverride(inner.properties) : resolveDefaultQemuBinaryPath();
  await updateExposedComponentPropertyCommand(outerComponentId, sourceId, innerComponentId, "firmwarePath", firmwarePath, options);

  if (state.simulationStatus === "running") {
    const targetCoreId = await resolveSubcircuitChildCoreId(outerComponentId, innerComponentId);
    if (state.coreClient && targetCoreId) {
      try {
        await state.coreClient.loadMcuFirmware(targetCoreId, firmwarePath, qemuBinaryOverride);
        recordFirmwareLoaded(targetCoreId, firmwarePath);
      } catch (err) {
        options.reportCoreWarning(`carregar firmware de "${label}"`, err);
      }
    }
  }
}

export interface McuFirmwareTarget {
  label: string;
  firmwarePath: string;
  qemuBinaryOverride: string | undefined;
  resolveCoreId: () => Promise<string | undefined>;
}

function isMcuHostTypeId(typeId: string): boolean {
  return state.schematicState.catalog.find((entry) => entry.typeId === typeId)?.mcuHost === true;
}

/** Um item por MCU/CPU emulado no esquemático atual -- direto (`mcu-adapter` solto no circuito
 * principal) OU exposto dentro de uma instância de subcircuito (`registeredSourceKind ===
 * "subcircuit-file"`, ex: ESP32 dentro do DevKitC) -- INCLUI hosts ainda sem `firmwarePath`
 * configurado (`firmwarePath: ""`), ao contrário de `collectMcuFirmwareTargets` (que filtra esses
 * fora). Traversal única compartilhada entre `collectMcuFirmwareTargets` e a checagem de "MCU sem
 * firmware" de `ensureAllMcuFirmwareUpToDate` -- percorrer os dois ramos (direto vs. exposto em
 * subcircuito) separadamente duplicaria a lógica e divergiria com o tempo. */
function collectMcuHostEntries(options: McuCommandOptions): McuFirmwareTarget[] {
  const entries: McuFirmwareTarget[] = [];
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
        entries.push({
          label: inner.label,
          firmwarePath: typeof inner.properties.firmwarePath === "string" ? inner.properties.firmwarePath.trim() : "",
          qemuBinaryOverride: resolveQemuBinaryOverride(inner.properties),
          resolveCoreId: () => resolveSubcircuitChildCoreId(component.id, inner.id),
        });
      }
      continue;
    }
    if (!isMcuHostTypeId(component.typeId)) continue;
    entries.push({
      label: component.label,
      firmwarePath: typeof component.properties.firmwarePath === "string" ? component.properties.firmwarePath.trim() : "",
      qemuBinaryOverride: resolveQemuBinaryOverride(component.properties),
      resolveCoreId: () => Promise.resolve(resolveMcuTargetCoreId(component.id)),
    });
  }
  return entries;
}

/** Um alvo por MCU/CPU emulado no esquemático atual COM firmware configurado -- usado por
 * `ensureAllMcuFirmwareUpToDate` (chamado antes de "Run", ver `extension.ts::
 * runSimulationWithFirmwareCheck`) e pelo comando de depuração GDB (`mcuDebug.ts`). Substitui os
 * antigos comandos manuais "Recarregar firmware" (removidos do menu 2026-07-09): o recarregamento
 * agora é sempre automático, nunca uma ação que o usuário precisa lembrar de clicar. */
export function collectMcuFirmwareTargets(options: McuCommandOptions): McuFirmwareTarget[] {
  return collectMcuHostEntries(options).filter((entry) => entry.firmwarePath.length > 0);
}

const FIRMWARE_DIAGNOSTIC_KEY = "firmware";

/** Roda ANTES de "Run" (`extension.ts::runSimulationWithFirmwareCheck`) -- BLOQUEIA a simulação (nunca
 * deixa rodar "no escuro") em dois casos: (1) algum MCU/CPU emulado no esquemático não tem
 * `firmwarePath` configurado -- achado real: sem isto, `collectMcuFirmwareTargets` (que só enxerga
 * hosts COM firmware) simplesmente ignorava o MCU inteiro, e "Run" seguia em frente com o MCU
 * parado/sem responder, SEM NENHUM feedback de por quê; (2) pra cada MCU COM firmware configurado,
 * confirma que o arquivo ainda existe, compara `mtime`+tamanho contra o que foi efetivamente empurrado
 * da ÚLTIMA vez pra ESSA instância do Core (`lastLoadedFirmwareByCoreId`, ver `state.ts`) e só chama
 * `loadMcuFirmware` de novo quando algo mudou -- nunca a cada Run incondicionalmente (evitaria
 * reiniciar o processo QEMU sem necessidade, mais lento e reseta o estado do firmware à toa). MCU
 * ainda sem instância no Core (`resolveCoreId` undefined -- circuito nunca foi construído, ou
 * subcircuito ainda não expandiu) é silenciosamente ignorado aqui: nada pra recarregar ainda,
 * `rebuildCoreFromSchematicState` não carrega firmware sozinho (`firmwarePath`/`qemuBinaryOverride`
 * são propriedades "UI-only", ver `coreLifecycle.ts::isUiOnlyRuntimeProperty`) -- por isso mesmo TODA
 * instância nova precisa passar por aqui pelo menos uma vez, o que já acontece automaticamente (nunca
 * está em `lastLoadedFirmwareByCoreId` ainda). Toda falha já é logada (canal de saída + painel de
 * Problemas + status bar, ver `diagnostics/simulationLog.ts`) ANTES de devolver -- o chamador só
 * decide se aborta o Run, sem precisar formatar mensagem nenhuma de novo. */
export async function ensureAllMcuFirmwareUpToDate(options: McuCommandOptions): Promise<{ ok: true } | { ok: false; message: string }> {
  const entries = collectMcuHostEntries(options);
  const missingFirmware = entries.filter((entry) => entry.firmwarePath.length === 0);
  if (missingFirmware.length > 0) {
    const labels = missingFirmware.map((entry) => entry.label).join(", ");
    const message = `Nenhum firmware selecionado para: ${labels}. Configure o firmware antes de rodar a simulação.`;
    logSimulation("error", message, { stage: "firmware" });
    reportFirmwareDiagnostic(state.currentProjectFilePath, FIRMWARE_DIAGNOSTIC_KEY, message);
    return { ok: false, message };
  }

  for (const target of entries) {
    if (!fileExists(target.firmwarePath)) {
      const message = `Firmware não encontrado: ${target.firmwarePath}`;
      logSimulation("error", message, { device: target.label, stage: "firmware" });
      reportFirmwareDiagnostic(state.currentProjectFilePath, FIRMWARE_DIAGNOSTIC_KEY, `${target.label}: ${message}`);
      return { ok: false, message: `Firmware de "${target.label}" não encontrado: ${target.firmwarePath}` };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target.firmwarePath);
    } catch (err) {
      const message = `Não foi possível acessar o firmware: ${err instanceof Error ? err.message : String(err)}`;
      logSimulation("error", message, { device: target.label, stage: "firmware" });
      reportFirmwareDiagnostic(state.currentProjectFilePath, FIRMWARE_DIAGNOSTIC_KEY, `${target.label}: ${message}`);
      return { ok: false, message: `Não foi possível acessar o firmware de "${target.label}": ${err instanceof Error ? err.message : String(err)}` };
    }
    const targetCoreId = await target.resolveCoreId();
    if (!state.coreClient || !targetCoreId) continue;
    const previous = lastLoadedFirmwareByCoreId.get(targetCoreId);
    if (previous && previous.path === target.firmwarePath && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) continue;
    try {
      await state.coreClient.loadMcuFirmware(targetCoreId, target.firmwarePath, target.qemuBinaryOverride);
      lastLoadedFirmwareByCoreId.set(targetCoreId, { path: target.firmwarePath, mtimeMs: stat.mtimeMs, size: stat.size });
      logSimulation("info", `Firmware carregado: ${target.firmwarePath}`, { device: target.label, stage: "firmware" });
    } catch (err) {
      const detail = await state.coreClient.getMcuLogs(targetCoreId).catch(() => undefined);
      const message = `Falha ao recarregar firmware: ${err instanceof Error ? err.message : String(err)}`;
      logSimulation("error", message, { device: target.label, stage: "firmware", detail: detail ? detail.slice(-2000) : undefined });
      reportFirmwareDiagnostic(state.currentProjectFilePath, FIRMWARE_DIAGNOSTIC_KEY, `${target.label}: ${message}`);
      return { ok: false, message: `Falha ao recarregar firmware de "${target.label}": ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  reportFirmwareDiagnostic(state.currentProjectFilePath, FIRMWARE_DIAGNOSTIC_KEY, undefined);
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

  // Escreve em `exposedComponents[]` (schemaVersion 3, `catalog/subcircuitDocument.ts`) -- só x/y
  // mudam aqui (este comando só cobre arrasto no overlay do circuito principal, nunca rotação/
  // espelhamento/escala, ajustáveis dentro de "Abrir Subcircuito", Modo Símbolo). Preserva
  // rotação/espelhamento/escala/camada já salvos, cria a entrada com os padrões de sempre só se
  // ainda não existir (nunca deveria acontecer -- só se expõe algo que já tinha entrada -- mas
  // nunca quebra o arrasto se acontecer).
  if (Array.isArray(json.exposedComponents)) {
    const existing = json.exposedComponents.find(
      (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).componentId === innerComponentId
    );
    const updatedEntry = { rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0, ...existing, componentId: innerComponentId, x, y };
    json.exposedComponents = existing
      ? json.exposedComponents.map((entry) => (entry === existing ? updatedEntry : entry))
      : [...json.exposedComponents, updatedEntry];
  } else {
    json.exposedComponents = [{ componentId: innerComponentId, x, y, rotation: 0, flipH: false, flipV: false, scale: 1, layer: 0 }];
  }

  try {
    fs.writeFileSync(absoluteFilePath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar ${absoluteFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await options.refreshUnifiedCatalogState(true);
}

/*
 * Ligação entre o build do projeto PLC (.lsplc, openplc/openPlcBuild.ts) e o bloco "PLC IEC 61131-3"
 * rodando no Core.
 * Não importa coreLifecycle (que importa este arquivo): o rebuild do Core fica em plcSchematic.ts.
 */

import * as path from "path";
import type { WebviewComponentModel } from "../ui/webview/model";
import { coreInstanceIdByComponentId, state } from "../state";
import { logSimulation } from "../diagnostics/simulationLog";
import {
  PlcBuildOptions,
  PlcBuildResult,
  defaultPlcCacheRoot,
  resolvePlcToolchain,
} from "./plcBuild";
import { buildOpenPlcProject } from "./openplc/openPlcBuild";
import { loadOpenPlcHost } from "./openplc/openPlcHost";
import { isLsplcFile } from "./openplc/lsplcFile";

/** artifactHash carregado em cada bloco PLC (id do componente), para saber se o Core está com o
 * programa atual ou precisa de rebuild depois de uma compilação. */
export const loadedPlcArtifactHashByComponentId = new Map<string, string>();
export const loadedPlcTaskIntervalMsByComponentId = new Map<string, number>();

export function plcBuildOptions(overrides: Partial<PlcBuildOptions> = {}): PlcBuildOptions {
  const extensionPath = state.extensionContext?.extensionPath;
  if (!extensionPath) throw new Error("Extensão LasecSimul ainda não foi ativada.");
  return {
    toolchain: resolvePlcToolchain(extensionPath),
    cacheRoot: defaultPlcCacheRoot(state.extensionContext?.globalStorageUri.fsPath),
    log: (line) => logSimulation("info", line, { stage: "clp" }),
    ...overrides,
  };
}

export function sameFilePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Ouvintes de "terminou uma compilação" (o editor do projeto aberto mostra o resultado). */
const buildListeners = new Set<(projectPath: string, result: PlcBuildResult) => void>();

export function onPlcBuildFinished(listener: (projectPath: string, result: PlcBuildResult) => void): { dispose(): void } {
  buildListeners.add(listener);
  return { dispose: () => buildListeners.delete(listener) };
}

export function notifyPlcBuildFinished(projectPath: string, result: PlcBuildResult): void {
  for (const listener of buildListeners) listener(projectPath, result);
}

/** Compila o projeto PLC (.lsplc, as cinco linguagens) de um bloco CLP. */
export async function buildIecProjectForSimulator(projectPath: string, cacheOnly = false): Promise<PlcBuildResult> {
  const options = plcBuildOptions({ cacheOnly });
  let result: PlcBuildResult;
  if (!isLsplcFile(projectPath)) {
    const message = `O bloco CLP usa um projeto PLC .lsplc: ${path.basename(projectPath)}`;
    result = { ok: false, diagnostics: [{ severity: "error", stage: "project", message }], log: message };
  } else {
    const extensionPath = state.extensionContext?.extensionPath ?? "";
    const storageDir = state.extensionContext?.globalStorageUri.fsPath ?? path.dirname(options.cacheRoot);
    try {
      const host = loadOpenPlcHost({ extensionPath, storageDir, toolchain: options.toolchain });
      result = await buildOpenPlcProject(projectPath, { ...options, host });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { ok: false, diagnostics: [{ severity: "error", stage: "toolchain", message }], log: message };
    }
  }
  if (!cacheOnly) notifyPlcBuildFinished(projectPath, result);
  return result;
}

/** Depois de um build com a simulação rodando: troca o programa dos blocos que usam o projeto
 * sem parar o Core. Devolve avisos para mostrar a quem pediu o build. */
export async function hotReloadRunningPlcs(projectPath: string, result: PlcBuildResult): Promise<string[]> {
  if (!result.ok || state.simulationStatus === "stopped") return [];
  const notices: string[] = [];
  for (const instance of runningPlcInstancesFor(projectPath)) {
    if (loadedPlcArtifactHashByComponentId.get(instance.componentId) === result.module.artifactHash) continue;
    if (loadedPlcTaskIntervalMsByComponentId.get(instance.componentId) !== result.entry.taskIntervalMs) {
      notices.push(`TASK interval changed: stop and run the simulation again to apply it to ${instance.label}.`);
      continue;
    }
    try {
      await state.coreClient?.loadPlcArtifact(instance.instanceId, result.module);
      loadedPlcArtifactHashByComponentId.set(instance.componentId, result.module.artifactHash);
      notices.push(`Program reloaded on the running PLC block ${instance.label}.`);
    } catch (error) {
      notices.push(`Build finished, but reloading ${instance.label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return notices;
}

/**
 * Chamado pelo rebuild do Core para cada bloco PLC com projeto IEC: carrega o build que já existe
 * para o programa atual (compilar fica com o Rodar e o botão Compilar, para editar o esquemático
 * não esperar o g++). Sem build, o bloco fica sem programa até a próxima compilação.
 */
export async function publishIecProjectPlc(
  component: Pick<WebviewComponentModel, "plc"> & { id?: string },
  instanceId: string,
): Promise<void> {
  const componentId = component.id;
  const projectPath = component.plc?.iecProjectRef;
  if (!state.coreClient || !projectPath) return;
  const build = await buildIecProjectForSimulator(projectPath, true);
  if (!build.ok) {
    if (componentId) {
      loadedPlcArtifactHashByComponentId.delete(componentId);
      loadedPlcTaskIntervalMsByComponentId.delete(componentId);
    }
    return;
  }
  await state.coreClient.setPlcTaskInterval(instanceId, Math.max(1, Math.round(build.entry.taskIntervalMs * 1_000_000)));
  await state.coreClient.loadPlcArtifact(instanceId, build.module);
  if (componentId) {
    loadedPlcArtifactHashByComponentId.set(componentId, build.module.artifactHash);
    loadedPlcTaskIntervalMsByComponentId.set(componentId, build.entry.taskIntervalMs);
  }
}

export interface RunningPlcInstance {
  componentId: string;
  label: string;
  instanceId: string;
}

/** Blocos PLC do esquemático que usam este projeto e já estão no Core. */
export function runningPlcInstancesFor(projectPath: string): RunningPlcInstance[] {
  return state.schematicState.components
    .filter(component => component.typeId === "plc.instance" && component.plc?.iecProjectRef &&
      sameFilePath(component.plc.iecProjectRef, projectPath))
    .flatMap(component => {
      const instanceId = coreInstanceIdByComponentId.get(component.id);
      return instanceId && loadedPlcArtifactHashByComponentId.has(component.id)
        ? [{ componentId: component.id, label: component.label || component.id, instanceId }]
        : [];
    });
}

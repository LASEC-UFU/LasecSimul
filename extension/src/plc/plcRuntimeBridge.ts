/*
 * Ligação entre o build do projeto IEC (plcBuild.ts) e o bloco "PLC IEC 61131-3" rodando no Core.
 * Não importa coreLifecycle (que importa este arquivo): o rebuild do Core fica em plcSchematic.ts.
 */

import * as path from "path";
import type { WebviewComponentModel } from "../ui/webview/model";
import { coreInstanceIdByComponentId, state } from "../state";
import { logSimulation } from "../diagnostics/simulationLog";
import {
  PlcBuildOptions,
  PlcBuildResult,
  buildIecProjectFile,
  defaultPlcCacheRoot,
  resolvePlcToolchain,
} from "./plcBuild";

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

/** Ouvintes de "terminou uma compilação" (editor IEC aberto mostra o resultado). */
const buildListeners = new Set<(projectPath: string, result: PlcBuildResult) => void>();

export function onPlcBuildFinished(listener: (projectPath: string, result: PlcBuildResult) => void): { dispose(): void } {
  buildListeners.add(listener);
  return { dispose: () => buildListeners.delete(listener) };
}

export async function buildIecProjectForSimulator(projectPath: string, cacheOnly = false): Promise<PlcBuildResult> {
  const result = await buildIecProjectFile(projectPath, plcBuildOptions({ cacheOnly }));
  if (!cacheOnly) for (const listener of buildListeners) listener(projectPath, result);
  return result;
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

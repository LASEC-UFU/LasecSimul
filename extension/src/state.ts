import * as vscode from "vscode";
import { CoreClient } from "./ipc/CoreClient";
import { CoreProcess } from "./ipc/CoreProcess";
import { SchematicPanel } from "./ui/panels/SchematicPanel";
import { createInitialWebviewState } from "./ui/webview/catalog";
import { WebviewProjectState } from "./ui/webview/model";
import { SimulationStatus } from "./ui/webview/messages";
import { ComponentPaletteViewProvider } from "./ui/views/ComponentPaletteViewProvider";
import { TrustStore } from "./trust/TrustStore";
import { ProjectSerializer } from "./project/ProjectSerializer";

/** Estado mutável de nível de módulo de `extension.ts`, extraído (EX-9,
 * .spec/lasecsimul-native-devices.spec) pra um objeto único importável por outros módulos de
 * domínio (`catalog/registeredSources.ts` não precisa disto -- só lê `extensionPath` por parâmetro
 * -- mas `core/coreLifecycle.ts` e futuros módulos de domínio precisam ESCREVER estes campos).
 * `export let X` do ES module só permite ao módulo QUE DECLAROU reatribuir `X`; um objeto exportado
 * por `const` não tem essa restrição pras suas PROPRIEDADES -- qualquer módulo importador pode fazer
 * `state.coreClient = x`, só não pode fazer `state = outroObjeto`. Por isso um objeto único em vez de
 * `let` soltos por campo. */
export const state = {
  coreProc: undefined as CoreProcess | undefined,
  coreClient: undefined as CoreClient | undefined,
  schematicPanel: undefined as SchematicPanel | undefined,
  schematicState: createInitialWebviewState() as WebviewProjectState,
  currentProjectFilePath: undefined as string | undefined,
  simulationStatus: "stopped" as SimulationStatus,
  paletteViewProvider: undefined as ComponentPaletteViewProvider | undefined,
  extensionContext: undefined as vscode.ExtensionContext | undefined,
  trustStore: undefined as TrustStore | undefined,
  lastSyncedProjectState: undefined as WebviewProjectState | undefined,
  voltageReadoutTimer: undefined as ReturnType<typeof setInterval> | undefined,
};

/**
 * componentId da Webview -> instanceId devolvido pelo Core (resposta de "addComponent").
 * Sem entrada == o Core ainda não tem essa instância (typeId sem componente built-in/plugin
 * ainda, ou o Core não está conectado) — quem usa este mapa sempre trata a ausência como
 * "ignora silenciosamente", nunca como erro fatal (ver docs/mvp-limitacoes.md).
 */
export const coreInstanceIdByComponentId = new Map<string, string>();
export const mcuTargetCoreIdByComponentId = new Map<string, string>();
export const mcuSerialMonitorByKey = new Map<string, { channel: vscode.OutputChannel; timer: ReturnType<typeof setInterval>; lastLength: number }>();
export const projectSerializer = new ProjectSerializer();

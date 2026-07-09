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
  /** Snapshot de `{components, wires}` (o que `ProjectSerializer` de fato persiste, ver
   * `ProjectSerializer.ts`/`projectCommands.ts`) tirado logo após um save/load bem-sucedido --
   * comparado contra `schematicState` atual pra decidir se há alteração não salva (`isProjectDirty`
   * em `projectCommands.ts`). `undefined` == projeto novo/vazio ainda sem save nenhum. */
  lastSavedProjectState: undefined as { components: WebviewProjectState["components"]; wires: WebviewProjectState["wires"] } | undefined,
  /** Pilha de sessões "Abrir Subcircuito" em andamento (ver `extension.ts::
   * openSubcircuitForEditingCommand`/`closeSubcircuitEditorCommand`) -- empilha em vez de um único
   * slot pra suportar abrir um subcircuito DENTRO de outro já em edição. `originalManifest` é o JSON
   * bruto lido do `.lssubcircuit` no momento da abertura, com `components`/`wires` sobrescritos na
   * hora de gravar de volta -- preserva TODAS as outras chaves (`package`, `interface`,
   * `translations`, ...) sem precisar conhecê-las aqui. */
  subcircuitEditingStack: [] as Array<{
    sourceId: string;
    filePath: string;
    originalManifest: Record<string, unknown>;
    outerSchematicState: WebviewProjectState;
    outerProjectFilePath: string | undefined;
    /** `components`/`wires` como ficaram logo após a conversão do `.lssubcircuit` (antes de
     * qualquer edição do usuário nesta sessão) -- comparado contra `state.schematicState.
     * components/wires` atuais em `closeSubcircuitEditorCommand` pra decidir se há alteração não
     * salva (mesmo princípio de `projectCommands.ts::isProjectDirty`). Nunca mutado depois de
     * empilhado (todo mutador de `schematicState` sempre troca o array por um novo, nunca edita in-
     * place -- guardar a referência aqui é seguro). */
    initialComponents: WebviewProjectState["components"];
    initialWires: WebviewProjectState["wires"];
  }>,
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

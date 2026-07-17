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
import { SubcircuitDocument } from "./catalog/subcircuitDocument";

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
  lastSavedProjectState: undefined as { components: WebviewProjectState["components"]; topology: WebviewProjectState["topology"] } | undefined,
  /** Pilha de sessões "Abrir Subcircuito" em andamento (ver `extension.ts::
   * openSubcircuitForEditingCommand`/`closeSubcircuitEditorCommand`) -- empilha em vez de um único
   * slot pra suportar abrir um subcircuito DENTRO de outro já em edição. `originalDocument` é o
   * `SubcircuitDocument` já parseado (schemaVersion 3, `catalog/subcircuitDocument.ts`) no momento
   * da abertura -- preserva os campos que a UI ainda não edita (`translations`, `serialPorts`,
   * `folderPath`, `defaultProperties`, `propertySchema`, `help`) sem precisar conhecê-los aqui;
   * `components`/`topology`/`symbol`/`icon`/`exposedComponents` são recompilados a partir da cena
   * VIVA (`state.schematicState`) na hora de gravar, nunca reaproveitados deste snapshot. */
  subcircuitEditingStack: [] as Array<{
    sourceId: string;
    filePath: string;
    originalDocument: SubcircuitDocument;
    outerSchematicState: WebviewProjectState;
    outerProjectFilePath: string | undefined;
    /** Cada cena como ficou logo após abrir a sessão (antes de qualquer edição do usuário) --
     * comparada contra `state.schematicState` atual em `isSubcircuitEditingSessionDirty` pra decidir
     * se há alteração não salva (mesmo princípio de `projectCommands.ts::isProjectDirty`). Nunca
     * mutada depois de empilhada (todo mutador de `schematicState` sempre troca o array/objeto por
     * um novo, nunca edita in-place -- guardar a referência aqui é seguro). */
    initialComponents: WebviewProjectState["components"];
    initialWires: WebviewProjectState["topology"]["conductors"];
    initialTopologyNodes: WebviewProjectState["topology"]["nodes"];
    initialSymbolElements: WebviewProjectState["symbolElements"];
    initialIconElements: WebviewProjectState["iconElements"];
    initialExposedComponents: WebviewProjectState["exposedComponents"];
    initialExportedPropertyComponentIds: WebviewProjectState["exportedPropertyComponentIds"];
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
/** Último firmware efetivamente empurrado (`CoreClient.loadMcuFirmware`) por instância REAL do Core --
 * chave é o `instanceId` do MCU (não `componentId`: uma reconstrução -- `rebuildCoreFromSchematicState`
 * -- destrói e recria toda instância, então uma instância nova nunca está aqui e recebe o firmware de
 * novo automaticamente; entradas de instâncias mortas só ficam paradas no mapa, nunca mais batem com
 * nada, sem custo prático de limpar cedo). Usado por `mcuCommands.ts::ensureAllMcuFirmwareUpToDate`
 * (chamado antes de "Run") pra decidir se o `.bin`/`.elf`/`.hex` mudou (mtime+tamanho) desde a última
 * carga -- sem isto, cada Run recarregaria (mata+sobe o processo QEMU de novo) mesmo sem mudança
 * nenhuma no arquivo. */
export const lastLoadedFirmwareByCoreId = new Map<string, { path: string; mtimeMs: number; size: number }>();
export const mcuSerialMonitorByKey = new Map<string, { channel: vscode.OutputChannel; timer: ReturnType<typeof setInterval>; lastLength: number }>();
export const projectSerializer = new ProjectSerializer();

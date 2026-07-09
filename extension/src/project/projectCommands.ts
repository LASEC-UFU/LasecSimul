import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { hasShowOnSymbolProperty } from "../catalog/catalogMerge";
import { parseSubcircuitManifest } from "../catalog/registeredSources";
import { currentLasecSimulLanguage } from "../currentLanguage";
import { fileExists, normalizeAbsolutePath, readJsonFile } from "../pathUtils";
import { state, projectSerializer } from "../state";
import { rebuildCoreFromSchematicState, pinsForProjectComponent } from "../core/coreLifecycle";
import { JUNCTION_TYPE_ID, WebviewComponentCatalogEntry, WebviewComponentModel, WebviewProjectState, WebviewWireModel } from "../ui/webview/model";
import { ProjectComponent, ProjectDocument, createEmptyProject } from "./ProjectTypes";

export function absoluteSubcircuitRefPath(refPath: string): string {
  if (path.isAbsolute(refPath)) return path.normalize(refPath);
  const baseDir = state.currentProjectFilePath ? path.dirname(state.currentProjectFilePath) : process.cwd();
  return path.resolve(baseDir, refPath);
}

function projectWithRelativeSubcircuitRefs(project: ProjectDocument, targetProjectPath: string): ProjectDocument {
  const targetDir = path.dirname(targetProjectPath);
  return {
    ...project,
    components: project.components.map((component) => {
      if (!component.subcircuitRef?.path) return component;
      const absolutePath = absoluteSubcircuitRefPath(component.subcircuitRef.path);
      const relativePath = path.relative(targetDir, absolutePath);
      const portablePath = relativePath && !path.isAbsolute(relativePath) ? relativePath : absolutePath;
      return {
        ...component,
        subcircuitRef: {
          ...component.subcircuitRef,
          path: portablePath,
        },
      };
    }),
  };
}

function webviewComponentToProjectComponent(component: WebviewComponentModel): ProjectComponent {
  return {
    id: component.id,
    typeId: component.typeId,
    properties: component.properties,
    label: component.label,
    showId: component.showId,
    showValue: component.showValue,
    valueLabelPropertyKey: component.valueLabelPropertyKey,
    flipH: component.flipH,
    flipV: component.flipV,
    visual: { x: component.x, y: component.y, rotation: component.rotation },
    subcircuitRef: component.subcircuitRef,
  };
}

function validVisualPoints(points: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(points)) return [];
  return points
    .filter((point): point is { x: number; y: number } =>
      typeof point === "object" &&
      point !== null &&
      "x" in point &&
      "y" in point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y)
    )
    .map((point) => ({ x: point.x, y: point.y }));
}

function projectToWebviewState(project: ProjectDocument): WebviewProjectState {
  const catalog = state.schematicState.catalog;
  const visualWirePoints = new Map(
    project.visual.wires.map((wire) => [
      wire.id,
      validVisualPoints(wire.points),
    ])
  );
  const components: WebviewComponentModel[] = project.components.map((component) => {
    const descriptor = catalog.find((item) => item.typeId === component.typeId);
    return {
      id: component.id,
      typeId: component.typeId,
      label: component.label ?? descriptor?.label ?? component.typeId,
      hidden: component.typeId === JUNCTION_TYPE_ID ? true : (descriptor?.hidden ?? false),
      showId: component.showId,
      showValue: component.showValue ?? hasShowOnSymbolProperty(descriptor),
      valueLabelPropertyKey: component.valueLabelPropertyKey,
      flipH: component.flipH,
      flipV: component.flipV,
      x: component.visual?.x ?? 0,
      y: component.visual?.y ?? 0,
      rotation: component.visual?.rotation ?? 0,
      pins: pinsForProjectComponent(component),
      properties: component.properties as Record<string, string | number | boolean>,
      subcircuitRef: component.subcircuitRef,
    };
  });
  const wires: WebviewWireModel[] = project.wires.map((wire) => {
    const points = visualWirePoints.get(wire.id);
    return {
      id: wire.id,
      from: wire.from,
      to: wire.to,
      ...(points && points.length > 0 ? { points } : {}),
    };
  });
  return {
    locale: currentLasecSimulLanguage(),
    catalog,
    components,
    wires,
    viewport: project.visual.viewport,
    selectedComponentIds: [],
    selectedWireIds: [],
  };
}

async function resolveProjectSubcircuitReferences(projectDir: string): Promise<void> {
  const componentsWithRef = state.schematicState.components.filter((component) => component.subcircuitRef);
  if (componentsWithRef.length === 0) return;

  const language = currentLasecSimulLanguage();
  const newCatalogEntries: WebviewComponentCatalogEntry[] = [];
  const updatedComponents = new Map<string, WebviewComponentModel>();
  let missingCount = 0;

  for (const component of componentsWithRef) {
    const ref = component.subcircuitRef!;
    const absolutePath = normalizeAbsolutePath(projectDir, ref.path);
    if (!fileExists(absolutePath) || !state.coreClient) {
      missingCount++;
      continue;
    }

    try {
      await state.coreClient.registerAdhocSubcircuitDefinition(absolutePath);
    } catch {
      missingCount++;
      continue;
    }
    const parsed = parseSubcircuitManifest(
      readJsonFile(absolutePath) as Record<string, unknown>,
      path.dirname(absolutePath),
      language,
      new Set(state.schematicState.catalog.filter((entry) => entry.registeredSourceKind === "mcu-adapter").map((entry) => entry.typeId))
    );
    if (!parsed.typeId) {
      missingCount++;
      continue;
    }

    const newPinIds = parsed.pinIds.length > 0 ? parsed.pinIds : Array.from({ length: parsed.pinCount }, (_, index) => `pin-${index + 1}`);
    const label = parsed.label || parsed.typeId;
    newCatalogEntries.push({
      typeId: parsed.typeId,
      label,
      category: "Subcircuitos",
      hidden: true,
      pinCount: parsed.pinCount,
      pinIds: parsed.pinIds.length > 0 ? parsed.pinIds : undefined,
      defaultProperties: parsed.defaultProperties,
      icon: parsed.icon,
      iconFilePath: parsed.iconFilePath,
      iconSvgInline: parsed.iconSvgInline,
      package: parsed.package,
      logicSymbolPackage: parsed.logicSymbolPackage,
      disabled: false,
      mcuHost: parsed.mcuHost,
      serialPorts: parsed.serialPorts,
    });
    updatedComponents.set(component.id, {
      ...component,
      typeId: parsed.typeId,
      pins: newPinIds.map((id, index) => ({ id, x: 0, y: index * 12 })),
      subcircuitRef: { path: ref.path, lastKnownTypeId: parsed.typeId, lastKnownPinIds: newPinIds },
    });
  }

  if (newCatalogEntries.length > 0 || updatedComponents.size > 0) {
    const catalogTypeIds = new Set(newCatalogEntries.map((entry) => entry.typeId));
    state.schematicState = {
      ...state.schematicState,
      catalog: [...state.schematicState.catalog.filter((entry) => !catalogTypeIds.has(entry.typeId)), ...newCatalogEntries],
      components: state.schematicState.components.map((component) => updatedComponents.get(component.id) ?? component),
    };
  }

  if (missingCount > 0) {
    vscode.window.showWarningMessage(
      `${missingCount} subcircuito(s) não encontrado(s). Clique com o botão direito no bloco para localizar o arquivo.`
    );
  }
}

/** O que `ProjectSerializer` de fato persiste (ver `ProjectSerializer.ts::save`) -- usado tanto pra
 * gravar o snapshot "salvo por último" (`markProjectSaved`) quanto pra decidir se há alteração não
 * salva (`isProjectDirty`). Comparação estrutural (`JSON.stringify`) é barata o bastante pro
 * tamanho típico de um esquemático e evita persistir/computar um diff campo a campo à parte. */
function projectContentSnapshot(): { components: WebviewProjectState["components"]; wires: WebviewProjectState["wires"] } {
  return { components: state.schematicState.components, wires: state.schematicState.wires };
}

function markProjectSaved(): void {
  state.lastSavedProjectState = projectContentSnapshot();
  state.schematicPanel?.setDirty(false);
}

/** `undefined` (projeto novo, nunca salvo) conta como "sujo" assim que há QUALQUER componente --
 * um esquemático vazio recém-aberto não deve disparar aviso nenhum. */
export function isProjectDirty(): boolean {
  const current = projectContentSnapshot();
  if (!state.lastSavedProjectState) return current.components.length > 0 || current.wires.length > 0;
  return JSON.stringify(current) !== JSON.stringify(state.lastSavedProjectState);
}

/** Chamado por `syncSchematicPanel()` (roda depois de toda mutação relevante) -- mantém o indicador
 * "●" no título da aba em sincronia sem precisar instrumentar cada handler de mutação
 * individualmente. */
export function refreshDirtyIndicator(): void {
  state.schematicPanel?.setDirty(isProjectDirty());
}

// ── Arquivos recentes (MRU) ─────────────────────────────────────────────────────────────────────
// Achado de auditoria de UI 2026-07-09: SimulIDE mantém uma lista de até `MaxRecentFiles` circuitos
// recentes (toolbar/menu dedicados); LasecSimul só tinha o diálogo nativo de Abrir/Salvar avulso.
// Persistido em `ExtensionContext.globalState` (mesmo padrão de `TrustStore.ts`) -- sobrevive a
// reinícios do VSCode, local à máquina (não sincroniza, é só uma lista de caminhos de arquivo).

const RECENT_PROJECTS_KEY = "lasecsimul.recentProjectPaths";
const MAX_RECENT_PROJECTS = 10;

/** Filtra caminhos que não existem mais no disco -- uma lista "recentes" com entradas mortas é pior
 * que uma lista vazia (usuário clica, dá erro). Não persiste a filtragem de volta aqui (efeito
 * colateral surpreendente numa função de leitura); quem ESCREVE (`addRecentProjectPath`) já grava
 * só o que existia no momento. */
export function recentProjectPaths(): string[] {
  if (!state.extensionContext) return [];
  const stored = state.extensionContext.globalState.get<string[]>(RECENT_PROJECTS_KEY, []);
  return stored.filter((filePath) => fileExists(filePath));
}

async function addRecentProjectPath(filePath: string): Promise<void> {
  if (!state.extensionContext) return;
  const stored = state.extensionContext.globalState.get<string[]>(RECENT_PROJECTS_KEY, []);
  const deduped = [filePath, ...stored.filter((existing) => existing !== filePath)].slice(0, MAX_RECENT_PROJECTS);
  await state.extensionContext.globalState.update(RECENT_PROJECTS_KEY, deduped);
}

/** Comando `lasecsimul.openRecentProject` -- QuickPick nativo do VSCode (sem UI nova na Webview,
 * mesmo espírito de outros comandos só-Command-Palette do projeto) com os últimos projetos
 * abertos/salvos. Reaproveita EXATAMENTE o mesmo caminho de carga de `openProjectCommand` (dirty
 * check, `projectToWebviewState`, resolução de subcircuitos, `rebuildCoreFromSchematicState`) --
 * só troca de onde o `filePath` vem (QuickPick em vez de `showOpenDialog`). */
export async function openRecentProjectCommand(options: {
  extensionUri: vscode.Uri;
  beforeOpen?: () => void;
  openSchematicEditor: (extensionUri: vscode.Uri) => void;
  syncSchematicPanel: () => void;
}): Promise<void> {
  if (!warnIfEditingSubcircuit()) return;
  const paths = recentProjectPaths();
  if (paths.length === 0) {
    vscode.window.showInformationMessage("Nenhum projeto recente ainda.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    paths.map((filePath) => ({ label: path.basename(filePath), description: filePath, filePath })),
    { placeHolder: "Abrir projeto recente" }
  );
  if (!picked) return;
  if (!(await confirmDiscardUnsavedChanges())) return;

  let project: ProjectDocument;
  try {
    project = await projectSerializer.load(picked.filePath);
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível abrir o projeto: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  options.beforeOpen?.();
  state.currentProjectFilePath = picked.filePath;
  state.schematicState = projectToWebviewState(project);
  await resolveProjectSubcircuitReferences(path.dirname(picked.filePath));
  if (!state.schematicPanel) options.openSchematicEditor(options.extensionUri);
  options.syncSchematicPanel();
  markProjectSaved();
  await addRecentProjectPath(picked.filePath);
  await rebuildCoreFromSchematicState();
}

/** Abrir/Salvar/Importar Projeto usam o formato `.lsproj` (`ProjectDocument`), incompatível com o
 * circuito INTERNO de um `.lssubcircuit` sendo editado via "Abrir Subcircuito" (ver `state.
 * subcircuitEditingStack`/`extension.ts::openSubcircuitForEditingCommand`) -- rodar qualquer um deles
 * nessa hora sobrescreveria a sessão de edição sem gravá-la de volta primeiro. `true` == pode seguir. */
function warnIfEditingSubcircuit(): boolean {
  if (state.subcircuitEditingStack.length === 0) return true;
  vscode.window.showWarningMessage(
    "Termine a edição do subcircuito atual (\"Voltar ao Circuito Principal\") antes de abrir, salvar ou importar um projeto."
  );
  return false;
}

/** `true` == usuário confirmou continuar (ou não havia nada pra perder); `false` == cancelou. */
async function confirmDiscardUnsavedChanges(): Promise<boolean> {
  if (!isProjectDirty()) return true;
  const save = "Salvar";
  const discard = "Descartar";
  // Sem botão "Cancelar" explícito -- o modal já oferece isso via Escape/X, retornando `undefined`.
  const choice = await vscode.window.showWarningMessage(
    "O esquemático atual tem alterações não salvas. O que deseja fazer antes de continuar?",
    { modal: true },
    save,
    discard
  );
  if (choice === save) {
    await saveProjectCommand();
    return !isProjectDirty(); // usuário pode ter cancelado o diálogo de salvar -- ainda sujo, não continua
  }
  return choice === discard;
}

export async function saveProjectCommand(): Promise<void> {
  if (!warnIfEditingSubcircuit()) return;
  const uri = await vscode.window.showSaveDialog({ filters: { "LasecSimul Project": ["lsproj"] } });
  if (!uri) return;
  const project: ProjectDocument = projectWithRelativeSubcircuitRefs({
    ...createEmptyProject(),
    components: state.schematicState.components.map(webviewComponentToProjectComponent),
    wires: state.schematicState.wires.map((wire) => ({ id: wire.id, from: wire.from, to: wire.to })),
    visual: {
      wires: state.schematicState.wires
        .filter((wire) => wire.points && wire.points.length > 0)
        .map((wire) => ({ id: wire.id, points: wire.points })),
      viewport: state.schematicState.viewport,
    },
  }, uri.fsPath);
  try {
    await projectSerializer.save(uri.fsPath, project);
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar o projeto: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  state.currentProjectFilePath = uri.fsPath;
  markProjectSaved();
  await addRecentProjectPath(uri.fsPath);
  vscode.window.showInformationMessage(`Projeto LasecSimul salvo em ${uri.fsPath}`);
}

export async function openProjectCommand(options: {
  extensionUri: vscode.Uri;
  beforeOpen?: () => void;
  openSchematicEditor: (extensionUri: vscode.Uri) => void;
  syncSchematicPanel: () => void;
}): Promise<void> {
  if (!warnIfEditingSubcircuit()) return;
  if (!(await confirmDiscardUnsavedChanges())) return;
  const uris = await vscode.window.showOpenDialog({
    filters: { "LasecSimul Project": ["lsproj"] },
    canSelectMany: false,
  });
  const selected = uris?.[0];
  if (!selected) return;
  let project: ProjectDocument;
  try {
    project = await projectSerializer.load(selected.fsPath);
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível abrir o projeto: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  options.beforeOpen?.();
  state.currentProjectFilePath = selected.fsPath;
  state.schematicState = projectToWebviewState(project);
  await resolveProjectSubcircuitReferences(path.dirname(selected.fsPath));
  if (!state.schematicPanel) options.openSchematicEditor(options.extensionUri);
  options.syncSchematicPanel();
  markProjectSaved();
  await addRecentProjectPath(selected.fsPath);
  await rebuildCoreFromSchematicState();
}

let importIdCounter = 0;
function nextImportedId(prefix: string): string {
  importIdCounter += 1;
  return `${prefix}-imported-${Date.now()}-${importIdCounter}`;
}

/** "Importar Circuito" (achado de auditoria de UI 2026-07-09, paridade com `Circuit::importCircuit()`
 * real do SimulIDE) -- MESCLA outro `.lsproj` no esquemático ABERTO (diferente de "Abrir Projeto",
 * que SUBSTITUI). IDs de componente/fio remapeados (mesma técnica de `pasteClipboardItems` na
 * Webview, agora do lado Extension já que o gatilho é um comando nativo, sem round-trip de IPC
 * pra montar os itens antes de inserir -- `state.schematicState` é mutado direto, `syncSchematicPanel`
 * já sabe computar o patch incremental certo). Posições NÃO deslocadas (ao contrário de colar) --
 * um circuito importado normalmente já tem seu próprio layout coerente; deslocar tudo por um valor
 * fixo só ajudaria a evitar sobreposição num caso especial (importar o MESMO arquivo duas vezes),
 * não vale a complexidade extra pra este caso raro. */
export async function importProjectCommand(options: { syncSchematicPanel: () => void }): Promise<void> {
  if (!warnIfEditingSubcircuit()) return;
  if (!state.schematicPanel) {
    vscode.window.showInformationMessage("Abra ou crie um esquemático antes de importar um circuito nele.");
    return;
  }
  const uris = await vscode.window.showOpenDialog({ filters: { "LasecSimul Project": ["lsproj"] }, canSelectMany: false });
  const selected = uris?.[0];
  if (!selected) return;

  let project: ProjectDocument;
  try {
    project = await projectSerializer.load(selected.fsPath);
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível importar o projeto: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const imported = projectToWebviewState(project);
  const idMap = new Map<string, string>();
  const components: WebviewComponentModel[] = imported.components.map((component) => {
    const nextComponentId = nextImportedId("component");
    idMap.set(component.id, nextComponentId);
    return { ...component, id: nextComponentId };
  });
  const wires: WebviewWireModel[] = imported.wires.flatMap((wire) => {
    const fromId = idMap.get(wire.from.componentId);
    const toId = idMap.get(wire.to.componentId);
    if (!fromId || !toId) return []; // fio apontando pra um componente que o mapeamento acima não cobriu -- não deveria acontecer, mas não trava a importação por causa de 1 fio órfão
    return [{ ...wire, id: nextImportedId("wire"), from: { ...wire.from, componentId: fromId }, to: { ...wire.to, componentId: toId } }];
  });
  if (components.length === 0) {
    vscode.window.showInformationMessage("O projeto selecionado não tem componentes para importar.");
    return;
  }

  state.schematicState = {
    ...state.schematicState,
    catalog: [...state.schematicState.catalog, ...imported.catalog.filter((entry) => !state.schematicState.catalog.some((existing) => existing.typeId === entry.typeId))],
    components: [...state.schematicState.components, ...components],
    wires: [...state.schematicState.wires, ...wires],
    selectedComponentIds: components.map((component) => component.id),
    selectedWireIds: wires.map((wire) => wire.id),
  };
  await resolveProjectSubcircuitReferences(path.dirname(selected.fsPath));
  options.syncSchematicPanel();
  await rebuildCoreFromSchematicState();
  vscode.window.showInformationMessage(`${components.length} componente(s) importado(s) de ${path.basename(selected.fsPath)}.`);
}

/** "Salvar Esquemático como Imagem" (achado de auditoria de UI 2026-07-09) -- a Webview já monta o
 * SVG completo (`buildSchematicSvgExport` em `main.ts`, clona o `canvas-content` real dentro de um
 * `<foreignObject>` com o CSS da página embutido), aqui só mostra o diálogo nativo e grava o
 * arquivo -- MESMA divisão de responsabilidade de `saveProjectCommand` (Webview nunca tem acesso a
 * `fs`). Só SVG por enquanto -- ver nota em `messages.ts::requestExportSchematicImage`.
 */
export async function exportSchematicImageCommand(svg: string): Promise<void> {
  const uri = await vscode.window.showSaveDialog({ filters: { "Imagem SVG": ["svg"] } });
  if (!uri) return;
  try {
    fs.writeFileSync(uri.fsPath, svg, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(`Não foi possível salvar a imagem: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  vscode.window.showInformationMessage(`Esquemático exportado em ${uri.fsPath}`);
}

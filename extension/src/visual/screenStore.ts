import { state } from "../state";
import type { WebviewComponentModel, WebviewProjectState } from "../ui/webview/model";
import {
  HMI_SCREEN_TYPE_ID, createScreenDocument, duplicateScreenDocument, screenIdOf, subsystemTypeIdOfFaceplate, uniqueScreenTitle, type VisualDocument,
} from "../ui/webview/visualDocument";

/**
 * Autoridade dos documentos visuais no Host (ADR 0018): Telas HMI do projeto e Faceplates dos
 * subsistemas internos (`kind: "faceplate"`, id `faceplate:<typeId>`), com revisão e desfazer por
 * documento. As Webviews (Painéis Visuais) são vistas reconstruíveis -- toda troca de janela recria
 * a Webview, então nada que precise sobreviver a um Dock/Undock pode morar só nela. Os Faceplates
 * ficam AQUI e não dentro de `schematicState.subsystems`: o esquemático devolve a tabela inteira no
 * `projectChanged`, e uma cópia atrasada dele apagaria a edição; no arquivo eles vão dentro da
 * definição (`subsystems[].faceplate`), ver `projectCommands.ts`.
 */
const HISTORY_LIMIT = 200;
const histories = new Map<string, { past: VisualDocument[]; future: VisualDocument[] }>();
const listeners = new Set<(documentId: string, origin: unknown) => void>();
const revisions = new Map<string, number>();

/** O projeto RAIZ (o que é simulado e salvo), mesmo com um subsistema aberto para edição. */
export function rootSchematicState(): WebviewProjectState {
  return state.subcircuitEditingStack[0]?.outerSchematicState ?? state.schematicState;
}

export function rootComponents(): WebviewComponentModel[] {
  return rootSchematicState().components;
}

/** Telas HMI do projeto (sem os Faceplates). */
export function listScreens(): readonly VisualDocument[] {
  return state.visualDocuments.filter((doc) => doc.kind !== "faceplate");
}

export function listFaceplates(): readonly VisualDocument[] {
  return state.visualDocuments.filter((doc) => doc.kind === "faceplate");
}

export function getScreen(documentId: string): VisualDocument | undefined {
  return state.visualDocuments.find((doc) => doc.id === documentId);
}

export function screenRevision(documentId: string): number {
  return revisions.get(documentId) ?? 0;
}

export function onScreenChanged(listener: (documentId: string, origin: unknown) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(documentId: string, origin: unknown): void {
  revisions.set(documentId, screenRevision(documentId) + 1);
  for (const listener of listeners) listener(documentId, origin);
}

/** Troca o conjunto inteiro (abrir/fechar projeto): o histórico das telas antigas não vale mais. */
export function resetScreens(documents: readonly VisualDocument[]): void {
  state.visualDocuments = documents.map((doc) => structuredClone(doc));
  histories.clear();
  revisions.clear();
  for (const doc of state.visualDocuments) notify(doc.id, undefined);
}

function historyOf(documentId: string): { past: VisualDocument[]; future: VisualDocument[] } {
  let history = histories.get(documentId);
  if (!history) {
    history = { past: [], future: [] };
    histories.set(documentId, history);
  }
  return history;
}

function replace(next: VisualDocument): void {
  const exists = state.visualDocuments.some((doc) => doc.id === next.id);
  state.visualDocuments = exists
    ? state.visualDocuments.map((doc) => (doc.id === next.id ? next : doc))
    : [...state.visualDocuments, next];
}

/** Grava uma versão nova da tela. `record` empilha a anterior no desfazer; `origin` é a vista que
 * produziu a mudança (ela já a tem e não recebe eco). Igualdade estrutural não grava nada. */
export function putScreen(next: VisualDocument, options: { record: boolean; origin?: unknown }): boolean {
  const previous = getScreen(next.id);
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) return false;
  if (previous && options.record) {
    const history = historyOf(next.id);
    history.past.push(previous);
    if (history.past.length > HISTORY_LIMIT) history.past.shift();
    history.future = [];
  }
  replace(structuredClone(next));
  notify(next.id, options.origin);
  return true;
}

export function undoScreen(documentId: string): boolean {
  const history = historyOf(documentId);
  const current = getScreen(documentId);
  const previous = history.past.pop();
  if (!current || !previous) return false;
  history.future.push(current);
  replace(previous);
  notify(documentId, undefined);
  return true;
}

export function redoScreen(documentId: string): boolean {
  const history = historyOf(documentId);
  const current = getScreen(documentId);
  const next = history.future.pop();
  if (!current || !next) return false;
  history.past.push(current);
  replace(next);
  notify(documentId, undefined);
  return true;
}

export function screenHistory(documentId: string): { canUndo: boolean; canRedo: boolean } {
  const history = histories.get(documentId);
  return { canUndo: Boolean(history?.past.length), canRedo: Boolean(history?.future.length) };
}

function screenButtonsIn(components: readonly WebviewComponentModel[]): WebviewComponentModel[] {
  return components.filter((component) => component.typeId === HMI_SCREEN_TYPE_ID);
}

/** Botões de tela do projeto raiz E do nível em edição (um botão recém-colocado dentro de um
 * subsistema aberto ainda não está no raiz). */
export function screenButtons(): WebviewComponentModel[] {
  const root = rootComponents();
  const current = state.schematicState.components === root ? [] : state.schematicState.components;
  return [...screenButtonsIn(root), ...screenButtonsIn(current)];
}

export function screenButtonFor(documentId: string): WebviewComponentModel | undefined {
  return screenButtons().find((component) => screenIdOf(component) === documentId);
}

/**
 * Garante um documento para cada botão (docs/62 §5.2): botão recém-colocado (id novo) cria tela vazia;
 * botão colado (`screenSource` = tela de origem) cria CÓPIA independente; título do botão e da tela
 * andam juntos. Documentos sem botão continuam na memória (um Ctrl+Z que devolve o botão devolve a
 * tela) e só deixam de ser gravados (`screensForSave`). Devolve os ids criados.
 */
export function reconcileScreenButtons(): string[] {
  const created: string[] = [];
  for (const button of screenButtons()) {
    const documentId = screenIdOf(button);
    if (!documentId) continue;
    const title = typeof button.properties.title === "string" && button.properties.title.trim() ? button.properties.title.trim() : "Tela HMI";
    const existing = getScreen(documentId);
    if (existing) {
      if (existing.title !== title) putScreen({ ...existing, title }, { record: false });
      continue;
    }
    const sourceId = typeof button.properties.screenSource === "string" ? button.properties.screenSource : undefined;
    const source = sourceId ? getScreen(sourceId) : undefined;
    const doc = source ? duplicateScreenDocument(source, documentId, title) : createScreenDocument(documentId, title);
    putScreen(doc, { record: false });
    created.push(documentId);
  }
  return created;
}

/** O que vai para o arquivo: só telas que algum botão do projeto raiz referencia, na ordem dos botões. */
export function screensForSave(): VisualDocument[] {
  const order = screenButtonsIn(rootComponents()).map((button) => screenIdOf(button)).filter((id): id is string => Boolean(id));
  const seen = new Set<string>();
  const result: VisualDocument[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const doc = getScreen(id);
    if (doc) result.push(doc);
  }
  return result;
}

/** Faceplates que vão para o arquivo, por `typeId` do subsistema: só os de definições que existem. */
export function faceplatesForSave(): Map<string, VisualDocument> {
  const typeIds = new Set((rootSchematicState().subsystems ?? []).map((definition) => definition.typeId));
  const result = new Map<string, VisualDocument>();
  for (const doc of listFaceplates()) {
    const typeId = subsystemTypeIdOfFaceplate(doc.id);
    if (typeId && typeIds.has(typeId)) result.set(typeId, doc);
  }
  return result;
}

export function screenTitles(): Set<string> {
  return new Set(listScreens().map((doc) => doc.title));
}

export function uniqueTitleForNewScreen(base = "Tela HMI"): string {
  return uniqueScreenTitle(base, screenTitles());
}

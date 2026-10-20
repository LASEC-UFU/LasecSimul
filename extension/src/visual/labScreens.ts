import type { WebviewComponentModel } from "../ui/webview/model";
import type { LabActivity } from "../ui/webview/lab/activity";
import { MATH_ACTIVITY_TYPE_ID } from "../ui/webview/mathWidgets";
import { labActivityPage, uniqueLabPageSuffix } from "../ui/webview/labPages";
import { HMI_SCREEN_TYPE_ID, VISUAL_DOCUMENT_SCHEMA_VERSION, type VisualDocument } from "../ui/webview/visualDocument";

/**
 * Telas do Laboratório de Cálculo na modalidade nova (docs/62 §6.3, docs/64): uma Tela HMI cujas páginas
 * são as atividades -- cada página com um elemento "Atividade do Laboratório" que ocupa a página. Abre no
 * contexto Laboratório (o cabeçalho e as abas do Laboratório) e em operação (modo aluno); a tela cheia
 * fica no contexto Laboratório.
 */
export const LAB_SCREEN_TITLE = "Laboratório de Cálculo";

export function createLabScreenDocument(id: string, title: string, activities: readonly LabActivity[]): VisualDocument {
  const pages: VisualDocument["pages"] = [];
  for (const activity of activities) pages.push(labActivityPage(activity, uniqueLabPageSuffix(activity, pages)));
  return {
    schemaVersion: VISUAL_DOCUMENT_SCHEMA_VERSION,
    id,
    kind: "screen",
    title,
    startPageId: pages[0]?.id ?? "",
    pages,
    presentation: { fullscreenContext: "lab", defaultContext: "lab", startInOperation: true },
  };
}

/** Botão "Tela HMI" que abre a tela do Laboratório, colocado ACIMA do circuito (nada é movido). */
export function labScreenButton(
  screenId: string, title: string, components: readonly WebviewComponentModel[], takenIds: ReadonlySet<string>, at?: { x: number; y: number },
): WebviewComponentModel {
  const minX = components.length > 0 ? Math.min(...components.map((component) => component.x)) : 40;
  const minY = components.length > 0 ? Math.min(...components.map((component) => component.y)) : 120;
  let id = "laboratorio-calculo";
  for (let index = 2; takenIds.has(id); index += 1) id = `laboratorio-calculo-${index}`;
  return {
    id,
    typeId: HMI_SCREEN_TYPE_ID,
    label: title,
    x: at?.x ?? Math.round(minX / 8) * 8,
    y: at?.y ?? Math.round((minY - 96) / 8) * 8,
    rotation: 0,
    pins: [],
    showId: false,
    showValue: false,
    properties: { title, screenId, width: 176, height: 64 },
  };
}

/** A tela do projeto que tem atividades do Laboratório (a primeira), se houver. */
export function findLabScreen(documents: readonly VisualDocument[]): VisualDocument | undefined {
  return documents.find((doc) => doc.pages.some((page) => page.elements.some((element) => element.typeId === MATH_ACTIVITY_TYPE_ID)));
}

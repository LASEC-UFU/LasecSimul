/**
 * Páginas-modelo do Laboratório de Cálculo (docs/62 §6.3): cada atividade vira uma página com um elemento
 * "Atividade do Laboratório" que ocupa a página. Compartilhado pelo Host (tela criada pelo comando,
 * conversão de projetos antigos, exemplos) e pela Webview ("+ Página do Laboratório" na edição).
 */
import type { LabActivity } from "./lab/activity.js";
import { MATH_ACTIVITY_TYPE_ID } from "./mathWidgets.js";
import type { HmiPage } from "./model.js";

export const LAB_PAGE_WIDTH = 1920;
export const LAB_PAGE_HEIGHT = 1080;

/** Página de uma atividade; `suffix` desambigua ids quando a mesma atividade-modelo entra de novo. */
export function labActivityPage(activity: LabActivity, suffix = ""): HmiPage {
  return {
    id: `pagina-${activity.id}${suffix}`,
    name: activity.title,
    width: LAB_PAGE_WIDTH,
    height: LAB_PAGE_HEIGHT,
    elements: [{
      id: `atividade-${activity.id}${suffix}`,
      typeId: MATH_ACTIVITY_TYPE_ID,
      label: activity.title,
      properties: {
        width: LAB_PAGE_WIDTH, height: LAB_PAGE_HEIGHT, kind: activity.kind, fillPage: true,
        plantComponentId: "plantComponentId" in activity && typeof activity.plantComponentId === "string" ? activity.plantComponentId : "",
        activityJson: JSON.stringify(activity),
      },
      visual: { x: 0, y: 0, width: LAB_PAGE_WIDTH, height: LAB_PAGE_HEIGHT, rotation: 0 },
    }],
  };
}

/** Sufixo que torna a página/elemento únicos entre as páginas existentes ("", "-2", "-3"...). */
export function uniqueLabPageSuffix(activity: LabActivity, pages: readonly HmiPage[]): string {
  const ids = new Set(pages.flatMap((page) => [page.id, ...page.elements.map((element) => element.id)]));
  let suffix = "";
  for (let index = 2; ids.has(`pagina-${activity.id}${suffix}`) || ids.has(`atividade-${activity.id}${suffix}`); index += 1) suffix = `-${index}`;
  return suffix;
}

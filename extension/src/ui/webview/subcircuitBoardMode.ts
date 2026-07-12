import { WebviewComponentModel } from "./model.js";

export type ComponentTransform = Pick<WebviewComponentModel, "x" | "y" | "rotation" | "flipH" | "flipV">;

/** Quem aparece no Modo Placa (igual a `Component::setHidden` do SimulIDE real: só componentes
 * `m_graphical` continuam visíveis quando o modo liga, todo o resto some -- ver
 * `subpackage.cpp::setBoardMode`). `isGraphicalTypeId` é injetado (em vez de ler `catalogEntryFor`
 * direto aqui) pra este módulo continuar puro/testável sem precisar montar um catálogo inteiro --
 * `main.ts` passa `(typeId) => catalogEntryFor(typeId)?.graphical === true`. O próprio `other.package`
 * (o item que REPRESENTA a placa) e a Figura/ícone do Package (`packageIconRole`) sempre aparecem,
 * independente do catálogo -- são a "mesa" onde os outros itens são posicionados, não algo pra
 * esconder. */
export function isBoardModeVisible(component: WebviewComponentModel, isGraphicalTypeId: (typeId: string) => boolean): boolean {
  return isGraphicalTypeId(component.typeId) || component.typeId === "other.package" || component.packageIconRole === true;
}

export function captureCircuitTransforms(components: WebviewComponentModel[]): Map<string, ComponentTransform> {
  return new Map(components.map((component) => [component.id, {
    x: component.x, y: component.y, rotation: component.rotation,
    flipH: component.flipH, flipV: component.flipV,
  }]));
}

export function applyBoardTransforms(
  components: WebviewComponentModel[],
  isVisible: (component: WebviewComponentModel) => boolean
): void {
  for (const component of components) {
    if (!isVisible(component)) continue;
    component.x = component.boardX ?? component.x;
    component.y = component.boardY ?? component.y;
    component.rotation = component.boardRotation ?? component.rotation;
    component.flipH = component.boardFlipH ?? component.flipH;
    component.flipV = component.boardFlipV ?? component.flipV;
  }
}

export function captureBoardTransforms(
  components: WebviewComponentModel[],
  isVisible: (component: WebviewComponentModel) => boolean
): void {
  for (const component of components) {
    if (!isVisible(component)) continue;
    component.boardX = component.x;
    component.boardY = component.y;
    component.boardRotation = component.rotation;
    component.boardFlipH = component.flipH;
    component.boardFlipV = component.flipV;
  }
}

export function restoreCircuitTransforms(
  components: WebviewComponentModel[],
  transforms: ReadonlyMap<string, ComponentTransform>
): void {
  for (const component of components) {
    const transform = transforms.get(component.id);
    if (transform) Object.assign(component, transform);
  }
}

export function applyExposedSelection(components: WebviewComponentModel[], selectedIds: ReadonlySet<string>): void {
  for (const component of components) component.exposed = selectedIds.has(component.id);
}

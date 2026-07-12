import { WebviewComponentModel } from "./model.js";

export type ComponentTransform = Pick<WebviewComponentModel, "x" | "y" | "rotation" | "flipH" | "flipV">;

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

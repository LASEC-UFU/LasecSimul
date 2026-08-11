export interface ContextMenuPoint {
  x: number;
  y: number;
}

export interface ContextMenuSize {
  width: number;
  height: number;
}

export interface ContextMenuViewport {
  width: number;
  height: number;
}

export interface ContextMenuAnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ContextMenuPosition {
  left: number;
  top: number;
}

export interface SubmenuPosition extends ContextMenuPosition {
  direction: "left" | "right";
}

export const CONTEXT_MENU_VIEWPORT_MARGIN = 8;

export function contextMenuViewportSize(
  viewport: ContextMenuViewport,
  margin = CONTEXT_MENU_VIEWPORT_MARGIN,
): ContextMenuSize {
  return {
    width: Math.max(0, viewport.width - margin * 2),
    height: Math.max(0, viewport.height - margin * 2),
  };
}

function fits(start: number, size: number, minimum: number, maximum: number): boolean {
  return start >= minimum && start + size <= maximum;
}

function clampStart(start: number, size: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(start, minimum), Math.max(minimum, maximum - size));
}

/**
 * Mantém a posição padrão sempre que ela cabe. A alternativa invertida só é usada quando há
 * colisão; se nem ela couber (viewport extremamente pequeno), o popup é deslocado pelo mínimo
 * necessário. A dimensão do popup já deve ser a dimensão real, obtida após sua renderização.
 */
function positionAxis(
  preferred: number,
  flipped: number,
  size: number,
  minimum: number,
  maximum: number,
): { start: number; flipped: boolean } {
  if (fits(preferred, size, minimum, maximum)) return { start: preferred, flipped: false };
  if (fits(flipped, size, minimum, maximum)) return { start: flipped, flipped: true };
  return { start: clampStart(flipped, size, minimum, maximum), flipped: true };
}

export function positionRootContextMenu(
  anchor: ContextMenuPoint,
  menu: ContextMenuSize,
  viewport: ContextMenuViewport,
  margin = CONTEXT_MENU_VIEWPORT_MARGIN,
): ContextMenuPosition {
  const horizontal = positionAxis(anchor.x, anchor.x - menu.width, menu.width, margin, viewport.width - margin);
  const vertical = positionAxis(anchor.y, anchor.y - menu.height, menu.height, margin, viewport.height - margin);
  return { left: horizontal.start, top: vertical.start };
}

export function positionContextSubmenu(
  anchor: ContextMenuAnchorRect,
  menu: ContextMenuSize,
  viewport: ContextMenuViewport,
  margin = CONTEXT_MENU_VIEWPORT_MARGIN,
): SubmenuPosition {
  const horizontal = positionAxis(anchor.right, anchor.left - menu.width, menu.width, margin, viewport.width - margin);

  // Submenus continuam alinhados ao topo do item de origem. Perto da borda inferior, apenas o
  // deslocamento vertical estritamente necessário é aplicado, em vez de saltar para uma posição
  // sem relação visual com o item.
  const top = clampStart(anchor.top, menu.height, margin, viewport.height - margin);
  return {
    left: horizontal.start,
    top,
    direction: horizontal.flipped ? "left" : "right",
  };
}

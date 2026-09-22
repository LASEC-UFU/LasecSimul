// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see licenses/ipd-studio/COMMERCIAL-LICENSE.md).
// Adapted for LasecSimul from IPD Studio src/canvas/keyboardNav.ts at
// 4b84fb8694bc89985872690366e8be2e32a8db2b.

export interface IpdNavigationItem {
  id: string;
  x: number;
  y: number;
  kind: "component" | "wire";
  label: string;
  rotation?: number;
}

const NAVIGATION_BAND = 24;

/** Reading order used by Tab: top to bottom, then left to right within a visual row. */
export function ipdNavigationOrder(items: readonly IpdNavigationItem[]): string[] {
  return items
    .map((item) => ({ id: item.id, x: item.x, y: item.y }))
    .sort((a, b) => {
      const band = Math.floor(a.y / NAVIGATION_BAND) - Math.floor(b.y / NAVIGATION_BAND);
      if (band !== 0) return band;
      if (a.x !== b.x) return a.x - b.x;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((item) => item.id);
}

/** Pure selection step; wrapping and no-selection entry match the current IPD behavior. */
export function stepIpdNavigation(
  order: readonly string[],
  currentId: string | undefined,
  direction: 1 | -1,
): string | undefined {
  if (order.length === 0) return undefined;
  const current = currentId ? order.indexOf(currentId) : -1;
  if (current < 0) return direction === 1 ? order[0] : order[order.length - 1];
  return order[(current + direction + order.length) % order.length];
}

export function describeIpdNavigationSelection(
  items: readonly IpdNavigationItem[],
  selection: readonly string[],
  locale: "pt-BR" | "en",
): string {
  if (selection.length === 0) return locale === "pt-BR" ? "Nada selecionado" : "Nothing selected";
  if (selection.length > 1) {
    return locale === "pt-BR" ? `${selection.length} objetos selecionados` : `${selection.length} objects selected`;
  }
  const item = items.find((candidate) => candidate.id === selection[0]);
  if (!item) return locale === "pt-BR" ? "Objeto" : "Object";
  const order = ipdNavigationOrder(items);
  const index = order.indexOf(item.id);
  const position = index >= 0
    ? locale === "pt-BR" ? `${index + 1} de ${order.length}` : `${index + 1} of ${order.length}`
    : "";
  const rotation = item.rotation
    ? locale === "pt-BR" ? `, girado ${item.rotation} graus` : `, rotated ${item.rotation} degrees`
    : "";
  return [item.label + rotation, position].filter(Boolean).join(", ");
}

// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see licenses/ipd-studio/COMMERCIAL-LICENSE.md).
// Adapted for LasecSimul from IPD Studio src/canvas/alignment.ts at
// 4b84fb8694bc89985872690366e8be2e32a8db2b.

/**
 * Geometry-only adaptation of IPD Studio's align/distribute operations.
 *
 * LasecSimul components are positioned by a symbol anchor. Rotation around a
 * non-central origin can therefore move the visible box away from that anchor.
 * `bounds` describes that already-transformed local box so the operation acts
 * on what the operator sees while the returned move still targets the original
 * component anchor.
 */
export interface IpdAlignmentNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: 0 | 90 | 180 | 270;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface IpdNodeMove {
  id: string;
  x: number;
  y: number;
}

export type IpdAlignMode = "left" | "right" | "top" | "bottom" | "center-h" | "center-v";

interface ResolvedBox {
  node: IpdAlignmentNode;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  left: number;
  top: number;
}

function resolvedBox(node: IpdAlignmentNode): ResolvedBox {
  const rotated = node.rotation === 90 || node.rotation === 270;
  const local = node.bounds ?? {
    x: 0,
    y: 0,
    width: rotated ? node.height : node.width,
    height: rotated ? node.width : node.height,
  };
  return {
    node,
    offsetX: local.x,
    offsetY: local.y,
    width: local.width,
    height: local.height,
    left: node.x + local.x,
    top: node.y + local.y,
  };
}

function unchanged(nodes: IpdAlignmentNode[]): IpdNodeMove[] {
  return nodes.map((node) => ({ id: node.id, x: node.x, y: node.y }));
}

/** Align visible edges or centers using the complete selection extent. */
export function alignIpdNodes(nodes: IpdAlignmentNode[], mode: IpdAlignMode): IpdNodeMove[] {
  if (nodes.length < 2) return unchanged(nodes);

  const boxes = nodes.map(resolvedBox);
  const left = Math.min(...boxes.map((box) => box.left));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const top = Math.min(...boxes.map((box) => box.top));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;

  return boxes.map((box) => {
    const { node, offsetX, offsetY, width, height } = box;
    switch (mode) {
      case "left":
        return { id: node.id, x: left - offsetX, y: node.y };
      case "right":
        return { id: node.id, x: right - width - offsetX, y: node.y };
      case "top":
        return { id: node.id, x: node.x, y: top - offsetY };
      case "bottom":
        return { id: node.id, x: node.x, y: bottom - height - offsetY };
      case "center-v":
        return { id: node.id, x: Math.round((centerX - width / 2 - offsetX) / 8) * 8, y: node.y };
      case "center-h":
        return { id: node.id, x: node.x, y: Math.round((centerY - height / 2 - offsetY) / 8) * 8 };
    }
  });
}

/** Distribute visible centers spatially; input selection order is irrelevant. */
export function distributeIpdNodes(nodes: IpdAlignmentNode[], axis: "h" | "v"): IpdNodeMove[] {
  if (nodes.length < 3) return unchanged(nodes);

  const boxes = nodes
    .map(resolvedBox)
    .sort((a, b) => (axis === "h" ? a.left - b.left : a.top - b.top));
  const first = boxes[0]!;
  const last = boxes[boxes.length - 1]!;
  const firstCenter = axis === "h" ? first.left + first.width / 2 : first.top + first.height / 2;
  const lastCenter = axis === "h" ? last.left + last.width / 2 : last.top + last.height / 2;
  const step = (lastCenter - firstCenter) / (boxes.length - 1);

  return boxes.map((box, index) => {
    const center = firstCenter + step * index;
    return axis === "h"
      ? {
          id: box.node.id,
          x: Math.round((center - box.width / 2 - box.offsetX) / 8) * 8,
          y: box.node.y,
        }
      : {
          id: box.node.id,
          x: box.node.x,
          y: Math.round((center - box.height / 2 - box.offsetY) / 8) * 8,
        };
  });
}

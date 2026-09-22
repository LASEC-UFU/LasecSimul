// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright © 2026 Praharsh Nagpure — IPD Studio. Noncommercial use only;
// commercial use requires a paid license (see licenses/ipd-studio/COMMERCIAL-LICENSE.md).
// Adapted for LasecSimul from IPD Studio src/canvas/lineStyle.ts, src/canvas/glyphs.ts and
// src/model/types.ts at 4b84fb8694bc89985872690366e8be2e32a8db2b.

export const IPD_LINE_CLASSES = [
  "process.major",
  "process.minor",
  "process.impulse",
  "signal.electric",
  "signal.pneumatic",
  "signal.hydraulic",
  "signal.capillary",
  "signal.data",
  "signal.software",
  "link.internal",
  "signal.em",
  "pipe.jacketed",
  "pipe.traced",
  "pipe.existing",
  "pipe.underground",
  "pipe.battery-limit",
] as const;

export type IpdLineClass = (typeof IPD_LINE_CLASSES)[number];

export interface IpdLineStroke {
  width: number;
  dasharray?: string;
  /** Rendered as a dark outline plus a light inner stroke. */
  double?: boolean;
}

export interface IpdGlyphStation {
  x: number;
  y: number;
  angle: number;
  distance: number;
}

export type IpdLineGlyph =
  | { kind: "path"; d: string }
  | { kind: "circle"; radius: number };

export interface IpdLineGlyphSpec {
  spacing: number;
  glyph: IpdLineGlyph;
}

export const IPD_LINE_STROKES: Readonly<Record<IpdLineClass, IpdLineStroke>> = {
  "process.major": { width: 2.5 },
  "process.minor": { width: 1.25 },
  "process.impulse": { width: 1 },
  "signal.electric": { width: 1.25, dasharray: "4 3" },
  "signal.pneumatic": { width: 1.25 },
  "signal.hydraulic": { width: 1.25 },
  "signal.capillary": { width: 1.25 },
  "signal.data": { width: 1.25 },
  "signal.software": { width: 1.25, dasharray: "4 3" },
  "link.internal": { width: 1, dasharray: "2 2" },
  "signal.em": { width: 1.25 },
  "pipe.jacketed": { width: 2.5, double: true },
  "pipe.traced": { width: 1.25, dasharray: "8 3 2 3 2 3" },
  "pipe.existing": { width: 0.75 },
  "pipe.underground": { width: 1.25, dasharray: "12 6" },
  "pipe.battery-limit": { width: 2.5, dasharray: "12 4 3 4" },
};

export const IPD_LINE_GLYPHS: Readonly<Record<IpdLineClass, IpdLineGlyphSpec | null>> = {
  "process.major": null,
  "process.minor": null,
  "process.impulse": null,
  "signal.electric": null,
  "signal.pneumatic": { spacing: 24, glyph: { kind: "path", d: "M -5 4 L 1 -4 M -1 4 L 5 -4" } },
  "signal.hydraulic": { spacing: 24, glyph: { kind: "path", d: "M -2 -4 V 4 H 4" } },
  "signal.capillary": { spacing: 24, glyph: { kind: "path", d: "M -4 -4 L 4 4 M 4 -4 L -4 4" } },
  "signal.data": { spacing: 24, glyph: { kind: "circle", radius: 2.5 } },
  "signal.software": { spacing: 24, glyph: { kind: "circle", radius: 2.5 } },
  "link.internal": null,
  "signal.em": { spacing: 24, glyph: { kind: "path", d: "M -5 0 q 2.5 -4 5 0 q 2.5 4 5 0" } },
  "pipe.jacketed": null,
  "pipe.traced": null,
  "pipe.existing": null,
  "pipe.underground": null,
  "pipe.battery-limit": null,
};

const EN_LABELS: Readonly<Record<IpdLineClass, string>> = {
  "process.major": "Process (major)",
  "process.minor": "Process (minor)",
  "process.impulse": "Instrument impulse",
  "signal.electric": "Electric signal",
  "signal.pneumatic": "Pneumatic signal",
  "signal.hydraulic": "Hydraulic signal",
  "signal.capillary": "Capillary",
  "signal.data": "Data link",
  "signal.software": "Software link",
  "link.internal": "Internal system link",
  "signal.em": "Electromagnetic/sonic signal",
  "pipe.jacketed": "Jacketed pipe",
  "pipe.traced": "Heat-traced pipe",
  "pipe.existing": "Existing pipe",
  "pipe.underground": "Underground pipe",
  "pipe.battery-limit": "Battery limit",
};

const PT_LABELS: Readonly<Record<IpdLineClass, string>> = {
  "process.major": "Processo (principal)",
  "process.minor": "Processo (secundária)",
  "process.impulse": "Impulso de instrumento",
  "signal.electric": "Sinal elétrico",
  "signal.pneumatic": "Sinal pneumático",
  "signal.hydraulic": "Sinal hidráulico",
  "signal.capillary": "Capilar",
  "signal.data": "Enlace de dados",
  "signal.software": "Enlace de software",
  "link.internal": "Enlace interno do sistema",
  "signal.em": "Sinal eletromagnético/sônico",
  "pipe.jacketed": "Tubulação jaquetada",
  "pipe.traced": "Tubulação com traço térmico",
  "pipe.existing": "Tubulação existente",
  "pipe.underground": "Tubulação subterrânea",
  "pipe.battery-limit": "Limite de bateria",
};

export function isIpdLineClass(value: unknown): value is IpdLineClass {
  return typeof value === "string" && (IPD_LINE_CLASSES as readonly string[]).includes(value);
}

export function isIpdProcessClass(lineClass: IpdLineClass): boolean {
  return lineClass.startsWith("process") || lineClass.startsWith("pipe");
}

export function ipdLineStroke(lineClass: IpdLineClass): IpdLineStroke {
  return IPD_LINE_STROKES[lineClass];
}

export function ipdLineClassLabel(lineClass: IpdLineClass, locale = "en"): string {
  return locale.toLowerCase().startsWith("pt") ? PT_LABELS[lineClass] : EN_LABELS[lineClass];
}

export function ipdLineClassCssSuffix(lineClass: IpdLineClass): string {
  return lineClass.replaceAll(".", "-");
}

/** Evenly spaced ISA glyph stations, with 12 px clearance from route ends and corners. */
export function ipdGlyphStations(
  points: readonly { x: number; y: number }[],
  spacing: number,
): IpdGlyphStation[] {
  if (points.length < 2) return [];
  const segments: Array<{ x0: number; y0: number; dx: number; dy: number; length: number; start: number }> = [];
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    const rawDx = to.x - from.x;
    const rawDy = to.y - from.y;
    const length = Math.hypot(rawDx, rawDy);
    if (length === 0) continue;
    segments.push({ x0: from.x, y0: from.y, dx: rawDx / length, dy: rawDy / length, length, start: total });
    total += length;
  }

  const stations: IpdGlyphStation[] = [];
  const endClearance = 12;
  for (let distance = spacing; distance < total - endClearance; distance += spacing) {
    const segment = segments.find((candidate) => distance >= candidate.start && distance <= candidate.start + candidate.length);
    if (!segment) continue;
    const local = distance - segment.start;
    if (local < endClearance || segment.length - local < endClearance) continue;
    stations.push({
      x: segment.x0 + segment.dx * local,
      y: segment.y0 + segment.dy * local,
      angle: ((Math.atan2(segment.dy, segment.dx) * 180) / Math.PI + 360) % 360,
      distance,
    });
  }
  return stations;
}

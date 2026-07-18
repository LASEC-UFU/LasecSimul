import * as fs from "fs";
import * as path from "path";
import { fileExists, normalizeAbsolutePath } from "../pathUtils";
import {
  ComponentViewSpec,
  PackageDescriptor,
  PackageDynamicLayout,
  PackageDynamicPinGroup,
  PackageNumberExpression,
  PackageNumberValue,
  PackagePin,
  PackageShape,
  SimulidePaintGradient,
  SimulidePaintPrimitive,
  SimulidePaintSpec,
  SimulidePaintStateFill,
  SimulidePaintStateHref,
  SimulidePaintStateText,
  SimulidePaintStateVisible,
  SimulidePaintStyle,
  SimulideQtWidgetSpec,
  ViewSpecAxisMapping,
  ViewSpecGradient,
  ViewSpecHitTest,
  ViewSpecInteraction,
  ViewSpecLimit,
  ViewSpecPart,
  ViewSpecProjection,
} from "../ui/webview/model";

/** EX-9 (.spec/lasecsimul-native-devices.spec): sanitização de `package`/`viewSpec`/`simulidePaint`/
 * `qtWidget` vindos de JSON externo (`.lsdevice`/`.lssubcircuit`) -- extraído de `extension.ts` por
 * ser um bloco 100% autocontido (nenhuma função aqui toca estado mutável de nível de módulo do
 * host da extensão, só transforma `unknown` em tipos validados). `sanitizePackage`/
 * `sanitizeManifestDefaultProperties` são a superfície pública real (únicas chamadas de fora deste
 * arquivo); o resto é máquina interna de apoio, exportada só por uniformidade/testabilidade. */

const PACKAGE_SHAPE_KINDS = new Set(["rect", "text", "line", "ellipse", "polygon", "path", "image", "svg"]);
const SIMULIDE_PAINT_PRIMITIVE_KINDS = new Set(["line", "rect", "roundedRect", "ellipse", "arc", "path", "polygon", "polyline", "text", "image", "repeat"]);
const VIEW_SPEC_GRADIENT_KINDS = new Set(["radial", "linear"]);
const VIEW_SPEC_PROJECTION_KINDS = new Set(["translate", "rotate", "fill", "visible"]);
const VIEW_SPEC_HIT_TEST_KINDS = new Set(["rect", "circle", "ellipse", "polygon", "path"]);
const VIEW_SPEC_INTERACTION_KINDS = new Set(["dragVector", "dragAngular", "touchPoint", "press", "toggle", "slider"]);

export function sanitizePackageShape(value: unknown): PackageShape | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const shape = value as Record<string, unknown> & { kind?: unknown };
  if (typeof shape.kind !== "string" || !PACKAGE_SHAPE_KINDS.has(shape.kind)) return undefined;
  const statePathRaw = typeof shape.statePath === "object" && shape.statePath !== null
    ? shape.statePath as Record<string, unknown>
    : undefined;
  const statePathMap = typeof statePathRaw?.map === "object" && statePathRaw.map !== null
    ? Object.fromEntries(
        Object.entries(statePathRaw.map as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      )
    : undefined;
  const statePath = sanitizeOptionalString(statePathRaw?.prop) && statePathMap && Object.keys(statePathMap).length > 0
    ? {
        prop: sanitizeOptionalString(statePathRaw?.prop)!,
        map: statePathMap,
        ...(sanitizeOptionalString(statePathRaw?.fallback) ? { fallback: sanitizeOptionalString(statePathRaw?.fallback) } : {}),
      }
    : undefined;
  return {
    ...(shape as unknown as PackageShape),
    cssClass: typeof shape.cssClass === "string" && shape.cssClass.trim() ? shape.cssClass.trim() : undefined,
    partId: typeof shape.partId === "string" && shape.partId.trim() ? shape.partId.trim() : undefined,
    stateFill: sanitizeSimulidePaintStateFill(shape.stateFill),
    stateText: shape.kind === "text" ? sanitizeSimulidePaintStateText(shape.stateText) : undefined,
    ...(statePath ? { statePath } : {}),
  };
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeNumberValue(value: unknown): PackageNumberValue | undefined {
  const direct = finiteNumber(value);
  if (direct !== undefined) return direct;
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const prop = typeof raw.prop === "string" && raw.prop.trim() ? raw.prop.trim() : undefined;
  const index = typeof raw.index === "string" && raw.index.trim() ? raw.index.trim() : undefined;
  if (!prop && !index) return undefined;
  const out: PackageNumberExpression = {
    ...(prop ? { prop } : {}),
    ...(index ? { index } : {}),
    ...(finiteNumber(raw.multiplier) !== undefined ? { multiplier: finiteNumber(raw.multiplier) } : {}),
    ...(finiteNumber(raw.offset) !== undefined ? { offset: finiteNumber(raw.offset) } : {}),
    ...(finiteNumber(raw.fallback) !== undefined ? { fallback: finiteNumber(raw.fallback) } : {}),
    ...(finiteNumber(raw.min) !== undefined ? { min: finiteNumber(raw.min) } : {}),
    ...(finiteNumber(raw.max) !== undefined ? { max: finiteNumber(raw.max) } : {}),
    ...(raw.round === "trunc" || raw.round === "round" || raw.round === "floor" || raw.round === "ceil" ? { round: raw.round } : {}),
    ...(raw.transform === "log2Ceil" ? { transform: raw.transform } : {}),
  };
  return out;
}

export function sanitizePointList(value: unknown): Array<{ x: number; y: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const points = value
    .map((point) => {
      if (typeof point !== "object" || point === null) return undefined;
      const raw = point as Record<string, unknown>;
      const x = finiteNumber(raw.x);
      const y = finiteNumber(raw.y);
      return x !== undefined && y !== undefined ? { x, y } : undefined;
    })
    .filter((point): point is { x: number; y: number } => Boolean(point));
  return points.length > 0 ? points : undefined;
}

export function sanitizeSimulidePaintStyle(raw: Record<string, unknown>): SimulidePaintStyle {
  return {
    ...(sanitizeOptionalString(raw.stroke) ? { stroke: sanitizeOptionalString(raw.stroke) } : {}),
    ...(sanitizeOptionalString(raw.fill) ? { fill: sanitizeOptionalString(raw.fill) } : {}),
    ...(sanitizeSimulidePaintGradient(raw.fillGradient) ? { fillGradient: sanitizeSimulidePaintGradient(raw.fillGradient) } : {}),
    ...(finiteNumber(raw.strokeWidth) !== undefined ? { strokeWidth: finiteNumber(raw.strokeWidth) } : {}),
    ...(raw.strokeLinecap === "butt" || raw.strokeLinecap === "round" || raw.strokeLinecap === "square" ? { strokeLinecap: raw.strokeLinecap } : {}),
    ...(raw.strokeLinejoin === "arcs" || raw.strokeLinejoin === "bevel" || raw.strokeLinejoin === "miter" || raw.strokeLinejoin === "miter-clip" || raw.strokeLinejoin === "round" ? { strokeLinejoin: raw.strokeLinejoin } : {}),
    ...(sanitizeOptionalString(raw.strokeDasharray) ? { strokeDasharray: sanitizeOptionalString(raw.strokeDasharray) } : {}),
    ...(raw.fillRule === "nonzero" || raw.fillRule === "evenodd" ? { fillRule: raw.fillRule } : {}),
    ...(finiteNumber(raw.opacity) !== undefined ? { opacity: finiteNumber(raw.opacity) } : {}),
  };
}

export function sanitizeSimulidePaintGradient(value: unknown): SimulidePaintGradient | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const stopsRaw = Array.isArray(raw.stops) ? raw.stops : [];
  const stops = stopsRaw
    .map((stop) => {
      if (typeof stop !== "object" || stop === null) return undefined;
      const rawStop = stop as Record<string, unknown>;
      const offset = typeof rawStop.offset === "number" || typeof rawStop.offset === "string" ? rawStop.offset : undefined;
      const color = sanitizeOptionalString(rawStop.color);
      return offset !== undefined && color ? { offset, color } : undefined;
    })
    .filter((stop): stop is { offset: number | string; color: string } => Boolean(stop));
  if (stops.length === 0) return undefined;
  if (raw.kind === "linear") {
    const x1 = finiteNumber(raw.x1), y1 = finiteNumber(raw.y1), x2 = finiteNumber(raw.x2), y2 = finiteNumber(raw.y2);
    return x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined
      ? { kind: "linear", x1, y1, x2, y2, stops }
      : undefined;
  }
  if (raw.kind === "radial") {
    const cx = finiteNumber(raw.cx), cy = finiteNumber(raw.cy), r = finiteNumber(raw.r);
    const fx = finiteNumber(raw.fx), fy = finiteNumber(raw.fy);
    return cx !== undefined && cy !== undefined && r !== undefined
      ? { kind: "radial", cx, cy, r, ...(fx !== undefined ? { fx } : {}), ...(fy !== undefined ? { fy } : {}), stops }
      : undefined;
  }
  return undefined;
}

export function sanitizeSimulidePaintStateFill(value: unknown): SimulidePaintStateFill | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.prop !== "string" || !raw.prop.trim()) return undefined;
  const map = typeof raw.map === "object" && raw.map !== null
    ? Object.fromEntries(
        Object.entries(raw.map as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      )
    : undefined;
  const numeric = Array.isArray(raw.numeric)
    ? raw.numeric
        .map((rule): { op: ">" | ">=" | "<" | "<=" | "==" | "!="; value?: number; valueProp?: string; color: string } | undefined => {
          if (typeof rule !== "object" || rule === null) return undefined;
          const rawRule = rule as Record<string, unknown>;
          const op = rawRule.op;
          const value = finiteNumber(rawRule.value);
          const valueProp = typeof rawRule.valueProp === "string" && rawRule.valueProp.trim() ? rawRule.valueProp : undefined;
          return (op === ">" || op === ">=" || op === "<" || op === "<=" || op === "==" || op === "!=") && (value !== undefined || valueProp) && typeof rawRule.color === "string"
            ? { op, ...(value !== undefined ? { value } : {}), ...(valueProp ? { valueProp } : {}), color: rawRule.color }
            : undefined;
        })
        .filter((rule): rule is { op: ">" | ">=" | "<" | "<=" | "==" | "!="; value?: number; valueProp?: string; color: string } => Boolean(rule))
    : undefined;
  return (map && Object.keys(map).length > 0) || (numeric && numeric.length > 0)
    ? { prop: raw.prop, ...(map && Object.keys(map).length > 0 ? { map } : {}), ...(numeric && numeric.length > 0 ? { numeric } : {}), ...(typeof raw.fallback === "string" ? { fallback: raw.fallback } : {}) }
    : undefined;
}

export function sanitizeSimulidePaintStateVisible(value: unknown): SimulidePaintStateVisible | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const whenRaw = typeof raw.when === "object" && raw.when !== null ? raw.when as Record<string, unknown> : undefined;
  if (!whenRaw) return undefined;
  const when: Record<string, string[]> = {};
  for (const [prop, acceptedRaw] of Object.entries(whenRaw)) {
    if (!prop.trim()) continue;
    const accepted = Array.isArray(acceptedRaw)
      ? acceptedRaw.map((item) => String(item)).filter(Boolean)
      : typeof acceptedRaw === "string" || typeof acceptedRaw === "number" || typeof acceptedRaw === "boolean"
        ? [String(acceptedRaw)]
        : [];
    if (accepted.length > 0) when[prop] = accepted;
  }
  return Object.keys(when).length > 0 ? { when } : undefined;
}

export function sanitizeSimulidePaintStateHref(value: unknown): SimulidePaintStateHref | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.prop !== "string" || !raw.prop.trim()) return undefined;
  if (typeof raw.map !== "object" || raw.map === null) return undefined;
  const map = Object.fromEntries(
    Object.entries(raw.map as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  return Object.keys(map).length > 0 ? { prop: raw.prop, map } : undefined;
}

export function sanitizeSimulidePaintStateText(value: unknown): SimulidePaintStateText | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "meterDisplay") {
    return typeof raw.unit === "string" ? { kind: "meterDisplay", unit: raw.unit } : undefined;
  }
  if (raw.kind === "frequencyDisplay") return { kind: "frequencyDisplay" };
  if (raw.kind === "readout") {
    return {
      kind: "readout",
      ...(typeof raw.unit === "string" ? { unit: raw.unit } : {}),
      ...(finiteNumber(raw.decimals) !== undefined ? { decimals: finiteNumber(raw.decimals) } : {}),
    };
  }
  if (raw.kind === "propertyChar") {
    const prop = sanitizeOptionalString(raw.prop);
    if (!prop) return undefined;
    return {
      kind: "propertyChar",
      prop,
      ...(sanitizeOptionalString(raw.rowIndex) ? { rowIndex: sanitizeOptionalString(raw.rowIndex) } : {}),
      ...(sanitizeOptionalString(raw.columnIndex) ? { columnIndex: sanitizeOptionalString(raw.columnIndex) } : {}),
      ...(sanitizeOptionalString(raw.columnsProp) ? { columnsProp: sanitizeOptionalString(raw.columnsProp) } : {}),
      ...(typeof raw.fallback === "string" ? { fallback: raw.fallback } : {}),
    };
  }
  if (raw.kind === "property") {
    const prop = sanitizeOptionalString(raw.prop);
    return prop ? { kind: "property", prop } : undefined;
  }
  return undefined;
}

export function sanitizeDominantBaseline(value: unknown): PackageShape["dominantBaseline"] | undefined {
  return value === "auto" ||
    value === "middle" ||
    value === "central" ||
    value === "hanging" ||
    value === "text-before-edge" ||
    value === "text-after-edge"
    ? value
    : undefined;
}

export function sanitizeSimulidePaintPrimitive(value: unknown): SimulidePaintPrimitive | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !SIMULIDE_PAINT_PRIMITIVE_KINDS.has(raw.kind)) return undefined;

  if (raw.kind === "repeat") {
    const count = finiteNumber(raw.count);
    const countProp = sanitizeOptionalString(raw.countProp);
    if (((count === undefined || count <= 0) && !countProp) || !Array.isArray(raw.primitives)) return undefined;
    const primitives = raw.primitives.map(sanitizeSimulidePaintPrimitive).filter((primitive): primitive is SimulidePaintPrimitive => Boolean(primitive));
    if (primitives.length === 0) return undefined;
    const stepX = finiteNumber(raw.stepX);
    const stepY = finiteNumber(raw.stepY);
    const stateVisibleRepeat = sanitizeSimulidePaintStateVisible(raw.stateVisible);
    return {
      kind: "repeat",
      ...(count !== undefined ? { count: Math.trunc(count) } : {}),
      ...(countProp ? { countProp } : {}),
      ...(sanitizeOptionalString(raw.indexName) ? { indexName: sanitizeOptionalString(raw.indexName) } : {}),
      ...(stepX !== undefined ? { stepX } : {}),
      ...(stepY !== undefined ? { stepY } : {}),
      primitives,
      ...(stateVisibleRepeat ? { stateVisible: stateVisibleRepeat } : {}),
    };
  }

  const style = sanitizeSimulidePaintStyle(raw);
  const stateFill = sanitizeSimulidePaintStateFill(raw.stateFill);
  const stateVisible = sanitizeSimulidePaintStateVisible(raw.stateVisible);
  const stateAttrs = { ...(stateFill ? { stateFill } : {}), ...(stateVisible ? { stateVisible } : {}) };

  if (raw.kind === "line") {
    const x1 = sanitizeNumberValue(raw.x1), y1 = sanitizeNumberValue(raw.y1), x2 = sanitizeNumberValue(raw.x2), y2 = sanitizeNumberValue(raw.y2);
    return x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined ? { kind: "line", x1, y1, x2, y2, ...stateAttrs, ...style } : undefined;
  }
  if (raw.kind === "rect" || raw.kind === "roundedRect") {
    const x = sanitizeNumberValue(raw.x), y = sanitizeNumberValue(raw.y), w = sanitizeNumberValue(raw.w), h = sanitizeNumberValue(raw.h);
    if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
    const rx = sanitizeNumberValue(raw.rx);
    const ry = sanitizeNumberValue(raw.ry);
    return raw.kind === "roundedRect"
      ? { kind: "roundedRect", x, y, w, h, rx: rx ?? 0, ry: ry ?? rx ?? 0, ...stateAttrs, ...style }
      : { kind: "rect", x, y, w, h, ...(rx !== undefined ? { rx } : {}), ...(ry !== undefined ? { ry } : {}), ...stateAttrs, ...style };
  }
  if (raw.kind === "ellipse") {
    const cx = sanitizeNumberValue(raw.cx), cy = sanitizeNumberValue(raw.cy), rx = sanitizeNumberValue(raw.rx), ry = sanitizeNumberValue(raw.ry);
    return cx !== undefined && cy !== undefined && rx !== undefined && ry !== undefined ? { kind: "ellipse", cx, cy, rx, ry, ...stateAttrs, ...style } : undefined;
  }
  if (raw.kind === "arc") {
    const x = sanitizeNumberValue(raw.x), y = sanitizeNumberValue(raw.y), w = sanitizeNumberValue(raw.w), h = sanitizeNumberValue(raw.h);
    const startDeg = sanitizeNumberValue(raw.startDeg), spanDeg = sanitizeNumberValue(raw.spanDeg);
    return x !== undefined && y !== undefined && w !== undefined && h !== undefined && startDeg !== undefined && spanDeg !== undefined
      ? { kind: "arc", x, y, w, h, startDeg, spanDeg, ...stateAttrs, ...style }
      : undefined;
  }
  if (raw.kind === "path") {
    return typeof raw.d === "string" && raw.d.trim() ? { kind: "path", d: raw.d, ...stateAttrs, ...style } : undefined;
  }
  if (raw.kind === "polygon" || raw.kind === "polyline") {
    const points = sanitizePointList(raw.points);
    return points ? { kind: raw.kind, points, ...stateAttrs, ...style } : undefined;
  }
  if (raw.kind === "text") {
    const x = sanitizeNumberValue(raw.x), y = sanitizeNumberValue(raw.y);
    if (x === undefined || y === undefined || typeof raw.value !== "string") return undefined;
    const textAnchor = raw.textAnchor === "start" || raw.textAnchor === "middle" || raw.textAnchor === "end" ? raw.textAnchor : undefined;
    return {
      kind: "text",
      x,
      y,
      value: raw.value,
      ...(sanitizeNumberValue(raw.fontSize) !== undefined ? { fontSize: sanitizeNumberValue(raw.fontSize) } : {}),
      ...(textAnchor ? { textAnchor } : {}),
      ...(sanitizeDominantBaseline(raw.dominantBaseline) ? { dominantBaseline: sanitizeDominantBaseline(raw.dominantBaseline) } : {}),
      ...(sanitizeOptionalString(raw.fontFamily) ? { fontFamily: sanitizeOptionalString(raw.fontFamily) } : {}),
      ...(typeof raw.fontWeight === "string" || typeof raw.fontWeight === "number" ? { fontWeight: raw.fontWeight } : {}),
      ...(sanitizeSimulidePaintStateText(raw.stateText) ? { stateText: sanitizeSimulidePaintStateText(raw.stateText) } : {}),
      ...stateAttrs,
      ...style,
    };
  }
  const x = sanitizeNumberValue(raw.x), y = sanitizeNumberValue(raw.y), w = sanitizeNumberValue(raw.w), h = sanitizeNumberValue(raw.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined || typeof raw.href !== "string" || !raw.href.trim()) return undefined;
  const stateHref = sanitizeSimulidePaintStateHref(raw.stateHref);
  return { kind: "image", x, y, w, h, href: raw.href, ...(sanitizeOptionalString(raw.preserveAspectRatio) ? { preserveAspectRatio: sanitizeOptionalString(raw.preserveAspectRatio) } : {}), ...stateAttrs, ...(stateHref ? { stateHref } : {}), ...style };
}

export function sanitizeSimulidePaintSpec(value: unknown): SimulidePaintSpec | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const boundsRaw = typeof raw.bounds === "object" && raw.bounds !== null ? raw.bounds as Record<string, unknown> : undefined;
  const x = finiteNumber(boundsRaw?.x), y = finiteNumber(boundsRaw?.y), w = finiteNumber(boundsRaw?.w), h = finiteNumber(boundsRaw?.h);
  if (raw.version !== 1 || x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) return undefined;
  if (!Array.isArray(raw.primitives)) return undefined;
  const primitives = raw.primitives
    .map(sanitizeSimulidePaintPrimitive)
    .filter((primitive): primitive is SimulidePaintPrimitive => Boolean(primitive));
  if (primitives.length === 0) return undefined;
  const sourceRaw = typeof raw.source === "object" && raw.source !== null ? raw.source as Record<string, unknown> : undefined;
  return {
    version: 1,
    source: sourceRaw
      ? {
          ...(sanitizeOptionalString(sourceRaw.file) ? { file: sanitizeOptionalString(sourceRaw.file) } : {}),
          ...(sanitizeOptionalString(sourceRaw.className) ? { className: sanitizeOptionalString(sourceRaw.className) } : {}),
          ...(sanitizeOptionalString(sourceRaw.method) ? { method: sanitizeOptionalString(sourceRaw.method) } : {}),
          ...(sanitizeOptionalString(sourceRaw.notes) ? { notes: sanitizeOptionalString(sourceRaw.notes) } : {}),
        }
      : undefined,
    bounds: { x, y, w, h },
    ...(sanitizeOptionalString(raw.defaultStroke) ? { defaultStroke: sanitizeOptionalString(raw.defaultStroke) } : {}),
    ...(sanitizeOptionalString(raw.defaultFill) ? { defaultFill: sanitizeOptionalString(raw.defaultFill) } : {}),
    ...(finiteNumber(raw.defaultStrokeWidth) !== undefined ? { defaultStrokeWidth: finiteNumber(raw.defaultStrokeWidth) } : {}),
    primitives,
  };
}

export function sanitizeSimulideQtWidgetSpec(value: unknown): SimulideQtWidgetSpec | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "plotBase") return undefined;
  if (raw.variant !== "oscope" && raw.variant !== "logicAnalyzer") return undefined;
  const channels = finiteNumber(raw.channels);
  const tracks = finiteNumber(raw.tracks);
  const sourceRaw = typeof raw.source === "object" && raw.source !== null ? raw.source as Record<string, unknown> : undefined;
  return channels !== undefined && channels > 0
    ? {
        kind: "plotBase",
        variant: raw.variant,
        channels,
        ...(tracks !== undefined ? { tracks } : {}),
        source: sourceRaw
          ? {
              ...(sanitizeOptionalString(sourceRaw.file) ? { file: sanitizeOptionalString(sourceRaw.file) } : {}),
              ...(sanitizeOptionalString(sourceRaw.className) ? { className: sanitizeOptionalString(sourceRaw.className) } : {}),
              ...(sanitizeOptionalString(sourceRaw.method) ? { method: sanitizeOptionalString(sourceRaw.method) } : {}),
              ...(sanitizeOptionalString(sourceRaw.notes) ? { notes: sanitizeOptionalString(sourceRaw.notes) } : {}),
            }
          : undefined,
      }
    : undefined;
}

export function isNumberPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number";
}

export function isViewSpecScalar(value: unknown): value is boolean | number | string {
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

/** Princípio do arquivo único (`.spec/lasecsimul-native-devices.spec` seção 14): `defaultProperties`
 * do catálogo vem SEMPRE do próprio manifesto (`.lsdevice`/`.lssubcircuit`) -- nunca de um arquivo
 * separado. */
export function sanitizeManifestDefaultProperties(value: unknown): Record<string, string | number | boolean> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") out[key] = raw;
  }
  return out;
}

export function sanitizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function sanitizeViewSpecAxisMapping(value: unknown): ViewSpecAxisMapping | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.prop !== "string" || !raw.prop.trim()) return undefined;
  if (!isNumberPair(raw.propRange) || !isNumberPair(raw.pixelRange)) return undefined;
  return { prop: raw.prop, propRange: raw.propRange, pixelRange: raw.pixelRange };
}

export function sanitizeViewSpecGradient(value: unknown): ViewSpecGradient | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !VIEW_SPEC_GRADIENT_KINDS.has(raw.kind)) return undefined;
  const stopsRaw = Array.isArray(raw.stops) ? raw.stops : [];
  const stops = stopsRaw
    .map((stop) => {
      if (typeof stop !== "object" || stop === null) return undefined;
      const rawStop = stop as Record<string, unknown>;
      if (typeof rawStop.offset !== "string" || typeof rawStop.color !== "string") return undefined;
      return { offset: rawStop.offset, color: rawStop.color };
    })
    .filter((stop): stop is { offset: string; color: string } => Boolean(stop));
  if (stops.length === 0) return undefined;
  const gradientUnits =
    raw.gradientUnits === "objectBoundingBox" || raw.gradientUnits === "userSpaceOnUse"
      ? raw.gradientUnits
      : undefined;
  if (raw.kind === "radial") {
    if (typeof raw.cx !== "number" || typeof raw.cy !== "number" || typeof raw.r !== "number") return undefined;
    return {
      kind: "radial",
      cx: raw.cx,
      cy: raw.cy,
      r: raw.r,
      fx: typeof raw.fx === "number" ? raw.fx : undefined,
      fy: typeof raw.fy === "number" ? raw.fy : undefined,
      gradientUnits,
      stops,
    };
  }
  if (typeof raw.x1 !== "number" || typeof raw.y1 !== "number" || typeof raw.x2 !== "number" || typeof raw.y2 !== "number") return undefined;
  return { kind: "linear", x1: raw.x1, y1: raw.y1, x2: raw.x2, y2: raw.y2, gradientUnits, stops };
}

export function sanitizeViewSpecHitTest(value: unknown): ViewSpecHitTest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !VIEW_SPEC_HIT_TEST_KINDS.has(raw.kind)) return undefined;
  const cursor = sanitizeOptionalString(raw.cursor);
  if (raw.kind === "rect") {
    if (typeof raw.x !== "number" || typeof raw.y !== "number" || typeof raw.w !== "number" || typeof raw.h !== "number") return undefined;
    return { kind: "rect", x: raw.x, y: raw.y, w: raw.w, h: raw.h, ...(cursor ? { cursor } : {}) };
  }
  if (raw.kind === "circle") {
    if (typeof raw.cx !== "number" || typeof raw.cy !== "number" || typeof raw.r !== "number") return undefined;
    return { kind: "circle", cx: raw.cx, cy: raw.cy, r: raw.r, ...(cursor ? { cursor } : {}) };
  }
  if (raw.kind === "ellipse") {
    if (typeof raw.cx !== "number" || typeof raw.cy !== "number" || typeof raw.rx !== "number" || typeof raw.ry !== "number") return undefined;
    return { kind: "ellipse", cx: raw.cx, cy: raw.cy, rx: raw.rx, ry: raw.ry, ...(cursor ? { cursor } : {}) };
  }
  if (raw.kind === "polygon") {
    const points = Array.isArray(raw.points)
      ? raw.points
          .map((point) => {
            if (typeof point !== "object" || point === null) return undefined;
            const rawPoint = point as Record<string, unknown>;
            return typeof rawPoint.x === "number" && typeof rawPoint.y === "number" ? { x: rawPoint.x, y: rawPoint.y } : undefined;
          })
          .filter((point): point is { x: number; y: number } => Boolean(point))
      : [];
    return points.length > 0 ? { kind: "polygon", points, ...(cursor ? { cursor } : {}) } : undefined;
  }
  if (typeof raw.d !== "string" || !raw.d.trim()) return undefined;
  return { kind: "path", d: raw.d, ...(cursor ? { cursor } : {}) };
}

export function sanitizeViewSpecLimit(value: unknown): ViewSpecLimit | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const limit: ViewSpecLimit = {};
  if (typeof raw.min === "number") limit.min = raw.min;
  if (typeof raw.max === "number") limit.max = raw.max;
  if (typeof raw.step === "number") limit.step = raw.step;
  if (typeof raw.center === "number") limit.center = raw.center;
  if (typeof raw.radius === "number") limit.radius = raw.radius;
  if (typeof raw.minAngleDeg === "number") limit.minAngleDeg = raw.minAngleDeg;
  if (typeof raw.maxAngleDeg === "number") limit.maxAngleDeg = raw.maxAngleDeg;
  if (typeof raw.clamp === "boolean") limit.clamp = raw.clamp;
  return Object.keys(limit).length > 0 ? limit : undefined;
}

export function sanitizeViewSpecPart(value: unknown): ViewSpecPart | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const paint = Array.isArray(raw.paint)
    ? raw.paint.map(sanitizePackageShape).filter((shape): shape is PackageShape => Boolean(shape))
    : undefined;
  const hitTest = typeof raw.hitTest === "string" && raw.hitTest.trim()
    ? raw.hitTest.trim()
    : sanitizeViewSpecHitTest(raw.hitTest);
  const originRaw = raw.origin;
  const originRecord = typeof originRaw === "object" && originRaw !== null ? originRaw as Record<string, unknown> : undefined;
  const originX = typeof originRecord?.x === "number" ? originRecord.x : undefined;
  const originY = typeof originRecord?.y === "number" ? originRecord.y : undefined;
  const origin =
    originX !== undefined && originY !== undefined
      ? { x: originX, y: originY }
      : undefined;
  const part: ViewSpecPart = {
    ...(sanitizeOptionalString(raw.role) ? { role: sanitizeOptionalString(raw.role) } : {}),
    ...(paint && paint.length > 0 ? { paint } : {}),
    ...(hitTest ? { hitTest } : {}),
    ...(sanitizeOptionalString(raw.interaction) ? { interaction: sanitizeOptionalString(raw.interaction) } : {}),
    ...(origin ? { origin } : {}),
    ...(typeof raw.movable === "boolean" ? { movable: raw.movable } : {}),
    ...(sanitizeOptionalString(raw.cursor) ? { cursor: sanitizeOptionalString(raw.cursor) } : {}),
  };
  return Object.keys(part).length > 0 ? part : undefined;
}

export function sanitizeViewSpecInteraction(value: unknown): ViewSpecInteraction | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !VIEW_SPEC_INTERACTION_KINDS.has(raw.kind)) return undefined;
  const common = {
    ...(sanitizeOptionalString(raw.partId) ? { partId: sanitizeOptionalString(raw.partId) } : {}),
    ...(sanitizeOptionalString(raw.hitTest) ? { hitTest: sanitizeOptionalString(raw.hitTest) } : {}),
    ...(sanitizeOptionalString(raw.limits) ? { limits: sanitizeOptionalString(raw.limits) } : {}),
  };
  if (raw.kind === "dragVector") {
    const x = sanitizeViewSpecAxisMapping(raw.x);
    const y = sanitizeViewSpecAxisMapping(raw.y);
    if (!x && !y) return undefined;
    return {
      kind: "dragVector",
      ...common,
      ...(x ? { x } : {}),
      ...(y ? { y } : {}),
      ...(typeof raw.springBack === "boolean" ? { springBack: raw.springBack } : {}),
      ...(sanitizeOptionalString(raw.pressedProp) ? { pressedProp: sanitizeOptionalString(raw.pressedProp) } : {}),
    };
  }
  if (raw.kind === "dragAngular") {
    if (typeof raw.prop !== "string" || !raw.prop.trim()) return undefined;
    if (typeof raw.cx !== "number" || typeof raw.cy !== "number") return undefined;
    return {
      kind: "dragAngular",
      ...common,
      prop: raw.prop,
      cx: raw.cx,
      cy: raw.cy,
      ...(typeof raw.stepsPerRev === "number" && raw.stepsPerRev > 0 ? { stepsPerRev: raw.stepsPerRev } : {}),
      ...(sanitizeOptionalString(raw.stepsPerRevProp) ? { stepsPerRevProp: sanitizeOptionalString(raw.stepsPerRevProp) } : {}),
      ...(typeof raw.continuous === "boolean" ? { continuous: raw.continuous } : {}),
    };
  }
  if (raw.kind === "touchPoint") {
    const x = sanitizeViewSpecAxisMapping(raw.x);
    const y = sanitizeViewSpecAxisMapping(raw.y);
    if (!x || !y) return undefined;
    return {
      kind: "touchPoint",
      ...common,
      x,
      y,
      ...(sanitizeOptionalString(raw.pressedProp) ? { pressedProp: sanitizeOptionalString(raw.pressedProp) } : {}),
    };
  }
  if (raw.kind === "press") {
    if (typeof raw.prop !== "string" || !raw.prop.trim()) return undefined;
    return {
      kind: "press",
      ...common,
      prop: raw.prop,
      ...(isViewSpecScalar(raw.pressedValue) ? { pressedValue: raw.pressedValue } : {}),
      ...(isViewSpecScalar(raw.releasedValue) ? { releasedValue: raw.releasedValue } : {}),
    };
  }
  if (raw.kind === "toggle") {
    if (typeof raw.prop !== "string" || !raw.prop.trim()) return undefined;
    const values = Array.isArray(raw.values) && raw.values.length === 2 && isViewSpecScalar(raw.values[0]) && isViewSpecScalar(raw.values[1])
      ? [raw.values[0], raw.values[1]] satisfies [boolean | number | string, boolean | number | string]
      : undefined;
    return { kind: "toggle", ...common, prop: raw.prop, ...(values ? { values } : {}) };
  }
  if (raw.axis !== "x" && raw.axis !== "y") return undefined;
  if (typeof raw.prop !== "string" || !raw.prop.trim()) return undefined;
  if (!isNumberPair(raw.propRange) || !isNumberPair(raw.pixelRange)) return undefined;
  return { kind: "slider", ...common, axis: raw.axis, prop: raw.prop, propRange: raw.propRange, pixelRange: raw.pixelRange };
}

export function sanitizeViewSpecProjection(value: unknown): ViewSpecProjection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !VIEW_SPEC_PROJECTION_KINDS.has(raw.kind)) return undefined;
  if (raw.kind === "translate") {
    const x = sanitizeViewSpecAxisMapping(raw.x);
    const y = sanitizeViewSpecAxisMapping(raw.y);
    if (!x && !y) return undefined;
    return { kind: "translate", ...(x ? { x } : {}), ...(y ? { y } : {}) };
  }
  if (raw.kind === "rotate") {
    if (typeof raw.prop !== "string" || !raw.prop.trim()) return undefined;
    if (typeof raw.stepsPerRev !== "number" || raw.stepsPerRev <= 0) return undefined;
    if (typeof raw.cx !== "number" || typeof raw.cy !== "number") return undefined;
    return {
      kind: "rotate",
      prop: raw.prop,
      stepsPerRev: raw.stepsPerRev,
      ...(sanitizeOptionalString(raw.stepsPerRevProp) ? { stepsPerRevProp: sanitizeOptionalString(raw.stepsPerRevProp) } : {}),
      cx: raw.cx,
      cy: raw.cy,
      ...(isNumberPair(raw.propRange) ? { propRange: raw.propRange } : {}),
      ...(isNumberPair(raw.angleRange) ? { angleRange: raw.angleRange } : {}),
    };
  }
  if (raw.kind === "fill") {
    if (typeof raw.prop !== "string" || !raw.prop.trim()) return undefined;
    if (typeof raw.map !== "object" || raw.map === null) return undefined;
    const map = Object.fromEntries(
      Object.entries(raw.map as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
    return Object.keys(map).length > 0 ? { kind: "fill", prop: raw.prop, map } : undefined;
  }
  if (typeof raw.prop !== "string" || !raw.prop.trim()) return undefined;
  return { kind: "visible", prop: raw.prop, invert: typeof raw.invert === "boolean" ? raw.invert : undefined };
}

export function imageMimeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  return "image/png";
}

export function sanitizePackageBackground(value: unknown, assetBasePath?: string): PackageDescriptor["background"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string") return undefined;
  const kind = raw.kind;
  if (kind !== "color" && kind !== "svg" && kind !== "image" && kind !== "none") return undefined;

  let data = typeof raw.data === "string" ? raw.data : undefined;
  let mime = typeof raw.mime === "string" && raw.mime.trim() ? raw.mime.trim() : undefined;
  const asset = sanitizeOptionalString(raw.asset);
  if (kind === "image" && !data && asset && assetBasePath) {
    const assetPath = normalizeAbsolutePath(assetBasePath, asset);
    if (fileExists(assetPath)) {
      data = fs.readFileSync(assetPath).toString("base64");
      mime = mime ?? imageMimeForFile(assetPath);
    }
  }

  return {
    kind,
    value: typeof raw.value === "string" ? raw.value : undefined,
    data,
    asset,
    mime,
  };
}

export function sanitizePackageValueLabel(value: unknown): PackageDescriptor["valueLabel"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const x = finiteNumber(raw.x);
  const y = finiteNumber(raw.y);
  if (x === undefined || y === undefined) return undefined;
  const rotation = raw.rotation === -90 || raw.rotation === 0 || raw.rotation === 90 || raw.rotation === 180 || raw.rotation === 270
    ? raw.rotation
    : undefined;
  return { x, y, ...(rotation !== undefined ? { rotation } : {}) };
}

export function sanitizeComponentViewSpec(value: unknown): ComponentViewSpec | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const paint = Array.isArray(raw.paint)
    ? raw.paint.map(sanitizePackageShape).filter((shape): shape is PackageShape => Boolean(shape))
    : [];

  const gradients: Record<string, ViewSpecGradient> = {};
  if (typeof raw.gradients === "object" && raw.gradients !== null) {
    for (const [name, gradientRaw] of Object.entries(raw.gradients as Record<string, unknown>)) {
      const gradient = sanitizeViewSpecGradient(gradientRaw);
      if (gradient) gradients[name] = gradient;
    }
  }

  const parts: Record<string, ViewSpecPart> = {};
  if (typeof raw.parts === "object" && raw.parts !== null) {
    for (const [partId, partRaw] of Object.entries(raw.parts as Record<string, unknown>)) {
      const part = sanitizeViewSpecPart(partRaw);
      if (part) parts[partId] = part;
    }
  }

  const hitTest: Record<string, ViewSpecHitTest> = {};
  if (typeof raw.hitTest === "object" && raw.hitTest !== null) {
    for (const [hitTestId, hitTestRaw] of Object.entries(raw.hitTest as Record<string, unknown>)) {
      const region = sanitizeViewSpecHitTest(hitTestRaw);
      if (region) hitTest[hitTestId] = region;
    }
  }

  const interaction: Record<string, ViewSpecInteraction> = {};
  if (typeof raw.interaction === "object" && raw.interaction !== null) {
    for (const [interactionId, interactionRaw] of Object.entries(raw.interaction as Record<string, unknown>)) {
      const item = sanitizeViewSpecInteraction(interactionRaw);
      if (item) interaction[interactionId] = item;
    }
  }

  const limits: Record<string, ViewSpecLimit> = {};
  if (typeof raw.limits === "object" && raw.limits !== null) {
    for (const [limitId, limitRaw] of Object.entries(raw.limits as Record<string, unknown>)) {
      const limit = sanitizeViewSpecLimit(limitRaw);
      if (limit) limits[limitId] = limit;
    }
  }

  const stateProjection: Record<string, ViewSpecProjection[]> = {};
  if (typeof raw.stateProjection === "object" && raw.stateProjection !== null) {
    for (const [partId, projectionsRaw] of Object.entries(raw.stateProjection as Record<string, unknown>)) {
      if (!Array.isArray(projectionsRaw)) continue;
      const projections = projectionsRaw
        .map(sanitizeViewSpecProjection)
        .filter((projection): projection is ViewSpecProjection => Boolean(projection));
      if (projections.length > 0) stateProjection[partId] = projections;
    }
  }

  if (
    paint.length === 0 &&
    Object.keys(parts).length === 0 &&
    Object.keys(hitTest).length === 0 &&
    Object.keys(interaction).length === 0
  ) {
    return undefined;
  }

  return {
    ...(Object.keys(gradients).length > 0 ? { gradients } : {}),
    ...(raw.overlayPaint === true ? { overlayPaint: true } : {}),
    ...(Object.keys(parts).length > 0 ? { parts } : {}),
    ...(Object.keys(hitTest).length > 0 ? { hitTest } : {}),
    ...(Object.keys(interaction).length > 0 ? { interaction } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    paint,
    ...(Object.keys(stateProjection).length > 0 ? { stateProjection } : {}),
  };
}

/** Confia na mesma medida que `.lsdevice`/`.lssubcircuit` já são confiados pelo resto do chamador
 * (são manifestos de primeira parte ou já passaram por consentimento de plugin antes de chegar aqui,
 * ver `extension.ts::ensureLibraryTrusted`) — valida só a forma estrutural mínima (presença e tipo
 * dos campos numéricos obrigatórios), não cada combinação de campo por `kind`. */
function sanitizeDynamicPinGroup(value: unknown): PackageDynamicPinGroup | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const countProp = sanitizeOptionalString(raw.countProp);
  const x = sanitizeNumberValue(raw.x);
  const y = sanitizeNumberValue(raw.y);
  if (!countProp || x === undefined || y === undefined) return undefined;
  const angle = sanitizeNumberValue(raw.angle) ?? 0;
  const length = sanitizeNumberValue(raw.length) ?? 8;
  const terminalX = legacyBodyCoordinate(x, angle, length, "x", raw.leadOrigin);
  const terminalY = legacyBodyCoordinate(y, angle, length, "y", raw.leadOrigin);
  return {
    countProp,
    ...(raw.countFn === "log2Ceil" ? { countFn: raw.countFn } : {}),
    ...(sanitizeOptionalString(raw.indexName) ? { indexName: sanitizeOptionalString(raw.indexName) } : {}),
    ...(sanitizeOptionalString(raw.idPrefix) ? { idPrefix: sanitizeOptionalString(raw.idPrefix) } : {}),
    ...(sanitizeNumberValue(raw.idStart) !== undefined ? { idStart: sanitizeNumberValue(raw.idStart) } : {}),
    x: terminalX,
    y: terminalY,
    ...(sanitizeNumberValue(raw.angle) !== undefined ? { angle } : {}),
    ...(sanitizeNumberValue(raw.length) !== undefined ? { length } : {}),
    ...(sanitizeNumberValue(raw.leadEndTrim) !== undefined ? { leadEndTrim: sanitizeNumberValue(raw.leadEndTrim) } : {}),
    ...(sanitizeOptionalString(raw.leadColor) ? { leadColor: sanitizeOptionalString(raw.leadColor) } : {}),
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
  };
}

/** Adaptador de entrada para manifestos antigos que declaravam explicitamente o contato no corpo.
 * O restante do sistema nunca recebe essa dupla semântica: daqui em diante `x/y` é terminal. */
function legacyBodyCoordinate(
  value: PackageNumberValue,
  angle: PackageNumberValue,
  length: PackageNumberValue,
  axis: "x" | "y",
  legacyOrigin: unknown,
): PackageNumberValue {
  if (legacyOrigin !== "body") return value;
  if (typeof angle !== "number" || typeof length !== "number") return value;
  const radians = angle * Math.PI / 180;
  // `Pin::paint`: terminal→corpo é rotacionado por `180-angle`; portanto corpo→terminal é
  // `(cos(angle), -sin(angle)) * length` nas coordenadas Qt/SVG (Y cresce para baixo).
  const delta = (axis === "x" ? Math.cos(radians) : -Math.sin(radians)) * length;
  if (Math.abs(delta) < 1e-12) return value;
  if (typeof value === "number") return value + delta;
  return { ...value, offset: (value.offset ?? 0) + delta };
}

function sanitizeDynamicLayout(value: unknown): PackageDynamicLayout | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const boundsRaw = typeof raw.simulideBounds === "object" && raw.simulideBounds !== null ? raw.simulideBounds as Record<string, unknown> : {};
  const simulideBounds = {
    ...(sanitizeNumberValue(boundsRaw.x) !== undefined ? { x: sanitizeNumberValue(boundsRaw.x) } : {}),
    ...(sanitizeNumberValue(boundsRaw.y) !== undefined ? { y: sanitizeNumberValue(boundsRaw.y) } : {}),
    ...(sanitizeNumberValue(boundsRaw.w) !== undefined ? { w: sanitizeNumberValue(boundsRaw.w) } : {}),
    ...(sanitizeNumberValue(boundsRaw.h) !== undefined ? { h: sanitizeNumberValue(boundsRaw.h) } : {}),
  };
  const pinGroups = Array.isArray(raw.pinGroups)
    ? raw.pinGroups.map(sanitizeDynamicPinGroup).filter((group): group is PackageDynamicPinGroup => Boolean(group))
    : [];
  const out: PackageDynamicLayout = {
    ...(sanitizeNumberValue(raw.width) !== undefined ? { width: sanitizeNumberValue(raw.width) } : {}),
    ...(sanitizeNumberValue(raw.height) !== undefined ? { height: sanitizeNumberValue(raw.height) } : {}),
    ...(sanitizeNumberValue(raw.schematicWidth) !== undefined ? { schematicWidth: sanitizeNumberValue(raw.schematicWidth) } : {}),
    ...(sanitizeNumberValue(raw.schematicHeight) !== undefined ? { schematicHeight: sanitizeNumberValue(raw.schematicHeight) } : {}),
    ...(Object.keys(simulideBounds).length > 0 ? { simulideBounds } : {}),
    ...(typeof raw.replacePins === "boolean" ? { replacePins: raw.replacePins } : {}),
    ...(pinGroups.length > 0 ? { pinGroups } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

export function sanitizePackage(value: unknown, assetBasePath?: string): PackageDescriptor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.width !== "number" || typeof raw.height !== "number") return undefined;
  const dynamicLayout = sanitizeDynamicLayout(raw.dynamicLayout);
  const rawPins = Array.isArray(raw.pins) ? raw.pins : [];

  const pins: PackagePin[] = [];
  for (const pinValue of rawPins) {
    if (typeof pinValue !== "object" || pinValue === null) continue;
    const pin = pinValue as Record<string, unknown>;
    if (typeof pin.id !== "string" || !pin.id.trim()) continue;
    const x = sanitizeNumberValue(pin.x);
    const y = sanitizeNumberValue(pin.y);
    if (x === undefined || y === undefined) continue;
    const angle = sanitizeNumberValue(pin.angle) ?? 0;
    const length = sanitizeNumberValue(pin.length) ?? 8;
    pins.push({
      id: pin.id,
      aliases: Array.isArray(pin.aliases) ? pin.aliases.filter((alias): alias is string => typeof alias === "string" && Boolean(alias.trim())) : undefined,
      stateVisible: sanitizeSimulidePaintStateVisible(pin.stateVisible),
      kind: typeof pin.kind === "string" ? pin.kind : undefined,
      x: legacyBodyCoordinate(x, angle, length, "x", pin.leadOrigin),
      y: legacyBodyCoordinate(y, angle, length, "y", pin.leadOrigin),
      angle,
      length,
      leadEndTrim: sanitizeNumberValue(pin.leadEndTrim),
      leadColor: typeof pin.leadColor === "string" ? pin.leadColor : undefined,
      label: typeof pin.label === "string" ? pin.label : undefined,
      labelColor: typeof pin.labelColor === "string" ? pin.labelColor : undefined,
      labelFontSize: sanitizeNumberValue(pin.labelFontSize),
      labelSpace: sanitizeNumberValue(pin.labelSpace),
      labelStateVisible: sanitizeSimulidePaintStateVisible(pin.labelStateVisible),
      labelHidden: typeof pin.labelHidden === "boolean" ? pin.labelHidden : undefined,
      labelTextAnchor: pin.labelTextAnchor === "start" || pin.labelTextAnchor === "middle" || pin.labelTextAnchor === "end" ? pin.labelTextAnchor : undefined,
      labelDominantBaseline: sanitizeDominantBaseline(pin.labelDominantBaseline),
      labelX: sanitizeNumberValue(pin.labelX),
      labelY: sanitizeNumberValue(pin.labelY),
      labelRotation: sanitizeNumberValue(pin.labelRotation),
    });
  }
  const shapes: PackageShape[] = [];
  if (Array.isArray(raw.shapes)) {
    for (const shapeValue of raw.shapes) {
      const shape = sanitizePackageShape(shapeValue);
      if (shape) shapes.push(shape);
    }
  }
  const viewSpec = sanitizeComponentViewSpec(raw.viewSpec);
  const simulidePaint = sanitizeSimulidePaintSpec(raw.simulidePaint);
  const qtWidget = sanitizeSimulideQtWidgetSpec(raw.qtWidget);

  const background = sanitizePackageBackground(raw.background, assetBasePath);

  // Um descritor sem pino algum ainda é válido quando tem OUTRO conteúdo visual real (shapes/
  // background/viewSpec) -- o Ícone do subcircuito (Modo Ícone) NUNCA tem pinos por definição
  // (ver `subcircuitDocument.ts`), então exigir pelo menos 1 pino aqui descartaria todo ícone
  // silenciosamente. Só um descritor totalmente vazio (nem pino, nem forma alguma) é tratado como
  // ausente/não-autorado.
  if (pins.length === 0 && !dynamicLayout?.pinGroups?.length && shapes.length === 0 && !background && !viewSpec && !simulidePaint) {
    return undefined;
  }

  return {
    width: raw.width,
    height: raw.height,
    coordinateSpace: raw.coordinateSpace === "simulide-local" ? raw.coordinateSpace : undefined,
    schematicWidth: typeof raw.schematicWidth === "number" ? raw.schematicWidth : undefined,
    schematicHeight: typeof raw.schematicHeight === "number" ? raw.schematicHeight : undefined,
    initialTransform: typeof raw.initialTransform === "object" && raw.initialTransform !== null
      ? {
          rotateDeg: typeof (raw.initialTransform as Record<string, unknown>).rotateDeg === "number" ? (raw.initialTransform as Record<string, unknown>).rotateDeg as number : undefined,
          cx: typeof (raw.initialTransform as Record<string, unknown>).cx === "number" ? (raw.initialTransform as Record<string, unknown>).cx as number : undefined,
          cy: typeof (raw.initialTransform as Record<string, unknown>).cy === "number" ? (raw.initialTransform as Record<string, unknown>).cy as number : undefined,
        }
      : undefined,
    border: typeof raw.border === "boolean" ? raw.border : undefined,
    background,
    pinMarker: raw.pinMarker === "packagePin" ? "packagePin" : undefined,
    shapes,
    simulidePaint,
    qtWidget,
    dynamicLayout,
    viewSpec,
    valueLabel: sanitizePackageValueLabel(raw.valueLabel),
    pins,
    pinLabelColor: typeof raw.pinLabelColor === "string" && raw.pinLabelColor.trim() ? raw.pinLabelColor : undefined,
  };
}

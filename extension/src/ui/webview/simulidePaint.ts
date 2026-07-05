import { PackageShape, SimulidePaintGradient, SimulidePaintPrimitive, SimulidePaintSpec } from "./model.js";

interface PaintTransform {
  x: (value: number) => number;
  y: (value: number) => number;
  sx: (value: number) => number;
  sy: (value: number) => number;
  sw: (value: number | undefined) => number | undefined;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function transformFor(spec: SimulidePaintSpec, width: number, height: number): PaintTransform {
  const sx = width / Math.max(1e-9, spec.bounds.w);
  const sy = height / Math.max(1e-9, spec.bounds.h);
  const strokeScale = (Math.abs(sx) + Math.abs(sy)) / 2;
  return {
    x: (value) => round((value - spec.bounds.x) * sx),
    y: (value) => round((value - spec.bounds.y) * sy),
    sx: (value) => round(value * sx),
    sy: (value) => round(value * sy),
    sw: (value) => value === undefined ? undefined : round(value * strokeScale),
  };
}

function stateFillFor(primitive: SimulidePaintPrimitive, properties: Record<string, unknown>): string | undefined {
  if (!primitive.stateFill) return undefined;
  const raw = properties[primitive.stateFill.prop];
  if (primitive.stateFill.map) {
    const mapped = primitive.stateFill.map[String(raw)];
    if (mapped !== undefined) return mapped;
  }
  if (primitive.stateFill.numeric) {
    const value = Number(raw);
    if (Number.isFinite(value)) {
      for (const rule of primitive.stateFill.numeric) {
        const compareRaw = rule.valueProp ? Number(properties[rule.valueProp]) : rule.value;
        if (!Number.isFinite(compareRaw)) continue;
        const compareTo = Number(compareRaw);
        if (
          (rule.op === ">" && value > compareTo) ||
          (rule.op === ">=" && value >= compareTo) ||
          (rule.op === "<" && value < compareTo) ||
          (rule.op === "<=" && value <= compareTo) ||
          (rule.op === "==" && value === compareTo) ||
          (rule.op === "!=" && value !== compareTo)
        ) return rule.color;
      }
    }
  }
  return primitive.stateFill.fallback;
}

function stateVisibleFor(primitive: SimulidePaintPrimitive, properties: Record<string, unknown>): boolean {
  if (!primitive.stateVisible) return true;
  for (const [prop, accepted] of Object.entries(primitive.stateVisible.when)) {
    if (!accepted.includes(String(properties[prop]))) return false;
  }
  return true;
}

function stateHrefFor(primitive: SimulidePaintPrimitive, properties: Record<string, unknown>): string | undefined {
  if (primitive.kind !== "image" || !primitive.stateHref) return undefined;
  const raw = properties[primitive.stateHref.prop];
  return primitive.stateHref.map[String(raw)];
}

function readoutNumber(properties: Record<string, unknown>): number {
  const value = properties.__readout;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function simulideUnitScale(value: number): { value: number; multiplier: string; decimals: number } {
  let scaled = value;
  const units = [" p", " n", " u", " m", " ", " k", " M", " G"];
  let unitIndex = 0;
  for (; unitIndex < units.length - 1 && Math.abs(scaled) > 999; unitIndex += 1) {
    scaled /= 1000;
  }
  const absScaled = Math.abs(scaled);
  const decimals = absScaled < 10 ? 3 : absScaled < 100 ? 2 : 1;
  return { value: scaled, multiplier: units[unitIndex] ?? "  ", decimals };
}

function formatFixed(value: number, decimals: number): string {
  return value.toFixed(Math.max(0, Math.trunc(decimals)));
}

function formatSimulideMeterDisplay(value: number, unit: string): string {
  let sign = " ";
  let scaled = Math.abs(value);
  if (scaled < 1e-9) scaled = 0;
  let multiplier = " ";
  let decimals = 3;
  if (scaled !== 0) {
    scaled *= 1e12;
    if (value < 0) sign = "-";
    const projected = simulideUnitScale(scaled);
    scaled = projected.value;
    multiplier = projected.multiplier;
    decimals = projected.decimals;
  }
  if (scaled > 999) return " ----";
  const numberText = formatFixed(scaled, decimals).slice(0, 5);
  return `${sign}${numberText}\n${multiplier}${unit}`;
}

function formatSimulideFrequencyDisplay(value: number): string {
  let freq = Math.max(0, value);
  let unit = "  Hz";
  if (freq > 999) { freq /= 1000; unit = " kHz"; }
  if (freq > 999) { freq /= 1000; unit = " MHz"; }
  if (freq > 999) { freq /= 1000; unit = " GHz"; }
  const decimals = freq < 10 ? 4 : freq < 100 ? 3 : 2;
  return `${formatFixed(freq, decimals)}${unit}`;
}

function stateTextFor(primitive: SimulidePaintPrimitive, properties: Record<string, unknown>): string | undefined {
  if (primitive.kind !== "text" || !primitive.stateText) return undefined;
  const readout = readoutNumber(properties);
  if (primitive.stateText.kind === "meterDisplay") return formatSimulideMeterDisplay(readout, primitive.stateText.unit);
  if (primitive.stateText.kind === "frequencyDisplay") return formatSimulideFrequencyDisplay(readout);
  const decimals = primitive.stateText.decimals ?? 2;
  return `${formatFixed(readout, decimals)}${primitive.stateText.unit ?? ""}`;
}

function gradientStops(stops: SimulidePaintGradient["stops"]): string {
  return stops
    .map((stop) => {
      const offset = typeof stop.offset === "number" ? `${Math.round(stop.offset * 1000) / 10}%` : stop.offset;
      return `<stop offset="${offset}" stop-color="${stop.color}"/>`;
    })
    .join("");
}

function gradientDefFor(
  gradient: SimulidePaintGradient | undefined,
  id: string,
  transform: PaintTransform
): string | undefined {
  if (!gradient || gradient.stops.length === 0) return undefined;
  const stops = gradientStops(gradient.stops);
  if (gradient.kind === "linear") {
    return `<linearGradient id="${id}" x1="${transform.x(gradient.x1)}" y1="${transform.y(gradient.y1)}" x2="${transform.x(gradient.x2)}" y2="${transform.y(gradient.y2)}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>`;
  }
  const fx = gradient.fx === undefined ? "" : ` fx="${transform.x(gradient.fx)}"`;
  const fy = gradient.fy === undefined ? "" : ` fy="${transform.y(gradient.fy)}"`;
  const r = Math.abs((transform.sx(gradient.r) + transform.sy(gradient.r)) / 2);
  return `<radialGradient id="${id}" cx="${transform.x(gradient.cx)}" cy="${transform.y(gradient.cy)}" r="${r}"${fx}${fy} gradientUnits="userSpaceOnUse">${stops}</radialGradient>`;
}

function styleFor(
  spec: SimulidePaintSpec,
  primitive: SimulidePaintPrimitive,
  transform: PaintTransform,
  properties: Record<string, unknown>,
  gradientId?: string
): Partial<PackageShape> {
  const projectedFill = stateFillFor(primitive, properties);
  return {
    stroke: primitive.stroke ?? spec.defaultStroke ?? "currentColor",
    fill: projectedFill ?? (gradientId ? `url(#${gradientId})` : primitive.fill ?? spec.defaultFill ?? "none"),
    strokeWidth: transform.sw(primitive.strokeWidth ?? spec.defaultStrokeWidth ?? 1),
    strokeLinecap: primitive.strokeLinecap,
    strokeLinejoin: primitive.strokeLinejoin,
    strokeDasharray: primitive.strokeDasharray,
    fillRule: primitive.fillRule,
    opacity: primitive.opacity,
    cssClass: primitive.cssClass,
  };
}

function pointList(points: Array<{ x: number; y: number }>, transform: PaintTransform): Array<{ x: number; y: number }> {
  return points.map((point) => ({ x: transform.x(point.x), y: transform.y(point.y) }));
}

function polylinePath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function simulidePaintArcPathD(
  x: number,
  y: number,
  w: number,
  h: number,
  startDeg: number,
  spanDeg: number,
  transform: PaintTransform
): string {
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  const startRad = (startDeg * Math.PI) / 180;
  const endRad = ((startDeg + spanDeg) * Math.PI) / 180;
  const startX = cx + rx * Math.cos(startRad);
  const startY = cy - ry * Math.sin(startRad);
  const endX = cx + rx * Math.cos(endRad);
  const endY = cy - ry * Math.sin(endRad);
  const largeArc = Math.abs(spanDeg) > 180 ? 1 : 0;
  const sweep = spanDeg < 0 ? 1 : 0;
  return `M ${transform.x(startX)} ${transform.y(startY)} A ${Math.abs(transform.sx(rx))} ${Math.abs(transform.sy(ry))} 0 ${largeArc} ${sweep} ${transform.x(endX)} ${transform.y(endY)}`;
}

function transformPathData(d: string, transform: PaintTransform): string {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let command = "";
  let coordinateIndex = 0;

  for (const token of tokens) {
    if (/^[a-zA-Z]$/.test(token)) {
      command = token;
      coordinateIndex = 0;
      out.push(token);
      continue;
    }
    const value = Number(token);
    if (!Number.isFinite(value)) {
      out.push(token);
      continue;
    }
    if (command === "H") out.push(String(transform.x(value)));
    else if (command === "V") out.push(String(transform.y(value)));
    else if (command === "h") out.push(String(transform.sx(value)));
    else if (command === "v") out.push(String(transform.sy(value)));
    else {
      const isRelative = command === command.toLowerCase();
      const isX = coordinateIndex % 2 === 0;
      const mapped = isRelative
        ? isX ? transform.sx(value) : transform.sy(value)
        : isX ? transform.x(value) : transform.y(value);
      out.push(String(mapped));
      coordinateIndex += 1;
    }
  }

  return out.join(" ");
}

export function simulidePaintToPackageShapes(
  spec: SimulidePaintSpec,
  width: number,
  height: number,
  properties: Record<string, unknown> = {},
  scopeId = "simulide-paint"
): PackageShape[] {
  const transform = transformFor(spec, width, height);
  const shapes: PackageShape[] = [];
  const defs: string[] = [];
  let gradientIndex = 0;

  for (const primitive of spec.primitives) {
    if (!stateVisibleFor(primitive, properties)) continue;
    const gradientId = primitive.fillGradient ? `${scopeId}-grad-${gradientIndex++}` : undefined;
    const gradientDef = gradientDefFor(primitive.fillGradient, gradientId ?? "", transform);
    if (gradientDef) defs.push(gradientDef);
    const style = styleFor(spec, primitive, transform, properties, gradientId);
    switch (primitive.kind) {
      case "line":
        shapes.push({ kind: "line", x1: transform.x(primitive.x1), y1: transform.y(primitive.y1), x2: transform.x(primitive.x2), y2: transform.y(primitive.y2), ...style });
        break;
      case "rect":
      case "roundedRect":
        shapes.push({
          kind: "rect",
          x: transform.x(primitive.x),
          y: transform.y(primitive.y),
          w: transform.sx(primitive.w),
          h: transform.sy(primitive.h),
          rx: primitive.rx === undefined ? undefined : Math.abs(transform.sx(primitive.rx)),
          ry: primitive.ry === undefined ? undefined : Math.abs(transform.sy(primitive.ry)),
          ...style,
        });
        break;
      case "ellipse":
        shapes.push({ kind: "ellipse", cx: transform.x(primitive.cx), cy: transform.y(primitive.cy), rx: Math.abs(transform.sx(primitive.rx)), ry: Math.abs(transform.sy(primitive.ry)), ...style });
        break;
      case "arc":
        shapes.push({ kind: "path", d: simulidePaintArcPathD(primitive.x, primitive.y, primitive.w, primitive.h, primitive.startDeg, primitive.spanDeg, transform), fill: "none", ...style });
        break;
      case "path":
        shapes.push({ kind: "path", d: transformPathData(primitive.d, transform), ...style });
        break;
      case "polygon":
        shapes.push({ kind: "polygon", points: pointList(primitive.points, transform), ...style });
        break;
      case "polyline":
        shapes.push({ kind: "path", d: polylinePath(pointList(primitive.points, transform)), fill: "none", ...style });
        break;
      case "text":
        shapes.push({
          kind: "text",
          x: transform.x(primitive.x),
          y: transform.y(primitive.y),
          value: stateTextFor(primitive, properties) ?? primitive.value,
          fontSize: transform.sw(primitive.fontSize),
          textAnchor: primitive.textAnchor,
          dominantBaseline: primitive.dominantBaseline,
          color: primitive.fill ?? primitive.stroke ?? spec.defaultStroke ?? "currentColor",
          fontFamily: primitive.fontFamily,
          fontWeight: primitive.fontWeight,
          ...style,
        });
        break;
      case "image":
        shapes.push({
          kind: "image",
          x: transform.x(primitive.x),
          y: transform.y(primitive.y),
          w: transform.sx(primitive.w),
          h: transform.sy(primitive.h),
          href: stateHrefFor(primitive, properties) ?? primitive.href,
          preserveAspectRatio: primitive.preserveAspectRatio,
          ...style,
        });
        break;
    }
  }

  if (defs.length > 0) shapes.unshift({ kind: "svg", value: `<defs>${defs.join("")}</defs>` });
  return shapes;
}

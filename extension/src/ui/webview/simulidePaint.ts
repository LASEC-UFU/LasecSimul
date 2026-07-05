import { PackageShape, SimulidePaintPrimitive, SimulidePaintSpec } from "./model.js";

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
  return primitive.stateFill.map[String(raw)];
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

function styleFor(
  spec: SimulidePaintSpec,
  primitive: SimulidePaintPrimitive,
  transform: PaintTransform,
  properties: Record<string, unknown>
): Partial<PackageShape> {
  const projectedFill = stateFillFor(primitive, properties);
  return {
    stroke: primitive.stroke ?? spec.defaultStroke ?? "currentColor",
    fill: projectedFill ?? primitive.fill ?? spec.defaultFill ?? "none",
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
  properties: Record<string, unknown> = {}
): PackageShape[] {
  const transform = transformFor(spec, width, height);
  const shapes: PackageShape[] = [];

  for (const primitive of spec.primitives) {
    if (!stateVisibleFor(primitive, properties)) continue;
    const style = styleFor(spec, primitive, transform, properties);
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
          value: primitive.value,
          fontSize: transform.sw(primitive.fontSize),
          textAnchor: primitive.textAnchor,
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

  return shapes;
}

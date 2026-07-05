#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function splitArgs(input) {
  const args = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function colorFor(expr) {
  const text = String(expr).trim();
  if (/Qt::NoPen|Qt::NoBrush/.test(text)) return "none";
  if (/Qt::white/.test(text)) return "#ffffff";
  if (/Qt::black/.test(text)) return "#000000";
  if (/Qt::red/.test(text)) return "#ff0000";
  if (/Qt::blue/.test(text)) return "#0000ff";
  const named = text.match(/QColor\(\s*"([^"]+)"\s*\)/);
  if (named) return named[1];
  const rgb = text.match(/QColor\(\s*([^)]+)\)/);
  if (!rgb) return undefined;
  const parts = splitArgs(rgb[1]).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((value) => !Number.isFinite(value))) return undefined;
  return `#${parts.slice(0, 3).map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function expressionEvaluator(symbols = {}) {
  return (expr) => {
    let js = String(expr).trim()
      .replace(/\bqMin\s*\(/g, "Math.min(")
      .replace(/\bqMax\s*\(/g, "Math.max(")
      .replace(/\bM_PI\b/g, "Math.PI")
      .replace(/\bQDial::width\(\)/g, "width")
      .replace(/\bQDial::height\(\)/g, "height")
      .replace(/\bwidth\(\)/g, "width")
      .replace(/\bheight\(\)/g, "height")
      .replace(/\.x\(\)/g, ".x")
      .replace(/\.y\(\)/g, ".y");
    js = js.replace(/QPointF?\(([^)]+)\)/g, (_, args) => {
      const [x, y] = splitArgs(args);
      return `({x:${x},y:${y}})`;
    });
    js = js.replace(/QRectF?\(([^)]+)\)/g, (_, args) => {
      const [x, y, w, h] = splitArgs(args);
      return `({x:${x},y:${y},w:${w},h:${h}})`;
    });
    try {
      const names = Object.keys(symbols);
      const values = Object.values(symbols);
      return Function(...names, `"use strict"; return (${js});`)(...values);
    } catch {
      const number = Number(js);
      return Number.isFinite(number) ? number : undefined;
    }
  };
}

function painterCall(method) {
  return new RegExp(`(?:p|painter)(?:->|\\.)${method}\\(\\s*(.+)\\s*\\);?`);
}

function rectFromArgs(rawArgs, evalExpr) {
  const args = splitArgs(rawArgs);
  const first = args.length ? evalExpr(args[0]) : undefined;
  if (first && typeof first.x === "number" && typeof first.y === "number" && typeof first.w === "number" && typeof first.h === "number") {
    return { x: first.x, y: first.y, w: first.w, h: first.h, rest: args.slice(1) };
  }
  const rect = rawArgs.match(/QRectF?\(\s*([^)]+)\s*\)/);
  const values = rect ? splitArgs(rect[1]).map(evalExpr) : args.slice(0, 4).map(evalExpr);
  if (values.length < 4 || values.some((value) => typeof value !== "number")) return undefined;
  return { x: values[0], y: values[1], w: values[2], h: values[3], rest: rect ? args.slice(1) : args.slice(4) };
}

function pointFromExpr(expr, evalExpr) {
  const point = evalExpr(expr);
  return point && typeof point.x === "number" && typeof point.y === "number" ? point : undefined;
}

function cleanPrimitive(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function qtPaintToSimulidePrimitives(source, options = {}) {
  const code = stripComments(source);
  const symbols = { ...(options.symbols ?? {}) };
  const evalExpr = expressionEvaluator(symbols);
  const primitives = [];
  const gradients = new Map();
  let stroke = options.defaultStroke ?? "#000";
  let fill = options.defaultFill ?? "none";
  let fillGradient;
  let strokeWidth = options.defaultStrokeWidth ?? 1.5;

  for (const rawLine of code.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const assignment = line.match(/^(?:(?:int|double|qreal|float|auto)\s+)?([A-Za-z_]\w*)\s*=\s*(.+);$/);
    if (assignment && !assignment[2].includes("==")) {
      const value = evalExpr(assignment[2]);
      if (value !== undefined) symbols[assignment[1]] = value;
      continue;
    }

    const linear = line.match(/QLinearGradient\s+(\w+)\s*\(\s*QPointF?\(([^)]+)\)\s*,\s*QPointF?\(([^)]+)\)\s*\)/);
    if (linear) {
      const [x1, y1] = splitArgs(linear[2]).map(evalExpr);
      const [x2, y2] = splitArgs(linear[3]).map(evalExpr);
      gradients.set(linear[1], { kind: "linear", x1, y1, x2, y2, stops: [] });
      continue;
    }
    const radial = line.match(/QRadialGradient\s+(\w+)\s*\(\s*QPointF?\(([^)]+)\)\s*,\s*([^)]+)\)/);
    if (radial) {
      const [cx, cy] = splitArgs(radial[2]).map(evalExpr);
      gradients.set(radial[1], { kind: "radial", cx, cy, r: evalExpr(radial[3]), stops: [] });
      continue;
    }
    const stop = line.match(/(\w+)\.setColorAt\(\s*([^,]+)\s*,\s*(.+)\s*\)/);
    if (stop && gradients.has(stop[1])) {
      gradients.get(stop[1]).stops.push({ offset: evalExpr(stop[2]) ?? stop[2].trim(), color: colorFor(stop[3]) ?? stop[3].trim() });
      continue;
    }

    const penWidth = line.match(/pen\.setWidthF?\(\s*([^)]+)\s*\)/);
    if (penWidth) {
      const parsed = evalExpr(penWidth[1]);
      if (typeof parsed === "number") strokeWidth = parsed;
      continue;
    }
    const penColor = line.match(/pen\.setColor\(\s*(.+)\s*\)/);
    if (penColor) {
      stroke = colorFor(penColor[1]) ?? stroke;
      continue;
    }
    const setPen = line.match(painterCall("setPen"));
    if (setPen) {
      const qpen = setPen[1].match(/QPen\(\s*(.+)\s*\)/);
      stroke = colorFor(qpen?.[1] ?? setPen[1]) ?? stroke;
      continue;
    }
    const brush = line.match(painterCall("setBrush"));
    if (brush) {
      const gradient = gradients.get(brush[1].trim());
      if (gradient) {
        fillGradient = gradient;
        fill = undefined;
      } else {
        fill = colorFor(brush[1]) ?? fill;
        fillGradient = undefined;
      }
      continue;
    }

    const drawLine = line.match(painterCall("drawLine"));
    if (drawLine) {
      const args = splitArgs(drawLine[1]);
      let p1, p2;
      if (args.length === 2) {
        p1 = pointFromExpr(args[0], evalExpr);
        p2 = pointFromExpr(args[1], evalExpr);
      } else if (args.length >= 4) {
        p1 = { x: evalExpr(args[0]), y: evalExpr(args[1]) };
        p2 = { x: evalExpr(args[2]), y: evalExpr(args[3]) };
      }
      if (p1 && p2) primitives.push(cleanPrimitive({ kind: "line", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke, strokeWidth, strokeLinecap: "round", strokeLinejoin: "round" }));
      continue;
    }
    const drawRoundedRect = line.match(painterCall("drawRoundedRect"));
    if (drawRoundedRect) {
      const rect = rectFromArgs(drawRoundedRect[1], evalExpr);
      if (rect) primitives.push(cleanPrimitive({ kind: "roundedRect", x: rect.x, y: rect.y, w: rect.w, h: rect.h, rx: evalExpr(rect.rest[0] ?? "0") ?? 0, ry: evalExpr(rect.rest[1] ?? rect.rest[0] ?? "0") ?? 0, stroke, fill, fillGradient, strokeWidth }));
      continue;
    }
    const drawRect = line.match(painterCall("drawRect"));
    if (drawRect) {
      const rect = rectFromArgs(drawRect[1], evalExpr);
      if (rect) primitives.push(cleanPrimitive({ kind: "rect", x: rect.x, y: rect.y, w: rect.w, h: rect.h, stroke, fill, fillGradient, strokeWidth }));
      continue;
    }
    const drawEllipse = line.match(painterCall("drawEllipse"));
    if (drawEllipse) {
      const args = splitArgs(drawEllipse[1]);
      const rect = rectFromArgs(drawEllipse[1], evalExpr);
      if (rect) primitives.push(cleanPrimitive({ kind: "ellipse", cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, rx: rect.w / 2, ry: rect.h / 2, stroke, fill, fillGradient, strokeWidth }));
      else if (args.length >= 3) {
        const point = pointFromExpr(args[0], evalExpr);
        const rx = evalExpr(args[1]);
        const ry = evalExpr(args[2]);
        if (point && typeof rx === "number" && typeof ry === "number") primitives.push(cleanPrimitive({ kind: "ellipse", cx: point.x, cy: point.y, rx, ry, stroke, fill, fillGradient, strokeWidth }));
      }
      continue;
    }
    const drawArc = line.match(painterCall("drawArc"));
    if (drawArc) {
      const rect = rectFromArgs(drawArc[1], evalExpr);
      if (rect) primitives.push(cleanPrimitive({ kind: "arc", x: rect.x, y: rect.y, w: rect.w, h: rect.h, startDeg: (evalExpr(rect.rest[0]) ?? 0) / 16, spanDeg: (evalExpr(rect.rest[1]) ?? 0) / 16, stroke, fill: "none", strokeWidth }));
      continue;
    }
    const drawPixmap = line.match(painterCall("drawPixmap"));
    if (drawPixmap) {
      const args = splitArgs(drawPixmap[1]);
      if (args.length >= 5) primitives.push(cleanPrimitive({ kind: "image", x: evalExpr(args[0]), y: evalExpr(args[1]), w: evalExpr(args[2]), h: evalExpr(args[3]), href: options.imageHref ?? "" }));
    }
  }

  return primitives;
}

function parseSymbols(args) {
  const symbols = {};
  for (const arg of args) {
    const [name, value] = arg.split("=");
    if (!name || value === undefined) continue;
    symbols[name] = Number(value);
  }
  return symbols;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node scripts/qt-paint-to-simulide-ir.mjs <file.cpp> [name=value ...]");
    process.exit(2);
  }
  const source = fs.readFileSync(path.resolve(file), "utf8");
  console.log(JSON.stringify({ primitives: qtPaintToSimulidePrimitives(source, { symbols: parseSymbols(rest) }) }, null, 2));
}

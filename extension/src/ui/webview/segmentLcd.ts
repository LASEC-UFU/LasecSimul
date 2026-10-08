/**
 * `segment-lcd` runtime surface: the local indicator of a HART field device
 * (Smar 301 series, LD301 manual Fig. 2.4) -- a sign, a half digit and four
 * 7-segment digits with decimal points (4 1/2 digit numeric field), five
 * 14-segment alphanumeric characters and an information field of
 * annunciators. The Core composes WHAT is shown (HartLcd.hpp); this module
 * only draws the glass. Pure (no DOM), unit-testable.
 *
 * Payload (little-endian, from `payloadOffset`): u32 enabled, 6 numeric chars
 * (sign, half digit, 4 digits), u8 decimal-point mask (bit p = point after
 * numeric position p), u8 glass, 5 alpha chars, 3 reserved, u32
 * annunciator mask.
 *
 * Glass 0 is the LD301 indicator (sqrt marks); glass 1 the TT301 one (TT301
 * manual Fig. 2.9: ACK instead of the sqrt marks).
 */
export interface SegmentLcdFrame {
  enabled: boolean;
  numeric: string;
  decimalPoints: number;
  alpha: string;
  annunciators: number;
  glass: number;
}

export const SEGMENT_LCD_PAYLOAD_BYTES = 24;

/** Annunciator bits (same order as HartLcdAnnunciator in the Core). */
export const SegmentLcdAnnunciator = {
  pid: 1 << 0, fix: 1 << 1, total: 1 << 2, table: 1 << 3, multidrop: 1 << 4, sqrt: 1 << 5, sqrtCube: 1 << 6,
  sqrtFifth: 1 << 7, automatic: 1 << 8, manual: 1 << 9, percent: 1 << 10, minutes: 1 << 11, degree: 1 << 12,
  adjust: 1 << 13, setpoint: 1 << 14, processVariable: 1 << 15, acknowledge: 1 << 16,
} as const;

/** Glass of the indicator (HartLcdGlass in the Core). */
export const SegmentLcdGlass = { ld301: 0, tt301: 1 } as const;

export function decodeSegmentLcd(bytes: Uint8Array, offset: number): SegmentLcdFrame | undefined {
  if (offset < 0 || offset + SEGMENT_LCD_PAYLOAD_BYTES > bytes.byteLength) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) => String.fromCharCode(...bytes.subarray(offset + start, offset + start + length));
  return {
    enabled: view.getUint32(offset, true) !== 0,
    numeric: text(4, 6),
    decimalPoints: bytes[offset + 10]!,
    alpha: text(12, 5),
    annunciators: view.getUint32(offset + 20, true),
    glass: bytes[offset + 11]!,
  };
}

// 7-segment: a b c d e f g.
const SEVEN: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc", "5": "afgcd", "6": "afgedc", "7": "abc",
  "8": "abcdefg", "9": "abcdfg", "-": "g", " ": "",
};

// 14-segment: a b c d e f, g = left middle, G = right middle, h i j = upper
// diagonal/vertical/diagonal, k l m = lower diagonal/vertical/diagonal.
const FOURTEEN: Record<string, string> = {
  "0": "abcdefjk", "1": "bcj", "2": "abdegG", "3": "abcdG", "4": "bcfgG", "5": "acdfgG", "6": "acdefgG", "7": "abc",
  "8": "abcdefgG", "9": "abcdfgG",
  A: "abcefgG", B: "abcdGil", C: "adef", D: "abcdil", E: "adefg", F: "aefg", G: "acdefG", H: "bcefgG", I: "adil",
  J: "bcde", K: "efgjm", L: "def", M: "bcefhj", N: "bcefhm", O: "abcdef", P: "abefgG", Q: "abcdefm", R: "abefgGm",
  S: "acdfgG", T: "ail", U: "bcdef", V: "efjk", W: "bcefkm", X: "hjkm", Y: "hjl", Z: "adjk",
  m: "cegGl", n: "cegG", o: "cdegG", r: "eg", u: "cde", c: "degG", h: "cefgG", i: "l", t: "defg",
  "-": "gG", "/": "jk", "+": "gGil", "_": "d", "=": "dgG", "*": "gGhijklm", "(": "jm", ")": "hk", " ": "",
};

export function sevenSegments(char: string): string {
  return SEVEN[char] ?? "";
}

export function fourteenSegments(char: string): string {
  return FOURTEEN[char] ?? FOURTEEN[char.toUpperCase()] ?? "";
}

function n(value: number): string {
  return Number(value.toFixed(2)).toString();
}

interface Cell { x: number; y: number; w: number; h: number; }

/** Segment lines of one glyph (slight italic like the real glass). */
function glyph(cell: Cell, segments: string, all: string, kind: 7 | 14, lit: string, ghost: string): string {
  const inset = cell.w * 0.08;
  const l = cell.x + inset, r = cell.x + cell.w - inset, t = cell.y + inset, b = cell.y + cell.h - inset;
  const m = (t + b) / 2, c = (l + r) / 2;
  const skew = (y: number) => (m - y) * 0.12;
  const lines: Record<string, [number, number, number, number]> = {
    a: [l, t, r, t], b: [r, t, r, m], c: [r, m, r, b], d: [l, b, r, b], e: [l, m, l, b], f: [l, t, l, m],
    ...(kind === 7
      ? { g: [l, m, r, m] as [number, number, number, number] }
      : {
          g: [l, m, c, m] as [number, number, number, number], G: [c, m, r, m] as [number, number, number, number],
          h: [l, t, c, m] as [number, number, number, number], i: [c, t, c, m] as [number, number, number, number],
          j: [r, t, c, m] as [number, number, number, number], k: [l, b, c, m] as [number, number, number, number],
          l: [c, m, c, b] as [number, number, number, number], m: [r, b, c, m] as [number, number, number, number],
        }),
  };
  const width = n(Math.max(0.6, cell.w * (kind === 7 ? 0.14 : 0.1)));
  let markup = "";
  for (const name of all) {
    const segment = lines[name];
    if (!segment) continue;
    const on = segments.includes(name);
    markup += `<line x1="${n(segment[0] + skew(segment[1]))}" y1="${n(segment[1])}" x2="${n(segment[2] + skew(segment[3]))}" y2="${n(segment[3])}" ` +
      `stroke="${on ? lit : ghost}" stroke-width="${width}" stroke-linecap="round" data-lcd-segment="${name}"${on ? ' data-lit="1"' : ""}/>`;
  }
  return markup;
}

function annunciator(text: string, x: number, y: number, size: number, on: boolean, lit: string, ghost: string, boxed = false): string {
  const fill = on ? lit : ghost;
  const box = boxed
    ? `<rect x="${n(x - size * 0.2)}" y="${n(y - size * 0.95)}" width="${n(size * (text.length * 0.68 + 0.4))}" height="${n(size * 1.25)}" fill="none" stroke="${fill}" stroke-width="${n(size * 0.08)}"/>`
    : "";
  return `${box}<text x="${n(x)}" y="${n(y)}" font-family="Arial,sans-serif" font-size="${n(size)}" fill="${fill}"` +
    `${on ? ' data-lit="1"' : ""} data-lcd-annunciator="${text}">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`;
}

/** SVG markup of the glass inside the rectangle (x, y, w, h). */
export function segmentLcdSvg(frame: SegmentLcdFrame | undefined, x: number, y: number, w: number, h: number,
                              lit = "#1b1f1a", ghost = "rgba(27,31,26,0.07)"): string {
  if (!frame || !frame.enabled) return "";
  const A = SegmentLcdAnnunciator;
  const on = (bit: number) => (frame.annunciators & bit) !== 0;
  const U = (u: number) => x + u * w;
  const V = (v: number) => y + v * h;
  const small = h * 0.085;
  let markup = "";
  // Information field, top rows.
  markup += annunciator("PID", U(0.13), V(0.12), small, on(A.pid), lit, ghost);
  markup += annunciator("MD", U(0.66), V(0.12), small, on(A.multidrop), lit, ghost, true);
  markup += annunciator("Fix", U(0.06), V(0.25), small, on(A.fix), lit, ghost);
  markup += annunciator("F(t)", U(0.24), V(0.25), small, on(A.total), lit, ghost);
  markup += annunciator("F(x)", U(0.43), V(0.25), small, on(A.table), lit, ghost);
  if (frame.glass === SegmentLcdGlass.tt301) {
    markup += annunciator("ACK", U(0.40), V(0.12), small, on(A.acknowledge), lit, ghost);
  } else {
    markup += annunciator("√", U(0.64), V(0.25), small * 1.15, on(A.sqrt), lit, ghost);
    markup += annunciator("3", U(0.71), V(0.21), small * 0.7, on(A.sqrtCube), lit, ghost);
    markup += annunciator("5", U(0.76), V(0.21), small * 0.7, on(A.sqrtFifth), lit, ghost);
  }
  // Numeric field: A / sign / M, half digit, four digits with points, %.
  markup += annunciator("A", U(0.035), V(0.37), small, on(A.automatic), lit, ghost);
  markup += annunciator("M", U(0.035), V(0.60), small, on(A.manual), lit, ghost);
  const top = 0.30, height = 0.30;
  const signOn = frame.numeric[0] === "-";
  markup += `<line x1="${n(U(0.03))}" y1="${n(V(top + height / 2))}" x2="${n(U(0.075))}" y2="${n(V(top + height / 2))}" ` +
    `stroke="${signOn ? lit : ghost}" stroke-width="${n(w * 0.012)}" stroke-linecap="round" data-lcd-sign="1"${signOn ? ' data-lit="1"' : ""}/>`;
  const half: Cell = { x: U(0.08), y: V(top), w: w * 0.05, h: h * height };
  markup += glyph(half, frame.numeric[1] === "1" ? "bc" : "", "bc", 7, lit, ghost);
  const digitCells: Cell[] = [0, 1, 2, 3].map((index) => ({ x: U(0.14 + index * 0.155), y: V(top), w: w * 0.12, h: h * height }));
  digitCells.forEach((cell, index) => { markup += glyph(cell, sevenSegments(frame.numeric[2 + index] ?? " "), "abcdefg", 7, lit, ghost); });
  const pointCells = [half, ...digitCells];
  pointCells.forEach((cell, index) => {
    const position = index + 1;
    const pointOn = (frame.decimalPoints & (1 << position)) !== 0;
    if (position === 5) return; // no point after the last digit
    markup += `<circle cx="${n(cell.x + cell.w + w * 0.012)}" cy="${n(cell.y + cell.h - h * 0.012)}" r="${n(w * 0.009)}" ` +
      `fill="${pointOn ? lit : ghost}" data-lcd-point="${position}"${pointOn ? ' data-lit="1"' : ""}/>`;
  });
  markup += annunciator("%", U(0.80), V(0.40), small * 1.2, on(A.percent), lit, ghost);
  // Alphanumeric field: adjust arrows, five 14-segment characters, degree, min.
  markup += annunciator("⇕", U(0.02), V(0.80), small * 1.6, on(A.adjust), lit, ghost);
  for (let index = 0; index < 5; index += 1) {
    const cell: Cell = { x: U(0.09 + index * 0.135), y: V(0.64), w: w * 0.11, h: h * 0.21 };
    const char = frame.alpha[index] ?? " ";
    if (char === ".") {
      markup += `<circle cx="${n(cell.x + cell.w / 2)}" cy="${n(cell.y + cell.h - h * 0.015)}" r="${n(w * 0.01)}" fill="${lit}" data-lit="1"/>`;
      continue;
    }
    markup += glyph(cell, fourteenSegments(char), "abcdefgGhijklm", 14, lit, ghost);
  }
  markup += annunciator("°", U(0.765), V(0.70), small * 1.2, on(A.degree), lit, ghost);
  markup += annunciator("min", U(0.80), V(0.84), small, on(A.minutes), lit, ghost);
  // Bottom row.
  markup += annunciator("SP", U(0.36), V(0.93), small, on(A.setpoint), lit, ghost);
  markup += annunciator("PV", U(0.52), V(0.93), small, on(A.processVariable), lit, ghost);
  return `<g data-runtime-surface="segment-lcd">${markup}</g>`;
}

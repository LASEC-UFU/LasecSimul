import { Ast, arg, argNode, argString } from "./ast.js";

const PREC: Readonly<Record<string, number>> = { Add: 1, Subtract: 1, Multiply: 2, Divide: 3, Negate: 3, Power: 4 };
const FN_LABEL: Readonly<Record<string, string>> = { Sin: "sen", Cos: "cos", Tan: "tg", Exp: "exp", Ln: "ln", Log: "log", Sign: "sgn" };
const IMPLICIT_RIGHT = new Set(["Power", "Sin", "Cos", "Tan", "Exp", "Ln", "Log", "Sqrt", "Call"]);

export const escapeXml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** Número no formato pt-BR (vírgula decimal), até 12 algarismos significativos. */
export function formatNumberPt(v: number): string {
  return String(Number(v.toPrecision(12))).replace("-", "−").replace(".", ",");
}

/** AST -> marcação MathML Core (texto escapado; renderização nativa do Chromium, sem biblioteca). */
export function astToMathML(ast: Ast, display: "inline" | "block" = "inline"): string {
  const numML = (v: number): string =>
    v === Math.PI ? "<mi>π</mi>" : v === Math.E ? "<mi>e</mi>" : v === Infinity ? "<mi>∞</mi>"
      : v === -Infinity ? "<mrow><mo>−</mo><mi>∞</mi></mrow>" : `<mn>${escapeXml(formatNumberPt(v))}</mn>`;
  const prec = (node: Ast): number => (Array.isArray(node) ? PREC[node[0]] ?? 5 : typeof node === "number" && node < 0 ? 3 : 5);
  const wrap = (node: Ast, min: number): string => (prec(node) < min ? `<mrow><mo>(</mo>${go(node)}<mo>)</mo></mrow>` : go(node));
  const fn = (name: string, a: Ast): string => `<mrow><mi>${name}</mi><mo>&#x2061;</mo><mrow><mo>(</mo>${go(a)}<mo>)</mo></mrow></mrow>`;
  function go(node: Ast): string {
    if (typeof node === "number") return numML(node);
    if (typeof node === "string") return `<mi>${escapeXml(node)}</mi>`;
    const head = node[0];
    switch (head) {
      case "Add": return `<mrow>${wrap(arg(node, 1), 1)}<mo>+</mo>${wrap(arg(node, 2), 2)}</mrow>`;
      case "Subtract": return `<mrow>${wrap(arg(node, 1), 1)}<mo>−</mo>${wrap(arg(node, 2), 2)}</mrow>`;
      case "Multiply": {
        const a = arg(node, 1), b = arg(node, 2);
        const implicit = typeof a === "number" && (typeof b === "string" || (Array.isArray(b) && IMPLICIT_RIGHT.has(b[0])));
        return implicit ? `<mrow>${numML(a)}<mo>&#x2062;</mo>${wrap(b, 2)}</mrow>` : `<mrow>${wrap(a, 2)}<mo>·</mo>${wrap(b, 3)}</mrow>`;
      }
      case "Divide": return `<mfrac>${go(arg(node, 1))}${go(arg(node, 2))}</mfrac>`;
      case "Power": return `<msup>${wrap(arg(node, 1), 5)}${go(arg(node, 2))}</msup>`;
      case "Negate": return `<mrow><mo>−</mo>${wrap(arg(node, 1), 3)}</mrow>`;
      case "Sqrt": return `<msqrt>${go(arg(node, 1))}</msqrt>`;
      case "Abs": return `<mrow><mo>|</mo>${go(arg(node, 1))}<mo>|</mo></mrow>`;
      case "Equal": return `<mrow>${go(arg(node, 1))}<mo>=</mo>${go(arg(node, 2))}</mrow>`;
      case "Call": return fn(escapeXml(argString(node, 1)), arg(node, 2));
      case "Integrate": {
        const L = argNode(node, 2);
        return `<mrow><msubsup><mo>∫</mo>${go(arg(L, 2))}${go(arg(L, 3))}</msubsup>${wrap(arg(node, 1), 2)}<mspace width="0.17em"></mspace><mi>d</mi><mi>${escapeXml(argString(L, 1))}</mi></mrow>`;
      }
      case "D": return `<mrow><mfrac><mi>d</mi><mrow><mi>d</mi><mi>${escapeXml(argString(node, 2))}</mi></mrow></mfrac>${wrap(arg(node, 1), 5)}</mrow>`;
      case "Limit": {
        const side = arg(node, 4) as number, target = go(arg(node, 3));
        const approach = side === 0 ? target : `<msup>${target}<mo>${side > 0 ? "+" : "−"}</mo></msup>`;
        return `<mrow><munder><mo movablelimits="false">lim</mo><mrow><mi>${escapeXml(argString(node, 2))}</mi><mo>→</mo>${approach}</mrow></munder>${wrap(arg(node, 1), 2)}</mrow>`;
      }
      case "Sum": case "Product": {
        const L = argNode(node, 2);
        return `<mrow><munderover><mo movablelimits="false">${head === "Sum" ? "∑" : "∏"}</mo><mrow><mi>${escapeXml(argString(L, 1))}</mi><mo>=</mo>${go(arg(L, 2))}</mrow>${go(arg(L, 3))}</munderover>${wrap(arg(node, 1), 2)}</mrow>`;
      }
      default: return fn(FN_LABEL[head] ?? escapeXml(head.toLowerCase()), arg(node, 1));
    }
  }
  return `<math display="${display}">${go(ast)}</math>`;
}

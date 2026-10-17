import { Ast, arg, isNode } from "./ast.js";

/** Coeficientes [c0, c1, …] se `ast` é polinômio em `v` com coeficientes numéricos; senão undefined.
 * É o "caminho exato" (mesma ideia do atalho polinomial de `Function.getDerivative` no GeoGebra). */
export function toPolynomial(ast: Ast, v: string): number[] | undefined {
  const add = (a: number[], b: number[]): number[] => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
  const mul = (a: number[], b: number[]): number[] => {
    const r = new Array<number>(a.length + b.length - 1).fill(0);
    a.forEach((x, i) => b.forEach((y, j) => { r[i + j] = (r[i + j] ?? 0) + x * y; }));
    return r;
  };
  function go(node: Ast): number[] | undefined {
    if (typeof node === "number") return Number.isFinite(node) ? [node] : undefined;
    if (typeof node === "string") return node === v ? [0, 1] : undefined;
    const head = node[0];
    if (!["Add", "Subtract", "Multiply", "Divide", "Power", "Negate"].includes(head)) return undefined;
    const pa = go(arg(node, 1));
    const pb = head === "Negate" ? undefined : go(arg(node, 2));
    switch (head) {
      case "Add": return pa && pb && add(pa, pb);
      case "Subtract": return pa && pb && add(pa, pb.map((x) => -x));
      case "Negate": return pa && pa.map((x) => -x);
      case "Multiply": return pa && pb && mul(pa, pb);
      case "Power": {
        const exponent = pb && pb.length === 1 ? pb[0] : undefined;
        if (!pa || exponent === undefined || !Number.isInteger(exponent) || exponent < 0 || exponent > 32) return undefined;
        let r = [1];
        for (let k = 0; k < exponent; k++) r = mul(r, pa);
        return r;
      }
      default: { // Divide
        const divisor = pb && pb.length === 1 ? pb[0] : undefined;
        return pa && divisor !== undefined && divisor !== 0 ? pa.map((x) => x / divisor) : undefined;
      }
    }
  }
  const r = go(ast);
  if (!r) return undefined;
  while (r.length > 1 && r[r.length - 1] === 0) r.pop();
  return r;
}

export const polyEval = (c: readonly number[], x: number): number => c.reduceRight((acc, k) => acc * x + k, 0);

/** Divide por (x − a) (Ruffini); devolve [quociente, resto]. */
export function deflate(c: readonly number[], a: number): [number[], number] {
  const n = c.length - 1;
  if (n < 1) return [[0], c[0] ?? 0];
  const q = new Array<number>(n).fill(0);
  let carry = c[n] as number;
  for (let k = n - 1; k >= 0; k--) { q[k] = carry; carry = (c[k] as number) + carry * a; }
  return [q, carry];
}

/** Quociente incremental [p(a+Δ) − p(a)]/Δ como polinômio em Δ (válido para Δ ≠ 0). */
export function differenceQuotientPolynomial(coeffs: readonly number[], a: number): number[] {
  const shifted = new Array<number>(coeffs.length).fill(0);
  coeffs.forEach((c, k) => {
    let binom = 1;
    for (let j = 0; j <= k; j++) {
      shifted[j] = (shifted[j] ?? 0) + c * binom * a ** (k - j);
      binom = (binom * (k - j)) / (j + 1);
    }
  });
  return shifted.slice(1);
}

/** Polinômio em texto pt-BR ("48 + 12Δt + Δt^2"). */
export function formatPolynomial(coeffs: readonly number[], variable: string, decimals = 6): string {
  const fmt = (x: number): string => Number(x.toFixed(decimals)).toLocaleString("pt-BR", { maximumFractionDigits: decimals });
  const parts: Array<{ sign: string; term: string }> = [];
  coeffs.forEach((c, k) => {
    if (Math.abs(c) < 1e-15) return;
    const magnitude = Math.abs(c);
    const coef = k > 0 && magnitude === 1 ? "" : fmt(magnitude);
    parts.push({ sign: c < 0 ? "−" : "+", term: k === 0 ? coef : `${coef}${variable}${k > 1 ? `^${k}` : ""}` });
  });
  if (parts.length === 0) return "0";
  return parts.map((part, i) => (i === 0 ? (part.sign === "−" ? "−" : "") + part.term : ` ${part.sign} ${part.term}`)).join("");
}

/** Helper para chamadores que precisam testar se um nó é divisão de dois polinômios. */
export function rationalParts(ast: Ast, v: string): [number[], number[]] | undefined {
  if (!isNode(ast) || ast[0] !== "Divide") return undefined;
  const p = toPolynomial(arg(ast, 1), v), q = toPolynomial(arg(ast, 2), v);
  return p && q ? [p, q] : undefined;
}

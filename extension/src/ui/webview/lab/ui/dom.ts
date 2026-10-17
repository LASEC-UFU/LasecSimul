/** Utilitários de DOM e formatação da Webview do laboratório. */
export const SVG_NS = "http://www.w3.org/2000/svg";

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`elemento #${id} ausente`);
  return element as T;
}

export function html<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) element.setAttribute(k, v);
  if (text !== undefined) element.textContent = text;
  return element;
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) element.setAttribute(k, String(v));
  parent?.appendChild(element);
  return element;
}

export function clear(node: Element): void { while (node.firstChild) node.firstChild.remove(); }

/** Número pt-BR com até `digits` algarismos significativos (exibição; o valor calculado não é arredondado). */
export function fmt(x: number, digits = 6): string {
  return Number.isFinite(x) ? Number(x.toPrecision(Math.max(digits, 1))).toLocaleString("pt-BR", { maximumFractionDigits: 10 }) : "—";
}

/** Casas suficientes para distinguir aproximações sucessivas de passo Δ (docs/52 §4.2). */
export function digitsFor(delta: number): number {
  return Math.max(2, Math.ceil(-Math.log10(Math.abs(delta) || 1)) + 1);
}

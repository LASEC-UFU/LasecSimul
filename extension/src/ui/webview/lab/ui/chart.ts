import { clear, svg } from "./dom.js";

/**
 * Gráfico XY em camadas SVG ("ChartKit" mínimo, docs/51 §4.7): uma transformação mundo↔tela por vista e
 * três camadas (`under` áreas/barras, `base` eixos e séries, `over` cursor e marcadores). Mover o cursor
 * redesenha só `over`.
 */
export interface ChartGeometry { W: number; H: number; L: number; R: number; T: number; B: number }
export interface ChartView { x0: number; x1: number; y0: number; y1: number }

export const DEFAULT_GEOMETRY: ChartGeometry = { W: 640, H: 260, L: 56, R: 12, T: 18, B: 30 };

const nf = (x: number, d = 2): string => (Number.isFinite(x) ? x.toLocaleString("pt-BR", { maximumFractionDigits: d }) : "—");

/** Passo "bonito" (1, 2, 5 × 10^k) para ~`count` marcas. */
export function niceStep(span: number, count = 6): number {
  const raw = Math.abs(span) / count;
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

export class XYChart {
  view: ChartView = { x0: 0, x1: 1, y0: 0, y1: 1 };

  constructor(readonly root: SVGSVGElement, readonly geo: ChartGeometry = DEFAULT_GEOMETRY) {
    root.setAttribute("viewBox", `0 0 ${geo.W} ${geo.H}`);
  }

  setView(view: ChartView): void { this.view = view; }
  x(v: number): number { const { x0, x1 } = this.view; return this.geo.L + ((v - x0) / (x1 - x0)) * (this.geo.W - this.geo.L - this.geo.R); }
  y(v: number): number { const { y0, y1 } = this.view; return this.geo.H - this.geo.B - ((v - y0) / (y1 - y0)) * (this.geo.H - this.geo.T - this.geo.B); }
  xFromPx(px: number): number { const { x0, x1 } = this.view; return x0 + ((px - this.geo.L) / (this.geo.W - this.geo.L - this.geo.R)) * (x1 - x0); }
  yFromPx(py: number): number { const { y0, y1 } = this.view; return y0 + ((this.geo.H - this.geo.B - py) / (this.geo.H - this.geo.T - this.geo.B)) * (y1 - y0); }
  /** Coordenada x de dados sob o ponteiro (o SVG escala com o contêiner). */
  pointerX(event: PointerEvent | MouseEvent): number {
    const rect = this.root.getBoundingClientRect();
    return this.xFromPx(((event.clientX - rect.left) / rect.width) * this.geo.W);
  }
  pointerY(event: PointerEvent | MouseEvent): number {
    const rect = this.root.getBoundingClientRect();
    return this.yFromPx(((event.clientY - rect.top) / rect.height) * this.geo.H);
  }

  /** Camada limpa; a ordem under → base → over é criada na primeira chamada. */
  layer(name: "under" | "base" | "over"): SVGGElement {
    let group = this.root.querySelector<SVGGElement>(`g[data-layer="${name}"]`);
    if (!group) {
      for (const layer of ["under", "base", "over"]) svg("g", { "data-layer": layer }, this.root);
      group = this.root.querySelector<SVGGElement>(`g[data-layer="${name}"]`)!;
    }
    clear(group);
    return group;
  }

  axes(group: SVGGElement, options: { xLabel: string; yLabel: string; xDecimals?: number; yDecimals?: number }): void {
    const { x0, x1, y0, y1 } = this.view, g = this.geo;
    const zeroY = y0 <= 0 && y1 >= 0 ? this.y(0) : g.H - g.B;
    const zeroX = x0 <= 0 && x1 >= 0 ? this.x(0) : g.L;
    svg("line", { x1: g.L, y1: zeroY, x2: g.W - g.R, y2: zeroY, stroke: "#94a3b8" }, group);
    svg("line", { x1: zeroX, y1: g.T, x2: zeroX, y2: g.H - g.B, stroke: "#94a3b8" }, group);
    const xs = niceStep(x1 - x0), ys = niceStep(y1 - y0);
    for (let v = Math.ceil(x0 / xs) * xs; v <= x1 + xs * 1e-9; v += xs) {
      svg("line", { x1: this.x(v), y1: g.T, x2: this.x(v), y2: g.H - g.B, stroke: "#e2e8f0" }, group);
      svg("text", { x: this.x(v), y: g.H - 10, "text-anchor": "middle", "font-size": 11, fill: "#475569" }, group).textContent = nf(v, options.xDecimals ?? 2);
    }
    for (let v = Math.ceil(y0 / ys) * ys; v <= y1 + ys * 1e-9; v += ys) {
      svg("line", { x1: g.L, y1: this.y(v), x2: g.W - g.R, y2: this.y(v), stroke: "#f1f5f9" }, group);
      svg("text", { x: g.L - 6, y: this.y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "#475569" }, group).textContent = nf(v, options.yDecimals ?? 2);
    }
    svg("text", { x: 6, y: 12, "font-size": 12, fill: "#0f172a" }, group).textContent = options.yLabel;
    svg("text", { x: g.W - g.R, y: 12, "text-anchor": "end", "font-size": 12, fill: "#0f172a" }, group).textContent = options.xLabel;
  }

  /** Trechos de pontos em coordenadas de dados (cada trecho é um path; NaN quebra o traçado). */
  path(group: SVGGElement, segments: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, attrs: Record<string, string | number>): SVGPathElement {
    const d = segments.map((points) => points.map(([px, py], k) => `${k ? "L" : "M"}${this.x(px).toFixed(1)} ${this.y(py).toFixed(1)}`).join("")).join("");
    return svg("path", { d, fill: "none", ...attrs }, group);
  }

  hLine(group: SVGGElement, v: number, attrs: Record<string, string | number>): void {
    svg("line", { x1: this.geo.L, y1: this.y(v), x2: this.geo.W - this.geo.R, y2: this.y(v), ...attrs }, group);
  }
  vLine(group: SVGGElement, v: number, attrs: Record<string, string | number>): void {
    svg("line", { x1: this.x(v), y1: this.geo.T, x2: this.x(v), y2: this.geo.H - this.geo.B, ...attrs }, group);
  }
  text(group: SVGGElement, x: number, y: number, value: string, attrs: Record<string, string | number> = {}): SVGTextElement {
    const element = svg("text", { x: this.x(x), y: this.y(y), "font-size": 12, fill: "#0f172a", ...attrs }, group);
    element.textContent = value;
    return element;
  }
  dot(group: SVGGElement, x: number, y: number, attrs: Record<string, string | number>): SVGCircleElement {
    return svg("circle", { cx: this.x(x), cy: this.y(y), r: 5, ...attrs }, group);
  }
}

/**
 * Marcador arrastável operável por teclado (docs/52 §5): `role="slider"`, setas = passo, Shift+setas =
 * passo fino, Home/End = extremos, `aria-valuetext` com coordenadas e unidades. O elemento é criado uma
 * vez e atualizado no lugar -- redesenhar a camada nunca tira o foco de quem está usando o teclado.
 */
export class ChartHandle {
  readonly element: SVGCircleElement;
  private value: number;

  constructor(parent: SVGElement, private readonly options: {
    label: string; min: number; max: number; step: number; color: string; text: (value: number) => string; onChange: (value: number) => void;
  }, initial: number) {
    this.value = initial;
    this.element = svg("circle", { r: 7, fill: options.color, stroke: "#fff", "stroke-width": 1.5, class: "chart-handle" }, parent);
    this.element.setAttribute("role", "slider");
    this.element.setAttribute("tabindex", "0");
    this.element.setAttribute("aria-label", options.label);
    this.element.setAttribute("aria-valuemin", String(options.min));
    this.element.setAttribute("aria-valuemax", String(options.max));
    this.element.addEventListener("keydown", (event) => {
      const fine = event.shiftKey ? this.options.step / 10 : this.options.step;
      let next: number | undefined;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") next = this.value + fine;
      else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = this.value - fine;
      else if (event.key === "Home") next = this.options.min;
      else if (event.key === "End") next = this.options.max;
      if (next === undefined) return;
      event.preventDefault();
      this.options.onChange(Math.min(this.options.max, Math.max(this.options.min, next)));
    });
  }

  /** Nova posição (px do SVG) e valor; só atributos mudam. */
  update(value: number, cx: number, cy: number, max = this.options.max): void {
    this.value = value;
    this.element.setAttribute("cx", cx.toFixed(1));
    this.element.setAttribute("cy", cy.toFixed(1));
    this.element.setAttribute("aria-valuemax", String(max));
    this.element.setAttribute("aria-valuenow", String(value));
    this.element.setAttribute("aria-valuetext", this.options.text(value));
  }
}

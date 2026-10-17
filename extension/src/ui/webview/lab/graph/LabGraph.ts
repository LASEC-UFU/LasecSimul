/**
 * Grafo de dependências incremental do Laboratório de Cálculo (docs/51 §4.6).
 *
 * Mesma base do `algoUpdateSet` do GeoGebra: um nó derivado só depende de nós já definidos, então a ordem de
 * definição é topológica, e cada fonte conhece seu conjunto transitivo de dependentes. Diferenças deliberadas:
 *  - poda por valor: um nó só recalcula se algum insumo mudou de VALOR nesta propagação, e só propaga se o
 *    próprio valor mudou (o GeoGebra recalcula todo o conjunto);
 *  - lote: várias fontes alteradas geram uma única propagação e uma única notificação;
 *  - nós têm tipo; a inspeção nunca escreve no simulador (não há caminho do grafo para o Core).
 */
export type NodeKind = "authoring" | "parameter-mirror" | "series" | "inspection" | "view" | "execution" | "derived";

export type Equality = (a: unknown, b: unknown) => boolean;

interface GraphNode {
  id: string;
  kind: NodeKind;
  inputs: readonly string[];
  compute: ((...args: unknown[]) => unknown) | undefined;
  equals: Equality;
  value: unknown;
  index: number;
  dependents: string[];
}

/** Igualdade estrutural barata para valores pequenos (objetos de inspeção, resultados). */
export const sameValue: Equality = (a, b) =>
  Object.is(a, b) || (typeof a === "object" && a !== null && typeof b === "object" && b !== null && JSON.stringify(a) === JSON.stringify(b));

export class LabGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly downstreamCache = new Map<string, GraphNode[]>();
  private readonly listeners = new Set<(changed: ReadonlySet<string>) => void>();
  private readonly computes = new Map<string, number>();
  private readonly pending = new Set<string>();
  private batchDepth = 0;

  source<T>(id: string, value: T, options: { kind?: NodeKind; equals?: Equality } = {}): string {
    this.define({ id, kind: options.kind ?? "inspection", inputs: [], compute: undefined, equals: options.equals ?? sameValue, value });
    return id;
  }

  derived<T>(id: string, inputs: readonly string[], compute: (...args: never[]) => T, options: { kind?: NodeKind; equals?: Equality } = {}): string {
    for (const input of inputs) if (!this.nodes.has(input)) throw new Error(`nó "${id}" depende de "${input}" ainda não definido`);
    const node = this.define({ id, kind: options.kind ?? "derived", inputs, compute: compute as (...args: unknown[]) => unknown, equals: options.equals ?? sameValue, value: undefined });
    node.value = this.run(node);
    return id;
  }

  get<T>(id: string): T {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`nó desconhecido: ${id}`);
    return node.value as T;
  }

  has(id: string): boolean { return this.nodes.has(id); }

  set(id: string, value: unknown): void {
    const node = this.nodes.get(id);
    if (!node || node.compute) throw new Error(`"${id}" não é fonte`);
    if (node.equals(node.value, value)) return;
    node.value = value;
    this.pending.add(id);
    if (this.batchDepth === 0) this.flush();
  }

  batch(fn: () => void): void {
    this.batchDepth++;
    try { fn(); } finally { if (--this.batchDepth === 0) this.flush(); }
  }

  onChange(listener: (changed: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Para testes e diagnóstico: quantas vezes o nó foi calculado. */
  computeCount(id: string): number { return this.computes.get(id) ?? 0; }

  private define(spec: Omit<GraphNode, "index" | "dependents">): GraphNode {
    if (this.nodes.has(spec.id)) throw new Error(`nó duplicado: ${spec.id}`);
    const node: GraphNode = { ...spec, index: this.nodes.size, dependents: [] };
    for (const input of node.inputs) this.nodes.get(input)?.dependents.push(node.id);
    this.nodes.set(node.id, node);
    this.downstreamCache.clear();
    return node;
  }

  private run(node: GraphNode): unknown {
    this.computes.set(node.id, (this.computes.get(node.id) ?? 0) + 1);
    const args = node.inputs.map((id) => this.nodes.get(id)?.value);
    try {
      return node.compute?.(...args);
    } catch (error) {
      return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private downstream(id: string): GraphNode[] {
    const cached = this.downstreamCache.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [...(this.nodes.get(id)?.dependents ?? [])];
    while (stack.length) {
      const d = stack.pop() as string;
      if (seen.has(d)) continue;
      seen.add(d);
      stack.push(...(this.nodes.get(d)?.dependents ?? []));
    }
    const result = [...seen].map((d) => this.nodes.get(d) as GraphNode).sort((a, b) => a.index - b.index);
    this.downstreamCache.set(id, result);
    return result;
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const changed = new Set(this.pending);
    this.pending.clear();
    const candidates = new Map<string, GraphNode>();
    for (const source of changed) for (const node of this.downstream(source)) candidates.set(node.id, node);
    for (const node of [...candidates.values()].sort((a, b) => a.index - b.index)) {
      if (!node.inputs.some((input) => changed.has(input))) continue;
      const next = this.run(node);
      if (!node.equals(node.value, next)) { node.value = next; changed.add(node.id); }
    }
    for (const listener of this.listeners) listener(changed);
  }
}

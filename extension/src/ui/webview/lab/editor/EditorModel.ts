/**
 * Modelo do editor de equações estruturado (sem DOM; ver docs/51 §4.8 e ADR 0014).
 *
 * Comportamento estudado no `editor-base` do GeoGebra (EUPL-1.2; nenhum código copiado): árvore em vez de
 * texto; "/" leva o operando à esquerda para o numerador; "^" abre expoente; "|" abre módulo; nomes de
 * função viram template ao serem digitados; campo vazio exibe placeholder; setas e Tab percorrem campos.
 * Templates de Cálculo: ∫ definida, d/d□, lim (bilateral, ⁺, ⁻), Σ e Π.
 */
import { Ast, arg, argNode, argString, isNode } from "../calc/ast.js";
import { escapeXml } from "../calc/mathml.js";

export type TemplateKind = "frac" | "pow" | "sqrt" | "abs" | "paren" | "fn" | "int" | "deriv" | "lim" | "sum" | "prod";
interface Seq { kind: "seq"; id: number; items: Item[] }
interface CharItem { kind: "char"; c: string }
interface TemplateItem { kind: TemplateKind; fields: Seq[]; name?: string; dir?: number }
type Item = CharItem | TemplateItem;
interface Cursor { seq: Seq; offset: number }
interface Parent { node: TemplateItem; field: number; owner: Seq }

const OPERATORS = new Set(["+", "−", "·", "=", "<", ">"]);
/** Nomes digitados que viram template (mais longos primeiro). */
const WORDS: ReadonlyArray<readonly [string, { kind: TemplateKind | "char"; name?: string; c?: string }]> = [
  ["sqrt", { kind: "sqrt" }], ["prod", { kind: "prod" }], ["sum", { kind: "sum" }], ["int", { kind: "int" }],
  ["lim", { kind: "lim" }], ["abs", { kind: "abs" }], ["sin", { kind: "fn", name: "sin" }], ["sen", { kind: "fn", name: "sin" }],
  ["cos", { kind: "fn", name: "cos" }], ["tan", { kind: "fn", name: "tan" }], ["tg", { kind: "fn", name: "tan" }],
  ["exp", { kind: "fn", name: "exp" }], ["log", { kind: "fn", name: "log" }], ["ln", { kind: "fn", name: "ln" }], ["pi", { kind: "char", c: "π" }],
];
const FN_LABEL: Readonly<Record<string, string>> = { sin: "sen", cos: "cos", tan: "tg", exp: "exp", ln: "ln", log: "log" };
/** Campos que contam para "template vazio" (variável e início pré-preenchidos não contam). */
const CONTENT_FIELDS: Partial<Record<TemplateKind, readonly number[]>> = { int: [0, 1, 2], deriv: [1], lim: [1, 2], sum: [2, 3], prod: [2, 3] };
const CARET = '<mspace class="caret" width="0.08em" height="0.95em" depth="0.2em"></mspace>';

let nextSeqId = 0;
const seq = (items: Item[] = []): Seq => ({ kind: "seq", id: ++nextSeqId, items });
const chr = (c: string): CharItem => ({ kind: "char", c });
const tpl = (kind: TemplateKind, fields: Seq[], extra: { name?: string; dir?: number } = {}): TemplateItem => ({ kind, fields, ...extra });
const isTemplate = (item: Item): item is TemplateItem => item.kind !== "char";

export interface KeyInput { key: string; shift?: boolean; ctrl?: boolean }

export class EditorModel {
  private root: Seq = seq();
  private cursor: Cursor = { seq: this.root, offset: 0 };
  private parents = new Map<number, Parent>();
  private seqs = new Map<number, Seq>();
  private allSelected = false;

  constructor(private readonly variable = "x") { this.index(); }

  get selectionAll(): boolean { return this.allSelected; }

  /** Texto linear para o parser do núcleo (ponto decimal, operadores ASCII, operadores de Cálculo). */
  text(): string { return this.seqText(this.root); }

  /** Quantidade de campos de conteúdo vazios (placeholders a completar). */
  emptyFields(): number {
    let n = 0;
    const walk = (s: Seq, isContent: boolean): void => {
      if (isContent && s.items.length === 0) n++;
      for (const item of s.items) if (isTemplate(item)) item.fields.forEach((f, i) => walk(f, (CONTENT_FIELDS[item.kind] ?? [0, 1, 2, 3]).includes(i)));
    };
    walk(this.root, false);
    return n;
  }

  setAst(ast: Ast): void {
    this.root = seq(fromAst(ast));
    this.cursor = { seq: this.root, offset: this.root.items.length };
    this.allSelected = false;
    this.index();
  }

  clear(): void { this.root = seq(); this.cursor = { seq: this.root, offset: 0 }; this.allSelected = false; this.index(); }

  typeText(text: string): void { for (const c of text) this.typeChar(c); this.index(); }

  insertTemplate(kind: TemplateKind | "pow2", options: { name?: string; dir?: number; variable?: string } = {}): void {
    this.insertTemplateRaw(kind, options);
    this.index();
  }

  selectAll(): void { this.allSelected = true; }

  /** Processa uma tecla. Devolve true quando a tecla foi consumida (o chamador deve impedir o padrão). */
  key(input: KeyInput): boolean {
    if (input.ctrl) {
      if (input.key.toLowerCase() === "a") { this.allSelected = true; return true; }
      return false;
    }
    if (this.allSelected) {
      this.allSelected = false;
      if (input.key === "Backspace" || input.key === "Delete") { this.clear(); return true; }
      if (input.key.length === 1) this.clear();
    }
    const handled = this.navigateOrEdit(input);
    this.index();
    return handled;
  }

  /** Clique: posiciona o cursor no item `index` da sequência `seqId` (antes ou depois dele). */
  placeCursor(seqId: number | undefined, index: number | undefined, after: boolean): void {
    this.allSelected = false;
    const s = seqId === undefined ? undefined : this.seqs.get(seqId);
    if (!s) { this.cursor = { seq: this.root, offset: this.root.items.length }; return; }
    const i = index ?? s.items.length;
    this.cursor = { seq: s, offset: Math.min(s.items.length, i + (after ? 1 : 0)) };
  }

  /** Caminho legível do cursor (testes/acessibilidade). */
  cursorInfo(): { offset: number; template: string; field: number } {
    const p = this.parents.get(this.cursor.seq.id);
    return { offset: this.cursor.offset, template: p?.node.kind ?? "raiz", field: p?.field ?? 0 };
  }

  /** MathML com cursor e placeholders; atributos data-s/data-i permitem posicionar o cursor por clique. */
  render(): string { return `<math display="block">${this.renderSeq(this.root)}</math>`; }

  /** Leitura linear para leitores de tela. */
  readable(): string {
    return this.text().replace(/Integrate\(/g, "integral(").replace(/Limit\(/g, "limite(").replace(/Sum\(/g, "somatório(")
      .replace(/Product\(/g, "produtório(").replace(/\bD\(/g, "derivada(").replace(/\*/g, " vezes ").replace(/\^/g, " elevado a ")
      .replace(/sqrt\(/g, "raiz(").replace(/\//g, " sobre ");
  }

  // ------------------------------------------------------------------ edição
  private insert(item: Item): void { this.cursor.seq.items.splice(this.cursor.offset, 0, item); this.cursor.offset++; }
  private enter(node: TemplateItem, field = 0, atEnd = false): void {
    const s = node.fields[field] as Seq;
    this.cursor = { seq: s, offset: atEnd ? s.items.length : 0 };
  }
  private typeChar(c: string): void {
    if (c === "/" || c === "÷") { this.makeFraction(); return; }
    if (c === "^") { this.insertTemplateRaw("pow"); return; }
    if (c === "(" || c === "[") { this.insertTemplateRaw("paren"); return; }
    if (c === ")" || c === "]") { this.closeParen(); return; }
    if (c === "|") { this.insertTemplateRaw("abs"); return; }
    if (c === "√") { this.insertTemplateRaw("sqrt"); return; }
    if (c === "²") { this.insertTemplateRaw("pow2"); return; }
    const mapped = c === "*" || c === "×" ? "·" : c === "-" ? "−" : c === "." ? "," : c;
    if (!/^[0-9,+−·=<>a-zA-ZΔπ∞]$/.test(mapped)) return;
    this.insert(chr(mapped));
    if (/[a-zA-Z]/.test(mapped)) this.detectWord();
  }
  private detectWord(): void {
    const items = this.cursor.seq.items;
    let start = this.cursor.offset;
    const letterAt = (i: number): boolean => { const it = items[i]; return it !== undefined && it.kind === "char" && /[a-zA-Z]/.test(it.c); };
    while (start > 0 && letterAt(start - 1)) start--;
    const word = items.slice(start, this.cursor.offset).map((it) => (it.kind === "char" ? it.c : "")).join("");
    for (const [name, spec] of WORDS) {
      if (!word.endsWith(name)) continue;
      items.splice(this.cursor.offset - name.length, name.length);
      this.cursor.offset -= name.length;
      if (spec.kind === "char") this.insert(chr(spec.c as string));
      else this.insertTemplateRaw(spec.kind, spec.name ? { name: spec.name } : {});
      return;
    }
  }
  private makeFraction(): void {
    const { seq: s, offset } = this.cursor;
    let start = offset;
    const isOperator = (i: number): boolean => { const it = s.items[i]; return it !== undefined && it.kind === "char" && OPERATORS.has(it.c); };
    while (start > 0 && !isOperator(start - 1)) start--;
    const taken = s.items.splice(start, offset - start);
    const only = taken.length === 1 ? taken[0] : undefined;
    const numerator = only && isTemplate(only) && only.kind === "paren" ? (only.fields[0] as Seq).items : taken;
    const node = tpl("frac", [seq(numerator), seq()]);
    s.items.splice(start, 0, node);
    this.enter(node, numerator.length ? 1 : 0);
  }
  private insertTemplateRaw(kind: TemplateKind | "pow2", options: { name?: string; dir?: number; variable?: string } = {}): void {
    const v = (): Seq => seq([...(options.variable ?? this.variable)].map(chr));
    let node: TemplateItem, field = 0;
    switch (kind) {
      case "frac": this.makeFraction(); return;
      case "pow": node = tpl("pow", [seq()]); break;
      case "pow2": this.insert(tpl("pow", [seq([chr("2")])])); return;
      case "sqrt": case "abs": case "paren": node = tpl(kind, [seq()]); break;
      case "fn": node = tpl("fn", [seq()], { name: options.name ?? "sin" }); break;
      case "int": node = tpl("int", [seq(), seq(), seq(), v()]); break;
      case "deriv": node = tpl("deriv", [v(), seq()]); field = 1; break;
      case "lim": node = tpl("lim", [v(), seq(), seq()], { dir: options.dir ?? 0 }); field = 1; break;
      case "sum": case "prod": node = tpl(kind, [seq([chr("k")]), seq([chr("1")]), seq(), seq()]); field = 2; break;
    }
    this.insert(node);
    this.enter(node, field);
  }
  private closeParen(): void {
    for (let s = this.cursor.seq, p = this.parents.get(s.id); p; s = p.owner, p = this.parents.get(s.id)) {
      if (p.node.kind === "paren") { this.cursor = { seq: p.owner, offset: p.owner.items.indexOf(p.node) + 1 }; return; }
    }
  }
  private isEmpty(node: TemplateItem): boolean {
    return (CONTENT_FIELDS[node.kind] ?? node.fields.map((_, i) => i)).every((i) => (node.fields[i] as Seq).items.length === 0);
  }
  private navigateOrEdit(input: KeyInput): boolean {
    const { seq: s, offset } = this.cursor;
    const p = this.parents.get(s.id);
    const exitAfter = (q: Parent): void => { this.cursor = { seq: q.owner, offset: q.owner.items.indexOf(q.node) + 1 }; };
    const exitBefore = (q: Parent): void => { this.cursor = { seq: q.owner, offset: q.owner.items.indexOf(q.node) }; };
    switch (input.key) {
      case "ArrowRight": {
        const n = s.items[offset];
        if (n) { if (isTemplate(n)) this.enter(n, 0); else this.cursor.offset++; }
        else if (p) { if (p.field + 1 < p.node.fields.length) this.enter(p.node, p.field + 1); else exitAfter(p); }
        return true;
      }
      case "ArrowLeft": {
        const n = s.items[offset - 1];
        if (n) { if (isTemplate(n)) this.enter(n, n.fields.length - 1, true); else this.cursor.offset--; }
        else if (p) { if (p.field > 0) this.enter(p.node, p.field - 1, true); else exitBefore(p); }
        return true;
      }
      case "Tab":
        if (!p) return false; // deixa o foco seguir para o próximo controle
        if (input.shift) { if (p.field > 0) this.enter(p.node, p.field - 1, true); else exitBefore(p); }
        else if (p.field + 1 < p.node.fields.length) this.enter(p.node, p.field + 1); else exitAfter(p);
        return true;
      case "ArrowUp": case "ArrowDown": {
        if (!p) return true;
        const up = input.key === "ArrowUp";
        const pairs: Partial<Record<TemplateKind, readonly [number, number]>> = {
          frac: up ? [1, 0] : [0, 1], int: up ? [0, 1] : [1, 0], sum: up ? [1, 2] : [2, 1], prod: up ? [1, 2] : [2, 1],
        };
        const pair = pairs[p.node.kind];
        if (pair && p.field === pair[0]) this.enter(p.node, pair[1], true);
        return true;
      }
      case "Home": this.cursor.offset = 0; return true;
      case "End": this.cursor.offset = s.items.length; return true;
      case "Backspace": {
        const n = s.items[offset - 1];
        if (n) {
          if (!isTemplate(n) || this.isEmpty(n)) { s.items.splice(offset - 1, 1); this.cursor.offset--; }
          else this.enter(n, n.fields.length - 1, true);
        } else if (p) {
          const at = p.owner.items.indexOf(p.node);
          if (this.isEmpty(p.node)) { p.owner.items.splice(at, 1); this.cursor = { seq: p.owner, offset: at }; }
          else if (p.field > 0) this.enter(p.node, p.field - 1, true);
          else if (["paren", "abs", "sqrt", "fn", "pow"].includes(p.node.kind)) { // desfaz o template mantendo o conteúdo
            p.owner.items.splice(at, 1, ...(p.node.fields[0] as Seq).items);
            this.cursor = { seq: p.owner, offset: at };
          } else exitBefore(p);
        }
        return true;
      }
      case "Delete": {
        const n = s.items[offset];
        if (n) { if (!isTemplate(n) || this.isEmpty(n)) s.items.splice(offset, 1); else this.enter(n, 0); }
        return true;
      }
      default:
        if (input.key.length !== 1) return false;
        this.typeChar(input.key);
        return true;
    }
  }

  // ------------------------------------------------------------------ índice, texto e desenho
  private index(): void {
    this.parents = new Map();
    this.seqs = new Map();
    const walk = (s: Seq): void => {
      this.seqs.set(s.id, s);
      for (const item of s.items) if (isTemplate(item)) item.fields.forEach((f, field) => { this.parents.set(f.id, { node: item, field, owner: s }); walk(f); });
    };
    walk(this.root);
  }
  private seqText(s: Seq): string { return s.items.map((item) => this.itemText(item)).join(""); }
  private itemText(item: Item): string {
    if (!isTemplate(item)) return item.c === "·" ? "*" : item.c === "−" ? "-" : item.c === "," ? "." : item.c;
    const f = (i: number): string => this.seqText(item.fields[i] as Seq);
    switch (item.kind) {
      case "frac": return `((${f(0)})/(${f(1)}))`;
      case "pow": return `^(${f(0)})`;
      case "sqrt": return `sqrt(${f(0)})`;
      case "abs": return `abs(${f(0)})`;
      case "paren": return `(${f(0)})`;
      case "fn": return `${item.name}(${f(0)})`;
      case "int": return `Integrate(${f(3)}, (${f(0)}), (${f(1)}), (${f(2)}))`;
      case "deriv": return `D(${f(0)}, (${f(1)}))`;
      case "lim": return `Limit(${f(0)}, (${f(1)}), ${item.dir ?? 0}, (${f(2)}))`;
      default: return `${item.kind === "sum" ? "Sum" : "Product"}(${f(0)}, (${f(1)}), (${f(2)}), (${f(3)}))`;
    }
  }
  private renderSeq(s: Seq): string {
    const here = (i: number): boolean => this.cursor.seq === s && this.cursor.offset === i;
    if (s.items.length === 0) {
      return `<mrow data-s="${s.id}">${here(0) ? CARET : ""}<mspace class="ph" data-s="${s.id}" data-i="0" data-ph="1" width="0.62em" height="0.78em" depth="0.12em"></mspace></mrow>`;
    }
    const out: string[] = [];
    s.items.forEach((item, i) => {
      if (here(i)) out.push(CARET);
      const at = `data-s="${s.id}" data-i="${i}"`;
      if (isTemplate(item) && item.kind === "pow") { // expoente pós-fixado: o item anterior vira base
        let base = "<mrow></mrow>";
        if (out[out.length - 1] === CARET) { out.pop(); base = `<mrow>${out.pop() ?? ""}${CARET}</mrow>`; }
        else if (out.length) base = out.pop() as string;
        out.push(`<msup ${at}>${base}${this.renderSeq(item.fields[0] as Seq)}</msup>`);
        return;
      }
      out.push(this.renderItem(item, at));
    });
    if (here(s.items.length)) out.push(CARET);
    return `<mrow data-s="${s.id}">${out.join("")}</mrow>`;
  }
  private renderItem(item: Item, at: string): string {
    if (!isTemplate(item)) {
      if (/[0-9,]/.test(item.c)) return `<mn ${at}>${item.c}</mn>`;
      if (OPERATORS.has(item.c)) return `<mo ${at}>${item.c}</mo>`;
      return `<mi ${at}>${escapeXml(item.c)}</mi>`;
    }
    const r = (i: number): string => this.renderSeq(item.fields[i] as Seq);
    switch (item.kind) {
      case "frac": return `<mfrac ${at}>${r(0)}${r(1)}</mfrac>`;
      case "sqrt": return `<msqrt ${at}>${r(0)}</msqrt>`;
      case "abs": return `<mrow ${at}><mo>|</mo>${r(0)}<mo>|</mo></mrow>`;
      case "paren": return `<mrow ${at}><mo>(</mo>${r(0)}<mo>)</mo></mrow>`;
      case "fn": return `<mrow ${at}><mi>${escapeXml(FN_LABEL[item.name ?? ""] ?? item.name ?? "")}</mi><mo>&#x2061;</mo><mrow><mo>(</mo>${r(0)}<mo>)</mo></mrow></mrow>`;
      case "int": return `<mrow ${at}><msubsup><mo>∫</mo>${r(0)}${r(1)}</msubsup>${r(2)}<mspace width="0.17em"></mspace><mi>d</mi>${r(3)}</mrow>`;
      case "deriv": return `<mrow ${at}><mfrac><mi>d</mi><mrow><mi>d</mi>${r(0)}</mrow></mfrac><mrow><mo>(</mo>${r(1)}<mo>)</mo></mrow></mrow>`;
      case "lim": {
        const dir = item.dir ?? 0;
        const target = dir ? `<msup>${r(1)}<mo>${dir > 0 ? "+" : "−"}</mo></msup>` : r(1);
        return `<mrow ${at}><munder><mo movablelimits="false">lim</mo><mrow>${r(0)}<mo>→</mo>${target}</mrow></munder>${r(2)}</mrow>`;
      }
      default: return `<mrow ${at}><munderover><mo movablelimits="false">${item.kind === "sum" ? "∑" : "∏"}</mo><mrow>${r(0)}<mo>=</mo>${r(1)}</mrow>${r(2)}</munderover>${r(3)}</mrow>`;
    }
  }
}

/** AST do núcleo -> itens do editor (carregar uma expressão existente). */
const PREC: Readonly<Record<string, number>> = { Add: 1, Subtract: 1, Multiply: 2, Divide: 5, Negate: 3, Power: 4 };
function fromAst(node: Ast): Item[] {
  const prec = (x: Ast): number => (isNode(x) ? PREC[x[0]] ?? 5 : typeof x === "number" && x < 0 ? 3 : 5);
  const wrap = (x: Ast, min: number): Item[] => (prec(x) < min ? [tpl("paren", [seq(fromAst(x))])] : fromAst(x));
  const chars = (s: string): Item[] => [...s].map(chr);
  if (typeof node === "number") {
    if (node === Math.PI) return [chr("π")];
    if (node === Math.E) return [chr("e")];
    if (node === Infinity) return [chr("∞")];
    return chars(String(Number(node.toPrecision(12))).replace("-", "−").replace(".", ","));
  }
  if (typeof node === "string") return chars(node);
  const limits = (L: Ast): Seq[] => { const n = L as [string, ...Ast[]]; return [seq(chars(argString(n, 1))), seq(fromAst(arg(n, 2))), seq(fromAst(arg(n, 3)))]; };
  const a = (): Ast => arg(node, 1), b = (): Ast => arg(node, 2);
  switch (node[0]) {
    case "Add": return [...wrap(a(), 1), chr("+"), ...wrap(b(), 2)];
    case "Subtract": return [...wrap(a(), 1), chr("−"), ...wrap(b(), 2)];
    case "Negate": return [chr("−"), ...wrap(a(), 3)];
    case "Multiply": {
      const implicit = typeof a() === "number" && typeof b() !== "number";
      return implicit ? [...wrap(a(), 2), ...wrap(b(), 3)] : [...wrap(a(), 2), chr("·"), ...wrap(b(), 3)];
    }
    case "Divide": return [tpl("frac", [seq(fromAst(a())), seq(fromAst(b()))])];
    case "Power": return [...wrap(a(), 5), tpl("pow", [seq(fromAst(b()))])];
    case "Sqrt": return [tpl("sqrt", [seq(fromAst(a()))])];
    case "Abs": return [tpl("abs", [seq(fromAst(a()))])];
    case "Sin": case "Cos": case "Tan": case "Exp": case "Ln": case "Log": return [tpl("fn", [seq(fromAst(a()))], { name: node[0].toLowerCase() })];
    case "Call": return [tpl("fn", [seq(fromAst(b()))], { name: argString(node, 1) })];
    case "Integrate": { const [v, lo, hi] = limits(argNode(node, 2)) as [Seq, Seq, Seq]; return [tpl("int", [lo, hi, seq(fromAst(a())), v])]; }
    case "D": return [tpl("deriv", [seq(chars(argString(node, 2))), seq(fromAst(a()))])];
    case "Limit": return [tpl("lim", [seq(chars(argString(node, 2))), seq(fromAst(arg(node, 3))), seq(fromAst(a()))], { dir: arg(node, 4) as number })];
    case "Sum": case "Product": {
      const [v, m, n] = limits(argNode(node, 2)) as [Seq, Seq, Seq];
      return [tpl(node[0] === "Sum" ? "sum" : "prod", [v, m, n, seq(fromAst(a()))])];
    }
    default: throw new Error(`não há template para ${node[0]}`);
  }
}

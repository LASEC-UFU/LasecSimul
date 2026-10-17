// PoC isolada (NÃO é produção). Editor de equações estruturado, implementação própria.
//
// Comportamento estudado no editor do GeoGebra (`editor-base`, EUPL-1.2; nenhum código copiado):
// árvore Formula/Sequence/Function em vez de texto; "/" leva o operando à esquerda para o numerador
// (`ArgumentHelper.passArgument`); "^" abre expoente; "|" abre módulo; nomes de função viram
// template ao serem digitados; campo vazio exibe placeholder; setas entram e saem dos campos.
// Templates de Cálculo: ∫ definida, d/d□, lim (bilateral, ⁺, ⁻), Σ e Π.

let ids = 0;
const seq = (items = []) => ({ kind: "seq", id: ++ids, items });
const chr = (c) => ({ kind: "char", c });
const tpl = (kind, fields, extra = {}) => ({ kind, fields, ...extra });

const OPERATORS = new Set(["+", "−", "·", "=", "<", ">"]);
const WORDS = [ // nomes digitados que viram template (mais longos primeiro)
  ["sqrt", { kind: "sqrt" }], ["prod", { kind: "prod" }], ["sum", { kind: "sum" }], ["int", { kind: "int" }],
  ["lim", { kind: "lim" }], ["abs", { kind: "abs" }], ["sin", { kind: "fn", name: "sin" }], ["sen", { kind: "fn", name: "sin" }],
  ["cos", { kind: "fn", name: "cos" }], ["tan", { kind: "fn", name: "tan" }], ["tg", { kind: "fn", name: "tan" }],
  ["exp", { kind: "fn", name: "exp" }], ["log", { kind: "fn", name: "log" }], ["ln", { kind: "fn", name: "ln" }], ["pi", { kind: "char", c: "π" }],
];
const FN_LABEL = { sin: "sen", cos: "cos", tan: "tg", exp: "exp", ln: "ln", log: "log" };
/** Campos que contam para "template vazio" (ignora variável e início pré-preenchidos). */
const CONTENT_FIELDS = { int: [0, 1, 2], deriv: [1], lim: [1, 2], sum: [2, 3], prod: [2, 3] };
const CARET = '<mspace class="caret" width="0.08em" height="0.95em" depth="0.2em"></mspace>';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export class MathEditor {
  /**
   * @param {HTMLElement} host contêiner focável
   * @param {{variable?: string, onChange?: (text: string) => void, label?: string}} options
   */
  constructor(host, { variable = "x", onChange, label = "Editor de expressão" } = {}) {
    this.host = host; this.variable = variable; this.onChange = onChange; this.label = label;
    this.root = seq(); this.cursor = { seq: this.root, offset: 0 };
    host.tabIndex = 0;
    host.setAttribute("role", "textbox");
    host.classList.add("math-editor");
    host.addEventListener("keydown", (e) => this.#onKey(e));
    host.addEventListener("pointerdown", (e) => this.#onPointer(e));
    host.addEventListener("paste", (e) => { e.preventDefault(); this.typeText(e.clipboardData.getData("text")); });
    this.#commit(false);
  }

  // ------------------------------------------------------------------ API pública
  focus() { this.host.focus(); }
  /** Texto linear para o parser do núcleo (ponto decimal, operadores ASCII, operadores de Cálculo). */
  text() { return this.#seqText(this.root); }
  emptyFields() { let n = 0; const walk = (s, isContent) => { if (isContent && s.items.length === 0) n++; for (const it of s.items) if (it.fields) it.fields.forEach((f, i) => walk(f, (CONTENT_FIELDS[it.kind] ?? [0, 1, 2, 3]).includes(i))); }; walk(this.root, false); return n; }
  setAst(ast) { this.root = seq(fromAst(ast)); this.cursor = { seq: this.root, offset: this.root.items.length }; this.#commit(); }
  typeText(text) { for (const c of text) this.#typeChar(c); this.#commit(); }
  insertTemplate(kind, options = {}) { this.#insertTemplate(kind, options); this.#commit(); }
  key(name) { this.#onKey({ key: name, preventDefault() {}, shiftKey: false }); }
  /** Estado de cursor para testes: caminho legível. */
  cursorInfo() { const p = this.parents.get(this.cursor.seq.id); return { offset: this.cursor.offset, template: p?.node.kind ?? "raiz", field: p?.field ?? 0 }; }

  // ------------------------------------------------------------------ edição
  #insert(node) { this.cursor.seq.items.splice(this.cursor.offset, 0, node); this.cursor.offset++; }
  #enter(node, field = 0, atEnd = false) { const s = node.fields[field]; this.cursor = { seq: s, offset: atEnd ? s.items.length : 0 }; }
  #typeChar(c) {
    if (c === "/" || c === "÷") return this.#makeFraction();
    if (c === "^") return this.#insertTemplate("pow");
    if (c === "(" || c === "[") return this.#insertTemplate("paren");
    if (c === ")" || c === "]") return this.#closeParen();
    if (c === "|") return this.#insertTemplate("abs");
    if (c === "√") return this.#insertTemplate("sqrt");
    if (c === "²") return this.#insertTemplate("pow2");
    const mapped = c === "*" || c === "×" ? "·" : c === "-" ? "−" : c === "." ? "," : c;
    if (!/^[0-9,+−·=<>a-zA-ZΔπ∞]$/.test(mapped)) return;
    this.#insert(chr(mapped));
    if (/[a-zA-Z]/.test(mapped)) this.#detectWord();
  }
  #detectWord() {
    const items = this.cursor.seq.items;
    let start = this.cursor.offset;
    while (start > 0 && items[start - 1].kind === "char" && /[a-zA-Z]/.test(items[start - 1].c)) start--;
    const word = items.slice(start, this.cursor.offset).map((n) => n.c).join("");
    for (const [name, spec] of WORDS) {
      if (!word.endsWith(name)) continue;
      items.splice(this.cursor.offset - name.length, name.length);
      this.cursor.offset -= name.length;
      if (spec.kind === "char") this.#insert(chr(spec.c));
      else this.#insertTemplate(spec.kind, spec);
      return;
    }
  }
  #makeFraction() {
    const { seq: s, offset } = this.cursor;
    let start = offset;
    while (start > 0 && !(s.items[start - 1].kind === "char" && OPERATORS.has(s.items[start - 1].c))) start--;
    const taken = s.items.splice(start, offset - start);
    const numItems = taken.length === 1 && taken[0].kind === "paren" ? taken[0].fields[0].items : taken;
    const node = tpl("frac", [seq(numItems), seq()]);
    s.items.splice(start, 0, node);
    this.#enter(node, numItems.length ? 1 : 0);
  }
  #insertTemplate(kind, options = {}) {
    const v = () => seq([...(options.variable ?? this.variable)].map(chr));
    let node, field = 0;
    switch (kind) {
      case "frac": return this.#makeFraction();
      case "pow": node = tpl("pow", [seq()]); break;
      case "pow2": node = tpl("pow", [seq([chr("2")])]); this.#insert(node); return;
      case "sqrt": case "abs": case "paren": node = tpl(kind, [seq()]); break;
      case "fn": node = tpl("fn", [seq()], { name: options.name }); break;
      case "int": node = tpl("int", [seq(), seq(), seq(), v()]); break;
      case "deriv": node = tpl("deriv", [v(), seq()]); field = 1; break;
      case "lim": node = tpl("lim", [v(), seq(), seq()], { dir: options.dir ?? 0 }); field = 1; break;
      case "sum": case "prod": node = tpl(kind, [seq([chr("k")]), seq([chr("1")]), seq(), seq()]); field = 2; break;
      default: throw new Error(`template desconhecido ${kind}`);
    }
    this.#insert(node);
    this.#enter(node, field);
  }
  #closeParen() {
    for (let s = this.cursor.seq, p = this.parents.get(s.id); p; s = p.owner, p = this.parents.get(s.id)) {
      if (p.node.kind === "paren") { this.cursor = { seq: p.owner, offset: p.owner.items.indexOf(p.node) + 1 }; return; }
    }
  }
  #isEmpty(node) { return (CONTENT_FIELDS[node.kind] ?? node.fields.map((_, i) => i)).every((i) => node.fields[i].items.length === 0); }

  // ------------------------------------------------------------------ teclado e ponteiro
  #onKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { // selecionar tudo
      e.preventDefault(); this.allSelected = true; this.host.classList.add("all-selected"); return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.allSelected) {
      this.allSelected = false; this.host.classList.remove("all-selected");
      if (e.key === "Backspace" || e.key === "Delete" || e.key.length === 1) {
        this.root = seq(); this.cursor = { seq: this.root, offset: 0 };
        if (e.key.length !== 1) { e.preventDefault(); this.#commit(); return; }
      }
    }
    const { seq: s, offset } = this.cursor;
    const p = this.parents.get(s.id);
    const exitAfter = () => { this.cursor = { seq: p.owner, offset: p.owner.items.indexOf(p.node) + 1 }; };
    const exitBefore = () => { this.cursor = { seq: p.owner, offset: p.owner.items.indexOf(p.node) }; };
    switch (e.key) {
      case "ArrowRight":
        if (offset < s.items.length) { const n = s.items[offset]; if (n.kind === "char") this.cursor.offset++; else this.#enter(n, 0); }
        else if (p) { if (p.field + 1 < p.node.fields.length) this.#enter(p.node, p.field + 1); else exitAfter(); }
        break;
      case "ArrowLeft":
        if (offset > 0) { const n = s.items[offset - 1]; if (n.kind === "char") this.cursor.offset--; else this.#enter(n, n.fields.length - 1, true); }
        else if (p) { if (p.field > 0) this.#enter(p.node, p.field - 1, true); else exitBefore(); }
        break;
      case "Tab":
        if (!p) return; // deixa o foco seguir para o próximo controle
        if (e.shiftKey) { if (p.field > 0) this.#enter(p.node, p.field - 1, true); else exitBefore(); }
        else if (p.field + 1 < p.node.fields.length) this.#enter(p.node, p.field + 1); else exitAfter();
        break;
      case "ArrowUp": case "ArrowDown": {
        if (!p) break;
        const up = e.key === "ArrowUp";
        const pairs = { frac: up ? [1, 0] : [0, 1], int: up ? [0, 1] : [1, 0], sum: up ? [1, 2] : [2, 1], prod: up ? [1, 2] : [2, 1] }[p.node.kind];
        if (pairs && p.field === pairs[0]) this.#enter(p.node, pairs[1], true);
        break;
      }
      case "Home": this.cursor.offset = 0; break;
      case "End": this.cursor.offset = s.items.length; break;
      case "Backspace":
        if (offset > 0) {
          const n = s.items[offset - 1];
          if (n.kind === "char" || this.#isEmpty(n)) { s.items.splice(offset - 1, 1); this.cursor.offset--; }
          else this.#enter(n, n.fields.length - 1, true);
        } else if (p) {
          const at = p.owner.items.indexOf(p.node);
          if (this.#isEmpty(p.node)) { p.owner.items.splice(at, 1); this.cursor = { seq: p.owner, offset: at }; }
          else if (p.field > 0) this.#enter(p.node, p.field - 1, true);
          else if (["paren", "abs", "sqrt", "fn", "pow"].includes(p.node.kind)) { // desfaz o template mantendo o conteúdo
            p.owner.items.splice(at, 1, ...p.node.fields[0].items); this.cursor = { seq: p.owner, offset: at };
          } else exitBefore();
        }
        break;
      case "Delete":
        if (offset < s.items.length) {
          const n = s.items[offset];
          if (n.kind === "char" || this.#isEmpty(n)) s.items.splice(offset, 1); else this.#enter(n, 0);
        }
        break;
      default:
        if (e.key.length !== 1) return;
        this.#typeChar(e.key);
    }
    e.preventDefault();
    this.#commit();
  }
  #onPointer(e) {
    // Foca ANTES de redesenhar: o redesenho remove o alvo do clique e o foco padrão do navegador se perderia.
    e.preventDefault();
    this.host.focus({ preventScroll: true });
    const el = e.target.closest?.("[data-s]");
    const s = el ? this.seqs.get(Number(el.dataset.s)) : undefined;
    if (!s) { this.cursor = { seq: this.root, offset: this.root.items.length }; }
    else {
      const i = Number(el.dataset.i ?? s.items.length);
      const r = el.getBoundingClientRect();
      const after = el.dataset.i !== undefined && el.dataset.ph === undefined && e.clientX > r.left + r.width / 2;
      this.cursor = { seq: s, offset: Math.min(s.items.length, i + (after ? 1 : 0)) };
    }
    this.#commit(false);
  }

  // ------------------------------------------------------------------ índice, texto e desenho
  #index() {
    this.parents = new Map(); this.seqs = new Map();
    const walk = (s) => {
      this.seqs.set(s.id, s);
      for (const node of s.items) node.fields?.forEach((f, field) => { this.parents.set(f.id, { node, field, owner: s }); walk(f); });
    };
    walk(this.root);
  }
  #commit(changed = true) {
    this.#index();
    this.host.innerHTML = `<math display="block">${this.#renderSeq(this.root)}</math>`;
    this.host.setAttribute("aria-label", `${this.label}: ${readable(this.text())}`);
    if (changed) this.onChange?.(this.text());
  }
  #seqText(s) { return s.items.map((n) => this.#nodeText(n)).join(""); }
  #nodeText(n) {
    const f = (i) => this.#seqText(n.fields[i]);
    switch (n.kind) {
      case "char": return n.c === "·" ? "*" : n.c === "−" ? "-" : n.c === "," ? "." : n.c;
      case "frac": return `((${f(0)})/(${f(1)}))`;
      case "pow": return `^(${f(0)})`;
      case "sqrt": return `sqrt(${f(0)})`;
      case "abs": return `abs(${f(0)})`;
      case "paren": return `(${f(0)})`;
      case "fn": return `${n.name}(${f(0)})`;
      case "int": return `Integrate(${f(3)}, (${f(0)}), (${f(1)}), (${f(2)}))`;
      case "deriv": return `D(${f(0)}, (${f(1)}))`;
      case "lim": return `Limit(${f(0)}, (${f(1)}), ${n.dir}, (${f(2)}))`;
      default: return `${n.kind === "sum" ? "Sum" : "Product"}(${f(0)}, (${f(1)}), (${f(2)}), (${f(3)}))`;
    }
  }
  #renderSeq(s) {
    const here = (i) => this.cursor.seq === s && this.cursor.offset === i;
    if (s.items.length === 0) {
      return `<mrow data-s="${s.id}">${here(0) ? CARET : ""}<mspace class="ph" data-s="${s.id}" data-i="0" data-ph="1" width="0.62em" height="0.78em" depth="0.12em"></mspace></mrow>`;
    }
    const out = [];
    s.items.forEach((n, i) => {
      if (here(i)) out.push(CARET);
      const at = `data-s="${s.id}" data-i="${i}"`;
      if (n.kind === "pow") { // expoente pós-fixado: o item anterior vira base
        let base = "<mrow></mrow>";
        if (out.length && out.at(-1) === CARET) { out.pop(); base = `<mrow>${out.pop() ?? ""}${CARET}</mrow>`; }
        else if (out.length) base = out.pop();
        out.push(`<msup ${at}>${base}${this.#renderSeq(n.fields[0])}</msup>`);
        return;
      }
      out.push(this.#renderNode(n, at));
    });
    if (here(s.items.length)) out.push(CARET);
    return `<mrow data-s="${s.id}">${out.join("")}</mrow>`;
  }
  #renderNode(n, at) {
    const r = (i) => this.#renderSeq(n.fields[i]);
    switch (n.kind) {
      case "char":
        if (/[0-9,]/.test(n.c)) return `<mn ${at}>${n.c}</mn>`;
        if (OPERATORS.has(n.c)) return `<mo ${at}>${n.c}</mo>`;
        return `<mi ${at}>${esc(n.c)}</mi>`;
      case "frac": return `<mfrac ${at}>${r(0)}${r(1)}</mfrac>`;
      case "sqrt": return `<msqrt ${at}>${r(0)}</msqrt>`;
      case "abs": return `<mrow ${at}><mo>|</mo>${r(0)}<mo>|</mo></mrow>`;
      case "paren": return `<mrow ${at}><mo>(</mo>${r(0)}<mo>)</mo></mrow>`;
      case "fn": return `<mrow ${at}><mi>${FN_LABEL[n.name] ?? n.name}</mi><mo>&#x2061;</mo><mrow><mo>(</mo>${r(0)}<mo>)</mo></mrow></mrow>`;
      case "int": return `<mrow ${at}><msubsup><mo>∫</mo>${r(0)}${r(1)}</msubsup>${r(2)}<mspace width="0.17em"></mspace><mi>d</mi>${r(3)}</mrow>`;
      case "deriv": return `<mrow ${at}><mfrac><mi>d</mi><mrow><mi>d</mi>${r(0)}</mrow></mfrac><mrow><mo>(</mo>${r(1)}<mo>)</mo></mrow></mrow>`;
      case "lim": {
        const target = n.dir ? `<msup>${r(1)}<mo>${n.dir > 0 ? "+" : "−"}</mo></msup>` : r(1);
        return `<mrow ${at}><munder><mo movablelimits="false">lim</mo><mrow>${r(0)}<mo>→</mo>${target}</mrow></munder>${r(2)}</mrow>`;
      }
      default: return `<mrow ${at}><munderover><mo movablelimits="false">${n.kind === "sum" ? "∑" : "∏"}</mo><mrow>${r(0)}<mo>=</mo>${r(1)}</mrow>${r(2)}</munderover>${r(3)}</mrow>`;
    }
  }
}

/** Leitura linear para leitores de tela. */
function readable(text) {
  return text.replace(/Integrate\(/g, "integral(").replace(/Limit\(/g, "limite(").replace(/Sum\(/g, "somatório(")
    .replace(/Product\(/g, "produtório(").replace(/\bD\(/g, "derivada(").replace(/\*/g, " vezes ").replace(/\^/g, " elevado a ")
    .replace(/sqrt\(/g, "raiz(").replace(/\//g, " sobre ");
}

/** AST do núcleo -> itens do editor (para carregar uma expressão existente). */
const PREC = { Add: 1, Subtract: 1, Multiply: 2, Divide: 5, Negate: 3, Power: 4 };
function fromAst(node) {
  const prec = (x) => (Array.isArray(x) ? PREC[x[0]] ?? 5 : typeof x === "number" && x < 0 ? 3 : 5);
  const wrap = (x, min) => (prec(x) < min ? [tpl("paren", [seq(fromAst(x))])] : fromAst(x));
  const chars = (s) => [...s].map(chr);
  if (typeof node === "number") return node === Math.PI ? [chr("π")] : node === Math.E ? [chr("e")] : node === Infinity ? [chr("∞")] : chars(String(Number(node.toPrecision(12))).replace("-", "−").replace(".", ","));
  if (typeof node === "string") return chars(node);
  const [head, a, b, c, d] = node;
  const limits = (L) => [seq(chars(L[1])), seq(fromAst(L[2])), seq(fromAst(L[3]))];
  switch (head) {
    case "Add": return [...wrap(a, 1), chr("+"), ...wrap(b, 2)];
    case "Subtract": return [...wrap(a, 1), chr("−"), ...wrap(b, 2)];
    case "Negate": return [chr("−"), ...wrap(a, 3)];
    case "Multiply": {
      const implicit = typeof a === "number" && !(typeof b === "number");
      return implicit ? [...wrap(a, 2), ...wrap(b, 3)] : [...wrap(a, 2), chr("·"), ...wrap(b, 3)];
    }
    case "Divide": return [tpl("frac", [seq(fromAst(a)), seq(fromAst(b))])];
    case "Power": return [...wrap(a, 5), tpl("pow", [seq(fromAst(b))])];
    case "Sqrt": return [tpl("sqrt", [seq(fromAst(a))])];
    case "Abs": return [tpl("abs", [seq(fromAst(a))])];
    case "Sin": case "Cos": case "Tan": case "Exp": case "Ln": case "Log": return [tpl("fn", [seq(fromAst(a))], { name: head.toLowerCase() })];
    case "Integrate": { const [v, lo, hi] = limits(b); return [tpl("int", [lo, hi, seq(fromAst(a)), v])]; }
    case "D": return [tpl("deriv", [seq(chars(b)), seq(fromAst(a))])];
    case "Limit": return [tpl("lim", [seq(chars(b)), seq(fromAst(c)), seq(fromAst(a))], { dir: d })];
    case "Sum": case "Product": { const [v, m, n] = limits(b); return [tpl(head === "Sum" ? "sum" : "prod", [v, m, n, seq(fromAst(a))])]; }
    case "Call": return [tpl("fn", [seq(fromAst(b))], { name: a })];
    default: throw new Error(`não há template para ${head}`);
  }
}

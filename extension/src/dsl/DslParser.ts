import { nodeEndpoint, portEndpoint } from "../ui/webview/model.js";
import { DEFAULT_PIN_SENTINEL } from "./DslTypes.js";
import type { DslComponent, DslDiagnostic, DslDocument, DslEndpoint, DslNode, DslParseResult, DslTunnel, DslValue, DslWire } from "./DslTypes.js";

export type Token = { kind: "word" | "string" | "number" | "symbol" | "eof"; text: string; line: number; column: number };

/** Exported so other Lasec DSL parsers (e.g. `HartCommandDsl.ts`, HART command
 * bodies) reuse the SAME tokenizer instead of a second hand-rolled one -- the
 * "ONE LASEC DSL" principle applies at the lexical level even where the
 * grammar above this layer is domain-specific (circuit topology vs. a HART
 * command's bounded byte-transform pipeline are different enough semantically
 * to warrant separate parsers/compilers, but not a second lexer). */
export function lex(source: string): { tokens: Token[]; diagnostics: DslDiagnostic[] } {
  const tokens: Token[] = []; const diagnostics: DslDiagnostic[] = [];
  let i = 0; let line = 1; let column = 1;
  const advance = (text: string) => { for (const c of text) { if (c === "\n") { line++; column = 1; } else column++; } i += text.length; };
  while (i < source.length) {
    const rest = source.slice(i);
    const ws = /^[ \t\r\n]+/.exec(rest); if (ws) { advance(ws[0]!); continue; }
    const comment = /^(\/\/|#)[^\n]*/.exec(rest); if (comment) { advance(comment[0]!); continue; }
    const start = { line, column };
    const str = /^"(?:\\.|[^"\\])*"/.exec(rest);
    if (str) { tokens.push({ kind: "string", text: str[0], ...start }); advance(str[0]); continue; }
    const number = /^-?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][+-]?\d+)?(?:[A-Za-z]+)?/.exec(rest);
    if (number) { tokens.push({ kind: "number", text: number[0], ...start }); advance(number[0]); continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(rest);
    if (word) { tokens.push({ kind: "word", text: word[0], ...start }); advance(word[0]); continue; }
    const symbol = /^(->|==|!=|<=|>=|\{|\}|\[|\]|\(|\)|:|=|,|;|\.|@|<|>)/.exec(rest);
    if (symbol) { tokens.push({ kind: "symbol", text: symbol[0]!, ...start }); advance(symbol[0]!); continue; }
    diagnostics.push({ message: `caractere inesperado '${rest[0]}'`, ...start, severity: "error" }); advance(rest[0]!);
  }
  tokens.push({ kind: "eof", text: "", line, column }); return { tokens, diagnostics };
}

function parseLegacyDsl(source: string): DslParseResult {
  const scanned = lex(source); const tokens = scanned.tokens; const diagnostics = [...scanned.diagnostics]; let p = 0;
  const peek = () => tokens[p]!; const take = () => tokens[p++]!;
  const error = (message: string, token = peek()) => diagnostics.push({ message, line: token.line, column: token.column, severity: "error" });
  const expect = (text: string): boolean => { if (peek().text !== text) { error(`esperado '${text}'`); return false; } take(); return true; };
  const expectWord = (): string | undefined => { const t = take(); if (t.kind !== "word" && t.kind !== "string") { error("identificador esperado", t); return undefined; } return t.kind === "string" ? JSON.parse(t.text) as string : t.text; };
  const value = (): DslValue | undefined => {
    const t = peek();
    if (t.kind === "string") { take(); return JSON.parse(t.text) as string; }
    if (t.kind === "number") { take(); return Number(t.text); }
    if (t.text === "true" || t.text === "false") { take(); return t.text === "true"; }
    if (t.text === "[") { take(); const values: DslValue[] = []; while (peek().text !== "]" && peek().kind !== "eof") { const v = value(); if (v !== undefined) values.push(v); if (peek().text === ",") take(); else if (peek().text !== "]") { error("esperado ',' ou ']'" ); break; } } expect("]"); return values; }
    error("valor esperado"); return undefined;
  };
  const endpoint = () => {
    const token = take();
    if (token.kind !== "word") { error("endpoint deve usar componente.porta", token); return undefined; }
    if (token.text.startsWith("node.")) return nodeEndpoint(token.text.slice("node.".length));
    const separator = token.text.lastIndexOf(".");
    if (separator <= 0 || separator === token.text.length - 1) { error("endpoint deve usar componente.porta", token); return undefined; }
    return portEndpoint(token.text.slice(0, separator), token.text.slice(separator + 1));
  };
  if (peek().text !== "model") { error("documento deve começar com 'model'"); return { diagnostics }; }
  take(); const name = expectWord(); if (!name || !expect("{")) return { diagnostics };
  const components: DslComponent[] = []; const nodes: DslDocument["nodes"] = []; const wires: DslDocument["wires"] = [];
  while (peek().kind !== "eof" && peek().text !== "}") {
    const kind = expectWord();
    if (kind === "component") {
      const id = expectWord(); const typeId = expectWord(); if (!id || !typeId || !expect("{")) continue;
      const properties: Record<string, DslValue> = {};
      while (peek().text !== "}" && peek().kind !== "eof") { const key = expectWord(); if (!key || !expect("=")) { while (peek().text !== ";" && peek().text !== "}" && peek().kind !== "eof") take(); if (peek().text === ";") take(); continue; } const v = value(); if (v !== undefined) properties[key] = v; expect(";"); }
      expect("}"); components.push({ id, typeId, properties }); continue;
    }
    if (kind === "node") { const id = expectWord(); if (id) nodes.push({ id }); expect(";"); continue; }
    if (kind === "wire") {
      const id = expectWord(); if (!id || !expect(":")) continue; const from = endpoint(); expect("->"); const to = endpoint(); if (from && to) wires.push({ id, from, to }); expect(";"); continue;
    }
    if (kind) error(`declaração desconhecida '${kind}'`);
    while (peek().text !== ";" && peek().text !== "}" && peek().kind !== "eof") take(); if (peek().text === ";") take();
  }
  expect("}"); if (peek().kind !== "eof") error("tokens após o fim do documento");
  const ids = new Set<string>(); for (const item of [...components, ...nodes, ...wires]) { if (ids.has(item.id)) diagnostics.push({ message: `ID duplicado '${item.id}'`, line: 1, column: 1, severity: "error" }); ids.add(item.id); }
  return diagnostics.some((d) => d.severity === "error") ? { diagnostics } : { document: { name: name ?? "LasecSimul", components, nodes, wires }, diagnostics };
}

/** Compact graph authoring syntax. It is lowered to the same DslDocument as
 * the explicit model/component/wire form; no runtime evaluator is involved. */
function parseCompactDsl(source: string): DslParseResult {
  const scanned = lex(source); const tokens = scanned.tokens; const diagnostics = [...scanned.diagnostics]; let p = 0;
  const peek = () => tokens[p]!; const take = () => tokens[p++]!;
  const error = (message: string, token = peek()) => diagnostics.push({ message, line: token.line, column: token.column, severity: "error" });
  const expect = (text: string) => { if (peek().text !== text) { error(`esperado '${text}'`); return false; } take(); return true; };
  const word = () => { const t = take(); if (t.kind !== "word" && t.kind !== "string") { error("identificador esperado", t); return undefined; } return t.kind === "string" ? JSON.parse(t.text) as string : t.text; };
  const components: DslComponent[] = []; const wires: DslWire[] = []; const nodes: DslNode[] = []; const tunnels: DslTunnel[] = [];
  const declared = new Set<string>();
  // Anonymous inline blocks (`A -> Gain(2) -> B`, no explicit `name = Type(...)`
  // binding) and auto-numbered wires used to get their id from a SINGLE counter
  // shared across the whole document (`inlineNo++`/`wireNo++`). That made every
  // anonymous entity's identity depend on how many OTHER anonymous entities had
  // already been declared earlier in the file -- adding, removing, or
  // reordering an unrelated chain anywhere else would silently reassign the id
  // of every inline block/wire declared after it, breaking position/route
  // preservation in `reconcileDsl` (which looks entities up by id). Counters
  // are now scoped per chain-anchor (the stable identity the chain hangs off
  // of -- a component id, tunnel name, or in/out context port) so an edit to
  // one chain cannot perturb another chain's generated ids. Two structurally
  // identical inline blocks in DIFFERENT chains (e.g. `A -> Gain(2) -> B` and
  // `C -> Gain(2) -> D`) get different ids because their anchors differ; two
  // in the SAME chain get distinct sequential ids because the counter is
  // per-anchor, not global.
  const anchorCounts = new Map<string, number>();
  const wireCounts = new Map<string, number>();
  const endpointAnchor = (e: DslEndpoint): string => {
    if (e.kind === "tunnel") return `tunnel_${e.tunnelId}`;
    if (e.kind === "context") return `context_${e.direction}_${e.portId ?? "default"}`;
    return (e.kind === "node" ? e.nodeId : e.componentId).replace(/[^A-Za-z0-9_]/g, "_");
  };
  const addInline = (typeId: string, properties: Record<string, DslValue>, anchor: string, explicit?: string): string => {
    let id = explicit;
    if (id === undefined) {
      const sanitizedType = typeId.replace(/[^A-Za-z0-9_]/g, "_");
      const next = anchorCounts.get(anchor) ?? 0;
      anchorCounts.set(anchor, next + 1);
      id = `__inline_${anchor}_${sanitizedType}_${next}`;
    }
    components.push({ id, typeId, properties }); declared.add(id); return id;
  };
  const nextWireId = (from: DslEndpoint, to: DslEndpoint): string => {
    const key = `${endpointAnchor(from)}__${endpointAnchor(to)}`;
    const next = wireCounts.get(key) ?? 0;
    wireCounts.set(key, next + 1);
    return `wire_${key}${next > 0 ? `_${next}` : ""}`;
  };
  const value = (): DslValue | undefined => {
    const t = peek();
    if (t.kind === "string") { take(); return JSON.parse(t.text) as string; }
    if (t.kind === "number") { take(); const n = Number.parseFloat(t.text); return Number.isFinite(n) ? n : t.text; }
    if (t.text === "true" || t.text === "false") { take(); return t.text === "true"; }
    if (t.text === "[") { take(); const out: DslValue[] = []; while (peek().text !== "]" && peek().kind !== "eof") { const v = value(); if (v !== undefined) out.push(v); if (peek().text === ",") take(); else break; } expect("]"); return out; }
    error("valor esperado"); return undefined;
  };
  const parseTarget = (): DslEndpoint | undefined => {
    if (peek().text === "@") { take(); const name = word(); if (!name) return undefined; if (!tunnels.some((x) => x.id === name)) tunnels.push({ id: name, name }); return { kind: "tunnel", tunnelId: name }; }
    const raw = word(); if (!raw) return undefined;
    // The lexer's word regex intentionally includes '.' (so `endpoint.pin`
    // lexes as ONE token, matching the legacy grammar's own `endpoint()`
    // helper) -- so `peek().text === "."` right after `word()` can never be
    // true for realistic input; that dead branch used to make EVERY
    // `component.pin` / `in.port` / `out.port` reference here silently
    // resolve as a component/context literally named "component.pin" with a
    // hardcoded default "out" pin, instead of splitting on the dot. Split
    // manually, same rule the legacy `endpoint()` parser already uses
    // (split at the LAST '.'; a trailing dot with nothing after it doesn't
    // count as a separator).
    const separator = raw.lastIndexOf(".");
    const hasTail = separator > 0 && separator < raw.length - 1;
    const head = hasTail ? raw.slice(0, separator) : raw;
    const tail = hasTail ? raw.slice(separator + 1) : undefined;
    if (head === "in" || head === "out") return { kind: "context", direction: head, portId: tail };
    if (tail !== undefined) return portEndpoint(head, tail);
    // Bare reference, no `.pin` given: the parser has no catalog access to
    // pick a real pin id (see DEFAULT_PIN_SENTINEL) -- `reconcileDsl` resolves
    // this once it has the component's actual, ordered pin list.
    return portEndpoint(head, DEFAULT_PIN_SENTINEL);
  };
  const parseBlock = (anchor: string): string | undefined => {
    const type = word(); if (!type) return undefined; const props: Record<string, DslValue> = {};
    if (peek().text === "(") { take(); let positional = 0; while (peek().text !== ")" && peek().kind !== "eof") { const key = peek().kind === "word" && tokens[p + 1]?.text === "=" ? word() : undefined; if (key) { expect("="); const v = value(); if (v !== undefined) props[key] = v; } else { const v = value(); if (v !== undefined) props[`arg${positional++}`] = v; } if (peek().text === ",") take(); else if (peek().text !== ")") { error("esperado ',' ou ')'"); break; } } expect(")"); }
    return addInline(type, props, anchor);
  };
  const parseChain = (first: DslEndpoint | string | undefined) => {
    let current: DslEndpoint | undefined = typeof first === "string" ? portEndpoint(first, DEFAULT_PIN_SENTINEL) : first;
    // The chain's own starting endpoint is the anchor for every anonymous
    // inline block/wire declared within it -- stable across unrelated edits
    // elsewhere in the document (see the comment on `anchorCounts` above).
    const anchor = current ? endpointAnchor(current) : "root";
    while (peek().text === "->") { take(); let next: DslEndpoint | undefined; if (peek().kind === "word" && tokens[p + 1]?.text === "(" ) next = portEndpoint(parseBlock(anchor)!, DEFAULT_PIN_SENTINEL); else next = parseTarget(); if (!current || !next) return; wires.push({ id: nextWireId(current, next), from: current, to: next }); current = next; }
  };
  // A statement ends at an explicit ';', at '}'/eof, OR at a line break (this
  // IS the "compact" one-connection-per-line syntax -- requiring a trailing
  // ';' on every line defeats the point, and the tests/usage this grammar
  // was written for never included one). `tokens[p - 1]` is the last token
  // actually consumed by the statement just parsed.
  const statementTerminated = (): boolean => {
    if (peek().text === ";") { take(); return true; }
    if (peek().text === "}" || peek().kind === "eof") return true;
    const lastConsumedLine = tokens[p - 1]?.line;
    return lastConsumedLine === undefined || peek().line > lastConsumedLine;
  };
  if (peek().text === "model") { take(); word(); } if (!expect("{")) return { diagnostics };
  while (peek().kind !== "eof" && peek().text !== "}") {
    if (peek().kind !== "word" && peek().text !== "@") { error("declaração esperada"); take(); continue; }
    if (peek().kind === "word" && tokens[p + 1]?.text === "=" && tokens[p + 2]?.kind === "word") { const id = word()!; take(); const type = word()!; const props: Record<string, DslValue> = {}; if (peek().text === "(") { take(); while (peek().text !== ")" && peek().kind !== "eof") { const k = word(); expect("="); const v = value(); if (k && v !== undefined) props[k] = v; if (peek().text === ",") take(); else break; } expect(")"); } addInline(type, props, id, id); if (!statementTerminated()) error("esperado ';' ou fim de linha"); continue; }
    const first = peek().text === "@" ? parseTarget() : parseTarget(); parseChain(first); if (!statementTerminated()) error("esperado ';' ou fim de linha");
  }
  expect("}");
  for (const t of tunnels) nodes.push({ id: `tunnel:${t.id}` });
  if (diagnostics.some((d) => d.severity === "error")) return { diagnostics };
  return { document: { name: "Circuit", components, nodes, wires, tunnels }, diagnostics };
}

export function parseDsl(source: string): DslParseResult {
  const trimmed = source.trimStart();
  return trimmed.startsWith("model ") || trimmed.startsWith("model{") || trimmed.startsWith("model\n")
    ? parseLegacyDsl(source) : parseCompactDsl(source);
}

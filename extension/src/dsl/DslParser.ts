import { nodeEndpoint, portEndpoint } from "../ui/webview/model.js";
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
  const declared = new Set<string>(); let inlineNo = 0; let wireNo = 0;
  const addInline = (typeId: string, properties: Record<string, DslValue>, explicit?: string): string => {
    const id = explicit ?? `__inline_${typeId.replace(/[^A-Za-z0-9_]/g, "_")}_${inlineNo++}`;
    components.push({ id, typeId, properties }); declared.add(id); return id;
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
    const first = word(); if (!first) return undefined;
    if (first === "in" || first === "out") { let portId: string | undefined; if (peek().text === ".") { take(); portId = word(); } return { kind: "context", direction: first, portId }; }
    if (peek().text === ".") { take(); const pin = word(); if (!pin) return undefined; return portEndpoint(first, pin); }
    if (declared.has(first)) return portEndpoint(first, "out");
    return portEndpoint(first, "out");
  };
  const parseBlock = (): string | undefined => {
    const type = word(); if (!type) return undefined; const props: Record<string, DslValue> = {};
    if (peek().text === "(") { take(); let positional = 0; while (peek().text !== ")" && peek().kind !== "eof") { const key = peek().kind === "word" && tokens[p + 1]?.text === "=" ? word() : undefined; if (key) { expect("="); const v = value(); if (v !== undefined) props[key] = v; } else { const v = value(); if (v !== undefined) props[`arg${positional++}`] = v; } if (peek().text === ",") take(); else if (peek().text !== ")") { error("esperado ',' ou ')'"); break; } } expect(")"); }
    return addInline(type, props);
  };
  const parseChain = (first: DslEndpoint | string | undefined) => {
    let current: DslEndpoint | undefined = typeof first === "string" ? portEndpoint(first, "out") : first;
    while (peek().text === "->") { take(); let next: DslEndpoint | undefined; if (peek().kind === "word" && tokens[p + 1]?.text === "(" ) next = portEndpoint(parseBlock()!, "out"); else next = parseTarget(); if (!current || !next) return; wires.push({ id: `line_${wireNo++}`, from: current, to: next }); current = next; }
  };
  if (peek().text === "model") { take(); word(); } if (!expect("{")) return { diagnostics };
  while (peek().kind !== "eof" && peek().text !== "}") {
    if (peek().kind !== "word" && peek().text !== "@") { error("declaração esperada"); take(); continue; }
    if (peek().kind === "word" && tokens[p + 1]?.text === "=" && tokens[p + 2]?.kind === "word") { const id = word()!; take(); const type = word()!; const props: Record<string, DslValue> = {}; if (peek().text === "(") { take(); while (peek().text !== ")" && peek().kind !== "eof") { const k = word(); expect("="); const v = value(); if (k && v !== undefined) props[k] = v; if (peek().text === ",") take(); else break; } expect(")"); } addInline(type, props, id); if (peek().text === ";") take(); continue; }
    const first = peek().text === "@" ? parseTarget() : parseTarget(); parseChain(first); if (peek().text === ";") take(); else if (peek().text !== "}") error("esperado ';' ou '}'");
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

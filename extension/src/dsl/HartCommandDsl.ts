import { lex, Token } from "./DslParser.js";

/** Lasec HART Command DSL -- the same lexical layer as the circuit DSL
 * (`DslParser.ts`, via the shared `lex()`), a separate grammar above it (a
 * HART command body is a bounded byte-transform pipeline, not circuit
 * topology -- different enough semantically to need its own parser, per
 * .spec/features/hart-device-engine.md "Anexo D"). This module is the
 * authoring surface; it never runs at request time (parsed once, cold path,
 * lowered to the same JSON `HartCommandJson.cpp` already compiles for the
 * flat/JSON authoring path -- see `hartInspectorSections.ts`).
 *
 * Grammar (V1, deliberately scoped -- see "Anexo D" for what's out of scope):
 *
 *   body       := '{' statement* '}'
 *   statement  := ifStatement | chain
 *   ifStatement:= 'if' expr '==' expr '{' statement* '}' ('else' '{' statement* '}')?
 *   chain      := term ('->' term)*
 *   term       := 'out' | 'in' slice? | identifier slice? | 'hex' '(' string ')' | 'IdentityBlock' | codecWord
 *   slice      := '[' number (':' number)? ']'
 *
 * A chain whose LAST term is `out` is a response Append (or, inside an `if`,
 * an Append in that branch). A chain whose last term is a plain identifier
 * (not `out`, not a codec word) is a `write`-stage SET into that variable --
 * "Variable -> ... = read (ends in out)", "... -> Variable = write" (section
 * 58). `codecWord` (U8/U16/I16/F32BE/Bool/ASCII6/...) appearing mid-chain is
 * validated as a known name and otherwise a no-op: encoding is already
 * implicit in which HartVarId/user-variable-type is referenced, matching the
 * current compiled IR (HartCommandProgram.hpp) -- the syntax is accepted and
 * checked now so command bodies read the way the spec's examples show, ready
 * to carry real meaning if/when the IR grows an explicit "encode as" node.
 * `IdentityBlock` expands (cold path, here, not at request time) to the same
 * 10-field macro `hartIdentityBlockMacro()` expands to in C++. */

export interface HartDslDiagnostic { message: string; line: number; column: number; severity: "error" | "warning" }

export type HartCommandStep =
  | { kind: "hex"; bytes: string }
  | { kind: "variable"; variable: string }
  | { kind: "body" }
  | { kind: "bodySlice"; offset: number; length: number }
  | { kind: "localCode" }
  | { kind: "set"; target: string; value: HartCommandStep }
  | { kind: "if"; lhs: HartCommandStep; rhs: HartCommandStep; then: HartCommandStep[]; else: HartCommandStep[] };

export interface HartCommandBody { writeSteps: HartCommandStep[]; responseSteps: HartCommandStep[] }

export interface HartDslParseResult { body?: HartCommandBody; diagnostics: HartDslDiagnostic[] }

/** Mirrors `kVarIdNames` in `HartCommandJson.cpp` (full names) plus the short
 * aliases the DSL examples use (`PV`, `PVUnit`) -- both resolve to the SAME
 * built-in `variable` step; anything else becomes a user-variable reference
 * by stable id, exactly like the JSON bridge's `parseVarId` fallback. */
const BUILTIN_VARIABLE_ALIASES: Readonly<Record<string, string>> = {
  PV: "PrimaryVariable", PVUnit: "PrimaryVariableUnit", Tag: "Tag", DeviceTag: "Tag",
  ManufacturerId: "ManufacturerId", DeviceType: "DeviceType", DeviceId: "DeviceId",
  NumRequestPreambles: "NumRequestPreambles", UniversalCommandRevision: "UniversalCommandRevision",
  TransmitterSpecificRevision: "TransmitterSpecificRevision", SoftwareRevision: "SoftwareRevision",
  HardwareRevisionAndSignal: "HardwareRevisionAndSignal", Flags: "Flags",
  PrimaryVariableUnit: "PrimaryVariableUnit", PrimaryVariable: "PrimaryVariable",
};

/** Accepted purely as a type assertion mid-chain (see module doc); not a
 * distinct AST/IR node in this iteration. */
const CODEC_WORDS = new Set(["U8", "U16", "I16", "F32BE", "Bool", "ASCII6", "Float32", "UInt8", "UInt16", "Int16", "PackedAscii"]);

/** `HartCommandJson.cpp`'s `hartIdentityBlockMacro()` mirrored here so the DSL
 * can expand it cold-path, same as the C++ side does for the reference
 * catalog's built-in commands -- never traversed as a macro at request time. */
const IDENTITY_BLOCK_VARIABLES = [
  "ManufacturerId", "DeviceType", "NumRequestPreambles", "UniversalCommandRevision",
  "TransmitterSpecificRevision", "SoftwareRevision", "HardwareRevisionAndSignal", "Flags", "DeviceId",
] as const;

export function parseHartCommandDsl(source: string): HartDslParseResult {
  const scanned = lex(source);
  const tokens = scanned.tokens;
  const diagnostics: HartDslDiagnostic[] = [...scanned.diagnostics];
  let p = 0;
  const peek = (): Token => tokens[p]!;
  const take = (): Token => tokens[p++]!;
  const error = (message: string, token = peek()): void => { diagnostics.push({ message, line: token.line, column: token.column, severity: "error" }); };
  const expect = (text: string): boolean => { if (peek().text !== text) { error(`esperado '${text}', encontrado '${peek().text}'`); return false; } take(); return true; };
  const hasError = () => diagnostics.some((d) => d.severity === "error");

  function resolveVariableName(name: string): string {
    return BUILTIN_VARIABLE_ALIASES[name] ?? name;
  }

  function identityBlockSteps(): HartCommandStep[] {
    const steps: HartCommandStep[] = [{ kind: "hex", bytes: "FE" }];
    for (const variable of IDENTITY_BLOCK_VARIABLES) steps.push({ kind: "variable", variable });
    return steps;
  }

  /** One chain term. Returns `undefined` for `out` (the chain's sink, not a
   * value) and for a bare identifier that is NOT `in`/a known variable/codec
   * word when it's the chain's first term (ambiguous -- reported as an error
   * by the caller, which knows whether a value was expected there). */
  function parseTerm(): { step?: HartCommandStep; isOut: boolean; isIdentityBlock: boolean; bareName?: string } {
    const token = peek();
    if (token.text === "out") { take(); return { isOut: true, isIdentityBlock: false }; }
    if (token.text === "IdentityBlock") { take(); return { isOut: false, isIdentityBlock: true }; }
    if (token.kind === "word" && token.text === "in") {
      take();
      if (peek().text === "[") return { step: parseSlice(), isOut: false, isIdentityBlock: false };
      return { step: { kind: "body" }, isOut: false, isIdentityBlock: false };
    }
    if (token.kind === "word" && token.text === "hex") {
      take();
      if (!expect("(")) return { isOut: false, isIdentityBlock: false };
      const bytesToken = take();
      if (bytesToken.kind !== "string") { error("hex(...) espera uma string de bytes hex, ex: hex(\"CAFE\")", bytesToken); }
      const bytes = bytesToken.kind === "string" ? (JSON.parse(bytesToken.text) as string) : "";
      expect(")");
      return { step: { kind: "hex", bytes }, isOut: false, isIdentityBlock: false };
    }
    if (token.kind === "word" && CODEC_WORDS.has(token.text)) {
      take();
      return { isOut: false, isIdentityBlock: false }; // no-op assertion, see module doc
    }
    if (token.kind === "word") {
      take();
      return { step: { kind: "variable", variable: resolveVariableName(token.text) }, isOut: false, isIdentityBlock: false, bareName: token.text };
    }
    error(`termo de cadeia inesperado '${token.text}'`, token);
    take();
    return { isOut: false, isIdentityBlock: false };
  }

  function parseSlice(): HartCommandStep {
    expect("[");
    const startToken = take();
    const start = startToken.kind === "number" ? Number.parseInt(startToken.text, 10) : 0;
    if (startToken.kind !== "number") error("esperado um número no slice, ex: in[0:4]", startToken);
    if (peek().text === ":") {
      take();
      const endToken = take();
      const end = endToken.kind === "number" ? Number.parseInt(endToken.text, 10) : start + 1;
      if (endToken.kind !== "number") error("esperado um número após ':' no slice", endToken);
      expect("]");
      if (end < start) { error("fim do slice não pode ser menor que o início"); return { kind: "bodySlice", offset: start, length: 0 }; }
      return { kind: "bodySlice", offset: start, length: end - start };
    }
    expect("]");
    return { kind: "bodySlice", offset: start, length: 1 };
  }

  /** One `A -> B -> C` chain, expanding `IdentityBlock` inline (it can only
   * legally appear as the chain's final/only value feeding `out`; using it
   * mid-chain or as a write target is a compile error, not silently ignored). */
  function parseChainSteps(): { steps: HartCommandStep[]; endsInOut: boolean; writeTarget?: string } {
    const values: HartCommandStep[] = [];
    let endsInOut = false;
    let writeTarget: string | undefined;
    let sawIdentityBlock = false;
    for (;;) {
      const term = parseTerm();
      if (term.isOut) { endsInOut = true; }
      else if (term.isIdentityBlock) { sawIdentityBlock = true; }
      else if (term.step) { values.push(term.step); writeTarget = term.bareName; }
      if (peek().text !== "->") break;
      take();
    }
    if (sawIdentityBlock) {
      if (!endsInOut || values.length > 0) {
        error("IdentityBlock só pode ser usado sozinho numa cadeia que termina em 'out' (ex: 'IdentityBlock -> out')");
        return { steps: [], endsInOut };
      }
      return { steps: identityBlockSteps(), endsInOut: true };
    }
    return { steps: values, endsInOut, writeTarget: endsInOut ? undefined : writeTarget };
  }

  function parseStatement(): { resp: HartCommandStep[]; write: HartCommandStep[] } {
    if (peek().text === "if") {
      take();
      const lhs = parseTerm().step;
      if (!lhs) error("condição do 'if' precisa de um valor à esquerda de '=='");
      if (!expect("==")) return { resp: [], write: [] };
      const rhs = parseTerm().step;
      if (!rhs) error("condição do 'if' precisa de um valor à direita de '=='");
      if (!expect("{")) return { resp: [], write: [] };
      const thenSteps = parseStatementsUntilBrace();
      expect("}");
      let elseSteps: HartCommandStep[] = [];
      if (peek().text === "else") {
        take();
        if (expect("{")) { elseSteps = parseStatementsUntilBrace().resp; expect("}"); }
      }
      if (!lhs || !rhs) return { resp: [], write: [] };
      return { resp: [{ kind: "if", lhs, rhs, then: thenSteps.resp, else: elseSteps }], write: [] };
    }
    const chain = parseChainSteps();
    if (hasError()) return { resp: [], write: [] };
    if (chain.endsInOut) return { resp: chain.steps, write: [] };
    // A write chain needs a SOURCE value feeding the destination word --
    // `chain.steps` always ends with the destination itself (pushed as an
    // ordinary Variable term by parseTerm(), since the parser can't tell a
    // read-source word from a write-destination word until it sees whether
    // the chain ends in 'out'), so a real write needs at least 2 entries.
    // Exactly 1 means a bare identifier with no '->' at all -- neither a
    // valid read (missing '-> out') nor a valid write (no source value) --
    // reject it rather than silently synthesize a self-referential SET.
    if (chain.writeTarget !== undefined && chain.steps.length >= 2) {
      const value = chain.steps[chain.steps.length - 2]!;
      return { resp: [], write: [{ kind: "set", target: resolveVariableName(chain.writeTarget), value }] };
    }
    error("cadeia precisa terminar em 'out' (leitura) ou ligar um valor de origem a um nome de variável, ex: 'in[0] -> Variable' (escrita)");
    return { resp: [], write: [] };
  }

  function parseStatementsUntilBrace(): { resp: HartCommandStep[]; write: HartCommandStep[] } {
    const resp: HartCommandStep[] = []; const write: HartCommandStep[] = [];
    while (peek().kind !== "eof" && peek().text !== "}") {
      const before = p;
      const result = parseStatement();
      resp.push(...result.resp); write.push(...result.write);
      if (peek().text === ";") take();
      if (p === before) { error(`declaração inesperada '${peek().text}'`); take(); }
      if (hasError()) break;
    }
    return { resp, write };
  }

  if (!expect("{")) return { diagnostics };
  const top = parseStatementsUntilBrace();
  if (!expect("}")) return { diagnostics };
  if (peek().kind !== "eof") error("tokens após o fim do corpo do comando");

  if (hasError()) return { diagnostics };
  return { body: { writeSteps: top.write, responseSteps: top.resp }, diagnostics };
}

/** Lowers a parsed body to the exact JSON shape `HartCommandJson.cpp` compiles
 * (`{id, name, enabled, writeSteps, responseSteps}`) -- this function is the
 * only place that shape is assembled for DSL-authored commands, so the wire
 * format only needs to be kept in sync with Core in one place. */
export function hartCommandBodyToJson(id: number, name: string, body: HartCommandBody): Record<string, unknown> {
  return { id, name, enabled: true, writeSteps: body.writeSteps, responseSteps: body.responseSteps };
}

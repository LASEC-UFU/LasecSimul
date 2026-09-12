import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { hartCommandBodyToJson, parseHartCommandDsl } from "./HartCommandDsl";

(async () => {
  const { test, finish } = createTestRunner("HartCommandDsl - Lasec HART Command DSL parser");

  await test("comando de leitura simples (0x01 equivalente): PVUnit -> U8 -> out / PV -> F32BE -> out", () => {
    const result = parseHartCommandDsl(`{
      PVUnit -> U8 -> out
      PV -> F32BE -> out
    }`);
    assert(result.body !== undefined, `esperava parse bem-sucedido, diagnostics: ${JSON.stringify(result.diagnostics)}`);
    assert(result.body!.writeSteps.length === 0, "não deveria haver write steps");
    assert(result.body!.responseSteps.length === 2, "deveria haver 2 response steps");
    assert(JSON.stringify(result.body!.responseSteps[0]) === JSON.stringify({ kind: "variable", variable: "PrimaryVariableUnit" }),
      "PVUnit deveria resolver para o nome canônico PrimaryVariableUnit");
    assert(JSON.stringify(result.body!.responseSteps[1]) === JSON.stringify({ kind: "variable", variable: "PrimaryVariable" }),
      "PV deveria resolver para o nome canônico PrimaryVariable");
  });

  await test("codec words (U8/F32BE/etc.) são aceitos e não geram um node extra na cadeia", () => {
    const withCodec = parseHartCommandDsl("{ PV -> F32BE -> out }");
    const withoutCodec = parseHartCommandDsl("{ PV -> out }");
    assert(withCodec.body !== undefined && withoutCodec.body !== undefined, "ambas variantes deveriam parsear");
    assert(JSON.stringify(withCodec.body!.responseSteps) === JSON.stringify(withoutCodec.body!.responseSteps),
      "a palavra de codec é uma asserção, não deveria mudar o AST resultante");
  });

  await test("write chain (direção da seta determina leitura vs escrita): in[0] -> U8 -> PollingAddress", () => {
    const result = parseHartCommandDsl("{ in[0] -> U8 -> PollingAddress }");
    assert(result.body !== undefined, `esperava parse bem-sucedido: ${JSON.stringify(result.diagnostics)}`);
    assert(result.body!.responseSteps.length === 0, "não deveria haver response steps");
    assert(result.body!.writeSteps.length === 1, "deveria haver exatamente 1 write step");
    const set = result.body!.writeSteps[0] as { kind: string; target: string; value: unknown };
    assert(set.kind === "set" && set.target === "PollingAddress", "write deveria ser um SET para PollingAddress");
    assert(JSON.stringify(set.value) === JSON.stringify({ kind: "bodySlice", offset: 0, length: 1 }),
      "valor do SET deveria ser in[0] (bodySlice offset=0 length=1)");
  });

  await test("in[a:b] produz bodySlice com length = b - a, não b", () => {
    const result = parseHartCommandDsl("{ in[2:6] -> out }");
    assert(result.body !== undefined, "esperava parse bem-sucedido");
    assert(JSON.stringify(result.body!.responseSteps[0]) === JSON.stringify({ kind: "bodySlice", offset: 2, length: 4 }),
      "in[2:6] deveria virar bodySlice{offset:2,length:4} (6-2), não length:6");
  });

  await test("hex(\"...\") produz um passo hex literal", () => {
    const result = parseHartCommandDsl('{ hex("CAFE") -> out }');
    assert(result.body !== undefined, "esperava parse bem-sucedido");
    assert(JSON.stringify(result.body!.responseSteps[0]) === JSON.stringify({ kind: "hex", bytes: "CAFE" }),
      "hex(\"CAFE\") deveria virar {kind:hex,bytes:CAFE}");
  });

  await test("IdentityBlock expande para os 10 campos do macro (cold path, não em runtime)", () => {
    const result = parseHartCommandDsl("{ IdentityBlock -> out }");
    assert(result.body !== undefined, `esperava parse bem-sucedido: ${JSON.stringify(result.diagnostics)}`);
    assert(result.body!.responseSteps.length === 10, `IdentityBlock deveria expandir para 10 passos, recebeu ${result.body!.responseSteps.length}`);
    assert(JSON.stringify(result.body!.responseSteps[0]) === JSON.stringify({ kind: "hex", bytes: "FE" }),
      "primeiro campo do IdentityBlock deveria ser o byte de expansão FE");
    assert(JSON.stringify(result.body!.responseSteps[9]) === JSON.stringify({ kind: "variable", variable: "DeviceId" }),
      "último campo do IdentityBlock (índice 9: FE + 9 campos de 1 byte antes dele) deveria ser DeviceId (3 bytes)");
  });

  await test("comando 0x0B equivalente: if in[0:6] == Tag { status + IdentityBlock } else { status + IdentityBlock }", () => {
    const result = parseHartCommandDsl(`{
      if in[0:6] == Tag {
        hex("00") -> out
        IdentityBlock -> out
      } else {
        hex("01") -> out
        IdentityBlock -> out
      }
    }`);
    assert(result.body !== undefined, `esperava parse bem-sucedido: ${JSON.stringify(result.diagnostics)}`);
    assert(result.body!.responseSteps.length === 1, "deveria haver exatamente 1 response step (o IF)");
    const ifStep = result.body!.responseSteps[0] as { kind: string; lhs: unknown; rhs: unknown; then: unknown[]; else: unknown[] };
    assert(ifStep.kind === "if", "response step deveria ser um IF");
    assert(JSON.stringify(ifStep.lhs) === JSON.stringify({ kind: "bodySlice", offset: 0, length: 6 }), "lhs deveria ser in[0:6]");
    assert(JSON.stringify(ifStep.rhs) === JSON.stringify({ kind: "variable", variable: "Tag" }), "rhs deveria ser Tag");
    assert(ifStep.then.length === 11 && ifStep.else.length === 11,
      `then/else deveriam ter 1 (status) + 10 (IdentityBlock) = 11 passos cada, recebeu then=${ifStep.then.length} else=${ifStep.else.length}`);
    assert(JSON.stringify(ifStep.then[0]) === JSON.stringify({ kind: "hex", bytes: "00" }), "then começa com status 00");
    assert(JSON.stringify(ifStep.else[0]) === JSON.stringify({ kind: "hex", bytes: "01" }), "else começa com status 01");
  });

  await test("identificador desconhecido vira referência de variável do usuário (mesmo fallback do parser JSON em HartCommandJson.cpp)", () => {
    const result = parseHartCommandDsl("{ MyCustomVariable -> out }");
    assert(result.body !== undefined, "esperava parse bem-sucedido");
    assert(JSON.stringify(result.body!.responseSteps[0]) === JSON.stringify({ kind: "variable", variable: "MyCustomVariable" }),
      "identificador desconhecido deveria virar uma referência de variável de usuário pelo próprio nome");
  });

  await test("DSL inválida não produz corpo algum (rejeição atômica -- nunca um resultado parcial)", () => {
    const missingBrace = parseHartCommandDsl("{ PV -> out");
    assert(missingBrace.body === undefined, "chave de fechamento ausente deveria ser rejeitada");
    const danglingArrow = parseHartCommandDsl("{ PV -> }");
    assert(danglingArrow.body === undefined, "seta pendente sem termo seguinte deveria ser rejeitada");
    const bareIdentifier = parseHartCommandDsl("{ PV }");
    assert(bareIdentifier.body === undefined, "identificador solto sem seta (nem leitura nem escrita) deveria ser rejeitado, não virar um SET nonsense");
    const badSlice = parseHartCommandDsl("{ in[6:2] -> out }");
    assert(badSlice.body === undefined, "slice com fim menor que início deveria ser rejeitado");
  });

  await test("hartCommandBodyToJson produz exatamente o formato que HartCommandJson.cpp::parseCommandDefinition espera", () => {
    const result = parseHartCommandDsl("{ PVUnit -> U8 -> out\nPV -> F32BE -> out }");
    assert(result.body !== undefined, "esperava parse bem-sucedido");
    const json = hartCommandBodyToJson(200, "Custom PV Read", result.body!);
    assert(json.id === 200 && json.name === "Custom PV Read" && json.enabled === true, "campos de topo (id/name/enabled) corretos");
    assert(Array.isArray(json.responseSteps) && (json.responseSteps as unknown[]).length === 2, "responseSteps presente com 2 entradas");
    assert(Array.isArray(json.writeSteps) && (json.writeSteps as unknown[]).length === 0, "writeSteps presente (vazio)");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
  HartCommandRow,
  HartVariableRow,
  hartInspectorClientScript,
  parseCommandRows,
  parseVariableRows,
  renderCommandsSection,
  renderVariablesSection,
  serializeCommandRows,
  serializeVariableRows,
} from "./hartInspectorSections";

(async () => {
  const { test, finish } = createTestRunner("hartInspectorSections - Property Inspector HART editors");

  await test("parseVariableRows lê os campos reais do modelo Core (role/type/direction/readable/writable/runtimeMutable)", () => {
    const json = JSON.stringify([{
      id: "PV", name: "Process Value", role: "PV", type: "Float32", direction: "Input",
      unit: "kPa", value: 10, readable: true, writable: false, runtimeMutable: true,
    }]);
    const rows = parseVariableRows(json);
    assert(rows.length === 1, "deveria parsear exatamente 1 variável");
    assert(rows[0]!.id === "PV" && rows[0]!.direction === "Input" && rows[0]!.runtimeMutable === true,
      "campos reais (id estável, direction, runtimeMutable) deveriam sobreviver ao parse");
  });

  await test("parseVariableRows nunca lança em JSON malformado -- volta lista vazia", () => {
    assert(parseVariableRows("{not json").length === 0, "JSON inválido deveria virar lista vazia, não exceção");
    assert(parseVariableRows("").length === 0, "string vazia deveria virar lista vazia");
    assert(parseVariableRows("[1,2,3]").length === 0, "array de não-objetos deveria virar lista vazia");
  });

  await test("serializeVariableRows produz exatamente os campos que HartCommunicationComponent::rebuildConfiguredPlan espera", () => {
    const row: HartVariableRow = {
      id: "PV", name: "Process Value", role: "PV", type: "Float32", direction: "Internal",
      unit: "kPa", value: 10, readable: true, writable: false, runtimeMutable: false,
    };
    const parsed = JSON.parse(serializeVariableRows([row]));
    assert(parsed[0].id === "PV" && parsed[0].direction === "Internal" && parsed[0].value === 10,
      "round-trip de serialização deveria preservar id/direction/value");
    assert(!("expression" in parsed[0]), "uma variável sem expression legado não deveria inventar o campo ao serializar");
  });

  await test("expression legado é preservado no round-trip (retirado como editor de 1a classe, não descartado)", () => {
    const rows = parseVariableRows(JSON.stringify([{ id: "PV", expression: "base * gain" }]));
    assert(rows[0]!.expression === "base * gain", "expression legado deveria sobreviver ao parse");
    const roundTripped = JSON.parse(serializeVariableRows(rows));
    assert(roundTripped[0].expression === "base * gain", "expression legado deveria sobreviver à serialização de volta");
  });

  await test("parseCommandRows lê responseSteps com os 4 tipos de step suportados", () => {
    const json = JSON.stringify([{
      id: 128, name: "Custom", enabled: true,
      responseSteps: [
        { kind: "hex", bytes: "CAFE" },
        { kind: "variable", variable: "PrimaryVariable" },
        { kind: "body" },
        { kind: "bodySlice", offset: 0, length: 2 },
      ],
    }]);
    const rows = parseCommandRows(json);
    assert(rows.length === 1 && rows[0]!.responseSteps.length === 4, "deveria parsear 1 comando com 4 steps");
    assert(rows[0]!.responseSteps[0]!.kind === "hex" && rows[0]!.responseSteps[0]!.bytes === "CAFE", "step hex preservado");
    assert(rows[0]!.responseSteps[3]!.kind === "bodySlice" && rows[0]!.responseSteps[3]!.length === 2, "step bodySlice preservado");
  });

  await test("serializeCommandRows produz exatamente o formato que HartCommandJson::parseCommandCollection espera", () => {
    const row: HartCommandRow = {
      id: 128, name: "Custom", enabled: true,
      responseSteps: [{ kind: "variable", variable: "PrimaryVariable" }, { kind: "hex", bytes: "00" }],
    };
    const parsed = JSON.parse(serializeCommandRows([row]));
    assert(parsed[0].id === 128 && parsed[0].responseSteps.length === 2, "round-trip deveria preservar id e a lista de steps");
    assert(parsed[0].responseSteps[0].kind === "variable" && parsed[0].responseSteps[0].variable === "PrimaryVariable",
      "step variable deveria round-tripar com o campo 'variable', não 'bytes'");
  });

  await test("renderVariablesSection nunca expõe bytecode -- só rótulos semânticos (role/type/direction)", () => {
    const html = renderVariablesSection(
      [{ id: "PV", name: "PV", role: "PV", type: "Float32", direction: "Internal", unit: "", value: 0, readable: true, writable: false, runtimeMutable: false }],
      { structuralEditsLocked: false },
    );
    assert(!/LOAD_R\d|opcode|0x[0-9A-F]{2}\s*;/.test(html), "HTML do editor de variáveis não deveria conter nenhum artefato de bytecode/opcode");
    assert(html.includes("Primary Variable (PV)"), "role deveria aparecer como rótulo legível, não como enum cru");
  });

  await test("renderVariablesSection desabilita edições estruturais durante RUN mas mantém 'value' editável quando runtimeMutable", () => {
    const runtimeMutableRow: HartVariableRow = { id: "PV", name: "PV", role: "PV", type: "Float32", direction: "Internal", unit: "", value: 0, readable: true, writable: false, runtimeMutable: true };
    const lockedHtml = renderVariablesSection([runtimeMutableRow], { structuralEditsLocked: true });
    assert(lockedHtml.includes("+ Add Variable") && /data-hv-add="1" disabled/.test(lockedHtml), "Add Variable deveria estar desabilitado durante RUN");
    assert(/data-hv-field="id"[^>]*readonly/.test(lockedHtml), "o id (identidade estável) deveria virar readonly durante RUN");
    assert(!/data-hv-field="value"[^>]*disabled/.test(lockedHtml), "value deveria continuar editável durante RUN quando a linha é runtimeMutable");

    const nonMutableRow: HartVariableRow = { ...runtimeMutableRow, runtimeMutable: false };
    const lockedNonMutableHtml = renderVariablesSection([nonMutableRow], { structuralEditsLocked: true });
    assert(/data-hv-field="value"[^>]*disabled/.test(lockedNonMutableHtml), "value deveria ficar desabilitado durante RUN quando a linha NÃO é runtimeMutable");
  });

  await test("renderVariablesSection desabilita 'writable' quando direction=Input (write-ownership visível na UI)", () => {
    const inputRow: HartVariableRow = { id: "PV", name: "PV", role: "PV", type: "Float32", direction: "Input", unit: "", value: 0, readable: true, writable: false, runtimeMutable: false };
    const html = renderVariablesSection([inputRow], { structuralEditsLocked: false });
    assert(/data-hv-field="writable"[^>]*disabled/.test(html), "writable deveria estar desabilitado para uma variável Input");
    assert(html.includes("Signal Graph wire"), "deveria haver uma nota explicando por que Input não é writable");
  });

  await test("renderCommandsSection mostra o status do compilador (OK vs erro) sem esconder o motivo", () => {
    const okHtml = renderCommandsSection([], "OK", { structuralEditsLocked: false });
    assert(okHtml.includes("Valid") && !okHtml.includes("class=\"hc-status err\""), "status OK deveria mostrar 'Valid', não erro");
    const errHtml = renderCommandsSection([], "ERROR: duplicate command id 128", { structuralEditsLocked: false });
    assert(errHtml.includes("duplicate command id 128"), "a mensagem de erro real do compilador deveria aparecer no HTML, não um genérico 'inválido'");
  });

  await test("hartInspectorClientScript reserva os ids de comando padrão (0/1/3/11/33) ao sugerir um novo id", () => {
    // O script roda só na Webview (usa document/acquireVsCodeApi) -- não é
    // executável aqui, mas a lista de ids reservados é uma constante literal
    // no texto gerado, então uma leitura estática já caracteriza que
    // 0x00/0x01/0x03/0x0B/0x21 (0/1/3/11/33) nunca seriam sugeridos como novo
    // id de comando custom (evita colidir com HartReferenceCatalog).
    const script = hartInspectorClientScript();
    assert(script.includes("[0, 1, 3, 11, 33]"), "os 5 ids de comando padrão deveriam estar na lista de reservados do script");
  });

  finish();
})();

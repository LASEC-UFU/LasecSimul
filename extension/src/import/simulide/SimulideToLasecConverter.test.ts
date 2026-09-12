import * as fs from "node:fs";
import * as path from "node:path";
import { assert, createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import { loadUnifiedCatalog } from "../../catalog/UnifiedCatalog";
import { parseSimulideCircuit } from "./SimulideParser";
import { convertSimulideDocument } from "./SimulideToLasecConverter";
import { hasImportErrors } from "./SimulideTypes";

(async () => {
  const { test, finish } = createTestRunner("SimulIDE importer -- parser/conversor best-effort");
  const workspace = path.resolve(__dirname, "../../../../..");
  const catalog = loadUnifiedCatalog(process.cwd(), "pt-BR").catalog;
  const fixturesDir = path.join(workspace, "extension/test/fixtures/simulide");

  await test("CircId duplicado NUNCA aborta o arquivo inteiro -- renomeia e reporta duplicate-id", () => {
    const text = `<circuit version="1.0.0" >
  <item itemtype="Resistor" CircId="R1" Pos="0,0" />
  <item itemtype="Resistor" CircId="R1" Pos="50,0" />
  <item itemtype="Node" CircId="node1" Pos="100,0" />
  <item itemtype="Connector" startpinid="R1-1" endpinid="node1" pointList="0,0,100,0" />
</circuit>`;
    const document = parseSimulideCircuit(text);
    assert(document.components.length === 2, `esperava 2 componentes, recebeu ${document.components.length}`);
    const result = convertSimulideDocument(document, catalog);
    assert(!hasImportErrors(result.report), "CircId duplicado não deve ser erro fatal");
    assert(
      result.report.issues.some((issue) => issue.code === "duplicate-id"),
      "esperava um issue duplicate-id"
    );
    assert(result.project.components.length === 2, "os dois componentes devem sobreviver, um deles renomeado");
  });

  await test("item sem CircId é ignorado (parse-warning), resto do arquivo continua", () => {
    const text = `<circuit version="1.0.0" >
  <item itemtype="Resistor" Pos="0,0" />
  <item itemtype="Resistor" CircId="R2" Pos="50,0" />
</circuit>`;
    const document = parseSimulideCircuit(text);
    assert(document.components.length === 1, `esperava 1 componente, recebeu ${document.components.length}`);
    assert(document.parseIssues.some((issue) => issue.code === "parse-warning"), "esperava um parse-warning para o item sem CircId");
  });

  await test("Connector com pointList inválida preserva os endpoints em vez de abortar", () => {
    const text = `<circuit version="1.0.0" >
  <item itemtype="Node" CircId="n1" Pos="0,0" />
  <item itemtype="Node" CircId="n2" Pos="100,0" />
  <item itemtype="Connector" startpinid="n1" endpinid="n2" pointList="not,a,valid,point,list,here" />
</circuit>`;
    const document = parseSimulideCircuit(text);
    assert(document.connectors.length === 1, "o Connector deve sobreviver com vértices vazios");
    assert(
      document.parseIssues.length === 1 && document.parseIssues[0]!.code === "parse-warning",
      "esperava exatamente um parse-warning para a pointList inválida"
    );
  });

  await test("arquivo sem a tag <circuit> continua sendo o único caso realmente fatal", () => {
    let threw = false;
    try {
      parseSimulideCircuit("isto nao e um circuito SimulIDE");
    } catch {
      threw = true;
    }
    assert(threw, "deveria lançar quando não há tag <circuit>");
  });

  await test("NTC_ApInst.sim1 (fixture real) converte contra o catálogo real sem erro fatal", () => {
    const filePath = path.join(fixturesDir, "real-user/NTC_ApInst.sim1");
    const document = parseSimulideCircuit(fs.readFileSync(filePath, "utf8"));
    const result = convertSimulideDocument(document, catalog);
    assert(!hasImportErrors(result.report), "fixture real não deveria produzir erro fatal");
    assert(result.project.components.length === document.components.length, "todo componente original deve ser emitido (best-effort)");
    assert(result.project.topology.conductors.length === document.connectors.length, "todo condutor original deve ser preservado");
    assert(result.report.orphanEndpointCount === 0, "fixture real não deveria gerar endpoints órfãos");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

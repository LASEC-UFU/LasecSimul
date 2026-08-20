import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { validateSubcircuitDocument } from "../catalog/subcircuitValidation";
import { parseSubcircuitDocument } from "../catalog/subcircuitDocument";
import { convertTdpsToSubcircuit, parseTdpsSmp, summarizeTdpsCorpus } from "./tdpsImporter";

const BASIC_SAMPLE = `Vazão Linear Simples
screen.bmp
=====<<<CONTROLADOR:01>>>=====
{C01/01} Tag:FIC101
{C01/03} Kc:1
{C01/04} Ti:10
{C01/05} Td:0
{C01/06} Bias:50
{C01/09} COmim:0
{C01/10} COMax:100
{C01/14} Indice lista PV:41
{C01/15} Indice lista SPR:14
{C01/18} Habilita SPR:True
{C01/20} Tipo acao:1
{C01/21} Derivada na PV:1
{C01/27} Habilita Modo Auto:True
=====<<<PROCESSO:21>>>=====
{P21/01} Tag:FT101
{P21/03} Indice lista PV:0
{P21/04} Tal 1:1.1
{P21/05} Tal 2:0.8
{P21/08} Tempo Morto:0.4
{P21/09} Ganho:1.2
{P21/13} Const. Tempo Atuador:0.5
=====<<<BLOCO CALC:41>>>=====
{B41/01} Tag:FY101
{B41/03} Funcao:M21+M81
{B41/04} Lim Sup:105
{B41/05} Lim Inf:0
{B41/06} Habilita Lim Sup:False
{B41/07} Habilita Lim Inf:True
=====<<<REGISTRADOR:201>>>=====
{R/03} Ind Lista Var1:41
{R/04} Desc Var1:Vazão
{R/05} Ind Lista Var2:-1
{R/07} Ind Lista Var3:-1
=====<<<TEXTO ANIMADO:101>>>=====
{T/01} Desc:PV
{T/04} Unidade:L/min
{T/08} Variavel:41
=====<<<COORDENADAS>>>=====
FIC101
71
351
True
=====<<<REGISTRADOR XY>>>=====
{X/01}
`;

function listSmpFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".smp")) files.push(full);
    }
  };
  visit(root);
  return files.sort();
}

(async () => {
  const { test, finish } = createTestRunner("tdpsImporter - parser e conversao canonica");

  await test("parser preserva latin-1 e classifica todas as entidades suportadas", () => {
    const encoded = Buffer.from(BASIC_SAMPLE, "latin1");
    const model = parseTdpsSmp(encoded, "basic.smp");
    assert(model.title === "Vazão Linear Simples", `titulo latin-1 inesperado: ${model.title}`);
    assert(model.controllers.length === 1, "deveria encontrar CONTROLADOR");
    assert(model.processes.length === 1, "deveria encontrar PROCESSO");
    assert(model.calcBlocks.length === 1, "deveria encontrar BLOCO CALC");
    assert(model.recorders.length === 1, "deveria encontrar REGISTRADOR");
    assert(model.xyRecorders.length === 1, "deveria encontrar REGISTRADOR XY");
    assert(model.animatedTexts.length === 1, "deveria encontrar TEXTO ANIMADO");
  });

  await test("conversao elimina Mnn operacional, resolve edges e produz schema v3 valido", () => {
    const converted = convertTdpsToSubcircuit(parseTdpsSmp(BASIC_SAMPLE, "basic.smp"), "subcircuits.tdps.basic-test");
    const calc = converted.document.components.find((component) => component.id === "calc-41");
    assert(calc?.properties.expression === "x0+x1", `expressao canonica inesperada: ${String(calc?.properties.expression)}`);
    assert(JSON.stringify(calc?.properties).match(/\bM\d+\b/i) === null, "propriedades operacionais nao podem manter Mnn");
    assert(converted.document.topology.conductors.some((wire) => wire.from.kind === "port" && wire.from.componentId === "process-21" && wire.to.kind === "port" && wire.to.componentId === "calc-41" && wire.to.pinId === "x0"), "M21 deveria virar edge process-21 -> calc-41.x0");
    assert(converted.report.externalVariables.includes(14) && converted.report.externalVariables.includes(81), "referencias sem produtor deveriam virar inputs externos explicitos");
    const validation = validateSubcircuitDocument(converted.document);
    assert(validation.errors.length === 0, `documento convertido deveria ser valido: ${validation.errors.join(" | ")}`);
  });

  await test("duas conversoes nao compartilham componentes, topologia ou estado de autoria", () => {
    const model = parseTdpsSmp(BASIC_SAMPLE);
    const first = convertTdpsToSubcircuit(model).document;
    const second = convertTdpsToSubcircuit(model).document;
    first.components[0]!.properties.kc = 99;
    first.topology.conductors.pop();
    assert(second.components[0]!.properties.kc === 1, "propriedades de instancias convertidas devem ser independentes");
    assert(second.topology.conductors.length > first.topology.conductors.length, "topologias convertidas devem ser independentes");
  });

  await test("biblioteca FOPDT, basic flow e Smith usa schema v3 valido e DSL canonica", () => {
    const repositoryRoot = path.resolve(__dirname, "../../../../");
    for (const name of ["process_fopdt", "tdps_basic_flow_loop", "tdps_smith_predictor"]) {
      const file = path.join(repositoryRoot, "subcircuits", `${name}.lssubcircuit`);
      const parsed = parseSubcircuitDocument(JSON.parse(fs.readFileSync(file, "utf8")), path.dirname(file));
      assert(parsed.ok, `${name} deveria ser um .lssubcircuit schemaVersion 3 parseavel`);
      if (!parsed.ok) continue;
      const validation = validateSubcircuitDocument(parsed.document);
      assert(validation.errors.length === 0, `${name}: ${validation.errors.join(" | ")}`);
      for (const component of parsed.document.components.filter((candidate) => candidate.typeId === "control.calc_expression")) {
        assert(!/\bM\d+\b/i.test(String(component.properties.expression ?? "")), `${name}/${component.id} ainda contem Mnn operacional`);
      }
    }
  });

  const fixtureRoot = process.env.TDPS_FIXTURE_DIR;
  if (fixtureRoot) {
    await test("corpus TDPS v7.71: 24 arquivos e contagens de referencia", () => {
      const files = listSmpFiles(fixtureRoot);
      const coverageManifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../.spec/fixtures/tdps-v771-coverage.json"), "utf8")) as {
        entries: Array<{ file: string; sha256: string }>;
      };
      const expectedHashes = new Map(coverageManifest.entries.map((entry) => [entry.file.toLowerCase(), entry.sha256]));
      const models = files.map((file) => parseTdpsSmp(fs.readFileSync(file), path.relative(fixtureRoot, file)));
      const coverage = summarizeTdpsCorpus(models);
      assert(coverage.files === 24, `esperados 24 .smp, encontrados ${coverage.files}`);
      assert(coverage.controllers === 66, `esperados 66 controladores, encontrados ${coverage.controllers}`);
      assert(coverage.processes === 139, `esperados 139 processos, encontrados ${coverage.processes}`);
      assert(coverage.calcBlocks === 172, `esperados 172 blocos calc, encontrados ${coverage.calcBlocks}`);
      assert(coverage.recorders === 57, `esperados 57 registradores, encontrados ${coverage.recorders}`);
      assert(coverage.xyRecorders === 24, `esperados 24 registradores XY, encontrados ${coverage.xyRecorders}`);
      assert(coverage.animatedTexts === 213, `esperados 213 textos animados, encontrados ${coverage.animatedTexts}`);
      for (const file of files) {
        const relative = path.relative(fixtureRoot, file).replace(/\\/g, "/");
        const actualHash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        assert(expectedHashes.get(relative.toLowerCase()) === actualHash, `${relative}: hash nao corresponde ao corpus v7.71 auditado`);
      }
      for (const model of models) {
        const converted = convertTdpsToSubcircuit(model);
        const validation = validateSubcircuitDocument(converted.document);
        assert(validation.errors.length === 0, `${model.sourceName}: ${validation.errors.join(" | ")}`);
      }
    });
  }

  finish();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

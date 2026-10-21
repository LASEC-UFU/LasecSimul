import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { assert, createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import { loadBlockLibrary } from "../../catalog/blockLibraryLoader";
import type { ProjectComponent } from "../../project/ProjectTypes";
import { parseMdl } from "./MdlParser";
import { parseSimulinkModel } from "./SimulinkImporter";
import { convertSimulinkModel, formatSimulinkImportReport, normalizeSourceBlock, referencedVariables } from "./SimulinkToLasec";
import { buildStoredZip, ZipArchive } from "./zip";

/**
 * Importador `.slx`/`.mdl` -> `.lsproj` (docs/66): leitura do pacote, parâmetros (bloco > padrão do
 * arquivo > especificação), nomes antigos, portas e ramificações, subsistemas, viewers, workspace.
 * Modelos sintéticos escritos aqui; os modelos reais do usuário (`_audit_*`) entram quando existem.
 */
const { test, finish } = createTestRunner("Importador Simulink");
const extensionRoot = path.resolve(__dirname, "..", "..", "..", "..");
const library = loadBlockLibrary(extensionRoot);

const blockdiagram = `<?xml version="1.0" encoding="utf-8"?>
<ModelInformation Version="1.0">
  <Model>
    <System>
      <Block BlockType="Constant" Name="K &amp; ref" SID="1">
        <P Name="Position">[100, 100, 130, 130]</P>
        <P Name="Value">2*Kp</P>
      </Block>
      <Block BlockType="Gain" Name="Gain" SID="2">
        <P Name="Position">[200, 100, 230, 130]</P>
      </Block>
      <Block BlockType="Sum" Name="Sum" SID="3">
        <P Name="Ports">[2, 1]</P>
        <P Name="Position">[300, 105, 320, 125]</P>
        <P Name="IconShape">round</P>
        <P Name="Inputs">|+-</P>
      </Block>
      <Block BlockType="Step" Name="Step" SID="4">
        <P Name="Position">[100, 200, 130, 230]</P>
        <P Name="BlockRotation">270</P>
        <P Name="BlockMirror">on</P>
        <P Name="Time">2</P>
        <P Name="Before">-1</P>
        <P Name="After">3</P>
      </Block>
      <Block BlockType="SubSystem" Name="Planta" SID="5">
        <P Name="Ports">[1, 1]</P>
        <P Name="Position">[400, 100, 460, 140]</P>
        <System>
          <Block BlockType="Inport" Name="u" SID="6"><P Name="Position">[20, 20, 40, 34]</P></Block>
          <Block BlockType="Integrator" Name="Int" SID="7"><P Name="Position">[80, 15, 110, 45]</P></Block>
          <Block BlockType="Outport" Name="y" SID="8"><P Name="Position">[150, 20, 170, 34]</P></Block>
          <Line><P Name="Src">6#out:1</P><P Name="Dst">7#in:1</P></Line>
          <Line><P Name="Src">7#out:1</P><P Name="Dst">8#in:1</P></Line>
        </System>
      </Block>
      <Block BlockType="Scope" Name="Viewer" SID="9">
        <P Name="Ports">[]</P>
        <P Name="IOType">viewer</P>
        <List ListType="IOSignalStrings"><P Name="set0Sigs">Gain:o1</P></List>
      </Block>
      <Block BlockType="Reference" Name="PID" SID="10">
        <P Name="Ports">[1, 1]</P>
        <P Name="Position">[500, 100, 540, 130]</P>
        <P Name="SourceBlock">slpidlib/PID Controller</P>
        <InstanceData><P Name="P">2.5</P><P Name="I">0.5</P></InstanceData>
      </Block>
      <Block BlockType="Goto" Name="Goto" SID="11"><P Name="GotoTag">A</P></Block>
      <Line><P Name="Src">1#out:1</P><P Name="Dst">2#in:1</P></Line>
      <Line>
        <P Name="Src">2#out:1</P>
        <Branch><P Name="Dst">3#in:1</P></Branch>
        <Branch><P Name="Dst">5#in:1</P></Branch>
      </Line>
      <Line><P Name="Src">4#out:1</P><P Name="Dst">3#in:2</P></Line>
      <Line><P Name="Src">5#out:1</P><P Name="Dst">10#in:1</P></Line>
      <Line><P Name="Src">3#out:1</P><P Name="Dst">11#in:1</P></Line>
    </System>
  </Model>
</ModelInformation>`;

const bddefaults = `<?xml version="1.0" encoding="utf-8"?>
<BlockDiagramDefaults>
  <BlockParameterDefaults>
    <Block BlockType="Gain"><P Name="Gain">7</P><P Name="SampleTime">-1</P></Block>
    <Block BlockType="Sum"><P Name="IconShape">rectangular</P><P Name="Inputs">++</P></Block>
  </BlockParameterDefaults>
</BlockDiagramDefaults>`;

const configSet = `<?xml version="1.0" encoding="utf-8"?><ConfigSet><Object><P Name="StopTime">30</P><P Name="Solver">VariableStepAuto</P><P Name="MaxStep">0.01</P><P Name="RelTol">1e-4</P></Object></ConfigSet>`;

function syntheticSlx(): Buffer {
  return buildStoredZip({
    "[Content_Types].xml": "<Types/>",
    "simulink/blockdiagram.xml": blockdiagram,
    "simulink/bddefaults.xml": bddefaults,
    "simulink/configSet0.xml": configSet,
  });
}

const byLabel = (components: ProjectComponent[], label: string) => components.find((component) => component.label === label);

(async () => {
  await test("ZIP: entradas armazenadas e deflate", () => {
    const zip = new ZipArchive(buildStoredZip({ "a.txt": "olá", "b/c.xml": "<x/>" }));
    assert(zip.readText("a.txt") === "olá" && zip.readText("b/c.xml") === "<x/>", "conteudo lido");
    // Deflate (método 8): o .slx real comprime as partes; monta uma entrada comprimida a mão.
    const raw = Buffer.from("conteudo comprimido ".repeat(20));
    const stored = buildStoredZip({ "d.txt": raw });
    const deflated = zlib.deflateRawSync(raw);
    const nameLength = stored.readUInt16LE(26);
    const local = Buffer.from(stored.subarray(0, 30 + nameLength));
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(deflated.length, 18);
    const centralStart = 30 + nameLength + raw.length;
    const central = Buffer.from(stored.subarray(centralStart, stored.length - 22));
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(deflated.length, 20);
    const end = Buffer.from(stored.subarray(stored.length - 22));
    end.writeUInt32LE(30 + nameLength + deflated.length, 16);
    const zipped = Buffer.concat([local, deflated, central, end]);
    assert(new ZipArchive(zipped).read("d.txt").equals(raw), "entrada deflate");
  });

  await test(".slx sintetico: blocos, padroes do arquivo, nomes antigos, ligacoes e subsistema", () => {
    const model = parseSimulinkModel(syntheticSlx(), "C:/tmp/sintetico.slx");
    assert(model.format === "slx" && model.root.blocks.length === 8, `blocos: ${model.root.blocks.length}`);
    const { project, report } = convertSimulinkModel(model, library);
    const components = project.components;
    const constant = byLabel(components, "K & ref")!;
    assert(constant.typeId === "sl.constant" && constant.properties.Value === "2*Kp", "Constant com expressao; entidade decodificada");
    const gain = byLabel(components, "Gain")!;
    assert(gain.properties.Gain === "7", `Gain sem valor no bloco usa o padrao DO ARQUIVO (7): ${gain.properties.Gain}`);
    const sum = byLabel(components, "Sum")!;
    assert(sum.properties.IconShape === "round" && sum.properties.Inputs === "|+-", "Sum com os valores do bloco");
    const step = byLabel(components, "Step")!;
    assert(step.properties.InitialValue === "-1" && step.properties.FinalValue === "3" && step.properties.Time === "2", `Step com nomes antigos Before/After: ${JSON.stringify(step.properties)}`);
    assert(step.visual?.rotation === 270 && step.flipH === true, "orientacao preservada");
    const pid = byLabel(components, "PID")!;
    assert(pid.typeId === "sl.pid_controller" && pid.properties.P === "2.5" && pid.properties.I === "0.5", `alias slpidlib -> PID Controller: ${pid.typeId}`);
    const conductors = project.topology.conductors;
    const to = (label: string) => conductors.filter((wire) => wire.to.kind === "port" && wire.to.componentId === byLabel(components, label)!.id);
    assert(to("Sum").length === 2 && to("Sum").some((wire) => wire.to.kind === "port" && wire.to.pinId === "in2"), "Sum recebe Gain (in1) e Step (in2)");
    assert(to("Planta").length === 1 && to("PID").length === 1, "ramificacao do Gain chega ao subsistema; subsistema -> PID");
    const viewer = byLabel(components, "Viewer")!;
    assert(viewer.typeId === "sl.scope" && to("Viewer").length === 1, "viewer vira Scope ligado ao sinal observado");
    const definition = project.subsystems?.[0] as unknown as { typeId: string; interface: Array<{ pinId: string; direction: string }>; components: ProjectComponent[] };
    assert(definition && definition.typeId === "subsystem.planta" && byLabel(components, "Planta")!.typeId === "subsystem.planta", "SubSystem vira definicao interna");
    assert(JSON.stringify(definition.interface.map((entry) => `${entry.pinId}:${entry.direction}`)) === JSON.stringify(["in1:in", "out1:out"]), "interface do subsistema");
    assert(definition.components.some((component) => component.typeId === "sl.integrator"), "conteudo do subsistema convertido");
    assert(report.unsupported.length === 1 && report.unsupported[0]!.blockType === "Goto", "Goto relatado como sem equivalente");
    assert(report.issues.some((issue) => /Goto/.test(issue.path)) || report.unsupported[0]!.reason.length > 0, "motivo relatado");
    assert(JSON.stringify(project.modelWorkspace) === JSON.stringify([{ name: "Kp", value: "", description: "citada em sintetico/K & ref (Value)" }]), `workspace: ${JSON.stringify(project.modelWorkspace)}`);
    assert(project.simulationSettings.maximumStepSeconds === 0.01 && project.simulationSettings.relativeTolerance === 1e-4, "solver: passo maximo e tolerancia");
    assert(formatSimulinkImportReport(report).includes("Kp"), "relatorio cita a variavel a definir");
  });

  await test(".mdl classico: linhas por nome com ramificacao e mascara antiga", () => {
    const source = `Model {
  Name "classico"
  BlockParameterDefaults {
    Block {
      BlockType Gain
      Gain "4"
    }
  }
  System {
    Name "classico"
    Block {
      BlockType Constant
      Name "C"
      Position [10, 10, 40, 40]
      Value "1"
    }
    Block {
      BlockType Gain
      Name "G"
      Position [80, 10, 110, 40]
    }
    Block {
      BlockType SubSystem
      Name "Masc"
      Position [150, 10, 200, 40]
      MaskVariables "Ti=@1;"
      MaskValueString "10"
      System {
        Block {
          BlockType Inport
          Name "In1"
        }
        Block {
          BlockType Gain
          Name "Ki"
          Gain "1/"
          "Ti"
        }
        Block {
          BlockType Outport
          Name "Out1"
        }
        Line {
          SrcBlock "In1"
          SrcPort 1
          DstBlock "Ki"
          DstPort 1
        }
        Line {
          SrcBlock "Ki"
          SrcPort 1
          DstBlock "Out1"
          DstPort 1
        }
      }
    }
    Line {
      SrcBlock "C"
      SrcPort 1
      Branch {
        DstBlock "G"
        DstPort 1
      }
      Branch {
        DstBlock "Masc"
        DstPort 1
      }
    }
  }
}
`;
    const model = parseMdl(source, "classico");
    const { project } = convertSimulinkModel(model, library);
    assert(project.components.length === 3 && project.topology.conductors.length === 2, `componentes ${project.components.length}, fios ${project.topology.conductors.length}`);
    assert(byLabel(project.components, "G")!.properties.Gain === "4", "padrao do arquivo no .mdl");
    const inner = (project.subsystems?.[0] as unknown as { components: ProjectComponent[] }).components;
    assert(byLabel(inner, "Ki")!.properties.Gain === "1/Ti", "texto continuado em duas linhas");
    assert(project.modelWorkspace?.some((variable) => variable.name === "Ti" && variable.value === "10") === true, "parametro de mascara vira variavel com o valor da mascara");
  });

  await test("caminhos de biblioteca e variaveis citadas", () => {
    assert(normalizeSourceBlock("simulink/Discrete/Transfer Fcn\nFirst Order") === "simulink/Discrete/Transfer Fcn First Order", "quebra de linha normalizada");
    assert(normalizeSourceBlock("pid_lib/Discrete PID Controller (2DOF)") === "simulink/Discrete/Discrete PID Controller (2DOF)", "alias pid_lib");
    assert(JSON.stringify(referencedVariables("2*l + sqrt(R)*pi", new Set())) === JSON.stringify(["l", "R"]), "variaveis l e R; sqrt e pi reconhecidos");
  });

  await test("modelos reais do usuario (quando presentes): tubulao e tubulaoNL convertem sem perda", () => {
    for (const name of ["tubulao", "tubulaoNL"]) {
      const file = `C:/SourceCode/_audit_process_simul/assets/${name}.slx`;
      if (!fs.existsSync(file)) continue;
      const { project, report } = convertSimulinkModel(parseSimulinkModel(fs.readFileSync(file), file), library);
      assert(report.unsupported.length === 0, `${name}: sem blocos omitidos (${report.unsupported.map((item) => item.path).join(", ")})`);
      assert(report.lines > 5 && project.components.length >= 10, `${name}: ${project.components.length} componentes, ${report.lines} ligacoes`);
      assert(!report.issues.some((issue) => issue.severity === "error"), `${name}: sem erro`);
      assert(!report.issues.some((issue) => /sinal observado/.test(issue.message)), `${name}: todos os sinais dos viewers ligados (${report.issues.map((issue) => issue.message).join("; ")})`);
    }
  });

  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

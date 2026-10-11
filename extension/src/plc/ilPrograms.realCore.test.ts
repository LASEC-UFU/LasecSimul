import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { IecProjectAuthoring, IecVariable, PouDefinition } from "./iecProject";
import { starterIecProject } from "./plcProjectTemplate";
import { PlcBuildOptions, buildIecProject, parsePlcVariableReply, resolvePlcToolchain } from "./plcBuild";

/**
 * Etapa 2 do CLP: Lista de Instruções (IEC 61131-3 3ª ed.) traduzida para ST, compilada e
 * EXECUTADA num Core real. Cada programa roda num bloco PLC; as entradas são forçadas pelo monitor
 * (plcForce) e as saídas lidas por plcGet, a cada scan da tarefa de 10 ms.
 *
 * Fora do `npm test` (precisa do Core, do STruCpp e de um g++):
 *   npm run compile && node out/plc/ilPrograms.realCore.test.js
 */
const { test, finish } = createTestRunner("CLP em IL (IEC 61131-3 3ª ed.) executado no Core real");

const extensionRoot = path.resolve(__dirname, "..", "..");
const MS = 1_000_000;

function v(name: string, variableClass: IecVariable["class"], type: string): IecVariable {
  return variableClass === "input" || variableClass === "output"
    ? { ioId: name, name, class: variableClass, type }
    : { name, class: variableClass, type };
}

function ilProject(id: string, variables: IecVariable[], il: string, extra: PouDefinition[] = []): IecProjectAuthoring {
  const project = starterIecProject(id);
  project.pous = [
    { pouId: "pou-main", name: "MAIN", kind: "program", interface: { variables }, implementation: { language: "il", text: il } },
    ...extra,
  ];
  return project;
}

const LOGIC_IL = `
(* Q1 = A AND (B OR C): operação adiada com parênteses *)
LD   A
AND( B
OR   C
)
ST   Q1
LDN  A          // Q2 = NOT A OR NOT B
ORN  B
ST   Q2
LD   A
XOR  B
STN  Q3         (* Q3 = NOT (A XOR B) *)
LD   A
S    LATCH      (* liga com A, desliga com C *)
LD   C
R    LATCH
`;

const ARITH_IL = `
LD   N
ADD  M
MUL  2
ST   SUM2       (* (N + M) * 2 *)
LD   N
SUB( M
MUL  3
)
ST   DIFF       (* N - (M * 3) *)
LD   N
MOD  4
ST   REMAINDER
LD   N
GT   M
ST   BIGGER
LD   N
INT_TO_REAL
DIV  4.0
ST   QUARTER    (* conversão de tipo como função *)
LD   0
LIMIT N, 100
ST   LIMITED    (* LIMIT(0, N, 100): o CR é o primeiro argumento *)
LD   G
SEL  10, 20
ST   CHOSEN     (* SEL(G, 10, 20) *)
LIMIT(
  MN := -5,
  IN := M,
  MX := 5
)
ST   FORMAL     (* chamada formal em várias linhas *)
`;

const LOOP_IL = `
       LD   STOPNOW
       RETC              (* RETC: sai do programa sem mexer nas saídas *)
       LD   0
       ST   ACC
       LD   1
       ST   I
LOOP:  LD   I
       GT   N
       JMPC FIM
       LD   ACC
       ADD  I
       ST   ACC
       LD   I
       ADD  1
       ST   I
       JMP  LOOP
FIM:   LD   ACC
       ST   RESULT       (* RESULT = 1 + 2 + ... + N *)
       LD   N
       EQ   0
       JMPCN NAOZERO
       LD   TRUE
       ST   ZERO
       JMP  FIM2
NAOZERO:
       LD   FALSE
       ST   ZERO
FIM2:
`;

const FB_IL = `
CAL  T1(IN := START, PT := T#200ms)
LD   T1.Q
ST   DONE
LD   PULSE
CU   C1          (* operadores de entrada da norma: C1(CU := PULSE) *)
LD   RST
R    C1          (* R com operando FB: entrada R do CTU, não reset de BOOL *)
LD   3
PV   C1
LD   C1.Q
ST   REACHED
LD   C1.CV
ST   COUNT
LD   ENABLE
CALC T2(IN := TRUE, PT := T#100ms)
LD   T2.Q
ST   T2DONE
`;

const USER_POUS_IL = `
CAL  FF(SET1 := A, RST1 := B)
LD   FF.Q
ST   QFF
LD   N
DOUBLE_IT        (* FUNCTION do projeto com o CR como argumento *)
ST   D2
DOUBLE_IT(
  V := M
)
ST   D3
`;

const MORE_IL = `
LD   A
&N   B
ST   Q_ANDN      (* & é AND; &N nega o operando *)
LD   A
ANDN( B
OR(  C
AND  D
)
)
ST   Q_NEST      (* A AND NOT (B OR (C AND D)) *)
LD   A
S1   SR1         (* SR1(S1 := A) *)
LD   B
R    SR1         (* SR1(R := B) *)
LD   SR1.Q1
ST   Q_SR
LD   C
CLK  RT1         (* R_TRIG pela entrada CLK *)
LD   RT1.Q
JMPCN SEM_BORDA
LD   EDGES
ADD  1
ST   EDGES
SEM_BORDA:
LD   T#1s
ADD  T#500ms
TIME_TO_MS
ST   DURMS
LD   W
AND  16#0F
ST   WLOW
LD   ARR[1]
ADD  ARR[2]
ST   ARR[0]
LD   ARR[0]
ST   ASUM
LD   'CL'
CONCAT 'P'
ST   NAME
LEN
ST   NAMELEN
LD   D
CALCN T3(IN := TRUE, PT := T#50ms)
LD   T3.Q
ST   T3Q
LD   D
RETCN
LD   TRUE
ST   AFTER
`;

const FLIPFLOP: PouDefinition = {
  pouId: "pou-flipflop", name: "FLIPFLOP", kind: "functionBlock",
  interface: { variables: [v("SET1", "input", "BOOL"), v("RST1", "input", "BOOL"), v("Q", "output", "BOOL")] },
  implementation: { language: "il", text: "LD SET1\nS Q\nLD RST1\nR Q" },
};
const DOUBLE_IT: PouDefinition = {
  pouId: "pou-double", name: "DOUBLE_IT", kind: "function",
  interface: { returnType: "INT", variables: [v("V", "input", "INT")] },
  implementation: { language: "il", text: "LD V\nMUL 2\nST DOUBLE_IT" },
};

(async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-plc-il-"));
  const options: PlcBuildOptions = { toolchain: resolvePlcToolchain(extensionRoot), cacheRoot };
  const pipeName = `lasecsimul-plc-il-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });

  /** Compila, cria um bloco PLC e devolve funções para forçar entradas e ler variáveis. */
  const load = async (project: IecProjectAuthoring) => {
    const built = await buildIecProject(project, options);
    if (!built.ok) throw new Error(`compilação: ${JSON.stringify(built.diagnostics)}\n${built.log}`);
    const pins = built.module.exportedIo.map((io, index) => ({ id: io.ioId, x: 0, y: index * 12 }));
    const plc = await client.addComponent("plc.instance", {}, pins, project.projectId);
    await client.setPlcTaskInterval(plc.instanceId, 10 * MS);
    await client.loadPlcArtifact(plc.instanceId, built.module);
    const force = async (values: Record<string, string | number | boolean>) => {
      for (const [name, value] of Object.entries(values)) {
        await client.plcForce(plc.instanceId, `MAIN.${name}`, typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value));
      }
    };
    const get = async (name: string) => parsePlcVariableReply(await client.plcGet(plc.instanceId, `MAIN.${name}`)).value;
    const write = async (name: string, value: string) => client.plcSet(plc.instanceId, `MAIN.${name}`, value);
    return { force, get, write };
  };

  try {
    processManager.start();
    await client.start();

    await test("Lógica com parênteses, N, XOR, STN, S/R: tabela-verdade das 8 combinações", async () => {
      const plc = await load(ilProject("il-logica", [
        v("A", "input", "BOOL"), v("B", "input", "BOOL"), v("C", "input", "BOOL"),
        v("Q1", "output", "BOOL"), v("Q2", "output", "BOOL"), v("Q3", "output", "BOOL"), v("LATCH", "output", "BOOL"),
      ], LOGIC_IL));
      let latch = false;
      for (let combo = 0; combo < 8; combo += 1) {
        const a = Boolean(combo & 4), b = Boolean(combo & 2), c = Boolean(combo & 1);
        await plc.force({ A: a, B: b, C: c });
        await client.step(30 * MS);
        if (a) latch = true;
        if (c) latch = false;
        const expected = { Q1: a && (b || c), Q2: !a || !b, Q3: !(a !== b), LATCH: latch };
        for (const [name, value] of Object.entries(expected)) {
          const actual = await plc.get(name);
          assert(actual === (value ? "TRUE" : "FALSE"), `A=${a} B=${b} C=${c}: ${name} = ${actual}, esperado ${value}`);
        }
      }
    });

    await test("Aritmética INT/REAL, MOD, comparação, conversão, LIMIT e SEL com o CR como 1º argumento, chamada formal", async () => {
      const plc = await load(ilProject("il-aritmetica", [
        v("N", "input", "INT"), v("M", "input", "INT"), v("G", "input", "BOOL"),
        v("SUM2", "output", "INT"), v("DIFF", "output", "INT"), v("REMAINDER", "output", "INT"), v("BIGGER", "output", "BOOL"),
        v("QUARTER", "output", "REAL"), v("LIMITED", "output", "INT"), v("CHOSEN", "output", "INT"), v("FORMAL", "output", "INT"),
      ], ARITH_IL));
      await plc.force({ N: 130, M: 7, G: true });
      await client.step(30 * MS);
      const values = Object.fromEntries(await Promise.all(["SUM2", "DIFF", "REMAINDER", "BIGGER", "QUARTER", "LIMITED", "CHOSEN", "FORMAL"]
        .map(async name => [name, await plc.get(name)])));
      assert(values.SUM2 === "274" && values.DIFF === "109" && values.REMAINDER === "2" && values.BIGGER === "TRUE", JSON.stringify(values));
      assert(Math.abs(Number(values.QUARTER) - 32.5) < 1e-6, `QUARTER ${values.QUARTER}`);
      assert(values.LIMITED === "100" && values.CHOSEN === "20" && values.FORMAL === "5", JSON.stringify(values));
    });

    await test("Rótulos e JMP/JMPC/JMPCN: laço soma 1..N; RETC sai do programa", async () => {
      const plc = await load(ilProject("il-saltos", [
        v("N", "input", "INT"), v("STOPNOW", "input", "BOOL"),
        v("RESULT", "output", "INT"), v("ZERO", "output", "BOOL"),
        v("ACC", "local", "INT"), v("I", "local", "INT"),
      ], LOOP_IL));
      await plc.force({ N: 10, STOPNOW: false });
      await client.step(30 * MS);
      assert(await plc.get("RESULT") === "55" && await plc.get("ZERO") === "FALSE", `N=10: ${await plc.get("RESULT")}, ZERO ${await plc.get("ZERO")}`);
      await plc.force({ N: 0 });
      await client.step(30 * MS);
      assert(await plc.get("RESULT") === "0" && await plc.get("ZERO") === "TRUE", `N=0: ${await plc.get("RESULT")}, ZERO ${await plc.get("ZERO")}`);
      await plc.force({ STOPNOW: true, N: 4 });
      await client.step(30 * MS);
      assert(await plc.get("RESULT") === "0", `RETC deixou RESULT = ${await plc.get("RESULT")}`);
    });

    await test("FBs: CAL formal no TON (200 ms de simulação), operadores de entrada CU/R/PV no CTU, CALC condicional", async () => {
      const plc = await load(ilProject("il-blocos", [
        v("START", "input", "BOOL"), v("PULSE", "input", "BOOL"), v("RST", "input", "BOOL"), v("ENABLE", "input", "BOOL"),
        v("DONE", "output", "BOOL"), v("REACHED", "output", "BOOL"), v("COUNT", "output", "INT"), v("T2DONE", "output", "BOOL"),
        v("T1", "local", "TON"), v("C1", "local", "CTU"), v("T2", "local", "TON"),
      ], FB_IL));
      await plc.force({ START: true, PULSE: false, RST: false, ENABLE: false });
      await client.step(150 * MS);
      const early = await plc.get("DONE");
      await client.step(100 * MS);
      const late = await plc.get("DONE");
      assert(early === "FALSE" && late === "TRUE", `TON 200 ms: 150 ms ${early}, 250 ms ${late}`);
      for (let pulse = 0; pulse < 3; pulse += 1) {
        await plc.force({ PULSE: true });
        await client.step(30 * MS);
        await plc.force({ PULSE: false });
        await client.step(30 * MS);
      }
      assert(await plc.get("COUNT") === "3" && await plc.get("REACHED") === "TRUE", `CTU ${await plc.get("COUNT")}, Q ${await plc.get("REACHED")}`);
      await plc.force({ RST: true });
      await client.step(30 * MS);
      assert(await plc.get("COUNT") === "0" && await plc.get("REACHED") === "FALSE", `R C1: ${await plc.get("COUNT")}`);
      await client.step(200 * MS);
      const disabled = await plc.get("T2DONE");
      await plc.force({ ENABLE: true });
      await client.step(200 * MS);
      assert(disabled === "FALSE" && await plc.get("T2DONE") === "TRUE", `CALC: sem ENABLE ${disabled}, com ENABLE ${await plc.get("T2DONE")}`);
    });

    await test("FUNCTION_BLOCK e FUNCTION escritos em IL, chamados de um PROGRAM em IL (CAL formal, CR e chamada formal)", async () => {
      const plc = await load(ilProject("il-pous", [
        v("A", "input", "BOOL"), v("B", "input", "BOOL"), v("N", "input", "INT"), v("M", "input", "INT"),
        v("QFF", "output", "BOOL"), v("D2", "output", "INT"), v("D3", "output", "INT"),
        v("FF", "local", "FLIPFLOP"),
      ], USER_POUS_IL, [FLIPFLOP, DOUBLE_IT]));
      await plc.force({ A: true, B: false, N: 21, M: -4 });
      await client.step(30 * MS);
      const set = await plc.get("QFF");
      await plc.force({ A: false });
      await client.step(30 * MS);
      const held = await plc.get("QFF");
      await plc.force({ B: true });
      await client.step(30 * MS);
      const reset = await plc.get("QFF");
      assert(set === "TRUE" && held === "TRUE" && reset === "FALSE", `FLIPFLOP: ${set} ${held} ${reset}`);
      assert(await plc.get("D2") === "42" && await plc.get("D3") === "-8", `DOUBLE_IT: ${await plc.get("D2")}, ${await plc.get("D3")}`);
    });

    await test("&N, ANDN( com parênteses aninhados, SR e R_TRIG por operadores de entrada, TIME, WORD 16#, ARRAY, STRING, CALCN, RETCN", async () => {
      const plc = await load(ilProject("il-mais", [
        v("A", "input", "BOOL"), v("B", "input", "BOOL"), v("C", "input", "BOOL"), v("D", "input", "BOOL"), v("W", "input", "WORD"),
        v("Q_ANDN", "output", "BOOL"), v("Q_NEST", "output", "BOOL"), v("Q_SR", "output", "BOOL"), v("EDGES", "output", "INT"),
        v("DURMS", "output", "LINT"), v("WLOW", "output", "WORD"), v("ASUM", "output", "INT"), v("NAMELEN", "output", "INT"),
        v("T3Q", "output", "BOOL"), v("AFTER", "output", "BOOL"),
        v("SR1", "local", "SR"), v("RT1", "local", "R_TRIG"), v("T3", "local", "TON"), v("NAME", "local", "STRING"),
        { name: "ARR", class: "local", type: "ARRAY[0..2] OF INT", initialValue: "[0, 5, 7]" },
      ], MORE_IL));
      const truth: Array<[boolean, boolean, boolean, boolean]> = [
        [true, false, false, false], [true, true, false, false], [true, false, true, true], [true, false, true, false], [false, false, false, false],
      ];
      for (const [a, b, c, d] of truth) {
        await plc.force({ A: a, B: b, C: c, D: d, W: 0xab });
        await client.step(30 * MS);
        if (!d) {
          // RETCN: com D = FALSE o programa sai antes do fim, mas tudo antes do RETCN rodou.
          assert(await plc.get("Q_ANDN") === (a && !b ? "TRUE" : "FALSE"), `&N com A=${a} B=${b}`);
          assert(await plc.get("Q_NEST") === (a && !(b || (c && d)) ? "TRUE" : "FALSE"), `aninhado A=${a} B=${b} C=${c} D=${d}`);
        }
      }
      assert(await plc.get("DURMS") === "1500" && await plc.get("WLOW") === "16#000B" && await plc.get("ASUM") === "12" && await plc.get("NAMELEN") === "3",
        `TIME ${await plc.get("DURMS")}, WORD ${await plc.get("WLOW")}, ARRAY ${await plc.get("ASUM")}, STRING ${await plc.get("NAMELEN")}`);
      await plc.force({ A: true, B: false });
      await client.step(30 * MS);
      const setSr = await plc.get("Q_SR");
      await plc.force({ A: false, B: true });
      await client.step(30 * MS);
      assert(setSr === "TRUE" && await plc.get("Q_SR") === "FALSE", `SR: ${setSr} -> ${await plc.get("Q_SR")}`);
      const before = Number(await plc.get("EDGES"));
      for (let pulse = 0; pulse < 2; pulse += 1) {
        await plc.force({ C: true });
        await client.step(30 * MS);
        await plc.force({ C: false });
        await client.step(30 * MS);
      }
      assert(Number(await plc.get("EDGES")) - before === 2, `R_TRIG contou ${Number(await plc.get("EDGES")) - before} bordas em 2 pulsos`);
      await plc.force({ D: false });
      await plc.write("AFTER", "FALSE"); // ficou TRUE das rodadas com D = TRUE; RETCN não deve religar
      await client.step(80 * MS);
      assert(await plc.get("T3Q") === "TRUE" && await plc.get("AFTER") === "FALSE", `CALCN/RETCN com D=FALSE: T3Q ${await plc.get("T3Q")}, AFTER ${await plc.get("AFTER")}`);
      await plc.force({ D: true });
      await client.step(30 * MS);
      assert(await plc.get("AFTER") === "TRUE", "com D=TRUE o programa passa do RETCN");
    });

    await test("Exemplos trm/plc partida_pisca em ST e em IL: mesmas saídas a cada 50 ms de simulação", async () => {
      const exampleDir = path.resolve(extensionRoot, "..", "trm", "plc");
      const read = (name: string) => JSON.parse(fs.readFileSync(path.join(exampleDir, name), "utf8")) as IecProjectAuthoring;
      const stPlc = await load(read("partida_pisca.iec.json"));
      const ilPlc = await load(read("partida_pisca_il.iec.json"));
      const sample = async () => {
        const one = async (plc: typeof stPlc) => ["LAMP", "BLINK", "COUNT"].map(async name => plc.get(name));
        return [await Promise.all(await one(stPlc)), await Promise.all(await one(ilPlc))].map(values => values.join(","));
      };
      const both = async (values: Record<string, boolean>) => { await stPlc.force(values); await ilPlc.force(values); };
      const trace: string[] = [];
      await both({ START: false, STOP: false });
      await client.step(50 * MS);
      await both({ START: true });
      await client.step(50 * MS);
      await both({ START: false });
      for (let index = 0; index < 30; index += 1) {
        await client.step(50 * MS);
        const [st, il] = await sample();
        assert(st === il, `t=${(index + 2) * 50} ms: ST ${st} x IL ${il}`);
        trace.push(st!);
      }
      await both({ STOP: true });
      await client.step(50 * MS);
      const [stopped] = await sample();
      const blinkChanges = trace.slice(1).filter((value, index) => value.split(",")[1] !== trace[index]!.split(",")[1]).length;
      assert(trace.every(value => value.startsWith("TRUE,")) && blinkChanges >= 2 && stopped!.startsWith("FALSE,FALSE"),
        `selo ${trace[0]}, trocas do pisca ${blinkChanges}, depois do DESLIGA ${stopped}`);
    });

    await test("Erros de IL apontam POU e linha antes de chamar o compilador", async () => {
      const result = await buildIecProject(ilProject("il-erros", [v("A", "input", "BOOL"), v("Q", "output", "BOOL")],
        "LD A\nAND B\nJMP NENHUM\nFOO Q\nST Q"), options);
      assert(!result.ok, "devia falhar");
      if (result.ok) return;
      const found = result.diagnostics.map(item => `${item.pouName}:${item.line}:${item.message}`);
      assert(found.some(item => item.startsWith("MAIN:2:") && /B/.test(item)), found.join(" | "));
      assert(found.some(item => item.startsWith("MAIN:3:") && /NENHUM/.test(item)), found.join(" | "));
      assert(found.some(item => item.startsWith("MAIN:4:") && /FOO/.test(item)), found.join(" | "));
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

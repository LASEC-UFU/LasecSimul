import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { IecProjectAuthoring, IecVariable, LdCell, LdCoilKind, LdContactKind, LdRung, PouDefinition } from "./iecProject";
import { starterIecProject } from "./plcProjectTemplate";
import { PlcBuildOptions, buildIecProject, parsePlcVariableReply, resolvePlcToolchain } from "./plcBuild";

/**
 * Etapa 4 do CLP: Ladder (IEC 61131-3 3ª ed., seção 8.2) traduzido para ST, compilado e EXECUTADO
 * num Core real, tarefa de 10 ms. Entradas forçadas pelo monitor; saídas lidas por plcGet.
 *
 * Fora do `npm test`: npm run compile && node out/plc/ldPrograms.realCore.test.js
 */
const { test, finish } = createTestRunner("CLP em LD (IEC 61131-3 3ª ed.) executado no Core real");

const extensionRoot = path.resolve(__dirname, "..", "..");
const MS = 1_000_000;

function v(name: string, variableClass: IecVariable["class"], type: string): IecVariable {
  return variableClass === "input" || variableClass === "output" ? { ioId: name, name, class: variableClass, type } : { name, class: variableClass, type };
}

const contact = (variable: string, kind: LdContactKind = "no"): LdCell => ({ kind: "contact", contact: kind, variable });
const coil = (variable: string, kind: LdCoilKind = "coil"): LdCell => ({ kind: "coil", coil: kind, variable });
const wire: LdCell = { kind: "wire" };
const block = (typeName: string, powerInput: string, powerOutput: string, inputs: Record<string, string> = {}, outputs: Record<string, string> = {}, instanceName?: string): LdCell =>
  ({ kind: "block", typeName, powerInput, powerOutput, inputs, outputs, ...(instanceName ? { instanceName } : {}) });

let rungCounter = 0;
function rung(rows: Array<Array<LdCell | null>>, verticals: Array<[number, number]> = [], label?: string): LdRung {
  rungCounter += 1;
  return { rungId: `rung-${rungCounter}`, rows, verticals: verticals.map(([row, column]) => ({ row, column })), ...(label ? { label } : {}) };
}

function ldProject(id: string, variables: IecVariable[], rungs: LdRung[], extra: PouDefinition[] = []): IecProjectAuthoring {
  const project = starterIecProject(id);
  project.pous = [{ pouId: "pou-main", name: "MAIN", kind: "program", interface: { variables }, implementation: { language: "ld", networks: [], rungs } }, ...extra];
  return project;
}

(async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-plc-ld-"));
  const options: PlcBuildOptions = { toolchain: resolvePlcToolchain(extensionRoot), cacheRoot };
  const pipeName = `lasecsimul-plc-ld-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });

  const load = async (project: IecProjectAuthoring) => {
    const built = await buildIecProject(project, options);
    if (!built.ok) throw new Error(`compilação: ${JSON.stringify(built.diagnostics)}\n${built.log}`);
    const pins = built.module.exportedIo.map((io, index) => ({ id: io.ioId, x: 0, y: index * 12 }));
    const plc = await client.addComponent("plc.instance", {}, pins, project.projectId);
    await client.setPlcTaskInterval(plc.instanceId, 10 * MS);
    await client.loadPlcArtifact(plc.instanceId, built.module);
    const force = async (values: Record<string, boolean | number>) => {
      for (const [name, value] of Object.entries(values)) {
        await client.plcForce(plc.instanceId, `MAIN.${name}`, typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value));
      }
    };
    const get = async (name: string) => parsePlcVariableReply(await client.plcGet(plc.instanceId, `MAIN.${name}`)).value;
    const on = async (name: string) => (await get(name)) === "TRUE";
    return { force, get, on };
  };
  const pulse = async (plc: Awaited<ReturnType<typeof load>>, name: string) => {
    await plc.force({ [name]: true });
    await client.step(30 * MS);
    await plc.force({ [name]: false });
    await client.step(30 * MS);
  };

  try {
    processManager.start();
    await client.start();

    await test("Contatos NA/NF, bobina, bobina negada, set/reset; série, paralelo por ligação vertical e ramo no meio: tabela-verdade", async () => {
      const plc = await load(ldProject("ld-logica", [
        v("A", "input", "BOOL"), v("B", "input", "BOOL"), v("C", "input", "BOOL"),
        v("Q1", "output", "BOOL"), v("Q2", "output", "BOOL"), v("Q3", "output", "BOOL"), v("Q4", "output", "BOOL"), v("LATCH", "output", "BOOL"),
      ], [
        rung([[contact("A"), contact("B"), coil("Q1")]]),                                            // A AND B
        rung([[contact("A"), wire, coil("Q2")], [contact("B", "nc"), null, null]], [[0, 0]]),        // A OR NOT B
        rung([[contact("A"), coil("Q3", "negated")]]),                                               // NOT A
        rung([[contact("A"), contact("B"), coil("Q4")], [null, contact("C"), null]], [[0, 0], [0, 1]]), // A AND (B OR C)
        rung([[contact("A"), coil("LATCH", "set")]]),
        rung([[contact("C"), coil("LATCH", "reset")]]),
      ]));
      let latch = false;
      for (let combo = 0; combo < 8; combo += 1) {
        const a = Boolean(combo & 4), b = Boolean(combo & 2), c = Boolean(combo & 1);
        await plc.force({ A: a, B: b, C: c });
        await client.step(30 * MS);
        if (a) latch = true;
        if (c) latch = false; // a rede do reset vem depois da do set
        const expected = { Q1: a && b, Q2: a || !b, Q3: !a, Q4: a && (b || c), LATCH: latch };
        for (const [name, value] of Object.entries(expected)) {
          assert((await plc.on(name)) === value, `A=${a} B=${b} C=${c}: ${name} = ${await plc.get(name)}, esperado ${value}`);
        }
      }
    });

    await test("Contatos e bobinas de transição P/N: uma avaliação por borda", async () => {
      const count = (target: string) => block("ADD", "EN", "ENO", { IN1: target, IN2: "1" }, { OUT: target });
      const plc = await load(ldProject("ld-bordas", [
        v("X", "input", "BOOL"), v("CP", "output", "INT"), v("CN", "output", "INT"), v("CPC", "output", "INT"), v("CNC", "output", "INT"),
        v("PP", "local", "BOOL"), v("PN", "local", "BOOL"),
      ], [
        rung([[contact("X", "p"), count("CP")]]),
        rung([[contact("X", "n"), count("CN")]]),
        rung([[contact("X"), coil("PP", "p")]]),
        rung([[contact("PP"), count("CPC")]]),
        rung([[contact("X"), coil("PN", "n")]]),
        rung([[contact("PN"), count("CNC")]]),
      ]));
      await plc.force({ X: false });
      await client.step(30 * MS);
      for (let index = 0; index < 3; index += 1) await pulse(plc, "X");
      const counts = [await plc.get("CP"), await plc.get("CN"), await plc.get("CPC"), await plc.get("CNC")].join(",");
      assert(counts === "3,3,3,3", `3 pulsos de X: contato P, contato N, bobina P, bobina N = ${counts}`);
    });

    await test("Blocos: TON e CTU ligados ao degrau pela entrada/saída BOOL; funções com EN/ENO; função BOOL como saída do degrau; contato de comparação", async () => {
      const plc = await load(ldProject("ld-blocos", [
        v("START", "input", "BOOL"), v("PULSE", "input", "BOOL"), v("RST", "input", "BOOL"), v("EN_SW", "input", "BOOL"), v("N", "input", "INT"),
        v("DONE", "output", "BOOL"), v("REACHED", "output", "BOOL"), v("COUNT", "output", "INT"), v("DOUBLE", "output", "INT"), v("OK", "output", "BOOL"),
        v("BIG", "output", "BOOL"), v("GE5", "output", "BOOL"),
        v("T1", "local", "TON"), v("C1", "local", "CTU"),
      ], [
        rung([[contact("START"), block("TON", "IN", "Q", { PT: "T#200ms" }, {}, "T1"), coil("DONE")]]),
        rung([[contact("PULSE"), block("CTU", "CU", "Q", { R: "RST", PV: "3" }, { CV: "COUNT" }, "C1"), coil("REACHED")]]),
        rung([[contact("EN_SW"), block("MUL", "EN", "ENO", { IN1: "N", IN2: "2" }, { OUT: "DOUBLE" }), coil("OK")]]),
        rung([[block("GT", "EN", "OUT", { IN1: "N", IN2: "10" }), coil("BIG")]]),
        rung([[{ kind: "compare", operator: ">=", left: "N", right: "5", dataType: "INT" }, coil("GE5")]]),
      ]));
      await plc.force({ START: true, PULSE: false, RST: false, EN_SW: false, N: 7 });
      await client.step(150 * MS);
      const early = await plc.on("DONE");
      await client.step(100 * MS);
      assert(!early && await plc.on("DONE"), `TON 200 ms pelo degrau: 150 ms ${early}, 250 ms ${await plc.on("DONE")}`);
      for (let index = 0; index < 3; index += 1) await pulse(plc, "PULSE");
      assert(await plc.get("COUNT") === "3" && await plc.on("REACHED"), `CTU: ${await plc.get("COUNT")}, Q ${await plc.get("REACHED")}`);
      assert(await plc.get("DOUBLE") === "0" && !(await plc.on("OK")), "MUL com EN = FALSE não executa; ENO = FALSE");
      await plc.force({ EN_SW: true });
      await client.step(30 * MS);
      assert(await plc.get("DOUBLE") === "14" && await plc.on("OK"), `MUL com EN: ${await plc.get("DOUBLE")}, ENO ${await plc.get("OK")}`);
      assert(!(await plc.on("BIG")) && await plc.on("GE5"), "N = 7: GT 10 falso, contato N >= 5 conduz");
      await plc.force({ N: 11 });
      await client.step(30 * MS);
      assert(await plc.on("BIG") && await plc.on("GE5"), "N = 11: GT 10 verdadeiro");
      await plc.force({ N: 3 });
      await client.step(30 * MS);
      assert(!(await plc.on("GE5")), "N = 3: contato N >= 5 não conduz");
    });

    await test("Redes avaliadas de cima para baixo: selo; cadeia M1->M2->M3 resolve num ciclo na ordem direta e em três na inversa", async () => {
      const chain = (id: string, reversed: boolean) => {
        const rungs = [rung([[contact("X"), coil("M1")]]), rung([[contact("M1"), coil("M2")]]), rung([[contact("M2"), coil("M3")]])];
        return ldProject(id, [v("X", "input", "BOOL"), v("M1", "output", "BOOL"), v("M2", "output", "BOOL"), v("M3", "output", "BOOL")], reversed ? rungs.reverse() : rungs);
      };
      const direct = await load(chain("ld-ordem-direta", false));
      const reversed = await load(chain("ld-ordem-inversa", true));
      await direct.force({ X: false });
      await reversed.force({ X: false });
      await client.step(30 * MS);
      await direct.force({ X: true });
      await reversed.force({ X: true });
      await client.step(10 * MS);
      const afterOne = [await direct.on("M3"), await reversed.on("M3")];
      await client.step(20 * MS);
      assert(afterOne[0] === true && afterOne[1] === false && await reversed.on("M3"), `1 ciclo: direta ${afterOne[0]}, inversa ${afterOne[1]}; 3 ciclos: inversa ${await reversed.on("M3")}`);

      const seal = await load(ldProject("ld-selo", [v("START", "input", "BOOL"), v("STOP", "input", "BOOL"), v("RUN", "output", "BOOL"), v("LAMP", "output", "BOOL")], [
        rung([[contact("START"), contact("STOP", "nc"), coil("RUN")], [contact("RUN"), null, null]], [[0, 0]]),
        rung([[contact("RUN"), coil("LAMP")]]),
      ]));
      await seal.force({ START: false, STOP: false });
      await pulse(seal, "START");
      const held = await seal.on("LAMP");
      await pulse(seal, "STOP");
      assert(held && !(await seal.on("LAMP")), `selo: ${held}; depois do STOP ${await seal.on("LAMP")}`);
    });

    await test("Salto condicional e incondicional para rótulo de rede; retorno condicional", async () => {
      const plc = await load(ldProject("ld-saltos", [
        v("SKIP", "input", "BOOL"), v("STOPR", "input", "BOOL"), v("MID", "output", "BOOL"), v("FIM", "output", "BOOL"),
        v("NUNCA", "output", "BOOL"), v("AFTER", "output", "BOOL"),
      ], [
        rung([[contact("SKIP"), { kind: "jump", label: "CONTINUA" }]]),
        rung([[coil("MID", "set")]]),
        rung([[coil("FIM", "set")]], [], "CONTINUA"),
        rung([[{ kind: "jump", label: "DEPOIS" }]]),               // incondicional: direto na barra
        rung([[coil("NUNCA", "set")]]),
        rung([[contact("STOPR"), { kind: "return" }]], [], "DEPOIS"),
        rung([[coil("AFTER", "set")]]),
      ]));
      await plc.force({ SKIP: true, STOPR: true });
      await client.step(30 * MS);
      assert(!(await plc.on("MID")) && await plc.on("FIM") && !(await plc.on("NUNCA")) && !(await plc.on("AFTER")),
        `SKIP e STOPR: MID ${await plc.get("MID")}, FIM ${await plc.get("FIM")}, NUNCA ${await plc.get("NUNCA")}, AFTER ${await plc.get("AFTER")}`);
      await plc.force({ SKIP: false, STOPR: false });
      await client.step(30 * MS);
      assert(await plc.on("MID") && !(await plc.on("NUNCA")) && await plc.on("AFTER"), "sem SKIP a rede do meio roda; sem STOPR o programa passa do retorno");
    });

    await test("Exemplos trm/plc partida_pisca em ST e em LD: mesmas saídas a cada 50 ms; fluxo de energia do selo no monitor", async () => {
      const exampleDir = path.resolve(extensionRoot, "..", "trm", "plc");
      const read = (name: string) => JSON.parse(fs.readFileSync(path.join(exampleDir, name), "utf8")) as IecProjectAuthoring;
      const stPlc = await load(read("partida_pisca.iec.json"));
      const ldPlc = await load(read("partida_pisca_ld.iec.json"));
      const sample = async (plc: typeof stPlc) => (await Promise.all(["LAMP", "BLINK", "COUNT"].map(name => plc.get(name)))).join(",");
      const both = async (values: Record<string, boolean>) => { await stPlc.force(values); await ldPlc.force(values); };
      await both({ START: false, STOP: false });
      await client.step(50 * MS);
      await both({ START: true });
      await client.step(50 * MS);
      await both({ START: false });
      const trace: string[] = [];
      for (let index = 0; index < 30; index += 1) {
        await client.step(50 * MS);
        const [st, ld] = [await sample(stPlc), await sample(ldPlc)];
        assert(st === ld, `t=${(index + 2) * 50} ms: ST ${st} x LD ${ld}`);
        trace.push(st);
      }
      const blinkChanges = trace.slice(1).filter((value, index) => value.split(",")[1] !== trace[index]!.split(",")[1]).length;
      assert(trace.every(value => value.startsWith("TRUE,")) && blinkChanges >= 2, `selo ${trace[0]}, trocas do pisca ${blinkChanges}`);
      // Rede 1 com START solto: o contato START (linha 1) não conduz, o ramo RUN (linha 2) e o NF STOP conduzem.
      const power = async (name: string) => ldPlc.on(name);
      assert(!(await power("__LD_1_1_1")) && await power("__LD_1_2_1") && await power("__LD_1_1_2") && await power("__LD_1_1_3"),
        "fluxo de energia: START aberto, ramo do selo, NF STOP e bobina RUN energizados");
      await both({ STOP: true });
      await client.step(50 * MS);
      assert((await sample(stPlc)).startsWith("FALSE,FALSE") && (await sample(ldPlc)).startsWith("FALSE,FALSE"), "DESLIGA apaga nos dois");
    });

    await test("Erros: variável não declarada, bobina em entrada, contato não BOOL, elemento sem ligação, bloco desconhecido, rótulo inexistente", async () => {
      const result = await buildIecProject(ldProject("ld-erros", [v("A", "input", "BOOL"), v("N", "input", "INT"), v("Q", "output", "BOOL")], [
        rung([[contact("NADA"), coil("A")]]),
        rung([[contact("N"), null, coil("Q")]]),
        rung([[block("FOO", "EN", "ENO"), { kind: "jump", label: "SUMIU" }]]),
      ]), options);
      assert(!result.ok, "devia falhar");
      if (result.ok) return;
      const text = result.diagnostics.map(item => `${item.elementLabel ?? ""}: ${item.message}`).join(" | ");
      for (const expected of [/rede 1, linha 1, coluna 1: variável não declarada: NADA/, /bobina não pode escrever na entrada A/, /contato precisa de uma variável BOOL: N é INT/,
        /rede 2, linha 1, coluna 3: elemento sem ligação à esquerda/, /bloco desconhecido: FOO/, /rótulo não encontrado: SUMIU/]) {
        assert(expected.test(text), `${expected} em ${text}`);
      }
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

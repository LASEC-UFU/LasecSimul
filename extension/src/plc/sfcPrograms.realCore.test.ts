import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { IecProjectAuthoring, IecVariable, SfcAction, SfcActionAssociation, SfcStep, SfcTransition } from "./iecProject";
import { starterIecProject } from "./plcProjectTemplate";
import { PlcBuildOptions, buildIecProject, parsePlcVariableReply, resolvePlcToolchain } from "./plcBuild";

/**
 * Etapa 3 do CLP: SFC (IEC 61131-3 3ª ed., seção 6.7) traduzido para ST, compilado e EXECUTADO num
 * Core real, tarefa de 10 ms. Entradas forçadas pelo monitor; saídas e `__SFC_<PASSO>_X` lidos.
 *
 * Fora do `npm test`: npm run compile && node out/plc/sfcPrograms.realCore.test.js
 */
const { test, finish } = createTestRunner("CLP em SFC (IEC 61131-3 3ª ed.) executado no Core real");

const extensionRoot = path.resolve(__dirname, "..", "..");
const MS = 1_000_000;

function v(name: string, variableClass: IecVariable["class"], type: string): IecVariable {
  return variableClass === "input" || variableClass === "output" ? { ioId: name, name, class: variableClass, type } : { name, class: variableClass, type };
}

function step(name: string, actions: Array<[string, string, string?]> = [], initial = false): SfcStep {
  return {
    stepId: `s-${name}`, name, ...(initial ? { initial: true } : {}),
    actions: actions.map(([qualifier, actionName, time], index): SfcActionAssociation => ({
      actionId: `a-${name}-${index}`, qualifier: qualifier as SfcActionAssociation["qualifier"], actionName, ...(time ? { time } : {}),
    })),
  };
}

function tr(id: string, from: string[], to: string[], condition: string, priority?: number): SfcTransition {
  return { transitionId: id, fromStepIds: from.map(name => `s-${name}`), toStepIds: to.map(name => `s-${name}`), condition,
    ...(priority !== undefined ? { priority } : {}) };
}

function sfcProject(id: string, variables: IecVariable[], steps: SfcStep[], transitions: SfcTransition[], actions: SfcAction[] = []): IecProjectAuthoring {
  const project = starterIecProject(id);
  project.pous = [{ pouId: "pou-main", name: "MAIN", kind: "program", interface: { variables },
    implementation: { language: "sfc", steps, transitions, actions } }];
  return project;
}

(async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lasecsimul-plc-sfc-"));
  const options: PlcBuildOptions = { toolchain: resolvePlcToolchain(extensionRoot), cacheRoot };
  const pipeName = `lasecsimul-plc-sfc-${process.pid}`;
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
    const active = async (stepName: string) => on(`__SFC_${stepName}_X`);
    return { force, get, on, active, instanceId: plc.instanceId };
  };

  try {
    processManager.start();
    await client.start();

    await test("Sequência: START ativa S1; transições TRUE avançam um passo por ciclo; S3.T >= 100 ms volta ao inicial", async () => {
      const plc = await load(sfcProject("sfc-seq", [
        v("START", "input", "BOOL"), v("L1", "output", "BOOL"), v("L2", "output", "BOOL"), v("L3", "output", "BOOL"),
      ], [step("S0", [], true), step("S1", [["N", "L1"]]), step("S2", [["N", "L2"]]), step("S3", [["N", "L3"]])], [
        tr("t0", ["S0"], ["S1"], "START"), tr("t1", ["S1"], ["S2"], "TRUE"), tr("t2", ["S2"], ["S3"], "TRUE"), tr("t3", ["S3"], ["S0"], "S3.T >= T#100ms"),
      ]));
      await plc.force({ START: false });
      await client.step(30 * MS);
      assert(await plc.active("S0") && !(await plc.on("L1")), "parado no passo inicial");
      await plc.force({ START: true });
      const trace: string[] = [];
      for (let index = 0; index < 18; index += 1) {
        await client.step(10 * MS);
        trace.push(`${Number(await plc.on("L1"))}${Number(await plc.on("L2"))}${Number(await plc.on("L3"))}`);
      }
      await plc.force({ START: false });
      const firstL1 = trace.indexOf("100");
      assert(firstL1 >= 0 && trace[firstL1 + 1] === "010" && trace[firstL1 + 2] === "001", `um passo por ciclo: ${trace.join(" ")}`);
      const l3Scans = trace.slice(firstL1 + 2).findIndex(item => item !== "001");
      assert(l3Scans >= 10 && l3Scans <= 12, `S3 ficou ${l3Scans} ciclos de 10 ms (S3.T >= 100 ms): ${trace.join(" ")}`);
    });

    await test("Qualificadores N S R L D SD DS SL P1 P0 pelo ACTION_CONTROL da norma; A = Q ou a última execução", async () => {
      const outputs = ["QN", "QS", "QL", "QD", "QSD", "QDS", "QSL"];
      const plc = await load(sfcProject("sfc-qualif", [
        v("GO1", "input", "BOOL"), v("GO2", "input", "BOOL"), v("GO3", "input", "BOOL"),
        ...outputs.map(name => v(name, "output", "BOOL")),
        v("NP1", "output", "INT"), v("NA", "output", "INT"), v("NP0", "output", "INT"),
      ], [
        step("INIT", [], true),
        step("A", [["N", "QN"], ["S", "QS"], ["L", "QL", "T#50ms"], ["D", "QD", "T#50ms"], ["SD", "QSD", "T#50ms"],
          ["DS", "QDS", "T#50ms"], ["SL", "QSL", "T#50ms"], ["P1", "PULSE1"], ["P0", "PULSE0"]]),
        step("B"),
        step("C", [["R", "QS"], ["R", "QSD"], ["R", "QDS"], ["R", "QSL"]]),
      ], [
        tr("t1", ["INIT"], ["A"], "GO1"), tr("t2", ["A"], ["B"], "GO2"), tr("t3", ["B"], ["C"], "GO3"), tr("t4", ["C"], ["INIT"], "TRUE"),
      ], [
        { name: "PULSE1", language: "st", text: "IF PULSE1.Q THEN\n  NP1 := NP1 + 1;\nEND_IF;\nNA := NA + 1;" },
        { name: "PULSE0", language: "st", text: "IF PULSE0.Q THEN NP0 := NP0 + 1; END_IF;" },
      ]));
      const snapshot = async () => Object.fromEntries(await Promise.all(outputs.map(async name => [name, await plc.on(name)] as const)));
      await plc.force({ GO1: false, GO2: false, GO3: false });
      await client.step(20 * MS);
      await plc.force({ GO1: true });
      await client.step(10 * MS);               // INIT -> A no fim deste ciclo
      await plc.force({ GO1: false });
      await client.step(20 * MS);               // A ativo há ~20 ms
      const early = await snapshot();
      await client.step(60 * MS);               // ~80 ms
      const late = await snapshot();
      await plc.force({ GO2: true });
      await client.step(10 * MS);
      await plc.force({ GO2: false });
      await client.step(30 * MS);               // B ativo
      const inB = await snapshot();
      await plc.force({ GO3: true });
      await client.step(30 * MS);               // C (R) e de volta ao INIT
      await plc.force({ GO3: false });
      const afterReset = await snapshot();
      const counts = { NP1: await plc.get("NP1"), NA: await plc.get("NA"), NP0: await plc.get("NP0") };
      const expect = (label: string, actual: Record<string, boolean>, expected: Record<string, boolean>) => {
        for (const [name, value] of Object.entries(expected)) assert(actual[name] === value, `${label}: ${name} = ${actual[name]}, norma: ${value}`);
      };
      expect("A +20 ms", early, { QN: true, QS: true, QL: true, QD: false, QSD: false, QDS: false, QSL: true });
      expect("A +80 ms", late, { QN: true, QS: true, QL: false, QD: true, QSD: true, QDS: true, QSL: false });
      expect("em B", inB, { QN: false, QS: true, QL: false, QD: false, QSD: true, QDS: true, QSL: false });
      expect("depois do R em C", afterReset, { QN: false, QS: false, QSD: false, QDS: false, QSL: false });
      // P1: um pulso de Q por ativação; o corpo roda também na última execução (A), então NA = 2.
      assert(counts.NP1 === "1" && counts.NA === "2" && counts.NP0 === "1", `P1/P0/A: ${JSON.stringify(counts)}`);
    });

    await test("DS: passo ativo menos que T não memoriza a ação", async () => {
      const plc = await load(sfcProject("sfc-ds", [v("GO", "input", "BOOL"), v("Q", "output", "BOOL")], [
        step("INIT", [], true), step("A", [["DS", "Q", "T#50ms"]]), step("B"),
      ], [tr("t1", ["INIT"], ["A"], "GO"), tr("t2", ["A"], ["B"], "A.T >= T#20ms"), tr("t3", ["B"], ["INIT"], "NOT GO")]));
      await plc.force({ GO: true });
      await client.step(150 * MS);
      assert(!(await plc.on("Q")), "A durou ~20 ms < 50 ms: DS não ligou");
    });

    await test("Divergência seletiva: prioridade numerada (menor primeiro) e, sem números, da esquerda para a direita", async () => {
      const make = (id: string, priorities: [number | undefined, number | undefined]) => sfcProject(id, [v("C1", "input", "BOOL"), v("C2", "input", "BOOL")], [
        step("S0", [], true), step("S1"), step("S2"),
      ], [tr("a", ["S0"], ["S1"], "C1", priorities[0]), tr("b", ["S0"], ["S2"], "C2", priorities[1])]);
      const numbered = await load(make("sfc-sel-num", [2, 1]));
      await numbered.force({ C1: true, C2: true });
      await client.step(30 * MS);
      assert(await numbered.active("S2") && !(await numbered.active("S1")) && !(await numbered.active("S0")), "prioridade 1 (para S2) vence");
      const leftToRight = await load(make("sfc-sel-lr", [undefined, undefined]));
      await leftToRight.force({ C1: true, C2: true });
      await client.step(30 * MS);
      assert(await leftToRight.active("S1") && !(await leftToRight.active("S2")), "sem números: a primeira da lista (esquerda) vence");
    });

    await test("Divergência e convergência simultâneas: ramos paralelos e sincronização", async () => {
      const plc = await load(sfcProject("sfc-par", [v("GO", "input", "BOOL"), v("TA", "input", "BOOL"), v("TB", "input", "BOOL")], [
        step("S0", [], true), step("A1"), step("A2"), step("B1"), step("B2"), step("S3"),
      ], [
        tr("fork", ["S0"], ["A1", "B1"], "GO"), tr("ta", ["A1"], ["A2"], "TA"), tr("tb", ["B1"], ["B2"], "TB"), tr("join", ["A2", "B2"], ["S3"], "TRUE"),
      ]));
      await plc.force({ GO: true, TA: false, TB: false });
      await client.step(30 * MS);
      assert(await plc.active("A1") && await plc.active("B1") && !(await plc.active("S0")), "os dois ramos ativos");
      await plc.force({ TA: true });
      await client.step(30 * MS);
      assert(await plc.active("A2") && await plc.active("B1") && !(await plc.active("S3")), "convergência espera o outro ramo");
      await plc.force({ TB: true });
      await client.step(30 * MS);
      assert(await plc.active("S3") && !(await plc.active("A2")) && !(await plc.active("B2")), "convergência: S3 ativo, ramos desativados");
    });

    await test("Ação em IL e ação em ST lendo PASSO.X; passo ativado e desativado no mesmo ciclo continua ativo", async () => {
      const plc = await load(sfcProject("sfc-code", [v("RUN", "input", "BOOL"), v("CNT", "output", "INT"), v("SEEN", "output", "BOOL")], [
        step("S0", [], true), step("LOOP", [["N", "COUNT_IL"], ["N", "WATCH"]]),
      ], [tr("go", ["S0"], ["LOOP"], "RUN"), tr("again", ["LOOP"], ["LOOP"], "RUN")], [
        { name: "COUNT_IL", language: "il", text: "LD CNT\nADD 1\nST CNT" },
        { name: "WATCH", language: "st", text: "SEEN := LOOP.X AND LOOP.T < T#1s;" },
      ]));
      await plc.force({ RUN: true });
      await client.step(200 * MS);
      const count = Number(await plc.get("CNT"));
      assert(count >= 17 && count <= 21, `ação IL rodou ${count} vezes em ~19 ciclos`);
      assert(await plc.on("SEEN"), "LOOP.T não reinicia (o passo nunca deixa de estar ativo) e continua < 1 s");
    });

    await test("Exemplo trm/plc/semaforo_sfc: 3 s vermelho, 4 s verde, 1 s amarelo; botão de pedestre encurta o verde (prioridade 1)", async () => {
      const example = JSON.parse(fs.readFileSync(path.resolve(extensionRoot, "..", "trm", "plc", "semaforo_sfc.iec.json"), "utf8")) as IecProjectAuthoring;
      const plc = await load(example);
      await plc.force({ BOTAO: false });
      const colors: string[] = [];
      for (let index = 0; index < 160; index += 1) {
        await client.step(50 * MS);
        colors.push((await plc.on("VERMELHO") ? "R" : "") + (await plc.on("AMARELO") ? "A" : "") + (await plc.on("VERDE") ? "G" : ""));
      }
      // Durações das fases (amostras de 50 ms), descartando a primeira (pode estar cortada).
      const runs: Array<[string, number]> = [];
      for (const color of colors) {
        const last = runs[runs.length - 1];
        if (last && last[0] === color) last[1] += 1; else runs.push([color, 1]);
      }
      const complete = runs.slice(1, -1);
      const lengths = (color: string) => complete.filter(([name]) => name === color).map(([, count]) => count * 50);
      assert(colors.every(color => color.length === 1), `uma lâmpada por vez: ${[...new Set(colors)].join(",")}`);
      assert(lengths("G").every(ms => Math.abs(ms - 4000) <= 60) && lengths("A").every(ms => Math.abs(ms - 1000) <= 60) &&
        lengths("R").every(ms => Math.abs(ms - 3000) <= 60), `fases: ${complete.map(([c, n]) => `${c}${n * 50}`).join(" ")}`);
      const cycles = Number(await plc.get("CICLOS"));
      // Botão: espera o verde acender e aperta; o verde dura ~1 s.
      while (!(await plc.on("VERDE"))) await client.step(50 * MS);
      await plc.force({ BOTAO: true });
      let green = 0;
      while (await plc.on("VERDE")) { await client.step(50 * MS); green += 50; }
      await plc.force({ BOTAO: false });
      assert(green >= 900 && green <= 1100, `verde com pedestre: ${green} ms`);
      assert(Number(await plc.get("CICLOS")) === cycles + 1, `CONTA (P1) somou um ciclo: ${cycles} -> ${await plc.get("CICLOS")}`);
    });

    await test("SFC com temporização IEC produz o mesmo estado e instante em step, headless, realtime e acelerado", async () => {
      const project = sfcProject("sfc-clock-modes", [v("Q", "output", "BOOL"), v("S0_TIME_MS", "output", "DINT")], [
        step("S0", [["N", "CAPTURE"]], true), step("S1", [["N", "LAMP"]]),
      ], [tr("elapsed", ["S0"], ["S1"], "S0.T >= T#100ms")], [
        { name: "CAPTURE", language: "st", text: "S0_TIME_MS := TIME_TO_MS(S0.T);" },
        { name: "LAMP", language: "st", text: "Q := TRUE;" },
      ]);

      const execute = async (mode: "step" | "headless" | "realtime" | "accelerated") => {
        const plc = await load(project);
        try {
          await client.setSimulationConfig({ realTimeRate: mode === "realtime" ? 1 : mode === "accelerated" ? 100 : 0 });
          if (mode === "step") {
            await client.step(200 * MS);
          } else {
            await client.run();
            const deadline = Date.now() + 5_000;
            let reached = false;
            while (Date.now() < deadline) {
              if (await plc.on("Q")) { reached = true; break; }
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert(reached, `SFC não atingiu S1 no modo ${mode}`);
            await client.pause();
          }
          return { q: await plc.get("Q"), transitionTimeMs: await plc.get("S0_TIME_MS") };
        } finally {
          await client.stopSimulation();
          await client.removeComponent(plc.instanceId);
        }
      };

      const stepResult = await execute("step");
      const headlessResult = await execute("headless");
      const realtimeResult = await execute("realtime");
      const acceleratedResult = await execute("accelerated");
      assert(stepResult.q === "TRUE" && stepResult.transitionTimeMs === "100",
        `step reportou ${JSON.stringify(stepResult)}`);
      assert(JSON.stringify(headlessResult) === JSON.stringify(stepResult), `headless divergiu: ${JSON.stringify(headlessResult)}`);
      assert(JSON.stringify(realtimeResult) === JSON.stringify(stepResult), `realtime divergiu: ${JSON.stringify(realtimeResult)}`);
      assert(JSON.stringify(acceleratedResult) === JSON.stringify(stepResult), `acelerado divergiu: ${JSON.stringify(acceleratedResult)}`);
    });

    await test("Erros pela norma: dois passos iniciais, L sem duração, ação inexistente, transição sem condição", async () => {
      const result = await buildIecProject(sfcProject("sfc-erros", [v("Q", "output", "BOOL")], [
        step("S0", [], true), step("S1", [["L", "Q"], ["N", "NADA"]], true),
      ], [tr("t", ["S0"], ["S1"], " ")]), options);
      assert(!result.ok, "devia falhar");
      if (result.ok) return;
      const text = result.diagnostics.map(item => `${item.elementLabel ?? ""}: ${item.message}`).join(" | ");
      for (const expected of [/exatamente um passo inicial/, /L exige uma duração/, /não declarada: NADA/, /transição S0 → S1: transição sem condição/]) {
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

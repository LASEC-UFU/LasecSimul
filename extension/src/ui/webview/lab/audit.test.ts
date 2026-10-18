import { assert as assertWithMessage, createTestRunner } from "../../../ipc/testSupport/MockCoreServer";
import { defaultCalculusLab, defaultFunctionsActivity, defaultTankActivity, validateCalculusLab, type CalculusLab } from "./activity";
import { labProjectInfo } from "./audit";

const assert = (condition: boolean, message = "falhou"): void => assertWithMessage(condition, message);
const { test, finish } = createTestRunner("Laboratório de Cálculo — atividades e auditoria de referências (M6)");

/** JSON com chaves ordenadas: compara conteúdo, não a ordem em que o validador monta os objetos. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v);
const tank = (id: string) => ({ id, typeId: "subcircuits.process.hydraulic_tank", label: `Tanque ${id}` });

void (async () => {
  await test("as atividades-modelo dos seis tipos validam e voltam iguais", () => {
    const lab = defaultCalculusLab();
    assert(lab.activities.map((a) => a.kind).join() === "functions,sensor,limits,axis,firstOrder,tank", lab.activities.map((a) => a.kind).join());
    assert(canonical(validateCalculusLab(JSON.parse(JSON.stringify(lab)))) === canonical(lab), "ida e volta pelo validador");
    assert(lab.activities.every((a) => a.steps.length > 0), "toda atividade-modelo traz etapas");
  });

  await test("validação recusa parâmetros fora da faixa, etapas inválidas e funções com parâmetro repetido", () => {
    const bad = (mutate: (lab: CalculusLab) => void): boolean => {
      const lab = structuredClone(defaultCalculusLab()) as CalculusLab;
      mutate(lab);
      try { validateCalculusLab(lab); return false; } catch { return true; }
    };
    assert(bad((lab) => { const t = lab.activities.find((a) => a.kind === "tank")!; if (t.kind === "tank") t.parameters.area = 5; }), "área fora da faixa");
    assert(bad((lab) => { lab.activities[0]!.steps.push({ id: "x", phase: "explore", prompt: "", hints: [] }); }), "etapa sem pergunta");
    assert(bad((lab) => { const f = lab.activities[0]!; if (f.kind === "functions") f.parameters.push({ ...f.parameters[0]! }); }), "parâmetro repetido");
    assert(bad((lab) => { const s = lab.activities.find((a) => a.kind === "sensor")!; if (s.kind === "sensor") { s.parameters.pmin = 150; s.parameters.pmax = 100; } }), "Pmax ≤ Pmin");
  });

  await test("auditoria: planta ausente, referência quebrada, ambiguidade e caso resolvido", () => {
    const lab: CalculusLab = { schemaVersion: 1, activities: [defaultFunctionsActivity(), defaultTankActivity()] };
    assert(labProjectInfo(lab, []).findings[0]?.code === "no-plant", "sem tanque no projeto");
    assert(labProjectInfo(lab, [tank("a")]).findings.length === 0, "uma instância: ligação implícita sem achado");
    const ambiguous = labProjectInfo(lab, [tank("a"), tank("b")]);
    assert(ambiguous.findings[0]?.code === "ambiguous-plant" && ambiguous.findings[0].candidates.length === 2, "duas instâncias");
    const broken: CalculusLab = { ...lab, activities: [defaultFunctionsActivity(), { ...defaultTankActivity(), plantComponentId: "removido" }] };
    const info = labProjectInfo(broken, [tank("a"), { id: "x", typeId: "passive.resistor", label: "R" }]);
    assert(info.findings[0]?.code === "missing-plant" && info.findings[0].severity === "error" && info.findings[0].candidates[0]?.id === "a", "referência quebrada com candidato para religar");
    assert(info.components.length === 1, "só componentes que servem de planta");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

import * as fs from "fs";
import * as path from "path";
import { assert, createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../../ipc/CoreProcess";
import { CoreClient } from "../../ipc/CoreClient";
import { loadBlockLibrary } from "../../catalog/blockLibraryLoader";
import { convertSimulinkFile } from "./SimulinkImporter";

/**
 * Modelo do Simulink importado e SIMULADO no Core real (docs/66): `tubulaoNL.slx` (tanque cilíndrico
 * horizontal) com l = 2 e R = 3 no Model Workspace (nível sempre abaixo do diâmetro 2R). Referência independente do engine: a equação do
 * próprio diagrama, h' = (Fi - F0) / (2 l sqrt(2 R h - h^2) + 0.001), integrada por RK4 com passo fino.
 *
 * Fora do `npm test` (precisa do Core compilado e do modelo do usuário):
 *   npx tsc -p ./tsconfig.test.json && node out-test/src/import/simulink/SimulinkImporter.realCore.test.js [lasecsimul-core.exe]
 */
const { test, finish } = createTestRunner("Importador Simulink (Core real)");
const extensionRoot = path.resolve(__dirname, "..", "..", "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const model = "C:/SourceCode/_audit_process_simul/assets/tubulaoNL.slx";
const executable = process.argv[2] ?? path.join(repoRoot, "core", "build-main", "Release", "lasecsimul-core.exe");
const MS = 1_000_000;
const l = 2, R = 3;

/** RK4 da equação do diagrama: Fi = degrau em 1 s, F0 = degrau em 20 s. */
function reference(tEnd: number): number {
  const derivative = (t: number, h: number) => {
    const fi = t >= 1 ? 1 : 0, f0 = t >= 20 ? 1 : 0;
    return (fi - f0) / (2 * l * Math.sqrt(2 * R * h - h * h) + 0.001);
  };
  let t = 0, h = 0;
  const dt = 1e-5;
  while (t < tEnd - 1e-12) {
    const step = Math.min(dt, tEnd - t);
    // Não atravessa as descontinuidades dos degraus dentro de um passo.
    const next = [1, 20].find((edge) => t < edge && t + step > edge);
    const s = next !== undefined ? next - t : step;
    const k1 = derivative(t, h), k2 = derivative(t + s / 2, h + (s / 2) * k1), k3 = derivative(t + s / 2, h + (s / 2) * k2), k4 = derivative(t + s, h + s * k3);
    h += (s / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    t += s;
  }
  return h;
}

(async () => {
  if (!fs.existsSync(model) || !fs.existsSync(executable)) {
    console.log(`modelo ou Core ausente (${model}, ${executable}): teste pulado`);
    return;
  }
  const { project } = await convertSimulinkFile(model, loadBlockLibrary(extensionRoot));
  const pipeName = `lasecsimul-simulink-${process.pid}`;
  const core = new CoreProcess({ executablePath: executable, pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 60_000 });
  core.start();
  try {
    await client.start();
    await test("tubulaoNL importado simula a equacao do tanque (l = 2, R = 3)", async () => {
      const errors = await client.setModelWorkspace([{ name: "l", value: String(l) }, { name: "R", value: String(R) }]);
      assert(errors.length === 0, `workspace: ${JSON.stringify(errors)}`);
      const ids = new Map<string, string>();
      for (const component of project.components) {
        const added = await client.addComponent(component.typeId, component.properties, [], component.label ?? component.id);
        ids.set(component.id, added.instanceId);
      }
      await client.applyWireTopologyTransaction(project.topology.conductors.map((wire) => ({
        kind: "connect" as const,
        from: { componentId: ids.get((wire.from as { componentId: string }).componentId)!, pinId: (wire.from as { pinId: string }).pinId },
        to: { componentId: ids.get((wire.to as { componentId: string }).componentId)!, pinId: (wire.to as { pinId: string }).pinId },
      })));
      const integrator = project.components.find((component) => component.label === "Integrator")!;
      const subscription = await client.subscribeSeries([{ instanceId: ids.get(integrator.id)!, port: "out1" }], { periodNs: 100 * MS });
      const samples = new Map<number, number>();
      let sinceSeq = 0, sinceEventSeq = 0;
      const drain = async () => {
        for (let guard = 0; guard < 1000; guard++) {
          const frame = await client.getTelemetryFrame({ items: [], probes: [], series: [{ subscriptionId: subscription, sinceSeq, sinceEventSeq, columns: 1 }] });
          const chunk = frame.series.find((item) => item.subscriptionId === subscription)!;
          chunk.tNs.forEach((t, i) => samples.set(t, chunk.columns[0]![i] ?? NaN));
          sinceSeq = chunk.toSeq; sinceEventSeq = chunk.nextEventSeq;
          if (!chunk.more) return;
        }
      };
      for (let second = 0; second < 25; second++) { await client.step(1000 * MS); await drain(); }
      let worst = 0;
      for (const t of [5, 10, 15, 19.9, 25]) {
        const simulated = samples.get(Math.round(t * 1000) * MS);
        const expected = reference(t);
        assert(simulated !== undefined, `amostra em t = ${t} s`);
        worst = Math.max(worst, Math.abs(simulated! - expected) / Math.max(1e-9, Math.abs(expected)));
        console.log(`  t = ${t} s: Core ${simulated} | RK4 de referencia ${expected}`);
      }
      assert(worst < 2e-3, `erro relativo maximo ${worst}`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    core.kill();
  }
  const result = finish();
  if (result.failed > 0) process.exitCode = 1;
})();

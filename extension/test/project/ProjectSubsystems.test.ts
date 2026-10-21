import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ProjectSerializer } from "../../src/project/ProjectSerializer";
import { createEmptyProject } from "../../src/project/ProjectTypes";

/** Persistência de subsistemas internos no `.lsproj` (tabela `subsystems`) e migrações de leitura. */
(async () => {
  const serializer = new ProjectSerializer();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lasecsimul-subsystems-"));
  const project = createEmptyProject();

  // `control.tank` (removido do Core, ADR 0013) dentro de uma planta incorporada e no topo do projeto.
  const tankPath = path.join(tmpDir, "legacy-tank.lsproj");
  const embeddedPlant = {
    schemaVersion: 3, typeId: "subcircuits.local.tanque", name: "Tanque",
    components: [
      { id: "tank", typeId: "control.tank", properties: { area: 1, initial: 1.5, samplePeriodNs: 10000000 } },
      { id: "wide", typeId: "control.tank", properties: { area: 2, initial: 0 } },
      { id: "gain", typeId: "control.gain", properties: { gain: 2 } },
    ],
    topology: { revision: 0, nodes: [], conductors: [{ id: "w1", from: { kind: "port", componentId: "gain", pinId: "out" }, to: { kind: "port", componentId: "tank", pinId: "in" }, vertices: [] }] },
    interface: [], exposedComponents: ["tank"],
  };
  await fs.writeFile(tankPath, JSON.stringify({
    ...project,
    components: [
      { id: "plant", typeId: "subcircuits.local.tanque", properties: {}, subcircuitRef: { path: "tanque.lssubcircuit", embedded: embeddedPlant } },
      { id: "top", typeId: "control.tank", properties: { initial: 3 } },
    ],
  }), "utf8");
  const tankLoaded = await serializer.load(tankPath);
  // A cópia por instância (formato anterior) vira definição interna da tabela; o tank migra lá dentro.
  assert.strictEqual(tankLoaded.components[0]!.typeId, "subsystem.local.tanque", "instância passa a usar a definição interna");
  assert.strictEqual(tankLoaded.components[0]!.subcircuitRef, undefined, "a instância não carrega mais a cópia");
  const migratedPlant = tankLoaded.subsystems!.find((definition) => definition.typeId === "subsystem.local.tanque") as unknown as typeof embeddedPlant & { origin?: { typeId?: string } };
  const plantComponents = migratedPlant.components;
  assert.deepStrictEqual(plantComponents[0], { id: "tank", typeId: "process.accumulator", properties: { initial: 1.5, samplePeriodNs: 10000000 } },
    "tank com area 1 vira o acumulador equivalente, preservando id e as demais propriedades");
  assert.deepStrictEqual(plantComponents[1], embeddedPlant.components[1], "tank com area != 1 não tem equivalente exato e fica intocado");
  assert.deepStrictEqual(plantComponents[2], { id: "gain", typeId: "sl.gain", properties: { Gain: "2", SampleTime: "0.1" } }, "outros blocos legados também são convertidos preservando o ID");
  assert.deepStrictEqual(migratedPlant.topology.conductors[0], { id: "w1", from: { kind: "port", componentId: "gain", pinId: "out1" }, to: { kind: "port", componentId: "tank", pinId: "in" }, vertices: [] }, "ligação mantém os IDs e remapeia a porta do ganho");
  assert.deepStrictEqual(migratedPlant.exposedComponents, ["tank"], "componentes expostos continuam apontando para o mesmo id");
  assert.strictEqual(migratedPlant.origin?.typeId, "subcircuits.local.tanque", "a origem da cópia antiga fica registrada");
  assert.strictEqual(tankLoaded.components[1]!.typeId, "process.accumulator", "tank no topo do projeto (area ausente = 1) também migra");
  assert.deepStrictEqual(tankLoaded.components[1]!.properties, { initial: 3 });

  // Tabela de subsistemas internos: ida e volta, instâncias independentes, hierarquia.
  const subsystemsPath = path.join(tmpDir, "subsystems.lsproj");
  const sensorDef = { schemaVersion: 3, typeId: "subsystem.sensor", name: "Sensor", components: [{ id: "g", typeId: "control.gain", properties: { gain: 2 } }], topology: { revision: 0, nodes: [], conductors: [] }, interface: [], exposedComponents: [], exportedPropertyComponentIds: [] };
  const plantaDef = { ...sensorDef, typeId: "subsystem.planta", name: "Planta", components: [{ id: "s1", typeId: "subsystem.sensor", properties: {} }] };
  const withTable = { ...createEmptyProject(), subsystems: [sensorDef, plantaDef], components: [
    { id: "p1", typeId: "subsystem.planta", properties: { k: 1 } },
    { id: "p2", typeId: "subsystem.planta", properties: { k: 2 } },
  ] };
  await serializer.save(subsystemsPath, withTable);
  const reopened = await serializer.load(subsystemsPath);
  assert.deepStrictEqual(reopened.subsystems!.map((definition) => definition.typeId), ["subsystem.sensor", "subsystem.planta"], "várias definições internas no mesmo .lsproj");
  assert.deepStrictEqual(reopened.components.map((component) => [component.typeId, component.properties]), [["subsystem.planta", { k: 1 }], ["subsystem.planta", { k: 2 }]], "duas instâncias da mesma definição com parâmetros próprios");
  assert.strictEqual((reopened.subsystems![1]!.components as Array<{ typeId: string }>)[0]!.typeId, "subsystem.sensor", "subsistema dentro de subsistema");

  const cyclePath = path.join(tmpDir, "cycle.lsproj");
  await fs.writeFile(cyclePath, JSON.stringify({ ...createEmptyProject(), subsystems: [
    { ...sensorDef, typeId: "subsystem.a", name: "A", components: [{ id: "b", typeId: "subsystem.b", properties: {} }] },
    { ...sensorDef, typeId: "subsystem.b", name: "B", components: [{ id: "a", typeId: "subsystem.a", properties: {} }] },
  ] }), "utf8");
  await assert.rejects(serializer.load(cyclePath), /referência recursiva entre definições: subsystem\.a → subsystem\.b → subsystem\.a/);
  const badTablePath = path.join(tmpDir, "bad-table.lsproj");
  await fs.writeFile(badTablePath, JSON.stringify({ ...createEmptyProject(), subsystems: [{ typeId: "subcircuits.x", name: "X" }] }), "utf8");
  await assert.rejects(serializer.load(badTablePath), /subsystems\[0\] precisa de typeId "subsystem\.\*"/);

  console.log("ProjectSubsystems: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

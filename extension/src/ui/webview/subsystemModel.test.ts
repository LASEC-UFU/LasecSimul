import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
  canonicalJson,
  duplicateSubsystemDefinition,
  exportSubsystemAsExternal,
  findSubsystemCycle,
  flattenExternalSystem,
  hoistEmbeddedSubsystems,
  importExternalAsSubsystem,
  importSubsystemDefinitions,
  mapComponentRefPaths,
  mapTableRefPaths,
  subsystemClosure,
  subsystemDependsOn,
  subsystemUsage,
  SubsystemDefinition,
} from "./subsystemModel";

const def = (typeId: string, name: string, children: string[] = [], extra: Record<string, unknown> = {}): SubsystemDefinition => ({
  schemaVersion: 3, typeId, name,
  components: [{ id: "g", typeId: "control.gain", properties: { gain: 2 } }, ...children.map((child, index) => ({ id: `c${index}`, typeId: child, properties: {} }))],
  topology: { revision: 0, nodes: [], conductors: [] }, interface: [], exposedComponents: [], exportedPropertyComponentIds: [], ...extra,
});

(async () => {
  const { test, finish } = createTestRunner("subsystemModel (definições internas x instâncias)");

  await test("fechamento transitivo põe dependências antes e detecta ciclos de definição", () => {
    const table = [def("subsystem.planta", "Planta", ["subsystem.sensor"]), def("subsystem.sensor", "Sensor"), def("subsystem.ctrl", "Controlador")];
    assert(subsystemClosure(["subsystem.planta"], table).map((entry) => entry.typeId).join(",") === "subsystem.sensor,subsystem.planta", "sensor antes da planta");
    assert(findSubsystemCycle(table) === undefined, "sem ciclo");
    assert(subsystemDependsOn(table, "subsystem.planta", "subsystem.sensor") && !subsystemDependsOn(table, "subsystem.sensor", "subsystem.planta"), "dependência transitiva");
    const cyclic = [def("subsystem.a", "A", ["subsystem.b"]), def("subsystem.b", "B", ["subsystem.a"])];
    assert(JSON.stringify(findSubsystemCycle(cyclic)) === JSON.stringify(["subsystem.a", "subsystem.b", "subsystem.a"]), `ciclo: ${JSON.stringify(findSubsystemCycle(cyclic))}`);
  });

  await test("colar no mesmo documento reaproveita a definição idêntica (mesma identidade)", () => {
    const table = [def("subsystem.sensor", "Sensor"), def("subsystem.planta", "Planta", ["subsystem.sensor"])];
    const result = importSubsystemDefinitions(table, structuredClone(table));
    assert(result.table.length === 2 && result.added.length === 0, "nada novo");
    assert(result.typeIdMap.get("subsystem.planta") === "subsystem.planta", "mapa identidade");
  });

  await test("colar em documento com definição homônima/de mesmo id e conteúdo diferente: nunca sobrescreve", () => {
    const target = [def("subsystem.sensor", "Sensor", [], { help: { description: "do destino" } })];
    const incoming = [def("subsystem.sensor", "Sensor"), def("subsystem.planta", "Planta", ["subsystem.sensor", "subsystem.sensor"])];
    const result = importSubsystemDefinitions(target, incoming);
    assert(canonicalJson(result.table[0]) === canonicalJson(target[0]), "a definição do destino ficou intacta");
    const sensor = result.typeIdMap.get("subsystem.sensor")!;
    assert(sensor === "subsystem.sensor_2", `sensor importado com id novo: ${sensor}`);
    const importedSensor = result.table.find((entry) => entry.typeId === sensor)!;
    assert(importedSensor.name === "Sensor (2)", `nome ajustado: ${importedSensor.name}`);
    const planta = result.table.find((entry) => entry.typeId === result.typeIdMap.get("subsystem.planta"))!;
    const childTypeIds = (planta.components ?? []).filter((component) => component.id !== "g").map((component) => component.typeId);
    assert(childTypeIds.every((typeId) => typeId === sensor), `as duas instâncias internas apontam para o MESMO sensor importado: ${JSON.stringify(childTypeIds)}`);
  });

  await test("migração de cópias incorporadas por instância: compartilha conteúdo igual, separa diferente, sobe aninhadas, idempotente", () => {
    const sensor = { schemaVersion: 3, typeId: "subcircuits.local.sensor", name: "Sensor", components: [{ id: "k", typeId: "control.gain", properties: { gain: 1 } }] };
    const planta = { schemaVersion: 3, typeId: "subcircuits.local.planta", name: "Planta", components: [{ id: "s", typeId: "subcircuits.local.sensor", subcircuitRef: { path: "sensor.lssubcircuit", embedded: sensor } }] };
    const components = [
      { id: "p1", typeId: "subcircuits.local.planta", properties: { x: 1 }, subcircuitRef: { path: "planta.lssubcircuit", embedded: planta } },
      { id: "p2", typeId: "subcircuits.local.planta", properties: { x: 2 }, subcircuitRef: { path: "planta.lssubcircuit", embedded: structuredClone(planta) } },
      { id: "p3", typeId: "subcircuits.local.planta", properties: {}, subcircuitRef: { path: "planta.lssubcircuit", embedded: { ...planta, help: { description: "variante" } } } },
    ];
    const result = hoistEmbeddedSubsystems(components, []);
    assert(result.components[0]!.typeId === "subsystem.local.planta" && result.components[1]!.typeId === "subsystem.local.planta", "p1 e p2 compartilham a definição");
    assert(result.components[2]!.typeId === "subsystem.local.planta_2", `p3 tem conteúdo diferente: ${result.components[2]!.typeId}`);
    assert(result.components.every((component) => !("subcircuitRef" in component)), "a cópia por instância sai das instâncias");
    assert(JSON.stringify(result.components.map((component) => component.properties)) === JSON.stringify([{ x: 1 }, { x: 2 }, {}]), "parâmetros por instância preservados");
    const plantaDef = result.table.find((entry) => entry.typeId === "subsystem.local.planta")!;
    assert(plantaDef.components?.[0]?.typeId === "subsystem.local.sensor" && plantaDef.origin?.typeId === "subcircuits.local.planta", "aninhada sobe para a tabela e a origem fica registrada");
    assert(result.table.filter((entry) => entry.typeId.startsWith("subsystem.local.sensor")).length === 1, "o sensor aninhado vira UMA definição");
    const again = hoistEmbeddedSubsystems(result.components, result.table);
    assert(again.migrated === 0 && canonicalJson(again.table) === canonicalJson(result.table), "idempotente");
  });

  await test("exportar leva as dependências internas; importar como cópia é independente do arquivo", () => {
    const table = [def("subsystem.sensor", "Sensor"), def("subsystem.planta", "Planta", ["subsystem.sensor"])];
    const exported = exportSubsystemAsExternal(table, "subsystem.planta", "subcircuits.planta")!;
    assert(exported.typeId === "subcircuits.planta", "typeId externo");
    assert(Array.isArray(exported.subsystems) && (exported.subsystems as SubsystemDefinition[]).map((entry) => entry.typeId).join(",") === "subsystem.sensor", "sensor incluído");
    const imported = importExternalAsSubsystem([def("subsystem.sensor", "Sensor", [], { help: { description: "outro" } })], exported, { file: "C:/x/planta.lssubcircuit" });
    const root = imported.table.find((entry) => entry.typeId === imported.typeId)!;
    assert(imported.typeId === "subsystem.planta" && root.origin?.typeId === "subcircuits.planta" && root.origin?.file === "C:/x/planta.lssubcircuit", `raiz importada: ${imported.typeId}`);
    assert(Boolean(root.components?.some((component) => component.typeId === "subsystem.sensor_2")), "o sensor do arquivo não se mistura com o sensor do destino");
    (exported.components as SubsystemDefinition["components"])![0]!.properties = { gain: 99 };
    assert(JSON.stringify(root.components?.[0]?.properties) === JSON.stringify({ gain: 2 }), "mudar o manifesto de origem não altera a cópia");
    const twice = importExternalAsSubsystem(imported.table, exportSubsystemAsExternal(table, "subsystem.planta", "subcircuits.planta")!, { reuseEquivalent: true });
    assert(twice.typeId === imported.typeId && twice.table.length === imported.table.length, "reuseEquivalent reaproveita a cópia idêntica");
    const explicit = importExternalAsSubsystem(imported.table, exportSubsystemAsExternal(table, "subsystem.planta", "subcircuits.planta")!);
    assert(explicit.typeId !== imported.typeId, "importação explícita cria cópia nova");
  });

  await test("sistema externo com subsistemas internos é registrado em espaço de nomes próprio", () => {
    const external = { schemaVersion: 3, typeId: "subcircuits.planta", name: "Planta", components: [{ id: "s", typeId: "subsystem.sensor" }], subsystems: [def("subsystem.sensor", "Sensor")] };
    const flat = flattenExternalSystem(external);
    assert(flat.definitions.length === 1 && flat.definitions[0]!.typeId === "subsystem.sensor@subcircuits.planta", "definição interna com namespace");
    assert((flat.main.components as Array<{ typeId: string }>)[0]!.typeId === "subsystem.sensor@subcircuits.planta" && !("subsystems" in flat.main), "principal reescrito sem a tabela");
  });

  await test("duplicar cria definição independente; uso conta instâncias e definições que a contêm", () => {
    const table = [def("subsystem.sensor", "Sensor"), def("subsystem.planta", "Planta", ["subsystem.sensor"])];
    const duplicated = duplicateSubsystemDefinition(table, "subsystem.sensor")!;
    assert(duplicated.typeId === "subsystem.sensor_copia" && duplicated.table.find((entry) => entry.typeId === duplicated.typeId)!.name === "Sensor (cópia)", `cópia: ${duplicated.typeId}`);
    const usage = subsystemUsage("subsystem.sensor", [{ id: "a", typeId: "subsystem.sensor" }, { id: "b", typeId: "control.gain" }], table);
    assert(JSON.stringify(usage) === JSON.stringify({ instanceIds: ["a"], containingDefinitions: ["subsystem.planta"] }), JSON.stringify(usage));
  });

  await test("caminhos de sistemas externos: componentes e definições mapeados; cópias incorporadas antigas intactas", () => {
    const toAbsolute = (refPath: string) => (refPath.startsWith("/") ? refPath : `/projeto/${refPath}`);
    const components = [
      { id: "x", typeId: "subcircuits.medidor", subcircuitRef: { path: "../lib/medidor.lssubcircuit" } },
      { id: "y", typeId: "subcircuits.velho", subcircuitRef: { path: "velho.lssubcircuit", embedded: { typeId: "subcircuits.velho" } } },
      { id: "z", typeId: "control.gain" },
    ];
    const mapped = mapComponentRefPaths(components, toAbsolute);
    assert(mapped[0]!.subcircuitRef!.path === "/projeto/../lib/medidor.lssubcircuit" && mapped[1] === components[1] && mapped[2] === components[2], JSON.stringify(mapped));
    const table = mapTableRefPaths([def("subsystem.planta", "Planta", [], { components: [components[0]] }), def("subsystem.vazio", "Vazio")], toAbsolute);
    assert(table[0]!.components![0]!.subcircuitRef!.path === "/projeto/../lib/medidor.lssubcircuit" && components[0]!.subcircuitRef!.path === "../lib/medidor.lssubcircuit", "tabela mapeada sem alterar a origem");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { voltageProbesForProject } from "./voltageTelemetry";

(async () => {
  const { test, finish } = createTestRunner("voltageTelemetry — seleção robusta do ponto de leitura");

  await test("prefere um endpoint consultável da mesma rede em vez da primeira fronteira inválida", () => {
    const conductors = [
      {
        id: "wire-a",
        from: { kind: "port" as const, componentId: "boundary", pinId: "G13" },
        to: { kind: "node" as const, nodeId: "junction" },
      },
      {
        id: "wire-b",
        from: { kind: "node" as const, nodeId: "junction" },
        to: { kind: "port" as const, componentId: "resistor", pinId: "pin-2" },
      },
      {
        id: "wire-c",
        from: { kind: "node" as const, nodeId: "junction" },
        to: { kind: "port" as const, componentId: "probe", pinId: "pin-1" },
      },
    ];
    const probes = voltageProbesForProject({ conductors }, (candidate) => candidate.componentId !== "boundary");
    assert(probes.length === 3, `esperadas três leituras, recebidas ${JSON.stringify(probes)}`);
    assert(probes.every((probe) => probe.componentId === "resistor" || probe.componentId === "probe"),
      `nenhum fio deveria usar a fronteira inválida: ${JSON.stringify(probes)}`);
    assert(new Set(probes.map((probe) => `${probe.componentId}:${probe.pinId}`)).size === 1,
      `todos os fios da mesma rede devem usar o mesmo nó: ${JSON.stringify(probes)}`);
  });

  await test("mantém compatibilidade e usa o primeiro endpoint quando não há filtro", () => {
    const probes = voltageProbesForProject({ conductors: [{
      id: "wire",
      from: { kind: "port" as const, componentId: "a", pinId: "1" },
      to: { kind: "port" as const, componentId: "b", pinId: "2" },
    }] });
    assert(probes.length === 1 && probes[0]?.componentId === "a", `resultado inesperado: ${JSON.stringify(probes)}`);
  });

  finish();
})();

import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
  buildPortDockIndex,
  connectionKindsCompatible,
  findMagneticDock,
  magneticDockRadius,
  orthogonalSegmentCrossesRect,
  orthogonalizeConnectionWaypoints,
  routeOrthogonalConnection,
} from "./connectionEngine";

(async () => {
  const { test, finish } = createTestRunner("connectionEngine — roteamento e docking");

  await test("raio magnético permanece estável em pixels de tela", () => {
    assert(magneticDockRadius(1) === 18, "zoom 1 deveria usar 18 unidades");
    assert(magneticDockRadius(2) === 9, "zoom 2 deveria compensar para 9 unidades");
    assert(magneticDockRadius(100) === 6, "zoom extremo deveria respeitar o mínimo");
    assert(magneticDockRadius(0.01) === 48, "zoom distante deveria respeitar o máximo");
  });

  await test("docking escolhe a porta compatível mais próxima e nunca o próprio componente", () => {
    const index = buildPortDockIndex([
      { ownerId: "source", portId: "other", point: { x: 10, y: 10 }, kind: "electrical" },
      { ownerId: "process", portId: "p", point: { x: 13, y: 10 }, kind: "process" },
      { ownerId: "target", portId: "in", point: { x: 16, y: 10 }, kind: "signal" },
    ]);
    const dock = findMagneticDock({ x: 10, y: 10 }, index, 18, { ownerId: "source", portId: "out", kind: "electrical" });
    assert(dock?.port.ownerId === "target", `esperado target compatível, recebido ${dock?.port.ownerId}`);
  });

  await test("famílias de conexão separam processo de sinal/elétrica", () => {
    assert(connectionKindsCompatible("electrical", "signal"), "sinal deve usar infraestrutura elétrica existente");
    assert(!connectionKindsCompatible("process", "signal"), "processo não pode conectar em sinal");
    assert(connectionKindsCompatible("process", "any"), "porta genérica deve aceitar processo");
  });

  await test("roteador automático contorna obstáculo e produz somente segmentos ortogonais", () => {
    const obstacle = { x: 80, y: -20, width: 40, height: 40 };
    const route = routeOrthogonalConnection(
      { x: 0, y: 0, direction: "right" },
      { x: 200, y: 0, direction: "left" },
      [obstacle]
    );
    assert(route.length >= 4, `desvio deveria ter curvas, recebido ${route.length} pontos`);
    for (let index = 0; index + 1 < route.length; index += 1) {
      const a = route[index]!;
      const b = route[index + 1]!;
      assert(a.x === b.x || a.y === b.y, `segmento ${index} ficou diagonal`);
      assert(!orthogonalSegmentCrossesRect(a, b, { x: 72, y: -28, width: 56, height: 56 }), `segmento ${index} atravessou obstáculo inflado`);
    }
  });

  await test("waypoints manuais são preservados e ortogonalizados", () => {
    const route = orthogonalizeConnectionWaypoints(
      [{ x: 0, y: 0 }, { x: 70, y: 40 }, { x: 120, y: 40 }],
      [{ x: 30, y: -10, width: 20, height: 30 }]
    );
    const waypointStillOnRoute = route.some((point, index) => {
      const next = route[index + 1];
      if (!next) return point.x === 70 && point.y === 40;
      return point.y === 40 && next.y === 40 && 70 >= Math.min(point.x, next.x) && 70 <= Math.max(point.x, next.x);
    });
    assert(waypointStillOnRoute, "rota deveria continuar passando pelo waypoint autorado");
    for (let index = 0; index + 1 < route.length; index += 1) {
      assert(route[index]!.x === route[index + 1]!.x || route[index]!.y === route[index + 1]!.y, "rota deveria ser ortogonal");
    }
  });

  await test("mesma entrada produz rota determinística", () => {
    const args = [
      { x: 0, y: 0, direction: "right" as const },
      { x: 240, y: 80, direction: "left" as const },
      [{ x: 90, y: -20, width: 60, height: 80 }],
    ] as const;
    const first = routeOrthogonalConnection(args[0], args[1], args[2]);
    const second = routeOrthogonalConnection(args[0], args[1], args[2]);
    assert(JSON.stringify(first) === JSON.stringify(second), "roteamento não pode oscilar sem mudança geométrica");
  });

  await test("cena densa não cai em rota de emergência através de obstáculo próximo", () => {
    const obstacles = [{ x: 80, y: -20, width: 40, height: 40 }];
    for (let index = 0; index < 210; index += 1) {
      obstacles.push({ x: 1200 + index * 7, y: 900 + index * 11, width: 20, height: 20 });
    }
    const route = routeOrthogonalConnection(
      { x: 0, y: 0, direction: "right" },
      { x: 200, y: 0, direction: "left" },
      obstacles
    );
    const nearInflated = { x: 72, y: -28, width: 56, height: 56 };
    for (let index = 0; index + 1 < route.length; index += 1) {
      assert(!orthogonalSegmentCrossesRect(route[index]!, route[index + 1]!, nearInflated),
        `rota densa atravessou obstáculo no segmento ${index}`);
    }
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

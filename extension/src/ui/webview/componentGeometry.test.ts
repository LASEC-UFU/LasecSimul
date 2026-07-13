import { localToScene, sceneToLocal, snapScenePoint, svgLocalTransform, transformedLocalBounds, transformLocalPoint } from "./componentGeometry.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

async function main(): Promise<void> {
  let passed = 0;
  const test = async (name: string, run: () => void): Promise<void> => {
    run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  console.log("\ncomponentGeometry — transform único de componente\n");

  await test("quatro rotações usam o mesmo pivô local", () => {
    const size = { width: 40, height: 20 };
    const expected = [{ x: 40, y: 10 }, { x: 20, y: 30 }, { x: 0, y: 10 }, { x: 20, y: -10 }];
    ([0, 90, 180, 270] as const).forEach((rotation, index) => {
      const actual = transformLocalPoint({ x: 40, y: 10 }, { size, rotation });
      assert(near(actual.x, expected[index]!.x) && near(actual.y, expected[index]!.y), `${rotation}°: ${JSON.stringify(actual)}`);
    });
  });

  await test("espelhamento acontece antes da rotação, como no renderer", () => {
    const actual = transformLocalPoint({ x: 0, y: 0 }, { size: { width: 40, height: 20 }, rotation: 90, flipH: true });
    assert(actual.x === 30 && actual.y === 30, `recebido ${JSON.stringify(actual)}`);
  });

  await test("localToScene e sceneToLocal são inversas", () => {
    const transform = { size: { width: 64, height: 32 }, position: { x: 100, y: 80 }, rotation: 270 as const, flipH: true, flipV: true, origin: { x: 8, y: 16 } };
    const local = { x: -4.5, y: 41.25 };
    const roundTrip = sceneToLocal(localToScene(local, transform), transform);
    assert(near(roundTrip.x, local.x) && near(roundTrip.y, local.y), `round-trip ${JSON.stringify(roundTrip)}`);
  });

  await test("bounding box transformada agrega os quatro cantos", () => {
    const bounds = transformedLocalBounds({ size: { width: 40, height: 20 }, rotation: 90, origin: { x: 0, y: 0 } });
    assert(bounds.x === -20 && bounds.y === 0 && bounds.width === 20 && bounds.height === 40, `bounds ${JSON.stringify(bounds)}`);
  });

  await test("SVG recebe exatamente a mesma ordem flip→rotate", () => {
    const svg = svgLocalTransform({ size: { width: 40, height: 20 }, rotation: 90, flipH: true, origin: { x: 8, y: 4 } });
    assert(svg === "translate(8 4) rotate(90) scale(-1 1) translate(-8 -4)", svg);
  });

  await test("snap ao grid só acontece no espaço de cena", () => {
    const snapped = snapScenePoint({ x: 14.1, y: -5.9 }, 4);
    assert(snapped.x === 16 && snapped.y === -4, JSON.stringify(snapped));
  });

  console.log(`\nResultado: ${passed} passaram, 0 falharam\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

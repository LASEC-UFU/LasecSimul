import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { compileSymbolAuthoringComponents, seedSymbolAuthoringComponents } from "./symbolAuthoring";
import { PackageDescriptor } from "../ui/webview/model";

(async () => {
  const { test, finish } = createTestRunner("symbolAuthoring — seed/compile entre package e componentes (Épico G, escrita)");

  await test("seed: package em branco gera só o componente other.package", () => {
    const pkg: PackageDescriptor = { width: 80, height: 60, border: true, pins: [] };
    const components = seedSymbolAuthoringComponents(pkg);
    assert(components.length === 1, `esperado 1 componente, recebido ${components.length}`);
    assert(components[0]!.typeId === "other.package", "único componente deveria ser other.package");
    assert(components[0]!.properties.width === 80 && components[0]!.properties.height === 60, "width/height deveriam vir do package");
  });

  await test("seed: rect/ellipse/line/text/pin geram um componente cada", () => {
    const pkg: PackageDescriptor = {
      width: 100,
      height: 80,
      border: true,
      shapes: [
        { kind: "rect", x: 10, y: 10, w: 20, h: 15 },
        { kind: "ellipse", cx: 50, cy: 40, rx: 8, ry: 6 },
        { kind: "line", x1: 0, y1: 0, x2: 20, y2: 0 },
        { kind: "text", x: 50, y: 50, value: "ESP32", fontSize: 11 },
      ],
      pins: [{ id: "GPIO2", x: 0, y: 20, angle: 180, length: 8, label: "G2" }],
    };
    const components = seedSymbolAuthoringComponents(pkg);
    assert(components.length === 6, `esperado 1 package + 4 shapes + 1 pin = 6, recebido ${components.length}`);
    const rect = components.find((c) => c.typeId === "graphics.rectangle");
    assert(Boolean(rect) && rect!.properties.width === 20 && rect!.properties.height === 15, "rect deveria preservar w/h");
    const pin = components.find((c) => c.typeId === "other.package_pin");
    assert(Boolean(pin) && pin!.properties.pinId === "GPIO2" && pin!.rotation === 180, "pino deveria preservar id e ângulo (180 já é cardinal)");
  });

  await test("seed: pino com âncora no CENTRO da caixa (ponto invariante sob rotação)", () => {
    const pkg: PackageDescriptor = { width: 60, height: 40, pins: [{ id: "p1", x: 0, y: 20, angle: 180, length: 8 }] };
    const components = seedSymbolAuthoringComponents(pkg, 0, 0);
    const pin = components.find((c) => c.typeId === "other.package_pin")!;
    const boxSide = Math.max(24, 8 * 2 + 16); // mesma fórmula de propertyDrivenBox
    assert(pin.x + boxSide / 2 === 0 && pin.y + boxSide / 2 === 20, `âncora deveria reconstruir pra {0,20} a partir do centro, recebido x+side/2=${pin.x + boxSide / 2}`);
  });

  await test("compile: sem nenhum other.package devolve erro, não lança exceção", () => {
    const result = compileSymbolAuthoringComponents([], undefined);
    assert(result.package === undefined, "não deveria compilar package nenhum");
    assert(typeof result.error === "string" && result.error.length > 0, "deveria ter mensagem de erro");
  });

  await test("compile: mais de um other.package devolve erro", () => {
    const pkg: PackageDescriptor = { width: 80, height: 60, pins: [] };
    const components = seedSymbolAuthoringComponents(pkg);
    components.push({ ...components[0]!, id: "outro-package" });
    const result = compileSymbolAuthoringComponents(components, undefined);
    assert(result.package === undefined && Boolean(result.error), "dois other.package deveria falhar");
  });

  await test("round-trip: seed então compile reproduz width/height/pino/forma sem perda", () => {
    const original: PackageDescriptor = {
      width: 100,
      height: 80,
      border: true,
      shapes: [{ kind: "rect", x: 10, y: 10, w: 20, h: 15, stroke: "#94a3b8", fill: "none", strokeWidth: 1 }],
      pins: [{ id: "GPIO2", x: 0, y: 20, angle: 180, length: 8, label: "G2" }],
    };
    const components = seedSymbolAuthoringComponents(original);
    const result = compileSymbolAuthoringComponents(components, undefined);
    assert(Boolean(result.package), "deveria compilar com sucesso");
    const compiled = result.package!;
    assert(compiled.width === original.width && compiled.height === original.height, "width/height deveriam sobreviver ao round-trip");
    assert(compiled.pins.length === 1 && compiled.pins[0]!.id === "GPIO2" && compiled.pins[0]!.angle === 180 && compiled.pins[0]!.length === 8, "pino deveria sobreviver ao round-trip");
    assert(compiled.shapes?.length === 1 && compiled.shapes[0]!.kind === "rect" && compiled.shapes[0]!.w === 20 && compiled.shapes[0]!.h === 15, "forma rect deveria sobreviver ao round-trip");
  });

  await test("compile: fundo color vem do componente other.package, svg/image existente é preservado se não houver backgroundColor", () => {
    const pkg: PackageDescriptor = { width: 80, height: 60, pins: [] };
    const components = seedSymbolAuthoringComponents(pkg);
    const existingSvgBackground = { kind: "svg" as const, data: "<svg></svg>" };
    const result = compileSymbolAuthoringComponents(components, existingSvgBackground);
    assert(result.package?.background?.kind === "svg", "fundo svg existente deveria ser preservado quando o componente não define backgroundColor");

    const withColor = components.map((c) => (c.typeId === "other.package" ? { ...c, properties: { ...c.properties, backgroundColor: "#112233" } } : c));
    const resultWithColor = compileSymbolAuthoringComponents(withColor, existingSvgBackground);
    assert(resultWithColor.package?.background?.kind === "color" && resultWithColor.package.background.value === "#112233", "backgroundColor explícito deveria sobrescrever o fundo svg existente");
  });

  finish();
})();

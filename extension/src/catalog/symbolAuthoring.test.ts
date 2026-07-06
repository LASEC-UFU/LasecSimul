import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import {
  compileSubcircuitInternalComponents,
  compileSymbolAuthoringComponents,
  InternalComponentSeed,
  InternalWireSeed,
  seedSubcircuitInternalComponents,
  seedSymbolAuthoringComponents,
} from "./symbolAuthoring";
import { PackageDescriptor, WebviewWireModel } from "../ui/webview/model";

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
    // 1 package + 4 shapes + 1 pino + 1 rótulo de pino (graphics.text vinculado, sempre semeado
    // junto -- ver seedPinLabelComponent) = 7.
    assert(components.length === 7, `esperado 1 package + 4 shapes + 1 pin + 1 rótulo = 7, recebido ${components.length}`);
    const rect = components.find((c) => c.typeId === "graphics.rectangle");
    assert(Boolean(rect) && rect!.properties.width === 20 && rect!.properties.height === 15, "rect deveria preservar w/h");
    const pin = components.find((c) => c.typeId === "other.package_pin");
    assert(Boolean(pin) && pin!.properties.pinId === "GPIO2" && pin!.rotation === 180, "pino deveria preservar id e ângulo (180 já é cardinal)");
    const decorativeTexts = components.filter((c) => c.typeId === "graphics.text" && !c.properties.linkedPinComponentId);
    assert(decorativeTexts.length === 1 && decorativeTexts[0]!.properties.text === "ESP32", "o graphics.text DECORATIVO (não vinculado) deveria ser só o do shape kind text original");
    const pinLabel = components.find((c) => c.typeId === "graphics.text" && c.properties.linkedPinComponentId === pin!.id);
    assert(Boolean(pinLabel) && pinLabel!.properties.text === "G2", "deveria existir um graphics.text vinculado ao pino com o texto do rótulo");
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
    assert(compiled.pins[0]!.label === "G2", "rótulo do pino deveria sobreviver ao round-trip (via graphics.text vinculado)");
    assert(compiled.shapes?.length === 1 && compiled.shapes[0]!.kind === "rect" && compiled.shapes[0]!.w === 20 && compiled.shapes[0]!.h === 15, "forma rect deveria sobreviver ao round-trip");
  });

  await test("round-trip: rótulo de pino arrastado pra posição própria (labelX/labelY) sobrevive", () => {
    const original: PackageDescriptor = {
      width: 100,
      height: 80,
      pins: [{ id: "GPIO2", x: 0, y: 20, angle: 180, length: 8, label: "G2", labelX: 50, labelY: 40 }],
    };
    const components = seedSymbolAuthoringComponents(original);
    const result = compileSymbolAuthoringComponents(components, undefined);
    assert(Boolean(result.package), "deveria compilar com sucesso");
    const pin = result.package!.pins[0]!;
    // Tolerância de 1 unidade -- `baseComponent` arredonda x/y pra inteiro ao semear (mesmo
    // comportamento de qualquer componente posicionado no canvas), então um `labelY` fracionário
    // como 40 perde um pouquinho de precisão no arredondamento, não é uma regressão real.
    assert(Math.abs((pin.labelX ?? 0) - 50) < 1 && Math.abs((pin.labelY ?? 0) - 40) < 1, `labelX/labelY deveriam sobreviver ao round-trip (posição arrastada pelo usuário, não a fórmula padrão), recebido {${pin.labelX},${pin.labelY}}`);
  });

  await test("seed/compile: cor do rótulo de pino vem de pinLabelColor e sobrevive quando editada no graphics.text vinculado", () => {
    const original: PackageDescriptor = {
      width: 100,
      height: 80,
      pinLabelColor: "#FAFAC8",
      pins: [{ id: "GPIO2", x: 0, y: 20, angle: 180, length: 8, label: "G2" }],
    };
    const components = seedSymbolAuthoringComponents(original);
    const pinLabel = components.find((c) => c.typeId === "graphics.text" && c.properties.linkedPinComponentId)!;
    assert(pinLabel.properties.color === "#FAFAC8", `seed deveria aplicar pinLabelColor no graphics.text vinculado, recebido ${pinLabel.properties.color}`);

    pinLabel.properties.color = "#00AAFF";
    const result = compileSymbolAuthoringComponents(components, undefined);
    assert(result.package?.pinLabelColor === "#00AAFF", `compile deveria devolver a cor editada do rótulo de pino, recebido ${result.package?.pinLabelColor}`);
  });

  await test("seed/compile: fontSize do rótulo de pino é preservado entre editor e package (labelFontSize)", () => {
    const original: PackageDescriptor = {
      width: 100,
      height: 80,
      border: true,
      pins: [{ id: "G2", x: 100, y: 24, angle: 0, length: 8, label: "G2", labelFontSize: 13 }],
      shapes: [],
    };
    const components = seedSymbolAuthoringComponents(original);
    const pinLabel = components.find((c) => c.typeId === "graphics.text" && c.properties.linkedPinComponentId)!;
    assert(pinLabel.properties.fontSize === 13, `seed deveria usar labelFontSize do package no rótulo vinculado, recebido ${pinLabel.properties.fontSize}`);

    pinLabel.properties.fontSize = 17;
    const result = compileSymbolAuthoringComponents(components, undefined);
    assert(result.package?.pins[0]?.labelFontSize === 17, `compile deveria persistir labelFontSize editado no package, recebido ${result.package?.pins[0]?.labelFontSize}`);
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

  // ── Circuito interno real ("Abrir Subcircuito", Board Mode) ────────────────────────────────────

  await test("seedSubcircuitInternalComponents: sem visual salvo, usa layout em grade padrão (nunca empilha tudo no mesmo ponto)", () => {
    const components: InternalComponentSeed[] = [
      { id: "mcu1", typeId: "espressif.esp32", properties: {} },
      { id: "gnd1", typeId: "other.ground", properties: {} },
    ];
    const { components: seeded } = seedSubcircuitInternalComponents(components, []);
    assert(seeded.length === 2, `esperado 2 componentes, recebido ${seeded.length}`);
    assert(seeded[0]!.x !== seeded[1]!.x || seeded[0]!.y !== seeded[1]!.y, "componentes sem visual salvo não deveriam empilhar na mesma posição");
    assert(seeded[0]!.boardX === undefined, "sem boardVisual salvo, boardX não deveria existir ainda");
  });

  await test("seed/compile do circuito interno: visual e boardVisual sobrevivem ao round-trip, independentes um do outro", () => {
    const components: InternalComponentSeed[] = [
      {
        id: "led1",
        typeId: "outputs.led",
        properties: { threshold: 2 },
        visual: { x: 500, y: 80, rotation: 90 },
        boardVisual: { x: 30, y: 40, rotation: 0 },
      },
    ];
    const wires: InternalWireSeed[] = [{ from: { componentId: "led1", pinId: "a" }, to: { componentId: "tunnel_X", pinId: "pin" }, points: [{ x: 1, y: 2 }] }];

    const seeded = seedSubcircuitInternalComponents(components, wires);
    assert(seeded.components[0]!.x === 500 && seeded.components[0]!.y === 80 && seeded.components[0]!.rotation === 90, "posição/rotação no CIRCUITO deveria vir de `visual`");
    assert(seeded.components[0]!.boardX === 30 && seeded.components[0]!.boardY === 40, "posição na PLACA deveria vir de `boardVisual`, independente de `visual`");
    assert(seeded.wires[0]!.points?.[0]?.x === 1, "roteamento do fio interno deveria sobreviver");

    const compiled = compileSubcircuitInternalComponents(seeded.components, seeded.wires);
    assert(compiled.components.length === 1 && compiled.components[0]!.id === "led1", "componente interno deveria sobreviver ao round-trip");
    assert(compiled.components[0]!.visual?.x === 500 && compiled.components[0]!.visual?.rotation === 90, "visual (circuito) deveria sobreviver ao round-trip");
    assert(compiled.components[0]!.boardVisual?.x === 30 && compiled.components[0]!.boardVisual?.y === 40, "boardVisual (placa) deveria sobreviver ao round-trip, sem se misturar com visual");
    assert(compiled.wires[0]!.points?.[0]?.x === 1, "roteamento do fio deveria sobreviver ao round-trip");
  });

  await test("compileSubcircuitInternalComponents: ignora componentes de autoria de símbolo (other.package/graphics.*/other.package_pin), só circuito interno real", () => {
    const pkg: PackageDescriptor = { width: 80, height: 60, pins: [{ id: "GPIO2", x: 0, y: 20, angle: 180, length: 8 }] };
    const symbolComponents = seedSymbolAuthoringComponents(pkg);
    const internalSeeded = seedSubcircuitInternalComponents([{ id: "gnd1", typeId: "other.ground", properties: {} }], []);
    const allSessionComponents = [...symbolComponents, ...internalSeeded.components];
    const wires: WebviewWireModel[] = [];

    const compiled = compileSubcircuitInternalComponents(allSessionComponents, wires);
    assert(compiled.components.length === 1 && compiled.components[0]!.typeId === "other.ground", `só o componente interno real deveria sobreviver, recebido ${compiled.components.map((c) => c.typeId).join(",")}`);
  });

  finish();
})();

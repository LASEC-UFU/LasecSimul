import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { PackageDescriptor, PackagePin } from "../ui/webview/model";
import { packagePinVisualEnd } from "../ui/webview/componentSymbols";
import { SYMBOL_PIN_TYPE_ID, compileSymbolScene, materializeSymbolScene } from "./subcircuitSymbolScene";

function makeIdFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

(async () => {
  const { test, finish } = createTestRunner("subcircuitSymbolScene - materialize/compile WYSIWYG do Modo Símbolo/Ícone");

  await test("materializeSymbolScene sem descriptor devolve cena vazia", () => {
    const elements = materializeSymbolScene(undefined, makeIdFactory("id"));
    assert(elements.length === 0, "descriptor ausente não deveria materializar nada");
  });

  await test("materializeSymbolScene materializa 1 pino + rótulo NUM SÓ objeto (nunca um graphics.text separado)", () => {
    const descriptor: PackageDescriptor = {
      width: 56, height: 40, border: true,
      pins: [{ id: "VCC", label: "VCC", x: 0, y: 12, angle: 180, length: 8 }],
    };
    const elements = materializeSymbolScene(descriptor, makeIdFactory("id"));
    assert(elements.length === 1, `esperado 1 elemento (só o pino), recebido ${elements.length}`);
    const pinEl = elements[0]!;
    assert(pinEl.typeId === SYMBOL_PIN_TYPE_ID, "pino deveria usar o typeId dedicado symbol.pin");
    assert(pinEl.properties.pinId === "VCC", "pino deveria carregar seu pinId");
    assert(pinEl.properties.labelText === "VCC", "pino deveria carregar seu PRÓPRIO rótulo, sem objeto separado");
  });

  await test("conversão rotation<->angle do pino bate com packagePinVisualEnd (mesma convenção preservada da autoria antiga)", () => {
    for (const angle of [0, 90, 180, 270]) {
      const descriptor: PackageDescriptor = { width: 56, height: 40, pins: [{ id: "P1", x: 0, y: 20, angle, length: 8, label: "P1" }] };
      const elements = materializeSymbolScene(descriptor, makeIdFactory("id"));
      const pinEl = elements[0]!;
      const expectedRotation = (180 - angle + 360) % 360;
      assert(pinEl.rotation === expectedRotation, `angle=${angle} deveria virar rotation=${expectedRotation}, recebido ${pinEl.rotation}`);

      const rad = (pinEl.rotation * Math.PI) / 180;
      const authoringVector = { x: 8 * Math.cos(rad), y: 8 * Math.sin(rad) };
      const realEnd = packagePinVisualEnd({ id: "P1", x: 0, y: 0, angle, length: 8 });
      assert(Math.abs(authoringVector.x - realEnd.x) < 1e-9 && Math.abs(authoringVector.y - realEnd.y) < 1e-9, `angle=${angle}: lead da autoria deveria bater com packagePinVisualEnd real`);
    }
  });

  await test("materializeSymbolScene materializa shapes reaproveitando typeIds GENÉRICOS do catálogo (nunca um typeId novo)", () => {
    const descriptor: PackageDescriptor = {
      width: 56, height: 40, pins: [],
      shapes: [
        { kind: "rect", x: 4, y: 4, w: 20, h: 10, stroke: "#111", fill: "#eee" },
        { kind: "ellipse", cx: 30, cy: 20, rx: 8, ry: 5 },
        { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0 },
        { kind: "image", x: 0, y: 0, w: 12, h: 12, href: "data:image/png;base64,QUJD" },
        { kind: "text", x: 25, y: 5, value: "Rev A", fontSize: 6 },
      ],
    };
    const elements = materializeSymbolScene(descriptor, makeIdFactory("id"));
    assert(elements.length === 5, `esperado 5 elementos, recebido ${elements.length}`);
    const typeIds = elements.map((e) => e.typeId).sort();
    assert(
      JSON.stringify(typeIds) === JSON.stringify(["graphics.ellipse", "graphics.image", "graphics.line", "graphics.rectangle", "graphics.text"]),
      `typeIds deveriam ser os genéricos já existentes, recebido: ${typeIds.join(",")}`
    );
  });

  await test("compileSymbolScene é o inverso EXATO de materializeSymbolScene pro round-trip de um pino (posição/ângulo/rótulo)", () => {
    const pin: PackagePin = { id: "GND", x: 40, y: 24, angle: 0, length: 8, label: "GND" };
    const descriptor: PackageDescriptor = { width: 56, height: 40, pins: [pin] };
    const elements = materializeSymbolScene(descriptor, makeIdFactory("id"));
    const compiled = compileSymbolScene(elements);
    assert(compiled.errors.length === 0, `não deveria ter erros: ${compiled.errors.join(" | ")}`);
    assert(compiled.pins.length === 1, "deveria compilar 1 pino");
    const compiledPin = compiled.pins[0]!;
    assert(compiledPin.id === "GND", "pinId deveria sobreviver ao round-trip");
    assert(Math.abs(Number(compiledPin.x) - 40) < 0.01 && Math.abs(Number(compiledPin.y) - 24) < 0.01, `posição deveria sobreviver ao round-trip, recebido (${compiledPin.x},${compiledPin.y})`);
    assert(compiledPin.angle === 0, `angle deveria sobreviver ao round-trip, recebido ${compiledPin.angle}`);
    assert(compiledPin.label === "GND", "label deveria sobreviver ao round-trip");
  });

  await test("compileSymbolScene detecta pinId duplicado como erro bloqueante", () => {
    const elements = materializeSymbolScene(
      { width: 56, height: 40, pins: [{ id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "A" }, { id: "P1", x: 40, y: 12, angle: 0, length: 8, label: "B" }] },
      makeIdFactory("id")
    );
    const compiled = compileSymbolScene(elements);
    assert(compiled.errors.some((e) => e.includes("duplicado")), `esperava erro de pinId duplicado, recebido: ${compiled.errors.join(" | ")}`);
  });

  await test("compileSymbolScene ignora (warning, não erro) pino sem pinId", () => {
    const elements = materializeSymbolScene({ width: 56, height: 40, pins: [{ id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "A" }] }, makeIdFactory("id"));
    elements[0]!.properties.pinId = "";
    const compiled = compileSymbolScene(elements);
    assert(compiled.errors.length === 0, "pino sem pinId não deveria bloquear o save");
    assert(compiled.warnings.length === 1, "deveria gerar 1 warning");
    assert(compiled.pins.length === 0, "pino sem pinId não deveria entrar no compilado");
  });

  await test("round-trip materialize -> compile de shapes preserva posição/estilo/ordem (z-order)", () => {
    const descriptor: PackageDescriptor = {
      width: 56, height: 40, pins: [],
      shapes: [
        { kind: "rect", x: 4, y: 4, w: 20, h: 10, stroke: "#111", fill: "#eee", strokeWidth: 2 },
        { kind: "text", x: 25, y: 5, value: "Rev A", fontSize: 6, color: "#444" },
      ],
    };
    const elements = materializeSymbolScene(descriptor, makeIdFactory("id"));
    const compiled = compileSymbolScene(elements);
    assert(compiled.errors.length === 0, `não deveria ter erros: ${compiled.errors.join(" | ")}`);
    assert(compiled.shapes.length === 2, `esperado 2 shapes compilados, recebido ${compiled.shapes.length}`);
    const rect = compiled.shapes[0]!;
    assert(rect.kind === "rect" && Math.abs(rect.x! - 4) < 0.01 && Math.abs(rect.y! - 4) < 0.01 && rect.w === 20 && rect.h === 10, `retângulo deveria preservar posição/tamanho, recebido ${JSON.stringify(rect)}`);
    assert(rect.stroke === "#111" && rect.fill === "#eee" && rect.strokeWidth === 2, "retângulo deveria preservar estilo");
    const text = compiled.shapes[1]!;
    assert(text.kind === "text" && text.value === "Rev A" && text.color === "#444", "texto deveria preservar valor/cor");
  });

  await test("reordenar shapes (z-order) muda a ordem compilada", () => {
    const descriptor: PackageDescriptor = {
      width: 56, height: 40, pins: [],
      shapes: [
        { kind: "rect", x: 0, y: 0, w: 8, h: 8 },
        { kind: "ellipse", cx: 20, cy: 20, rx: 4, ry: 4 },
      ],
    };
    const elements = materializeSymbolScene(descriptor, makeIdFactory("id"));
    // Troca a ordem: elemento que era 2º (order=1) passa a ser 1º (order=0), e vice-versa.
    const rectEl = elements.find((e) => e.typeId === "graphics.rectangle")!;
    const ellipseEl = elements.find((e) => e.typeId === "graphics.ellipse")!;
    rectEl.properties.__symbolShapeOrder = 1;
    ellipseEl.properties.__symbolShapeOrder = 0;
    const compiled = compileSymbolScene(elements);
    assert(compiled.shapes[0]!.kind === "ellipse", "após reordenar, a elipse (order=0) deveria vir primeiro no compilado");
    assert(compiled.shapes[1]!.kind === "rect", "o retângulo (order=1) deveria vir depois");
  });

  await test("materialize -> compile -> materialize é idempotente (posição/rótulo estáveis entre save/reload)", () => {
    const descriptor: PackageDescriptor = { width: 56, height: 40, pins: [{ id: "VCC", label: "VCC", x: 10, y: 12, angle: 180, length: 8 }] };
    const elements1 = materializeSymbolScene(descriptor, makeIdFactory("seed1"));
    const compiled1 = compileSymbolScene(elements1);
    assert(compiled1.errors.length === 0, `não deveria ter erros: ${compiled1.errors.join(" | ")}`);

    const descriptor2: PackageDescriptor = { ...descriptor, pins: compiled1.pins };
    const elements2 = materializeSymbolScene(descriptor2, makeIdFactory("seed2"));
    const compiled2 = compileSymbolScene(elements2);
    assert(compiled2.errors.length === 0, `não deveria ter erros na 2ª rodada: ${compiled2.errors.join(" | ")}`);

    const p1 = compiled1.pins[0]!;
    const p2 = compiled2.pins[0]!;
    assert(Math.abs(Number(p1.x) - Number(p2.x)) < 0.01 && Math.abs(Number(p1.y) - Number(p2.y)) < 0.01, `posição deveria ser estável entre save/reload, recebido (${p1.x},${p1.y}) vs (${p2.x},${p2.y})`);
    assert(p1.label === p2.label, "rótulo deveria ser estável entre save/reload");
  });

  finish();
})();

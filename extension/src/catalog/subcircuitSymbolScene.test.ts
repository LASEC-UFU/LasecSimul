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
    assert(pinEl.label === "VCC", "pino deveria carregar seu PRÓPRIO rótulo (component.label), sem objeto separado");
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

  await test("posição de rótulo ARRASTADA (arquivo com labelX/labelY explícitos) sobrevive ao round-trip via __ui_idLabelX/Y (mesmo contrato de main.ts::externalLabelOffset)", () => {
    const pin: PackagePin = { id: "VCC", x: 0, y: 12, angle: 180, length: 8, label: "VCC", labelX: 999, labelY: 888, labelRotation: 90, labelColor: "#e11d48" };
    const descriptor: PackageDescriptor = { width: 56, height: 40, pins: [pin] };
    const elements = materializeSymbolScene(descriptor, makeIdFactory("id"));
    const pinEl = elements[0]!;
    // __ui_idLabelX/Y são um DELTA relativo a component.x/y (contrato com main.ts), não a posição
    // absoluta do arquivo -- verifica que a soma bate com o labelX/Y original.
    assert(typeof pinEl.properties.__ui_idLabelX === "number" && typeof pinEl.properties.__ui_idLabelY === "number", "pino com labelX/Y explícitos deveria gravar __ui_idLabelX/Y");
    assert(Math.abs((pinEl.x + (pinEl.properties.__ui_idLabelX as number)) - 999) < 0.01, "componentX + delta deveria bater com labelX absoluto original");
    assert(Math.abs((pinEl.y + (pinEl.properties.__ui_idLabelY as number)) - 888) < 0.01, "componentY + delta deveria bater com labelY absoluto original");
    assert(pinEl.properties.__ui_idLabelRotation === 90, "labelRotation deveria sobreviver como __ui_idLabelRotation");
    assert(pinEl.properties.__ui_idLabelColor === "#e11d48", "labelColor customizado deveria sobreviver como __ui_idLabelColor");

    const compiled = compileSymbolScene(elements);
    assert(compiled.errors.length === 0, `não deveria ter erros: ${compiled.errors.join(" | ")}`);
    const compiledPin = compiled.pins[0]!;
    assert(Math.abs((compiledPin.labelX as number) - 999) < 0.01, `labelX deveria sobreviver ao round-trip, recebido ${compiledPin.labelX}`);
    assert(Math.abs((compiledPin.labelY as number) - 888) < 0.01, `labelY deveria sobreviver ao round-trip, recebido ${compiledPin.labelY}`);
    assert(compiledPin.labelRotation === 90, "labelRotation deveria sobreviver ao round-trip");
    assert(compiledPin.labelColor === "#e11d48", "labelColor deveria sobreviver ao round-trip");
  });

  await test("pino SEM labelX/Y explícitos no arquivo nunca grava __ui_idLabelX/Y cravado (deixa main.ts calcular o padrão)", () => {
    const pin: PackagePin = { id: "VCC", x: 0, y: 12, angle: 180, length: 8, label: "VCC" };
    const elements = materializeSymbolScene({ width: 56, height: 40, pins: [pin] }, makeIdFactory("id"));
    const pinEl = elements[0]!;
    assert(pinEl.properties.__ui_idLabelX === undefined && pinEl.properties.__ui_idLabelY === undefined, "sem posição explícita no arquivo, não deveria gravar nenhum __ui_idLabelX/Y");
    const compiled = compileSymbolScene(elements);
    assert(compiled.pins[0]!.labelX === undefined && compiled.pins[0]!.labelY === undefined, "sem arrastar o rótulo, compilar não deveria inventar labelX/Y no arquivo");
  });

  await test("labelFontSize: customizado sobrevive ao round-trip, default (7) nunca é gravado no arquivo", () => {
    const customized: PackagePin = { id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1", labelFontSize: 14 };
    const elementsCustom = materializeSymbolScene({ width: 56, height: 40, pins: [customized] }, makeIdFactory("id"));
    assert(elementsCustom[0]!.properties.labelFontSize === 14, "labelFontSize customizado deveria virar properties.labelFontSize");
    const compiledCustom = compileSymbolScene(elementsCustom);
    assert(compiledCustom.pins[0]!.labelFontSize === 14, "labelFontSize customizado deveria sobreviver ao round-trip");

    const defaulted: PackagePin = { id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1" };
    const elementsDefault = materializeSymbolScene({ width: 56, height: 40, pins: [defaulted] }, makeIdFactory("id"));
    assert(elementsDefault[0]!.properties.labelFontSize === undefined, "sem labelFontSize no arquivo, não deveria gravar a propriedade (default 7 implícito)");
    const compiledDefault = compileSymbolScene(elementsDefault);
    assert(compiledDefault.pins[0]!.labelFontSize === 7, `sem customização, compilar deveria usar o default 7, recebido ${compiledDefault.pins[0]!.labelFontSize}`);
  });

  // ── Bug real corrigido (2026-07-18): compileSymbolScene gravava "middle" INCONDICIONALMENTE pra
  // todo pino, derrubando o default inteligente por ângulo de packagePinLeadSvg pra sempre. Agora só
  // grava quando o autor customizou de verdade (via symbolPinLabelPackageFields). ──────────────────
  await test("alinhamento: pino com labelTextAnchor explícito no arquivo materializa __ui_idLabelAlign e sobrevive ao round-trip", () => {
    const pin: PackagePin = { id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1", labelTextAnchor: "end" };
    const elements = materializeSymbolScene({ width: 56, height: 40, pins: [pin] }, makeIdFactory("id"));
    assert(elements[0]!.properties.__ui_idLabelAlign === "end", `esperado __ui_idLabelAlign==="end", recebido ${JSON.stringify(elements[0]!.properties)}`);
    const compiled = compileSymbolScene(elements);
    assert(compiled.pins[0]!.labelTextAnchor === "end", `alinhamento deveria sobreviver ao round-trip, recebido ${compiled.pins[0]!.labelTextAnchor}`);
    assert(compiled.pins[0]!.labelDominantBaseline === "middle", "labelDominantBaseline deveria acompanhar o alinhamento customizado");
  });

  await test("alinhamento: pino SEM labelTextAnchor no arquivo nunca grava __ui_idLabelAlign nem inventa um valor ao compilar (deixa o default por ângulo valer)", () => {
    const pin: PackagePin = { id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1" };
    const elements = materializeSymbolScene({ width: 56, height: 40, pins: [pin] }, makeIdFactory("id"));
    assert(elements[0]!.properties.__ui_idLabelAlign === undefined, "sem labelTextAnchor no arquivo, não deveria gravar __ui_idLabelAlign");
    const compiled = compileSymbolScene(elements);
    assert(compiled.pins[0]!.labelTextAnchor === undefined, `sem customização, compilar NÃO deveria forçar um valor -- este é o bug original (hardcode incondicional "middle"), recebido ${compiled.pins[0]!.labelTextAnchor}`);
  });

  // ── Bug real corrigido (2026-07-18): não existia jeito de ocultar o rótulo de um pino em Modo
  // Símbolo -- `showId` nunca era lido/escrito por materializeSymbolPin/compileSymbolScene. ────────
  await test("visibilidade: pino com labelHidden:true materializa showId:false e sobrevive ao round-trip", () => {
    const pin: PackagePin = { id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1", labelHidden: true };
    const elements = materializeSymbolScene({ width: 56, height: 40, pins: [pin] }, makeIdFactory("id"));
    assert(elements[0]!.showId === false, `esperado showId===false, recebido ${elements[0]!.showId}`);
    const compiled = compileSymbolScene(elements);
    assert(compiled.pins[0]!.labelHidden === true, `labelHidden deveria sobreviver ao round-trip, recebido ${compiled.pins[0]!.labelHidden}`);
  });

  await test("visibilidade: pino sem labelHidden no arquivo nunca força showId, e compilar showId ausente/true nunca grava labelHidden", () => {
    const pin: PackagePin = { id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1" };
    const elements = materializeSymbolScene({ width: 56, height: 40, pins: [pin] }, makeIdFactory("id"));
    assert(elements[0]!.showId === undefined, `sem labelHidden no arquivo, showId não deveria ser forçado, recebido ${elements[0]!.showId}`);
    const compiled = compileSymbolScene(elements);
    assert(compiled.pins[0]!.labelHidden === undefined, `sem ocultar, compilar não deveria gravar labelHidden, recebido ${compiled.pins[0]!.labelHidden}`);
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

  await test("materialize -> compile -> materialize é idempotente (posição/rótulo/fonte/alinhamento/visibilidade estáveis entre save/reload)", () => {
    const descriptor: PackageDescriptor = {
      width: 56, height: 40,
      pins: [{ id: "VCC", label: "VCC", x: 10, y: 12, angle: 180, length: 8, labelFontSize: 14, labelTextAnchor: "end", labelHidden: true }],
    };
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
    assert(p1.labelFontSize === p2.labelFontSize && p2.labelFontSize === 14, `labelFontSize deveria ser estável, recebido ${p1.labelFontSize} vs ${p2.labelFontSize}`);
    assert(p1.labelTextAnchor === p2.labelTextAnchor && p2.labelTextAnchor === "end", `labelTextAnchor deveria ser estável, recebido ${p1.labelTextAnchor} vs ${p2.labelTextAnchor}`);
    assert(p1.labelHidden === p2.labelHidden && p2.labelHidden === true, `labelHidden deveria ser estável, recebido ${p1.labelHidden} vs ${p2.labelHidden}`);
  });

  finish();
})();

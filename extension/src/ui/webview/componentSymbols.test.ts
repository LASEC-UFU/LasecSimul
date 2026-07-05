import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import fs from "node:fs";
import path from "node:path";
import { componentBox, componentSymbolSvg, hasRealPinPosition, pinLocalPosition, packageSymbolSvg, registerPackage } from "./componentSymbols";
import { PackageDescriptor } from "./model";

(async () => {
  const { test, finish } = createTestRunner("componentSymbols — package real (Épico G)");

  const pkg: PackageDescriptor = {
    width: 60,
    height: 40,
    border: true,
    pins: [
      { id: "out", x: 60, y: 20, angle: 0, length: 8, label: "OUT" },
      { id: "vcc", x: 0, y: 10, angle: 180, length: 8, label: "VCC" },
      { id: "gnd", x: 0, y: 30, angle: 180, length: 8, label: "GND" },
    ],
  };

  function catalogPackage(typeId: string): PackageDescriptor {
    const candidates = [
      path.resolve(process.cwd(), "..", "project", "schema", "component-catalog.json"),
      path.resolve(process.cwd(), "project", "schema", "component-catalog.json"),
    ];
    const catalogPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!catalogPath) throw new Error("component-catalog.json nao localizado para teste de renderer");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as { items?: Array<{ typeId?: string; package?: PackageDescriptor }> };
    const item = catalog.items?.find((entry) => entry.typeId === typeId);
    if (!item?.package) throw new Error(`package nao localizado no catalogo para ${typeId}`);
    registerPackage(typeId, item.package);
    return item.package;
  }

  await test("sem package registrado, componentBox cai pro algoritmo genérico (fallback)", () => {
    registerPackage("test.example", undefined);
    const box = componentBox("test.example");
    assert(box.width === 70 && box.height === 40, `esperado box genérico, recebido {${box.width},${box.height}}`);
  });

  await test("other.ground replica sources/ground.cpp: caixa, pino no topo do lead e barras com stroke 2.5", () => {
    const box = componentBox("other.ground");
    assert(box.width === 16 && box.height === 18, `Ground deveria usar caixa compacta 16x18, recebido {${box.width},${box.height}}`);
    const pin = pinLocalPosition("pin", 0, 1, "other.ground");
    assert(pin.x === 8 && pin.y === 0, `pino eletrico do Ground deveria ficar no topo do lead (8,0), recebido {${pin.x},${pin.y}}`);
    const svg = componentSymbolSvg("other.ground");
    assert(svg.includes('x1="1.4" y1="8" x2="14.6" y2="8"'), `barra superior do Ground deveria vir de ground.cpp, markup: ${svg}`);
    assert(svg.includes('stroke-width="2.5"'), `barras do Ground deveriam usar pen 2.5 como no SimulIDE, markup: ${svg}`);
  });

  await test("sources.fixed_volt vem do renderer package.simulidePaint, com botao proxy e lead ate o IoPin real", () => {
    catalogPackage("sources.fixed_volt");
    const box = componentBox("sources.fixed_volt");
    assert(box.width === 48 && box.height === 16, `FixedVolt deveria incluir botao 16x16 + corpo 16x16 + pino, recebido {${box.width},${box.height}}`);
    const pin = pinLocalPosition("pin", 0, 1, "sources.fixed_volt");
    assert(pin.x === 48 && pin.y === 8, `pino eletrico do FixedVolt deveria ficar em (48,8), recebido {${pin.x},${pin.y}}`);
    const svgOn = packageSymbolSvg("sources.fixed_volt", { out: true }, "fixed-render") ?? "";
    assert(svgOn.includes('x1="40" y1="8" x2="48" y2="8"'), `FixedVolt deveria desenhar lead ate o pino, markup: ${svgOn}`);
    assert(svgOn.includes('fill="#ffa600"'), `FixedVolt ligado deveria ficar laranja por properties.out, markup: ${svgOn}`);
    assert(svgOn.includes('fill="#dddddd"'), `FixedVolt deveria desenhar botao cinza no schematic, markup: ${svgOn}`);
    const svgOff = packageSymbolSvg("sources.fixed_volt", { out: false }, "fixed-render-off") ?? "";
    assert(svgOff.includes('fill="#e6e6ff"'), `FixedVolt desligado deveria ficar lavanda por properties.out=false, markup: ${svgOff}`);
  });

  await test("sources.clock e sources.wave_gen vem do renderer package.simulidePaint com botao proxy", () => {
    catalogPackage("sources.clock");
    catalogPackage("sources.wave_gen");
    const clockBox = componentBox("sources.clock");
    const waveBox = componentBox("sources.wave_gen");
    assert(clockBox.width === 48 && clockBox.height === 16, `Clock deveria incluir botao, recebido {${clockBox.width},${clockBox.height}}`);
    assert(waveBox.width === 48 && waveBox.height === 16, `WaveGen deveria incluir botao, recebido {${waveBox.width},${waveBox.height}}`);
    const clockSvg = packageSymbolSvg("sources.clock", { running: false }, "clock-render") ?? "";
    const waveSvg = packageSymbolSvg("sources.wave_gen", { running: false, bipolar: false }, "wave-render") ?? "";
    assert(clockSvg.includes('fill="#dddddd"'), `Clock deveria desenhar botao cinza, markup: ${clockSvg}`);
    assert(waveSvg.includes('fill="#dddddd"'), `WaveGen deveria desenhar botao cinza, markup: ${waveSvg}`);
    assert(clockSvg.includes('x1="40" y1="8" x2="48" y2="8"'), `Clock deveria manter lead de saida, markup: ${clockSvg}`);
    assert(waveSvg.includes('x1="40" y1="8" x2="48" y2="8"'), `WaveGen deveria manter lead de saida, markup: ${waveSvg}`);
  });

  await test("sources.battery vem do renderer package.simulidePaint com filamentos horizontais", () => {
    catalogPackage("sources.battery");
    const svg = packageSymbolSvg("sources.battery", {}, "battery-render") ?? "";
    assert(svg.includes('x1="0" y1="10" x2="9" y2="10"'), `Battery deveria desenhar filamento esquerdo ate a primeira placa, markup: ${svg}`);
    assert(svg.includes('x1="24" y1="10" x2="32" y2="10"'), `Battery deveria desenhar filamento direito depois da ultima placa, markup: ${svg}`);
  });

  await test("sources.controlled_source trata sinais +/- como labels de Pin do SimulIDE e corpo sem fill branco", () => {
    const controlledPkg = catalogPackage("sources.controlled_source");
    assert(!controlledPkg.simulidePaint?.primitives.some((primitive) => primitive.kind === "text"), "Csource nao deveria carregar +/- como primitive text; no SimulIDE eles sao labels dos Pins");
    assert(!controlledPkg.simulidePaint?.primitives.some((primitive) => primitive.kind === "line" && primitive.strokeWidth === 3), "Csource nao deveria carregar leads de Pin como primitive paint; no SimulIDE eles sao Pin::paint()");
    const svg = packageSymbolSvg("sources.controlled_source", { controlPins: true, currSource: true, currControl: false }, "csource-render") ?? "";
    assert(!svg.includes('fill="#ffffff"'), `Csource nao deveria preencher o corpo interno de branco, markup: ${svg}`);
    assert(svg.includes('x1="0.0" y1="12.0" x2="7.3" y2="12.0"'), `lead esquerdo superior deveria seguir Pin::paint() com m_length-0.7, markup: ${svg}`);
    assert(svg.includes('x1="24.0" y1="0.0" x2="24.0" y2="7.3"'), `lead superior deveria seguir Pin::paint() com origem no terminal eletrico, markup: ${svg}`);
    assert(svg.includes('x="9.7" y="6.0" text-anchor="start" dominant-baseline="hanging" fill="#ff0000" style="font-size:9px">+</text>'), `label + deveria vir do pino cp como label de Pin do SimulIDE, markup: ${svg}`);
    assert(svg.includes('x="9.7" y="22.0" text-anchor="start" dominant-baseline="hanging" fill="#000000" style="font-size:9px">–</text>'), `label - deveria vir do pino cm como label de Pin do SimulIDE, markup: ${svg}`);
    assert(svg.includes('x="8" y="4" width="32" height="32"'), `m_area deve comecar em x=8 apos traduzir bounds -24..24, deixando labels fora da moldura, markup: ${svg}`);

    const currentControlledSvg = packageSymbolSvg("sources.controlled_source", { controlPins: true, currSource: true, currControl: true }, "csource-current-render") ?? "";
    assert(!currentControlledSvg.includes(">+</text>") && !currentControlledSvg.includes(">–</text>"), `CurrControl=true deveria limpar labels dos pinos como Csource::updateStep(), markup: ${currentControlledSvg}`);
  });

  await test("com package registrado, componentBox usa o layout resolvido (com folga pra leads)", () => {
    registerPackage("test.example", pkg);
    const box = componentBox("test.example");
    // leads de 8px nos dois lados (vcc/gnd à esquerda, out à direita) -- largura cresce 8 pra cada lado
    assert(box.width === 76, `esperado largura 76 (60 + 8 esquerda + 8 direita), recebido ${box.width}`);
    assert(box.height === 40, `altura não deveria mudar (nenhum lead vertical), recebido ${box.height}`);
  });

  await test("package registrado para typeId ABI/subcircuito novo não precisa de case hardcoded", () => {
    const abiPkg: PackageDescriptor = {
      width: 11,
      height: 22,
      schematicWidth: 11 * 8,
      schematicHeight: 22 * 8,
      pins: [{ id: "GPIO0", x: 11, y: 10, angle: 0, length: 8, label: "GPIO0" }],
    };
    registerPackage("community.abi-device-sem-case", abiPkg);

    const box = componentBox("community.abi-device-sem-case");
    assert(box.width === 152 && box.height === 176, `package ABI deveria vir só do JSON (88px corpo + 64px lead escalado), recebido {${box.width},${box.height}}`);
    const pin = pinLocalPosition("GPIO0", 0, 1, "community.abi-device-sem-case");
    assert(pin.x === 152 && pin.y === 80, `pino ABI deveria casar por id no package registrado, recebido {${pin.x},${pin.y}}`);

    registerPackage("community.abi-device-sem-case", undefined);
  });

  await test("package com schematicWidth/schematicHeight escala o corpo e preserva folga de leads", () => {
    registerPackage("test.scaled", { ...pkg, schematicWidth: 30, schematicHeight: 20 });
    const box = componentBox("test.scaled");
    assert(box.width === 38, `esperado largura visual 38 (30 corpo + 8 leads escalados), recebido ${box.width}`);
    assert(box.height === 20, `esperado altura visual 20, recebido ${box.height}`);
    const pin = pinLocalPosition("out", 0, 3, "test.scaled");
    assert(Math.abs(pin.x - 38) < 0.001, `pino deveria escalar junto com a largura visual (38), recebido ${pin.x}`);
  });

  await test("pinLocalPosition casa por id, na ponta real do lead (corpo + length na direção do angle)", () => {
    registerPackage("test.example", pkg);
    const outPos = pinLocalPosition("out", 0, 3, "test.example");
    // offsetX = 8 (pra cobrir o lead de vcc/gnd que vai a x=-8) -- ponta de "out" = 60+8(lead)+8(offset) = 76
    assert(outPos.x === 76, `ponta de "out" esperada em x=76, recebido ${outPos.x}`);
    assert(outPos.y === 20, `y de "out" não deveria mudar, recebido ${outPos.y}`);

    const vccPos = pinLocalPosition("vcc", 1, 3, "test.example");
    // ponta de vcc = 0 - 8(lead) + 8(offset) = 0
    assert(vccPos.x === 0, `ponta de "vcc" esperada em x=0, recebido ${vccPos.x}`);
  });

  await test("pinLocalPosition cai pro algoritmo genérico quando o id não está no package", () => {
    registerPackage("test.example", pkg);
    const fallback = pinLocalPosition("nao-existe", 0, 2, "test.example");
    // algoritmo genérico: índice par -> PIN_INSET (6) da borda esquerda do box resolvido (76)
    assert(fallback.x === 6, `esperado fallback genérico x=6, recebido ${fallback.x}`);
  });

  await test("packageSymbolSvg devolve undefined sem package, markup com package", () => {
    registerPackage("test.example", undefined);
    assert(packageSymbolSvg("test.example") === undefined, "sem package registrado deveria devolver undefined");
    registerPackage("test.example", pkg);
    const svg = packageSymbolSvg("test.example");
    assert(typeof svg === "string" && svg.includes("OUT") && svg.includes("VCC") && svg.includes("GND"),
      "markup deveria conter o rótulo de cada pino declarado");
  });

  await test("packageSymbolSvg preserva formas path/image para assets e desenhos SimulIDE", () => {
    const richPkg: PackageDescriptor = {
      width: 40,
      height: 40,
      pins: [{ id: "p1", x: 0, y: 20, angle: 180, length: 8, label: "P1" }],
      shapes: [
        { kind: "path", d: "M 2 2 L 20 8 L 2 14 Z", fill: "#222", stroke: "#111", strokeWidth: 0.5, cssClass: "simulide-path" },
        { kind: "image", x: 4, y: 4, w: 16, h: 12, href: "data:image/png;base64,AAAA", preserveAspectRatio: "xMidYMid meet", cssClass: "simulide-image" },
      ],
    };
    registerPackage("test.rich-shapes", richPkg);
    const svg = packageSymbolSvg("test.rich-shapes") ?? "";
    assert(svg.includes('<path class="simulide-path" d="M 2 2 L 20 8 L 2 14 Z"'), `path deveria renderizar no package, markup: ${svg}`);
    assert(svg.includes('<image class="simulide-image" x="4" y="4" width="16" height="12" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,AAAA"'), `image deveria renderizar no package, markup: ${svg}`);
  });

  await test("package.simulidePaint traduz coordenadas locais do SimulIDE antes de viewSpec/shapes", () => {
    const simulidePkg: PackageDescriptor = {
      width: 16,
      height: 18,
      pins: [{ id: "pin", x: 8, y: 0, angle: 270, length: 0, label: "" }],
      shapes: [{ kind: "rect", x: 0, y: 0, w: 16, h: 18, fill: "#f00", stroke: "#f00" }],
      simulidePaint: {
        version: 1,
        source: { file: "src/components/sources/ground.cpp", className: "Ground", method: "paint" },
        bounds: { x: -8, y: -16, w: 16, h: 18 },
        defaultStroke: "#000",
        defaultFill: "none",
        defaultStrokeWidth: 2.5,
        primitives: [
          { kind: "line", x1: 0, y1: -16, x2: 0, y2: -8, strokeWidth: 3, strokeLinecap: "round" },
          { kind: "line", x1: -6.6, y1: -8, x2: 6.6, y2: -8 },
          { kind: "line", x1: -4.3, y1: -4, x2: 4.3, y2: -4 },
          { kind: "line", x1: -1.9, y1: 0, x2: 1.9, y2: 0 },
        ],
      },
    };
    registerPackage("test.simulide-paint.ground", simulidePkg);
    const svg = packageSymbolSvg("test.simulide-paint.ground", {}, "ground-1") ?? "";
    assert(svg.includes('x1="8" y1="0" x2="8" y2="8"'), `lead deveria ser traduzido do local SimulIDE para viewBox positivo, markup: ${svg}`);
    assert(svg.includes('x1="1.4" y1="8" x2="14.6" y2="8"'), `barra superior deveria preservar geometria -6.6..6.6, markup: ${svg}`);
    assert(svg.includes('stroke-width="2.5"'), `stroke default do paint deveria sobreviver, markup: ${svg}`);
    assert(!svg.includes('fill="#f00"'), `simulidePaint deveria ter prioridade sobre shapes[] legado, markup: ${svg}`);
    assert(!svg.includes('x1="8.0" y1="0.0" x2="8.0" y2="0.0"'), `pino length=0 nao deveria emitir lead zero-length, markup: ${svg}`);
    assert(!svg.includes("<text"), `label vazio nao deveria emitir texto invisivel, markup: ${svg}`);
  });

  await test("package.simulidePaint converte drawArc Qt em path SVG auditavel", () => {
    const arcPkg: PackageDescriptor = {
      width: 20,
      height: 20,
      pins: [{ id: "p1", x: 0, y: 10, angle: 180, length: 8, label: "P1" }],
      simulidePaint: {
        version: 1,
        bounds: { x: -10, y: -10, w: 20, h: 20 },
        primitives: [
          { kind: "arc", x: -8, y: -8, w: 16, h: 16, startDeg: 0, spanDeg: -180, stroke: "#123", strokeWidth: 1.5 },
        ],
      },
    };
    registerPackage("test.simulide-paint.arc", arcPkg);
    const svg = packageSymbolSvg("test.simulide-paint.arc", {}, "arc-1") ?? "";
    assert(svg.includes('<path d="M 18 10 A 8 8 0 0 1 2 10" stroke="#123" fill="none" stroke-width="1.5"'), `drawArc deveria virar path SVG com endpoint deterministico, markup: ${svg}`);
  });

  await test("package.simulidePaint aplica fill por propriedade e aliases de pino", () => {
    const fixedVoltPkg: PackageDescriptor = {
      width: 28,
      height: 24,
      pins: [{ id: "out", aliases: ["pin", "pin-1"], x: 28, y: 12, angle: 0, length: 0, label: "" }],
      simulidePaint: {
        version: 1,
        bounds: { x: -12, y: -12, w: 28, h: 24 },
        defaultStroke: "#000",
        defaultFill: "none",
        defaultStrokeWidth: 1.5,
        primitives: [
          { kind: "line", x1: 8, y1: 0, x2: 16, y2: 0, strokeWidth: 3, strokeLinecap: "round" },
          {
            kind: "roundedRect",
            x: -8,
            y: -8,
            w: 16,
            h: 16,
            rx: 2,
            ry: 2,
            fill: "#e6e6ff",
            stateFill: { prop: "out", map: { true: "#ffa600", false: "#e6e6ff" } },
          },
        ],
      },
    };
    registerPackage("test.simulide-paint.fixed-volt", fixedVoltPkg);
    const svgOn = packageSymbolSvg("test.simulide-paint.fixed-volt", { out: true }, "fixed-1") ?? "";
    const svgOff = packageSymbolSvg("test.simulide-paint.fixed-volt", { out: false }, "fixed-2") ?? "";
    assert(svgOn.includes('x1="20" y1="12" x2="28" y2="12"'), `lead deveria vir do paint local (8,0)->(16,0), markup: ${svgOn}`);
    assert(svgOn.includes('fill="#ffa600"'), `out=true deveria projetar fill laranja SimulIDE, markup: ${svgOn}`);
    assert(svgOff.includes('fill="#e6e6ff"'), `out=false deveria projetar fill lavanda SimulIDE, markup: ${svgOff}`);
    const pinOut = pinLocalPosition("out", 0, 1, "test.simulide-paint.fixed-volt");
    const pinLegacy = pinLocalPosition("pin-1", 0, 1, "test.simulide-paint.fixed-volt");
    assert(pinOut.x === 28 && pinOut.y === 12, `id real out deveria conectar em (28,12), recebido ${JSON.stringify(pinOut)}`);
    assert(pinLegacy.x === 28 && pinLegacy.y === 12, `alias pin-1 deveria conectar no mesmo ponto, recebido ${JSON.stringify(pinLegacy)}`);
    assert(hasRealPinPosition("test.simulide-paint.fixed-volt", "pin"), "alias pin deveria contar como posicao real");
  });

  await test("package.simulidePaint aplica visibilidade e imagem condicionais por estado", () => {
    const pkg: PackageDescriptor = {
      width: 12,
      height: 12,
      background: { kind: "none" },
      pins: [{ id: "out", aliases: ["pin-1"], x: 12, y: 6, angle: 0, length: 0, label: "", stateVisible: { when: { enabled: ["true"] } } }],
      simulidePaint: {
        version: 1,
        bounds: { x: 0, y: 0, w: 12, h: 12 },
        primitives: [
          { kind: "line", x1: 0, y1: 6, x2: 12, y2: 6, strokeWidth: 1, stateVisible: { when: { enabled: ["true"] } } },
          {
            kind: "image",
            x: 1,
            y: 1,
            w: 4,
            h: 4,
            href: "data:image/png;base64,AAAA",
            stateHref: { prop: "mode", map: { alt: "data:image/png;base64,BBBB" } },
          },
        ],
      },
    };
    registerPackage("test.simulide-paint.conditional", pkg);
    const disabled = packageSymbolSvg("test.simulide-paint.conditional", { enabled: false, mode: "alt" }, "cond-1") ?? "";
    const enabled = packageSymbolSvg("test.simulide-paint.conditional", { enabled: true, mode: "alt" }, "cond-2") ?? "";
    assert(!disabled.includes('x1="0" y1="6" x2="12" y2="6"'), `linha condicional nao deveria aparecer desligada, markup: ${disabled}`);
    assert(enabled.includes('x1="0" y1="6" x2="12" y2="6"'), `linha condicional deveria aparecer ligada, markup: ${enabled}`);
    assert(enabled.includes('href="data:image/png;base64,BBBB"'), `stateHref deveria trocar a imagem, markup: ${enabled}`);
    assert(!hasRealPinPosition("test.simulide-paint.conditional", "out", { enabled: false }), "pino condicional nao deveria ficar clicavel invisivel");
    assert(hasRealPinPosition("test.simulide-paint.conditional", "pin-1", { enabled: true }), "alias do pino condicional deveria ficar clicavel quando visivel");
  });

  await test("package.simulidePaint converte gradientes Qt em defs SVG escopados por componente", () => {
    const pkg: PackageDescriptor = {
      width: 32,
      height: 16,
      background: { kind: "none" },
      pins: [{ id: "out", x: 32, y: 8, angle: 0, length: 0, label: "" }],
      simulidePaint: {
        version: 1,
        bounds: { x: 0, y: 0, w: 32, h: 16 },
        primitives: [
          {
            kind: "roundedRect",
            x: 1,
            y: 1,
            w: 30,
            h: 14,
            rx: 2,
            ry: 2,
            stroke: "none",
            fillGradient: {
              kind: "linear",
              x1: 16,
              y1: 0,
              x2: 16,
              y2: 14,
              stops: [
                { offset: 0, color: "#ffffff" },
                { offset: 1, color: "#c8c8c8" },
              ],
            },
          },
        ],
      },
    };
    registerPackage("test.simulide-paint.gradient", pkg);
    const svg = packageSymbolSvg("test.simulide-paint.gradient", {}, "gradient component") ?? "";
    assert(svg.includes('<defs><linearGradient id="simulide-gradient_component-grad-0"'), `gradiente deveria ser emitido em defs com id escopado, markup: ${svg}`);
    assert(svg.includes('fill="url(#simulide-gradient_component-grad-0)"'), `fill deveria referenciar o gradiente escopado, markup: ${svg}`);
  });

  await test("ViewSpec escopa gradientes por componentId e aplica rotate stateProjection", () => {
    const viewSpecPkg: PackageDescriptor = {
      width: 40,
      height: 56,
      background: { kind: "none" },
      pins: [{ id: "clk", x: 36, y: 56, angle: 90, length: 8, label: "CLK" }],
      viewSpec: {
        gradients: {
          knob: {
            kind: "radial",
            cx: 6,
            cy: 6,
            r: 28,
            gradientUnits: "userSpaceOnUse",
            stops: [
              { offset: "0%", color: "#fff" },
              { offset: "100%", color: "#ccc" },
            ],
          },
        },
        paint: [
          { kind: "ellipse", cx: 20, cy: 20, rx: 13, ry: 13, fill: "gradient:knob", stroke: "none", strokeWidth: 0, cssClass: "encoder-hit-zone" },
          { kind: "ellipse", cx: 20, cy: 12, rx: 2, ry: 2, fill: "#d2d2c8", stroke: "#dcdcd0", strokeWidth: 0.5, cssClass: "encoder-indicator", partId: "indicator" },
        ],
        hitTest: {
          knob: { kind: "circle", cx: 20, cy: 20, r: 13, cursor: "grab" },
        },
        interaction: {
          turn: { kind: "dragAngular", hitTest: "knob", prop: "position", cx: 20, cy: 20, stepsPerRev: 20 },
        },
        stateProjection: {
          indicator: [{ kind: "rotate", prop: "position", stepsPerRev: 20, cx: 20, cy: 20 }],
        },
      },
    };
    registerPackage("test.viewspec.encoder", viewSpecPkg);
    const svgA = packageSymbolSvg("test.viewspec.encoder", { position: 5 }, "component A") ?? "";
    assert(svgA.includes('id="knob-component_A"'), `gradiente deveria ser escopado pelo componentId sanitizado, markup: ${svgA}`);
    assert(svgA.includes('fill="url(#knob-component_A)"'), `fill deveria referenciar o gradiente escopado, markup: ${svgA}`);
    assert(svgA.includes('class="encoder-hit-zone"'), "hit-zone do encoder deveria ser preservada");
    assert(svgA.includes('class="encoder-indicator" transform="rotate(90.00,20,20)"'), `indicator deveria girar 90 graus para position=5/20, markup: ${svgA}`);
    assert(svgA.includes('class="viewspec-hit-zone viewspec-hit-knob viewspec-interaction-dragAngular"'), `ViewSpec deveria criar overlay de hit-test do knob, markup: ${svgA}`);
    assert(svgA.includes('data-viewspec-hit-id="knob"'), "overlay deveria manter o id lógico do hit-test");

    const svgB = packageSymbolSvg("test.viewspec.encoder", { position: 0 }, "component-B") ?? "";
    assert(svgB.includes('id="knob-component-B"'), "segunda instância deveria ter outro ID de gradiente");
    assert(!svgB.includes("knob-component_A"), "segunda instância não deveria reutilizar ID da primeira");
  });

  await test("ViewSpec preserva background image antes do paint interativo", () => {
    const viewSpecWithBackgroundPkg: PackageDescriptor = {
      width: 24,
      height: 16,
      background: { kind: "image", data: "AAAA", mime: "image/png" },
      pins: [{ id: "p1", x: 0, y: 8, angle: 180, length: 8, label: "P1" }],
      viewSpec: {
        paint: [
          { kind: "rect", x: 4, y: 4, w: 8, h: 8, fill: "#ccc", stroke: "#333", cssClass: "interactive-paint" },
        ],
      },
    };
    registerPackage("test.viewspec.background", viewSpecWithBackgroundPkg);
    const svg = packageSymbolSvg("test.viewspec.background", {}, "bg-1") ?? "";
    const imageIndex = svg.indexOf('href="data:image/png;base64,AAAA"');
    const paintIndex = svg.indexOf('class="interactive-paint"');
    assert(imageIndex >= 0, `ViewSpec deveria renderizar o background image do package, markup: ${svg}`);
    assert(paintIndex > imageIndex, `paint interativo deveria vir depois do background, markup: ${svg}`);
  });

  await test("ViewSpec aplica translate stateProjection para joystick", () => {
    const joystickPkg: PackageDescriptor = {
      width: 40,
      height: 56,
      background: { kind: "none" },
      pins: [{ id: "vrx", x: 20, y: 56, angle: 90, length: 8, label: "VRX" }],
      viewSpec: {
        paint: [
          { kind: "ellipse", cx: 20, cy: 20, rx: 10, ry: 10, fill: "#999", stroke: "#aaa", strokeWidth: 0.5, cssClass: "joystick-hit-zone", partId: "thumbstick" },
        ],
        stateProjection: {
          thumbstick: [{
            kind: "translate",
            x: { prop: "x_pos", propRange: [0, 1023], pixelRange: [-7, 7] },
            y: { prop: "y_pos", propRange: [0, 1023], pixelRange: [-7, 7] },
          }],
        },
      },
    };
    registerPackage("test.viewspec.joystick", joystickPkg);
    const svg = packageSymbolSvg("test.viewspec.joystick", { x_pos: 1023, y_pos: 0 }, "joy-1") ?? "";
    assert(svg.includes('class="joystick-hit-zone" transform="translate(7.00,-7.00)"'), `thumbstick deveria refletir x/y nas propriedades, markup: ${svg}`);
  });

  await test("packagePinLeadSvg gira o rótulo -90° só em lead vertical (angle 90/270) -- evita rótulos colados quando há muitos pinos apertados num lado (ex: topo do ESP32 nu)", () => {
    const verticalPkg: PackageDescriptor = {
      width: 40,
      height: 40,
      pins: [
        { id: "top1", x: 10, y: 0, angle: 270, length: 8, label: "TOP1" },
        { id: "side1", x: 0, y: 10, angle: 180, length: 8, label: "SIDE1" },
      ],
    };
    registerPackage("test.vertical", verticalPkg);
    const svg = packageSymbolSvg("test.vertical")!;
    assert(svg.includes('rotate(-90') && /rotate\(-90[^)]*\)">TOP1/.test(svg), "pino vertical (angle 270) deveria ter <text> com transform rotate(-90...)");
    assert(!/rotate\(-90[^)]*\)">SIDE1/.test(svg), "pino horizontal (angle 180) não deveria girar o rótulo");
  });

  await test("packagePinLeadSvg usa labelX/labelY do pino quando presentes, sem girar (posição já escolhida pelo usuário)", () => {
    const customLabelPkg: PackageDescriptor = {
      width: 40,
      height: 40,
      pins: [{ id: "top1", x: 10, y: 0, angle: 270, length: 8, label: "TOP1", labelX: 20, labelY: 20 }],
    };
    registerPackage("test.customlabel", customLabelPkg);
    const svg = packageSymbolSvg("test.customlabel")!;
    assert(svg.includes('x="20.0" y="28.0"'), `texto deveria ficar na posição customizada deslocada pelo viewBox (20,28), markup: ${svg}`);
    assert(!svg.includes("rotate(-90"), "com labelX/labelY explícitos, não deveria girar automaticamente (usuário já escolheu a posição)");
    registerPackage("test.customlabel", undefined);
  });

  await test("hasRealPinPosition: sem package, qualquer pinId tem posição (algoritmo genérico já é a posição real)", () => {
    registerPackage("test.example", undefined);
    assert(hasRealPinPosition("test.example", "qualquer-id") === true, "sem package deveria sempre devolver true");
  });

  await test("hasRealPinPosition: com package, só pinId presente no package tem posição -- ex: GPIO elétrico sem lead físico no encapsulamento", () => {
    registerPackage("test.example", pkg);
    assert(hasRealPinPosition("test.example", "out") === true, "pino real do package deveria ter posição");
    assert(hasRealPinPosition("test.example", "pin-eletrico-sem-lead") === false, "pino elétrico sem lead físico no package não deveria ter posição (não desenha terminal genérico por cima)");
  });

  await test("registerPackage com 3º argumento: properties.logicSymbol escolhe a variante alternativa (igual ao SubPackage::Logic_Symbol do SimulIDE real)", () => {
    const logicSymbolPkg: PackageDescriptor = {
      width: 30,
      height: 20,
      pins: [{ id: "out", x: 30, y: 10, angle: 0, length: 8, label: "LOGIC-OUT" }],
    };
    registerPackage("test.dual", pkg, logicSymbolPkg);

    const defaultBox = componentBox("test.dual");
    assert(defaultBox.width === 76, `sem logicSymbol=true, deveria usar o package padrão (largura 76), recebido ${defaultBox.width}`);

    const logicSymbolBox = componentBox("test.dual", { logicSymbol: true });
    assert(logicSymbolBox.width !== defaultBox.width, "com logicSymbol=true, deveria usar a variante alternativa (geometria diferente)");

    const svgDefault = packageSymbolSvg("test.dual") ?? "";
    assert(svgDefault.includes("OUT") && !svgDefault.includes("LOGIC-OUT"), "sem logicSymbol, markup deveria ser o package padrão");
    const svgLogicSymbol = packageSymbolSvg("test.dual", { logicSymbol: true }) ?? "";
    assert(svgLogicSymbol.includes("LOGIC-OUT"), "com logicSymbol=true, markup deveria ser a variante alternativa");

    registerPackage("test.dual", undefined);
  });

  await test("registerPackage sem 3º argumento (típico de typeId sem variante Logic Symbol): logicSymbol=true não tem efeito, cai no package padrão", () => {
    registerPackage("test.example", pkg);
    const box = componentBox("test.example", { logicSymbol: true });
    assert(box.width === 76, "sem variante registrada, logicSymbol=true deveria ser ignorado e cair no package padrão");
  });

  await test("connectors.tunnel cresce para caber o nome e mantem o pino na ponta da seta", () => {
    const shortBox = componentBox("connectors.tunnel", { name: "GND" });
    const longBox = componentBox("connectors.tunnel", { name: "GPIO_UART_DEBUG_LONG_NAME" });
    assert(longBox.width > shortBox.width, `nome longo deveria aumentar a largura (${shortBox.width} -> ${longBox.width})`);
    const pin = pinLocalPosition("pin", 0, 1, "connectors.tunnel", { name: "GPIO_UART_DEBUG_LONG_NAME" });
    assert(pin.x === longBox.width - 8, `pino deveria ficar na ponta da seta (x=width-8), recebido ${pin.x} para width=${longBox.width}`);
    const svg = componentSymbolSvg("connectors.tunnel", { name: "GPIO23" });
    assert(svg.includes("GPIO23"), "nome do tunel deveria ser desenhado dentro do simbolo");
  });

  await test("voltimetro ancora leituras longas dentro do display", () => {
    const svg = componentSymbolSvg("instruments.voltmeter", { __readout: -2.499 });
    assert(svg.includes('text-anchor="end"'), "valor do voltimetro deveria ficar ancorado pela borda direita do LCD");
    assert(svg.includes('style="font-size:11px"'), "leitura com sinal e tres casas deveria reduzir fonte para caber no LCD");
    assert(svg.includes(">-2.499<"), "leitura negativa deveria ser preservada no texto do display");
  });

  registerPackage("test.example", undefined);
  registerPackage("test.scaled", undefined);
  registerPackage("test.vertical", undefined);
  registerPackage("test.customlabel", undefined);
  registerPackage("test.dual", undefined);
  registerPackage("test.viewspec.encoder", undefined);
  registerPackage("test.viewspec.joystick", undefined);
  registerPackage("test.viewspec.background", undefined);
  registerPackage("test.rich-shapes", undefined);
  registerPackage("test.simulide-paint.fixed-volt", undefined);
  finish();
})();

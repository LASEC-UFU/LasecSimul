import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
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

  await test("sem package registrado, componentBox cai pro algoritmo genérico (fallback)", () => {
    registerPackage("test.example", undefined);
    const box = componentBox("test.example");
    assert(box.width === 70 && box.height === 40, `esperado box genérico, recebido {${box.width},${box.height}}`);
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
  finish();
})();

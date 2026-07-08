import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import fs from "node:fs";
import path from "node:path";
import { componentBox, componentLocalOrigin, componentSymbolSvg, hasRealPinPosition, pinLocalPosition, packageSymbolSvg, registerPackage } from "./componentSymbols";
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

  // cos/sin(180deg)/(0deg) em ponto flutuante não batem com -1/0/1 exatos (ex: Math.sin(Math.PI) ≈
  // 1.22e-16, não 0) -- suficiente pra quebrar `===` num pino a 8 unidades de distância mesmo sendo
  // visualmente idêntico. Tolerância de 1e-6 absorve esse ruído sem mascarar erro de geometria real.
  function near(a: number, b: number): boolean {
    return Math.abs(a - b) < 1e-6;
  }

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

  await test("package com origem Qt do SimulIDE expõe origem local separada do bounding box visual", () => {
    registerPackage("test.qt-origin", pkg);
    const box = componentBox("test.qt-origin", { __simulideQtOrigin: true });
    const origin = componentLocalOrigin("test.qt-origin", { __simulideQtOrigin: true });
    assert(box.width === 76 && box.height === 40, `box deveria incluir lead externo do package, recebido {${box.width},${box.height}}`);
    assert(Boolean(origin) && near(origin!.x, 8) && near(origin!.y, 0), `origem Qt deveria ser o offset do layout resolvido, recebido ${JSON.stringify(origin)}`);
  });

  await test("package traduzido de cena SimulIDE aplica escala local em box, origem e pinos", () => {
    registerPackage("test.qt-scale", pkg);
    const properties = { __simulideQtOrigin: true, __simulideSceneScaleX: 2, __simulideSceneScaleY: 3 };
    const box = componentBox("test.qt-scale", properties);
    const origin = componentLocalOrigin("test.qt-scale", properties);
    const out = pinLocalPosition("out", 0, 3, "test.qt-scale", properties);
    assert(box.width === 152 && box.height === 120, `box deveria escalar package resolvido, recebido {${box.width},${box.height}}`);
    assert(Boolean(origin) && near(origin!.x, 16) && near(origin!.y, 0), `origem Qt deveria acompanhar escala da cena, recebido ${JSON.stringify(origin)}`);
    assert(near(out.x, 152) && near(out.y, 60), `pino deveria acompanhar escala da cena, recebido ${JSON.stringify(out)}`);
  });

  await test("other.ground replica sources/ground.cpp: caixa, pino no topo do lead e barras com stroke 2.5", () => {
    catalogPackage("other.ground");
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

  await test("medidores pequenos vem do renderer package.simulidePaint, nao do SVG hardcoded legado", () => {
    catalogPackage("instruments.voltmeter");
    catalogPackage("meters.ampmeter");
    catalogPackage("meters.freqmeter");

    const voltBox = componentBox("instruments.voltmeter");
    const ampBox = componentBox("meters.ampmeter");
    const freqBox = componentBox("meters.freqmeter");
    assert(voltBox.width === 64 && voltBox.height === 48, `Voltimeter deveria usar bounds do Meter real + pinos, recebido {${voltBox.width},${voltBox.height}}`);
    assert(ampBox.width === 64 && ampBox.height === 48, `Ampmeter deveria usar bounds do Meter real + pinos, recebido {${ampBox.width},${ampBox.height}}`);
    assert(freqBox.width === 93 && freqBox.height === 20, `FreqMeter deveria usar m_area + pino real, recebido {${freqBox.width},${freqBox.height}}`);

    const v1 = pinLocalPosition("pin-1", 0, 3, "instruments.voltmeter");
    const v2 = pinLocalPosition("pin-2", 1, 3, "instruments.voltmeter");
    const v3 = pinLocalPosition("pin-3", 2, 3, "instruments.voltmeter");
    assert(v1.x === 16 && v1.y === 40, `Voltimeter lPin deveria ficar em (-8,16) traduzido => (16,40), recebido ${JSON.stringify(v1)}`);
    assert(v2.x === 32 && v2.y === 40, `Voltimeter rPin deveria ficar em (8,16) traduzido => (32,40), recebido ${JSON.stringify(v2)}`);
    assert(v3.x === 56 && v3.y === 16, `Voltimeter outnod deveria ficar em (32,-8) traduzido => (56,16), recebido ${JSON.stringify(v3)}`);
    const f1 = pinLocalPosition("pin-1", 0, 1, "meters.freqmeter");
    assert(f1.x === 0 && f1.y === 10, `FreqMeter lPin deveria ficar em (-40,0) traduzido => (0,10), recebido ${JSON.stringify(f1)}`);

    const voltSvg = packageSymbolSvg("instruments.voltmeter", { __readout: -2.499 }, "voltmeter-render") ?? "";
    const ampSvg = packageSymbolSvg("meters.ampmeter", { __readout: 0.0012 }, "ampmeter-render") ?? "";
    const freqSvg = packageSymbolSvg("meters.freqmeter", { __readout: 2500 }, "freqmeter-render") ?? "";
    assert(voltSvg.includes('width="48" height="32"') && voltSvg.includes('fill="#000000"'), `Voltimeter deveria desenhar QRectF(-24,-24,48,32) preto, markup: ${voltSvg}`);
    assert(voltSvg.includes('font-family="Ubuntu Mono"') && voltSvg.includes('font-size="13"'), `Voltimeter deveria usar fonte do SimulIDE, markup: ${voltSvg}`);
    assert(voltSvg.includes('stroke="#ff0000"'), `Voltimeter lPin deveria preservar setColor(Qt::red), markup: ${voltSvg}`);
    assert(voltSvg.includes("<tspan") && voltSvg.includes("-2.499") && voltSvg.includes("> V<"), `Voltimeter deveria renderizar QGraphicsSimpleTextItem em duas linhas, markup: ${voltSvg}`);
    assert(ampSvg.includes("> 1.200<") && ampSvg.includes("> mA<"), `Ampmeter deveria formatar leitura via Meter::updateStep/valToUnit, markup: ${ampSvg}`);
    assert(freqSvg.includes(">2.5000 kHz<"), `FreqMeter deveria formatar leitura via FreqMeter::updateStep, markup: ${freqSvg}`);
  });

  await test("probe e graficos PlotBase vem de package renderer, nao dos fallbacks grandes", () => {
    const probePkg = catalogPackage("meters.probe");
    const scopePkg = catalogPackage("meters.oscope");
    const logicPkg = catalogPackage("meters.logic_analyzer");
    assert(Boolean(probePkg.simulidePaint), "Probe deveria usar package.simulidePaint traduzido de probe.cpp");
    assert(probePkg.initialTransform?.rotateDeg === -45, "Probe deveria declarar initialTransform.rotateDeg=-45 (Probe::Probe() faz setRotation(rotation()-45))");
    assert(scopePkg.qtWidget?.kind === "plotBase", "Oscope deveria usar qtWidget plotBase traduzido de PlotBase/DataWidget");
    assert(logicPkg.qtWidget?.variant === "logicAnalyzer", "Logic analyzer deveria usar qtWidget plotBase variant logicAnalyzer");

    const probeBox = componentBox("meters.probe");
    const scopeBox = componentBox("meters.oscope");
    const logicBox = componentBox("meters.logic_analyzer");
    // Box do Probe cresce em Y (16 -> ~23.56) porque o pino real (declarado na orientação CANÔNICA,
    // sem rotação) é girado -45° em volta do pivô (22,8) pelo initialTransform -- resolvePackageLayout
    // expande a caixa pra caber a nova ponta do pino, exatamente como faria pra qualquer pino comum
    // que saísse fora do `width`/`height` estático declarado.
    assert(probeBox.width === 30 && Math.abs(probeBox.height - 23.556349186104043) < 1e-9, `Probe deveria crescer em Y pelo pino rotacionado -45°, recebido ${JSON.stringify(probeBox)}`);
    assert(scopeBox.width === 227 && scopeBox.height === 153, `Oscope deveria usar m_area+pins do PlotBase colapsado, recebido ${JSON.stringify(scopeBox)}`);
    assert(logicBox.width === 227 && logicBox.height === 153, `Logic analyzer deveria usar m_area+pins do PlotBase colapsado, recebido ${JSON.stringify(logicBox)}`);

    const probePin = pinLocalPosition("pin-1", 0, 1, "meters.probe");
    const scopePin = pinLocalPosition("pin-1", 0, 4, "meters.oscope");
    const logicPin8 = pinLocalPosition("pin-8", 7, 8, "meters.logic_analyzer");
    // Pino canônico (-22,0) traduzido => (0,8) antes do initialTransform; girado -45° em volta de
    // (22,8) (mesmo pivô do corpo) => (6.44,23.56) -- ver initialTransform acima.
    assert(Math.abs(probePin.x - 6.443650813895953) < 1e-9 && Math.abs(probePin.y - 23.556349186104043) < 1e-9, `Probe inpin deveria ficar em (-22,0) traduzido+girado -45° => (6.44,23.56), recebido ${JSON.stringify(probePin)}`);
    assert(scopePin.x === 0 && scopePin.y === 25, `Oscope Pin0 deveria ficar em (-88,-48) traduzido => (0,25), recebido ${JSON.stringify(scopePin)}`);
    assert(logicPin8.x === 0 && logicPin8.y === 121, `Logic Pin7 deveria ficar em (-88,48) traduzido => (0,121), recebido ${JSON.stringify(logicPin8)}`);

    const probeHigh = packageSymbolSvg("meters.probe", { __readout: 5, threshold: 2.5, negativeThreshold: -2.5 }, "probe-render") ?? "";
    const probeLow = packageSymbolSvg("meters.probe", { __readout: -5, threshold: 2.5, negativeThreshold: -2.5 }, "probe-render-low") ?? "";
    const scopeSvg = packageSymbolSvg("meters.oscope", {}, "scope-render") ?? "";
    const logicSvg = packageSymbolSvg("meters.logic_analyzer", {}, "logic-render") ?? "";
    assert(probeHigh.includes('fill="#ffa600"'), `Probe acima do threshold deveria ficar laranja por stateFill numerico, markup: ${probeHigh}`);
    assert(probeLow.includes('fill="#0064ff"'), `Probe abaixo do threshold negativo deveria ficar azul por stateFill numerico, markup: ${probeLow}`);
    assert(scopeSvg.includes('width="219" height="153"') && scopeSvg.includes(">0 Hz</text>"), `Oscope deveria renderizar DataWidget/PlotDisplay colapsado, markup: ${scopeSvg}`);
    assert(logicSvg.includes('width="219" height="153"') && logicSvg.includes('width="60" height="14"'), `Logic analyzer deveria renderizar DataLaWidget/PlotDisplay colapsado, markup: ${logicSvg}`);
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

  await test("package com schematicWidth/schematicHeight NAO escala font-size/stroke-width do rotulo/lead (fidelidade ao SimulIDE real)", () => {
    // SimulIDE real (gui/circuitwidget/pin.cpp::Pin::paint()): font.setPixelSize(7) e
    // QPen(...,3,...)/QPen(...,0.5,...) sao CONSTANTES fixas, sem nenhum fator de escala -- nao
    // existe conceito de "tamanho nativo vs. schematic" (cada Package real ja nasce autorado direto
    // no espaco final, subcircuits/chip.cpp::m_area = QRect(0,0,8*m_width,8*m_height)). Um fator de
    // escala foi introduzido aqui antes por diagnostico equivocado (avaliado como bug de "labels
    // colando" que na verdade era o pitch normal e denso do SimulIDE real, ver .spec secao 14.2) e
    // deixava o texto pequeno demais comparado ao SimulIDE de verdade -- revertido. schematicWidth/
    // schematicHeight so comprime POSICAO (pinos capturados em espaco de pixel de foto/imagem).
    registerPackage("test.scaled-labels", { ...pkg, schematicWidth: 30, schematicHeight: 20 });
    const svg = packageSymbolSvg("test.scaled-labels") ?? "";
    assert(svg.includes("font-size:7px"), `font-size do rotulo deveria continuar o nativo "7px", sem escala, markup: ${svg}`);
    assert(svg.includes('stroke-width="3"'), `lead stroke-width deveria continuar o nativo "3", sem escala, markup: ${svg}`);
    assert(svg.includes('stroke-width="0.5"') || !svg.includes("packagePin"), `marker stroke-width deveria continuar o nativo "0.5" quando presente, markup: ${svg}`);
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

  await test("packageSymbolSvg bloqueia svg inline perigoso em shapes[]", () => {
    registerPackage("test.unsafe-svg-shape", {
      width: 20,
      height: 20,
      pins: [{ id: "p1", x: 0, y: 10, angle: 180, length: 0, label: "" }],
      shapes: [
        { kind: "svg", value: '<script>alert("x")</script><rect width="20" height="20"/>' },
        { kind: "svg", value: '<g onclick="alert(1)"><rect width="10" height="10"/></g>' },
        { kind: "svg", value: '<path d="M0 0 L10 10"/>' },
      ],
    });
    const svg = packageSymbolSvg("test.unsafe-svg-shape") ?? "";
    assert(!svg.includes("<script"), `script inline nao deveria sobreviver, markup: ${svg}`);
    assert(!svg.includes("onclick"), `handler inline nao deveria sobreviver, markup: ${svg}`);
    assert(svg.includes('<path d="M0 0 L10 10"/>'), `svg inline seguro deveria ser preservado, markup: ${svg}`);
  });

  await test("package.viewSpec adiciona hit-test mesmo quando simulidePaint desenha o corpo", () => {
    registerPackage("test.viewspec-over-simulide-paint", {
      width: 20,
      height: 20,
      pins: [{ id: "p1", x: 0, y: 10, angle: 180, length: 0, label: "" }],
      simulidePaint: {
        version: 1,
        bounds: { x: 0, y: 0, w: 20, h: 20 },
        primitives: [{ kind: "rect", x: 0, y: 0, w: 20, h: 20, fill: "#ff0000" }],
      },
      viewSpec: {
        paint: [{ kind: "rect", x: 0, y: 0, w: 20, h: 20, fill: "#00ff00" }],
        interaction: { press: { kind: "press", hitTest: "button", prop: "pressed" } },
        hitTest: { button: { kind: "rect", x: 2, y: 2, w: 16, h: 16, cursor: "pointer" } },
      },
    });
    const svg = packageSymbolSvg("test.viewspec-over-simulide-paint", {}, "viewspec-overlay") ?? "";
    assert(svg.includes('fill="#ff0000"'), `simulidePaint deveria continuar desenhando o corpo, markup: ${svg}`);
    assert(!svg.includes('fill="#00ff00"'), `paint do viewSpec nao deveria duplicar quando simulidePaint existe, markup: ${svg}`);
    assert(svg.includes('data-viewspec-hit-id="button"') && svg.includes("viewspec-hit-button"), `hit-test do viewSpec deveria ser composto sobre simulidePaint, markup: ${svg}`);
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

  await test("package.simulidePaint primitive 'repeat' duplica um template N vezes (arrays/repeticoes, ex: SwitchDip::createSwitches) sem hand-enumeration por device", () => {
    const repeatPkg: PackageDescriptor = {
      width: 20,
      height: 40,
      pins: [{ id: "pin-1", x: 20, y: 20, angle: 0, length: 0, label: "" }],
      simulidePaint: {
        version: 1,
        bounds: { x: 0, y: 0, w: 20, h: 40 },
        primitives: [
          {
            kind: "repeat",
            count: 4,
            stepY: 10,
            primitives: [
              { kind: "rect", x: 2, y: 2, w: 6, h: 6, stateFill: { prop: "on", map: { true: "#0f0", false: "#ccc" } }, fill: "#ccc" },
            ],
          },
        ],
      },
    };
    registerPackage("test.simulide-paint.repeat", repeatPkg);
    const svgOn = packageSymbolSvg("test.simulide-paint.repeat", { on: true }, "repeat-1") ?? "";
    const svgOff = packageSymbolSvg("test.simulide-paint.repeat", { on: false }, "repeat-2") ?? "";
    const rectCountOn = (svgOn.match(/<rect/g) ?? []).length;
    assert(rectCountOn === 4, `'repeat' com count=4 deveria gerar 4 rects, recebido ${rectCountOn} no markup: ${svgOn}`);
    assert(svgOn.includes('y="2"') && svgOn.includes('y="12"') && svgOn.includes('y="22"') && svgOn.includes('y="32"'), `'repeat' deveria deslocar cada copia por stepY=10 (y=2,12,22,32), markup: ${svgOn}`);
    assert((svgOn.match(/#0f0/g) ?? []).length === 4, "cada copia deveria aplicar o proprio stateFill (todas 'on' juntas, ja que compartilham a mesma property)");
    assert((svgOff.match(/#ccc/g) ?? []).length === 4, "com on=false, as 4 copias deveriam usar o fallback/false do stateFill");
  });

  await test("package.simulidePaint repeat aceita countProp/indexName e texto por caractere para matrizes Qt", () => {
    const matrixPkg: PackageDescriptor = {
      width: 32,
      height: 16,
      pins: [{ id: "pin-1", x: 0, y: 0, angle: 0, length: 0, label: "" }],
      simulidePaint: {
        version: 1,
        bounds: { x: 0, y: 0, w: 32, h: 16 },
        primitives: [
          {
            kind: "repeat",
            countProp: "columns",
            indexName: "col",
            stepX: 8,
            primitives: [
              { kind: "rect", x: 0, y: 0, w: 8, h: 8, fill: "#fff" },
              {
                kind: "text",
                x: 4,
                y: 4,
                value: "",
                stateText: { kind: "propertyChar", prop: "keyLabels", columnIndex: "col", columnsProp: "columns" },
              },
            ],
          },
        ],
      },
    };
    registerPackage("test.simulide-paint.matrix", matrixPkg);
    const svg = packageSymbolSvg("test.simulide-paint.matrix", { columns: 4, keyLabels: "ABCD" }, "matrix-1") ?? "";
    assert((svg.match(/<rect/g) ?? []).length === 4, `countProp columns=4 deveria gerar 4 copias, markup: ${svg}`);
    assert(svg.includes(">A<") && svg.includes(">D<"), `stateText.propertyChar deveria indexar keyLabels por repeat context, markup: ${svg}`);
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

  await test("packagePinLeadSvg desenha o marcador cinza de PackagePin quando o package declara pinMarker=packagePin", () => {
    const packagePinPkg: PackageDescriptor = {
      width: 40,
      height: 40,
      pinMarker: "packagePin",
      pins: [{ id: "p1", x: 0, y: 20, angle: 180, length: 8, label: "P1" }],
    };
    registerPackage("test.packagepin-marker", packagePinPkg);
    const svg = packageSymbolSvg("test.packagepin-marker") ?? "";
    assert(svg.includes('stroke="#d3d3d3" stroke-width="0.5"'), `PackagePin::paint deveria gerar marcador cinza, markup: ${svg}`);
    assert(svg.includes('<line x1="7.0" y1="20.0" x2="9.0" y2="20.0"'), `marcador deveria ficar no ponto de origem do pino, markup: ${svg}`);
    registerPackage("test.packagepin-marker", undefined);
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

  await test("connectors.tunnel usa geometria real do Tunnel/Pin do SimulIDE", () => {
    const shortBox = componentBox("connectors.tunnel", { name: "GND" });
    const longBox = componentBox("connectors.tunnel", { name: "GPIO_UART_DEBUG_LONG_NAME" });
    assert(longBox.width > shortBox.width, `nome longo deveria aumentar a largura (${shortBox.width} -> ${longBox.width})`);
    const pin = pinLocalPosition("pin", 0, 1, "connectors.tunnel", { name: "GPIO_UART_DEBUG_LONG_NAME" });
    assert(pin.x === longBox.width && pin.y === 6, `pino deveria ficar na origem Qt do Tunnel nao-rotated (${longBox.width},6), recebido ${pin.x},${pin.y}`);
    const rotatedPin = pinLocalPosition("pin", 0, 1, "connectors.tunnel", { name: "GPIO_UART_DEBUG_LONG_NAME", __simulideTunnelRotated: true });
    assert(rotatedPin.x === 0 && rotatedPin.y === 6, `setRotated(true) deveria mover a origem/pino para a esquerda, recebido ${rotatedPin.x},${rotatedPin.y}`);
    const svg = componentSymbolSvg("connectors.tunnel", { name: "GPIO23" });
    assert(svg.includes("GPIO23"), "nome do tunel deveria ser desenhado dentro do simbolo");
    assert(svg.includes("<polygon") && svg.includes('fill="#fffffa"'), "tunel deveria vir do renderer SimulidePaint com fill real de grupo existente");
    assert(!svg.includes('stroke-width="4"'), "tunel nao deveria manter o contorno grosso do SVG manual antigo");
  });

  await test("voltimetro com package usa texto dinamico do renderer SimulIDE", () => {
    catalogPackage("instruments.voltmeter");
    const svg = packageSymbolSvg("instruments.voltmeter", { __readout: -2.499 }, "voltmeter-render-negative") ?? "";
    assert(svg.includes('text-anchor="start"'), "texto do Meter real deveria iniciar em m_display.pos(), nao ancorar na direita como LCD custom");
    assert(svg.includes('font-size="13"'), "texto do Meter real deveria usar pixelSize 13");
    assert(svg.includes(">-2.499<"), "leitura negativa deveria ser preservada no texto do display");
  });

  await test("switches.push/switches.switch vem de package.simulidePaint (Interruptores) com botao proxy e alavanca/barra reais", () => {
    catalogPackage("switches.push");
    catalogPackage("switches.switch");
    const pushBox = componentBox("switches.push");
    const switchBox = componentBox("switches.switch");
    assert(pushBox.width === 32 && pushBox.height === 28, `Push deveria usar m_area(-12,-8,24,12) + botao(-8,4,16,16), recebido ${JSON.stringify(pushBox)}`);
    assert(switchBox.width === 32 && switchBox.height === 28, `Switch deveria ter a mesma caixa de Push (mesma SwitchBase), recebido ${JSON.stringify(switchBox)}`);

    const p1 = pinLocalPosition("pin-1", 0, 2, "switches.push");
    const p2 = pinLocalPosition("pin-2", 1, 2, "switches.push");
    assert(near(p1.x, 0) && near(p1.y, 8), `Pino esquerdo do Push deveria ficar em (-16,0) traduzido => (0,8), recebido ${JSON.stringify(p1)}`);
    assert(near(p2.x, 32) && near(p2.y, 8), `Pino direito do Push deveria ficar em (16,0) traduzido => (32,8), recebido ${JSON.stringify(p2)}`);

    const pushOpen = packageSymbolSvg("switches.push", { closed: false, normallyClosed: false, key: "A" }, "push-open") ?? "";
    const pushPressed = packageSymbolSvg("switches.push", { closed: true, normallyClosed: false, key: "A" }, "push-pressed") ?? "";
    assert(pushOpen.includes('y1="0" x2="25" y2="0"'), `Push solto deveria desenhar a barra em y=-8 (Push::paint), markup: ${pushOpen}`);
    assert(pushPressed.includes('y1="6" x2="25" y2="6"'), `Push pressionado deveria desenhar a barra em y=-2, markup: ${pushPressed}`);
    assert(pushPressed.includes('fill="#62d67b"') && pushOpen.includes('fill="#dddddd"'), `Botao proxy deveria mudar de cor com \`closed\`, markups: ${pushOpen} | ${pushPressed}`);
    assert(pushOpen.includes(">A<"), "Push deveria ecoar properties.key no rotulo do botao (SwitchBase::setKey/CustomButton)");

    // Norm_Close inverte a POSIÇÃO VISUAL (m_closed real = onbuttonPressed/Released XOR Norm_Close),
    // mas NÃO a cor do botão (CustomButton::isChecked reflete o `closed` cru, sem XOR).
    const pushNcPressed = packageSymbolSvg("switches.push", { closed: true, normallyClosed: true, key: "" }, "push-nc-pressed") ?? "";
    assert(pushNcPressed.includes('y1="0" x2="25" y2="0"'), `Push Norm_Close pressionado deveria desenhar a barra na posição SOLTA (XOR), markup: ${pushNcPressed}`);
    assert(pushNcPressed.includes('fill="#62d67b"'), "Botao deveria continuar verde (closed=true cru) mesmo com Norm_Close invertendo a posicao visual");

    const switchClosed = packageSymbolSvg("switches.switch", { closed: true, normallyClosed: false }, "switch-closed") ?? "";
    const switchOpen = packageSymbolSvg("switches.switch", { closed: false, normallyClosed: false }, "switch-open") ?? "";
    assert(switchClosed.includes('x1="6" y1="8" x2="26" y2="6"'), `Switch fechado deveria desenhar MechContact::paint drawLine(-10,0,10,-2), markup: ${switchClosed}`);
    assert(switchOpen.includes('x1="5.5" y1="8" x2="24" y2="0"'), `Switch aberto deveria desenhar drawLine(-10.5,0,8,-8), markup: ${switchOpen}`);

    // Component::paint() real não desenha nada (só seta pen/brush) e nem Push::paint() nem
    // MechContact::paint() chamam drawRect(m_area) -- ao contrário de SwitchDip/Relay, que chamam.
    // `m_area` aqui é só boundingRect()/hit-test; um `<rect>` desenhado em volta da alavanca/barra
    // é um elemento INVENTADO que não existe no SimulIDE real (bug encontrado comparando screenshot
    // real x LasecSimul: a alavanca aparecia "presa numa caixa" que não deveria existir).
    assert(!pushOpen.includes("<rect") || !/<rect[^>]*x="4"[^>]*y="0"/.test(pushOpen), `Push NÃO deveria desenhar um rect de corpo em volta da barra (m_area é só hit-test), markup: ${pushOpen}`);
    assert(!switchOpen.includes("<rect") || !/<rect[^>]*x="4"[^>]*y="0"/.test(switchOpen), `Switch NÃO deveria desenhar um rect de corpo em volta da alavanca (m_area é só hit-test), markup: ${switchOpen}`);
  });

  await test("switches.switch_dip vem de package.simulidePaint com 8 posicoes e 16 pinos reais (switchdip.cpp)", () => {
    catalogPackage("switches.switch_dip");
    const box = componentBox("switches.switch_dip");
    assert(box.width === 24 && box.height === 64, `SwitchDip deveria usar m_area(-3,-28,14,64) + pinos, recebido ${JSON.stringify(box)}`);
    const first = pinLocalPosition("pin-1", 0, 16, "switches.switch_dip");
    const last = pinLocalPosition("pin-16", 15, 16, "switches.switch_dip");
    assert(near(first.x, 0) && near(first.y, 4), `Pino P da posicao 0 deveria ficar em (-8,-24) traduzido => (0,4), recebido ${JSON.stringify(first)}`);
    assert(near(last.x, 24) && near(last.y, 60), `Pino N da posicao 7 deveria ficar em (16,32) traduzido => (24,60), recebido ${JSON.stringify(last)}`);
    const svg = packageSymbolSvg("switches.switch_dip", { closed: true }, "dip-closed") ?? "";
    assert((svg.match(/toggle-hit-zone/g) ?? []).length === 8, `SwitchDip deveria desenhar 8 botoes clicaveis (1 por posicao), markup: ${svg}`);
    assert((svg.match(/#62d67b/g) ?? []).length === 8, "As 8 posicoes compartilham a mesma propriedade `closed` (limitacao do Core) -- todas devem ficar verdes juntas");
  });

  await test("switches.relay vem de package.simulidePaint com bobina (arcos de inductor.cpp) + contato SPST (relay.cpp)", () => {
    catalogPackage("switches.relay");
    const box = componentBox("switches.relay");
    assert(box.width === 32 && box.height === 36, `Relay deveria usar m_area(-12,-28,24,36) + pinos, recebido ${JSON.stringify(box)}`);
    const coilP = pinLocalPosition("pin-1", 0, 4, "switches.relay");
    const coilN = pinLocalPosition("pin-2", 1, 4, "switches.relay");
    const contactP = pinLocalPosition("pin-3", 2, 4, "switches.relay");
    const contactN = pinLocalPosition("pin-4", 3, 4, "switches.relay");
    assert(near(coilP.x, 0) && near(coilP.y, 28), `Pino P da bobina deveria ficar em (-16,0) traduzido => (0,28), recebido ${JSON.stringify(coilP)}`);
    assert(near(coilN.x, 32) && near(coilN.y, 28), `Pino N da bobina deveria ficar em (16,0) traduzido => (32,28), recebido ${JSON.stringify(coilN)}`);
    assert(near(contactP.x, 0) && near(contactP.y, 12), `Pino P do contato deveria ficar em (-16,-16) traduzido => (0,12), recebido ${JSON.stringify(contactP)}`);
    assert(near(contactN.x, 32) && near(contactN.y, 12), `Pino N do contato deveria ficar em (16,-16) traduzido => (32,12), recebido ${JSON.stringify(contactN)}`);

    const relayOpen = packageSymbolSvg("switches.relay", { normallyClosed: false }, "relay-open") ?? "";
    const relayNc = packageSymbolSvg("switches.relay", { normallyClosed: true }, "relay-nc") ?? "";
    assert(relayOpen.includes('x1="5.5" y1="12" x2="24" y2="4"'), `Relay normalmente aberto (repouso) deveria desenhar drawLine(-10.5,-16,8,-24), markup: ${relayOpen}`);
    assert(relayNc.includes('x1="6" y1="12" x2="26" y2="10"'), `Relay Norm_Close (repouso fechado) deveria desenhar drawLine(-10,-16,10,-18), markup: ${relayNc}`);
    assert((relayOpen.match(/<path/g) ?? []).length === 3, "Bobina do rele deveria reusar os 3 arcos de inductor.cpp");
  });

  await test("switches.keypad vem de package.simulidePaint com repeat rows/columns e labels reais", () => {
    catalogPackage("switches.keypad");
    const props = { rows: 4, columns: 4, keyLabels: "123A456B789C*0#D" };
    const box = componentBox("switches.keypad", props);
    assert(box.width === 80 && box.height === 76, `KeyPad 4x4 deveria incluir m_area 72x72 + leads SimulIDE, recebido ${JSON.stringify(box)}`);

    const rowPin0 = pinLocalPosition("pin-1", 0, 8, "switches.keypad", props);
    const rowPin3 = pinLocalPosition("pin-4", 3, 8, "switches.keypad", props);
    const colPin0 = pinLocalPosition("pin-5", 4, 8, "switches.keypad", props);
    const colPin3 = pinLocalPosition("pin-8", 7, 8, "switches.keypad", props);
    assert(near(rowPin0.x, 80) && near(rowPin0.y, 12), `1o pino de linha deveria ficar na ponta do lead direito, recebido ${JSON.stringify(rowPin0)}`);
    assert(near(rowPin3.x, 80) && near(rowPin3.y, 60), `4o pino de linha deveria ficar na ponta do lead direito, recebido ${JSON.stringify(rowPin3)}`);
    assert(near(colPin0.x, 12) && near(colPin0.y, 72), `1o pino de coluna deveria ficar na ponta do lead inferior, recebido ${JSON.stringify(colPin0)}`);
    assert(near(colPin3.x, 60) && near(colPin3.y, 72), `4o pino de coluna deveria ficar na ponta do lead inferior, recebido ${JSON.stringify(colPin3)}`);

    const svg = componentSymbolSvg("switches.keypad", props);
    assert(svg.includes('fill="#324664"'), `Corpo do KeyPad deveria seguir QColor(50,70,100) do SimulIDE, markup: ${svg}`);
    assert((svg.match(/<rect/g) ?? []).length === 17, `Deveria desenhar 1 corpo + 16 teclas (4x4), recebido ${(svg.match(/<rect/g) ?? []).length}`);
    assert(svg.includes(">A<") && svg.includes(">D<") && svg.includes(">*<"), `Rótulos das teclas deveriam vir de keyLabels real ("123A456B789C*0#D"), markup: ${svg}`);

    // keypad.cpp::createSwitches() cria Pin(...,length=4) por linha/coluna -- sem um <line> real de
    // lead desenhado, o KeyPad ficava sem NENHUM traço de terminal (só o círculo invisível de
    // hit-test que main.ts desenha à parte pra todo componente, package ou não).
    const leadLines = svg.match(/<line[^>]*stroke-width="3"[^>]*\/>/g) ?? [];
    assert(leadLines.length === 8, `KeyPad 4x4 deveria desenhar 8 leads grossos (4 linhas + 4 colunas), recebido ${leadLines.length}: ${svg}`);
    assert(svg.includes('x1="76.0" y1="12.0" x2="79.3" y2="12.0"'), `Lead da 1a linha deveria sair da borda direita ate o pino, markup: ${svg}`);
    assert(svg.includes('x1="12.0" y1="76.0" x2="12.0" y2="72.7"'), `Lead da 1a coluna deveria sair da borda inferior ate o pino, markup: ${svg}`);

    const wideProps = { rows: 2, columns: 5, keyLabels: "ABCDEFGHIJ" };
    const wideBox = componentBox("switches.keypad", wideProps);
    const lastCol = pinLocalPosition("pin-7", 6, 7, "switches.keypad", wideProps);
    const wideSvg = componentSymbolSvg("switches.keypad", wideProps);
    assert(wideBox.width === 96 && wideBox.height === 44, `KeyPad 2x5 deveria recalcular caixa por rows/columns, recebido ${JSON.stringify(wideBox)}`);
    assert(near(lastCol.x, 76) && near(lastCol.y, 40), `Ultimo pino de coluna 2x5 deveria vir do pinGroup dinamico, recebido ${JSON.stringify(lastCol)}`);
    assert((wideSvg.match(/<rect/g) ?? []).length === 11, `KeyPad 2x5 deveria desenhar 1 corpo + 10 teclas, markup: ${wideSvg}`);
  });

  // Pino dinâmico (2026-07-07) -- dynamicLayout de outputs.led_matrix/led_bar/active.analog_mux,
  // valores derivados do SimulIDE real (ledmatrix.cpp/ledbar.cpp/mux_analog.cpp), NÃO verificados
  // visualmente numa sessão interativa (sem GUI/harness de DOM neste projeto) -- ver
  // .spec/lasecsimul-native-devices.spec seção 7.1 e docs/22. Estes testes cobrem a FÓRMULA (caixa
  // cresce/encolhe certo, pinos de grupos consecutivos ficam no grid step certo, countFn/transform
  // "log2Ceil" resolve a contagem/posição certas) -- não substituem a conferência visual pendente.
  await test("outputs.led_matrix vem de package com dynamicLayout rows+columns (m_pin[row]/m_pin[rows+col], ledmatrix.cpp)", () => {
    catalogPackage("outputs.led_matrix");
    const props = { rows: 8, columns: 8 };
    const box = componentBox("outputs.led_matrix", props);
    // m_area real é 72x72 (cols*8+8/rows*8+8), mas componentBox() inclui a extensão do LEAD (row
    // pin sai 8px pra esquerda do corpo, angle=180) -- mesmo comportamento já existente pro keypad
    // (box.width sempre > m_area quando algum lead se projeta pra fora do corpo).
    assert(box.width === 88 && box.height === 72, `LedMatrix 8x8: m_area 72x72 + lead de 8px do pino de linha (angle 180) = 88 de largura, recebido ${JSON.stringify(box)}`);

    const row0 = pinLocalPosition("pin-1", 0, 16, "outputs.led_matrix", props);
    const row1 = pinLocalPosition("pin-2", 1, 16, "outputs.led_matrix", props);
    assert(near(row1.y - row0.y, 8) && near(row1.x, row0.x),
      `Pinos de linha consecutivos devem diferir 8px só em y (grid step real do LedMatrix), recebido row0=${JSON.stringify(row0)} row1=${JSON.stringify(row1)}`);

    const col0 = pinLocalPosition("pin-9", 8, 16, "outputs.led_matrix", props);
    const col1 = pinLocalPosition("pin-10", 9, 16, "outputs.led_matrix", props);
    assert(near(col1.x - col0.x, 8) && near(col1.y, col0.y),
      `Pinos de coluna consecutivos devem diferir 8px só em x, recebido col0=${JSON.stringify(col0)} col1=${JSON.stringify(col1)}`);

    const smallProps = { rows: 4, columns: 3 };
    const smallBox = componentBox("outputs.led_matrix", smallProps);
    assert(smallBox.width === 48 && smallBox.height === 40, `LedMatrix 4x3 deveria encolher a caixa junto (cols*8+8=32 + lead 16 = 48, rows*8+8=40), recebido ${JSON.stringify(smallBox)}`);

    const svg = componentSymbolSvg("outputs.led_matrix", smallProps);
    assert((svg.match(/<rect/g) ?? []).length === 1 + 4 * 3, `LedMatrix 4x3 deveria desenhar 1 corpo + 12 LEDs, recebido ${(svg.match(/<rect/g) ?? []).length}: ${svg}`);
  });

  await test("outputs.led_bar vem de package com dynamicLayout size (par P/N por LED, ledbar.cpp)", () => {
    catalogPackage("outputs.led_bar");
    const props = { size: 8 };
    const box = componentBox("outputs.led_bar", props);
    // m_area real é 16x64, mas os pinos P (y indo até -24) e N (tip.x=16, coincide com a borda,
    // sem expandir X) puxam o topo do box pra fora do corpo -- altura final inclui essa margem.
    assert(box.width === 32 && box.height === 88, `LedBar size=8: largura 16 + lead 16 (P estende 8px além de cada borda) = 32, altura 64 + margem do primeiro pino (y=-24) = 88, recebido ${JSON.stringify(box)}`);

    const p0 = pinLocalPosition("pin-P1", 0, 16, "outputs.led_bar", props);
    const p1 = pinLocalPosition("pin-P2", 1, 16, "outputs.led_bar", props);
    assert(near(p1.y - p0.y, 8) && near(p1.x, p0.x), `Pinos P consecutivos devem diferir 8px só em y, recebido p0=${JSON.stringify(p0)} p1=${JSON.stringify(p1)}`);

    // Numeração de id CRUZA os dois grupos (mesmo padrão do Core, resolveDynamicPins) -- o grupo N
    // continua a partir de onde o grupo P parou (size=8 -> N começa em pin-N9), nunca reinicia em 1.
    const n0 = pinLocalPosition("pin-N9", 0, 16, "outputs.led_bar", props);
    // P (tip x=-16) e N (tip x=+16) ficam nas pontas OPOSTAS dos leads, não nas bordas do corpo --
    // 32px de distância entre as PONTAS (16 de cada lado), não os 16px de largura do corpo em si.
    assert(near(n0.x - p0.x, 32), `Pino N deveria ficar na ponta do lead oposto (P tip=-16, N tip=+16, 32px de distância), recebido p0=${JSON.stringify(p0)} n0=${JSON.stringify(n0)}`);

    const smallProps = { size: 4 };
    const smallBox = componentBox("outputs.led_bar", smallProps);
    assert(smallBox.width === 32 && smallBox.height === 56, `LedBar size=4: largura fica igual (independe de size), altura encolhe (m_area 32 + margem do 1o pino em y=-24 = 56), recebido ${JSON.stringify(smallBox)}`);
  });

  await test("active.analog_mux vem de package com dynamicLayout channels + countFn/transform log2Ceil (mux_analog.cpp)", () => {
    catalogPackage("active.analog_mux");
    const props = { channels: 8 };
    const box = componentBox("active.analog_mux", props);
    // m_area real é 32x72, mas Z/En/Addr (angle=180, length=8) estendem 8px além da borda esquerda
    // (corpo em x=-16 -> tip em x=-24) -- box final inclui essa margem, altura já cabe no corpo.
    assert(box.width === 56 && box.height === 72, `AnalogMux 8 canais: área 32x72 + lead de 8px (Z/En/Addr) na borda esquerda = 56 de largura, recebido ${JSON.stringify(box)}`);

    // Z/En são pinos ESTÁTICOS (replacePins=false) -- sempre presentes, independente de channels.
    const z = pinLocalPosition("z", 0, 13, "active.analog_mux", props);
    const en = pinLocalPosition("en", 1, 13, "active.analog_mux", props);
    assert(near(en.x, z.x), `Z e En devem ficar na mesma borda (esquerda), recebido z=${JSON.stringify(z)} en=${JSON.stringify(en)}`);

    // 8 canais -> ceil(log2(8))=3 bits de endereço -- grupo "addr-" (countFn log2Ceil) deve ter
    // exatamente 3 pinos (addr-3..addr-5, numeração cruzando z/en fixos), grupo "chan-" (countFn
    // default) deve ter exatamente 8 (chan-6..chan-13, idStart via transform log2Ceil = 3+3=6).
    const addr0 = pinLocalPosition("addr-3", 0, 13, "active.analog_mux", props);
    const addr2 = pinLocalPosition("addr-5", 2, 13, "active.analog_mux", props);
    assert(near(addr2.y - addr0.y, 16), `3 pinos addr (ceil(log2(8))=3) devem cobrir 2 steps de 8px, recebido addr-3=${JSON.stringify(addr0)} addr-5=${JSON.stringify(addr2)}`);

    const chan0 = pinLocalPosition("chan-6", 0, 13, "active.analog_mux", props);
    const chan7 = pinLocalPosition("chan-13", 7, 13, "active.analog_mux", props);
    assert(near(chan7.y - chan0.y, 56), `8 pinos chan (channels=8) devem cobrir 7 steps de 8px, recebido chan-6=${JSON.stringify(chan0)} chan-13=${JSON.stringify(chan7)}`);
    assert(!near(chan0.x, addr0.x), `Canais ficam na borda OPOSTA aos endereços (chan angle=0 direita, addr angle=180 esquerda), recebido chan-6=${JSON.stringify(chan0)} addr-3=${JSON.stringify(addr0)}`);

    // channels=4 -> ceil(log2(4))=2 bits -- MENOS pinos de endereço, ids deslocam (addr-3/4,
    // chan-5..chan-8) -- prova que countFn/idStart recalculam juntos, não travam no valor default.
    const smallProps = { channels: 4 };
    const smallAddr1 = pinLocalPosition("addr-4", 1, 9, "active.analog_mux", smallProps);
    const smallChan0 = pinLocalPosition("chan-5", 0, 9, "active.analog_mux", smallProps);
    assert(near(smallAddr1.y, 32), `2o (ultimo) pino addr com channels=4 (2 bits) deveria ficar em y=24+1*8=32, recebido ${JSON.stringify(smallAddr1)}`);
    assert(near(smallChan0.y, 8), `1o pino chan com channels=4 deveria continuar em y=8 (offset do grupo, independente da contagem de bits), recebido ${JSON.stringify(smallChan0)}`);
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
  registerPackage("test.simulide-paint.matrix", undefined);
  finish();
})();

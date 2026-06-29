"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MockCoreServer_1 = require("../../ipc/testSupport/MockCoreServer");
const componentSymbols_1 = require("./componentSymbols");
(async () => {
    const { test, finish } = (0, MockCoreServer_1.createTestRunner)("componentSymbols — package real (Épico G)");
    const pkg = {
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
        (0, componentSymbols_1.registerPackage)("test.example", undefined);
        const box = (0, componentSymbols_1.componentBox)("test.example");
        (0, MockCoreServer_1.assert)(box.width === 70 && box.height === 40, `esperado box genérico, recebido {${box.width},${box.height}}`);
    });
    await test("com package registrado, componentBox usa o layout resolvido (com folga pra leads)", () => {
        (0, componentSymbols_1.registerPackage)("test.example", pkg);
        const box = (0, componentSymbols_1.componentBox)("test.example");
        // leads de 8px nos dois lados (vcc/gnd à esquerda, out à direita) -- largura cresce 8 pra cada lado
        (0, MockCoreServer_1.assert)(box.width === 76, `esperado largura 76 (60 + 8 esquerda + 8 direita), recebido ${box.width}`);
        (0, MockCoreServer_1.assert)(box.height === 40, `altura não deveria mudar (nenhum lead vertical), recebido ${box.height}`);
    });
    await test("pinLocalPosition casa por id, na ponta real do lead (corpo + length na direção do angle)", () => {
        (0, componentSymbols_1.registerPackage)("test.example", pkg);
        const outPos = (0, componentSymbols_1.pinLocalPosition)("out", 0, 3, "test.example");
        // offsetX = 8 (pra cobrir o lead de vcc/gnd que vai a x=-8) -- ponta de "out" = 60+8(lead)+8(offset) = 76
        (0, MockCoreServer_1.assert)(outPos.x === 76, `ponta de "out" esperada em x=76, recebido ${outPos.x}`);
        (0, MockCoreServer_1.assert)(outPos.y === 20, `y de "out" não deveria mudar, recebido ${outPos.y}`);
        const vccPos = (0, componentSymbols_1.pinLocalPosition)("vcc", 1, 3, "test.example");
        // ponta de vcc = 0 - 8(lead) + 8(offset) = 0
        (0, MockCoreServer_1.assert)(vccPos.x === 0, `ponta de "vcc" esperada em x=0, recebido ${vccPos.x}`);
    });
    await test("pinLocalPosition cai pro algoritmo genérico quando o id não está no package", () => {
        (0, componentSymbols_1.registerPackage)("test.example", pkg);
        const fallback = (0, componentSymbols_1.pinLocalPosition)("nao-existe", 0, 2, "test.example");
        // algoritmo genérico: índice par -> PIN_INSET (6) da borda esquerda do box resolvido (76)
        (0, MockCoreServer_1.assert)(fallback.x === 6, `esperado fallback genérico x=6, recebido ${fallback.x}`);
    });
    await test("packageSymbolSvg devolve undefined sem package, markup com package", () => {
        (0, componentSymbols_1.registerPackage)("test.example", undefined);
        (0, MockCoreServer_1.assert)((0, componentSymbols_1.packageSymbolSvg)("test.example") === undefined, "sem package registrado deveria devolver undefined");
        (0, componentSymbols_1.registerPackage)("test.example", pkg);
        const svg = (0, componentSymbols_1.packageSymbolSvg)("test.example");
        (0, MockCoreServer_1.assert)(typeof svg === "string" && svg.includes("OUT") && svg.includes("VCC") && svg.includes("GND"), "markup deveria conter o rótulo de cada pino declarado");
    });
    await test("packagePinLeadSvg gira o rótulo -90° só em lead vertical (angle 90/270) -- evita rótulos colados quando há muitos pinos apertados num lado (ex: topo do ESP32 nu)", () => {
        const verticalPkg = {
            width: 40,
            height: 40,
            pins: [
                { id: "top1", x: 10, y: 0, angle: 270, length: 8, label: "TOP1" },
                { id: "side1", x: 0, y: 10, angle: 180, length: 8, label: "SIDE1" },
            ],
        };
        (0, componentSymbols_1.registerPackage)("test.vertical", verticalPkg);
        const svg = (0, componentSymbols_1.packageSymbolSvg)("test.vertical");
        (0, MockCoreServer_1.assert)(svg.includes('rotate(-90') && /rotate\(-90[^)]*\)">TOP1/.test(svg), "pino vertical (angle 270) deveria ter <text> com transform rotate(-90...)");
        (0, MockCoreServer_1.assert)(!/rotate\(-90[^)]*\)">SIDE1/.test(svg), "pino horizontal (angle 180) não deveria girar o rótulo");
    });
    await test("packagePinLeadSvg usa labelX/labelY do pino quando presentes, sem girar (posição já escolhida pelo usuário)", () => {
        const customLabelPkg = {
            width: 40,
            height: 40,
            pins: [{ id: "top1", x: 10, y: 0, angle: 270, length: 8, label: "TOP1", labelX: 20, labelY: 20 }],
        };
        (0, componentSymbols_1.registerPackage)("test.customlabel", customLabelPkg);
        const svg = (0, componentSymbols_1.packageSymbolSvg)("test.customlabel");
        (0, MockCoreServer_1.assert)(svg.includes('x="20.0" y="20.0"'), `texto deveria ficar na posição customizada (20,20), markup: ${svg}`);
        (0, MockCoreServer_1.assert)(!svg.includes("rotate(-90"), "com labelX/labelY explícitos, não deveria girar automaticamente (usuário já escolheu a posição)");
        (0, componentSymbols_1.registerPackage)("test.customlabel", undefined);
    });
    await test("hasRealPinPosition: sem package, qualquer pinId tem posição (algoritmo genérico já é a posição real)", () => {
        (0, componentSymbols_1.registerPackage)("test.example", undefined);
        (0, MockCoreServer_1.assert)((0, componentSymbols_1.hasRealPinPosition)("test.example", "qualquer-id") === true, "sem package deveria sempre devolver true");
    });
    await test("hasRealPinPosition: com package, só pinId presente no package tem posição -- ex: GPIO elétrico sem lead físico no encapsulamento", () => {
        (0, componentSymbols_1.registerPackage)("test.example", pkg);
        (0, MockCoreServer_1.assert)((0, componentSymbols_1.hasRealPinPosition)("test.example", "out") === true, "pino real do package deveria ter posição");
        (0, MockCoreServer_1.assert)((0, componentSymbols_1.hasRealPinPosition)("test.example", "pin-eletrico-sem-lead") === false, "pino elétrico sem lead físico no package não deveria ter posição (não desenha terminal genérico por cima)");
    });
    (0, componentSymbols_1.registerPackage)("test.example", undefined);
    (0, componentSymbols_1.registerPackage)("test.vertical", undefined);
    finish();
})();
//# sourceMappingURL=componentSymbols.test.js.map
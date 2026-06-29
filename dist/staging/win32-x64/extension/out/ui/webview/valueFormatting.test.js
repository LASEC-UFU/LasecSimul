"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const MockCoreServer_1 = require("../../ipc/testSupport/MockCoreServer");
const valueFormatting_1 = require("./valueFormatting");
(async () => {
    const { test, finish } = (0, MockCoreServer_1.createTestRunner)("valueFormatting — testes puros");
    await test("valor zero devolve '0 <unidade>' sem prefixo", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(0, "Ω") === "0 Ω", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(0, "Ω")}`);
    });
    await test("valor zero com unidade vazia devolve só '0'", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(0, "") === "0", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(0, "")}`);
    });
    await test("prefixo k (quilo), mantissa < 10 usa 2 decimais", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(1000, "Ω") === "1.00 kΩ", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(1000, "Ω")}`);
    });
    await test("prefixo k, mantissa entre 10 e 100 usa 1 decimal", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(15_000, "Ω") === "15.0 kΩ", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(15_000, "Ω")}`);
    });
    await test("prefixo k, mantissa >= 100 usa 0 decimais", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(150_000, "Ω") === "150 kΩ", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(150_000, "Ω")}`);
    });
    await test("prefixo M (mega)", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(2_500_000, "Ω") === "2.50 MΩ", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(2_500_000, "Ω")}`);
    });
    await test("prefixo G (giga)", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(1e9, "Hz") === "1.00 GHz", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(1e9, "Hz")}`);
    });
    await test("prefixo µ (micro)", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(1e-6, "F") === "1.00 µF", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(1e-6, "F")}`);
    });
    await test("prefixo n (nano)", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(1e-9, "F") === "1.00 nF", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(1e-9, "F")}`);
    });
    await test("prefixo p (pico)", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(1e-12, "F") === "1.00 pF", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(1e-12, "F")}`);
    });
    await test("prefixo m (mili)", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(0.005, "A") === "5.00 mA", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(0.005, "A")}`);
    });
    await test("sem prefixo (entre 1 e 1000), unidade vazia não deixa espaço sobrando", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(5, "") === "5.00", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(5, "")}`);
    });
    await test("valor negativo preserva o sinal", () => {
        (0, MockCoreServer_1.assert)((0, valueFormatting_1.formatEngineeringValue)(-1000, "Ω") === "-1.00 kΩ", `recebido: ${(0, valueFormatting_1.formatEngineeringValue)(-1000, "Ω")}`);
    });
    const { failed } = finish();
    process.exitCode = failed > 0 ? 1 : 0;
})();
//# sourceMappingURL=valueFormatting.test.js.map
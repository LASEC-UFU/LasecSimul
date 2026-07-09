import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { formatEngineeringValue, defaultSiPrefixFactor } from "./valueFormatting";

(async () => {
  const { test, finish } = createTestRunner("valueFormatting — testes puros");

  await test("valor zero devolve '0 <unidade>' sem prefixo", () => {
    assert(formatEngineeringValue(0, "Ω") === "0 Ω", `recebido: ${formatEngineeringValue(0, "Ω")}`);
  });

  await test("valor zero com unidade vazia devolve só '0'", () => {
    assert(formatEngineeringValue(0, "") === "0", `recebido: ${formatEngineeringValue(0, "")}`);
  });

  await test("prefixo k (quilo), mantissa < 10 usa 2 decimais", () => {
    assert(formatEngineeringValue(1000, "Ω") === "1.00 kΩ", `recebido: ${formatEngineeringValue(1000, "Ω")}`);
  });

  await test("prefixo k, mantissa entre 10 e 100 usa 1 decimal", () => {
    assert(formatEngineeringValue(15_000, "Ω") === "15.0 kΩ", `recebido: ${formatEngineeringValue(15_000, "Ω")}`);
  });

  await test("prefixo k, mantissa >= 100 usa 0 decimais", () => {
    assert(formatEngineeringValue(150_000, "Ω") === "150 kΩ", `recebido: ${formatEngineeringValue(150_000, "Ω")}`);
  });

  await test("prefixo M (mega)", () => {
    assert(formatEngineeringValue(2_500_000, "Ω") === "2.50 MΩ", `recebido: ${formatEngineeringValue(2_500_000, "Ω")}`);
  });

  await test("prefixo G (giga)", () => {
    assert(formatEngineeringValue(1e9, "Hz") === "1.00 GHz", `recebido: ${formatEngineeringValue(1e9, "Hz")}`);
  });

  await test("prefixo µ (micro)", () => {
    assert(formatEngineeringValue(1e-6, "F") === "1.00 µF", `recebido: ${formatEngineeringValue(1e-6, "F")}`);
  });

  await test("prefixo n (nano)", () => {
    assert(formatEngineeringValue(1e-9, "F") === "1.00 nF", `recebido: ${formatEngineeringValue(1e-9, "F")}`);
  });

  await test("prefixo p (pico)", () => {
    assert(formatEngineeringValue(1e-12, "F") === "1.00 pF", `recebido: ${formatEngineeringValue(1e-12, "F")}`);
  });

  await test("prefixo m (mili)", () => {
    assert(formatEngineeringValue(0.005, "A") === "5.00 mA", `recebido: ${formatEngineeringValue(0.005, "A")}`);
  });

  await test("sem prefixo (entre 1 e 1000), unidade vazia não deixa espaço sobrando", () => {
    assert(formatEngineeringValue(5, "") === "5.00", `recebido: ${formatEngineeringValue(5, "")}`);
  });

  await test("valor negativo preserva o sinal", () => {
    assert(formatEngineeringValue(-1000, "Ω") === "-1.00 kΩ", `recebido: ${formatEngineeringValue(-1000, "Ω")}`);
  });

  await test("defaultSiPrefixFactor: 0 cai no fator neutro (1, sem prefixo)", () => {
    assert(defaultSiPrefixFactor(0) === 1, `recebido: ${defaultSiPrefixFactor(0)}`);
  });

  await test("defaultSiPrefixFactor: 4.7e-6 (4.7µF) escolhe o fator µ (1e-6)", () => {
    assert(defaultSiPrefixFactor(4.7e-6) === 1e-6, `recebido: ${defaultSiPrefixFactor(4.7e-6)}`);
  });

  await test("defaultSiPrefixFactor: 1000 (1kΩ) escolhe o fator k (1e3), não o neutro", () => {
    assert(defaultSiPrefixFactor(1000) === 1e3, `recebido: ${defaultSiPrefixFactor(1000)}`);
  });

  await test("defaultSiPrefixFactor: 999 fica no fator neutro (1), abaixo do limiar de k", () => {
    assert(defaultSiPrefixFactor(999) === 1, `recebido: ${defaultSiPrefixFactor(999)}`);
  });

  await test("defaultSiPrefixFactor: valor negativo usa a magnitude, mesmo fator do positivo", () => {
    assert(defaultSiPrefixFactor(-4.7e-6) === 1e-6, `recebido: ${defaultSiPrefixFactor(-4.7e-6)}`);
  });

  await test("defaultSiPrefixFactor: valor menor que pico (1e-15) cai no menor fator da tabela (pico)", () => {
    assert(defaultSiPrefixFactor(1e-15) === 1e-12, `recebido: ${defaultSiPrefixFactor(1e-15)}`);
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

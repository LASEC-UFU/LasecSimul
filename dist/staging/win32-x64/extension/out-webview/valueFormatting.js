/** Formatação pura de valores de engenharia — sem DOM, extraído de `main.ts` para teste isolado
 * (Épico E do roadmap de pendências). */
const SI_PREFIXES = [
    [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"],
];
/** Porta `valToUnit` do SimulIDE-dev (`utils.h`) — escolhe o prefixo SI que mantém a mantissa abaixo
 * de 1000 (ex: `1000` Ω → `"1 kΩ"`, `1e-6` F → `"1 µF"`), usado pro rótulo de valor no canvas. Valor
 * exatamente 0 ou sem prefixo que sirva (>= 1000 G ou < 1 p) cai pro número crú sem prefixo. */
export function formatEngineeringValue(value, unit) {
    if (value === 0)
        return `0 ${unit}`.trim();
    const magnitude = Math.abs(value);
    for (const [factor, prefix] of SI_PREFIXES) {
        if (magnitude >= factor) {
            const mantissa = value / factor;
            const decimals = magnitude >= factor * 100 ? 0 : magnitude >= factor * 10 ? 1 : 2;
            return `${mantissa.toFixed(decimals)} ${prefix}${unit}`.trim();
        }
    }
    return `${value} ${unit}`.trim();
}
//# sourceMappingURL=valueFormatting.js.map
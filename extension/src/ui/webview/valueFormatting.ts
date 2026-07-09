/** Formatação pura de valores de engenharia — sem DOM, extraído de `main.ts` para teste isolado
 * (Épico E do roadmap de pendências). */

/** Exportado (não só interno) -- reaproveitado pelo seletor de múltiplo de unidade dos campos
 * numéricos do painel de propriedades (`main.ts`, achado de auditoria de UI 2026-07-09: SimulIDE
 * tem um combobox de unidade ao lado do spinbox, `NumVal::addMultipliers`, LasecSimul não tinha). */
export const SI_PREFIXES: Array<[number, string]> = [
  [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"],
];

/** Prefixo SI cujo fator mantém a mantissa exibida abaixo de 1000 pro valor atual -- MESMA regra de
 * `formatEngineeringValue`, extraída pra escolher a opção inicial do seletor de múltiplo (não só
 * formatar texto read-only). `0` cai no fator neutro (`1`, sem prefixo). */
export function defaultSiPrefixFactor(value: number): number {
  if (value === 0) return 1;
  const magnitude = Math.abs(value);
  for (const [factor] of SI_PREFIXES) {
    if (magnitude >= factor) return factor;
  }
  return SI_PREFIXES[SI_PREFIXES.length - 1]?.[0] ?? 1e-12;
}

/** Porta `valToUnit` do SimulIDE-dev (`utils.h`) — escolhe o prefixo SI que mantém a mantissa abaixo
 * de 1000 (ex: `1000` Ω → `"1 kΩ"`, `1e-6` F → `"1 µF"`), usado pro rótulo de valor no canvas. Valor
 * exatamente 0 ou sem prefixo que sirva (>= 1000 G ou < 1 p) cai pro número crú sem prefixo. */
export function formatEngineeringValue(value: number, unit: string): string {
  if (value === 0) return `0 ${unit}`.trim();
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

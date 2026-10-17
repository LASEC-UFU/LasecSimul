# ADR 0014 - Núcleo matemático, editor de equações e ícones próprios (GeoGebra como referência)

## Objetivo

Escolher como o Laboratório de Cálculo avalia expressões, faz Cálculo (∫, d/dx, lim, Σ), desenha funções, edita
equações e exibe símbolos e ícones.

## Status

Aceita (decisão do usuário em 2026-10-16: estratégia A) e implementada em `extension/src/ui/webview/lab/` (2026-10-17). Marcos M1/M2 de
[`docs/54`](../54-laboratorio-calculo-validacao-e-riscos.md). Análise em [`docs/57`](../57-laboratorio-calculo-geogebra-e-estrategia.md).

## Contexto

- A Webview é ESM gerado por `tsc`, sem bundler, sem dependências de runtime, sob CSP sem `'unsafe-eval'`.
- Compute Engine: núcleo ≈ 4,2 MB, `compile()` gera código em runtime. MathLive: ≈ 844 KB + fontes e exige o Compute
  Engine para MathJSON. GeoGebra embutido: não carrega sob a CSP da Webview, 49 MB, bundle não comercial.
- PoC própria: 74 + 25 + 19 verificações, sem `eval`, CSP atual, 2,3 MiB de heap.

## Decisão

Implementação própria em TypeScript: parser com allowlist e compilação por closures; operadores de Cálculo com
proveniência (exato × numérico); grafo de dependências com poda por valor; plotter adaptativo; MathML Core para
equações; editor estruturado com templates (fração, potência, raiz, módulo, funções, ∫, d/d□, lim, Σ, Π); teclado em
abas; ícones SVG próprios. Comportamentos do GeoGebra são estudados, nunca copiados; recursos dele (CC BY-NC-SA)
não são usados.

## Consequências

- Nenhuma dependência nova; nenhuma restrição de licença adicional.
- Sem CAS geral: limites exatos só por continuidade, cancelamento de fator comum e graus; o resto é evidência numérica rotulada.

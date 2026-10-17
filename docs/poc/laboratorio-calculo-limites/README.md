# PoC isolada — Laboratório de Cálculo (estratégia A: implementação própria)

> **Produção (2026-10-17):** o laboratório foi implementado na extensão (`extension/src/ui/webview/lab/`, `extension/src/lab/`)
> e no Core (`SignalRecorder`, `control.accumulator`, `subcircuits/process_hydraulic_tank.lssubcircuit`); estado e diferenças
> em [54 §0](../../54-laboratorio-calculo-validacao-e-riscos.md). Esta pasta fica como referência e oráculo (`accumulator.mjs`).

**Não é código de produção.** Pasta fora de qualquer build ou pacote da extensão. Serve para resolver dúvidas de
integração do plano ([57](../../57-laboratorio-calculo-geogebra-e-estrategia.md), [51](../../51-laboratorio-calculo-arquitetura-e-dados.md),
[53](../../53-laboratorio-calculo-experimentos-e-tanque.md)). O GeoGebra foi usado só como referência de comportamento;
nenhum código ou recurso dele está aqui (exceto o harness da estratégia C em `ggb/`, que carrega o bundle oficial baixado à parte).

| Arquivo | Papel |
|---|---|
| `math.mjs` | parser (allowlist, multiplicação implícita, funções do usuário), AST tipo MathJSON, compilação por closures **sem `eval`**, operadores **∫, d/dx, lim (bilateral, ⁺, ⁻), Σ, Π** com proveniência exata/numérica, derivação simbólica (inclui TFC/Leibniz), polinômios, MathML |
| `engine.mjs` | grafo de dependências incremental com poda por valor, quociente incremental, amostrador adaptativo; reexporta `math.mjs` |
| `editor.mjs` | **editor de equações estruturado próprio** (árvore, cursor por campos, placeholders, `/` puxa o operando, `^`, `|`, funções digitadas viram template, Ctrl+A, MathML) |
| `palette.mjs` | teclado matemático (abas 123, f(x), Cálculo) com faces em MathML e placeholders |
| `icons.mjs` | ícones SVG próprios (ferramentas, execução, lados) — não derivam dos ícones do GeoGebra (CC BY-NC-SA) |
| `index.html`, `app.mjs`, `styles.css` | atividade de Limites + editor do modelo h(t) + calculadora de Cálculo |
| `accumulator.mjs` | implementação de **referência** do acumulador conservativo do Core (oráculo para testes C++) com limite superior ao vivo |
| `series.mjs` | gravador colunar, leituras linear/por passo, ∫ exato da série, Riemann sobre dados gravados |
| `tank-sim.mjs` | substituto do Core **só para a PoC** (passo 10 ms, parâmetros na fronteira com `appliedAtNs`, eventos) |
| `tanque.html`, `tank-app.mjs`, `tank.css` | vertical do tanque com **área A ajustável durante a execução**, gráficos em camadas, cursor, Riemann, equações |
| `verify.mjs`, `e2e.mjs`, `e2e-tanque.mjs`, `server.mjs` | verificações em Node e em Edge headless (Playwright da extensão) |
| `ggb/` | estratégia C: GeoGebra oficial embutido (bundle baixado à parte, não versionado) |

## Como reproduzir

```sh
node docs/poc/laboratorio-calculo-limites/server.mjs        # abre em http://127.0.0.1:8123/index.html e /tanque.html
node docs/poc/laboratorio-calculo-limites/verify.mjs
node docs/poc/laboratorio-calculo-limites/e2e.mjs           # requer extension/node_modules e Microsoft Edge
node docs/poc/laboratorio-calculo-limites/e2e-tanque.mjs
GGB_BUNDLE_DIR=<pasta com deployggb.js> node docs/poc/laboratorio-calculo-limites/ggb/ggb-e2e.mjs
```

## Resultados registrados em 2026-10-16 (Windows Server 2025, Edge headless, Playwright 1.61.1)

Medidas de desempenho são **indicativas** (uma máquina, headless, fora do VS Code).

**`verify.mjs` — 74 verificações**
- Limites: tabela 4,5/3,5 · 4,05/3,95 · 4,005/3,995; `lim Δt→0 [h(4+Δt)−h(4)]/Δt = 4` **exato** (cancelamento de fator comum);
  `(x²−1)/(x−1)` → 2 exato; `sen x/x` → 1 como **evidência numérica**; `|x|/x` → laterais −1/+1, "não existe"; `1/x` em 0⁺ → +∞;
  `sen(1/x)` → "sem convergência observada"; `(3x²+1)/(x²−5)` em ∞ → 3.
- Integrais: ∫₀⁴ 0,5t² = 32/3 exato (antiderivada); ∫₀^π sen = 2 numérico (Simpson adaptativo); ∫₋₁¹ x = 0.
- Derivadas: d/dt 0,5t² = t; TFC d/dx ∫₀ˣ s² ds = x²; d/dx |x| em 0 = "não diferenciável (canto)".
- Σ/Π: Σk = 5050; Πk = 120; Riemann à esquerda de h em [0,4] com n = 8 = 8,75.
- Editor: `/` leva só o operando à esquerda; `sin` vira template; templates ∫, lim⁺, Σ, d/dt geram expressões avaliáveis; Backspace desfaz
  parênteses mantendo o conteúdo; AST recarregado mantém `h(...)`.
- Tanque: ΔV = 6 L em 10 s; transbordo em 133,333… s (±1 ns); esvazia em 10 s com `unmet = 2 L/s`; resíduo ≤ 3,4e-16 m³;
  válvula vs exponencial: erro relativo 3,0e-5; **A ao vivo** 0,1 → 0,04 m² derrama 10 L como evento discreto, h salta 0,5 → 1,0 m
  (duas linhas no mesmo instante), passado intacto; A 0,1 → 0,2 m² preserva V; V0 recusado em execução; parâmetro em pausa aplicado na hora.
- Riemann sobre dados gravados (válvula, [0, 50 s]): esquerda converge ~1/n (2,0e-3 → 1,9e-4 → 1,7e-5 m³); ponto médio/trapézio ~100×
  melhores com n = 50; **piso de ~1e-6 m³ (≈7e-5·ΔV) imposto pela amostragem de 10 ms**, que só some quando cada retângulo coincide
  com um passo. Isso é efeito da amostragem, não do método.
- Nenhum `eval`/`new Function` nos módulos.

**`e2e.mjs` — 25 verificações** (página de Limites)
- Arraste de Q (60 movimentos) sem recalcular curva/tabela/P; 1 redesenho por quadro; foco preservado; entrada→fim do quadro p95 ≈ 2 ms.
- Digitar `t^3` no editor recalcula tudo: tabela 61/37 · 49,21/46,81, limite exato 48 cm/s, quociente `48 + 12Δt + Δt²`, calculadora 48.
- Montar ∫₀¹ x² dx pela **paleta** + teclado → 0,3333333333 (exato); exemplos d/dt h (3t², 48 em t = 4), lim |x|/x, lim sen x/x.
- Zero violações de CSP, zero erros, zero requisições externas.

**`e2e-tanque.mjs` — 19 verificações**
- Slider de A durante a execução: evento em t = 50 s, derramamento de 10 L, vertedouro mostra 0,6 L/s, traçado de h quebrado, resíduo 8,8e-15 m³.
- Cursor, método, n e marcador b: **zero escritas** no simulador; mover o cursor **não redesenha a série** (gráfico em camadas):
  p95 da inspeção caiu de 13,5 ms para 8,4 ms com essa separação.
- Riemann atravessando a mudança de A: `V(b) − V(a) = ∫q − derramamentos` (fechamento 2e-12 L); o ponto médio erra 0,072 L porque q salta em 50 s.
- V0 recusado em execução; q_in em pausa aplicado no tempo pausado; Reiniciar zera geração; modo válvula converge (erro 1,96 L → 0,046 L).

**`ggb/ggb-e2e.mjs`** (GeoGebra 5.4.932.1): não carrega sob CSP de Webview; carrega com `'strict-dynamic'` + nonce + `'wasm-unsafe-eval'`;
≈ 0,93 s; 7,9 MiB na partida; heap ≈ 44 MiB; arredondamento padrão esconde a convergência; `Point(h)` projeta no ponto euclidiano mais próximo.

**Não verificado:** execução dentro de uma Webview real do VS Code (origem `vscode-webview://`, `asWebviewUri`, MathML no Electron mínimo).

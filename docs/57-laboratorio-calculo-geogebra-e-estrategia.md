# Laboratório de Cálculo — GeoGebra como referência técnica e escolha de estratégia

**Estado:** investigação concluída em 2026-10-16. Marcas de evidência: **[C]** código, **[E]** execução, **[I]** inferência,
**[P]** proposta (ver [50](50-laboratorio-calculo-investigacao.md)).

## 1. O que foi analisado

| Item | Versão / origem |
|---|---|
| Código-fonte | `github.com/geogebra/geogebra` @ `ae21d67840755a15a3874aa4618c903b110d0d7c` (2026-10-15), checkout esparso de 118 arquivos (~85 mil linhas) em `source/shared/common` e `source/web/web-common` |
| Bundle offline | `geogebra-math-apps-bundle-5-4-932-1.zip`, 33,4 MB, sha256 `c139f3edb51c004ec67d83226a1f1215486f8559ad98ee37e9e775aac278e96e`, baixado em 2026-10-16 de `download.geogebra.org` |
| Licença | [geogebra_license.md](https://github.com/geogebra/legal/blob/main/geogebra_license.md) (atualizada em novembro de 2025) e cabeçalho de cada arquivo `.java` |
| API e incorporação | [Apps API](https://geogebra.github.io/docs/reference/en/GeoGebra_Apps_API/), [Embedding](https://geogebra.github.io/docs/reference/en/GeoGebra_Apps_Embedding/), [geogebra/integration](https://github.com/geogebra/integration) |

O GeoGebra **não** é uma biblioteca de gráficos: é um aplicativo Java compilado para JavaScript por GWT, com núcleo
(`kernel`), visões (`euclidian`, álgebra, planilha), CAS externo (Giac em WebAssembly) e renderizador LaTeX próprio
(`retex`) **[C]**. Nada disso é um pacote npm isolável.

## 2. Mapa dos fluxos reais (caminhos relativos a `source/shared/common/src/main/java/org/geogebra/common/`)

### 2.1 Criação e dependências

`AlgoElement.setDependencies()` chama `input[i].addAlgorithm(this)` → `GeoElement.addToUpdateSets(algo)`, que insere o
algoritmo no `algoUpdateSet` do insumo **e propaga para cima** pelos insumos do `algoParent`, até as fontes livres **[C]**
(`kernel/algos/AlgoElement.java`, `kernel/geos/GeoElement.java`). Cada objeto mantém, portanto, o conjunto **transitivo**
de algoritmos dependentes. `AlgorithmSet` é lista ligada + `HashSet`, ordenada pela ordem de inserção/índice de construção,
que é topológica porque um algoritmo só pode usar objetos já existentes **[C]** (`kernel/algos/AlgorithmSet.java`).

### 2.2 Alteração e propagação

```text
GeoElement.updateCascade(dragging)
  kernel.notifyBatchUpdate()                       -> views.startBatchUpdate()
  update(): updateGeo(...); kernel.notifyUpdate(this) -> cada View.update(geo)
  updateDependentObjects(): cons.updateAllAlgosInSet(algoUpdateSet)
      AlgorithmSet.updateAll(): para cada algo, em ordem: algo.update()
          AlgoElement.update(): compute(); updateDependentGeos() -> output.update() -> notifyUpdate
  kernel.notifyEndBatchUpdate()
GeoElement.updateRepaint() = updateCascade() + kernel.notifyRepaint()
```

[C] `GeoElement.java` (~linhas 3091–3347), `AlgoElement.java` (`update`, `updateDependentGeos`), `Kernel.java`
(`notifyUpdate`, `notifyRepaint`, `notifyBatchUpdate`). Observação importante: **não há poda por valor** — todo algoritmo do
conjunto transitivo recalcula, mesmo que seus insumos não tenham mudado de valor **[C]**. `GeoElement.updateCascade(List, …)`
une os conjuntos de várias fontes antes de recalcular (lote) **[C]**.

### 2.3 Desenho

`EuclidianView.update(geo)` só marca `drawable.setNeedsUpdate(true)` (salvo rastro), e a geometria é recalculada no próximo
paint (`Drawable` ~linha 1049) **[C]**. Na web, `EuclidianViewW.repaint()` arma o `TimerSystemW` e o desenho ocorre em
`requestAnimationFrame` (`doRepaint2`) **[C]** (`source/web/web-common/.../euclidian/EuclidianViewW.java`). Modelo calcula
imediatamente; desenho é preguiçoso e coalescido por quadro.

### 2.4 Interação

- Coordenadas: `EuclidianView.toScreenCoordX/Xd` e `toRealWorldCoordX`, a partir de `xZero`, `yZero`, `xscale`, `yscale`;
  zoom/pan por `setCoordSystem` e `CoordSystemAnimation` **[C]**.
- Arraste: `EuclidianController.handleMouseDragged` → `transformCoords()` (`xRW = (mouse.x − xZero) · invXscale`, com captura
  de grade) → `movePoint…` → `setCoords` → `updateCascade()`; o undo é gravado ao soltar (`storeUndoInfo`) **[C]**.
  Limiar de toque/mouse: `app.getCapturingThreshold(eventType)` **[C]**.
- Ponto sobre função: `GeoFunction.pointChanged` limita x ao intervalo ou ao domínio de um `If[...]` e faz `y = f(x)`; para
  polinômios usa `closestPoly`, isto é, o **ponto mais próximo** em coordenadas de mundo **[C]**. Medido: `Point(h)` com
  `setCoords(4,5; 0)` foi parar em (1,7625; 1,5532) **[E]** — inadequado quando eixos têm escalas e unidades diferentes (s × cm).
- Undo: `UndoManager.storeUndoInfo(construction.getCurrentUndoXML(true))`, snapshots XML da construção inteira, até 100 **[C]**
  (`main/undo/UndoManager.java`, `DefaultUndoManager.java`, web `UndoManagerW.java`).

### 2.5 Núcleo matemático

| Tema | Implementação no GeoGebra | Evidência |
|---|---|---|
| Expressões | `ExpressionNode` (árvore) + enum `Operation` (2 843 linhas); avaliação numérica direta; indefinido = `NaN` | [C] `kernel/arithmetic`, `plugin/Operation.java` |
| Por partes | `Operation.IF`, `IF_ELSE`, `IF_LIST` | [C] |
| Derivada | `Function.getDerivative`: (1) polinômio sem CAS; (2) regras internas `Derivative.get` (~111 casos); (3) Giac | [C] |
| Armadilhas da derivada interna | `IF` derivado **ramo a ramo, sem verificar continuidade na fronteira**; `FLOOR`/`ROUND`/`CEIL` → 0 em toda parte, inclusive nos saltos; `ABS` → `u'·u/|u|` (NaN só exatamente em 0) | [C] `kernel/arithmetic/Derivative.java` |
| Integral definida | tenta antiderivada do CAS (com salvaguardas para divisão pela variável/descontinuidades); senão Gauss-Legendre adaptativo de duas ordens (Apache Commons Math), orçamento de chamadas → `NaN` | [C] `kernel/cas/AlgoIntegralDefinite.java` |
| Somas de Riemann | `AlgoFunctionAreaSums` (`UPPERSUM`, `LOWERSUM`, `LEFTSUM`, `RECTANGLESUM`, `TRAPEZOIDALSUM`…), até 10 000 retângulos; superior/inferior usam subamostragem **da região visível** (5 px), então o número pode mudar com o zoom | [C] `kernel/algos/AlgoFunctionAreaSums.java` ~800–920 |
| Limite | `AlgoLimit` monta a string e chama `kernel.evaluateCachedGeoGebraCAS` (Giac); sem CAS, indefinido; assíncrono | [C] `kernel/cas/AlgoLimit.java`; [E] resposta 4 após ~3 s |
| Gráfico de função | `DrawParametricCurve` escolhe `IntervalPlotter` (aritmética intervalar, 1 amostra por pixel, reaproveita dados no pan, intervalos invertidos para assíntotas) quando todas as operações são suportadas; senão `CurveSegmentPlotter` (Gillam: bisseção diádica com pilha, ≤10 px e ≤10°, profundidade 16, teste de continuidade por encolhimento da distância, `moveTo` em saltos) | [C] `euclidian/plot/**`, `kernel/interval/**` |
| Exato × numérico × visual | não há marcação sistemática: o mesmo `GeoNumeric` pode vir do CAS ou de quadratura; a exibição arredonda (2 casas por padrão) | [C]; [E] `q = 4` exibido para Δt = 0,01 |

## 3. Mecanismos do GeoGebra × necessidades do LasecSimul

| Necessidade | Mecanismo de referência | Decisão para o LasecSimul |
|---|---|---|
| Arrastar Q e atualizar só o que depende de Q | `algoUpdateSet` transitivo em ordem topológica | **Adotar a ideia** no `LabGraph` [P]; **melhorar** com poda por valor e lote (PoC: arraste não recalcula curva/tabela/P) [E] |
| Atualização visual fluida | `setNeedsUpdate` + rAF | **Adotar**: invalidação por insumo, um desenho por quadro [E] |
| Ponto restrito à curva | `pointChanged` | **Adaptar**: parametrizar por t (x do ponteiro, y = f(t)), domínio limitado; **não** usar o mais próximo euclidiano [E] |
| Curva com assíntotas | Gillam + teste de continuidade; plotter intervalar | **Adotar Gillam** (PoC) [E]; avaliar intervalar depois (M7) se aparecerem falsos ramos |
| Riemann | `AlgoFunctionAreaSums` | **Reimplementar** sem dependência da janela visível: resultado numérico independente do zoom |
| Integral numérica | Gauss-Legendre adaptativo de duas ordens | **Adotar a ideia** (Gauss-Kronrod/Simpson adaptativo com estimativa de erro e orçamento) para funções; trapézio com Δt real para séries |
| Derivada | polinômio → regras → CAS | **Adotar a escada**, corrigindo: fronteiras de por partes e funções escada devolvem "não diferenciável/indeterminado" |
| Limite | CAS | **Não depender de CAS** no MVP: exato só para quociente polinomial/racional simplificável; demais casos = evidência numérica rotulada |
| Undo | snapshot XML por gesto completo | **Já é o modelo** do `main.ts`; gravar só ao soltar, como o GeoGebra |
| Integração externa | API por strings + listeners por objeto | **Não adotar**: contratos tipados internos |
| Editor de equações | `editor-base`: árvore `Formula/SequenceNode/FunctionNode/ArrayNode/PlaceholderNode`; `InputController.handleChar` (`/` → `frac` com `ArgumentHelper.passArgument`, `^` → expoente, `|` → `abs`, √); templates `$defint`, `$limeq`, `$sumeq`, `$prodeq` em `catalog/Tag.java` [C] | **Reimplementar** o modelo e os comportamentos (editor próprio, PoC [E]); acrescentar d/d□ e lim⁺/lim⁻, que não aparecem como templates em `Tag.java` no commit analisado |
| Teclado matemático | `keyboard-base` (`MathKeyboardFactory`: x, y, π, e, x², xᵇ, √, \|x\|, <, >, parênteses) [C] | **Reimplementar** a organização em abas, com aba própria de Cálculo |
| Ícones e estilos | recursos de UI sob CC BY-NC-SA 4.0 [C] | **Não usar**; conjunto SVG próprio |

## 4. Comparação das estratégias

| Critério | A. Implementação própria guiada pela referência | B. Reaproveitar código | C. Incorporar o aplicativo |
|---|---|---|---|
| Integração Core/Host/Webview | nativa: séries e tempo do Core entram no mesmo grafo | código Java acoplado a `Kernel`/`Construction`/`GeoElement` (classes de 3–12 mil linhas) | dados do Core teriam de ser copiados para listas do GeoGebra por API de strings |
| Offline / empacotamento | ESM local, sem bundler novo | porte manual para TS | 49 MB (variante `web3d`) a 117 MB; bundle **não comercial** dentro de um VSIX GPL |
| CSP | CSP atual da Webview, sem `eval` [E] | idem A | exige `'strict-dynamic'` com nonce (ou `'unsafe-inline'`) + `'wasm-unsafe-eval'` + `font-src data:` [E] |
| Partida / memória (indicativo) | 1º quadro ≈ 135 ms, heap ≈ 2,3 MiB, 44 KB [E] | — | `appletOnLoad` ≈ 0,93 s, 7,9 MiB transferidos, heap ≈ 44 MiB [E] |
| Responsividade | entrada→quadro p95 ≈ 2,5 ms [E] | — | `setValue`+`getValue` p50 ≈ 0,4 ms; 4,5 eventos por mudança [E] |
| Controle da UX / acessibilidade | total (ARIA, teclado, projeção) | total | limitado ao que o app expõe; arredondamento e projeção de pontos precisaram de contorno [E] |
| Persistência | `calculusLab` no `.lsproj` | idem A | estado em XML/base64 do GeoGebra, segundo documento |
| Testabilidade | funções puras + e2e (PoC) | idem A | caixa-preta por API |
| Manutenção | código próprio, pequeno | divergência permanente do upstream | acompanhar versões do GeoGebra; API por strings |
| Licença | sem obrigações externas | EUPL-1.2 por arquivo; compatível com GPLv3 pelo art. 5 [I] — exige rastreio e avisos | código EUPL, mas arquivos de idioma/ícones/estilos CC BY-NC-SA 4.0 e app/instaladores sob licença não comercial [C] |
| Duplicação | um motor matemático e um renderizador | idem A | segundo motor matemático, segundo renderizador, segundo undo |

**Recomendação [P]: estratégia A.** O GeoGebra é usado como referência de mecanismos (seções 2–3), não como dependência.
B fica reservado a um caso concreto: se o plotter Gillam não bastar para funções racionais/trigonométricas difíceis, avaliar
o porte do pacote intervalar (`kernel/interval/**`, `euclidian/plot/interval/**`) com registro de origem — decisão em M7,
após casos de teste que falhem. C é descartado como caminho de execução; no máximo, uma exportação opcional de comandos
para o professor abrir no GeoGebra por conta própria, sem empacotar nada (fora do MVP).

Nenhuma combinação foi adotada: manter o GeoGebra embutido ao lado do motor próprio duplicaria avaliação, plotagem,
persistência e undo sem ganho que justifique.

## 5. Prova de conceito (atividade "velocidade de subida aos 4 s")

Detalhes e reprodução em [`docs/poc/laboratorio-calculo-limites/README.md`](poc/laboratorio-calculo-limites/README.md).

- **A (própria)** [E], escolhida pelo usuário em 2026-10-16 também para a parte visual: `verify.mjs` 74 verificações, `e2e.mjs` 25 e
  `e2e-tanque.mjs` 19, todas no Edge headless sob CSP de Webview. Inclui: tabela bilateral calculada; quociente exato `4 + 0,5Δt`;
  Δt = 0 "indefinido"; arraste sem recalcular o que não depende de Q; **editor de equações próprio** com templates ∫, d/d□, lim (⁺/⁻),
  Σ, Π, teclado em abas e ícones próprios; digitar `t^3` recalcula tabela, limite (48), quociente e calculadora; **tanque com A ao vivo**
  (derramamento discreto, traçado quebrado, balanço fechado em 8,8e-15 m³); zero violações de CSP; zero rede externa.
- **C (GeoGebra 5.4.932.1)** [E]: não carrega sob a CSP da Webview; carrega com `nonce` + `'strict-dynamic'` +
  `'wasm-unsafe-eval'`; sincronização por `setValue`/listener funciona; arredondamento padrão esconde a convergência;
  `Point(h)` projeta no ponto euclidiano mais próximo; `Limit` depende do CAS assíncrono.
- **Não verificado:** comportamento dentro de uma Webview real do VS Code (origem `vscode-webview://`, `asWebviewUri`,
  service worker de recursos) para qualquer das duas.

## 6. Licenciamento e rastreabilidade

| Ação | Situação |
|---|---|
| Estudar conceitos e arquitetura (o que este plano faz) | Permitido; nenhum código copiado. A PoC foi escrita do zero; comentários citam as classes de referência. |
| Copiar/adaptar código (estratégia B, não adotada) | Cada arquivo traz "licensed … under the EUPL 1.2 … may be used under the EUPL 1.2 in compatible projects (see Article 5 and the Appendix)" e a nota "The overall GeoGebra software package is free to use for non-commercial purposes only" [C]. O apêndice da EUPL-1.2 lista GPLv3 como compatível [I]. Se um dia adotado: registrar arquivo, commit, licença, avisos de copyright, oferecer fonte, manter fora dos arquivos de idioma/ícones (CC BY-NC-SA) e revisar com [`LICENSE-POLICY.md`](../LICENSE-POLICY.md). |
| Distribuir componentes compilados | O bundle oficial é o "pacote completo" com arquivos de idioma, ícones e estilos (CC BY-NC-SA 4.0) e o README declara uso não comercial [C]. Incompatível com a política de não acrescentar restrições ao trabalho GPL [I]. |
| Incorporar o produto e serviços | Serviços e instaladores sob GeoGebra Non-Commercial License; uso comercial exige acordo [C]. Marca GeoGebra® é de terceiros. |

Esta tabela registra achados de engenharia; não é parecer jurídico.

## 7. Impactos no plano

- Contratos: `LabGraph` com nós tipados e poda por valor; `MathExpressionService` próprio com AST compatível com
  MathJSON; exato/numérico/visual explícitos em todo resultado ([51](51-laboratorio-calculo-arquitetura-e-dados.md)).
- Dependências: **nenhuma biblioteca matemática ou de gráficos nova no MVP**; MathLive/Compute Engine/mathjs/uPlot
  rebaixados a alternativas condicionais ([51 §6](51-laboratorio-calculo-arquitetura-e-dados.md)).
- Distribuição: nada de GeoGebra no VSIX.
- Testes: oráculos e e2e da PoC viram base dos testes de M3 ([54](54-laboratorio-calculo-validacao-e-riscos.md)).
- Sequência: a atividade de Limites com modelo analítico **sobe** para logo após a fundação da Webview, sem esperar o Core.

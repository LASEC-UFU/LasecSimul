# Biblioteca gráfica de supervisório (HMI/SCADA) — Fase 0: auditoria e arquitetura

Documento de entrada da feature "Graphical" (`Miscelâneos → Gráfico`). Escrito para quem for
implementar ou revisar as fases seguintes. Nada aqui é implementação: é o inventário do que **já
existe** no LasecSimul, o que falta, e qual é o menor caminho correto entre os dois.

Spec governante: [`.spec/features/process-visualization.md`](../.spec/features/process-visualization.md)
(FEAT-008, hoje `status: deferred`). Este trabalho é a implementação dela.

---

## 1. Conclusão executiva

O LasecSimul **já tem** quase toda a infraestrutura necessária. Não é preciso criar um canvas novo,
um renderizador novo, um formato de arquivo novo, nem um motor de binding novo. O que falta são
quatro coisas pequenas e genéricas, mais o conteúdo (os símbolos):

| # | Lacuna | Onde | Tamanho |
|---|---|---|---|
| G1 | `registerPackage` recusa package sem pinos — símbolo declarativo de 0 pinos não renderiza | `ui/webview/componentSymbols.ts:376` | 1 condição |
| G2 | Caixa do componente não é redimensionável por instância de forma pública (só `__simulideSceneScaleX/Y`) | `componentSymbols.ts::componentBox` | 1 função |
| G3 | Valores do Signal Graph não chegam à UI (blocos `control.*` têm `getState()` vazio) | `core/.../SignalMathBlock.hpp`, `SimulationSession` | ~1 método + 1 sample |
| G4 | Sem alças de redimensionamento/z-order/agrupamento no canvas | `ui/webview/main.ts` | UI nova |

Tudo o mais é reuso.

---

## 2. O que já existe (mapa de reuso)

### 2.1 A seção já existe

`project/schema/component-catalog.json` já publica **`Miscelâneos → Gráfico`** (pt-BR) /
**`Miscellaneous → Graphical`** (en) com cinco itens:

```
graphics.image | graphics.text | graphics.rectangle | graphics.ellipse | graphics.line
```

Todos com `workspaceSection: "misc"`, `folderPath: ["Grafico"]`, `graphical: true`, `pinCount: 0`.
A hierarquia pedida (Tubulação, Tanques, Válvulas, …) entra como **subpastas** de `folderPath`
(`["Grafico", "Tubulacao"]`), sem nenhuma mudança na árvore da paleta
(`ui/webview/paletteTree.ts` já monta N níveis).

### 2.2 Componentes gráficos já são cidadãos de primeira classe do canvas

`pinCount: 0` faz `coreLifecycle.ts::shouldSyncComponentToCore` retornar `false`: o componente
**nunca é enviado ao Core**, não entra no Netlist/MNA e não participa do solver. É exatamente a
regra da FEAT-008 ("visualização é projeção de telemetria, não participante do solver") — e já é o
comportamento de hoje de `graphics.rectangle`.

Como são componentes normais, herdam de graça: seleção, multi-seleção, marquee, arraste, rotação
(90°), copiar/colar/duplicar, apagar, undo/redo, zoom/pan, snap ao grid, rótulos, painel de
propriedades, serialização e o editor de subcircuito.

### 2.3 Já existe um renderizador vetorial declarativo (e maduro)

`PackageDescriptor` (`ui/webview/model.ts:818`) + `simulidePaint` (`ui/webview/simulidePaint.ts`)
formam um IR de desenho **dado, não código**:

- primitivas: `line`, `rect`, `roundedRect`, `ellipse`, `arc`, `path`, `polygon`, `polyline`,
  `text`, `image`, `repeat`;
- estilo: stroke/fill/width/dash/linecap/linejoin/opacity/gradientes (linear e radial);
- `bounds` + `transformFor()` escalam o desenho inteiro para a caixa da instância — **vetor puro,
  nítido em qualquer zoom**;
- 55 dispositivos do catálogo já usam isso em produção.

Isso é o substrato dos símbolos industriais. Um símbolo novo é **um objeto JSON**, não um `case`
novo em nenhum `switch` — atende diretamente o requisito de extensibilidade (§27 da task).

### 2.4 Já existe binding declarativo propriedade → aparência

No mesmo IR, e já testado:

| Recurso | O que faz | Uso no supervisório |
|---|---|---|
| `PackageNumberExpression` (`{prop, multiplier, offset, min, max, round}`) | qualquer número de qualquer primitiva vem de uma propriedade, com transformação e faixa | altura do líquido do tanque, ângulo/abertura da válvula, comprimento da barra |
| `stateFill` (`map` / `numeric` com `> >= < <= == !=` / `raw`) | cor por valor ou por faixa | verde=rodando, vermelho=falha, cor por nível |
| `stateVisible` (`when`) | mostra/esconde primitiva por valor | lâmpada de status, seta de fluxo |
| `stateText` (`{kind:"property", prop}` / `readout`) | texto vem de propriedade ou da telemetria | tag `LT-101`, valor `72.4 %` |

`numericValue()` em `simulidePaint.ts:136` **é** a "transformation + range" pedida em §13 da task,
já implementada e coberta por teste.

### 2.5 Já existe transporte de telemetria com atualização pontual

```
Core getComponentStates(batch)
  → coreLifecycle.ts::pollInstrumentReadouts (~300 ms)
  → postMessage "componentReadout" { readoutsByComponentId }
  → main.ts::runtimeSymbolProperties injeta __readout nas propriedades do símbolo
  → updateComponentElement(el, component)  // SÓ os componentes afetados
```

`main.ts:9239-9285` já faz patch por componente em vez de `render()` global, justamente para não
destruir arraste/seleção e não repintar o canvas a cada tick. É a otimização exigida em §26 da
task — já existe, basta usá-la.

### 2.6 Já existe projeção de componentes internos sobre a instância

`exposedComponents[]` (`catalog/subcircuitDocument.ts:43`) com `x, y, rotation, flipH, flipV,
scale, **layer**` + `main.ts::renderBoardOverlaysFor` desenham componentes internos de um
subcircuito **sobre o símbolo da instância colocada**, com leitura ao vivo e arraste. É o
mecanismo de tela supervisória que já roda hoje nos modelos TDPS (as sondas em cima do BMP).
`layer` já é z-order persistido.

### 2.7 Já existe round-trip de formas editáveis

`catalog/subcircuitSymbolScene.ts` converte `symbol.shapes[] ↔ componentes graphics.*`: no "Modo
Símbolo" as formas do símbolo são editadas como componentes normais e recompiladas para
`PackageShape[]` ao salvar. É o precedente exato de "objeto gráfico editável individualmente".

### 2.8 Inspector é dirigido por dados

`ui/views/PropertyInspectorViewProvider.ts` monta o painel a partir de
`catalogEntry.propertySchema[]`, agrupando por `schema.group`. Editores reconhecidos
(`batchProperties.ts::propertyFieldKindFromEditor`): `number`, `checkbox/switch`, `select/enum`,
`color`, `filePath`, `textarea`, `display` (readonly), `text`. Cobre Geometria / Aparência /
Componente / Binding sem nenhuma UI nova. `graphics.image` já declara `propertySchema` no catálogo
— o precedente de que isso funciona para componente que não existe no Core.

---

## 3. O que falta (lacunas confirmadas por leitura de código)

### G1 — Package sem pinos não é registrado

```ts
// componentSymbols.ts:376
if (pkg && (pkg.pins.length > 0 || pkg.dynamicLayout?.pinGroups?.length)) PACKAGE_BY_TYPE_ID.set(...)
else PACKAGE_BY_TYPE_ID.delete(typeId);
```

Um símbolo gráfico tem **zero pinos**, então seu `package` é descartado e o desenho cai no
retângulo genérico. Verificado: **nenhum item do catálogo hoje tem package com zero pinos**, logo
relaxar a condição para "registra se tem algo desenhável" é *no-op* para todo o catálogo atual.

### G2 — Tamanho por instância

`componentBox()` usa a largura/altura fixas do package multiplicadas por
`__simulideSceneScaleX/Y` (propriedade interna do importador SimulIDE). Não há caminho público
`width`/`height` por instância para símbolos com package. Sem isso não há "arraste a alça e
redimensione o tanque".

### G3 — Valores de processo não chegam à UI

`SignalMathBlock::getState()` retorna 0 e nenhum `control.*` declara `readoutFormat`. Logo o valor
de um tanque, de um PID ou de uma sonda **não existe do lado da Extension**. Existe todo o resto do
caminho: `SignalRuntime::output(blockId)` + `real(slot)` (`SignalEngine.hpp:148-150`) e o
precedente `SimulationSession::sampleHartInputsFromSignalUnlocked()` que faz exatamente essa
leitura para o HART.

### G4 — Edição avançada

Não existe no canvas: alça de redimensionamento (só fios têm alças de vértice/segmento), z-order
(as strings i18n `bringPackageShapeForward`/`sendPackageShapeBackward` existem em `main.ts:242` mas
**não têm implementação**), agrupar/desagrupar, alinhar/distribuir. Rotação é limitada a
0/90/180/270 (`ProjectComponent.visual.rotation`).

### G5 — DSL não carrega geometria

`dsl/DslSerializer.ts` escreve `component <id> <typeId> { propriedades }` e **nada de x/y/rotation**
— para nenhum componente, não só gráficos. `DslReconciler` preserva a posição antiga quando o id já
existe e arbitra uma posição em grade quando é novo. Ou seja: objetos gráficos **não se perdem** no
round-trip e suas propriedades (tamanho, cor, binding) sobrevivem; a **posição** não. É uma
limitação pré-existente do DSL, documentada aqui em vez de forçada.

---

## 4. Inventário TDPS

Fonte de verdade: [`.spec/fixtures/tdps-v771-library.json`](../.spec/fixtures/tdps-v771-library.json).

**Exatamente 24 processos** (auditados do corpus TDPS v7.71), mais `process_fopdt` (bloco FOPDT
base, não é um projeto TDPS). Os 24 estão em `subcircuits/tdps_*.lssubcircuit`, cada um com uma
referência visual em `subcircuits/tdps-reference-images/*.png` (640 px de largura).

### Como a tela é montada HOJE

`scripts/apply-tdps-reference-symbols.mjs` grava, em cada modelo:

```jsonc
"symbol": { "width": 640, "height": 480, "background": { "kind": "image", "asset": "...png" }, "shapes": [] },
"exposedComponents": [ /* todo componente interno, projetado sobre a foto */ ]
```

Ou seja: **a tela de processo É o bitmap**, com as sondas projetadas por cima. É precisamente isso
que esta feature substitui. O script é o ponto de troca das Fases 5/6.

### Conteúdo interno dos modelos

Os 24 modelos usam só quatro primitivas de sinal: `control.observer` (274 instâncias),
`control.calc_expression` (172), `control.process` (139/140) e `control.pid` (66/67), ligadas por
`connectors.tunnel`. A topologia de simulação está pronta — falta só a camada visual.

### Requisitos gráficos observados nas referências

Levantados lendo as telas (`basic_flow_loop`, `heat_exchanger`, `regulatory_level`, `surge_tank`):

| Elemento | Onde aparece | Cobertura planejada |
|---|---|---|
| Tubulação com cotovelo, tê, flange, cor por fluido | todas | `graphics.pipe` |
| Seta de fluxo | quase todas | `graphics.pipe` (flag) + `graphics.arrow` |
| Tanque vertical com nível | regulatory_level, surge_tank, boiler | `graphics.tank` |
| Vaso/trocador com serpentina | heat_exchanger, reactor | `graphics.vessel` |
| Válvula (bowtie) + atuador (diafragma/manual/solenoide) | quase todas | `graphics.valve` |
| Bomba centrífuga / motor | regulatory_level, cooling_plant, surge_tank | `graphics.pump`, `graphics.motor` |
| Balão ISA 2 linhas (FT, TT, LT, HS…) | quase todas | `graphics.instrument` |
| Faceplate de controlador com bargraph (FIC/TIC) | basic_flow_loop, heat_exchanger | `graphics.controller_faceplate` |
| Junção somadora ⊕ | heat_exchanger, split_range, cross_limits | `graphics.summing_junction` |
| Texto/tag e valor animado | 213 "TEXTO ANIMADO" no corpus | `graphics.label`, `graphics.value_display` |
| Barra de nível / limites | surge_tank | `graphics.level_bar` |
| Lâmpada de status / booleano | combustão | `graphics.status_lamp` |
| Correia, peneira, caçamba, separador magnético | **só surge_tank** | equipamento genérico + rótulo (gap honesto, ver §6) |

---

## 5. Arquitetura alvo

```
                 ┌──────────────────────────────────────────────┐
                 │ catálogo (DADOS)                             │
                 │ project/schema/component-catalog.json        │
                 │  · typeId graphics.*                         │
                 │  · folderPath ["Grafico","<subpasta>"]       │
                 │  · propertySchema  → Inspector               │
                 │  · package.simulidePaint → desenho vetorial  │
                 └───────────────┬──────────────────────────────┘
                                 │ registerPackage (G1)
                 ┌───────────────▼──────────────────────────────┐
                 │ motor de cena genérico (JÁ EXISTE)           │
                 │ main.ts: seleção/arraste/rotação/undo/…      │
                 │ componentSymbols.ts + simulidePaint.ts       │
                 └───────────────┬──────────────────────────────┘
                                 │ propriedades da instância
                 ┌───────────────▼──────────────────────────────┐
                 │ binding (GENÉRICO, uma implementação só)     │
                 │ bindSource (id estável) + bindProperty       │
                 │ resolvido em runtimeSymbolProperties()       │
                 │ → vira __bind_value, consumido por           │
                 │   PackageNumberExpression/stateFill/stateText│
                 └───────────────┬──────────────────────────────┘
                                 │ readoutsByComponentId (JÁ EXISTE)
                 ┌───────────────▼──────────────────────────────┐
                 │ Core: valor do Signal Graph (G3)             │
                 │ SignalRuntime::real(output(blockId))         │
                 └──────────────────────────────────────────────┘
```

Princípios (derivados da FEAT-008 e da ARCH-006):

1. **Um canvas só.** Nada de editor paralelo. Objeto gráfico é componente de catálogo.
2. **Símbolo é dado.** Nenhum símbolo novo adiciona `case` ao renderizador.
3. **Binding por ID estável, não por rótulo** (ARCH-006: "bindings persistem por `ioId`, não por
   nome, posição visual ou índice").
4. **Zero acoplamento a HART/CTRL/TDPS.** O gráfico consome um valor; não sabe de onde veio.
5. **Gráfico nunca entra no solver.** `pinCount: 0` garante isso estruturalmente.

---

## 6. Riscos e limites conhecidos

| Risco | Mitigação |
|---|---|
| Relaxar `registerPackage` mudar render de algum device | verificado: zero itens com package sem pino hoje; teste de regressão fixa isso |
| Rotação limitada a 90° | é o contrato de `ProjectComponent.visual.rotation`; símbolos são desenhados para ler bem nos 4 quadrantes |
| DSL sem geometria | documentado como extensão futura (§3/G5), não forçado agora |
| `surge_tank` tem pictórico específico (caçamba, peneira, correia) | será representado com equipamento genérico + rótulo; divergência declarada na matriz de cobertura, não escondida |
| Telemetria a ~300 ms | suficiente para supervisório; FPS é política da Extension (regra da FEAT-008) |

---

## 7. Plano por fase (mapeado a arquivos reais)

| Fase | Entrega | Arquivos |
|---|---|---|
| 1 | Núcleo gráfico: G1, G2, esquema de propriedades comum, primitivas básicas | `componentSymbols.ts`, `component-catalog.json`, `scripts/generate-graphics-library.mjs` |
| 2 | Símbolos industriais (pipe, tank, valve, pump, instrument, indicator) | gerador + catálogo |
| 3 | Binding genérico + G3 (valor do Signal Graph) | `main.ts::runtimeSymbolProperties`, `coreLifecycle.ts`, `SignalMathBlock.hpp`, `SimulationSession.cpp` |
| 4 | Redimensionar/z-order/agrupar/alinhar (G4) | `main.ts` |
| 5 | Pilotos TDPS (3 processos) | novo gerador de tela, substituindo `apply-tdps-reference-symbols.mjs` |
| 6 | Cobertura dos 24 | idem |
| 7 | `.lssubcircuit` + DSL | `subcircuitDocument.ts`, `dsl/*` |
| 8 | Validação final | suíte completa |

---

## 8. Comandos de verificação usados nesta auditoria

```bash
node -e "const {loadUnifiedCatalog}=require('./extension/out/catalog/UnifiedCatalog.js'); ..."   # seção Gráfico já existe
grep -c '"typeId": "control\.' subcircuits/tdps_*.lssubcircuit                                   # uso interno dos modelos
python -c "...json.load('.spec/fixtures/tdps-v771-library.json')..."                             # 24 processos
```

# Biblioteca gráfica de supervisório — relatório de implementação

Continuação de [`44-biblioteca-grafica-supervisorio-fase0.md`](44-biblioteca-grafica-supervisorio-fase0.md)
(auditoria e arquitetura). Aqui estão o que foi construído, o inventário de componentes, como o
binding funciona, a matriz de cobertura TDPS, os testes e as lacunas que ficaram.

Implementa [FEAT-008](../.spec/features/process-visualization.md) dentro das regras da
[ARCH-006](../.spec/architecture/topology-and-bindings.md).

---

## 1. Decisões arquiteturais

| Decisão | Por quê |
|---|---|
| Objeto gráfico é **componente de catálogo** (`graphics.*`, `pinCount: 0`) | herda de graça seleção, arraste, rotação, copiar/colar, undo/redo, zoom, snap, Inspector e serialização; e `pinCount: 0` faz `shouldSyncComponentToCore` devolver `false`, o que mantém a visualização **estruturalmente** fora do solver (regra da FEAT-008) |
| Símbolo é **dado** (`package.simulidePaint`), não código | acrescentar um símbolo é uma entrada num gerador; o renderizador nunca cresce um `case` (task §27/§36) |
| Binding tem **uma** implementação (`graphicsBinding.ts`) | `__g_pct`/`__g_text`/`__g_on` são consumidos por `PackageNumberExpression`/`stateFill`/`stateText`; nenhum símbolo tem lógica de binding própria (task §13) |
| Binding referencia **id**, nunca rótulo | ARCH-006: renomear o rótulo de uma sonda não pode quebrar uma tela (task §30) |
| Telas TDPS usam **compositor semântico + perfis curados** | o compositor genérico continua cobrindo qualquer modelo; processos cuja referência exige fidelidade pictórica podem declarar uma composição curada que reutiliza os mesmos símbolos e bindings nativos, sem bitmap |

---

## 2. Arquivos criados

| Arquivo | Papel |
|---|---|
| `extension/src/ui/webview/graphicsBinding.ts` | resolvedor único de binding (valor → `__g_pct`/`__g_text`/`__g_on`/`__g_bind`) |
| `scripts/generate-graphics-library.mjs` | publica os 32 símbolos no catálogo + gera os 64 ícones da paleta a partir do mesmo paint spec |
| `scripts/generate-tdps-process-screens.mjs` | compositor das 24 telas de processo; `generate-tdps-process-library.mjs` passou a chamá-lo no lugar de `apply-tdps-reference-symbols.mjs` (marcado obsoleto), para que regenerar a biblioteca nunca reintroduza bitmaps |
| `extension/src/ui/webview/graphicsBinding.test.ts` | 13 testes do binding |
| `extension/src/catalog/graphicsLibrary.test.ts` | 17 testes da biblioteca (render real, estados, proporção, Inspector, ícones) |
| `extension/src/dsl/graphicsDslRoundTrip.test.ts` | 6 testes de round-trip pelo Lasec DSL |
| `extension/src/tdps/tdpsProcessScreens.test.ts` | 10 testes das 24 telas (sem bitmap, dispositivos HMI detalhados, bindings válidos, z-order, save/reopen) |
| `extension/media/components/{light,dark}/graphic-*.svg` | 64 ícones vetoriais |

## 3. Arquivos modificados

| Arquivo | Mudança | Tamanho |
|---|---|---|
| `componentSymbols.ts` | `registerPackage` aceita package sem pino quando ele tem conteúdo desenhável | 1 predicado |
| `simulidePaint.ts` | cor de TEXTO passa a honrar `stateFill` como as demais primitivas | 1 linha |
| `main.ts` | projeção de binding, repintura pontual, opacidade por instância, z-order, alças de redimensionar, agrupar/desagrupar, overlay de Modo Placa genérico | ~230 linhas |
| `model.ts` | campo `paletteHidden` (trabalho anterior) | — |
| `coreLifecycle.ts` | telemetria passa a incluir as FONTES de binding de elementos gráficos expostos | ~12 linhas |
| `DslReconciler.ts` | propriedades `__`-prefixadas (estado de UI) atravessam o DSL sem virar erro | 1 linha |
| `styles.css` | estilo das alças de redimensionar | ~20 linhas |
| `SignalMathBlock.hpp` | `getState()`/`setLastOutput()`/`readoutFormat()` — blocos de controle passam a publicar leitura escalar | ~35 linhas |
| `SimulationSession.{hpp,cpp}` | `sampleSignalMathOutputsUnlocked()` copia a saída do `SignalRuntime` para a instância na captura de telemetria | ~20 linhas |
| `CoreApplication.cpp` | registra `readoutFormat` escalar para os `control.*` | 4 linhas |
| `SubcircuitRegistry.cpp` | a camada visual (`graphics.*`) é cortada da definição no ÚNICO ponto por onde toda definição passa — o Core nunca vê objeto de tela | ~18 linhas |
| `ProcessSubcircuitCompiler.cpp` | ignora `graphics.*` em vez de rejeitar como "tipo não suportado" | 1 guarda |
| `SimulationSession.cpp` (relay) | **correção de runtime**: o túnel ELÉTRICO legado passa a valer como relay de sinal (antes só o `signal_tunnel`), incluindo propagação de rate/política de loop | ~15 linhas |
| `SimulationSession.cpp` (rede de túnel) | **correção de runtime**: túneis de relay com o MESMO nome passam a ser a mesma rede também no domínio de SINAL | ~45 linhas |
| `ControlBlockSubcircuitTest.cpp` | fixture registrava só `signal_tunnel`; faltava a factory do túnel elétrico | ~8 linhas |
| `project/schema/component-catalog.json` | 32 símbolos novos + subpastas + tradução en | dados |
| `subcircuits/tdps_*.lssubcircuit` (24) | telas de processo nativas no lugar do bitmap | dados |

---

## 4. Inventário da biblioteca (44 símbolos nativos + 193 portados do IPD)

Todos em `Miscelâneos → Gráfico` (pt-BR) / `Miscellaneous → Graphical` (en), todos `pinCount: 0`,
todos vetoriais, todos redimensionáveis por `width`/`height`.

| Subseção | Símbolo (`graphics.`) | Propriedades próprias | Binding |
|---|---|---|---|
| **Tubulação** | `pipe` | cor, flanges, seta e sentido de fluxo | estado (fluxo lig/desl) |
| | `pipe_elbow`, `pipe_tee`, `pipe_cross`, `pipe_flange` | cor/contorno | — |
| **Tanques e Vasos** | `tank` | cor do líquido, escala, mostrar valor | nível 0–100 % |
| | `tank_horizontal` | cor do líquido | nível |
| | `vessel` | cor do líquido | nível |
| | `hopper` | cor do material | nível |
| | `heat_exchanger` | — | — |
| **Válvulas** | `valve` | atuador (nenhum/manual/diafragma/solenoide/motor), tag | abertura 0–100 % (cor por faixa) |
| | `check_valve` | tag | — |
| **Bombas e Motores** | `pump`, `motor` | tag | estado lig/desl (cor) |
| **Supervisório Industrial** | `flow_transmitter`, `controller_station` | tag, leitura, setpoint | vazão/saída ao vivo |
| | `control_valve_industrial` | tag, abertura | abertura ao vivo |
| | `hand_valve_industrial` | tag | — |
| **Instrumentos** | `instrument` | tag 2 linhas, invólucro (círculo/quadrado/hexágono/losango), localização (campo/painel/atrás) | valor ao vivo |
| | `controller_faceplate` | tag, setpoint, cor da barra | PV (barra + valor) |
| | `summing_junction` | — | — |
| **Indicadores** | `value_display` | rótulo, cor do valor | valor formatado |
| | `level_bar` | cor, limites alto/baixo | valor 0–100 % |
| | `gauge_bar` | cor | valor 0–100 % |
| | `status_lamp` | cor lig/desl, rótulo | booleano |
| **Elementos de Fluxo** | `flow_arrow`, `orifice_plate` | cor | — |
| **Equipamento de Processo** | `equipment` | rótulo, tamanho do texto | — |
| | `conveyor` | — | estado lig/desl |
| **Conexões** | `signal_line` | traço (tracejada/cheia/pontilhada) | — |
| | `arrow` | cor, espessura | — |
| **Texto e Rótulos** | `label` | texto, tamanho, alinhamento, moldura | mostra o valor quando ligado |
| **Supervisório Industrial** | `flow_transmitter`, `controller_station`, `control_valve_industrial`, `hand_valve_industrial` | tag, faixa, estilo do dispositivo | valor/abertura ao vivo |
| **Controles HMI** | `hmi_button`, `hmi_toggle`, `hmi_switch`, `numeric_input`, `slider`, `setpoint` | rótulo, faixa, passo | valor do operador |
| **Formas Básicas** | `rectangle`, `ellipse`, `line`, `text`, `image` (legados) | — | — |

Propriedades comuns a todos: **Geometria** (largura, altura) e **Aparência** (contorno,
preenchimento, espessura, opacidade). Os que têm binding acrescentam o grupo **Binding**.

As subseções *Supervisório Industrial* (dispositivos de campo detalhados, usados no sinótico curado
de *Vazão Linear Simples*) e *Controles HMI* (elementos de entrada do operador) foram acrescentadas
depois do conjunto inicial — pelo mesmo gerador, sem tocar no renderizador, que é exatamente o
critério de extensibilidade do §1.

---

## 5. Binding: como um gráfico lê a simulação

```
control.observer (sonda no modelo)
  └─ Core: SignalRuntime::real(output(blockId))
       └─ SimulationSession::sampleSignalMathOutputsUnlocked()   [na captura de telemetria]
            └─ SignalMathBlock::getState()  → 1 double
                 └─ decodeComponentReadout (readoutFormat: scalar)
                      ├─ componentReadout        → readoutsByComponentId[id]        (canvas)
                      └─ boardOverlayReadouts    → readoutsByKey["instancia:id"]    (instância colocada)
                           └─ graphicalRuntimeProperties(props, leitura)
                                ├─ __g_value  valor * ganho + offset
                                ├─ __g_pct    normalizado em bindMin..bindMax, saturado
                                ├─ __g_text   formatado (casas decimais + unidade)
                                ├─ __g_on     >= limiar (com inversão opcional)
                                └─ __g_bind   static | bound | missing
                                     └─ package.simulidePaint consome via
                                        PackageNumberExpression / stateFill / stateText / stateVisible
```

Campos do Inspector (grupo **Binding**): `bindSource` (id da fonte), `bindChannel`, `bindScale`,
`bindOffset`, `bindMin`, `bindMax`, `bindUnit`, `bindDecimals` e, nos símbolos de estado,
`bindThreshold` e `bindInvert`.

Sem `bindSource`, o símbolo desenha a propriedade estática `value` — é isso que permite montar a
tela inteira com a simulação parada. Com `bindSource` apontando para algo que não publica leitura,
o estado vira `missing` e o desenho **não quebra**: continua mostrando o último valor autorado.

### Desempenho

Atualização é **pontual**: `componentNeedsReadoutRepaint` repinta só os elementos cuja fonte mudou
(`updateComponentElement` naquele componente), e `patchBoardOverlayRuntimeVisuals` faz o mesmo no
overlay da instância. Nenhum `render()` global por tick — a mesma disciplina que o canvas já usava
para LED e tensão de fio.

---

## 6. Matriz de cobertura TDPS

24 processos (número confirmado em `.spec/fixtures/tdps-v771-library.json`, não presumido).
**Nenhum usa bitmap.** "Elem." = objetos gráficos na tela; "Lig." = objetos ligados à simulação.

| # | Processo | Elem. | Sondas | Ctrl | Tanque | Tubo | Válv. | Bomba | Instr. | Indic. | Cobertura |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Vazão Linear Simples (piloto curado) | 40 | 3 | 1 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 2 | Caldeira Industrial V1 (Boiler) | 35 | 23 | 9 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 3 | Combustão Limites Cruzados | 20 | 10 | 3 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 4 | Combustão Limites Cruzados Dinâmicos | 20 | 10 | 3 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 5 | Controle de Razão para Combustão | 20 | 10 | 3 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 6 | Queima com Dois Combustíveis | 18 | 8 | 3 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 7 | Torre de Resfriamento | 21 | 8 | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | completa |
| 8 | Controle de Vazão Course-Fine | 14 | 5 | 2 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 9 | Torre Deetanizadora | 45 | 26 | 6 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | completa |
| 10 | Laboratório de Resposta em Frequência | 15 | 4 | 1 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 11 | Forno Mestre-Escravo | 24 | 11 | 2 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 12 | Controle de Temperatura de Forno | 20 | 8 | 1 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 13 | Pressão de Header com 3 Consumidores | 26 | 9 | 3 | – | ✓ | ✓ | ✓ | ✓ | ✓ | completa |
| 14 | Temperatura com Trocador de Calor V1 | 22 | 11 | 1 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 15 | Caldeira Industrial V1 | 56 | 44 | 9 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 16 | Controle pH Linearizado | 16 | 6 | 1 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 17 | Controle pH Linearizado (Alt.) | 16 | 6 | 1 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 18 | Processos de Vazão Não Lineares | 22 | 11 | 4 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 19 | Sistemas Dinâmicos Lineares | 32 | 17 | 0 | ✓ | ✓ | ✓ | – | ✓ | ✓ | completa |
| 20 | Controle Regulatório em Reator | 24 | 12 | 4 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 21 | Controle de Nível V1 | 23 | 11 | 1 | ✓ | ✓ | – | ✓ | ✓ | ✓ | completa |
| 22 | Espessura com Preditor de Smith | 15 | 7 | 1 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 23 | Temperatura com Split-Range | 20 | 8 | 1 | – | ✓ | ✓ | – | ✓ | ✓ | completa |
| 24 | Caixa de Polpa (surge tank) | 17 | 6 | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | parcial¹ |

**Total: 581 objetos gráficos, 0 bitmaps.**

¹ **Caixa de Polpa** é o único processo cuja referência visual tem equipamento pictórico sem símbolo
dedicado na biblioteca: caçamba basculante, peneira vibratória, correia transportadora e separador
magnético. A correia tem símbolo (`graphics.conveyor`); os outros três são representados por
`graphics.equipment` com rótulo. A tela é funcional e ligada à simulação, mas menos figurativa que a
original. Ver §8.

---

## 7. Relatório de testes

### Comandos e resultados

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit -p extension/tsconfig.json` | limpo |
| `npx tsc --noEmit -p extension/tsconfig.webview.json` | limpo |
| `npm --prefix extension test` | **653 passaram, 0 falharam** nas 56 suítes com runner compartilhado, além dos checks standalone do mesmo comando |
| `node scripts/build-core.js` | exit 0 |
| `ctest -C Debug` (hermético) | 66/67 — só a trava pré-existente de `electrical_signal_bridge_live` |
| `node scripts/generate-graphics-library.mjs` | 44 símbolos, 88 ícones |
| `node scripts/generate-tdps-process-screens.mjs` | 24 telas, 586 objetos, nenhum bitmap |
| `node scripts/generate-ipd-symbol-library.mjs` | 193 símbolos P&ID publicados; catálogo gráfico em 242 entradas |

### Suítes novas (48 testes, incluídos nos 619)

```
graphicsBinding        13  estático/ligado/ausente, faixa, saturação, ganho, multicanal,
                           id estável, formatação, faixa degenerada
graphicsLibrary        19  paleta+subseções, pinCount 0, render vetorial sem NaN,
                           resize, Inspector, tanque 0/50/100 %, válvula 3 estados,
                           bomba/motor/lâmpada, indicadores, tubo, ícones
graphicsDslRoundTrip    6  objeto sobrevive, aparência/binding preservados, id estável,
                           propriedade de UI, tela inteira, limitação de posição
tdpsProcessScreens     10  24 processos, sem bitmap, composição, exposição, bindings
                           válidos, z-order, save/reopen, render, simulação intacta
```

### Falhas do Core — classificação honesta

| Teste | Causa | Situação |
|---|---|---|
| `process_subcircuit` | `ProcessSubcircuitCompiler` rejeitava `graphics.*` com "tipo nao suportado no subcircuito de processo" | **Regressão minha — corrigida.** O corte definitivo da camada visual ficou em `SubcircuitRegistry::registerDefinition`. Passa. |
| `control_block_subcircuit` caso (3) | compilava o Signal Plan de **1 de 49** manifestos publicados; os outros 48 falhavam | **Defeito pré-existente — corrigido.** Passa **49/49**. Duas causas, descritas abaixo. |
| `electrical_signal_bridge_live` (timeout) | trava antes de imprimir qualquer linha | **Pré-existente, não corrigido.** Verificado recompilando o Core **sem** as mudanças deste trabalho: timeout idêntico. Fora do escopo desta feature. |
| `session_restart_stress`, `mcu_*`, `plc_*` | rótulos `external-qemu` / `external-plc` | **Pré-existentes.** Dependentes de ambiente (QEMU, toolchain PLC). |

Fora esses, a suíte hermética do Core passa inteira (66 testes).

### Os dois defeitos de runtime que travavam a biblioteca Ctrl/TDPS

Ambos viviam em `SimulationSession::materializeSignalGraphUnlocked` e eram **silenciosos**: o plano
compilava (ou nem chegava a compilar) sem que nada na UI indicasse o problema.

**1. O túnel elétrico legado não era tratado como relay de sinal.**
`Tunnel::signalPorts()` declara a porta como `Output` fixo — a `direction` de um túnel descreve o
papel de FRONTEIRA, nunca se o bloco precisa de entrada. A exceção que reconhece isso existia só
para `connectors.signal_tunnel`, então todo túnel elétrico alimentado por um fio nascia
`ExternalInput` sem porta `"in"`, e a conexão correspondente estourava com
`porta de entrada inexistente: sig.N.pin.in`. Como a biblioteca Ctrl/TDPS inteira usa o túnel
elétrico como relay (o próprio `ProcessSubcircuitCompiler` já aceitava os dois), 48 dos 49
manifestos não compilavam.

**2. Túneis de mesmo nome não formavam uma rede no domínio de sinal.**
No domínio elétrico o `Netlist` funde túneis por nome. No de sinal isso não existia: cada túnel
virava um bloco isolado. Os modelos TDPS ligam bloco a bloco justamente por PARES de túneis com o
mesmo nome (`pid-01.out` → túnel `pid-01.out` … túnel `pid-01.out` → `process-21.in`), então o
valor **nunca atravessava o par** — a simulação rodava e toda sonda a jusante do primeiro túnel lia
0 para sempre, sem erro nenhum.

A semântica implementada é deliberadamente conservadora (ARCH-006: *"fan-in exige semântica
explícita do domínio/bloco e nunca implica soma automática"*): exatamente um membro alvo de fio é o
driver da rede e os demais passam a lê-lo; zero drivers (fronteira externa do subcircuito) continua
`ExternalInput` com default; dois ou mais drivers deixa a rede intocada, sem eleger um vencedor
arbitrário. A propagação de rate/política de loop também atravessa a rede, senão os dois lados do
par cairiam em `RateGroup`s diferentes e o `SignalCompiler` recusaria o SCC da malha.

Nenhum teste existente foi enfraquecido ou removido. `ControlBlockSubcircuitTest` ganhou a factory
de `connectors.tunnel` que faltava no seu fixture — sem ela os 48 manifestos falhavam antes com
"Unknown component typeId", escondendo os defeitos reais atrás de uma mensagem enganosa.

### Evidência de que está ligado na UI de produção

- **Simulação real alimentando a tela** (prova ponta a ponta): subindo o `lasecsimul-core.exe` de
  verdade, registrando um `.lssubcircuit` TDPS, instanciando-o e rodando, as sondas são lidas pelo
  MESMO caminho da Extension (`getComponentStates` → `decodeComponentReadout`) e alimentam o
  resolvedor de binding, que desenha a tela. Em `tdps_basic_flow_loop`: `pid-01 = 50` (seu bias),
  `process-21 = 42,67` (resposta dinâmica real ao degrau do PID) e a sonda `readout-104 = 50`
  atravessando o par de túneis. Em `tdps_regulatory_level`: 10 das 20 sondas com valor não-zero,
  tanque desenhado em 100 %, FT-103 em 100 L/min, faceplate LIC01 acompanhando. Os zeros restantes
  são os túneis de fronteira externa do subcircuito (`external-*`), que nada alimenta num harness
  isolado — comportamento correto, não falha.
- **Editor de esquemático real**: o bundle de produção (`out-webview/main.js` +
  `src/ui/webview/styles.css`) carregado com uma cena montada só de elementos da biblioteca desenha
  os 12 objetos no canvas, mostra as **8 alças de redimensionar** no objeto selecionado e abre o
  **Inspector** com exatamente os grupos projetados — *Geometria* (Largura/Altura), *Aparência*
  (contorno, preenchimento, espessura, opacidade) e *Componente* (cor do líquido, mostrar escala),
  com seletor de cor funcionando. Zero erros de página.
- **Paleta real**: o bundle de produção (`out-webview/palette.js` + `src/ui/palette/styles.css`),
  carregado num navegador com o catálogo real, mostra as 5 abas com os ícones novos de
  Controle/Processo e `Miscelâneos → Gráfico` com as 11 subseções; expandidas, cada símbolo aparece
  com o ícone vetorial gerado a partir do seu próprio paint spec (nunca o fallback genérico).
- **Render dos símbolos**: `graphicsLibrary.test.ts` desenha pelo caminho real
  (`registerPackage` → `packageSymbolSvg`), o mesmo da Webview.
- **Telas TDPS**: `tdpsProcessScreens.test.ts` valida os 24 arquivos com o parser/serializador real
  do `.lssubcircuit`, incluindo save → reopen.

## 7b. Passe de fidelidade visual do sinótico piloto

A primeira versão do piloto *Vazão Linear Simples* estava tecnicamente correta (objetos nativos,
bindings válidos) mas visualmente distante do sinótico TDPS original. A comparação lado a lado com a
referência apontou quatro defeitos concretos, todos corrigidos:

| Defeito | Causa | Correção |
|---|---|---|
| Tubo chapado, sem volume | o casco era um retângulo com três fios de luz | faixas horizontais de branco/preto em fração de `H` sobre o corpo — cilindro convincente em qualquer espessura e qualquer cor de tubo. Gradiente não serve aqui: o IR usa `userSpaceOnUse` com coordenadas constantes e este símbolo é elástico |
| FCV-101 flutuando acima da linha | posição escrita como número solto | posição derivada de `PIPE_AXIS` menos o eixo do corpo dentro da caixa de projeto do símbolo (`VALVE_BODY_AXIS`) |
| Tomada do FT-101 sem encostar no tubo | comprimento fixo | comprimento calculado até o topo do tubo |
| Cantos das rotas de sinal com falha | segmentos apenas encostados | segmentos com 1 px de sobreposição nos cantos |

Também entraram: ramal derivando do eixo da linha (tê real, não um tubo solto ao lado), trackbar no
setpoint em vez de barra de nível, aba de identificação do FIC-101 e rótulos reposicionados para
fora do tubo.

Aprendizado registrado no gerador: `strokeWidth` no IR de pintura é número puro — ao contrário de
`x`/`y`/`w`/`h`, não aceita expressão de propriedade, e passar um objeto gera `NaN` no atributo do
SVG. O gate `graphicsLibrary` pega isso.

## 7c. Limpeza vetorial das rotas manuais

O passe de fidelidade do editor também adaptou `src/canvas/vertexClean.ts` do IPD Studio para o
modelo de fios nativo. Ao terminar o arraste de um canto ou segmento, os vértices internos são
encaixados na grade de 8 px, podem adotar o eixo de uma porta próxima mesmo quando ela está fora da
grade, e pontos duplicados ou microcotovelos colineares são removidos. A limpeza ocorre somente ao
soltar o ponteiro: durante o gesto, o operador continua recebendo feedback visual contínuo e o
documento persiste apenas a geometria final estabilizada.

O código adaptado está isolado em `ipdVertexClean.ts`, com SPDX PolyForm Noncommercial, copyright,
arquivo de origem e commit exato. Sete regressões cobrem dobras reais, cura de desvios, portas fora
da grade, cadeias de vértices e extremidades livres.

## 7d. Classes de linha e glifos ISA do IPD

O editor agora oferece no menu de contexto do fio as 16 classes atuais do IPD Studio: linhas de
processo, impulso, sinais elétrico/pneumático/hidráulico/capilar/dados/software/eletromagnético,
enlace interno e cinco variantes especiais de tubulação. Espessuras e padrões tracejados vêm de
`src/canvas/lineStyle.ts`; os marcadores repetidos ao longo da rota vêm de `src/canvas/glyphs.ts` e
mantêm 12 px livres nas extremidades e nos cotovelos. `pipe.jacketed` é realmente desenhada em dois
traços SVG, não simulada por uma linha grossa única.

A propriedade `lineClass` é opcional e persistida em `.lsproj` e `.lssubcircuit`. Portanto, projetos
antigos continuam usando o fio elétrico nativo e sua coloração por tensão; nenhum estilo de processo
é imposto automaticamente. Dividir um fio propaga a classe às duas metades, e uma junção de grau 2
que separa classes diferentes não é colapsada, evitando perda silenciosa da representação. Oito
testes específicos cobrem o registro, traços, jaqueta, validação, tradução e posicionamento dos
glifos; as regressões de topologia e serialização cobrem split, transição e save/reopen.

A prancha `extension/test/e2e/artifacts/ipd-line-style-gallery.png`, gerada por
`npm --prefix extension run test:line-styles:visual`, foi inspecionada com todas as 16 classes lado a
lado e confirma visualmente os padrões, marcadores, cotovelos e a jaqueta dupla.

## 7e. Biblioteca P&ID completa herdada do IPD Studio

O passe anterior redesenhava à mão cada família de equipamento. Isso respondia mal à pergunta
"cadê a válvula do IPD?": a geometria era nossa interpretação, não o acervo herdado. O
`scripts/generate-ipd-symbol-library.mjs` fecha essa lacuna sem criar um segundo aplicativo.

O gerador compila `external-research/ipd-studio-current/src/symbols/{types.ts,lib/*.ts}` para CJS em
`.lasecsimul-cache/ipd-symbols`, executa cada `SymbolDef.render(cfg)` **em tempo de geração** e grava
o SVG resultante no catálogo. Nada do IPD entra em tempo de execução: não há React, JointJS, iframe,
servidor nem dependência de runtime — apenas geometria congelada em `PackageShape`. Cada combinação
de `configOptions` vira uma primitiva `{kind:"svg", stateVisible:{when}}` da mesma peça, então
`cv.globe` carrega 56 variantes (atuador × modo de falha × posicionador) e o usuário troca entre elas
pelo painel de propriedades, sem trocar de componente.

São **193 símbolos** publicados em `Grafico > P&ID > <categoria>`, elevando o catálogo gráfico a 242
entradas. Todos nascem com `pinCount: 0` (fora do solver, regra FEAT-008), `aspect: "fixed"` e
`dynamicLayout.schematicWidth/Height` — sem esses dois últimos, o desenho herdado esticaria e
deixaria de ser o símbolo ISA que o upstream desenhou. O gate `graphicsLibrary.test.ts` foi
estendido para exigir exatamente isso dos símbolos portados.

Proveniência: o registro de reúso em `docs/third-party/IPD_STUDIO_PROVENANCE.md` classifica o lote
como `DIRECT_PORT`, com arquivo de origem, commit fixado, PolyForm Noncommercial 1.0.0 e o aviso
exigido repetidos por item e dentro do próprio SVG. O uso é acadêmico/não comercial, e o código
portado nunca é apresentado como original.

## 7f. Operar não é editar: overlay de instância e controles HMI

Duas falhas apareciam juntas quando uma tela de processo era usada como subcircuito: arrastar um
símbolo projetado sobre a instância reescrevia `exposedComponents[].x/y` do `.lssubcircuit` sem o
usuário ter entrado em modo de edição nenhum, e "Abrir Subcircuito" ficava inacessível porque o
overlay capturava o clique antes do componente hospedeiro.

A regra agora é explícita: **no canvas principal, o overlay só opera; autorar posição pertence a
"Abrir Subcircuito" → Modo Símbolo.** Em CSS, `.component--board-overlay` recebe
`pointer-events: none` e só os itens operáveis reativam o ponteiro via
`.component--board-overlay--interactive`. O arrasto de reposicionamento foi removido desse caminho.

O que "operar" significa passou a valer também dentro do subcircuito.
`applyBoardOverlayOperatorAction` é o irmão de `applyGraphicalOperatorAction` com uma única diferença
que importa: controle e alvo são componentes internos, então a escrita vai por
`requestUpdateBoardOverlayProperty` (que resolve o filho no Core e persiste no manifesto) em vez de
`requestUpdateProperty`, que endereça o circuito principal. Sem isso, um slider desenhado numa tela
era visível e clicável mas não escrevia em lugar nenhum. Estão cobertos: arraste de `slider` e
`setpoint` (razão do ponteiro na caixa × `[actionMin, actionMax]`), pressionar/soltar momentâneo,
alternar, o `closed` dos botões nativos do catálogo e entrada numérica por duplo clique.

O catálogo expõe sete controles de operador: `hmi_button`, `hmi_lamp_button`, `hmi_toggle`,
`hmi_switch`, `slider`, `setpoint` e `numeric_input`. O `hmi_lamp_button` foi acrescentado
especificamente para o Command Panel do piloto, onde a referência TDPS mostra lâmpadas que também
são comandos — antes eram círculos decorativos. Os campos de Ação (`actionTarget`,
`actionProperty`, `actionMode`, …) ficam persistidos e vazios por padrão: o compositor não adivinha
um alvo, quem monta a tela aponta o comando.

## 8. Lacunas e limitações (explícitas)

1. **DSL não carrega geometria.** `x`/`y`/`rotation` não são emitidos pelo `DslSerializer` para
   **nenhum** componente — limitação pré-existente, não introduzida aqui. Objetos gráficos e suas
   propriedades (inclusive bindings) sobrevivem ao round-trip; a posição só é preservada para um id
   que já existe no estado. Travado por teste (`graphicsDslRoundTrip`, último caso) para que mudar
   isso seja decisão consciente. Extensão proposta: cláusula opcional `at(x, y, rot)` por componente.
2. **Rotação em passos de 90°.** Contrato de `ProjectComponent.visual.rotation`; símbolos foram
   desenhados para ler bem nos quatro quadrantes. Rotação livre exigiria mudar o formato.
3. **Caixa de Polpa** (§6, nota 1): caçamba, peneira e separador magnético usam equipamento genérico
   com rótulo.
4. **Sem roteamento ortogonal automático de tubulação.** O tubo é composto por trechos + cotovelos +
   tês colocados pelo usuário (ou pelo compositor). Reaproveitar o roteador de fios exigiria
   estendê-lo para um domínio não elétrico; foi avaliado e deliberadamente não feito.
5. **Sem animação de fluxo.** A seta de fluxo acende/apaga com o estado, mas não anima. A FEAT-008
   pede animação declarativa e limitada; o IR de pintura ainda não tem eixo de tempo.
6. **Agrupamento é de seleção.** `__ui_group` faz a seleção expandir para o grupo (mover/girar/
   apagar já operavam sobre a seleção). Não cria um objeto composto — isso é subcircuito, que já
   existe.
7. **Alças de redimensionar só na seleção única.** Com vários selecionados, arrastar continua
   movendo o grupo.
8. **`electrical_signal_bridge_live` continua travando** — defeito pré-existente do Core,
   comprovadamente anterior a este trabalho e não relacionado à camada gráfica; não foi investigado.
9. **23 das 24 telas são geradas, não desenhadas à mão.** O compositor produz um diagrama semântico
   correto e ligado, com a mesma estrutura para todos; ele não reproduz o arranjo espacial exato de
   cada referência original. *Vazão Linear Simples* é a exceção: um sinótico curado, com os quatro
   dispositivos HMI detalhados e tubulação volumétrica, que serve de referência de acabamento para
   as demais. As telas são objetos editáveis — ajustar o arranjo é arrastar.

# Geometria comum alinhada ao SimulIDE — 2026-07-13

## Escopo e versão de referência

A referência auditada é a árvore real em `.codex-simulide-src`, commit
`ed253d6612b1293a320d68d6e27968cd7e6523c4` (2026-05-17). As imagens fornecidas motivaram a
investigação, mas nenhuma regra abaixo depende de um `typeId` específico.

## Como o SimulIDE faz

| Tema | Implementação e referência exata |
| --- | --- |
| item e coordenadas locais | `Component : CompBase, QGraphicsItem` em `src/components/component.h:21`; `position()`/`setPosition()` delegam a `pos()`/`setPos()` em `component.h:39-40`. `m_area` é local (`component.h:232`). |
| bounds | `Component::boundingRect()` retorna `m_area` acrescido de 2 unidades em cada lado para não cortar o traço (`component.h:25-27`). Filhos como `Pin` têm `boundingRect()` próprio (`pin.h:38`). |
| terminal elétrico | `Pin` também é `QGraphicsItem` filho (`pin.h:26-30`). O construtor faz `setPos(pos)` (`pin.cpp:21-22,70`); conexão, colisão e roteamento usam diretamente `scenePos()` (`pin.cpp:151-187,193-200`). Logo, o `QPoint` do construtor é o terminal elétrico, não o contato com o corpo. |
| lead visual | `Pin` faz `setRotation(180-angle)` (`pin.cpp:71`), e `paint()` desenha de `(0,0)` a `(length-0.7,0)` com `QPen` de largura 3, cap/join redondos (`pin.cpp:447-460`). O contato interno é derivado; não há uma segunda coordenada elétrica. |
| labels | Fonte `Ubuntu Mono`, pixel size 7 (`pin.cpp:55-64`); posição deriva de `pos`, `angle`, `length`, espaço e flips (`pin.cpp:256-316`). Labels do componente são itens próprios e recebem transform inversível (`component.cpp:64-85,487-494`). |
| rotação/espelho | rotação é a propriedade nativa de `QGraphicsItem` (`component.h:42-43`); passos de 90° em `component.cpp:500-515`. Espelho usa um único `QTransform::fromScale(hflip,vflip)` no item pai, propagando só o ajuste de label aos pinos (`component.cpp:473-498`). Qt transforma automaticamente filhos e `scenePos()`. |
| grid | grid visual tem pitch 8 e offset 4 (`circuit.cpp:1223-1265`). Movimento geral usa `toGrid`, snap de 4 (`utils.cpp:211-239`, `component.cpp:223`); criação de componentes usa `toGrid` (`circuit.cpp:564-568`). Coordenadas locais de pino só são snapadas quando editadas (`pin.cpp:334-341`), não durante paint. |
| zoom/escala | `CircuitView` habilita antialiasing de forma, texto e pixmap (`circuitview.cpp:46-50`). Zoom aplica `QGraphicsView::scale()` uniformemente à cena (`circuitview.cpp:84-89`); a geometria do componente não é recalculada por zoom. |
| largura de linha e DPR | As larguras são unidades da cena (`QPen` comum); não há `setCosmetic(true)` nem tratamento manual de `devicePixelRatio` na árvore auditada. Qt/QGraphicsView faz a projeção para o dispositivo. |
| shape/seleção | o padrão é `boundingRect()` do item; componentes que precisam de silhueta especial sobrescrevem `shape()` com `QPainterPath`, por exemplo `Gate::shape()` (`src/components/logic/gate.cpp:86`) e `Probe::shape()` (`src/components/meters/probe.cpp:208`). |
| repetitivos | `LedMatrix::createMatrix()` deriva `m_area`, LEDs e pinos de `rows`, `cols` e pitch 8 (`ledmatrix.cpp:98-148`). `LedBar::createLeds()` deriva os pares P/N e LEDs de `size` (`ledbar.cpp:70-101`), e `setSize()` deriva `m_area` (`ledbar.cpp:137-150`). `SevenSegment::setNumDisplays/createDisplay()` deriva bounds, common pins e oito segmentos por display (`sevensegment.cpp:131-165,240-285`). |
| modo placa | `Component` persiste conjuntos separados de posição/rotação/flip de circuito e placa, mas mantém o mesmo objeto e os mesmos `Pin`/estado elétrico (`component.h:80-102,168,207-214`; `component.cpp:55-62,120-130`). |

`QGraphicsItem`/`QGraphicsScene`, `QPainter`, `QPen`, `QPainterPath`, `QTransform`, `QGraphicsSimpleTextItem`,
`QGraphicsProxyWidget` e `QGraphicsView` são, portanto, a arquitetura comum — não offsets globais por device.

## Comparação e causa raiz

O renderer web já possuía `PackageDescriptor`, mas atribuía duas semânticas incompatíveis a
`PackagePin.x/y`:

- na maioria do catálogo, `x/y` era tratado como contato no corpo e o endpoint era calculado com
  `x + cos(angle)*length`;
- em componentes auditados mais recentemente, `x/y` já era o terminal real e uma flag
  `leadOrigin:"terminal"` mudava a fórmula;
- paint, `pinLocalPosition`/wire, bounds e transformação inicial percorriam ramos diferentes;
- flip/rotação/bounds estavam duplicados em `main.ts` e `wireTopology.ts`;
- `packageBodySvg` desenhava `pkg.pins` não transformados, enquanto o endpoint usava os pinos
  transformados de `ResolvedPackage`.

Essa ambiguidade explica deslocamentos de exatamente um comprimento de lead, bounds com folga,
divergência após rotação e correções locais recorrentes. A causa não era device pixel ratio nem zoom.

Uma validação visual posterior revelou uma segunda normalização antiga ainda ativa nos dados:
`simulidePaintToPackageShapes` normalizava `m_area`, mas alguns pinos e `bounds` já tinham sido
deslocados manualmente para `0..width/height`. Corpo e terminal acabavam usando origens diferentes;
na matriz isso produzia exatamente uma célula vazia entre a borda inferior e os leads. O novo modo
genérico `coordinateSpace:"simulide-local"` elimina essa camada: primitivas, labels e pinos guardam
os `QPoint` nativos e passam uma única vez pela transformação de `m_area`.

Durante a inserção apareceu outra manifestação da mesma confusão de unidade: o preview chamava
`componentBox` sem as propriedades padrão, e `numericPackageValue` tratava o fallback final do campo
como entrada bruta da expressão. Assim, a matriz declarada com largura 72 virava `72*8+8=584`, e a
barra com altura 64 virava `64*8=512`. O avaliador agora devolve o fallback final sem reaplicar a
expressão; somente o `fallback` declarado dentro da expressão é base bruta. O preview usa as mesmas
`defaultProperties` usadas para criar a instância.

## Infraestrutura implementada

1. `PackagePin.x/y` agora tem uma única definição: terminal elétrico local. O lead começa nesse ponto;
   seu contato interno é derivado por `angle` e `length`. A flag `leadOrigin` foi removida do modelo e
   do catálogo.
2. `resolvePackageLayout`, `packagePinLeadSvg` e `pinLocalPosition` consomem a mesma geometria
   resolvida. Pinos com `initialTransform` agora são os mesmos no desenho e na topologia.
3. `componentGeometry.ts` centraliza origem/pivô, flip, rotação, local→cena, cena→local, bounds
   transformados, transform SVG e snap. `main.ts` e `wireTopology.ts` deixaram de ter matrizes próprias.
4. O sanitizador converte somente manifestos legados que declarem explicitamente
   `leadOrigin:"body"` na borda de entrada; o restante da aplicação só vê terminais canônicos.
5. O catálogo recebeu `geometryConvention:"simulide-terminal-v1"`; 162 entradas estáticas/dinâmicas
   foram normalizadas. A ferramenta `scripts/migrate-package-pin-terminals.mjs --check` impede a
   reintrodução da convenção antiga e rejeita arrays estáticos quando `dynamicLayout.replacePins`
   já é a fonte paramétrica da pinagem, bem como IDs estáticos que sobreponham os prefixos dos
   `pinGroups`. A redução de 172 para 162 removeu as 11 entradas duplicadas do mux analógico.
6. Layout repetitivo continua declarativo e comum: `dynamicLayout.pinGroups` deriva quantidade,
   id, posição e pitch; `simulidePaint.repeat` deriva células/segmentos. Matriz, barra, keypad,
   resistor DIP, bus e mux já passam por esse mecanismo.
7. Modo Placa continua selecionando outra aparência (`boardPackage`) sem duplicar pinos, topologia,
   persistência ou estado elétrico.
8. Dez pacotes — potenciômetro, mux analógico, LED, LED RGB, barra, matriz, sete-segmentos, motor
   DC, stepper e lâmpada incandescente — agora consomem coordenadas
   locais reais da fonte por `coordinateSpace:"simulide-local"`. O sete-segmentos padrão foi corrigido
   para os 9 pinos de `createDisplay(0)`; o décimo terminal artificial foi removido também do Core.

Após a migração geral, um erro de dado foi confirmado contra o upstream: o pino central do
potenciômetro é `Pin(270,QPoint(0,16),...)` (`potentiometer.cpp:32-35`), não 90°. Esse ângulo foi
corrigido; não foi introduzido offset especial.

Na barra e na matriz, a primitiva externa ainda começava em `x=-16`, posição dos terminais, embora
`LedBar::paint()` e `LedMatrix::paint()` desenhem diretamente `m_area`, cujo início é `x=-8`. As
primitivas foram corrigidas para `x=-8`. A lâmpada foi migrada para os `Comp2Pin` nativos em
`(-16,0)/(16,0)`, comprimento 8, com corpo `m_area=(-10,-10,20,20)`.

## Validação

- `componentGeometry.test.ts`: quatro rotações, ordem flip→rotate, round-trip local/cena, bounds,
  transform SVG e snap.
- `componentSymbols.test.ts`: endpoint igual ao início do lead; famílias LED, ativos, DIP,
  potenciômetro e layouts dinâmicos; auditoria automática de 132 terminais estáticos do catálogo.
- `wireTopology.test.ts`: endpoint de fio usa a mesma posição canônica do renderer.
- A suíte existente cobre persistência de posição/rotação e round-trip de projeto; Modo Placa cobre
  posição/rotação/flip independentes.

## Auditoria ampla e limite comprovado

`scripts/audit-simulide-rendering.mjs --write` inventariou 129 registros: 45 usam `simulidePaint`,
53 `viewSpec`, 19 `package.shapes` e 12 ainda dependem de fallback. A infraestrutura geométrica é
comum a todos os packages e fallbacks, mas equivalência visual pixel a pixel de todos os 129 não pode
ser declarada: 84 registros ainda não têm paint C++ integralmente traduzido ou referência raster
controlada. Isso é trabalho de conteúdo visual, não uma razão para reintroduzir coordenadas de pino
por device. O inventário detalhado está em `.codex-validation/render-audit.json`.

Não foi criada uma imagem “antes” sintética, pois ela adulteraria a evidência anexada pelo usuário.
As imagens fornecidas permanecem a referência anterior; snapshots raster controlados por tolerância
exigem primeiro baselines reais exportados do SimulIDE para os mesmos estados, zoom, fonte e DPR.

# Janelas expandidas dos instrumentos — baseline SimulIDE

Data da comparação: 2026-07-13. Referência local: `.codex-simulide-src`.

## Resultado da comparação anterior à implementação

O SimulIDE não usa `QChart`, `QGraphicsView` nem um timer privado da janela. `OscWidget` e
`LaWidget` são `QDialog` montados por Qt Designer e compartilham `PlotDisplay`, um `QWidget`
customizado pintado diretamente por `QPainter`. O componente mantém buffers e estado; a janela só
apresenta e edita esse estado. Ao expandir, o mesmo `PlotDisplay` é movido do widget compacto para o
dialog, evitando duas fontes de aquisição.

O LasecSimul já possuía aquisição assíncrona por IPC, cores corretas, controles de canais, tunnels,
trigger e traço digital ortogonal. As diferenças objetivas eram:

- SVG fixo de 560 x 448 e popup sem resize persistente;
- reconstrução completa do DOM a cada atualização de histórico;
- ausência de wheel zoom ancorado, pan e zero de tempo móvel;
- ausência de crosshair e leituras sob o cursor;
- traço analógico interpolado por diagonais, diferente do sample-and-hold do SimulIDE;
- ausência de decimação min/max por coluna de pixel;
- estado de escala, posição, visibilidade, trigger e geometria perdido ao fechar/reabrir;
- controles do analisador organizados em painel genérico, não na distribuição lateral/inferior do
  `LaWidget`;
- exportação somente CSV, enquanto o SimulIDE também expressa o caso digital como VCD.

## Fontes Qt verificadas

- `plotdisplay.cpp:19-60`: configuração do `QWidget`, cores, fontes e mouse tracking.
- `plotdisplay.cpp:67-105`: quadro temporal e recálculo por `width()`/`height()`.
- `plotdisplay.cpp:108-132`: `QWheelEvent` e zoom com âncora no cursor.
- `plotdisplay.cpp:135-179`: `QPainter`/`QPen`, fundo, dez divisões, trilhas e eixos.
- `plotdisplay.cpp:181-340`: antialiasing, cursor, traces e envelope min/max.
- `oscwidget.cpp:13-81` e `lawidget.cpp:15-41`: `QDialog`, button groups e controles.
- `oscwidget.cpp:378-399` e `lawidget.cpp:180-201`: eventos de mouse para navegação.
- `oscope.cpp:160-178` e `logicanalizer.cpp:172-190`: reutilização do display compacto.

## Arquitetura escolhida

A adaptação Webview preserva a separação já melhor que a do Qt legado: Core produz histórico,
Extension transporta IPC e uma camada de viewport pura transforma dados em geometria. Ambos os
instrumentos devem compartilhar estado versionado, zoom/pan/cursor, resize, grade e shell; cada um
mantém apenas controles e renderer específicos. A propriedade `__ui_instrumentView` persiste esse
estado sem ser enviada ao Core.

Esta documentação registra deliberadamente o estado antes da mudança. Resultados, arquivos e testes
executados serão acrescentados ao concluir a implementação.

## Implementação concluída

Foi criado `instrumentViewport.ts`, compartilhado pelos dois instrumentos. Ele concentra:

- clamp de dimensão da janela;
- transformação de tempo e posição;
- zoom de 20% ancorado no cursor;
- pan horizontal;
- traço analógico sample-and-hold;
- envelope min/max por coluna de pixel;
- codec versionado de estado;
- exportação VCD de histórico digital.

`main.ts` passou a usar a propriedade reservada `__ui_instrumentView`. Posição e tamanho da janela,
base e posição de tempo, escalas dos canais, trilhas, canal ativo, visibilidade, auto, trigger,
limiares e zero de tempo sobrevivem ao fechamento e ao round-trip do projeto. Essa propriedade é
filtrada por `coreLifecycle.ts`, portanto não cria dependência do Core.

O framebuffer não provoca mais reconstrução integral da janela em cada resposta de histórico:
`refreshInstrumentPopupPlots()` substitui somente o SVG, preservando foco, resize e gestos. O SVG
ocupa o espaço calculado pelo layout, enquanto controles laterais têm largura estável e passam para
baixo em viewport estreito. A janela usa limites mínimos/máximos relativos ao viewport e resize
nativo, sem coordenadas especiais por instrumento.

Comportamentos disponíveis:

- roda do mouse no plot: zoom ancorado;
- arrasto esquerdo: navegação temporal;
- botão central: move o zero de tempo;
- cursor: crosshair e tempo; no osciloscópio também tensão do canal/trilha ativa;
- osciloscópio: uma trilha inicial, 1 ms/div, 1/2/4 trilhas, sample-and-hold, máximo/mínimo,
  autoescala, trigger, hide e tabs Ch1–Ch4/All;
- analisador: 1 ms/div, oito canais ortogonais identificados, trigger, limiares, tunnels e VCD;
- pausa conserva o último quadro; stop limpa os buffers reais; run continua pelo polling IPC já
  assíncrono, sem timer concorrente na UI.

## Arquivos desta rodada

- `.spec/lasecsimul.spec` — contrato 29.11 e baseline comparativo;
- `extension/src/ui/webview/instrumentViewport.ts` — infraestrutura pura compartilhada;
- `extension/src/ui/webview/instrumentViewport.test.ts` — zoom, pan, bounds, persistência,
  sample-and-hold, decimação e VCD;
- `extension/src/ui/webview/main.ts` — integração, interação, persistência e atualização incremental;
- `extension/src/ui/webview/styles.css` — chassis responsivo, resize, plot, cursor e layout do
  analisador;
- `extension/package.json` — inclusão da nova suíte.

## Fechamento funcional

As regras vigentes estao centralizadas em `.spec/lasecsimul.spec`, secao 29.12; este documento
registra somente evidencias operacionais para nao duplicar a especificacao.

O Analyzer agora recebe descritores e amostras vetoriais reais pelo Core/IPC v2. Os oito pinos
antigos continuam abrindo como vetores de largura 1; canais novos aceitam sinal, barramento, elemento
ou slice e a Webview identifica cada bit como `DATA[n]`. Valores sao empacotados por largura, sem
converter barramentos em dezenas de doubles/objetos JSON.

A condicao de pausa agora e compilada e executada pelo Core no passo convergido. Lexer/parser/AST
controlados suportam comparacoes, logica, parenteses, sinais analogicos/digitais, corrente, elementos,
slices e bordas. O evento IPC leva instante, expressao e valores; a interface apenas reflete a pausa.
Foi adicionado ao `core_bootstrap_test` um fluxo real `setPauseCondition -> start -> notificacao`,
alem dos testes puros e de sessao.

O harness em `extension/test/e2e/run-webview-e2e.cjs` usa VS Code 1.128.0 isolado via
`@vscode/test-electron`, nao a instalacao/sessao do usuario. Ele abre a Webview real, carrega
`fixtures/instruments.lsproj`, abre os dois popups, recebe dados, observa pausa, redimensiona,
fecha/reabre e compara PNGs com `pixelmatch`. Baselines: `snapshots/oscope.png` e
`snapshots/analyzer.png`; artefatos e metrica ficam em `artifacts/`.

Resultados finais de 2026-07-13:

- build Debug completo do Core concluido;
- Core: 43/43 testes;
- Extension: compilacao e suite completa sem falhas;
- E2E executado duas vezes (criacao e comparacao): 0 pixels diferentes para ambos os instrumentos,
  threshold 0,12, AA ignorado e limite 0,5%;
- carga Debug extrema, 32 canais x 64 bits x 1024 amostras: 271078 bytes e 49102 us de aquisicao,
  aproximadamente 48 us por amostra de 2048 bits.

Nao permanece pendencia tecnica nas tres frentes desta rodada. A aprovacao visual humana dos novos
baselines continua sendo uma decisao de produto, nao uma ausencia de cobertura automatica.

# ADR 0012 - Séries de sinais gravadas no Core e escoadas pelo frame de telemetria

## Objetivo

Definir de onde vêm os históricos de sinais `control.*` usados por gráficos, cursor, Riemann e painéis
auxiliares (Laboratório de Cálculo, sintonia PID, tendências de HMI).

## Status

Aceita e implementada (2026-10-17): `core/src/simulation/SignalRecorder.hpp`, comandos `subscribeSeries`/`unsubscribeSeries`,
grupo `series` do `getTelemetryFrame`. Gravação numa grade por assinatura (`periodNs`), não em todo passo estável; eventos
`start` e `parameter` (com `appliedAtNs`). Detalhes e decisões refinadas em [`docs/54 §0`](../54-laboratorio-calculo-validacao-e-riscos.md).

Complemento (2026-10-18): o painel PID também lê do gravador (`PidSeriesFeed`); a janela do Oscope, que continua no estado
do componente, passou a ser pedida por deltas (`history.sinceNs`). Custo medido: 5,2 ns por passo sem inscrição, 99,1 ns com
13 colunas.

## Contexto

- A telemetria contínua (`pollTelemetryFrame` → `getTelemetryFrame`) entrega o **último valor** de cada componente
  inscrito, a 20 Hz por padrão, com o tempo simulado do passo estável. Amostras entre ticks se perdem.
- Os blocos de sinal rodam no período do bloco (`samplePeriodNs`, 100 ms por padrão, 10 ms nos subcircuitos).
- O `Oscope` grava só tensões de nó MNA, 512 amostras, e sintetiza amostras retidas; não serve para sinais de bloco.
- Derivar/integrar com tempo de chegada de mensagem ou cadência de tela é incorreto.

## Decisão

1. Um `SignalRecorder` na `SimulationSession` grava, em anéis colunares pré-alocados, os slots inscritos depois de
   `signals.executeUntil(t)` em `onStableStepUnlocked`: uma linha quando t avança e algum valor muda ou um rate group
   inscrito ativa. Eventos (parâmetro aplicado, fronteira, derramamento, reset) têm tempo exato. Descontinuidades
   gravam duas linhas no mesmo t.
2. As linhas saem no **mesmo** IPC do tick de telemetria (`getTelemetryFrame` com `series: [{subscriptionId, sinceSeq}]`),
   limitadas ao orçamento do frame; o resto sai no tick seguinte. Nenhum timer ou canal novo.
3. O Host mantém um `SeriesStore` (Float64Array por geração) e envia só deltas aos painéis inscritos.

## Consequências

- Resolução = período real do bloco, independente da taxa de tela.
- Painéis passam a ler séries, não "último valor"; o painel PID deixa de depender de `Date.now()`.
- O Oscope continua com seu histórico próprio (semântica de instrumento).

# Investigação do sintoma 2 (onda serrilhada de `>seno:`/`>reta:`) — resultado: não reproduzido no backend isolado

Data: 2026-08-26. Complementa a seção 7 ("ainda não confirmado") de
[`39-i2c-mttcg-throughput-ceiling-2026-08-26.md`](39-i2c-mttcg-throughput-ceiling-2026-08-26.md) — arquivo separado de
propósito, porque aquele documento está em edição ativa (Codex) no momento desta investigação.

## O que foi testado

Projeto ESP32 + `outputs.ssd1306` (com pull-ups) + `peripherals.lasecplot`, rodando o firmware REAL
do usuário (`c:\SourceCode\II1P04_GPIO_Debug\sourcecode\merged.bin`, o mesmo `esp2.cpp` que emite
`>seno:` a cada 100ms e `>reta:` a cada 200ms). Rodado via `scripts/benchmark-real-esp32.mjs` com
`LASECSIMUL_BENCHMARK_UART_TIMELINE=1` (funcionalidade nova, adicionada pelo Codex nesta mesma
investigação) — captura o horário de parede de CADA lote UART recebido, não só o agregado.
`realTimeRate=1` (padrão de produção), 15 segundos, processo isolado.

## Resultado 1: o boot trava ~6,9s por causa do MESMO teto de I2C do sintoma 1

A timeline mostra um buraco de **336ms a 7.781ms** (quase 7 segundos) sem nenhum byte de UART —
exatamente a janela em que `inicializarDisplay()` (I2C, `begin()` + um `display()` dos 3 textos)
está rodando. Isso bate exatamente com o teto de vazão de I2C documentado no arquivo 39: o boot do
firmware do usuário já paga esse custo antes mesmo de chegar no `loop()` de telemetria. A primeira
linha de `>reta:`/`>seno:` só aparece depois disso, com `millis()` interno já em ~6500-6600 --
ou seja, os primeiros ~6,5 segundos "reais" de telemetria que o usuário esperaria ver já se foram
no boot travado, antes de qualquer amostra existir.

## Resultado 2: depois do boot, a entrega é regular -- NÃO serrilhada

Removendo os 18 primeiros lotes (banner de boot da ROM), os 236 intervalos entre lotes seguintes:

| Métrica | Valor |
|---|---:|
| Mínimo | 29,5 ms |
| Máximo | 62,6 ms |
| Média | 31,5 ms |
| Mediana | 31,3 ms |

223 dos 236 intervalos (94%) caem entre 30-39ms — batendo com o poll de ~25ms configurado no
broker, sem nenhum salto grande. Só 2 intervalos chegaram a 60-69ms; nenhum saiu disso. **A
hipótese da seção 7 do doc 39 (rajadas por Scheduler ocupado, lote grande com timestamp único) NÃO
se confirma neste teste** -- o backend (Core + ponte UART + `LasecPlotBroker`), isolado, entrega os
lotes de forma consistentemente fina e regular, bem mais fina que os períodos de 100/200ms que o
firmware usa pra `>seno:`/`>reta:`.

## Interpretação

O sintoma 2 original (forma de onda poligonal/serrilhada no LasecPlot) **provavelmente não vem do
pipeline UART do LasecSimul** -- pelo menos não do jeito que a hipótese anterior propunha. Duas
explicações prováveis restantes, nenhuma testável a partir daqui:

1. **Contenção do processo da extensão interativa**: este teste rodou um Core+QEMU isolados, sem
   nada mais competindo por CPU/laço de eventos. A sessão real do usuário roda dentro do processo
   de extensão do VSCode, que também está renderizando o esquemático, atualizando painéis de
   propriedade, etc. -- contenção ali (não testada aqui) poderia introduzir irregularidade que este
   teste isolado não capturaria.
2. **Do lado da extensão LasecPlot** (renderização do gráfico): fora do alcance deste repositório
   pra inspecionar.

Se o usuário conseguir reproduzir o sintoma com a extensão LasecPlot aberta e outra ferramenta
(ex.: o comando "LasecSimul: List LasecPlot Endpoints", que já existe pra diagnóstico) observando o
mesmo fluxo, dá pra comparar diretamente "o que o LasecSimul enviou" vs "o que o LasecPlot mostrou"
sem precisar reproduzir a UI interativa inteira.

## Nota lateral (não é o foco desta investigação, mas fica registrado)

O buraco de ~6,9s no boot é uma manifestação A MAIS do mesmo teto de I2C do documento 39 -- reforça
que corrigir aquele problema também adianta em quantos segundos o usuário espera até ver a PRIMEIRA
amostra de telemetria, não só a rolagem do OLED.

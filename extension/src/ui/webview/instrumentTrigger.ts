/**
 * Detecção de trigger e janelamento de tempo da janela "Expande" (osciloscópio/analisador
 * lógico) -- lógica pura, sem DOM, extraída de `main.ts` pra poder ser testada diretamente (mesmo
 * padrão de `wireGeometry.ts`). Porta fiel de `SimulIDE-dev/src/components/meters/
 * oscopechannel.cpp`/`oscope.cpp` (ver `C:\SourceCode\simulide_2\src`) -- mesmo algoritmo de
 * auto-detecção de período/amplitude/ponto-médio e alinhamento de fase que um osciloscópio de
 * bancada real usa pra manter a onda "parada" na tela.
 */

export interface ChannelTriggerInfo {
  periodNs?: number;
  risingEdgeNs?: number;
  amplitude: number;
  mid: number;
}

/** Acha o índice (na história COMPLETA) da transição de subida mais recente cruzando o threshold --
 * usado pelo trigger do analisador lógico (sinal digital, nível já conhecido -- 0/1 -- não precisa
 * de auto-detecção de amplitude, diferente do osciloscópio analógico abaixo). `undefined` se não há
 * nenhuma transição na história disponível ainda. */
export function findTriggerAnchorIndex(history: number[], thresholdUp: number): number | undefined {
  for (let i = history.length - 1; i > 0; i--) {
    const previous = history[i - 1];
    const current = history[i];
    if (previous !== undefined && current !== undefined && previous < thresholdUp && current >= thresholdUp) return i;
  }
  return undefined;
}

/** Constrói um traço digital sample-and-hold: mantém o nível anterior horizontalmente até a nova
 * amostra e então faz uma aresta vertical. Uma polilinha comum ligaria 0→1 por uma diagonal e
 * inventaria valores analógicos que não existem num analisador lógico. */
export function digitalStepPath(masks: number[], bit: number, width: number, high: number, low: number): string {
  let path = "";
  let previousY: number | undefined;
  masks.forEach((mask, index) => {
    const x = (index / Math.max(1, masks.length - 1)) * width;
    const y = ((mask >>> bit) & 1) === 1 ? high : low;
    if (index === 0) path = `M ${x.toFixed(1)} ${y.toFixed(1)}`;
    else if (previousY === y) path += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    else path += ` L ${x.toFixed(1)} ${(previousY ?? y).toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)}`;
    previousY = y;
  });
  return path;
}

/** Porta fiel de `OscopeChannel::voltChanged()`/`updateStep()` (SimulIDE-dev real) -- rastreia
 * mínimo/máximo ao longo dos ciclos e detecta a borda de subida cruzando o PONTO MÉDIO da
 * amplitude do próprio sinal (não um nível fixo arbitrário) -- mesmo princípio de "Auto Trigger
 * Level" de um osciloscópio de bancada: o nível de disparo se ajusta sozinho a QUALQUER sinal
 * periódico, não precisa ser configurado à mão pra cada amplitude/offset. `filterThreshold` é
 * histerese (ignora variações menores que isso, evita disparo falso por ruído) -- mesmo papel de
 * `OscWidget::filterBox`. Exige 2 ciclos completos pra "travar" no período (mesma exigência do
 * original, `m_nCycles > 1`) -- sinais não periódicos (ruído, pulso único, DC) nunca produzem
 * `periodNs` definido, e quem chama cai pro modo "free running" (mostra a amostra mais recente) em
 * vez de fingir um trigger que não existe. */
export function detectChannelTrigger(timestampsNs: number[], values: number[], filterThreshold: number): ChannelTriggerInfo {
  let rising = false;
  let falling = false;
  let lastValue = 0;
  let maxVal = -Infinity;
  let minVal = Infinity;
  let nCycles = 0;
  let numMax = 0;
  let risingEdgeNs: number | undefined;
  let periodNs: number | undefined;
  let dispMax = 0;
  let dispMin = 0;

  for (let i = 0; i < values.length; i++) {
    const data = values[i]!;
    const t = timestampsNs[i]!;
    const delta = data - lastValue;
    if (delta === 0) continue;
    if (data > maxVal) maxVal = data;
    if (data < minVal) minVal = data;

    if (delta > filterThreshold) {
      if (falling && !rising) {
        numMax++;
        nCycles++;
        falling = false;
      }
      rising = true;
      lastValue = data;

      if (nCycles > 2) {
        nCycles = 0;
        maxVal = -Infinity;
        minVal = Infinity;
      } else if (nCycles > 1) {
        const amplitude = maxVal - minVal;
        const mid = minVal + amplitude / 2;
        if (data >= mid) {
          if (numMax > 1) {
            dispMax = maxVal;
            dispMin = minVal;
            maxVal = -Infinity;
            minVal = Infinity;
          }
          nCycles--;
          if (risingEdgeNs !== undefined && risingEdgeNs > 0) periodNs = t - risingEdgeNs;
          risingEdgeNs = t;
        }
      }
    } else if (delta < -filterThreshold) {
      if (rising && !falling) rising = false;
      falling = true;
      lastValue = data;
    }
  }

  // "Onda perdida" -- mesmo critério do real (tempo desde a última borda > 2 períodos): a última
  // amostra ficou muito mais recente que a última borda detectada, então o sinal parou de ser
  // periódico (ou parou de oscilar) -- não finge um trigger estável que não existe mais.
  const lastSampleNs = timestampsNs[timestampsNs.length - 1];
  if (periodNs !== undefined && lastSampleNs !== undefined && risingEdgeNs !== undefined && lastSampleNs - risingEdgeNs > periodNs * 2) {
    periodNs = undefined;
  }

  return { periodNs, risingEdgeNs, amplitude: dispMax - dispMin, mid: dispMin + (dispMax - dispMin) / 2 };
}

/** Porta fiel de `Oscope::updateStep()` -- alinha o FIM da janela exibida à borda de subida mais
 * recente do canal de trigger, escolhendo um nº PAR de períodos pra encaixar o quadro de tempo
 * exibido (`timeFrameNs`) -- é isto que faz a onda parecer "parada" na tela (cada redesenho mostra
 * a MESMA fase do ciclo), em vez de deslizar a cada atualização. Sem trigger detectado, cai pra
 * "free running": mostra sempre a amostra mais recente. */
export function triggerAlignedWindowEndNs(latestSampleNs: number, trigger: ChannelTriggerInfo, timeFrameNs: number): number {
  if (trigger.periodNs === undefined || trigger.risingEdgeNs === undefined || trigger.periodNs <= 0) return latestSampleNs;
  const period = trigger.periodNs;
  let nCycles = Math.floor(timeFrameNs / period);
  if (timeFrameNs % period !== 0) nCycles++;
  if (nCycles % 2 !== 0) nCycles++;
  let delta = (nCycles * period) / 2 - timeFrameNs / 2;
  if (delta > trigger.risingEdgeNs) delta = trigger.risingEdgeNs;
  return trigger.risingEdgeNs - delta;
}

/** Janela de amostras visível no plot, a partir de um timestamp de FIM (ns, tempo simulado real) e
 * largura da janela (ns) -- nunca assume espaçamento uniforme entre amostras (a gravação no Core é
 * por tempo decorrido, não por contagem, ver doc de `Oscope.hpp`). */
export function visibleSampleWindowByTime(timestampsNs: number[], windowEndNs: number, windowNs: number): { start: number; end: number } {
  if (timestampsNs.length === 0) return { start: 0, end: -1 };
  let end = timestampsNs.length - 1;
  while (end > 0 && timestampsNs[end]! > windowEndNs) end--;
  let start = end;
  while (start > 0 && timestampsNs[start - 1]! >= windowEndNs - windowNs) start--;
  return { start, end };
}

import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import { detectChannelTrigger, digitalStepPath, findTriggerAnchorIndex, triggerAlignedWindowEndNs, visibleSampleWindowByTime } from "./instrumentTrigger";

(async () => {
  const { test, finish } = createTestRunner("instrumentTrigger — testes puros (porta do trigger real do SimulIDE)");

  await test("detectChannelTrigger: onda quadrada periódica trava no período real (auto-nível, sem threshold fixo)", () => {
    // Onda quadrada 5V/0V com borda de subida a cada 1000ns (mesmo traçado de
    // OscopeChannel::voltChanged() -- precisa de 2 ciclos completos pra "travar" no período).
    const timestampsNs = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000];
    const values =        [5,    0,    5,    0,    5,    0,    5,    0,    5,    0];
    const trigger = detectChannelTrigger(timestampsNs, values, 1);
    assert(trigger.periodNs === 1000, `período deveria ser 1000ns, recebido ${trigger.periodNs}`);
    assert(trigger.risingEdgeNs === 4500, `última borda de subida deveria ser 4500ns, recebido ${trigger.risingEdgeNs}`);
    assert(trigger.amplitude === 5, `amplitude deveria ser 5V, recebido ${trigger.amplitude}`);
    assert(trigger.mid === 2.5, `ponto médio deveria ser 2.5V, recebido ${trigger.mid}`);
  });

  await test("detectChannelTrigger: sinal DC constante nunca trava num período (sem trigger, cai pro free-running)", () => {
    const timestampsNs = [0, 1000, 2000, 3000];
    const values = [3.3, 3.3, 3.3, 3.3];
    const trigger = detectChannelTrigger(timestampsNs, values, 0.05);
    assert(trigger.periodNs === undefined, "DC constante não deveria detectar período");
    assert(trigger.risingEdgeNs === undefined, "DC constante não deveria detectar borda de subida");
  });

  await test("detectChannelTrigger: ruído menor que o filtro (histerese) é ignorado, não conta como borda", () => {
    // Mesma onda quadrada do 1º teste, mas com pequenas variações de ruído (0.02V) intercaladas --
    // abaixo do filterThreshold de 0.1V, não deveriam interferir na detecção do período real.
    const timestampsNs = [500, 600, 1000, 1100, 1500, 1600, 2000, 2100, 2500, 2600, 3000, 3100, 3500];
    const values =        [5,   5.02, 0,   0.01, 5,    4.99, 0,   0.02, 5,    4.98, 0,    0.01, 5];
    const trigger = detectChannelTrigger(timestampsNs, values, 0.1);
    assert(trigger.periodNs === 1000, `ruído sub-limiar não deveria afetar o período detectado (1000ns), recebido ${trigger.periodNs}`);
  });

  await test("detectChannelTrigger: 'onda perdida' -- sinal periódico que parou de oscilar não finge trigger estável", () => {
    const timestampsNs = [500, 1000, 1500, 2000, 2500, 3000, 3500, 50000];
    const values =        [5,   0,    5,    0,    5,    0,    5,    5];
    const trigger = detectChannelTrigger(timestampsNs, values, 1);
    assert(trigger.periodNs === undefined, "sinal parado há muito tempo (>2 períodos) não deveria manter período travado");
  });

  await test("findTriggerAnchorIndex: acha a transição de subida mais recente cruzando o threshold", () => {
    const history = [0, 0, 1, 1, 0, 0, 1, 1];
    const index = findTriggerAnchorIndex(history, 1);
    assert(index === 6, `deveria achar a borda mais recente no índice 6, recebido ${index}`);
  });

  await test("findTriggerAnchorIndex: sem nenhuma transição devolve undefined", () => {
    const index = findTriggerAnchorIndex([0, 0, 0, 0], 1);
    assert(index === undefined, "sem transição deveria devolver undefined");
  });

  await test("digitalStepPath: transições lógicas são ortogonais, nunca diagonais", () => {
    const path = digitalStepPath([0, 1, 1, 0], 0, 90, 10, 30);
    assert(path === "M 0.0 30.0 L 30.0 30.0 L 30.0 10.0 L 60.0 10.0 L 90.0 10.0 L 90.0 30.0",
      `traço digital deveria manter nível e criar aresta vertical: ${path}`);
  });

  await test("triggerAlignedWindowEndNs: sem período detectado, cai pro free-running (mostra a amostra mais recente)", () => {
    const end = triggerAlignedWindowEndNs(9999, { amplitude: 0, mid: 0 }, 5000);
    assert(end === 9999, `sem trigger deveria devolver o timestamp mais recente (9999), recebido ${end}`);
  });

  await test("triggerAlignedWindowEndNs: com trigger, encaixa nº PAR de períodos no quadro de tempo (mesma matemática de Oscope::updateStep())", () => {
    // risingEdge=4500, period=1000, timeFrame=3500 -> nCycles=4 (par), delta=250, fim=4250.
    const end = triggerAlignedWindowEndNs(999999, { periodNs: 1000, risingEdgeNs: 4500, amplitude: 5, mid: 2.5 }, 3500);
    assert(end === 4250, `esperado 4250 (alinhado de fase), recebido ${end}`);
  });

  await test("visibleSampleWindowByTime: histórico vazio devolve janela vazia", () => {
    const { start, end } = visibleSampleWindowByTime([], 1000, 500);
    assert(start === 0 && end === -1, `histórico vazio deveria devolver {start:0,end:-1}, recebido {${start},${end}}`);
  });

  await test("visibleSampleWindowByTime: recorta pelos timestamps reais, não por contagem de amostra", () => {
    const timestampsNs = [0, 100, 200, 300, 400, 500];
    const { start, end } = visibleSampleWindowByTime(timestampsNs, 350, 200);
    assert(start === 2 && end === 3, `esperado {start:2,end:3} (amostras em [150,350]), recebido {${start},${end}}`);
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

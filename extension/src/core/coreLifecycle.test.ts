import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { RollingRateSampler } from "./rollingRateSampler";

/** Achado 2026-07-22: usuário reporta LED de 500ms via millis() levando ~4s reais mesmo com o
 * indicador de velocidade da simulação em "100%" -- a causa é que esse indicador mede só o solver
 * elétrico (`Scheduler::nowNs()`, pareado ao relógio de parede por design), sem relação nenhuma com
 * o progresso real do MCU/QEMU (base de `millis()`). `RollingRateSampler` é a máquina de estado por
 * trás do NOVO indicador honesto (`mcuRealTimeRatio`) e do já existente (`simulationRate`) --
 * extraída de `pollSimulationRate` pra ser testável sem mockar IPC/timers/`vscode`. */
(async () => {
  const { test, finish } = createTestRunner("coreLifecycle — RollingRateSampler");

  await test("resetOriginEveryTick=true (solver elétrico): primeira amostra nunca relata", () => {
    const sampler = new RollingRateSampler(50, true);
    const result = sampler.sample(1000, 500_000_000);
    assert(!result.report && result.rate === undefined, "primeira amostra não deveria relatar nada");
  });

  await test("resetOriginEveryTick=true: relata só quando a janela mínima passa, e taxa bate com Δvalor/Δparede", () => {
    const sampler = new RollingRateSampler(50, true);
    sampler.sample(1000, 0); // origem
    const tooSoon = sampler.sample(1010, 5_000_000); // só 10ms de janela, abaixo do mínimo (50ms)
    assert(!tooSoon.report, "janela abaixo do mínimo não deveria relatar");
    // Tempo simulado 100ms (1e8 ns) em 100ms de parede = taxa 1.0 (tempo real).
    const onTime = sampler.sample(1110, 5_000_000 + 100_000_000);
    assert(onTime.report && onTime.rate !== undefined && Math.abs(onTime.rate - 1.0) < 1e-6,
      `esperada taxa ~1.0 (tempo real), veio ${onTime.rate}`);
  });

  await test("resetOriginEveryTick=true: origem SEMPRE avança pro tick atual, mesmo quando a janela não fecha (nunca acumula atraso)", () => {
    const sampler = new RollingRateSampler(50, true);
    sampler.sample(1000, 0);
    sampler.sample(1010, 1_000_000); // janela pequena, não relata, mas origem deveria avançar pra cá
    // Se a origem tivesse ficado presa em wallMs=1000, Δparede aqui seria 100ms (>50) -- mas como
    // avançou pro tick de 1010, Δparede real é só 90ms, ainda >50, então relata; o que importa é que
    // a taxa reflita a origem de 1010, não a de 1000 (Δvalor 4_000_000ns / Δparede 90ms != o que
    // daria a origem antiga).
    const result = sampler.sample(1100, 5_000_000);
    assert(result.report, "janela de 90ms deveria disparar relatório");
    const expectedRate = (5_000_000 - 1_000_000) / 1e6 / 90; // origem em (1010, 1_000_000), não (1000, 0)
    assert(result.rate !== undefined && Math.abs(result.rate - expectedRate) < 1e-6,
      `taxa deveria usar a origem do tick MAIS RECENTE (1010), esperado ${expectedRate}, veio ${result.rate}`);
  });

  await test("resetOriginEveryTick=false (MCU/QEMU): preserva a origem até a janela fechar, em vez de resample a cada tick", () => {
    const sampler = new RollingRateSampler(1000, false);
    sampler.sample(0, 0); // origem
    const tooSoon1 = sampler.sample(300, 300_000_000); // janela de 300ms, abaixo do mínimo (1000ms)
    assert(!tooSoon1.report, "janela abaixo de 1000ms não deveria relatar");
    const tooSoon2 = sampler.sample(600, 600_000_000); // ainda abaixo -- origem deveria continuar em (0,0)
    assert(!tooSoon2.report, "ainda abaixo do mínimo, não deveria relatar");
    // Se a origem tivesse avançado nos ticks anteriores (como no modo resetOriginEveryTick), a
    // janela aqui teria zerado; como preservou a origem em (0,0), 1200ms de parede já fecha a
    // janela de 1000ms e a taxa reflete o intervalo COMPLETO desde o início (tempo real: 1.0x).
    const result = sampler.sample(1200, 1_200_000_000);
    assert(result.report, "janela de 1200ms deveria fechar (mínimo 1000ms)");
    assert(result.rate !== undefined && Math.abs(result.rate - 1.0) < 1e-6,
      `taxa deveria refletir o intervalo completo desde a origem preservada (~1.0x), veio ${result.rate}`);
  });

  await test("resetOriginEveryTick=false: detecta corretamente uma taxa MAIS LENTA que tempo real (o próprio bug reportado)", () => {
    const sampler = new RollingRateSampler(1000, false);
    sampler.sample(0, 0);
    // 2000ms de parede, só 250ms de tempo virtual do MCU avançou -- ~8x mais lento que tempo real,
    // exatamente a ordem de grandeza do bug relatado (LED de 500ms levando ~4s reais).
    const result = sampler.sample(2000, 250_000_000);
    assert(result.report, "janela de 2000ms deveria fechar");
    assert(result.rate !== undefined && result.rate > 0.1 && result.rate < 0.15,
      `taxa deveria refletir ~0.125x (8x mais lento), veio ${result.rate}`);
  });

  await test("valueNs=undefined limpa a amostra e relata undefined SÓ se havia uma amostra anterior (nunca relata repetidamente por uma fonte que nunca existiu)", () => {
    const sampler = new RollingRateSampler(50, true);
    const neverHadOne = sampler.sample(1000, undefined);
    assert(!neverHadOne.report, "sem MCU nunca ter existido, não deveria relatar 'undefined' repetidamente");

    sampler.sample(2000, 0); // agora existe uma fonte
    const cleared = sampler.sample(3000, undefined); // fonte removida (ex.: MCU removido do circuito)
    assert(cleared.report && cleared.rate === undefined, "deveria relatar UMA VEZ 'undefined' na transição de existir->não existir");

    const stillGone = sampler.sample(4000, undefined);
    assert(!stillGone.report, "não deveria relatar de novo enquanto continua sem fonte");
  });

  await test("reset() limpa a amostra (equivalente a começar uma corrida nova, ex.: Run após Stop)", () => {
    const sampler = new RollingRateSampler(50, true);
    sampler.sample(1000, 0);
    sampler.reset();
    const afterReset = sampler.sample(1010, 1_000_000_000);
    assert(!afterReset.report, "logo após reset(), a próxima amostra deveria se comportar como a primeira (sem relatório)");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();

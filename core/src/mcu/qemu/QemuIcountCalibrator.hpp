#pragma once

#include <functional>
#include <string>
#include "lasecsimul/IMcuAdapter.hpp"

namespace lasecsimul::mcu::qemu {

using QemuIcountCalibratorLogFn = std::function<void(const std::string&)>;

/** Achado 2026-07-22 (usuário: LED de 500ms via millis() demora ~4s reais mesmo com a simulação "a
 * 100%"): `-icount shift=N` (ver `Esp32Adapter.cpp::buildLaunchArgs`) credita `2^N` nanossegundos de
 * tempo VIRTUAL a cada instrução Xtensa retirada -- sem NENHUMA relação obrigatória com quanto tempo
 * REAL essa instrução levou. O valor fixo `shift=4` (16ns/instrução, ~62.5 MIPS assumidos) nunca foi
 * calibrado contra o host real; se o TCG deste host só retira, digamos, ~8M instruções/s pra este
 * binário/workload, cada instrução credita 16ns de tempo virtual enquanto consome ~125ns de tempo
 * real -- o relógio virtual (base de `millis()`/FreeRTOS tick) fica ~8x atrás do relógio de parede,
 * mesmo que o solver elétrico (métrica INDEPENDENTE, ver `Scheduler.cpp`) continue reportando 100%.
 *
 * Esta função mede UMA VEZ (com cache em disco por processo/host/binário) a taxa REAL de ns-por-
 * instrução que este host consegue para o binário QEMU configurado, e seta `LASECSIMUL_ESP32_ICOUNT_SHIFT`
 * no ambiente do PRÓPRIO processo Core -- lido por `Esp32Adapter.cpp::buildLaunchArgs` no lugar do
 * `shift=4` fixo. Calibrar o shift pra bater com o throughput REAL do host faz o tempo virtual
 * acompanhar o tempo de parede POR CONSTRUÇÃO -- é a definição de "1 unidade de tempo virtual por
 * instrução == 1 unidade de tempo real por instrução", não uma heurística.
 *
 * Idempotente e barato de chamar repetidamente: se a env var já está setada (calibração anterior
 * NESTE processo) ou se o cache em disco bate com o binário atual (mtime+tamanho, sem precisar ler
 * o arquivo inteiro), retorna quase imediatamente sem lançar nenhum processo QEMU novo. Só mede de
 * verdade (lança uma instância QEMU descartável, sem firmware, só o boot ROM) na primeira vez com
 * cache ausente/inválido.
 *
 * `resolvedBinaryPath` precisa ser um caminho ABSOLUTO e concreto (não o nome nu "qemu-system-xtensa"
 * dependente de PATH) -- em produção, a Extension sempre resolve isso antes de chamar
 * `loadMcuFirmware` (ver `mcuCommands.ts::resolveQemuBinaryOverride`). Chamador (`McuController::start`)
 * já tem essa informação disponível; se vazio, esta função é um no-op (não há binário concreto pra
 * medir/cachear contra) -- Esp32Adapter cai no `shift=4` default nesse caso. Nunca lança: qualquer
 * falha (launch, timeout, medição inválida) é só logada via `log`, mantendo o comportamento anterior. */
void ensureIcountShiftCalibrated(const IMcuAdapter& adapter, const std::string& resolvedBinaryPath,
                                 const QemuIcountCalibratorLogFn& log);

} // namespace lasecsimul::mcu::qemu

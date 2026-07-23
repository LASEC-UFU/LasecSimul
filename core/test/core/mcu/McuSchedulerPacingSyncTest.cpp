// Sincronização de ritmo (2026-07-23, ver .claude/plans/humble-waddling-parnas.md): o usuário
// reportou o solver elétrico rodando a "100%" (pareado 1:1 ao relógio de parede via
// Scheduler::setMaximumTimeStepNs(), um tique próprio e independente de qualquer MCU) enquanto um
// MCU emulado (QEMU/-icount, gargalado pela vazão real de instruções do host) roda mais devagar
// (ex.: "83%") -- pediu que o elétrico desacelere pra acompanhar o mais lento em vez de correr à
// frente dele. Uma primeira versão (razão suavizada por EMA alimentando um multiplicador de taxa)
// falhou em teste ao vivo duas vezes -- ver doc-comment de Scheduler::AdvanceLimitFn. Reescrito
// como um TETO DE POSIÇÃO absoluta, sem estado nenhum: nunca deixa Scheduler::nowNs() avançar mais
// que uma folga fixa (derivada da granularidade de pacing já medida, ver Scheduler::pacingQuantumNs())
// à frente da posição confirmada do MCU mais lento.
//
// Usa arena SINTÉTICA (mesma técnica de McuComponentLivePollThreadTest.cpp, sem QEMU real) com uma
// thread de teste publicando heartbeats (SIM_EVENT) numa taxa deliberadamente controlada em relação
// ao relógio de parede -- simula um "MCU lento" de forma determinística e livre de flakiness
// dependente de host, exercitando exatamente o mesmo caminho de produção (mesmo ABI, mesmas
// classes) que um QEMU real usaria.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>
#include "lasecsimul/qemu_arena_abi.h"
#include "mcu/McuComponent.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;

namespace {

int failures = 0;

void check(bool ok, const char* label) {
    if (ok) std::printf("OK: %s\n", label);
    else {
        std::fprintf(stderr, "FALHOU: %s\n", label);
        failures++;
    }
}

std::string uniqueArenaName(const char* suffix) {
    return "lasecsimul-mcu-pacing-sync-test-" + std::string(suffix) + "-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

// Publica um heartbeat (SIM_EVENT, sem payload elétrico -- ver McuComponent::dispatchArenaEvent,
// ramo `else`) direto nos campos brutos da arena, mesma técnica de simulateQemuWrite() em
// McuComponentLivePollThreadTest.cpp/McuComponentTest.cpp.
void simulateQemuHeartbeat(LsdnQemuArena* arena, uint64_t simuTimePs) {
    const uint64_t slot = arena->queueWriteIndex % LSDN_QEMU_ARENA_QUEUE_DEPTH;
    arena->queue[slot].regAddr = 0;
    arena->queue[slot].regData = 0;
    arena->queue[slot].simuAction = LSDN_SIM_EVENT;
    arena->queue[slot].simuTime = simuTimePs;
    arena->queueWriteIndex++;
}

template <class Predicate>
bool waitUntil(Predicate predicate, std::chrono::milliseconds timeout = std::chrono::seconds(5)) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    do {
        if (predicate()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    } while (std::chrono::steady_clock::now() < deadline);
    return predicate();
}

// Thread de produção de heartbeats a uma taxa ALVO controlada (simuTimePs avançado por tick, em
// proporção ao tempo de parede real decorrido) -- simula um "QEMU lento" sustentando `ratio` de
// tempo real, sem depender da vazão de instrução de host nenhum (determinístico).
class HeartbeatProducer {
public:
    void start(LsdnQemuArena* arena, double ratio) {
        m_thread = std::thread([this, arena, ratio] {
            uint64_t simuTimePs = 0;
            auto last = std::chrono::steady_clock::now();
            while (!m_stop.load(std::memory_order_relaxed)) {
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
                const auto now = std::chrono::steady_clock::now();
                const auto wallDeltaNs = std::chrono::duration_cast<std::chrono::nanoseconds>(now - last).count();
                last = now;
                simuTimePs += static_cast<uint64_t>(static_cast<double>(wallDeltaNs) * 1000.0 * ratio);
                // Respeita o backpressure real da fila (mesmo raciocínio de runConcurrentStressBurst
                // em McuComponentLivePollThreadTest.cpp): só espera quando ela está CHEIA.
                while (!m_stop.load(std::memory_order_relaxed) &&
                       (arena->queueWriteIndex - arena->queueReadIndex) >= LSDN_QEMU_ARENA_QUEUE_DEPTH) {
                    std::this_thread::yield();
                }
                if (m_stop.load(std::memory_order_relaxed)) break;
                simulateQemuHeartbeat(arena, simuTimePs);
            }
        });
    }
    void stop() {
        m_stop.store(true, std::memory_order_relaxed);
        if (m_thread.joinable()) m_thread.join();
    }
    ~HeartbeatProducer() { stop(); }

private:
    std::thread m_thread;
    std::atomic<bool> m_stop{false};
};

} // namespace

int main() {
#ifndef ESP32_ADAPTER_DLL_PATH
#error "ESP32_ADAPTER_DLL_PATH precisa ser definido pelo CMakeLists (caminho do adapter.dll real)"
#endif
    const std::filesystem::path dllPath = ESP32_ADAPTER_DLL_PATH;
    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr, "PULADO: %s nao existe -- rode 'npm run build:mcu-adapters'.\n",
                     dllPath.string().c_str());
        return 0;
    }

    plugins::GlobalPluginCache cache;
    std::shared_ptr<plugins::PluginModule> module = cache.loader().loadMcuPlugin(dllPath);
    cache.setActiveMcuModule("espressif.esp32", module);

    // ── Teste 1: sem estado -- posição some sem evento, recomeça sem hiato numa recarga ────
    {
        SimulationSession session(cache);
        session.registerKnownMcuTypes();
        mcu::McuComponent* mcuPtr = nullptr;
        session.components().registerFactory("mcu.esp32", [&mcuPtr, &session](const registry::ComponentParams&) {
            auto instance = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
            mcuPtr = instance.get();
            return instance;
        });
        session.addComponent("mcu.esp32", {});
        check(mcuPtr != nullptr, "McuComponent criado (teste de posicao sem estado)");

        session.scheduler().start();
        mcuPtr->openSyntheticArenaForTesting(uniqueArenaName("a"));
        LsdnQemuArena* arena = mcuPtr->arenaBridge().arena();

        check(!session.computeSlowestMcuPositionNsForTesting().has_value(),
              "logo apos abrir a arena, nenhuma posicao reportada ainda (nenhum evento processado)");

        // Taxa rapida (1.0) so pra ter dado disponivel rapido -- este teste nao mede convergencia
        // de taxa (isso e o Teste 2), so a semantica de posicao/reset.
        HeartbeatProducer producer;
        producer.start(arena, 1.0);
        const bool gotPosition = waitUntil([&] { return session.computeSlowestMcuPositionNsForTesting().has_value(); });
        check(gotPosition, "depois do primeiro heartbeat, uma posicao passa a ser reportada");

        // Recarga: abre uma NOVA arena sintetica no mesmo McuComponent -- reseta latestVirtualTimeNs()
        // pra 0 e a origem pro nowNs() ATUAL (ja corrigido em McuComponent::openSyntheticArenaForTesting).
        producer.stop();
        const uint64_t nowNsAtReload = session.scheduler().nowNs();
        mcuPtr->openSyntheticArenaForTesting(uniqueArenaName("b"));
        check(!session.computeSlowestMcuPositionNsForTesting().has_value(),
              "logo apos recarregar, volta a nao reportar posicao nenhuma (nenhum evento na arena nova ainda)");

        LsdnQemuArena* reloadedArena = mcuPtr->arenaBridge().arena();
        HeartbeatProducer producerAfterReload;
        producerAfterReload.start(reloadedArena, 1.0);
        std::optional<uint64_t> positionAfterReload;
        const bool gotPositionAfterReload = waitUntil([&] {
            positionAfterReload = session.computeSlowestMcuPositionNsForTesting();
            return positionAfterReload.has_value();
        });
        producerAfterReload.stop();
        check(gotPositionAfterReload, "depois da recarga, uma posicao nova passa a ser reportada");
        if (positionAfterReload) {
            // Sem hiato nenhum pra "detectar": a origem nova e o nowNs() de quando a recarga
            // aconteceu, entao a posicao traduzida comeca exatamente ali (ou um pouco depois, dado
            // o pequeno simuTimePs do primeiro heartbeat) -- nunca um valor preso/antigo.
            check(*positionAfterReload >= nowNsAtReload,
                  "posicao apos recarga comeca exatamente onde o eletrico ja estava, sem hiato");
        }

        session.scheduler().stop();
    }

    // ── Teste 2: fim-a-fim -- Scheduler::nowNs() nunca foge da posicao do MCU, e a taxa media
    //    converge MUITO perto do alvo (sem o vies de subestimacao da EMA antiga) ────────────
    {
        SimulationSession session(cache);
        session.registerKnownMcuTypes();
        mcu::McuComponent* mcuPtr = nullptr;
        session.components().registerFactory("mcu.esp32", [&mcuPtr, &session](const registry::ComponentParams&) {
            auto instance = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
            mcuPtr = instance.get();
            return instance;
        });
        session.addComponent("mcu.esp32", {});
        check(mcuPtr != nullptr, "McuComponent criado (teste fim-a-fim)");

        session.scheduler().setRealTimeRate(1.0); // mesmo default que a extensao configura hoje.
        session.scheduler().start();
        mcuPtr->openSyntheticArenaForTesting(uniqueArenaName("e2e"));
        LsdnQemuArena* arena = mcuPtr->arenaBridge().arena();

        constexpr double kTargetRatio = 0.4;
        HeartbeatProducer producer;
        producer.start(arena, kTargetRatio);
        std::this_thread::sleep_for(std::chrono::milliseconds(300)); // deixa estabilizar

        // Amostra o GAP entre nowNs() e a posicao do MCU repetidamente ao longo de uma janela --
        // deve ficar sempre dentro da folga maxima (kMaxAdvanceLeadNs=20ms, pior caso).
        uint64_t maxGapNs = 0;
        const auto gapDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        while (std::chrono::steady_clock::now() < gapDeadline) {
            const uint64_t nowNs = session.scheduler().nowNs();
            const std::optional<uint64_t> mcuPositionNs = session.computeSlowestMcuPositionNsForTesting();
            if (mcuPositionNs && nowNs > *mcuPositionNs) maxGapNs = std::max(maxGapNs, nowNs - *mcuPositionNs);
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }

        // Mede a taxa MEDIA de avanco de nowNs() sobre uma janela maior, separado da amostragem de
        // gap acima.
        const auto sampleStart = std::chrono::steady_clock::now();
        const uint64_t nowNsStart = session.scheduler().nowNs();
        std::this_thread::sleep_for(std::chrono::seconds(2));
        const auto sampleEnd = std::chrono::steady_clock::now();
        const uint64_t nowNsEnd = session.scheduler().nowNs();
        producer.stop();
        session.scheduler().stop();

        const double wallDeltaNs = static_cast<double>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(sampleEnd - sampleStart).count());
        const double simDeltaNs = static_cast<double>(nowNsEnd - nowNsStart);
        const double observedRatio = simDeltaNs / wallDeltaNs;
        std::fprintf(stderr, "  [info] maior gap observado=%lluns, taxa de avanco de nowNs()=%.3f (alvo=%.3f)\n",
                     static_cast<unsigned long long>(maxGapNs), observedRatio, kTargetRatio);

        check(maxGapNs <= 20'000'000,
              "gap entre nowNs() e a posicao do MCU nunca excede a folga maxima (20ms)");
        check(std::abs(observedRatio - kTargetRatio) < 0.1,
              "taxa media de avanco de nowNs() converge MUITO perto do alvo injetado (sem subestimar como a EMA antiga)");
    }

    // ── Teste 3 (bonus): dois MCUs -- o mais lento manda, o mais rapido tambem fica represado ──
    {
        SimulationSession session(cache);
        session.registerKnownMcuTypes();
        std::vector<mcu::McuComponent*> mcus;
        session.components().registerFactory("mcu.esp32", [&mcus, &session](const registry::ComponentParams&) {
            auto instance = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
            mcus.push_back(instance.get());
            return instance;
        });
        session.addComponent("mcu.esp32", {});
        session.addComponent("mcu.esp32", {});
        check(mcus.size() == 2, "dois McuComponent criados (teste bonus de 2 MCUs)");
        mcu::McuComponent* slowMcu = mcus[0];
        mcu::McuComponent* fastMcu = mcus[1];

        session.scheduler().setRealTimeRate(1.0);
        session.scheduler().start();
        slowMcu->openSyntheticArenaForTesting(uniqueArenaName("slow"));
        fastMcu->openSyntheticArenaForTesting(uniqueArenaName("fast"));

        constexpr double kSlowRatio = 0.3;
        constexpr double kFastRatio = 1.0; // sempre responsivo, acompanharia 100% sozinho
        HeartbeatProducer slowProducer;
        HeartbeatProducer fastProducer;
        slowProducer.start(slowMcu->arenaBridge().arena(), kSlowRatio);
        fastProducer.start(fastMcu->arenaBridge().arena(), kFastRatio);
        std::this_thread::sleep_for(std::chrono::milliseconds(300));

        const auto sampleStart = std::chrono::steady_clock::now();
        const uint64_t nowNsStart = session.scheduler().nowNs();
        std::this_thread::sleep_for(std::chrono::seconds(2));
        const auto sampleEnd = std::chrono::steady_clock::now();
        const uint64_t nowNsEnd = session.scheduler().nowNs();
        slowProducer.stop();
        fastProducer.stop();
        session.scheduler().stop();

        const double wallDeltaNs = static_cast<double>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(sampleEnd - sampleStart).count());
        const double observedRatio = static_cast<double>(nowNsEnd - nowNsStart) / wallDeltaNs;
        std::fprintf(stderr, "  [info] 2 MCUs: taxa de avanco de nowNs()=%.3f (MCU lento alvo=%.3f, MCU rapido alvo=%.3f)\n",
                     observedRatio, kSlowRatio, kFastRatio);

        check(observedRatio < 0.6,
              "com 2 MCUs, o elétrico segue o MAIS LENTO (nao o mais rapido, nem uma media)");
    }

    if (failures == 0) {
        std::printf("\nTodos os testes de sincronizacao de ritmo Scheduler<->MCU passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}

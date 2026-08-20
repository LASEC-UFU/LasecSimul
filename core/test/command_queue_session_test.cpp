#include <atomic>
#include <chrono>
#include <cstdio>
#include <thread>
#include "components/sources/Rail.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::session;

namespace {

// Redesign de concorrência 2026-07-19 (ver .claude/plans/idempotent-floating-cat.md): escritas
// estruturais (addComponent/connectWire/setProperty/etc.) passaram a enfileirar um comando e
// esperar a thread do Scheduler confirmar, em vez de mutar m_netlist/m_componentInstances direto na
// thread de IPC. Roda `fn` numa thread separada com prazo -- se `fn` travar de verdade (regressão no
// mecanismo de drenagem), o teste FALHA relatando qual chamada travou em vez de a suíte inteira
// travar sem explicação (a thread presa é propositalmente `detach()`ada nesse caso, não dá pra
// `join()` sem travar o teste também).
template <class Fn>
bool completesWithin(Fn&& fn, std::chrono::milliseconds timeout) {
    std::atomic<bool> done{false};
    std::thread worker([&fn, &done] { fn(); done.store(true); });
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (!done.load() && std::chrono::steady_clock::now() < deadline) std::this_thread::yield();
    if (done.load()) {
        worker.join();
        return true;
    }
    worker.detach();
    return false;
}

} // namespace

int main() {
    int failures = 0;
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    session.components().registerFactory("sources.rail", [](const ComponentParams& p) {
        return std::make_unique<components::Rail>(Pin{"out"}, p.property("voltage", 0.0));
    });

    // Antes do primeiro start(): worker não existe -- caminho de aplicação direta (sem fila).
    const uint32_t before = session.addComponent("sources.rail", {});
    const uint32_t beforeSecond = session.addComponent("sources.rail", {});
    session.scheduler().start();

    bool addRejected = false;
    const bool addedWhileRunning = completesWithin([&] {
        try { (void)session.addComponent("sources.rail", {}); }
        catch (const std::runtime_error&) { addRejected = true; }
    }, std::chrono::seconds(2));
    if (!addedWhileRunning) {
        std::printf("FALHOU: addComponent travou com a simulacao rodando\n");
        ++failures;
    } else if (!addRejected) {
        std::printf("FALHOU: addComponent estrutural nao exigiu stop\n");
        ++failures;
    }

    bool connectRejected = false;
    const bool connectedWhileRunning = completesWithin([&] {
        try { session.connectWire(before, "out", beforeSecond, "out"); }
        catch (const std::runtime_error&) { connectRejected = true; }
    }, std::chrono::seconds(2));
    if (!connectedWhileRunning) {
        std::printf("FALHOU: connectWire travou com a simulacao rodando\n");
        ++failures;
    } else if (!connectRejected) {
        std::printf("FALHOU: connectWire estrutural nao exigiu stop\n");
        ++failures;
    }

    const bool setPropWhileRunning = completesWithin([&] {
        const auto error = session.setProperty(before, "voltage", PropertyValue{3.3});
        if (error) std::printf("setProperty (rodando) devolveu erro inesperado: %s\n", error->c_str());
    }, std::chrono::seconds(2));
    if (!setPropWhileRunning) {
        std::printf("FALHOU: setProperty travou com a simulacao rodando\n");
        ++failures;
    }

    session.scheduler().pause();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    if (!session.scheduler().isPaused()) {
        std::printf("FALHOU: scheduler nao ficou pausado\n");
        ++failures;
    }

    // Regressão direta do gap encontrado antes de compilar: pausado != parado. A worker continua
    // viva (Scheduler::isRunning() true), então setProperty ainda vai pra fila -- sem o fix no ramo
    // pausado de Scheduler::start(), isto travaria pra sempre esperando uma iteração de settle que
    // nunca ia rodar enquanto pausado.
    const bool setPropWhilePaused = completesWithin([&] {
        const auto error = session.setProperty(before, "voltage", PropertyValue{1.1});
        if (error) std::printf("setProperty (pausado) devolveu erro inesperado: %s\n", error->c_str());
    }, std::chrono::seconds(2));
    if (!setPropWhilePaused) {
        std::printf("FALHOU: setProperty travou com a simulacao pausada\n");
        ++failures;
    }

    session.scheduler().stop();

    // Depois de stop(): worker não existe mais -- volta ao caminho de aplicação direta.
    const bool addedAfterStop = completesWithin([&] {
        session.addComponent("sources.rail", {});
    }, std::chrono::seconds(2));
    if (!addedAfterStop) {
        std::printf("FALHOU: addComponent travou depois de stop()\n");
        ++failures;
    }

    std::printf("CommandQueue via SimulationSession: %s\n", failures == 0 ? "OK" : "FALHOU");
    return failures == 0 ? 0 : 1;
}

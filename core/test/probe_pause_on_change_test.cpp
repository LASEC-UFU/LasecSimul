// Regressão da auditoria de UI 2026-07-09 -- paridade com "Pause at state change" real do SimulIDE
// (probe.cpp:199-208). Prova que `meters.probe` com `pauseOnChange=true` de fato pausa o
// `Scheduler` quando o sinal cruza `threshold`, e que `pauseOnChange=false` (default) NUNCA pausa
// sozinho -- mesmo padrão de diode_test.cpp/inert_components_fix_test.cpp: sem framework de teste,
// factories locais mínimas (registerBuiltinComponents tem linkage interna).
#include <cstdio>
#include <memory>
#include "components/meters/Probe.hpp"
#include "components/other/Ground.hpp"
#include "components/sources/FixedVolt.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;

namespace {

int failures = 0;
#define CHECK(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

void registerCommon(ComponentRegistry& c, simulation::Scheduler& scheduler) {
    c.registerFactory("sources.fixed_volt", [](const ComponentParams& p) {
        return std::make_unique<components::FixedVolt>(Pin{"out"}, p.property("voltage", 5.0), p.property("out", true));
    });
    c.registerFactory("meters.probe", [&scheduler](const ComponentParams& p) {
        return std::make_unique<components::Probe>(scheduler, Pin{"in"}, p.property("threshold", 2.5),
                                                    p.property("showVolt", true), p.property("pauseOnChange", false));
    });
    c.registerFactory("other.ground", [](const ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
}

ComponentParams withVoltage(double v) {
    ComponentParams p;
    p.properties["voltage"] = v;
    p.properties["out"] = true;
    return p;
}

} // namespace

int main() {
    std::fprintf(stderr, "=== ProbePauseOnChangeTest ===\n");

    // Caso 1: pauseOnChange=true, tensão cruza o limiar (0V -> 5V) -- deve pausar.
    {
        GlobalPluginCache cache;
        SimulationSession session(cache);
        registerCommon(session.components(), session.scheduler());

        const uint32_t src = session.addComponent("sources.fixed_volt", withVoltage(0.0));
        ComponentParams probeParams;
        probeParams.properties["threshold"] = 2.5;
        probeParams.properties["pauseOnChange"] = true;
        const uint32_t probe = session.addComponent("meters.probe", probeParams);
        session.connectWire(src, "out", probe, "in");

        session.settleStep(); // primeira solve() -- 0V, só estabelece o estado inicial (nunca pausa na primeira leitura)
        CHECK(!session.scheduler().isPaused(), "probe pauseOnChange: não pausa na primeira leitura (sem estado anterior pra comparar)");

        session.setProperty(src, "voltage", 5.0); // cruza o limiar (0V -> 5V)
        // 2 rounds no mínimo: 1º estampa `src`/resolve o nó pra 5V e marca `probe` dirty (listener),
        // só o 2º de fato estampa `probe` já vendo os 5V resolvidos (mesmo defasagem de 1 round que
        // QUALQUER stamp() reflete "a última solve()", nunca a que ele mesmo acabou de produzir).
        for (int i = 0; i < 20 && !session.scheduler().isPaused(); ++i) session.settleStep();
        CHECK(session.scheduler().isPaused(), "probe pauseOnChange=true: pausa o Scheduler ao cruzar o limiar");
    }

    // Caso 2: pauseOnChange=false (default) -- MESMO cruzamento de limiar NÃO deve pausar.
    {
        GlobalPluginCache cache;
        SimulationSession session(cache);
        registerCommon(session.components(), session.scheduler());

        const uint32_t src = session.addComponent("sources.fixed_volt", withVoltage(0.0));
        const uint32_t probe = session.addComponent("meters.probe", {}); // pauseOnChange default = false
        session.connectWire(src, "out", probe, "in");

        session.settleStep();
        session.setProperty(src, "voltage", 5.0);
        for (int i = 0; i < 20; ++i) session.settleStep();
        CHECK(!session.scheduler().isPaused(), "probe pauseOnChange=false (default): cruzar o limiar NÃO pausa o Scheduler");
    }

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}

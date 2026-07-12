// Teste de regressão pra SimulationSession::reuseUnaffectedCircuitGroups (.spec/lasecsimul.spec,
// seção 25.5): edita repetidamente UMA ilha elétrica isolada e confere que (a) o resultado da ilha
// editada continua fisicamente correto a cada mutação e (b) a tensão da ilha NÃO TOCADA nunca muda
// nem um bit -- é essa segunda checagem que prova que o reaproveitamento de CircuitGroup não vaza
// estado estampado velho pra uma rede que não devia ser afetada. Sem framework de teste, mesmo
// padrão de voltage_divider_test.cpp/diode_test.cpp.
#include <cmath>
#include <cstdio>
#include <memory>
#include <array>
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/DcVoltageSource.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;

namespace {

bool nearlyEqual(double a, double b, double eps = 1e-6) { return std::abs(a - b) < eps; }

void registerTestComponents(ComponentRegistry& components) {
    components.registerFactory("sources.dc_voltage", [](const ComponentParams& params) {
        return std::make_unique<components::DcVoltageSource>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                               params.property("voltage", 10.0));
    });
    components.registerFactory("passive.resistor", [](const ComponentParams& params) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                        params.property("resistance", 1000.0));
    });
    components.registerFactory("other.ground", [](const ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
}

ComponentParams withVoltage(double v) {
    ComponentParams p;
    p.properties["voltage"] = v;
    return p;
}

ComponentParams withResistance(double r) {
    ComponentParams p;
    p.properties["resistance"] = r;
    return p;
}

bool settleWithin(SimulationSession& session, int limit = 200) {
    for (int i = 0; i < limit; ++i) if (!session.settleStep()) return true;
    return false;
}

} // namespace

int main() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerTestComponents(session.components());

    // Ilha 1 (NUNCA tocada depois do settle inicial): fonte 10V -- R1 1k -- R2 1k -- terra -- V_B1=5V.
    const uint32_t source1 = session.addComponent("sources.dc_voltage", withVoltage(10.0));
    const uint32_t r1a = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t r1b = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t ground1 = session.addComponent("other.ground", {});
    session.connectWire(source1, "p1", r1a, "p1");
    session.connectWire(r1a, "p2", r1b, "p1");
    session.connectWire(r1b, "p2", source1, "p2");
    session.connectWire(source1, "p2", ground1, "pin");

    // Ilha 2 (editada repetidamente): fonte 20V -- R3 1k -- R4 1k -- terra -- V_B2=10V inicial.
    const uint32_t source2 = session.addComponent("sources.dc_voltage", withVoltage(20.0));
    const uint32_t r2a = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t r2b = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t ground2 = session.addComponent("other.ground", {});
    session.connectWire(source2, "p1", r2a, "p1");
    session.connectWire(r2a, "p2", r2b, "p1");
    session.connectWire(r2b, "p2", source2, "p2");
    session.connectWire(source2, "p2", ground2, "pin");

    bool ok = true;
    if (!settleWithin(session)) { std::fprintf(stderr, "FALHOU: settle inicial nao estabilizou\n"); ok = false; }

    const double islandOneBaseline = session.nodeVoltageOfPin(r1a, "p2");
    if (!nearlyEqual(islandOneBaseline, 5.0, 1e-3)) {
        std::fprintf(stderr, "FALHOU: V_B1 inicial deveria ser 5V, deu %.6f\n", islandOneBaseline);
        ok = false;
    }
    const double islandTwoInitial = session.nodeVoltageOfPin(r2a, "p2");
    if (!nearlyEqual(islandTwoInitial, 10.0, 1e-3)) {
        std::fprintf(stderr, "FALHOU: V_B2 inicial deveria ser 10V, deu %.6f\n", islandTwoInitial);
        ok = false;
    }

    // 20 rodadas de edição SÓ na ilha 2 (adiciona um resistor R5 em T, remove, reconecta em outro
    // ponto, restaura) -- a cada rodada, ilha 1 tem que continuar EXATAMENTE no mesmo valor (nenhum
    // re-stamp deveria tocá-la) e ilha 2 tem que continuar fisicamente coerente com a topologia atual.
    const uint32_t r5 = session.addComponent("passive.resistor", withResistance(1000.0));
    for (int round = 0; round < 20; ++round) {
        if (round % 2 == 0) {
            // T: R5 do nó médio da ilha 2 até a própria terra da ilha 2 -- 3 resistores de 1k em
            // paralelo (R4 e R5) puxando o nó médio, então V_B2 = 20 * (Rpar/(1000+Rpar)), Rpar=500.
            session.connectWire(r5, "p1", r2a, "p2");
            session.connectWire(r5, "p2", ground2, "pin");
        } else {
            session.disconnectWire(r5, "p1", r2a, "p2");
            session.disconnectWire(r5, "p2", ground2, "pin");
        }

        if (!settleWithin(session)) {
            std::fprintf(stderr, "FALHOU: settle da rodada %d nao estabilizou\n", round);
            ok = false;
            break;
        }

        const double islandOneNow = session.nodeVoltageOfPin(r1a, "p2");
        if (!nearlyEqual(islandOneNow, islandOneBaseline)) {
            std::fprintf(stderr,
                         "FALHOU rodada %d: ilha 1 (nao tocada) mudou de %.9f pra %.9f -- reaproveitamento de "
                         "CircuitGroup vazou estampa velha ou nao reaproveitou e o grupo reconstruido deu "
                         "resultado diferente\n",
                         round, islandOneBaseline, islandOneNow);
            ok = false;
        }

        const double islandTwoNow = session.nodeVoltageOfPin(r2a, "p2");
        const double expected = (round % 2 == 0) ? (20.0 * 500.0 / 1500.0) : 10.0;
        if (!nearlyEqual(islandTwoNow, expected, 1e-3)) {
            std::fprintf(stderr, "FALHOU rodada %d: V_B2 deveria ser %.6f (%s), deu %.6f\n", round, expected,
                         (round % 2 == 0) ? "T de 3 resistores" : "restaurado", islandTwoNow);
            ok = false;
        }
    }

    // Funde dois nós na PRIMEIRA ilha. Isso reduz a numeração densa e pode deslocar os IDs
    // globais da segunda ilha, embora seus índices locais e membros sejam iguais. O guard de
    // nodeIndices precisa recusar o reuso e ainda preservar o resultado elétrico da ilha 2.
    session.connectWire(source1, "p1", r1b, "p1");
    if (!settleWithin(session)) {
        std::fprintf(stderr, "FALHOU: settle depois de deslocar IDs globais nao estabilizou\n");
        ok = false;
    } else if (!nearlyEqual(session.nodeVoltageOfPin(r2a, "p2"), 10.0, 1e-3)) {
        std::fprintf(stderr, "FALHOU: ilha 2 corrompida depois de deslocamento dos IDs globais\n");
        ok = false;
    }

    if (ok) std::printf("OK: reaproveitamento de CircuitGroup nunca afetou uma rede nao tocada, e a rede editada permaneceu fisicamente correta em todas as 20 rodadas.\n");
    return ok ? 0 : 1;
}

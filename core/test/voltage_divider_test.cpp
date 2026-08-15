// Teste de integração mínimo: fonte de tensão ideal + 2 resistores + terra, ponta a ponta pelo
// pipeline real (Netlist -> CircuitGroup com variável extra -> Eigen -> ComponentMatrixView).
// Sem framework de teste — assert + código de saída, consistente com o resto do scaffold
// (ver .spec/archive/legacy-v2/lasecsimul.spec, seção 7.3). Roda settleStep() direto (sem thread do Scheduler) —
// uso de teste single-threaded é o único contexto seguro de chamar settleStep() fora do Scheduler.
#include <array>
#include <cmath>
#include <cstdio>
#include <memory>
#include <optional>
#include <string>
#include "components/connectors/Tunnel.hpp"
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

bool nearlyEqual(double a, double b, double eps = 1e-4) { return std::abs(a - b) < eps; }

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

} // namespace

int main() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerTestComponents(session.components());

    // Fonte 10V -- R1 1k -- (nó B) -- R2 1k -- Terra. Esperado: V_B = 5V (divisor 1:1).
    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(10.0));
    const uint32_t r1 = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t r2 = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t ground = session.addComponent("other.ground", {});

    session.connectWire(source, "p1", r1, "p1");   // nó A: source(+) -- r1
    session.connectWire(r1, "p2", r2, "p1");        // nó B: r1 -- r2 (ponto médio do divisor)
    session.connectWire(r2, "p2", source, "p2");    // nó GND: r2 -- source(-)
    session.connectWire(source, "p2", ground, "pin"); // GND -- terra

    for (int i = 0; i < 100 && session.settleStep(); ++i) {} // settle-loop manual até estabilizar

    const double voltA = session.nodeVoltageOfPin(source, "p1");
    const double voltB = session.nodeVoltageOfPin(r1, "p2");
    const double voltGnd = session.nodeVoltageOfPin(ground, "pin");

    std::printf("V_A=%.6f V_B=%.6f V_GND=%.6f\n", voltA, voltB, voltGnd);

    bool ok = true;
    if (!nearlyEqual(voltGnd, 0.0, 1e-3)) {
        std::fprintf(stderr, "FALHOU: V_GND deveria ser ~0V (terra), deu %.6f\n", voltGnd);
        ok = false;
    }
    if (!nearlyEqual(voltA, 10.0)) {
        std::fprintf(stderr, "FALHOU: V_A deveria ser 10V (fonte ideal), deu %.6f\n", voltA);
        ok = false;
    }
    if (!nearlyEqual(voltB, 5.0)) {
        std::fprintf(stderr, "FALHOU: V_B deveria ser 5V (divisor 1:1), deu %.6f\n", voltB);
        ok = false;
    }

    // Leitura de corrente (opção 1 do plano: sem incógnita nova, lida sob demanda do estado
    // cacheado na última stamp()) -- convenção PASSIVA (positiva = entra em p1, sai em p2, mesma
    // pra todo componente, ver docstring de DcVoltageSource::current()).
    const std::optional<double> sourceCurrent = session.componentCurrent(source);
    const std::optional<double> r1Current = session.componentCurrent(r1);
    if (!sourceCurrent || !nearlyEqual(*sourceCurrent, -0.005, 1e-6)) {
        std::fprintf(stderr, "FALHOU: source.current() deveria ser -5mA (fonte fornecendo energia), deu %s\n",
                     sourceCurrent ? std::to_string(*sourceCurrent).c_str() : "nullopt");
        ok = false;
    }
    if (!r1Current || !nearlyEqual(*r1Current, 0.005, 1e-6)) {
        std::fprintf(stderr, "FALHOU: r1.current() deveria ser +5mA (V_A>V_B, p1->p2), deu %s\n",
                     r1Current ? std::to_string(*r1Current).c_str() : "nullopt");
        ok = false;
    }

    if (ok) std::printf("OK: divisor de tensao resolvido corretamente (incluindo leitura de corrente).\n");
    return ok ? 0 : 1;
}

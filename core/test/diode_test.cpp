// Teste de integração do primeiro componente não linear real (Épico H do roadmap de pendências):
// fonte de tensão + resistor + diodo + terra, resolvido pelo settle-loop real (Newton-Raphson via
// stamp() repetido até hasConverged()==true para todo não linear). Mesmo padrão de
// voltage_divider_test.cpp: sem framework de teste, settleStep() chamado direto (uso de teste).
#include <array>
#include <cmath>
#include <cstdio>
#include <memory>
#include "components/active/Diode.hpp"
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

bool nearlyEqual(double a, double b, double eps) { return std::abs(a - b) < eps; }

bool settleWithin(SimulationSession& session, int limit = 200) {
    for (int i = 0; i < limit; ++i) if (!session.settleStep()) return true;
    return false;
}

void registerTestComponents(ComponentRegistry& components) {
    components.registerFactory("sources.dc_voltage", [](const ComponentParams& params) {
        return std::make_unique<components::DcVoltageSource>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                               params.property("voltage", 10.0));
    });
    components.registerFactory("passive.resistor", [](const ComponentParams& params) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                        params.property("resistance", 1000.0));
    });
    components.registerFactory("active.diode", [](const ComponentParams& params) {
        return std::make_unique<components::Diode>(std::array<Pin, 2>{Pin{"anode"}, Pin{"cathode"}},
                                                     params.property("saturationCurrent", 1e-12));
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

    // Fonte 10V -- R 1k -- Diodo (anodo no nó B, catodo na terra) -- Terra.
    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(10.0));
    const uint32_t r1 = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t diode = session.addComponent("active.diode", {});
    const uint32_t ground = session.addComponent("other.ground", {});

    session.connectWire(source, "p1", r1, "p1");          // nó A: fonte(+) -- R
    session.connectWire(r1, "p2", diode, "anode");        // nó B: R -- anodo do diodo
    session.connectWire(diode, "cathode", source, "p2");  // catodo do diodo -- fonte(-)
    session.connectWire(source, "p2", ground, "pin");     // GND -- terra

    const bool settled = settleWithin(session);

    const double voltA = session.nodeVoltageOfPin(source, "p1");
    const double voltB = session.nodeVoltageOfPin(r1, "p2"); // == tensão do anodo
    const double voltCathode = session.nodeVoltageOfPin(diode, "cathode");
    const double vd = voltB - voltCathode;
    const double currentThroughResistor = (voltA - voltB) / 1000.0;

    // Equação do diodo no ponto convergido, calculada de fora (não reaproveita estado interno do
    // componente) -- isto é o que valida que o companion model linearizado de fato convergiu pra
    // um ponto de operação fisicamente consistente, não só que o laço parou de iterar.
    constexpr double kIs = 1e-12;
    constexpr double kVt = 0.02585;
    const double diodeEquationCurrent = kIs * (std::exp(vd / kVt) - 1.0);

    std::printf("settled=%d iterations<=200 V_A=%.6f V_B(anodo)=%.6f V_catodo=%.6f Vd=%.6f I_R=%.6e I_diodo(eq)=%.6e\n",
                settled, voltA, voltB, voltCathode, vd, currentThroughResistor, diodeEquationCurrent);

    bool ok = true;
    if (!settled) {
        std::fprintf(stderr, "FALHOU: settle-loop não estabilizou em 200 iterações.\n");
        ok = false;
    }
    if (!nearlyEqual(voltA, 10.0, 1e-3)) {
        std::fprintf(stderr, "FALHOU: V_A deveria ser 10V (fonte ideal), deu %.6f\n", voltA);
        ok = false;
    }
    if (!(vd > 0.3 && vd < 1.0)) {
        std::fprintf(stderr, "FALHOU: Vd deveria estar numa faixa de condução direta plausível (0.3-1.0V), deu %.6f\n", vd);
        ok = false;
    }
    // KCL no ponto convergido: corrente pelo resistor deve bater com a equação do diodo na mesma
    // Vd, dentro de uma tolerância relativa frouxa (a corrente varia exponencialmente com Vd, então
    // pequenos resíduos numéricos de convergência mudam a corrente avaliada mais que a tensão).
    if (!nearlyEqual(currentThroughResistor, diodeEquationCurrent, std::abs(diodeEquationCurrent) * 0.05 + 1e-6)) {
        std::fprintf(stderr,
                     "FALHOU: KCL violado -- corrente do resistor (%.6e A) deveria bater com a equação do diodo "
                     "na mesma Vd (%.6e A)\n",
                     currentThroughResistor, diodeEquationCurrent);
        ok = false;
    }


    // Regressão: cachear union-find comprimido entre revisões fazia o segundo settle de circuitos
    // ativos prender. Cada lote agora invalida a topologia uma vez e o rebuild integral funciona como
    // oracle tanto no split quanto na restauração da rede.
    session.applyWireTopologyTransaction(session.wireTopologyRevision(), {
        {WireTopologyOperation::Kind::Disconnect, {r1, "p2"}, {diode, "anode"}},
        {WireTopologyOperation::Kind::Connect, {r1, "p2"}, {ground, "pin"}},
    });
    if (!settleWithin(session)) {
        std::fprintf(stderr, "FALHOU: rede ativa não estabilizou depois do split transacional.\n");
        ok = false;
    }
    session.applyWireTopologyTransaction(session.wireTopologyRevision(), {
        {WireTopologyOperation::Kind::Disconnect, {r1, "p2"}, {ground, "pin"}},
        {WireTopologyOperation::Kind::Connect, {r1, "p2"}, {diode, "anode"}},
    });
    if (!settleWithin(session)) {
        std::fprintf(stderr, "FALHOU: rede ativa não estabilizou depois de restaurar a topologia.\n");
        ok = false;
    }

    if (ok) std::printf("OK: diodo convergiu pra um ponto de operação fisicamente consistente.\n");
    return ok ? 0 : 1;
}

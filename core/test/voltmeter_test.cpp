// Teste de integração do Voltmeter built-in: alta impedância, leitura V(+) − V(−),
// getState() devolve 1 double. Mesmo padrão de voltage_divider_test.cpp (settleStep direto,
// sem framework de teste).
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include "components/meters/Voltmeter.hpp"
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

bool nearlyEqual(double a, double b, double eps = 1e-3) { return std::abs(a - b) < eps; }

bool ok = true;
void check(bool cond, const char* msg) {
    if (!cond) {
        std::fprintf(stderr, "FALHOU: %s\n", msg);
        ok = false;
    }
}

} // namespace

int main() {
    GlobalPluginCache cache;
    SimulationSession session(cache);

    session.components().registerFactory("sources.dc_voltage", [](const ComponentParams& p) {
        return std::make_unique<components::DcVoltageSource>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                               p.property("voltage", 5.0));
    });
    session.components().registerFactory("passive.resistor", [](const ComponentParams& p) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                        p.property("resistance", 1000.0));
    });
    session.components().registerFactory("other.ground", [](const ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
    session.components().registerFactory("instruments.voltmeter", [](const ComponentParams&) {
        return std::make_unique<components::Voltmeter>(
            std::array<Pin, 3>{Pin{"lPin"}, Pin{"rPin"}, Pin{"outPin"}});
    });

    // Circuito: 5V — R1 1k — nodeB — R2 1k — GND
    // Voltímetro: lPin=GND, rPin=nodeB → leitura esperada ~2.5V
    ComponentParams srcP; srcP.properties["voltage"] = 5.0;
    ComponentParams resP; resP.properties["resistance"] = 1000.0;
    const uint32_t source  = session.addComponent("sources.dc_voltage", srcP);
    const uint32_t r1      = session.addComponent("passive.resistor",   resP);
    const uint32_t r2      = session.addComponent("passive.resistor",   resP);
    const uint32_t ground  = session.addComponent("other.ground",       {});
    const uint32_t vm      = session.addComponent("instruments.voltmeter", {});

    // Topologia: source(p1)→r1(p1), r1(p2)→r2(p1) [nodeB], r2(p2)→source(p2)→ground
    session.connectWire(source, "p1",  r1,     "p1");
    session.connectWire(r1,     "p2",  r2,     "p1");
    session.connectWire(r2,     "p2",  source, "p2");
    session.connectWire(source, "p2",  ground, "pin");

    // Voltímetro across R2: lPin = GND side (r2.p2), rPin = nodeB (r2.p1)
    session.connectWire(vm, "lPin",  r2, "p2");
    session.connectWire(vm, "rPin",  r2, "p1");

    for (int i = 0; i < 100 && session.settleStep(); ++i) {}

    const double vNodeB  = session.nodeVoltageOfPin(r1, "p2");
    const double vGnd    = session.nodeVoltageOfPin(ground, "pin");
    const double vSrc    = session.nodeVoltageOfPin(source, "p1");

    std::printf("V_src=%.4f V_nodeB=%.4f V_gnd=%.4f\n", vSrc, vNodeB, vGnd);
    check(nearlyEqual(vSrc,   5.0), "fonte deve estar em 5V");
    check(nearlyEqual(vGnd,   0.0), "terra deve estar em 0V");
    // 1 MΩ do voltímetro em paralelo com R2=1k carrega levemente o divisor: ~2.499V em vez de 2.5V.
    check(nearlyEqual(vNodeB, 2.5, 5e-3), "nodeB deve estar em ~2.5V (divisor 1:1, carregado levemente pelo voltimetro 1 MΩ)");

    // Leitura via getState(): 8 bytes = 1 double com a tensão medida
    const std::vector<uint8_t> state = session.getComponentState(vm);
    check(state.size() == sizeof(double), "getState() deve devolver exatamente 8 bytes (1 double)");

    if (state.size() >= sizeof(double)) {
        double readback = 0.0;
        std::memcpy(&readback, state.data(), sizeof(double));
        std::printf("Voltmeter readback=%.6f\n", readback);
        // readback deve coincidir com a tensão real do nó (mesmo loading effect do voltímetro)
        check(nearlyEqual(readback, vNodeB - vGnd, 1e-4),
              "getState() deve codificar V(rPin) - V(lPin) (tensao real do no medido)");
    }

    // outPin deve refletir a leitura como tensão analógica (mesmo padrão do Ampmeter)
    const double vOut = session.nodeVoltageOfPin(vm, "outPin");
    std::printf("Voltmeter outPin=%.6f\n", vOut);
    check(nearlyEqual(vOut, 2.5, 5e-3), "outPin deve refletir ~2.5V medido");

    if (ok) std::printf("OK: voltimetro de alta impedancia leu 2.5V corretamente.\n");
    return ok ? 0 : 1;
}

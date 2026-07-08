// Teste de integração da extensão de ruptura reversa da classe `Diode` (mesmo componente não
// linear real usado por active.diode, agora reaproveitado por active.zener e outputs.led com
// parâmetros diferentes -- ver core/src/components/active/Diode.hpp e CoreApplication.cpp).
// Mesmo padrão de diode_test.cpp: sem framework de teste, settleStep() chamado direto.
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

// Mesmos parâmetros/registro de active.zener e outputs.led em CoreApplication.cpp.
void registerTestComponents(ComponentRegistry& components) {
    components.registerFactory("sources.dc_voltage", [](const ComponentParams& params) {
        return std::make_unique<components::DcVoltageSource>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                               params.property("voltage", 10.0));
    });
    components.registerFactory("passive.resistor", [](const ComponentParams& params) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                        params.property("resistance", 1000.0));
    });
    components.registerFactory("active.zener", [](const ComponentParams& params) {
        return std::make_unique<components::Diode>(
            std::array<Pin, 2>{Pin{"anode"}, Pin{"cathode"}}, params.property("saturationCurrent", 1e-12), 0.02585,
            params.property("breakdownVoltage", 5.1), true);
    });
    components.registerFactory("outputs.led", [](const ComponentParams& params) {
        return std::make_unique<components::Diode>(std::array<Pin, 2>{Pin{"anode"}, Pin{"cathode"}},
                                                     params.property("saturationCurrent", 9.32e-11),
                                                     params.property("thermalVoltage", 0.0965));
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

// Regulador zener clássico: fonte 20V -- R 1k -- catodo do zener, anodo do zener na terra. A
// junção fica reversamente polarizada (V_catodo > V_anodo=0) e, se a fonte empurra V_catodo além
// de breakdownVoltage, a ruptura deve "grampear" a tensão perto de breakdownVoltage -- é a prova
// de que o ramo de ruptura em Diode::stamp() de fato conduz (se fosse 0, V_catodo subiria livre
// até ~20V, limitado só pelo divisor resistivo inexistente aqui).
bool testZenerBreakdown() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerTestComponents(session.components());

    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(20.0));
    const uint32_t r1 = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t zener = session.addComponent("active.zener", {});
    const uint32_t ground = session.addComponent("other.ground", {});

    session.connectWire(source, "p1", r1, "p1");
    session.connectWire(r1, "p2", zener, "cathode");
    session.connectWire(zener, "anode", ground, "pin");
    session.connectWire(source, "p2", ground, "pin");

    bool settled = false;
    for (int i = 0; i < 200; ++i) {
        if (!session.settleStep()) { settled = true; break; }
    }

    const double voltCathode = session.nodeVoltageOfPin(zener, "cathode");
    const double voltAnode = session.nodeVoltageOfPin(zener, "anode");
    const double voltA = session.nodeVoltageOfPin(source, "p1");
    const double vd = voltAnode - voltCathode; // reverso: negativo
    const double currentThroughResistor = (voltA - voltCathode) / 1000.0;

    constexpr double kIs = 1e-12;
    constexpr double kVt = 0.02585;
    constexpr double kBreakdown = 5.1;
    constexpr double kMaxOvershoot = 2.0;
    double zenerEquationCurrent = kIs * (std::exp(vd / kVt) - 1.0);
    if (vd < 0.0) {
        const double vz = std::min(-vd - kBreakdown, kMaxOvershoot);
        if (vz > 0.0) zenerEquationCurrent -= kIs * std::exp(vz / kVt);
    }
    // KCL: corrente que sai do nó do catodo pelo zener é o negativo da corrente convencional
    // anodo->catodo usada acima (mesma convenção de sinal de matrix.addCurrent em Diode::stamp()).
    const double currentIntoZener = -zenerEquationCurrent;

    std::printf(
        "[zener] settled=%d V_A=%.4f V_catodo=%.4f V_anodo=%.4f Vd=%.4f I_R=%.6e I_zener(eq)=%.6e\n",
        settled, voltA, voltCathode, voltAnode, vd, currentThroughResistor, currentIntoZener);

    bool ok = true;
    if (!settled) {
        std::fprintf(stderr, "FALHOU (zener): settle-loop não estabilizou em 200 iterações.\n");
        ok = false;
    }
    // Regulação: com fonte de 20V e R=1k puxando o catodo bem acima de breakdownVoltage=5.1V, a
    // ruptura deve grampear V_catodo numa faixa plausível ao redor de 5.1V -- longe dos ~20V que
    // teria sem ruptura nenhuma, mas o joelho exponencial permite alguma margem acima do valor
    // nominal (mesma faixa frouxa usada em diode_test.cpp pro joelho direto).
    if (!(voltCathode > 4.5 && voltCathode < 8.0)) {
        std::fprintf(stderr,
                     "FALHOU (zener): V_catodo deveria estar perto da regulação de ruptura "
                     "(4.5-8.0V), deu %.4f -- ramo de ruptura pode não estar conduzindo\n",
                     voltCathode);
        ok = false;
    }
    if (!nearlyEqual(currentThroughResistor, currentIntoZener, std::abs(currentIntoZener) * 0.05 + 1e-6)) {
        std::fprintf(stderr,
                     "FALHOU (zener): KCL violado -- corrente do resistor (%.6e A) deveria bater "
                     "com a equação do zener na mesma Vd (%.6e A)\n",
                     currentThroughResistor, currentIntoZener);
        ok = false;
    }
    if (ok) std::printf("OK: zener rompeu e regulou a tensão de forma fisicamente consistente.\n");
    return ok;
}

// LED com os parâmetros reais do preset "RGY Default" do SimulIDE (satCurr maior, thermalVoltage
// efetivo maior que um diodo comum) -- o joelho de condução direta deve ficar bem mais alto
// (~1.5-2.5V) que o de active.diode (~0.3-1.0V, já validado em diode_test.cpp).
bool testLedForwardVoltage() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerTestComponents(session.components());

    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(10.0));
    const uint32_t r1 = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t led = session.addComponent("outputs.led", {});
    const uint32_t ground = session.addComponent("other.ground", {});

    session.connectWire(source, "p1", r1, "p1");
    session.connectWire(r1, "p2", led, "anode");
    session.connectWire(led, "cathode", source, "p2");
    session.connectWire(source, "p2", ground, "pin");

    bool settled = false;
    for (int i = 0; i < 200; ++i) {
        if (!session.settleStep()) { settled = true; break; }
    }

    const double voltB = session.nodeVoltageOfPin(r1, "p2");
    const double voltCathode = session.nodeVoltageOfPin(led, "cathode");
    const double vd = voltB - voltCathode;

    std::printf("[led] settled=%d Vd=%.4f\n", settled, vd);

    bool ok = true;
    if (!settled) {
        std::fprintf(stderr, "FALHOU (led): settle-loop não estabilizou em 200 iterações.\n");
        ok = false;
    }
    if (!(vd > 1.0 && vd < 3.0)) {
        std::fprintf(stderr,
                     "FALHOU (led): Vd deveria estar na faixa de condução direta de um LED real "
                     "(1.0-3.0V), deu %.4f\n",
                     vd);
        ok = false;
    }
    if (ok) std::printf("OK: LED convergiu com tensão direta plausível.\n");
    return ok;
}

} // namespace

int main() {
    const bool zenerOk = testZenerBreakdown();
    const bool ledOk = testLedForwardVoltage();
    return (zenerOk && ledOk) ? 0 : 1;
}

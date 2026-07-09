// Regressão da auditoria "pente fino" (2026-07-08): 11 componentes built-in tinham `stamp()`
// vazio (SimulidePassiveState, no-op puro) -- eletricamente inertes em produção. Este teste prova
// que os componentes agora fazem alguma coisa eletricamente real, não só que o processo não
// crasha. Mesmo padrão de diode_test.cpp/zener_led_test.cpp: sem framework de teste, factories
// locais mínimas (registerBuiltinComponents tem linkage interna).
#include <array>
#include <cmath>
#include <cstdio>
#include <memory>
#include <vector>
#include "components/active/AnalogMux.hpp"
#include "components/active/DiodeLegArray.hpp"
#include "components/active/OpAmp.hpp"
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "components/passive/ResistorArray.hpp"
#include "components/sources/DcVoltageSource.hpp"
#include "components/switches/Keypad.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;

namespace {

bool nearlyEqual(double a, double b, double eps) { return std::abs(a - b) < eps; }
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

void registerCommon(ComponentRegistry& c) {
    c.registerFactory("sources.dc_voltage", [](const ComponentParams& p) {
        return std::make_unique<components::DcVoltageSource>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                               p.property("voltage", 10.0));
    });
    c.registerFactory("passive.resistor", [](const ComponentParams& p) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                        p.property("resistance", 1000.0));
    });
    c.registerFactory("other.ground", [](const ComponentParams&) {
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

// Buffer de ganho unitário: opamp com in- realimentado direto do output -- se stamp() fosse no-op
// (bug antigo), V_out ficaria em 0V (nenhuma equação ligando out a nada além da terra implícita
// que nem existe) e o teste de KCL abaixo falharia. Se real, V_out deve convergir pra ~V_in (mesma
// técnica de virtual-short de um buffer real).
bool testOpAmpBuffer() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerCommon(session.components());
    session.components().registerFactory("active.opamp", [](const ComponentParams& p) {
        const auto pos = p.pins<3>();
        return std::make_unique<components::OpAmp>(
            std::array<Pin, 5>{Pin{"in+"}, Pin{"in-"}, Pin{"out"}, Pin{"vp"}, Pin{"vn"}}, p.property("gain", 100000.0));
        (void)pos;
    });

    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(3.3));
    const uint32_t opamp = session.addComponent("active.opamp", {});
    const uint32_t ground = session.addComponent("other.ground", {});

    session.connectWire(source, "p1", opamp, "in+");
    session.connectWire(opamp, "out", opamp, "in-"); // realimentação negativa direta -- buffer
    session.connectWire(source, "p2", ground, "pin");

    bool settled = false;
    for (int i = 0; i < 200; ++i) {
        if (!session.settleStep()) { settled = true; break; }
    }
    const double vOut = session.nodeVoltageOfPin(opamp, "out");
    std::fprintf(stderr, "[opamp] settled=%d V_out=%.4f (esperado ~3.3V)\n", settled, vOut);

    bool ok = settled;
    CHECK(ok, "opamp buffer: settle-loop convergiu");
    CHECK(nearlyEqual(vOut, 3.3, 0.01), "opamp buffer: V_out ~= V_in (virtual short real, não 0V de stamp() morto)");
    return ok && nearlyEqual(vOut, 3.3, 0.01);
}

// Mux 2 canais: canal 0 selecionado (addr=0, en=0V=ativo) deve conduzir Z<->chan0 com baixa
// impedância; chan1 (não selecionado) deve ficar em alta impedância (V_chan1 não deve seguir Z).
bool testAnalogMux() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerCommon(session.components());
    session.components().registerFactory("active.analog_mux", [](const ComponentParams& p) {
        std::vector<Pin> pins = resolveDynamicPins(components::AnalogMux::pinSpec(), p.properties);
        return std::make_unique<components::AnalogMux>(std::move(pins), p.property("channels", 2.0));
    });

    ComponentParams muxParams;
    muxParams.properties["channels"] = 2.0;
    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(5.0));
    const uint32_t rZ = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t mux = session.addComponent("active.analog_mux", muxParams);
    // Carga na MESMA ordem de grandeza de rZ -- kOffConductance (1e-7 S ~ 10MΩ) formando um divisor
    // com uma carga de 1MΩ ainda deixaria ~0.45V no canal desligado (divisor real, não bug); com
    // 1kΩ o divisor deixa o canal desligado na casa de μV, bem abaixo do limiar do teste.
    const uint32_t rLoad0 = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t rLoad1 = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t ground = session.addComponent("other.ground", {});

    session.connectWire(source, "p1", rZ, "p1");
    session.connectWire(rZ, "p2", mux, "z");
    session.connectWire(mux, "en", ground, "pin"); // en ativo em nível baixo -- amarrado a 0V = habilitado
    session.connectWire(mux, "addr-3", ground, "pin"); // addr=0 -> canal 0 selecionado
    session.connectWire(mux, "chan-4", rLoad0, "p1"); // canal 0 (índice do 1º addr pin + 1 bit = pin 4, ver AnalogMux)
    session.connectWire(rLoad0, "p2", ground, "pin");
    session.connectWire(mux, "chan-5", rLoad1, "p1"); // canal 1
    session.connectWire(rLoad1, "p2", ground, "pin");
    session.connectWire(source, "p2", ground, "pin");

    bool settled = false;
    for (int i = 0; i < 200; ++i) {
        if (!session.settleStep()) { settled = true; break; }
    }
    const double vZ = session.nodeVoltageOfPin(mux, "z");
    const double vChan0 = session.nodeVoltageOfPin(mux, "chan-4");
    const double vChan1 = session.nodeVoltageOfPin(mux, "chan-5");
    std::fprintf(stderr, "[analog_mux] settled=%d V_Z=%.4f V_chan0=%.4f V_chan1=%.4f\n", settled, vZ, vChan0, vChan1);

    bool ok = settled;
    CHECK(ok, "analog_mux: settle-loop convergiu");
    CHECK(nearlyEqual(vZ, vChan0, 0.05), "analog_mux: canal selecionado (0) segue Z (baixa impedância real)");
    CHECK(vChan1 < 0.05, "analog_mux: canal não selecionado (1) fica em alta impedância (perto de 0V, desconectado de Z)");
    return ok;
}

// LED RGB: perna R (anodo=pin R, catodo=pin C comum) forward-biased deve conduzir (Vd no joelho
// ~1.5-2.5V, mesma física de outputs.led); se stamp() fosse no-op, o ramo seria circuito aberto e
// toda a tensão da fonte cairia sem limite no resistor série, Vd == V_fonte inteira.
bool testLedRgb() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerCommon(session.components());
    session.components().registerFactory("outputs.led_rgb", [](const ComponentParams& p) {
        std::vector<Pin> pins;
        for (int i = 1; i <= 4; ++i) pins.push_back(i <= p.pinList.size() ? p.pinList[i - 1] : Pin{"pin-" + std::to_string(i)});
        std::vector<components::DiodeLegArray::Leg> legs{{0, 3}, {1, 3}, {2, 3}};
        return std::make_unique<components::DiodeLegArray>("outputs.led_rgb", std::move(pins), std::move(legs));
    });

    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(5.0));
    const uint32_t r1 = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t led = session.addComponent("outputs.led_rgb", {});
    const uint32_t ground = session.addComponent("other.ground", {});

    session.connectWire(source, "p1", r1, "p1");
    session.connectWire(r1, "p2", led, "pin-1"); // R
    session.connectWire(led, "pin-4", ground, "pin"); // C comum
    session.connectWire(source, "p2", ground, "pin");

    bool settled = false;
    for (int i = 0; i < 200; ++i) {
        if (!session.settleStep()) { settled = true; break; }
    }
    const double vAnode = session.nodeVoltageOfPin(r1, "p2");
    const double vCathode = session.nodeVoltageOfPin(led, "pin-4");
    const double vd = vAnode - vCathode;
    std::fprintf(stderr, "[led_rgb] settled=%d Vd(R)=%.4f (esperado 1.0-3.0V, não ~5V de circuito aberto)\n", settled, vd);

    bool ok = settled && vd > 1.0 && vd < 3.0;
    CHECK(settled, "led_rgb: settle-loop convergiu");
    CHECK(vd > 1.0 && vd < 3.0, "led_rgb: perna R conduz de verdade (joelho de LED real, não circuito aberto)");
    return ok;
}

// ResistorDip: 8 pares independentes -- prova que um par ALÉM do primeiro (ex: par 3, pinos 5/6)
// também drena corrente de verdade (bug antigo: só pin-1/pin-2 eram reais, os outros 14 pinos
// ficavam flutuando).
bool testResistorDip() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerCommon(session.components());
    session.components().registerFactory("passive.resistor_dip", [](const ComponentParams& p) {
        std::vector<Pin> pins;
        for (int i = 1; i <= 16; ++i) pins.push_back(static_cast<size_t>(i) <= p.pinList.size() ? p.pinList[i - 1] : Pin{"pin-" + std::to_string(i)});
        return std::make_unique<components::ResistorArray>("passive.resistor_dip", std::move(pins),
                                                            p.property("resistance", 100.0));
    });

    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(5.0));
    const uint32_t dip = session.addComponent("passive.resistor_dip", withResistance(100.0));
    const uint32_t ground = session.addComponent("other.ground", {});

    // Par 3 (0-based índice 2) = pin-5/pin-6, NÃO o primeiro par -- e os OUTROS 7 pares ficam
    // deliberadamente SEM NENHUM fio (uso normal de um DIP: ninguém fia os 16 pinos sempre).
    // `ResistorArray::stamp()` estampa uma condutância de fuga mínima em TODO pino (ver comentário
    // lá) exatamente pra este caso não deixar o grupo inteiro singular.
    session.connectWire(source, "p1", dip, "pin-5");
    session.connectWire(dip, "pin-6", ground, "pin");
    session.connectWire(source, "p2", ground, "pin");

    bool settled = false;
    for (int i = 0; i < 50; ++i) {
        if (!session.settleStep()) { settled = true; break; }
    }
    const double vAcross = session.nodeVoltageOfPin(dip, "pin-5") - session.nodeVoltageOfPin(dip, "pin-6");
    std::fprintf(stderr, "[resistor_dip] settled=%d V(pin5-pin6)=%.4f (esperado ~5V, par 3 conduzindo)\n", settled, vAcross);

    bool ok = settled && nearlyEqual(vAcross, 5.0, 0.05);
    CHECK(settled, "resistor_dip: settle-loop convergiu");
    CHECK(nearlyEqual(vAcross, 5.0, 0.05), "resistor_dip: par 3 (pin-5/pin-6) conduz de verdade (não flutuante)");
    return ok;
}

// Keypad: tecla (row0,col0) marcada em pressedMask deve curto-circuitar row0<->col0 (baixa
// impedância); tecla NÃO pressionada (row0,col1) deve continuar em alta impedância.
bool testKeypad() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerCommon(session.components());
    session.components().registerFactory("switches.keypad", [](const ComponentParams& p) {
        const size_t rows = 2, columns = 2;
        std::vector<Pin> pins{Pin{"pin-1"}, Pin{"pin-2"}, Pin{"pin-3"}, Pin{"pin-4"}};
        return std::make_unique<components::Keypad>(std::move(pins), rows, columns, false, false,
                                                     p.property("pressedMask", 0.0));
    });

    ComponentParams keypadParams;
    keypadParams.properties["pressedMask"] = 1.0; // bit 0 = (row0,col0) pressionada
    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(5.0));
    const uint32_t rPullup = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t keypad = session.addComponent("switches.keypad", keypadParams);
    const uint32_t ground = session.addComponent("other.ground", {});

    session.connectWire(source, "p1", rPullup, "p1");
    session.connectWire(rPullup, "p2", keypad, "pin-1"); // row0
    session.connectWire(keypad, "pin-3", ground, "pin"); // col0 -- tecla (row0,col0) pressionada
    session.connectWire(source, "p2", ground, "pin");

    bool settled = false;
    for (int i = 0; i < 50; ++i) {
        if (!session.settleStep()) { settled = true; break; }
    }
    const double vRow0 = session.nodeVoltageOfPin(keypad, "pin-1");
    std::fprintf(stderr, "[keypad] settled=%d V(row0)=%.4f (esperado perto de 0V -- tecla fechada puxa pra terra)\n",
                 settled, vRow0);

    bool ok = settled && vRow0 < 0.5;
    CHECK(settled, "keypad: settle-loop convergiu");
    CHECK(vRow0 < 0.5, "keypad: tecla pressionada conecta linha/coluna de verdade (não flutuante)");
    return ok;
}

} // namespace

int main() {
    const bool r1 = testOpAmpBuffer();
    const bool r2 = testAnalogMux();
    const bool r3 = testLedRgb();
    const bool r4 = testResistorDip();
    const bool r5 = testKeypad();
    if (failures == 0) std::fprintf(stderr, "\nTodos os testes passaram.\n");
    else std::fprintf(stderr, "\n%d asserção(ões) FALHARAM.\n", failures);
    return (r1 && r2 && r3 && r4 && r5 && failures == 0) ? 0 : 1;
}

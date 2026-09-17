// `logic.adc`/`logic.dac` (components/logic/AdcDac.hpp): réplica do barramento digital de 8 bits
// LITERAL do ADC/DAC do SimulIDE -- pedido explícito do usuário depois de uma primeira versão que
// expunha o valor quantizado como UMA porta de Signal Graph (mais fácil de ligar a blocos Ctrl, mas
// não é como o dispositivo real funciona). Agora são 100% elétricos: 1 pino analógico de terminal
// único (referenciado ao terra global da MNA, sem par diferencial) + 8 pinos digitais
// independentes ("d0".."d7", d0 = LSB), cada um um nível lógico 0V/5V de verdade -- prova aqui que
// o código binário nos 8 pinos bate com a tensão analógica em ambas as direções, e que o `vref`
// (única propriedade editável) desloca a escala corretamente.
#include <cmath>
#include <cstdio>
#include <memory>

#include "components/logic/AdcDac.hpp"
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/FixedVolt.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;
using namespace lasecsimul::simulation;

namespace {

int failures = 0;
void check(bool ok, const char* label) {
    if (ok) std::printf("OK: %s\n", label);
    else { std::fprintf(stderr, "FALHOU: %s\n", label); ++failures; }
}

void registerFactories(SimulationSession& session) {
    session.components().registerFactory("other.ground", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Ground>(Pin{pos[0].id.empty() ? "pin" : pos[0].id, pos[0].x, pos[0].y});
    });
    session.components().registerFactory("sources.fixed_volt", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::FixedVolt>(Pin{pos[0].id.empty() ? "pin" : pos[0].id, pos[0].x, pos[0].y},
                                                        p.property("voltage", 12.0), true);
    });
    session.components().registerFactory("passive.resistor", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        return std::make_unique<components::Resistor>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            1000.0);
    });
    session.components().registerFactory("logic.adc", [](const ComponentParams& p) {
        const auto pos = p.pins<9>();
        std::array<Pin, 9> pins;
        static constexpr std::array<const char*, 9> ids{"in", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"};
        for (size_t i = 0; i < 9; ++i) pins[i] = Pin{pos[i].id.empty() ? ids[i] : pos[i].id, pos[i].x, pos[i].y};
        return std::make_unique<components::AdcConverter>(pins, p.property("vref", 5.0));
    });
    session.components().registerFactory("logic.dac", [](const ComponentParams& p) {
        const auto pos = p.pins<9>();
        std::array<Pin, 9> pins;
        static constexpr std::array<const char*, 9> ids{"d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "out"};
        for (size_t i = 0; i < 9; ++i) pins[i] = Pin{pos[i].id.empty() ? ids[i] : pos[i].id, pos[i].x, pos[i].y};
        return std::make_unique<components::DacConverter>(pins, p.property("vref", 5.0));
    });
}

uint32_t addFixedVolt(SimulationSession& session, double voltage) {
    ComponentParams params;
    params.properties["voltage"] = voltage;
    return session.addComponent("sources.fixed_volt", params);
}

// (1) ADC: 3.3V com vref=5V (default) -> codigo = round(3.3/5*255) = 168 = 0b10101000 (d0=LSB=0,
// d7=MSB=1). Le CADA pino digital eletricamente (nodeVoltageOfPin), reconstroi o byte, compara.
void adcEncodesAnalogVoltageAsLiteralDigitalBus() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t source = addFixedVolt(session, 3.3);
    const uint32_t adc = session.addComponent("logic.adc", {});
    session.connectWire(source, "pin", adc, "in");

    session.scheduler().runUntil(1);
    uint32_t code = 0;
    for (uint32_t bit = 0; bit < 8; ++bit) {
        const std::string pinId = "d" + std::to_string(bit);
        if (session.nodeVoltageOfPin(adc, pinId) > 2.5) code |= (1u << bit);
    }
    check(code == 168, "(1) ADC codifica 3.3V/vref=5V como o byte 168 (0b10101000) no barramento digital literal");
}

// (2) ADC satura em 255 (todos os bits em 5V) quando a entrada excede vref, e em 0 (todos os bits
// em 0V) quando a entrada é 0V -- os dois extremos do conversor real.
void adcSaturatesAtBothEnds() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t highSource = addFixedVolt(session, 12.0); // acima do vref default (5V)
    const uint32_t adcHigh = session.addComponent("logic.adc", {});
    session.connectWire(highSource, "pin", adcHigh, "in");

    const uint32_t ground = session.addComponent("other.ground", {});
    const uint32_t adcLow = session.addComponent("logic.adc", {});
    session.connectWire(ground, "pin", adcLow, "in");

    session.scheduler().runUntil(1);
    bool allHigh = true, allLow = true;
    for (uint32_t bit = 0; bit < 8; ++bit) {
        if (session.nodeVoltageOfPin(adcHigh, "d" + std::to_string(bit)) <= 2.5) allHigh = false;
        if (session.nodeVoltageOfPin(adcLow, "d" + std::to_string(bit)) > 2.5) allLow = false;
    }
    check(allHigh, "(2a) entrada acima de vref satura em 255 (todos os bits em 5V)");
    check(allLow, "(2b) entrada em 0V satura em 0 (todos os bits em 0V)");
}

// (3) DAC: dirige o byte 153 = 0b10011001 (d0=1,d3=1,d4=1,d7=1, resto 0) nos 8 pinos digitais e
// confere a tensão analógica resultante em "out": 153/255*5V = 3.0V exato (sem arredondamento).
void dacDecodesLiteralDigitalBusToAnalogVoltage() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t dac = session.addComponent("logic.dac", {});
    const uint8_t code = 0b10011001;
    std::vector<uint32_t> bitSources;
    for (uint32_t bit = 0; bit < 8; ++bit) {
        const bool high = (code >> bit) & 1u;
        const uint32_t bitSource = addFixedVolt(session, high ? 5.0 : 0.0);
        session.connectWire(bitSource, "pin", dac, "d" + std::to_string(bit));
        bitSources.push_back(bitSource);
    }
    const uint32_t resistor = session.addComponent("passive.resistor", {});
    const uint32_t ground = session.addComponent("other.ground", {});
    session.connectWire(dac, "out", resistor, "p1");
    session.connectWire(resistor, "p2", ground, "pin");

    session.scheduler().runUntil(1);
    check(std::abs(session.nodeVoltageOfPin(dac, "out") - 3.0) < 1e-6,
          "(3a) DAC decodifica o byte 153 (0b10011001) como 3.0V exato (153/255*5V)");
    const auto current = session.componentCurrent(resistor);
    check(current.has_value() && std::abs(std::abs(*current) - 3.0 / 1000.0) < 1e-6,
          "(3b) a tensão decodificada é elétrica de verdade: 3.0V/1k = 3mA reais no resistor");
}

// (4) `vref` é a única propriedade editável (resolução fixa em 8 bits, mesmo layout de pinos do
// SimulIDE) -- mudar vref desloca a escala de quantização do ADC.
void vrefPropertyShiftsAdcScale() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t source = addFixedVolt(session, 5.0);
    const uint32_t adc = session.addComponent("logic.adc", {});
    session.connectWire(source, "pin", adc, "in");
    session.scheduler().runUntil(1);

    uint32_t codeBefore = 0;
    for (uint32_t bit = 0; bit < 8; ++bit)
        if (session.nodeVoltageOfPin(adc, "d" + std::to_string(bit)) > 2.5) codeBefore |= (1u << bit);
    check(codeBefore == 255, "(4a) 5V com vref=5V (default) satura em 255");

    check(!session.setProperty(adc, "vref", PropertyValue{10.0}).has_value(), "(4b) editar vref e' aceito");
    session.scheduler().runUntil(2);
    uint32_t codeAfter = 0;
    for (uint32_t bit = 0; bit < 8; ++bit)
        if (session.nodeVoltageOfPin(adc, "d" + std::to_string(bit)) > 2.5) codeAfter |= (1u << bit);
    // 5V com vref=10V: codigo = round(5/10*255) = 128.
    check(codeAfter == 128, "(4c) com vref=10V, os mesmos 5V agora codificam como 128 (metade da escala)");
}

} // namespace

int main() {
    try {
        adcEncodesAnalogVoltageAsLiteralDigitalBus();
        adcSaturatesAtBothEnds();
        dacDecodesLiteralDigitalBusToAnalogVoltage();
        vrefPropertyShiftsAdcScale();
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "EXCECAO NAO TRATADA: %s\n", ex.what());
        return 2;
    }
    if (failures == 0) std::puts("AdcDacBusTest: OK");
    return failures == 0 ? 0 : 1;
}

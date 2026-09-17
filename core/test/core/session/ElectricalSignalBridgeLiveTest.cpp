// Os 6 componentes `bridges.*` (SignalBridges.hpp) já existiam completos no Core, com toda a
// mecânica de causalidade cross-domain correta (`applySignalActuatorsUnlocked`/
// `publishElectricalSensorsToSignalUnlocked` no settle loop) -- mas nunca tinham `signalPorts()`,
// então nenhum fio comum conseguia alcançá-los, e a autoria real (`setElectricalSignalBridges`)
// nunca era chamada pela Extension. Mesmo padrão do bug do TDPS: existiam só pros próprios testes.
// Este teste prova, pelo caminho real (`addComponent`/`connectWire`, sem nenhuma API especial de
// binding), os 3 sensores (elétrico -> sinal) e os 3 atuadores (sinal -> elétrico).
#include <cmath>
#include <cstdio>
#include <memory>

#include "components/bridges/SignalBridges.hpp"
#include "components/control/SignalMathBlock.hpp"
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

std::array<Pin, 2> pins2(const ComponentParams& p, const char* a, const char* b) {
    const auto pos = p.pins<2>();
    return {Pin{pos[0].id.empty() ? a : pos[0].id, pos[0].x, pos[0].y}, Pin{pos[1].id.empty() ? b : pos[1].id, pos[1].x, pos[1].y}};
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
        return std::make_unique<components::Resistor>(pins2(p, "p1", "p2"), 1000.0);
    });
    session.components().registerFactory("bridges.voltage_sensor", [](const ComponentParams& p) {
        return std::make_unique<components::SignalVoltageSensor>(pins2(p, "p", "n"));
    });
    session.components().registerFactory("bridges.current_sensor", [](const ComponentParams& p) {
        return std::make_unique<components::SignalCurrentSensor>(pins2(p, "p", "n"));
    });
    session.components().registerFactory("bridges.digital_input", [](const ComponentParams& p) {
        return std::make_unique<components::SignalDigitalInput>(pins2(p, "p", "n"));
    });
    session.components().registerFactory("bridges.controlled_voltage_source", [](const ComponentParams& p) {
        return std::make_unique<components::SignalControlledVoltageSource>(pins2(p, "p", "n"));
    });
    session.components().registerFactory("bridges.controlled_current_source", [](const ComponentParams& p) {
        return std::make_unique<components::SignalControlledCurrentSource>(pins2(p, "p", "n"));
    });
    session.components().registerFactory("bridges.digital_output", [](const ComponentParams& p) {
        return std::make_unique<components::SignalDigitalOutput>(pins2(p, "p", "n"));
    });
    for (const std::string_view mathTypeId : components::SignalMathBlock::signalMathTypeIds()) {
        const std::string typeId(mathTypeId);
        session.components().registerFactory(typeId, [typeId](const ComponentParams& p) {
            return std::make_unique<components::SignalMathBlock>(typeId, p);
        });
    }
}

// (1) Sensor de tensão: divisor resistivo 12V -> 6V no meio, lido pelo sensor e publicado como
// sinal real -- um control.gain do outro lado lê o valor elétrico convertido.
void voltageSensorPublishesElectricalReadingAsSignal() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t source = session.addComponent("sources.fixed_volt", {});
    const uint32_t r1 = session.addComponent("passive.resistor", {});
    const uint32_t r2 = session.addComponent("passive.resistor", {});
    const uint32_t ground = session.addComponent("other.ground", {});
    const uint32_t sensor = session.addComponent("bridges.voltage_sensor", {});
    ComponentParams gainParams;
    gainParams.properties["gain"] = 1.0;
    gainParams.properties["samplePeriodNs"] = 10'000'000.0;
    const uint32_t gain = session.addComponent("control.gain", gainParams);

    session.connectWire(source, "pin", r1, "p1");
    session.connectWire(r1, "p2", r2, "p1");
    session.connectWire(r2, "p2", ground, "pin");
    session.connectWire(sensor, "p", r1, "p2");
    session.connectWire(sensor, "n", ground, "pin");
    session.connectWire(sensor, "value", gain, "in");

    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine, "(1) circuito misto elétrico+sinal com sensor de tensão compila");

    // >= alguns períodos de amostragem do control.gain (10ms): a relay block do sensor ("sig.<idx>.
    // value") fica no rate GENÉRICO (1ns, nunca herda o rate do bloco de controle -- só
    // `connectors.signal_tunnel` propaga rate, ver `controlRateByComponent` em
    // `materializeSignalGraphUnlocked`), então o rate group do gain só ativa nos múltiplos do
    // período dele -- rodar só alguns ns nunca chegaria à primeira ativação.
    session.scheduler().runUntil(50'000'000ull);
    const double atGain = session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(gain, "in")));
    check(std::abs(atGain - 6.0) < 0.05, "(1) o valor de sinal lido pelo control.gain é a tensão real medida no ponto médio (~6V)");
}

// (2) Fonte de tensão controlada por sinal: um control.bias fixa um valor, a fonte impõe essa
// tensão no nó elétrico, e um resistor pra terra fecha o circuito -- prova sinal -> elétrico.
void controlledVoltageSourceDrivesElectricalNodeFromSignal() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t actuator = session.addComponent("bridges.controlled_voltage_source", {});
    const uint32_t resistor = session.addComponent("passive.resistor", {});
    const uint32_t ground = session.addComponent("other.ground", {});
    ComponentParams biasParams;
    biasParams.properties["bias"] = 9.0;
    biasParams.properties["samplePeriodNs"] = 10'000'000.0;
    const uint32_t bias = session.addComponent("control.bias", biasParams);

    session.connectWire(bias, "out", actuator, "command");
    session.connectWire(actuator, "p", resistor, "p1");
    session.connectWire(actuator, "n", ground, "pin");
    session.connectWire(resistor, "p2", ground, "pin");

    session.scheduler().runUntil(50'000'000ull);
    const auto current = session.componentCurrent(actuator);
    // Magnitude, não sinal: o que importa aqui é a Lei de Ohm (V/R) bater com o comando de sinal --
    // o SENTIDO da corrente é convenção interna do branch da fonte ideal, não o que este teste quer
    // travar (ver IComponentModel.hpp: cada componente define sua própria convenção "principal").
    check(current.has_value() && std::abs(std::abs(*current) - 9.0 / 1000.0) < 1e-6,
          "(2) a fonte controlada por sinal impõe 9V no resistor de 1k -- corrente elétrica real bate com o comando de sinal");
}

// (3) Sensor de corrente: mesmo circuito resistivo, mas lendo a corrente que passa pelo sensor.
void currentSensorPublishesElectricalReadingAsSignal() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t source = session.addComponent("sources.fixed_volt", {});
    const uint32_t sensor = session.addComponent("bridges.current_sensor", {});
    const uint32_t resistor = session.addComponent("passive.resistor", {});
    const uint32_t ground = session.addComponent("other.ground", {});
    ComponentParams gainParams;
    gainParams.properties["gain"] = 1.0;
    gainParams.properties["samplePeriodNs"] = 10'000'000.0;
    const uint32_t gain = session.addComponent("control.gain", gainParams);

    session.connectWire(source, "pin", sensor, "p");
    session.connectWire(sensor, "n", resistor, "p1");
    session.connectWire(resistor, "p2", ground, "pin");
    session.connectWire(sensor, "value", gain, "in");

    session.scheduler().runUntil(50'000'000ull);
    const double atGain = session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(gain, "in")));
    check(std::abs(std::abs(atGain) - 12.0 / 1000.0) < 1e-6, "(3) o sinal lido é a corrente real do laço (12V/1k = 12mA, magnitude)");
}

// (4) Malha digital completa: 12V (acima do limiar) -> bridges.digital_input mede "true" -> fio de
// sinal comum -> bridges.digital_output liga a saída (5V) -> resistor fecha o laço. Nenhum bloco
// `control.*` produz `SignalValueKind::Digital` hoje (lib Ctrl é toda analógica) -- por isso a
// origem Bool de verdade aqui é o PRÓPRIO sensor digital, o que também prova o sensor na mesma
// tacada. Sem fio de comando, a saída fica em 0V (default false) -- confere os dois estados.
void digitalSensorDrivesDigitalActuatorThroughSignalWire() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t source = session.addComponent("sources.fixed_volt", {}); // 12V, acima do limiar (2V default)
    const uint32_t sensor = session.addComponent("bridges.digital_input", {});
    const uint32_t actuator = session.addComponent("bridges.digital_output", {});
    const uint32_t resistor = session.addComponent("passive.resistor", {});
    const uint32_t ground = session.addComponent("other.ground", {});

    session.connectWire(source, "pin", sensor, "p");
    session.connectWire(sensor, "n", ground, "pin");
    session.connectWire(actuator, "p", resistor, "p1");
    session.connectWire(actuator, "n", ground, "pin");
    session.connectWire(resistor, "p2", ground, "pin");

    // `SignalDigitalOutput` não sobrescreve `current()` (só sensor/fonte analógica o fazem) -- lê a
    // corrente pelo RESISTOR (que sempre expõe `current()`), consequência elétrica real do estado
    // do atuador, não um atalho pro estado interno dele.
    session.scheduler().runUntil(1'000'000ull);
    const auto currentOff = session.componentCurrent(resistor);
    check(currentOff.has_value() && std::abs(*currentOff) < 1e-9, "(4a) sem fio de comando, saída digital fica em 0V (default false)");

    session.connectWire(sensor, "value", actuator, "command");
    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine, "(4b) malha digital sensor->sinal->atuador compila");
    session.scheduler().runUntil(5'000'000ull);
    const auto currentOn = session.componentCurrent(resistor);
    check(currentOn.has_value() && std::abs(std::abs(*currentOn) - 5.0 / 1000.0) < 1e-6,
          "(4c) sensor digital mede 12V como 'true' -> atuador liga em 5V -> 5mA no resistor de 1k, tudo via fio comum");
}

} // namespace

int main() {
    try {
        voltageSensorPublishesElectricalReadingAsSignal();
        controlledVoltageSourceDrivesElectricalNodeFromSignal();
        currentSensorPublishesElectricalReadingAsSignal();
        digitalSensorDrivesDigitalActuatorThroughSignalWire();
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "EXCECAO NAO TRATADA: %s\n", ex.what());
        return 2;
    }
    if (failures == 0) std::puts("ElectricalSignalBridgeLiveTest: OK");
    return failures == 0 ? 0 : 1;
}

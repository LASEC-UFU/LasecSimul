#include <array>
#include <cmath>
#include <cstdio>
#include <memory>
#include <unordered_map>

#include "components/bridges/SignalBridges.hpp"
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::components;
using namespace lasecsimul::plugins;
using namespace lasecsimul::registry;
using namespace lasecsimul::session;
using namespace lasecsimul::simulation;

namespace {
int failures = 0;
#define CHECK(expr, message) do { if (!(expr)) { std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); ++failures; } } while (false)

class FakeMatrix final : public MnaMatrixView {
public:
    void addConductance(const Pin&, const Pin&, double value) override { conductance = value; }
    void addCurrent(const Pin& a, const Pin& b, double value) override { currentFrom = a.id; currentTo = b.id; current = value; }
    void addVoltageSource(const Pin& a, const Pin& b, double value) override { voltageFrom = a.id; voltageTo = b.id; voltage = value; }
    void addConductanceToGround(const Pin&, double value) override { conductance = value; }
    void addCurrentToGround(const Pin&, double value) override { current = value; }
    double getNodeVoltage(const Pin& pin) const override {
        const auto it = nodeVoltages.find(pin.id); return it == nodeVoltages.end() ? 0.0 : it->second;
    }
    double getBranchCurrent() const override { return branchCurrent; }
    std::unordered_map<std::string, double> nodeVoltages;
    double branchCurrent = 0.0;
    double conductance = 0.0;
    double current = 0.0;
    double voltage = 0.0;
    std::string currentFrom, currentTo, voltageFrom, voltageTo;
};

void primitiveBridgeSemantics() {
    FakeMatrix matrix;
    matrix.nodeVoltages = {{"p", 3.3}, {"n", 0.0}};
    SignalVoltageSensor voltageSensor({Pin{"p"}, Pin{"n"}});
    voltageSensor.stamp(matrix); voltageSensor.stamp(matrix);
    CHECK(std::abs(voltageSensor.measuredValue() - 3.3) < 1e-12, "VoltageSensor le resultado MNA aceito");
    CHECK(std::abs(matrix.conductance - 1e-12) < 1e-18, "VoltageSensor tem carga finita explicitamente minima");

    matrix.branchCurrent = 0.25;
    SignalCurrentSensor currentSensor({Pin{"p"}, Pin{"n"}});
    currentSensor.stamp(matrix); currentSensor.stamp(matrix);
    CHECK(std::abs(currentSensor.measuredValue() - 0.25) < 1e-12 && currentSensor.extraVariableCount() == 1,
          "CurrentSensor usa variavel de ramo MNA");

    SignalControlledVoltageSource voltageSource({Pin{"p"}, Pin{"n"}});
    CHECK(voltageSource.setCommand(-2.5), "mudanca de comando de tensao e observavel");
    voltageSource.stamp(matrix);
    CHECK(matrix.voltage == -2.5, "ControlledVoltageSource aceita sinal bipolar sem clamp implicito");

    SignalControlledCurrentSource currentSource({Pin{"p"}, Pin{"n"}});
    currentSource.setCommand(0.4); currentSource.stamp(matrix);
    CHECK(matrix.currentFrom == "n" && matrix.currentTo == "p" && matrix.current == 0.4,
          "ControlledCurrentSource preserva direcao causal explicita");

    SignalDigitalInput digitalInput({Pin{"p"}, Pin{"n"}}, 0.8, 2.0);
    digitalInput.stamp(matrix); digitalInput.stamp(matrix);
    CHECK(digitalInput.measuredValue(), "DigitalInput sobe acima do limiar alto");
    matrix.nodeVoltages["p"] = 1.2; digitalInput.stamp(matrix);
    CHECK(digitalInput.measuredValue(), "DigitalInput preserva estado dentro da histerese");
    matrix.nodeVoltages["p"] = 0.2; digitalInput.stamp(matrix);
    CHECK(!digitalInput.measuredValue(), "DigitalInput desce abaixo do limiar baixo");

    SignalDigitalOutput digitalOutput({Pin{"p"}, Pin{"n"}}, 0.0, 5.0);
    digitalOutput.setCommand(true); digitalOutput.stamp(matrix);
    CHECK(matrix.voltage == 5.0, "DigitalOutput estampa nivel eletrico explicito");
}

void registerSessionComponents(SimulationSession& session) {
    session.components().registerFactory("bridges.controlled_voltage_source", [](const ComponentParams&) {
        return std::make_unique<SignalControlledVoltageSource>(std::array<Pin, 2>{Pin{"p"}, Pin{"n"}});
    });
    session.components().registerFactory("bridges.voltage_sensor", [](const ComponentParams&) {
        return std::make_unique<SignalVoltageSensor>(std::array<Pin, 2>{Pin{"p"}, Pin{"n"}});
    });
    session.components().registerFactory("passive.resistor", [](const ComponentParams&) {
        return std::make_unique<Resistor>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}}, 1000.0);
    });
    session.components().registerFactory("other.ground", [](const ComponentParams&) {
        return std::make_unique<Ground>(Pin{"pin"});
    });
}

void sessionCompilesHandlesAndUsesAcceptedStepCausality() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerSessionComponents(session);
    const uint32_t actuator = session.addComponent("bridges.controlled_voltage_source", {});
    const uint32_t sensor = session.addComponent("bridges.voltage_sensor", {});
    const uint32_t load = session.addComponent("passive.resistor", {});
    const uint32_t ground = session.addComponent("other.ground", {});
    session.connectWire(actuator, "p", sensor, "p");
    session.connectWire(sensor, "p", load, "p1");
    session.connectWire(actuator, "n", sensor, "n");
    session.connectWire(sensor, "n", load, "p2");
    session.connectWire(load, "p2", ground, "pin");

    SignalBlockDefinition command;
    command.id = "command"; command.kind = SignalBlockKind::Source;
    command.output.unit = "V"; command.realParameters = {5.0}; command.rate = {1'000'000, 0, 0};
    SignalBlockDefinition measured;
    measured.id = "measured"; measured.kind = SignalBlockKind::ExternalInput;
    measured.output.unit = "V"; measured.realParameters = {0.0}; measured.rate = command.rate;
    SignalBlockDefinition probe;
    probe.id = "probe"; probe.kind = SignalBlockKind::Probe;
    probe.inputs = {{"in", {SignalScalarType::Real, 1}, "V"}};
    probe.output = {"out", {SignalScalarType::Real, 1}, "V"}; probe.rate = command.rate;
    SignalGraphDefinition graph;
    graph.blocks = {command, measured, probe};
    graph.connections = {{"measured", "out", "probe", "in", false}};
    session.setSignalGraph(std::move(graph));
    session.setElectricalSignalBridges({
        {ElectricalSignalBridgeKind::ControlledVoltageSource, actuator, "command"},
        {ElectricalSignalBridgeKind::VoltageSensor, sensor, "measured"},
    });
    const auto plan = session.simulationPlan();
    CHECK(plan->signal->electricalBridges.size() == 2, "bridges viram handles densos no SignalPlan");
    session.scheduler().runUntil(1'000'000);
    CHECK(std::abs(session.nodeVoltageOfPin(actuator, "p") - 5.0) < 1e-6,
          "sinal aceito dirige fonte eletrica no passo seguinte");
    CHECK(std::abs(session.signalRuntime().real(session.signalRuntime().output("probe")) - 5.0) < 1e-6,
          "sensor publica solucao MNA aceita antes do RateGroup");

    session.scheduler().pause();
    session.scheduler().runUntil(2'000'000);
    CHECK(session.scheduler().nowNs() == 1'000'000, "bridge nao atravessa pausa nem usa wall clock");
    session.scheduler().resume();

    SignalGraphDefinition invalid;
    SignalBlockDefinition wrong = command; wrong.id = "wrong"; wrong.output.unit = "A";
    invalid.blocks = {wrong};
    session.setSignalGraph(invalid);
    bool rejected = false;
    try {
        session.setElectricalSignalBridges({{ElectricalSignalBridgeKind::ControlledVoltageSource, actuator, "wrong"}});
    } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "unidade incompativel e rejeitada no cold path");
}

} // namespace

int main() {
    primitiveBridgeSemantics();
    sessionCompilesHandlesAndUsesAcceptedStepCausality();
    if (failures == 0) std::puts("SignalBridgeTest: OK");
    return failures == 0 ? 0 : 1;
}

#include <array>
#include <cmath>
#include <cstdio>
#include <memory>
#include <string>

#include "components/connectors/SignalTunnel.hpp"
#include "components/connectors/Tunnel.hpp"
#include "components/control/SignalMathBlock.hpp"
#include "components/passive/Resistor.hpp"
#include "components/other/Ground.hpp"
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
void check(bool condition, const char* label) {
    if (condition) std::printf("OK: %s\n", label);
    else { std::fprintf(stderr, "FALHOU: %s\n", label); ++failures; }
}

void registerFactories(SimulationSession& session) {
    session.components().registerFactory("connectors.tunnel", [](const ComponentParams& params) {
        const auto pins = params.pins<1>();
        return std::make_unique<components::Tunnel>(Pin{pins[0].id.empty() ? "pin" : pins[0].id});
    });
    session.components().registerFactory("connectors.signal_tunnel", [](const ComponentParams& params) {
        return std::make_unique<components::SignalTunnel>(params);
    });
    session.components().registerFactory("passive.resistor", [](const ComponentParams& params) {
        const auto pins = params.pins<2>();
        return std::make_unique<components::Resistor>(
            std::array<Pin, 2>{Pin{pins[0].id.empty() ? "p1" : pins[0].id},
                               Pin{pins[1].id.empty() ? "p2" : pins[1].id}}, 1000.0);
    });
    session.components().registerFactory("other.ground", [](const ComponentParams& params) {
        const auto pins = params.pins<1>();
        return std::make_unique<components::Ground>(Pin{pins[0].id.empty() ? "pin" : pins[0].id});
    });
    session.components().registerFactory("sources.fixed_volt", [](const ComponentParams& params) {
        const auto pins = params.pins<1>();
        return std::make_unique<components::FixedVolt>(Pin{pins[0].id.empty() ? "pin" : pins[0].id}, 5.0, true);
    });
    session.components().registerFactory("control.gain", [](const ComponentParams& params) {
        return std::make_unique<components::SignalMathBlock>("control.gain", params);
    });
}

uint32_t addElectricalTunnel(SimulationSession& session, const char* name) {
    const uint32_t id = session.addComponent("connectors.tunnel", {});
    session.setTunnelName(id, "pin", "", name);
    return id;
}

uint32_t addSignalTunnel(SimulationSession& session, const char* name) {
    ComponentParams params;
    params.properties["name"] = std::string(name);
    return session.addComponent("connectors.signal_tunnel", params);
}

void electricalTunnelsOnlyUseNetlist() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);
    const uint32_t source = session.addComponent("sources.fixed_volt", {});
    const uint32_t resistor = session.addComponent("passive.resistor", {});
    const uint32_t tunnelA = addElectricalTunnel(session, "gnd");
    const uint32_t tunnelB = addElectricalTunnel(session, "gnd");
    const uint32_t ground = session.addComponent("other.ground", {});
    session.connectWire(source, "pin", resistor, "p1");
    session.connectWire(resistor, "p2", tunnelA, "pin");
    session.connectWire(tunnelB, "pin", ground, "pin");
    check(session.simulationPlan() != nullptr, "circuito elétrico com Tunnel compila");
    check(!session.signalRuntime().nextEventNs().has_value(),
          "Tunnel elétrico não agenda evento de sinal a cada 1 ns");
}

void signalTunnelsOnlyUseSignalGraph() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);
    ComponentParams gainParams;
    gainParams.properties["samplePeriodNs"] = 10'000'000.0;
    const uint32_t gain = session.addComponent("control.gain", gainParams);
    const uint32_t signalTunnel = addSignalTunnel(session, "PV");
    session.connectWire(signalTunnel, "value", gain, "in");
    check(session.simulationPlan() != nullptr && session.signalRuntime().nextEventNs().has_value(),
          "SignalTunnel ligado a controle permanece no Signal Plan");

    const uint32_t resistor = session.addComponent("passive.resistor", {});
    bool rejected = false;
    try { session.connectWire(signalTunnel, "value", resistor, "p1"); }
    catch (const std::invalid_argument&) { rejected = true; }
    check(rejected, "SignalTunnel rejeita ligação elétrica");
    const uint32_t electricalTunnel = addElectricalTunnel(session, "PV");
    rejected = false;
    try { session.connectWire(electricalTunnel, "pin", gain, "in"); }
    catch (const std::invalid_argument&) { rejected = true; }
    check(rejected, "Tunnel elétrico rejeita ligação de sinal");
    session.connectWire(electricalTunnel, "pin", resistor, "p2");
    check(session.simulationPlan() != nullptr,
          "túneis dos dois domínios podem usar o mesmo nome sem conflito");
}

void idleSignalTunnelDoesNotScheduleNanosecondEvents() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);
    addSignalTunnel(session, "unused");
    check(session.simulationPlan() != nullptr && !session.signalRuntime().nextEventNs().has_value(),
          "SignalTunnel solto nao agenda eventos de 1 ns");
}

void namedSignalTunnelPairPropagatesValue() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);
    ComponentParams firstParams;
    firstParams.properties["gain"] = 2.0;
    firstParams.properties["samplePeriodNs"] = 10'000'000.0;
    ComponentParams secondParams = firstParams;
    secondParams.properties["gain"] = 3.0;
    const uint32_t source = addSignalTunnel(session, "source");
    const uint32_t first = session.addComponent("control.gain", firstParams);
    const uint32_t driver = addSignalTunnel(session, "paired");
    const uint32_t reader = addSignalTunnel(session, "paired");
    const uint32_t second = session.addComponent("control.gain", secondParams);
    session.connectWire(source, "value", first, "in");
    session.connectWire(first, "out", driver, "value");
    session.connectWire(reader, "value", second, "in");

    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine,
          "par de SignalTunnel com mesmo nome compila no Signal Plan");
    SignalRuntime runtime;
    runtime.bind(plan->signal->engine);
    runtime.setExternalReal(signalPortBlockId(source, "value"), 4.0);
    runtime.executeUntil(10'000'000ull);
    const double observed = runtime.real(runtime.output(signalPortBlockId(second, "out")));
    check(std::abs(observed - 24.0) < 1e-9,
          "par de SignalTunnel entrega valor ao bloco seguinte na taxa de controle");
}

void legacySignalSubcircuitMigrates() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    SubcircuitDefinition definition;
    definition.typeId = "subcircuits.legacy_signal";
    definition.components = {
        {"gain", "control.gain", R"({"gain":2,"samplePeriodNs":10000000})"},
        {"input", "connectors.tunnel", R"({"name":"PV","direction":"Input"})"},
        {"electric", "connectors.tunnel", R"({"name":"GND"})"},
    };
    definition.wires = {{"input", "pin", "gain", "in"}};
    definition.interfaceDefs = {{"PV", "PV", "PV", "signal", "in"},
                                {"GND", "GND", "GND"}};
    session.subcircuits().registerDefinition(std::move(definition));
    const auto* normalized = session.subcircuits().find("subcircuits.legacy_signal");
    check(normalized && normalized->components[1].typeId == "connectors.signal_tunnel" &&
          normalized->wires[0].fromPinId == "value" &&
          normalized->components[2].typeId == "connectors.tunnel",
          "subcircuito antigo migra apenas o túnel de sinal");
}
} // namespace

int main() {
    try {
        electricalTunnelsOnlyUseNetlist();
        signalTunnelsOnlyUseSignalGraph();
        idleSignalTunnelDoesNotScheduleNanosecondEvents();
        namedSignalTunnelPairPropagatesValue();
        legacySignalSubcircuitMigrates();
    }
    catch (const std::exception& error) {
        std::fprintf(stderr, "EXCECAO: %s\n", error.what());
        return 2;
    }
    if (failures == 0) std::puts("TunnelDomainSeparationTest: OK");
    return failures == 0 ? 0 : 1;
}

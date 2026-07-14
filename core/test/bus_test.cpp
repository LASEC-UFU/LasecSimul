#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <thread>
#include "components/connectors/Bus.hpp"
#include "components/sources/Clock.hpp"
#include "components/sources/Rail.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::session;

int main() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    session.components().registerFactory("connectors.bus", [](const ComponentParams& p) {
        return std::make_unique<components::Bus>(static_cast<size_t>(p.property("width", 8.0)),
                                                 static_cast<size_t>(p.property("startBit", 0.0)));
    });
    session.components().registerFactory("sources.rail", [](const ComponentParams& p) {
        return std::make_unique<components::Rail>(Pin{"out"}, p.property("voltage", 0.0));
    });
    session.components().registerFactory("sources.clock", [&session](const ComponentParams&) {
        return std::make_unique<components::Clock>(session.scheduler(), Pin{"out"}, 5.0, 1000.0, true);
    });

    ComponentParams eight; eight.properties["width"] = 8.0; eight.properties["startBit"] = 0.0;
    const uint32_t merge = session.addComponent("connectors.bus", eight);
    ComponentParams namedBus = eight; namedBus.instanceName = "BUS";
    const uint32_t split = session.addComponent("connectors.bus", namedBus);
    session.connectWire(merge, "bus-out", split, "bus-in");

    constexpr uint8_t pattern = 0b1010'0101;
    for (size_t bit = 0; bit < 8; ++bit) {
        ComponentParams source; source.properties["voltage"] = ((pattern >> bit) & 1) ? 5.0 : 0.0;
        const uint32_t rail = session.addComponent("sources.rail", source);
        session.connectWire(rail, "out", merge, "bit-" + std::to_string(bit));
    }
    for (int i = 0; i < 30 && session.settleStep(); ++i) {}

    int failures = 0;
    for (size_t bit = 0; bit < 8; ++bit) {
        const double expected = ((pattern >> bit) & 1) ? 5.0 : 0.0;
        if (std::abs(session.nodeVoltageOfPin(split, "bit-" + std::to_string(bit)) - expected) > 1e-3) ++failures;
    }
    try {
        const ResolvedSignal bit3 = session.resolveSignal("BUS[3]");
        if (bit3.elements.size() != 1 || bit3.unsignedValue() != ((pattern >> 3) & 1)) ++failures;
        const ResolvedSignal highNibble = session.resolveSignal("BUS[7:4]");
        if (highNibble.descriptor.width != 4 || highNibble.unsignedValue() != 0xA) ++failures;
    } catch (...) { ++failures; }
    bool badIndexRejected = false;
    try { (void)session.resolveSignal("BUS[9]"); }
    catch (const std::out_of_range&) { badIndexRejected = true; }
    if (!badIndexRejected) ++failures;

    int pauseEvents = 0;
    uint64_t pauseTime = UINT64_MAX;
    session.setPauseConditionTriggeredCallback([&](const PauseConditionTriggered& event) {
        ++pauseEvents; pauseTime = event.simulationTimeNs;
        if (event.ownerId != "analyzer" || event.expression != "BUS[7:4] == 0xA") ++failures;
    });
    session.setPauseCondition("analyzer", "BUS[7:4] == 0xA");
    session.scheduler().step(1);
    if (!session.scheduler().isPaused() || pauseEvents != 1 || pauseTime != 1) ++failures;
    session.scheduler().resume();
    session.scheduler().step(1);
    if (pauseEvents != 1) ++failures; // nível persistente: somente false->true
    session.setPauseCondition("analyzer", "");

    ComponentParams clockParams; clockParams.instanceName = "CLK";
    session.addComponent("sources.clock", clockParams);
    int edgeEvents = 0;
    session.setPauseConditionTriggeredCallback([&](const PauseConditionTriggered& event) {
        if (event.ownerId == "edge") ++edgeEvents;
    });
    session.scheduler().step(0);
    session.setPauseCondition("edge", "rising(CLK.out)");
    session.scheduler().resume();
    session.scheduler().start();
    for (int wait = 0; wait < 100 && edgeEvents == 0; ++wait) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    session.scheduler().stop();
    if (edgeEvents != 1 || !session.scheduler().isPaused()) ++failures;
    const auto state = session.getComponentState(split);
    uint64_t value = 0; if (state.size() >= sizeof(value)) std::memcpy(&value, state.data(), sizeof(value));
    if ((value & 0xffu) != pattern) ++failures;

    ComponentParams four; four.properties["width"] = 4.0;
    const uint32_t narrow = session.addComponent("connectors.bus", four);
    bool rejected = false;
    try { session.connectWire(split, "bus-out", narrow, "bus-in"); }
    catch (const std::invalid_argument& e) { rejected = std::string(e.what()).find("larguras") != std::string::npos; }
    if (!rejected) ++failures;

    if (!session.disconnectWire(merge, "bus-out", split, "bus-in")) ++failures;
    session.connectWire(merge, "bus-out", split, "bus-in");
    // Disconnect/reconnect e um rebuild posterior não perdem os oito pares registrados.
    for (int i = 0; i < 10 && session.settleStep(); ++i) {}
    if (std::abs(session.nodeVoltageOfPin(split, "bit-7") - 5.0) > 1e-3) ++failures;

    std::printf("Bus 8-bit: %s\n", failures == 0 ? "OK" : "FALHOU");
    return failures == 0 ? 0 : 1;
}

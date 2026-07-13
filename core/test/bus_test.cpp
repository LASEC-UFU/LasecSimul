#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include "components/connectors/Bus.hpp"
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

    ComponentParams eight; eight.properties["width"] = 8.0; eight.properties["startBit"] = 0.0;
    const uint32_t merge = session.addComponent("connectors.bus", eight);
    const uint32_t split = session.addComponent("connectors.bus", eight);
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

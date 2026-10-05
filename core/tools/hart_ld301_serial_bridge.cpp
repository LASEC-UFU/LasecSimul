// Serves the simulated Smar LD301 to a real HART master -- PACTware with the
// LD301 DTM, or scripts/ld301_serial_check.py -- through the SAME path a
// LasecSimul circuit uses: nothing is handed to the transmitter directly.
//
//   COMx (PC) == HART modem (series, 250 ohm) == 4-20 mA loop == LD301
//
//   Rail 24 V -- R 250 ohm -- [Modem HART L+/L-] -- [LD301 LOOP+/LOOP-] -- ground
//
// The PC's bytes are modulated by the modem as a voltage carrier on the loop,
// the transmitter demodulates them from its terminals and answers with a
// ±0.5 mA current carrier, which the modem demodulates back to the COM port.
// The simulation runs paced to real time (HART timing is real time for the
// PC).
//
//   hart_ld301_serial_bridge CNCB2 [--subcircuit path] [--pv 0.0] [--temperature 28.078] [--load 250] [--quiet]
//
// The transmitter is the standard HART field device configured exactly as
// subcircuits/hart_smar_ld301.lssubcircuit describes it.

#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/Rail.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "protocols/HartCommunicationComponent.hpp"
#include "protocols/HartModemComponent.hpp"
#include "session/SimulationSession.hpp"

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <thread>

using namespace lasecsimul;
using namespace lasecsimul::protocols;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <COMx|CNCBx> [--pv value] [--temperature value] [--load ohm] [--quiet]\n", argv[0]);
        return 2;
    }
    double pv = 0.0, temperature = 28.077999114990234, load = 250.0;
    bool quiet = false;
    std::string subcircuit = LASECSIMUL_LD301_SUBCIRCUIT;
    for (int i = 2; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--subcircuit" && i + 1 < argc) subcircuit = argv[++i];
        else if (arg == "--pv" && i + 1 < argc) pv = std::atof(argv[++i]);
        else if (arg == "--temperature" && i + 1 < argc) temperature = std::atof(argv[++i]);
        else if (arg == "--load" && i + 1 < argc) load = std::atof(argv[++i]);
        else if (arg == "--quiet") quiet = true;
    }

    registry::ComponentParams ld301Params;
    try {
        std::ifstream file(subcircuit);
        const auto document = nlohmann::json::parse(file);
        for (const auto& component : document.at("components")) {
            if (component.value("typeId", std::string{}) != "protocol.hart.device.standard") continue;
            for (const auto& [key, value] : component.at("properties").items()) {
                if (value.is_string()) ld301Params.properties[key] = value.get<std::string>();
                else if (value.is_boolean()) ld301Params.properties[key] = value.get<bool>();
                else if (value.is_number()) ld301Params.properties[key] = value.get<double>();
            }
        }
    } catch (const std::exception& error) {
        std::fprintf(stderr, "cannot read %s: %s\n", subcircuit.c_str(), error.what());
        return 1;
    }

    plugins::GlobalPluginCache cache;
    session::SimulationSession session(cache);
    auto& scheduler = session.scheduler();
    auto preset = HartCommunicationComponent::standardFieldDevicePreset();
    HartModemComponent* modem = nullptr;
    HartCommunicationComponent* ld301 = nullptr;
    auto& components = session.components();
    components.registerFactory("sources.rail", [](const registry::ComponentParams& p) {
        return std::make_unique<components::Rail>(Pin{"out", 0, 0}, p.property("voltage", 24.0));
    });
    components.registerFactory("passive.resistor", [](const registry::ComponentParams& p) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"p1", 0, 0}, Pin{"p2", 0, 0}}, p.property("resistance", 250.0));
    });
    components.registerFactory("other.ground", [](const registry::ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin", 0, 0});
    });
    components.registerFactory(HartModemComponent::kTypeId, [&](const registry::ComponentParams& p) {
        auto instance = std::make_unique<HartModemComponent>(scheduler, p);
        modem = instance.get();
        return instance;
    });
    components.registerFactory("protocol.hart.device.standard", [&](const registry::ComponentParams& p) {
        auto instance = std::make_unique<HartCommunicationComponent>(HartCommunicationComponent::Mode::Serial, scheduler, p, &preset);
        ld301 = instance.get();
        return instance;
    });

    registry::ComponentParams rail;
    rail.properties["voltage"] = 24.0;
    registry::ComponentParams resistor;
    resistor.properties["resistance"] = load;
    registry::ComponentParams modemParams;
    modemParams.properties["port_name"] = std::string(argv[1]);
    modemParams.properties["auto_open"] = true;
    const uint32_t supply = session.addComponent("sources.rail", rail);
    const uint32_t loadIndex = session.addComponent("passive.resistor", resistor);
    const uint32_t modemIndex = session.addComponent(HartModemComponent::kTypeId, modemParams);
    const uint32_t deviceIndex = session.addComponent("protocol.hart.device.standard", ld301Params);
    const uint32_t ground = session.addComponent("other.ground", {});
    session.connectWire(supply, "out", loadIndex, "p1");
    session.connectWire(loadIndex, "p2", modemIndex, "loop_plus");
    session.connectWire(modemIndex, "loop_minus", deviceIndex, "loop_plus");
    session.connectWire(deviceIndex, "loop_minus", ground, "pin");
    ld301->setSignalInput("PV", pv);
    ld301->setSignalInput("temperature", temperature);
    for (int i = 0; i < 20 && session.settleStep(); ++i) {}

    bool portOpen = false;
    std::string error;
    for (auto& descriptor : modem->propertyDescriptors()) {
        if (descriptor.schema.id == "port_is_open") portOpen = std::get<bool>(descriptor.get());
        if (descriptor.schema.id == "port_error") error = std::get<std::string>(descriptor.get());
    }
    if (!portOpen) {
        std::fprintf(stderr, "cannot open %s: %s\n", argv[1], error.c_str());
        return 1;
    }
    std::printf("LD301 on a simulated 4-20 mA loop (24 V, %.0f ohm + HART modem 250 ohm) -- PC side %s @ 1200 8O1; "
                "PV %.4f mmH2O, temperature %.3f degC. Ctrl+C to stop.\n", load, argv[1], pv, temperature);
    std::fflush(stdout);

    // Paced to real time: the PC's HART timing is wall-clock time.
    const auto wallStart = std::chrono::steady_clock::now();
    const uint64_t simStart = scheduler.nowNs();
    uint32_t reportedFrames = 0, reportedReplies = 0;
    auto lastReport = wallStart;
    for (;;) {
        scheduler.step(2'000'000);
        const auto wall = std::chrono::steady_clock::now();
        const auto simElapsed = std::chrono::nanoseconds(scheduler.nowNs() - simStart);
        const auto wallElapsed = wall - wallStart;
        if (simElapsed > wallElapsed) std::this_thread::sleep_for(simElapsed - wallElapsed);
        if (!quiet && (ld301->wireFramesReceived() != reportedFrames || ld301->wireRepliesSent() != reportedReplies)) {
            reportedFrames = ld301->wireFramesReceived();
            reportedReplies = ld301->wireRepliesSent();
            std::printf("loop: %u request frame(s) demodulated by the LD301, %u reply(ies) modulated  [%.1f mA]\n",
                        reportedFrames, reportedReplies, ld301->loopCurrentMilliamps());
            std::fflush(stdout);
        }
        if (!quiet && wall - lastReport > std::chrono::seconds(10)) {
            lastReport = wall;
            const double lag = std::chrono::duration<double>(wallElapsed - simElapsed).count();
            if (lag > 0.05) std::printf("warning: simulation %.2f s behind real time\n", lag);
            std::fflush(stdout);
        }
    }
}

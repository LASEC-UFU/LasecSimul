#include <array>
#include <cmath>
#include <cstdio>
#include <memory>
#include "components/other/Ground.hpp"
#include "components/passive/Capacitor.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/DcVoltageSource.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::plugins;
using namespace lasecsimul::registry;
using namespace lasecsimul::session;

static void registerComponents(SimulationSession& session) {
    session.components().registerFactory("v", [](const ComponentParams&) {
        return std::make_unique<components::DcVoltageSource>(std::array<Pin, 2>{Pin{"p"}, Pin{"n"}}, 1.0);
    });
    session.components().registerFactory("r", [](const ComponentParams&) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"p"}, Pin{"n"}}, 1000.0);
    });
    session.components().registerFactory("c", [](const ComponentParams&) {
        return std::make_unique<components::Capacitor>(std::array<Pin, 2>{Pin{"p"}, Pin{"n"}}, 1e-6);
    });
    session.components().registerFactory("g", [](const ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"p"});
    });
}

static bool runCase(IntegrationMethod method, double tolerance, bool adaptive = false, uint64_t stepNs = 10'000) {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerComponents(session);
    TransientSettings settings;
    settings.method = method;
    settings.initialStepNs = settings.maximumStepNs = stepNs;
    settings.minimumStepNs = 1;
    settings.adaptiveTimeStep = adaptive;
    session.setTransientSettings(settings);

    const uint32_t source = session.addComponent("v", {});
    const uint32_t resistor = session.addComponent("r", {});
    const uint32_t capacitor = session.addComponent("c", {});
    const uint32_t ground = session.addComponent("g", {});
    session.connectWire(source, "p", resistor, "p");
    session.connectWire(resistor, "n", capacitor, "p");
    session.connectWire(capacitor, "n", source, "n");
    session.connectWire(source, "n", ground, "p");

    session.scheduler().runUntil(1'000'000); // uma constante de tempo RC
    const double actual = session.nodeVoltageOfPin(capacitor, "p");
    const double expected = 1.0 - std::exp(-1.0);
    const double error = std::abs(actual - expected);
    std::printf("method=%u actual=%.9f expected=%.9f error=%.3g\n",
                static_cast<unsigned>(method), actual, expected, error);
    return error <= tolerance;
}

int main() {
    bool ok = true;
    ok &= runCase(IntegrationMethod::BackwardEuler, 0.003);
    ok &= runCase(IntegrationMethod::Trapezoidal, 0.0001);
    ok &= runCase(IntegrationMethod::Gear2, 0.003);
    ok &= runCase(IntegrationMethod::Automatic, 0.0002);
    ok &= runCase(IntegrationMethod::Automatic, 0.0005, true, 100'000);
    return ok ? 0 : 1;
}

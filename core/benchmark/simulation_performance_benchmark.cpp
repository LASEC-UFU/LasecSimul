#include <array>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>
#include "components/meters/LogicAnalyzer.hpp"
#include "components/meters/Oscope.hpp"
#include "components/other/Ground.hpp"
#include "components/passive/Capacitor.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/Clock.hpp"
#include "components/sources/FixedVolt.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::components;
using namespace lasecsimul::plugins;
using namespace lasecsimul::registry;
using namespace lasecsimul::session;
using ClockSource = lasecsimul::components::Clock;
using WallClock = std::chrono::steady_clock;

namespace {

struct Options {
    uint64_t simulatedNanoseconds = 10'000'000;
    size_t scale = 100;
    double digitalFrequencyHz = 10'000.0;
    bool requireRealtime = false;
};

int performanceFailures = 0;

void registerComponents(SimulationSession& session, double digitalFrequencyHz) {
    session.components().registerFactory("bench.ground", [](const ComponentParams&) {
        return std::make_unique<Ground>(Pin{"p"});
    });
    session.components().registerFactory("bench.source", [](const ComponentParams&) {
        return std::make_unique<FixedVolt>(Pin{"p"}, 5.0, true);
    });
    session.components().registerFactory("bench.resistor", [](const ComponentParams&) {
        return std::make_unique<Resistor>(std::array<Pin, 2>{Pin{"p"}, Pin{"n"}}, 1'000.0);
    });
    session.components().registerFactory("bench.capacitor", [](const ComponentParams&) {
        return std::make_unique<Capacitor>(std::array<Pin, 2>{Pin{"p"}, Pin{"n"}}, 1e-6);
    });
    session.components().registerFactory("bench.clock", [&session, digitalFrequencyHz](const ComponentParams&) {
        return std::make_unique<ClockSource>(session.scheduler(), Pin{"p"}, 5.0, digitalFrequencyHz, true);
    });
    session.components().registerFactory("bench.oscope", [&session](const ComponentParams&) {
        return std::make_unique<Oscope>(session.scheduler(),
            std::array<Pin, Oscope::kPinCount>{Pin{"ch1"}, Pin{"ch2"}, Pin{"ch3"}, Pin{"ch4"}, Pin{"ref"}});
    });
    session.components().registerFactory("bench.logic", [&session](const ComponentParams&) {
        return std::make_unique<LogicAnalyzer>(session.scheduler(),
            std::array<Pin, LogicAnalyzer::kChannelCount>{Pin{"ch0"}, Pin{"ch1"}, Pin{"ch2"}, Pin{"ch3"},
                                                           Pin{"ch4"}, Pin{"ch5"}, Pin{"ch6"}, Pin{"ch7"}},
            3.0, 2.0);
    });
}

void addPassiveIsland(SimulationSession& session, bool reactive) {
    const uint32_t source = session.addComponent("bench.source", {});
    const uint32_t resistor = session.addComponent("bench.resistor", {});
    const uint32_t ground = session.addComponent("bench.ground", {});
    session.connectWire(source, "p", resistor, "p");
    if (reactive) {
        const uint32_t capacitor = session.addComponent("bench.capacitor", {});
        session.connectWire(resistor, "n", capacitor, "p");
        session.connectWire(capacitor, "n", ground, "p");
    } else {
        session.connectWire(resistor, "n", ground, "p");
    }
}

void addDigitalIsland(SimulationSession& session) {
    const uint32_t clock = session.addComponent("bench.clock", {});
    const uint32_t resistor = session.addComponent("bench.resistor", {});
    const uint32_t ground = session.addComponent("bench.ground", {});
    session.connectWire(clock, "p", resistor, "p");
    session.connectWire(resistor, "n", ground, "p");
}

template <class Build>
void runScenario(const char* name, const Options& options, size_t units, Build&& build) {
    const auto initializationStart = WallClock::now();
    GlobalPluginCache cache;
    SimulationSession session(cache, std::max<size_t>(1024, units * 5 + 32));
    registerComponents(session, options.digitalFrequencyHz);
    build(session, units);
    const auto initializationEnd = WallClock::now();

    session.setPerformanceProfilingEnabled(true);
    session.resetPerformanceMetrics();
    const auto executionStart = WallClock::now();
    session.scheduler().runUntil(options.simulatedNanoseconds);
    const auto executionEnd = WallClock::now();
    const SimulationPerformanceSnapshot metrics = session.performanceMetrics();

    const double initializationMs = std::chrono::duration<double, std::milli>(
        initializationEnd - initializationStart).count();
    const double wallMs = std::chrono::duration<double, std::milli>(executionEnd - executionStart).count();
    const double rate = wallMs > 0.0 ? (static_cast<double>(metrics.simulatedNanoseconds) / 1e6) / wallMs : 0.0;
    if (options.requireRealtime && rate < 1.0) ++performanceFailures;
    std::printf(
        "SCENARIO name=%s units=%zu init_ms=%.3f wall_ms=%.3f simulated_ns=%llu rate=%.3fx "
        "steps=%llu events=%llu settle_iterations=%llu stamps=%llu solver_calls=%llu "
        "solver_ms=%.3f devices_ms=%.3f topology_ms=%.3f pending_events=%llu solver_threads=%zu\n",
        name, units, initializationMs, wallMs, static_cast<unsigned long long>(metrics.simulatedNanoseconds), rate,
        static_cast<unsigned long long>(metrics.timeSteps), static_cast<unsigned long long>(metrics.eventsProcessed),
        static_cast<unsigned long long>(metrics.settleIterations),
        static_cast<unsigned long long>(metrics.componentStamps),
        static_cast<unsigned long long>(metrics.solverCalls), static_cast<double>(metrics.solverNanoseconds) / 1e6,
        static_cast<double>(metrics.deviceStampNanoseconds) / 1e6,
        static_cast<double>(metrics.topologyNanoseconds) / 1e6,
        static_cast<unsigned long long>(metrics.pendingEvents), metrics.solverThreads);
}

Options parseOptions(int argc, char** argv) {
    Options options;
    for (int i = 1; i < argc; ++i) {
        const std::string option = argv[i];
        if (option == "--require-realtime") { options.requireRealtime = true; continue; }
        if (i + 1 >= argc) break;
        if (option == "--sim-ns") options.simulatedNanoseconds = std::strtoull(argv[++i], nullptr, 10);
        else if (option == "--scale") options.scale = static_cast<size_t>(std::strtoull(argv[++i], nullptr, 10));
        else if (option == "--digital-hz") options.digitalFrequencyHz = std::strtod(argv[++i], nullptr);
    }
    return options;
}

} // namespace

int main(int argc, char** argv) {
    const Options options = parseOptions(argc, argv);
    runScenario("empty", options, 0, [](SimulationSession&, size_t) {});
    runScenario("passive", options, options.scale, [](SimulationSession& session, size_t units) {
        for (size_t i = 0; i < units; ++i) addPassiveIsland(session, false);
    });
    runScenario("analog_rc", options, options.scale, [](SimulationSession& session, size_t units) {
        for (size_t i = 0; i < units; ++i) addPassiveIsland(session, true);
    });
    runScenario("digital", options, options.scale, [](SimulationSession& session, size_t units) {
        for (size_t i = 0; i < units; ++i) addDigitalIsland(session);
    });
    runScenario("instruments", options, 1, [](SimulationSession& session, size_t) {
        const uint32_t clock = session.addComponent("bench.clock", {});
        const uint32_t ground = session.addComponent("bench.ground", {});
        const uint32_t oscope = session.addComponent("bench.oscope", {});
        const uint32_t logic = session.addComponent("bench.logic", {});
        for (const char* pin : {"ch1", "ch2", "ch3", "ch4"}) session.connectWire(clock, "p", oscope, pin);
        session.connectWire(ground, "p", oscope, "ref");
        for (const char* pin : {"ch0", "ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7"})
            session.connectWire(clock, "p", logic, pin);
    });
    return performanceFailures == 0 ? 0 : 1;
}

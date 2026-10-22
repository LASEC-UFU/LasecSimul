#include "python/PythonProgramBlock.hpp"
#include "components/control/SignalConstant.hpp"
#include "components/control/SignalMathBlock.hpp"
#include "components/bridges/SignalBridges.hpp"
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/FixedVolt.hpp"
#include "session/SimulationSession.hpp"
#include "plugins/GlobalPluginCache.hpp"

#include <chrono>
#include <atomic>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <thread>
#include <tuple>
#include <utility>

using namespace lasecsimul;

int main() {
#if !defined(LASECSIMUL_TEST_PYTHON_EXECUTABLE)
    std::puts("PULADO: CMake nao encontrou um interpretador Python 3");
    return 0;
#else
    plugins::GlobalPluginCache cache;
    auto budget = resources::ResourceGovernor::forProfile(resources::ResourceProfile::SharedHost, 4).budget();
    budget.pythonStepTimeoutMs = 1000;
    budget.pythonMemoryBytes = 128ull * 1024ull * 1024ull;
    budget.pythonPayloadBytes = 256ull * 1024ull;
    session::SimulationSession session(cache, 32, resources::ResourceGovernor(budget));
    session.components().registerFactory("control.constant", [](const registry::ComponentParams& params) {
        return std::make_unique<components::SignalConstant>(params);
    });
    session.components().registerFactory("process.accumulator", [](const registry::ComponentParams& params) {
        return std::make_unique<components::SignalMathBlock>("process.accumulator", params);
    });
    session.components().registerFactory(python::PythonProgramBlock::kTypeId, [](const registry::ComponentParams& params) {
        return std::make_unique<python::PythonProgramBlock>(params);
    });
    std::atomic_bool isolatedFaultReported{false};
    session.setPythonFaultCallback([&](uint64_t, const std::string& detail) {
        if (detail.find("isolated expected error") != std::string::npos)
            isolatedFaultReported.store(true, std::memory_order_relaxed);
    });

    registry::ComponentParams constantParams;
    constantParams.properties["value"] = 4.0;
    const uint32_t constantIndex = session.addComponent("control.constant", constantParams);
    registry::ComponentParams params;
    params.properties["source"] = std::string{"y = x * 2.0 + bias\nenabled = True"};
    params.properties["periodNs"] = 1'000'000.0;
    params.properties["ports"] = std::string{R"({"inputs":[{"name":"x","type":"real"},{"name":"bias","type":"real","initialValue":2.0}],"outputs":[{"name":"y","type":"real"},{"name":"idle","type":"real","initialValue":9.5},{"name":"enabled","type":"bool"}]})"};
    const uint32_t index = session.addComponent(python::PythonProgramBlock::kTypeId, params);
    registry::ComponentParams downstreamParams;
    downstreamParams.properties["source"] = std::string{"z = x + 1.0"};
    downstreamParams.properties["periodNs"] = 1'000'000.0;
    downstreamParams.properties["ports"] = std::string{R"({"inputs":[{"name":"x","type":"real"}],"outputs":[{"name":"z","type":"real"}]})"};
    const uint32_t downstreamIndex = session.addComponent(python::PythonProgramBlock::kTypeId, downstreamParams);
    registry::ComponentParams failingParams;
    failingParams.properties["source"] = std::string{"raise RuntimeError('isolated expected error')"};
    failingParams.properties["periodNs"] = 1'000'000.0;
    failingParams.properties["failureMode"] = std::string{"initial"};
    failingParams.properties["ports"] = std::string{R"({"outputs":[{"name":"q","type":"real","initialValue":6.0}]})"};
    const uint32_t failingIndex = session.addComponent(python::PythonProgramBlock::kTypeId, failingParams);
    registry::ComponentParams zeroParams = failingParams;
    zeroParams.properties["failureMode"] = std::string{"zero"};
    zeroParams.properties["ports"] = std::string{R"({"outputs":[{"name":"z","type":"real","initialValue":6.0}]})"};
    const uint32_t zeroFailureIndex = session.addComponent(python::PythonProgramBlock::kTypeId, zeroParams);
    registry::ComponentParams tankFlowParams;
    tankFlowParams.properties["value"] = 1.0;
    const uint32_t tankFlowIndex = session.addComponent("control.constant", tankFlowParams);
    registry::ComponentParams tankParams;
    tankParams.properties["initial"] = 20.0;
    tankParams.properties["lowerLimitEnabled"] = true;
    tankParams.properties["lowerLimit"] = 0.0;
    tankParams.properties["upperLimitEnabled"] = true;
    tankParams.properties["upperLimit"] = 100.0;
    tankParams.properties["lowerInput"] = false;
    tankParams.properties["upperInput"] = false;
    const uint32_t tankIndex = session.addComponent("process.accumulator", tankParams);
    registry::ComponentParams tankControllerParams;
    tankControllerParams.properties["source"] = std::string{
        "if nivel >= 75.0:\n    state.valvula = True\nelif nivel <= 35.0:\n    state.valvula = False\n"
        "qout = 2.0 if state.get('valvula', False) else 0.2\n"};
    tankControllerParams.properties["periodNs"] = 100'000'000.0;
    tankControllerParams.properties["ports"] = std::string{
        R"({"inputs":[{"name":"nivel","type":"real","initialValue":20.0}],"outputs":[{"name":"qout","type":"real","initialValue":0.2}]})"};
    const uint32_t tankControllerIndex = session.addComponent(python::PythonProgramBlock::kTypeId, tankControllerParams);
    session.connectWire(constantIndex, "out", index, "x");
    session.connectWire(index, "y", downstreamIndex, "x");
    session.connectWire(tankFlowIndex, "out", tankIndex, "in");
    session.connectWire(tankIndex, "out", tankControllerIndex, "nivel");
    session.connectWire(tankControllerIndex, "qout", tankIndex, "outflow");
    simulation::SeriesSubscriptionRequest seriesRequest;
    seriesRequest.channels.push_back({index, "y", 0});
    seriesRequest.periodNs = 1'000'000;
    seriesRequest.capacityRows = 64;
    const uint32_t seriesSubscription = session.subscribeSeries(std::move(seriesRequest));
    session.scheduler().start();

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    std::tuple<uint64_t, uint64_t> progress{};
    while (std::chrono::steady_clock::now() < deadline) {
        progress = session.scheduler().synchronized([&] {
            return std::tuple{session.scheduler().nowNs(), session.pythonRuntime().metrics().steps};
        });
        if (std::get<0>(progress) >= 300'000'000 && std::get<1>(progress) >= 8) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    const uint64_t steps = std::get<1>(progress);
    if (std::get<0>(progress) < 300'000'000 || steps < 8) {
        session.stopSimulation();
        std::fprintf(stderr, "PythonProgramBlock did not execute from the normal SimulationSession scheduler: t=%llu scans=%llu\n",
                     static_cast<unsigned long long>(std::get<0>(progress)),
                     static_cast<unsigned long long>(steps));
        return 1;
    }

    const std::string outputId = signalPortBlockId(index, "y");
    const std::string idleId = signalPortBlockId(index, "idle");
    const std::string enabledId = signalPortBlockId(index, "enabled");
    const std::string downstreamOutputId = signalPortBlockId(downstreamIndex, "z");
    const std::string tankOutputId = signalPortBlockId(tankIndex, "out");
    const std::string tankCommandId = signalPortBlockId(tankControllerIndex, "qout");
    session.scheduler().pause();
    const auto [output, idle, enabled, downstreamOutput, tankLevel, tankCommand] = session.scheduler().synchronized([&] {
        return std::tuple{session.signalRuntime().real(session.signalRuntime().output(outputId)),
                         session.signalRuntime().real(session.signalRuntime().output(idleId)),
                         session.signalRuntime().boolean(session.signalRuntime().output(enabledId)),
                         session.signalRuntime().real(session.signalRuntime().output(downstreamOutputId)),
                         session.signalRuntime().real(session.signalRuntime().output(tankOutputId)),
                         session.signalRuntime().real(session.signalRuntime().output(tankCommandId))};
    });
    const auto [failureInitial, failureZero] = session.scheduler().synchronized([&] {
        return std::pair{session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(failingIndex, "q"))),
                         session.signalRuntime().real(session.signalRuntime().output(signalPortBlockId(zeroFailureIndex, "z")))};
    });
    const auto series = session.drainSeries(seriesSubscription, std::nullopt, 0, 0, 64);
    const bool pythonSeriesRecorded = series && !series->resolved.empty() && series->resolved[0] != 0 &&
        !series->columns.empty() && !series->columns[0].empty() &&
        std::abs(series->columns[0].back() - 10.0) < 1e-9;
    session.unsubscribeSeries(seriesSubscription);
    const bool runtimeReadyAfterIsolatedError = session.pythonRuntime().health() == python::PythonWorkerHealth::Ready;
    session.stopSimulation();
    if (std::abs(output - 10.0) > 1e-9 || std::abs(idle - 9.5) > 1e-9 || !enabled ||
        std::abs(downstreamOutput - 11.0) > 1e-9 || std::abs(tankCommand - 0.2) > 1e-9 ||
        tankLevel <= 20.0 || !std::isfinite(output) || !isolatedFaultReported.load(std::memory_order_relaxed) ||
        !runtimeReadyAfterIsolatedError || !pythonSeriesRecorded || std::abs(failureInitial - 6.0) > 1e-9 ||
        std::abs(failureZero) > 1e-9) {
        std::fprintf(stderr, "PythonProgramBlock output was not propagated through the Signal Engine: y=%f enabled=%d z=%f tank=%f qout=%f errorReported=%d health=%d\n",
                     output, enabled, downstreamOutput, tankLevel, tankCommand,
                     isolatedFaultReported.load(std::memory_order_relaxed), runtimeReadyAfterIsolatedError ? 1 : 0);
        return 1;
    }
    const auto readout = session.getComponentTelemetryState(index);
    const auto history = session.getComponentState(index);
    double readoutOutput = 0.0, readoutDigital = 0.0, historyOutput = 0.0;
    if (readout.size() >= sizeof(readoutOutput)) std::memcpy(&readoutOutput, readout.data(), sizeof(readoutOutput));
    if (readout.size() >= 3 * sizeof(double)) std::memcpy(&readoutDigital, readout.data() + 2 * sizeof(double), sizeof(readoutDigital));
    if (history.size() >= sizeof(historyOutput)) std::memcpy(&historyOutput, history.data(), sizeof(historyOutput));
    if (readout.size() != 64 * sizeof(double) || std::abs(readoutOutput - 10.0) > 1e-9 || readoutDigital != 1.0 ||
        history.size() < 64 * sizeof(double) + sizeof(uint32_t) || historyOutput != 10.0) {
        std::fprintf(stderr, "Python outputs were not published through component telemetry for HMI bindings\n");
        return 1;
    }
    uint32_t sampleCount = 0;
    std::memcpy(&sampleCount, history.data() + 64 * sizeof(double), sizeof(sampleCount));
    if (sampleCount == 0 || history.size() != 64 * sizeof(double) + sizeof(uint32_t) + 64 * sampleCount * 16) {
        std::fprintf(stderr, "Python output history format did not expose simulated samples\n");
        return 1;
    }
    std::printf("PythonProgramBlock scheduler-to-SignalGraph integration: OK (%llu scans)\n",
                static_cast<unsigned long long>(steps));

    // End-to-end cross-domain proof: an interpreted Python bool output drives the ordinary
    // digital-output bridge and produces real current through an electrical load.
    lasecsimul::session::SimulationSession electricalSession(cache, 8, resources::ResourceGovernor(budget));
    electricalSession.components().registerFactory(python::PythonProgramBlock::kTypeId, [](const registry::ComponentParams& value) {
        return std::make_unique<python::PythonProgramBlock>(value);
    });
    electricalSession.components().registerFactory("bridges.digital_output", [](const registry::ComponentParams& value) {
        const auto pins = value.pins<2>();
        return std::make_unique<components::SignalDigitalOutput>(std::array<Pin, 2>{
            Pin{pins[0].id.empty() ? "p" : pins[0].id, pins[0].x, pins[0].y},
            Pin{pins[1].id.empty() ? "n" : pins[1].id, pins[1].x, pins[1].y}});
    });
    electricalSession.components().registerFactory("passive.resistor", [](const registry::ComponentParams& value) {
        const auto pins = value.pins<2>();
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{
            Pin{pins[0].id.empty() ? "p1" : pins[0].id, pins[0].x, pins[0].y},
            Pin{pins[1].id.empty() ? "p2" : pins[1].id, pins[1].x, pins[1].y}}, 1000.0);
    });
    electricalSession.components().registerFactory("other.ground", [](const registry::ComponentParams& value) {
        const auto pins = value.pins<1>();
        return std::make_unique<components::Ground>(Pin{pins[0].id.empty() ? "pin" : pins[0].id,
                                                        pins[0].x, pins[0].y});
    });
    electricalSession.components().registerFactory("sources.fixed_volt", [](const registry::ComponentParams& value) {
        const auto pins = value.pins<1>();
        return std::make_unique<components::FixedVolt>(Pin{pins[0].id.empty() ? "pin" : pins[0].id,
                                                           pins[0].x, pins[0].y},
                                                       value.property("voltage", 12.0), true);
    });
    electricalSession.components().registerFactory("bridges.voltage_sensor", [](const registry::ComponentParams& value) {
        const auto pins = value.pins<2>();
        return std::make_unique<components::SignalVoltageSensor>(std::array<Pin, 2>{
            Pin{pins[0].id.empty() ? "p" : pins[0].id, pins[0].x, pins[0].y},
            Pin{pins[1].id.empty() ? "n" : pins[1].id, pins[1].x, pins[1].y}});
    });
    registry::ComponentParams digitalProgram;
    digitalProgram.properties["source"] = std::string{"observed = measured\nenabled = measured > 3.0"};
    digitalProgram.properties["periodNs"] = 1'000'000.0;
    digitalProgram.properties["ports"] = std::string{R"({"inputs":[{"name":"measured","type":"real"}],"outputs":[{"name":"enabled","type":"bool"},{"name":"observed","type":"real"}]})"};
    const uint32_t pythonSource = electricalSession.addComponent(python::PythonProgramBlock::kTypeId, digitalProgram);
    const uint32_t digitalOutput = electricalSession.addComponent("bridges.digital_output", {});
    const uint32_t load = electricalSession.addComponent("passive.resistor", {});
    const uint32_t electricalGround = electricalSession.addComponent("other.ground", {});
    const uint32_t supply = electricalSession.addComponent("sources.fixed_volt", {});
    const uint32_t dividerHigh = electricalSession.addComponent("passive.resistor", {});
    const uint32_t dividerLow = electricalSession.addComponent("passive.resistor", {});
    const uint32_t voltageSensor = electricalSession.addComponent("bridges.voltage_sensor", {});
    electricalSession.connectWire(supply, "pin", dividerHigh, "p1");
    electricalSession.connectWire(dividerHigh, "p2", dividerLow, "p1");
    electricalSession.connectWire(dividerLow, "p2", electricalGround, "pin");
    electricalSession.connectWire(voltageSensor, "p", dividerHigh, "p2");
    electricalSession.connectWire(voltageSensor, "n", electricalGround, "pin");
    electricalSession.connectWire(voltageSensor, "value", pythonSource, "measured");
    electricalSession.connectWire(pythonSource, "enabled", digitalOutput, "command");
    electricalSession.connectWire(digitalOutput, "p", load, "p1");
    electricalSession.connectWire(load, "p2", electricalGround, "pin");
    electricalSession.connectWire(digitalOutput, "n", electricalGround, "pin");
    electricalSession.scheduler().runUntil(2'000'000);
    const auto electricalProgress = std::pair{electricalSession.scheduler().nowNs(), electricalSession.pythonRuntime().metrics().steps};
    const auto electricalCurrent = electricalSession.componentCurrent(load);
    const double pythonMeasured = electricalSession.signalRuntime().real(electricalSession.signalRuntime().output(
        signalPortBlockId(pythonSource, "observed")));
    electricalSession.stopSimulation();
    if (electricalProgress.first < 2'000'000 || electricalProgress.second < 1 || !electricalCurrent ||
        std::abs(std::abs(*electricalCurrent) - 0.005) > 1e-6 || std::abs(pythonMeasured - 6.0) > 0.05) {
        std::fprintf(stderr, "Python cross-domain loop failed: t=%llu steps=%llu input=%f current=%f\n",
                     static_cast<unsigned long long>(electricalProgress.first),
                     static_cast<unsigned long long>(electricalProgress.second),
                     pythonMeasured,
                     electricalCurrent.value_or(-1.0));
        return 1;
    }
    std::puts("Electrical voltage sensor -> Python -> digital actuator integration: OK");

    lasecsimul::session::SimulationSession initialSession(cache, 4, resources::ResourceGovernor(budget));
    initialSession.components().registerFactory(python::PythonProgramBlock::kTypeId, [](const registry::ComponentParams& value) {
        return std::make_unique<python::PythonProgramBlock>(value);
    });
    registry::ComponentParams initialParams;
    initialParams.properties["source"] = std::string{"state.count = state.get('count', 0) + 1\ny = state.count"};
    initialParams.properties["periodNs"] = 1'000'000.0;
    initialParams.properties["ports"] = std::string{R"({"outputs":[{"name":"y","type":"real","initialValue":42.5}]})"};
    const uint32_t initialBlock = initialSession.addComponent(python::PythonProgramBlock::kTypeId, initialParams);
    initialSession.scheduler().runUntil(0);
    const double initialOutput = initialSession.signalRuntime().real(initialSession.signalRuntime().output(
        signalPortBlockId(initialBlock, "y")));
    if (std::abs(initialOutput - 42.5) > 1e-9) {
        initialSession.stopSimulation();
        std::fprintf(stderr, "Python output did not publish its configured initial value before the first scan: %f\n",
                     initialOutput);
        return 1;
    }
    initialSession.scheduler().runUntil(2'000'000);
    const double firstRunState = initialSession.signalRuntime().real(initialSession.signalRuntime().output(
        signalPortBlockId(initialBlock, "y")));
    initialSession.stopSimulation();
    initialSession.scheduler().runUntil(2'000'000);
    const double restartedRunState = initialSession.signalRuntime().real(initialSession.signalRuntime().output(
        signalPortBlockId(initialBlock, "y")));
    initialSession.stopSimulation();
    if (std::abs(firstRunState - 2.0) > 1e-9 || std::abs(restartedRunState - 2.0) > 1e-9) {
        std::fprintf(stderr, "Python state did not reset deterministically on stop/run: first=%f second=%f\n",
                     firstRunState, restartedRunState);
        return 1;
    }
    std::puts("Python configured output initial value and state reset: OK");
    return 0;
#endif
}

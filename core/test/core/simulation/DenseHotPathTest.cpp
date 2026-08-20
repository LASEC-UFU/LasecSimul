#include <array>
#include <atomic>
#include <cstdio>

#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::session;

namespace {

std::atomic<uint64_t> reactiveQueries{0};
std::atomic<uint64_t> nonlinearQueries{0};
std::atomic<uint64_t> subscriptionQueries{0};
std::atomic<uint64_t> resolvedSamples{0};

class CountingComponent final : public IComponentModel {
public:
    CountingComponent(bool reactive, bool nonlinear) : m_reactive(reactive), m_nonlinear(nonlinear) {}

    const char* typeId() const override { return "test.counting"; }
    std::span<Pin> pins() override { return m_pins; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    bool isReactive() const override {
        reactiveQueries.fetch_add(1, std::memory_order_relaxed);
        return m_reactive;
    }
    bool isNonlinear() const override {
        nonlinearQueries.fetch_add(1, std::memory_order_relaxed);
        return m_nonlinear;
    }
    bool hasConverged() const override { return true; }
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

private:
    bool m_reactive;
    bool m_nonlinear;
    std::array<Pin, 0> m_pins{};
};

class CountingObserver final : public IComponentModel {
public:
    const char* typeId() const override { return "test.observer"; }
    std::span<Pin> pins() override { return m_pins; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    std::vector<SignalSubscription> signalSubscriptions() const override {
        subscriptionQueries.fetch_add(1, std::memory_order_relaxed);
        return {{"channel", "@self.in", "Input", SignalValueKind::Analog}};
    }
    bool wantsResolvedSignalSample(uint64_t) const override { return true; }
    void onResolvedSignalSample(uint64_t, std::span<const ResolvedSignal> values) override {
        if (values.size() == 1) resolvedSamples.fetch_add(1, std::memory_order_relaxed);
    }
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

private:
    std::array<Pin, 1> m_pins{Pin{"in"}};
};

int runTest() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache, 1024);
    session.components().registerFactory("test.inert", [](const ComponentParams&) {
        return std::make_unique<CountingComponent>(false, false);
    });
    session.components().registerFactory("test.reactive", [](const ComponentParams&) {
        return std::make_unique<CountingComponent>(true, false);
    });
    session.components().registerFactory("test.nonlinear", [](const ComponentParams&) {
        return std::make_unique<CountingComponent>(false, true);
    });
    session.components().registerFactory("test.observer", [](const ComponentParams&) {
        return std::make_unique<CountingObserver>();
    });

    for (size_t index = 0; index < 510; ++index) session.addComponent("test.inert", {});
    session.addComponent("test.reactive", {});
    session.addComponent("test.nonlinear", {});
    session.addComponent("test.observer", {});
    const auto plan = session.simulationPlan();
    if (plan->execution->activeComponents.size() != 513 ||
        plan->execution->reactiveComponents != std::vector<uint32_t>{510} ||
        plan->execution->nonlinearComponents != std::vector<uint32_t>{511} ||
        plan->execution->signalSubscribers != std::vector<uint32_t>{512}) {
        std::fprintf(stderr, "FALHOU: classificacao densa incorreta\n");
        return 1;
    }

    reactiveQueries.store(0, std::memory_order_relaxed);
    nonlinearQueries.store(0, std::memory_order_relaxed);
    subscriptionQueries.store(0, std::memory_order_relaxed);
    resolvedSamples.store(0, std::memory_order_relaxed);
    session.scheduler().runUntil(10);
    if (reactiveQueries.load(std::memory_order_relaxed) != 0 ||
        nonlinearQueries.load(std::memory_order_relaxed) != 0 ||
        subscriptionQueries.load(std::memory_order_relaxed) != 0 ||
        resolvedSamples.load(std::memory_order_relaxed) == 0) {
        std::fprintf(stderr, "FALHOU: hot path voltou a resolver classificacao/source global\n");
        return 1;
    }
    std::printf("Dense hot path: 513 ativos, 0 scans globais de classificacao/source\n");
    return 0;
}

} // namespace

int main() { return runTest(); }

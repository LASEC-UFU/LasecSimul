#include <algorithm>
#include <array>
#include <atomic>
#include <cstdio>
#include <memory>
#include <optional>
#include <vector>

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

/** Assinante de dois canais: divide com CountingObserver o buffer de amostra da sessão. */
std::atomic<uint64_t> wideSamples{0};
std::atomic<uint64_t> wrongSamples{0};

class WideObserver final : public IComponentModel {
public:
    const char* typeId() const override { return "test.wide_observer"; }
    std::span<Pin> pins() override { return m_pins; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    std::vector<SignalSubscription> signalSubscriptions() const override {
        return {{"a", "@self.in", "A", SignalValueKind::Analog}, {"b", "@self.in2", "B", SignalValueKind::Analog}};
    }
    bool wantsResolvedSignalSample(uint64_t) const override { return true; }
    void onResolvedSignalSample(uint64_t, std::span<const ResolvedSignal> values) override {
        const bool ok = values.size() == 2 && values[0].descriptor.channelId == "a" &&
                        values[1].descriptor.channelId == "b" && values[0].elements.size() == 1 &&
                        values[1].elements.size() == 1;
        (ok ? wideSamples : wrongSamples).fetch_add(1, std::memory_order_relaxed);
    }
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

private:
    std::array<Pin, 2> m_pins{Pin{"in"}, Pin{"in2"}};
};

class NarrowObserver final : public IComponentModel {
public:
    const char* typeId() const override { return "test.narrow_observer"; }
    std::span<Pin> pins() override { return m_pins; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    std::vector<SignalSubscription> signalSubscriptions() const override {
        return {{"only", "@self.in", "Only", SignalValueKind::Analog}};
    }
    bool wantsResolvedSignalSample(uint64_t) const override { return true; }
    void onResolvedSignalSample(uint64_t, std::span<const ResolvedSignal> values) override {
        const bool ok = values.size() == 1 && values[0].descriptor.channelId == "only" && values[0].elements.size() == 1;
        if (!ok) wrongSamples.fetch_add(1, std::memory_order_relaxed);
    }
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

private:
    std::array<Pin, 1> m_pins{Pin{"in"}};
};

/** Corrente = número do último evento: cada passo estável publica um valor diferente. */
std::atomic<int> currentStep{0};

class SteppedCurrent final : public IComponentModel {
public:
    const char* typeId() const override { return "test.stepped_current"; }
    std::span<Pin> pins() override { return m_pins; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    std::optional<double> current() const override { return currentStep.load(std::memory_order_relaxed); }
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

private:
    std::array<Pin, 0> m_pins{};
};

/** O snapshot publicado a cada passo estável é reescrito no lugar quando nenhum leitor o segura,
 * e nunca enquanto um leitor o segura. */
int testPublishedSnapshotsAreRecycledOnlyWhenReleased() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache, 1024);
    session.components().registerFactory("test.stepped_current", [](const ComponentParams&) {
        return std::make_unique<SteppedCurrent>();
    });
    const uint32_t stepped = session.addComponent("test.stepped_current", {});

    constexpr int kEvents = 200;
    constexpr int kHeldAt = 10;
    std::shared_ptr<const NodeVoltageSnapshot> held;
    std::optional<double> heldCurrent;
    std::vector<const NodeVoltageSnapshot*> seen;
    int staleReads = 0;
    currentStep.store(0, std::memory_order_relaxed);
    for (int event = 1; event <= kEvents; ++event) {
        session.scheduler().scheduleAt(static_cast<uint64_t>(event), [&, event] {
            // Último snapshot publicado = passo estável depois do evento anterior (o primeiro evento
            // pode chegar antes de qualquer publicação).
            const std::shared_ptr<const NodeVoltageSnapshot> snapshot = session.currentSnapshot();
            if (event > 1 && (!snapshot || stepped >= snapshot->componentCurrents.size() ||
                              snapshot->componentCurrents[stepped] != std::optional<double>(event - 1)))
                ++staleReads;
            if (snapshot && std::find(seen.begin(), seen.end(), snapshot.get()) == seen.end())
                seen.push_back(snapshot.get());
            if (event == kHeldAt) {
                held = snapshot;
                heldCurrent = snapshot->componentCurrents[stepped];
            }
            // Como num componente real, a corrente nova chega pelo solve (o componente fica sujo).
            currentStep.store(event, std::memory_order_relaxed);
            session.scheduler().markDirty(stepped);
        });
    }
    session.scheduler().runUntil(kEvents + 1);

    // Passos sem solve (eventos que não mexem no circuito) não republicam: o snapshot publicado
    // continua o mesmo objeto, com o valor do último solve.
    const std::shared_ptr<const NodeVoltageSnapshot> afterRun = session.currentSnapshot();
    int republished = 0;
    for (int event = kEvents + 2; event <= kEvents + 50; ++event) {
        session.scheduler().scheduleAt(static_cast<uint64_t>(event), [&] {
            if (session.currentSnapshot() != afterRun) ++republished;
        });
    }
    session.scheduler().runUntil(kEvents + 51);
    if (republished != 0 || !afterRun || afterRun->componentCurrents[stepped] != std::optional<double>(kEvents)) {
        std::fprintf(stderr, "FALHOU: %d passos sem solve republicaram o snapshot\n", republished);
        return 1;
    }

    if (staleReads != 0) {
        std::fprintf(stderr, "FALHOU: %d leituras viram um snapshot que nao era o do passo anterior\n", staleReads);
        return 1;
    }
    if (!held || heldCurrent != std::optional<double>(kHeldAt - 1) ||
        held->componentCurrents[stepped] != heldCurrent) {
        std::fprintf(stderr, "FALHOU: snapshot segurado por um leitor foi reescrito\n");
        return 1;
    }
    // Dois se alternam e um terceiro substitui o segurado: alocar a cada passo daria ~kEvents.
    if (seen.size() > 3) {
        std::fprintf(stderr, "FALHOU: %zu snapshots distintos em %d passos (esperado <= 3)\n", seen.size(), kEvents);
        return 1;
    }
    std::printf("Snapshot: %d passos estaveis com %zu snapshots, o segurado intacto\n", kEvents, seen.size());
    return 0;
}

/** Assinantes de larguras diferentes recebem cada um a própria amostra, mesmo com o buffer da
 * sessão compartilhado entre eles. */
int testSubscribersOfDifferentWidthsShareTheSampleBuffer() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache, 1024);
    session.components().registerFactory("test.wide_observer", [](const ComponentParams&) {
        return std::make_unique<WideObserver>();
    });
    session.components().registerFactory("test.narrow_observer", [](const ComponentParams&) {
        return std::make_unique<NarrowObserver>();
    });
    session.addComponent("test.narrow_observer", {});
    session.addComponent("test.wide_observer", {});
    session.addComponent("test.narrow_observer", {});
    wideSamples.store(0, std::memory_order_relaxed);
    wrongSamples.store(0, std::memory_order_relaxed);
    for (uint64_t event = 1; event <= 20; ++event) session.scheduler().scheduleAt(event, [] {});
    session.scheduler().runUntil(21);
    if (wrongSamples.load(std::memory_order_relaxed) != 0 || wideSamples.load(std::memory_order_relaxed) < 20) {
        std::fprintf(stderr, "FALHOU: amostra de assinante errada (%llu erradas, %llu largas)\n",
                     static_cast<unsigned long long>(wrongSamples.load()),
                     static_cast<unsigned long long>(wideSamples.load()));
        return 1;
    }
    std::printf("Assinantes: 1 e 2 canais alternados, %llu amostras largas corretas\n",
                static_cast<unsigned long long>(wideSamples.load()));
    return 0;
}

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

int main() {
    if (const int failed = runTest()) return failed;
    if (const int failed = testPublishedSnapshotsAreRecycledOnlyWhenReleased()) return failed;
    return testSubscribersOfDifferentWidthsShareTheSampleBuffer();
}

#include <chrono>
#include <cstdio>
#include <thread>

#include "components/passive/Capacitor.hpp"
#include "components/sources/Rail.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::session;
using namespace lasecsimul::simulation;

namespace {

int failures = 0;

#define CHECK(expr, message) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); \
            ++failures; \
        } \
    } while (false)

void registerFactories(SimulationSession& session) {
    session.components().registerFactory("sources.rail", [](const ComponentParams& params) {
        return std::make_unique<components::Rail>(Pin{"out"}, params.property("voltage", 0.0));
    });
    session.components().registerFactory("passive.capacitor", [](const ComponentParams& params) {
        return std::make_unique<components::Capacitor>(
            std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}}, params.property("capacitance", 1e-6));
    });
}

void sessionPublishesOnlyAtStoppedBoundaries() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t rail = session.addComponent("sources.rail", {});
    session.addComponent("passive.capacitor", {});
    const auto first = session.simulationPlan();
    CHECK(first && first->generation == 1, "sessao parada publica primeira geracao");
    CHECK(first->execution->activeComponents == std::vector<uint32_t>({0, 1}),
          "ativos sao densos e ordenados");
    CHECK(first->execution->reactiveComponents == std::vector<uint32_t>({1}),
          "reativos sao classificados fora do passo");
    CHECK(session.runtimeState().planGeneration == first->generation,
          "RuntimeState fica vinculado a geracao publicada");

    const auto propertyError = session.setProperty(rail, "voltage", PropertyValue{3.3});
    CHECK(!propertyError, "parametro runtime-safe e aceito");
    const auto afterRuntimeProperty = session.simulationPlan();
    CHECK(afterRuntimeProperty == first, "parametro runtime-safe nao recompila plano");

    session.scheduler().start();
    bool structuralChangeRejected = false;
    try {
        (void)session.addComponent("sources.rail", {});
    } catch (const std::runtime_error&) {
        structuralChangeRejected = true;
    }
    const auto whileRunning = session.simulationPlan();
    CHECK(structuralChangeRejected, "mutacao estrutural durante RUN e rejeitada explicitamente");
    CHECK(whileRunning == first, "RUN nunca troca plano publicado");
    CHECK(session.runtimeState().execution.activeComponents.size() == 2,
          "RuntimeState permanece coerente com o plano publicado");
    CHECK(session.pendingPlanDomains() == PlanDomain::None, "rejeicao nao deixa invalidacao parcial");
    session.scheduler().stop();

    const uint32_t addedWhileStopped = session.addComponent("sources.rail", {});
    const auto second = session.simulationPlan();
    CHECK(addedWhileStopped == 2, "mutacao estrutural volta a ser aceita depois do stop");
    CHECK(second && second->generation == first->generation + 1,
          "proxima fronteira parada publica a pendencia");
    CHECK(second->execution->activeComponents == std::vector<uint32_t>({0, 1, 2}),
          "novo plano contem indices atualizados");
    CHECK(session.runtimeState().planGeneration == second->generation,
          "RuntimeState passa a nova geracao somente apos publicacao");
}

} // namespace

int main() {
    sessionPublishesOnlyAtStoppedBoundaries();
    if (failures == 0) std::printf("SimulationPlan session publication: OK\n");
    return failures == 0 ? 0 : 1;
}

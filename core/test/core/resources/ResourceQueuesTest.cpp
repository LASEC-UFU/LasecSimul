#include <cstdio>
#include <string>

#include "app/CoreApplication.hpp"
#include "ipc/IpcServer.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "resources/ResourceGovernor.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::resources;
using namespace lasecsimul::session;

namespace {

int failures = 0;

#define CHECK(expr, message) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); \
            ++failures; \
        } \
    } while (false)

void commandQueueRejectsOverflowExplicitly() {
    CommandQueue queue(2);
    int applied = 0;
    const auto command = [&applied](SimulationSession&) { ++applied; };

    CHECK(queue.push(command) == CommandQueue::PushResult::First, "primeiro comando marca transicao");
    CHECK(queue.push(command) == CommandQueue::PushResult::Queued, "segundo comando entra em FIFO");
    CHECK(queue.push(command) == CommandQueue::PushResult::Full, "overflow e rejeitado explicitamente");
    CHECK(queue.size() == 2 && queue.capacity() == 2, "fila nunca ultrapassa sua capacidade");

    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    auto commands = queue.takeAll();
    for (auto& queued : commands) queued(session);
    CHECK(applied == 2, "somente comandos aceitos sao executados");
    CHECK(!queue.hasPending(), "drenagem restaura estado vazio");
}

void emptySessionHasNoSolverWorkers() {
    ResourceBudget budget = ResourceGovernor::forProfile(ResourceProfile::SharedHost, 16).budget();
    budget.commandQueueCapacity = 7;
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache, 64, ResourceGovernor(budget));
    CHECK(session.solverWorkerThreadCount() == 0, "sessao vazia nao materializa worker MNA");
    CHECK(session.resourceGovernor().budget().commandQueueCapacity == 7,
          "sessao preserva o ResourceBudget recebido");
}

void notificationQueueIsByteBoundedAndLazy() {
    ipc::IpcServer server("resource-queue-test-unused", 128);
    CHECK(!server.metrics().notificationWorkerStarted, "servidor vazio nao cria worker de notificacao");

    const std::string oversizedPayload = "\"" + std::string(256, 'x') + "\"";
    CHECK(!server.sendNotification("telemetry", oversizedPayload),
          "notificacao maior que o budget e rejeitada");
    CHECK(server.metrics().rejectedNotifications == 1, "rejeicao fica observavel em metrica");
    CHECK(!server.metrics().notificationWorkerStarted, "rejeicao nao materializa worker");

    CHECK(server.sendNotification("telemetry", "{}"), "notificacao dentro do budget e aceita");
    CHECK(server.metrics().notificationWorkerStarted, "primeira notificacao aceita cria worker lazy");
}

void coreProfileIsSelectable() {
    char executable[] = "lasecsimul-core";
    char pipeFlag[] = "--pipe";
    char pipeName[] = "resource-profile-test";
    char profileFlag[] = "--resource-profile";
    char profileName[] = "shared-host";
    char* argv[] = {executable, pipeFlag, pipeName, profileFlag, profileName};
    const app::CoreConfig config = app::parseArgs(5, argv);
    CHECK(config.pipeName == pipeName, "parser preserva nome do pipe");
    CHECK(config.resourceProfile == ResourceProfile::SharedHost,
          "perfil SharedHost chega ao bootstrap do Core");
}

} // namespace

int main() {
    commandQueueRejectsOverflowExplicitly();
    emptySessionHasNoSolverWorkers();
    notificationQueueIsByteBoundedAndLazy();
    coreProfileIsSelectable();
    if (failures == 0) std::printf("ResourceGovernor queues: OK\n");
    return failures == 0 ? 0 : 1;
}

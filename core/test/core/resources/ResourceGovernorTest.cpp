#include <cstdio>
#include <stdexcept>

#include "resources/ResourceGovernor.hpp"

using namespace lasecsimul::resources;

namespace {

int failures = 0;

#define CHECK(expr, message) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); \
            ++failures; \
        } \
    } while (false)

void profileBudgetsAreBounded() {
    const ResourceGovernor single = ResourceGovernor::forProfile(ResourceProfile::Automatic, 1);
    CHECK(single.budget().maxWorkerThreads == 0, "host de um processador nao cria worker");
    CHECK(single.budget().maxParallelTasks == 1, "coordenador executa sozinho em host pequeno");

    const ResourceGovernor desktop = ResourceGovernor::forProfile(ResourceProfile::Desktop, 16);
    CHECK(desktop.budget().maxParallelTasks == 8, "Desktop tem teto por sessao");
    CHECK(desktop.budget().maxWorkerThreads == 7, "workers excluem a thread coordenadora");
    CHECK(desktop.budget().maxParallelTasks < 16, "Desktop nao recebe a maquina inteira");

    const ResourceGovernor shared = ResourceGovernor::forProfile(ResourceProfile::SharedHost, 32);
    CHECK(shared.budget().maxWorkerThreads == 1, "SharedHost concede no maximo um worker");
    CHECK(shared.budget().maxParallelTasks == 2, "SharedHost inclui coordenador mais um worker");
    CHECK(shared.budget().telemetryQueueBytes < desktop.budget().telemetryQueueBytes,
          "SharedHost usa fila de telemetria conservadora");
}

void grantsRespectCostTasksAndBudget() {
    ResourceBudget budget = ResourceGovernor::forProfile(ResourceProfile::Desktop, 8).budget();
    budget.maxWorkerThreads = 3;
    budget.maxParallelTasks = 4;
    const ResourceGovernor governor(budget);

    CHECK(!governor.grantParallelTasks(8, 99, 100).usesWorkers(),
          "trabalho abaixo do limiar permanece serial");
    CHECK(!governor.grantParallelTasks(1, 1000, 100).usesWorkers(),
          "uma unica tarefa permanece serial");

    const ParallelGrant two = governor.grantParallelTasks(2, 1000, 100);
    CHECK(two.parallelTasks == 2 && two.workerThreads == 1,
          "grant nao cria mais workers que tarefas");

    const ParallelGrant many = governor.grantParallelTasks(20, 1000, 100);
    CHECK(many.parallelTasks == 4 && many.workerThreads == 3,
          "grant respeita ambos os tetos do budget");
}

void invalidCustomBudgetsAreRejected() {
    ResourceBudget budget = ResourceGovernor::forProfile(ResourceProfile::SharedHost, 4).budget();
    budget.maxParallelTasks = 0;
    bool rejected = false;
    try {
        (void)ResourceGovernor(budget);
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    CHECK(rejected, "budget sem coordenador e rejeitado");

    rejected = false;
    try {
        (void)ResourceGovernor(ResourceProfile::Custom);
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    CHECK(rejected, "perfil Custom sem budget e rejeitado");
}

} // namespace

int main() {
    profileBudgetsAreBounded();
    grantsRespectCostTasksAndBudget();
    invalidCustomBudgetsAreRejected();
    if (failures == 0) std::printf("ResourceGovernor: OK\n");
    return failures == 0 ? 0 : 1;
}

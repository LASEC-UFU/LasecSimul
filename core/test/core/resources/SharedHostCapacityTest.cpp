#include <cstdio>
#include <set>
#include <stdexcept>
#include <string>

#include "resources/SharedHostCapacity.hpp"

using namespace lasecsimul::resources;

namespace {
int failures = 0;
#define CHECK(expr, message) \
    do { if (!(expr)) { std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); ++failures; } } while (false)

constexpr uint64_t GiB = 1024ull * 1024ull * 1024ull;

SharedHostPolicy capacityHost(size_t maxSessions = 20) {
    return {"lab-win-01", "C:/lasecsimul/shared", 8, 32 * GiB, 4 * GiB,
            1 * GiB, maxSessions, 2, 2};
}

void definedCapacityAndNamespaces() {
    SharedHostCapacity host(capacityHost());
    CHECK(host.capacity() == 20, "cenario documentado deve admitir vinte sessoes");
    std::set<std::string> pipes, arenas, ports, workdirs;
    for (size_t i = 0; i < 20; ++i) {
        const auto lease = host.admit("user-session-" + std::to_string(i));
        pipes.insert(lease.ipcEndpoint);
        arenas.insert(lease.arenaNamespace);
        ports.insert(lease.virtualPortNamespace);
        workdirs.insert(lease.workDir.string());
        CHECK(lease.budget.maxParallelTasks <= 2, "uma sessao SharedHost nao monopoliza CPUs");
        CHECK(lease.budget.maxExternalProcesses <= 2, "processos externos sao limitados por sessao");
    }
    CHECK(pipes.size() == 20 && arenas.size() == 20 && ports.size() == 20 && workdirs.size() == 20,
          "todos os namespaces devem ser unicos em vinte sessoes");
    const auto views = host.snapshot();
    CHECK(views.size() == 20, "snapshot inclui todas as sessoes");
    for (const auto& view : views) {
        CHECK(view.fairShareNumerator == 1 && view.fairShareDenominator == 20,
              "todas as sessoes recebem o mesmo peso de fair-share");
    }

    bool rejected = false;
    try { (void)host.admit("overflow"); } catch (const std::runtime_error&) { rejected = true; }
    CHECK(rejected, "admissao acima da capacidade deve falhar explicitamente");

    for (size_t i = 0; i < 20; ++i) host.release("user-session-" + std::to_string(i));
    CHECK(host.activeSessions() == 0, "release remove todas as sessoes");
}

void buildQueueAndCleanupAudit() {
    SharedHostCapacity host(capacityHost(5));
    host.admit("a"); host.admit("b"); host.admit("c");
    CHECK(host.tryAcquireBuildSlot("a"), "primeiro build entra");
    CHECK(host.tryAcquireBuildSlot("b"), "segundo build entra");
    CHECK(!host.tryAcquireBuildSlot("c"), "terceiro build aguarda a fila limitada");
    host.releaseBuildSlot("a");
    CHECK(host.tryAcquireBuildSlot("c"), "slot liberado pode ser reutilizado");

    host.release("b", {2, 1, {"worker PLC nao respondeu ao encerramento"}});
    const auto audit = host.cleanupFailures();
    CHECK(audit.size() == 1 && audit[0].sessionId == "b", "falha de cleanup fica auditavel");
    host.release("a", {1, 1, {}});
    host.release("c", {0, 0, {}});
}

void invalidAndDuplicateAdmission() {
    bool rejected = false;
    try {
        auto invalid = capacityHost();
        invalid.perSessionResidentBytes = 0;
        (void)SharedHostCapacity(invalid);
    } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "perfil administrativo invalido e rejeitado");

    SharedHostCapacity memoryBound({"small", "C:/lasecsimul/small", 4, 3 * GiB, 1 * GiB,
                                    1 * GiB, 20, 1, 1});
    CHECK(memoryBound.capacity() == 2, "memoria reduz capacidade administrativa");
    memoryBound.admit("same");
    rejected = false;
    try { (void)memoryBound.admit("same"); } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "sessionId duplicado e rejeitado antes de colidir namespace");
}
} // namespace

int main() {
    definedCapacityAndNamespaces();
    buildQueueAndCleanupAudit();
    invalidAndDuplicateAdmission();
    if (failures == 0) std::printf("SharedHost capacity/fair-share/namespace/cleanup: OK\n");
    return failures == 0 ? 0 : 1;
}

#include <cmath>
#include <cstdio>
#include <utility>
#include <vector>

#include "resources/ResourceGovernor.hpp"
#include "simulation/MnaSolver.hpp"
#include "simulation/ThreadPool.hpp"

using namespace lasecsimul::resources;
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

ResourceGovernor fixedParallelism(size_t parallelTasks) {
    ResourceBudget budget = ResourceGovernor::forProfile(ResourceProfile::Desktop, 8).budget();
    budget.maxWorkerThreads = parallelTasks - 1;
    budget.maxParallelTasks = parallelTasks;
    return ResourceGovernor(budget);
}

void poolIsLazyAndGrowsWithinGrant() {
    ThreadPool pool(3);
    CHECK(pool.workerThreadCount() == 0, "pool vazio nao cria worker");

    std::vector<size_t> values(8, 0);
    pool.parallelFor(values.size(), 2, [&](size_t index) { values[index] = index + 1; });
    CHECK(pool.workerThreadCount() == 1, "grant de duas tarefas cria somente um worker");
    for (size_t i = 0; i < values.size(); ++i) CHECK(values[i] == i + 1, "cada indice executa uma vez");

    pool.parallelFor(values.size(), 4, [&](size_t index) { values[index] *= 2; });
    CHECK(pool.workerThreadCount() == 3, "pool cresce ate o grant sem exceder budget");
    CHECK(pool.maxThreadCount() == 4, "coordenador esta incluido no paralelismo maximo");
}

std::vector<CircuitGroup> makeGroups() {
    std::vector<CircuitGroup> groups;
    uint32_t globalNode = 0;
    for (size_t groupIndex = 0; groupIndex < 4; ++groupIndex) {
        std::vector<uint32_t> nodes(64);
        for (uint32_t& node : nodes) node = globalNode++;
        groups.emplace_back(std::move(nodes));
        auto& matrix = groups.back().admittance();
        for (size_t i = 0; i < 64; ++i) {
            matrix(i, i) = 4.0;
            if (i != 0) matrix(i, i - 1) = -1.0;
            if (i + 1 != 64) matrix(i, i + 1) = -1.0;
            groups.back().rhs()(i) = static_cast<double>(groupIndex + 1);
        }
    }
    return groups;
}

std::vector<double> solveWith(size_t parallelTasks, size_t& workersBefore, size_t& workersAfter) {
    MnaSolver solver(fixedParallelism(parallelTasks));
    workersBefore = solver.workerThreadCount();
    auto groups = makeGroups();
    std::vector<double> voltages(4 * 64, 0.0);
    solver.solve(groups, voltages);
    workersAfter = solver.workerThreadCount();
    return voltages;
}

void solverIsDeterministicForOneTwoAndN() {
    size_t before1, after1, before2, after2, before4, after4;
    const auto serial = solveWith(1, before1, after1);
    const auto two = solveWith(2, before2, after2);
    const auto four = solveWith(4, before4, after4);

    CHECK(before1 == 0 && before2 == 0 && before4 == 0,
          "solvers nao criam workers antes do primeiro lote caro");
    CHECK(after1 == 0 && after2 == 1 && after4 == 3,
          "materializacao respeita budgets 1/2/N");
    CHECK(serial.size() == two.size() && serial.size() == four.size(), "resultados tem mesmo tamanho");
    for (size_t i = 0; i < serial.size(); ++i) {
        CHECK(std::abs(serial[i] - two[i]) < 1e-12, "resultado com dois participantes e deterministico");
        CHECK(std::abs(serial[i] - four[i]) < 1e-12, "resultado com N participantes e deterministico");
    }
}

} // namespace

int main() {
    poolIsLazyAndGrowsWithinGrant();
    solverIsDeterministicForOneTwoAndN();
    if (failures == 0) std::printf("ResourceGovernor worker pool: OK\n");
    return failures == 0 ? 0 : 1;
}

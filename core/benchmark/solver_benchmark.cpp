#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>
#include <unordered_map>
#include <vector>
#include "simulation/ComponentMatrixView.hpp"
#include "simulation/MnaSolver.hpp"

using namespace lasecsimul;
using namespace lasecsimul::simulation;
using Clock = std::chrono::steady_clock;

static double milliseconds(Clock::time_point a, Clock::time_point b) {
    return std::chrono::duration<double, std::milli>(b - a).count();
}

static double benchmarkDenseStamp(size_t matrixSize, size_t iterations) {
    CircuitGroup group{std::vector<uint32_t>(matrixSize)};
    const auto begin = Clock::now();
    for (size_t n = 0; n < iterations; ++n) {
        Eigen::MatrixXd matrix = Eigen::MatrixXd::Zero(matrixSize, matrixSize);
        Eigen::VectorXd rhs = Eigen::VectorXd::Zero(matrixSize);
        const double g = 0.001 + static_cast<double>(n & 1) * 1e-9;
        matrix(0, 0) += g; matrix(1, 1) += g; matrix(0, 1) -= g; matrix(1, 0) -= g;
        rhs(0) -= 1e-3; rhs(1) += 1e-3;
        group.replaceStamp(7, matrix, rhs);
    }
    return milliseconds(begin, Clock::now());
}

static double benchmarkSparseStamp(size_t matrixSize, size_t iterations) {
    CircuitGroup group{std::vector<uint32_t>(matrixSize)};
    std::unordered_map<std::string, uint32_t> pins{{"p", 0}, {"n", 1}};
    const Pin p{"p"}, n{"n"};
    const auto begin = Clock::now();
    for (size_t i = 0; i < iterations; ++i) {
        ComponentMatrixView view(group, pins, 7u);
        view.addConductance(p, n, 0.001 + static_cast<double>(i & 1) * 1e-9);
        view.addCurrent(p, n, 1e-3);
        view.commit();
    }
    return milliseconds(begin, Clock::now());
}

static std::vector<CircuitGroup> makeGroups(size_t groupCount, size_t size) {
    std::vector<CircuitGroup> groups;
    groups.reserve(groupCount);
    uint32_t global = 0;
    for (size_t g = 0; g < groupCount; ++g) {
        std::vector<uint32_t> nodes(size);
        for (uint32_t& node : nodes) node = global++;
        groups.emplace_back(std::move(nodes));
        Eigen::MatrixXd& a = groups.back().admittance();
        for (size_t i = 0; i < size; ++i) {
            a(i, i) = 4.0;
            if (i > 0) a(i, i - 1) = -1.0;
            if (i + 1 < size) a(i, i + 1) = -1.0;
            groups.back().rhs()(i) = 1.0;
        }
    }
    return groups;
}

static double benchmarkSolver(size_t threads, size_t groupCount, size_t size, size_t iterations, double& checksum) {
    auto groups = makeGroups(groupCount, size);
    std::vector<double> voltages(groupCount * size);
    MnaSolver solver(threads);
    solver.solve(groups, voltages); // warmup + factoracao
    const auto begin = Clock::now();
    for (size_t n = 0; n < iterations; ++n) {
        for (CircuitGroup& group : groups) group.rhs()(0) += 1e-12;
        solver.solve(groups, voltages);
    }
    const double elapsed = milliseconds(begin, Clock::now());
    checksum = 0.0;
    for (double value : voltages) checksum += value;
    return elapsed;
}

static double benchmarkRefactor(size_t threads, size_t groupCount, size_t size, size_t iterations, double& checksum) {
    auto groups = makeGroups(groupCount, size);
    std::vector<double> voltages(groupCount * size);
    MnaSolver solver(threads);
    const auto begin = Clock::now();
    for (size_t n = 0; n < iterations; ++n) {
        for (CircuitGroup& group : groups) group.admittance()(0, 0) += 1e-10;
        solver.solve(groups, voltages);
    }
    const double elapsed = milliseconds(begin, Clock::now());
    checksum = 0.0; for (double value : voltages) checksum += value;
    return elapsed;
}

static double benchmarkLegacyDenseFactor(size_t size, size_t iterations, double& checksum) {
    Eigen::MatrixXd a = Eigen::MatrixXd::Zero(size, size);
    Eigen::VectorXd rhs = Eigen::VectorXd::Ones(size), result(size);
    for (size_t i=0;i<size;++i){ a(i,i)=4; if(i)a(i,i-1)=-1; if(i+1<size)a(i,i+1)=-1; }
    const auto begin=Clock::now();
    for(size_t n=0;n<iterations;++n){ a(0,0)+=1e-10; Eigen::PartialPivLU<Eigen::MatrixXd> lu(a); result=lu.solve(rhs); }
    checksum=result.sum(); return milliseconds(begin,Clock::now());
}

int main() {
    constexpr size_t stampSize = 256, stampIterations = 2000;
    const double dense = benchmarkDenseStamp(stampSize, stampIterations);
    const double sparse = benchmarkSparseStamp(stampSize, stampIterations);
    std::printf("STAMP matrix=%zu iterations=%zu dense_ms=%.3f sparse_ms=%.3f speedup=%.2fx\n",
                stampSize, stampIterations, dense, sparse, dense / sparse);

    constexpr size_t groups = 32, size = 48, iterations = 300;
    double serialChecksum = 0.0, parallelChecksum = 0.0;
    const double serial = benchmarkSolver(1, groups, size, iterations, serialChecksum);
    const double parallel = benchmarkSolver(0, groups, size, iterations, parallelChecksum);
    std::printf("SOLVER groups=%zu size=%zu iterations=%zu serial_ms=%.3f pool_ms=%.3f speedup=%.2fx checksum_diff=%.3g\n",
                groups, size, iterations, serial, parallel, serial / parallel,
                std::abs(serialChecksum - parallelChecksum));
    double serialFactorChecksum = 0.0, parallelFactorChecksum = 0.0;
    const double serialFactor = benchmarkRefactor(1, 8, 256, 20, serialFactorChecksum);
    const double parallelFactor = benchmarkRefactor(0, 8, 256, 20, parallelFactorChecksum);
    std::printf("REFACTOR groups=8 size=256 iterations=20 serial_ms=%.3f pool_ms=%.3f speedup=%.2fx checksum_diff=%.3g\n",
                serialFactor, parallelFactor, serialFactor / parallelFactor,
                std::abs(serialFactorChecksum - parallelFactorChecksum));
    double denseLargeChecksum=0, sparseLargeChecksum=0;
    const double denseLarge=benchmarkLegacyDenseFactor(256,20,denseLargeChecksum);
    const double sparseLarge=benchmarkRefactor(1,1,256,20,sparseLargeChecksum);
    std::printf("LARGE_FACTOR size=256 iterations=20 dense_ms=%.3f sparse_ms=%.3f speedup=%.2fx checksum_diff=%.3g\n",
                denseLarge,sparseLarge,denseLarge/sparseLarge,std::abs(denseLargeChecksum-sparseLargeChecksum));
    return std::abs(serialChecksum - parallelChecksum) < 1e-9 ? 0 : 1;
}

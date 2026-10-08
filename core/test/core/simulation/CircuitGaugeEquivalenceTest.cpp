// CircuitGroup::applyFloatingGauge() replaced a row-wise breadth-first search
// that ran on every factor() (every admittance change: each GPIO/I2C edge that
// changes a conductance). This test keeps that former implementation as the
// reference and requires the new one to produce the very same scaled matrix on
// thousands of random circuits: grounded and floating blocks, voltage-source
// branch rows, unconnected pins, injected currents. It also times both.

#include "simulation/CircuitGroup.hpp"

#include <Eigen/Dense>

#include <chrono>
#include <cstdio>
#include <random>
#include <vector>

using lasecsimul::simulation::CircuitGroup;

namespace {

int failures = 0;
void check(bool condition, const char* message) {
    if (!condition) { std::fprintf(stderr, "FAIL: %s\n", message); ++failures; }
}

/** The pre-optimization code of CircuitGroup::factor(), verbatim in behavior. */
void referenceGauge(const Eigen::MatrixXd& admittance, const Eigen::VectorXd& rhs, Eigen::Index nodeCount, Eigen::MatrixXd& scaled) {
    const Eigen::Index n = admittance.rows();
    std::vector<bool> visited(static_cast<size_t>(n), false);
    for (Eigen::Index root = 0; root < n; ++root) {
        if (visited[static_cast<size_t>(root)]) continue;
        std::vector<Eigen::Index> block{root};
        visited[static_cast<size_t>(root)] = true;
        for (size_t head = 0; head < block.size(); ++head) {
            const Eigen::Index row = block[head];
            for (Eigen::Index column = 0; column < n; ++column) {
                if (visited[static_cast<size_t>(column)] ||
                    (admittance(row, column) == 0.0 && admittance(column, row) == 0.0)) continue;
                visited[static_cast<size_t>(column)] = true;
                block.push_back(column);
            }
        }
        std::vector<Eigen::Index> nodes;
        for (const Eigen::Index index : block) if (index < nodeCount) nodes.push_back(index);
        if (block.size() == 1 && nodes.size() == 1 && admittance.row(root).cwiseAbs().sum() == 0.0 && rhs(root) == 0.0) {
            scaled(root, root) = 1.0;
            continue;
        }
        if (nodes.size() < 2) continue;
        bool floatingGauge = true;
        for (const Eigen::Index row : block) {
            double sum = 0.0, magnitude = 0.0;
            for (const Eigen::Index column : nodes) {
                const double value = admittance(row, column);
                sum += value;
                magnitude += std::abs(value);
            }
            if (magnitude == 0.0 || std::abs(sum) > magnitude * 1e-12) { floatingGauge = false; break; }
        }
        if (floatingGauge) scaled(nodes.front(), nodes.front()) += 1.0;
    }
}

/** Random MNA-like system: conductances between random node pairs (small
 * integers so every sum is exact), some to ground, some voltage sources (an
 * extra row/column with +-1), unconnected nodes and injected currents. */
void randomCircuit(std::mt19937& rng, Eigen::Index nodes, Eigen::Index extras, Eigen::MatrixXd& a, Eigen::VectorXd& b) {
    const Eigen::Index n = nodes + extras;
    a = Eigen::MatrixXd::Zero(n, n);
    b = Eigen::VectorXd::Zero(n);
    std::uniform_int_distribution<int> pick(0, static_cast<int>(nodes) - 1), g(1, 8), coin(0, 99);
    const int edges = static_cast<int>(nodes) * (coin(rng) % 3);
    for (int e = 0; e < edges; ++e) {
        const Eigen::Index i = pick(rng), j = pick(rng);
        const double value = g(rng);
        if (i == j) { a(i, i) += value; continue; } // conductance to ground
        a(i, i) += value; a(j, j) += value; a(i, j) -= value; a(j, i) -= value;
    }
    for (Eigen::Index k = 0; k < extras; ++k) {
        const Eigen::Index row = nodes + k, i = pick(rng), j = pick(rng);
        a(row, i) += 1.0; a(i, row) += 1.0;
        if (coin(rng) < 70 && j != i) { a(row, j) -= 1.0; a(j, row) -= 1.0; } // else a source to ground
        b(row) = g(rng);
    }
    for (Eigen::Index i = 0; i < nodes; ++i) if (coin(rng) < 5) b(i) = g(rng);
}

} // namespace

int main() {
    std::mt19937 rng(20261007);
    CircuitGroup::GaugeWorkspace workspace;
    int cases = 0, floatingSeen = 0, unconnectedSeen = 0;
    for (int trial = 0; trial < 4000; ++trial) {
        const Eigen::Index nodes = 1 + static_cast<Eigen::Index>(rng() % 40);
        const Eigen::Index extras = static_cast<Eigen::Index>(rng() % 4);
        Eigen::MatrixXd a; Eigen::VectorXd b;
        randomCircuit(rng, nodes, extras, a, b);
        Eigen::MatrixXd expected = a, actual = a;
        referenceGauge(a, b, nodes, expected);
        CircuitGroup::applyFloatingGauge(a, b, nodes, actual, workspace);
        if ((expected - a).cwiseAbs().maxCoeff() > 0.0) {
            for (Eigen::Index i = 0; i < a.rows(); ++i) {
                if (expected(i, i) == 1.0 && a(i, i) == 0.0) ++unconnectedSeen;
                else if (expected(i, i) != a(i, i)) ++floatingSeen;
            }
        }
        ++cases;
        if (!(expected == actual)) {
            std::fprintf(stderr, "mismatch on trial %d (nodes %lld extras %lld)\n", trial,
                         static_cast<long long>(nodes), static_cast<long long>(extras));
            check(false, "G1 new gauge differs from the reference");
            break;
        }
    }
    std::printf("gauge equivalence: %d circuits, %d floating references, %d unconnected pins\n", cases, floatingSeen, unconnectedSeen);
    check(floatingSeen > 50 && unconnectedSeen > 50, "G2 the random circuits exercise both rules");

    // Timing on a board-sized group (ESP32 DevKit: ~40 pins, most unconnected).
    Eigen::MatrixXd a; Eigen::VectorXd b;
    randomCircuit(rng, 60, 3, a, b);
    Eigen::MatrixXd out = a;
    constexpr int kRuns = 20000;
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < kRuns; ++i) { out = a; referenceGauge(a, b, 60, out); }
    const auto t1 = std::chrono::steady_clock::now();
    for (int i = 0; i < kRuns; ++i) { out = a; CircuitGroup::applyFloatingGauge(a, b, 60, out, workspace); }
    const auto t2 = std::chrono::steady_clock::now();
    const double oldUs = std::chrono::duration<double, std::micro>(t1 - t0).count() / kRuns;
    const double newUs = std::chrono::duration<double, std::micro>(t2 - t1).count() / kRuns;
    std::printf("gauge per factor(), 63x63: reference %.2f us, new %.2f us\n", oldUs, newUs);

    std::printf("circuit_gauge_equivalence: %s\n", failures ? "FAIL" : "PASS");
    return failures ? 1 : 0;
}

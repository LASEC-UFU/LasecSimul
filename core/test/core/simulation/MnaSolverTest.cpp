#include <cmath>
#include <cstdio>
#include <string>
#include <unordered_map>
#include <vector>
#include "simulation/ComponentMatrixView.hpp"
#include "simulation/MnaSolver.hpp"

using namespace lasecsimul;
using namespace lasecsimul::simulation;

namespace {

bool nearlyEqual(double a, double b, double eps = 1e-5) { return std::abs(a - b) < eps; }

void stampGroundedSource(CircuitGroup& group, uint32_t sourceOwner, uint32_t groundOwner, double voltage) {
    const std::unordered_map<std::string, uint32_t> sourceMap{{"p", 0}, {"n", 1}};
    const std::unordered_map<std::string, uint32_t> groundMap{{"pin", 1}};

    ComponentMatrixView source(group, sourceMap, sourceOwner, static_cast<uint32_t>(group.size()));
    source.addVoltageSource(Pin{"p"}, Pin{"n"}, voltage);
    source.commit();

    ComponentMatrixView ground(group, groundMap, groundOwner);
    ground.addConductanceToGround(Pin{"pin"}, 1e9);
    ground.commit();
}

} // namespace

int main() {
    MnaSolver solver;

    std::vector<CircuitGroup> groups;
    groups.emplace_back(std::vector<uint32_t>{0, 1}, 1);
    groups.emplace_back(std::vector<uint32_t>{2, 3}, 1);

    stampGroundedSource(groups[0], 10, 11, 5.0);
    stampGroundedSource(groups[1], 20, 21, 3.0);

    std::vector<double> nodeVoltages(4, 0.0);
    solver.solve(groups, nodeVoltages);

    if (!nearlyEqual(nodeVoltages[0], 5.0) || !nearlyEqual(nodeVoltages[1], 0.0, 1e-6) ||
        !nearlyEqual(nodeVoltages[2], 3.0) || !nearlyEqual(nodeVoltages[3], 0.0, 1e-6)) {
        std::fprintf(stderr, "FALHOU: grupos independentes resolveram %.6f %.6f %.6f %.6f\n",
                     nodeVoltages[0], nodeVoltages[1], nodeVoltages[2], nodeVoltages[3]);
        return 1;
    }

    std::vector<CircuitGroup> singularGroups;
    singularGroups.emplace_back(std::vector<uint32_t>{0});
    std::vector<double> singularVoltages(1, 123.0);
    solver.solve(singularGroups, singularVoltages);

    if (singularGroups[0].singular() || !std::isfinite(singularVoltages[0]) || singularVoltages[0] != 0.0) {
        std::fprintf(stderr, "FALHOU: no isolado deveria assumir 0 V, deu %.6f\n",
                     singularVoltages[0]);
        return 1;
    }
    std::vector<CircuitGroup> invalidGroups;
    invalidGroups.emplace_back(std::vector<uint32_t>{0});
    invalidGroups[0].rhs()(0) = 1.0; // current injected without a return path
    std::vector<double> invalidVoltages(1, 123.0);
    solver.solve(invalidGroups, invalidVoltages);
    if (!invalidGroups[0].singular() || invalidVoltages[0] != 0.0) {
        std::fprintf(stderr, "FALHOU: corrente sem retorno deve permanecer singular\n");
        return 1;
    }

    // A source and load form a valid loop even without an explicit Ground.
    std::vector<CircuitGroup> floatingGroups;
    floatingGroups.emplace_back(std::vector<uint32_t>{0, 1}, 1);
    const std::unordered_map<std::string, uint32_t> floatingPins{{"p", 0}, {"n", 1}};
    {
        ComponentMatrixView source(floatingGroups[0], floatingPins, 30, 2);
        source.addVoltageSource(Pin{"p"}, Pin{"n"}, 24.0);
        source.commit();
        ComponentMatrixView load(floatingGroups[0], floatingPins, 31);
        load.addConductance(Pin{"p"}, Pin{"n"}, 1.0 / 1200.0);
        load.commit();
    }
    std::vector<double> floatingVoltages(2, 0.0);
    solver.solve(floatingGroups, floatingVoltages);
    if (floatingGroups[0].singular() || !nearlyEqual(floatingVoltages[0] - floatingVoltages[1], 24.0)) {
        std::fprintf(stderr, "FALHOU: loop flutuante de 24 V nao resolveu, deu %.6f %.6f\n",
                     floatingVoltages[0], floatingVoltages[1]);
        return 1;
    }

    std::printf("OK: MnaSolver resolve multiplos grupos e bloqueia matriz singular.\n");
    return 0;
}

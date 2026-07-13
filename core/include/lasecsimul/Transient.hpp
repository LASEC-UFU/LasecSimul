#pragma once
#include <cstdint>

namespace lasecsimul {

enum class IntegrationMethod : uint8_t { BackwardEuler, Trapezoidal, Gear2, Automatic };

struct TransientStepContext {
    uint64_t timeNs = 0;
    uint64_t deltaNs = 0;
    IntegrationMethod method = IntegrationMethod::Trapezoidal;
    uint64_t acceptedStepIndex = 0;

    double deltaSeconds() const { return static_cast<double>(deltaNs) * 1e-9; }
};

struct TransientSettings {
    IntegrationMethod method = IntegrationMethod::Automatic;
    uint64_t initialStepNs = 100;
    uint64_t minimumStepNs = 1;
    uint64_t maximumStepNs = 100'000;
    double relativeTolerance = 1e-4;
    double absoluteTolerance = 1e-9;
    uint32_t maximumNewtonIterations = 20;
    bool adaptiveTimeStep = true;
};

} // namespace lasecsimul

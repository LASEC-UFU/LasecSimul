#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace lasecsimul::simulation {

enum class SignalScalarType : uint8_t { Real, Bool, Int64 };

struct SignalDataType {
    SignalScalarType scalar = SignalScalarType::Real;
    uint16_t width = 1;
    bool operator==(const SignalDataType&) const = default;
};

struct SignalPortDefinition {
    std::string id;
    SignalDataType type;
    std::string unit;
};

struct SignalRate {
    uint64_t periodNs = 1;
    uint64_t offsetNs = 0;
    uint16_t phase = 0;
    bool operator==(const SignalRate&) const = default;
};

enum class SignalBlockKind : uint8_t {
    Source,
    Gain,
    Sum,
    Product,
    Limiter,
    Selector,
    Probe,
    CalcExpression,
    Integrator,
    FilteredDerivative,
    UnitDelay,
    DeadTime,
    FirstOrder,
    SecondOrder,
    LeadLag,
    Fopdt,
    Tank,
    ValveCharacteristic,
    Saturation,
    Deadband,
    Hysteresis,
    Stiction,
    RateLimiter,
};

enum class AlgebraicLoopPolicy : uint8_t { Reject, FixedPoint };

/** Authoring model. Strings and variable-size collections exist only on the cold path. */
struct SignalBlockDefinition {
    std::string id;
    SignalBlockKind kind = SignalBlockKind::Source;
    std::vector<SignalPortDefinition> inputs;
    SignalPortDefinition output{"out", {SignalScalarType::Real, 1}, ""};
    SignalRate rate;
    AlgebraicLoopPolicy loopPolicy = AlgebraicLoopPolicy::Reject;
    uint32_t maxIterations = 32;
    double tolerance = 1e-9;
    std::vector<double> realParameters;
    std::vector<int64_t> intParameters;
    std::vector<uint8_t> boolParameters;
    std::string expression;
    /** Ring capacity for DeadTime/Fopdt input changes; allocated once by bind(). */
    uint32_t historyCapacity = 1024;
};

struct SignalConnectionDefinition {
    std::string sourceBlock;
    std::string sourcePort = "out";
    std::string targetBlock;
    std::string targetPort;
    /** Conversions are never implicit. Differing compatible units require this flag. */
    bool allowUnitConversion = false;
};

struct SignalGraphDefinition {
    std::vector<SignalBlockDefinition> blocks;
    std::vector<SignalConnectionDefinition> connections;
    uint16_t maxVectorWidth = 64;
    uint32_t maxMicrosteps = 1024;
};

struct SignalSlotHandle {
    SignalScalarType scalar = SignalScalarType::Real;
    uint32_t offset = 0;
    uint16_t width = 1;
    bool operator==(const SignalSlotHandle&) const = default;
};

struct SignalRuntimeMetrics {
    uint64_t rateGroupActivations = 0;
    uint64_t blockEvaluations = 0;
    uint64_t microsteps = 0;
    uint64_t algebraicIterations = 0;
    uint64_t nonConvergentLoops = 0;
    uint64_t acceptedDynamicSteps = 0;
    uint64_t rejectedDynamicSteps = 0;
    uint64_t discontinuityEvents = 0;
    uint64_t delayHistoryDrops = 0;
    uint64_t lastAcceptedDynamicStepNs = 0;
    double lastDynamicErrorRatio = 0.0;
};

class CompiledSignalGraph;

class SignalCompiler {
public:
    static std::shared_ptr<const CompiledSignalGraph> compile(const SignalGraphDefinition& definition);
};

/** Mutable dense state. bind() performs all allocations; executeUntil() allocates nothing. */
class SignalRuntime {
public:
    void bind(std::shared_ptr<const CompiledSignalGraph> graph);
    void reset();
    void setTimeBase(uint64_t timestampNs);
    void executeUntil(uint64_t timestampNs);
    /** Two-phase continuous step. Candidate state is invisible until commitContinuousStep(). */
    void beginContinuousStep(uint64_t previousNs, uint64_t currentNs);
    double continuousErrorRatio(double absoluteTolerance, double relativeTolerance);
    void commitContinuousStep();
    void rollbackContinuousStep();
    std::optional<uint64_t> nextEventNs() const;
    void noteExplicitBoundary(uint64_t timestampNs);
    void resetMetrics() { m_metrics = {}; }

    const std::shared_ptr<const CompiledSignalGraph>& graph() const { return m_graph; }
    const SignalRuntimeMetrics& metrics() const { return m_metrics; }
    SignalSlotHandle output(std::string_view blockId) const;
    double real(SignalSlotHandle slot, uint16_t element = 0) const;
    bool boolean(SignalSlotHandle slot, uint16_t element = 0) const;
    int64_t integer(SignalSlotHandle slot, uint16_t element = 0) const;

    /** Used by tests/diagnostics to prove storage remains stable during steady-state execution. */
    const void* realStorageAddress() const { return m_reals.data(); }
    const void* boolStorageAddress() const { return m_bools.data(); }
    const void* integerStorageAddress() const { return m_ints.data(); }
    const void* dynamicStorageAddress() const { return m_dynamicState.data(); }

private:
    struct DelayBuffer {
        std::vector<uint64_t> times;
        std::vector<double> values;
        uint32_t head = 0;
        uint32_t count = 0;
        uint16_t width = 1;
    };

    void activateGroup(uint32_t groupIndex, uint64_t timestampNs);

    std::shared_ptr<const CompiledSignalGraph> m_graph;
    std::vector<double> m_reals;
    std::vector<double> m_realSnapshot;
    std::vector<double> m_realCandidate;
    std::vector<int64_t> m_ints;
    std::vector<int64_t> m_intSnapshot;
    std::vector<int64_t> m_intCandidate;
    std::vector<uint8_t> m_bools;
    std::vector<uint8_t> m_boolSnapshot;
    std::vector<uint8_t> m_boolCandidate;
    std::vector<double> m_expressionStack;
    std::vector<uint64_t> m_nextActivationNs;
    std::vector<double> m_dynamicState;
    std::vector<double> m_dynamicCandidate;
    std::vector<double> m_dynamicFullStep;
    std::vector<double> m_dynamicOutputCandidate;
    std::vector<DelayBuffer> m_delayBuffers;
    uint64_t m_dynamicTimeNs = 0;
    uint64_t m_lastExecutionNs = 0;
    uint64_t m_pendingDynamicTimeNs = 0;
    uint64_t m_pendingDynamicStepNs = 0;
    bool m_dynamicStepPending = false;
    double m_pendingDynamicErrorRatio = 0.0;
    SignalRuntimeMetrics m_metrics;
};

} // namespace lasecsimul::simulation

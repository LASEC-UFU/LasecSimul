#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "library/Kernel.hpp"

namespace lasecsimul::simulation {

/** Período usado para tempo de amostragem constante (`inf` no Simulink): o grupo ativa uma vez e só
 * volta a executar quando um parâmetro ajustável de um de seus blocos muda (docs/66 §4.1). */
inline constexpr uint64_t kConstantSamplePeriodNs = 1ull << 62;

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
    /** 0 = tempo contínuo (só blocos `Kernel`): o bloco entra na partição contínua acoplada e é
     * avaliado nos estágios do integrador e em todo passo maior (docs/66 §4.2). */
    uint64_t periodNs = 1;
    uint64_t offsetNs = 0;
    uint16_t phase = 0;
    bool continuous() const noexcept { return periodNs == 0; }
    bool operator==(const SignalRate&) const = default;
};

enum class SignalBlockKind : uint8_t {
    Source,
    ExternalInput,
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
    /** Causal discrete-time transfer function in descending powers of z, clocked by its RateGroup. */
    DiscreteTransferFunction,
    /** SISO realization with real A/B/C/D parameters; parameters are row-major A, B, C, D. */
    StateSpaceContinuous,
    StateSpaceDiscrete,
    DeadTime,
    FirstOrder,
    SecondOrder,
    LeadLag,
    Fopdt,
    /** Estoque conservativo (ADR 0013): saída vetorial [x, inActual, outActual, overflow, unmet,
     * cumIn, cumOut, cumOverflow, cumUnmet, cumSpill, upperContactTime, lowerContactTime, +5
     * compensações internas]; entradas in, outflow e, opcionais, lower/upper (amostradas: o estado é
     * projetado nelas na própria ativação). */
    Accumulator,
    ValveCharacteristic,
    Saturation,
    Deadband,
    Hysteresis,
    Stiction,
    RateLimiter,
    Pid,
    /** Extrai o elemento `realParameters[0]` de um vetor Real (portas nomeadas do Accumulator). */
    Element,
    /** Bloco da biblioteca equivalente ao Simulink: comportamento dado pelo kernel `kernel`
     * (`simulation/library/Kernel.hpp`), com estados contínuos, discretos e direct feedthrough
     * declarados pelo próprio kernel (docs/66 §4). */
    Kernel,
};

/** Posições do vetor de saída/estado do Accumulator (as 12 primeiras têm porta nomeada). */
enum AccumulatorElement : uint16_t {
    AccumulatorState = 0,
    AccumulatorInActual,
    AccumulatorOutActual,
    AccumulatorOverflow,
    AccumulatorUnmet,
    AccumulatorCumIn,
    AccumulatorCumOut,
    AccumulatorCumOverflow,
    AccumulatorCumUnmet,
    /** Volume que saiu (ou entrou, se negativo) porque uma fronteira se moveu para dentro do estado. */
    AccumulatorCumSpill,
    /** Instante exato (s) do último contato com o topo / o fundo vindo de dentro; -1 = nunca. */
    AccumulatorUpperContactTime,
    AccumulatorLowerContactTime,
    /** Compensações de Neumaier (internas, sem porta): o balanço fecha em ~1e-15 relativo mesmo com
     * centenas de milhares de passos de 100 µs. */
    AccumulatorCompState,
    AccumulatorCompCumIn,
    AccumulatorCompCumOut,
    AccumulatorCompCumOverflow,
    AccumulatorCompCumUnmet,
    AccumulatorWidth,
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
    /** Id do kernel quando `kind == Kernel`. */
    std::string kernel;
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
    static SignalSlotHandle output(const std::shared_ptr<const CompiledSignalGraph>& graph, std::string_view blockId);
    static SignalPortDefinition outputDefinition(const std::shared_ptr<const CompiledSignalGraph>& graph,
                                                 std::string_view blockId);
    static bool isExternalInput(const std::shared_ptr<const CompiledSignalGraph>& graph, std::string_view blockId);
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
    void setExternalReal(std::string_view blockId, double value, uint16_t element = 0);
    void setExternalBool(std::string_view blockId, bool value, uint16_t element = 0);
    /** Parâmetro ajustável (tunable) de um bloco `Kernel` com a simulação rodando: troca os valores
     * reais SEM recompilar o plano; a quantidade precisa ser a mesma (mudança de forma exige
     * recompilação, como no Simulink). Blocos de tempo constante são reavaliados no próximo instante. */
    void setKernelParameters(std::string_view blockId, std::span<const double> values);
    /** Valores atuais dos parâmetros reais de um bloco `Kernel` (testes/diagnóstico). */
    std::span<const double> kernelParameters(std::string_view blockId) const;
    /** Parâmetros inteiros (forma) do bloco `Kernel` compilado: fixos até a próxima recompilação. */
    std::span<const int64_t> kernelIntParameters(std::string_view blockId) const;

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

    void activateBatch(uint64_t timestampNs);
    library::KernelContext kernelContext(uint32_t blockIndex, uint64_t timestampNs, bool major, std::vector<double>& reals,
                                         double* states);
    /** Saída de um bloco Kernel. `reals` é de onde as entradas são lidas e onde a saída é escrita
     * (`m_reals` nos passos maiores, `m_stageReals` nos estágios do integrador); `states` é o vetor de
     * estados contínuos do estágio. */
    void runKernelOutputs(uint32_t blockIndex, uint64_t timestampNs, bool major, std::vector<double>& reals, double* states);
    void runKernelUpdate(uint32_t blockIndex, uint64_t timestampNs);
    /** Avalia a partição contínua no instante do estágio (saídas em ordem) e, com `derivatives`,
     * escreve as derivadas em `derivatives` (mesmo layout do vetor de estados). */
    void evaluateContinuousPartition(uint64_t timestampNs, double* states, double* derivatives);
    void integrateContinuousPartition(uint64_t previousNs, uint64_t currentNs);
    void continuousPartitionMajorStep(uint64_t timestampNs);

    std::shared_ptr<const CompiledSignalGraph> m_graph;
    std::vector<double> m_kernelDiscrete;
    std::vector<double> m_kernelParams;
    std::vector<double> m_stageReals;
    std::vector<double> m_stageState;
    std::vector<double> m_halfState;
    std::vector<const double*> m_kernelInputs;
    std::vector<uint16_t> m_kernelInputWidths;
    std::vector<double> m_kernelInputScratch;
    std::vector<uint8_t> m_due;
    bool m_constantGroupsDirty = false;
    /** Início do passo contínuo em andamento: `majorNs` dos estágios do integrador. */
    uint64_t m_stageMajorNs = 0;
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
    /** Rate groups made only of ExternalInput blocks. Their value is written
     * straight into the output slot by setExternal*, so activating them is a
     * no-op: they are never activated nor scheduled (a generic port runs at
     * the 1 ns marker rate and would otherwise step the simulation 1 ns at a
     * time). */
    std::vector<uint8_t> m_passiveGroup;
    std::vector<double> m_dynamicState;
    std::vector<double> m_dynamicCandidate;
    std::vector<double> m_dynamicScratch;
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

/**
 * Reusable scalar expression/function evaluator.  This is deliberately a thin
 * Core-owned facade over SignalCompiler/SignalRuntime, so protocol devices and
 * control blocks use exactly the same expression grammar and validation.
 * Compilation is cold-path; evaluate() is bounded and allocation-free.
 */
class SignalExpression {
public:
    SignalExpression() = default;
    SignalExpression(std::vector<std::string> inputIds, std::string expression);

    void compile(std::vector<std::string> inputIds, std::string expression);
    bool valid() const noexcept { return static_cast<bool>(m_graph); }
    const std::string& expression() const noexcept { return m_expression; }
    const std::vector<std::string>& inputIds() const noexcept { return m_inputIds; }
    double evaluate(std::span<const double> values, uint64_t timestampNs = 0);

private:
    std::vector<std::string> m_inputIds;
    std::string m_expression;
    std::shared_ptr<const CompiledSignalGraph> m_graph;
    SignalRuntime m_runtime;
};

} // namespace lasecsimul::simulation

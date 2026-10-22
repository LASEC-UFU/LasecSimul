#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include "resources/ResourceGovernor.hpp"

namespace lasecsimul::python {

using PythonValue = std::variant<bool, int64_t, double>;

struct PythonPortDefinition {
    std::string name;
    std::string type = "real";
    PythonValue initialValue = 0.0;
};

struct PythonBlockDefinition {
    std::string blockId;
    std::string source;
    std::string rateGroupId = "default";
    std::vector<std::string> dependencies;
    std::vector<PythonPortDefinition> inputs;
    std::vector<PythonPortDefinition> outputs;
};

struct PythonStep {
    std::string blockId;
    std::unordered_map<std::string, double> inputs;
    std::unordered_map<std::string, PythonValue> typedInputs;
    uint64_t dtNs = 0;
    uint64_t stepIndex = 0;
};

struct PythonStepResult {
    std::string blockId;
    std::unordered_map<std::string, double> outputs;
    std::unordered_map<std::string, PythonValue> typedOutputs;
    std::string error;
};

enum class PythonWorkerHealth : uint8_t {
    Stopped,
    Ready,
    Faulted,
};

struct PythonRuntimeMetrics {
    uint64_t workerStarts = 0;
    uint64_t batches = 0;
    uint64_t steps = 0;
    uint64_t requestBytes = 0;
    uint64_t responseBytes = 0;
    uint64_t timeouts = 0;
    uint64_t crashes = 0;
    uint64_t restarts = 0;
};

struct PythonEnvironmentDiagnostics {
    std::string implementation;
    std::string version;
    std::string executable;
    std::string platform;
    std::unordered_map<std::string, std::string> dependencies;
};

/**
 * Runtime Python subordinado ao tempo virtual da sessão.
 *
 * O processo é criado somente no primeiro STEP_BATCH, nunca por bloco. O protocolo é
 * request/response e portanto possui um único escritor/coordenador. Um timeout ou crash mata o
 * processo inteiro e exige restart() explícito; estado Python não checkpointado é descartado.
 *
 * A interface legada step(inputs, state, time_ns) continua aceitando mapas sem manifesto de portas;
 * nesse caso, nomes e tipos escalares de entradas e saídas são inferidos por ciclo. PythonProgramBlock
 * usa manifestos tipados explícitos. Os testes Windows cobrem timeout, restart e recuperação.
 */
class PythonRuntime {
public:
    explicit PythonRuntime(resources::ResourceBudget budget,
                           std::string pythonExecutable = {});
    ~PythonRuntime();

    PythonRuntime(const PythonRuntime&) = delete;
    PythonRuntime& operator=(const PythonRuntime&) = delete;

    void configure(std::vector<PythonBlockDefinition> blocks);
    std::vector<PythonStepResult> stepBatch(uint64_t timestampNs,
                                            const std::string& rateGroupId,
                                            const std::vector<PythonStep>& steps);

    void restart();
    void shutdown();
    void setPythonExecutable(std::string executable);
    void setStepTimeoutMs(uint32_t timeoutMs);
    void resetMetrics() { m_metrics = {}; }

    bool workerRunning() const;
    uint64_t workerProcessId() const;
    PythonWorkerHealth health() const { return m_health; }
    const std::string& faultMessage() const { return m_faultMessage; }
    const PythonRuntimeMetrics& metrics() const { return m_metrics; }
    const PythonEnvironmentDiagnostics& environment() const { return m_environment; }
    size_t configuredBlockCount() const { return m_blocks.size(); }

private:
    class Process;

    void ensureStarted();
    void markFaulted(const std::string& message, bool timeout);
    std::string resolvePythonExecutable() const;

    resources::ResourceBudget m_budget;
    std::string m_pythonExecutable;
    std::vector<PythonBlockDefinition> m_blocks;
    std::unique_ptr<Process> m_process;
    PythonWorkerHealth m_health = PythonWorkerHealth::Stopped;
    std::string m_faultMessage;
    PythonRuntimeMetrics m_metrics;
    PythonEnvironmentDiagnostics m_environment;
};

} // namespace lasecsimul::python

#pragma once

#include <memory>
#include <atomic>
#include <algorithm>
#include <cmath>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <unordered_map>
#include <vector>

#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/Sha256.hpp"
#include "PlcNativeModule.hpp"
#include "PlcRuntime.hpp"
#include "../simulation/SimulationPlan.hpp"

namespace lasecsimul::plc {

/** Pedido de ligação de um I/O do PLC a um bloco do Signal Engine (nesta rodada, ajustado via
 * `PlcComponent::setIoBindingRequests`, sem editor gráfico) -- resolvido/validado pelo
 * `PlanCompiler` (F9.5, `simulation::PlanCompileInput::plcInstances[].ioBindingRequests`) contra o
 * grafo do Signal Engine já compilado, nunca aqui. Reaproveita o tipo de
 * `simulation::PlcIoBindingRequest` diretamente (mesmo formato, só reexportado aqui pra quem já
 * inclui `PlcComponent.hpp` não precisar incluir `SimulationPlan.hpp` à parte). `ioId` é a
 * identidade estável (== `PlcExportedIo::ioId`, que nesta rodada é o nome da variável ST). */
using PlcIoBindingRequest = simulation::PlcIoBindingRequest;

/**
 * Componente do PLC (F9.5) -- ponte entre `PlcNativeModule`/`PlcRuntime` (F9.3/F9.4, já provados
 * isoladamente) e `IComponentModel` (entra no Netlist como qualquer outro componente, com pinos
 * reais ligáveis por fio -- mesmo papel que `McuComponent` cumpre pra QEMU, ver seu doc-comment).
 *
 * Cada `PlcNativeModule::exportedIo[]` vira um pino elétrico real. Entradas amostram a tensão do nó
 * com alta impedância e alimentam o scan quando não existe binding explícito do Signal Engine;
 * saídas dirigem a tensão do pino (BOOL = 0/5 V, tipos numéricos = valor em volts). Bindings do
 * Signal Engine continuam suportados e têm precedência para a mesma variável.
 *
 * O worker (`PlcRuntime`) é uma OWN member, criado/recriado por `loadArtifact()`, destruído
 * sincronamente no destrutor (mesmo padrão de `McuController::stop()` em `~McuComponent()`) -- a
 * remoção do componente (`SimulationSession::removeComponentUnlocked`, que já exige simulação
 * parada antes de rodar) garante que nenhuma outra thread está no meio de um `scan()` quando isso
 * acontece.
 */
class PlcComponent final : public IComponentModel {
public:
    explicit PlcComponent(PlcRuntimeOptions runtimeOptions = {}) : m_runtimeOptions(runtimeOptions) {}
    ~PlcComponent() override = default;

    const char* typeId() const override { return "plc.instance"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        if (!m_module) return;
        for (size_t i = 0; i < m_module->exportedIo.size(); ++i) {
            const PlcExportedIo& io = m_module->exportedIo[i];
            const Pin& pin = m_pins[i];
            if (io.direction == "input") {
                m_electricalInputs[io.ioId] = matrix.getNodeVoltage(pin);
                matrix.addConductanceToGround(pin, kInputConductance);
            } else {
                const auto found = m_electricalOutputs.find(io.ioId);
                const double target = found == m_electricalOutputs.end() ? 0.0 : found->second;
                matrix.addConductanceToGround(pin, kOutputConductance);
                matrix.addCurrentToGround(pin, target * kOutputConductance);
            }
        }
    }
    void postStep(uint64_t) override {}    // não usado -- scan é disparado pelo Scheduler via SimulationSession, não por postStep.

    /** A tensão das entradas vem da solução do circuito: `stamp()` só roda quando o componente fica
     * dirty, então a leitura feita lá ficava presa no valor da primeira montagem (um botão ligado
     * depois nunca chegava ao programa). A entrada não muda o que o bloco estampa: nunca pede
     * reestampa. */
    bool observesSolution() const override { return true; }
    bool observeSolution(const MnaMatrixView& matrix) override {
        if (!m_module) return false;
        for (size_t i = 0; i < m_module->exportedIo.size() && i < m_pins.size(); ++i) {
            const PlcExportedIo& io = m_module->exportedIo[i];
            if (io.direction == "input") m_electricalInputs[io.ioId] = matrix.getNodeVoltage(m_pins[i]);
        }
        return false;
    }

    /** LeakageGuard mantém entradas e saídas desconectadas numericamente referenciadas. */
    std::span<const uint32_t> leakagePinIndices() const override { return m_leakageIndices; }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    void onAssignedIndex(uint32_t index) override { m_componentIndex = index; }
    uint32_t componentIndex() const { return m_componentIndex; }
    uint64_t runtimeInstanceId() const noexcept { return static_cast<uint64_t>(m_componentIndex) + 1u; }
    RuntimeLaunchIdentity runtimeIdentity() const noexcept {
        if (m_runtime) return m_runtime->runtimeIdentity();
        return {m_sessionExecutionId.load(std::memory_order_acquire), runtimeInstanceId(),
                m_launchGeneration.load(std::memory_order_acquire)};
    }
    void setSessionExecutionId(uint64_t id) {
        if (m_runtime) m_runtime->setSessionExecutionId(id);
        m_sessionExecutionId.store(id, std::memory_order_release);
    }
    uint64_t reserveLaunchGeneration() {
        uint64_t current = m_launchGeneration.load(std::memory_order_relaxed);
        for (;;) {
            if (current == UINT64_MAX) throw std::overflow_error("PLC launch generation exhausted");
            if (m_launchGeneration.compare_exchange_weak(current, current + 1,
                    std::memory_order_acq_rel, std::memory_order_relaxed)) return current + 1;
        }
    }

    /** Carrega um artefato compilado (F9.3) -- reconstrói `m_pins` a partir de
     * `module.exportedIo` (zero pinos se `module` for `nullopt`, exatamente `exportedIo.size()`
     * caso contrário) e (re)cria o `PlcRuntime`, descartando qualquer worker anterior. Chamado fora
     * do caminho de propriedades genérico; o comando IPC `loadPlcArtifact` chega a
     * `SimulationSession::loadPlcArtifact`, que invoca isto e cuida de
     * `reregisterPinsIfChanged`/`invalidatePlan`. */
    void loadArtifact(std::optional<PlcNativeModule> module) {
        if (module) validateArtifact(*module);
        m_runtime.reset();
        m_module = std::move(module);
        m_pins.clear();
        m_leakageIndices.clear();
        m_electricalInputs.clear();
        m_electricalOutputs.clear();
        if (m_module) {
            m_pins.reserve(m_module->exportedIo.size());
            m_leakageIndices.reserve(m_module->exportedIo.size());
            for (uint32_t i = 0; i < m_module->exportedIo.size(); ++i) {
                m_pins.push_back(Pin{m_module->exportedIo[i].ioId, 0.0, 0.0});
                m_leakageIndices.push_back(i);
            }
            PlcRuntimeOptions options = m_runtimeOptions;
            options.sessionExecutionId = m_sessionExecutionId.load(std::memory_order_acquire);
            options.runtimeInstanceId = runtimeInstanceId();
            options.launchIdentityProvider = [this] {
                return RuntimeLaunchIdentity{m_sessionExecutionId.load(std::memory_order_acquire),
                                             runtimeInstanceId(), reserveLaunchGeneration()};
            };
            const char* dataDirectory = std::getenv("LASECSIMUL_CORE_DATA_DIR");
            if (dataDirectory && *dataDirectory && !m_persistenceIdentity.empty()) {
                const std::string key = m_persistenceIdentity + "\n" + m_module->sourceHash + "\n" + m_module->programName;
                Sha256 digest;
                digest.update(reinterpret_cast<const uint8_t*>(key.data()), key.size());
                const std::string filename = digest.finalizeHex() + ".retain";
                options.retainStoragePath = std::filesystem::u8path(dataDirectory) / "plc-retain" / filename;
            }
            m_runtime = std::make_unique<PlcRuntime>(*m_module, std::move(options));
        }
    }

    void setIoBindingRequests(std::vector<PlcIoBindingRequest> requests) { m_ioBindingRequests = std::move(requests); }
    const std::vector<PlcIoBindingRequest>& ioBindingRequests() const { return m_ioBindingRequests; }

    void setTaskIntervalNs(uint64_t ns) { m_taskIntervalNs = ns; }
    uint64_t taskIntervalNs() const { return m_taskIntervalNs; }
    void setPersistentIdentity(std::string identity) { m_persistenceIdentity = std::move(identity); }
    void setWorkerMemoryLimitBytes(uint64_t bytes) {
        m_runtimeOptions.workerMemoryLimitBytes = bytes;
        if (m_runtime) throw std::logic_error("memory limit must be set before loading PLC artifact");
    }
    void setSharedHostIsolationRequired(bool required) {
        m_runtimeOptions.sharedHostIsolationRequired = required;
        if (m_runtime) throw std::logic_error("worker isolation policy must be set before loading PLC artifact");
    }

    const std::optional<PlcNativeModule>& artifact() const { return m_module; }
    PlcRuntime* runtime() { return m_runtime.get(); }
    const PlcRuntime* runtime() const { return m_runtime.get(); }

    void appendElectricalInputs(PlcScanRequest& request, const std::unordered_set<std::string>& signalBoundNames) const {
        if (!m_module) return;
        for (const PlcExportedIo& io : m_module->exportedIo) {
            if (io.direction != "input" || signalBoundNames.contains(io.name) || signalBoundNames.contains(io.ioId)) continue;
            const auto found = m_electricalInputs.find(io.ioId);
            const double value = found == m_electricalInputs.end() ? 0.0 : found->second;
            const std::string type = upper(io.iecType);
            if (type == "BOOL") request.inputs[upper(io.name)] = value > kDigitalLevelThreshold ? "TRUE" : "FALSE";
            else if (type == "REAL" || type == "LREAL") request.inputs[upper(io.name)] = std::to_string(value);
            else request.inputs[upper(io.name)] = std::to_string(static_cast<int64_t>(std::llround(value)));
        }
    }

    bool commitElectricalOutputs(const std::unordered_map<std::string, std::string>& outputs) {
        if (!m_module) return false;
        bool changed = false;
        for (const PlcExportedIo& io : m_module->exportedIo) {
            if (io.direction != "output") continue;
            const auto found = outputs.find(upper(io.name));
            if (found == outputs.end()) continue;
            const std::string type = upper(io.iecType);
            double value = 0.0;
            try {
                value = type == "BOOL" ? (upper(found->second) == "TRUE" ? 5.0 : 0.0) : std::stod(found->second);
            } catch (const std::exception&) {
                continue;
            }
            const auto previous = m_electricalOutputs.find(io.ioId);
            changed = changed || previous == m_electricalOutputs.end() || previous->second != value;
            m_electricalOutputs[io.ioId] = value;
        }
        return changed;
    }

private:
    static std::string upper(std::string value) {
        for (char& c : value) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
        return value;
    }
    static void validateArtifact(const PlcNativeModule& module) {
        if (module.formatVersion != 1 || module.workerProtocolVersion != 1) {
            throw std::invalid_argument("PlcNativeModule format/protocol version incompativel");
        }
#if defined(_WIN32)
        constexpr const char* platform = "windows";
#elif defined(__APPLE__)
        constexpr const char* platform = "darwin";
#else
        constexpr const char* platform = "linux";
#endif
        if (module.targetPlatform != platform) throw std::invalid_argument("PlcNativeModule targetPlatform incompativel");
#if defined(__aarch64__) || defined(_M_ARM64)
        constexpr const char* architecture = "arm64";
#elif defined(_WIN64) || defined(__x86_64__)
        constexpr const char* architecture = "x64";
#else
        constexpr const char* architecture = "unknown";
#endif
        if (module.targetArch != architecture) throw std::invalid_argument("PlcNativeModule targetArch incompativel");
        if (module.nativeBinaryRef.empty() || !std::filesystem::exists(module.nativeBinaryRef)) {
            throw std::invalid_argument("PlcNativeModule nativeBinaryRef inexistente");
        }
        if (module.artifactHash.size() != 64 || Sha256::hashFile(module.nativeBinaryRef) != module.artifactHash) {
            throw std::invalid_argument("PlcNativeModule artifactHash invalido");
        }
        std::unordered_set<std::string> ioIds;
        for (const PlcExportedIo& io : module.exportedIo) {
            if (io.ioId.empty() || io.name.empty() || !ioIds.insert(io.ioId).second) {
                throw std::invalid_argument("PlcNativeModule exportedIo possui ioId vazio/duplicado");
            }
            if (io.direction != "input" && io.direction != "output") {
                throw std::invalid_argument("PlcNativeModule exportedIo direction invalida");
            }
        }
        std::unordered_set<std::string> retainedNames;
        for (const std::string& entry : module.retainLayout) {
            const size_t separator = entry.find(':');
            if (separator == std::string::npos || separator == 0 || separator + 1 >= entry.size() ||
                !retainedNames.insert(upper(entry.substr(0, separator))).second) {
                throw std::invalid_argument("PlcNativeModule retainLayout possui entrada vazia ou duplicada");
            }
        }
        if (!module.taskTable.empty() && module.configurationName.empty()) {
            throw std::invalid_argument("PlcNativeModule taskTable requer configurationName");
        }
        std::unordered_set<std::string> taskNames;
        for (const PlcTaskDescriptor& task : module.taskTable) {
            if (task.name.empty() || task.intervalNs < 0 || !taskNames.insert(upper(task.name)).second) {
                throw std::invalid_argument("PlcNativeModule taskTable possui nome vazio, intervalo negativo ou tarefa duplicada");
            }
            if (task.intervalNs == 0) {
                if (task.eventVariable.empty()) throw std::invalid_argument("PlcNativeModule event task requer eventVariable");
                const auto eventInput = std::find_if(module.exportedIo.begin(), module.exportedIo.end(), [&](const PlcExportedIo& io) {
                    return upper(io.name) == upper(task.eventVariable) && io.direction == "input" && upper(io.iecType) == "BOOL";
                });
                if (eventInput == module.exportedIo.end()) throw std::invalid_argument("eventVariable deve referenciar uma entrada BOOL exportada");
            } else if (!task.eventVariable.empty()) {
                throw std::invalid_argument("task cíclica não pode declarar eventVariable");
            }
        }
        std::unordered_set<std::string> instanceNames;
        for (const PlcProgramInstanceDescriptor& instance : module.programInstances) {
            if (instance.instanceName.empty() || instance.programName.empty() ||
                !instanceNames.insert(upper(instance.instanceName)).second ||
                (!module.taskTable.empty() && !taskNames.contains(upper(instance.taskName)))) {
                throw std::invalid_argument("PlcNativeModule programInstances possui binding vazio, duplicado ou task inexistente");
            }
        }
    }

    uint32_t m_componentIndex = 0;
    std::atomic<uint64_t> m_sessionExecutionId{0};
    std::atomic<uint64_t> m_launchGeneration{0};
    std::vector<Pin> m_pins;
    std::vector<uint32_t> m_leakageIndices;
    std::unordered_map<std::string, double> m_electricalInputs;
    std::unordered_map<std::string, double> m_electricalOutputs;
    std::optional<PlcNativeModule> m_module;
    std::vector<PlcIoBindingRequest> m_ioBindingRequests;
    uint64_t m_taskIntervalNs = 10'000'000; // 10ms -- default fixo desta rodada, ver doc-comment em SimulationPlan.hpp/PlcInstancePlan.
    PlcRuntimeOptions m_runtimeOptions;
    std::string m_persistenceIdentity;
    static constexpr double kInputConductance = 1e-9;
    static constexpr double kOutputConductance = 1e6;
    std::unique_ptr<PlcRuntime> m_runtime;
};

} // namespace lasecsimul::plc

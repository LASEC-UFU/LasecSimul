#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "resources/ResourceGovernor.hpp"

namespace lasecsimul::python {

struct PythonBlockDefinition {
    std::string blockId;
    std::string source;
    std::string rateGroupId = "default";
    std::vector<std::string> dependencies;
};

struct PythonStep {
    std::string blockId;
    std::unordered_map<std::string, double> inputs;
};

struct PythonStepResult {
    std::string blockId;
    std::unordered_map<std::string, double> outputs;
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
 * Runtime Python subordinado ao tempo virtual da sessao.
 *
 * O processo e criado somente no primeiro STEP_BATCH, nunca por bloco. O protocolo e
 * request/response e portanto possui um unico escritor/coordenador. Um timeout ou crash mata o
 * processo inteiro e exige restart() explicito; estado Python nao checkpointado e descartado.
 *
 * BUG CONHECIDO, NAO RESOLVIDO (2026-08-20, Windows apenas): respawnar um SEGUNDO worker
 * python.exe depois que o primeiro foi morto (timeout, crash, ou ate shutdown()+restart() limpo,
 * sem nenhuma falha real envolvida) crash a PRÓPRIA python_runtime_test.exe com
 * 0xC0000409/STATUS_STACK_BUFFER_OVERRUN (fail-fast, módulo faltante ucrtbase.dll) de forma
 * reprodutível, dentro do polling loop de Process::readLine() do segundo processo -- não em uma
 * chamada Win32 específica (não tratado como retorno de erro checável), consistente com detecção
 * tardia de corrupção de heap por uma alocação não relacionada, não um bug de lógica de uma linha
 * só. python_session_test (só um spawn por processo) passa limpo -- o bug é especificamente no
 * caminho de RESPAWN, não no spawn em si.
 *
 * Já investigado e DESCARTADO como causa (não repetir sem achado novo): Job Object/
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (desabilitar não muda nada); a thread leitora de stderr
 * (desabilitar não muda nada -- o crash acontece até no PRIMEIRO spawn sob instrumentação pesada,
 * sugerindo uma corrida de baixa probabilidade cuja janela a instrumentação desloca, não um bug
 * determinístico); PROC_THREAD_ATTRIBUTE_HANDLE_LIST/STARTUPINFOEXW (implementado abaixo em
 * Process::start() como correção documentada da Microsoft para herança de handle em processo
 * multithread -- endurecimento real, mantido, mas NÃO resolveu este crash específico); atraso de
 * 1-3s antes do respawn (nenhum efeito -- não é uma corrida de "SO ainda não liberou recurso");
 * CREATE_BREAKAWAY_FROM_JOB (nenhum efeito -- confirmado via IsProcessInJob que a árvore do shell
 * sandboxado da ferramenta de investigação está de fato dentro de um Job Object, mas escapar dele
 * não mudou nada); resetar o objeto Process "zumbi" imediatamente em markFaulted() em vez de
 * deixar para restart() fazer depois (nenhum efeito).
 *
 * Nenhum debugger (cdb/WinDbg) estava disponível no ambiente de investigação -- um novo esforço de
 * correção deveria começar por aí (Application Verifier + page heap em python_runtime_test.exe, ou
 * um dump de crash local via HKLM\...\Windows Error Reporting\LocalDumps) em vez de mais bisecção
 * via printf, que teve sinal ruim aqui. Até isto fechar, o critério de aceite "timeout/crash/
 * restart testados" de FEAT-006/gate F8 do ROADMAP.md NÃO está cumprido no Windows.
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

#include "PythonRuntime.hpp"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <unordered_set>

#include <nlohmann/json.hpp>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <csignal>
#include <fcntl.h>
#include <poll.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif
#endif

namespace lasecsimul::python {
namespace {

using json = nlohmann::json;

class PythonTimeout final : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

constexpr const char* kWorkerProgram = R"PY(
import contextlib
import io
import importlib.metadata
import json
import os
import sys
import traceback
import platform

blocks = {}

def reply(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()

def initialize(definitions):
    staged = {}
    for definition in definitions:
        block_id = definition["blockId"]
        namespace = {"__name__": "lasecsimul_block_" + block_id}
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            exec(compile(definition["source"], "<lasecsimul:" + block_id + ">", "exec"), namespace, namespace)
        step = namespace.get("step")
        if not callable(step):
            raise ValueError("block " + block_id + " must define step(inputs, state, time_ns)")
        staged[block_id] = (step, {})
    return staged

for raw in sys.stdin:
    try:
        request = json.loads(raw)
        operation = request.get("op")
        if operation == "INIT":
            blocks = initialize(request.get("blocks", []))
            dependency_versions = {}
            for name in request.get("dependencies", []):
                try:
                    dependency_versions[name] = importlib.metadata.version(name)
                except importlib.metadata.PackageNotFoundError:
                    dependency_versions[name] = "<missing>"
            reply({"ok": True, "pid": os.getpid(), "blocks": len(blocks), "environment": {
                "implementation": platform.python_implementation(), "version": platform.python_version(),
                "executable": sys.executable, "platform": platform.platform(),
                "dependencies": dependency_versions}})
        elif operation == "STEP_BATCH":
            timestamp_ns = int(request["timestampNs"])
            results = []
            for item in request.get("steps", []):
                block_id = item["blockId"]
                if block_id not in blocks:
                    raise KeyError("unknown block " + block_id)
                step, state = blocks[block_id]
                captured = io.StringIO()
                with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
                    outputs = step(dict(item.get("inputs", {})), state, timestamp_ns)
                if not isinstance(outputs, dict):
                    raise TypeError("step for " + block_id + " must return a dict")
                results.append({"blockId": block_id, "outputs": outputs})
            reply({"ok": True, "pid": os.getpid(), "rateGroupId": request.get("rateGroupId", ""), "results": results})
        elif operation == "SHUTDOWN":
            reply({"ok": True, "pid": os.getpid()})
            break
        else:
            raise ValueError("unsupported operation: " + str(operation))
    except BaseException as error:
        reply({"ok": False, "pid": os.getpid(), "error": str(error), "type": type(error).__name__, "traceback": traceback.format_exc(limit=8)})
)PY";

std::chrono::milliseconds timeoutFrom(const resources::ResourceBudget& budget) {
    return std::chrono::milliseconds(budget.pythonStepTimeoutMs);
}

std::chrono::milliseconds startupTimeoutFrom(const resources::ResourceBudget& budget) {
    // O watchdog curto protege o hot path STEP_BATCH. O bootstrap importa módulos da stdlib e
    // coleta versões de dependências, operações cold-path que no Windows podem ultrapassar 100 ms
    // mesmo em uma máquina saudável. Reutilizar diretamente o prazo do step fazia um timeout de
    // usuário matar o worker antes de ele aceitar o primeiro batch e tornava restart não confiável.
    return std::max(timeoutFrom(budget), std::chrono::milliseconds(5000));
}

#if defined(_WIN32)
std::wstring widen(const std::string& text) {
    if (text.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.c_str(), -1, nullptr, 0);
    if (size <= 0) throw std::runtime_error("invalid UTF-8 in Python command line");
    std::wstring result(static_cast<size_t>(size), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.c_str(), -1, result.data(), size) != size) {
        throw std::runtime_error("invalid UTF-8 in Python command line");
    }
    result.pop_back();
    return result;
}

std::wstring quoteWindowsArg(const std::string& argument) {
    const std::wstring input = widen(argument);
    if (input.find_first_of(L" \t\"") == std::wstring::npos) return input;
    std::wstring output = L"\"";
    size_t slashes = 0;
    for (const wchar_t ch : input) {
        if (ch == L'\\') {
            ++slashes;
        } else if (ch == L'\"') {
            output.append(slashes * 2 + 1, L'\\');
            output.push_back(ch);
            slashes = 0;
        } else {
            output.append(slashes, L'\\');
            slashes = 0;
            output.push_back(ch);
        }
    }
    output.append(slashes * 2, L'\\');
    output.push_back(L'\"');
    return output;
}
#endif

} // namespace

class PythonRuntime::Process {
public:
    Process(std::string executable, uint64_t memoryBytes, uint64_t logBytes, size_t payloadBytes)
        : m_executable(std::move(executable)),
          m_memoryBytes(memoryBytes),
          m_maxLogBytes(static_cast<size_t>(std::max<uint64_t>(1024, logBytes))),
          m_maxPayloadBytes(payloadBytes) {}

    ~Process() { kill(); }

    void start() {
        if (running()) throw std::runtime_error("Python worker is already running");
#if defined(_WIN32)
        // Achado real (2026-08-20, investigação ao vivo de crash 0xC0000409/STATUS_STACK_BUFFER_OVERRUN
        // em ucrtbase.dll, reproduzido de forma confiável ao respawnar um segundo worker Python na
        // mesma sessao de testes): CreateProcessW com bInheritHandle=TRUE herda TODO handle
        // marcado herdavel do processo inteiro, nao so os 3 que este metodo realmente quer passar --
        // e essa varredura de herança NAO e thread-safe contra criação/fechamento concorrente de
        // handles em OUTRA thread do mesmo processo (aqui: a thread leitora de stderr de uma
        // instancia de Process anterior ainda finalizando, ou o proprio SimulationSession). A
        // Microsoft documenta exatamente essa classe de bug e recomenda PROC_THREAD_ATTRIBUTE_HANDLE_LIST
        // (STARTUPINFOEXW) em vez de bInheritHandle=TRUE + SetHandleInformation em processos
        // multithread -- so os 3 handles explicitamente listados abaixo sao herdados, eliminando a
        // corrida de vez (nao um workaround parcial como reduzir handles herdaveis manualmente).
        SECURITY_ATTRIBUTES attributes{};
        attributes.nLength = sizeof(attributes);
        attributes.bInheritHandle = TRUE;

        HANDLE childStdinRead = nullptr;
        HANDLE childStdoutWrite = nullptr;
        HANDLE childStderrWrite = nullptr;
        if (!CreatePipe(&childStdinRead, &m_stdinWrite, &attributes, 0) ||
            !CreatePipe(&m_stdoutRead, &childStdoutWrite, &attributes, 0) ||
            !CreatePipe(&m_stderrRead, &childStderrWrite, &attributes, 0)) {
            closeHandles();
            throw std::runtime_error("failed to create Python worker pipes");
        }
        SetHandleInformation(m_stdinWrite, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(m_stdoutRead, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(m_stderrRead, HANDLE_FLAG_INHERIT, 0);

        HANDLE inheritList[3] = {childStdinRead, childStdoutWrite, childStderrWrite};
        SIZE_T attributeListSize = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeListSize);
        std::vector<uint8_t> attributeListStorage(attributeListSize);
        auto* attributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeListStorage.data());
        const bool attributeListReady =
            InitializeProcThreadAttributeList(attributeList, 1, 0, &attributeListSize) &&
            UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                      inheritList, sizeof(inheritList), nullptr, nullptr);
        if (!attributeListReady) {
            CloseHandle(childStdinRead);
            CloseHandle(childStdoutWrite);
            CloseHandle(childStderrWrite);
            closeHandles();
            throw std::runtime_error("failed to build Python worker inherit-handle list");
        }

        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = childStdinRead;
        startup.StartupInfo.hStdOutput = childStdoutWrite;
        startup.StartupInfo.hStdError = childStderrWrite;
        startup.lpAttributeList = attributeList;

        std::wstring command = quoteWindowsArg(m_executable) + L" -u -c " + quoteWindowsArg(kWorkerProgram);
        const BOOL created = CreateProcessW(
            nullptr, command.data(), nullptr, nullptr, TRUE,
            CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr,
            &startup.StartupInfo, &m_processInfo);
        DeleteProcThreadAttributeList(attributeList);
        if (!created) {
            CloseHandle(childStdinRead);
            CloseHandle(childStdoutWrite);
            CloseHandle(childStderrWrite);
            closeHandles();
            throw std::runtime_error("failed to start Python interpreter: " + m_executable);
        }
        CloseHandle(childStdinRead);
        CloseHandle(childStdoutWrite);
        CloseHandle(childStderrWrite);

        m_job = CreateJobObjectW(nullptr, nullptr);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (m_memoryBytes > 0) {
            limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            limits.ProcessMemoryLimit = static_cast<SIZE_T>(m_memoryBytes);
        }
        const bool attached = m_job &&
            SetInformationJobObject(m_job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) &&
            AssignProcessToJobObject(m_job, m_processInfo.hProcess);
        if (!attached || ResumeThread(m_processInfo.hThread) == static_cast<DWORD>(-1)) {
            TerminateProcess(m_processInfo.hProcess, 1);
            WaitForSingleObject(m_processInfo.hProcess, 1000);
            closeHandles();
            throw std::runtime_error("failed to contain Python worker in Job Object");
        }
        m_stderrThread = std::thread([this] { readStderrLoop(); });
#else
        int inputPipe[2] = {-1, -1};
        int outputPipe[2] = {-1, -1};
        int errorPipe[2] = {-1, -1};
        if (pipe(inputPipe) != 0 || pipe(outputPipe) != 0 || pipe(errorPipe) != 0) {
            throw std::runtime_error("failed to create Python worker pipes");
        }
        m_pid = fork();
        if (m_pid < 0) throw std::runtime_error("failed to fork Python worker");
        if (m_pid == 0) {
            setpgid(0, 0);
#if defined(__linux__)
            prctl(PR_SET_PDEATHSIG, SIGKILL);
            if (getppid() == 1) _exit(125);
#endif
            if (m_memoryBytes > 0) {
                struct rlimit limit { static_cast<rlim_t>(m_memoryBytes), static_cast<rlim_t>(m_memoryBytes) };
                setrlimit(RLIMIT_AS, &limit);
            }
            dup2(inputPipe[0], STDIN_FILENO);
            dup2(outputPipe[1], STDOUT_FILENO);
            dup2(errorPipe[1], STDERR_FILENO);
            close(inputPipe[0]); close(inputPipe[1]);
            close(outputPipe[0]); close(outputPipe[1]);
            close(errorPipe[0]); close(errorPipe[1]);
            execlp(m_executable.c_str(), m_executable.c_str(), "-u", "-c", kWorkerProgram, nullptr);
            _exit(127);
        }
        setpgid(m_pid, m_pid);
        close(inputPipe[0]); close(outputPipe[1]); close(errorPipe[1]);
        m_stdinFd = inputPipe[1];
        m_stdoutFd = outputPipe[0];
        m_stderrFd = errorPipe[0];
        fcntl(m_stdoutFd, F_SETFL, fcntl(m_stdoutFd, F_GETFL, 0) | O_NONBLOCK);
        m_stderrThread = std::thread([this] { readStderrLoop(); });
#endif
    }

    json request(const json& value, std::chrono::milliseconds timeout, size_t& sent, size_t& received) {
        std::string wire = value.dump();
        wire.push_back('\n');
        if (wire.size() > m_maxPayloadBytes) throw std::runtime_error("Python request exceeds payload budget");
        sent = wire.size();
        writeAll(wire);
        const std::string response = readLine(timeout);
        received = response.size() + 1;
        if (received > m_maxPayloadBytes) throw std::runtime_error("Python response exceeds payload budget");
        try {
            return json::parse(response);
        } catch (const std::exception& error) {
            throw std::runtime_error(std::string("invalid Python worker response: ") + error.what());
        }
    }

    bool running() const {
#if defined(_WIN32)
        return m_processInfo.hProcess && WaitForSingleObject(m_processInfo.hProcess, 0) == WAIT_TIMEOUT;
#else
        if (m_pid <= 0) return false;
        int status = 0;
        const pid_t result = waitpid(m_pid, &status, WNOHANG);
        if (result == 0) return true;
        if (result == m_pid) const_cast<Process*>(this)->m_pid = -1;
        return false;
#endif
    }

    uint64_t processId() const {
#if defined(_WIN32)
        return static_cast<uint64_t>(m_processInfo.dwProcessId);
#else
        return m_pid > 0 ? static_cast<uint64_t>(m_pid) : 0;
#endif
    }

    std::string logs() const {
        std::lock_guard<std::mutex> lock(m_logMutex);
        return m_logs;
    }

    void kill() {
#if defined(_WIN32)
        if (m_processInfo.hProcess && WaitForSingleObject(m_processInfo.hProcess, 0) == WAIT_TIMEOUT) {
            TerminateProcess(m_processInfo.hProcess, 1);
            WaitForSingleObject(m_processInfo.hProcess, 2000);
        }
        if (m_stdinWrite) { CloseHandle(m_stdinWrite); m_stdinWrite = nullptr; }
        if (m_stdoutRead) { CloseHandle(m_stdoutRead); m_stdoutRead = nullptr; }
        if (m_stderrThread.joinable()) {
            // A morte anormal do interpretador nem sempre sinaliza EOF no pipe de stderr antes de
            // o último handle do processo ser fechado. Nesse caso ReadFile() pode permanecer
            // bloqueado e o watchdog ficava preso no join(), impedindo justamente o restart que
            // deveria recuperar a sessão. Cancele a I/O síncrona na thread proprietária antes de
            // aguardá-la; ela continua sendo a única thread que fecha m_stderrRead.
            CancelSynchronousIo(m_stderrThread.native_handle());
            m_stderrThread.join();
        }
        closeHandles();
#else
        if (m_pid > 0) {
            ::kill(-m_pid, SIGKILL);
            int status = 0;
            waitpid(m_pid, &status, 0);
            m_pid = -1;
        }
        if (m_stdinFd >= 0) { close(m_stdinFd); m_stdinFd = -1; }
        if (m_stdoutFd >= 0) { close(m_stdoutFd); m_stdoutFd = -1; }
        if (m_stderrThread.joinable()) m_stderrThread.join();
        if (m_stderrFd >= 0) { close(m_stderrFd); m_stderrFd = -1; }
#endif
    }

private:
    void appendLog(const char* data, size_t size) {
        std::lock_guard<std::mutex> lock(m_logMutex);
        m_logs.append(data, size);
        if (m_logs.size() > m_maxLogBytes) {
            m_logs.erase(0, m_logs.size() - m_maxLogBytes / 2);
        }
    }

#if defined(_WIN32)
    void readStderrLoop() {
        char buffer[512];
        DWORD count = 0;
        while (m_stderrRead && ReadFile(m_stderrRead, buffer, sizeof(buffer), &count, nullptr) && count > 0) {
            appendLog(buffer, static_cast<size_t>(count));
        }
        if (m_stderrRead) { CloseHandle(m_stderrRead); m_stderrRead = nullptr; }
    }

    void closeHandles() {
        if (m_processInfo.hThread) { CloseHandle(m_processInfo.hThread); m_processInfo.hThread = nullptr; }
        if (m_processInfo.hProcess) { CloseHandle(m_processInfo.hProcess); m_processInfo.hProcess = nullptr; }
        if (m_job) { CloseHandle(m_job); m_job = nullptr; }
        if (m_stdinWrite) { CloseHandle(m_stdinWrite); m_stdinWrite = nullptr; }
        if (m_stdoutRead) { CloseHandle(m_stdoutRead); m_stdoutRead = nullptr; }
        if (m_stderrRead) { CloseHandle(m_stderrRead); m_stderrRead = nullptr; }
        m_processInfo = {};
    }

    void writeAll(const std::string& data) {
        size_t offset = 0;
        while (offset < data.size()) {
            DWORD written = 0;
            if (!WriteFile(m_stdinWrite, data.data() + offset,
                           static_cast<DWORD>(data.size() - offset), &written, nullptr) || written == 0) {
                throw std::runtime_error("Python worker crashed while receiving request");
            }
            offset += written;
        }
    }

    std::string readLine(std::chrono::milliseconds timeout) {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        for (;;) {
            const size_t newline = m_stdoutBuffer.find('\n');
            if (newline != std::string::npos) {
                std::string line = m_stdoutBuffer.substr(0, newline);
                m_stdoutBuffer.erase(0, newline + 1);
                return line;
            }
            if (m_stdoutBuffer.size() > m_maxPayloadBytes) throw std::runtime_error("Python response exceeds payload budget");
            if (!running()) throw std::runtime_error("Python worker crashed: " + logs());
            DWORD available = 0;
            if (!PeekNamedPipe(m_stdoutRead, nullptr, 0, nullptr, &available, nullptr)) {
                throw std::runtime_error("Python worker output pipe failed");
            }
            if (available > 0) {
                char buffer[4096];
                DWORD count = 0;
                if (!ReadFile(m_stdoutRead, buffer, std::min<DWORD>(available, sizeof(buffer)), &count, nullptr)) {
                    throw std::runtime_error("Python worker output read failed");
                }
                m_stdoutBuffer.append(buffer, count);
                continue;
            }
            if (std::chrono::steady_clock::now() >= deadline) throw PythonTimeout("Python STEP_BATCH timed out");
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }

    HANDLE m_stdinWrite = nullptr;
    HANDLE m_stdoutRead = nullptr;
    HANDLE m_stderrRead = nullptr;
    HANDLE m_job = nullptr;
    PROCESS_INFORMATION m_processInfo{};
#else
    void readStderrLoop() {
        char buffer[512];
        ssize_t count = 0;
        while (m_stderrFd >= 0 && (count = read(m_stderrFd, buffer, sizeof(buffer))) > 0) {
            appendLog(buffer, static_cast<size_t>(count));
        }
    }

    void writeAll(const std::string& data) {
        size_t offset = 0;
        while (offset < data.size()) {
            const ssize_t written = write(m_stdinFd, data.data() + offset, data.size() - offset);
            if (written <= 0) throw std::runtime_error("Python worker crashed while receiving request");
            offset += static_cast<size_t>(written);
        }
    }

    std::string readLine(std::chrono::milliseconds timeout) {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        for (;;) {
            const size_t newline = m_stdoutBuffer.find('\n');
            if (newline != std::string::npos) {
                std::string line = m_stdoutBuffer.substr(0, newline);
                m_stdoutBuffer.erase(0, newline + 1);
                return line;
            }
            if (m_stdoutBuffer.size() > m_maxPayloadBytes) throw std::runtime_error("Python response exceeds payload budget");
            if (!running()) throw std::runtime_error("Python worker crashed: " + logs());
            const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now());
            if (remaining.count() <= 0) throw PythonTimeout("Python STEP_BATCH timed out");
            struct pollfd descriptor { m_stdoutFd, POLLIN, 0 };
            const int ready = poll(&descriptor, 1, static_cast<int>(std::min<int64_t>(remaining.count(), 20)));
            if (ready < 0 && errno != EINTR) throw std::runtime_error("Python worker output poll failed");
            if (ready > 0 && (descriptor.revents & (POLLIN | POLLHUP))) {
                char buffer[4096];
                const ssize_t count = read(m_stdoutFd, buffer, sizeof(buffer));
                if (count > 0) m_stdoutBuffer.append(buffer, static_cast<size_t>(count));
            }
        }
    }

    mutable pid_t m_pid = -1;
    int m_stdinFd = -1;
    int m_stdoutFd = -1;
    int m_stderrFd = -1;
#endif

    std::string m_executable;
    uint64_t m_memoryBytes = 0;
    size_t m_maxLogBytes = 0;
    size_t m_maxPayloadBytes = 0;
    mutable std::mutex m_logMutex;
    std::string m_logs;
    std::string m_stdoutBuffer;
    std::thread m_stderrThread;
};

PythonRuntime::PythonRuntime(resources::ResourceBudget budget, std::string pythonExecutable)
    : m_budget(std::move(budget)), m_pythonExecutable(std::move(pythonExecutable)) {}

PythonRuntime::~PythonRuntime() = default;

void PythonRuntime::configure(std::vector<PythonBlockDefinition> blocks) {
    std::unordered_set<std::string> ids;
    size_t totalBytes = 0;
    for (const auto& block : blocks) {
        if (block.blockId.empty()) throw std::invalid_argument("Python blockId cannot be empty");
        if (!ids.insert(block.blockId).second) throw std::invalid_argument("duplicate Python blockId: " + block.blockId);
        if (block.source.empty()) throw std::invalid_argument("Python block source cannot be empty: " + block.blockId);
        totalBytes += block.blockId.size() + block.source.size();
        for (const std::string& dependency : block.dependencies) {
            if (dependency.empty()) throw std::invalid_argument("Python dependency name cannot be empty: " + block.blockId);
            totalBytes += dependency.size();
        }
    }
    if (totalBytes > m_budget.pythonPayloadBytes) {
        throw std::invalid_argument("Python definitions exceed payload budget");
    }
    shutdown();
    m_blocks = std::move(blocks);
    m_faultMessage.clear();
    m_environment = {};
}

void PythonRuntime::ensureStarted() {
    if (m_health == PythonWorkerHealth::Faulted) {
        throw std::runtime_error("Python domain is Faulted; call restart() before another batch");
    }
    if (m_process && m_process->running()) return;
    if (m_blocks.empty()) throw std::runtime_error("Python runtime has no configured blocks");
    if (m_budget.maxExternalProcesses == 0) throw std::runtime_error("ResourceBudget forbids external processes");
    if (m_budget.pythonPayloadBytes == 0 || m_budget.pythonStepTimeoutMs == 0) {
        throw std::runtime_error("ResourceBudget disables Python payload or watchdog");
    }

    m_process = std::make_unique<Process>(resolvePythonExecutable(), m_budget.pythonMemoryBytes,
                                          m_budget.logBytes, m_budget.pythonPayloadBytes);
    try {
        m_process->start();
        ++m_metrics.workerStarts;
        json definitions = json::array();
        std::unordered_set<std::string> dependencySet;
        for (const auto& block : m_blocks) {
            definitions.push_back({{"blockId", block.blockId}, {"source", block.source}});
            dependencySet.insert(block.dependencies.begin(), block.dependencies.end());
        }
        std::vector<std::string> dependencies(dependencySet.begin(), dependencySet.end());
        std::sort(dependencies.begin(), dependencies.end());
        size_t sent = 0;
        size_t received = 0;
        const json response = m_process->request({{"op", "INIT"}, {"blocks", definitions}, {"dependencies", dependencies}},
                                                  startupTimeoutFrom(m_budget), sent, received);
        m_metrics.requestBytes += sent;
        m_metrics.responseBytes += received;
        if (!response.value("ok", false)) {
            throw std::runtime_error("Python initialization failed: " + response.value("error", std::string("unknown error")));
        }
        if (response.contains("environment") && response["environment"].is_object()) {
            const json& environment = response["environment"];
            m_environment.implementation = environment.value("implementation", std::string{});
            m_environment.version = environment.value("version", std::string{});
            m_environment.executable = environment.value("executable", std::string{});
            m_environment.platform = environment.value("platform", std::string{});
            m_environment.dependencies = environment.value("dependencies", std::unordered_map<std::string, std::string>{});
        }
        m_health = PythonWorkerHealth::Ready;
    } catch (const PythonTimeout& error) {
        markFaulted(error.what(), true);
        throw;
    } catch (const std::exception& error) {
        markFaulted(error.what(), false);
        throw;
    }
}

std::vector<PythonStepResult> PythonRuntime::stepBatch(uint64_t timestampNs,
                                                       const std::string& rateGroupId,
                                                       const std::vector<PythonStep>& steps) {
    ensureStarted();
    json encodedSteps = json::array();
    for (const auto& step : steps) {
        encodedSteps.push_back({{"blockId", step.blockId}, {"inputs", step.inputs}});
    }
    try {
        size_t sent = 0;
        size_t received = 0;
        const json response = m_process->request(
            {{"op", "STEP_BATCH"}, {"timestampNs", timestampNs}, {"rateGroupId", rateGroupId}, {"steps", encodedSteps}},
            timeoutFrom(m_budget), sent, received);
        m_metrics.requestBytes += sent;
        m_metrics.responseBytes += received;
        if (!response.value("ok", false)) {
            throw std::runtime_error("Python STEP_BATCH failed: " + response.value("error", std::string("unknown error")));
        }
        if (!response.contains("results") || !response["results"].is_array() || response["results"].size() != steps.size()) {
            throw std::runtime_error("Python STEP_BATCH returned an invalid result count");
        }
        std::vector<PythonStepResult> results;
        results.reserve(steps.size());
        for (size_t i = 0; i < steps.size(); ++i) {
            const json& item = response["results"][i];
            const std::string blockId = item.value("blockId", std::string{});
            if (blockId != steps[i].blockId) throw std::runtime_error("Python STEP_BATCH changed deterministic plan order");
            PythonStepResult result;
            result.blockId = blockId;
            result.outputs = item.at("outputs").get<std::unordered_map<std::string, double>>();
            results.push_back(std::move(result));
        }
        ++m_metrics.batches;
        m_metrics.steps += steps.size();
        return results;
    } catch (const PythonTimeout& error) {
        markFaulted(error.what(), true);
        throw;
    } catch (const std::exception& error) {
        markFaulted(error.what(), false);
        throw;
    }
}

void PythonRuntime::markFaulted(const std::string& message, bool timeout) {
    if (timeout) ++m_metrics.timeouts;
    else ++m_metrics.crashes;
    m_faultMessage = message;
    m_health = PythonWorkerHealth::Faulted;
    if (m_process) m_process->kill();
}

void PythonRuntime::restart() {
    if (m_process) m_process->kill();
    m_process.reset();
    m_health = PythonWorkerHealth::Stopped;
    m_faultMessage.clear();
    m_environment = {};
    ++m_metrics.restarts;
}

void PythonRuntime::shutdown() {
    if (m_process) m_process->kill();
    m_process.reset();
    m_health = PythonWorkerHealth::Stopped;
}

bool PythonRuntime::workerRunning() const { return m_process && m_process->running(); }
uint64_t PythonRuntime::workerProcessId() const { return m_process ? m_process->processId() : 0; }

std::string PythonRuntime::resolvePythonExecutable() const {
    if (!m_pythonExecutable.empty()) return m_pythonExecutable;
    if (const char* configured = std::getenv("LASECSIMUL_PYTHON"); configured && *configured) return configured;
#if defined(_WIN32)
    return "python.exe";
#else
    return "python3";
#endif
}

} // namespace lasecsimul::python

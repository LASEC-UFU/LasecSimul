#include "GhdlProcessManager.hpp"
#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdio>
#include <cwctype>
#include <map>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <vector>

#if !defined(_WIN32)
#include <cstdlib>
#endif

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX // sem isto, as macros min/max de windows.h colidem com std::min (CaseInsensitiveWideLess)
#endif
#include <windows.h>
#else
#include <csignal>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace lasecsimul::fpga {

namespace {

#if defined(_WIN32)
std::wstring widen(const std::string& s) {
    if (s.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    if (size <= 0) throw std::runtime_error("Invalid UTF-8 in GHDL command line");
    // Mesma correção de QemuProcessManager::widen(): `size` já inclui o terminador NUL (o
    // comprimento de entrada é -1) -- reservar `size - 1` e ainda pedir pra MultiByteToWideChar
    // escrever `size` wchar_t estourava um wchar_t além do intervalo gravável de std::wstring.
    std::wstring out(static_cast<size_t>(size), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.c_str(), -1, out.data(), size) != size) {
        throw std::runtime_error("Invalid UTF-8 in GHDL command line");
    }
    out.pop_back();
    return out;
}

std::wstring quoteWindowsArg(const std::string& arg) {
    std::wstring w = widen(arg);
    if (w.find_first_of(L" \t\"") == std::wstring::npos) return w;
    std::wstring out = L"\"";
    size_t backslashes = 0;
    for (wchar_t ch : w) {
        if (ch == L'\\') {
            ++backslashes;
        } else if (ch == L'"') {
            out.append(backslashes * 2 + 1, L'\\');
            out.push_back(ch);
            backslashes = 0;
        } else {
            out.append(backslashes, L'\\');
            backslashes = 0;
            out.push_back(ch);
        }
    }
    out.append(backslashes * 2, L'\\');
    out.push_back(L'"');
    return out;
}

std::wstring buildCommandLine(const GhdlLaunchSpec& spec) {
    std::wstring command = quoteWindowsArg(spec.binary);
    for (const std::string& arg : spec.args) {
        command.push_back(L' ');
        command += quoteWindowsArg(arg);
    }
    return command;
}

struct CaseInsensitiveWideLess {
    bool operator()(const std::wstring& a, const std::wstring& b) const {
        // Nomes de variavel de ambiente do Windows sao case-insensitive por convencao do SO --
        // sem isso, "Path" (herdado do processo pai) e um override nosso escrito como "PATH"
        // coexistiriam como duas entradas distintas no bloco, comportamento nao especificado.
        const size_t n = std::min(a.size(), b.size());
        for (size_t i = 0; i < n; ++i) {
            const wchar_t ca = towlower(a[i]);
            const wchar_t cb = towlower(b[i]);
            if (ca != cb) return ca < cb;
        }
        return a.size() < b.size();
    }
};

/** Bloco de ambiente pro `lpEnvironment` de CreateProcessW: copia o ambiente ATUAL do processo
 * (GHDL precisa de PATH pra achar suas próprias DLLs/libghdlvpi, entre outras coisas -- nunca um
 * ambiente vazio) e sobrepõe/adiciona as entradas de `overrides`. Formato exigido pela API:
 * pares "NOME=valor" concatenados, cada um terminado em NUL, bloco inteiro terminado em NUL duplo. */
std::wstring buildEnvironmentBlock(const std::vector<std::pair<std::string, std::string>>& overrides) {
    std::map<std::wstring, std::wstring, CaseInsensitiveWideLess> env;
    LPWCH inherited = GetEnvironmentStringsW();
    if (inherited) {
        for (LPCWSTR p = inherited; *p != L'\0';) {
            const std::wstring entry(p);
            const size_t eq = entry.find(L'=');
            // Entradas começando com '=' (ex.: "=C:=C:\algum\dir", estado de diretório-por-drive
            // do cmd.exe) não são variáveis de verdade -- pular, senão `eq==0` produziria uma
            // chave vazia.
            if (eq != std::wstring::npos && eq > 0) env[entry.substr(0, eq)] = entry.substr(eq + 1);
            p += entry.size() + 1;
        }
        FreeEnvironmentStringsW(inherited);
    }
    for (const auto& [name, value] : overrides) env[widen(name)] = widen(value);

    std::wstring block;
    for (const auto& [name, value] : env) {
        block += name;
        block += L'=';
        block += value;
        block += L'\0';
    }
    block += L'\0';
    return block;
}
#endif

} // namespace

class GhdlProcessManager::Impl {
public:
    ~Impl() { kill(); }

    void start(const GhdlLaunchSpec& spec) {
        if (spec.binary.empty()) throw std::runtime_error("GHDL binary path is empty");
        if (isRunning()) throw std::runtime_error("GHDL process is already running");
        clearProcessState();

        if (!spec.diagnostics.empty()) appendLog(spec.diagnostics.data(), spec.diagnostics.size());

#if defined(_WIN32)
        HANDLE readPipe = nullptr;
        HANDLE writePipe = nullptr;
        SECURITY_ATTRIBUTES sa{};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        if (!CreatePipe(&readPipe, &writePipe, &sa, 0)) throw std::runtime_error("Failed to create GHDL log pipe");
        SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdOutput = writePipe;
        si.hStdError = writePipe;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

        std::wstring commandLine = buildCommandLine(spec);
        std::wstring environmentBlock = buildEnvironmentBlock(spec.environmentOverrides);
        const std::wstring workingDirectory = spec.workingDirectory.empty() ? std::wstring() : widen(spec.workingDirectory);
        if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, TRUE,
                            CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                            environmentBlock.data(), workingDirectory.empty() ? nullptr : workingDirectory.c_str(),
                            &si, &m_processInfo)) {
            CloseHandle(readPipe);
            CloseHandle(writePipe);
            throw std::runtime_error("Failed to start GHDL process: " + spec.binary);
        }
        // Mesma disciplina de QemuProcessManager: prende o processo GHDL ao ciclo de vida do
        // Core (Job Object kill-on-close), pra não deixar um GHDL orfao segurando handles/arquivos
        // de build (ex.: work-obj08.cf) se o Core morrer sem dar tempo dos destrutores rodarem.
        m_job = CreateJobObjectW(nullptr, nullptr);
        if (m_job) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(
                    m_job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) ||
                !AssignProcessToJobObject(m_job, m_processInfo.hProcess)) {
                CloseHandle(m_job);
                m_job = nullptr;
                std::fprintf(stderr,
                    "[GhdlProcessManager] AVISO: nao foi possivel vincular GHDL ao Job Object; "
                    "encerramento forcado do Core pode deixar processo orfao.\n");
            }
        }
        if (ResumeThread(m_processInfo.hThread) == static_cast<DWORD>(-1)) {
            TerminateProcess(m_processInfo.hProcess, 1);
            CloseHandle(readPipe);
            CloseHandle(writePipe);
            closeProcessHandles();
            throw std::runtime_error("Failed to resume GHDL process: " + spec.binary);
        }
        CloseHandle(writePipe);
        m_running = true;
        m_reader = std::thread([this, readPipe] { readPipeLoop(readPipe); });
#else
        int pipes[2];
        if (pipe(pipes) != 0) throw std::runtime_error("Failed to create GHDL log pipe");

        m_pid = fork();
        if (m_pid < 0) {
            ::close(pipes[0]);
            ::close(pipes[1]);
            throw std::runtime_error("Failed to fork GHDL process");
        }

        if (m_pid == 0) {
            dup2(pipes[1], STDOUT_FILENO);
            dup2(pipes[1], STDERR_FILENO);
            ::close(pipes[0]);
            ::close(pipes[1]);

            // Muta o ambiente só DESTE processo filho recém-forkado (nunca o do pai) --
            // lasecsimul_vpi.c lê LASECSIMUL_FPGA_MODE/LASECSIMUL_FPGA_ARENA_NAME daqui, mesma
            // convenção do lado Windows (buildEnvironmentBlock).
            for (const auto& [name, value] : spec.environmentOverrides) {
                setenv(name.c_str(), value.c_str(), 1);
            }
            if (!spec.workingDirectory.empty() && chdir(spec.workingDirectory.c_str()) != 0) {
                _exit(126); // mesma convenção de exit code de "não consegui nem começar" do shell
            }

            std::vector<char*> argv;
            argv.reserve(spec.args.size() + 2);
            argv.push_back(const_cast<char*>(spec.binary.c_str()));
            for (const std::string& arg : spec.args) argv.push_back(const_cast<char*>(arg.c_str()));
            argv.push_back(nullptr);
            execvp(spec.binary.c_str(), argv.data());
            _exit(127);
        }

        ::close(pipes[1]);
        m_running = true;
        m_reader = std::thread([this, fd = pipes[0]] { readPipeLoop(fd); });
#endif
    }

    bool stop(std::chrono::milliseconds timeout) {
        if (!isRunning()) return true;
#if defined(_WIN32)
        const DWORD waitMs = static_cast<DWORD>(timeout.count());
        if (WaitForSingleObject(m_processInfo.hProcess, waitMs) == WAIT_OBJECT_0) {
            reapProcess();
            return true;
        }
        TerminateProcess(m_processInfo.hProcess, 1);
        reapProcess();
        return false;
#else
        ::kill(m_pid, SIGTERM);
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < deadline) {
            int status = 0;
            const pid_t result = waitpid(m_pid, &status, WNOHANG);
            if (result == m_pid) {
                m_running = false;
                joinReader();
                m_pid = -1;
                return true;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        kill();
        return false;
#endif
    }

    void kill() {
        if (!isRunning()) {
            joinReader();
            clearProcessState();
            return;
        }
#if defined(_WIN32)
        TerminateProcess(m_processInfo.hProcess, 1);
        reapProcess();
#else
        ::kill(m_pid, SIGKILL);
        int status = 0;
        waitpid(m_pid, &status, 0);
        m_running = false;
        joinReader();
        m_pid = -1;
#endif
    }

    std::optional<int> waitForExit(std::chrono::milliseconds timeout) {
#if defined(_WIN32)
        if (!m_processInfo.hProcess) return std::nullopt; // nunca iniciado ou já reapado
        const DWORD waitMs = static_cast<DWORD>(timeout.count());
        if (WaitForSingleObject(m_processInfo.hProcess, waitMs) != WAIT_OBJECT_0) return std::nullopt;
        DWORD exitCode = 0;
        GetExitCodeProcess(m_processInfo.hProcess, &exitCode);
        m_running = false;
        joinReader();
        closeProcessHandles();
        return static_cast<int>(exitCode);
#else
        if (m_pid <= 0) return std::nullopt;
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < deadline) {
            int status = 0;
            const pid_t result = waitpid(m_pid, &status, WNOHANG);
            if (result == m_pid) {
                m_running = false;
                joinReader();
                m_pid = -1;
                return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        return std::nullopt;
#endif
    }

    bool isRunning() const {
#if defined(_WIN32)
        if (!m_running || !m_processInfo.hProcess) return false;
        return WaitForSingleObject(m_processInfo.hProcess, 0) == WAIT_TIMEOUT;
#else
        if (!m_running || m_pid <= 0) return false;
        return ::kill(m_pid, 0) == 0;
#endif
    }

    std::string logs() const {
        std::lock_guard<std::mutex> lock(m_logMutex);
        return m_logs.str();
    }

private:
#if defined(_WIN32)
    void readPipeLoop(HANDLE pipe) {
        char buffer[512];
        DWORD read = 0;
        while (ReadFile(pipe, buffer, sizeof(buffer), &read, nullptr) && read > 0) appendLog(buffer, read);
        CloseHandle(pipe);
    }

    /** Mesmo achado/fix de QemuProcessManager (.spec 32.5.4/32.5.5): um processo que já recebeu
     * TerminateProcess() mas o SO/driver segura vivo no nível de kernel travaria este método pra
     * sempre com um wait INFINITE. `kProcessReapTimeout` limita a espera; se o processo ainda não
     * morreu depois dela, a limpeza é ABANDONADA (handles/thread leitor ficam pra trás de
     * propósito) em vez de travar o chamador indefinidamente -- o processo vira um órfão real, mas
     * o harness recupera o controle. */
    static constexpr std::chrono::milliseconds kProcessReapTimeout{3000};

    void reapProcess() {
        if (m_processInfo.hProcess) {
            const DWORD waited = WaitForSingleObject(
                m_processInfo.hProcess, static_cast<DWORD>(kProcessReapTimeout.count()));
            if (waited != WAIT_OBJECT_0) {
                if (m_job) {
                    CloseHandle(m_job);
                    m_job = nullptr;
                }
                TerminateProcess(m_processInfo.hProcess, 1);
                if (WaitForSingleObject(m_processInfo.hProcess, 1000) == WAIT_OBJECT_0) {
                    m_running = false;
                    joinReader();
                    closeProcessHandles();
                    return;
                }
                std::fprintf(stderr,
                    "[GhdlProcessManager] AVISO: processo GHDL nao terminou %lldms apos "
                    "TerminateProcess; abandonando limpeza para nao travar o chamador (processo "
                    "orfao remanescente).\n",
                    static_cast<long long>(kProcessReapTimeout.count()));
                m_running = false;
                if (m_reader.joinable()) m_reader.detach();
                m_processInfo = {};
                return;
            }
        }
        m_running = false;
        joinReader();
        closeProcessHandles();
    }
#else
    void readPipeLoop(int fd) {
        char buffer[512];
        ssize_t read = 0;
        while ((read = ::read(fd, buffer, sizeof(buffer))) > 0) appendLog(buffer, static_cast<size_t>(read));
        ::close(fd);
    }
#endif

    /** Mesmo teto/histerese de QemuProcessManager (achado de auditoria 2026-07-08): sem limite,
     * `m_logs` cresceria sem parar durante `ghdl -r` de um testbench longo; `kMaxLogBytes` limita
     * memória, cortando pra METADE do teto (não só até o teto) pra não re-cortar a cada
     * `appendLog` individual uma vez cruzado o limite. */
    void appendLog(const char* data, size_t len) {
        std::lock_guard<std::mutex> lock(m_logMutex);
        m_logs.write(data, static_cast<std::streamsize>(len));
        m_logBytes += len;
        if (m_logBytes > kMaxLogBytes) trimLogsLocked();
    }

    void trimLogsLocked() {
        const std::string full = m_logs.str();
        const size_t keep = kMaxLogBytes / 2;
        const std::string tail = full.size() > keep ? full.substr(full.size() - keep) : full;
        m_logs.str({});
        m_logs.clear();
        m_logs << tail;
        m_logBytes = tail.size();
    }

    void joinReader() {
        if (m_reader.joinable()) m_reader.join();
    }

    void clearProcessState() {
        closeProcessHandles();
        {
            std::lock_guard<std::mutex> lock(m_logMutex);
            m_logs.str({});
            m_logs.clear();
            m_logBytes = 0;
        }
        m_running = false;
#if defined(_WIN32)
        m_processInfo = {};
#else
        m_pid = -1;
#endif
    }

    void closeProcessHandles() {
#if defined(_WIN32)
        if (m_processInfo.hThread) {
            CloseHandle(m_processInfo.hThread);
            m_processInfo.hThread = nullptr;
        }
        if (m_processInfo.hProcess) {
            CloseHandle(m_processInfo.hProcess);
            m_processInfo.hProcess = nullptr;
        }
        if (m_job) {
            CloseHandle(m_job);
            m_job = nullptr;
        }
#endif
    }

    static constexpr size_t kMaxLogBytes = 1u << 20; // 1 MiB -- ver comentário de appendLog()

    std::atomic<bool> m_running{false};
    mutable std::mutex m_logMutex;
    std::ostringstream m_logs;
    size_t m_logBytes = 0;
    std::thread m_reader;
#if defined(_WIN32)
    PROCESS_INFORMATION m_processInfo{};
    HANDLE m_job = nullptr;
#else
    pid_t m_pid = -1;
#endif
};

GhdlProcessManager::GhdlProcessManager() : m_impl(std::make_unique<Impl>()) {}
GhdlProcessManager::~GhdlProcessManager() = default;

void GhdlProcessManager::start(const GhdlLaunchSpec& spec) { m_impl->start(spec); }
bool GhdlProcessManager::stop(std::chrono::milliseconds timeout) { return m_impl->stop(timeout); }
void GhdlProcessManager::kill() { m_impl->kill(); }
bool GhdlProcessManager::isRunning() const { return m_impl->isRunning(); }
std::string GhdlProcessManager::logs() const { return m_impl->logs(); }
std::optional<int> GhdlProcessManager::waitForExit(std::chrono::milliseconds timeout) {
    return m_impl->waitForExit(timeout);
}

} // namespace lasecsimul::fpga

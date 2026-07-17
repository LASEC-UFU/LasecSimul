#include "QemuProcessManager.hpp"
#include <atomic>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <csignal>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace lasecsimul::mcu::qemu {

namespace {

#if defined(_WIN32)
std::wstring widen(const std::string& s) {
    if (s.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    if (size <= 0) throw std::runtime_error("Invalid UTF-8 in QEMU command line");
    // `size` includes the trailing NUL because the input length is -1. Reserving `size - 1`
    // and still asking MultiByteToWideChar to write `size` wchar_t values used to overwrite one
    // wchar_t past std::wstring's writable range. On Windows that corrupted the heap immediately
    // before CreateProcessW and surfaced as 0xC0000005 after loading firmware from paths containing
    // spaces/non-ASCII characters. Keep the terminator in a temporary buffer, then remove it.
    std::wstring out(static_cast<size_t>(size), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.c_str(), -1, out.data(), size) != size) {
        throw std::runtime_error("Invalid UTF-8 in QEMU command line");
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

std::wstring buildCommandLine(const QemuLaunchSpec& spec) {
    std::wstring command = quoteWindowsArg(spec.binary);
    for (const std::string& arg : spec.args) {
        command.push_back(L' ');
        command += quoteWindowsArg(arg);
    }
    return command;
}
#endif

} // namespace

class QemuProcessManager::Impl {
public:
    ~Impl() { kill(); }

    void start(const QemuLaunchSpec& spec) {
        if (spec.binary.empty()) throw std::runtime_error("QEMU binary path is empty");
        if (isRunning()) throw std::runtime_error("QEMU process is already running");
        clearProcessState();

#if defined(_WIN32)
        HANDLE readPipe = nullptr;
        HANDLE writePipe = nullptr;
        SECURITY_ATTRIBUTES sa{};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        if (!CreatePipe(&readPipe, &writePipe, &sa, 0)) throw std::runtime_error("Failed to create QEMU log pipe");
        SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdOutput = writePipe;
        si.hStdError = writePipe;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

        std::wstring commandLine = buildCommandLine(spec);
        if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr,
                            &si, &m_processInfo)) {
            CloseHandle(readPipe);
            CloseHandle(writePipe);
            throw std::runtime_error("Failed to start QEMU process: " + spec.binary);
        }
        CloseHandle(writePipe);
        m_running = true;
        m_reader = std::thread([this, readPipe] { readPipeLoop(readPipe); });
#else
        int pipes[2];
        if (pipe(pipes) != 0) throw std::runtime_error("Failed to create QEMU log pipe");

        m_pid = fork();
        if (m_pid < 0) {
            ::close(pipes[0]);
            ::close(pipes[1]);
            throw std::runtime_error("Failed to fork QEMU process");
        }

        if (m_pid == 0) {
            dup2(pipes[1], STDOUT_FILENO);
            dup2(pipes[1], STDERR_FILENO);
            ::close(pipes[0]);
            ::close(pipes[1]);

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

    void reapProcess() {
        if (m_processInfo.hProcess) WaitForSingleObject(m_processInfo.hProcess, INFINITE);
        m_running = false;
        joinReader();
        if (m_processInfo.hThread) CloseHandle(m_processInfo.hThread);
        if (m_processInfo.hProcess) CloseHandle(m_processInfo.hProcess);
        m_processInfo = {};
    }
#else
    void readPipeLoop(int fd) {
        char buffer[512];
        ssize_t read = 0;
        while ((read = ::read(fd, buffer, sizeof(buffer))) > 0) appendLog(buffer, static_cast<size_t>(read));
        ::close(fd);
    }
#endif

    /** Sem limite, `m_logs` cresceria sem parar por toda a sessão de simulação (achado de auditoria
     * 2026-07-08) -- `logs()` é sondado a cada ~500ms enquanto o monitor serial estiver aberto
     * (`mcuCommands.ts::pollLogs`) e SEMPRE retorna o buffer INTEIRO (só o delta é usado do lado da
     * Extension), então memória do Core E dados trafegados na IPC cresciam ambos sem limite (O(n²)
     * ao longo de uma sessão longa). `kMaxLogBytes` limita memória; a histerese (corta pra METADE
     * do teto, não só até o teto) evita re-cortar a cada `appendLog` individual uma vez que o limite
     * é cruzado -- só corta de novo depois de outro kMaxLogBytes/2 de crescimento. Não implementado
     * (fora de escopo desta correção): protocolo de IPC "desde o offset X" pra nunca retransmitir o
     * que já foi lido -- mudança de protocolo maior, o cap de memória já resolve o crescimento
     * ilimitado, que era a parte mais grave do achado. */
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
#else
    pid_t m_pid = -1;
#endif
};

QemuProcessManager::QemuProcessManager() : m_impl(std::make_unique<Impl>()) {}
QemuProcessManager::~QemuProcessManager() = default;

void QemuProcessManager::start(const QemuLaunchSpec& spec) { m_impl->start(spec); }
bool QemuProcessManager::stop(std::chrono::milliseconds timeout) { return m_impl->stop(timeout); }
void QemuProcessManager::kill() { m_impl->kill(); }
bool QemuProcessManager::isRunning() const { return m_impl->isRunning(); }
std::string QemuProcessManager::logs() const { return m_impl->logs(); }

} // namespace lasecsimul::mcu::qemu

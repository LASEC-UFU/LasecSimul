#include "PlcRuntime.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <sstream>
#include <thread>

#include "lasecsimul/Sha256.hpp"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <csignal>
#include <fcntl.h>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace lasecsimul::plc {

namespace {

#if defined(_WIN32)
std::wstring widen(const std::string& text) {
    if (text.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
    std::wstring result(static_cast<size_t>(size > 0 ? size : 0), L'\0');
    if (size > 0) MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, result.data(), size);
    if (!result.empty() && result.back() == L'\0') result.pop_back();
    return result;
}

std::wstring quoteWindowsArg(const std::string& argument) {
    const std::wstring input = widen(argument);
    if (!input.empty() && input.find_first_of(L" \t\"") == std::wstring::npos) return input;
    std::wstring output = L"\"";
    size_t slashes = 0;
    for (const wchar_t ch : input) {
        if (ch == L'\\') { ++slashes; }
        else if (ch == L'"') { output.append(slashes * 2 + 1, L'\\'); output.push_back(ch); slashes = 0; }
        else { output.append(slashes, L'\\'); slashes = 0; output.push_back(ch); }
    }
    output.append(slashes * 2, L'\\');
    output.push_back(L'"');
    return output;
}
#endif

std::string trim(const std::string& text) {
    const size_t start = text.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return {};
    const size_t end = text.find_last_not_of(" \t\r\n");
    return text.substr(start, end - start + 1);
}

} // namespace

// =============================================================================
// Process -- um worker por instância, pipes stdin/stdout reais. Mesma técnica já validada em
// `PlcCompiler::validateArtifact()` (F9.3), agora como classe reaproveitável dentro de um único
// `PlcRuntime` (nunca compartilhada entre instâncias -- isolamento total é o requisito). stderr do
// worker é descartado (redirecionado pra NUL/dev-null): o protocolo `PlcScanSession` nunca escreve
// diagnóstico lá em operação normal, e crash/EOF já são detectados via saída do processo, não via
// conteúdo de stderr -- evita a complexidade de thread leitora de stderr que F8 teve.
// =============================================================================

class PlcRuntime::Process {
public:
    explicit Process(std::string executablePath) : m_executablePath(std::move(executablePath)) {}
    ~Process() { terminate(); }

    void start() {
#if defined(_WIN32)
        SECURITY_ATTRIBUTES attributes{};
        attributes.nLength = sizeof(attributes);
        attributes.bInheritHandle = TRUE;

        HANDLE childStdinRead = nullptr;
        HANDLE childStdoutWrite = nullptr;
        if (!CreatePipe(&childStdinRead, &m_stdinWrite, &attributes, 0) ||
            !CreatePipe(&m_stdoutRead, &childStdoutWrite, &attributes, 0)) {
            throw PlcRuntimeError("falha ao criar pipes do worker PLC");
        }
        SetHandleInformation(m_stdinWrite, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(m_stdoutRead, HANDLE_FLAG_INHERIT, 0);

        HANDLE nulHandle = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_WRITE | FILE_SHARE_READ,
                                       &attributes, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);

        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = childStdinRead;
        startup.hStdOutput = childStdoutWrite;
        startup.hStdError = (nulHandle != INVALID_HANDLE_VALUE) ? nulHandle : childStdoutWrite;

        std::wstring command = quoteWindowsArg(m_executablePath);
        const BOOL created = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                                            nullptr, nullptr, &startup, &m_processInfo);
        CloseHandle(childStdinRead);
        CloseHandle(childStdoutWrite);
        if (nulHandle != INVALID_HANDLE_VALUE) CloseHandle(nulHandle);
        if (!created) {
            closeHandles();
            throw PlcRuntimeError("falha ao iniciar o worker PLC: " + m_executablePath);
        }
#else
        // Sem isso, escrever no stdin de um worker que ja morreu (pipe sem leitor) manda SIGPIPE
        // pro PROPRIO Core e mata o processo inteiro por padrao -- exatamente o que "crash do
        // worker nao pode derrubar o Core" proibe. write() simplesmente devolve EPIPE/-1 em vez
        // disso, que writeLine() ja trata como falha normal.
        std::signal(SIGPIPE, SIG_IGN);

        int inputPipe[2] = {-1, -1};
        int outputPipe[2] = {-1, -1};
        if (pipe(inputPipe) != 0 || pipe(outputPipe) != 0) {
            throw PlcRuntimeError("falha ao criar pipes do worker PLC");
        }
        m_pid = fork();
        if (m_pid < 0) throw PlcRuntimeError("fork() falhou pro worker PLC");
        if (m_pid == 0) {
            setpgid(0, 0);
            const int devNull = open("/dev/null", O_WRONLY);
            dup2(inputPipe[0], STDIN_FILENO);
            dup2(outputPipe[1], STDOUT_FILENO);
            if (devNull >= 0) dup2(devNull, STDERR_FILENO);
            close(inputPipe[0]); close(inputPipe[1]);
            close(outputPipe[0]); close(outputPipe[1]);
            execl(m_executablePath.c_str(), m_executablePath.c_str(), nullptr);
            _exit(127);
        }
        setpgid(m_pid, m_pid);
        close(inputPipe[0]);
        close(outputPipe[1]);
        m_stdinFd = inputPipe[1];
        m_stdoutFd = outputPipe[0];
        fcntl(m_stdoutFd, F_SETFL, fcntl(m_stdoutFd, F_GETFL, 0) | O_NONBLOCK);
#endif
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

    /** `false` = EOF/pipe quebrado ao escrever (worker morreu) -- nunca lança, quem chama decide o
     * que fazer (marcar Faulted). */
    bool writeLine(const std::string& line) {
        const std::string wire = line + "\n";
#if defined(_WIN32)
        size_t offset = 0;
        while (offset < wire.size()) {
            DWORD written = 0;
            if (!WriteFile(m_stdinWrite, wire.data() + offset, static_cast<DWORD>(wire.size() - offset), &written, nullptr) ||
                written == 0) {
                return false;
            }
            offset += written;
        }
        return true;
#else
        size_t offset = 0;
        while (offset < wire.size()) {
            const ssize_t written = write(m_stdinFd, wire.data() + offset, wire.size() - offset);
            if (written <= 0) return false;
            offset += static_cast<size_t>(written);
        }
        return true;
#endif
    }

    /** `std::nullopt` = timeout OU EOF (worker morreu/fechou stdout) -- quem chama distingue os
     * dois checando `running()` depois, se precisar; pro propósito de "nunca publicar resultado
     * parcial", os dois casos são tratados igual (Faulted, sem resultado). */
    std::optional<std::string> readLine(std::chrono::milliseconds timeout) {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        for (;;) {
            const size_t newline = m_buffer.find('\n');
            if (newline != std::string::npos) {
                std::string line = m_buffer.substr(0, newline);
                m_buffer.erase(0, newline + 1);
                return line;
            }
            // IMPORTANTE: sempre tenta drenar o pipe ANTES de checar `running()`. Um worker que
            // escreve a resposta e sai imediatamente em seguida (varios modos do
            // `misbehaving_worker` de teste, e cenarios reais de crash logo apos responder) pode
            // ja ter saido no momento em que checamos -- os bytes continuam disponiveis no buffer
            // do pipe do kernel independente do processo ainda existir, entao checar `running()`
            // primeiro e descartar sem tentar ler perde essa resposta por uma corrida de tempo.
            // So trata como EOF quando o pipe realmente nao tem mais nada E (peek falhou/pipe
            // quebrado OU o processo ja nao esta rodando).
#if defined(_WIN32)
            DWORD available = 0;
            const BOOL peeked = PeekNamedPipe(m_stdoutRead, nullptr, 0, nullptr, &available, nullptr);
            if (peeked && available > 0) {
                char chunk[4096];
                DWORD count = 0;
                if (!ReadFile(m_stdoutRead, chunk, sizeof(chunk), &count, nullptr)) return std::nullopt;
                m_buffer.append(chunk, count);
                continue;
            }
            if (!peeked || !running()) return std::nullopt;
#else
            struct pollfd descriptor { m_stdoutFd, POLLIN, 0 };
            const int ready = poll(&descriptor, 1, 20);
            if (ready > 0 && (descriptor.revents & POLLIN)) {
                char chunk[4096];
                const ssize_t count = read(m_stdoutFd, chunk, sizeof(chunk));
                if (count > 0) { m_buffer.append(chunk, static_cast<size_t>(count)); continue; }
                if (count == 0) return std::nullopt; // EOF de verdade -- writer fechou o lado dele.
            }
            if (ready < 0 || !running()) return std::nullopt;
#endif
            if (std::chrono::steady_clock::now() >= deadline) return std::nullopt;
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }

    /** Idempotente -- termina o processo se ainda estiver rodando, fecha handles. Nunca lança. */
    void terminate() {
#if defined(_WIN32)
        if (m_processInfo.hProcess && WaitForSingleObject(m_processInfo.hProcess, 0) == WAIT_TIMEOUT) {
            TerminateProcess(m_processInfo.hProcess, 1);
            WaitForSingleObject(m_processInfo.hProcess, 2000);
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
#endif
    }

    /** Espera o processo sair SOZINHO (depois de SHUTDOWN já ter sido mandado) -- não força nada.
     * `true` = saiu dentro do prazo. */
    bool waitForExit(std::chrono::milliseconds timeout) {
#if defined(_WIN32)
        if (!m_processInfo.hProcess) return true;
        return WaitForSingleObject(m_processInfo.hProcess, static_cast<DWORD>(timeout.count())) == WAIT_OBJECT_0;
#else
        if (m_pid <= 0) return true;
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < deadline) {
            if (!running()) return true;
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        return !running();
#endif
    }

private:
#if defined(_WIN32)
    void closeHandles() {
        if (m_processInfo.hThread) { CloseHandle(m_processInfo.hThread); m_processInfo.hThread = nullptr; }
        if (m_processInfo.hProcess) { CloseHandle(m_processInfo.hProcess); m_processInfo.hProcess = nullptr; }
        if (m_stdinWrite) { CloseHandle(m_stdinWrite); m_stdinWrite = nullptr; }
        if (m_stdoutRead) { CloseHandle(m_stdoutRead); m_stdoutRead = nullptr; }
        m_processInfo = {};
    }
    HANDLE m_stdinWrite = nullptr;
    HANDLE m_stdoutRead = nullptr;
    PROCESS_INFORMATION m_processInfo{};
#else
    mutable pid_t m_pid = -1;
    int m_stdinFd = -1;
    int m_stdoutFd = -1;
#endif
    std::string m_executablePath;
    std::string m_buffer;
};

// =============================================================================
// PlcRuntime
// =============================================================================

PlcRuntime::PlcRuntime(PlcNativeModule module, PlcRuntimeOptions options)
    : m_module(std::move(module)), m_options(options) {}

PlcRuntime::~PlcRuntime() { forceKill(); }

void PlcRuntime::markFaulted(const std::string& message) {
    m_faultMessage = message;
    m_state = PlcRuntimeState::Faulted;
    if (m_process) m_process->terminate();
    m_process.reset();
}

std::string PlcRuntime::nextRequestId() {
    return "r" + std::to_string(++m_requestSequence);
}

std::string PlcRuntime::sendRequestExpectingOk(const std::string& commandName, const std::string& args) {
    if (m_state != PlcRuntimeState::Ready && m_state != PlcRuntimeState::Starting) {
        throw PlcRuntimeError("PlcRuntime nao esta pronto (estado atual != Ready/Starting)");
    }
    const std::string requestId = nextRequestId();
    const std::string line = args.empty() ? (commandName + " " + requestId) : (commandName + " " + requestId + " " + args);
    if (!m_process->writeLine(line)) {
        markFaulted("falha ao escrever no worker PLC (pipe fechado -- processo provavelmente morreu)");
        throw PlcRuntimeError(m_faultMessage);
    }
    const auto response = m_process->readLine(std::chrono::milliseconds(m_options.stepTimeoutMs));
    if (!response) {
        const bool stillRunning = m_process && m_process->running();
        markFaulted(stillRunning ? "timeout esperando resposta do worker PLC para " + commandName
                                 : "worker PLC encerrou inesperadamente (EOF) durante " + commandName);
        throw PlcRuntimeError(m_faultMessage);
    }

    std::istringstream stream(*response);
    std::string status;
    std::string responseRequestId;
    if (!(stream >> status) || !(stream >> responseRequestId)) {
        markFaulted("resposta malformada do worker PLC: " + *response);
        throw PlcRuntimeError(m_faultMessage);
    }
    if (responseRequestId != requestId) {
        markFaulted("requestId incorreto na resposta do worker PLC: esperado " + requestId + ", recebido " + responseRequestId);
        throw PlcRuntimeError(m_faultMessage);
    }
    std::string rest;
    std::getline(stream, rest);
    rest = trim(rest);

    if (status == "OK") return rest;
    if (status == "ERR") {
        markFaulted("worker PLC recusou " + commandName + ": " + rest);
        throw PlcRuntimeError(m_faultMessage);
    }
    markFaulted("resposta com status desconhecido do worker PLC: " + *response);
    throw PlcRuntimeError(m_faultMessage);
}

void PlcRuntime::ensureStarted() {
    if (m_state == PlcRuntimeState::Ready) return;
    if (m_state == PlcRuntimeState::Faulted) {
        throw PlcRuntimeError("PlcRuntime esta Faulted; chame restart()/reset() antes de continuar");
    }

    const std::string actualHash = Sha256::hashFile(m_module.nativeBinaryRef);
    if (actualHash.empty() || actualHash != m_module.artifactHash) {
        markFaulted("artifactHash nao bate com o binario em " + m_module.nativeBinaryRef +
                    " (esperado " + m_module.artifactHash + ", obtido " + (actualHash.empty() ? "<arquivo ilegivel>" : actualHash) + ")");
        throw PlcRuntimeError(m_faultMessage);
    }

    m_state = PlcRuntimeState::Starting;
    m_process = std::make_unique<Process>(m_module.nativeBinaryRef);
    try {
        m_process->start();
    } catch (const PlcRuntimeError& error) {
        markFaulted(error.what());
        throw;
    }

    const std::string helloResponse = sendRequestExpectingOk("HELLO", "");
    // Formato: "protocol=<N> program=<NOME>" -- mesmo que PlcScanSession::handleHello (F9.2) gera.
    uint32_t protocolVersion = 0;
    std::string programField;
    {
        std::istringstream stream(helloResponse);
        std::string protocolField;
        stream >> protocolField >> programField;
        const size_t eq = protocolField.find('=');
        if (eq != std::string::npos) {
            try { protocolVersion = static_cast<uint32_t>(std::stoul(protocolField.substr(eq + 1))); }
            catch (...) { protocolVersion = 0; }
        }
        const size_t programEq = programField.find('=');
        if (programEq != std::string::npos) programField = programField.substr(programEq + 1);
    }
    if (protocolVersion != m_module.workerProtocolVersion) {
        markFaulted("workerProtocolVersion incompativel: PlcNativeModule diz " +
                    std::to_string(m_module.workerProtocolVersion) + ", worker respondeu " + std::to_string(protocolVersion));
        throw PlcRuntimeError(m_faultMessage);
    }
    std::string expectedProgramUpper = m_module.programName;
    std::transform(expectedProgramUpper.begin(), expectedProgramUpper.end(), expectedProgramUpper.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    if (programField != expectedProgramUpper) {
        markFaulted("identidade do worker PLC inesperada: PlcNativeModule diz " + expectedProgramUpper +
                    ", worker respondeu " + programField);
        throw PlcRuntimeError(m_faultMessage);
    }

    m_state = PlcRuntimeState::Ready;
    m_hasScanned = false;
    m_lastAcceptedTimeNs = -1;
}

PlcScanResult PlcRuntime::scan(const PlcScanRequest& request) {
    ensureStarted();
    if (m_hasScanned && request.simulationTimeNs <= m_lastAcceptedTimeNs) {
        throw PlcRuntimeError("simulationTimeNs deve ser estritamente maior que o ultimo scan aceito (" +
                              std::to_string(m_lastAcceptedTimeNs) + "), recebido " + std::to_string(request.simulationTimeNs));
        // Nota: esta checagem é redundante com a que o PlcScanSession (F9.2) já faz do lado do
        // worker -- mantida aqui TAMBÉM pra rejeitar ANTES de sequer mandar a requisição, evitando
        // gastar um round-trip inteiro com algo que o Core já sabe que vai falhar. Não é uma
        // segunda fonte de verdade divergente: os dois usam a MESMA regra (estritamente maior).
    }

    std::string args = std::to_string(request.simulationTimeNs);
    for (const auto& [name, value] : request.inputs) {
        args += " " + name + "=" + value;
    }
    const std::string response = sendRequestExpectingOk("SCAN", args);

    PlcScanResult result;
    std::istringstream stream(response);
    std::string token;
    while (stream >> token) {
        const size_t eq = token.find('=');
        if (eq == std::string::npos) {
            markFaulted("resposta de SCAN com par nome=valor malformado: " + token);
            throw PlcRuntimeError(m_faultMessage);
        }
        result.outputs[token.substr(0, eq)] = token.substr(eq + 1);
    }

    // Só atualiza o estado do lado do Core DEPOIS de ter parseado a resposta inteira com sucesso --
    // se qualquer coisa acima tivesse lançado, m_lastAcceptedTimeNs/m_hasScanned continuariam com o
    // valor anterior, nunca um estado "meio avançado".
    m_hasScanned = true;
    m_lastAcceptedTimeNs = request.simulationTimeNs;
    return result;
}

std::string PlcRuntime::get(const std::string& qualifiedName) {
    return sendRequestExpectingOk("GET", qualifiedName);
}
std::string PlcRuntime::set(const std::string& qualifiedName, const std::string& value) {
    return sendRequestExpectingOk("SET", qualifiedName + " " + value);
}
std::string PlcRuntime::force(const std::string& qualifiedName, const std::string& value) {
    return sendRequestExpectingOk("FORCE", qualifiedName + " " + value);
}
std::string PlcRuntime::unforce(const std::string& qualifiedName) {
    return sendRequestExpectingOk("UNFORCE", qualifiedName);
}

void PlcRuntime::reset() {
    // Nesta rodada, reset = matar o worker atual + subir um novo (novo processo, handshake do
    // zero) -- garante estado inicial conhecido de forma determinística sem implementar a
    // semantica IEC completa de Cold/Warm Reset (RETAIN, etc. -- ver plano F9 Rodada 1). O comando
    // RESET do proprio protocolo PlcScanSession (F9.2, reinicializa a instancia NO MESMO processo)
    // fica reservado para quando fizer sentido reaproveitar o processo em vez de respawnar --
    // nao usado aqui para nao introduzir dois caminhos de "reset" com garantias sutilmente
    // diferentes nesta rodada.
    if (m_process) m_process->terminate();
    m_process.reset();
    m_state = PlcRuntimeState::Stopped;
    m_faultMessage.clear();
    m_hasScanned = false;
    m_lastAcceptedTimeNs = -1;
    ensureStarted();
}

void PlcRuntime::restart() { reset(); }

void PlcRuntime::shutdown() {
    if (m_state == PlcRuntimeState::Stopped) return;
    if (m_process && m_process->running()) {
        const std::string requestId = nextRequestId();
        m_process->writeLine("SHUTDOWN " + requestId);
        m_process->waitForExit(std::chrono::milliseconds(m_options.shutdownTimeoutMs));
    }
    forceKill();
}

void PlcRuntime::forceKill() {
    if (m_process) m_process->terminate();
    m_process.reset();
    m_state = PlcRuntimeState::Stopped;
}

bool PlcRuntime::workerRunning() const { return m_process && m_process->running(); }
uint64_t PlcRuntime::workerProcessId() const { return m_process ? m_process->processId() : 0; }

} // namespace lasecsimul::plc

#include "IpcServer.hpp"
#include <nlohmann/json.hpp>
#include <cstdio>
#include <stdexcept>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#else
#  include <sys/socket.h>
#  include <sys/un.h>
#  include <unistd.h>
#  include <cerrno>
#  include <cstring>
#endif

namespace lasecsimul::ipc {

// ── construtor / destrutor ─────────────────────────────────────────────────────

IpcServer::IpcServer(std::string pipeName)
    : m_pipeName(std::move(pipeName)) {}

IpcServer::~IpcServer() {
#ifdef _WIN32
    if (m_pipe && m_pipe != INVALID_HANDLE_VALUE) {
        CloseHandle(static_cast<HANDLE>(m_pipe));
    }
#else
    if (m_clientFd >= 0) close(m_clientFd);
    if (m_serverFd >= 0) close(m_serverFd);
    if (!m_sockPath.empty()) unlink(m_sockPath.c_str());
#endif
}

// ── API pública ────────────────────────────────────────────────────────────────

void IpcServer::setMessageHandler(MessageHandler handler) {
    m_handler = std::move(handler);
}

int IpcServer::run() {
    if (!openServer()) return 1;
    if (!acceptClient()) return 1;
    processLoop();
    return 0;
}

void IpcServer::shutdown() {
    m_shutdown = true;
}

void IpcServer::sendNotification(const OutgoingNotification& n) {
    sendLine(buildNotification(n));
}

// ── serialização ──────────────────────────────────────────────────────────────

std::string IpcServer::buildResponse(const OutgoingResponse& resp) {
    nlohmann::json j;
    j["id"] = resp.id;
    j["ok"] = resp.ok;
    if (!resp.payloadJson.empty()) {
        j["payload"] = nlohmann::json::parse(resp.payloadJson);
    } else if (resp.ok) {
        j["payload"] = nlohmann::json::object();
    }
    if (!resp.ok) {
        j["error"] = resp.error;
    }
    return j.dump();
}

std::string IpcServer::buildNotification(const OutgoingNotification& n) {
    nlohmann::json j;
    j["type"] = n.type;
    if (!n.payloadJson.empty()) {
        j["payload"] = nlohmann::json::parse(n.payloadJson);
    } else {
        j["payload"] = nlohmann::json::object();
    }
    return j.dump();
}

bool IpcServer::parseMessage(const std::string& line, IncomingMessage& out) {
    try {
        auto j = nlohmann::json::parse(line);
        out.id              = j.value("id", "");
        out.type            = j.value("type", "");
        out.protocolVersion = j.value("protocolVersion", 0);
        if (j.contains("payload")) {
            out.payloadJson = j["payload"].dump();
        }
        return true;
    } catch (...) {
        return false;
    }
}

// ── plataforma: abrir servidor ─────────────────────────────────────────────────

#ifdef _WIN32

bool IpcServer::openServer() {
    const std::string fullPath = "\\\\.\\pipe\\" + m_pipeName;
    HANDLE h = CreateNamedPipeA(
        fullPath.c_str(),
        PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        1,        // máximo de instâncias
        4096, 4096, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        std::fprintf(stderr, "[IpcServer] CreateNamedPipe falhou: %lu\n", GetLastError());
        return false;
    }
    m_pipe = h;
    return true;
}

bool IpcServer::acceptClient() {
    BOOL ok = ConnectNamedPipe(static_cast<HANDLE>(m_pipe), nullptr);
    if (!ok && GetLastError() != ERROR_PIPE_CONNECTED) {
        std::fprintf(stderr, "[IpcServer] ConnectNamedPipe falhou: %lu\n", GetLastError());
        return false;
    }
    return true;
}

bool IpcServer::sendLine(const std::string& line) {
    const std::string msg = line + "\n";
    DWORD written = 0;
    return WriteFile(static_cast<HANDLE>(m_pipe), msg.data(),
                     static_cast<DWORD>(msg.size()), &written, nullptr) == TRUE;
}

std::string IpcServer::readLine(bool& eof) {
    for (;;) {
        if (const size_t pos = m_readBuffer.find('\n'); pos != std::string::npos) {
            std::string line = m_readBuffer.substr(0, pos);
            m_readBuffer.erase(0, pos + 1);
            return line;
        }
        char chunk[4096];
        DWORD nRead = 0;
        BOOL ok = ReadFile(static_cast<HANDLE>(m_pipe), chunk, sizeof(chunk), &nRead, nullptr);
        if (!ok || nRead == 0) {
            eof = true;
            std::string rest = std::move(m_readBuffer);
            m_readBuffer.clear();
            return rest;
        }
        m_readBuffer.append(chunk, nRead);
    }
}

#else // POSIX

bool IpcServer::openServer() {
    const char* tmpDir = getenv("TMPDIR");
    if (!tmpDir || tmpDir[0] == '\0') tmpDir = "/tmp";
    m_sockPath = std::string(tmpDir) + "/" + m_pipeName + ".sock";

    m_serverFd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (m_serverFd < 0) {
        std::fprintf(stderr, "[IpcServer] socket() falhou: %s\n", strerror(errno));
        return false;
    }
    // Remove socket antigo para evitar EADDRINUSE
    unlink(m_sockPath.c_str());

    struct sockaddr_un addr = {};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, m_sockPath.c_str(), sizeof(addr.sun_path) - 1);

    if (bind(m_serverFd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::fprintf(stderr, "[IpcServer] bind() falhou (%s): %s\n", m_sockPath.c_str(), strerror(errno));
        return false;
    }
    if (listen(m_serverFd, 1) < 0) {
        std::fprintf(stderr, "[IpcServer] listen() falhou: %s\n", strerror(errno));
        return false;
    }
    return true;
}

bool IpcServer::acceptClient() {
    m_clientFd = accept(m_serverFd, nullptr, nullptr);
    if (m_clientFd < 0) {
        std::fprintf(stderr, "[IpcServer] accept() falhou: %s\n", strerror(errno));
        return false;
    }
    // O socket de escuta não é mais necessário após aceitar o único cliente
    close(m_serverFd);
    m_serverFd = -1;
    return true;
}

bool IpcServer::sendLine(const std::string& line) {
    const std::string msg = line + "\n";
    ssize_t total = 0;
    const ssize_t len = static_cast<ssize_t>(msg.size());
    while (total < len) {
        ssize_t n = write(m_clientFd, msg.data() + total, static_cast<size_t>(len - total));
        if (n <= 0) return false;
        total += n;
    }
    return true;
}

std::string IpcServer::readLine(bool& eof) {
    for (;;) {
        if (const size_t pos = m_readBuffer.find('\n'); pos != std::string::npos) {
            std::string line = m_readBuffer.substr(0, pos);
            m_readBuffer.erase(0, pos + 1);
            return line;
        }
        char chunk[4096];
        ssize_t n = read(m_clientFd, chunk, sizeof(chunk));
        if (n <= 0) {
            eof = true;
            std::string rest = std::move(m_readBuffer);
            m_readBuffer.clear();
            return rest;
        }
        m_readBuffer.append(chunk, static_cast<size_t>(n));
    }
}

#endif // _WIN32

// ── loop de processamento (independente de plataforma) ─────────────────────────

void IpcServer::processLoop() {
    while (!m_shutdown) {
        bool eof = false;
        std::string line = readLine(eof);
        if (eof) break;
        const std::string trimmed = [&] {
            size_t s = line.find_first_not_of(" \t\r");
            size_t e = line.find_last_not_of(" \t\r");
            return (s == std::string::npos) ? std::string{} : line.substr(s, e - s + 1);
        }();
        if (trimmed.empty()) continue;

        IncomingMessage msg;
        if (!parseMessage(trimmed, msg)) {
            // mensagem malformada — envia erro sem id
            OutgoingResponse errResp;
            errResp.id = "";
            errResp.ok = false;
            errResp.error = "mensagem JSON inválida";
            sendLine(buildResponse(errResp));
            continue;
        }

        OutgoingResponse resp;
        if (m_handler) {
            resp = m_handler(msg);
        } else {
            resp.id = msg.id;
            resp.ok = false;
            resp.error = "nenhum handler registrado";
        }
        sendLine(buildResponse(resp));
    }
}

} // namespace lasecsimul::ipc

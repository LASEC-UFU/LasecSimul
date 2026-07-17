#pragma once
#include <atomic>
#include <functional>
#include <string>
#include <mutex>
#include <condition_variable>
#include <deque>
#include <thread>
#include "Protocol.hpp"

namespace lasecsimul::ipc {

using MessageHandler = std::function<OutgoingResponse(const IncomingMessage&)>;

/**
 * Servidor IPC que aceita UMA conexão em named pipe (Win32) ou unix socket (POSIX).
 * Protocolo de transporte: newline-delimited JSON — cada mensagem é uma linha JSON terminada em \n.
 *
 * O método run() bloqueia até que o cliente se desconecte ou shutdown() seja chamado (de dentro
 * do MessageHandler). A thread do Scheduler corre separadamente — run() não precisa ser
 * chamado numa thread dedicada extra, basta que o bootstrap não precise de outro work no main.
 *
 * Não copyable nem movable.
 */
class IpcServer {
public:
    struct MetricsSnapshot {
        bool enabled = false;
        uint64_t requests = 0;
        uint64_t notifications = 0;
        uint64_t receivedBytes = 0;
        uint64_t sentBytes = 0;
        uint64_t parseNanoseconds = 0;
        uint64_t handlerNanoseconds = 0;
        uint64_t serializationNanoseconds = 0;
        uint64_t notificationQueueDepth = 0;
        uint64_t maxNotificationQueueDepth = 0;
    };
    explicit IpcServer(std::string pipeName);
    ~IpcServer();

    IpcServer(const IpcServer&) = delete;
    IpcServer& operator=(const IpcServer&) = delete;

    /** Define o handler que processa cada mensagem recebida e retorna a resposta. */
    void setMessageHandler(MessageHandler handler);

    /**
     * Abre o pipe/socket, aguarda a conexão do cliente e processa mensagens até shutdown() ser
     * chamado (dentro do handler) ou a conexão ser encerrada.
     * Retorna o código de saída: 0 = shutdown limpo, 1 = erro de transporte.
     */
    int run();

    /** Sinaliza encerramento limpo. Deve ser chamado dentro do MessageHandler. */
    void shutdown();
    bool sendNotification(const std::string& type, const std::string& payloadJson);
    void setProfilingEnabled(bool enabled) { m_profilingEnabled.store(enabled, std::memory_order_relaxed); }
    void resetMetrics();
    MetricsSnapshot metrics() const;

private:
    std::string m_pipeName;
    MessageHandler m_handler;
    bool m_shutdown = false;
    // Sobra de bytes já lidos do transporte que ainda não formam uma linha completa -- readLine()
    // lê em blocos (ver IpcServer.cpp) em vez de 1 byte por syscall, então o que vier depois do
    // último '\n' de um bloco fica aqui até o próximo readLine() completar a linha.
    std::string m_readBuffer;
    std::mutex m_sendMutex;
    std::mutex m_notificationMutex;
    std::condition_variable m_notificationWake;
    std::deque<std::string> m_notificationQueue;
    bool m_notificationStop = false;
    std::thread m_notificationThread;
    std::atomic<bool> m_profilingEnabled{false};
    std::atomic<uint64_t> m_requests{0};
    std::atomic<uint64_t> m_notifications{0};
    std::atomic<uint64_t> m_receivedBytes{0};
    std::atomic<uint64_t> m_sentBytes{0};
    std::atomic<uint64_t> m_parseNanoseconds{0};
    std::atomic<uint64_t> m_handlerNanoseconds{0};
    std::atomic<uint64_t> m_serializationNanoseconds{0};
    std::atomic<uint64_t> m_notificationQueueDepth{0};
    std::atomic<uint64_t> m_maxNotificationQueueDepth{0};

#ifdef _WIN32
    void* m_pipe = nullptr; // HANDLE
#else
    int m_serverFd = -1;
    int m_clientFd = -1;
    std::string m_sockPath;
#endif

    bool openServer();
    bool acceptClient();
    void processLoop();
    bool sendLine(const std::string& line);
    void notificationLoop();
    std::string readLine(bool& eof);

    static std::string buildResponse(const OutgoingResponse& resp);
    static bool parseMessage(const std::string& line, IncomingMessage& out);
};

} // namespace lasecsimul::ipc

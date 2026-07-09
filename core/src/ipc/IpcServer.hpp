#pragma once
#include <functional>
#include <string>
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

private:
    std::string m_pipeName;
    MessageHandler m_handler;
    bool m_shutdown = false;
    // Sobra de bytes já lidos do transporte que ainda não formam uma linha completa -- readLine()
    // lê em blocos (ver IpcServer.cpp) em vez de 1 byte por syscall, então o que vier depois do
    // último '\n' de um bloco fica aqui até o próximo readLine() completar a linha.
    std::string m_readBuffer;

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
    std::string readLine(bool& eof);

    static std::string buildResponse(const OutgoingResponse& resp);
    static bool parseMessage(const std::string& line, IncomingMessage& out);
};

} // namespace lasecsimul::ipc

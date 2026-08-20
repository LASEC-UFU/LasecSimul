#pragma once

/**
 * Worker isolado por instância PLC (F9.4) -- spawna o binário de um `PlcNativeModule` (F9.3) como
 * processo separado, fala o protocolo `PlcScanSession` (F9.2: HELLO/RESET/SCAN/GET/SET/FORCE/
 * UNFORCE/SHUTDOWN, tudo com `requestId`) via stdin/stdout reais. Implementação PRÓPRIA -- não
 * reaproveita `PythonRuntime::Process` (F8, domínio diferente) nem `GhdlProcessManager` (padrão
 * distinto, processo de longa duração com lockstep) como base compartilhada; ambos serviram só de
 * referência de comportamento, conforme decisão do plano F9 (poucos usuários não justificam
 * abstração agora, mesma razão já documentada em `GhdlBackend.hpp` pra não unificar
 * `QemuProcessManager`/`GhdlProcessManager`).
 *
 * Sem integração com `SimulationSession`/`Scheduler` nesta rodada -- isso é F9.5. `PlcRuntime` só
 * sabe gerenciar UM worker isolado.
 */

#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>

#include "PlcNativeModule.hpp"

namespace lasecsimul::plc {

enum class PlcRuntimeState : uint8_t {
    Stopped,  // nenhum processo worker rodando
    Starting, // processo criado, handshake HELLO ainda nao confirmado
    Ready,    // handshake validado (workerProtocolVersion + program name) -- aceita SCAN/GET/SET/...
    Faulted,  // timeout, EOF inesperado, resposta malformada ou requestId incorreto -- exige
              // restart() explicito antes de qualquer nova operacao
};

struct PlcRuntimeOptions {
    uint32_t handshakeTimeoutMs = 5000;
    uint32_t stepTimeoutMs = 5000;   // usado por SCAN/GET/SET/FORCE/UNFORCE/RESET
    uint32_t shutdownTimeoutMs = 3000; // espera apos mandar SHUTDOWN antes de considerar travado
};

struct PlcScanRequest {
    int64_t simulationTimeNs = 0;
    std::unordered_map<std::string, std::string> inputs; // nome (ex.: "DI0") -> valor textual
};

struct PlcScanResult {
    std::unordered_map<std::string, std::string> outputs;
};

/** Lançada por qualquer operação que falhe -- a instância sempre transita pra `Faulted` antes de
 * lançar (nunca deixa o estado ambíguo). `faultMessage()`/`state()` continuam consultáveis depois. */
class PlcRuntimeError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class PlcRuntime {
public:
    explicit PlcRuntime(PlcNativeModule module, PlcRuntimeOptions options = {});
    ~PlcRuntime();

    PlcRuntime(const PlcRuntime&) = delete;
    PlcRuntime& operator=(const PlcRuntime&) = delete;

    /** Verifica `artifactHash` contra o arquivo real de `nativeBinaryRef` (nunca spawna um binário
     * que não bate com o hash gravado no módulo), spawna o processo, manda HELLO e valida
     * `workerProtocolVersion`/nome do programa na resposta antes de marcar `Ready`. Idempotente:
     * chamar de novo com o estado já `Ready` é no-op. Lança `PlcRuntimeError` (e fica `Faulted`) se
     * qualquer passo falhar. */
    void ensureStarted();

    /** UM scan -- exige `Ready` (chama `ensureStarted()` internamente). `simulationTimeNs` deve
     * ser estritamente maior que o último aceito (mesmo contrato provado em F9.2 -- `PlcRuntime`
     * não relaxa isso, só repassa pro worker e valida a resposta). Nunca devolve um `PlcScanResult`
     * parcial: timeout, EOF, resposta malformada ou `requestId` incorreto viram `PlcRuntimeError`
     * (e `Faulted`) ANTES de qualquer saída ser interpretada -- quem chama nunca vê output parcial. */
    PlcScanResult scan(const PlcScanRequest& request);

    /** `qualifiedName` no formato `PROGRAMA.VARIAVEL` (ex.: `"HELLO.DO0"`). Nenhum destes avança
     * `simulationTimeNs`/executa `run()` -- garantido pelo próprio `PlcScanSession` (F9.2), aqui só
     * repassados e validados (requestId, formato de resposta). */
    std::string get(const std::string& qualifiedName);
    std::string set(const std::string& qualifiedName, const std::string& value);
    std::string force(const std::string& qualifiedName, const std::string& value);
    std::string unforce(const std::string& qualifiedName);

    /** Reinicialização determinística do estado da instância: mata o worker atual e sobe um novo
     * (novo processo, novo handshake) -- escopo desta rodada é "estado inicial conhecido", não a
     * semântica IEC completa de Cold/Warm Reset (RETAIN, etc.) -- ver plano F9 Rodada 1. */
    void reset();

    /** Alias semântico de `reset()` nesta rodada -- mesma implementação (mata + sobe de novo +
     * handshake). Mantido como nome próprio porque o vocabulário de "restart após fault" e "reset
     * determinístico de instância" são conceitualmente distintos mesmo compartilhando mecanismo
     * agora; podem divergir quando RETAIN/Cold/Warm Reset ganharem semântica própria. */
    void restart();

    /** Encerramento limpo: manda SHUTDOWN, espera o processo sair sozinho até
     * `shutdownTimeoutMs`; se não sair, força (`forceKill()`). Sempre deixa `Stopped`. Idempotente. */
    void shutdown();

    /** Encerramento forçado imediato (worker travado) -- nunca manda SHUTDOWN, nunca espera
     * resposta. Sempre deixa `Stopped`. Idempotente. */
    void forceKill();

    PlcRuntimeState state() const { return m_state; }
    const std::string& faultMessage() const { return m_faultMessage; }
    bool workerRunning() const;
    uint64_t workerProcessId() const;
    uint64_t requestSequence() const { return m_requestSequence; }
    int64_t lastAcceptedSimulationTimeNs() const { return m_lastAcceptedTimeNs; }

private:
    class Process;

    void markFaulted(const std::string& message);
    std::string nextRequestId();
    /** Manda `command` já formatado (sem requestId -- adiciona aqui) e devolve a resposta JÁ COM O
     * PREFIXO `OK <requestId> `/`ERR <requestId> ` removido. Lança (e marca `Faulted`) em timeout,
     * EOF, requestId de volta diferente do enviado, ou uma resposta `ERR`. */
    std::string sendRequestExpectingOk(const std::string& commandName, const std::string& args);

    PlcNativeModule m_module;
    PlcRuntimeOptions m_options;
    std::unique_ptr<Process> m_process;
    PlcRuntimeState m_state = PlcRuntimeState::Stopped;
    std::string m_faultMessage;
    uint64_t m_requestSequence = 0;
    bool m_hasScanned = false;
    int64_t m_lastAcceptedTimeNs = -1;
};

} // namespace lasecsimul::plc

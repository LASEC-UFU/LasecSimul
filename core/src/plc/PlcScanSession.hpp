#pragma once

/**
 * Núcleo testável do protocolo de scan do worker PLC (F9.2) -- código PRÓPRIO do LasecSimul, não
 * vendorizado da STruCpp. Implementa exatamente o contrato decidido no plano F9 Rodada 1:
 *
 *   HELLO -> handshake/versão do protocolo
 *   RESET -> reinicializa a instância do PROGRAM e o relógio simulado conhecido
 *   SCAN <requestId> <simulationTimeNs> [entrada=valor ...] -> UM scan, I/O atômico
 *   GET/SET/FORCE/UNFORCE <requestId> <programa>.<var> -> nunca avança __CURRENT_TIME_NS/run()
 *   SHUTDOWN -> encerra
 *
 * `simulationTimeNs` é monotônico: SCAN com tempo <= último aceito é rejeitado ANTES de tocar
 * __CURRENT_TIME_NS/run() (achado real, 2026-08-20: TIME() da STruCpp lê __CURRENT_TIME_NS, uma
 * variável global simples -- ver iec_std_lib.hpp -- então qualquer garantia de monotonicidade é
 * responsabilidade de quem chama, não da runtime STruCpp em si).
 *
 * I/O atômico: SCAN valida TODOS os pares nome=valor (existência da variável + valor parseável
 * pro tipo) numa passada que não toca nenhum ponteiro real antes de aplicar qualquer um -- se
 * qualquer par falhar, nenhuma variável de entrada é alterada e run() não é chamado.
 *
 * Não implementado nesta rodada (reservado no protocolo, ver `handleLine`): PAUSE, CONTINUE,
 * STEP_SCAN (SCAN já é um único passo -- STEP_SCAN fica reservado como nome futuro caso um modo
 * "step" com semântica distinta de SCAN normal seja necessário), SET_BREAKPOINT, CLEAR_BREAKPOINT.
 */

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "PlcVariableCommands.hpp"

namespace lasecsimul::plc {

/** Um `PROGRAM` só nesta rodada (sem symbol table/linker cross-language, sem múltiplas tasks) --
 * ver plano F9 Rodada 1, "Mudanças mínimas", RETAIN/reset. */
class PlcScanSession {
public:
    /** `resetInstance`: reconstrói a instância concreta do PROGRAM (ex.:
     * `new (&prog_HELLO) Program_HELLO();`, placement-new no MESMO endereço -- os ponteiros já
     * resolvidos em `inputVars`/`outputVars`/`program.vars` continuam válidos depois, já que o
     * objeto não muda de endereço, só é reconstruído). PlcScanSession não conhece o tipo concreto
     * do PROGRAM (Program_HELLO etc.) -- quem monta a sessão (o driver/main, gerado por projeto em
     * F9.3) sabe e fornece isso. */
    PlcScanSession(ProgramDescriptor program, std::vector<VarDescriptor> inputVars,
                   std::vector<VarDescriptor> outputVars, std::function<void()> resetInstance);

    /** Processa uma linha de protocolo (sem o '\n' final) e devolve a linha de resposta completa
     * (também sem '\n' -- quem chama, o driver/main, cuida da E/S real). Nunca lança. */
    std::string handleLine(const std::string& line);

    /** Só pra teste: expõe se um scan já foi aceito (pra checar reset/monotonicidade sem parsear
     * respostas de texto). */
    bool hasScanned() const { return m_hasScanned; }
    int64_t lastAcceptedTimeNs() const { return m_lastAcceptedTimeNs; }
    uint64_t scanCount() const { return m_scanCount; }

private:
    std::string handleHello(const std::string& requestId);
    std::string handleReset(const std::string& requestId);
    std::string handleScan(const std::string& requestId, const std::string& args);
    std::string handleVariableCommand(const std::string& command, const std::string& requestId, const std::string& args);
    std::string handleShutdown(const std::string& requestId);

    ProgramDescriptor m_program;
    std::vector<VarDescriptor> m_inputVars;
    std::vector<VarDescriptor> m_outputVars;
    std::function<void()> m_resetInstance;
    bool m_hasScanned = false;
    int64_t m_lastAcceptedTimeNs = -1;
    uint64_t m_scanCount = 0;
};

} // namespace lasecsimul::plc

#pragma once
#include <memory>
#include <string>
#include "../resources/ResourceGovernor.hpp"
#include "../session/SimulationSession.hpp"

namespace lasecsimul::app {

/** Configuração recebida via argumentos de linha de comando. */
struct CoreConfig {
    std::string pipeName; // nome do pipe/socket IPC (sem prefixo de plataforma)
    resources::ResourceProfile resourceProfile = resources::ResourceProfile::Automatic;
};

/**
 * Coordena o bootstrap do processo Core:
 *   1. GlobalPluginCache (processo-wide, carrega módulos, nunca instâncias)
 *   2. SimulationSession (dona de estado por projeto)
 *   3. IpcServer (canal de controle Extension ↔ Core)
 *
 * main.cpp deve apenas fazer parsing de args e delegar tudo a CoreApplication::run().
 * Nenhuma lógica de UI, nenhuma referência à API do VSCode.
 */
class CoreApplication {
public:
    explicit CoreApplication(CoreConfig config);
    ~CoreApplication();

    CoreApplication(const CoreApplication&) = delete;
    CoreApplication& operator=(const CoreApplication&) = delete;

    /**
     * Executa o loop de mensagens IPC. Bloqueia até que o cliente envie "shutdown"
     * ou a conexão seja encerrada.
     * Retorna 0 em caso de shutdown limpo, 1 em caso de erro de transporte.
     */
    int run();

    /** TEST-ONLY accessor (2026-08-28, getProperty IPC head-of-line-blocking regression test) --
     * lets a test hold Scheduler::m_mutex from a thread other than the one running run(), to
     * prove getProperty's tryPropertyValueOf() path returns BUSY promptly instead of blocking the
     * serial IPC dispatch loop. Safe to call from a different thread than run(): the session is
     * fully constructed before run() is ever invoked (see CoreBootstrapTest.cpp's existing
     * pattern -- CoreApplication is constructed on the test's own thread, only run() is handed to
     * a background thread), and Scheduler's own locking is what this accessor exists to exercise.
     * Not part of the IPC protocol; do not call from production code paths. */
    session::SimulationSession& sessionForTesting();

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

/**
 * Faz o parsing de `--pipe <name>` de argv.
 * Retorna um CoreConfig válido ou imprime uso e termina o processo com código 1.
 */
CoreConfig parseArgs(int argc, char** argv);

} // namespace lasecsimul::app

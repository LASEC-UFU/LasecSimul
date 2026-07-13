#pragma once

#include <filesystem>
#include <string>
#include "lasecsimul/IMcuAdapter.hpp"
#include "qemu/QemuArenaBridge.hpp"
#include "qemu/QemuProcessManager.hpp"

namespace lasecsimul::mcu {

/**
 * Junta IMcuAdapter + QemuProcessManager + QemuArenaBridge num único ciclo de vida — a peça que
 * faltava: cada um dos três só tinha contrato/teste isolado até aqui (QemuProcessManager e
 * QemuArenaBridge só testados com fake/sintético, ver docs/mvp-limitacoes.md). NÃO faz polling
 * contínuo nem dispatch para módulos genéricos (GpioModule etc) — isso é trabalho de quem possui o
 * settle-loop (SimulationSession/Scheduler), igual a `IComponentModel::stamp()`; este controller só
 * abre e fecha o processo QEMU real e a arena, na ordem que o protocolo exige (Core cria a arena
 * ANTES de o QEMU poder abri-la — ver qemu_arena_abi.h).
 *
 * Lacuna conhecida (deliberadamente fora de escopo aqui): o mecanismo pelo qual o binário QEMU do
 * fork qemu-simulide recebe o NOME da arena (flag de linha de comando ou variável de ambiente
 * própria do fork) não está documentado neste repositório — só o layout da struct compartilhada
 * está espelhado em qemu_arena_abi.h. Sem o código-fonte do fork (G:\Meu Drive\SourceCode\qemu-
 * simulide-1, não presente aqui), não dá para fechar esse elo com segurança; ver
 * docs/mvp-limitacoes.md. Este controller abre a arena do lado do Core de qualquer forma — é o que
 * já está especificado — mas não garante que o processo QEMU real de fato a anexe.
 */
class McuController {
public:
    /** `qemuBinaryOverride` substitui o `spec.binary` que o adapter devolve (ex: "qemu-system-xtensa",
     * que depende do PATH) por um caminho absoluto — necessário em qualquer ambiente onde o binário
     * do fork não esteja no PATH do sistema. Vazio (default) usa o que o adapter já devolve. */
    explicit McuController(const IMcuAdapter& adapter, std::string qemuBinaryOverride = {});

    McuController(const McuController&) = delete;
    McuController& operator=(const McuController&) = delete;

    /** Abre a arena de memória compartilhada (Core sempre cria primeiro) e só então inicia o
     * processo QEMU com o firmware indicado. Lança std::runtime_error se a arena não puder ser
     * criada ou o processo não puder ser iniciado (mesma semântica de QemuArenaBridge::open() e
     * QemuProcessManager::start()) — chamador decide se tenta de novo ou propaga.
     * `callSiteBinaryOverride` (opcional), se não vazio, vence o override dado ao construtor —
     * usado por `McuComponent::loadFirmware`, onde o caminho do binário só é conhecido por
     * instância/chamada (via IPC `loadMcuFirmware`), não no momento em que o McuController é
     * criado junto com o componente. */
    void start(const std::filesystem::path& firmwarePath, const std::string& arenaName,
               const std::string& callSiteBinaryOverride = {}, McuDebugOptions debug = {});
    QemuLaunchSpec buildLaunchSpec(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                                   const std::string& callSiteBinaryOverride = {}, McuDebugOptions debug = {}) const;

    /** Para o processo (gracioso até `timeout`, kill() se não responder) e sempre fecha a arena
     * depois, mesmo se o processo já tiver morrido por conta própria. */
    void stop();

    bool isRunning() const;
    std::string qemuLogs() const;

    qemu::QemuArenaBridge& arenaBridge() { return m_arenaBridge; }
    const qemu::QemuArenaBridge& arenaBridge() const { return m_arenaBridge; }

private:
    const IMcuAdapter& m_adapter;
    std::string m_qemuBinaryOverride;
    qemu::QemuProcessManager m_processManager;
    qemu::QemuArenaBridge m_arenaBridge;
};

} // namespace lasecsimul::mcu

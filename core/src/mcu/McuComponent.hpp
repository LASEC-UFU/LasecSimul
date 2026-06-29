#pragma once

#include <filesystem>
#include <memory>
#include <string>
#include <vector>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/IMcuAdapter.hpp"
#include "lasecsimul/QemuModule.hpp"
#include "qemu/QemuArenaBridge.hpp"
#include "qemu/QemuProcessManager.hpp"
#include "simulation/Scheduler.hpp"

namespace lasecsimul::mcu {

/**
 * Ponte entre `IMcuAdapter` (declarativo) e `IComponentModel` (entra no Netlist/Scheduler como
 * qualquer outro componente, com pinos reais ligáveis por fio) -- a peça que faltava: sem isso,
 * um registrador GPIO escrito pelo QEMU nunca chegava a afetar o circuito de verdade.
 *
 * Deliberadamente NEUTRO quanto a chip: só chama `QemuModule::isOutputEnabled()`/`outputLevel()`/
 * `setInputLevel()` genericamente pra todo `PinMapping` de `m_adapter.pinMap()` -- nunca sabe o
 * que cada bit significa (isso é só do módulo concreto, ex: `Esp32GpioModule`). A detecção de
 * qual módulo é dono de cada `regAddr` usa a MESMA `QemuArenaBridge::dispatch()` que já existia.
 *
 * Simplificação documentada (ver `mcu_simulide` mais embaixo): processa cada evento da arena
 * IMEDIATAMENTE no `stamp()` em que é detectado, em vez de agendar pro timestamp exato que o QEMU
 * reportou (`SimulIDE-dev`/`simulide_2` real agenda via fila de eventos própria,
 * `Simulator::addEventAt(nextTime,...)` -- ver qemudevice.cpp `runEvent()`). Pra protocolos de
 * timing fino (largura de pulso, etc.) isso pode divergir um pouco do hardware real; aceitável
 * pra GPIO digital simples (Blink Real), revisitar se precisão de timing se tornar necessária.
 */
class McuComponent final : public IComponentModel {
public:
    McuComponent(std::unique_ptr<IMcuAdapter> adapter, simulation::Scheduler& scheduler, std::span<const Pin> requestedPins = {});

    const char* typeId() const override { return m_adapter->chipId(); }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override;
    void postStep(uint64_t) override {} // não usado -- self-agendamento via onAssignedIndex/scheduleEvent

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    void onAssignedIndex(uint32_t index) override;

    /** Inicia o processo QEMU real com o firmware indicado -- chamado via propriedade/IPC (ainda
     * não exposto, ver pendência em CoreApplication.cpp). `arenaName` deve ser único por
     * instância (várias MCUs no mesmo projeto = várias arenas, nunca uma global -- ver
     * McuRuntimeManager, ainda não implementado). */
    void loadFirmware(const std::filesystem::path& firmwarePath, const std::string& arenaName);
    void stopFirmware();
    bool firmwareRunning() const { return m_processManager.isRunning(); }

    /** Estado do pino RST (ModuleKind::Reset, ex: EN do ESP32) na última stamp() -- exposto só pra
     * teste confirmar a borda sem precisar reler tensão de matriz. */
    bool resetPinHigh() const { return m_resetPinHigh; }

    /** Abre a arena SEM iniciar nenhum processo QEMU -- só pra teste poder simular escritas de
     * registrador manualmente (mesmo papel de QemuArenaBridgeTest), sem precisar de um binário
     * real nem de firmware. Produção sempre usa loadFirmware(), nunca isto direto. */
    void openSyntheticArenaForTesting(const std::string& arenaName) {
        m_arenaBridge.open(qemu::QemuArenaOpenOptions{arenaName, true});
        m_arenaOpen = true;
    }
    qemu::QemuArenaBridge& arenaBridge() { return m_arenaBridge; }

private:
    void scheduleNextPoll();
    void scheduleModuleWakeup(size_t moduleIndex);
    void scheduleWakeupsForAllModules();
    void runPendingModuleWakeups();
    void pollAndDispatchPendingEvents();
    void stampResetPin(MnaMatrixView& matrix, const Pin& pin);
    void resetModulesAndWakeups();
    QemuModule* findModule(uint64_t address) const;

    static constexpr uint64_t kPollIntervalNs = 50'000; // 50us -- mesma ordem do period_ns real
    static constexpr int kMaxEventsPerStamp = 64; // limite pra nunca girar pra sempre num round só
    // 1e6/1e-6 (não 1e9/1e-9 como Rail/Probe) -- ver comentário extenso em stamp(): um componente
    // com dezenas de pinos simultaneamente flutuantes precisa de spread seguro pro rcond() do
    // solver, não só "forte"/"fraco" em isolado.
    static constexpr double kDriveConductance = 1e6;
    static constexpr double kFloatingConductance = 1e-6;
    static constexpr double kDriveHighVolts = 3.3; // lógica ESP32 é 3.3V, não 5V

    std::unique_ptr<IMcuAdapter> m_adapter;
    simulation::Scheduler& m_scheduler;
    std::vector<Pin> m_pins;
    std::vector<std::unique_ptr<QemuModule>> m_modules;
    std::vector<uint64_t> m_moduleWakeupDueNs;
    std::vector<uint64_t> m_moduleWakeupGeneration;
    std::vector<uint8_t> m_moduleWakeupPending;
    qemu::QemuArenaBridge m_arenaBridge;
    qemu::QemuProcessManager m_processManager;
    uint32_t m_componentIndex = 0;
    bool m_arenaOpen = false;
    // ModuleKind::Reset (ex: EN do ESP32) -- nunca tem QemuModule, McuComponent trata direto.
    // Default true: sem fio externo nenhum, o pino fica com polarização fraca pra ALTO (chip roda
    // normalmente) -- inverso do floating genérico de GPIO (que vai fraco pra terra), porque aqui
    // "sem ligação" tem que significar "não resetado", nunca o oposto (ver stampResetPin()).
    bool m_resetPinHigh = true;
    std::filesystem::path m_lastFirmwarePath;
    std::string m_lastArenaName;
};

} // namespace lasecsimul::mcu

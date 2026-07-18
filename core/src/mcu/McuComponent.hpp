#pragma once

#include <atomic>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/IMcuAdapter.hpp"
#include "lasecsimul/QemuModule.hpp"
#include "mcu/McuController.hpp"
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
 * A sincronização segue o princípio usado por `QemuDevice::runEvent()` no SimulIDE: o QEMU publica
 * o próximo timestamp virtual, ações do mesmo instante são drenadas em lote e uma ação futura é
 * colocada exatamente nesse instante na fila do Scheduler. O passo interno e o refresh visual não
 * participam desse handshake; assim preservamos timing/determinismo sem polling por passo de MNA.
 */
class McuComponent final : public IComponentModel {
public:
    McuComponent(std::unique_ptr<IMcuAdapter> adapter, simulation::Scheduler& scheduler, std::span<const Pin> requestedPins = {});
    ~McuComponent() override;

    const char* typeId() const override { return m_adapter->chipId(); }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override;
    void postStep(uint64_t) override {} // não usado -- self-agendamento via onAssignedIndex/scheduleEvent

    /** `kPinChangeEventTag` (Types.hpp): ÚNICA fonte de borda do pino RST/EN -- disparado pelo
     * framework (`SimulationSession::settleStep()`) só depois do solver MNA convergir E só numa
     * transição REAL de nível (`wasHigh != isHigh` contra a tensão anterior já resolvida), nunca
     * durante uma iteração intermediária de Newton. Substitui a comparação manual de tensão que
     * `stampResetPin()` fazia antes (ver histórico: comparar a leitura de CADA stamp() contra uma
     * suposição não observada causava reset fantasma no cold-start, quando a 1ª stamp() via ~0V
     * antes de o solver convergir -- mesma categoria de bug que o SimulIDE real evita não lendo
     * tensão de pino dentro do laço do solver, só via callback pós-solve do próprio nó). */
    void onEvent(const ComponentEvent& event) override;

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    /** Agrega a saúde do adaptador (`create`/`build_launch_args`/`get_memory_regions`/
     * `get_pin_map`/`create_modules`, ver `NativeMcuAdapterProxy`) com a de cada módulo concreto
     * (`writeRegister`/`readRegister`/etc, ver `QemuModuleProxy`) -- `Faulted` se qualquer um dos
     * dois relatar `Faulted`, senão `Lagging` se qualquer um relatar `Lagging`, senão `Ok`. Built-in
     * (chip nativo compilado no Core, se algum dia existir) nunca sobrescreve nem adapter nem
     * módulo, então isto sempre devolve `Ok` pra esse caso -- mesma composicionalidade de
     * `IComponentModel::health()`/`IMcuAdapter::health()`/`QemuModule::health()` (achado de
     * auditoria arquitetural 2026-07-09: MCU não tinha NENHUMA contenção de crash até esta
     * correção). */
    PluginHealthStatus health() const override;

    void onAssignedIndex(uint32_t index) override;

    /** Inicia o processo QEMU real com o firmware indicado -- chamado via IPC `loadMcuFirmware`
     * (`CoreApplication.cpp`, `extension/src/mcu/mcuCommands.ts`). `arenaName` deve ser único por
     * instância (várias MCUs no mesmo projeto = várias arenas, nunca uma global). */
    void loadFirmware(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                      const std::string& qemuBinaryOverride = {}, McuDebugOptions debug = {});
    uint16_t gdbPort() const { return m_gdbPort; }
    void stopFirmware();
    bool firmwareRunning() const;
    std::string qemuLogs() const;

    /** Estado do pino RST (ModuleKind::Reset, ex: EN do ESP32) na última borda confirmada via
     * `onEvent()` -- exposto só pra teste confirmar a borda sem precisar reler tensão de matriz. */
    bool resetPinHigh() const { return m_resetPinHigh; }
    uint64_t stampCountForTesting() const { return m_stampCount; }
    /** Quantas vezes `loadFirmware()` executou de verdade (chamada explícita OU reload disparado
     * por `onEvent()` numa borda de subida do RST/EN) -- exposto só pra teste provar que um
     * `loadFirmware()` legítimo nunca dispara UM SEGUNDO reload espúrio sozinho (achado 2026-07-17:
     * a 1ª subida natural do próprio pull-up de RST, logo após o `loadFirmware()` inicial, tinha
     * virado uma "borda" e recarregava tudo de novo -- ver guarda `!firmwareRunning()` em
     * `onEvent()`). */
    uint64_t loadFirmwareCallCountForTesting() const { return m_loadFirmwareCallCount; }

    /** Abre a arena SEM iniciar nenhum processo QEMU -- só pra teste poder simular escritas de
     * registrador manualmente (mesmo papel de QemuArenaBridgeTest), sem precisar de um binário
     * real nem de firmware. Produção sempre usa loadFirmware(), nunca isto direto. */
    void openSyntheticArenaForTesting(const std::string& arenaName);
    qemu::QemuArenaBridge& arenaBridge() { return m_controller.arenaBridge(); }

private:
    struct CallbackState {
        mutable std::recursive_mutex mutex;
        McuComponent* owner = nullptr;
    };
    void startPolling();
    void stopPolling();
    void scheduleNextPoll();
    void schedulePollAt(uint64_t timeNs);
    void onPollEvent();
    void scheduleModuleWakeup(size_t moduleIndex, uint64_t nowNs, bool schedulerLockHeld);
    void scheduleWakeupsForAllModules(uint64_t nowNs, bool schedulerLockHeld);
    bool pollAndDispatchPendingEvents(uint64_t nowNs);
    bool dispatchArenaEvent(const qemu::QemuArenaEvent& event, uint64_t eventTimeNs);
    uint64_t electricalOutputFingerprint() const;
    void stampResetPin(MnaMatrixView& matrix, const Pin& pin);
    void resetModulesAndWakeups();
    QemuModule* findModule(uint64_t address) const;

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
    std::vector<QemuModule*> m_moduleByPin;
    std::vector<uint64_t> m_moduleWakeupDueNs;
    std::vector<uint64_t> m_moduleWakeupGeneration;
    // Dono real do processo QEMU + arena de memória compartilhada -- ver McuController.hpp. Eram
    // dois membros próprios (QemuArenaBridge/QemuProcessManager) duplicando exatamente o que
    // McuController já fazia; unificado (achado de auditoria arquitetural 2026-07-09, D11) pra ter
    // uma só implementação, testada tanto por McuComponentTest (arena sintética) quanto por
    // McuControllerRealQemuTest (binário QEMU real) contra o MESMO código.
    McuController m_controller;
    std::shared_ptr<CallbackState> m_callbackState;
    uint32_t m_componentIndex = 0;
    std::atomic<bool> m_polling{false};
    bool m_pollEventScheduled = false;
    bool m_syntheticArenaForTesting = false;
    uint64_t m_qemuTimeOriginNs = 0;
    uint64_t m_stampCount = 0;
    uint64_t m_loadFirmwareCallCount = 0;
    // ModuleKind::Reset (ex: EN do ESP32) -- nunca tem QemuModule, McuComponent trata direto.
    // Só reflete o ÚLTIMO nível confirmado via `onEvent(kPinChangeEventTag)` (tensão já
    // convergida) -- nunca escrito a partir de uma leitura crua de `stamp()` (ver comentário de
    // `onEvent()` no .hpp). Default false: nenhuma borda ainda observada pelo framework: mesma
    // convenção de `eNode::m_volt=0` no SimulIDE real (`e-node.cpp`) -- o nó começa "baixo" do
    // ponto de vista do detector de borda até o solver resolver a tensão real pela 1ª vez, quando
    // então uma borda de SUBIDA genuína dispara (RST sem fio nenhum se estabiliza em ~3.3V, ver
    // `stampResetPin()`), tratada como "liberado do reset", nunca como reset em si.
    bool m_resetPinHigh = false;
    std::filesystem::path m_lastFirmwarePath;
    std::string m_lastArenaName;
    std::string m_lastQemuBinaryOverride;
    McuDebugOptions m_lastDebugOptions;
    uint16_t m_gdbPort = 0;
};

} // namespace lasecsimul::mcu

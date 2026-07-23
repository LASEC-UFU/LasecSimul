#pragma once

#include <atomic>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
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

    /** Uma propriedade `uart{N}_tx_monitor_hex`/`uart{N}_rx_monitor_hex` por USART que o adaptador
     * declara em `memoryRegions()` (`ModuleKind::Usart`) -- drena (hex, atômico) o buffer de monitor
     * fora da banda do módulo real (`QemuModule::drainMonitorByte`), alimentando "Abrir monitor
     * serial UARTx" (`mcuCommands.ts::openSerialMonitor`, via `getProperty` IPC genérico) SEM exigir
     * fio nenhum -- equivalente ao `SerialMonitor` real do SimulIDE que lê direto do `UsartModule`
     * do MCU. Somente leitura (`set` no-op); ausente do painel de propriedades
     * (`PropertySchemaHidden`). Vazio (`{}`) se o adaptador não declarar nenhum USART. */
    std::vector<PropertyDescriptor> propertyDescriptors() override;

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

    /** Achado 2026-07-22 (indicador "MCU real-time ratio" sempre em 0%, mesmo com o MCU rodando
     * normalmente): `arena->qemuTime` NUNCA é escrito pelo fork QEMU real (confirmado lendo
     * simuliface.c -- só existe como variável LOCAL dentro de getQemu_ps(), nunca atribuído ao
     * campo do arena) -- fica 0 pra sempre, então ler esse campo direto (como
     * `SimulationSession::firstMcuVirtualTimeNs` fazia antes desta correção) sempre dava 0. O tempo
     * virtual só chega EMBUTIDO em cada evento processado (`simuTimePs`, escrito tanto pelos
     * heartbeats `SIM_EVENT` quanto por cada leitura/escrita de registrador) -- por isso
     * `pollStepLocked()` atualiza este campo a cada evento (mesma técnica do
     * `QemuIcountCalibrator::pumpArenaFor`), e este getter expõe o valor mais recente. `std::atomic`
     * porque é lido de uma thread diferente da que escreve (poll thread ou chamador síncrono vs. a
     * thread que atende `getSimulationTime` via IPC). */
    uint64_t latestVirtualTimeNs() const { return m_latestVirtualTimePs.load(std::memory_order_relaxed) / 1000u; }

    /** Achado 2026-07-23 (sincronização de ritmo, ver .claude/plans/humble-waddling-parnas.md):
     * mesma fonte de `latestVirtualTimeNs()`, mas já traduzida pra timeline do `Scheduler`
     * compartilhado (mesma tradução que `pollStepLocked()` já faz pra `eventNs`) -- comparável
     * direto contra `Scheduler::nowNs()`. Usado por `SimulationSession::computeSlowestMcuPositionNs()`
     * pra alimentar `Scheduler::AdvanceLimitFn` (o elétrico nunca corre mais que uma folga fixa à
     * frente da posição confirmada do MCU mais lento). `std::nullopt` se nenhum evento foi
     * processado ainda (boot ou logo após uma recarga de firmware). Implementado no .cpp porque
     * `qemuEventTimeNs()` é uma função livre dentro do namespace anônimo de McuComponent.cpp. */
    std::optional<uint64_t> pacingPositionNs() const;

private:
    /** PERF-12 (docs/33-plano-revisao-arquitetural-core.md, alternativa C): sobrevive à destruição
     * do McuComponent -- mantida viva pela `shared_ptr` que a própria thread de poll dedicada
     * carrega, então `pollThreadRunning`/`mutex` continuam seguros de tocar mesmo depois de `owner`
     * virar nullptr (ver `runBackgroundPollLoop`, que nunca guarda um `McuComponent*` cru fora do
     * escopo do lock). */
    struct CallbackState {
        mutable std::recursive_mutex mutex;
        McuComponent* owner = nullptr;
        std::atomic<bool> pollThreadRunning{false};
    };
    /** Resultado de uma tentativa de poll -- ver `pollStepLocked()`. */
    enum class PollStep { NoEvent, DispatchedReady, DeferredFuture };
    /** Achado 2026-07-21 (relato ao vivo do usuário: simulação travava em 0% depois de alguns
     * minutos rodando): `Scheduler::runUntil()` segura `Scheduler::m_mutex` pelo laço de settle
     * inteiro, e `stamp()` (chamado de dentro dele) adquire `m_callbackState->mutex` NESSA ordem
     * (Scheduler::m_mutex -> CallbackState::mutex) -- sempre na própria thread do Scheduler. A
     * thread de poll dedicada (`runBackgroundPollLoop`) faz o INVERSO: seguraria
     * `m_callbackState->mutex` e SÓ ENTÃO chamaria `Scheduler::markDirty()`/`scheduleEvent()`/
     * `scheduleAt()` (que adquirem `Scheduler::m_mutex`) -- inversão clássica de ordem de lock.
     * Quando a thread do Scheduler está em `stamp()` do MESMO MCU (segurando as duas, nessa ordem)
     * exatamente quando a thread de poll despacha um evento (segurando a primeira, querendo a
     * segunda), as duas travam para sempre. `pollStepLocked()`/`schedulePollAt()`/
     * `scheduleModuleWakeup()`/`scheduleWakeupsForAllModules()` aceitam este vetor opcional: quando
     * não-nulo, QUALQUER chamada que tocaria o Scheduler é empacotada aqui em vez de disparada na
     * hora -- `runBackgroundPollLoop()` as executa DEPOIS de soltar `m_callbackState->mutex`,
     * nunca segurando as duas ao mesmo tempo. `nullptr` (default) preserva o comportamento direto
     * de sempre para quem já é seguro (stamp()/onPollEvent() legado, chamados só pela própria
     * thread do Scheduler com `Scheduler::m_mutex` já liberado antes do callback, ver
     * `Scheduler::processNextEventUntilLocked`). */
    using DeferredSchedulerCall = std::function<void()>;
    void startPolling(std::vector<DeferredSchedulerCall>* deferred = nullptr);
    void stopPolling();
    void scheduleNextPoll(std::vector<DeferredSchedulerCall>* deferred = nullptr);
    void schedulePollAt(uint64_t timeNs, std::vector<DeferredSchedulerCall>* deferred = nullptr);
    void onPollEvent();
    /** Um poll na arena + no máximo uma ação: sem evento (`NoEvent`), evento futuro reagendado via
     * `schedulePollAt` (`DeferredFuture`) ou evento pronto despachado agora (`DispatchedReady`).
     * Chamar só com `m_callbackState->mutex` já travado pelo chamador (mesma convenção de
     * `settleUntilStableLocked`/`scheduleEventUnlocked` do Scheduler) -- nunca abre/fecha a arena
     * nem checa `isOpen()`, isso é responsabilidade de quem chama. `deferred` -- ver doc-comment de
     * `DeferredSchedulerCall` acima. */
    PollStep pollStepLocked(std::vector<DeferredSchedulerCall>* deferred = nullptr);
    /** PERF-12: inicia (se ainda não houver uma) a thread dedicada de poll para este MCU -- só
     * quando `m_scheduler.isRunning()` (worker de verdade rodando em background; ver `onPollEvent`)
     * -- idempotente via `CallbackState::pollThreadRunning` (compare-and-swap), seguro chamar toda
     * vez que `onPollEvent()` não tem evento imediato pronto. */
    void startBackgroundPollThreadIfNeeded();
    /** Corpo da thread dedicada -- `static` de propósito: nunca guarda `this`/`McuComponent*` fora
     * do escopo de `state->mutex`, só `state` (mantém `CallbackState` vivo sozinho). Poll roda com
     * o lock tomado (serializa contra `stamp()`/`pollAndDispatchPendingEvents()` na thread do
     * Scheduler, mesma arena -- fila de escritas/heartbeat desde o PERF-13, ver qemu_arena_abi.h);
     * o lock é solto entre iterações (ver `std::this_thread::
     * yield()` abaixo) -- diferente de `onPollEvent()` de hoje, que segurava o mutex pelo busy-wait
     * inteiro (achado PERF-09 da revisão arquitetural: resolvido de graça por este redesenho, já
     * que a espera nunca mais acontece com o lock tomado). Toda chamada ao Scheduler é coletada via
     * `DeferredSchedulerCall` e só disparada DEPOIS de soltar `state->mutex` (ver doc-comment
     * acima -- evita a inversão de ordem de lock contra `stamp()`). Termina sozinha (sem `join()`
     * -- nunca bloqueia quem chama `stopPolling()`/o destrutor, mesmo se isso acontecer de dentro
     * de um callback que já segura `state->mutex` recursivamente, ver `onEvent()`) assim que
     * `m_polling` vira false, a arena fecha, ou o dono é destruído.
     */
    static void runBackgroundPollLoop(std::shared_ptr<CallbackState> state);
    void scheduleModuleWakeup(size_t moduleIndex, uint64_t nowNs, bool schedulerLockHeld,
                               std::vector<DeferredSchedulerCall>* deferred = nullptr);
    void scheduleWakeupsForAllModules(uint64_t nowNs, bool schedulerLockHeld,
                                       std::vector<DeferredSchedulerCall>* deferred = nullptr);
    /** Corpo de `loadFirmware()` -- espera `m_callbackState->mutex` JÁ travado pelo chamador (uma
     * vez só, não reentrante) e nunca dispara `deferred` sozinha, só anexa -- quem travou primeiro
     * é quem dispara, depois de soltar a PRÓPRIA trava (ver `loadFirmware()` e as bordas de
     * `onEvent()`, que chamam isto direto em vez do `loadFirmware()` público porque já seguram o
     * lock reentrante e precisam dispará-la só quando ELAS soltarem, não quando esta função
     * retornar -- senão o disparo ainda aconteceria com `m_callbackState->mutex` travado pela
     * chamadora externa, mesma inversão de ordem que motivou `DeferredSchedulerCall`). */
    void loadFirmwareLocked(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                             const std::string& qemuBinaryOverride, McuDebugOptions debug,
                             std::vector<DeferredSchedulerCall>& deferred);
    bool pollAndDispatchPendingEvents(uint64_t nowNs);
    bool dispatchArenaEvent(const qemu::QemuArenaEvent& event, uint64_t eventTimeNs);
    uint64_t electricalOutputFingerprint() const;
    void stampResetPin(MnaMatrixView& matrix, const Pin& pin);
    void resetModulesAndWakeups();
    QemuModule* findModule(uint64_t address) const;
    /** Drena TODO o buffer de monitor (até esvaziar ou `kUsartMonitorDrainGuard` iterações, o que
     * vier primeiro -- nunca deveria bater no guard em uso normal, é só proteção contra um adaptador
     * malcomportado que nunca devolve buffer vazio) do módulo dono de `regionStart`, devolvendo hex
     * lowercase (2 chars por byte, `""` se vazio ou módulo não encontrado). `tx=true` = lado saída. */
    std::string drainUsartMonitorHex(uint64_t regionStart, bool tx) const;
    /** Decodifica `hex` (lowercase/uppercase, 2 chars por byte) e injeta no RX do módulo dono de
     * `regionStart` via `QemuModule::injectRxBytes` -- ver doc-comment lá (bypassa temporização
     * elétrica de propósito). Hex malformado (tamanho ímpar/caractere inválido) é ignorado
     * silenciosamente a partir do ponto do erro, mesmo espírito tolerante de `uart_enqueue_hex` em
     * `devices/simulide-peripherals/src/lib.c`. */
    void injectUsartRxHex(uint64_t regionStart, const std::string& hex) const;

    // Mesmas impedâncias REAIS de `IoPin` no SimulIDE real (`.codex-simulide-src/src/gui/
    // circuitwidget/iopin.cpp` -- `m_outputImp`/`m_inputImp`, usadas por `Esp32Pin`/todo pino de
    // MCU real): 40Ω de saída ativa (`kDriveConductance=1/40`) e 1e7Ω flutuando
    // (`kFloatingConductance=1e-7`, = `high_imp` de `e-element.h`). Substituídos aqui em
    // 2026-07-17 -- os valores anteriores (1e6/1e-6, spread 1e12) eram um número SEM
    // correspondência física nenhuma, inventado só pra manter `rcond()` acima do piso de rejeição
    // do solver com ~40 pinos flutuando ao mesmo tempo (comentário antigo em stamp()); achado real:
    // esse spread inflado deixava o `CircuitGroup` do MCU perigosamente perto do piso de
    // singularidade sempre que compartilhava grupo com um componente não-linear (`DiodeLegArray`
    // do LED, ver `.spec`) em convergência -- quando cruzava o piso, `MnaSolver::solve()` zerava
    // TODAS as tensões do grupo (inclusive RST/EN), disparando um reset fantasma sincronizado com
    // cada toggle do blink do usuário. O spread real do SimulIDE (40/1e7 ≈ 2.5e5, MUITO menor que
    // 1e12) já é fisicamente plausível e não precisa desse "colchão" artificial.
    static constexpr double kDriveConductance = 1.0 / 40.0;
    static constexpr double kFloatingConductance = 1.0 / 1e7;
    // Pull-up dedicado do pino RST/EN (`stampResetPin()`) -- idêntico a `Esp32::addPin()` real
    // (`m_rstPin->setPullup(1e5)`, 100kΩ), NÃO o `kFloatingConductance` genérico de GPIO acima.
    // SimulIDE trata o pino de reset como um caso elétrico PRÓPRIO (pull-up físico dedicado, mais
    // forte que um GPIO comum flutuando), nunca reaproveita a condutância genérica de "sem fio" de
    // um GPIO de dados -- reproduzido aqui fielmente em vez de continuar usando o mesmo valor de
    // "flutuando" que todo GPIO comum usa.
    static constexpr double kResetPullupConductance = 1e-5;
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
    // Achado 2026-07-23 (sincronização de ritmo): lido cross-thread por pacingPositionNs(), sem
    // segurar m_callbackState->mutex -- precisa ser atomic pela mesma razão de m_latestVirtualTimePs
    // logo abaixo.
    std::atomic<uint64_t> m_qemuTimeOriginNs{0};
    // Ver comentário de `latestVirtualTimeNs()` acima -- atualizado em pollStepLocked() a cada
    // evento processado, lido de uma thread diferente via `latestVirtualTimeNs()`.
    std::atomic<uint64_t> m_latestVirtualTimePs{0};
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

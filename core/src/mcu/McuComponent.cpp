#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#endif
#include "McuComponent.hpp"
#include "ConsumerTrace.hpp"
#include "lasecsimul/CausalTrace.hpp"
#include "lasecsimul/qemu_arena_abi.h"
#include "mcu/qemu/VnextBArbiter.hpp"
#include "simulation/SettleProvenance.hpp"
#include <algorithm>
#include <array>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <limits>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#endif

namespace lasecsimul::mcu {

namespace {
uint64_t qemuEventTimeNs(uint64_t originNs, uint64_t virtualTimePs) {
    const uint64_t deltaNs = virtualTimePs / 1000u + (virtualTimePs % 1000u != 0 ? 1u : 0u);
    if (deltaNs > std::numeric_limits<uint64_t>::max() - originNs) return std::numeric_limits<uint64_t>::max();
    return originNs + deltaNs;
}

// PLAN_MTTCG_VNEXT_B_CAUSALITY.md section 10.5: VNEXT_B's lasec_at_event::timestamp_ns is
// already nanoseconds (QEMU_CLOCK_VIRTUAL at publish time, see softmmu/vnext_b.c), unlike the
// legacy arena's picosecond simuTimePs -- a dedicated, explicitly-named nanosecond helper
// instead of silently reusing qemuEventTimeNs()'s ps-to-ns division on an already-ns value.
uint64_t vnextEventTimeNs(uint64_t originNs, uint64_t timestampNs) {
    if (timestampNs > std::numeric_limits<uint64_t>::max() - originNs) return std::numeric_limits<uint64_t>::max();
    return originNs + timestampNs;
}

// TEMPORARY (ConsumerTrace investigation, see ConsumerTrace.hpp) -- raw snapshot of queue
// indices, same fields/no-lock convention the test's own diagnostic prints already use.
struct QueueSnap { uint64_t writeIndex = 0; uint64_t readIndex = 0; };
QueueSnap snapshotQueue(const qemu::QemuArenaBridge& arena) {
    const LsdnQemuArena* a = arena.arena();
    return a ? QueueSnap{a->queueWriteIndex, a->queueReadIndex} : QueueSnap{};
}

// TEMPORARY (ConsumerTrace investigation, round 8): raw, read-only peek at the newest
// (tail) queued entry's timestamp -- same no-side-effect convention as arena.poll()'s own peek at
// the head. 0 if the queue is empty. Used only for the backlog-horizon diagnostic.
uint64_t tailSimuTimePs(const qemu::QemuArenaBridge& arena, uint64_t writeIndex, uint64_t readIndex) {
    if (writeIndex <= readIndex) return 0;
    const LsdnQemuArena* a = arena.arena();
    if (!a) return 0;
    const uint64_t slot = (writeIndex - 1) % LSDN_QEMU_ARENA_QUEUE_DEPTH;
    return a->queue[slot].simuTime;
}

// Lockstep exato: maior intervalo de tempo do guest sem sincronizar com o Core, mesmo sem eventos.
// Mantém o guest no ritmo do tempo real (o Core faz o pacing) e o tempo da sessão andando. Medido
// (2026-10-29): 5 ou 10 ms dividem as sincronizações por 2 sem ganhar ritmo -- cada uma só demora mais.
constexpr uint64_t kLockstepQuantumNs = 1'000'000;
// Folga sobre a posição provada dos outros MCUs em lockstep: sem ela os dois guests esperariam um pelo
// outro para sempre. É o maior atraso com que um sinal entre dois MCUs pode chegar.
constexpr uint64_t kLockstepPeerLookaheadNs = 1'000;

// LASECSIMUL_LOCKSTEP_TRACE=1: onde vai o tempo de parede de cada sincronização do lockstep.
bool lockstepTraceEnabled() {
    static const bool enabled = [] {
        const char* value = std::getenv("LASECSIMUL_LOCKSTEP_TRACE");
        return value && *value && std::strcmp(value, "0") != 0;
    }();
    return enabled;
}
uint64_t steadyNowNs() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}

// Só o que stamp() aplica a um pino: o nível de um pino dirigido, ou o pull de um não dirigido.
uint8_t electricalPinState(uint8_t state) {
    constexpr uint8_t kDriven = QemuModule::kPinOutputEnabled | QemuModule::kPinOutputHigh;
    constexpr uint8_t kPulls = QemuModule::kPinPullUp | QemuModule::kPinPullDown;
    return static_cast<uint8_t>(state & ((state & QemuModule::kPinOutputEnabled) != 0 ? kDriven : kPulls));
}

// Estado elétrico de `bitsOrLines` de `module`, lido em lotes de até 64 linhas sem alocar;
// `visit(posição, estado)` para cada linha, na ordem dada.
template <class Visit>
void visitPinStates(const QemuModule& module, std::span<const uint32_t> bitsOrLines, Visit&& visit) {
    std::array<uint8_t, 64> states{};
    for (size_t first = 0; first < bitsOrLines.size(); first += states.size()) {
        const size_t count = std::min(states.size(), bitsOrLines.size() - first);
        module.pinStates(bitsOrLines.subspan(first, count), std::span<uint8_t>(states).first(count));
        for (size_t i = 0; i < count; ++i) visit(first + i, electricalPinState(states[i]));
    }
}

struct LockstepTrace {
    std::atomic<uint64_t> wakeNs{0};
    uint64_t observedNs = 0;
    uint64_t syncs = 0, wakeToObserveNs = 0, observeToPublishNs = 0, cycles = 0, releasedSeq = 0;
};
LockstepTrace g_lockstepTrace;

// Lido uma vez: consultado a cada escrita de GPIO e a cada transação I2C do VNEXT_B, e getenv no
// CRT do Windows varre o bloco de ambiente inteiro (mesmo achado de analogTraceEnabled no adaptador).
bool vnextTraceEnabled() {
    static const bool enabled = [] {
        const char* value = std::getenv("LASECSIMUL_VNEXT_TRACE");
        return value && *value && std::strcmp(value, "0") != 0;
    }();
    return enabled;
}

// GPIO_IN/GPIO_IN1 do ESP32. No VNEXT_B o QEMU atende leituras destes dois registradores a partir
// do snapshot compartilhado (vnext_b_gpio_read em softmmu/vnext_b.c): GPIO_IN nos bytes 0-7,
// GPIO_IN1 nos bytes 8-15 -- nunca com um pedido de leitura ao Core.
constexpr std::array<uint64_t, 2> kVnextBGpioInAddresses{0x3FF4403Cull, 0x3FF44040ull};

// I2C elétrico do VNEXT_B: periféricos I2C0/I2C1 do ESP32 (mesmos endereços que o QEMU usa em
// vnext_i2c_address) e o protocolo privado do motor do adaptador (Esp32Adapter.cpp, kI2cCoreOpOffset).
constexpr uint64_t kVnextBI2c0Base = 0x3FF53000ull;
constexpr uint64_t kVnextBI2c1Base = 0x3FF67000ull;
// Flags do BATCH (byte 1 do envelope): START 1, fim lógico da transação 2 (STOP *ou* END -- a
// fronteira em que os modelos de dispositivo do fast path consolidam), READ 4; e para o caminho
// elétrico: a lista termina num STOP de verdade 8 (END segura o barramento, sem STOP no fio) e o
// mestre dá NACK no último byte lido 16 (ACK_VAL do último READ). Ver esp32_i2c.c no fork QEMU.
constexpr uint8_t kVnextBI2cStart = 1u, kVnextBI2cWireStop = 8u, kVnextBI2cLastReadNack = 16u;
constexpr uint64_t kAdapterI2cLowPeriodOffset = 0x00;
constexpr uint64_t kAdapterI2cStatusOffset = 0x08;
constexpr uint64_t kAdapterI2cStatusBusBusy = 1u << 4;
constexpr uint64_t kAdapterI2cCoreOpOffset = 0xF00;
constexpr uint64_t kAdapterI2cCoreResultCountOffset = 0xF04;
constexpr uint64_t kAdapterI2cCoreResultOffset = 0xF08;
// Canal privado do módulo GPIO do adaptador: pinos 0-31 / 32-39 com interrupção armada.
constexpr uint64_t kAdapterGpioIrqArmedAddress = 0x3FF44F00;

// Módulos cujos despertares só mexem em saídas deste MCU (e no snapshot de GPIO_IN): eventos suaves
// do lockstep. O I2C fica de fora -- cada fase publica o estado do barramento para o QEMU (C2A).
bool lockstepSoftModule(ModuleKind kind) {
    return kind == ModuleKind::Spi || kind == ModuleKind::Pwm || kind == ModuleKind::Usart;
}

// LASECSIMUL_LOCKSTEP_SOFT=0: toda borda vale como rígida (diagnóstico; mesmo resultado, mais lento).
bool lockstepSoftEventsEnabled() {
    static const bool enabled = [] {
        const char* value = std::getenv("LASECSIMUL_LOCKSTEP_SOFT");
        return !(value && std::strcmp(value, "0") == 0);
    }();
    return enabled;
}
enum : uint32_t { kAdapterI2cOpRestart = 0, kAdapterI2cOpWrite = 1, kAdapterI2cOpRead = 2, kAdapterI2cOpStop = 3 };

} // namespace

McuComponent::CallbackState::CallbackState() {
    const char* configured = std::getenv("LASECSIMUL_MCU_POLL_WAIT_TIMEOUT_MS");
    if (configured && *configured) {
        char* end = nullptr;
        const long parsed = std::strtol(configured, &end, 10);
        if (end && *end == '\0' && parsed >= 1 && parsed <= 50) {
            boundedWaitTimeoutMs = static_cast<uint32_t>(parsed);
        } else {
            std::fprintf(stderr,
                         "[LasecSimul] invalid LASECSIMUL_MCU_POLL_WAIT_TIMEOUT_MS='%s'; using 5ms\n",
                         configured);
        }
    }
#ifdef _WIN32
    stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!stopEvent) throw std::runtime_error("CreateEventW failed for MCU poll stop event");
#endif
}

McuComponent::CallbackState::~CallbackState() {
#ifdef _WIN32
    if (doorbell) CloseHandle(static_cast<HANDLE>(doorbell));
    if (stopEvent) CloseHandle(static_cast<HANDLE>(stopEvent));
#endif
}

uint64_t McuComponent::lockstepProvenNs() const {
    return std::max(m_vnextBHeartbeatWatermarkNs.load(std::memory_order_acquire),
                    m_lockstepPrefetchNs.load(std::memory_order_acquire));
}

std::optional<uint64_t> McuComponent::lockstepLimitNs() const {
    if (!m_controller.lockstep()) return std::nullopt;
    return vnextEventTimeNs(m_qemuTimeOriginNs.load(std::memory_order_relaxed), lockstepProvenNs());
}

bool McuComponent::vnextBGpioInterruptArmedLocked() const {
    QemuModule* gpio = findModule(kVnextBGpioInAddresses[0]);
    return gpio && (gpio->readRegister(kAdapterGpioIrqArmedAddress) != 0 ||
                    gpio->readRegister(kAdapterGpioIrqArmedAddress + 4) != 0);
}

double McuComponent::lockstepCpuDilation() const {
    return m_controller.lockstep() ? m_controller.vnextBAttachment().artifactCpuDilation() : 1.0;
}

void McuComponent::publishLockstepTime(uint64_t nowNs, uint64_t nextEventNs, uint64_t nextHardEventNs,
                                       uint64_t peersProvenNs, std::optional<uint64_t> scheduleNs) {
    if (!m_controller.lockstep()) return;
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    if (!m_controller.vnextBActive() || !m_controller.lockstep()) return;
    // Entradas antes do tempo: o QEMU consome o C2A ao soltar as vCPUs, então uma borda que o
    // circuito produziu neste instante chega ao guest neste mesmo instante.
    publishVnextBGpioInputsLocked();
    const uint64_t originNs = m_qemuTimeOriginNs.load(std::memory_order_relaxed);
    const uint64_t limitNs = vnextEventTimeNs(originNs, lockstepProvenNs());
    // Tudo até doneNs está processado: o instante atual, nunca além do que o QEMU provou, e antes
    // de qualquer evento que ainda espera na fila.
    uint64_t doneNs = std::min(nowNs, limitNs);
    if (nextEventNs <= doneNs) {
        if (nextEventNs <= originNs) return;
        doneNs = nextEventNs - 1;
    }
    if (doneNs < originNs) return;
    const uint64_t timeNs = doneNs - originNs;
    // Dois horizontes, ambos à frente de doneNs (nextEventNs > doneNs aqui, e o próximo evento
    // rígido nunca vem antes do próximo evento):
    //  - de entrada: o próximo evento de qualquer tipo pode mover um pad -- uma leitura de GPIO_IN
    //    a partir dele sincroniza;
    //  - rígido: o guest não passa dele sem sincronizar. Eventos suaves (bordas que só mexem em
    //    saídas deste MCU: SPI, LEDC, UART TX) ficam de fora enquanto nenhum pino tiver interrupção
    //    armada -- sem interrupção, uma borda só é vista lendo GPIO_IN. Com uma armada, qualquer borda
    //    pode chegar a ela pelo circuito e vale como rígida.
    // Teto comum: o quantum e, com outros MCUs em lockstep, o ponto até onde eles já chegaram.
    uint64_t capNs = timeNs + kLockstepQuantumNs;
    if (peersProvenNs != UINT64_MAX && peersProvenNs >= originNs)
        capNs = std::min(capNs, std::max(peersProvenNs - originNs, timeNs) + kLockstepPeerLookaheadNs);
    const auto toArtifact = [&](uint64_t coreNs) {
        return coreNs == UINT64_MAX ? capNs : std::min(coreNs - originNs, capNs);
    };
    const uint64_t inputHorizonNs = toArtifact(nextEventNs);
    const uint64_t horizonNs = toArtifact(!lockstepSoftEventsEnabled() || vnextBGpioInterruptArmedLocked() ? nextEventNs
                                                                          : std::max(nextHardEventNs, nextEventNs));
    const uint64_t syncSeq = m_lockstepObservedSyncSeq.load(std::memory_order_acquire);
    if (lockstepTraceEnabled()) ++g_lockstepTrace.cycles;
    if (syncSeq == m_lockstepPublishedSeq && timeNs == m_lockstepPublishedTimeNs &&
        horizonNs == m_lockstepPublishedHorizonNs && inputHorizonNs == m_lockstepPublishedInputHorizonNs) return;
    if (lockstepTraceEnabled() && syncSeq != g_lockstepTrace.releasedSeq && timeNs >= m_vnextBHeartbeatWatermarkNs.load()) {
        g_lockstepTrace.releasedSeq = syncSeq;
        auto& t = g_lockstepTrace;
        const uint64_t now = steadyNowNs();
        ++t.syncs;
        t.observeToPublishNs += now - t.observedNs;
        if ((t.syncs & (t.syncs - 1)) == 0 || t.syncs % 65536 == 0)
            std::fprintf(stderr, "[LOCKSTEP_CORE] syncs=%llu avg_wake_to_observe_ns=%llu avg_observe_to_publish_ns=%llu hook_calls=%llu\n",
                         static_cast<unsigned long long>(t.syncs),
                         static_cast<unsigned long long>(t.wakeToObserveNs / t.syncs),
                         static_cast<unsigned long long>(t.observeToPublishNs / t.syncs),
                         static_cast<unsigned long long>(t.cycles));
    }
    m_lockstepPublishedSeq = syncSeq;
    m_lockstepPublishedTimeNs = timeNs;
    m_lockstepPublishedHorizonNs = horizonNs;
    m_lockstepPublishedInputHorizonNs = inputHorizonNs;
    // Onde a simulação deveria estar pelo relógio real, na linha do tempo do artefato (0 = sem pacing).
    const uint64_t scheduleArtifactNs = scheduleNs && *scheduleNs > originNs ? *scheduleNs - originNs : 0;
    m_controller.vnextBAttachment().publishCoreTime(syncSeq, timeNs, horizonNs, inputHorizonNs, scheduleArtifactNs);
}

std::optional<uint64_t> McuComponent::pacingPositionNs() const {
    const uint64_t ps = m_latestVirtualTimePs.load(std::memory_order_relaxed);
    const uint64_t appliedPositionLegacy =
        ps == 0 ? 0 : qemuEventTimeNs(
                            m_qemuTimeOriginNs.load(std::memory_order_relaxed), ps);
    // PLAN_MTTCG_VNEXT_B_CAUSALITY.md section 10.5: VNEXT_B's applied position. Stored raw
    // (session-relative, see the store site's comment) and origin-adjusted here at read time,
    // the same convention as the legacy field just above -- only one of the two transports is
    // ever active for a given session, so the other's field simply stays 0 and max() picks the
    // live one.
    const uint64_t vnextBNs = m_latestVnextBVirtualTimeNs.load(std::memory_order_relaxed);
    const uint64_t appliedPositionVnextB =
        vnextBNs == 0 ? 0 : vnextEventTimeNs(m_qemuTimeOriginNs.load(std::memory_order_relaxed), vnextBNs);
    const uint64_t appliedPosition =
        appliedPositionLegacy > appliedPositionVnextB ? appliedPositionLegacy : appliedPositionVnextB;
    const uint64_t pendingPosition =
        m_nextPendingEventNs.load(std::memory_order_relaxed);
    // R3c heartbeat watermark: proves virtual time elapsed even when the guest produced no
    // lane events at all (legitimately silent -- WFI, no GPIO/I2C). Same raw-stored/
    // origin-adjusted-at-read convention as appliedPositionVnextB above. This is a pacing FLOOR
    // only: it never feeds latestVirtualTimeNs() or the arbiter, and it does not represent any
    // applied/dispatched event.
    const uint64_t heartbeatNs = m_vnextBHeartbeatWatermarkNs.load(std::memory_order_relaxed);
    const uint64_t heartbeatPosition =
        heartbeatNs == 0 ? 0 : vnextEventTimeNs(m_qemuTimeOriginNs.load(std::memory_order_relaxed), heartbeatNs);
    uint64_t safeFrontier =
        appliedPosition > pendingPosition ? appliedPosition : pendingPosition;
    if (heartbeatPosition > safeFrontier) safeFrontier = heartbeatPosition;
    if (safeFrontier == 0) return std::nullopt;
    return safeFrontier;
}

McuComponent::McuComponent(std::unique_ptr<IMcuAdapter> adapter, simulation::Scheduler& scheduler,
                           std::span<const Pin> requestedPins)
    : m_adapter(std::move(adapter)), m_scheduler(scheduler), m_controller(*m_adapter),
      m_callbackState(std::make_shared<CallbackState>()) {
    m_callbackState->owner = this;
    m_modules = m_adapter->createModules();
    m_moduleWakeupDueNs.assign(m_modules.size(), QemuModule::kNoWakeup);
    m_moduleWakeupGeneration.assign(m_modules.size(), 0);

    const auto pinMap = m_adapter->pinMap();
    m_pins.reserve(pinMap.size());
    for (size_t index = 0; index < pinMap.size(); ++index) {
        // Metadata and subcircuit endpoints may enumerate pins in a different
        // order (JSON objects, for example, sort GPIO10 before GPIO2). Modules
        // are indexed in adapter order: match authoring coordinates by identity,
        // never rename an adapter line using the same positional index.
        const auto requested = std::find_if(requestedPins.begin(), requestedPins.end(),
            [&](const Pin& pin) { return pin.id == pinMap[index].pinId; });
        if (requested != requestedPins.end()) {
            m_pins.push_back(*requested);
            continue;
        }
        m_pins.push_back(Pin{pinMap[index].pinId});
    }
    m_moduleByPin.reserve(pinMap.size());
    for (const PinMapping& mapping : pinMap) {
        QemuModule* resolved = nullptr;
        for (const std::unique_ptr<QemuModule>& module : m_modules) {
            if (module->kind() == mapping.moduleKind && module->index() == mapping.moduleIndex) {
                resolved = module.get();
                break;
            }
        }
        m_moduleByPin.push_back(resolved);
    }
    m_pinBatchByPin.assign(pinMap.size(), kNoPinBatch);
    for (size_t index = 0; index < pinMap.size(); ++index) {
        QemuModule* module = m_moduleByPin[index];
        if (!module || pinMap[index].moduleKind == ModuleKind::Reset) continue; // ver stampResetPin()
        auto batch = std::find_if(m_pinBatches.begin(), m_pinBatches.end(),
                                  [&](const PinBatch& candidate) { return candidate.module == module; });
        if (batch == m_pinBatches.end()) batch = m_pinBatches.insert(m_pinBatches.end(), PinBatch{module});
        m_pinBatchByPin[index] = static_cast<uint32_t>(batch - m_pinBatches.begin());
        batch->pinIndices.push_back(static_cast<uint32_t>(index));
        batch->bitsOrLines.push_back(pinMap[index].bitOrLine);
    }
    for (PinBatch& batch : m_pinBatches) {
        batch.inputBits.reserve(batch.bitsOrLines.size());
        batch.inputVoltages.reserve(batch.bitsOrLines.size());
    }
    m_pinStates.assign(pinMap.size(), 0);
    // m_controller já chamou setMemoryRegions(m_adapter->memoryRegions()) no próprio construtor.
}

McuComponent::~McuComponent() {
    stopPolling();
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    m_callbackState->owner = nullptr;
    m_controller.stop();
}

PluginHealthStatus McuComponent::health() const {
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    PluginHealthStatus worst = m_adapter->health();
    for (const std::unique_ptr<QemuModule>& module : m_modules) {
        const PluginHealthStatus moduleHealth = module->health();
        if (moduleHealth == PluginHealthStatus::Faulted) return PluginHealthStatus::Faulted;
        if (moduleHealth == PluginHealthStatus::Lagging && worst == PluginHealthStatus::Ok) worst = PluginHealthStatus::Lagging;
    }
    return worst;
}

void McuComponent::onAssignedIndex(uint32_t index) {
    m_componentIndex = index;
}

void McuComponent::startPolling(std::vector<DeferredSchedulerCall>* deferred) {
    // Recargas dentro da mesma timeline reutilizam o callback que já está na fila: ele executará
    // contra a arena atual e schedulePollAt() impede duplicatas. Scheduler::reset() é diferente:
    // ele descarta callbacks sem executar onPollEvent(), portanto sua geração monotônica informa
    // quando a flag local precisa ser liberada e callbacks da timeline anterior invalidados.
    const uint64_t schedulerResetGeneration = m_scheduler.resetGeneration();
    if (m_pollSchedulerResetGeneration != schedulerResetGeneration) {
        m_pollSchedulerResetGeneration = schedulerResetGeneration;
        ++m_pollGeneration;
        m_pollEventScheduled = false;
        m_pollEventDueNs = UINT64_MAX;
    }
    m_polling.store(true, std::memory_order_release);
    scheduleNextPoll(deferred);
}

void McuComponent::stopPolling() {
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    m_polling.store(false, std::memory_order_release);
#ifdef _WIN32
    if (m_callbackState->stopEvent &&
        !SetEvent(static_cast<HANDLE>(m_callbackState->stopEvent))) {
        std::fprintf(stderr, "[LasecSimul] SetEvent failed for MCU poll stop event: %lu\n",
                     static_cast<unsigned long>(GetLastError()));
    }
#endif
}

void McuComponent::bindPollDoorbellLocked(const std::string& arenaName) {
    CallbackState& state = *m_callbackState;
    if (state.expectedDoorbellArenaName.empty()) state.expectedDoorbellArenaName = arenaName;
    else if (state.expectedDoorbellArenaName != arenaName) {
        throw std::runtime_error("MCU poll doorbell cannot be rebound to a different arena name");
    }
#ifdef _WIN32
    if (state.doorbell) return;
    const std::string utf8Name = arenaName + "-doorbell";
    const int chars = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8Name.c_str(), -1,
                                          nullptr, 0);
    if (chars <= 0) return;
    std::wstring name(static_cast<size_t>(chars), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8Name.c_str(), -1, name.data(), chars);
    SetLastError(ERROR_SUCCESS);
    HANDLE handle = CreateEventW(nullptr, FALSE, FALSE, name.c_str());
    const DWORD error = GetLastError();
    if (!handle) {
        std::fprintf(stderr, "[LasecSimul] I2C doorbell unavailable (%lu); timed fallback active\n",
                     static_cast<unsigned long>(error));
        return;
    }
    if (error == ERROR_ALREADY_EXISTS) {
        std::fprintf(stderr, "[LasecSimul] I2C doorbell name already exists; timed fallback active\n");
        CloseHandle(handle);
        return;
    }
    state.doorbell = handle;
#else
    (void)arenaName;
#endif
}

void McuComponent::waitForPollWork(const std::shared_ptr<CallbackState>& state) {
#ifdef _WIN32
    HANDLE stop = static_cast<HANDLE>(state->stopEvent);
    HANDLE doorbell = static_cast<HANDLE>(state->doorbell);
    const DWORD timeout = state->boundedWaitTimeoutMs;
    if (doorbell) {
        HANDLE handles[2]{stop, doorbell};
        const DWORD result = WaitForMultipleObjects(2, handles, FALSE, timeout);
        if (result == WAIT_OBJECT_0) state->stopEventWakeCount.fetch_add(1, std::memory_order_relaxed);
        else if (result == WAIT_OBJECT_0 + 1) state->doorbellWakeCount.fetch_add(1, std::memory_order_relaxed);
        else if (result == WAIT_TIMEOUT) state->normalTimeoutCount.fetch_add(1, std::memory_order_relaxed);
        else {
            state->multiWaitFailedCount.fetch_add(1, std::memory_order_relaxed);
            const DWORD stopResult = WaitForSingleObject(stop, timeout);
            if (stopResult == WAIT_FAILED) {
                state->singleStopWaitFailedCount.fetch_add(1, std::memory_order_relaxed);
                state->level3SleepFallbackCount.fetch_add(1, std::memory_order_relaxed);
                Sleep(timeout);
            }
        }
        return;
    }
    state->doorbellUnavailableFallbackWaits.fetch_add(1, std::memory_order_relaxed);
    const DWORD result = WaitForSingleObject(stop, timeout);
    if (result == WAIT_OBJECT_0) state->stopEventWakeCount.fetch_add(1, std::memory_order_relaxed);
    else if (result == WAIT_TIMEOUT) state->normalTimeoutCount.fetch_add(1, std::memory_order_relaxed);
    else if (result == WAIT_FAILED) {
        state->singleStopWaitFailedCount.fetch_add(1, std::memory_order_relaxed);
        state->level3SleepFallbackCount.fetch_add(1, std::memory_order_relaxed);
        Sleep(timeout);
    }
#else
    state->doorbellUnavailableFallbackWaits.fetch_add(1, std::memory_order_relaxed);
    std::this_thread::sleep_for(std::chrono::milliseconds(state->boundedWaitTimeoutMs));
#endif
}

void McuComponent::scheduleNextPoll(std::vector<DeferredSchedulerCall>* deferred, bool schedulerLockHeld) {
    // +1ns (não `nowNs()` cru): quando chamado de dentro de `onPollEvent()` sem o Scheduler
    // rodando em background (`isRunning()==false` -- driver síncrono via `step()`/testes), um
    // evento reagendado EXATAMENTE no instante atual é reprocessado na MESMA passada de
    // `runUntil()` (o laço interno consome qualquer evento com `timeNs <= nextTime`, e `m_nowNs`
    // nunca avança processando um evento no MESMO instante) -- livelock genuíno, `m_nowNs` nunca
    // avança, achado do diagnóstico "QEMU manda sinal mas vem como pulso e não retém": mascarado
    // até aqui só porque o reset fantasma do EN/RST (ver `m_resetPinObserved`) fechava a arena
    // antes deste laço rodar. O +1ns é imperceptível pro caso normal (`startPolling()`, chamado
    // fora de `runUntil()`) e garante que `m_nowNs` sempre progride, então o laço termina.
    schedulePollAt(m_scheduler.nowNs() + 1, deferred, schedulerLockHeld);
}

void McuComponent::schedulePollAt(uint64_t timeNs, std::vector<DeferredSchedulerCall>* deferred,
                                   bool schedulerLockHeld) {
    if (m_pollEventScheduled) {
        if (timeNs >= m_pollEventDueNs) return;
        /* Um mailbox síncrono (I2C burst) pode chegar enquanto há um poll marcado para um evento
         * normal futuro. Ele precisa preemptar esse prazo: o QEMU não pode avançar até receber a
         * resposta, portanto esperar o evento futuro cria um bloqueio circular com o pacing. Não
         * há cancelamento físico no Scheduler; avance a geração para tornar o callback antigo um
         * no-op e publique o callback anterior. */
        ++m_pollGeneration;
    }
    m_pollEventScheduled = true;
    m_pollEventDueNs = timeNs;
    const std::weak_ptr<CallbackState> weakState = m_callbackState;
    const uint64_t generation = m_pollGeneration;
    auto callback = [weakState, generation] {
        const std::shared_ptr<CallbackState> state = weakState.lock();
        if (!state) return;
        std::vector<DeferredSchedulerCall> schedulerCalls;
        {
            std::lock_guard<std::recursive_mutex> lock(state->mutex);
            McuComponent* self = state->owner;
            if (!self || self->m_pollGeneration != generation) return;
            if (self->m_controller.vnextBActive()) {
                self->m_pollEventScheduled = false;
                self->m_pollEventDueNs = UINT64_MAX;
                // Future VNEXT work is independent of legacy m_polling. Queue
                // any rearming until outside the lifetime lock: health readers
                // acquire Scheduler -> lifetime, so the opposite order deadlocks.
                self->pollAndDispatchPendingEvents(self->m_scheduler.nowNs(), &schedulerCalls);
                self->m_scheduler.markDirty(self->m_componentIndex);
            } else {
                self->onPollEvent();
            }
        }
        for (auto& call : schedulerCalls) call();
    };
    // Same three-way branch as scheduleModuleWakeup()'s established pattern: deferred takes
    // priority (batched, flushed outside the lock later); otherwise schedulerLockHeld selects
    // between the two Scheduler entry points that differ only in whether they take
    // Scheduler::m_mutex themselves (scheduleAt(), unsafe if already held -- real deadlock, see
    // this function's declaration comment) or assume the caller already holds it
    // (scheduleEventUnlocked()).
    if (deferred) {
        deferred->push_back([&scheduler = m_scheduler, timeNs, callback = std::move(callback)]() mutable {
            scheduler.scheduleAt(timeNs, std::move(callback));
        });
    } else if (schedulerLockHeld) {
        const uint64_t nowNs = m_scheduler.nowNs();
        const uint64_t delayNs = timeNs > nowNs ? timeNs - nowNs : 0;
        m_scheduler.scheduleEventUnlocked(delayNs, std::move(callback));
    } else {
        m_scheduler.scheduleAt(timeNs, std::move(callback));
    }
}

void McuComponent::onPollEvent() {
    m_pollEventScheduled = false;
    m_pollEventDueNs = UINT64_MAX;
    if (m_scheduler.isRunning()) {
        // PERF-12: com um worker de verdade rodando em background, o busy-wait "sem evento ainda"
        // sai da thread do Scheduler (onde travava TODOS os outros MCUs/settle atrás dele na fila,
        // ver docs/33-plano-revisao-arquitetural-core.md secao 5.3) e vai para uma thread dedicada
        // por MCU -- ela mesma despacha eventos prontos (sob o mesmo m_callbackState->mutex que já
        // serializa contra stamp()) e devolve o controle pra cá via schedulePollAt() assim que
        // encontra um evento futuro, exatamente como o caminho síncrono abaixo já fazia.
        //
        // Achado 2026-07-23 (janela entre "Scheduler alcançou o timestamp agendado" e "a thread de
        // poll recém-criada rodou pela primeira vez"): este callback roda na própria thread do
        // Scheduler, com Scheduler::m_mutex JÁ SOLTO (ver processNextEventUntilLocked: unlock ->
        // callback() -> lock) -- então é seguro despachar aqui, direto, ANTES de delegar a thread
        // dedicada. Sem isto, startBackgroundPollThreadIfNeeded() só CRIA a thread e retorna na
        // hora (não espera ela rodar nem uma vez) -- o laço de runUntil() (nada mais dirty pra
        // assentar ainda) ficava livre pra avançar m_nowNs por cima de eventos SEGUINTES do MESMO
        // MCU antes da thread recém-criada sequer ganhar sua primeira fatia de CPU do SO pra
        // despachar o evento atual. Despachar aqui, síncrono, fecha essa janela pro evento que JÁ
        // SABEMOS estar pronto agora (é por isso que este callback disparou); a thread dedicada
        // assume só o que sobrar (evento futuro ainda não vencido, ou nada). Ressalva honesta: essa
        // janela é real e esta correção a fecha, mas NÃO é a causa do GPIO13 travado em LOW visto
        // com firmware real. A causa foi o ACK de um SIM_FREQ do slot legado avançando uma escrita
        // recém-chegada na fila; ver dispatchArenaEvent()/QemuArenaEvent::fromQueue.
        while (m_polling.load(std::memory_order_acquire) && pollStepLocked() == PollStep::DispatchedReady) {
        }
        startBackgroundPollThreadIfNeeded();
        return;
    }
    // Sem worker em background (driver síncrono via step()/runUntil(), ex: testes) -- mesma
    // ressalva de sempre: uma thread dedicada aqui não teria quem drenar m_events por conta própria,
    // então mantém o comportamento de sempre (reagenda +1ns e devolve o controle pro chamador
    // síncrono em vez de bloquear esperando um evento que só chega quando ELE avançar o relógio).
    qemu::QemuArenaBridge& arena = m_controller.arenaBridge();
    while (m_polling.load(std::memory_order_acquire) && arena.isOpen()) {
        const PollStep step = pollStepLocked();
        if (step == PollStep::DeferredFuture) return;
        if (step == PollStep::NoEvent) {
            scheduleNextPoll();
            return;
        }
        // DispatchedReady: a próxima iteração agrupa ações do mesmo timestamp.
    }
}

McuComponent::PollStep McuComponent::pollStepLocked(std::vector<DeferredSchedulerCall>* deferred) {
    qemu::QemuArenaBridge& arena = m_controller.arenaBridge();
    const uint64_t traceExecId = m_controller.runtimeIdentity().sessionExecutionId;
    if (m_controller.vnextBActive()) {
        return pollAndDispatchPendingEvents(m_scheduler.nowNsUnlocked(), deferred);
    }
    if (arena.pollI2cBurst()) {
        {
            const QueueSnap qs = snapshotQueue(arena);
            diag::trace(diag::ConsumerTraceEvent::D2_ReadIndexObserved, traceExecId, qs.writeIndex,
                        qs.readIndex, /*opcode=*/0xFFFFFFFFu /* I2C burst peek */);
        }
        /* Achado 2026-08-27 (investigação TG0WDT_SYS_RESET): arena.pollI2cBurst() é um peek sem
         * efeito colateral -- nada além de completeI2cBurst() consome o pedido. onPollEvent() (thread
         * do próprio Scheduler, isCurrentThreadWorker()==true) cai no ramo de baixo e despacha
         * sincronamente via processI2cBurstLocked(). Isso é intencional só pra fechar a janela de
         * partida ANTES da thread de poll dedicada existir (ver onPollEvent()) -- mas nada impedia
         * essa mesma chamada de continuar disparando em TODO poll subsequente do Scheduler mesmo
         * depois da thread de fundo já estar rodando e ter copiado o MESMO pedido (ainda pendente,
         * porque runBackgroundPollLoop() solta m_callbackState->mutex ANTES de despachar, de
         * propósito, pra não bloquear o mutex durante uma chamada de dispositivo potencialmente
         * lenta -- ver comentário em runBackgroundPollLoop()). As duas threads passavam no mesmo
         * peek antes de qualquer uma publicar completeI2cBurst(), cada uma chamando
         * NativeDeviceProxy::transferI2c() (e portanto o i2c_transfer() do plugin) de forma
         * independente pro mesmo i2cRequestSeq -- violando a invariante do protocolo (um pedido, um
         * dispatch, uma conclusão autoritativa). `pollThreadRunning` já é o estado de lifecycle
         * existente da thread de fundo (CAS ao nascer, revertido em toda saída/falha de lançamento,
         * ver startBackgroundPollThreadIfNeeded()/runBackgroundPollLoop()) -- reutilizado aqui como
         * regra de ownership por-lifecycle em vez de um claim atômico por-pedido: enquanto ele está
         * true, só a thread de fundo despacha I2C; a checagem abaixo faz a thread do Scheduler
         * desistir (adiar, não descartar) sempre que a de fundo já estiver de pé, preservando o
         * comportamento original de fechar a janela de partida (antes dela existir,
         * `pollThreadRunning` é false e este ramo despacha normalmente). */
        const bool backgroundThreadOwnsI2c =
            m_callbackState->pollThreadRunning.load(std::memory_order_acquire);
        /* Achado 2026-09-28 (rolagem do SSD1306 ~4x mais lenta que no hardware): os dois ramos
         * abaixo reagendavam um poll do Scheduler no MESMO instante enquanto o pedido esperava a
         * thread de fundo. Como o QEMU publica o burst microssegundos depois de a worker drenar a
         * escrita de CTR que o precede, a worker entrava num laço poll -> pedido pendente -> poll
         * no mesmo nowNs (~700 mil callbacks/s medidos), tomando este mutex a cada volta. A thread
         * de fundo precisa dele para reivindicar e concluir o pedido e ficava faminta (p90 ~4 ms
         * por aquisição, duas por burst); enquanto isso o relógio elétrico ficava parado, a fila
         * da arena enchia e o firmware via cada transação I2C custar milissegundos. */
        if (m_scheduler.isRunning() && !m_scheduler.isCurrentThreadWorker()) {
            // A thread de fundo perdeu a corrida contra um burst publicado depois da própria
            // checagem do mailbox: a próxima iteração dela o reivindica, sem esperar outra
            // campainha (que o QEMU não toca de novo enquanto aguarda esta resposta).
            return PollStep::DispatchedReady;
        }
        if (m_scheduler.isCurrentThreadWorker() && backgroundThreadOwnsI2c) {
            // A thread de fundo conclui o pedido sem a worker; ao terminar ela volta a olhar a
            // fila e agenda o próximo poll necessário. Não reagende nada aqui.
            return PollStep::DeferredFuture;
        }
        if (processI2cBurstLocked()) return PollStep::DispatchedReady;
    }
    const qemu::QemuPollResult result = arena.poll();
    // D2 STAGE 1 (2026-08-29, SHADOW/OBSERVATION ONLY -- see coreProgressNs's doc-comment in
    // qemu_arena_abi.h). Publishes Core's own causal position at the same already-audited
    // arena-observation point this file's diagnostic instrumentation has used for six rounds --
    // no new call site category, bounded to this function's own natural cadence (background poll
    // thread wake / dispatch), never per-Scheduler-iteration. Unconditional (not gated by the
    // LASECSIMUL_MCU_CONSUMER_TRACE diagnostic flag): this is a real protocol field now, not a
    // pure diagnostic probe -- but nothing on the QEMU side may use it to change behavior in this
    // stage; it is observed only.
    arena.publishCoreProgress(m_scheduler.nowNs());
    {
        const QueueSnap qs = snapshotQueue(arena);
        diag::trace(diag::ConsumerTraceEvent::D2_ReadIndexObserved, traceExecId, qs.writeIndex,
                    qs.readIndex,
                    (result.hasEvent && result.event) ? result.event->simuAction : 0xFFFFFFFFu);
        // TEMPORARY (ConsumerTrace investigation, round 2): occupancy alone is NOT the fatal event
        // (round 1 caught two 32/32 instances, both recovered while actively cycling) -- track
        // SUSTAINED pressure instead, cheap/no-I/O per poll (see ConsumerTrace.hpp::updatePressure).
        // The actual dump-on-failure stays at the existing test-level sites (TRAVOU NO MEIO/NAO
        // INICIALIZOU in SessionRestartStressTest.cpp), which already satisfies "immediately on
        // failure/QEMU host-error termination".
        diag::updatePressure(qs.writeIndex - qs.readIndex, diag::monotonicNs(), traceExecId,
                              qs.writeIndex, qs.readIndex);
        // TEMPORARY (ConsumerTrace investigation, round 9): reuses this same observation point to
        // update the shared pressure-phase indicator Scheduler.cpp reads (read-only from its side)
        // to classify nextTime-limiter stats by P0/P1/P2 -- no new call site, no new coupling.
        diag::updatePressurePhaseForTesting(qs.writeIndex - qs.readIndex);
        // TEMPORARY (ConsumerTrace investigation, round 8): healthy-vs-terminal baseline for the
        // specific I2C0 0x3ff53058 write round 7 identified as the terminal blocking entry, plus a
        // general backlog-horizon (head-vs-tail virtual-time span) sample when occupancy is
        // elevated. Both filter/gate internally (traceAddressWatch on regAddr match,
        // traceBacklogHorizon on the existing pressure threshold) -- effectively free when neither
        // condition holds. eventNs for the watch is recomputed here (not reused from below) only
        // because that computation hasn't happened yet at this point in the function.
        if (result.hasEvent && result.event) {
            const uint64_t occNow = qs.writeIndex - qs.readIndex;
            const uint64_t eventNsForWatch =
                qemuEventTimeNs(m_qemuTimeOriginNs.load(std::memory_order_relaxed), result.event->simuTimePs);
            diag::traceAddressWatch(result.event->regAddr, eventNsForWatch, m_scheduler.nowNs(), occNow,
                                     qs.readIndex, qs.writeIndex, result.event->simuTimePs);
            if (occNow >= diag::kPressureOccupancyThreshold) {
                const uint64_t tailPs = tailSimuTimePs(arena, qs.writeIndex, qs.readIndex);
                const uint64_t tailEventNs = qemuEventTimeNs(
                    m_qemuTimeOriginNs.load(std::memory_order_relaxed), tailPs);
                diag::traceBacklogHorizon(occNow, eventNsForWatch, tailEventNs);
            }
        }
    }
    if (!result.hasEvent || !result.event) return PollStep::NoEvent;

    // nowNs() é um snapshot lock-free (m_nowSnapshotNs), nunca toca Scheduler::m_mutex -- seguro
    // chamar segurando m_callbackState->mutex independente de `deferred`.
    const uint64_t eventNs = qemuEventTimeNs(m_qemuTimeOriginNs.load(std::memory_order_relaxed), result.event->simuTimePs);
    const uint64_t nowNs = m_scheduler.nowNs();
    if (eventNs > nowNs) {
        /*
         * A cabeça futura é uma fronteira segura: o QEMU já chegou a esse timestamp e
         * schedulePollAt() instala um callback exatamente nele. Sem publicar essa fronteira ao
         * pacing, um gap de heartbeat maior que a folga (10,8ms > 5ms reproduzido sob MTTCG)
         * cria um deadlock circular: Scheduler para antes do callback, Core não consome a cabeça,
         * a fila enche e o QEMU não publica o heartbeat intermediário que liberaria o teto.
         *
         * Não altera m_latestVirtualTimePs: métricas continuam representando somente eventos
         * aplicados. A cabeça futura serve apenas para alcançar o callback que a aplicará.
         */
        const uint64_t previous =
            m_nextPendingEventNs.exchange(eventNs, std::memory_order_relaxed);
        if (previous != eventNs) m_scheduler.notifyAdvanceLimitChanged();
        // Mantém a ação na arena e agenda uma única entrada exatamente no instante publicado. NÃO
        // avança m_latestVirtualTimePs aqui -- ver achado 2026-07-23 abaixo: isto só é seguro fazer
        // depois de confirmar que o evento está sendo despachado agora, não só espiado.
        schedulePollAt(eventNs, deferred);
        // TEMPORARY (ConsumerTrace investigation, round 2): the decisive question is WHY nowNs
        // doesn't reach eventNs before the queue stays saturated for ~3s -- record nowNs, eventNs,
        // delta, occupancy, and the just-published m_nextPendingEventNs for every DeferredFuture,
        // plus same-head repeat tracking (see ConsumerTrace.hpp::traceDeferredFuture). previous is
        // read again post-exchange purely for the trace value; exchange() above already applied it.
        {
            const QueueSnap qsAfter = snapshotQueue(arena);
            // TEMPORARY (round 7): resolve the owning module for this head entry's regAddr, same
            // read-only lookup dispatchArenaEvent() already uses -- identifies WHO published it
            // (which device/register), not just its opcode.
            const QemuModule* owningModule = findModule(result.event->regAddr);
            diag::traceDeferredFuture(nowNs, eventNs, qsAfter.writeIndex - qsAfter.readIndex,
                                       qsAfter.readIndex, m_nextPendingEventNs.load(std::memory_order_relaxed),
                                       result.event->simuAction, result.event->regAddr,
                                       owningModule ? static_cast<uint32_t>(owningModule->kind()) : 0xFFFFFFFFu,
                                       owningModule ? owningModule->index() : 0);
        }
        return PollStep::DeferredFuture;
    }
    m_nextPendingEventNs.store(0, std::memory_order_relaxed);

    // Achado 2026-07-23 (sincronização de ritmo): só avança m_latestVirtualTimePs DEPOIS de
    // confirmar `eventNs <= nowNs()` acima -- ou seja, só quando o evento está de fato sendo
    // despachado agora, não quando foi meramente espiado (arena.poll() é PEEK, não consome; a fila
    // pode ter até 32 entradas bufferizadas à frente do que foi realmente processado). Fazer isto
    // ANTES do teste acima (versão original) deixava pacingPositionNs() refletir o timestamp de um
    // evento ainda NÃO despachado -- com QEMU bufferizando rápido o bastante, isso inflava a
    // posição relatada ao AdvanceLimitFn sem necessidade. Ressalva honesta: esta correção é uma
    // melhoria de precisão real (confirmada sem regressão no ctest), mas investigação posterior
    // (2026-07-23, ver .spec) mostrou que o salto de Scheduler::nowNs() pro fim da simulação em uma
    // única chamada de runUntil() tinha uma causa DIFERENTE e mais simples (MCU com arena aberta
    // mas zero eventos despachados sendo excluído do cálculo do teto em vez de contar como posição
    // 0 -- ver SimulationSession::computeSlowestMcuPositionNs()), e nenhuma das duas explica o
    // travamento de GPIO13 em LOW com firmware real. A causa foi o ACK de um SIM_FREQ do slot
    // legado avançando uma entrada da fila sem despachá-la.
    {
        uint64_t observed = m_latestVirtualTimePs.load(std::memory_order_relaxed);
        bool advanced = false;
        while (result.event->simuTimePs > observed) {
            if (m_latestVirtualTimePs.compare_exchange_weak(observed, result.event->simuTimePs, std::memory_order_relaxed)) {
                advanced = true;
                break;
            }
        }
        if (advanced) m_scheduler.notifyAdvanceLimitChanged();
    }

    {
        const QueueSnap qs = snapshotQueue(arena);
        diag::trace(diag::ConsumerTraceEvent::D3_ProcessBegin, traceExecId, qs.writeIndex, qs.readIndex,
                    result.event->regAddr);
    }
    const bool changed = dispatchArenaEvent(*result.event, eventNs);
    {
        const QueueSnap qs = snapshotQueue(arena);
        diag::trace(diag::ConsumerTraceEvent::D4_ProcessEnd, traceExecId, qs.writeIndex, qs.readIndex,
                    result.event->regAddr);
        if (result.event->fromQueue) {
            diag::trace(diag::ConsumerTraceEvent::D5_ReadIndexAdvanced, traceExecId, qs.writeIndex,
                        qs.readIndex, result.event->regAddr);
        }
    }
    if (changed) {
        if (deferred) {
            /*
             * Publique o nivel eletrico atual ANTES de agendar a proxima borda do modulo.
             * No poll em background, ambas as operacoes viram chamadas adiadas executadas sem o
             * callbackState mutex. A ordem antiga era scheduleWakeup -> markDirty: o schedule
             * acordava a worker e, sob carga, ela conseguia executar a proxima borda UART antes de
             * markDirty publicar o start bit. O solver entao via direto o primeiro data bit e o
             * LasecPlot corrompia bytes esporadicamente a 921600 baud. Dirty primeiro garante um
             * settle do nivel presente; so' depois a borda seguinte pode entrar na fila.
             */
            deferred->push_back([&scheduler = m_scheduler, index = m_componentIndex] { scheduler.markDirty(index); });
        } else {
            m_scheduler.markDirty(m_componentIndex);
        }
    }
    scheduleWakeupsForAllModules(eventNs, false, deferred);
    return PollStep::DispatchedReady;
}

bool McuComponent::processI2cBurstLocked() {
    qemu::QemuArenaBridge& arena = m_controller.arenaBridge();
    const std::optional<qemu::QemuI2cBurst> pending = arena.pollI2cBurst();
    if (!pending) return false;
    const uint64_t traceExecId = m_controller.runtimeIdentity().sessionExecutionId;
    {
        const QueueSnap qs = snapshotQueue(arena);
        diag::trace(diag::ConsumerTraceEvent::D3_ProcessBegin, traceExecId, qs.writeIndex, qs.readIndex,
                    pending->sequence);
    }

    std::array<uint8_t, 32> rx{};
    I2cTransferResult result{};
    if (m_i2cTransferHandler && pending->txLen > 0) {
        const bool start = (pending->flags & 1u) != 0;
        const bool read = (pending->flags & 4u) != 0;
        /* ABI 5 sempre transporta o byte de endereço em tx[0], inclusive em uma continuação sem
         * START. Nesse caso ele é metadado de roteamento e não deve chegar ao payload do plugin. */
        const uint32_t payloadOffset = 1u;
        I2cTransfer transfer{};
        transfer.address = static_cast<uint8_t>(pending->tx[0] >> 1);
        transfer.read = read;
        transfer.start = start;
        transfer.stop = (pending->flags & 2u) != 0;
        transfer.txData = pending->tx + payloadOffset;
        transfer.txSize = pending->txLen - payloadOffset;
        transfer.rxData = rx.data();
        transfer.rxSize = pending->rxLen;
        transfer.periodNs = pending->periodNs;
        auto& traceRecorder = lasecsimul::trace::Recorder::instance();
        traceRecorder.setCurrentI2cRequest(pending->sequence);
        traceRecorder.setRuntimeIdentity(m_controller.runtimeIdentity());
        struct I2cTraceContextGuard { lasecsimul::trace::Recorder& r; ~I2cTraceContextGuard() { r.setCurrentI2cRequest(0); r.setRuntimeIdentity({}); } } guard{traceRecorder};
        result = m_i2cTransferHandler(m_componentIndex, pending->bus, transfer);
    }
    uint32_t status = (result.handled ? 1u : 0u) | (result.addressAck ? 2u : 0u);
    arena.completeI2cBurst(pending->sequence, status, result.firstNack,
                           std::span<const uint8_t>(rx.data(), std::min<uint32_t>(result.rxSize, 32)),
                           result.stretchNs);
    {
        const QueueSnap qs = snapshotQueue(arena);
        diag::trace(diag::ConsumerTraceEvent::D4_ProcessEnd, traceExecId, qs.writeIndex, qs.readIndex,
                    pending->sequence);
    }
    auto& tr = lasecsimul::trace::Recorder::instance(); tr.setRuntimeIdentity(m_controller.runtimeIdentity());
    tr.setCurrentI2cRequest(pending->sequence);
    tr.record(lasecsimul::trace::EventType::CoreI2cCompletionPublished, pending->sequence, pending->sequence, m_scheduler.nowNs());
    tr.setCurrentI2cRequest(0); tr.setRuntimeIdentity({});
    return true;
}

void McuComponent::startBackgroundPollThreadIfNeeded() {
#ifdef _WIN32
    if (m_callbackState->doorbell) {
        SetEvent(static_cast<HANDLE>(m_callbackState->doorbell));
    }
#endif
    bool expected = false;
    if (!m_callbackState->pollThreadRunning.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
        return; // já existe uma thread de poll ativa para este MCU -- ela vai pegar o estado atual.
    }
#ifdef _WIN32
    if (!ResetEvent(static_cast<HANDLE>(m_callbackState->stopEvent))) {
        m_callbackState->pollThreadRunning.store(false, std::memory_order_release);
        m_callbackState->pollWorkerLaunchFailed.store(true, std::memory_order_release);
        m_polling.store(false, std::memory_order_release);
        std::fprintf(stderr, "[LasecSimul] ResetEvent failed for MCU poll worker: %lu\n",
                     static_cast<unsigned long>(GetLastError()));
        return;
    }
#endif
    std::thread worker;
    try {
        worker = std::thread(&McuComponent::runBackgroundPollLoop, m_callbackState);
    } catch (...) {
        m_callbackState->pollThreadRunning.store(false, std::memory_order_release);
        m_callbackState->pollWorkerLaunchFailed.store(true, std::memory_order_release);
        m_polling.store(false, std::memory_order_release);
        return;
    }
    worker.detach();
    m_callbackState->pollWorkerLaunchFailed.store(false, std::memory_order_release);
}

void McuComponent::runBackgroundPollLoop(std::shared_ptr<CallbackState> state) {
    // Nunca guarda `McuComponent*` fora do escopo do lock abaixo -- `state` (CallbackState) é a
    // única coisa que esta thread mantém viva sozinha; McuComponent pode ser destruído a qualquer
    // momento entre duas iterações (ver ~McuComponent(), que zera `owner` sob o mesmo mutex antes
    // de qualquer membro ser desalocado).
    // TEMPORARY (ConsumerTrace investigation, see ConsumerTrace.hpp): identify this thread's
    // lifetime and the ONE synchronization primitive that can block D1 (entering the drain
    // section below) -- `state->mutex`, a recursive_mutex also taken by Scheduler::stamp() (see
    // CallbackState doc-comment in the .hpp for the documented lock-order rule). Any acquisition
    // here slower than kWaitThresholdNs is recorded (start/end/duration), without changing the
    // lock type, order, or any other locking behavior -- std::unique_lock is a drop-in RAII
    // equivalent to the std::lock_guard it replaces below.
    constexpr uint64_t kWaitThresholdNs = 5'000'000; // 5ms -- generous vs. the 5ms bounded wait itself
    diag::trace(diag::ConsumerTraceEvent::ThreadStart, 0, 0, 0);
    bool restartAfterExit = false;
    for (;;) {
        diag::trace(diag::ConsumerTraceEvent::D0_Wake, 0, 0, 0);
        PollStep step = PollStep::NoEvent;
        bool stop = false;
        std::optional<qemu::QemuI2cBurst> backgroundI2c;
        I2cTransferHandler backgroundI2cHandler;
        uint32_t backgroundComponentIndex = 0;
        std::vector<DeferredSchedulerCall> deferred;
        {
            const uint64_t lockWaitStartNs = diag::traceEnabled() ? diag::monotonicNs() : 0;
            std::unique_lock<std::recursive_mutex> lock(state->mutex);
            if (diag::traceEnabled()) {
                const uint64_t lockWaitEndNs = diag::monotonicNs();
                if (lockWaitEndNs - lockWaitStartNs > kWaitThresholdNs) {
                    diag::traceWait(0, lockWaitStartNs, lockWaitEndNs, /*ownerThreadIdIfKnown=*/0);
                }
            }
            McuComponent* self = state->owner;
            const uint64_t traceExecId = self ? self->m_controller.runtimeIdentity().sessionExecutionId : 0;
            diag::trace(diag::ConsumerTraceEvent::D1_LoopEnter, traceExecId, 0, 0);
            if (!self || !self->m_polling.load(std::memory_order_acquire)) {
                stop = true;
                restartAfterExit = self != nullptr;
            } else {
                qemu::QemuArenaBridge& arena = self->m_controller.arenaBridge();
                if (!arena.isOpen()) {
                    stop = true;
                    restartAfterExit = true;
                } else if (arena.pollI2cBurst() && self->m_scheduler.isRunning() &&
                           !self->m_scheduler.isCurrentThreadWorker()) {
                    /* Não agende o mailbox na timeline: o QEMU está bloqueado esperando esta
                     * resposta e pode não produzir o evento futuro que liberaria o pacing. Copie
                     * o pedido aqui e execute depois de soltar o mutex do MCU. A topologia é
                     * imutável durante Run e NativeDeviceProxy serializa o próprio estado. */
                    backgroundI2c = arena.pollI2cBurst();
                    backgroundI2cHandler = self->m_i2cTransferHandler;
                    backgroundComponentIndex = self->m_componentIndex;
                    /* TEMPORARY, minimal diagnostic (TG0WDT_SYS_RESET investigation, 2026-08-27) --
                     * C0: request claimed by the background poll thread, before the handler call.
                     * Uses the existing causal-trace Recorder (LASECSIMUL_CAUSAL_TRACE=detailed),
                     * not a new mechanism -- see CausalTrace.hpp. Remove once concluded. */
                    if (backgroundI2c) {
                        auto& tr = lasecsimul::trace::Recorder::instance();
                        tr.setRuntimeIdentity(self->m_controller.runtimeIdentity());
                        tr.record(lasecsimul::trace::EventType::CoreI2cBurstClaimed,
                                  backgroundI2c->sequence, backgroundI2c->sequence, self->m_scheduler.nowNs());
                        const QueueSnap qs = snapshotQueue(arena);
                        diag::trace(diag::ConsumerTraceEvent::D2_ReadIndexObserved, traceExecId,
                                    qs.writeIndex, qs.readIndex, backgroundI2c->sequence);
                    }
                } else {
                    step = self->pollStepLocked(&deferred);
                    if (step == PollStep::NoEvent && !self->m_scheduler.isRunning()) {
                        // O Scheduler deixou de rodar em background enquanto esperávamos (ex: Stop)
                        // -- só sai, SEM reagendar. Achado 2026-07-22 (SessionRestartStressTest,
                        // 15/15 ciclos travando pra sempre após o primeiro): reagendar aqui via
                        // scheduleNextPoll() (versão antiga desta linha) deixava m_pollEventScheduled
                        // preso em `true` para sempre sempre que este ramo disparasse durante
                        // SimulationSession::stopSimulation() -- ela para o Scheduler ANTES de
                        // chamar stopFirmware() (de propósito: nenhum componente pode voltar a
                        // agendar trabalho enquanto as MCUs são encerradas), então esta thread podia
                        // flagrar "sem evento + Scheduler parou" bem nessa janela e agendar um
                        // callback num Scheduler prestes a ser resetado. Esse callback é o ÚNICO
                        // lugar que zera m_pollEventScheduled (em onPollEvent()) -- mas
                        // Scheduler::reset() (chamado logo depois, em stopSimulation()) descarta a
                        // fila de eventos sem executá-lo, e a flag ficava presa para sempre: todo
                        // load posterior via startPolling()->scheduleNextPoll()->schedulePollAt()
                        // via a flag presa e desistia silenciosamente, nenhuma thread de poll nunca
                        // mais nascia, o MCU travava pra sempre. Nenhum chamador real de
                        // Scheduler::stop() deixa a arena aberta esperando um "ponto de retomada"
                        // agendado (stopSimulation() sempre também chama stopFirmware()+reset() logo
                        // em seguida) -- sair sem reagendar é seguro e evita a pegadinha.
                        stop = true;
                        restartAfterExit = true;
                    }
                }
            }
        }
        // As chamadas ao Scheduler coletadas acima (markDirty/scheduleEvent/scheduleAt) só
        // disparam AQUI, com `state->mutex` já solto -- ver doc-comment de DeferredSchedulerCall
        // no .hpp: stamp() (thread do Scheduler) adquire Scheduler::m_mutex e SÓ DEPOIS
        // m_callbackState->mutex; segurar as duas ao mesmo tempo na ordem inversa aqui
        // deadlockaria assim que as duas threads se cruzassem no mesmo MCU.
        for (DeferredSchedulerCall& call : deferred) call();

        if (backgroundI2c) {
            diag::trace(diag::ConsumerTraceEvent::D3_ProcessBegin, 0, 0, 0, backgroundI2c->sequence);
            std::array<uint8_t, 32> rx{};
            I2cTransferResult result{};
            if (backgroundI2cHandler && backgroundI2c->txLen > 0) {
                const bool start = (backgroundI2c->flags & 1u) != 0;
                I2cTransfer transfer{};
                transfer.address = static_cast<uint8_t>(backgroundI2c->tx[0] >> 1);
                transfer.read = (backgroundI2c->flags & 4u) != 0;
                transfer.start = start;
                transfer.stop = (backgroundI2c->flags & 2u) != 0;
                transfer.txData = backgroundI2c->tx + 1;
                transfer.txSize = backgroundI2c->txLen - 1;
                transfer.rxData = rx.data();
                transfer.rxSize = backgroundI2c->rxLen;
                transfer.periodNs = backgroundI2c->periodNs;
                auto& traceRecorder = lasecsimul::trace::Recorder::instance();
                traceRecorder.setCurrentI2cRequest(backgroundI2c->sequence);
                traceRecorder.setRuntimeIdentity(state->owner ? state->owner->m_controller.runtimeIdentity() : RuntimeLaunchIdentity{});
                struct I2cTraceContextGuard { lasecsimul::trace::Recorder& r; ~I2cTraceContextGuard() { r.setCurrentI2cRequest(0); r.setRuntimeIdentity({}); } } guard{traceRecorder};
                result = backgroundI2cHandler(backgroundComponentIndex, backgroundI2c->bus, transfer);
            }
            {
                const uint64_t lockWaitStartNs = diag::traceEnabled() ? diag::monotonicNs() : 0;
                std::unique_lock<std::recursive_mutex> lock(state->mutex);
                if (diag::traceEnabled()) {
                    const uint64_t lockWaitEndNs = diag::monotonicNs();
                    if (lockWaitEndNs - lockWaitStartNs > kWaitThresholdNs) {
                        diag::traceWait(0, lockWaitStartNs, lockWaitEndNs, /*ownerThreadIdIfKnown=*/0);
                    }
                }
                McuComponent* self = state->owner;
                if (self && self->m_controller.arenaBridge().isOpen()) {
                    const uint32_t status = (result.handled ? 1u : 0u) |
                                            (result.addressAck ? 2u : 0u);
                    self->m_controller.arenaBridge().completeI2cBurst(
                        backgroundI2c->sequence, status, result.firstNack,
                        std::span<const uint8_t>(rx.data(), std::min<uint32_t>(result.rxSize, 32)),
                        result.stretchNs);
                    auto& tr = lasecsimul::trace::Recorder::instance();
                    tr.setRuntimeIdentity(self->m_controller.runtimeIdentity());
                    tr.setCurrentI2cRequest(backgroundI2c->sequence);
                    tr.record(lasecsimul::trace::EventType::CoreI2cCompletionPublished,
                              backgroundI2c->sequence, backgroundI2c->sequence, self->m_scheduler.nowNs());
                    tr.setCurrentI2cRequest(0); tr.setRuntimeIdentity({});
                    const QueueSnap qs = snapshotQueue(self->m_controller.arenaBridge());
                    diag::trace(diag::ConsumerTraceEvent::D4_ProcessEnd,
                                self->m_controller.runtimeIdentity().sessionExecutionId,
                                qs.writeIndex, qs.readIndex, backgroundI2c->sequence);
                }
            }
            continue;
        }

        if (stop) {
            diag::trace(diag::ConsumerTraceEvent::D6_LoopExit, 0, 0, 0, /*reason=*/1 /* stop */);
            break;
        }
        if (step == PollStep::DeferredFuture) {
            /* ABI 5 acrescentou um pedido síncrono que pode ser publicado DEPOIS de termos
             * encontrado/agendado um evento normal futuro. Sem doorbell cross-process, encerrar
             * esta thread aqui deixa o mailbox sem consumidor enquanto o QEMU está bloqueado e
             * já não consegue publicar outro heartbeat que acorde o Core. Continue observando a
             * arena; o callback futuro já está deduplicado por schedulePollAt(). O lock é solto a
             * cada iteração, então o Scheduler pode executar o callback normalmente. */
            /* `yield()` sozinho causa starvation no Windows: esta thread readquire o mutex em um
             * laço quente antes de a worker conseguir executar o callback recém-agendado. A pausa
             * ocorre fora do mutex e limita a latência de descoberta do mailbox sem ocupar um
             * núcleo nem impedir o Scheduler. */
            diag::trace(diag::ConsumerTraceEvent::D6_LoopExit, 0, 0, 0, /*reason=*/2 /* deferred-future wait */);
            waitForPollWork(state);
            continue;
        }
        if (step == PollStep::DispatchedReady) continue; // agrupa ações do mesmo timestamp.
        diag::trace(diag::ConsumerTraceEvent::D6_LoopExit, 0, 0, 0, /*reason=*/3 /* no-event wait */);
        waitForPollWork(state);
    }
    diag::trace(diag::ConsumerTraceEvent::ThreadStop, 0, 0, 0);
    if (restartAfterExit) {
        /*
         * Stop -> Run pode começar enquanto esta thread destacada já decidiu sair, mas antes de
         * publicar pollThreadRunning=false. Nesse intervalo startPolling() vê a flag antiga em
         * true e não cria uma substituta; sem este handoff, a thread antiga sai logo depois e a
         * nova arena fica sem consumidor. Reavalie somente depois de baixar a flag. Se o novo Run
         * já estiver ativo, o CAS transfere a responsabilidade para uma única nova thread; se ele
         * começar depois desta checagem, verá a flag false e fará a mesma coisa.
         */
        std::lock_guard<std::recursive_mutex> lock(state->mutex);
        state->pollThreadRunning.store(false, std::memory_order_release);
        McuComponent* self = state->owner;
        if (self && self->m_polling.load(std::memory_order_acquire) &&
            self->m_scheduler.isRunning() &&
            self->m_controller.arenaBridge().isOpen()) {
            self->startBackgroundPollThreadIfNeeded();
        }
        // Nada depois deste bloco pode voltar a agir como worker ativo.
    } else {
        state->pollThreadRunning.store(false, std::memory_order_release);
    }
}

void McuComponent::scheduleModuleWakeup(size_t moduleIndex, uint64_t nowNs, bool schedulerLockHeld,
                                         std::vector<DeferredSchedulerCall>* deferred) {
    if (moduleIndex >= m_modules.size()) return;

    const uint64_t delayNs = m_modules[moduleIndex]->nextWakeupDelayNs(nowNs);
    if (delayNs == QemuModule::kNoWakeup) {
        if (m_moduleWakeupDueNs[moduleIndex] != QemuModule::kNoWakeup) ++m_moduleWakeupGeneration[moduleIndex];
        m_moduleWakeupDueNs[moduleIndex] = QemuModule::kNoWakeup;
        return;
    }

    const uint64_t dueNs = nowNs + delayNs;
    if (m_moduleWakeupDueNs[moduleIndex] != QemuModule::kNoWakeup && m_moduleWakeupDueNs[moduleIndex] <= dueNs) {
        return;
    }

    m_moduleWakeupDueNs[moduleIndex] = dueNs;
    const uint64_t generation = ++m_moduleWakeupGeneration[moduleIndex];
    const std::weak_ptr<CallbackState> weakState = m_callbackState;
    auto callback = [weakState, moduleIndex, generation] {
        const std::shared_ptr<CallbackState> state = weakState.lock();
        if (!state) return;
        std::vector<DeferredSchedulerCall> schedulerCalls;
        {
        std::lock_guard<std::recursive_mutex> lock(state->mutex);
        McuComponent* self = state->owner;
        if (!self || moduleIndex >= self->m_moduleWakeupGeneration.size()) return;
        if (self->m_moduleWakeupGeneration[moduleIndex] != generation) return;
        self->m_moduleWakeupDueNs[moduleIndex] = QemuModule::kNoWakeup;
        const uint64_t nowNs = self->m_scheduler.nowNs();
        const uint64_t before = self->electricalOutputFingerprint();
        self->m_modules[moduleIndex]->onWakeup(nowNs);
        if (self->m_controller.vnextBActive() && self->m_modules[moduleIndex]->kind() == ModuleKind::I2c) {
            auto& attachment = self->m_controller.vnextBAttachment();
            const uint64_t base = self->m_modules[moduleIndex]->memStart();
            attachment.publishRegisterResult(base + 0x08, self->m_modules[moduleIndex]->readRegister(base + 0x08));
            attachment.publishRegisterResult(base + 0x58, self->m_modules[moduleIndex]->readRegister(base + 0x58));
            // Pode iniciar a próxima transação da fila: conta na mudança elétrica abaixo.
            self->completeVnextBElectricalI2cIfDoneLocked();
        }
        const bool changed = before != self->electricalOutputFingerprint();
        // Este callback já roda com Scheduler::m_mutex liberado (ver
        // Scheduler::processNextEventUntilLocked: unlock -> callback() -> lock) e na própria
        // thread do Scheduler. Mesmo assim, chamadas que adquirem o lock do Scheduler
        // são deferred até liberar o lock de lifetime do callback (ordem de locks).
        self->scheduleModuleWakeup(moduleIndex, nowNs, false, &schedulerCalls);
        // Mudança de FIFO/RX ou bit TX repetido não altera o circuito elétrico.
        if (changed) self->m_scheduler.markDirty(self->m_componentIndex);
        }
        for (auto& call : schedulerCalls) call();
    };
    const bool soft = lockstepSoftModule(m_modules[moduleIndex]->kind());
    if (deferred) {
        // Ver doc-comment de DeferredSchedulerCall no .hpp -- evita inversão de ordem de lock com
        // stamp() quando quem chama é a thread de poll dedicada (segurando m_callbackState->mutex).
        deferred->push_back([&scheduler = m_scheduler, targetNs = nowNs + delayNs, callback = std::move(callback), soft]() mutable {
            scheduler.scheduleAt(targetNs, std::move(callback), soft);
        });
    } else if (schedulerLockHeld) {
        m_scheduler.scheduleEventUnlocked(delayNs, std::move(callback), soft);
    } else {
        m_scheduler.scheduleAt(m_scheduler.nowNs() + delayNs, std::move(callback), soft);
    }
}

void McuComponent::scheduleWakeupsForAllModules(uint64_t nowNs, bool schedulerLockHeld,
                                                 std::vector<DeferredSchedulerCall>* deferred) {
    for (size_t i = 0; i < m_modules.size(); ++i) scheduleModuleWakeup(i, nowNs, schedulerLockHeld, deferred);
}

QemuModule* McuComponent::findModule(uint64_t address) const {
    for (const std::unique_ptr<QemuModule>& module : m_modules) {
        if (module->owns(address)) return module.get();
    }
    return nullptr;
}

namespace {
constexpr int kUsartMonitorDrainGuard = 1 << 20; // ver doc-comment de drainUsartMonitorHex no .hpp
constexpr char kHexDigits[] = "0123456789abcdef";
} // namespace

std::string McuComponent::drainUsartMonitorHex(uint64_t regionStart, bool tx) const {
    QemuModule* module = findModule(regionStart);
    if (!module) return {};
    // Achado 2026-09-29 (LasecPlot divergiu do monitor com o mesmo numero de bytes): o wakeup da
    // USART empurra no buffer do monitor segurando so' m_callbackState->mutex (o Scheduler solta o
    // seu antes do callback), e esta leitura via IPC segurava so' Scheduler::m_mutex -- push_back e
    // pop_front concorrentes no mesmo std::deque. Mesma regra de tryDrainUartTxWireTap(): nunca
    // esperar por este mutex com o do Scheduler tomado; ocupado = nada drenado, o proximo poll pega.
    std::unique_lock<std::recursive_mutex> lock(m_callbackState->mutex, std::try_to_lock);
    if (!lock.owns_lock()) return {};
    std::string hex;
    uint8_t byte = 0;
    for (int guard = 0; guard < kUsartMonitorDrainGuard && module->drainMonitorByte(tx, byte); ++guard) {
        hex.push_back(kHexDigits[byte >> 4]);
        hex.push_back(kHexDigits[byte & 0x0Fu]);
    }
    return hex;
}

bool McuComponent::pinHasUartTxWireTap(size_t localPinIndex) const {
    const std::span<const PinMapping> mappings = m_adapter->pinMap();
    if (localPinIndex >= mappings.size() || localPinIndex >= m_moduleByPin.size()) return false;
    const PinMapping& mapping = mappings[localPinIndex];
    QemuModule* module = m_moduleByPin[localPinIndex];
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    return mapping.moduleKind == ModuleKind::Usart && module && module->hasWireTap() &&
           module->isOutputEnabled(mapping.bitOrLine);
}

void McuComponent::setPinTransitionsObserved(size_t localPinIndex, bool observed) {
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    if (localPinIndex < m_adapter->pinMap().size()) {
        m_adapter->setPinTransitionsObserved(static_cast<uint32_t>(localPinIndex), observed);
    }
}

std::optional<std::string>
McuComponent::tryDrainUartTxWireTap(size_t localPinIndex, bool& busy) const {
    busy = false;
    const std::span<const PinMapping> mappings = m_adapter->pinMap();
    if (localPinIndex >= mappings.size() || localPinIndex >= m_moduleByPin.size()) return std::nullopt;
    const PinMapping& mapping = mappings[localPinIndex];
    if (mapping.moduleKind != ModuleKind::Usart) return std::nullopt;

    // tryDrainUartRx() chama isto com Scheduler::m_mutex tomado. NUNCA espere aqui pelo mutex do
    // callback: um wakeup UART pode estar segurando-o e prestes a marcar o Scheduler dirty, ordem
    // inversa que deadlockaria os dois. Se a UART estiver atualizando neste exato instante,
    // identifique o pino como fonte (string vazia) e deixe o poll do instrumento tentar de novo;
    // principalmente, nao caia no decoder eletrico e nao consuma seu buffer nessa tentativa.
    std::unique_lock<std::recursive_mutex> lock(m_callbackState->mutex, std::try_to_lock);
    if (!lock.owns_lock()) {
        busy = true;
        return std::nullopt;
    }

    QemuModule* module = m_moduleByPin[localPinIndex];
    if (!module || !module->isOutputEnabled(mapping.bitOrLine)) {
        return std::nullopt;
    }

    std::string hex;
    uint8_t byte = 0;
    for (int guard = 0; guard < kUsartMonitorDrainGuard && module->drainWireTapByte(byte); ++guard) {
        hex.push_back(kHexDigits[byte >> 4]);
        hex.push_back(kHexDigits[byte & 0x0Fu]);
    }
    return hex;
}

namespace {
int hexNibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
} // namespace

void McuComponent::injectUsartRxHex(uint64_t regionStart, const std::string& hex) const {
    QemuModule* module = findModule(regionStart);
    if (!module) return;
    std::vector<uint8_t> bytes;
    bytes.reserve(hex.size() / 2);
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        const int hi = hexNibble(hex[i]);
        const int lo = hexNibble(hex[i + 1]);
        if (hi < 0 || lo < 0) break;
        bytes.push_back(static_cast<uint8_t>((hi << 4) | lo));
    }
    if (!bytes.empty()) module->injectRxBytes(bytes.data(), bytes.size());
}

std::vector<PropertyDescriptor> McuComponent::propertyDescriptors() {
    std::vector<PropertyDescriptor> descriptors;
    for (const MemoryRegion& region : m_adapter->memoryRegions()) {
        if (region.moduleKind != ModuleKind::Usart) continue;
        const uint64_t regionStart = region.start;
        for (const bool tx : {true, false}) {
            PropertyDescriptor descriptor;
            descriptor.name = "uart" + std::to_string(region.moduleIndex) + (tx ? "_tx_monitor_hex" : "_rx_monitor_hex");
            descriptor.get = [this, regionStart, tx]() -> PropertyValue { return drainUsartMonitorHex(regionStart, tx); };
            descriptor.set = [](const PropertyValue&) {}; // somente leitura -- `set` nunca chamado pelo caminho previsto
            descriptor.schema.id = descriptor.name;
            descriptor.schema.valueKind = PropertyValueKind::String;
            descriptor.schema.flags = PropertySchemaHidden | PropertySchemaReadOnly;
            descriptors.push_back(std::move(descriptor));
        }
        // Lado ESCRITA do monitor (mcu_abi.h minor 7) -- caixa de envio do "Abrir monitor serial"
        // injeta hex aqui, que vira bytes reais no RX desta USART via injectUsartRxHex/
        // QemuModule::injectRxBytes. `get` nunca é lido pelo caminho previsto (write-only de
        // verdade, ao contrário dos dois acima que são somente-leitura).
        {
            PropertyDescriptor descriptor;
            descriptor.name = "uart" + std::to_string(region.moduleIndex) + "_rx_inject_hex";
            descriptor.get = []() -> PropertyValue { return std::string{}; };
            descriptor.set = [this, regionStart](const PropertyValue& value) {
                if (const auto* hex = std::get_if<std::string>(&value)) injectUsartRxHex(regionStart, *hex);
            };
            descriptor.schema.id = descriptor.name;
            descriptor.schema.valueKind = PropertyValueKind::String;
            descriptor.schema.flags = PropertySchemaHidden;
            descriptors.push_back(std::move(descriptor));
        }
    }
    return descriptors;
}

uint64_t McuComponent::electricalOutputFingerprint() const {
    // FNV-1a do que stamp() aplica a cada pino, sem alocação, uma leitura em lote por módulo. Inclui
    // a posição implicitamente pela ordem fixa dos lotes. O pull de um pino não dirigido entra:
    // pinMode(INPUT_PULLUP) num pino solto muda o nível do pad como no chip, sem esperar outro
    // pino mudar para o MCU ser estampado de novo.
    uint64_t fingerprint = 1469598103934665603ull;
    for (const PinBatch& batch : m_pinBatches) {
        visitPinStates(*batch.module, batch.bitsOrLines, [&](size_t, uint8_t state) {
            fingerprint ^= state;
            fingerprint *= 1099511628211ull;
        });
    }
    return fingerprint;
}

void McuComponent::publishVnextBGpioInputsLocked() {
    if (!m_controller.vnextBActive()) return;
    std::array<uint64_t, 2> words{};
    for (size_t i = 0; i < kVnextBGpioInAddresses.size(); ++i) {
        if (QemuModule* module = findModule(kVnextBGpioInAddresses[i])) words[i] = module->readRegister(kVnextBGpioInAddresses[i]);
    }
    qemu::VnextBAttachment& attachment = m_controller.vnextBAttachment();
    if (!m_vnextBGpioInPublished || words != m_vnextBPublishedGpioIn) {
        if (attachment.publishSnapshot(reinterpret_cast<const uint8_t*>(words.data()), sizeof(words))) {
            m_vnextBPublishedGpioIn = words;
            m_vnextBGpioInPublished = true;
        }
    }
    // The snapshot only serves the guest's own GPIO_IN reads. The real chip also latches an edge
    // interrupt the moment the pad changes, so each changed word is pushed to QEMU's GPIO model
    // as well (esp32_gpio_vnext_input). A full C2A ring is retried on the next call.
    for (size_t i = 0; i < words.size(); ++i) {
        if (m_vnextBNotifiedGpioInValid[i] && m_vnextBNotifiedGpioIn[i] == words[i]) continue;
        if (!attachment.publishRegisterResult(kVnextBGpioInAddresses[i], words[i])) continue;
        m_vnextBNotifiedGpioIn[i] = words[i];
        m_vnextBNotifiedGpioInValid[i] = true;
    }
}

void McuComponent::startOrQueueVnextBElectricalI2cLocked(uint32_t lane, uint64_t requestSeq,
                                                         std::vector<uint8_t> op, uint64_t nowNs) {
    m_vnextBQueuedI2c.push_back(VnextBElectricalI2c{lane, requestSeq, std::move(op)});
    if (m_vnextBElectricalI2c) return;
    startVnextBElectricalI2cLocked(nowNs);
    // Transação sem nada para pôr no fio (continuação só com o endereço de roteamento) não gera
    // wakeup do motor: conclui já.
    completeVnextBElectricalI2cIfDoneLocked();
}

void McuComponent::startVnextBElectricalI2cLocked(uint64_t nowNs) {
    while (!m_vnextBElectricalI2c && !m_vnextBQueuedI2c.empty()) {
        VnextBElectricalI2c transaction = std::move(m_vnextBQueuedI2c.front());
        m_vnextBQueuedI2c.pop_front();
        // Envelope BATCH (ver o despacho em pollAndDispatchPendingEvents): [0] barramento,
        // [1] flags (START 1, STOP 2, READ 4), [2..3] bytes tx, [4..5] bytes rx, [6..13] período de
        // bit em ns, [14..] tx -- tx[0] é sempre o byte de endereço, mas numa continuação sem START
        // ele só identifica o alvo e não vai para o fio.
        const std::vector<uint8_t>& op = transaction.op;
        uint16_t txBytes = 0, rxBytes = 0;
        uint64_t periodNs = 0;
        std::memcpy(&txBytes, op.data() + 2, sizeof(txBytes));
        std::memcpy(&rxBytes, op.data() + 4, sizeof(rxBytes));
        std::memcpy(&periodNs, op.data() + 6, sizeof(periodNs));
        transaction.start = (op[1] & kVnextBI2cStart) != 0;
        const bool stop = (op[1] & kVnextBI2cWireStop) != 0;
        const bool lastReadNack = (op[1] & kVnextBI2cLastReadNack) != 0;
        transaction.moduleBase = op[0] == 0 ? kVnextBI2c0Base : kVnextBI2c1Base;
        QemuModule* module = findModule(transaction.moduleBase);
        if (!module) {
            I2cTransferResult nack{};
            nack.handled = true;
            nack.firstNack = 0;
            m_controller.vnextBAttachment().respondToI2c(transaction.lane, transaction.requestSeq, nack, {});
            continue;
        }
        const auto queue = [&](uint32_t kind, uint8_t byte, bool nack, bool abortOnNack) {
            module->writeRegisterAt(transaction.moduleBase + kAdapterI2cCoreOpOffset,
                                    byte | (kind << 8) | (nack ? 1u << 10 : 0u) | (abortOnNack ? 1u << 11 : 0u), nowNs);
        };
        if (periodNs > 0) module->writeRegisterAt(transaction.moduleBase + kAdapterI2cLowPeriodOffset, periodNs, nowNs);
        const uint8_t* tx = op.data() + 14;
        if (transaction.start) {
            queue(kAdapterI2cOpRestart, 0, false, false);
            queue(kAdapterI2cOpWrite, tx[0], false, true);
        }
        for (uint16_t i = 1; i < txBytes; ++i) queue(kAdapterI2cOpWrite, tx[i], false, true);
        // O mestre confirma cada byte lido; o último leva o ACK_VAL do último READ da lista (ESP-IDF:
        // READ n-1 com ACK + READ 1 com NACK antes do STOP).
        for (uint16_t i = 0; i < rxBytes; ++i) queue(kAdapterI2cOpRead, 0, lastReadNack && i + 1 == rxBytes, false);
        if (stop) queue(kAdapterI2cOpStop, 0, false, false);
        m_vnextBElectricalI2c = std::move(transaction);
    }
}

void McuComponent::completeVnextBElectricalI2cIfDoneLocked() {
    if (!m_vnextBElectricalI2c) return;
    const VnextBElectricalI2c& transaction = *m_vnextBElectricalI2c;
    QemuModule* module = findModule(transaction.moduleBase);
    if (!module) return;
    if ((module->readRegister(transaction.moduleBase + kAdapterI2cStatusOffset) & kAdapterI2cStatusBusBusy) != 0) return;

    I2cTransferResult result{};
    result.handled = true;
    result.firstNack = UINT32_MAX;
    result.addressAck = !transaction.start; // continuação: o alvo já foi selecionado antes
    std::array<uint8_t, 32> rx{};
    uint32_t rxCount = 0;
    uint32_t writes = 0;
    const uint64_t results = module->readRegister(transaction.moduleBase + kAdapterI2cCoreResultCountOffset);
    for (uint64_t i = 0; i < results; ++i) {
        const uint64_t word = module->readRegister(transaction.moduleBase + kAdapterI2cCoreResultOffset);
        const bool ack = (word & (1u << 8)) != 0;
        if (((word >> 9) & 0x3u) == kAdapterI2cOpWrite) {
            if (transaction.start && writes == 0) {
                result.addressAck = ack;
            } else if (!ack && result.firstNack == UINT32_MAX) {
                result.firstNack = writes - (transaction.start ? 1u : 0u);
            }
            ++writes;
        } else if (rxCount < rx.size()) {
            rx[rxCount++] = static_cast<uint8_t>(word & 0xFFu);
        }
    }
    result.rxSize = rxCount;
    const bool published = m_controller.vnextBAttachment().respondToI2c(
        transaction.lane, transaction.requestSeq, result, std::span<const uint8_t>(rx.data(), rxCount));
    if (vnextTraceEnabled()) std::fprintf(stderr, "[VNEXT_CORE_I2C] electrical done ack=%d nack=%u rx=%u published=%d\n",
                                          result.addressAck ? 1 : 0, result.firstNack, rxCount, published ? 1 : 0);
    if (published) m_vnextI2cCompletionCount.fetch_add(1, std::memory_order_relaxed);
    m_vnextBElectricalI2c.reset();
    startVnextBElectricalI2cLocked(m_scheduler.nowNsUnlocked());
    completeVnextBElectricalI2cIfDoneLocked(); // próxima da fila também pode não ter nada no fio
}

McuComponent::PollStep McuComponent::pollAndDispatchPendingEvents(
    uint64_t nowNs, std::vector<DeferredSchedulerCall>* deferred, bool schedulerLockHeld) {
    if (m_controller.vnextBActive()) {
        // Entradas que mudaram por outro caminho (ex.: GPIO matrix reroteada) também precisam
        // chegar ao snapshot antes de o firmware ler GPIO_IN de novo.
        publishVnextBGpioInputsLocked();
        // PLAN_MTTCG_VNEXT_B_CAUSALITY.md sections 9/10: temporal-merge arbiter across lanes,
        // future-event deferral via the same schedulePollAt() mechanism the legacy transport
        // already uses (weak-lifetime + generation-deduplicated, see schedulePollAt() above --
        // reused as-is, not reimplemented), and a bounded per-turn drain budget so one wake can
        // never abandon backlog nor monopolize the Scheduler.
        auto& attachment = m_controller.vnextBAttachment();
        const uint32_t laneCount = attachment.view().control->lane_count;
        const uint64_t originNs = m_qemuTimeOriginNs.load(std::memory_order_relaxed);
        // Lockstep: a sequência é lida ANTES do instante e das filas -- tudo que o QEMU publicou
        // antes dela é visto (e despachado ou agendado) nesta chamada; só então ela é ecoada.
        const bool lockstep = m_controller.lockstep();
        const uint64_t observedSyncSeq = lockstep ? attachment.artifactSyncSeq() : 0;

        // R3c heartbeat: read on every call (independent of whether any lane has anything to
        // arbitrate), forward-only via qemu::advanceMonotonicNs() (see its doc-comment: this is
        // exactly what makes repeated/coalesced doorbell-driven reads of the same or an older
        // watermark safe to call unconditionally). load-acquire pairs with QEMU's store-release
        // in vnext_heartbeat_cb().
        {
            const uint64_t heartbeatNow =
                std::atomic_ref<const uint64_t>(attachment.view().control->artifact_virtual_time_ns)
                    .load(std::memory_order_acquire);
            const bool heartbeatAdvanced = qemu::advanceMonotonicNs(m_vnextBHeartbeatWatermarkNs, heartbeatNow);
            lasecsimul::simulation::diag::ProvenanceTracker::instance().recordHeartbeatSample(
                heartbeatAdvanced, heartbeatNow);
            if (heartbeatAdvanced) {
                m_scheduler.notifyAdvanceLimitChanged();
            }
        }

        // Single per-lane, per-kind dispatch: unchanged from the prior implementation except
        // that it now operates on one already-selected (lane, event) pair instead of iterating
        // lanes itself. Returns true if the electrical output fingerprint changed.
        auto dispatchOneEvent = [&](uint32_t lane, const lasec_at_event& event) -> bool {
            lasecsimul::simulation::diag::ProvenanceTracker::instance().recordDispatchedEventKind(event.kind);
            if (event.kind == 3 && event.payload_bytes == sizeof(uint64_t) * 2) {
                uint64_t requestSeq = 0, address = 0;
                std::memcpy(&requestSeq, event.payload, sizeof(requestSeq));
                std::memcpy(&address, event.payload + sizeof(requestSeq), sizeof(address));
                uint64_t value = 0;
                if (address != 0) {
                    lasecsimul::simulation::diag::ProvenanceTracker::instance().recordMmioRead(address);
                    if (QemuModule* module = findModule(address)) value = module->readRegister(address);
                }
                attachment.respondToRequest(lane, requestSeq, value);
                return false;
            }
            if (event.kind == LASEC_AT_KIND_BATCH) {
                if (vnextTraceEnabled()) std::fprintf(stderr, "[VNEXT_CORE_I2C] batch lane=%u bytes=%u\\n", lane, event.payload_bytes);
                /* Generic BATCH envelope used by the ESP32 endpoint adapter. The
                 * transport validates only bounded envelope structure; the adapter
                 * interprets the opaque operation bytes. */
                if (event.payload_bytes < 12 || event.payload[0] != 1) { std::fprintf(stderr, "[VNEXT_CORE_I2C] reject envelope\\n"); return false; }
                uint16_t opBytes = 0, txBytes = 0, rxBytes = 0;
                std::memcpy(&opBytes, event.payload + 8, sizeof(opBytes));
                if (opBytes < 14 || event.payload_bytes != 12u + opBytes ||
                    opBytes > LASEC_AT_EVENT_PAYLOAD - 12u) return false;
                const uint8_t* op = event.payload + 12;
                std::memcpy(&txBytes, op + 2, sizeof(txBytes));
                std::memcpy(&rxBytes, op + 4, sizeof(rxBytes));
                if (op[0] > 1 || txBytes == 0 || txBytes > 32 || rxBytes > 32 ||
                    opBytes != 14u + txBytes) return false;
                const uint64_t requestSeq = std::atomic_ref<const uint64_t>(
                    attachment.view().responses[lane].request_seq).load(std::memory_order_acquire);
                if (vnextTraceEnabled()) std::fprintf(stderr, "[VNEXT_CORE_I2C] req=%llu handler=%d op=%u tx=%u rx=%u\\n",
                             static_cast<unsigned long long>(requestSeq), m_i2cTransferHandler ? 1 : 0,
                             op[0], txBytes, rxBytes);
                if (!requestSeq) return false;
                m_vnextI2cSubmissionCount.fetch_add(1, std::memory_order_relaxed);
                if (!m_i2cTransferHandler) {
                    // Sem resolvedor de topologia: executa no barramento real em vez de deixar o
                    // QEMU (que pausou a vCPU esperando esta resposta) sem resposta para sempre.
                    const uint64_t before = electricalOutputFingerprint();
                    startOrQueueVnextBElectricalI2cLocked(lane, requestSeq, std::vector<uint8_t>(op, op + opBytes), nowNs);
                    return before != electricalOutputFingerprint();
                }
                uint64_t periodNs = 0;
                std::memcpy(&periodNs, op + 6, sizeof(periodNs));
                std::array<uint8_t, 32> rx{};
                I2cTransfer transfer{};
                transfer.address = static_cast<uint8_t>(op[14] >> 1);
                transfer.read = (op[1] & 4u) != 0;
                transfer.start = (op[1] & 1u) != 0;
                transfer.stop = (op[1] & 2u) != 0;
                transfer.txData = op + 15;
                transfer.txSize = txBytes - 1;
                transfer.rxData = rx.data();
                transfer.rxSize = rxBytes;
                transfer.periodNs = periodNs;
                auto& traceRecorder = lasecsimul::trace::Recorder::instance();
                traceRecorder.setCurrentI2cRequest(requestSeq);
                traceRecorder.setRuntimeIdentity(m_controller.runtimeIdentity());
                const I2cTransferResult result = m_i2cTransferHandler(m_componentIndex, op[0], transfer);
                if (vnextTraceEnabled()) std::fprintf(stderr, "[VNEXT_CORE_I2C] result handled=%d ack=%d rx=%u nack=%u\\n",
                             result.handled ? 1 : 0, result.addressAck ? 1 : 0, result.rxSize, result.firstNack);
                traceRecorder.setCurrentI2cRequest(0);
                traceRecorder.setRuntimeIdentity({});
                if (!result.handled) {
                    // O fast path só vale quando o barramento é indistinguível de uma transferência
                    // direta (só dispositivos I2C, túneis e resistores). Com instrumento, pull-up ou
                    // dispositivo sem i2c_transfer, a transação roda eletricamente, como no chip.
                    const uint64_t before = electricalOutputFingerprint();
                    startOrQueueVnextBElectricalI2cLocked(lane, requestSeq, std::vector<uint8_t>(op, op + opBytes), nowNs);
                    return before != electricalOutputFingerprint();
                }
                const bool published = attachment.respondToI2c(lane, requestSeq, result,
                    std::span<const uint8_t>(rx.data(), std::min<uint32_t>(result.rxSize, 32u)));
                if (vnextTraceEnabled()) std::fprintf(stderr, "[VNEXT_CORE_I2C] response published=%d\\n", published ? 1 : 0);
                if (published) m_vnextI2cCompletionCount.fetch_add(1, std::memory_order_relaxed);
                return false;
            }
            if (event.kind != 10 || event.payload_bytes != sizeof(uint64_t) * 2) return false;
            uint64_t address = 0, value = 0;
            std::memcpy(&address, event.payload, sizeof(address));
            std::memcpy(&value, event.payload + sizeof(address), sizeof(value));
            lasecsimul::simulation::diag::ProvenanceTracker::instance().recordGpioWrite(address);
            if (address >= 0x3ff44000ull && address < 0x3ff45000ull)
                if (vnextTraceEnabled()) std::fprintf(stderr, "[VNEXT_CORE_GPIO] addr=%llx value=%llx event_ns=%llu now_ns=%llu wall_ns=%llu\n",
                             static_cast<unsigned long long>(address), static_cast<unsigned long long>(value),
                             static_cast<unsigned long long>(vnextEventTimeNs(originNs, event.timestamp_ns)),
                             static_cast<unsigned long long>(nowNs),
                             static_cast<unsigned long long>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                 std::chrono::steady_clock::now().time_since_epoch()).count()));
            const uint64_t before = electricalOutputFingerprint();
            if (QemuModule* module = findModule(address)) {
                module->writeRegisterAt(address, value, vnextEventTimeNs(originNs, event.timestamp_ns));
            }
            return before != electricalOutputFingerprint();
        };

        // Bounded per turn: must not monopolize the Scheduler (section 9.4), but on exhaustion
        // must request an immediate continuation rather than silently deferring to the next
        // doorbell, which may not come if the guest is waiting on THIS turn's responses.
        constexpr uint32_t kMaxEventsPerTurn = 256;
        bool changed = false;
        uint32_t dispatchedCount = 0;
        bool budgetExhausted = false;
        // Uma mudança elétrica por settle: escritas de GPIO são aplicadas na hora no módulo, então
        // despachar CLK=1 e CLK=0 na mesma rodada apagava o pulso antes de o solver vê-lo (SPI por
        // bit-bang chegava sem bordas ao display). Mesmo princípio do caminho legado ("dirty
        // primeiro", ver pollStepLocked()): depois de uma mudança, devolve o controle para o
        // chamador marcar dirty/assentar e continua na próxima rodada (now+1 ns).
        bool yieldForSettle = false;
        for (;;) {
            std::array<qemu::VnextBLanePeek, LASEC_AT_MAX_LANES> peeks{};
            for (uint32_t lane = 0; lane < laneCount; ++lane) {
                if (const auto peeked = attachment.peekLane(lane)) {
                    peeks[lane] = {true, vnextEventTimeNs(originNs, peeked->timestamp_ns)};
                }
            }
            const qemu::VnextBArbiterDecision decision =
                qemu::selectNextLaneEvent(std::span<const qemu::VnextBLanePeek>(peeks.data(), laneCount), nowNs);
            if (!decision.hasCandidate) break;
            if (!decision.ready) {
                // Future head: publish the boundary for pacing (never advance
                // m_latestVnextBVirtualTimeNs here -- only a dispatched event may do that, same
                // invariant the legacy transport already enforces) and schedule a callback for
                // exactly that instant. Do not consume anything, do not loop further this turn.
                const uint64_t previous =
                    m_nextPendingEventNs.exchange(decision.timestampNs, std::memory_order_relaxed);
                if (previous != decision.timestampNs) m_scheduler.notifyAdvanceLimitChanged();
                schedulePollAt(decision.timestampNs, deferred, schedulerLockHeld);
                break;
            }
            if (dispatchedCount >= kMaxEventsPerTurn) {
                budgetExhausted = true;
                break;
            }
            const auto consumed = attachment.consumeLane(decision.lane);
            if (!consumed || vnextEventTimeNs(originNs, consumed->timestamp_ns) != decision.timestampNs) {
                // Protocol error (section 10.1 point 6): the consumed head no longer matches
                // what was just peeked and selected. Single-consumer operation under
                // m_callbackState->mutex makes this unreachable in practice; surface it instead
                // of silently proceeding with a different, unselected entry.
                std::fprintf(stderr, "[VNEXT_CORE] protocol error: consumed head diverged from "
                                      "selected peek on lane=%u\\n", decision.lane);
                break;
            }
            m_nextPendingEventNs.store(0, std::memory_order_relaxed);
            {
                // Stores the RAW (session-relative) timestamp_ns, matching m_latestVirtualTimePs's
                // own convention exactly (that field holds raw simuTimePs, not origin-adjusted --
                // see qemuEventTimeNs() being applied at *read* time in pacingPositionNs() and
                // latestVirtualTimeNs() below, never at write time). Storing the origin-adjusted
                // absolute value here instead would silently break latestVirtualTimeNs(), which
                // every session-progress caller (including the pacing-sync test) reads directly.
                if (qemu::advanceMonotonicNs(m_latestVnextBVirtualTimeNs, consumed->timestamp_ns)) {
                    m_scheduler.notifyAdvanceLimitChanged();
                }
            }
            const bool electricalChange = dispatchOneEvent(decision.lane, *consumed);
            changed = electricalChange || changed;
            ++dispatchedCount;
            if (electricalChange) {
                yieldForSettle = true;
                m_vnextBChangeAwaitingStamp = true;
                break;
            }
        }
        // scheduleNextPoll() (nowNs()+1, not schedulePollAt(nowNs, ...)): scheduling exactly at
        // the current instant risks the Scheduler treating it as already-due and invoking the
        // callback synchronously/immediately within this same call stack -- observed live as a
        // std::recursive_mutex "resource deadlock would occur" once the recursion depth exceeded
        // its limit. This is the same livelock this codebase already solved once, see
        // scheduleNextPoll()'s own +1ns comment above.
        if (budgetExhausted) scheduleNextPoll(deferred, schedulerLockHeld);

        // Safe acknowledge (PLAN_MTTCG_VNEXT_B_CAUSALITY.md section 10.4, steps 1-5, EVIDENCE.md
        // H143/E144): drain first (above), THEN clear the notification flag, THEN re-arbitrate
        // with acquire semantics so a publish racing the ack is still caught -- never rely on a
        // second doorbell transition for backlog that was already in the ring, and never busy-
        // loop when only a future head remains (10.4 step 5: "se houver somente evento futuro,
        // manter o callback temporal; não criar busy loop").
        //
        // E143/E144 (EVIDENCE.md, 2026-09-08; H143): the previous form of this block used
        // hasPendingLaneEvents() (write_seq != read_seq on any lane) to decide whether to
        // request an immediate repoll -- true whether the remaining head is ready now OR still
        // the same future head the main loop above just deferred, since it cannot tell the two
        // apart. Treating both the same way (an unconditional scheduleNextPoll(), i.e. now+1ns)
        // directly violates plan section 10.4 step 5 above: now+1ns is always earlier than any
        // real future deadline, so it always wins schedulePollAt()'s own "only preempt if
        // strictly earlier" generation-bump check, permanently invalidating the correct callback
        // just installed and replacing it with an immediate one that finds the exact same future
        // head and repeats -- a busy loop (proven: E143's isolated RED, and m_pollGeneration
        // measured ~1000-1200 per real 5s window against the E141 candidate). E144 corrected the
        // earlier classification: E132-E's historical "session_restart_stress_test 15/15" ran a
        // Release build; E142/E143 had been rebuilding and running Debug, which is slow enough
        // per storm iteration that it cannot grind past the busy loop within a 5s window, while
        // Release is fast enough to (verified: Release passes 3/3 with this exact bug still
        // present, submissions~750 each run) -- a real, plan-violating, wasteful busy loop that
        // Release happens not to be blocked by today, not a phantom. Fixed by re-arbitrating for
        // real instead of guessing from hasPendingLaneEvents() alone: re-peek every lane
        // (acquire, same as the main loop) and run the same pure policy function the main loop's
        // "future head" branch already conceptually implements, so the decision distinguishes
        // no-candidate / ready-now / still-future exactly like the main loop does. See
        // VnextBArbiter.hpp's decidePostAckRearm() (the pure policy, unit-tested in
        // VnextBArbiterTest.cpp's H143 RED/GREEN cases) for the policy this mirrors.
        const bool notified = attachment.notificationPending();
        if (notified) attachment.acknowledgeNotification();
        // Depois de ceder para o settle, só há o que continuar se ainda houver evento nas filas
        // (relido depois do ack, como o rearm abaixo). Um poll vazio em now+1 virava, no lockstep,
        // um horizonte 1 ns à frente e uma sincronização a mais por escrita.
        if (yieldForSettle && !budgetExhausted && attachment.hasPendingLaneEvents())
            scheduleNextPoll(deferred, schedulerLockHeld);
        if (!budgetExhausted && !yieldForSettle) {
            std::array<qemu::VnextBLanePeek, LASEC_AT_MAX_LANES> postAckPeeks{};
            for (uint32_t lane = 0; lane < laneCount; ++lane) {
                if (const auto peeked = attachment.peekLane(lane)) {
                    postAckPeeks[lane] = {true, vnextEventTimeNs(originNs, peeked->timestamp_ns)};
                }
            }
            const qemu::VnextBRearmDecision rearm = qemu::decidePostAckRearm(
                std::span<const qemu::VnextBLanePeek>(postAckPeeks.data(), laneCount), nowNs, budgetExhausted);
            switch (rearm.action) {
            case qemu::VnextBRearmAction::None:
                // No candidate at all (the drain loop above already consumed everything ready
                // and nothing remains, future or otherwise): nothing to reschedule.
                break;
            case qemu::VnextBRearmAction::Immediate:
                // A concurrent publish landed a ready event (possibly on a different lane)
                // between the drain loop's last empty check and the ack above; request an
                // immediate repoll rather than trusting a doorbell that may already have been
                // coalesced away by acknowledgeNotification() just now.
                scheduleNextPoll(deferred, schedulerLockHeld);
                break;
            case qemu::VnextBRearmAction::At:
                // Still (or again) future-only. schedulePollAt() itself is the only thing
                // allowed to decide whether this preempts the callback already installed above:
                // a no-op if this timestamp is the same or later (the common case -- it is
                // literally the same undrained head), a legitimate earlier-deadline preemption
                // if a concurrently-published event elsewhere is genuinely sooner. Never now+1ns.
                {
                    const uint64_t previous =
                        m_nextPendingEventNs.exchange(rearm.atTimestampNs, std::memory_order_relaxed);
                    if (previous != rearm.atTimestampNs) m_scheduler.notifyAdvanceLimitChanged();
                    schedulePollAt(rearm.atTimestampNs, deferred, schedulerLockHeld);
                }
                break;
            }
        }

        if (lockstep && lockstepTraceEnabled() &&
            observedSyncSeq != m_lockstepObservedSyncSeq.load(std::memory_order_relaxed)) {
            g_lockstepTrace.observedNs = steadyNowNs();
            const uint64_t wake = g_lockstepTrace.wakeNs.exchange(0);
            if (wake) g_lockstepTrace.wakeToObserveNs += g_lockstepTrace.observedNs - wake;
        }
        if (lockstep) m_lockstepObservedSyncSeq.store(observedSyncSeq, std::memory_order_release);
        if (dispatchedCount > 0 || budgetExhausted || yieldForSettle) return PollStep::DispatchedReady;
        if (m_nextPendingEventNs.load(std::memory_order_relaxed) != 0) return PollStep::DeferredFuture;
        (void)changed; // electrical-change tracking retained for parity/diagnostics; the return
                        // value no longer depends on it -- dispatchedCount already reflects every
                        // consumed event, including ones that don't move the electrical output.
        return PollStep::NoEvent;
    }
    qemu::QemuArenaBridge& arenaBridge = m_controller.arenaBridge();
    if (!arenaBridge.isOpen()) return PollStep::NoEvent;
    // PERF-13 (protocolo v3, ver qemu_arena_abi.h): a arena agora tem uma fila de escritas/
    // heartbeat, não mais um slot único -- mas este caminho (chamado de dentro de stamp(), uma
    // vez por iteração de Newton) continua processando no máximo um evento por chamada de
    // propósito: mantém cada stamp() rápido e deixa o esvaziamento de rajadas maiores pra
    // onPollEvent()/runBackgroundPollLoop() (que já drenam a fila inteira em loop quando o
    // Scheduler está rodando em background, ver PERF-12) -- um laço aqui dentro só duplicaria
    // esse trabalho e prenderia stamp() por mais tempo sem necessidade.
    const qemu::QemuPollResult result = arenaBridge.poll();
    if (!result.hasEvent || !result.event) return PollStep::NoEvent;
    const uint64_t eventNs = qemuEventTimeNs(m_qemuTimeOriginNs.load(std::memory_order_relaxed), result.event->simuTimePs);
    // Uma stamp causada por outra parte do circuito não pode antecipar o relógio virtual do QEMU.
    // A entrada permanece na fila; onPollEvent() já está agendado para consumi-la no instante certo.
    if (eventNs > nowNs && !m_syntheticArenaForTesting) return PollStep::DeferredFuture;
    dispatchArenaEvent(*result.event, m_syntheticArenaForTesting ? nowNs : eventNs);
    return PollStep::DispatchedReady;
}

bool McuComponent::dispatchArenaEvent(const qemu::QemuArenaEvent& event, uint64_t eventTimeNs) {
    qemu::QemuArenaBridge& arenaBridge = m_controller.arenaBridge();
    if (!arenaBridge.isOpen()) return false;
    const uint64_t before = electricalOutputFingerprint();
    uint64_t readValue = 0;
    if (event.simuAction == LSDN_SIM_WRITE) {
        if (QemuModule* module = findModule(event.regAddr)) {
            module->writeRegisterAt(event.regAddr, event.regData, eventTimeNs);
        }
    } else if (event.simuAction == LSDN_SIM_READ) {
        if (QemuModule* module = findModule(event.regAddr)) readValue = module->readRegister(event.regAddr);
    }

    // O ACK é determinado pela ORIGEM. QEMUs anteriores ao ajuste de protocolo ainda publicam
    // SIM_FREQ no slot único; usar acknowledgeWrite() nesse caso pode avançar uma entrada da fila
    // que chegou entre poll() e este ponto, descartando-a sem dispatch.
    if (event.fromQueue) {
        arenaBridge.acknowledgeWrite();
    } else if (event.simuAction == LSDN_SIM_READ) {
        arenaBridge.acknowledgeRead(readValue);
    } else {
        arenaBridge.acknowledgeEventSlot();
    }
    return before != electricalOutputFingerprint();
}

void McuComponent::stamp(MnaMatrixView& matrix) {
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    ++m_stampCount;
    lasecsimul::simulation::diag::ProvenanceTracker::instance().recordStampEntry(m_componentIndex);
    // Mantém o contrato de chamadas que marcam o MCU dirty explicitamente (testes sintéticos,
    // hosts ABI e futuras fontes de interrupção). O poll periódico continua desacoplado do MNA:
    // ele só marca dirty quando a saída elétrica muda.
    // schedulerLockHeld=true: stamp() runs inside Scheduler::runUntil()'s settle loop, which
    // holds Scheduler::m_mutex throughout (same reasoning as this function's own
    // scheduleWakeupsForAllModules(..., true) call below -- see schedulePollAt()'s doc-comment).
    // VNEXT_B: se uma mudança elétrica já despachada ainda não foi estampada, estampa-a primeiro
    // (o laço de pinos abaixo); a próxima sai no poll de continuação, depois deste solve.
    const PollStep pollStepResult = m_vnextBChangeAwaitingStamp
        ? PollStep::DispatchedReady
        : pollAndDispatchPendingEvents(m_scheduler.nowNsUnlocked(), nullptr, true);
    lasecsimul::simulation::diag::ProvenanceTracker::instance().recordPollOutcome(
        pollStepResult == PollStep::DispatchedReady, pollStepResult == PollStep::DeferredFuture,
        pollStepResult == PollStep::NoEvent);

    // Ponte pino<->matriz, genérica (ver doc da classe): pra cada PinMapping, pergunta ao módulo
    // responsável (nunca sabe qual chip é) se aquele bit está em modo saída -- se sim, dirige o
    // pino real; se não, lê a tensão atual do pino e alimenta de volta no módulo (pra uma leitura
    // de registrador futura, ex: GPIO_IN_REG, devolver o valor certo). Estado e entradas vão em
    // lote, uma chamada de cada por módulo: todo estado é lido antes das entradas desta rodada
    // (uma entrada só muda uma saída por wakeup do periférico, ver get_pin_states em mcu_abi.h).
    for (const PinBatch& batch : m_pinBatches) {
        visitPinStates(*batch.module, batch.bitsOrLines,
                       [&](size_t position, uint8_t state) { m_pinStates[batch.pinIndices[position]] = state; });
    }
    const std::span<const PinMapping> mappings = m_adapter->pinMap();
    for (size_t i = 0; i < m_pins.size(); ++i) {
        const PinMapping& mapping = mappings[i];
        if (mapping.moduleKind == ModuleKind::Reset) {
            stampResetPin(matrix, m_pins[i]);
            continue;
        }
        if (m_pinBatchByPin[i] == kNoPinBatch) {
            // Sem módulo concreto pra essa faixa ainda (ex: UART0_RX/TX -- só GPIO está
            // implementado nesta versão, ver Esp32Adapter::createModules()) -- mesma rede de
            // segurança do ramo "entrada" abaixo: nunca deixar uma linha inteiramente zerada.
            matrix.addConductanceToGround(m_pins[i], kFloatingConductance);
            continue;
        }

        const uint8_t state = m_pinStates[i];
        if ((state & QemuModule::kPinOutputEnabled) != 0) {
            const double targetVolts = (state & QemuModule::kPinOutputHigh) != 0 ? kDriveHighVolts : 0.0;
            matrix.addConductanceToGround(m_pins[i], kDriveConductance);
            matrix.addCurrentToGround(m_pins[i], targetVolts * kDriveConductance);
        } else {
            // Alta impedância (não baixa o pino de propósito -- quem estiver do outro lado do
            // fio decide o nível) MAS nunca zero: um pino sem fio nenhum (a maioria, a maior
            // parte do tempo) cairia numa linha zerada da matriz -- sistema singular, mesmo bug
            // já corrigido em WaveGen::stamp() pro pino "gnd" não-bipolar (ver doc lá).
            //
            // kDriveConductance/kFloatingConductance agora são as impedâncias REAIS de `IoPin` do
            // SimulIDE (40Ω/1e7Ω, ver comentário no .hpp) -- spread ~2.5e5, a MESMA ordem de
            // grandeza que o SimulIDE opera sem nenhum "colchão" especial, mesmo com um MCU de
            // dezenas de pinos flutuando ao mesmo tempo. O valor antigo (1e6/1e-6, spread 1e12) era
            // inflado de propósito só pra manter `rcond()` longe do piso de rejeição de
            // `CircuitGroup::singular()` (<= 1e-14) -- mas por não ter correspondência física
            // nenhuma, deixava o grupo perigosamente perto desse piso sempre que compartilhava
            // `CircuitGroup` com um componente não-linear em convergência (ex: `DiodeLegArray` do
            // LED do usuário), causando reset fantasma do RST/EN sincronizado com o toggle do GPIO
            // (achado 2026-07-17). Valores físicos reais são estruturalmente mais seguros aqui, não
            // menos -- não dependem de um spread artificial pra ficar bem-condicionados.
            //
            // Pull-up/pull-down INTERNO (ex: IO_MUX FUN_PU/FUN_PD do ESP32, ver
            // `QemuModule::pullState()`): quando o firmware habilita, o pino deixa de ser
            // puramente flutuante -- mesmo princípio elétrico do pull-up dedicado do RST/EN
            // (`stampResetPin()`), só que condicionado ao registrador real em vez de sempre-ligado.
            // Os dois juntos (pull-up E pull-down habilitados ao mesmo tempo, config incomum mas
            // fisicamente válida) simplesmente somam as duas stamps -- resultado real é um divisor
            // de tensão mais forte, não um erro a ser resolvido aqui.
            const bool pullUp = (state & QemuModule::kPinPullUp) != 0;
            const bool pullDown = (state & QemuModule::kPinPullDown) != 0;
            if (pullUp) {
                matrix.addConductanceToGround(m_pins[i], kWeakPullConductance);
                matrix.addCurrentToGround(m_pins[i], kDriveHighVolts * kWeakPullConductance);
            }
            if (pullDown) {
                matrix.addConductanceToGround(m_pins[i], kWeakPullConductance);
            }
            if (!pullUp && !pullDown) {
                matrix.addConductanceToGround(m_pins[i], kFloatingConductance);
            }
            PinBatch& batch = m_pinBatches[m_pinBatchByPin[i]];
            batch.inputBits.push_back(mapping.bitOrLine);
            batch.inputVoltages.push_back(matrix.getNodeVoltage(m_pins[i]));
        }
    }
    const uint64_t inputNs = m_scheduler.nowNsUnlocked();
    for (PinBatch& batch : m_pinBatches) {
        if (!batch.inputBits.empty()) batch.module->setInputVoltagesAt(batch.inputBits, batch.inputVoltages, inputNs);
        batch.inputBits.clear();
        batch.inputVoltages.clear();
    }
    m_vnextBChangeAwaitingStamp = false;
    publishVnextBGpioInputsLocked();
    scheduleWakeupsForAllModules(m_scheduler.nowNsUnlocked(), true);
}

void McuComponent::loadFirmware(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                                 const std::string& qemuBinaryOverride, McuDebugOptions debug,
                                 RuntimeLaunchIdentity identity) {
    // Também permite recarregar firmware enquanto o watcher está aguardando o próximo timestamp.
    stopPolling();
    // Achado 2026-07-21 (mesma classe de bug do doc-comment de DeferredSchedulerCall no .hpp):
    // loadMcuFirmware/stopMcuFirmware chamam isto direto de CoreApplication::handleMessage, na
    // thread de IPC -- NÃO na thread do Scheduler. Se startPolling()/markDirty() chamassem o
    // Scheduler direto aqui, segurando m_callbackState->mutex, e a thread do Scheduler estivesse
    // em stamp() deste MESMO MCU nesse instante (Scheduler::m_mutex -> CallbackState::mutex), as
    // duas travariam. loadFirmwareLocked() só ANEXA em `deferred`; disparamos aqui, uma vez, já
    // fora do lock (chamador único e não-reentrante -- ver as bordas de onEvent(), que chamam
    // loadFirmwareLocked() direto pelo motivo oposto).
    std::vector<DeferredSchedulerCall> deferred;
    {
        std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
        loadFirmwareLocked(firmwarePath, arenaName, qemuBinaryOverride, debug, deferred, identity);
    }
    for (DeferredSchedulerCall& call : deferred) call();
}

void McuComponent::loadFirmwareLocked(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                                       const std::string& qemuBinaryOverride, McuDebugOptions debug,
                                       std::vector<DeferredSchedulerCall>& deferred,
                                       RuntimeLaunchIdentity identity) {
    ++m_loadFirmwareCallCount;
    m_lastFirmwarePath = firmwarePath;
    m_lastArenaName = arenaName;
    m_lastQemuBinaryOverride = qemuBinaryOverride;
    m_lastDebugOptions = debug;

    if (m_controller.isRunning() || m_controller.arenaBridge().isOpen()) stopFirmware();
    resetModulesAndWakeups();

    // McuController::start() já cobre a sequência "Core cria a arena antes de o QEMU poder
    // anexá-la, depois inicia o processo" (mesmo código exercitado por McuControllerRealQemuTest
    // contra o binário QEMU de verdade) -- ver comentário do membro m_controller no .hpp.
    m_gdbPort = debug.gdbPort;
    m_syntheticArenaForTesting = false;
    // Achado 2026-07-22 (session_restart_stress_test intermitente sob carga): latestVirtualTimeNs()
    // rastreia o MAIOR simuTimePs já visto (compare_exchange que nunca retrocede, ver seu
    // doc-comment no .hpp) -- sem este reset, um firmware recarregado (novo processo QEMU, relógio
    // -icount próprio recomeçando perto de 0) nunca conseguia AVANÇAR esse indicador até seu
    // simuTimePs cru ultrapassar organicamente o pico deixado pela sessão ANTERIOR, deixando o
    // indicador de "MCU real-time %" (SimulationSession::firstMcuVirtualTimeNs) preso num valor
    // antigo e cada vez mais desonesto por vários ciclos de Stop->Run.
    //
    // Achado 2026-07-23: zera ANTES de setar a nova origem (ordem invertida em relação a antes) --
    // pacingPositionNs() lê os dois campos cross-thread, sem lock. Se um leitor pegar a transição
    // no meio nesta ordem, o pior caso é combinar a origem VELHA com virtualTimePs ZERADO, dando uma
    // posição um pouco ATRASADA (efeito: espera um instante a mais, inofensivo). Na ordem antiga
    // (origem primeiro), o pior caso combinava a origem NOVA com o simuTimePs VELHO da sessão
    // anterior, dando uma posição espúria no FUTURO (efeito: deixaria o elétrico correr à frente
    // indevidamente, ainda que só por uma janela curta).
    m_latestVirtualTimePs.store(0, std::memory_order_relaxed);
    m_latestVnextBVirtualTimeNs.store(0, std::memory_order_relaxed);
    // R3c: a heartbeat tick from the PREVIOUS generation must never be mistaken for the new
    // session's progress -- reset alongside the other virtual-time fields, at the same reload
    // point, before the new attachment's own watermark starts publishing from ~0.
    m_vnextBHeartbeatWatermarkNs.store(0, std::memory_order_relaxed);
    m_vnextI2cCompletionCount.store(0, std::memory_order_relaxed);
    m_vnextI2cSubmissionCount.store(0, std::memory_order_relaxed);
    m_nextPendingEventNs.store(0, std::memory_order_relaxed);
    m_qemuTimeOriginNs.store(m_scheduler.nowNs(), std::memory_order_relaxed);
    bindPollDoorbellLocked(arenaName);
    m_controller.start(firmwarePath, arenaName, qemuBinaryOverride, debug, identity,
                       [this] {
                           if (lockstepTraceEnabled()) {
                               uint64_t expected = 0;
                               g_lockstepTrace.wakeNs.compare_exchange_strong(expected, steadyNowNs());
                           }
                           if (m_controller.lockstep()) {
                               if (const auto safeNs = m_controller.vnextBAttachment().lockstepSafeTimeNs();
                                   safeNs && qemu::advanceMonotonicNs(m_lockstepPrefetchNs, *safeNs))
                                   m_scheduler.notifyAdvanceLimitChanged();
                           }
                           m_scheduler.markDirty(m_componentIndex);
                           lasecsimul::simulation::diag::ProvenanceTracker::instance().recordDirty(
                               lasecsimul::simulation::diag::DirtyOrigin::ExternalMarkDirty,
                               m_componentIndex, m_scheduler.nowNsUnlocked());
                       });
    diag::trace(diag::ConsumerTraceEvent::ArenaBind, identity.sessionExecutionId, 0, 0,
                identity.launchGeneration);
    // Anexação VNEXT_B nova = snapshot novo e zerado: republica o nível atual das entradas (ex.:
    // botão já em 5 V desde t=0 nunca gera borda depois da carga do firmware).
    m_vnextBGpioInPublished = false;
    m_vnextBNotifiedGpioInValid = {};
    m_vnextBChangeAwaitingStamp = false;
    m_vnextBElectricalI2c.reset();
    m_vnextBQueuedI2c.clear();
    m_lockstepObservedSyncSeq.store(0, std::memory_order_relaxed);
    m_lockstepPrefetchNs.store(0, std::memory_order_relaxed);
    m_lockstepPublishedSeq = 0;
    m_lockstepPublishedTimeNs = UINT64_MAX;
    m_lockstepPublishedHorizonNs = UINT64_MAX;
    m_lockstepPublishedInputHorizonNs = UINT64_MAX;
    publishVnextBGpioInputsLocked();
    if (!m_controller.vnextBActive()) {
        startPolling(&deferred);
    }
    deferred.push_back([&scheduler = m_scheduler, index = m_componentIndex] { scheduler.markDirty(index); });
}

void McuComponent::stopFirmware() {
    const uint64_t traceExecId = m_controller.runtimeIdentity().sessionExecutionId;
    diag::trace(diag::ConsumerTraceEvent::ArenaUnbind, traceExecId, 0, 0);
    // O callback pode estar aguardando o QEMU publicar o próximo timestamp segurando apenas este
    // mutex de lifetime. Sinalize primeiro para que ele saia; só então serialize o teardown.
    stopPolling();
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    m_controller.stop();
}

bool McuComponent::firmwareRunning() const {
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    return m_controller.isRunning();
}

std::string McuComponent::qemuLogs() const {
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    return m_controller.qemuLogs();
}

void McuComponent::openSyntheticArenaForTesting(const std::string& arenaName) {
    // Mesma ressalva de loadFirmware(): pode ser chamado de uma thread de teste diferente da do
    // Scheduler enquanto ele já está rodando (ver McuComponentLivePollThreadTest.cpp) -- não pode
    // chamar o Scheduler direto segurando m_callbackState->mutex.
    std::vector<DeferredSchedulerCall> deferred;
    {
        std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
        m_syntheticArenaForTesting = true;
        // Ordem invertida (zera primeiro, seta origem depois) -- ver comentário em loadFirmwareLocked().
        m_latestVirtualTimePs.store(0, std::memory_order_relaxed);
        m_latestVnextBVirtualTimeNs.store(0, std::memory_order_relaxed);
        m_vnextBHeartbeatWatermarkNs.store(0, std::memory_order_relaxed);
        m_nextPendingEventNs.store(0, std::memory_order_relaxed);
        m_qemuTimeOriginNs.store(m_scheduler.nowNs(), std::memory_order_relaxed);
        bindPollDoorbellLocked(arenaName);
        m_controller.arenaBridge().open(qemu::QemuArenaOpenOptions{arenaName, true});
        startPolling(&deferred);
    }
    for (DeferredSchedulerCall& call : deferred) call();
}

void McuComponent::ringPollDoorbellForTesting() {
#ifdef _WIN32
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    if (m_callbackState->doorbell &&
        !SetEvent(static_cast<HANDLE>(m_callbackState->doorbell))) {
        throw std::runtime_error("failed to signal MCU poll doorbell in test");
    }
#endif
}

void McuComponent::dumpConsumerTraceForTesting() { diag::dump(stderr, /*maxEntries=*/50); }
void McuComponent::dumpConsumerTraceToFileForTesting() { diag::dumpToFile(); }
void McuComponent::resetPerCycleWatchesForTesting() { diag::resetPerCycleWatchesForTesting(); }
void McuComponent::printAddressWatchSummaryForTesting(int cycle) { diag::printAddressWatchSummary(cycle); }
uint64_t McuComponent::peekAndResetMaxQueueOccupancyForTesting() {
    if (!diag::traceEnabled()) return 0;
    diag::PressureState& ps = diag::pressureState();
    return ps.maxOccupancy.exchange(0, std::memory_order_relaxed);
}

void McuComponent::resetModulesAndWakeups() {
    for (const std::unique_ptr<QemuModule>& m : m_modules) m->reset();
    for (size_t i = 0; i < m_modules.size(); ++i) {
        ++m_moduleWakeupGeneration[i]; // invalida qualquer wakeup já agendado antes do reset
        m_moduleWakeupDueNs[i] = QemuModule::kNoWakeup;
    }
}

void McuComponent::stampResetPin(MnaMatrixView& matrix, const Pin& pin) {
    // ModuleKind::Reset (ex: EN do ESP32) nunca tem QemuModule -- é linha de controle de
    // hardware, não registrador. Sem fio externo, fica puxado pra ALTO por um pull-up DEDICADO
    // (`kWeakPullConductance`, 100kΩ, idêntico a `Esp32Pin::m_pullAdmit`/`setPullup(1e5)` do
    // SimulIDE real) -- NUNCA o `kFloatingConductance` genérico de GPIO (que puxa fraco pra terra,
    // sentido oposto, e é 100x mais fraco): "sem ligação" aqui tem que significar "não resetado",
    // com força elétrica de pull-up de verdade, não um resíduo de "flutuando" emprestado de outro
    // tipo de pino. Um circuito real (botão + pull-up externo, igual ao EN real do DevKit) com
    // condutância ainda mais forte domina e decide o nível de verdade quando presente.
    //
    // Só modelagem ELÉTRICA aqui -- a detecção de borda (reset/reload) mora em `onEvent()`, que só
    // é chamado pelo framework depois do solver convergir E numa transição REAL de nível (ver
    // comentário de `onEvent()` no .hpp). `stamp()` roda várias vezes por rodada de convergência do
    // Newton (uma vez por iteração até o dirty-set esvaziar); ler `matrix.getNodeVoltage(pin)` AQUI
    // e comparar contra o estado anterior seria repetir o bug de cold-start já corrigido (a leitura
    // de uma iteração intermediária, ainda não convergida, sendo tratada como uma borda real).
    matrix.addConductanceToGround(pin, kWeakPullConductance);
    matrix.addCurrentToGround(pin, kDriveHighVolts * kWeakPullConductance);
}

void McuComponent::onEvent(const ComponentEvent& event) {
    if (event.tag != kPinChangeEventTag) return;
    const std::span<const PinMapping> mappings = m_adapter->pinMap();
    if (event.a >= mappings.size()) return;

    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    const bool levelHigh = event.b != 0;
    const PinMapping& mapping = mappings[event.a];
    if (mapping.moduleKind != ModuleKind::Reset) {
        // O pad de entrada continua fisicamente conectado quando o GPIO está configurado como
        // saída. ESP-IDF/Arduino `digitalRead(pin)` lê GPIO_IN (nível real do pad), não o latch
        // GPIO_OUT. Antes só atualizávamos a entrada no ramo de alta impedância de stamp(); depois
        // de pinMode(OUTPUT), digitalRead() ficava preso no último zero e o padrão comum
        // `digitalWrite(pin, !digitalRead(pin))` escrevia HIGH para sempre. O evento chega após a
        // convergência do solver, portanto também preserva o comportamento real quando uma carga
        // externa altera o nível do pad dirigido.
        if (event.a < m_moduleByPin.size()) {
            if (QemuModule* module = m_moduleByPin[event.a]) {
                module->setInputLevelAt(mapping.bitOrLine, levelHigh, m_scheduler.nowNsUnlocked());
            }
        }
        publishVnextBGpioInputsLocked();
        return;
    }
    m_resetPinHigh = levelHigh;

    if (!levelHigh) {
        // Borda de descida CONFIRMADA (o framework só chama onEvent numa transição real, com a
        // tensão já convergida -- ver `SimulationSession::settleStep()`, passo 3b): EN/RST ativo
        // (baixo) -- mantém o chip parado enquanto durar, igual a hardware real (CHIP_PU
        // desasserta, CPU não roda). stopFirmware()/loadFirmware() chamam Scheduler::markDirty
        // (toma m_mutex) -- nunca direto de dentro de onEvent()/stamp() (deadlock, `onEvent()` é
        // chamado com o m_mutex do Scheduler já travado por `Scheduler::runUntil()`, ver doc de
        // scheduleEventUnlocked em Scheduler.hpp), por isso agendado.
        const std::weak_ptr<CallbackState> weakState = m_callbackState;
        m_scheduler.scheduleEventUnlocked(0, [weakState] {
            const std::shared_ptr<CallbackState> state = weakState.lock();
            if (!state) return;
            // Achado 2026-07-21 (ver doc-comment de DeferredSchedulerCall no .hpp): este callback
            // já roda com `state->mutex` travado por TODA a duração do bloco abaixo -- markDirty()
            // só pode disparar DEPOIS que `innerLock` solta de vez, senão inverte a ordem de lock
            // contra qualquer chamador concorrente que segure Scheduler::m_mutex primeiro (ex:
            // componentHealth() via Scheduler::trySynchronized() -> McuComponent::health()).
            simulation::Scheduler* scheduler = nullptr;
            uint32_t componentIndex = 0;
            {
                std::lock_guard<std::recursive_mutex> innerLock(state->mutex);
                McuComponent* self = state->owner;
                if (!self) return;
                self->resetModulesAndWakeups();
                self->stopFirmware(); // não toca o Scheduler (só m_controller.stop()) -- seguro aninhado.
                scheduler = &self->m_scheduler;
                componentIndex = self->m_componentIndex;
            }
            scheduler->markDirty(componentIndex);
        });
    } else if (!firmwareRunning() && !m_lastFirmwarePath.empty()) {
        // Borda de subida: EN/RST liberado -- reinicia o firmware do zero (mesmo path/arena do
        // loadFirmware() anterior), igual a hardware real (CPU reinicia do vetor de boot). SÓ
        // quando o firmware NÃO está rodando (`!firmwareRunning()`) -- sem essa guarda, a 1ª borda
        // de subida natural (`m_previousNodeVoltages` do framework começa em 0V pra QUALQUER nó
        // recém-criado, então a tensão real ~3.3V do próprio `loadFirmware()` que acabou de rodar
        // JÁ conta como "subida") disparava um reload IMEDIATO logo depois de todo `loadFirmware()`
        // legítimo -- matava o processo QEMU recém-iniciado antes do firmware rodar qualquer coisa
        // (achado 2026-07-17: usuário reportou "nem o pulso eu detecto mais" depois da correção do
        // reset fantasma -- o reset fantasma tinha virado um reload fantasma). Sem firmware
        // carregado ainda (`m_lastFirmwarePath` vazio, ex: 1ª borda de subida do pull-up no boot
        // antes de qualquer `loadFirmware()`), não há o que recarregar de qualquer forma.
        const std::filesystem::path firmwarePath = m_lastFirmwarePath;
        const std::string arenaName = m_lastArenaName;
        const std::string qemuOverride = m_lastQemuBinaryOverride;
        const McuDebugOptions debug = m_lastDebugOptions;
        const std::weak_ptr<CallbackState> weakState = m_callbackState;
        m_scheduler.scheduleEventUnlocked(0, [weakState, firmwarePath, arenaName, qemuOverride, debug] {
            const std::shared_ptr<CallbackState> state = weakState.lock();
            if (!state) return;
            // Chama loadFirmwareLocked() (não o loadFirmware() público) de propósito: este
            // callback já segura `state->mutex` (reentrante) pela duração do bloco -- disparar as
            // chamadas ao Scheduler só depois que ELE solta de vez, mesma razão do ramo de descida
            // acima (ver doc-comment de DeferredSchedulerCall no .hpp).
            std::vector<DeferredSchedulerCall> deferred;
            {
                std::lock_guard<std::recursive_mutex> innerLock(state->mutex);
                McuComponent* self = state->owner;
                if (!self) return;
                self->stopPolling();
                self->loadFirmwareLocked(firmwarePath, arenaName, qemuOverride, debug, deferred);
            }
            for (DeferredSchedulerCall& call : deferred) call();
        });
    }
}

} // namespace lasecsimul::mcu

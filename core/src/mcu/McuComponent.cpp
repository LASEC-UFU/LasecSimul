#include "McuComponent.hpp"
#include "lasecsimul/qemu_arena_abi.h"
#include <limits>
#include <thread>

namespace lasecsimul::mcu {

namespace {
uint64_t qemuEventTimeNs(uint64_t originNs, uint64_t virtualTimePs) {
    const uint64_t deltaNs = virtualTimePs / 1000u + (virtualTimePs % 1000u != 0 ? 1u : 0u);
    if (deltaNs > std::numeric_limits<uint64_t>::max() - originNs) return std::numeric_limits<uint64_t>::max();
    return originNs + deltaNs;
}
} // namespace

McuComponent::McuComponent(std::unique_ptr<IMcuAdapter> adapter, simulation::Scheduler& scheduler,
                           std::span<const Pin> requestedPins)
    : m_adapter(std::move(adapter)), m_scheduler(scheduler), m_controller(*m_adapter),
      m_callbackState(std::make_shared<CallbackState>()) {
    m_callbackState->owner = this;
    m_modules = m_adapter->createModules();
    m_moduleWakeupDueNs.assign(m_modules.size(), QemuModule::kNoWakeup);
    m_moduleWakeupGeneration.assign(m_modules.size(), 0);

    const auto pinMap = m_adapter->pinMap();
    const bool useRequestedPins = requestedPins.size() == pinMap.size();
    m_pins.reserve(pinMap.size());
    for (size_t index = 0; index < pinMap.size(); ++index) {
        if (useRequestedPins) {
            Pin pin = requestedPins[index];
            if (pin.id.empty()) pin.id = pinMap[index].pinId;
            m_pins.push_back(std::move(pin));
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
    // m_controller já chamou setMemoryRegions(m_adapter->memoryRegions()) no próprio construtor.
}

McuComponent::~McuComponent() {
    m_polling.store(false, std::memory_order_release);
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

void McuComponent::startPolling() {
    m_polling.store(true, std::memory_order_release);
    scheduleNextPoll();
}

void McuComponent::stopPolling() { m_polling.store(false, std::memory_order_release); }

void McuComponent::scheduleNextPoll() {
    // +1ns (não `nowNs()` cru): quando chamado de dentro de `onPollEvent()` sem o Scheduler
    // rodando em background (`isRunning()==false` -- driver síncrono via `step()`/testes), um
    // evento reagendado EXATAMENTE no instante atual é reprocessado na MESMA passada de
    // `runUntil()` (o laço interno consome qualquer evento com `timeNs <= nextTime`, e `m_nowNs`
    // nunca avança processando um evento no MESMO instante) -- livelock genuíno, `m_nowNs` nunca
    // avança, achado do diagnóstico "QEMU manda sinal mas vem como pulso e não retém": mascarado
    // até aqui só porque o reset fantasma do EN/RST (ver `m_resetPinObserved`) fechava a arena
    // antes deste laço rodar. O +1ns é imperceptível pro caso normal (`startPolling()`, chamado
    // fora de `runUntil()`) e garante que `m_nowNs` sempre progride, então o laço termina.
    schedulePollAt(m_scheduler.nowNs() + 1);
}

void McuComponent::schedulePollAt(uint64_t timeNs) {
    if (m_pollEventScheduled) return;
    m_pollEventScheduled = true;
    const std::weak_ptr<CallbackState> weakState = m_callbackState;
    m_scheduler.scheduleAt(timeNs, [weakState] {
        const std::shared_ptr<CallbackState> state = weakState.lock();
        if (!state) return;
        std::lock_guard<std::recursive_mutex> lock(state->mutex);
        McuComponent* self = state->owner;
        if (!self) return;
        self->onPollEvent();
    });
}

void McuComponent::onPollEvent() {
    m_pollEventScheduled = false;
    qemu::QemuArenaBridge& arena = m_controller.arenaBridge();
    while (m_polling.load(std::memory_order_acquire) && arena.isOpen()) {
        const qemu::QemuPollResult result = arena.poll();
        if (!result.hasEvent || !result.event) {
            // O QEMU é a fonte do próximo timestamp, como no QemuDevice::runEvent do SimulIDE.
            // Este callback roda fora do mutex do Scheduler: IPC e Stop continuam livres.
            if (!m_scheduler.isRunning()) {
                scheduleNextPoll();
                return;
            }
            std::this_thread::yield();
            continue;
        }

        const uint64_t eventNs = qemuEventTimeNs(m_qemuTimeOriginNs, result.event->simuTimePs);
        const uint64_t nowNs = m_scheduler.nowNs();
        if (eventNs > nowNs) {
            // Mantém a ação na arena e agenda uma única entrada exatamente no instante publicado.
            schedulePollAt(eventNs);
            return;
        }

        const bool changed = dispatchArenaEvent(*result.event, eventNs);
        scheduleWakeupsForAllModules(eventNs, false);
        if (changed) m_scheduler.markDirty(m_componentIndex);
        // A próxima iteração agrupa ações do mesmo timestamp; uma ação futura cai no ramo acima.
    }
}

void McuComponent::scheduleModuleWakeup(size_t moduleIndex, uint64_t nowNs, bool schedulerLockHeld) {
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
        std::lock_guard<std::recursive_mutex> lock(state->mutex);
        McuComponent* self = state->owner;
        if (!self || moduleIndex >= self->m_moduleWakeupGeneration.size()) return;
        if (self->m_moduleWakeupGeneration[moduleIndex] != generation) return;
        self->m_moduleWakeupDueNs[moduleIndex] = QemuModule::kNoWakeup;
        const uint64_t nowNs = self->m_scheduler.nowNs();
        const uint64_t before = self->electricalOutputFingerprint();
        self->m_modules[moduleIndex]->onWakeup(nowNs);
        const bool changed = before != self->electricalOutputFingerprint();
        self->scheduleModuleWakeup(moduleIndex, nowNs, false);
        // Mudança de FIFO/RX ou bit TX repetido não altera o circuito elétrico.
        if (changed) self->m_scheduler.markDirty(self->m_componentIndex);
    };
    if (schedulerLockHeld) m_scheduler.scheduleEventUnlocked(delayNs, std::move(callback));
    else m_scheduler.scheduleEvent(delayNs, std::move(callback));
}

void McuComponent::scheduleWakeupsForAllModules(uint64_t nowNs, bool schedulerLockHeld) {
    for (size_t i = 0; i < m_modules.size(); ++i) scheduleModuleWakeup(i, nowNs, schedulerLockHeld);
}

QemuModule* McuComponent::findModule(uint64_t address) const {
    for (const std::unique_ptr<QemuModule>& module : m_modules) {
        if (module->owns(address)) return module.get();
    }
    return nullptr;
}

uint64_t McuComponent::electricalOutputFingerprint() const {
    // FNV-1a: estado compacto, sem alocação, suficiente para detectar a mudança que exige
    // restamp. Inclui a posição implicitamente pela ordem do pinMap.
    uint64_t fingerprint = 1469598103934665603ull;
    const std::span<const PinMapping> mappings = m_adapter->pinMap();
    for (size_t index = 0; index < mappings.size(); ++index) {
        const PinMapping& mapping = mappings[index];
        uint8_t value = 0;
        if (QemuModule* module = m_moduleByPin[index]) {
            if (module->isOutputEnabled(mapping.bitOrLine)) {
                value = static_cast<uint8_t>(1u | (module->outputLevel(mapping.bitOrLine) ? 2u : 0u));
            }
        }
        fingerprint ^= value;
        fingerprint *= 1099511628211ull;
    }
    return fingerprint;
}

bool McuComponent::pollAndDispatchPendingEvents(uint64_t nowNs) {
    qemu::QemuArenaBridge& arenaBridge = m_controller.arenaBridge();
    if (!arenaBridge.isOpen()) return false;
    // A arena possui um único slot com handshake: enquanto o Core confirma este evento o QEMU
    // não pode publicar outro. Portanto, um poll processa no máximo um evento real; um laço com
    // limite arbitrário apenas criava busy-wait e piorava a latência de controle.
    const qemu::QemuPollResult result = arenaBridge.poll();
    if (!result.hasEvent || !result.event) return false;
    const uint64_t eventNs = qemuEventTimeNs(m_qemuTimeOriginNs, result.event->simuTimePs);
    // Uma stamp causada por outra parte do circuito não pode antecipar o relógio virtual do QEMU.
    // O slot permanece intacto; onPollEvent() já está agendado para consumi-lo no instante correto.
    if (eventNs > nowNs && !m_syntheticArenaForTesting) return false;
    return dispatchArenaEvent(*result.event, m_syntheticArenaForTesting ? nowNs : eventNs);
}

bool McuComponent::dispatchArenaEvent(const qemu::QemuArenaEvent& event, uint64_t eventTimeNs) {
    qemu::QemuArenaBridge& arenaBridge = m_controller.arenaBridge();
    if (!arenaBridge.isOpen()) return false;
    const uint64_t before = electricalOutputFingerprint();
    if (event.simuAction == LSDN_SIM_WRITE) {
        if (QemuModule* module = findModule(event.regAddr)) {
            module->writeRegisterAt(event.regAddr, event.regData, eventTimeNs);
        }
        arenaBridge.acknowledgeWrite();
    } else if (event.simuAction == LSDN_SIM_READ) {
        uint64_t value = 0;
        if (QemuModule* module = findModule(event.regAddr)) value = module->readRegister(event.regAddr);
        arenaBridge.acknowledgeRead(value);
    } else {
        // SIM_FREQ/SIM_EVENT/SIM_INTERRUPT/SIM_I2C/SIM_SPI/SIM_USART/SIM_TIMER/SIM_GPIO_IN:
        // confirma para liberar o QEMU mesmo quando não há payload elétrico a aplicar.
        arenaBridge.acknowledgeWrite();
    }
    return before != electricalOutputFingerprint();
}

void McuComponent::stamp(MnaMatrixView& matrix) {
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    ++m_stampCount;
    // Mantém o contrato de chamadas que marcam o MCU dirty explicitamente (testes sintéticos,
    // hosts ABI e futuras fontes de interrupção). O poll periódico continua desacoplado do MNA:
    // ele só marca dirty quando a saída elétrica muda.
    pollAndDispatchPendingEvents(m_scheduler.nowNsUnlocked());

    // Ponte pino<->matriz, genérica (ver doc da classe): pra cada PinMapping, pergunta ao módulo
    // responsável (nunca sabe qual chip é) se aquele bit está em modo saída -- se sim, dirige o
    // pino real; se não, lê a tensão atual do pino e alimenta de volta no módulo (pra uma leitura
    // de registrador futura, ex: GPIO_IN_REG, devolver o valor certo).
    for (size_t i = 0; i < m_pins.size(); ++i) {
        const PinMapping& mapping = m_adapter->pinMap()[i];
        if (mapping.moduleKind == ModuleKind::Reset) {
            stampResetPin(matrix, m_pins[i]);
            continue;
        }
        QemuModule* module = m_moduleByPin[i];
        if (!module) {
            // Sem módulo concreto pra essa faixa ainda (ex: UART0_RX/TX -- só GPIO está
            // implementado nesta versão, ver Esp32Adapter::createModules()) -- mesma rede de
            // segurança do ramo "entrada" abaixo: nunca deixar uma linha inteiramente zerada.
            matrix.addConductanceToGround(m_pins[i], kFloatingConductance);
            continue;
        }

        if (module->isOutputEnabled(mapping.bitOrLine)) {
            const double targetVolts = module->outputLevel(mapping.bitOrLine) ? kDriveHighVolts : 0.0;
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
            matrix.addConductanceToGround(m_pins[i], kFloatingConductance);
            const double voltage = matrix.getNodeVoltage(m_pins[i]);
            module->setInputLevelAt(mapping.bitOrLine, voltage > kDigitalLevelThreshold, m_scheduler.nowNsUnlocked());
        }
    }
    scheduleWakeupsForAllModules(m_scheduler.nowNsUnlocked(), true);
}

void McuComponent::loadFirmware(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                                 const std::string& qemuBinaryOverride, McuDebugOptions debug) {
    // Também permite recarregar firmware enquanto o watcher está aguardando o próximo timestamp.
    stopPolling();
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
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
    m_qemuTimeOriginNs = m_scheduler.nowNs();
    m_controller.start(firmwarePath, arenaName, qemuBinaryOverride, debug);
    startPolling();
    m_scheduler.markDirty(m_componentIndex);
}

void McuComponent::stopFirmware() {
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
    std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
    m_syntheticArenaForTesting = true;
    m_qemuTimeOriginNs = m_scheduler.nowNs();
    m_controller.arenaBridge().open(qemu::QemuArenaOpenOptions{arenaName, true});
    startPolling();
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
    // (`kResetPullupConductance`, 100kΩ, idêntico a `Esp32::addPin()->setPullup(1e5)` do SimulIDE
    // real) -- NUNCA o `kFloatingConductance` genérico de GPIO (que puxa fraco pra terra, sentido
    // oposto, e é 100x mais fraco): "sem ligação" aqui tem que significar "não resetado", com força
    // elétrica de pull-up de verdade, não um resíduo de "flutuando" emprestado de outro tipo de
    // pino. Um circuito real (botão + pull-up externo, igual ao EN real do DevKit) com condutância
    // ainda mais forte domina e decide o nível de verdade quando presente.
    //
    // Só modelagem ELÉTRICA aqui -- a detecção de borda (reset/reload) mora em `onEvent()`, que só
    // é chamado pelo framework depois do solver convergir E numa transição REAL de nível (ver
    // comentário de `onEvent()` no .hpp). `stamp()` roda várias vezes por rodada de convergência do
    // Newton (uma vez por iteração até o dirty-set esvaziar); ler `matrix.getNodeVoltage(pin)` AQUI
    // e comparar contra o estado anterior seria repetir o bug de cold-start já corrigido (a leitura
    // de uma iteração intermediária, ainda não convergida, sendo tratada como uma borda real).
    matrix.addConductanceToGround(pin, kResetPullupConductance);
    matrix.addCurrentToGround(pin, kDriveHighVolts * kResetPullupConductance);
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
            std::lock_guard<std::recursive_mutex> innerLock(state->mutex);
            McuComponent* self = state->owner;
            if (!self) return;
            self->resetModulesAndWakeups();
            self->stopFirmware();
            self->m_scheduler.markDirty(self->m_componentIndex);
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
            std::lock_guard<std::recursive_mutex> innerLock(state->mutex);
            if (state->owner) state->owner->loadFirmware(firmwarePath, arenaName, qemuOverride, debug);
        });
    }
}

} // namespace lasecsimul::mcu

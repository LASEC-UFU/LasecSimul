#include "McuComponent.hpp"
#include "lasecsimul/qemu_arena_abi.h"

namespace lasecsimul::mcu {

McuComponent::McuComponent(std::unique_ptr<IMcuAdapter> adapter, simulation::Scheduler& scheduler,
                           std::span<const Pin> requestedPins)
    : m_adapter(std::move(adapter)), m_scheduler(scheduler), m_controller(*m_adapter) {
    m_modules = m_adapter->createModules();
    m_moduleWakeupDueNs.assign(m_modules.size(), QemuModule::kNoWakeup);
    m_moduleWakeupGeneration.assign(m_modules.size(), 0);
    m_moduleWakeupPending.assign(m_modules.size(), 0);

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
    // m_controller já chamou setMemoryRegions(m_adapter->memoryRegions()) no próprio construtor.
}

PluginHealthStatus McuComponent::health() const {
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
    scheduleNextPoll();
}

void McuComponent::scheduleNextPoll() {
    m_scheduler.scheduleEvent(kPollIntervalNs, [this] {
        m_scheduler.markDirty(m_componentIndex);
        scheduleNextPoll();
    });
}

void McuComponent::scheduleModuleWakeup(size_t moduleIndex) {
    if (moduleIndex >= m_modules.size()) return;

    const uint64_t nowNs = m_scheduler.nowNsUnlocked();
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
    m_scheduler.scheduleEventUnlocked(delayNs, [this, moduleIndex, generation] {
        if (moduleIndex >= m_moduleWakeupGeneration.size()) return;
        if (m_moduleWakeupGeneration[moduleIndex] != generation) return;
        m_moduleWakeupDueNs[moduleIndex] = QemuModule::kNoWakeup;
        m_moduleWakeupPending[moduleIndex] = 1;
        m_scheduler.markDirty(m_componentIndex);
    });
}

void McuComponent::scheduleWakeupsForAllModules() {
    for (size_t i = 0; i < m_modules.size(); ++i) scheduleModuleWakeup(i);
}

void McuComponent::runPendingModuleWakeups() {
    const uint64_t nowNs = m_scheduler.nowNsUnlocked();
    for (size_t i = 0; i < m_modules.size(); ++i) {
        if (!m_moduleWakeupPending[i]) continue;
        m_moduleWakeupPending[i] = 0;
        m_modules[i]->onWakeup(nowNs);
    }
}

QemuModule* McuComponent::findModule(uint64_t address) const {
    for (const std::unique_ptr<QemuModule>& module : m_modules) {
        if (module->owns(address)) return module.get();
    }
    return nullptr;
}

void McuComponent::pollAndDispatchPendingEvents() {
    qemu::QemuArenaBridge& arenaBridge = m_controller.arenaBridge();
    if (!arenaBridge.isOpen()) return;
    for (int i = 0; i < kMaxEventsPerStamp; ++i) {
        const qemu::QemuPollResult result = arenaBridge.poll();
        if (!result.hasEvent || !result.event) break;
        const qemu::QemuArenaEvent& event = *result.event;

        if (event.simuAction == LSDN_SIM_WRITE) {
            if (QemuModule* module = findModule(event.regAddr)) {
                module->writeRegisterAt(event.regAddr, event.regData, m_scheduler.nowNsUnlocked());
            }
            arenaBridge.acknowledgeWrite();
        } else if (event.simuAction == LSDN_SIM_READ) {
            uint64_t value = 0;
            if (QemuModule* module = findModule(event.regAddr)) value = module->readRegister(event.regAddr);
            arenaBridge.acknowledgeRead(value);
        } else {
            // SIM_FREQ/SIM_EVENT/SIM_INTERRUPT/SIM_I2C/SIM_SPI/SIM_USART/SIM_TIMER/SIM_GPIO_IN:
            // fora de escopo desta versão (Blink Real só precisa de SIM_READ/SIM_WRITE) -- só
            // confirma pra não travar o QEMU esperando uma resposta que nunca vem.
            arenaBridge.acknowledgeWrite();
        }
    }
}

void McuComponent::stamp(MnaMatrixView& matrix) {
    runPendingModuleWakeups();
    pollAndDispatchPendingEvents();

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
        QemuModule* module = nullptr;
        for (const std::unique_ptr<QemuModule>& candidate : m_modules) {
            if (candidate->kind() == mapping.moduleKind && candidate->index() == mapping.moduleIndex) {
                module = candidate.get();
                break;
            }
        }
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
            // kDriveConductance/kFloatingConductance NÃO podem ter spread arbitrário: um único
            // componente com MUITOS pinos simultaneamente não-conectados (este é o primeiro --
            // 42 pinos) faz a matriz inteira ficar diagonal, e CircuitGroup::singular() rejeita
            // por rcond() <= 1e-14 -- 1e9 (drive) vs 1e-9 (antiga "alta impedância" copiada de
            // Probe/WaveGen) já dá rcond ~1e-18, MUITO abaixo do limite, mesmo sendo uma matriz
            // perfeitamente diagonal/bem-condicionada equação a equação. Por isso este componente
            // usa valores próprios (1e6/1e-6, rcond ~1e-12) em vez dos de outros componentes --
            // ainda "forte o bastante"/"fraco o bastante" pra qualquer fio real, só com spread
            // seguro pro double. Ver .spec se outro componente algum dia precisar do mesmo ajuste.
            matrix.addConductanceToGround(m_pins[i], kFloatingConductance);
            const double voltage = matrix.getNodeVoltage(m_pins[i]);
            module->setInputLevelAt(mapping.bitOrLine, voltage > kDigitalLevelThreshold, m_scheduler.nowNsUnlocked());
        }
    }
    scheduleWakeupsForAllModules();
}

void McuComponent::loadFirmware(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                                 const std::string& qemuBinaryOverride, McuDebugOptions debug) {
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
    m_controller.start(firmwarePath, arenaName, qemuBinaryOverride, debug);
    m_scheduler.markDirty(m_componentIndex);
}

void McuComponent::stopFirmware() { m_controller.stop(); }

void McuComponent::resetModulesAndWakeups() {
    for (const std::unique_ptr<QemuModule>& m : m_modules) m->reset();
    for (size_t i = 0; i < m_modules.size(); ++i) {
        ++m_moduleWakeupGeneration[i]; // invalida qualquer wakeup já agendado antes do reset
        m_moduleWakeupDueNs[i] = QemuModule::kNoWakeup;
        m_moduleWakeupPending[i] = 0;
    }
}

void McuComponent::stampResetPin(MnaMatrixView& matrix, const Pin& pin) {
    // ModuleKind::Reset (ex: EN do ESP32) nunca tem QemuModule -- é linha de controle de
    // hardware, não registrador. Sem fio externo, fica fracamente puxado pra ALTO (chip roda) --
    // ao contrário do floating genérico de GPIO (puxa fraco pra terra) -- "sem ligação" aqui tem
    // que significar "não resetado". Um circuito real (botão + pull-up, igual ao EN real) com
    // condutância muito mais forte domina e decide o nível de verdade quando presente.
    matrix.addConductanceToGround(pin, kFloatingConductance);
    matrix.addCurrentToGround(pin, kDriveHighVolts * kFloatingConductance);
    const bool levelHigh = matrix.getNodeVoltage(pin) > kDigitalLevelThreshold;

    if (m_resetPinHigh && !levelHigh) {
        // Borda de descida: EN/RST ativo (baixo) -- mantém o chip parado enquanto durar, igual a
        // hardware real (CHIP_PU desasserta, CPU não roda). stopFirmware()/loadFirmware() chamam
        // Scheduler::markDirty (toma m_mutex) -- nunca direto de dentro de stamp() (deadlock, ver
        // doc de scheduleEventUnlocked em Scheduler.hpp), por isso agendado.
        m_resetPinHigh = false;
        m_scheduler.scheduleEventUnlocked(0, [this] {
            resetModulesAndWakeups();
            stopFirmware();
            m_scheduler.markDirty(m_componentIndex);
        });
    } else if (!m_resetPinHigh && levelHigh) {
        // Borda de subida: EN/RST liberado -- reinicia o firmware do zero (mesmo path/arena do
        // loadFirmware() anterior), igual a hardware real (CPU reinicia do vetor de boot).
        m_resetPinHigh = true;
        if (!m_lastFirmwarePath.empty()) {
            const std::filesystem::path firmwarePath = m_lastFirmwarePath;
            const std::string arenaName = m_lastArenaName;
            const std::string qemuOverride = m_lastQemuBinaryOverride;
            const McuDebugOptions debug = m_lastDebugOptions;
            m_scheduler.scheduleEventUnlocked(0, [this, firmwarePath, arenaName, qemuOverride, debug] {
                loadFirmware(firmwarePath, arenaName, qemuOverride, debug);
            });
        }
    }
}

} // namespace lasecsimul::mcu

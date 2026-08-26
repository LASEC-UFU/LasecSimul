#include "McuComponent.hpp"
#include "lasecsimul/qemu_arena_abi.h"
#include <algorithm>
#include <array>
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

std::optional<uint64_t> McuComponent::pacingPositionNs() const {
    const uint64_t ps = m_latestVirtualTimePs.load(std::memory_order_relaxed);
    const uint64_t appliedPosition =
        ps == 0 ? 0 : qemuEventTimeNs(
                            m_qemuTimeOriginNs.load(std::memory_order_relaxed), ps);
    const uint64_t pendingPosition =
        m_nextPendingEventNs.load(std::memory_order_relaxed);
    const uint64_t safeFrontier =
        appliedPosition > pendingPosition ? appliedPosition : pendingPosition;
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

void McuComponent::stopPolling() { m_polling.store(false, std::memory_order_release); }

void McuComponent::scheduleNextPoll(std::vector<DeferredSchedulerCall>* deferred) {
    // +1ns (não `nowNs()` cru): quando chamado de dentro de `onPollEvent()` sem o Scheduler
    // rodando em background (`isRunning()==false` -- driver síncrono via `step()`/testes), um
    // evento reagendado EXATAMENTE no instante atual é reprocessado na MESMA passada de
    // `runUntil()` (o laço interno consome qualquer evento com `timeNs <= nextTime`, e `m_nowNs`
    // nunca avança processando um evento no MESMO instante) -- livelock genuíno, `m_nowNs` nunca
    // avança, achado do diagnóstico "QEMU manda sinal mas vem como pulso e não retém": mascarado
    // até aqui só porque o reset fantasma do EN/RST (ver `m_resetPinObserved`) fechava a arena
    // antes deste laço rodar. O +1ns é imperceptível pro caso normal (`startPolling()`, chamado
    // fora de `runUntil()`) e garante que `m_nowNs` sempre progride, então o laço termina.
    schedulePollAt(m_scheduler.nowNs() + 1, deferred);
}

void McuComponent::schedulePollAt(uint64_t timeNs, std::vector<DeferredSchedulerCall>* deferred) {
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
        std::lock_guard<std::recursive_mutex> lock(state->mutex);
        McuComponent* self = state->owner;
        if (!self || self->m_pollGeneration != generation) return;
        self->onPollEvent();
    };
    if (deferred) {
        deferred->push_back([&scheduler = m_scheduler, timeNs, callback = std::move(callback)]() mutable {
            scheduler.scheduleAt(timeNs, std::move(callback));
        });
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
    if (arena.pollI2cBurst()) {
        if (m_scheduler.isRunning() && !m_scheduler.isCurrentThreadWorker()) {
            schedulePollAt(m_scheduler.nowNs(), deferred);
            return PollStep::DeferredFuture;
        }
        if (processI2cBurstLocked()) return PollStep::DispatchedReady;
    }
    const qemu::QemuPollResult result = arena.poll();
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

    const bool changed = dispatchArenaEvent(*result.event, eventNs);
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
        result = m_i2cTransferHandler(m_componentIndex, pending->bus, transfer);
    }
    uint32_t status = (result.handled ? 1u : 0u) | (result.addressAck ? 2u : 0u);
    arena.completeI2cBurst(pending->sequence, status, result.firstNack,
                           std::span<const uint8_t>(rx.data(), std::min<uint32_t>(result.rxSize, 32)),
                           result.stretchNs);
    return true;
}

void McuComponent::startBackgroundPollThreadIfNeeded() {
    bool expected = false;
    if (!m_callbackState->pollThreadRunning.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
        return; // já existe uma thread de poll ativa para este MCU -- ela vai pegar o estado atual.
    }
    std::thread(&McuComponent::runBackgroundPollLoop, m_callbackState).detach();
}

void McuComponent::runBackgroundPollLoop(std::shared_ptr<CallbackState> state) {
    // Nunca guarda `McuComponent*` fora do escopo do lock abaixo -- `state` (CallbackState) é a
    // única coisa que esta thread mantém viva sozinha; McuComponent pode ser destruído a qualquer
    // momento entre duas iterações (ver ~McuComponent(), que zera `owner` sob o mesmo mutex antes
    // de qualquer membro ser desalocado).
    bool restartAfterExit = false;
    for (;;) {
        PollStep step = PollStep::NoEvent;
        bool stop = false;
        std::optional<qemu::QemuI2cBurst> backgroundI2c;
        I2cTransferHandler backgroundI2cHandler;
        uint32_t backgroundComponentIndex = 0;
        std::vector<DeferredSchedulerCall> deferred;
        {
            std::lock_guard<std::recursive_mutex> lock(state->mutex);
            McuComponent* self = state->owner;
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
                result = backgroundI2cHandler(backgroundComponentIndex, backgroundI2c->bus, transfer);
            }
            {
                std::lock_guard<std::recursive_mutex> lock(state->mutex);
                McuComponent* self = state->owner;
                if (self && self->m_controller.arenaBridge().isOpen()) {
                    const uint32_t status = (result.handled ? 1u : 0u) |
                                            (result.addressAck ? 2u : 0u);
                    self->m_controller.arenaBridge().completeI2cBurst(
                        backgroundI2c->sequence, status, result.firstNack,
                        std::span<const uint8_t>(rx.data(), std::min<uint32_t>(result.rxSize, 32)),
                        result.stretchNs);
                }
            }
            continue;
        }

        if (stop) break;
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
            std::this_thread::sleep_for(std::chrono::microseconds(50));
            continue;
        }
        if (step == PollStep::DispatchedReady) continue; // agrupa ações do mesmo timestamp.
        std::this_thread::yield();
    }
    state->pollThreadRunning.store(false, std::memory_order_release);
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
        McuComponent* self = state->owner;
        if (self && self->m_polling.load(std::memory_order_acquire) &&
            self->m_scheduler.isRunning() &&
            self->m_controller.arenaBridge().isOpen()) {
            self->startBackgroundPollThreadIfNeeded();
        }
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
        std::lock_guard<std::recursive_mutex> lock(state->mutex);
        McuComponent* self = state->owner;
        if (!self || moduleIndex >= self->m_moduleWakeupGeneration.size()) return;
        if (self->m_moduleWakeupGeneration[moduleIndex] != generation) return;
        self->m_moduleWakeupDueNs[moduleIndex] = QemuModule::kNoWakeup;
        const uint64_t nowNs = self->m_scheduler.nowNs();
        const uint64_t before = self->electricalOutputFingerprint();
        self->m_modules[moduleIndex]->onWakeup(nowNs);
        const bool changed = before != self->electricalOutputFingerprint();
        // Este callback já roda com Scheduler::m_mutex liberado (ver
        // Scheduler::processNextEventUntilLocked: unlock -> callback() -> lock) e na própria
        // thread do Scheduler -- nunca precisa de `deferred` aqui, mesma lógica seguindo direto.
        self->scheduleModuleWakeup(moduleIndex, nowNs, false);
        // Mudança de FIFO/RX ou bit TX repetido não altera o circuito elétrico.
        if (changed) self->m_scheduler.markDirty(self->m_componentIndex);
    };
    if (deferred) {
        // Ver doc-comment de DeferredSchedulerCall no .hpp -- evita inversão de ordem de lock com
        // stamp() quando quem chama é a thread de poll dedicada (segurando m_callbackState->mutex).
        deferred->push_back([&scheduler = m_scheduler, delayNs, callback = std::move(callback)]() mutable {
            scheduler.scheduleEvent(delayNs, std::move(callback));
        });
    } else if (schedulerLockHeld) {
        m_scheduler.scheduleEventUnlocked(delayNs, std::move(callback));
    } else {
        m_scheduler.scheduleEvent(delayNs, std::move(callback));
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
    std::string hex;
    uint8_t byte = 0;
    for (int guard = 0; guard < kUsartMonitorDrainGuard && module->drainMonitorByte(tx, byte); ++guard) {
        hex.push_back(kHexDigits[byte >> 4]);
        hex.push_back(kHexDigits[byte & 0x0Fu]);
    }
    return hex;
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
    // PERF-13 (protocolo v3, ver qemu_arena_abi.h): a arena agora tem uma fila de escritas/
    // heartbeat, não mais um slot único -- mas este caminho (chamado de dentro de stamp(), uma
    // vez por iteração de Newton) continua processando no máximo um evento por chamada de
    // propósito: mantém cada stamp() rápido e deixa o esvaziamento de rajadas maiores pra
    // onPollEvent()/runBackgroundPollLoop() (que já drenam a fila inteira em loop quando o
    // Scheduler está rodando em background, ver PERF-12) -- um laço aqui dentro só duplicaria
    // esse trabalho e prenderia stamp() por mais tempo sem necessidade.
    const qemu::QemuPollResult result = arenaBridge.poll();
    if (!result.hasEvent || !result.event) return false;
    const uint64_t eventNs = qemuEventTimeNs(m_qemuTimeOriginNs.load(std::memory_order_relaxed), result.event->simuTimePs);
    // Uma stamp causada por outra parte do circuito não pode antecipar o relógio virtual do QEMU.
    // A entrada permanece na fila; onPollEvent() já está agendado para consumi-la no instante certo.
    if (eventNs > nowNs && !m_syntheticArenaForTesting) return false;
    return dispatchArenaEvent(*result.event, m_syntheticArenaForTesting ? nowNs : eventNs);
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
            //
            // Pull-up/pull-down INTERNO (ex: IO_MUX FUN_PU/FUN_PD do ESP32, ver
            // `QemuModule::pullState()`): quando o firmware habilita, o pino deixa de ser
            // puramente flutuante -- mesmo princípio elétrico do pull-up dedicado do RST/EN
            // (`stampResetPin()`), só que condicionado ao registrador real em vez de sempre-ligado.
            // Os dois juntos (pull-up E pull-down habilitados ao mesmo tempo, config incomum mas
            // fisicamente válida) simplesmente somam as duas stamps -- resultado real é um divisor
            // de tensão mais forte, não um erro a ser resolvido aqui.
            const QemuModule::PullState pull = module->pullState(mapping.bitOrLine);
            const bool pullUp = pull == QemuModule::PullState::Up || pull == QemuModule::PullState::UpAndDown;
            const bool pullDown = pull == QemuModule::PullState::Down || pull == QemuModule::PullState::UpAndDown;
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
            const double voltage = matrix.getNodeVoltage(m_pins[i]);
            module->setInputVoltageAt(mapping.bitOrLine, voltage, m_scheduler.nowNsUnlocked());
        }
    }
    scheduleWakeupsForAllModules(m_scheduler.nowNsUnlocked(), true);
}

void McuComponent::loadFirmware(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                                 const std::string& qemuBinaryOverride, McuDebugOptions debug) {
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
        loadFirmwareLocked(firmwarePath, arenaName, qemuBinaryOverride, debug, deferred);
    }
    for (DeferredSchedulerCall& call : deferred) call();
}

void McuComponent::loadFirmwareLocked(const std::filesystem::path& firmwarePath, const std::string& arenaName,
                                       const std::string& qemuBinaryOverride, McuDebugOptions debug,
                                       std::vector<DeferredSchedulerCall>& deferred) {
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
    m_nextPendingEventNs.store(0, std::memory_order_relaxed);
    m_qemuTimeOriginNs.store(m_scheduler.nowNs(), std::memory_order_relaxed);
    m_controller.start(firmwarePath, arenaName, qemuBinaryOverride, debug);
    startPolling(&deferred);
    deferred.push_back([&scheduler = m_scheduler, index = m_componentIndex] { scheduler.markDirty(index); });
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
    // Mesma ressalva de loadFirmware(): pode ser chamado de uma thread de teste diferente da do
    // Scheduler enquanto ele já está rodando (ver McuComponentLivePollThreadTest.cpp) -- não pode
    // chamar o Scheduler direto segurando m_callbackState->mutex.
    std::vector<DeferredSchedulerCall> deferred;
    {
        std::lock_guard<std::recursive_mutex> lock(m_callbackState->mutex);
        m_syntheticArenaForTesting = true;
        // Ordem invertida (zera primeiro, seta origem depois) -- ver comentário em loadFirmwareLocked().
        m_latestVirtualTimePs.store(0, std::memory_order_relaxed);
        m_nextPendingEventNs.store(0, std::memory_order_relaxed);
        m_qemuTimeOriginNs.store(m_scheduler.nowNs(), std::memory_order_relaxed);
        m_controller.arenaBridge().open(qemu::QemuArenaOpenOptions{arenaName, true});
        startPolling(&deferred);
    }
    for (DeferredSchedulerCall& call : deferred) call();
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

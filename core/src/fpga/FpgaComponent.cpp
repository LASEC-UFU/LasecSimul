#include "FpgaComponent.hpp"

#include <chrono>
#include <stdexcept>
#include <thread>

namespace lasecsimul::fpga {

namespace {

std::vector<uint32_t> collectInputLocalIndices(const std::vector<FpgaPinBit>& pinBits) {
    std::vector<uint32_t> indices;
    for (uint32_t i = 0; i < pinBits.size(); ++i) {
        if (pinBits[i].isInput) indices.push_back(i);
    }
    return indices;
}

} // namespace

FpgaComponent::FpgaComponent(simulation::Scheduler& scheduler, std::unique_ptr<RtlBackend> backend,
                             FpgaComponentConfig config)
    : m_scheduler(scheduler), m_controller(std::move(backend)), m_pinBits(mapPorts(config.ports)),
      m_vcc(config.vcc), m_advanceTimeout(config.advanceTimeout) {
    m_pins.reserve(m_pinBits.size());
    for (const FpgaPinBit& bit : m_pinBits) m_pins.push_back(Pin{bit.pinId});
    m_inputLocalIndices = collectInputLocalIndices(m_pinBits);
    // 'X' pra saída ainda não reportada pelo GHDL (fica flutuando via toVoltageStamp até a
    // primeira resposta real); 'Zero' pra entrada ainda não amostrada (stamp() sobrescreve antes
    // de qualquer advanceLockstep real usar o valor -- ver comentário de onAssignedIndex/start()).
    m_currentValue.assign(m_pinBits.size(), LogicValue::X);
    m_lastSentToGhdl.assign(m_pinBits.size(), LogicValue::X);
}

FpgaComponent::~FpgaComponent() {
    if (m_controller.isRunning()) m_controller.stop();
}

void FpgaComponent::stamp(MnaMatrixView& matrix) {
    for (size_t i = 0; i < m_pins.size(); ++i) {
        if (m_pinBits[i].isInput) {
            const double voltage = matrix.getNodeVoltage(m_pins[i]);
            m_currentValue[i] = fromVoltage(voltage);
        } else {
            const DriveStamp stamp = toVoltageStamp(m_currentValue[i], m_vcc);
            matrix.addConductanceToGround(m_pins[i], stamp.conductance);
            matrix.addCurrentToGround(m_pins[i], stamp.currentSource);
        }
    }
}

void FpgaComponent::start(const RtlCompileRequest& request) {
    const RtlCompileResult compileResult = m_controller.compile(request);
    if (!compileResult.ok) {
        m_health = PluginHealthStatus::Faulted;
        throw std::runtime_error("FpgaComponent: falha ao compilar VHDL -- " + compileResult.log);
    }
    m_controller.start();
    m_health = PluginHealthStatus::Ok;
    m_forceFullInputResend = true; // plano: "Initial-input correctness" -- amostra tudo incondicionalmente
    if (m_componentIndex != kNoIndex) m_scheduler.markDirty(m_componentIndex); // garante stamp() fresco antes do 1o advance
}

void FpgaComponent::stop() { m_controller.stop(); }

void FpgaComponent::restart(const RtlCompileRequest& request) {
    stop();
    start(request);
}

void FpgaComponent::applyOutputChanges(std::span<const GhdlChangeEntry> changes) {
    for (const GhdlChangeEntry& change : changes) {
        for (size_t i = 0; i < m_pinBits.size(); ++i) {
            if (m_pinBits[i].isInput) continue;
            if (m_pinBits[i].portIndex == change.portIndex && m_pinBits[i].bitIndex == change.bitIndex) {
                m_currentValue[i] = change.value;
                break;
            }
        }
    }
}

void FpgaComponent::advanceLockstep(uint64_t /*previousNs*/, uint64_t nextNs) {
    if (m_health == PluginHealthStatus::Faulted) return;
    if (!m_controller.isRunning()) return; // nunca iniciado, ou já parado deliberadamente -- não é falha

    std::vector<GhdlChangeEntry> changes;
    for (size_t i = 0; i < m_pins.size(); ++i) {
        if (!m_pinBits[i].isInput) continue;
        if (!m_forceFullInputResend && m_currentValue[i] == m_lastSentToGhdl[i]) continue;
        changes.push_back(GhdlChangeEntry{m_pinBits[i].portIndex, m_pinBits[i].bitIndex, m_currentValue[i]});
        m_lastSentToGhdl[i] = m_currentValue[i];
    }
    m_forceFullInputResend = false;

    try {
        m_controller.requestAdvanceTo(nextNs, changes);
    } catch (const std::exception&) {
        m_health = PluginHealthStatus::Faulted;
        return;
    }

    // Bloqueia a thread worker do Scheduler de propósito -- é o design lockstep (plano: "GHDL é
    // comandado, o Core continua sendo a autoridade do tempo"). Nunca sem limite: um GHDL
    // travado/morto (Caso E) não pode travar o Core inteiro pra sempre.
    const auto deadline = std::chrono::steady_clock::now() + m_advanceTimeout;
    GhdlAdvanceReply reply;
    for (;;) {
        reply = m_controller.pollReply();
        if (reply.ready) break;
        if (!m_controller.isRunning()) {
            m_health = PluginHealthStatus::Faulted;
            return;
        }
        if (std::chrono::steady_clock::now() > deadline) {
            m_health = PluginHealthStatus::Faulted;
            m_controller.stop(); // isola o travamento -- nunca deixa o processo pendurado pra sempre
            return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    if (reply.overflow) {
        m_health = PluginHealthStatus::Faulted;
        return;
    }

    applyOutputChanges(reply.outputChanges);
    // Achado real: `advanceLockstep` roda de DENTRO de `TimeStepCommitFn`, um callback do
    // Scheduler já invocado com `m_mutex` retido pela MESMA thread -- `markDirty()`'s `try_lock`
    // falha nesse caso (mutex não-recursivo) e cai no caminho `m_pendingDirty`, que só é mesclado
    // de dentro do PRÓPRIO loop de settle do Scheduler (`mergePendingDirtyLocked`), nunca por uma
    // chamada solta e posterior a `SimulationSession::settleStep()`. `dirtySet()` é documentado
    // (Scheduler.hpp) como seguro de chamar "de dentro do callback de settle" -- exatamente esta
    // situação, mesmo padrão que `TimeStepBeginFn` já usa (`m_scheduler.dirtySet().insert(i)`)
    // pra componentes reativos.
    if (m_componentIndex != kNoIndex) m_scheduler.dirtySet().insert(m_componentIndex);
}

} // namespace lasecsimul::fpga

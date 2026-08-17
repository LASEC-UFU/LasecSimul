// Passo 2 do plano FPGA/VHDL (golden-puzzling-quasar.md): GhdlArenaBridge sintético, sem GHDL
// real -- simula o "lado GHDL" escrevendo direto nos campos do transport (mesma técnica de
// QemuArenaBridgeTest.cpp), usando as MESMAS funções de aritmética de ponteiro
// (lsdnFpgaArenaInputChanges/lsdnFpgaArenaOutputChanges) que o módulo VPI real vai usar --
// prova o layout de fio, não só a API C++.
#include "fpga/GhdlArenaBridge.hpp"
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

using namespace lasecsimul;
using namespace lasecsimul::fpga;

namespace {

std::string uniqueArenaName() {
    return "lasecsimul-fpga-arena-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

/** Simula o lado GHDL respondendo a uma rodada ADVANCE_TO: publica N mudanças de saída e iguala
 * replySeq a commandSeq (o que `pollReply()` observa como "pronto"). */
void simulateGhdlReply(LsdnFpgaArenaTransport& transport, uint32_t inputCapacity, uint64_t reachedTimeNs,
                       const std::vector<LsdnFpgaChangeEntry>& outputs, bool overflow) {
    LsdnFpgaChangeEntry* outEntries = lsdnFpgaArenaOutputChanges(&transport, inputCapacity);
    for (size_t i = 0; i < outputs.size(); ++i) outEntries[i] = outputs[i];
    transport.outputChangeCount = outputs.size();
    transport.outputOverflow = overflow ? 1 : 0;
    transport.reachedTimeNs = reachedTimeNs;
    std::atomic_ref<uint64_t>(transport.state).store(LSDN_FPGA_STATE_RUNNING, std::memory_order_relaxed);
    std::atomic_ref<uint64_t>(transport.replySeq)
        .store(transport.commandSeq, std::memory_order_release);
}

void testOpenCreatesValidDescriptor() {
    GhdlArenaBridge bridge;
    bridge.open(GhdlArenaOpenOptions{uniqueArenaName(), true, 8, 16});
    assert(bridge.isOpen());
    assert(bridge.descriptor() != nullptr);
    assert(bridge.descriptor()->magic == LSDN_FPGA_ARENA_ABI_MAGIC);
    assert(bridge.descriptor()->abiMajor == LSDN_FPGA_ARENA_ABI_MAJOR);
    assert(bridge.descriptor()->descriptorSize == sizeof(LsdnFpgaArenaDescriptor));
    assert(bridge.descriptor()->transportSize == sizeof(LsdnFpgaArenaTransport));
    assert(bridge.descriptor()->inputChangeCapacity == 8);
    assert(bridge.descriptor()->outputChangeCapacity == 16);
    assert(bridge.descriptor()->coreCapabilities == LSDN_FPGA_ARENA_CAPABILITIES);
    assert(bridge.descriptor()->coreReady == 1);
    assert(bridge.inputChangeCapacity() == 8);
    assert(bridge.outputChangeCapacity() == 16);
    assert(!bridge.peerReady());
    assert(bridge.state() == LSDN_FPGA_STATE_NOT_STARTED);
    std::printf("OK: open() cria descriptor v1 valido com capacidades assimetricas\n");
}

void testAttachDiscoversCapacitiesFromExistingArena() {
    const std::string name = uniqueArenaName();
    GhdlArenaBridge owner;
    owner.open(GhdlArenaOpenOptions{name, true, 12, 40});

    GhdlArenaBridge attacher;
    attacher.open(GhdlArenaOpenOptions{name, false, 0, 0});
    assert(attacher.inputChangeCapacity() == 12);
    assert(attacher.outputChangeCapacity() == 40);
    assert(attacher.descriptor()->magic == LSDN_FPGA_ARENA_ABI_MAGIC);

    // prova que os dois lados enxergam a MESMA memória: owner escreve, attacher lê.
    owner.transport()->reachedTimeNs = 999;
    assert(attacher.transport()->reachedTimeNs == 999);
    std::printf("OK: attach descobre capacidades reais da arena (duas fases no Windows, fstat no POSIX)\n");
}

void testRequestAdvanceToPublishesInputsAndCommand() {
    GhdlArenaBridge bridge;
    bridge.open(GhdlArenaOpenOptions{uniqueArenaName(), true, 4, 4});

    const std::vector<GhdlChangeEntry> inputs = {
        GhdlChangeEntry{0, 0, LogicValue::One},
        GhdlChangeEntry{1, 2, LogicValue::Zero},
    };
    bridge.requestAdvanceTo(500, inputs);

    assert(bridge.transport()->commandSeq == 1);
    assert(bridge.transport()->command == LSDN_FPGA_CMD_ADVANCE_TO);
    assert(bridge.transport()->requestedTimeNs == 500);
    assert(bridge.transport()->inputChangeCount == 2);

    const LsdnFpgaChangeEntry* raw = lsdnFpgaArenaInputChanges(bridge.transport());
    assert(raw[0].portIndex == 0 && raw[0].bitIndex == 0 && raw[0].value == static_cast<uint8_t>(LogicValue::One));
    assert(raw[1].portIndex == 1 && raw[1].bitIndex == 2 && raw[1].value == static_cast<uint8_t>(LogicValue::Zero));
    std::printf("OK: requestAdvanceTo publica comando+entradas no layout de fio real\n");
}

void testRequestAdvanceToThrowsWhenInputsExceedCapacity() {
    GhdlArenaBridge bridge;
    bridge.open(GhdlArenaOpenOptions{uniqueArenaName(), true, 1, 1});
    const std::vector<GhdlChangeEntry> tooMany = {
        GhdlChangeEntry{0, 0, LogicValue::One}, GhdlChangeEntry{0, 1, LogicValue::Zero}};
    bool threw = false;
    try {
        bridge.requestAdvanceTo(10, tooMany);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    assert(threw);
    std::printf("OK: excesso de mudancas de entrada lanca (erro de chamada, nao truncamento silencioso)\n");
}

void testPollReplyNotReadyUntilReplySeqMatches() {
    GhdlArenaBridge bridge;
    bridge.open(GhdlArenaOpenOptions{uniqueArenaName(), true, 2, 2});
    bridge.requestAdvanceTo(100, {});

    const GhdlAdvanceReply pending = bridge.pollReply();
    assert(!pending.ready);
    assert(pending.outputChanges.empty());
    std::printf("OK: pollReply() nunca bloqueia -- reporta nao-pronto sem esperar\n");
}

void testPollReplyReturnsOutputChangesOnceReady() {
    GhdlArenaBridge bridge;
    bridge.open(GhdlArenaOpenOptions{uniqueArenaName(), true, 2, 4});
    bridge.requestAdvanceTo(1000, {});

    simulateGhdlReply(*bridge.transport(), bridge.inputChangeCapacity(), 1000,
                      {LsdnFpgaChangeEntry{2, 0, static_cast<uint8_t>(LogicValue::One), {0, 0, 0}},
                       LsdnFpgaChangeEntry{2, 1, static_cast<uint8_t>(LogicValue::Zero), {0, 0, 0}}},
                      false);

    const GhdlAdvanceReply reply = bridge.pollReply();
    assert(reply.ready);
    assert(!reply.overflow);
    assert(reply.reachedTimeNs == 1000);
    assert(reply.state == LSDN_FPGA_STATE_RUNNING);
    assert(reply.outputChanges.size() == 2);
    assert(reply.outputChanges[0].portIndex == 2 && reply.outputChanges[0].bitIndex == 0 &&
          reply.outputChanges[0].value == LogicValue::One);
    assert(reply.outputChanges[1].bitIndex == 1 && reply.outputChanges[1].value == LogicValue::Zero);
    std::printf("OK: pollReply() entrega o batch de OUTPUT_CHANGE quando replySeq alcanca commandSeq\n");
}

void testOverflowNeverReturnsPartialData() {
    GhdlArenaBridge bridge;
    bridge.open(GhdlArenaOpenOptions{uniqueArenaName(), true, 1, 2});
    bridge.requestAdvanceTo(50, {});

    // Simula GHDL detectando que teria mais mudancas do que a capacidade permite -- seta
    // outputOverflow e NAO preenche outputChangeCount com dado parcial (contrato do protocolo:
    // ver fpga_arena_abi.h, "nunca aceitar dados truncados em silencio").
    bridge.transport()->outputChangeCount = 0;
    bridge.transport()->outputOverflow = 1;
    bridge.transport()->reachedTimeNs = 50;
    std::atomic_ref<uint64_t>(bridge.transport()->state).store(LSDN_FPGA_STATE_RUNNING, std::memory_order_relaxed);
    std::atomic_ref<uint64_t>(bridge.transport()->replySeq)
        .store(bridge.transport()->commandSeq, std::memory_order_release);

    const GhdlAdvanceReply reply = bridge.pollReply();
    assert(reply.ready);
    assert(reply.overflow);
    assert(reply.outputChanges.empty());
    std::printf("OK: overflow reportado explicitamente, nunca como mudancas parciais silenciosas\n");
}

void testInvalidCountWithoutOverflowFlagIsStillRejected() {
    GhdlArenaBridge bridge;
    bridge.open(GhdlArenaOpenOptions{uniqueArenaName(), true, 1, 2});
    bridge.requestAdvanceTo(50, {});
    bridge.transport()->outputChangeCount = 3; // peer corrompido: maior que a capacidade 2
    bridge.transport()->outputOverflow = 0;
    std::atomic_ref<uint64_t>(bridge.transport()->replySeq)
        .store(bridge.transport()->commandSeq, std::memory_order_release);
    const GhdlAdvanceReply reply = bridge.pollReply();
    assert(reply.ready && reply.overflow && reply.outputChanges.empty());
    std::printf("OK: contagem fora da capacidade e rejeitada mesmo sem flag do peer\n");
}

void testExcessiveArenaCapacityIsRejected() {
    GhdlArenaBridge bridge;
    bool threw = false;
    try {
        bridge.open(GhdlArenaOpenOptions{uniqueArenaName(), true, (1u << 20) + 1, 1});
    } catch (const std::runtime_error&) {
        threw = true;
    }
    assert(threw);
    std::printf("OK: capacidade excessiva e rejeitada antes de calcular/mapear a arena\n");
}

void testResetAndStopPublishDistinctCommands() {
    GhdlArenaBridge bridge;
    bridge.open(GhdlArenaOpenOptions{uniqueArenaName(), true, 1, 1});

    bridge.requestReset();
    assert(bridge.transport()->command == LSDN_FPGA_CMD_RESET);
    assert(bridge.transport()->commandSeq == 1);

    bridge.requestStop();
    assert(bridge.transport()->command == LSDN_FPGA_CMD_STOP);
    assert(bridge.transport()->commandSeq == 2);
    std::printf("OK: RESET e STOP publicam comandos distintos, cada um avancando commandSeq\n");
}

void testLogQueueDrainsInOrder() {
    GhdlArenaBridge bridge;
    bridge.open(GhdlArenaOpenOptions{uniqueArenaName(), true, 1, 1});
    LsdnFpgaArenaTransport* transport = bridge.transport();

    auto pushLog = [&](LsdnFpgaLogSeverity severity, uint64_t timeNs, const char* text) {
        const uint64_t slot = transport->logWriteIndex % LSDN_FPGA_ARENA_LOG_QUEUE_DEPTH;
        transport->logQueue[slot].severity = severity;
        transport->logQueue[slot].timeNs = timeNs;
        std::snprintf(transport->logQueue[slot].message, LSDN_FPGA_ARENA_LOG_MESSAGE_MAX, "%s", text);
        transport->logWriteIndex++;
    };

    pushLog(LSDN_FPGA_LOG_INFO, 10, "analyze ok");
    pushLog(LSDN_FPGA_LOG_ASSERT_FAILURE, 20, "assertion violated at t=20ns");

    const std::optional<GhdlLogMessage> first = bridge.pollLog();
    assert(first.has_value());
    assert(first->severity == LSDN_FPGA_LOG_INFO);
    assert(first->timeNs == 10);
    assert(first->message == "analyze ok");
    bridge.acknowledgeLog();

    const std::optional<GhdlLogMessage> second = bridge.pollLog();
    assert(second.has_value());
    assert(second->severity == LSDN_FPGA_LOG_ASSERT_FAILURE);
    assert(second->message == "assertion violated at t=20ns");
    bridge.acknowledgeLog();

    assert(!bridge.pollLog().has_value());
    std::printf("OK: fila de log/assert/erro drena em ordem, separada do batch de OUTPUT_CHANGE\n");
}

} // namespace

int main() {
    testOpenCreatesValidDescriptor();
    testAttachDiscoversCapacitiesFromExistingArena();
    testRequestAdvanceToPublishesInputsAndCommand();
    testRequestAdvanceToThrowsWhenInputsExceedCapacity();
    testPollReplyNotReadyUntilReplySeqMatches();
    testPollReplyReturnsOutputChangesOnceReady();
    testOverflowNeverReturnsPartialData();
    testInvalidCountWithoutOverflowFlagIsStillRejected();
    testExcessiveArenaCapacityIsRejected();
    testResetAndStopPublishDistinctCommands();
    testLogQueueDrainsInOrder();
    std::printf("\nTodos os testes passaram.\n");
    return 0;
}

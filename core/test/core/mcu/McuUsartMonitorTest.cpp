// Prova o monitor de UART fora da banda (mcu_abi.h minor 6, `QemuModule::drainMonitorByte`) que
// alimenta "Abrir monitor serial UARTx" (extension/src/mcu/mcuCommands.ts::openSerialMonitor) SEM
// exigir fio nenhum -- diferente de McuUartToLasecPlotTest.cpp (que decodifica eletricamente via um
// peripherals.lasecplot cabeado no pino Tx), este lê direto a propriedade
// `uart{N}_tx_monitor_hex` que McuComponent::propertyDescriptors() expõe, drenando o buffer de
// monitor que o próprio módulo USART do adaptador mantém internamente (Esp32Adapter.cpp::
// UsartState::txMonitor, tocado quando um frame completa em usartAdvanceTx -- ver doc-comment lá).
// Não precisa de IOMUX/GPIO nenhum roteado (a diferença chave: o monitor tapeia o FRAME antes de
// chegar no pino, então funciona mesmo sem nenhuma fiação elétrica) -- só escreve no FIFO TX via
// arena sintética (mesma técnica de McuComponentTest.cpp) e lê a propriedade de volta.
//
// Também cobre o lado ESCRITA (mcu_abi.h minor 7, `QemuModule::injectRxBytes`, achado 2026-07-22
// ao completar o Monitor Serial): `uart{N}_rx_inject_hex` (setProperty) injeta bytes direto no RX
// real da USART, sem simular fio nenhum -- verificado indiretamente via `uart{N}_rx_monitor_hex`
// (McuComponent::injectUsartRxHex empurra pro MESMO laço que popula `rxFifo` E `rxMonitor`, ver
// Esp32Adapter.cpp::usartInjectRxBytes, então confirmar o monitor já confirma o FIFO real também).
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <variant>
#include "lasecsimul/qemu_arena_abi.h"
#include "mcu/McuComponent.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;

namespace {

int failures = 0;

void check(bool ok, const char* label) {
    if (ok) std::printf("OK: %s\n", label);
    else {
        std::fprintf(stderr, "FALHOU: %s\n", label);
        failures++;
    }
}

void simulateQemuWrite(LsdnQemuArena* arena, uint64_t addr, uint64_t value) {
    const uint64_t slot = arena->queueWriteIndex % LSDN_QEMU_ARENA_QUEUE_DEPTH;
    arena->queue[slot].regAddr = addr;
    arena->queue[slot].regData = value;
    arena->queue[slot].simuAction = LSDN_SIM_WRITE;
    arena->queue[slot].simuTime = 1;
    arena->queueWriteIndex++;
}

std::string uniqueArenaName() {
    return "lasecsimul-mcu-usart-monitor-test-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

// Envia UM byte pelo TX FIFO da UART `index` e avança tempo/settle o suficiente pro frame inteiro
// (10 bits a 115200 baud = ~86.8us) completar -- mesma folga de McuUartToLasecPlotTest.cpp.
void sendByteAndSettle(SimulationSession& session, uint32_t mcuIndex, LsdnQemuArena* arena,
                        uint64_t uartStart, uint8_t byte) {
    simulateQemuWrite(arena, uartStart + 0x00, byte);
    session.scheduler().markDirty(mcuIndex);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}
    session.scheduler().step(120'000);
    for (int i = 0; i < 20 && session.settleStep(); ++i) {}
}

} // namespace

int main() {
#ifndef ESP32_ADAPTER_DLL_PATH
#error "ESP32_ADAPTER_DLL_PATH precisa ser definido pelo CMakeLists (caminho do adapter.dll real)"
#endif
    const std::filesystem::path dllPath = ESP32_ADAPTER_DLL_PATH;
    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr,
                      "PULADO: %s não existe -- rode 'npm run build:mcu-adapters' antes deste teste.\n",
                      dllPath.string().c_str());
        return 0;
    }

    plugins::GlobalPluginCache cache;
    std::shared_ptr<plugins::PluginModule> mcuModule = cache.loader().loadMcuPlugin(dllPath);
    cache.setActiveMcuModule("espressif.esp32", mcuModule);

    SimulationSession session(cache);
    session.registerKnownMcuTypes();

    plugins::PluginRuntime runtime(cache);
    const std::unique_ptr<IMcuAdapter> probeAdapter = runtime.createMcuAdapter("espressif.esp32");
    uint64_t uart0Start = 0;
    uint64_t uart1Start = 0;
    for (const MemoryRegion& region : probeAdapter->memoryRegions()) {
        if (region.moduleKind == ModuleKind::Usart && region.moduleIndex == 0) uart0Start = region.start;
        else if (region.moduleKind == ModuleKind::Usart && region.moduleIndex == 1) uart1Start = region.start;
    }
    check(uart0Start != 0, "memoryRegions() do plugin declara uma faixa UART0");
    check(uart1Start != 0, "memoryRegions() do plugin declara uma faixa UART1");

    mcu::McuComponent* mcuPtr = nullptr;
    session.components().registerFactory("mcu.esp32", [&mcuPtr, &session](const registry::ComponentParams&) {
        auto instance = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
        mcuPtr = instance.get();
        return instance;
    });
    const uint32_t mcuIndex = session.addComponent("mcu.esp32", {});
    mcuPtr->openSyntheticArenaForTesting(uniqueArenaName());
    LsdnQemuArena* arena = mcuPtr->arenaBridge().arena();

    // Sem fio/IOMUX nenhum roteado de propósito -- o monitor tapeia o frame ANTES do nível chegar
    // no pino (diferente do que peripherals.lasecplot precisa pra decodificar eletricamente), então
    // não deveria importar se o pino está flutuando.
    const auto txHex0 = session.propertyValueOf(mcuIndex, "uart0_tx_monitor_hex");
    check(txHex0.has_value() && std::holds_alternative<std::string>(*txHex0) && std::get<std::string>(*txHex0).empty(),
          "uart0_tx_monitor_hex começa vazio (nenhum byte transmitido ainda)");

    sendByteAndSettle(session, mcuIndex, arena, uart0Start, 0x41); // 'A'
    sendByteAndSettle(session, mcuIndex, arena, uart0Start, 0x42); // 'B'
    const auto drained = session.propertyValueOf(mcuIndex, "uart0_tx_monitor_hex");
    check(drained.has_value() && std::holds_alternative<std::string>(*drained), "uart0_tx_monitor_hex devolve string");
    const std::string drainedHex = drained.has_value() && std::holds_alternative<std::string>(*drained) ? std::get<std::string>(*drained) : "";
    check(drainedHex == "4142", ("uart0_tx_monitor_hex drena os 2 bytes transmitidos em ordem, sem fio nenhum -- recebido: '" + drainedHex + "'").c_str());

    const auto drainedAgain = session.propertyValueOf(mcuIndex, "uart0_tx_monitor_hex");
    check(drainedAgain.has_value() && std::holds_alternative<std::string>(*drainedAgain) && std::get<std::string>(*drainedAgain).empty(),
          "uart0_tx_monitor_hex esvazia após o dreno (leitura é atômica, não repete bytes já lidos)");

    const auto uart1TxHex = session.propertyValueOf(mcuIndex, "uart1_tx_monitor_hex");
    check(uart1TxHex.has_value() && std::holds_alternative<std::string>(*uart1TxHex) && std::get<std::string>(*uart1TxHex).empty(),
          "uart1_tx_monitor_hex continua vazia -- byte enviado pela UART0 não vaza pra outro índice");

    const auto unknownProperty = session.propertyValueOf(mcuIndex, "uart9_tx_monitor_hex");
    check(!unknownProperty.has_value(), "uart9_tx_monitor_hex (índice inexistente) devolve nullopt, não uma string vazia");

    // --- lado escrita: uart0_rx_inject_hex injeta bytes que aparecem em uart0_rx_monitor_hex ---
    const auto rxHex0 = session.propertyValueOf(mcuIndex, "uart0_rx_monitor_hex");
    check(rxHex0.has_value() && std::holds_alternative<std::string>(*rxHex0) && std::get<std::string>(*rxHex0).empty(),
          "uart0_rx_monitor_hex começa vazio (nada injetado ainda)");

    session.setProperty(mcuIndex, "uart0_rx_inject_hex", PropertyValue{std::string("deadbeef")});
    const auto injected = session.propertyValueOf(mcuIndex, "uart0_rx_monitor_hex");
    const std::string injectedHex = injected.has_value() && std::holds_alternative<std::string>(*injected) ? std::get<std::string>(*injected) : "";
    check(injectedHex == "deadbeef", ("uart0_rx_inject_hex injetado aparece em uart0_rx_monitor_hex -- recebido: '" + injectedHex + "'").c_str());

    const auto injectedAgain = session.propertyValueOf(mcuIndex, "uart0_rx_monitor_hex");
    check(injectedAgain.has_value() && std::holds_alternative<std::string>(*injectedAgain) && std::get<std::string>(*injectedAgain).empty(),
          "uart0_rx_monitor_hex esvazia após o dreno (mesma semântica atômica do lado TX)");

    // UART1 não é afetado por uma injeção na UART0 (sem mistura de índice, mesma checagem já feita
    // do lado TX acima).
    session.setProperty(mcuIndex, "uart1_rx_inject_hex", PropertyValue{std::string("ff")});
    const auto uart0RxAfterUart1Inject = session.propertyValueOf(mcuIndex, "uart0_rx_monitor_hex");
    check(uart0RxAfterUart1Inject.has_value() && std::holds_alternative<std::string>(*uart0RxAfterUart1Inject) &&
              std::get<std::string>(*uart0RxAfterUart1Inject).empty(),
          "injetar na UART1 não vaza pro uart0_rx_monitor_hex");
    const auto uart1RxAfterInject = session.propertyValueOf(mcuIndex, "uart1_rx_monitor_hex");
    const std::string uart1RxHex = uart1RxAfterInject.has_value() && std::holds_alternative<std::string>(*uart1RxAfterInject)
        ? std::get<std::string>(*uart1RxAfterInject) : "";
    check(uart1RxHex == "ff", "uart1_rx_inject_hex injeta corretamente no índice certo");

    // Hex de tamanho ímpar: injeta só os pares completos, sem crashar (mesma tolerância de
    // uart_enqueue_hex em devices/simulide-peripherals/src/lib.c).
    session.setProperty(mcuIndex, "uart0_rx_inject_hex", PropertyValue{std::string("abc")});
    const auto oddHexResult = session.propertyValueOf(mcuIndex, "uart0_rx_monitor_hex");
    const std::string oddHex = oddHexResult.has_value() && std::holds_alternative<std::string>(*oddHexResult)
        ? std::get<std::string>(*oddHexResult) : "";
    check(oddHex == "ab", ("hex de tamanho ímpar injeta só os pares completos, sem crashar -- recebido: '" + oddHex + "'").c_str());

    if (failures == 0) {
        std::printf("\nTodos os testes de McuUsartMonitor passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}

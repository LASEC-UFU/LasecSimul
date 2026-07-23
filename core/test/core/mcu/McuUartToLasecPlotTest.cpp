// Achado ao vivo 2026-07-22: usuário reporta dados chegando embaralhados no LasecPlot, SEMPRE com
// o MESMO padrão de lixo pro mesmo dado (determinístico, não varia entre tentativas) -- e confirma
// que isto já acontecia ANTES do PERF-12 (thread de poll dedicada), afastando qualquer explicação
// de precisão de tempo virtual/concorrência. Um bug determinístico só pode estar na CODIFICAÇÃO em
// si: ordem de bits (LSB vs MSB), polaridade do start/stop bit, ou temporização sistematicamente
// errada de amostragem -- não em quando/qual thread desperta.
//
// Nenhum teste existente prova isto ponta-a-ponta com os componentes REAIS do usuário: os testes
// de UART já existentes usam OU dois periféricos genéricos (scripts/test-uart-devices.js:
// peripherals.serialterm <-> peripherals.lasecplot, via writeUart() direto -- não passa pelo
// bit-banging elétrico de TX do MCU) OU o McuComponent sozinho sem nenhum decodificador real do
// outro lado (McuComponentTest.cpp -- só confirma nível de tensão em instantes fixos, não que um
// receptor de verdade decodifica o byte certo).
//
// Este teste fecha essa lacuna: MCU ESP32 real (plugin, sem QEMU/firmware -- arena sintética, mesma
// técnica de McuComponentTest.cpp) com UART0 TX (GPIO1) fiado no RX de um peripherals.lasecplot
// REAL (mesmo .lsdevice do usuário), tudo em modo SÍNCRONO (sem Scheduler::start(), sem PERF-12
// envolvido -- elimina essa variável de vez, dado que o usuário já confirmou que o bug independe
// dela). Escreve um byte no FIFO do UART0 (simulando o que o firmware faria) e confirma que
// peripherals.lasecplot decodifica o byte EXATO via tryDrainUartRx() -- a mesma leitura que
// LasecPlotBroker::poll() usa em produção.
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
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

// Mesmo helper de McuComponentTest.cpp -- simula o que writeReg(addr,value) do lado QEMU real
// faria: publica uma entrada na fila de escritas/heartbeat (protocolo v3).
void simulateQemuWrite(LsdnQemuArena* arena, uint64_t addr, uint64_t value) {
    const uint64_t slot = arena->queueWriteIndex % LSDN_QEMU_ARENA_QUEUE_DEPTH;
    arena->queue[slot].regAddr = addr;
    arena->queue[slot].regData = value;
    arena->queue[slot].simuAction = LSDN_SIM_WRITE;
    arena->queue[slot].simuTime = 1;
    arena->queueWriteIndex++;
}

std::string uniqueArenaName() {
    return "lasecsimul-mcu-uart-lasecplot-test-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
#ifndef REAL_DEVICES_LIBRARY_JSON_PATH
#error "REAL_DEVICES_LIBRARY_JSON_PATH precisa ser definido pelo CMakeLists (caminho de devices/library.json)"
#endif
    const std::filesystem::path devicesLibraryPath = REAL_DEVICES_LIBRARY_JSON_PATH;
    if (!std::filesystem::exists(devicesLibraryPath)) {
        std::fprintf(stderr, "PULADO: %s não existe.\n", devicesLibraryPath.string().c_str());
        return 0;
    }

    plugins::GlobalPluginCache cache;
    std::shared_ptr<plugins::PluginModule> mcuModule = cache.loader().loadMcuPlugin(dllPath);
    cache.setActiveMcuModule("espressif.esp32", mcuModule);
    cache.loadLibrary(devicesLibraryPath);

    SimulationSession session(cache);
    session.registerKnownMcuTypes();
    session.registerKnownPluginTypes();

    plugins::PluginRuntime runtime(cache);
    const std::unique_ptr<IMcuAdapter> probeAdapter = runtime.createMcuAdapter("espressif.esp32");
    uint64_t ioMuxStart = 0;
    uint64_t uart0Start = 0;
    for (const MemoryRegion& region : probeAdapter->memoryRegions()) {
        if (region.moduleKind == ModuleKind::IoMux && region.moduleIndex == 0) ioMuxStart = region.start;
        else if (region.moduleKind == ModuleKind::Usart && region.moduleIndex == 0) uart0Start = region.start;
    }
    check(ioMuxStart != 0, "memoryRegions() do plugin declara uma faixa IOMUX");
    check(uart0Start != 0, "memoryRegions() do plugin declara uma faixa UART0");

    mcu::McuComponent* mcuPtr = nullptr;
    session.components().registerFactory("mcu.esp32", [&mcuPtr, &session](const registry::ComponentParams&) {
        auto instance = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
        mcuPtr = instance.get();
        return instance;
    });
    const uint32_t mcuIndex = session.addComponent("mcu.esp32", {});
    mcuPtr->openSyntheticArenaForTesting(uniqueArenaName());
    LsdnQemuArena* arena = mcuPtr->arenaBridge().arena();

    // `pinList` precisa vir preenchido -- sem ele `meta.pins`/`declaredPins` ficam vazios e
    // `Netlist::registerComponent` registra o componente com ZERO pinos (ver
    // `SimulationSession::registerKnownPluginTypes`, linha `meta.pins = params.pinList`). É o mesmo
    // `pins` que a Extension sempre envia via IPC (`CoreClient.addComponent`) e que
    // `broker.realCore.test.ts` já passa explicitamente.
    registry::ComponentParams plotParams;
    plotParams.pinList = {{"tx", 0.0, 8.0}, {"rx", 0.0, 24.0}};
    const uint32_t plotIndex = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plotIndex, "data_bits", PropertyValue{8.0});
    session.setProperty(plotIndex, "stop_bits", PropertyValue{1.0});
    session.setProperty(plotIndex, "parity", PropertyValue{std::string("none")});
    session.connectWire(mcuIndex, "GPIO1", plotIndex, "rx");

    // Habilita GPIO1 como U0TXD (função IOMUX 0) -- mesma sequência de McuComponentTest.cpp.
    simulateQemuWrite(arena, ioMuxStart + 0x88, 0);
    session.scheduler().markDirty(mcuIndex);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}

    // Achado 2026-07-22 (usuário reporta perda de dados especificamente em 921600 baud, 115200
    // funcionando): antes só 115200 era exercitado aqui. `usartWriteClkDiv`/`ser_bit_period_ns`
    // (Esp32Adapter.cpp/lib.c) escalam o período de bit a partir do baud configurado -- este teste
    // agora prova a decodificação elétrica ponta-a-ponta nos DOIS baud rates que o usuário precisa,
    // não só no que já funcionava.
    auto runBaudRateCase = [&](double baudRate) {
        session.setProperty(plotIndex, "baudrate", PropertyValue{baudRate});
        // Configura o UART_CLKDIV_REG (offset 0x14) do UART0 do MCU pro MESMO baud rate --
        // `usartWriteClkDiv` (Esp32Adapter.cpp) aceita o bit-time em ns já convertido direto (sem o
        // marcador `kRawClkDivMarker`), o mesmo caminho que a produção real (qemu_simulide) usa.
        // Sem isto, o TX do MCU continua no bit-time padrão (115200) enquanto o receptor já espera
        // o baud novo -- causa decodificação embaralhada e determinística, não um bug do produto.
        simulateQemuWrite(arena, uart0Start + 0x14, static_cast<uint64_t>(1'000'000'000.0 / baudRate));
        session.scheduler().markDirty(mcuIndex);
        for (int i = 0; i < 5 && session.settleStep(); ++i) {}

        // Testa vários bytes -- 0x55/0xAA cobrem os dois padrões alternados de bit (maximiza chance
        // de flagrar um bug de ordem de bits, que um valor só como 0x00 ou 0xFF nunca revelaria),
        // 0x41 é um caractere ASCII normal (o tipo de dado real que passaria por telemetria de
        // texto).
        const std::vector<uint8_t> bytesToSend = {0x55, 0xAA, 0x41, 0x00, 0xFF};
        for (const uint8_t byteToSend : bytesToSend) {
            simulateQemuWrite(arena, uart0Start + 0x00, byteToSend);
            session.scheduler().markDirty(mcuIndex);
            for (int i = 0; i < 5 && session.settleStep(); ++i) {}

            // 10 bits (start+8+stop) no baud configurado; avança tempo virtual síncrono o
            // suficiente pra cobrir o frame inteiro, com ~38% de folga (mesma margem que o valor
            // original hardcoded pra 115200 já usava: 120000ns / 86805ns ~= 1.38).
            const auto frameNs = static_cast<uint64_t>(10.0 * 1'000'000'000.0 / baudRate);
            session.scheduler().step(frameNs * 138 / 100);
            for (int i = 0; i < 20 && session.settleStep(); ++i) {}

            std::string receivedHex;
            // tryDrainUartRx() pode devolver nullopt (settle em andamento) -- mesma disciplina de
            // retry usada por LasecPlotBroker::poll() em produção.
            for (int attempt = 0; attempt < 20 && receivedHex.empty(); ++attempt) {
                if (const auto snapshot = session.tryDrainUartRx(plotIndex)) receivedHex = snapshot->dataHex;
                else std::this_thread::sleep_for(std::chrono::milliseconds(2));
            }

            char expectedHex[3];
            std::snprintf(expectedHex, sizeof(expectedHex), "%02x", static_cast<unsigned>(byteToSend));
            const std::string label = "peripherals.lasecplot (dispositivo real) decodifica 0x" + std::string(expectedHex) +
                " a " + std::to_string(static_cast<long>(baudRate)) + " baud, vindo de MCU ESP32 real (UART0 TX) -- recebido: '" +
                receivedHex + "'";
            check(receivedHex == expectedHex, label.c_str());
        }
    };

    runBaudRateCase(115200.0);
    runBaudRateCase(921600.0);

    if (failures == 0) {
        std::printf("\nTodos os testes de McuUartToLasecPlot passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}

// SPI de hardware lendo o circuito (MISO) com firmware ESP32 real. Um registrador de deslocamento de
// 8 bits (logic.shift_reg) fica no VSPI: GPIO23 (MOSI) -> data, GPIO18 (SCK) -> clk, q7 -> GPIO19
// (MISO), GPIO4 -> rst. Cada bit sai 8 clocks depois de entrar, e o mestre amostra o MISO na borda de
// subida, antes do registrador deslocar: SPI.transfer(b) devolve o byte anterior. Antes o MISO nunca
// era lido -- o adaptador guardava o nivel e o QEMU deixava no W0 o proprio byte enviado.
//
// Firmware (LASECSIMUL_TEST_SPI_MISO_FIRMWARE, merged.bin de vnext_prototype/guest_spi_miso): por
// rodada, 32 bytes um por transacao (MSB primeiro), 48 bytes numa transacao so' (W0..W15) e 16 bytes
// LSB primeiro; confere cada byte recebido e imprime "SPIMISO round=... ok=... bad=...".
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include "mcu/McuComponent.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;

namespace {

std::string hexToText(const std::string& hex) {
    std::string out;
    for (size_t i = 0; i + 1 < hex.size(); i += 2)
        out.push_back(static_cast<char>(std::stoul(hex.substr(i, 2), nullptr, 16)));
    return out;
}

void setEnv(const char* name, const char* value) {
#ifdef _WIN32
    _putenv_s(name, value);
#else
    if (value && *value) setenv(name, value, 1);
    else unsetenv(name);
#endif
}

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_SPI_MISO_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_SPI_MISO_FIRMWARE (firmware do SPI com MISO).\n");
        return 0;
    }
    const std::filesystem::path firmware = std::filesystem::u8path(firmwareEnv);
    const char* qemuOverride = std::getenv("LASECSIMUL_TEST_QEMU_BINARY");
    const std::filesystem::path adapterPath = ESP32_ADAPTER_DLL_PATH;
    const std::filesystem::path qemuPath =
        (qemuOverride && *qemuOverride) ? std::filesystem::u8path(qemuOverride) : std::filesystem::path(QEMU_REAL_BINARY_PATH);
    const std::filesystem::path devicesLibraryPath = REAL_DEVICES_LIBRARY_JSON_PATH;
    if (!std::filesystem::exists(firmware) || !std::filesystem::exists(adapterPath) ||
        !std::filesystem::exists(qemuPath) || !std::filesystem::exists(devicesLibraryPath)) {
        std::fprintf(stderr, "PULADO: firmware, adapter, QEMU ou devices/library.json ausente.\n");
        return 0;
    }
    setEnv("LASECSIMUL_NETWORK_MODE", "disabled");
    setEnv("LASECSIMUL_MCU_TRANSPORT", "VNEXT_B");

    plugins::GlobalPluginCache cache;
    auto module = cache.loader().loadMcuPlugin(adapterPath);
    cache.setActiveMcuModule("espressif.esp32", module);
    cache.loadLibrary(devicesLibraryPath);

    SimulationSession session(cache);
    session.registerKnownMcuTypes();
    session.registerKnownPluginTypes();
    mcu::McuComponent* mcu = nullptr;
    session.components().registerFactory("test.esp32", [&session, &mcu](const registry::ComponentParams&) {
        auto component = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
        mcu = component.get();
        return component;
    });
    registry::ComponentParams plotParams;
    plotParams.pinList = {{"tx", 0.0, 8.0}, {"rx", 0.0, 24.0}};
    const uint32_t plot = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plot, "baudrate", PropertyValue{115200.0});
    const uint32_t esp32 = session.addComponent("test.esp32", {});
    registry::ComponentParams shiftParams;
    shiftParams.pinList = {{"clk", 0.0, 0.0}, {"data", 0.0, 8.0}, {"rst", 0.0, 16.0}, {"q0", 0.0, 24.0},
                           {"q1", 0.0, 32.0}, {"q2", 0.0, 40.0}, {"q3", 0.0, 48.0}, {"q4", 0.0, 56.0},
                           {"q5", 0.0, 64.0}, {"q6", 0.0, 72.0}, {"q7", 0.0, 80.0}};
    const uint32_t shift = session.addComponent("logic.shift_reg", shiftParams);
    session.setProperty(shift, "outputHighV", PropertyValue{3.3});
    session.connectWire(esp32, "UART0_TX", plot, "rx");
    session.connectWire(esp32, "GPIO18", shift, "clk");
    session.connectWire(esp32, "GPIO23", shift, "data");
    session.connectWire(esp32, "GPIO4", shift, "rst");
    session.connectWire(shift, "q7", esp32, "GPIO19");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-spi-miso-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    session.beginExecutionIfNeeded();
    session.scheduler().start();
    try {
        McuDebugOptions debug;
        session.loadMcuFirmware(esp32, firmware, arena, qemuPath.string(), debug);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FALHOU: firmware nao subiu: %s\n", error.what());
        session.stopSimulation();
        return 1;
    }
    std::string received;
    const auto started = std::chrono::steady_clock::now();
    const auto deadline = started + std::chrono::seconds(8);
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    const double wallMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    session.stopSimulation();

    for (size_t at = received.find("SPIMISO bad"); at != std::string::npos; at = received.find("SPIMISO bad", at + 1)) {
        const size_t end = received.find('\n', at);
        std::fprintf(stderr, "%s\n", received.substr(at, end == std::string::npos ? std::string::npos : end - at).c_str());
    }
    // A ultima linha completa (a recepcao pode ter parado no meio de uma).
    const size_t lastNewline = received.rfind('\n');
    const size_t last = lastNewline == std::string::npos ? std::string::npos : received.rfind("SPIMISO round=", lastNewline);
    unsigned rounds = 0, ok = 0, bad = 0;
    unsigned long firmwareMs = 0;
    if (last == std::string::npos ||
        std::sscanf(received.c_str() + last, "SPIMISO round=%u ok=%u bad=%u ms=%lu", &rounds, &ok, &bad, &firmwareMs) != 4) {
        const std::string tail = received.substr(received.size() > 300 ? received.size() - 300 : 0);
        std::fprintf(stderr, "FALHOU: o firmware nao terminou nenhuma rodada. UART: '%s'\n", tail.c_str());
        return 1;
    }
    std::fprintf(stderr, "rodadas=%u bytes certos=%u errados=%u millis=%lu em %.0f ms de parede\n", rounds, ok, bad,
                 firmwareMs, wallMs);
    if (rounds < 3 || bad != 0 || ok != rounds * 96u) {
        std::fprintf(stderr, "FALHOU: esperado >= 3 rodadas, 96 bytes certos por rodada e nenhum errado\n");
        return 1;
    }
    std::printf("SPI MISO: %u rodadas, %u bytes lidos do registrador de deslocamento, nenhum errado\n", rounds, ok);
    return 0;
}

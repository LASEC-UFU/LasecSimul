// I2S do ESP32 com firmware real (driver do ESP-IDF): a DMA anda no tempo da taxa de amostragem e o receptor
// le o nivel do pino de dados. Antes as duas I2S eram stubs e o i2s_write()/i2s_read() esperava para sempre
// pelas interrupcoes da DMA.
//
// O GPIO4 vai ao GPIO35, o DIN da I2S1. Esperado: um I2S_EVENT_TX_DONE de 441 quadros a cada 441 / taxa
// (10 ms a 44100 Hz, 55,125 ms a 8000 Hz); um segundo de audio por i2s_write leva esse segundo menos os 4
// buffers da DMA; 100 ms de amostras a 16 kHz levam ~100 ms e valem 0xFFFF com o DIN em alto e 0 em baixo.
//
// Firmware (LASECSIMUL_TEST_I2S_FIRMWARE, merged.bin de vnext_prototype/guest_i2s).
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
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
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_I2S_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_I2S_FIRMWARE (firmware da I2S).\n");
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
    session.connectWire(esp32, "UART0_TX", plot, "rx");
    session.connectWire(esp32, "GPIO4", esp32, "GPIO35");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-i2s-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
        if (received.find("I2S fim") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    const std::string qemuLog = mcu ? mcu->qemuLogs() : std::string{};
    session.stopSimulation();
    std::fprintf(stderr, "%s", received.c_str());
    if (const char* logPath = std::getenv("LASECSIMUL_TEST_QEMU_LOG"); logPath && *logPath)
        std::ofstream(std::filesystem::u8path(logPath), std::ios::binary) << qemuLog;

    int failures = 0;
    for (const char* kind : {"TX rate=44100 ", "TX rate=8000 ", "TXA rate=44100 "}) {
        const int rate = std::atoi(std::strchr(kind, '=') + 1);
        const std::string prefix = kind;
        const size_t at = received.find(prefix);
        int events = -1;
        long long avg = -1;
        const double want = 441.0 * 1e6 / rate;
        if (at == std::string::npos || std::sscanf(received.c_str() + at + prefix.size(), "events=%d avg_us=%lld", &events, &avg) != 2 ||
            events < 21 || std::abs(static_cast<double>(avg) - want) > want * 0.003) {
            std::fprintf(stderr, "FALHOU: %sesperado 21 eventos a cada %.0f us; veio events=%d avg_us=%lld\n", kind, want, events,
                         avg);
            ++failures;
        }
    }
    {
        unsigned bytes = 0;
        long long us = -1;
        const size_t at = received.find("TXW ");
        if (at == std::string::npos || std::sscanf(received.c_str() + at, "TXW bytes=%u us=%lld", &bytes, &us) != 2 ||
            bytes != 176400 || us < 930000 || us > 1005000) {
            std::fprintf(stderr, "FALHOU: i2s_write de 1 s esperado 176400 bytes em 0,93-1,0 s; veio bytes=%u us=%lld\n", bytes, us);
            ++failures;
        }
    }
    for (const int level : {1, 0}) {
        const std::string prefix = "RX lvl=" + std::to_string(level) + " ";
        const size_t at = received.find(prefix);
        unsigned n = 0;
        int match = -1;
        long long us = -1;
        if (at == std::string::npos ||
            std::sscanf(received.c_str() + at + prefix.size(), "n=%u match=%d us=%lld", &n, &match, &us) != 3 || n != 1600 ||
            match != 1600 || us < 75000 || us > 105000) {
            std::fprintf(stderr, "FALHOU: RX com o DIN em %d esperado 1600 amostras iguais em ~100 ms; veio n=%u match=%d us=%lld\n",
                         level, n, match, us);
            ++failures;
        }
    }
    if (failures) return 1;
    std::printf("I2S: a DMA de TX e de RX anda no tempo da taxa de amostragem e o receptor le o nivel do DIN\n");
    return 0;
}

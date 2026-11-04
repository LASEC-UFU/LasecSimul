// O DAC pelo I2S0 com firmware real (I2S_MODE_DAC_BUILT_IN do driver do ESP-IDF): cada amostra da DMA chega
// ao pad no seu instante. Antes o I2S era um stub e o DAC so' saia pelo PDAC (dacWrite).
//
// GPIO25 (DAC1) no GPIO34 e no GPIO27, GPIO26 (DAC2) no GPIO35. Esperado: o primeiro de cada par do buffer
// estereo no DAC1 (o canal direito, I2S_TX_MSB_RIGHT 0 do driver) e o segundo no DAC2, 3,3 V * codigo / 255;
// o DAC1 alternando a cada 441 amostras a 44100 Hz da' bordas de subida a cada 20 ms; depois do
// i2s_driver_uninstall, o dacWrite volta a valer.
//
// Firmware (LASECSIMUL_TEST_I2S_DAC_FIRMWARE, merged.bin de vnext_prototype/guest_i2s_dac).
#include <chrono>
#include <cmath>
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

unsigned mv(int code) { return static_cast<unsigned>(std::lround(3300.0 * code / 255)); }

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_I2S_DAC_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_I2S_DAC_FIRMWARE (firmware do DAC pelo I2S).\n");
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
    session.connectWire(esp32, "GPIO25", esp32, "GPIO34");
    session.connectWire(esp32, "GPIO25", esp32, "GPIO27");
    session.connectWire(esp32, "GPIO26", esp32, "GPIO35");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-i2s-dac-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
        if (received.find("DACI fim") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    session.stopSimulation();
    std::fprintf(stderr, "%s", received.c_str());

    int failures = 0;
    struct Step {
        const char* name;
        int dac1, dac2;
    };
    for (const Step& step : {Step{"a", 64, 192}, Step{"b", 192, 64}}) {
        const std::string prefix = std::string("DACI ") + step.name + " ";
        const size_t at = received.find(prefix);
        unsigned mv25 = 0, mv26 = 0;
        if (at == std::string::npos || std::sscanf(received.c_str() + at + prefix.size(), "mv25=%u mv26=%u", &mv25, &mv26) != 2 ||
            std::abs(static_cast<int>(mv25) - static_cast<int>(mv(step.dac1))) > 40 ||
            std::abs(static_cast<int>(mv26) - static_cast<int>(mv(step.dac2))) > 40) {
            std::fprintf(stderr, "FALHOU: passo %s esperado mv25~%u mv26~%u; veio mv25=%u mv26=%u\n", step.name, mv(step.dac1),
                         mv(step.dac2), mv25, mv26);
            ++failures;
        }
    }
    {
        int edges = -1;
        long long period = -1;
        const size_t at = received.find("DACSQ ");
        if (at == std::string::npos || std::sscanf(received.c_str() + at, "DACSQ edges=%d period_us=%lld", &edges, &period) != 2 ||
            edges < 11 || std::abs(period - 20000) > 60) {
            std::fprintf(stderr, "FALHOU: quadrada no DAC1 esperada a cada 20000 us; veio edges=%d period_us=%lld\n", edges, period);
            ++failures;
        }
    }
    {
        unsigned off = 0;
        const size_t at = received.find("DACOFF ");
        if (at == std::string::npos || std::sscanf(received.c_str() + at, "DACOFF mv25=%u", &off) != 1 ||
            std::abs(static_cast<int>(off) - static_cast<int>(mv(100))) > 40) {
            std::fprintf(stderr, "FALHOU: dacWrite depois do I2S esperado ~%u mV; veio %u\n", mv(100), off);
            ++failures;
        }
    }
    if (failures) return 1;
    std::printf("DAC pelo I2S: as amostras da DMA chegam ao GPIO25/26 no seu instante (o direito no DAC1) e o dacWrite volta "
                "depois\n");
    return 0;
}

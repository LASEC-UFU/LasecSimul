// DAC do ESP32 com firmware real (dacWrite/dacDisable do Arduino): a tensao chega ao pad e ao circuito.
// Antes o RTC_IO era um stub e o DAC nao saia em pino nenhum.
//
// GPIO25 (DAC1) ligado ao GPIO34, GPIO26 (DAC2) ao GPIO35 com 1 kOhm ao GND; o ADC (analogReadMilliVolts) le
// as duas. Esperado: 3,3 V * codigo / 255 no DAC1; no DAC2 em 200, o mesmo pela resistencia de saida (20 Ohm)
// contra o 1 kOhm; com o DAC1 desligado, o pad solto.
//
// Firmware (LASECSIMUL_TEST_DAC_FIRMWARE, merged.bin de vnext_prototype/guest_dac).
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
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
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_DAC_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_DAC_FIRMWARE (firmware do DAC).\n");
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
    session.components().registerFactory("test.r1k", [](const registry::ComponentParams&) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"a"}, Pin{"b"}}, 1000.0);
    });
    session.components().registerFactory("test.ground", [](const registry::ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
    registry::ComponentParams plotParams;
    plotParams.pinList = {{"tx", 0.0, 8.0}, {"rx", 0.0, 24.0}};
    const uint32_t plot = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plot, "baudrate", PropertyValue{115200.0});
    const uint32_t esp32 = session.addComponent("test.esp32", {});
    const uint32_t load = session.addComponent("test.r1k", {});
    const uint32_t ground = session.addComponent("test.ground", {});
    session.connectWire(esp32, "UART0_TX", plot, "rx");
    session.connectWire(esp32, "GPIO25", esp32, "GPIO34");
    session.connectWire(esp32, "GPIO26", esp32, "GPIO35");
    session.connectWire(esp32, "GPIO26", load, "a");
    session.connectWire(esp32, "GPIO27", esp32, "GPIO39");
    session.connectWire(load, "b", ground, "pin");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-dac-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
        if (received.find("DAC fim") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    session.stopSimulation();
    std::fprintf(stderr, "%s", received.c_str());

    const unsigned loadedMv = static_cast<unsigned>(std::lround(3300.0 * 200 / 255 * 1000.0 / 1020.0));
    int failures = 0;
    for (const char* step : {"a", "b", "c", "off"}) {
        const std::string prefix = std::string("DAC ") + step + " ";
        const size_t at = received.find(prefix);
        int code = -1;
        unsigned mv25 = 0, mv26 = 0;
        if (at == std::string::npos ||
            std::sscanf(received.c_str() + at + prefix.size(), "code=%d mv25=%u mv26=%u", &code, &mv25, &mv26) != 3) {
            std::fprintf(stderr, "FALHOU: sem a linha do passo %s\n", step);
            ++failures;
            continue;
        }
        const unsigned want25 = static_cast<unsigned>(std::lround(3300.0 * code / 255));
        const bool ok25 = std::string(step) == "off" ? mv25 < 150 : std::abs(static_cast<int>(mv25) - static_cast<int>(want25)) <= 40;
        const bool ok26 = std::abs(static_cast<int>(mv26) - static_cast<int>(loadedMv)) <= 40;
        if (!ok25 || !ok26) {
            std::fprintf(stderr, "FALHOU: passo %s esperado mv25~%u mv26~%u; veio mv25=%u mv26=%u\n", step,
                         std::string(step) == "off" ? 0u : want25, loadedMv, mv25, mv26);
            ++failures;
        }
    }
    // O GPIO de RTC: com o pad no dominio do RTC a saida digital (ainda em alto) nao chega mais nele.
    int dig = -1, lo = -1, hi = -1;
    const size_t atRtc = received.find("RTCGPIO ");
    if (atRtc == std::string::npos ||
        std::sscanf(received.c_str() + atRtc, "RTCGPIO dig=%d lo=%d hi=%d", &dig, &lo, &hi) != 3 || dig != 1 || lo != 0 ||
        hi != 1) {
        std::fprintf(stderr, "FALHOU: GPIO de RTC esperado dig=1 lo=0 hi=1; veio dig=%d lo=%d hi=%d\n", dig, lo, hi);
        ++failures;
    }
    if (failures) return 1;
    std::printf("DAC: o DAC1 em 64/128/192 e o DAC2 em 200 com 1 kOhm (%u mV) chegam ao pad como no chip; desligado, solta o "
                "pad; o GPIO de RTC dirige o pad no lugar da saida digital\n",
                loadedMv);
    return 0;
}

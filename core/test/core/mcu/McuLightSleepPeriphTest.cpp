// Light sleep do ESP32 com firmware real e o ESP-IDF: acorda pelo timer de RTC, pelo ext0 (GPIO33) e pelo
// GPIO (esp_sleep_enable_gpio_wakeup, GPIO27), uma onda quadrada de 2 Hz nos dois. Como no chip:
//  - o esp_timer conta o sono (o ESP-IDF o acerta pelo tempo de RTC na volta);
//  - a CPU e o APB ficam sem clock: o CCOUNT e o timer de hardware do TIMG nao contam o sono.
//
// Firmware (LASECSIMUL_TEST_LIGHT_SLEEP_PERIPH_FIRMWARE, merged.bin de vnext_prototype/guest_light_sleep).
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include "components/sources/Clock.hpp"
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
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_LIGHT_SLEEP_PERIPH_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_LIGHT_SLEEP_PERIPH_FIRMWARE (firmware do light sleep).\n");
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
    session.components().registerFactory("test.clock", [&session](const registry::ComponentParams&) {
        return std::make_unique<components::Clock>(session.scheduler(), Pin{"pin"}, 3.3, 2.0, true);
    });
    registry::ComponentParams plotParams;
    plotParams.pinList = {{"tx", 0.0, 8.0}, {"rx", 0.0, 24.0}};
    const uint32_t plot = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plot, "baudrate", PropertyValue{115200.0});
    const uint32_t esp32 = session.addComponent("test.esp32", {});
    const uint32_t clock = session.addComponent("test.clock", {});
    session.connectWire(esp32, "UART0_TX", plot, "rx");
    session.connectWire(clock, "pin", esp32, "GPIO33");
    session.connectWire(clock, "pin", esp32, "GPIO27");
    session.connectWire(esp32, "GPIO18", esp32, "GPIO34");
    session.connectWire(esp32, "GPIO19", esp32, "GPIO35");
    session.connectWire(esp32, "GPIO18", esp32, "GPIO22");
    session.connectWire(esp32, "GPIO19", esp32, "GPIO21");
    session.connectWire(esp32, "GPIO19", esp32, "GPIO35");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-lightsleep-periph-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
        if (received.find("LIGHTPERIPH fim") != std::string::npos) break;
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
    long long slept = 0; int apbBefore=0, apbAfter=0, rtcBefore=0, rtcAfter=0;
    const size_t at = received.find("LIGHTPERIPH slept_us=");
    if (at == std::string::npos || std::sscanf(received.c_str()+at, "LIGHTPERIPH slept_us=%lld apb=%d:%d rtc8m=%d:%d", &slept, &apbBefore, &apbAfter, &rtcBefore, &rtcAfter) != 5) {
        std::fprintf(stderr, "FALHOU: linha LIGHTPERIPH ausente ou invalida\n"); ++failures;
    } else {
        if (slept < 45000 || slept > 60000) { std::fprintf(stderr, "FALHOU: light sleep mediu %lld us\n", slept); ++failures; }
        if (std::abs(apbAfter-apbBefore) > 2 || std::abs(rtcAfter-rtcBefore) > 2) { std::fprintf(stderr, "FALHOU: PCNT acumulou pulsos no sono: APB %d:%d RTC8M %d:%d\n", apbBefore, apbAfter, rtcBefore, rtcAfter); ++failures; }
    }    if (failures) return 1;
    std::printf("Light sleep peripheral: %lld us; PCNT permaneceu APB=%d RTC8M=%d\\n", slept, apbAfter, rtcAfter);
    return 0;
}








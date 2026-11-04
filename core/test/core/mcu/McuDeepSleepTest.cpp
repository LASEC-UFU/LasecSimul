// Deep sleep do ESP32 com firmware real e o ESP-IDF: o chip dorme e acorda pelo timer de RTC, pelo ext0 e
// pelo ext1 (um pino de RTC em alto, aqui uma onda quadrada de 2 Hz no GPIO33). Cada despertar e' um reset
// com DEEPSLEEP_RESET em que a memoria de RTC (RTC_DATA_ATTR) e o tempo de RTC continuam; a causa sai de
// esp_sleep_get_wakeup_cause(). Antes o esp_deep_sleep_start() ficava girando para sempre.
//
// Firmware (LASECSIMUL_TEST_DEEP_SLEEP_FIRMWARE, merged.bin de vnext_prototype/guest_deep_sleep).
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
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_DEEP_SLEEP_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_DEEP_SLEEP_FIRMWARE (firmware do deep sleep).\n");
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
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-deepsleep-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
        if (received.find("SLEEP fim") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    const std::string qemuLog = mcu ? mcu->qemuLogs() : std::string{};
    session.stopSimulation();
    std::fprintf(stderr, "%s", received.c_str());
    if (const char* logPath = std::getenv("LASECSIMUL_TEST_QEMU_LOG"); logPath && *logPath)
        std::ofstream(std::filesystem::u8path(logPath), std::ios::binary) << qemuLog;
    // Os resets que o QEMU fez (causa, PC das CPUs, quem pediu), para entender uma falha.
    for (size_t at = qemuLog.find("[LasecSimul][ESP32 reset]"); at != std::string::npos;
         at = qemuLog.find("[LasecSimul][ESP32 reset]", at + 1))
        std::fprintf(stderr, "%s\n", qemuLog.substr(at, qemuLog.find('\n', at) - at).c_str());

    // esp_sleep_get_wakeup_cause: EXT0 2, EXT1 3, TIMER 4; esp_reset_reason: POWERON 1, DEEPSLEEP 8.
    int failures = 0;
    const struct { int boot, cause, reason; } expected[] = {{1, 0, 1}, {2, 4, 8}, {3, 2, 8}, {4, 3, 8}};
    unsigned sleptTimer = 0;
    for (const auto& e : expected) {
        char prefix[16];
        std::snprintf(prefix, sizeof(prefix), "BOOT %d ", e.boot);
        const size_t at = received.find(prefix);
        int boot = 0, cause = -1, reason = -1;
        unsigned slept = 0;
        if (at == std::string::npos ||
            std::sscanf(received.c_str() + at, "BOOT %d cause=%d reason=%d slept_ms=%u", &boot, &cause, &reason, &slept) != 4 ||
            cause != e.cause || reason != e.reason) {
            std::fprintf(stderr, "FALHOU: boot %d esperado cause=%d reason=%d; veio cause=%d reason=%d\n", e.boot, e.cause,
                         e.reason, cause, reason);
            ++failures;
        }
        if (e.boot == 2) sleptTimer = slept;
    }
    // 300 ms dormindo pelo timer, mais o boot ate' o setup(): o tempo de RTC continua durante o sono.
    if (sleptTimer < 300 || sleptTimer > 1500) {
        std::fprintf(stderr, "FALHOU: o timer de 300 ms deu %u ms de RTC ate' o setup() seguinte\n", sleptTimer);
        ++failures;
    }
    if (received.find("EXT1 status=200000000") == std::string::npos) {
        std::fprintf(stderr, "FALHOU: esp_sleep_get_ext1_wakeup_status() sem o GPIO33\n");
        ++failures;
    }
    if (failures) return 1;
    std::printf("Deep sleep: acordou pelo timer (%u ms de RTC), pelo ext0 e pelo ext1 como no chip\n", sleptTimer);
    return 0;
}

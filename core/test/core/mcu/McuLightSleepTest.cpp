// Light sleep do ESP32 com firmware real e o ESP-IDF: acorda pelo timer de RTC, pelo ext0 (GPIO33) e pelo
// GPIO (esp_sleep_enable_gpio_wakeup, GPIO27), uma onda quadrada de 2 Hz nos dois. Como no chip:
//  - o esp_timer conta o sono (o ESP-IDF o acerta pelo tempo de RTC na volta);
//  - a CPU e o APB ficam sem clock: o CCOUNT e o timer de hardware do TIMG nao contam o sono.
//
// Firmware (LASECSIMUL_TEST_LIGHT_SLEEP_FIRMWARE, merged.bin de vnext_prototype/guest_light_sleep).
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
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_LIGHT_SLEEP_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_LIGHT_SLEEP_FIRMWARE (firmware do light sleep).\n");
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
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-lightsleep-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
        if (received.find("LIGHT fim") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    const std::string qemuLog = mcu ? mcu->qemuLogs() : std::string{};
    session.stopSimulation();
    std::fprintf(stderr, "%s", received.c_str());
    if (const char* logPath = std::getenv("LASECSIMUL_TEST_QEMU_LOG"); logPath && *logPath)
        std::ofstream(std::filesystem::u8path(logPath), std::ios::binary) << qemuLog;

    // esp_sleep_get_wakeup_cause: EXT0 2, TIMER 4, GPIO 7. O CCOUNT (milhares de ciclos) e o TIMG (us) so'
    // contam o que a CPU ficou acordada em volta do sono: no chip, poucos ms; o sono inteiro seria 200 ms.
    int failures = 0;
    const struct { const char* name; int cause; } expected[] = {{"timer", 4}, {"ext0", 2}, {"gpio", 7}};
    long long timerSlept = 0;
    for (const auto& e : expected) {
        const std::string prefix = std::string("LIGHT ") + e.name + " ";
        const size_t at = received.find(prefix);
        int cause = -1;
        long long slept = 0;
        unsigned ccountK = 0;
        unsigned long long timgUs = 0;
        if (at == std::string::npos ||
            std::sscanf(received.c_str() + at + prefix.size(), "cause=%d slept_us=%lld ccount=%u timg=%llu", &cause, &slept,
                        &ccountK, &timgUs) != 4 ||
            cause != e.cause) {
            std::fprintf(stderr, "FALHOU: %s esperado cause=%d; veio cause=%d\n", e.name, e.cause, cause);
            ++failures;
            continue;
        }
        if (std::string(e.name) == "timer") timerSlept = slept;
        // CCOUNT a 240 MHz: menos de 5 ms acordado (1200 mil ciclos); o TIMG a 1 MHz, menos de 5000 us -- de
        // um sono de 200 a 500 ms. Um contador que volta (a troca do APB recontando a base) da' um enorme.
        if (ccountK > 1200 || timgUs > 5000) {
            std::fprintf(stderr, "FALHOU: o sono (%s) contou no CCOUNT (%u mil ciclos) ou no TIMG (%llu us)\n", e.name,
                         ccountK, timgUs);
            ++failures;
        }
    }
    if (timerSlept < 195000 || timerSlept > 215000) {
        std::fprintf(stderr, "FALHOU: o esp_timer mediu %lld us num light sleep de 200 ms\n", timerSlept);
        ++failures;
    }
    if (failures) return 1;
    std::printf("Light sleep: acordou pelo timer (%lld us no esp_timer, CCOUNT e TIMG parados), pelo ext0 e pelo GPIO\n",
                timerSlept);
    return 0;
}

// Sensor de toque do ESP32 com firmware real (touchRead/touchAttachInterrupt do Arduino): a contagem e' a
// dos ciclos de carga e descarga do pad na medicao, e cai com a capacitancia que o circuito poe nele. Antes
// era ~1500 fixo com ruido, sem ligacao com o circuito.
//
// T0 (GPIO4) solto, T3 (GPIO15) com 100 pF ao GND, T7 (GPIO27) com 470 pF. Com a medicao do Arduino (0x1000
// ciclos de 8 MHz, 2,7 V/0,5 V sem atenuacao, inclinacao 7): T * I / (2 C dV) com o pad de 20 pF. O GPIO15 e'
// o MTDO, uma saida digital no reset: so' o MUX do RTC (rtc_gpio_init) o tira do digital.
//
// Firmware (LASECSIMUL_TEST_TOUCH_FIRMWARE, merged.bin de vnext_prototype/guest_touch).
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include "components/other/Ground.hpp"
#include "components/passive/Capacitor.hpp"
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

// A contagem do modelo: T * I / (2 C dV), I = 7 x 1,72 uA (inclinacao 7), dV = 2,7 - 0,5 V (o Arduino nao
// atenua), C = 20 pF + o externo.
unsigned expectedCount(double measCycles, double externalFarads) {
    return static_cast<unsigned>(measCycles / 8e6 * 7 * 1.72e-6 / (2.0 * (20e-12 + externalFarads) * 2.2));
}

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_TOUCH_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_TOUCH_FIRMWARE (firmware do sensor de toque).\n");
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
    session.components().registerFactory("test.cap100p", [](const registry::ComponentParams&) {
        return std::make_unique<components::Capacitor>(std::array<Pin, 2>{Pin{"a"}, Pin{"b"}}, 100e-12);
    });
    session.components().registerFactory("test.cap470p", [](const registry::ComponentParams&) {
        return std::make_unique<components::Capacitor>(std::array<Pin, 2>{Pin{"a"}, Pin{"b"}}, 470e-12);
    });
    session.components().registerFactory("test.ground", [](const registry::ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
    registry::ComponentParams plotParams;
    plotParams.pinList = {{"tx", 0.0, 8.0}, {"rx", 0.0, 24.0}};
    const uint32_t plot = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plot, "baudrate", PropertyValue{115200.0});
    const uint32_t esp32 = session.addComponent("test.esp32", {});
    const uint32_t c100 = session.addComponent("test.cap100p", {});
    const uint32_t c470 = session.addComponent("test.cap470p", {});
    const uint32_t ground = session.addComponent("test.ground", {});
    session.connectWire(esp32, "UART0_TX", plot, "rx");
    session.connectWire(esp32, "GPIO15", c100, "a");
    session.connectWire(c100, "b", ground, "pin");
    session.connectWire(esp32, "GPIO27", c470, "a");
    session.connectWire(c470, "b", ground, "pin");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-touch-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
        if (received.find("TOUCH fim") != std::string::npos) break;
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
    const auto within = [](unsigned got, unsigned want) { return std::abs(static_cast<int>(got) - static_cast<int>(want)) <= 2; };
    unsigned t0 = 0, t3 = 0, t7 = 0, t0x2 = 0;
    int hits = -1;
    const size_t at = received.find("TOUCH t0=");
    if (at == std::string::npos || std::sscanf(received.c_str() + at, "TOUCH t0=%u t3=%u t7=%u", &t0, &t3, &t7) != 3 ||
        !within(t0, expectedCount(0x1000, 0)) || !within(t3, expectedCount(0x1000, 100e-12)) ||
        !within(t7, expectedCount(0x1000, 470e-12))) {
        std::fprintf(stderr, "FALHOU: esperado t0~%u t3~%u t7~%u; veio t0=%u t3=%u t7=%u\n", expectedCount(0x1000, 0),
                     expectedCount(0x1000, 100e-12), expectedCount(0x1000, 470e-12), t0, t3, t7);
        ++failures;
    }
    const size_t at2 = received.find("TOUCH2 t0=");
    if (at2 == std::string::npos || std::sscanf(received.c_str() + at2, "TOUCH2 t0=%u", &t0x2) != 1 ||
        !within(t0x2, expectedCount(0x2000, 0))) {
        std::fprintf(stderr, "FALHOU: com o dobro da medicao esperado t0~%u; veio %u\n", expectedCount(0x2000, 0), t0x2);
        ++failures;
    }
    const size_t at3 = received.find("TOUCHINT ");
    if (at3 == std::string::npos || std::sscanf(received.c_str() + at3, "TOUCHINT hits=%d", &hits) != 1 || hits != 1) {
        std::fprintf(stderr, "FALHOU: o toque no T3 (abaixo do limiar) nao deu interrupcao\n");
        ++failures;
    }
    // Deep sleep com o despertar pelo toque: ESP_SLEEP_WAKEUP_TOUCHPAD (5), o pad 3.
    int cause = -1, pad = -1;
    const size_t at4 = received.find("WAKE ");
    if (at4 == std::string::npos || std::sscanf(received.c_str() + at4, "WAKE cause=%d pad=%d", &cause, &pad) != 2 ||
        cause != 5 || pad != 3) {
        std::fprintf(stderr, "FALHOU: o toque nao acordou o deep sleep (cause=%d pad=%d, esperado 5 e 3)\n", cause, pad);
        ++failures;
    }
    if (failures) return 1;
    std::printf("Touch: t0=%u (solto) t3=%u (100 pF) t7=%u (470 pF), %u com o dobro da medicao, a interrupcao e o "
                "despertar do deep sleep pelo T3\n",
                t0, t3, t7, t0x2);
    return 0;
}

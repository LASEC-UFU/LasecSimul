// A frequencia da CPU com firmware real (setCpuFrequencyMhz do Arduino): 240/160/80 MHz no PLL e 40/20/10 MHz
// no XTAL dividido por APB_CTRL_SYSCLK_CONF.PRE_DIV_CNT. Antes o divisor era ignorado (40 MHz em 20 e 10) e o
// LEDC, o PCNT, o MCPWM e o TWAI do Core contavam sempre em 80 MHz de APB.
//
// GPIO25 (LEDC) ligado ao GPIO26. Esperado em cada frequencia: o ESP-IDF le a CPU pedida e o APB (80 MHz no
// PLL, igual a CPU no XTAL), o CCOUNT anda a CPU MHz por us e o LEDC de 1 kHz, configurado de novo pelo
// sketch, sai com 1000 us de periodo.
//
// Firmware (LASECSIMUL_TEST_CPU_FREQ_FIRMWARE, merged.bin de vnext_prototype/guest_cpu_freq).
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

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_CPU_FREQ_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_CPU_FREQ_FIRMWARE (firmware da frequencia da CPU).\n");
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
    session.connectWire(esp32, "GPIO25", esp32, "GPIO26");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-cpu-freq-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(40);
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
        if (received.find("CPU fim") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    session.stopSimulation();
    std::fprintf(stderr, "%s", received.c_str());

    int failures = 0;
    for (const unsigned mhz : {240u, 160u, 80u, 40u, 20u, 10u}) {
        const std::string prefix = "CPU set=" + std::to_string(mhz) + " ";
        const size_t at = received.find(prefix);
        unsigned cpu = 0, apb = 0, perUs = 0;
        long long ledc = -1;
        const unsigned wantApb = mhz >= 80 ? 80000000u : mhz * 1000000u;
        if (at == std::string::npos ||
            std::sscanf(received.c_str() + at + prefix.size(), "cpu=%u apb=%u ccount_per_us=%u ledc_us=%lld", &cpu, &apb, &perUs, &ledc) !=
                4 ||
            cpu != mhz || apb != wantApb || std::abs(static_cast<int>(perUs) - static_cast<int>(mhz)) > 1 || std::llabs(ledc - 1000) > 5) {
            std::fprintf(stderr, "FALHOU: %u MHz esperado cpu=%u apb=%u ccount_per_us~%u ledc_us~1000; veio cpu=%u apb=%u ccount_per_us=%u ledc_us=%lld\n",
                         mhz, mhz, wantApb, mhz, cpu, apb, perUs, ledc);
            ++failures;
        }
    }
    if (failures) return 1;
    std::printf("CPU: 240/160/80 MHz no PLL e 40/20/10 MHz no XTAL dividido, o CCOUNT e o LEDC no ritmo certo em cada uma\n");
    return 0;
}

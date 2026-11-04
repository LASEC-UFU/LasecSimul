// MCPWM do ESP32 com firmware real e o driver do ESP-IDF: 1 kHz em modo complementar com dead time de
// 2 us no PWM0A/PWM0B (GPIO18/19), medido pela captura do próprio MCPWM (GPIO26/27 ligados de volta). As
// medidas esperadas, em ns: período 1 000 000; A em alto = duty x período - 2000 (RED atrasa a subida);
// intervalo A desce -> B sobe = 2000 (FED); B em alto = (1 - duty) x período - 2000; B desce -> A sobe =
// 2000. Antes o MCPWM nem estava mapeado: o primeiro acesso dava Guru Meditation.
//
// Firmware (LASECSIMUL_TEST_MCPWM_FIRMWARE, merged.bin de vnext_prototype/guest_mcpwm): imprime
// "MCPWM duty=.. period=.. high_a=.. dead_ab=.. high_b=.. dead_ba=..".
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

bool within(long long value, long long expected, long long tolerance) { return value >= expected - tolerance && value <= expected + tolerance; }

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_MCPWM_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_MCPWM_FIRMWARE (firmware do MCPWM).\n");
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
    session.connectWire(esp32, "GPIO18", esp32, "GPIO26");
    session.connectWire(esp32, "GPIO19", esp32, "GPIO27");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-mcpwm-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
        size_t lines = 0;
        for (size_t at = received.find("MCPWM duty="); at != std::string::npos; at = received.find("MCPWM duty=", at + 1)) ++lines;
        if (lines >= 6) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    session.stopSimulation();
    received.resize(received.rfind('\n') == std::string::npos ? 0 : received.rfind('\n') + 1); // só linhas completas

    int failures = 0, measured = 0;
    for (size_t at = received.find("MCPWM duty="); at != std::string::npos; at = received.find("MCPWM duty=", at + 1)) {
        int duty = 0;
        long long period = 0, highA = 0, deadAB = 0, highB = 0, deadBA = 0;
        if (std::sscanf(received.c_str() + at, "MCPWM duty=%d period=%lld high_a=%lld dead_ab=%lld high_b=%lld dead_ba=%lld", &duty,
                        &period, &highA, &deadAB, &highB, &deadBA) != 6) {
            const size_t end = received.find('\n', at);
            std::fprintf(stderr, "FALHOU: %s\n", received.substr(at, end == std::string::npos ? 80 : end - at).c_str());
            ++failures;
            continue;
        }
        ++measured;
        std::fprintf(stderr, "duty %d%%: periodo=%lld A=%lld A->B=%lld B=%lld B->A=%lld ns\n", duty, period, highA, deadAB, highB, deadBA);
        // Resolução: tick do timer (1 us no driver) e captura em 12,5 ns.
        const long long expectedA = duty * 10'000LL - 2'000, expectedB = (100 - duty) * 10'000LL - 2'000;
        if (!within(period, 1'000'000, 50) || !within(highA, expectedA, 50) || !within(deadAB, 2'000, 50) ||
            !within(highB, expectedB, 50) || !within(deadBA, 2'000, 50)) {
            std::fprintf(stderr, "FALHOU: esperado periodo=1000000 A=%lld A->B=2000 B=%lld B->A=2000\n", expectedA, expectedB);
            ++failures;
        }
    }
    if (measured < 4) {
        std::fprintf(stderr, "FALHOU: %d medidas. UART: '%s'\n", measured,
                     received.substr(received.size() > 300 ? received.size() - 300 : 0).c_str());
        return 1;
    }
    if (failures) return 1;
    std::printf("MCPWM: %d medidas, PWM complementar com dead time e duty novo como no chip\n", measured);
    return 0;
}

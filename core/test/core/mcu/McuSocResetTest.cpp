// Os resets do ESP32 com firmware real, cada um com o alcance que tem no chip, nos perifericos que o Core
// modela nos pinos tambem:
//  - esp_restart() reinicia so' as CPUs (SW_CPU_RESET): o LEDC segue gerando PWM e o PCNT segue contando;
//  - periph_module_reset() (DPORT_PERIP_RST_EN) reinicia um periferico: o PCNT zera, o LEDC para;
//  - o reset de sistema por software (RTC_CNTL_SW_SYS_RST, SW_RESET) reinicia todo o digital.
// Antes um reset do digital deixava o LEDC e o PCNT do Core rodando e o periph_module_reset() nao fazia nada.
//
// Firmware (LASECSIMUL_TEST_SOC_RESET_FIRMWARE, merged.bin de vnext_prototype/guest_soc_reset), GPIO4 (LEDC a
// 1 kHz) ligado ao GPIO5 (PCNT): tres boots, ver o firmware.
#include <chrono>
#include <cstdio>
#include <cstdlib>
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
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_SOC_RESET_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_SOC_RESET_FIRMWARE (firmware do reset de software).\n");
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
    session.connectWire(esp32, "GPIO4", esp32, "GPIO5");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-socreset-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
        const size_t boot3 = received.find("BOOT3 ");
        if (boot3 != std::string::npos && received.find('\n', boot3) != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    const std::string qemuLog = mcu ? mcu->qemuLogs() : std::string{};
    session.stopSimulation();
    if (const char* logPath = std::getenv("LASECSIMUL_TEST_QEMU_LOG"); logPath && *logPath)
        std::ofstream(std::filesystem::u8path(logPath), std::ios::binary) << qemuLog;
    // Os resets que o QEMU fez (causa, PC das CPUs, quem pediu), para entender uma falha.
    for (size_t at = qemuLog.find("[LasecSimul][ESP32 reset]"); at != std::string::npos;
         at = qemuLog.find("[LasecSimul][ESP32 reset]", at + 1))
        std::fprintf(stderr, "%s\n", qemuLog.substr(at, qemuLog.find('\n', at) - at).c_str());
    std::fprintf(stderr, "%s", received.c_str());

    // delay(20) de PWM de 1 kHz: ~20 subidas (o tick de 1 ms e a fase mudam uma ou duas).
    const auto pwmEdges = [](int edges) { return edges >= 18 && edges <= 22; };
    int failures = 0;
    int boot1 = -1;
    const size_t at1 = received.find("BOOT1 ");
    if (at1 == std::string::npos || std::sscanf(received.c_str() + at1, "BOOT1 pcnt=%d", &boot1) != 1 || !pwmEdges(boot1)) {
        std::fprintf(stderr, "FALHOU: o 1o boot nao contou o PWM (pcnt=%d)\n", boot1);
        ++failures;
    }
    // rtc_get_reset_reason(0): SW_CPU_RESET = 12, SW_RESET = 3.
    int reason = -1, before = -1, edges = -1, pcntReset = -1, ledcEdges = -1;
    const size_t at2 = received.find("BOOT2 ");
    if (at2 == std::string::npos ||
        std::sscanf(received.c_str() + at2, "BOOT2 reason=%d pcnt_before=%d edges=%d pcnt_reset=%d ledc_reset_edges=%d", &reason,
                    &before, &edges, &pcntReset, &ledcEdges) != 5 ||
        reason != 12 || before <= boot1 || !pwmEdges(edges) || pcntReset != 0 || ledcEdges != 0) {
        std::fprintf(stderr,
                     "FALHOU: esp_restart() reinicia so' as CPUs e periph_module_reset() o periferico: esperado reason=12 "
                     "pcnt_before>%d edges~20 pcnt_reset=0 ledc_reset_edges=0; veio reason=%d pcnt_before=%d edges=%d "
                     "pcnt_reset=%d ledc_reset_edges=%d\n",
                     boot1, reason, before, edges, pcntReset, ledcEdges);
        ++failures;
    }
    int again = -1;
    const size_t atAgain = received.find("PWM again ");
    if (atAgain == std::string::npos || std::sscanf(received.c_str() + atAgain, "PWM again edges=%d", &again) != 1 ||
        !pwmEdges(again)) {
        std::fprintf(stderr, "FALHOU: o LEDC nao voltou depois do periph_module_reset() (edges=%d)\n", again);
        ++failures;
    }
    int reason3 = -1, before3 = -1, edges3 = -1;
    const size_t at3 = received.find("BOOT3 ");
    if (at3 == std::string::npos ||
        std::sscanf(received.c_str() + at3, "BOOT3 reason=%d pcnt_before=%d edges=%d", &reason3, &before3, &edges3) != 3 ||
        reason3 != 3 || before3 != 0 || edges3 != 0) {
        std::fprintf(stderr,
                     "FALHOU: o reset de sistema reinicia o PCNT e o LEDC: esperado reason=3 pcnt_before=0 edges=0; veio "
                     "reason=%d pcnt_before=%d edges=%d\n",
                     reason3, before3, edges3);
        ++failures;
    }
    if (failures) return 1;
    std::printf("SOC reset: CPU reset manteve o PCNT (%d -> %d) e o PWM; periph_module_reset() e o reset de sistema "
                "reiniciaram o LEDC e o PCNT como no chip\n",
                boot1, before);
    return 0;
}

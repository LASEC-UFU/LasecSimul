// Espera da CPU1 pelo cache da flash com firmware ESP32 real (QEMU com -icount, VNEXT_B). Quando a
// CPU0 desliga o cache da CPU1, um acesso da CPU1 à flash espera até o cache voltar e então termina
// com o valor certo (hw/misc/esp32_dport.c, appcpu_cache_wait_mask). Uma prova anterior (E131,
// 2026-09) lia contadores de um QEMU de diagnóstico e marcas no DPORT_DATE, que no chip é só a data
// da versão; esta observa tudo pelo próprio firmware.
//
// Firmware: LASECSIMUL_TEST_CACHE_WAIT_FIRMWARE, merged.bin de vnext_prototype/guest_cache_wait_e2e.
// Seis cenários em ordem (DROM, FETCH, RUNSTALL, CLKGATE, SELF_ILLEGAL, RESET_WAIT), cada um imprime
// "E131 <nome> PASS" ou "E131 <nome> FAIL check=..." pela UART0, e no fim "E131_DONE PASS|FAIL".
// Sem a variável o teste é pulado.
#include <array>
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
    setenv(name, value, 1);
#endif
}

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_CACHE_WAIT_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_CACHE_WAIT_FIRMWARE (firmware da espera pelo cache).\n");
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
        auto result = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
        mcu = result.get();
        return result;
    });
    registry::ComponentParams plotParams;
    plotParams.pinList = {{"tx", 0.0, 8.0}, {"rx", 0.0, 24.0}};
    const uint32_t plot = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plot, "baudrate", PropertyValue{115200.0});
    const uint32_t esp32 = session.addComponent("test.esp32", {});
    session.connectWire(esp32, "UART0_TX", plot, "rx");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-cache-wait-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    session.beginExecutionIfNeeded();
    session.scheduler().start();
    try {
        McuDebugOptions debug;
        if (const char* port = std::getenv("LASECSIMUL_TEST_GDB_PORT")) {
            debug.gdbPort = static_cast<uint16_t>(std::stoi(port));
            debug.startPaused = false;
        }
        session.loadMcuFirmware(esp32, firmware, arena, qemuPath.string(), debug);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FALHOU: firmware nao subiu: %s\n", error.what());
        session.stopSimulation();
        return 1;
    }

    // O resultado é o que veio até o E131_DONE; depois do reset da CPU1 o firmware não tem mais nada
    // a provar.
    std::string received;
    size_t doneLineEnd = std::string::npos;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
        const size_t done = received.find("E131_DONE ");
        if (done != std::string::npos && (doneLineEnd = received.find('\n', done)) != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    const std::string qemuLogs = mcu ? mcu->qemuLogs() : std::string();
    session.scheduler().pause();
    session.stopSimulation();

    if (doneLineEnd == std::string::npos) {
        std::fprintf(stderr, "FALHOU: o firmware nao terminou os cenarios. UART: '%s'\nQEMU:\n%s\n",
                     received.substr(received.size() > 600 ? received.size() - 600 : 0).c_str(),
                     qemuLogs.substr(qemuLogs.size() > 4000 ? qemuLogs.size() - 4000 : 0).c_str());
        return 1;
    }
    const size_t begin = received.find("E131_BEGIN");
    const std::string report = received.substr(begin == std::string::npos ? 0 : begin,
                                               doneLineEnd - (begin == std::string::npos ? 0 : begin));
    std::fprintf(stderr, "%s\n", report.c_str());

    int failures = 0;
    if (report.find(" FAIL") != std::string::npos) ++failures;
    constexpr std::array<const char*, 6> kScenarios{"DROM", "FETCH", "RUNSTALL", "CLKGATE", "SELF_ILLEGAL", "RESET_WAIT"};
    for (const char* scenario : kScenarios) {
        if (report.find(std::string("E131 ") + scenario + " PASS") == std::string::npos) {
            std::fprintf(stderr, "FALHOU: cenario %s sem PASS\n", scenario);
            ++failures;
        }
    }
    if (report.find("E131_DONE PASS failures=0") == std::string::npos) ++failures;
    if (failures) return 1;
    std::printf("Espera da CPU1 pelo cache da flash: os seis cenarios passaram\n");
    return 0;
}

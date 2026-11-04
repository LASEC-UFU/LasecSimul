// Contador de pulsos (PCNT) do ESP32 com firmware real e o driver do ESP-IDF. O LEDC gera 1 kHz no
// GPIO25, que volta pelo GPIO26 (pulso da unidade 0); o GPIO14 vai ao GPIO27 (controle: baixo inverte o
// sentido). Por rodada: 100 ms para cima, 50 ms para baixo e 1,1 s para cima, passando pelo limiar 250 e
// pelo limite alto 1000 (que zera o contador). Antes o PCNT nem estava mapeado: o primeiro acesso dava
// LoadStorePIFAddrError (Guru Meditation).
//
// Firmware (LASECSIMUL_TEST_PCNT_FIRMWARE, merged.bin de vnext_prototype/guest_pcnt): imprime
// "PCNT round=.. up=.. down=.. thres=.. hlim=.. after=..".
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

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_PCNT_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_PCNT_FIRMWARE (firmware do PCNT).\n");
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
    session.connectWire(esp32, "GPIO14", esp32, "GPIO27");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-pcnt-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
        if (received.find("PCNT round=3 ") != std::string::npos && received.find('\n', received.find("PCNT round=3 ")) != std::string::npos)
            break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    session.stopSimulation();

    int failures = 0;
    unsigned rounds = 0;
    for (size_t at = received.find("PCNT round="); at != std::string::npos; at = received.find("PCNT round=", at + 1)) {
        unsigned round = 0, thres = 0, hlim = 0;
        int up = 0, down = 0, after = 0;
        if (std::sscanf(received.c_str() + at, "PCNT round=%u up=%d down=%d thres=%u hlim=%u after=%d", &round, &up, &down,
                        &thres, &hlim, &after) != 6)
            continue;
        ++rounds;
        std::fprintf(stderr, "rodada %u: up=%d down=%d thres=%u hlim=%u after=%d\n", round, up, down, thres, hlim, after);
        // 1 kHz: 100 subidas em 100 ms, menos 50 em 50 ms ao contrário; depois 1,1 s a mais passa por 250 e
        // chega a 1000 (volta a 0) uma vez e para em ~150. +-1 pela fase do LEDC em cada janela.
        if (up < 99 || up > 101) { std::fprintf(stderr, "FALHOU: up=%d (esperado 100)\n", up); ++failures; }
        if (down < up - 51 || down > up - 49) { std::fprintf(stderr, "FALHOU: down=%d (esperado up-50)\n", down); ++failures; }
        if (thres != 1 || hlim != 1) { std::fprintf(stderr, "FALHOU: eventos thres=%u hlim=%u (esperado 1 e 1)\n", thres, hlim); ++failures; }
        const int expectedAfter = down + 1100 - 1000;
        if (after < expectedAfter - 2 || after > expectedAfter + 2) {
            std::fprintf(stderr, "FALHOU: after=%d (esperado %d)\n", after, expectedAfter);
            ++failures;
        }
    }
    if (rounds < 2) {
        std::fprintf(stderr, "FALHOU: %u rodadas. UART: '%s'\n", rounds,
                     received.substr(received.size() > 300 ? received.size() - 300 : 0).c_str());
        return 1;
    }
    if (failures) return 1;
    std::printf("PCNT: %u rodadas, contagem nos dois sentidos, limiar e limite alto como no chip\n", rounds);
    return 0;
}

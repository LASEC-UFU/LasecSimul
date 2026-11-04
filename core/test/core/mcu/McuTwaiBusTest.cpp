// Dois ESP32 conversando por CAN (TWAI) com firmware real e o driver do ESP-IDF, num barramento sem
// transceptor: TX (GPIO5) em dreno aberto e RX (GPIO4) dos dois no mesmo fio, com pull-up de 4,7 kOhm para
// 3,3 V -- o "E" com fio do CAN. Confere o que so' acontece com dois nos: o ACK que o receptor da' no
// quadro do outro, as respostas, e a arbitragem bit a bit (0x050 ganha de 0x060 no bit 5 do ID; o perdedor
// recebe o vencedor e transmite depois). Nenhum erro de barramento, TEC e REC em 0.
//
// Firmware (LASECSIMUL_TEST_TWAI_NODE_FIRMWARE, merged.bin de vnext_prototype/guest_twai_node), o mesmo nos
// dois: o papel A vem do GPIO12 ligado ao GPIO13 so' nele.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include <vector>
#include "components/passive/Resistor.hpp"
#include "components/sources/Rail.hpp"
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

int expectInOrder(const std::string& text, const std::vector<std::string>& lines, const char* who) {
    int failures = 0;
    size_t at = 0;
    for (const std::string& line : lines) {
        const size_t found = text.find(line, at);
        if (found == std::string::npos) {
            std::fprintf(stderr, "FALHOU (%s): esperado '%s'\n", who, line.c_str());
            ++failures;
            continue;
        }
        at = found + line.size();
    }
    return failures;
}

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_TWAI_NODE_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_TWAI_NODE_FIRMWARE (firmware dos dois nos CAN).\n");
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
    std::vector<mcu::McuComponent*> mcus;
    session.components().registerFactory("test.esp32", [&session, &mcus](const registry::ComponentParams&) {
        auto component = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
        mcus.push_back(component.get());
        return component;
    });
    session.components().registerFactory("test.pullup", [](const registry::ComponentParams&) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"pin-1"}, Pin{"pin-2"}}, 4700.0);
    });
    session.components().registerFactory("test.rail", [](const registry::ComponentParams&) {
        return std::make_unique<components::Rail>(Pin{"pin"}, 3.3);
    });
    registry::ComponentParams plotParams;
    plotParams.pinList = {{"tx", 0.0, 8.0}, {"rx", 0.0, 24.0}};
    const uint32_t plotA = session.addComponent("peripherals.lasecplot", plotParams);
    const uint32_t plotB = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plotA, "baudrate", PropertyValue{115200.0});
    session.setProperty(plotB, "baudrate", PropertyValue{115200.0});
    const uint32_t a = session.addComponent("test.esp32", {});
    const uint32_t b = session.addComponent("test.esp32", {});
    const uint32_t pullup = session.addComponent("test.pullup", {});
    const uint32_t rail = session.addComponent("test.rail", {});
    session.connectWire(a, "UART0_TX", plotA, "rx");
    session.connectWire(b, "UART0_TX", plotB, "rx");
    session.connectWire(a, "GPIO12", a, "GPIO13"); // papel A
    session.connectWire(a, "GPIO14", b, "GPIO14"); // sincronismo da arbitragem
    session.connectWire(a, "GPIO5", a, "GPIO4");   // o barramento: TX e RX dos dois
    session.connectWire(a, "GPIO5", b, "GPIO5");
    session.connectWire(b, "GPIO5", b, "GPIO4");
    session.connectWire(a, "GPIO5", pullup, "pin-1");
    session.connectWire(pullup, "pin-2", rail, "pin");
    session.scheduler().setRealTimeRate(1.0);

    const auto stamp = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    session.beginExecutionIfNeeded();
    session.scheduler().start();
    try {
        McuDebugOptions debug;
        session.loadMcuFirmware(a, firmware, "lasecsimul-twai-a-" + stamp, qemuPath.string(), debug);
        session.loadMcuFirmware(b, firmware, "lasecsimul-twai-b-" + stamp, qemuPath.string(), debug);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FALHOU: firmware nao subiu: %s\n", error.what());
        session.stopSimulation();
        return 1;
    }
    std::string textA, textB;
    const auto started = std::chrono::steady_clock::now();
    const auto deadline = started + std::chrono::seconds(150); // dois MCUs em lockstep: ~2% do tempo real (item 17)
    // Quando cada linha chega, em tempo de parede e no tempo da sessão: mostra o ritmo dos dois MCUs juntos.
    const auto logLines = [&](std::string& text, const std::string& more, size_t& logged) {
        text += more;
        for (size_t end = text.find('\n', logged); end != std::string::npos; end = text.find('\n', logged)) {
            const double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
            std::fprintf(stderr, "[%6.2f s parede, %8.3f ms sessao] %s\n", wall, session.scheduler().nowNs() / 1e6,
                         text.substr(logged, end - logged).c_str());
            logged = end + 1;
        }
    };
    size_t loggedA = 0, loggedB = 0;
    while (std::chrono::steady_clock::now() < deadline) {
        if (const auto snapshot = session.tryDrainUartRx(plotA)) logLines(textA, hexToText(snapshot->dataHex), loggedA);
        if (const auto snapshot = session.tryDrainUartRx(plotB)) logLines(textB, hexToText(snapshot->dataHex), loggedB);
        if (textA.find("A fim") != std::string::npos && textB.find("B fim") != std::string::npos &&
            textA.find('\n', textA.find("A fim")) != std::string::npos && textB.find('\n', textB.find("B fim")) != std::string::npos)
            break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plotA)) textA += hexToText(snapshot->dataHex);
    if (const auto snapshot = session.tryDrainUartRx(plotB)) textB += hexToText(snapshot->dataHex);
    session.stopSimulation();
    std::fprintf(stderr, "--- A ---\n%s\n--- B ---\n%s\n", textA.c_str(), textB.c_str());

    int failures = expectInOrder(textA,
                                 {"A RX id=0x200 dlc=2 data=01a0", "A RX id=0x201 dlc=2 data=02a1",
                                  "A RX id=0x202 dlc=2 data=03a2", "A RX id=0x60 dlc=1 data=0b",
                                  "A fim tec=0 rec=0 arb_lost=0 bus_errors=0"},
                                 "A");
    failures += expectInOrder(textB,
                              {"B RX id=0x100 dlc=2 data=00a0", "B RX id=0x101 dlc=2 data=01a1",
                               "B RX id=0x102 dlc=2 data=02a2", "B RX id=0x700 dlc=8 data=f0e1d2c3b4a59687",
                               "B RX id=0x50 dlc=1 data=0a", "B fim tec=0 rec=0 arb_lost=1 bus_errors=0"},
                              "B");
    if (failures) return 1;
    std::printf("TWAI: dois ESP32 no mesmo barramento CAN -- ACK, respostas e arbitragem como no chip\n");
    return 0;
}

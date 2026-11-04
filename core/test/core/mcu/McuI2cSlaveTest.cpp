// I2C entre dois ESP32 com firmware real (Wire do Arduino): um mestre e um escravo no endereco 0x42, SDA e SCL
// dos dois no mesmo fio com pull-ups de 4,7 kOhm para 3,3 V. Antes o I2C so' tinha o modo mestre: o escravo
// nao respondia (o mestre via NACK no endereco) e nada chegava ao firmware dele.
//
// Esperado: as tres escritas com ACK (err=0) e o escravo recebendo "hi0", "hi1", "hi2"; as leituras trazem o
// que ja' estava na FIFO de TX do escravo -- "ABCD" de antes, depois o que o onRequest de cada leitura poe
// (o ESP32 original nao estica o clock).
//
// Firmware (LASECSIMUL_TEST_I2C_SLAVE_FIRMWARE, merged.bin de vnext_prototype/guest_i2c_slave), o mesmo nos
// dois: o papel de mestre vem do GPIO12 ligado ao GPIO13 so' nele.
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
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_I2C_SLAVE_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_I2C_SLAVE_FIRMWARE (firmware do mestre e do escravo I2C).\n");
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
    const uint32_t plotM = session.addComponent("peripherals.lasecplot", plotParams);
    const uint32_t plotS = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plotM, "baudrate", PropertyValue{115200.0});
    session.setProperty(plotS, "baudrate", PropertyValue{115200.0});
    const uint32_t m = session.addComponent("test.esp32", {});
    const uint32_t sl = session.addComponent("test.esp32", {});
    const uint32_t pullSda = session.addComponent("test.pullup", {});
    const uint32_t pullScl = session.addComponent("test.pullup", {});
    const uint32_t rail = session.addComponent("test.rail", {});
    session.connectWire(m, "UART0_TX", plotM, "rx");
    session.connectWire(sl, "UART0_TX", plotS, "rx");
    session.connectWire(m, "GPIO12", m, "GPIO13"); // papel de mestre
    session.connectWire(m, "GPIO21", sl, "GPIO21"); // SDA
    session.connectWire(m, "GPIO22", sl, "GPIO22"); // SCL
    session.connectWire(m, "GPIO21", pullSda, "pin-1");
    session.connectWire(m, "GPIO22", pullScl, "pin-1");
    session.connectWire(pullSda, "pin-2", rail, "pin");
    session.connectWire(pullScl, "pin-2", rail, "pin");
    session.scheduler().setRealTimeRate(1.0);

    const auto stamp = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    session.beginExecutionIfNeeded();
    session.scheduler().start();
    try {
        McuDebugOptions debug;
        session.loadMcuFirmware(m, firmware, "lasecsimul-i2cm-" + stamp, qemuPath.string(), debug);
        session.loadMcuFirmware(sl, firmware, "lasecsimul-i2cs-" + stamp, qemuPath.string(), debug);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FALHOU: firmware nao subiu: %s\n", error.what());
        session.stopSimulation();
        return 1;
    }
    std::string textM, textS;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(150); // dois MCUs: item 17
    while (std::chrono::steady_clock::now() < deadline) {
        if (const auto snapshot = session.tryDrainUartRx(plotM)) textM += hexToText(snapshot->dataHex);
        if (const auto snapshot = session.tryDrainUartRx(plotS)) textS += hexToText(snapshot->dataHex);
        if (textM.find("I2CM fim\n") != std::string::npos && textS.find("I2CS fim\n") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plotM)) textM += hexToText(snapshot->dataHex);
    if (const auto snapshot = session.tryDrainUartRx(plotS)) textS += hexToText(snapshot->dataHex);
    session.stopSimulation();
    std::fprintf(stderr, "--- mestre ---\n%s\n--- escravo ---\n%s\n", textM.c_str(), textS.c_str());

    int failures = expectInOrder(textM,
                                 {"I2CM i=0 err=0 n=4 data=41424344", "I2CM i=1 err=0 n=4 data=45464748",
                                  "I2CM i=2 err=0 n=4 data=494A4B4C", "I2CM fim"},
                                 "mestre");
    failures += expectInOrder(textS, {"I2CS rx n=3 data=hi0", "I2CS rx n=3 data=hi1", "I2CS rx n=3 data=hi2", "I2CS fim"},
                              "escravo");
    if (failures) return 1;
    std::printf("I2C escravo: o ESP32 no endereco 0x42 recebe as escritas e responde as leituras de outro ESP32\n");
    return 0;
}

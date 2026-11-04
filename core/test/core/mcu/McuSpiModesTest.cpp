// SPI do ESP32 alem do MODE0 byte a byte, com firmware real, conferido no fio pela captura do MCPWM:
//  - os quatro modos (VSPI, SPI do Arduino): nivel ocioso do SCK = CPOL, MOSI mudando na borda de volta
//    (CPHA 0) ou na de ida (CPHA 1), os 8 bits certos no fio e o byte de volta pelo MISO (ligado ao MOSI);
//  - transferBits de 9 bits: 9 ciclos de SCK, nao 16;
//  - spi_master do ESP-IDF no HSPI: fases de comando (8), endereco (24), dummy (8) e leitura (24) = 64
//    ciclos, com 0x9F e 0x123456 no MOSI; spi_device_transmit, que espera a interrupcao de fim de transacao;
//    e 5000 bytes por DMA, de volta inteiros.
//  - os valores de reset do HSPI: SCK no APB (SPI_CLOCK_REG) e a fase de comando de 8 bits (SPI_USER).
// Antes: so' MODE0, so' bytes inteiros, as fases e a interrupcao ignoradas, nenhum DMA e o SPI sem periodo
// ate' o firmware escrever SPI_CLOCK_REG.
//
// Firmware (LASECSIMUL_TEST_SPI_MODES_FIRMWARE, merged.bin de vnext_prototype/guest_spi_modes).
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include <vector>
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
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_SPI_MODES_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_SPI_MODES_FIRMWARE (firmware dos modos de SPI).\n");
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
    session.connectWire(esp32, "GPIO18", esp32, "GPIO26"); // VSPI SCK -> captura
    session.connectWire(esp32, "GPIO23", esp32, "GPIO27"); // VSPI MOSI -> captura
    session.connectWire(esp32, "GPIO23", esp32, "GPIO19"); // ... e de volta pelo MISO
    session.connectWire(esp32, "GPIO14", esp32, "GPIO32"); // HSPI SCK -> captura
    session.connectWire(esp32, "GPIO13", esp32, "GPIO33"); // HSPI MOSI -> captura
    session.connectWire(esp32, "GPIO13", esp32, "GPIO21"); // ... e de volta pelo MISO
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-spimodes-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
        if (received.find("SPI fim") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    session.stopSimulation();
    std::fprintf(stderr, "%s", received.c_str());

    // CPOL = idle; CPHA 0: o MOSI muda na borda de volta, CPHA 1: na de ida.
    const std::vector<std::string> expected = {
        // Valores de reset do HSPI e um byte com eles: SCK no APB, a fase de comando de 8 bits do reset.
        "RESET clock=80003043 user=80000040 sck_edges=32 rx=5a",
        "MODE 0 rx=a5 idle=0 shift=trailing", "bits=10100101 cycles=8 pcnt=16",
        "MODE 1 rx=a5 idle=0 shift=leading", "bits=10100101 cycles=8 pcnt=16",
        "MODE 2 rx=a5 idle=1 shift=trailing", "bits=10100101 cycles=8 pcnt=16",
        "MODE 3 rx=a5 idle=1 shift=leading", "bits=10100101 cycles=8 pcnt=16",
        "BITS9 out=0180 bits=000000011 cycles=9",
        "PHASES cycles=64 mosi=9f123456",
        "IRQ rx=11223344",
        "DMA n=5000 errors=0 first=03 last=b4",
    };
    int failures = 0;
    size_t at = 0;
    for (const std::string& line : expected) {
        const size_t found = received.find(line, at);
        if (found == std::string::npos) {
            std::fprintf(stderr, "FALHOU: esperado '%s'\n", line.c_str());
            ++failures;
            continue;
        }
        at = found + line.size();
    }
    if (failures) return 1;
    std::printf("SPI: os quatro modos, 9 bits, fases de comando/endereco/dummy, interrupcao e DMA como no chip\n");
    return 0;
}

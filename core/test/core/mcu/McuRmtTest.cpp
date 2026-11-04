// RMT do ESP32 com firmware real. Três WS2812 (outputs.ws2812, 3 colunas) no GPIO25 recebem 72 itens
// por quadro -- mais que os 64 de um bloco de RAM, então o driver recarrega a RAM pelo evento TX_THR
// enquanto o transmissor anda -- e o decodificador de bordas do próprio WS2812 tem de chegar às três
// cores. O GPIO26 manda 1 ms de portadora de 38 kHz (80 MHz / 2105) e volta pelo GPIO27, onde o
// firmware conta as bordas de subida. Antes nada disso saía no pino: os itens iam para um barramento
// interno do QEMU, a 1250 ns por item fixos.
//
// Firmware (LASECSIMUL_TEST_RMT_FIRMWARE, merged.bin de vnext_prototype/guest_rmt): imprime
// "RMT frame=.. ir_rises=.." por quadro.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
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

constexpr size_t kStateHeaderBytes = 9 * sizeof(uint32_t); // SIMULIDE_COMPLEX_STATE_HEADER_BYTES
constexpr uint32_t kExpected[3] = {0x123456, 0xABCDEF, 0x8001FF}; // (R << 16) | (G << 8) | B

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_RMT_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_RMT_FIRMWARE (firmware do RMT).\n");
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
    registry::ComponentParams ledParams;
    ledParams.pinList = {{"din", 0.0, 0.0}, {"dout", 0.0, 8.0}};
    ledParams.properties["columns"] = PropertyValue{3.0}; // o tamanho da fita vale na criação
    const uint32_t strip = session.addComponent("outputs.ws2812", ledParams);
    session.connectWire(esp32, "UART0_TX", plot, "rx");
    session.connectWire(esp32, "GPIO25", strip, "din");
    session.connectWire(esp32, "GPIO26", esp32, "GPIO27");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-rmt-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
        if (received.find("RMT frame=5 ") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    std::vector<uint8_t> state;
    for (int attempt = 0; attempt < 200 && state.empty(); ++attempt) {
        try {
            state = session.getComponentState(strip);
        } catch (const std::exception&) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }
    session.stopSimulation();

    int failures = 0;
    unsigned frames = 0;
    for (size_t at = received.find("RMT frame="); at != std::string::npos; at = received.find("RMT frame=", at + 1)) {
        unsigned frame = 0, rises = 0;
        if (std::sscanf(received.c_str() + at, "RMT frame=%u ir_rises=%u", &frame, &rises) != 2) continue;
        ++frames;
        // 1 ms / (2105 / 80 MHz) = 38,0 períodos, cada um com uma subida: 38 ou 39 com a da borda inicial.
        if (rises < 38 || rises > 39) {
            std::fprintf(stderr, "FALHOU: quadro %u, %u subidas da portadora em 1 ms (esperado 38-39)\n", frame, rises);
            ++failures;
        }
    }
    if (frames < 3) {
        std::fprintf(stderr, "FALHOU: %u quadros. UART: '%s'\n", frames,
                     received.substr(received.size() > 300 ? received.size() - 300 : 0).c_str());
        return 1;
    }
    if (state.size() < kStateHeaderBytes + 3 * sizeof(uint32_t)) {
        std::fprintf(stderr, "FALHOU: estado do WS2812 com %zu bytes\n", state.size());
        return 1;
    }
    for (int led = 0; led < 3; ++led) {
        uint32_t color = 0;
        std::memcpy(&color, state.data() + kStateHeaderBytes + led * sizeof(uint32_t), sizeof(color));
        std::fprintf(stderr, "LED %d: %06X\n", led, color);
        if (color != kExpected[led]) {
            std::fprintf(stderr, "FALHOU: LED %d com %06X, esperado %06X\n", led, color, kExpected[led]);
            ++failures;
        }
    }
    if (failures) return 1;
    std::printf("RMT: %u quadros, tres WS2812 com as cores certas e a portadora de 38 kHz no pino\n", frames);
    return 0;
}

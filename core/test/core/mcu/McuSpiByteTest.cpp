// SPI de hardware byte a byte (mcu_abi.h 3.3 / device_abi.h 4.1) com firmware ESP32 real e o PCD8544
// real do simulide-complex. Com os fios de clock e de dado ligando só o MCU e o display, o adaptador
// transmite cada byte sem as 16 bordas e o Core entrega o byte ao display no instante da 8a borda
// de subida. Antes cada borda custava um solve do circuito: ~46 settles por byte, um quadro de
// display por SPI.transfer() ~100x mais lento que o real.
//
// Firmware (LASECSIMUL_TEST_SPI_DISPLAY_FIRMWARE, merged.bin de vnext_prototype/guest_spi_display):
// inicializa o PCD8544 (comandos com D/C baixo) e manda quadros de 504 bytes de dado, cada um depois
// de um endereço (D/C baixo de novo), imprimindo "SPIFRAME n=..." por quadro. Roda duas vezes pelo
// mesmo tempo de parede -- bit a bit (LASECSIMUL_SPI_BYTE_MODE=bit) e byte a byte -- e exige o
// mesmo quadro no display e o caminho de bytes bem mais rápido.
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

struct RunResult {
    bool ok = false;
    unsigned frames = 0;
    std::vector<uint8_t> display;
    std::string uartTail;
};

constexpr size_t kStateHeaderBytes = 9 * sizeof(uint32_t); // SIMULIDE_COMPLEX_STATE_HEADER_BYTES

RunResult runOnce(plugins::GlobalPluginCache& cache, const std::filesystem::path& firmware,
                  const std::filesystem::path& qemuPath, std::chrono::seconds wall) {
    RunResult result;
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
    registry::ComponentParams displayParams;
    displayParams.pinList = {{"rst", 0.0, 0.0}, {"ce", 0.0, 8.0}, {"dc", 0.0, 16.0}, {"din", 0.0, 24.0}, {"clk", 0.0, 32.0}};
    const uint32_t display = session.addComponent("outputs.pcd8544", displayParams);
    session.connectWire(esp32, "UART0_TX", plot, "rx");
    session.connectWire(esp32, "GPIO18", display, "clk");
    session.connectWire(esp32, "GPIO23", display, "din");
    session.connectWire(esp32, "GPIO5", display, "ce");
    session.connectWire(esp32, "GPIO16", display, "dc");
    session.connectWire(esp32, "GPIO17", display, "rst");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-spi-byte-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    session.beginExecutionIfNeeded();
    session.scheduler().start();
    try {
        McuDebugOptions debug;
        session.loadMcuFirmware(esp32, firmware, arena, qemuPath.string(), debug);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FALHOU: firmware nao subiu: %s\n", error.what());
        session.stopSimulation();
        return result;
    }
    std::string received;
    const auto deadline = std::chrono::steady_clock::now() + wall;
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    // Com LASECSIMUL_LOCKSTEP_TRACE=1 o QEMU registra sincronismos ([LOCKSTEP]) e o controlador de
    // tempo real ([RT]) no log.
    if (std::getenv("LASECSIMUL_LOCKSTEP_TRACE") && mcu) {
        const std::string logs = mcu->qemuLogs();
        std::fprintf(stderr, "--- log do QEMU: [LOCKSTEP] e os ultimos [RT] ---\n");
        std::vector<std::string> rt;
        for (size_t begin = 0; begin < logs.size();) {
            const size_t end = std::min(logs.find('\n', begin), logs.size());
            const std::string line = logs.substr(begin, end - begin);
            if (line.find("[LOCKSTEP]") != std::string::npos) std::fprintf(stderr, "%s\n", line.c_str());
            if (line.find("[RT]") != std::string::npos) rt.push_back(line);
            begin = end + 1;
        }
        for (size_t i = rt.size() > 4 ? rt.size() - 4 : 0; i < rt.size(); ++i) std::fprintf(stderr, "%s\n", rt[i].c_str());
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    // getComponentState() recusa ("simulação ocupada") enquanto o Scheduler termina o passo em curso.
    for (int attempt = 0; attempt < 200 && result.display.empty(); ++attempt) {
        try {
            result.display = session.getComponentState(display);
        } catch (const std::exception&) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }
    session.stopSimulation();
    for (size_t at = received.find("SPIFRAME n="); at != std::string::npos; at = received.find("SPIFRAME n=", at + 1))
        ++result.frames;
    result.uartTail = received.substr(received.size() > 200 ? received.size() - 200 : 0);
    result.ok = true;
    return result;
}

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_SPI_DISPLAY_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_SPI_DISPLAY_FIRMWARE (firmware do display SPI).\n");
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

    // Diagnóstico: LASECSIMUL_SPI_TEST_WALL_S muda a janela; LASECSIMUL_SPI_TEST_ONLY=byte roda só o
    // caminho de bytes (para medir/perfilar).
    const char* wallEnv = std::getenv("LASECSIMUL_SPI_TEST_WALL_S");
    const auto wall = std::chrono::seconds(wallEnv && std::atoi(wallEnv) > 0 ? std::atoi(wallEnv) : 10);
    const char* only = std::getenv("LASECSIMUL_SPI_TEST_ONLY");
    if (only && std::string(only) == "byte") {
        setEnv("LASECSIMUL_SPI_BYTE_MODE", "");
        const RunResult bytes = runOnce(cache, firmware, qemuPath, wall);
        std::fprintf(stderr, "quadros em %lld s de parede, byte a byte: %u\n", static_cast<long long>(wall.count()),
                     bytes.frames);
        return bytes.ok && bytes.frames > 0 ? 0 : 1;
    }
    setEnv("LASECSIMUL_SPI_BYTE_MODE", "bit");
    const RunResult bits = runOnce(cache, firmware, qemuPath, wall);
    setEnv("LASECSIMUL_SPI_BYTE_MODE", "");
    const RunResult bytes = runOnce(cache, firmware, qemuPath, wall);
    std::fprintf(stderr, "quadros em %lld s de parede: bit a bit %u, byte a byte %u\n",
                 static_cast<long long>(wall.count()), bits.frames, bytes.frames);

    int failures = 0;
    if (!bits.ok || !bytes.ok) return 1;
    if (bits.frames < 1 || bytes.frames < 1) {
        std::fprintf(stderr, "FALHOU: algum modo nao completou um quadro. UART bit: '%s' byte: '%s'\n",
                     bits.uartTail.c_str(), bytes.uartTail.c_str());
        return 1;
    }
    const auto payload = [](const std::vector<uint8_t>& state) {
        return state.size() > kStateHeaderBytes ? std::vector<uint8_t>(state.begin() + kStateHeaderBytes, state.end())
                                                : std::vector<uint8_t>{};
    };
    const std::vector<uint8_t> bitPixels = payload(bits.display);
    const std::vector<uint8_t> bytePixels = payload(bytes.display);
    bool lit = false;
    for (uint8_t value : bytePixels) lit = lit || value != 0;
    if (bitPixels.empty() || bitPixels != bytePixels || !lit) {
        std::fprintf(stderr, "FALHOU: o quadro no PCD8544 difere entre bit a bit e byte a byte (ou esta' vazio)\n");
        ++failures;
    }
    // O ganho esperado é de uma ordem de grandeza; 4x deixa folga para um servidor carregado.
    if (bytes.frames < 4 * bits.frames) {
        std::fprintf(stderr, "FALHOU: byte a byte %u quadros, bit a bit %u (esperado >= 4x)\n", bytes.frames, bits.frames);
        ++failures;
    }
    if (failures) return 1;
    std::printf("SPI byte a byte: mesmo quadro no PCD8544, %u quadros contra %u bit a bit\n", bytes.frames, bits.frames);
    return 0;
}

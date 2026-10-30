// UART RX no VNEXT_B com firmware ESP32 real: o FIFO de RX que o firmware lê é o do modelo de UART do
// QEMU, então cada byte que o adaptador recebe precisa ir ao QEMU (C2A). Antes nenhum ia: o firmware
// nunca via o que chegava no pino RX nem o que a caixa de envio do monitor serial mandava.
//
// Firmware: eco em maiúscula na UART0 (LASECSIMUL_TEST_UART_ECHO_FIRMWARE, merged.bin de
// vnext_prototype/guest_uart_echo, imprime "ECHO_READY" no boot). Dois caminhos:
//  - elétrico: um LasecPlot transmite "abc" pelo fio até o GPIO3 (U0RXD) e lê o eco no GPIO1;
//  - monitor: `uart0_rx_inject_hex` injeta "xyz" no RX da USART.
// Antes do app, o banner da ROM ("ets Jul 29 2019 ...") precisa chegar legível a 115200.
// Sem a variável (ou sem QEMU/adaptador) o teste é pulado.
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

std::string textToHex(const std::string& text) {
    static const char* const digits = "0123456789abcdef";
    std::string hex;
    for (const unsigned char c : text) {
        hex.push_back(digits[c >> 4]);
        hex.push_back(digits[c & 0x0F]);
    }
    return hex;
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
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_UART_ECHO_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_UART_ECHO_FIRMWARE (firmware de eco da UART0).\n");
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
    session.setProperty(plot, "data_bits", PropertyValue{8.0});
    session.setProperty(plot, "stop_bits", PropertyValue{1.0});
    session.setProperty(plot, "parity", PropertyValue{std::string("none")});
    const uint32_t esp32 = session.addComponent("test.esp32", {});
    // Padrão: os pinos dedicados UART0_TX/UART0_RX, que a DevKitC usa. LASECSIMUL_TEST_UART_PINS=gpio
    // liga pelos pads GPIO1/GPIO3 (IO_MUX função 0).
    const char* uartPins = std::getenv("LASECSIMUL_TEST_UART_PINS");
    const bool gpioPins = uartPins && std::string(uartPins) == "gpio";
    session.connectWire(esp32, gpioPins ? "GPIO1" : "UART0_TX", plot, "rx");
    session.connectWire(plot, "tx", esp32, gpioPins ? "GPIO3" : "UART0_RX");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-uart-rx-vnextb-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
    const auto waitFor = [&](const std::string& needle, std::chrono::seconds timeout) {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
            if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
            if (received.find(needle) != std::string::npos) return true;
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        return false;
    };

    int failures = 0;
    if (!waitFor("ECHO_READY", std::chrono::seconds(30))) {
        std::fprintf(stderr, "FALHOU: firmware nao imprimiu ECHO_READY\n");
        ++failures;
    } else {
        // O banner da ROM sai antes do app, com o divisor que a própria ROM calcula do cristal que
        // ela detecta (calibração RTC x eFuse CK8M_FREQ). Com o eFuse em branco ela caía em 26 MHz e
        // o banner saía a 177 kbaud no pino: lixo no LasecPlot a 115200. No modo mttcg o relógio do
        // guest não acompanha o do circuito e os bits pelo pad não são confiáveis (limite do modo).
        const char* executionMode = std::getenv("LASECSIMUL_ESP32_EXECUTION_MODE");
        const bool mttcg = executionMode && std::string(executionMode) == "mttcg";
        if (!(mttcg && gpioPins) &&
            received.find("ets Jul 29 2019 12:21:46\r\n\r\nrst:0x1 (POWERON_RESET),boot:0x12 (SPI_FAST_FLASH_BOOT)") ==
                std::string::npos) {
            std::fprintf(stderr, "FALHOU: banner da ROM ilegivel no LasecPlot a 115200 (cristal detectado errado?)\n");
            ++failures;
        }
        if (const auto error = session.setProperty(plot, "uart_tx_hex", PropertyValue{textToHex("abc")})) {
            std::fprintf(stderr, "FALHOU: uart_tx_hex: %s\n", error->c_str());
            ++failures;
        } else if (!waitFor("ABC", std::chrono::seconds(10))) {
            // Diagnóstico: o adaptador decodificou algo no pino? O LasecPlot ainda tem bytes a enviar?
            const auto monitor = session.propertyValueOf(esp32, "uart0_rx_monitor_hex");
            const auto pending = session.propertyValueOf(plot, "uart_tx_pending");
            std::fprintf(stderr, "FALHOU: bytes no pino RX nao chegaram ao firmware (eco ausente); "
                         "rx_monitor='%s' lasecplot_tx_pending=%g\n",
                         monitor && std::holds_alternative<std::string>(*monitor) ? std::get<std::string>(*monitor).c_str() : "?",
                         pending && std::holds_alternative<double>(*pending) ? std::get<double>(*pending) : -1.0);
            ++failures;
        }
        if (const auto error = session.setProperty(esp32, "uart0_rx_inject_hex", PropertyValue{textToHex("xyz")})) {
            std::fprintf(stderr, "FALHOU: uart0_rx_inject_hex: %s\n", error->c_str());
            ++failures;
        } else if (!waitFor("XYZ", std::chrono::seconds(10))) {
            std::fprintf(stderr, "FALHOU: bytes da caixa de envio do monitor nao chegaram ao firmware\n");
            ++failures;
        }
    }
    session.scheduler().pause();
    session.stopSimulation();
    std::fprintf(stderr, "UART recebida pelo LasecPlot: '%s'\n", received.c_str());
    if (failures) return 1;
    std::printf("UART RX VNEXT_B: eco pelo pino RX e pela caixa de envio do monitor OK\n");
    return 0;
}

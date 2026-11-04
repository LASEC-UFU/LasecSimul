// O quadro da UART do ESP32 com firmware real (driver do ESP-IDF): paridade, 5..8 bits, 1, 1,5 e 2 stop bits
// (os 2 pelo DL1_EN do RS485_CONF, como o IDF faz no ESP32), a inversao da linha e os erros de recepcao. Antes
// o adaptador so' fazia 8 bits sem paridade com 1 ou 2 stops e o QEMU contava o mesmo: um 8E1 saia com 10 bits
// e o receptor nunca acusava erro.
//
// O TX da UART2 (GPIO17) vai ao RX da UART1 (GPIO18) e ao GPIO34. Esperado em cada formato: os 32 bytes
// chegam iguais e o envio leva 32 quadros do tamanho do formato (bit de 8680 ns em 115200, a conta do QEMU e
// do adaptador). Nos erros: 8E1 lido em 8O1 da' erro de paridade em cada byte; um 0x01 em 57600 lido em
// 115200 chega 0x06 com erro de quadro (o stop cai no d3, em baixo); um 0x00 em 57600, break. O
// uart_write_bytes_with_break manda o break do transmissor (TXD_BRK) e volta no TX_BRK_DONE; antes esperava
// para sempre. Invertidos os dois lados, os bytes chegam e a linha em repouso fica em baixo.
//
// Firmware (LASECSIMUL_TEST_UART_FORMAT_FIRMWARE, merged.bin de vnext_prototype/guest_uart_format).
#include <chrono>
#include <cmath>
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

struct Expected {
    const char* name;
    unsigned bitsBeforeStop; // start + dado + paridade
    unsigned stopHalfBits;   // o stop em meios bits (DL incluido)
};

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_UART_FORMAT_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_UART_FORMAT_FIRMWARE (firmware do formato da UART).\n");
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
    session.connectWire(esp32, "GPIO17", esp32, "GPIO18");
    session.connectWire(esp32, "GPIO17", esp32, "GPIO34");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-uart-format-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
        if (received.find("UART fim") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    session.stopSimulation();
    std::fprintf(stderr, "%s", received.c_str());

    constexpr double kBitNs = 8680.0; // 1e9 / (80 MHz * 16 / 11111), a conta do QEMU e do adaptador em 115200
    static const Expected formats[] = {
        {"8N1", 9, 2}, {"8E1", 10, 2}, {"7O1", 9, 2}, {"8N2", 9, 4}, {"8N1.5", 9, 3}, {"6E2", 8, 4}, {"5N1", 6, 2},
    };
    int failures = 0;
    for (const Expected& f : formats) {
        const std::string prefix = std::string("FMT ") + f.name + " ";
        const size_t at = received.find(prefix);
        int n = -1, ok = 0, pe = -1, fe = -1, brk = -1;
        long long us = -1;
        if (at == std::string::npos ||
            std::sscanf(received.c_str() + at + prefix.size(), "n=%d ok=%d us=%lld pe=%d fe=%d brk=%d", &n, &ok, &us, &pe, &fe,
                        &brk) != 6) {
            std::fprintf(stderr, "FALHOU: sem a linha do formato %s\n", f.name);
            ++failures;
            continue;
        }
        const double wantUs = 32.0 * (kBitNs * f.bitsBeforeStop + kBitNs * f.stopHalfBits / 2.0) / 1000.0;
        const bool timeOk = std::abs(static_cast<double>(us) - wantUs) <= 30.0 + wantUs * 0.005;
        if (n != 32 || !ok || pe || fe || brk || !timeOk) {
            std::fprintf(stderr, "FALHOU: formato %s esperado n=32 ok=1 us~%.0f sem erros; veio n=%d ok=%d us=%lld pe=%d fe=%d brk=%d\n",
                         f.name, wantUs, n, ok, us, pe, fe, brk);
            ++failures;
        }
    }
    struct ErrorCase {
        const char* name;
        int n;
        unsigned first;
        int pe, fe, brk; // -1: nao conferido
    };
    static const ErrorCase errorCases[] = {
        {"parity", 4, 0x41, 4, 0, 0},
        {"frame", 1, 0x06, 0, 1, 0},
        {"break", 1, 0x00, 0, -1, 1},
    };
    for (const ErrorCase& e : errorCases) {
        const std::string prefix = std::string("ERR ") + e.name + " ";
        const size_t at = received.find(prefix);
        int n = -1, pe = -1, fe = -1, brk = -1;
        unsigned first = 0xFFFF;
        if (at == std::string::npos ||
            std::sscanf(received.c_str() + at + prefix.size(), "n=%d first=%x pe=%d fe=%d brk=%d", &n, &first, &pe, &fe, &brk) != 5) {
            std::fprintf(stderr, "FALHOU: sem a linha do erro %s\n", e.name);
            ++failures;
            continue;
        }
        if (n != e.n || first != e.first || pe != e.pe || (e.fe >= 0 && fe != e.fe) || brk != e.brk) {
            std::fprintf(stderr, "FALHOU: erro %s esperado n=%d first=%02x pe=%d fe=%d brk=%d; veio n=%d first=%02x pe=%d fe=%d brk=%d\n",
                         e.name, e.n, e.first, e.pe, e.fe, e.brk, n, first, pe, fe, brk);
            ++failures;
        }
    }
    // O break do transmissor (TXD_BRK): 'U' e 100 bits em 0; o receptor ve o 'U' e um 0x00 com break, e a
    // chamada volta no TX_BRK_DONE, 110 bits depois.
    {
        int nb = -1, brk = -1;
        unsigned first = 0, second = 0;
        long long us = -1;
        const size_t at = received.find("TXBRK ");
        const double wantUs = 110 * kBitNs / 1000.0;
        if (at == std::string::npos ||
            std::sscanf(received.c_str() + at, "TXBRK n=%d first=%x second=%x brk=%d us=%lld", &nb, &first, &second, &brk, &us) != 5 ||
            nb != 2 || first != 0x55 || second != 0x00 || brk != 1 || std::abs(static_cast<double>(us) - wantUs) > 30.0 + wantUs * 0.005) {
            std::fprintf(stderr, "FALHOU: break esperado n=2 first=55 second=00 brk=1 us~%.0f; veio n=%d first=%02x second=%02x brk=%d us=%lld\n",
                         wantUs, nb, first, second, brk, us);
            ++failures;
        }
    }
    int n = -1, ok = 0, idle = -1, idleInv = -1;
    const size_t atInv = received.find("INV ");
    if (atInv == std::string::npos ||
        std::sscanf(received.c_str() + atInv, "INV n=%d ok=%d idle=%d idleinv=%d", &n, &ok, &idle, &idleInv) != 4 || n != 32 ||
        !ok || idle != 1 || idleInv != 0) {
        std::fprintf(stderr, "FALHOU: inversao esperada n=32 ok=1 idle=1 idleinv=0; veio n=%d ok=%d idle=%d idleinv=%d\n", n, ok,
                     idle, idleInv);
        ++failures;
    }
    if (failures) return 1;
    std::printf("UART: paridade, 5..8 bits, 1/1,5/2 stops (DL1_EN), a inversao e os erros de paridade, quadro e break como no "
                "chip\n");
    return 0;
}

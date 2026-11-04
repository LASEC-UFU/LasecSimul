// TWAI (CAN) do ESP32 com firmware real e o driver do ESP-IDF, num barramento de um no' so': GPIO5 (TX)
// ligado ao GPIO4 (RX) e ao GPIO26 (captura do MCPWM, que marca cada borda do fio). Antes o TWAI nem
// estava mapeado: o primeiro acesso dava Guru Meditation.
//
// Fase 1 (TWAI_MODE_NO_ACK, 125 kbit/s, auto-recepcao): cada quadro tem de voltar inteiro pelo RX e o fio
// tem de ser o quadro CAN de verdade -- SOF, ID, DLC, dados, CRC-15 certo, stuffing depois de 5 bits
// iguais, delimitadores e EOF recessivos -- com cada borda na grade de 8 us.
// Fase 2 (TWAI_MODE_NORMAL, sem ninguem para dar ACK): o TEC sobe 8 por tentativa ate' 128 (error passive)
// e fica ali, a excecao 1 da regra 3 do CAN; o REC fica em 0.
//
// Firmware (LASECSIMUL_TEST_TWAI_FIRMWARE, merged.bin de vnext_prototype/guest_twai).
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

struct Frame {
    uint32_t id;
    bool ext, rtr;
    uint32_t dlc;
    std::vector<uint8_t> data;
};

// O quadro no fio: bits do SOF ao fim do CRC com stuffing, mais 10 recessivos ate' o fim do EOF.
void wireBits(const Frame& f, uint32_t& bits, uint32_t& stuff) {
    std::vector<int> d;
    const auto put = [&d](uint32_t value, int count) {
        for (int i = count - 1; i >= 0; --i) d.push_back((value >> i) & 1);
    };
    put(0, 1);
    if (f.ext) {
        put(f.id >> 18, 11);
        put(3, 2);
        put(f.id & 0x3FFFF, 18);
        put(f.rtr, 1);
        put(0, 2);
    } else {
        put(f.id, 11);
        put(f.rtr, 1);
        put(0, 2);
    }
    put(f.dlc, 4);
    if (!f.rtr)
        for (const uint8_t byte : f.data) put(byte, 8);
    uint16_t crc = 0;
    for (const int bit : d) {
        const int next = bit ^ ((crc >> 14) & 1);
        crc = static_cast<uint16_t>((crc << 1) & 0x7FFF);
        if (next) crc ^= 0x4599;
    }
    put(crc, 15);
    uint32_t run = 0, count = 0;
    stuff = 0;
    int last = -1;
    for (const int bit : d) {
        if (run == 5) {
            ++stuff;
            ++count;
            last = !last;
            run = 1;
        }
        if (bit == last) ++run;
        else { last = bit; run = 1; }
        ++count;
    }
    if (run == 5) {
        ++stuff;
        ++count;
    }
    bits = count + 10;
}

std::string hexData(const Frame& f) {
    if (f.rtr || f.data.empty()) return "-";
    std::string out;
    char byte[3];
    for (const uint8_t value : f.data) {
        std::snprintf(byte, sizeof(byte), "%02x", value);
        out += byte;
    }
    return out;
}

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_TWAI_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_TWAI_FIRMWARE (firmware do TWAI).\n");
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
    // O fio e' conferido pela captura do MCPWM, uma interrupcao a cada borda (8 us a 125 kbit/s): cada borda
    // e' uma sincronizacao, o host nao acompanha o tempo real e o modo realtime deixaria a CPU mais lenta
    // ate' a interrupcao perder bordas. O protocolo nao depende do ritmo: modo exact.
    setEnv("LASECSIMUL_ESP32_TIMING", "exact");

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
    session.connectWire(esp32, "GPIO5", esp32, "GPIO4");
    session.connectWire(esp32, "GPIO5", esp32, "GPIO26");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-twai-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
        if (received.find("TWAI fim") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    session.stopSimulation();
    std::fprintf(stderr, "%s", received.c_str());

    const std::vector<Frame> frames = {
        {0x123, false, false, 3, {0x11, 0x22, 0x33}},
        {0x1ABCDE12, true, false, 8, {0, 1, 2, 3, 4, 5, 6, 7}},
        {0x7FF, false, true, 2, {}},
        {0x000, false, false, 4, {0, 0, 0, 0}},
        {0x555, false, false, 1, {0xAA}},
    };
    int failures = 0;
    size_t at = 0;
    for (const Frame& f : frames) {
        uint32_t bits = 0, stuff = 0;
        wireBits(f, bits, stuff);
        char rx[160], wire[200];
        std::snprintf(rx, sizeof(rx), "RX id=0x%x ext=%d rtr=%d dlc=%u data=%s\n", f.id, f.ext ? 1 : 0, f.rtr ? 1 : 0, f.dlc,
                      hexData(f).c_str());
        std::snprintf(wire, sizeof(wire), "WIRE id=0x%x ext=%d rtr=%d dlc=%u data=%s crc=ok ack=1 bits=%u stuff=%u dev=0\n",
                      f.id, f.ext ? 1 : 0, f.rtr ? 1 : 0, f.dlc, hexData(f).c_str(), bits, stuff);
        const size_t rxAt = received.find(rx, at);
        const size_t wireAt = rxAt == std::string::npos ? std::string::npos : received.find(wire, rxAt);
        if (rxAt == std::string::npos || wireAt == std::string::npos) {
            std::fprintf(stderr, "FALHOU: esperado\n  %s  %s", rx, wire);
            ++failures;
            continue;
        }
        at = wireAt;
    }
    unsigned tec = 999, rec = 999, busErrors = 0;
    int state = -1;
    const size_t noAck = received.find("NOACK ");
    if (noAck == std::string::npos ||
        std::sscanf(received.c_str() + noAck, "NOACK tec=%u rec=%u state=%d bus_errors=%u", &tec, &rec, &state, &busErrors) != 4 ||
        tec != 128 || rec != 0 || state != 1 || busErrors < 16) {
        std::fprintf(stderr, "FALHOU: sem ACK esperado tec=128 rec=0 state=1 bus_errors>=16; veio tec=%u rec=%u state=%d bus_errors=%u\n",
                     tec, rec, state, busErrors);
        ++failures;
    }
    if (failures) return 1;
    std::printf("TWAI: 5 quadros CAN certos no fio e de volta pelo RX; sem ACK o TEC para em 128 (%u erros de barramento)\n",
                busErrors);
    return 0;
}

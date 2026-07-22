// Teste ponta-a-ponta opcional com firmware ESP32 REAL do usuário (o mesmo binário que ele roda
// na extensão e que produz dados embaralhados no LasecPlot). Defina LASECSIMUL_TEST_FIRMWARE para
// um merged.bin. Sem a variável o teste é pulado (CI sem o firmware específico).
//
// Achado 2026-07-22: os testes anteriores (McuUartToLasecPlotTest.cpp) provam a decodificação
// elétrica com UM byte por vez, sempre esperando o frame completo antes de enviar o próximo -- mas
// o firmware real do usuário chama Serial.print() várias vezes seguidas (">graf:", millis(), ":",
// analogValue, "|g\r\n") a cada 1ms, ou seja, os bytes saem em RAJADA, praticamente sem gap ocioso
// entre o stop bit de um byte e o start bit do próximo (uma rajada de ~20 bytes leva ~1.7ms pra
// esvaziar a 115200 baud, mas é reenfileirada a cada 1ms). Nenhum teste existente exercita esse
// padrão de rajada contínua com firmware real -- este teste fecha essa lacuna, rodando o binário
// de verdade em QEMU real e imprimindo o texto decodificado pra inspeção.
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include "mcu/McuComponent.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;

namespace {

std::string hexToText(const std::string& hex) {
    std::string out;
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        const std::string byteHex = hex.substr(i, 2);
        const auto byte = static_cast<unsigned char>(std::stoul(byteHex, nullptr, 16));
        out.push_back(static_cast<char>(byte));
    }
    return out;
}

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_FIRMWARE para o merged.bin do usuário.\n");
        return 0;
    }
    const std::filesystem::path firmware = std::filesystem::u8path(firmwareEnv);
    if (!std::filesystem::exists(firmware)) {
        std::fprintf(stderr, "FALHOU: firmware nao existe: %s\n", firmware.string().c_str());
        return 1;
    }

    const char* qemuOverride = std::getenv("LASECSIMUL_TEST_QEMU_BINARY");
    const std::filesystem::path adapterPath = ESP32_ADAPTER_DLL_PATH;
    const std::filesystem::path qemuPath =
        (qemuOverride && *qemuOverride) ? std::filesystem::u8path(qemuOverride) : std::filesystem::path(QEMU_REAL_BINARY_PATH);
    if (!std::filesystem::exists(adapterPath) || !std::filesystem::exists(qemuPath)) {
        std::fprintf(stderr, "PULADO: adapter ou QEMU real nao esta compilado/empacotado.\n");
        return 0;
    }
    const std::filesystem::path devicesLibraryPath = REAL_DEVICES_LIBRARY_JSON_PATH;
    if (!std::filesystem::exists(devicesLibraryPath)) {
        std::fprintf(stderr, "PULADO: %s nao existe.\n", devicesLibraryPath.string().c_str());
        return 0;
    }

#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "disabled");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "disabled", 1);
#endif

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

    const uint32_t esp32 = session.addComponent("test.esp32", {});

    registry::ComponentParams plotParams;
    plotParams.pinList = {{"tx", 0.0, 8.0}, {"rx", 0.0, 24.0}};
    const uint32_t plotIndex = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plotIndex, "baudrate", PropertyValue{115200.0});
    session.setProperty(plotIndex, "data_bits", PropertyValue{8.0});
    session.setProperty(plotIndex, "stop_bits", PropertyValue{1.0});
    session.setProperty(plotIndex, "parity", PropertyValue{std::string("none")});
    session.connectWire(esp32, "GPIO1", plotIndex, "rx");

    const std::string arena = "lasecsimul-firmware-lasecplot-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    mcu->loadFirmware(firmware, arena, qemuPath.string());
    session.scheduler().start();

    std::string accumulatedHex;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
    while (std::chrono::steady_clock::now() < deadline && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plotIndex)) {
            if (!snapshot->dataHex.empty()) accumulatedHex += snapshot->dataHex;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    const bool stillRunning = mcu->firmwareRunning();
    const std::string logs = mcu->qemuLogs();
    session.scheduler().pause();
    session.stopSimulation();

    const std::string text = hexToText(accumulatedHex);
    std::fprintf(stderr, "===== TEXTO DECODIFICADO (%zu bytes) =====\n%s\n===== FIM =====\n",
                 text.size(), text.c_str());

    // Conta quantas linhas batem exatamente com o formato esperado ">graf:<numero>:<numero>|g" vs.
    // quantas linhas vieram com QUALQUER outra coisa (corrompidas) -- sem regex de proposito, so
    // scan simples caractere a caractere, pra nao mascarar nenhuma variacao de corrupcao.
    int wellFormedLines = 0;
    int malformedLines = 0;
    size_t pos = 0;
    while (pos < text.size()) {
        const size_t nl = text.find('\n', pos);
        const std::string line = text.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
        pos = (nl == std::string::npos) ? text.size() : nl + 1;
        if (line.empty() || line == "\r") continue;
        std::string trimmed = line;
        if (!trimmed.empty() && trimmed.back() == '\r') trimmed.pop_back();
        bool ok = trimmed.rfind(">graf:", 0) == 0 && trimmed.size() > 6;
        if (ok) {
            size_t firstColon = trimmed.find(':', 6);
            ok = firstColon != std::string::npos && trimmed.substr(trimmed.size() - 2) == "|g";
            if (ok) {
                const std::string millisPart = trimmed.substr(6, firstColon - 6);
                const std::string valuePart = trimmed.substr(firstColon + 1, trimmed.size() - 2 - (firstColon + 1));
                for (char c : millisPart) ok = ok && std::isdigit(static_cast<unsigned char>(c));
                for (char c : valuePart) ok = ok && std::isdigit(static_cast<unsigned char>(c));
                ok = ok && !millisPart.empty() && !valuePart.empty();
            }
        }
        if (ok) ++wellFormedLines;
        else { ++malformedLines; std::fprintf(stderr, "LINHA CORROMPIDA: '%s'\n", trimmed.c_str()); }
    }

    std::fprintf(stderr,
                 "\nResultado: linhas_ok=%d linhas_corrompidas=%d qemu_alive=%s sim_ns=%llu\n",
                 wellFormedLines, malformedLines, stillRunning ? "yes" : "no",
                 static_cast<unsigned long long>(session.scheduler().nowNs()));

    if (wellFormedLines == 0) {
        std::fprintf(stderr, "FALHOU: nenhuma linha bem formada recebida. Logs QEMU:\n%s\n", logs.c_str());
        return 1;
    }
    if (malformedLines > 0) {
        std::fprintf(stderr, "FALHOU: %d linha(s) corrompida(s) de %d total.\n", malformedLines,
                     wellFormedLines + malformedLines);
        return 1;
    }
    std::fprintf(stderr, "OK: %d linhas recebidas, todas bem formadas.\n", wellFormedLines);
    return 0;
}

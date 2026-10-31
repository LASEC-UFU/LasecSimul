// Rajada de UART até o LasecPlot com firmware ESP32 real, em VNEXT_B a 1x como na extensão.
//
// Achado 2026-07-22: os testes de decodificação (McuUartToLasecPlotTest.cpp) mandam UM byte por vez
// e esperam o frame completo antes do próximo. O sketch que embaralhava o gráfico chamava
// Serial.print() várias vezes seguidas a cada 1 ms (">graf:", millis(), ":", valor, "|g\r\n"): os
// bytes saem em rajada, sem intervalo ocioso entre o stop bit de um e o start bit do seguinte.
//
// Firmware: LASECSIMUL_TEST_LASECPLOT_FIRMWARE, merged.bin de vnext_prototype/guest_lasecplot_burst
// (">graf:<millis>:<sequência>|g" sem parar). Depois do texto do boot da ROM, toda linha precisa
// chegar inteira, a sequência sem buraco nem repetição desde 0, e o fluxo a 11,52 bytes por ms do
// firmware (115200 baud, 8N1, sem intervalo), como no chip. Duas ligações, 20 s cada (o regime, não a
// partida): UART0_TX, o TX da placa DevKitC, e GPIO1, o mesmo U0TXD no pino do chip avulso
// (LASECSIMUL_TEST_LASECPLOT_PIN escolhe uma). Sem a variável o teste é pulado.
//
// Com LASECSIMUL_TEST_EXPECTED_LINE o mesmo executável confere outro firmware
// (scripts/test-esp32-led-uart.ps1): a linha esperada repetida na UART0 e o GPIO13 alternando.
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <vector>
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
    for (size_t i = 0; i + 1 < hex.size(); i += 2)
        out.push_back(static_cast<char>(std::stoul(hex.substr(i, 2), nullptr, 16)));
    return out;
}

void setEnv(const char* name, const char* value) {
#ifdef _WIN32
    _putenv_s(name, value);
#else
    setenv(name, value, 1);
#endif
}

bool allDigits(std::string_view text) {
    return !text.empty() &&
           std::all_of(text.begin(), text.end(), [](char c) { return std::isdigit(static_cast<unsigned char>(c)) != 0; });
}

// ">graf:<millis>:<sequência>|g", sem regex de propósito: qualquer variação de corrupção reprova.
bool parseGraphLine(std::string_view line, unsigned long long& millis, unsigned long long& sequence) {
    constexpr std::string_view prefix = ">graf:";
    constexpr std::string_view suffix = "|g";
    if (line.size() <= prefix.size() + suffix.size() || line.substr(0, prefix.size()) != prefix ||
        line.substr(line.size() - suffix.size()) != suffix)
        return false;
    const std::string_view body = line.substr(prefix.size(), line.size() - prefix.size() - suffix.size());
    const size_t colon = body.find(':');
    if (colon == std::string_view::npos) return false;
    const std::string_view millisText = body.substr(0, colon);
    const std::string_view sequenceText = body.substr(colon + 1);
    if (!allDigits(millisText) || !allDigits(sequenceText) || millisText.size() > 12 || sequenceText.size() > 12)
        return false;
    millis = std::stoull(std::string(millisText));
    sequence = std::stoull(std::string(sequenceText));
    return true;
}

} // namespace

int runBurst(plugins::GlobalPluginCache& cache, const std::filesystem::path& firmware,
             const std::filesystem::path& qemuPath, const char* pin);

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_LASECPLOT_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_LASECPLOT_FIRMWARE (firmware de rajada para o LasecPlot).\n");
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

    const char* pinEnv = std::getenv("LASECSIMUL_TEST_LASECPLOT_PIN");
    if (std::getenv("LASECSIMUL_TEST_EXPECTED_LINE") || (pinEnv && *pinEnv))
        return runBurst(cache, firmware, qemuPath, pinEnv && *pinEnv ? pinEnv : "GPIO1") ? 1 : 0;
    int failures = 0;
    for (const char* pin : {"UART0_TX", "GPIO1"}) failures += runBurst(cache, firmware, qemuPath, pin);
    return failures ? 1 : 0;
}

// Uma sessão com o LasecPlot no `pin`; devolve o número de falhas.
int runBurst(plugins::GlobalPluginCache& cache, const std::filesystem::path& firmware,
             const std::filesystem::path& qemuPath, const char* pin) {
    std::fprintf(stderr, "== LasecPlot no %s ==\n", pin);
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
    const uint32_t plotIndex = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plotIndex, "baudrate", PropertyValue{115200.0});
    session.setProperty(plotIndex, "data_bits", PropertyValue{8.0});
    session.setProperty(plotIndex, "stop_bits", PropertyValue{1.0});
    session.setProperty(plotIndex, "parity", PropertyValue{std::string("none")});
    const uint32_t esp32 = session.addComponent("test.esp32", {});
    session.connectWire(esp32, pin, plotIndex, "rx");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-firmware-lasecplot-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    session.beginExecutionIfNeeded();
    session.scheduler().start();
    try {
        McuDebugOptions debug;
        if (const char* port = std::getenv("LASECSIMUL_TEST_GDB_PORT"))
            debug.gdbPort = static_cast<uint16_t>(std::stoi(port));
        session.loadMcuFirmware(esp32, firmware, arena, qemuPath.string(), debug);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FALHOU: firmware nao subiu: %s\n", error.what());
        session.stopSimulation();
        return 1;
    }

    std::string accumulatedHex;
    const char* expectedLine = std::getenv("LASECSIMUL_TEST_EXPECTED_LINE");
    bool previousHigh = false;
    unsigned gpioEdges = 0;
    auto lastEdge = std::chrono::steady_clock::time_point{};
    long long longestEdgeMs = 0;
    const char* durationEnv = std::getenv("LASECSIMUL_TEST_DURATION_SECONDS");
    const auto windowStart = std::chrono::steady_clock::now();
    const uint64_t windowStartSimNs = session.scheduler().nowNs();
    const auto deadline = windowStart + std::chrono::seconds(durationEnv ? std::stoi(durationEnv) : 20);
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plotIndex)) {
            if (!snapshot->dataHex.empty()) accumulatedHex += snapshot->dataHex;
        }
        if (expectedLine) {
          try {
            const bool high = session.nodeVoltageOfPin(esp32, "GPIO13") > 2.0;
            if (high != previousHigh) {
                const auto now = std::chrono::steady_clock::now();
                if (gpioEdges > 0) longestEdgeMs = std::max(longestEdgeMs,
                    std::chrono::duration_cast<std::chrono::milliseconds>(now - lastEdge).count());
                ++gpioEdges;
                previousHigh = high;
                lastEdge = now;
            }
          } catch (const std::exception&) {
              // Telemetry is non-blocking: a busy solver defers this sample.
          }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    if (const auto snapshot = session.tryDrainUartRx(plotIndex)) accumulatedHex += snapshot->dataHex;

    const bool stillRunning = mcu && mcu->firmwareRunning();
    const bool transportHealthy = mcu && !mcu->vnextArtifactFatal();
    const std::string logs = mcu ? mcu->qemuLogs() : std::string();
    const auto measuredSimNs = session.scheduler().nowNs();
    const double wallSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - windowStart).count();
    const double rate = wallSeconds > 0 ? static_cast<double>(measuredSimNs - windowStartSimNs) / 1e9 / wallSeconds : 0.0;
    session.scheduler().pause();
    session.stopSimulation();
    // Com LASECSIMUL_LOCKSTEP_TRACE=1 o QEMU registra o controlador de tempo real ([RT]) no log.
    if (std::getenv("LASECSIMUL_LOCKSTEP_TRACE") && !logs.empty())
        std::fprintf(stderr, "--- log do QEMU (fim) ---\n%s\n", logs.substr(logs.size() > 6000 ? logs.size() - 6000 : 0).c_str());

    const std::string text = hexToText(accumulatedHex);
    // Só as linhas completas: a última pode ter sido cortada pelo fim da janela.
    std::vector<std::string> lines;
    for (size_t pos = 0, nl; (nl = text.find('\n', pos)) != std::string::npos; pos = nl + 1) {
        std::string line = text.substr(pos, nl - pos);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        lines.push_back(std::move(line));
    }

    if (expectedLine && *expectedLine) {
        std::fprintf(stderr, "===== TEXTO DECODIFICADO (%zu bytes) =====\n%s\n===== FIM =====\n",
                     text.size(), text.c_str());
        unsigned matches = 0, bad = 0;
        bool appStarted = false;
        for (const auto& line : lines) {
            if (line == expectedLine) { ++matches; appStarted = true; }
            else if (appStarted && !line.empty()) ++bad;
        }
        const bool pass = stillRunning && transportHealthy && matches >= 8 && bad == 0 && gpioEdges >= 8 && longestEdgeMs < 1000;
        std::fprintf(stderr, "REAL_LED_UART %s lines=%u bad=%u edges=%u max_edge_ms=%lld sim_ns=%llu\n",
            pass ? "PASS" : "FAIL", matches, bad, gpioEdges, longestEdgeMs,
            static_cast<unsigned long long>(measuredSimNs));
        if (!pass) std::fprintf(stderr, "QEMU diagnostics:\n%s\n", logs.c_str());
        return pass ? 0 : 1;
    }

    // O boot da ROM escreve na mesma UART0 antes do app (no chip o LasecPlot também recebe esse
    // texto): a contagem começa na primeira linha do gráfico.
    size_t first = 0;
    unsigned long long millis = 0, sequence = 0;
    while (first < lines.size() && !parseGraphLine(lines[first], millis, sequence)) ++first;
    if (first == lines.size()) {
        std::fprintf(stderr, "FALHOU: nenhuma linha do grafico em %zu bytes (firmware vivo: %s). UART: '%s'\nQEMU:\n%s\n",
                     text.size(), stillRunning ? "sim" : "nao",
                     text.substr(text.size() > 300 ? text.size() - 300 : 0).c_str(), logs.c_str());
        return 1;
    }
    int failures = 0;
    if (sequence != 0) {
        std::fprintf(stderr, "FALHOU: a primeira linha do grafico tem sequencia %llu (as anteriores se perderam)\n", sequence);
        ++failures;
    }
    // Sem intervalo entre bytes a UART leva 10 bits por byte: 115200 / 10 = 11,52 bytes por ms.
    constexpr double kLineRateBytesPerMs = 115200.0 / 10.0 / 1000.0;
    const unsigned long long firstMillis = millis;
    unsigned long long expectedSequence = sequence + 1, previousMillis = millis, lastMillis = millis;
    size_t bytesBeforeLast = 0;  // da primeira linha do gráfico até o início da última
    size_t graphLines = 1;
    // Quanto o fluxo ficou atrás da linha a 11,52 bytes/ms, a cada 2 s do firmware: mostra onde a
    // UART parou, se parou.
    std::string drift;
    unsigned long long nextDriftMs = firstMillis + 2000;
    double previousLateMs = 0.0, largestStallMs = 0.0;
    unsigned long long largestStallAtMs = 0;
    for (size_t i = first + 1; i < lines.size(); ++i) {
        unsigned long long lineMillis = 0, lineSequence = 0;
        if (!parseGraphLine(lines[i], lineMillis, lineSequence)) {
            if (failures < 10) std::fprintf(stderr, "LINHA CORROMPIDA: '%s'\n", lines[i].c_str());
            ++failures;
            continue;
        }
        if (lineSequence != expectedSequence) {
            if (failures < 10)
                std::fprintf(stderr, "FALHOU: sequencia %llu depois de %llu (linha perdida ou repetida)\n",
                             lineSequence, expectedSequence - 1);
            ++failures;
        }
        if (lineMillis < previousMillis) {
            if (failures < 10) std::fprintf(stderr, "FALHOU: millis voltou de %llu para %llu\n", previousMillis, lineMillis);
            ++failures;
        }
        bytesBeforeLast += lines[i - 1].size() + 2;
        const double lateMs = static_cast<double>(lineMillis - firstMillis) -
                              static_cast<double>(bytesBeforeLast) / kLineRateBytesPerMs;
        if (lateMs - previousLateMs > largestStallMs) {
            largestStallMs = lateMs - previousLateMs;
            largestStallAtMs = previousMillis;
        }
        previousLateMs = lateMs;
        expectedSequence = lineSequence + 1;
        previousMillis = lastMillis = lineMillis;
        ++graphLines;
        if (lineMillis >= nextDriftMs) {
            char item[32];
            std::snprintf(item, sizeof(item), " %.1f", lateMs);
            drift += item;
            nextDriftMs += 2000;
        }
    }

    // O atraso da FIFO de TX entre o print e o fio é quase constante e se cancela na janela.
    const double spanMs = static_cast<double>(lastMillis - firstMillis);
    const double bytesPerMs = spanMs > 0 ? static_cast<double>(bytesBeforeLast) / spanMs : 0.0;
    std::fprintf(stderr, "Rajada: %zu linhas, %zu bytes em %.0f ms do firmware = %.3f bytes/ms (UART sem intervalo: %.2f); ritmo %.3fx\n",
                 graphLines, bytesBeforeLast, spanMs, bytesPerMs, kLineRateBytesPerMs, rate);
    std::fprintf(stderr, "Atraso do fluxo sobre 11,52 bytes/ms, a cada 2 s do firmware (ms):%s; maior parada %.1f ms em millis=%llu (primeira linha em %llu)\n",
                 drift.c_str(), largestStallMs, largestStallAtMs, firstMillis);
    if (graphLines < 1000) {
        std::fprintf(stderr, "FALHOU: so %zu linhas do grafico\n", graphLines);
        ++failures;
    }
    if (bytesPerMs < kLineRateBytesPerMs * 0.99 || bytesPerMs > kLineRateBytesPerMs * 1.01) {
        std::fprintf(stderr, "FALHOU: a UART nao saiu em rajada continua a 115200\n");
        ++failures;
    }
    if (!stillRunning || !transportHealthy) {
        std::fprintf(stderr, "FALHOU: firmware vivo=%s, transporte saudavel=%s\nQEMU:\n%s\n",
                     stillRunning ? "sim" : "nao", transportHealthy ? "sim" : "nao", logs.c_str());
        ++failures;
    }
    if (failures) return failures;
    std::printf("Rajada de UART ate o LasecPlot no %s: %zu linhas inteiras, sequencia continua, %.3f bytes/ms -- como no chip\n",
                pin, graphLines, bytesPerMs);
    return 0;
}

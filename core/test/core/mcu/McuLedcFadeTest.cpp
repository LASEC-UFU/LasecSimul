// Fade do LEDC por hardware com firmware ESP32 real (VNEXT_B): ledc_fade_start(LEDC_FADE_WAIT_DONE)
// só volta com a interrupção DUTY_CHNG_END, e ledc_get_duty() lê o duty em vigor (DUTY_R). Antes não
// havia motor de fade nem a interrupção ligada: o firmware ficava parado no primeiro fade.
//
// Firmware (LASECSIMUL_TEST_LEDC_FADE_FIRMWARE, merged.bin de vnext_prototype/guest_ledc_fade): HS
// timer 0 a 5 kHz/8 bits, fade 0->255
// pedido em 500 ms e 255->0 em 300 ms. O ESP-IDF converte o tempo em DUTY_CYCLE = ciclos / 255
// (9 e 5), então no chip os fades duram 9*255 e 5*255 períodos de 200 us: 459 ms e 255 ms. Imprime
// "FADE up_us=... up_duty=... down_us=... down_duty=..." pela UART0.
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

void setEnv(const char* name, const char* value) {
#ifdef _WIN32
    _putenv_s(name, value);
#else
    setenv(name, value, 1);
#endif
}

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_LEDC_FADE_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_LEDC_FADE_FIRMWARE (firmware de fade do LEDC).\n");
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
    const uint32_t esp32 = session.addComponent("test.esp32", {});
    session.connectWire(esp32, "UART0_TX", plot, "rx");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-ledc-fade-" +
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
    std::string line;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
        // A segunda linha FADE completa (a primeira pode coincidir com o fim do boot).
        size_t first = received.find("FADE up_us=");
        if (first != std::string::npos) {
            const size_t second = received.find("FADE up_us=", first + 1);
            if (second != std::string::npos) {
                const size_t end = received.find('\n', second);
                if (end != std::string::npos) {
                    line = received.substr(second, end - second);
                    break;
                }
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    session.scheduler().pause();
    session.stopSimulation();

    unsigned upUs = 0, upDuty = 0, downUs = 0, downDuty = 0;
    if (line.empty() ||
        std::sscanf(line.c_str(), "FADE up_us=%u up_duty=%u down_us=%u down_duty=%u", &upUs, &upDuty, &downUs, &downDuty) != 4) {
        std::fprintf(stderr, "FALHOU: o fade nunca terminou (ledc_fade_start nao voltou). UART: '%s'\n",
                     received.substr(received.size() > 300 ? received.size() - 300 : 0).c_str());
        return 1;
    }
    std::fprintf(stderr, "%s\n", line.c_str());
    // Período de 200 us: o primeiro passo espera o estouro seguinte (até 1 período) e a ISR acorda a
    // task logo depois -- 1 ms de folga cobre os dois sem aceitar um fade com a duração errada.
    // No modo mttcg o relógio do guest segue o do host e não fica preso ao do circuito: o fade termina
    // com o duty certo, mas a duração medida pelo firmware não é a do chip (limite documentado do modo).
    const char* executionMode = std::getenv("LASECSIMUL_ESP32_EXECUTION_MODE");
    const bool lockstepTiming = !(executionMode && std::string(executionMode) == "mttcg");
    int failures = 0;
    if (lockstepTiming && (upUs < 459'000 || upUs > 460'000 + 1'000)) { std::fprintf(stderr, "FALHOU: subida %u us (chip: 459 ms)\n", upUs); ++failures; }
    if (lockstepTiming && (downUs < 255'000 || downUs > 256'000 + 1'000)) { std::fprintf(stderr, "FALHOU: descida %u us (chip: 255 ms)\n", downUs); ++failures; }
    if (upDuty != 255 || downDuty != 0) { std::fprintf(stderr, "FALHOU: duty lido %u/%u (esperado 255/0)\n", upDuty, downDuty); ++failures; }
    if (failures) return 1;
    std::printf("LEDC fade: subida %u us, descida %u us, duty 255/0 -- como no chip\n", upUs, downUs);
    return 0;
}

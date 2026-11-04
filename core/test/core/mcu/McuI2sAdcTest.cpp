// O ADC pelo I2S0 com firmware real (I2S_MODE_ADC_BUILT_IN do driver do ESP-IDF): o controlador digital do
// SAR ADC amostra o pad em cada instante de amostra e a DMA traz os codigos. Antes o I2S era um stub e o
// APB_CTRL (onde fica o controlador digital) tambem.
//
// GPIO25 (DAC1, 128) no GPIO35 (ADC1_CH7) e o GPIO27 (LEDC 1 kHz, 50%) no GPIO34 (ADC1_CH6). Esperado: as
// amostras do I2S no canal 7 com o mesmo codigo do adc1_get_raw (12 bits, 11 dB) e o campo de canal 7; a
// quadrada a 20 kHz com uma subida a cada 20 amostras, metade em alto, e 4000 amostras em 200 ms.
//
// Firmware (LASECSIMUL_TEST_I2S_ADC_FIRMWARE, merged.bin de vnext_prototype/guest_i2s_adc).
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

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_I2S_ADC_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_I2S_ADC_FIRMWARE (firmware do ADC pelo I2S).\n");
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
    session.connectWire(esp32, "GPIO25", esp32, "GPIO35");
    session.connectWire(esp32, "GPIO27", esp32, "GPIO34");
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-i2s-adc-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
        if (received.find("ADCI fim") != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    session.stopSimulation();
    std::fprintf(stderr, "%s", received.c_str());

    int failures = 0;
    {
        int raw = -1, chanOk = -1, n = -1;
        long avg = -1;
        const size_t at = received.find("ADCDC ");
        if (at == std::string::npos ||
            std::sscanf(received.c_str() + at, "ADCDC raw=%d avg=%ld chan_ok=%d n=%d", &raw, &avg, &chanOk, &n) != 4 || raw < 1500 ||
            raw > 2500 || std::abs(avg - raw) > 3 || chanOk != n) {
            std::fprintf(stderr, "FALHOU: DC esperado avg = raw (~2000) e chan_ok = n; veio raw=%d avg=%ld chan_ok=%d n=%d\n", raw, avg,
                         chanOk, n);
            ++failures;
        }
    }
    {
        int n = -1, edges = -1, period = -1, highs = -1;
        long long us = -1;
        const size_t at = received.find("ADCSQ ");
        if (at == std::string::npos ||
            std::sscanf(received.c_str() + at, "ADCSQ n=%d edges=%d period_x100=%d highs=%d us=%lld", &n, &edges, &period, &highs, &us) !=
                5 ||
            edges < 190 || std::abs(period - 2000) > 5 || std::abs(highs - n / 2) > n / 50 || us < 190000 || us > 210000) {
            std::fprintf(stderr,
                         "FALHOU: quadrada esperada a cada 20 amostras, metade em alto, 200 ms; veio n=%d edges=%d period_x100=%d "
                         "highs=%d us=%lld\n",
                         n, edges, period, highs, us);
            ++failures;
        }
    }
    if (failures) return 1;
    std::printf("ADC pelo I2S: o codigo de cada amostra e' o do adc1_get_raw e chega no instante dela (1 kHz amostrado a "
                "20 kHz)\n");
    return 0;
}

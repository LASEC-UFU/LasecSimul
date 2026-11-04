// ADC do ESP32 com firmware real: cinco fontes de tensão fixas nos pads (ADC1 em GPIO34/35/32/33,
// ADC2 em GPIO25) e o firmware lendo cada um em todas as atenuações (0/2.5/6/11 dB) e larguras (9 a
// 12 bits). A referência é o que um ESP32 típico lê: o inverso da caracterização de linha do ESP-IDF
// com Vref de 1100 mV (components/esp_adc/esp32/adc_cali_line_fitting.c, a mesma curva que
// analogReadMilliVolts() usa num chip sem calibração no eFuse), sem o arredondamento para mV inteiros,
// e a conversão SAR guardando os bits de cima. Antes, no VNEXT_B, toda leitura dava 0: o QEMU pedia o
// valor por um caminho que só atendia GPIO_IN.
//
// Firmware (LASECSIMUL_TEST_ADC_FIRMWARE, merged.bin de vnext_prototype/guest_adc): imprime
// "ADC pin=.. atten=.. width=.. raw=.. us=.." e, por atenuação, "ADCMV pin=.. atten=.. mv=..", até
// "ADCDONE".
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include "components/other/Ground.hpp"
#include "components/sources/DcVoltageSource.hpp"
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

// ESP-IDF adc_cali_line_fitting.c (ESP32), Vref 1100 mV: raw de 12 bits -> mV.
constexpr uint32_t kScale[2][4] = {{57431, 76236, 105481, 196602}, {57236, 76175, 105678, 197170}};
constexpr uint32_t kOffset[2][4] = {{75, 78, 107, 142}, {63, 66, 89, 128}};
constexpr uint32_t kLutLow[2][20] = {
    {2240, 2297, 2352, 2405, 2457, 2512, 2564, 2616, 2664, 2709, 2754, 2795, 2832, 2868, 2903, 2937, 2969, 3000, 3030, 3060},
    {2238, 2293, 2347, 2399, 2451, 2507, 2561, 2613, 2662, 2710, 2754, 2792, 2831, 2869, 2904, 2937, 2968, 2999, 3029, 3059}};
constexpr uint32_t kLutHigh[2][20] = {
    {2667, 2706, 2745, 2780, 2813, 2844, 2873, 2901, 2928, 2956, 2982, 3006, 3032, 3059, 3084, 3110, 3135, 3160, 3184, 3209},
    {2657, 2698, 2738, 2774, 2807, 2838, 2867, 2894, 2921, 2946, 2971, 2996, 3020, 3043, 3067, 3092, 3116, 3139, 3162, 3185}};

// A curva da caracterização sem o arredondamento para mV inteiros, num código real x de 12 bits: a
// reta e, em 11 dB, a transição para a tabela no primeiro passo dela e a tabela (bilinear) acima.
double curveMv(int unit, int atten, double x) {
    const double a = static_cast<double>((1100u * kScale[unit][atten]) / 4096u) / 65536.0;
    const double linear = a * x + kOffset[unit][atten];
    if (atten != 3 || x < 2880.0) return linear;
    const double pos = (x - 2880.0) / 64.0;
    const int i = std::min(static_cast<int>(pos), 18);
    const double f = pos - i, t = 0.5; // Vref 1100 entre as tabelas de 1000 e 1200 mV
    const double low = kLutLow[unit][i] + (static_cast<double>(kLutLow[unit][i + 1]) - kLutLow[unit][i]) * f;
    const double high = kLutHigh[unit][i] + (static_cast<double>(kLutHigh[unit][i + 1]) - kLutHigh[unit][i]) * f;
    const double lut = low + (high - low) * t;
    if (x > 2944.0) return lut;
    return linear + (lut - linear) * (x - 2880.0) / 64.0;
}

// Código ideal (real) do chip típico para `mv`: o inverso da curva, preso em 0 e no fundo de escala.
// Varredura em passos de 1/64 de código, independente da bisseção do QEMU.
double idealCode(int unit, int atten, double mv) {
    if (mv <= curveMv(unit, atten, 0.0)) return 0.0;
    if (mv >= curveMv(unit, atten, 4096.0)) return 4096.0;
    double x = 0.0;
    while (x < 4096.0 && curveMv(unit, atten, x + 1.0 / 64.0) < mv) x += 1.0 / 64.0;
    return x;
}

// Conversão SAR de `width` bits: os bits de cima do código, até o maior código.
uint32_t expectedRaw(int unit, int atten, int width, double mv) {
    const uint32_t max = (1u << width) - 1u;
    return std::min(static_cast<uint32_t>(idealCode(unit, atten, mv) / static_cast<double>(1u << (12 - width))), max);
}

struct PadSource { const char* pin; int gpio; int unit; double volts; };
constexpr PadSource kPads[] = {
    {"GPIO34", 34, 0, 0.10}, {"GPIO35", 35, 0, 0.50}, {"GPIO32", 32, 0, 1.20}, {"GPIO33", 33, 0, 2.00}, {"GPIO25", 25, 1, 2.80},
};

} // namespace

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_ADC_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_ADC_FIRMWARE (firmware do ADC).\n");
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
    double nextVolts = 0.0;
    session.components().registerFactory("test.dc", [&nextVolts](const registry::ComponentParams&) {
        return std::make_unique<components::DcVoltageSource>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}}, nextVolts);
    });
    session.components().registerFactory("other.ground", [](const registry::ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
    registry::ComponentParams plotParams;
    plotParams.pinList = {{"tx", 0.0, 8.0}, {"rx", 0.0, 24.0}};
    const uint32_t plot = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plot, "baudrate", PropertyValue{115200.0});
    const uint32_t esp32 = session.addComponent("test.esp32", {});
    const uint32_t ground = session.addComponent("other.ground", {});
    session.connectWire(esp32, "UART0_TX", plot, "rx");
    for (const PadSource& pad : kPads) {
        nextVolts = pad.volts;
        const uint32_t source = session.addComponent("test.dc", {});
        session.connectWire(source, "p1", esp32, pad.pin);
        session.connectWire(source, "p2", ground, "pin");
    }
    session.scheduler().setRealTimeRate(1.0);

    const std::string arena = "lasecsimul-adc-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
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
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning() &&
           received.find("ADCDONE") == std::string::npos) {
        if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    session.scheduler().pause();
    if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
    session.stopSimulation();
    if (received.find("ADCDONE") == std::string::npos) {
        std::fprintf(stderr, "FALHOU: o firmware nao terminou uma passada. UART: '%s'\n",
                     received.substr(received.size() > 300 ? received.size() - 300 : 0).c_str());
        return 1;
    }
    received.resize(received.find("ADCDONE")); // só a primeira passada

    std::map<int, const PadSource*> byGpio;
    for (const PadSource& pad : kPads) byGpio[pad.gpio] = &pad;
    int failures = 0, checked = 0;
    unsigned maxUs = 0;
    for (size_t at = received.find("ADC pin="); at != std::string::npos; at = received.find("ADC pin=", at + 1)) {
        int gpio = 0, atten = 0, width = 0, raw = 0;
        unsigned us = 0;
        if (std::sscanf(received.c_str() + at, "ADC pin=%d atten=%d width=%d raw=%d us=%u", &gpio, &atten, &width, &raw, &us) != 5) continue;
        const auto it = byGpio.find(gpio);
        if (it == byGpio.end()) continue;
        const uint32_t expected = expectedRaw(it->second->unit, atten, width, it->second->volts * 1000.0);
        ++checked;
        maxUs = std::max(maxUs, us);
        // +-1 código: o QEMU inverte a curva por bisseção, este teste por varredura.
        if (std::abs(raw - static_cast<int>(expected)) > 1) {
            if (++failures <= 12)
                std::fprintf(stderr, "FALHOU: GPIO%d %.2f V atten=%d width=%d: leu %d, esperado %u\n", gpio,
                             it->second->volts, atten, width, raw, expected);
        }
    }
    // Conferência independente: a calibração do próprio ESP-IDF, rodando no guest, devolve a tensão de
    // entrada -- presa à faixa da atenuação (abaixo do offset o ADC lê o piso, acima do fundo de escala
    // satura).
    int checkedMv = 0;
    for (size_t at = received.find("ADCMV pin="); at != std::string::npos; at = received.find("ADCMV pin=", at + 1)) {
        int gpio = 0, atten = 0;
        unsigned mv = 0;
        if (std::sscanf(received.c_str() + at, "ADCMV pin=%d atten=%d mv=%u", &gpio, &atten, &mv) != 3) continue;
        const auto it = byGpio.find(gpio);
        if (it == byGpio.end()) continue;
        const double expectedMv = std::clamp(it->second->volts * 1000.0, curveMv(it->second->unit, atten, 0.0),
                                             curveMv(it->second->unit, atten, 4095.0));
        ++checkedMv;
        if (std::fabs(mv - expectedMv) > 2.0) {
            std::fprintf(stderr, "FALHOU: analogReadMilliVolts GPIO%d %.2f V atten=%d: %u mV, esperado %.0f\n", gpio,
                         it->second->volts, atten, mv, expectedMv);
            ++failures;
        }
    }
    std::fprintf(stderr, "leituras conferidas=%d (mV %d) erradas=%d, maior analogRead=%u us\n", checked, checkedMv,
                 failures, maxUs);
    if (checked != 4 * 4 * 5 || checkedMv != 4 * 5) {
        std::fprintf(stderr, "FALHOU: esperado 80 leituras e 20 em mV, conferidas %d e %d\n", checked, checkedMv);
        return 1;
    }
    if (failures) return 1;
    std::printf("ADC: 80 leituras (4 atenuacoes x 4 larguras x 5 pads) iguais ao ESP32 tipico; "
                "analogReadMilliVolts devolve a entrada nas 4 atenuacoes\n");
    return 0;
}

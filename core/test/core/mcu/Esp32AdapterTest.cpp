// Carrega o adapter.dll REAL compilado de mcu-adapters/espressif-esp32/ (mcu_abi.h major 2+)
// atraves do PluginLoader de producao e confirma o contrato principal do adapter ESP32 via plugin:
// chipId, launch args, regioes MMIO, pinMap, e os QemuModules concretos devolvidos por
// createModules(). Alem do GPIO simples, este teste agora verifica tambem a presenca do IOMUX e o
// roteamento temporizado de UART0 TX/RX via IOMUX/GPIO matrix.
#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <string>
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"

using namespace lasecsimul;
using namespace lasecsimul::plugins;

namespace {

int failures = 0;

#define TEST_ASSERT(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

bool containsArg(const QemuLaunchSpec& spec, const std::string& value) {
    return std::find(spec.args.begin(), spec.args.end(), value) != spec.args.end();
}

} // namespace

int main() {
    std::fprintf(stderr, "=== Esp32AdapterTest (via plugin) ===\n");

#ifndef ESP32_ADAPTER_DLL_PATH
#error "ESP32_ADAPTER_DLL_PATH precisa ser definido pelo CMakeLists (caminho do adapter.dll real)"
#endif
    const std::filesystem::path dllPath = ESP32_ADAPTER_DLL_PATH;
    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr,
                     "PULADO: %s nao existe -- rode 'npm run build:mcu-adapters' antes deste teste.\n",
                     dllPath.string().c_str());
        return 0;
    }

    GlobalPluginCache cache;
    std::shared_ptr<PluginModule> module;
    try {
        module = cache.loader().loadMcuPlugin(dllPath);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: loadMcuPlugin lancou: %s\n", e.what());
        return 1;
    }
    TEST_ASSERT(module != nullptr, "loadMcuPlugin devolve um PluginModule real");
    cache.setActiveMcuModule("espressif.esp32", module);

    PluginRuntime runtime(cache);
    const std::unique_ptr<IMcuAdapter> adapter = runtime.createMcuAdapter("espressif.esp32");
    TEST_ASSERT(adapter != nullptr, "PluginRuntime cria um IMcuAdapter real a partir do plugin");
    if (!adapter) {
        std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", ++failures);
        return 1;
    }

    TEST_ASSERT(std::string(adapter->chipId()) == "espressif.esp32", "chipId is espressif.esp32");

    const QemuLaunchSpec launch = adapter->buildLaunchArgs("build/blink.bin");
    TEST_ASSERT(launch.binary == "qemu-system-xtensa", "QEMU binary is Xtensa");
    TEST_ASSERT(containsArg(launch, "qemu-system-xtensa"),
                "launch args include conventional argv[0] for QEMU itself");
    TEST_ASSERT(containsArg(launch, "-M"), "launch args include -M flag");
    TEST_ASSERT(containsArg(launch, "esp32-simul"), "launch args include esp32-simul machine");
    TEST_ASSERT(containsArg(launch, "-display") && containsArg(launch, "none"),
                "QEMU runs headless and does not depend on a packaged keymap");
    TEST_ASSERT(containsArg(launch, "file=build/blink.bin,if=mtd,format=raw"),
                "launch args include firmware drive");
    TEST_ASSERT(!containsArg(launch, "-nic"),
                "adapter base launch is network-neutral; Core adds OpenETH only when explicitly enabled");

    const auto regions = adapter->memoryRegions();
    const auto gpioRegion = std::find_if(regions.begin(), regions.end(), [](const MemoryRegion& region) {
        return region.moduleKind == ModuleKind::Gpio && region.moduleIndex == 0;
    });
    const auto ioMuxRegion = std::find_if(regions.begin(), regions.end(), [](const MemoryRegion& region) {
        return region.moduleKind == ModuleKind::IoMux && region.moduleIndex == 0;
    });
    TEST_ASSERT(gpioRegion != regions.end(), "GPIO memory region exists");
    TEST_ASSERT(gpioRegion != regions.end() && gpioRegion->start == 0x3FF44000 && gpioRegion->end == 0x3FF44FFF,
                "GPIO memory region uses ESP32 MMIO range");
    TEST_ASSERT(ioMuxRegion != regions.end(), "IOMUX memory region exists");
    TEST_ASSERT(ioMuxRegion != regions.end() && ioMuxRegion->start == 0x3FF49000 && ioMuxRegion->end == 0x3FF49FFF,
                "IOMUX memory region uses ESP32 MMIO range");

    const auto pins = adapter->pinMap();
    const auto gpio2 =
        std::find_if(pins.begin(), pins.end(), [](const PinMapping& pin) { return pin.pinId == "GPIO2"; });
    TEST_ASSERT(gpio2 != pins.end(), "pin map contains GPIO2");
    TEST_ASSERT(gpio2 != pins.end() && gpio2->moduleKind == ModuleKind::Gpio && gpio2->bitOrLine == 2,
                "GPIO2 maps to GPIO bit 2");

    const auto modules = adapter->createModules();
    TEST_ASSERT(modules.size() == 11, "createModules() devolve GPIO/IOMUX/USART/I2C/SPI + ADC e PWM");
    bool hasGpioModule = false;
    bool hasIoMuxModule = false;
    QemuModule* gpioModule = nullptr;
    QemuModule* ioMuxModule = nullptr;
    QemuModule* uart0Module = nullptr;
    QemuModule* adcModule = nullptr;
    QemuModule* pwmModule = nullptr;
    for (const std::unique_ptr<QemuModule>& m : modules) {
        if (m->kind() == ModuleKind::Gpio && m->index() == 0 && m->owns(0x3FF44000)) {
            hasGpioModule = true;
            gpioModule = m.get();
        }
        if (m->kind() == ModuleKind::IoMux && m->index() == 0 && m->owns(0x3FF49000)) {
            hasIoMuxModule = true;
            ioMuxModule = m.get();
        }
        if (m->kind() == ModuleKind::Usart && m->index() == 0 && m->owns(0x3FF40000)) {
            uart0Module = m.get();
        }
        if (m->kind() == ModuleKind::Adc && m->index() == 0 && m->owns(0x3FF48800)) adcModule = m.get();
        if (m->kind() == ModuleKind::Pwm && m->index() == 0 && m->owns(0x3FF59000)) pwmModule = m.get();
    }
    TEST_ASSERT(hasGpioModule, "createModules() inclui um QemuModule GPIO cobrindo a faixa real");
    TEST_ASSERT(hasIoMuxModule, "createModules() inclui um QemuModule IOMUX cobrindo a faixa real");

    TEST_ASSERT(gpioModule != nullptr, "teste encontrou o modulo GPIO");
    TEST_ASSERT(ioMuxModule != nullptr, "teste encontrou o modulo IOMUX");
    TEST_ASSERT(uart0Module != nullptr, "teste encontrou o modulo UART0");
    TEST_ASSERT(adcModule != nullptr, "teste encontrou o modulo ADC");
    TEST_ASSERT(pwmModule != nullptr, "teste encontrou o modulo LEDC/PWM");
    if (gpioModule) {
        gpioModule->writeRegister(0x3FF44000 + 0x20, 1u << 2);
        gpioModule->writeRegister(0x3FF44000 + 0x04, 1u << 2);
        TEST_ASSERT(gpioModule->isOutputEnabled(2), "modulo via plugin marca bit 2 como saida apos ENABLE_REG");
        TEST_ASSERT(gpioModule->outputLevel(2), "modulo via plugin reporta nivel alto no bit 2 apos OUT_REG");

        // GPIO_OUT_W1TS_REG/GPIO_OUT_W1TC_REG (0x08/0x0C) e GPIO_ENABLE_W1TS_REG/W1TC_REG
        // (0x24/0x28) -- os registradores de AÇÃO reais que `digitalWrite()`/`pinMode()` do
        // ESP-IDF usam de verdade (nunca escrevem 0x04/0x20 direto), completados 2026-07-17.
        // Bit 4 (GPIO4 -- default `makeRawGpio(4)` no IOMUX, nunca sobrescrito por UART/SPI em
        // `configureIoMux()`, ao contrário do bit 3/GPIO3 que default pra U0RXD) começa em
        // 0/entrada; W1TS liga, W1TC desliga, sem afetar outros bits (bit 2 já ligado acima
        // continua intacto).
        gpioModule->writeRegister(0x3FF44000 + 0x24, 1u << 4); // ENABLE_W1TS: GPIO4 vira saida
        TEST_ASSERT(gpioModule->isOutputEnabled(4), "GPIO_ENABLE_W1TS_REG liga o bit 4 como saida");
        TEST_ASSERT(gpioModule->isOutputEnabled(2), "GPIO_ENABLE_W1TS_REG nao mexe no bit 2 ja ligado");
        gpioModule->writeRegister(0x3FF44000 + 0x08, 1u << 4); // OUT_W1TS: GPIO4 vai a nivel alto
        TEST_ASSERT(gpioModule->outputLevel(4), "GPIO_OUT_W1TS_REG liga o bit 4 (nivel alto)");
        gpioModule->writeRegister(0x3FF44000 + 0x0C, 1u << 4); // OUT_W1TC: GPIO4 volta a nivel baixo
        TEST_ASSERT(!gpioModule->outputLevel(4), "GPIO_OUT_W1TC_REG desliga o bit 4 (nivel baixo)");
        TEST_ASSERT(gpioModule->outputLevel(2), "GPIO_OUT_W1TC_REG do bit 4 nao mexe no nivel do bit 2");
        gpioModule->writeRegister(0x3FF44000 + 0x28, 1u << 4); // ENABLE_W1TC: GPIO4 volta a entrada
        TEST_ASSERT(!gpioModule->isOutputEnabled(4), "GPIO_ENABLE_W1TC_REG desliga o bit 4 (volta a entrada)");
        TEST_ASSERT(gpioModule->isOutputEnabled(2), "GPIO_ENABLE_W1TC_REG do bit 4 nao mexe no bit 2");

        if (ioMuxModule) ioMuxModule->writeRegister(0x3FF49000 + 0x88, 0);
        TEST_ASSERT(gpioModule->isOutputEnabled(1), "IOMUX direto habilita GPIO1 como saida do U0TXD");
        TEST_ASSERT(gpioModule->outputLevel(1), "IOMUX direto roteia idle alto do U0TXD para GPIO1");

        if (ioMuxModule) ioMuxModule->writeRegister(0x3FF49000 + 0x88, 2u << 12);
        gpioModule->writeRegister(0x3FF44000 + 0x530 + 4, 14u);
        TEST_ASSERT(gpioModule->isOutputEnabled(1), "GPIO matrix habilita GPIO1 como saida do U0TXD");
        TEST_ASSERT(gpioModule->outputLevel(1), "GPIO matrix roteia U0TXD para GPIO1");

        if (ioMuxModule) ioMuxModule->writeRegister(0x3FF49000 + 0x88, 0);
        if (uart0Module) uart0Module->writeRegister(0x3FF40000 + 0x14, 5'000u);
        if (uart0Module) uart0Module->writeRegister(0x3FF40000 + 0x00, 0x55u);
        TEST_ASSERT(gpioModule->isOutputEnabled(1), "UART0 TX temporizado continua roteado para GPIO1");
        TEST_ASSERT(!gpioModule->outputLevel(1), "UART0 FIFO inicia start bit baixo em GPIO1");
        TEST_ASSERT(uart0Module && uart0Module->nextWakeupDelayNs() == 5'000u,
                    "UART0 agenda wakeup usando bit time escrito em UART_CLKDIV");
        if (uart0Module) uart0Module->onWakeup(5'000u);
        TEST_ASSERT(gpioModule->outputLevel(1), "UART0 wakeup avanca para primeiro bit de dados alto");

        if (uart0Module) uart0Module->reset();
        if (uart0Module) uart0Module->writeRegisterAt(0x3FF40000 + 0x14, 5'000u, 0);
        gpioModule->setInputLevelAt(3, true, 0);
        if (ioMuxModule) ioMuxModule->writeRegisterAt(0x3FF49000 + 0x84, 0, 0);
        gpioModule->setInputLevelAt(3, false, 0);
        TEST_ASSERT(uart0Module && uart0Module->nextWakeupDelayNs(0) == 2'500u,
                    "UART0 RX agenda amostra no meio do start bit");

        if (uart0Module) uart0Module->onWakeup(2'500u);
        TEST_ASSERT(uart0Module && uart0Module->nextWakeupDelayNs(2'500u) == 5'000u,
                    "UART0 RX agenda primeira amostra de dado um bit depois");

        const bool rxBits[8] = {true, false, true, false, false, true, false, true}; // 0xA5, LSB first
        for (uint32_t i = 0; i < 8; ++i) {
            const uint64_t sampleNs = 7'500u + (static_cast<uint64_t>(i) * 5'000u);
            gpioModule->setInputLevelAt(3, rxBits[i], sampleNs);
            if (uart0Module) uart0Module->onWakeup(sampleNs);
        }
        gpioModule->setInputLevelAt(3, true, 47'500u);
        if (uart0Module) uart0Module->onWakeup(47'500u);
        TEST_ASSERT(uart0Module && (uart0Module->readRegister(0x3FF40000 + 0x1C) & 0xFFu) == 1u,
                    "UART0 RX coloca um byte no RX FIFO apos stop bit valido");
        TEST_ASSERT(uart0Module && uart0Module->readRegister(0x3FF40000 + 0x00) == 0xA5u,
                    "UART0 FIFO le o byte recebido 0xA5");
        TEST_ASSERT(uart0Module && (uart0Module->readRegister(0x3FF40000 + 0x1C) & 0xFFu) == 0u,
                    "UART0 RX FIFO decrementa apos leitura");

        // ADC1 canal 6 = GPIO34. A tensao analogica nao pode ser reduzida a HIGH/LOW na ABI.
        gpioModule->setInputVoltageAt(34, 1.65, 0);
        if (adcModule) adcModule->writeRegister(0x3FF48800 + 0x54, uint64_t(1u << 6u) << 19u);
        const uint64_t adcHalfScale = adcModule ? adcModule->readRegister(0x3FF48800 + 0x54) : 0;
        TEST_ASSERT(adcHalfScale >= 2047 && adcHalfScale <= 2048,
                    "ADC1 converte 1,65 V no GPIO34 para aproximadamente meia escala de 12 bits");
        // START/FORCE sem bitmap de canal e' uma escrita de controle normal do ESP-IDF e nao
        // significa selecionar ADC1_CH0. O canal 6 deve permanecer retido ate outra selecao real.
        if (adcModule) adcModule->writeRegister(0x3FF48800 + 0x54, 0x00000000u);
        const uint64_t adcAfterControlWrite = adcModule ? adcModule->readRegister(0x3FF48800 + 0x54) : 0;
        TEST_ASSERT(adcAfterControlWrite >= 2047 && adcAfterControlWrite <= 2048,
                    "ADC preserva o canal selecionado em escritas START/FORCE sem bitmap");

        // LEDC HS channel 0, 1 kHz/8 bits, roteado pelo sinal 71 da GPIO Matrix ao GPIO27.
        if (ioMuxModule) ioMuxModule->writeRegister(0x3FF49000 + 0x2C, 2u << 12u);
        gpioModule->writeRegister(0x3FF44000 + 0x530 + 27u * 4u, 71u);
        if (pwmModule) {
            pwmModule->writeRegisterAt(0x3FF59000 + 0x140, 8u | (80'000u << 5u) | 0x02000000u, 0);
            pwmModule->writeRegisterAt(0x3FF59000 + 0x000, 0, 0);
            pwmModule->writeRegisterAt(0x3FF59000 + 0x008, 128u << 4u, 0);
        }
        TEST_ASSERT(gpioModule->isOutputEnabled(27), "GPIO Matrix habilita GPIO27 como saida LEDC");
        TEST_ASSERT(gpioModule->outputLevel(27), "PWM de 50% inicia no nivel alto");
        TEST_ASSERT(pwmModule && pwmModule->nextWakeupDelayNs(0) >= 499'000u &&
                        pwmModule->nextWakeupDelayNs(0) <= 501'000u,
                    "PWM de 1 kHz/50% agenda a borda em aproximadamente 500 us");
        if (pwmModule) pwmModule->onWakeup(500'000u);
        TEST_ASSERT(!gpioModule->outputLevel(27), "borda do PWM alterna GPIO27 para nivel baixo");
    }

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}

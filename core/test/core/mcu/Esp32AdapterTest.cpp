// Carrega o adapter.dll REAL compilado de mcu-adapters/espressif-esp32/ (mcu_abi.h major 2+)
// atraves do PluginLoader de producao e confirma o contrato principal do adapter ESP32 via plugin:
// chipId, launch args, regioes MMIO, pinMap, e os QemuModules concretos devolvidos por
// createModules(). Alem do GPIO simples, este teste agora verifica tambem a presenca do IOMUX e o
// roteamento temporizado de UART0 TX/RX via IOMUX/GPIO matrix.
#include <algorithm>
#include <cstdlib>
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

bool containsArgPair(const QemuLaunchSpec& spec, const std::string& option,
                     const std::string& value) {
    for (size_t i = 0; i + 1 < spec.args.size(); ++i) {
        if (spec.args[i] == option && spec.args[i + 1] == value) return true;
    }
    return false;
}

void setExecutionMode(const char* mode) {
#if defined(_WIN32)
    _putenv_s("LASECSIMUL_ESP32_EXECUTION_MODE", mode ? mode : "");
#else
    if (mode) setenv("LASECSIMUL_ESP32_EXECUTION_MODE", mode, 1);
    else unsetenv("LASECSIMUL_ESP32_EXECUTION_MODE");
#endif
}

// Avanca o motor temporizado de um modulo (I2C/SPI/USART/...) chamando onWakeup() no proximo
// instante que o proprio modulo pediu, ate' `steps` vezes ou ate' ele nao ter mais nada agendado
// (kNoWakeup) -- devolve o `nowNs` final. `onEdge` roda depois de CADA onWakeup, com o novo
// `nowNs`, pra o chamador poder inspecionar/perturbar o estado eletrico exatamente entre dois
// passos do motor (ex: simular um escravo puxando SDA pra baixo na janela de ACK).
template <typename OnEdge>
uint64_t pumpWakeups(QemuModule* module, uint64_t nowNs, int steps, OnEdge onEdge) {
    for (int i = 0; i < steps; ++i) {
        const uint64_t delay = module->nextWakeupDelayNs(nowNs);
        if (delay == QemuModule::kNoWakeup) break;
        nowNs += delay;
        module->onWakeup(nowNs);
        onEdge(nowNs);
    }
    return nowNs;
}

} // namespace

int main() {
    std::fprintf(stderr, "=== Esp32AdapterTest (via plugin) ===\n");
    setExecutionMode(nullptr);

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
    TEST_ASSERT(containsArgPair(launch, "-accel", "tcg,thread=single"),
                "default launch explicitly keeps one deterministic TCG thread");
    TEST_ASSERT(containsArg(launch, "-icount"),
                "default deterministic launch retains instruction-counted virtual time");

    setExecutionMode("mttcg");
    const QemuLaunchSpec mttcgLaunch = adapter->buildLaunchArgs("build/blink.bin");
    TEST_ASSERT(containsArgPair(mttcgLaunch, "-accel", "tcg,thread=multi"),
                "opt-in MTTCG launch requests one host thread per ESP32 vCPU");
    TEST_ASSERT(!containsArg(mttcgLaunch, "-icount"),
                "MTTCG launch removes incompatible -icount");
    setExecutionMode(nullptr);

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
    QemuModule* i2c0Module = nullptr;
    QemuModule* spiModule = nullptr;
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
        if (m->kind() == ModuleKind::I2c && m->index() == 0 && m->owns(0x3FF53000)) i2c0Module = m.get();
        if (m->kind() == ModuleKind::Spi && m->index() == 0 && m->owns(0x3FF64000)) spiModule = m.get();
    }
    TEST_ASSERT(hasGpioModule, "createModules() inclui um QemuModule GPIO cobrindo a faixa real");
    TEST_ASSERT(hasIoMuxModule, "createModules() inclui um QemuModule IOMUX cobrindo a faixa real");

    TEST_ASSERT(gpioModule != nullptr, "teste encontrou o modulo GPIO");
    TEST_ASSERT(ioMuxModule != nullptr, "teste encontrou o modulo IOMUX");
    TEST_ASSERT(uart0Module != nullptr, "teste encontrou o modulo UART0");
    TEST_ASSERT(adcModule != nullptr, "teste encontrou o modulo ADC");
    TEST_ASSERT(pwmModule != nullptr, "teste encontrou o modulo LEDC/PWM");
    TEST_ASSERT(i2c0Module != nullptr, "teste encontrou o modulo I2C0");
    TEST_ASSERT(spiModule != nullptr, "teste encontrou o modulo SPI (HSPI)");
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

        // ---- Pull-up/pull-down interno real (IO_MUX FUN_PU/FUN_PD, bits 8/7) -- GPIO4, offset
        // 0x48 (ver getIoMuxPin) ----
        TEST_ASSERT(gpioModule->pullState(4) == QemuModule::PullState::None,
                    "GPIO4 sem FUN_PU/FUN_PD comeca sem pull nenhum");
        if (ioMuxModule) ioMuxModule->writeRegister(0x3FF49000 + 0x48, 1u << 8); // FUN_PU
        TEST_ASSERT(gpioModule->pullState(4) == QemuModule::PullState::Up,
                    "IO_MUX FUN_PU liga o pull-up interno real do GPIO4");
        if (ioMuxModule) ioMuxModule->writeRegister(0x3FF49000 + 0x48, 1u << 7); // FUN_PD
        TEST_ASSERT(gpioModule->pullState(4) == QemuModule::PullState::Down,
                    "IO_MUX FUN_PD liga o pull-down interno real do GPIO4");
        if (ioMuxModule) ioMuxModule->writeRegister(0x3FF49000 + 0x48, (1u << 7) | (1u << 8));
        TEST_ASSERT(gpioModule->pullState(4) == QemuModule::PullState::UpAndDown,
                    "FUN_PU e FUN_PD juntos (fisicamente validos) reportam os dois habilitados");
        if (ioMuxModule) ioMuxModule->writeRegister(0x3FF49000 + 0x48, 0);
        TEST_ASSERT(gpioModule->pullState(4) == QemuModule::PullState::None,
                    "limpar FUN_PU/FUN_PD desliga o pull de novo");

        // ---- Open-drain real (GPIO_PINn_REG bit2 = PAD_DRIVER) -- mesmo GPIO4, agora como saida ----
        gpioModule->writeRegister(0x3FF44000 + 0x20, 1u << 4); // GPIO_ENABLE_REG: GPIO4 = saida
        gpioModule->writeRegister(0x3FF44000 + 0x04, 1u << 4); // GPIO_OUT_REG: GPIO4 = alto
        TEST_ASSERT(gpioModule->isOutputEnabled(4) && gpioModule->outputLevel(4),
                    "GPIO4 normal (push-pull) dirige nivel alto de verdade, sem PAD_DRIVER");

        gpioModule->writeRegister(0x3FF44000 + 0x88 + 4u * 4u, 1u << 2); // GPIO_PIN4_REG: PAD_DRIVER
        TEST_ASSERT(!gpioModule->isOutputEnabled(4),
                    "open-drain (PAD_DRIVER=1) libera o pino em vez de dirigir nivel alto");
        TEST_ASSERT(gpioModule->outputLevel(4),
                    "outputLevel() continua reportando o nivel pretendido (alto) mesmo liberado");

        gpioModule->writeRegister(0x3FF44000 + 0x04, 0); // GPIO_OUT_REG: GPIO4 = baixo
        TEST_ASSERT(gpioModule->isOutputEnabled(4) && !gpioModule->outputLevel(4),
                    "open-drain continua dirigindo o nivel baixo normalmente (so' o alto e' liberado)");

        gpioModule->writeRegister(0x3FF44000 + 0x88 + 4u * 4u, 0); // desliga PAD_DRIVER
        gpioModule->writeRegister(0x3FF44000 + 0x28, 1u << 4); // ENABLE_W1TC: GPIO4 volta a entrada
    }

    if (i2c0Module) {
        constexpr uint64_t kI2cBase = 0x3FF53000;
        constexpr uint32_t kSclLine = 0, kSdaLine = 1;
        constexpr uint64_t kCmd0 = kI2cBase + 0x58;
        constexpr uint64_t kCmd1 = kI2cBase + 0x58 + 4;
        constexpr uint64_t kCmd2 = kI2cBase + 0x58 + 8;
        constexpr uint64_t kCmd3 = kI2cBase + 0x58 + 12;
        constexpr uint64_t kCmd4 = kI2cBase + 0x58 + 16;
        constexpr uint32_t kOpRstart = 0u << 11, kOpWrite = 1u << 11, kOpRead = 2u << 11, kOpStop = 3u << 11;
        constexpr uint32_t kAckVal = 1u << 10; // NACK pedido pelo mestre neste byte de leitura

        // I2C_LOW_PERIOD (offset 0x00) -- esp32_i2c_updt_frequency (fork QEMU) espelha aqui o
        // periodo de BIT COMPLETO real (ns) calculado do clock configurado -- 2500ns/bit = 400kHz.
        i2c0Module->writeRegister(kI2cBase + 0x00, 2500u);

        // TRANS_START (I2C_CTR bit 5) -- inicio de uma transacao logica nova; sem operacao nenhuma
        // ainda enfileirada, o motor mestre deve continuar ocioso (achado real 2026-07-25: um
        // adaptador anterior, so' de GPIO puro, nunca sequer tinha estes registradores
        // implementados -- toda escrita de registrador I2C do QEMU era descartada em silencio, e
        // o firmware "via" a transacao completar sem erro mesmo sem nenhum bit real no barramento).
        i2c0Module->writeRegister(kI2cBase + 0x04, 1u << 5);
        TEST_ASSERT(!i2c0Module->isOutputEnabled(kSclLine), "I2C fica ocioso ate' a 1a operacao chegar");

        // ---- Escrita: RSTART + WRITE(endereco+W=0x78) + WRITE(0xAA) + STOP ----
        // Mesma sequencia de opcodes que esp32_i2c_do_transaction (fork QEMU) gera e espelha pra'
        // cada opcode que seu proprio motor de FIFO/comando processa -- RSTART cobre tanto o
        // PRIMEIRO START quanto qualquer repeated-START (eletricamente identicos).
        i2c0Module->writeRegisterAt(kCmd0, kOpRstart, 0);
        TEST_ASSERT(i2c0Module->isOutputEnabled(kSclLine) && !i2c0Module->outputLevel(kSclLine),
                    "RSTART comeca com SCL baixo (preparo antes de soltar SDA)");
        TEST_ASSERT(i2c0Module->isOutputEnabled(kSdaLine) && i2c0Module->outputLevel(kSdaLine),
                    "RSTART solta/sobe SDA primeiro (RestartRelease)");

        i2c0Module->writeRegisterAt(kCmd1, kOpWrite | 0x78u, 0);
        i2c0Module->writeRegisterAt(kCmd2, kOpWrite | 0xAAu, 0);
        i2c0Module->writeRegisterAt(kCmd3, kOpStop, 0);

        uint64_t now = 0;
        int sclRises = 0;
        bool wasSclHigh = false; // SCL comeca baixo (RestartRelease, ja' visivel acima)
        bool sawStartEdge = false;
        now = pumpWakeups(i2c0Module, now, 80, [&](uint64_t) {
            const bool isHigh = i2c0Module->outputLevel(kSclLine);
            if (!wasSclHigh && isHigh) ++sclRises;
            wasSclHigh = isHigh;
            // A borda do START/repeated-START (SDA cai com SCL JA' alto) so' acontece uma vez, bem
            // no meio da sequencia RestartRelease->RestartClockHigh->StartFall->StartSettle.
            if (isHigh && !i2c0Module->outputLevel(kSdaLine) && i2c0Module->isOutputEnabled(kSdaLine)) {
                sawStartEdge = true;
            }
            // SDA liberado (nao mais dirigido pelo mestre) so' acontece na janela de ACK do
            // escravo -- simula o escravo (ex: outputs.ssd1306 endereçado) puxando pra baixo ali.
            if (!i2c0Module->isOutputEnabled(kSdaLine)) i2c0Module->setInputLevel(kSdaLine, false);
        });
        TEST_ASSERT(sawStartEdge, "a borda real do START (SDA cai com SCL alto) acontece durante o RSTART");
        // RestartClockHigh contribui 1 pulso proprio (sobe SCL antes da borda de SDA do START) +
        // 2 bytes de escrita a 9 pulsos cada (8 bits + ACK) + StopSetup contribui mais 1 (sobe SCL
        // antes da borda de subida de SDA do STOP, ja' enfileirado e processado dentro do mesmo
        // pump de 80 passos) = 1+9+9+1 = 20.
        TEST_ASSERT(sclRises == 20, "RSTART + dois bytes de escrita + STOP gera exatamente 20 pulsos de SCL");
        TEST_ASSERT((i2c0Module->readRegister(kI2cBase + 0x08) & 1u) == 0,
                    "I2C_STATUS reporta ACK_REC=0 (ACK recebido) depois do escravo puxar SDA na janela certa");
        TEST_ASSERT(!i2c0Module->isOutputEnabled(kSclLine) && !i2c0Module->isOutputEnabled(kSdaLine),
                    "STOP libera SCL/SDA de volta pro pull-up externo do circuito do usuario");

        // ---- Leitura com repeated-START: RSTART + WRITE(endereco+R=0x79) + READ(ACK) + READ(NACK) + STOP ----
        // Mesma forma que i2c_master_write_read_device()/i2c_master_read() do ESP-IDF programam:
        // todo byte de leitura exceto o ultimo pede ACK_VAL=0 (mestre manda ACK, mais bytes vem a
        // seguir); o ULTIMO byte pede ACK_VAL=1 (mestre manda NACK, sinaliza fim da leitura).
        i2c0Module->writeRegisterAt(kI2cBase + 0x04, 1u << 5, now); // TRANS_START de uma nova transacao
        i2c0Module->writeRegisterAt(kCmd0, kOpRstart, now);
        i2c0Module->writeRegisterAt(kCmd1, kOpWrite | 0x79u, now); // endereco 0x3C com R/W=1
        i2c0Module->writeRegisterAt(kCmd2, kOpRead | 1u, now); // ACK_VAL=0 (bit10 claro) -- ACK
        i2c0Module->writeRegisterAt(kCmd3, kOpRead | kAckVal | 1u, now); // ACK_VAL=1 -- NACK (ultimo byte)
        i2c0Module->writeRegisterAt(kCmd4, kOpStop, now);

        // Avanca exatamente UM passo do motor (nextWakeupDelayNs + onWakeup) -- usado quando o
        // teste precisa intercalar leitura/escrita de sdaInput ENTRE dois passos especificos,
        // coisa que pumpWakeups (so' tem callback DEPOIS de cada onWakeup) nao permite.
        auto stepOnce = [&]() {
            const uint64_t delay = i2c0Module->nextWakeupDelayNs(now);
            now += delay;
            i2c0Module->onWakeup(now);
        };

        // Pump generico ate' o byte de endereco+R (RSTART + WRITE) terminar E a 1a operacao Read da
        // fila ser kickada -- detecta o kick pela PROPRIA borda eletrica (sdaOutputEnabled cai de
        // verdadeiro pra falso quando o Read libera SDA pro escravo dirigir, ver i2cKick), nunca
        // por contagem fixa de passos: robusto a qualquer mudanca de timing/fases no motor. Para
        // exatamente nesse ponto -- o motor fica parado em ReadBitSetup aguardando o proximo
        // avanco, que e' quem realmente amostra o bit0 (ver clockInByte abaixo).
        bool sdaReleasedForAck = false;
        bool wasSdaEnabled = true;
        bool sdaJustReleasedForRead = false;
        for (int guard = 0; guard < 200 && !sdaJustReleasedForRead; ++guard) {
            const uint64_t delay = i2c0Module->nextWakeupDelayNs(now);
            if (delay == QemuModule::kNoWakeup) break;
            now += delay;
            i2c0Module->onWakeup(now);
            const bool isSdaEnabled = i2c0Module->isOutputEnabled(kSdaLine);
            if (!isSdaEnabled && wasSdaEnabled && sdaReleasedForAck) {
                // 2a vez que SDA e' liberado (a 1a foi a janela de ACK do endereco+R, simulada
                // abaixo): so' pode ser o kick do Read -- para' aqui, sem consumir mais nada.
                sdaJustReleasedForRead = true;
            } else if (!isSdaEnabled) {
                i2c0Module->setInputLevel(kSdaLine, false); // ACK do escravo pro byte de endereco+R
                sdaReleasedForAck = true;
            }
            wasSdaEnabled = isSdaEnabled;
        }
        TEST_ASSERT(sdaReleasedForAck, "escravo confirma o endereco+R antes da leitura comecar");
        TEST_ASSERT(sdaJustReleasedForRead, "motor kicka a 1a operacao Read e libera SDA pro escravo dirigir");

        // Dois bytes simulados vindos do escravo: 0xC3 (mais bytes a seguir) e 0x5A (ultimo). Cada
        // bit: seta sdaInput, DEPOIS avanca 2 passos (ReadBitSetup amostra+sobe SCL, ReadBitHold
        // desce SCL e avanca) -- valido pq' o pump generico acima ja' deixou o motor parado
        // exatamente em ReadBitSetup (kick ja' consumido), pronto pra' amostrar o bit0 no proximo
        // avanco. IMPORTANTE: apos o ACK/NACK do mestre de CADA byte, o motor volta a Idle com uma
        // folga pendente ate' a PROXIMA operacao (proximo Read ou STOP) ser kickada -- por isso
        // "consomeGracaEKickSeguinte" roda entre bytes, senao o proximo clockInByte comecaria
        // consumindo essa folga em vez de amostrar o bit0 de verdade (mesma pegadinha do pump
        // generico acima, ver comentario logo abaixo de cada uso).
        auto clockInByte = [&](uint8_t value) {
            for (int bit = 0; bit < 8; ++bit) {
                const bool bitVal = (value & (0x80u >> bit)) != 0;
                i2c0Module->setInputLevel(kSdaLine, bitVal); // visivel pro ReadBitSetup a seguir
                stepOnce(); // ReadBitSetup: sobe SCL e amostra o bit agora
                stepOnce(); // ReadBitHold: desce SCL, avanca pro proximo bit (ou ACK, no 8o)
            }
        };
        auto masterAck = [&](bool expectNack, const char* label) {
            stepOnce(); // ReadAckSetup: sobe SCL com o ACK/NACK do mestre ja' no nivel certo
            if (expectNack) {
                TEST_ASSERT(!i2c0Module->isOutputEnabled(kSdaLine), label);
            } else {
                TEST_ASSERT(i2c0Module->isOutputEnabled(kSdaLine) && !i2c0Module->outputLevel(kSdaLine), label);
            }
            stepOnce(); // ReadAckHold: desce SCL, disponibiliza o byte recebido, volta a Idle+folga
        };

        clockInByte(0xC3);
        masterAck(false, "ACK do mestre (mais bytes a vir) dirige SDA pra baixo de verdade");
        TEST_ASSERT(i2c0Module->readRegister(kCmd0) == 0xC3u,
                    "1o byte lido (0xC3) fica disponivel via A_I2C_CMD depois do ACK do mestre");

        stepOnce(); // consome a folga pos-ACK e kicka a 2a operacao Read da fila (ver nota acima)
        clockInByte(0x5A);
        masterAck(true, "NACK do mestre (ultimo byte) libera SDA em vez de dirigir");
        TEST_ASSERT(i2c0Module->readRegister(kCmd0) == 0x5Au,
                    "2o byte lido (0x5A, ultimo) fica disponivel via A_I2C_CMD depois do NACK do mestre");

        now = pumpWakeups(i2c0Module, now, 4, [](uint64_t) {});
        TEST_ASSERT(!i2c0Module->isOutputEnabled(kSclLine) && !i2c0Module->isOutputEnabled(kSdaLine),
                    "STOP apos a leitura libera SCL/SDA de volta pro pull-up externo");

        // ---- ACK_ERR real: escravo NUNCA responde (endereco errado/ausente) ----
        // sdaInput carrega o ultimo bit lido de 0x5A (0) -- reseta pra' "liberado/alto" (pull-up
        // externo, ninguem dirigindo) antes de simular a auséncia de resposta do escravo.
        i2c0Module->setInputLevel(kSdaLine, true);
        i2c0Module->writeRegisterAt(kI2cBase + 0x04, 1u << 5, now);
        i2c0Module->writeRegisterAt(kCmd0, kOpRstart, now);
        // ACK_CHECK_EN (bit8) ligado, ACK_EXP (bit9) claro = firmware espera ACK (comportamento
        // padrao de i2c_master_write_byte com ack_en=true).
        constexpr uint32_t kAckCheckEn = 1u << 8;
        i2c0Module->writeRegisterAt(kCmd1, kOpWrite | kAckCheckEn | 0x7Eu, now); // endereco que ninguem responde
        now = pumpWakeups(i2c0Module, now, 40, [&](uint64_t) {
            // Escravo NUNCA puxa SDA pra baixo -- pull-up externo mantem alto (NACK real).
        });
        TEST_ASSERT((i2c0Module->readRegister(kI2cBase + 0x08) & 1u) == 1u,
                    "I2C_STATUS reporta ACK_REC=1 (NACK real) quando nenhum escravo responde");
        i2c0Module->writeRegisterAt(kCmd2, kOpStop, now);
        now = pumpWakeups(i2c0Module, now, 4, [](uint64_t) {});
    }

    if (spiModule) {
        constexpr uint64_t kSpiBase = 0x3FF64000; // HSPI -- ver kSpi0Start no adaptador
        constexpr uint32_t kClkLine = 0, kMosiLine = 2;

        // SPI_CLOCK_REG (offset 0x18) -- periodo de 1 bit em picossegundos, ja' convertido pelo
        // fork QEMU antes de espelhar (ver esp32_spi.c::write_clk_reg): 100ns/bit = 10 MHz.
        spiModule->writeRegister(kSpiBase + 0x18, 100'000u);
        // A_SPI_W0 (offset 0x80) -- byte da transacao: 0xA5 = 1010 0101.
        spiModule->writeRegisterAt(kSpiBase + 0x80, 0xA5u, 0);
        TEST_ASSERT(spiModule->isOutputEnabled(kClkLine) && !spiModule->outputLevel(kClkLine),
                    "SPI MODE0: SCLK comeca ocioso em baixo assim que o byte chega");
        TEST_ASSERT(spiModule->isOutputEnabled(kMosiLine) && spiModule->outputLevel(kMosiLine),
                    "MOSI ja' segura o bit mais significativo de 0xA5 antes do 1o pulso de SCLK");

        uint64_t now = 0;
        int sclkRises = 0;
        int sampledBit = -1;
        bool wasClkHigh = false;
        constexpr bool kExpectedBits[8] = {true, false, true, false, false, true, false, true}; // 0xA5, MSB->LSB
        pumpWakeups(spiModule, now, 20, [&](uint64_t) {
            const bool isHigh = spiModule->outputLevel(kClkLine);
            if (!wasClkHigh && isHigh) {
                ++sclkRises;
                ++sampledBit;
                if (sampledBit < 8) {
                    TEST_ASSERT(spiModule->outputLevel(kMosiLine) == kExpectedBits[sampledBit],
                                "MOSI mantem o bit correto na borda de subida de SCLK (amostragem MODE0)");
                }
            }
            wasClkHigh = isHigh;
        });
        TEST_ASSERT(sclkRises == 8, "um byte SPI gera exatamente 8 pulsos de SCLK");

        // ---- CS0 de hardware real (SPI_PIN_REG + inicio/fim REAL de transacao) ----
        constexpr uint32_t kCs0Line = 3; // ver kSpiCs0Line no adaptador
        TEST_ASSERT(spiModule->isOutputEnabled(kCs0Line) && spiModule->outputLevel(kCs0Line),
                    "CS0 comeca habilitado e ocioso em alto (default real: pin_reg=0x6, CS0 fora dos _DIS)");

        // A_SPI_CMD (offset 0x00) espelhado com 1 = inicio REAL de uma transacao USR (ver
        // esp32_spi_do_command, numero>=2) -- CS0 deve cair (ativo-baixo, default sem CS0_POL).
        spiModule->writeRegisterAt(kSpiBase + 0x00, 1u, 0);
        TEST_ASSERT(spiModule->isOutputEnabled(kCs0Line) && !spiModule->outputLevel(kCs0Line),
                    "CS0 cai automaticamente no inicio real da transacao, sem nenhum firmware pilotar GPIO");

        // Fim real da transacao (espelhado com 0 em esp32_spi_event quando dataBytes chega a 0).
        spiModule->writeRegisterAt(kSpiBase + 0x00, 0u, 0);
        TEST_ASSERT(spiModule->outputLevel(kCs0Line),
                    "CS0 sobe de volta automaticamente no fim real da transacao");

        // SPI_PIN_REG (offset 0x34) com CS0_DIS (bit0) -- CS0 deixa de ser pilotado pelo periferico.
        spiModule->writeRegisterAt(kSpiBase + 0x34, 1u, 0);
        TEST_ASSERT(!spiModule->isOutputEnabled(kCs0Line), "CS0_DIS desliga o CS0 de hardware");
        spiModule->writeRegisterAt(kSpiBase + 0x34, 0u, 0); // restaura CS0 habilitado
        TEST_ASSERT(spiModule->isOutputEnabled(kCs0Line), "limpar CS0_DIS reabilita o CS0 de hardware");
    }

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}

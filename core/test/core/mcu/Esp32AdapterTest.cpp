// Carrega o adapter.dll REAL compilado de mcu-adapters/espressif-esp32/ (mcu_abi.h major 2+) através
// do PluginLoader de produção e confirma o mesmo contrato que o adaptador built-in tinha antes desta
// sessão (chipId, launch args, memoryRegions, pinMap) -- e adicionalmente que createModules() (novo
// na major 2) devolve um QemuModule real via QemuModuleProxy, decodificando registrador de verdade,
// não só declarando faixa de endereço. Ver docs/17-pendencias-pos-sessao-qemu-abi.md seção 3.4 (a
// pendência que esta extensão de ABI resolve).
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
                      "PULADO: %s não existe -- rode 'npm run build:mcu-adapters' antes deste teste.\n",
                      dllPath.string().c_str());
        return 0;
    }

    GlobalPluginCache cache;
    std::shared_ptr<PluginModule> module;
    try {
        module = cache.loader().loadMcuPlugin(dllPath);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: loadMcuPlugin lançou: %s\n", e.what());
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
    TEST_ASSERT(containsArg(launch, "qemu-system-xtensa"), "launch args include conventional argv[0] for QEMU itself");
    TEST_ASSERT(containsArg(launch, "-M"), "launch args include -M flag");
    TEST_ASSERT(containsArg(launch, "esp32-simul"), "launch args include esp32-simul machine");
    TEST_ASSERT(containsArg(launch, "file=build/blink.bin,if=mtd,format=raw"), "launch args include firmware drive");

    const auto regions = adapter->memoryRegions();
    const auto gpioRegion = std::find_if(regions.begin(), regions.end(), [](const MemoryRegion& region) {
        return region.moduleKind == ModuleKind::Gpio && region.moduleIndex == 0;
    });
    TEST_ASSERT(gpioRegion != regions.end(), "GPIO memory region exists");
    TEST_ASSERT(gpioRegion != regions.end() && gpioRegion->start == 0x3FF44000 && gpioRegion->end == 0x3FF44FFF,
                "GPIO memory region uses ESP32 MMIO range");

    const auto pins = adapter->pinMap();
    const auto gpio2 = std::find_if(pins.begin(), pins.end(), [](const PinMapping& pin) { return pin.pinId == "GPIO2"; });
    TEST_ASSERT(gpio2 != pins.end(), "pin map contains GPIO2");
    TEST_ASSERT(gpio2 != pins.end() && gpio2->moduleKind == ModuleKind::Gpio && gpio2->bitOrLine == 2,
                "GPIO2 maps to GPIO bit 2");

    const auto modules = adapter->createModules();
    TEST_ASSERT(!modules.empty(), "createModules() devolve ao menos 1 módulo (GPIO) via plugin");
    bool hasGpioModule = false;
    for (const std::unique_ptr<QemuModule>& m : modules) {
        if (m->kind() == ModuleKind::Gpio && m->index() == 0 && m->owns(0x3FF44000)) hasGpioModule = true;
    }
    TEST_ASSERT(hasGpioModule, "createModules() inclui um QemuModule GPIO (via QemuModuleProxy) cobrindo a faixa real");

    // Prova que o módulo do plugin DECODIFICA registrador de verdade, não só declara faixa --
    // exatamente o que o NativeMcuAdapterProxy::createModules() de antes da major 2 não conseguia.
    for (const std::unique_ptr<QemuModule>& m : modules) {
        if (m->kind() != ModuleKind::Gpio) continue;
        m->writeRegister(0x3FF44000 + 0x20, 1u << 2); // GPIO_ENABLE_REG: bit 2 como saída
        m->writeRegister(0x3FF44000 + 0x04, 1u << 2); // GPIO_OUT_REG: bit 2 em nível alto
        TEST_ASSERT(m->isOutputEnabled(2), "módulo via plugin marca bit 2 como saída após ENABLE_REG");
        TEST_ASSERT(m->outputLevel(2), "módulo via plugin reporta nível alto no bit 2 após OUT_REG");
    }

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}

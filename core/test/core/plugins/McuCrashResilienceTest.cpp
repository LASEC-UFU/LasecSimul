// Auditoria arquitetural 2026-07-09 (Fase 3): antes desta correção, NativeMcuAdapterProxy/
// QemuModuleProxy chamavam a vtable do plugin de MCU direto, sem CrashGuard/PluginWatchdog nenhum
// -- ao contrário de NativeDeviceProxy (dispositivos ABI comuns), que já tinha essa contenção.
// Este teste prova, com uma vtable SINTÉTICA que deliberadamente desreferencia um ponteiro nulo,
// que: (1) o processo do teste sobrevive (a exceção SEH é contida, nunca derruba o Core), (2)
// NativeMcuAdapterProxy::NativeMcuAdapterProxy() lança std::runtime_error limpo quando uma chamada
// fria (get_pin_map) crasha, e (3) QemuModuleProxy::writeRegister() marca health()==Faulted em vez
// de propagar o crash quando uma chamada quente (write_register) crasha.
//
// Só roda de verdade no Windows: CrashGuard é SEH-based lá (__try/__except); no POSIX,
// CrashGuard::call() é um passthrough direto (SIGSEGV não é seguro de capturar e continuar -- ver
// CrashGuard.cpp) -- rodar este teste no POSIX derrubaria o próprio processo de teste, então ele
// sai com sucesso trivial fora do Windows (mesma convenção de teste "pulado" usada em
// McuControllerRealQemuTest.cpp).
#include <cstdio>
#include <memory>
#include <string>
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/NativeMcuAdapterProxy.hpp"
#include "plugins/PluginLoader.hpp"
#include "plugins/PluginRuntime.hpp"
#include "plugins/QemuModuleProxy.hpp"
#include "simulation/Scheduler.hpp"

#if defined(_WIN32)

using namespace lasecsimul;
using namespace lasecsimul::plugins;

namespace {

int failures = 0;
#define CHECK(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

// Desreferencia um ponteiro nulo de propósito -- em x64/MSVC isto vira EXCEPTION_ACCESS_VIOLATION,
// capturado por CrashGuard::call (__try/__except) sem derrubar o processo. `volatile` evita que o
// otimizador prove UB e elimine a escrita inteira (mesmo em Release).
void crashNow() {
    volatile int* p = nullptr;
    *p = 1;
}

struct McuState {};
struct ModuleState {};

LsdnMcuAdapter* createMcuOk(void*, const LsdnMcuHostApi*) { return reinterpret_cast<LsdnMcuAdapter*>(new McuState{}); }
LsdnQemuLaunchSpec buildLaunchArgsOk(LsdnMcuAdapter*, const char*) { return LsdnQemuLaunchSpec{"qemu-fake", nullptr, 0}; }
uint32_t getMemoryRegionsOk(LsdnMcuAdapter*, LsdnMemoryRegion*, uint32_t) { return 0; }
// Crasha já na primeira chamada (cap=0, "só contar") -- pior caso: nem chega a devolver quantos
// pinos existem.
uint32_t getPinMapCrashes(LsdnMcuAdapter*, LsdnPinMapping*, uint32_t) {
    crashNow();
    return 0;
}
void destroyMcuOk(LsdnMcuAdapter* adapter) { delete reinterpret_cast<McuState*>(adapter); }

const LsdnMcuVTable kCrashingMcuVTable = {
    &createMcuOk, &buildLaunchArgsOk, &getMemoryRegionsOk, &getPinMapCrashes, nullptr, &destroyMcuOk,
};
const LsdnMcuVTable* getCrashingMcuVTable(uint32_t* major, uint32_t* minor) {
    *major = LSDN_MCU_ABI_VERSION_MAJOR;
    *minor = LSDN_MCU_ABI_VERSION_MINOR;
    return &kCrashingMcuVTable;
}

// Segunda vtable: constrói normalmente (get_pin_map/get_memory_regions bem-comportados), mas o
// ÚNICO módulo que cria via create_modules tem um write_register que crasha -- testa o caminho
// QUENTE (QemuModuleProxy), não o de inicialização.
uint32_t getMemoryRegionsForModule(LsdnMcuAdapter*, LsdnMemoryRegion* out, uint32_t cap) {
    const LsdnMemoryRegion region{0x1000, 0x10ff, LSDN_MODULE_GPIO, 0};
    if (out && cap >= 1) out[0] = region;
    return 1;
}
uint32_t getPinMapForModule(LsdnMcuAdapter*, LsdnPinMapping* out, uint32_t cap) {
    const LsdnPinMapping pin{"GPIO2", LSDN_MODULE_GPIO, 0, 2};
    if (out && cap >= 1) out[0] = pin;
    return 1;
}
void writeRegisterCrashes(LsdnQemuModule*, uint64_t, uint64_t) { crashNow(); }
uint64_t readRegisterOk(LsdnQemuModule*, uint64_t) { return 0; }
const LsdnQemuModuleVTable kCrashingModuleVTable = {
    nullptr, &writeRegisterCrashes, &readRegisterOk, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
};
uint32_t createModulesOneCrashingModule(LsdnMcuAdapter*, LsdnQemuModuleHandle* out, uint32_t cap) {
    if (out && cap >= 1) {
        out[0] = LsdnQemuModuleHandle{LSDN_MODULE_GPIO, 0, nullptr, &kCrashingModuleVTable};
    }
    return 1;
}
const LsdnMcuVTable kModuleCrashVTable = {
    &createMcuOk, &buildLaunchArgsOk, &getMemoryRegionsForModule, &getPinMapForModule, &createModulesOneCrashingModule, &destroyMcuOk,
};
const LsdnMcuVTable* getModuleCrashVTable(uint32_t* major, uint32_t* minor) {
    *major = LSDN_MCU_ABI_VERSION_MAJOR;
    *minor = LSDN_MCU_ABI_VERSION_MINOR;
    return &kModuleCrashVTable;
}

} // namespace

int main() {
    std::fprintf(stderr, "=== McuCrashResilienceTest ===\n");

    // Caso 1: chamada FRIA (get_pin_map, dentro do construtor de NativeMcuAdapterProxy) crasha --
    // deve virar std::runtime_error limpo, nunca derrubar o processo.
    {
        GlobalPluginCache cache;
        auto module = PluginLoader::createMcuModuleFromExports(nullptr, &getCrashingMcuVTable, "mcu.crash-init");
        cache.setActiveMcuModule("test.mcu.crash-init", module);
        PluginRuntime runtime(cache);

        bool threw = false;
        try {
            auto adapter = runtime.createMcuAdapter("test.mcu.crash-init");
            (void)adapter;
        } catch (const std::exception& e) {
            threw = true;
            std::fprintf(stderr, "  [info] exceção capturada como esperado: %s\n", e.what());
        }
        CHECK(threw, "get_pin_map() crashando no construtor vira std::runtime_error, não derruba o processo");
    }

    // Prova viva de que o processo sobreviveu ao Caso 1: chega até aqui e continua funcionando.
    std::fprintf(stderr, "  [info] processo de teste sobreviveu ao Caso 1 -- CrashGuard funcionou.\n");

    // Caso 2: chamada QUENTE (write_register, dentro de um QemuModuleProxy já construído) crasha --
    // deve marcar health()==Faulted no módulo, sem lançar nem derrubar o processo (mesma política
    // documentada em QemuModuleProxy: CrashGuard sem watchdog no caminho quente).
    {
        GlobalPluginCache cache;
        auto module = PluginLoader::createMcuModuleFromExports(nullptr, &getModuleCrashVTable, "mcu.crash-module");
        cache.setActiveMcuModule("test.mcu.crash-module", module);
        PluginRuntime runtime(cache);

        auto adapter = runtime.createMcuAdapter("test.mcu.crash-module");
        CHECK(adapter != nullptr, "adapter com módulo problemático constrói normalmente (só o módulo crasha, não o adapter)");
        CHECK(adapter->health() == PluginHealthStatus::Ok, "adapter em si permanece Ok -- só o módulo crasha");

        std::vector<std::unique_ptr<QemuModule>> modules = adapter->createModules();
        CHECK(modules.size() == 1, "createModules() devolve o único módulo declarado");
        CHECK(modules[0]->health() == PluginHealthStatus::Ok, "módulo começa Ok, antes de qualquer chamada crashar");

        modules[0]->writeRegister(0x1000, 42); // crasha dentro do plugin -- não deve propagar
        CHECK(modules[0]->health() == PluginHealthStatus::Faulted, "writeRegister() crashando marca o módulo Faulted");

        // Confirma que o módulo continua utilizável depois (readRegister não crasha) -- um módulo
        // Faulted não trava o resto do McuComponent, só perde confiabilidade daquela chamada.
        const uint64_t value = modules[0]->readRegister(0x1000);
        CHECK(value == 0, "módulo Faulted continua respondendo chamadas que não crasham");
    }

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes de resiliência de MCU passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}

#else // !_WIN32

int main() {
    std::fprintf(stderr,
                  "PULADO: McuCrashResilienceTest só roda no Windows -- CrashGuard::call() no POSIX é um "
                  "passthrough direto (SIGSEGV não é seguro de capturar e continuar), rodar aqui derrubaria o "
                  "próprio processo de teste em vez de provar contenção. Ver CrashGuard.cpp.\n");
    return 0;
}

#endif

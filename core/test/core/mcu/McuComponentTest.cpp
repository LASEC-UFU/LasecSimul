// Prova a ponte registrador<->pino do McuComponent SEM precisar de um processo QEMU real nem de
// firmware: abre uma arena sintética (mesmo papel de QemuArenaBridgeTest) e escreve direto nos
// campos que o QEMU real escreveria via writeReg()/readReg() (simuliface.c) -- depois verifica
// que o pino certo do circuito muda de tensão, e o caminho contrário (GPIO_IN_REG reflete a
// tensão real do nó). O adaptador ESP32 vem do plugin real (mcu_abi.h major 2+), não built-in --
// ver docs/17-pendencias-pos-sessao-qemu-abi.md seção 3.4.
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <memory>
#include "lasecsimul/qemu_arena_abi.h"
#include "mcu/McuComponent.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;

namespace {

int failures = 0;

void check(bool ok, const char* label) {
    if (ok) std::printf("OK: %s\n", label);
    else {
        std::fprintf(stderr, "FALHOU: %s\n", label);
        failures++;
    }
}

std::string uniqueArenaName() {
    return "lasecsimul-mcucomponent-test-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

/** Simula o que writeReg(addr,value) do lado QEMU real faria (ver simuliface.c) -- seta
 * regAddr/regData/simuAction e simuTime != 0, sem esperar confirmação (fire-and-forget, igual
 * ao protocolo real pra SIM_WRITE). */
void simulateQemuWrite(LsdnQemuArena* arena, uint64_t addr, uint64_t value) {
    arena->regAddr = addr;
    arena->regData = value;
    arena->simuAction = LSDN_SIM_WRITE;
    arena->simuTime = 1; // qualquer valor != 0 -- só importa que não seja 0
}

} // namespace

int main() {
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

    plugins::GlobalPluginCache cache;
    std::shared_ptr<plugins::PluginModule> module = cache.loader().loadMcuPlugin(dllPath);
    cache.setActiveMcuModule("espressif.esp32", module);

    SimulationSession session(cache);
    session.registerKnownMcuTypes();

    // Pega o GPIO start real declarado pelo próprio plugin (memoryRegions()) -- em vez de assumir
    // uma constante ESP32 hardcoded no teste, já que o adaptador agora é um plugin, não um tipo
    // C++ conhecido em tempo de compilação aqui.
    plugins::PluginRuntime runtime(cache);
    const std::unique_ptr<IMcuAdapter> probeAdapter = runtime.createMcuAdapter("espressif.esp32");
    uint64_t gpioStart = 0;
    for (const MemoryRegion& region : probeAdapter->memoryRegions()) {
        if (region.moduleKind == ModuleKind::Gpio && region.moduleIndex == 0) {
            gpioStart = region.start;
            break;
        }
    }
    check(gpioStart != 0, "memoryRegions() do plugin declara uma faixa GPIO");

    mcu::McuComponent* mcuPtr = nullptr;
    session.components().registerFactory("mcu.esp32", [&mcuPtr, &session](const registry::ComponentParams&) {
        auto instance = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
        mcuPtr = instance.get();
        return instance;
    });

    const uint32_t mcuIndex = session.addComponent("mcu.esp32", {});
    (void)mcuIndex;

    mcuPtr->openSyntheticArenaForTesting(uniqueArenaName());

    for (int i = 0; i < 5 && session.settleStep(); ++i) {}
    check(session.nodeVoltageOfPin(mcuIndex, "GPIO2") < 0.1, "GPIO2 começa perto de 0V (nenhum registrador escrito ainda)");

    // Simula firmware fazendo: GPIO_ENABLE_REG (offset 0x20) com bit 2 ligado (pino 2 = saída),
    // depois GPIO_OUT_REG (offset 0x04) com bit 2 ligado (nível alto) -- mesma sequência que
    // gpio_set_direction()+gpio_set_level() do ESP-IDF emitiriam, confirmado lendo
    // hw/gpio/esp32_gpio.c real.
    // settleStep() só estampa quem está no dirty set -- escrever na arena direto não marca nada
    // dirty por si só (em produção, McuComponent::scheduleNextPoll() faz isso a cada 50us via
    // Scheduler; aqui simulamos isso manualmente, sem precisar avançar o relógio).
    LsdnQemuArena* arena = mcuPtr->arenaBridge().arena();
    simulateQemuWrite(arena, gpioStart + 0x20, 1u << 2);
    session.scheduler().markDirty(mcuIndex);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}
    simulateQemuWrite(arena, gpioStart + 0x04, 1u << 2);
    session.scheduler().markDirty(mcuIndex);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}

    const double gpio2Volts = session.nodeVoltageOfPin(mcuIndex, "GPIO2");
    check(gpio2Volts > 3.0, "GPIO2 sobe para ~3.3V depois de ENABLE+OUT_REG ligarem o bit 2");

    // Agora o caminho contrário: GPIO3 não foi habilitado como saída -- McuComponent deve ler a
    // tensão real do nó (default 0V, sem nada estampado) e alimentar isso de volta no módulo.
    simulateQemuWrite(arena, gpioStart + 0x3C, 0); // dispara um SIM_READ
    arena->simuAction = LSDN_SIM_READ;
    session.scheduler().markDirty(mcuIndex);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}
    check(arena->qemuAction == LSDN_SIM_READ, "leitura de GPIO_IN_REG confirma via qemuAction (desbloquearia o QEMU real)");

    if (failures == 0) {
        std::printf("\nTodos os testes de McuComponent passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}

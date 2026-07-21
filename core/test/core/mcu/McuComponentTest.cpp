// Prova a ponte registrador<->pino do McuComponent SEM precisar de um processo QEMU real nem de
// firmware: abre uma arena sintética (mesmo papel de QemuArenaBridgeTest) e escreve direto nos
// campos que o QEMU real escreveria via writeReg()/readReg() (simuliface.c) -- depois verifica
// que o pino certo do circuito muda de tensão, e o caminho contrário (GPIO_IN_REG reflete a
// tensão real do nó). O adaptador ESP32 vem do plugin real (mcu_abi.h major 2+), não built-in --
// ver docs/17-pendencias-pos-sessao-qemu-abi.md seção 3.4.
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <vector>
#include "components/active/DiodeLegArray.hpp"
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/FixedVolt.hpp"
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

/** Simula o que writeReg(addr,value) do lado QEMU real faria (protocolo v3, ver
 * qemu_arena_abi.h/simuliface.c::pushQueueEntry) -- publica uma entrada na fila de escritas/
 * heartbeat: escreve os campos da entrada e só DEPOIS incrementa queueWriteIndex (é isso que
 * torna a entrada visível pro Core), sem esperar confirmação (fire-and-forget, igual ao
 * protocolo real pra SIM_WRITE). */
void simulateQemuWrite(LsdnQemuArena* arena, uint64_t addr, uint64_t value) {
    const uint64_t slot = arena->queueWriteIndex % LSDN_QEMU_ARENA_QUEUE_DEPTH;
    arena->queue[slot].regAddr = addr;
    arena->queue[slot].regData = value;
    arena->queue[slot].simuAction = LSDN_SIM_WRITE;
    arena->queue[slot].simuTime = 1; // qualquer valor != 0 -- só importa que não seja 0
    arena->queueWriteIndex++;
}

/** Simula o que readReg(addr) do lado QEMU real faria -- protocolo v3: leitura continua fora da
 * fila, no slot único de sempre (regAddr/simuAction/simuTime/qemuAction), inalterado desde v2. */
void simulateQemuRead(LsdnQemuArena* arena, uint64_t addr) {
    arena->regAddr = addr;
    arena->qemuAction = 0;
    arena->simuAction = LSDN_SIM_READ;
    arena->simuTime = 1;
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
    uint64_t ioMuxStart = 0;
    uint64_t uart0Start = 0;
    for (const MemoryRegion& region : probeAdapter->memoryRegions()) {
        if (region.moduleKind == ModuleKind::Gpio && region.moduleIndex == 0) {
            gpioStart = region.start;
        } else if (region.moduleKind == ModuleKind::IoMux && region.moduleIndex == 0) {
            ioMuxStart = region.start;
        } else if (region.moduleKind == ModuleKind::Usart && region.moduleIndex == 0) {
            uart0Start = region.start;
        }
    }
    check(gpioStart != 0, "memoryRegions() do plugin declara uma faixa GPIO");
    check(ioMuxStart != 0, "memoryRegions() do plugin declara uma faixa IOMUX");
    check(uart0Start != 0, "memoryRegions() do plugin declara uma faixa UART0");

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
    // dirty por si só (em produção, McuComponent::scheduleNextPoll() acompanha o passo temporal
    // configurado no Scheduler; aqui simulamos isso manualmente, sem precisar avançar o relógio).
    LsdnQemuArena* arena = mcuPtr->arenaBridge().arena();
    simulateQemuWrite(arena, gpioStart + 0x20, 1u << 2);
    session.scheduler().markDirty(mcuIndex);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}
    simulateQemuWrite(arena, gpioStart + 0x04, 1u << 2);
    session.scheduler().markDirty(mcuIndex);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}

    const double gpio2Volts = session.nodeVoltageOfPin(mcuIndex, "GPIO2");
    check(gpio2Volts > 3.0, "GPIO2 sobe para ~3.3V depois de ENABLE+OUT_REG ligarem o bit 2");

    // Arduino `digitalRead()` consulta GPIO_IN mesmo quando o pad está em OUTPUT. O nível físico
    // convergido precisa voltar ao buffer de entrada; caso contrário `!digitalRead(pin)` fica
    // sempre verdadeiro e um Blink por toggle permanece aceso para sempre.
    simulateQemuRead(arena, gpioStart + 0x3C);
    session.scheduler().markDirty(mcuIndex);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}
    check((arena->regData & (1u << 2)) != 0,
          "GPIO_IN reflete nivel alto do pad GPIO2 mesmo configurado como saida (digitalRead em OUTPUT)");

    // Retenção de nível (diagnóstico "QEMU manda sinal mas vem como pulso e não retém conforme
    // lógica"): sem NENHUM novo evento de arena (nenhuma escrita de registrador, nenhum
    // `markDirty` manual), o nível já estampado deveria continuar em ~3.3V por muitos ciclos de
    // `settleStep()` e por uma passagem grande de tempo simulado -- reproduz "firmware fez
    // digitalWrite(HIGH) e não tocou o pino de novo por um tempo" sem precisar de QEMU real. Se
    // isso reverter sozinho, o bug é no lado McuComponent/CircuitGroup (perda de estampa), não no
    // QEMU/decodificação de registrador.
    for (int i = 0; i < 50 && session.settleStep(); ++i) {}
    check(session.nodeVoltageOfPin(mcuIndex, "GPIO2") > 3.0,
          "GPIO2 continua em ~3.3V depois de 50 settleStep() extras sem nenhuma nova escrita de registrador");
    session.scheduler().step(2'000'000); // 2ms de tempo simulado parado no mesmo nivel logico
    for (int i = 0; i < 10 && session.settleStep(); ++i) {}
    check(session.nodeVoltageOfPin(mcuIndex, "GPIO2") > 3.0,
          "GPIO2 continua em ~3.3V depois de avancar 2ms de tempo simulado sem nova escrita (nao e um pulso que reverte sozinho -- "
          "prova que McuComponent::onEvent() só reage a bordas do RST/EN já convergidas pelo solver, nunca à leitura crua de uma "
          "iteração intermediária de stamp()/Newton: sem isso, o primeiro Scheduler::step() da simulação disparava um reset "
          "fantasma vindo do chute inicial do Newton, zerando GPIO_OUT/GPIO_ENABLE)");

    // Regressão do achado "pente fino" (2026-07-17, comparação direta com o SimulIDE real): RST/EN
    // compartilha `CircuitGroup` com TODOS os pinos do MCU por construção (garantia do Netlist --
    // "todos os pinos de um componente caem no mesmo grupo"), e o LED do usuário (`DiodeLegArray`,
    // `isNonlinear()==true`) entra no MESMO grupo assim que fiado num GPIO -- cada toggle de
    // `digitalWrite()` força várias rodadas de convergência de Newton (até `kMaxNonlinearIterations`
    // por settleStep()) ANTES do circuito estabilizar. Reproduz o circuito real do usuário (ESP32 +
    // resistor + LED, GPIO alternando como um blink) inteiramente com o adapter real, sem precisar
    // de QEMU real nem firmware -- prova que a modelagem elétrica REAL do SimulIDE (impedâncias de
    // `IoPin`, pull-up dedicado do RST) resolve o reset fantasma sincronizado com o blink que os
    // valores antigos (`kDriveConductance=1e6`/`kFloatingConductance=1e-6`, spread 1e12) causavam
    // ao deixar o `CircuitGroup` perto demais do piso de singularidade durante a convergência do LED.
    session.components().registerFactory("passive.resistor", [](const registry::ComponentParams& p) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"pin-1"}, Pin{"pin-2"}},
                                                        p.property("resistance", 220.0));
    });
    session.components().registerFactory("outputs.led", [](const registry::ComponentParams&) {
        std::vector<Pin> ledPins{Pin{"anode"}, Pin{"cathode"}};
        return std::make_unique<components::DiodeLegArray>(
            "outputs.led", std::move(ledPins), std::vector<components::DiodeLegArray::Leg>{{0, 1}});
    });
    session.components().registerFactory("other.ground", [](const registry::ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
    const uint32_t resistorIndex = session.addComponent("passive.resistor", {});
    const uint32_t ledIndex = session.addComponent("outputs.led", {});
    const uint32_t groundIndex = session.addComponent("other.ground", {});
    session.connectWire(mcuIndex, "GPIO2", resistorIndex, "pin-1");
    session.connectWire(resistorIndex, "pin-2", ledIndex, "anode");
    session.connectWire(ledIndex, "cathode", groundIndex, "pin");

    const uint64_t loadCountBeforeBlink = mcuPtr->loadFirmwareCallCountForTesting();
    bool resetPinStayedHighThroughoutBlink = true;
    for (int cycle = 0; cycle < 20; ++cycle) {
        const uint32_t bit2 = (cycle % 2 == 0) ? 0u : (1u << 2);
        simulateQemuWrite(arena, gpioStart + 0x04, bit2);
        session.scheduler().markDirty(mcuIndex);
        // kMaxNonlinearIterations do SimulationSession é 50 -- folga de sobra pro LED convergir.
        for (int i = 0; i < 60 && session.settleStep(); ++i) {}
        if (!mcuPtr->resetPinHigh()) resetPinStayedHighThroughoutBlink = false;
    }
    check(resetPinStayedHighThroughoutBlink,
          "RST/EN continua alto durante 20 ciclos de blink (GPIO2 alternando) com o LED não-linear "
          "no MESMO CircuitGroup -- nao houve reset fantasma sincronizado com o toggle");
    check(mcuPtr->loadFirmwareCallCountForTesting() == loadCountBeforeBlink,
          "nenhum loadFirmware() disparado durante o blink com carga nao-linear (nenhum reset/reload fantasma)");

    // Agora o caminho contrário: GPIO3 não foi habilitado como saída -- McuComponent deve ler a
    // tensão real do nó (default 0V, sem nada estampado) e alimentar isso de volta no módulo.
    simulateQemuRead(arena, gpioStart + 0x3C);
    session.scheduler().markDirty(mcuIndex);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}
    check(arena->qemuAction == LSDN_SIM_READ, "leitura de GPIO_IN_REG confirma via qemuAction (desbloquearia o QEMU real)");

    // UART0 TX temporizado: GPIO1 em funcao IOMUX 0 e' U0TXD. Escrever 0x55 no FIFO deve iniciar
    // start bit baixo imediatamente, depois o wakeup do modulo avanca para o primeiro bit de dados
    // (LSB=1) em ~8.68us, reestampando o pino pelo Scheduler.
    simulateQemuWrite(arena, ioMuxStart + 0x88, 0);
    session.scheduler().markDirty(mcuIndex);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}

    simulateQemuWrite(arena, uart0Start + 0x00, 0x55);
    session.scheduler().markDirty(mcuIndex);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}
    check(session.nodeVoltageOfPin(mcuIndex, "GPIO1") < 0.1, "UART0 TX coloca start bit baixo em GPIO1");

    session.scheduler().step(9'000);
    check(session.nodeVoltageOfPin(mcuIndex, "GPIO1") > 3.0, "UART0 TX wakeup avanca para primeiro bit de dados alto");

    // ModuleKind::Reset (pino "RST", ex: EN do ESP32 real): sem fio nenhum, fica fracamente puxado
    // pra ALTO -- confirma ANTES de ligar qualquer fonte externa.
    check(session.nodeVoltageOfPin(mcuIndex, "RST") > 3.0, "RST sem fio fica em ~3.3V (chip roda, nao resetado)");
    check(mcuPtr->resetPinHigh(), "resetPinHigh() comeca true (sem reset)");

    // Fonte de tensao controlavel ligada em RST -- simula um botao EN externo puxando pra GND.
    session.components().registerFactory("test.volt_source", [](const registry::ComponentParams& p) {
        return std::make_unique<components::FixedVolt>(Pin{"out"}, p.property("voltage", 3.3), true);
    });
    const uint32_t enSourceIndex = session.addComponent("test.volt_source", {});
    session.connectWire(enSourceIndex, "out", mcuIndex, "RST");
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}
    check(session.nodeVoltageOfPin(mcuIndex, "RST") > 3.0, "fonte de 3.3V em RST mantem o chip fora de reset");
    check(mcuPtr->resetPinHigh(), "resetPinHigh() continua true com a fonte em 3.3V");

    // Borda de descida: RST cai pra 0V -- McuComponent::stampResetPin() deve detectar e (via
    // evento agendado, fora do stamp() atual -- ver doc no .cpp) chamar module->reset() em todo
    // QemuModule, limpando GPIO_OUT/GPIO_ENABLE -- GPIO2 (ligado como saida alta mais acima) deve
    // cair de volta pra perto de 0V, prova observavel de que o reset de verdade aconteceu.
    session.setProperty(enSourceIndex, "voltage", PropertyValue{0.0});
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}
    check(!mcuPtr->resetPinHigh(), "resetPinHigh() vira false na borda de descida de RST");
    // A limpeza de verdade (resetModulesAndWakeups()+stopFirmware()) roda num evento AGENDADO
    // (delay 0, ver stampResetPin()), não dentro do stamp() atual -- só `Scheduler::step()`/
    // `runUntil()` drenam a fila de eventos por tempo (`m_events`), `settleStep()` sozinho só
    // processa o dirty-set do MNA e NUNCA toca essa fila. Sem este `step()`, este check só
    // passava antes por acidente (achado ao corrigir `m_resetPinObserved`): o reset fantasma do
    // cold-start já tinha zerado GPIO2 bem mais cedo, mascarando que o evento de reset de
    // verdade continuava parado na fila sem nunca ser processado.
    session.scheduler().step(1);
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}
    check(session.nodeVoltageOfPin(mcuIndex, "GPIO2") < 0.1,
          "reset de verdade limpa GPIO_ENABLE/GPIO_OUT -- GPIO2 volta a flutuar perto de 0V");

    const size_t pendingBeforeReloads = session.scheduler().pendingEventCount();
    for (int cycle = 0; cycle < 25; ++cycle) {
        mcuPtr->stopFirmware();
        mcuPtr->openSyntheticArenaForTesting(uniqueArenaName());
    }
    check(session.scheduler().pendingEventCount() <= pendingBeforeReloads + 1,
          "recargas repetidas reutilizam um unico poll pendente (fila nao cresce por ciclo)");
    mcuPtr->stopFirmware();

#ifdef QEMU_REAL_BINARY_PATH
    // Reload espúrio (2026-07-17): usuário reportou "nem o pulso eu detecto mais" depois da
    // correção do reset fantasma -- a 1ª subida natural da tensão do pull-up de RST, logo após o
    // `loadFirmware()` inicial (mesmo mecanismo de `m_previousNodeVoltages` do framework começar
    // em 0V pra QUALQUER nó novo, ver `onEvent()`), virava uma "borda de subida" e recarregava o
    // firmware sozinho -- matava o processo QEMU recém-iniciado antes dele rodar qualquer coisa.
    // Usa o binário REAL do QEMU vendorizado (mesma técnica de McuControllerRealQemuTest: flash
    // MTD apagada, sem toolchain ESP-IDF local -- não executa aplicação, só prova que o processo
    // sobe e fica de pé) porque o bug depende do RST realmente convergindo pra ~3.3V via solver,
    // não de uma escrita sintética de arena.
    {
        const std::filesystem::path qemuRealPath = QEMU_REAL_BINARY_PATH;
        if (std::filesystem::exists(qemuRealPath)) {
            const std::filesystem::path blankFlashPath =
                std::filesystem::temp_directory_path() / (uniqueArenaName() + "-flash.bin");
            {
                std::ofstream out(blankFlashPath, std::ios::binary | std::ios::trunc);
                const std::vector<char> erasedBlock(64 * 1024, static_cast<char>(0xFF));
                for (int i = 0; i < 64; ++i) out.write(erasedBlock.data(), erasedBlock.size());
            }
            mcuPtr->loadFirmware(blankFlashPath, uniqueArenaName(), qemuRealPath.string());
            for (int i = 0; i < 20 && session.settleStep(); ++i) {}
            session.scheduler().step(1);
            for (int i = 0; i < 20 && session.settleStep(); ++i) {}
            check(mcuPtr->loadFirmwareCallCountForTesting() == 1,
                  "loadFirmware() real nao dispara reload espurio sozinho (RST subindo naturalmente apos o load)");
            check(mcuPtr->firmwareRunning(),
                  "processo QEMU real continua rodando depois de assentar (nao foi morto por um reset fantasma)");
            mcuPtr->stopFirmware();
            std::error_code removeError;
            std::filesystem::remove(blankFlashPath, removeError);
        } else {
            std::fprintf(stderr, "PULADO (reload espurio): %s nao existe.\n", qemuRealPath.string().c_str());
        }
    }
#endif

    if (failures == 0) {
        std::printf("\nTodos os testes de McuComponent passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}

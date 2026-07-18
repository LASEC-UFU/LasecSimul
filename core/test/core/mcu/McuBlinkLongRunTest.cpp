// Teste ponta-a-ponta opcional com firmware ESP32 real. Defina LASECSIMUL_TEST_FIRMWARE para
// uma imagem merged.bin de Blink em GPIO13. Sem a variavel o teste e' pulado (CI sem PlatformIO).
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include "components/SimulideBuiltins.hpp"
#include "components/active/DiodeLegArray.hpp"
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/Rail.hpp"
#include "mcu/McuComponent.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;

int main() {
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_FIRMWARE para um Blink merged.bin (GPIO13).\n");
        return 0;
    }
    const std::filesystem::path firmware = std::filesystem::u8path(firmwareEnv);
    if (!std::filesystem::exists(firmware)) {
        std::fprintf(stderr, "FALHOU: firmware nao existe: %s\n", firmware.string().c_str());
        return 1;
    }

    const std::filesystem::path adapterPath = ESP32_ADAPTER_DLL_PATH;
    const std::filesystem::path qemuPath = QEMU_REAL_BINARY_PATH;
    if (!std::filesystem::exists(adapterPath) || !std::filesystem::exists(qemuPath)) {
        std::fprintf(stderr, "PULADO: adapter ou QEMU real nao esta compilado/empacotado.\n");
        return 0;
    }

#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "disabled");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "disabled", 1);
#endif

    plugins::GlobalPluginCache cache;
    auto module = cache.loader().loadMcuPlugin(adapterPath);
    cache.setActiveMcuModule("espressif.esp32", module);

    SimulationSession session(cache);
    session.registerKnownMcuTypes();
    mcu::McuComponent* mcu = nullptr;
    session.components().registerFactory("test.esp32", [&session, &mcu](const registry::ComponentParams&) {
        auto result = std::make_unique<mcu::McuComponent>(
            session.mcus().create("espressif.esp32"), session.scheduler());
        mcu = result.get();
        return result;
    });
    session.components().registerFactory("passive.resistor", [](const registry::ComponentParams&) {
        return std::make_unique<components::Resistor>(
            std::array<Pin, 2>{Pin{"pin-1"}, Pin{"pin-2"}}, 1000.0);
    });
    session.components().registerFactory("outputs.led", [](const registry::ComponentParams&) {
        return std::make_unique<components::DiodeLegArray>(
            "outputs.led", std::vector<Pin>{Pin{"anode"}, Pin{"cathode"}},
            std::vector<components::DiodeLegArray::Leg>{{0, 1}});
    });
    session.components().registerFactory("other.ground", [](const registry::ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
    // Cargas adicionais da montagem real fornecida pelo usuário: potenciômetro 10k entre 3V3/GND
    // com cursor em GPIO23 e motor resistivo de 10 ohms em GPIO27/GND. O Blink precisa continuar
    // funcionando mesmo quando essas outras saídas estão em zero.
    session.components().registerFactory("passive.potentiometer", [](const registry::ComponentParams&) {
        return std::make_unique<components::SimulidePotentiometer>(
            "passive.potentiometer",
            std::array<Pin, 3>{Pin{"pin-1"}, Pin{"pin-2"}, Pin{"pin-3"}}, 10000.0, 0.4540803157056692);
    });
    session.components().registerFactory("sources.rail", [](const registry::ComponentParams&) {
        return std::make_unique<components::Rail>(Pin{"pin-1"}, 3.3);
    });
    session.components().registerFactory("outputs.dc_motor", [](const registry::ComponentParams&) {
        return std::make_unique<components::Resistor>(
            std::array<Pin, 2>{Pin{"pin-1"}, Pin{"pin-2"}}, 10.0);
    });

    const uint32_t esp32 = session.addComponent("test.esp32", {});
    const uint32_t resistor = session.addComponent("passive.resistor", {});
    const uint32_t led = session.addComponent("outputs.led", {});
    const uint32_t ground = session.addComponent("other.ground", {});
    const uint32_t potentiometer = session.addComponent("passive.potentiometer", {});
    const uint32_t rail = session.addComponent("sources.rail", {});
    const uint32_t motor = session.addComponent("outputs.dc_motor", {});
    session.connectWire(esp32, "GPIO13", resistor, "pin-1");
    session.connectWire(resistor, "pin-2", led, "anode");
    session.connectWire(led, "cathode", ground, "pin");
    session.connectWire(esp32, "GPIO23", potentiometer, "pin-2");
    session.connectWire(rail, "pin-1", potentiometer, "pin-1");
    session.connectWire(potentiometer, "pin-3", ground, "pin");
    session.connectWire(esp32, "GPIO27", motor, "pin-1");
    session.connectWire(motor, "pin-2", ground, "pin");

    const std::string arena = "lasecsimul-blink-long-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    mcu->loadFirmware(firmware, arena, qemuPath.string());
    session.scheduler().start();

    bool haveLevel = false;
    bool previousHigh = false;
    bool observedHigh = false;
    bool observedLow = false;
    bool motorStayedLow = true;
    bool pauseVerified = false;
    int transitions = 0;
    const auto pauseAt = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
    while (std::chrono::steady_clock::now() < deadline && mcu->firmwareRunning()) {
        try {
            const bool high = session.nodeVoltageOfPin(esp32, "GPIO13") > 2.0;
            observedHigh = observedHigh || high;
            observedLow = observedLow || !high;
            motorStayedLow = motorStayedLow && session.nodeVoltageOfPin(esp32, "GPIO27") < 0.2;
            if (haveLevel && high != previousHigh) ++transitions;
            previousHigh = high;
            haveLevel = true;
        } catch (const std::exception&) {
            // Scheduler estava no meio de um passo; a proxima amostra tentara novamente.
        }
        if (!pauseVerified && std::chrono::steady_clock::now() >= pauseAt) {
            session.scheduler().pause();
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            const uint64_t pausedAtNs = session.scheduler().nowNs();
            const bool pausedLevel = session.nodeVoltageOfPin(esp32, "GPIO13") > 2.0;
            std::this_thread::sleep_for(std::chrono::milliseconds(750));
            pauseVerified = session.scheduler().isPaused() && mcu->firmwareRunning() &&
                            session.scheduler().nowNs() == pausedAtNs &&
                            (session.nodeVoltageOfPin(esp32, "GPIO13") > 2.0) == pausedLevel;
            session.scheduler().resume();
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    const uint64_t simulatedNsBeforeStop = session.scheduler().nowNs();
    const bool stillRunning = mcu->firmwareRunning();
    const std::string logs = mcu->qemuLogs();
    // O Stop precisa funcionar também a partir de Pause e só confirmar depois de encerrar QEMU,
    // limpar eventos e restaurar o relógio/flag de pausa do scheduler.
    session.scheduler().pause();
    session.stopSimulation();
    const bool stopVerified = !mcu->firmwareRunning() && !session.scheduler().isRunning() &&
                              !session.scheduler().isPaused() && session.scheduler().nowNs() == 0 &&
                              session.scheduler().pendingEventCount() == 0;

    // O ESP-IDF inicializa o segundo núcleo com um SW_CPU_RESET apenas do APP CPU. Esse reset
    // count=2/mask=0x02/cause1=12 é parte normal do boot dual-core, não uma reinicialização do
    // firmware. Depois desse ponto nenhum terceiro reset (nem um count=2 não classificado) é aceito.
    const bool expectedAppCpuBootReset =
        logs.find("count=2 mask=0x02") != std::string::npos &&
        logs.find("expected=app-cpu-startup") != std::string::npos;
    const bool noUnexpectedReset = expectedAppCpuBootReset && logs.find("count=3 ") == std::string::npos;
    const bool noNic = logs.find("network=disabled; no NIC/backend") != std::string::npos &&
                       logs.find("model=open_eth") == std::string::npos;
    std::fprintf(stderr, "Blink GPIO13: transitions=%d high=%s low=%s sim_ns=%llu qemu_alive=%s pause_resume=%s unexpected_reset=%s\n",
                 transitions, observedHigh ? "yes" : "no", observedLow ? "yes" : "no",
                 static_cast<unsigned long long>(simulatedNsBeforeStop),
                 stillRunning ? "yes" : "no", pauseVerified ? "yes" : "no",
                 noUnexpectedReset ? "no" : "yes");
    if (!stillRunning || transitions < 10 || !motorStayedLow || !pauseVerified || !stopVerified || !noUnexpectedReset || !noNic) {
        std::fprintf(stderr, "FALHOU: Blink instavel. Ultimos logs QEMU:\n%s\n", logs.c_str());
        return 1;
    }
    std::fprintf(stderr, "OK: Blink estavel por 15 segundos; Pause/Continue preservou estado e Stop pausado encerrou QEMU/zerou scheduler.\n");
    return 0;
}

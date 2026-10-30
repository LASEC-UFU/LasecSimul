// As duas CPUs do ESP32 em paralelo (QEMU com -icount, VNEXT_B): no chip cada núcleo executa no
// próprio ritmo, então um laço leva o mesmo tempo com o outro núcleo parado ou ocupado. O TCG de uma
// thread executa as vCPUs em turnos, e o icount contava as instruções das duas num relógio só: com os
// dois ocupados cada núcleo andava à metade (75,8 ms sozinho, 140-151 ms com o outro ocupado). Agora
// cada vCPU tem o próprio relógio (softmmu/icount.c).
//
// Firmware (LASECSIMUL_TEST_DUAL_CORE_FIRMWARE, merged.bin de vnext_prototype/guest_dual_core): o
// núcleo 1 mede N iterações sozinho e depois junto com o núcleo 0 (acordado por semáforo), e imprime
// "DUAL single_us=... both_core1_us=... both_core0_us=..." pela UART0. Em seguida o núcleo 0 apaga e
// grava a flash enquanto o núcleo 1 roda na flash ("FLASH us=..."): a operação precisa terminar.
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
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_DUAL_CORE_FIRMWARE");
    if (!firmwareEnv || !*firmwareEnv) {
        std::fprintf(stderr, "PULADO: defina LASECSIMUL_TEST_DUAL_CORE_FIRMWARE (firmware das duas CPUs).\n");
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

    const std::string arena = "lasecsimul-dual-core-" +
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
    std::string flashLine;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (std::chrono::steady_clock::now() < deadline && mcu && mcu->firmwareRunning()) {
        if (const auto snapshot = session.tryDrainUartRx(plot)) received += hexToText(snapshot->dataHex);
        // A segunda medida (a primeira inclui a tradução do código do laço), e a gravação da flash
        // pelo núcleo 0 que vem depois dela concluída.
        const size_t first = received.find("DUAL single_us=");
        if (first != std::string::npos) {
            const size_t second = received.find("DUAL single_us=", first + 1);
            if (second != std::string::npos) {
                const size_t end = received.find('\n', second);
                if (end != std::string::npos) {
                    line = received.substr(second, end - second);
                    const size_t flash = received.find("FLASH us=", end);
                    if (flash != std::string::npos && received.find('\n', flash) != std::string::npos) {
                        flashLine = received.substr(flash, received.find('\n', flash) - flash);
                        break;
                    }
                }
            }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    // Com LASECSIMUL_LOCKSTEP_TRACE=1 o QEMU registra o controlador de tempo real ([RT]) no log.
    const std::string qemuLogs = std::getenv("LASECSIMUL_LOCKSTEP_TRACE") && mcu ? mcu->qemuLogs() : std::string();
    session.scheduler().pause();
    session.stopSimulation();
    if (!qemuLogs.empty())
        std::fprintf(stderr, "--- log do QEMU (fim) ---\n%s\n", qemuLogs.substr(qemuLogs.size() > 6000 ? qemuLogs.size() - 6000 : 0).c_str());

    long long singleUs = 0, bothCore1Us = 0, bothCore0Us = 0;
    if (line.empty() ||
        std::sscanf(line.c_str(), "DUAL single_us=%lld both_core1_us=%lld both_core0_us=%lld", &singleUs, &bothCore1Us,
                    &bothCore0Us) != 3 || singleUs <= 0) {
        std::fprintf(stderr, "FALHOU: o firmware nao terminou a medida. UART: '%s'\n",
                     received.substr(received.size() > 300 ? received.size() - 300 : 0).c_str());
        return 1;
    }
    std::fprintf(stderr, "%s\n", line.c_str());
    if (flashLine.empty()) {
        std::fprintf(stderr, "FALHOU: a gravacao da flash pelo nucleo 0 (com o 1 rodando na flash) nao terminou\n");
        return 1;
    }
    std::fprintf(stderr, "%s\n", flashLine.c_str());
    // No modo mttcg o relógio do guest segue o do host (limite documentado do modo): sem exigência.
    const char* executionMode = std::getenv("LASECSIMUL_ESP32_EXECUTION_MODE");
    if (executionMode && std::string(executionMode) == "mttcg") {
        std::printf("Duas CPUs (mttcg, sem exigencia de tempo): %lld / %lld / %lld us\n", singleUs, bothCore1Us, bothCore0Us);
        return 0;
    }
    // 1% cobre a interrupção do tick e a troca de turno entre as vCPUs; o defeito antigo dava ~2x.
    const auto close = [](long long us, long long reference) {
        return us >= reference * 99 / 100 && us <= reference * 101 / 100;
    };
    // No modo realtime o QEMU estica o tempo de instrução quando o host não acompanha, e o fator muda
    // de uma fase para outra (o boot começa atrasado): só as duas medidas simultâneas se comparam.
    const char* timing = std::getenv("LASECSIMUL_ESP32_TIMING");
    const bool exact = timing && std::string(timing) == "exact";
    const long long reference = exact ? singleUs : bothCore1Us;
    int failures = 0;
    if (exact && !close(bothCore1Us, reference)) { std::fprintf(stderr, "FALHOU: nucleo 1 com o 0 ocupado levou %lld us (sozinho: %lld)\n", bothCore1Us, singleUs); ++failures; }
    if (!close(bothCore0Us, reference)) { std::fprintf(stderr, "FALHOU: nucleo 0 levou %lld us, nucleo 1 %lld us ao mesmo tempo (sozinho: %lld)\n", bothCore0Us, bothCore1Us, singleUs); ++failures; }
    if (failures) return 1;
    std::printf("Duas CPUs em paralelo: %lld us sozinho, %lld/%lld us com as duas ocupadas -- como no chip\n", singleUs,
                bothCore1Us, bothCore0Us);
    return 0;
}

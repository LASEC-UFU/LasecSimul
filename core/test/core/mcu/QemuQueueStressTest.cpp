// Achado 2026-07-22 (usuário reporta, AO VIVO, a simulação travando por completo depois de rodar
// por um tempo -- LED e UART funcionaram corretamente por um tempo, depois pararam de atualizar,
// com o indicador de velocidade ainda marcando 100%): a hipótese mais provável encontrada foi uma
// condição de corrida na fila circular Core<->QEMU (PERF-13, protocolo v3) -- os índices
// `queueWriteIndex`/`queueReadIndex` e os campos de cada entrada eram lidos/escritos como
// `uint64_t` simples, sem nenhuma barreira de memória, apesar de serem escritos por um PROCESSO
// SEPARADO (QEMU). Corrigido com `qatomic_store_release`/`qatomic_load_acquire`
// (simuliface.c, fork QEMU) pareado com `std::atomic_ref` (QemuArenaBridge.cpp, Core).
//
// Condições de corrida são, por natureza, difíceis de provar por leitura estática -- este teste é
// a melhor verificação disponível: roda uma instância QEMU real (mesma técnica de
// McuControllerRealQemuTest.cpp, flash apagada, sem firmware real) por uma janela BEM mais longa
// que os outros testes (dezenas de segundos, não frações de segundo), bombeando a fila
// continuamente e monitorando o maior intervalo (wall-clock) entre eventos consecutivos. Uma trava
// real do tipo relatado se manifestaria como: eventos param de chegar completamente pelo resto do
// teste. Ausência de trava aqui é evidência forte, não uma garantia matemática -- ver relatório
// final.
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <vector>
#include "mcu/McuController.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"

using namespace lasecsimul;
using namespace lasecsimul::mcu;

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

std::string uniqueArenaName() {
    return "lasecsimul-queue-stress-test-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

std::filesystem::path createBlankFlash() {
    const std::filesystem::path path =
        std::filesystem::temp_directory_path() / (uniqueArenaName() + "-flash.bin");
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    const std::vector<char> erasedBlock(64 * 1024, static_cast<char>(0xFF));
    for (int i = 0; i < 64; ++i) out.write(erasedBlock.data(), erasedBlock.size());
    if (!out) throw std::runtime_error("nao foi possivel criar flash vazia de teste");
    return path;
}

int configuredStressSeconds() {
    const char* value = std::getenv("LASECSIMUL_STRESS_SECONDS");
    if (!value || !*value) return 60;
    char* end = nullptr;
    const long parsed = std::strtol(value, &end, 10);
    return end != value && *end == '\0' && parsed >= 2 && parsed <= 600
               ? static_cast<int>(parsed)
               : 60;
}

int configuredStallThresholdMilliseconds() {
    const char* value = std::getenv("LASECSIMUL_STALL_THRESHOLD_MS");
    if (!value || !*value) return 5000;
    char* end = nullptr;
    const long parsed = std::strtol(value, &end, 10);
    return end != value && *end == '\0' && parsed >= 1000 && parsed <= 30000
               ? static_cast<int>(parsed)
               : 5000;
}

} // namespace

int main() {
#ifndef QEMU_REAL_BINARY_PATH
#error "QEMU_REAL_BINARY_PATH precisa ser definido pelo CMakeLists (caminho do qemu-system-xtensa.exe real)"
#endif
#ifndef ESP32_ADAPTER_DLL_PATH
#error "ESP32_ADAPTER_DLL_PATH precisa ser definido pelo CMakeLists (caminho do adapter.dll real)"
#endif
    const char* qemuOverride = std::getenv("LASECSIMUL_TEST_QEMU_BINARY");
    const std::filesystem::path qemuPath =
        qemuOverride && *qemuOverride ? std::filesystem::u8path(qemuOverride)
                                      : std::filesystem::path(QEMU_REAL_BINARY_PATH);
    const std::filesystem::path dllPath = ESP32_ADAPTER_DLL_PATH;
    if (!std::filesystem::exists(qemuPath)) {
        std::fprintf(stderr, "PULADO: %s nao existe.\n", qemuPath.string().c_str());
        return 0;
    }
    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr, "PULADO: %s nao existe -- rode 'npm run build:mcu-adapters'.\n", dllPath.string().c_str());
        return 0;
    }

#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "disabled");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "disabled", 1);
#endif

    plugins::GlobalPluginCache cache;
    std::shared_ptr<plugins::PluginModule> module = cache.loader().loadMcuPlugin(dllPath);
    cache.setActiveMcuModule("espressif.esp32", module);
    plugins::PluginRuntime runtime(cache);
    const std::unique_ptr<IMcuAdapter> adapter = runtime.createMcuAdapter("espressif.esp32");
    TEST_ASSERT(adapter != nullptr, "PluginRuntime cria o IMcuAdapter ESP32 a partir do plugin real");
    if (!adapter) return 1;

    McuController controller(*adapter, qemuPath.string());
    const std::string arenaName = uniqueArenaName();
    const std::filesystem::path flashPath = createBlankFlash();

    try {
        controller.start(flashPath, arenaName);
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "FALHOU: McuController::start lancou: %s\n", ex.what());
        return 1;
    }

    // Duração deliberadamente bem maior que os outros testes reais (que rodam frações de segundo
    // a poucos segundos) -- o achado ao vivo foi "funcionou por um tempo, depois travou", então uma
    // janela curta não teria exposição suficiente à condição de corrida.
    const auto stressDuration = std::chrono::seconds(configuredStressSeconds());
    const auto kStallThreshold =
        std::chrono::milliseconds(configuredStallThresholdMilliseconds());

    uint64_t eventsHandled = 0;
    auto lastEventAt = std::chrono::steady_clock::now();
    auto longestGap = std::chrono::steady_clock::duration::zero();
    bool sawAnyEvent = false;
    bool stillRunning = true;

    const auto testStart = std::chrono::steady_clock::now();
    const auto testDeadline = testStart + stressDuration;
    while (std::chrono::steady_clock::now() < testDeadline) {
        if (!controller.isRunning()) {
            stillRunning = false;
            break;
        }
        const auto result = controller.arenaBridge().poll();
        if (result.hasEvent) {
            ++eventsHandled;
            sawAnyEvent = true;
            const auto now = std::chrono::steady_clock::now();
            longestGap = std::max(longestGap, now - lastEventAt);
            lastEventAt = now;
            if (result.event->simuAction == LSDN_SIM_READ) controller.arenaBridge().acknowledgeRead(0);
            else controller.arenaBridge().acknowledgeWrite();
            continue; // drena agressivamente enquanto houver backlog, mesma disciplina de produção
        }
        // Sem evento agora -- ainda assim monitora o intervalo desde o último, pra detectar uma
        // trava em andamento sem esperar o teste inteiro acabar.
        const auto gapSoFar = std::chrono::steady_clock::now() - lastEventAt;
        if (sawAnyEvent && gapSoFar > kStallThreshold) {
            std::fprintf(stderr, "AVISO: %lld ms sem nenhum evento (limiar de trava: %lld ms)\n",
                         static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(gapSoFar).count()),
                         static_cast<long long>(kStallThreshold.count()));
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    const std::string logs = controller.qemuLogs();
    const uint32_t arenaProtocol = controller.arenaBridge().protocolMajor();
    const uint64_t arenaCapabilities =
        controller.arenaBridge().negotiatedCapabilities();
    controller.stop();
    std::filesystem::remove(flashPath);

    TEST_ASSERT(stillRunning, "processo QEMU real permaneceu vivo durante toda a janela de estresse");
    TEST_ASSERT(sawAnyEvent, "pelo menos um evento (heartbeat/registrador) foi processado");
    TEST_ASSERT(eventsHandled > 100, "volume de eventos consistente com atividade sustentada (nao só alguns no início)");
    TEST_ASSERT(longestGap < kStallThreshold,
        "nenhum intervalo maior que o limiar de trava entre eventos consecutivos -- fila nunca parou de fluir");

    const char* executionMode = std::getenv("LASECSIMUL_ESP32_EXECUTION_MODE");
    if (executionMode && std::string(executionMode) == "mttcg") {
        TEST_ASSERT(logs.find("execution mode: mttcg-realtime (vcpus=2, tcg_threads=2)") !=
                        std::string::npos,
                    "MTTCG real criou duas threads TCG para as duas vCPUs ESP32");
    }
    const char* profileMode = std::getenv("LASECSIMUL_QEMU_PROFILE");
    if (profileMode && std::string(profileMode) != "0") {
        TEST_ASSERT(logs.find("[LasecSimul][PROFILE] mode=mttcg-realtime") !=
                        std::string::npos,
                    "telemetria MTTCG publicou medidas reproduziveis de parede/tempo virtual/fila");
    }

    const char* arenaVersion =
        std::getenv("LASECSIMUL_QEMU_ARENA_VERSION");
    const bool legacyArena =
        arenaVersion && std::string(arenaVersion) == "3";
    if (legacyArena) {
        TEST_ASSERT(arenaProtocol == 3 && arenaCapabilities == 0,
                    "rollback v3 usa o payload legado sem descritor");
        TEST_ASSERT(logs.find("arena ABI v3 mapped") != std::string::npos,
                    "QEMU confirmou o mapping legado v3");
    } else {
        TEST_ASSERT(arenaProtocol == LSDN_QEMU_ARENA_ABI_MAJOR,
                    "Core abriu a arena ABI v4 por padrao");
        TEST_ASSERT(arenaCapabilities == LSDN_QEMU_ARENA_CAPABILITIES,
                    "Core e QEMU negociaram todas as capacidades v4 obrigatorias");
        TEST_ASSERT(logs.find("arena ABI v4 mapped") != std::string::npos,
                    "QEMU confirmou o descritor e o mapping v4");
    }

    const size_t profilePos = logs.rfind("[LasecSimul][PROFILE]");
    if (profilePos != std::string::npos) {
        const size_t profileEnd = logs.find_first_of("\r\n", profilePos);
        std::fprintf(stderr, "profile=%s\n",
                     logs.substr(profilePos, profileEnd - profilePos).c_str());
    }
    std::fprintf(stderr, "eventsHandled=%llu longestGapMs=%lld duration=%llds\n",
                 static_cast<unsigned long long>(eventsHandled),
                 static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(longestGap).count()),
                 static_cast<long long>(stressDuration.count()));

    if (failures == 0) {
        std::printf("\nTodos os testes de QemuQueueStress passaram (sem trava em %llds sustentados).\n",
                     static_cast<long long>(stressDuration.count()));
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM. Ultimos logs QEMU:\n%s\n", failures, logs.c_str());
    return 1;
}

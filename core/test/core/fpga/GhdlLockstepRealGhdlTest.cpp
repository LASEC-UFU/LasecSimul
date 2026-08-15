// Passo 4 do plano FPGA/VHDL (golden-puzzling-quasar.md): prova de ponta a ponta contra um GHDL
// REAL -- GhdlProcessManager + GhdlArenaBridge + o módulo VPI real (lasecsimul_vpi.dll/.so,
// construído por `npm run build:fpga-vpi`), sem nada simulado/sintético. Mesma convenção de
// self-skip de McuControllerRealQemuTest.cpp: se `ghdl` não estiver no PATH ou o módulo VPI não
// tiver sido construído, imprime "PULADO" e sai com sucesso em vez de falhar.
#include "fpga/GhdlArenaBridge.hpp"
#include "fpga/GhdlProcessManager.hpp"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <thread>

// TEST_CHECK() do CRT de depuracao do MSVC abre uma caixa de dialogo MODAL quando nao ha debugger
// anexado mas existe uma sessao de desktop -- travava esta automacao indefinidamente em vez de
// abortar. TEST_CHECK lanca em vez disso, sempre diagnosticavel sem interacao humana.
#define TEST_CHECK(expr)                                                                                             \
    do {                                                                                                             \
        if (!(expr)) throw std::runtime_error(std::string("check failed: ") + #expr + " (line " + std::to_string(__LINE__) + ")"); \
    } while (false)

using namespace lasecsimul;
using namespace lasecsimul::fpga;
namespace fs = std::filesystem;

namespace {

std::string uniqueArenaName() {
    return "lasecsimul-fpga-real-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

#if defined(_WIN32)
constexpr const char* kVpiModuleRelativePath = "/fpga/ghdl-vpi/build/win-x64/lasecsimul_vpi.dll";
#elif defined(__APPLE__)
constexpr const char* kVpiModuleRelativePath = "/fpga/ghdl-vpi/build/macos-universal/liblasecsimul_vpi.dylib";
#else
constexpr const char* kVpiModuleRelativePath = "/fpga/ghdl-vpi/build/linux-x64/liblasecsimul_vpi.so";
#endif

bool ghdlAvailable(std::string& versionLine) {
    GhdlProcessManager probe;
    try {
        probe.start(GhdlLaunchSpec{"ghdl", {"--version"}, {}, {}, {}});
    } catch (const std::exception&) {
        return false;
    }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (probe.isRunning() && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    probe.stop(std::chrono::seconds(2));
    const std::string logs = probe.logs();
    if (logs.find("GHDL") == std::string::npos) return false;
    versionLine = logs.substr(0, logs.find('\n'));
    return true;
}

/** Roda `ghdl <flag>` (ex.: `--vpi-library-dir`) e devolve a saida (uma linha, sem o \n final) --
 * mesmo mecanismo usado manualmente no Spike 0 pra descobrir onde `libghdlvpi.dll`/`vpi_user.h`
 * moram nesta instalacao do GHDL. */
std::string queryGhdl(const std::string& ghdlBinary, const std::string& flag) {
    GhdlProcessManager probe;
    probe.start(GhdlLaunchSpec{ghdlBinary, {flag}, {}, {}, {}});
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (probe.isRunning() && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    probe.stop(std::chrono::seconds(2));
    std::string output = probe.logs();
    while (!output.empty() && (output.back() == '\n' || output.back() == '\r')) output.pop_back();
    return output;
}

bool waitForProcessLogContains(GhdlProcessManager& manager, const std::string& text, std::chrono::milliseconds timeout) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
        if (manager.logs().find(text) != std::string::npos) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return false;
}

void runAnalyzeElaborate(const std::string& ghdlBinary, const fs::path& workDir, const fs::path& vhdlFile) {
    GhdlProcessManager analyze;
    analyze.start(GhdlLaunchSpec{ghdlBinary, {"-a", "--std=08", vhdlFile.string()}, {}, workDir.string(), {}});
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (analyze.isRunning() && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    analyze.stop(std::chrono::seconds(2));
    if (!fs::exists(workDir / "work-obj08.cf")) {
        throw std::runtime_error("ghdl -a nao produziu work-obj08.cf: " + analyze.logs());
    }

    // --time-resolution e opcao de elaborate (nao de run, apesar de aparecer em `ghdl help run`
    // tambem -- achado empirico: `ghdl -r ... --time-resolution=ns` rejeita com "unknown run
    // option"). Fixado em ns aqui pra bater exatamente com o dominio de tempo do protocolo da
    // arena (ver comentario de topo de lasecsimul_vpi.c).
    GhdlProcessManager elaborate;
    elaborate.start(
        GhdlLaunchSpec{ghdlBinary, {"-e", "--std=08", "--time-resolution=ns", "lockstep_test"}, {}, workDir.string(), {}});
    const auto elaborateDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (elaborate.isRunning() && std::chrono::steady_clock::now() < elaborateDeadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    elaborate.stop(std::chrono::seconds(2));
}

void testLockstepRoundTripAgainstRealGhdl(const std::string& ghdlBinary, const fs::path& vpiModule) {
    const fs::path workDir = fs::temp_directory_path() / ("lasecsimul-fpga-lockstep-" + uniqueArenaName());
    fs::create_directories(workDir);
    const fs::path vhdlFile = workDir / "lockstep_test.vhd";
    {
        std::ofstream out(vhdlFile);
        out << "library ieee;\n"
               "use ieee.std_logic_1164.all;\n"
               "entity lockstep_test is\n"
               "    port (\n"
               "        sw0  : in  std_logic;\n"
               "        sw1  : in  std_logic;\n"
               "        led0 : out std_logic\n"
               "    );\n"
               "end entity;\n"
               "architecture rtl of lockstep_test is\n"
               "begin\n"
               "    led0 <= sw0 and sw1;\n"
               "end architecture;\n";
    }

    runAnalyzeElaborate(ghdlBinary, workDir, vhdlFile);

    // Ordem de declaracao da entity == ordem de portIndex (contrato documentado em
    // lasecsimul_vpi.c/buildPortTable -- confirmado empiricamente no Spike 0 e de novo aqui):
    // portIndex 0=sw0, 1=sw1, 2=led0.
    constexpr uint32_t kPortSw0 = 0, kPortSw1 = 1, kPortLed0 = 2;

    const std::string arenaName = uniqueArenaName();
    GhdlArenaBridge bridge;
    bridge.open(GhdlArenaOpenOptions{arenaName, true, 4, 8});

    // GHDL busca `libghdlvpi.dll` (dependencia do NOSSO modulo VPI) no PATH do processo, nao no
    // diretorio do modulo carregado -- achado empirico (mesmo "modulo nao encontrado" do Spike 0,
    // resolvido la copiando a DLL pro cwd; aqui o cwd e o workDir do projeto VHDL, entao a fixacao
    // de verdade e garantir que o PATH inclua o diretorio de libs do GHDL).
    const std::string vpiLibraryDir = queryGhdl(ghdlBinary, "--vpi-library-dir");
    std::string pathOverride = vpiLibraryDir;
    if (const char* existingPath = std::getenv("PATH")) {
        pathOverride += ";";
        pathOverride += existingPath;
    }

    GhdlProcessManager runProcess;
    GhdlLaunchSpec runSpec{ghdlBinary,
                          {"-r", "--std=08", "lockstep_test", "--vpi=" + vpiModule.string()},
                          {},
                          workDir.string(),
                          {{"LASECSIMUL_FPGA_MODE", "run"},
                           {"LASECSIMUL_FPGA_ARENA_NAME", arenaName},
                           {"PATH", pathOverride}}};
    runProcess.start(runSpec);

    try {
        const auto readyDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (!bridge.peerReady() && std::chrono::steady_clock::now() < readyDeadline) {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        if (!bridge.peerReady()) {
            throw std::runtime_error("GHDL nunca sinalizou ghdlReady");
        }
        TEST_CHECK(bridge.negotiatedCapabilities() == LSDN_FPGA_ARENA_CAPABILITIES);
        std::printf("OK: processo GHDL real anexou na arena e negociou capacidades\n");

        // Rodada 1: ADVANCE_TO(1ns) com sw0=1,sw1=1 -- semeia os dois inputs (default VHDL e 'U'
        // indefinido) e observa led0 assumir '1'. Alvo é 1ns, nao 0: achado empirico (Step 4) --
        // um cbAfterDelay com delay ZERO nunca deixa o kernel do GHDL processar o delta cycle
        // disparado pela entrada que acabamos de depositar (confirmado contra GHDL real, nao
        // resolve nem com centenas de hops encadeados); um delay real >=1 resolve de primeira.
        // Por isso o protocolo exige `targetNs > tempo atual do GHDL` sempre -- FpgaComponent
        // (Step 5) nunca deve pedir ADVANCE_TO pro instante em que o GHDL já está.
        {
            const std::vector<GhdlChangeEntry> inputs = {GhdlChangeEntry{kPortSw0, 0, LogicValue::One},
                                                          GhdlChangeEntry{kPortSw1, 0, LogicValue::One}};
            bridge.requestAdvanceTo(1, inputs);

            GhdlAdvanceReply reply;
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
            do {
                reply = bridge.pollReply();
                if (!reply.ready) std::this_thread::sleep_for(std::chrono::milliseconds(5));
            } while (!reply.ready && std::chrono::steady_clock::now() < deadline);

            TEST_CHECK(reply.ready);
            TEST_CHECK(!reply.overflow);
            TEST_CHECK(reply.reachedTimeNs == 1);
            bool sawLedHigh = false;
            for (const GhdlChangeEntry& change : reply.outputChanges) {
                if (change.portIndex == kPortLed0) {
                    TEST_CHECK(change.value == LogicValue::One);
                    sawLedHigh = true;
                }
            }
            TEST_CHECK(sawLedHigh);
            std::printf("OK: ADVANCE_TO(1ns) com sw0=1,sw1=1 -- led0 reportado como One\n");
        }

        // Rodada 2: ADVANCE_TO(10ns) com sw0=0 -- exercita o caminho de callback AGENDADO de
        // verdade (cbAfterDelay). Prova que o Core comanda o avanco de tempo (GHDL nao roda a
        // frente sozinho) e que a saida reflete o novo valor combinacional.
        {
            const std::vector<GhdlChangeEntry> inputs = {GhdlChangeEntry{kPortSw0, 0, LogicValue::Zero}};
            bridge.requestAdvanceTo(10, inputs);

            GhdlAdvanceReply reply;
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
            do {
                reply = bridge.pollReply();
                if (!reply.ready) std::this_thread::sleep_for(std::chrono::milliseconds(5));
            } while (!reply.ready && std::chrono::steady_clock::now() < deadline);

            TEST_CHECK(reply.ready);
            TEST_CHECK(!reply.overflow);
            TEST_CHECK(reply.reachedTimeNs == 10);
            bool sawLedLow = false;
            for (const GhdlChangeEntry& change : reply.outputChanges) {
                if (change.portIndex == kPortLed0) {
                    TEST_CHECK(change.value == LogicValue::Zero);
                    sawLedLow = true;
                }
            }
            TEST_CHECK(sawLedLow);
            std::printf("OK: ADVANCE_TO(10ns) com sw0=0 -- callback agendado real, led0 volta a Zero\n");
        }

        bridge.requestStop();
        const bool stoppedGracefully = runProcess.stop(std::chrono::seconds(5));
        TEST_CHECK(stoppedGracefully);
        std::printf("OK: STOP encerra o processo GHDL de forma graciosa (vpi_control(vpiFinish))\n");
    } catch (const std::exception& e) {
        const std::string logs = runProcess.logs();
        runProcess.kill();
        throw std::runtime_error(std::string(e.what()) + "\n--- logs do processo GHDL ---\n" + logs);
    }

    std::error_code ec;
    fs::remove_all(workDir, ec);
}

} // namespace

int main() {
    std::string versionLine;
    if (!ghdlAvailable(versionLine)) {
        std::printf("PULADO: GHDL nao encontrado no PATH -- ver docs/fpga-vhdl.md pra instalar.\n");
        return 0;
    }
    std::printf("GHDL detectado: %s\n", versionLine.c_str());

    const fs::path repoRoot = fs::path(__FILE__).parent_path().parent_path().parent_path().parent_path().parent_path();
    const fs::path vpiModule = fs::path(repoRoot.string() + kVpiModuleRelativePath);
    if (!fs::exists(vpiModule)) {
        std::printf("PULADO: modulo VPI nao encontrado em %s -- rode 'npm run build:fpga-vpi' primeiro.\n",
                   vpiModule.string().c_str());
        return 0;
    }

    try {
        testLockstepRoundTripAgainstRealGhdl("ghdl", vpiModule);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: %s\n", e.what());
        return 1;
    }

    std::printf("\nOK: lockstep ADVANCE_TO/TIME_REACHED contra GHDL real passou.\n");
    return 0;
}

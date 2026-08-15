// Passo 5 do plano FPGA/VHDL (golden-puzzling-quasar.md): GhdlBackend (compile com cache + run)
// contra GHDL real, através da API de mais alto nível (não mais GhdlProcessManager/GhdlArenaBridge
// direto, como em GhdlLockstepRealGhdlTest -- prova que o empacotamento em GhdlBackend preserva o
// comportamento já validado no Step 4). Mesma convenção de self-skip.
#include "fpga/GhdlBackend.hpp"
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <thread>

using namespace lasecsimul::fpga;
namespace fs = std::filesystem;

#define TEST_CHECK(expr)                                                                                             \
    do {                                                                                                             \
        if (!(expr)) throw std::runtime_error(std::string("check failed: ") + #expr + " (line " + std::to_string(__LINE__) + ")"); \
    } while (false)

namespace {

std::string uniqueDirSuffix() {
    return std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

bool ghdlAvailable(std::string& versionLine) {
    GhdlProcessManager probe;
    try {
        probe.start(GhdlLaunchSpec{"ghdl", {"--version"}, {}, {}, {}});
    } catch (const std::exception&) {
        return false;
    }
    const std::optional<int> exitCode = probe.waitForExit(std::chrono::seconds(3));
    if (!exitCode) {
        probe.kill();
        return false;
    }
    const std::string logs = probe.logs();
    if (logs.find("GHDL") == std::string::npos) return false;
    versionLine = logs.substr(0, logs.find('\n'));
    return true;
}

#if defined(_WIN32)
constexpr const char* kVpiModuleRelativePath = "/fpga/ghdl-vpi/build/win-x64/lasecsimul_vpi.dll";
#elif defined(__APPLE__)
constexpr const char* kVpiModuleRelativePath = "/fpga/ghdl-vpi/build/macos-universal/liblasecsimul_vpi.dylib";
#else
constexpr const char* kVpiModuleRelativePath = "/fpga/ghdl-vpi/build/linux-x64/liblasecsimul_vpi.so";
#endif

GhdlAdvanceReply waitForReply(GhdlBackend& backend, std::chrono::seconds timeout) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    GhdlAdvanceReply reply;
    do {
        reply = backend.pollReply();
        if (!reply.ready) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    } while (!reply.ready && std::chrono::steady_clock::now() < deadline);
    return reply;
}

void testCompileCacheAndRunRoundTrip(const std::string& ghdlBinary, const std::string& vpiModulePath) {
    const fs::path workDir = fs::temp_directory_path() / ("lasecsimul-fpga-backend-" + uniqueDirSuffix());
    const fs::path cacheDir = workDir / "cache";
    const fs::path vhdlFile = workDir / "backend_test.vhd";
    fs::create_directories(workDir);
    {
        std::ofstream out(vhdlFile);
        out << "library ieee;\n"
               "use ieee.std_logic_1164.all;\n"
               "entity backend_test is\n"
               "    port (\n"
               "        a : in  std_logic;\n"
               "        b : in  std_logic;\n"
               "        y : out std_logic\n"
               "    );\n"
               "end entity;\n"
               "architecture rtl of backend_test is\n"
               "begin\n"
               "    y <= a and b;\n"
               "end architecture;\n";
    }

    GhdlBackendOptions options;
    options.ghdlBinary = ghdlBinary;
    options.vpiModulePath = vpiModulePath;
    options.cacheRootDir = cacheDir.string();

    RtlCompileRequest request;
    request.sources = {vhdlFile.string()};
    request.topEntity = "backend_test";
    request.standard = "08";
    request.inputBitCount = 2;
    request.outputBitCount = 1;

    // Primeira compilação: cache miss, roda ghdl -a/-e de verdade.
    GhdlBackend backend(options);
    const RtlCompileResult first = backend.compile(request);
    TEST_CHECK(first.ok);
    std::printf("OK: primeira compilacao (cache miss) roda ghdl -a/-e com sucesso\n");

    // Segunda compilação (instância nova, mesmas fontes/top/standard): cache hit, não deveria
    // rodar ghdl de novo -- só confere que o marker é respeitado e reporta sucesso instantâneo.
    GhdlBackend backendForCacheCheck(options);
    const RtlCompileResult second = backendForCacheCheck.compile(request);
    TEST_CHECK(second.ok);
    TEST_CHECK(second.log.find("cache hit") != std::string::npos);
    std::printf("OK: segunda compilacao com as mesmas fontes acerta o cache\n");

    // start()/run: mesma prova de ponta a ponta de GhdlLockstepRealGhdlTest, agora através da API
    // de mais alto nível.
    backend.start();
    const auto readyDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!backend.peerReady() && std::chrono::steady_clock::now() < readyDeadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    if (!backend.peerReady()) throw std::runtime_error("GHDL nunca sinalizou peerReady -- logs:\n" + backend.logs());

    try {
        constexpr uint32_t kPortA = 0, kPortB = 1, kPortY = 2;
        const std::vector<GhdlChangeEntry> inputs = {GhdlChangeEntry{kPortA, 0, LogicValue::One},
                                                      GhdlChangeEntry{kPortB, 0, LogicValue::One}};
        backend.requestAdvanceTo(1, inputs);
        const GhdlAdvanceReply reply = waitForReply(backend, std::chrono::seconds(5));
        TEST_CHECK(reply.ready);
        TEST_CHECK(!reply.overflow);
        TEST_CHECK(reply.reachedTimeNs == 1);
        bool sawYHigh = false;
        for (const GhdlChangeEntry& change : reply.outputChanges) {
            if (change.portIndex == kPortY) {
                TEST_CHECK(change.value == LogicValue::One);
                sawYHigh = true;
            }
        }
        TEST_CHECK(sawYHigh);
        std::printf("OK: GhdlBackend::start()+requestAdvanceTo()/pollReply() -- y=1 confirmado\n");
    } catch (const std::exception& e) {
        const std::string logs = backend.logs();
        backend.stop();
        throw std::runtime_error(std::string(e.what()) + "\n--- logs do processo GHDL ---\n" + logs);
    }

    backend.stop();
    TEST_CHECK(!backend.isRunning());
    std::printf("OK: stop() encerra o processo GHDL\n");

    std::error_code ec;
    fs::remove_all(workDir, ec);
}

void testInvalidVhdlReportsCompileFailure(const std::string& ghdlBinary) {
    const fs::path workDir = fs::temp_directory_path() / ("lasecsimul-fpga-backend-bad-" + uniqueDirSuffix());
    const fs::path cacheDir = workDir / "cache";
    const fs::path vhdlFile = workDir / "broken.vhd";
    fs::create_directories(workDir);
    {
        std::ofstream out(vhdlFile);
        // Erro de sintaxe deliberado (ponto e virgula faltando) -- prova que compile() propaga
        // falha real do GHDL (nao so o caminho sintetico de GhdlProcessManagerTest), groundwork
        // pro parser de diagnostics (Step 8, Problems panel do VS Code).
        out << "library ieee;\n"
               "use ieee.std_logic_1164.all;\n"
               "entity broken is\n"
               "    port (a : in std_logic)\n" // falta ';' aqui
               "end entity;\n";
    }

    GhdlBackendOptions options;
    options.ghdlBinary = ghdlBinary;
    options.vpiModulePath = "unused-for-this-test";
    options.cacheRootDir = cacheDir.string();

    RtlCompileRequest request;
    request.sources = {vhdlFile.string()};
    request.topEntity = "broken";
    request.standard = "08";

    GhdlBackend backend(options);
    const RtlCompileResult result = backend.compile(request);
    TEST_CHECK(!result.ok);
    TEST_CHECK(!result.log.empty());
    std::printf("OK: VHDL invalido reporta falha real do GHDL (log: %.80s...)\n", result.log.c_str());

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
        testCompileCacheAndRunRoundTrip("ghdl", vpiModule.string());
        testInvalidVhdlReportsCompileFailure("ghdl");
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: %s\n", e.what());
        return 1;
    }

    std::printf("\nOK: GhdlBackend compile+cache+run contra GHDL real passou.\n");
    return 0;
}

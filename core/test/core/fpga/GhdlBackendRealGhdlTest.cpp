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

    // discoverPorts(): mecanismo real de "LasecSimul: Analyze VHDL" -- roda GHDL em modo discover
    // (sem arena) e confere que as portas voltam batendo com a entity real acima.
    const std::vector<PortSpec> discovered = backend.discoverPorts();
    TEST_CHECK(discovered.size() == 3);
    TEST_CHECK(discovered[0].name == "a" && discovered[0].isInput && discovered[0].width == 1);
    TEST_CHECK(discovered[1].name == "b" && discovered[1].isInput && discovered[1].width == 1);
    TEST_CHECK(discovered[2].name == "y" && !discovered[2].isInput && discovered[2].width == 1);
    std::printf("OK: discoverPorts() contra GHDL real bate com a entity declarada (a,b,y)\n");

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

// Testes de Cache vNext (.spec/features/fpga-ghdl.md) -- ver GhdlBackend::compile() (lock por
// chave, staging+rename atomico, entrada publicada read-only) e memoria de projeto
// project_lasecsimul_fpga_vhdl_ghdl_integration.md, secao "Cache vNext".

void testConcurrentCompilationsOfSameKeyDoNotCorruptCache(const std::string& ghdlBinary, const std::string& vpiModulePath) {
    const fs::path workDir = fs::temp_directory_path() / ("lasecsimul-fpga-backend-concurrent-" + uniqueDirSuffix());
    const fs::path cacheDir = workDir / "cache";
    const fs::path vhdlFile = workDir / "concurrent_test.vhd";
    fs::create_directories(workDir);
    {
        std::ofstream out(vhdlFile);
        out << "library ieee;\n"
               "use ieee.std_logic_1164.all;\n"
               "entity concurrent_test is\n"
               "    port (a : in std_logic; y : out std_logic);\n"
               "end entity;\n"
               "architecture rtl of concurrent_test is\n"
               "begin\n"
               "    y <= a;\n"
               "end architecture;\n";
    }

    GhdlBackendOptions options;
    options.ghdlBinary = ghdlBinary;
    options.vpiModulePath = vpiModulePath;
    options.cacheRootDir = cacheDir.string();

    RtlCompileRequest request;
    request.sources = {vhdlFile.string()};
    request.topEntity = "concurrent_test";
    request.standard = "08";

    // Duas instâncias, MESMA chave de cache, compilando ao mesmo tempo -- aceitação de Cache vNext:
    // "duas compilações concorrentes da mesma chave não corrompem cache". Antes do lock por chave
    // (ver GhdlBackend::compile()), as duas escreviam direto no MESMO diretório final -- uma podia
    // remove_all() os arquivos que a outra estava lendo/escrevendo no meio da compilação.
    bool okA = false, okB = false;
    std::string logA, logB;
    std::thread threadA([&] {
        GhdlBackend backendA(options);
        const RtlCompileResult result = backendA.compile(request);
        okA = result.ok;
        logA = result.log;
    });
    std::thread threadB([&] {
        GhdlBackend backendB(options);
        const RtlCompileResult result = backendB.compile(request);
        okB = result.ok;
        logB = result.log;
    });
    threadA.join();
    threadB.join();

    if (!okA) std::printf("log A: %s\n", logA.c_str());
    if (!okB) std::printf("log B: %s\n", logB.c_str());
    TEST_CHECK(okA);
    TEST_CHECK(okB);
    std::printf("OK: duas compilacoes concorrentes da mesma chave nao corrompem o cache\n");

    // Prova que a entrada publicada ficou íntegra: uma TERCEIRA compilação depois disso deve ser
    // hit, e discoverPorts() deve continuar funcionando (arquivos de biblioteca não corrompidos).
    GhdlBackend verifyBackend(options);
    const RtlCompileResult verifyResult = verifyBackend.compile(request);
    TEST_CHECK(verifyResult.ok);
    TEST_CHECK(verifyResult.log.find("cache hit") != std::string::npos);
    const std::vector<PortSpec> ports = verifyBackend.discoverPorts();
    TEST_CHECK(ports.size() == 2);
    std::printf("OK: entrada publicada apos a corrida continua integra (discoverPorts funciona)\n");

    std::error_code ec;
    fs::remove_all(workDir, ec);
}

void testDifferentVpiFingerprintCausesCacheMiss(const std::string& ghdlBinary) {
    const fs::path workDir = fs::temp_directory_path() / ("lasecsimul-fpga-backend-vpimiss-" + uniqueDirSuffix());
    const fs::path cacheDir = workDir / "cache";
    const fs::path vhdlFile = workDir / "vpi_miss_test.vhd";
    const fs::path vpiA = workDir / "fake_vpi_a.bin";
    const fs::path vpiB = workDir / "fake_vpi_b.bin";
    fs::create_directories(workDir);
    {
        std::ofstream out(vhdlFile);
        out << "library ieee;\n"
               "use ieee.std_logic_1164.all;\n"
               "entity vpi_miss_test is\n"
               "    port (a : in std_logic; y : out std_logic);\n"
               "end entity;\n"
               "architecture rtl of vpi_miss_test is\n"
               "begin\n"
               "    y <= a;\n"
               "end architecture;\n";
    }
    { std::ofstream(vpiA) << "fake-vpi-content-a"; }
    { std::ofstream(vpiB) << "fake-vpi-content-b-different"; }

    RtlCompileRequest request;
    request.sources = {vhdlFile.string()};
    request.topEntity = "vpi_miss_test";
    request.standard = "08";

    // Aceitação de Cache vNext: "mudança de toolchain/VPI causa miss" -- mesmas fontes/top/
    // standard, só o MÓDULO VPI referenciado muda de conteúdo (simulando uma rebuild da ABI).
    // Fingerprint do VPI não afeta a etapa de compile em si, só a CHAVE do cache -- por isso não
    // precisa de uma .dll de verdade aqui, um arquivo binário qualquer com bytes diferentes já
    // move o hash (GhdlBackend::computeCacheKey faz Sha256::hashFile(vpiModulePath)).
    GhdlBackendOptions optionsA;
    optionsA.ghdlBinary = ghdlBinary;
    optionsA.vpiModulePath = vpiA.string();
    optionsA.cacheRootDir = cacheDir.string();
    GhdlBackend backendA(optionsA);
    const RtlCompileResult resultA = backendA.compile(request);
    TEST_CHECK(resultA.ok);
    TEST_CHECK(resultA.log.find("cache hit") == std::string::npos); // 1a compilacao, sempre miss

    GhdlBackendOptions optionsB = optionsA;
    optionsB.vpiModulePath = vpiB.string();
    GhdlBackend backendB(optionsB);
    const RtlCompileResult resultB = backendB.compile(request);
    TEST_CHECK(resultB.ok);
    TEST_CHECK(resultB.log.find("cache hit") == std::string::npos); // VPI diferente -- MISS, nao hit
    std::printf("OK: trocar o modulo VPI referenciado invalida o cache (miss, nao reusa a chave antiga)\n");

    // Confere que voltar pro MESMO vpiModulePath de A bate cache de novo (prova que a diferença
    // real observada acima é o conteúdo do VPI, não algum efeito colateral do teste).
    GhdlBackend backendA2(optionsA);
    const RtlCompileResult resultA2 = backendA2.compile(request);
    TEST_CHECK(resultA2.ok);
    TEST_CHECK(resultA2.log.find("cache hit") != std::string::npos);
    std::printf("OK: voltar ao mesmo modulo VPI de antes acerta o cache de novo\n");

    std::error_code ec;
    fs::remove_all(workDir, ec);
}

void testCompileTimeoutNeverPublishesCacheHit(const std::string& ghdlBinary) {
    const fs::path workDir = fs::temp_directory_path() / ("lasecsimul-fpga-backend-timeout-" + uniqueDirSuffix());
    const fs::path cacheDir = workDir / "cache";
    const fs::path vhdlFile = workDir / "timeout_test.vhd";
    fs::create_directories(workDir);
    {
        std::ofstream out(vhdlFile);
        out << "library ieee;\n"
               "use ieee.std_logic_1164.all;\n"
               "entity timeout_test is\n"
               "    port (a : in std_logic; y : out std_logic);\n"
               "end entity;\n"
               "architecture rtl of timeout_test is\n"
               "begin\n"
               "    y <= a;\n"
               "end architecture;\n";
    }

    GhdlBackendOptions options;
    options.ghdlBinary = ghdlBinary;
    options.vpiModulePath = "unused-for-this-test";
    options.cacheRootDir = cacheDir.string();
    // Timeout absurdamente curto -- forca timeout real no 'ghdl -a' (spawn de processo sozinho já
    // passa de 1ms no mundo real). Aceitação de Cache vNext: "timeout deixa cache inválido/
    // removível" -- nunca publica um hit parcial.
    options.compileTimeout = std::chrono::milliseconds(1);

    RtlCompileRequest request;
    request.sources = {vhdlFile.string()};
    request.topEntity = "timeout_test";
    request.standard = "08";

    GhdlBackend backend(options);
    const RtlCompileResult result = backend.compile(request);
    TEST_CHECK(!result.ok);
    std::printf("OK: timeout de compilacao nunca reporta sucesso (log: %.80s...)\n", result.log.c_str());

    // Nenhuma entrada publicada (marker) deve existir depois disso -- uma compilação subsequente
    // com timeout normal deve rodar `ghdl -a/-e` de VERDADE (miss), não herdar um "hit" fantasma
    // de uma publicação parcial/corrompida.
    GhdlBackendOptions normalOptions = options;
    normalOptions.compileTimeout = std::chrono::milliseconds(30000);
    GhdlBackend retryBackend(normalOptions);
    const RtlCompileResult retryResult = retryBackend.compile(request);
    TEST_CHECK(retryResult.ok);
    TEST_CHECK(retryResult.log.find("cache hit") == std::string::npos);
    std::printf("OK: nenhuma entrada fantasma publicada -- retry com timeout normal recompila de verdade\n");

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
        testConcurrentCompilationsOfSameKeyDoNotCorruptCache("ghdl", vpiModule.string());
        testDifferentVpiFingerprintCausesCacheMiss("ghdl");
        testCompileTimeoutNeverPublishesCacheHit("ghdl");
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: %s\n", e.what());
        return 1;
    }

    std::printf("\nOK: GhdlBackend compile+cache+run contra GHDL real passou.\n");
    return 0;
}

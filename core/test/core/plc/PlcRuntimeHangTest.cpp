/**
 * F9.4: prova, com um `PROGRAM` ST de verdade (nao um double escrito a mao), que um worker preso
 * num loop infinito (`WHILE TRUE DO ... END_WHILE`, `fixtures/hang.st`) e encerrado por timeout do
 * lado do `PlcRuntime` sem derrubar o Core -- complementa (nao substitui) o teste hermetico
 * equivalente em PlcRuntimeTest.cpp (que usa `misbehaving_worker` em modo "hang" pra cobertura
 * rapida e sem dependencia externa). Depende do binario STruCpp vendorizado + toolchain C++ real,
 * por isso "external-plc", mesmo padrao/SKIP de PlcCompilerTest.cpp.
 */
#include "plc/PlcCompiler.hpp"
#include "plc/PlcRuntime.hpp"

#include <cstdio>
#include <filesystem>

namespace fs = std::filesystem;
using namespace lasecsimul::plc;

namespace {
int failures = 0;
#define CHECK(condition, message) do { if (!(condition)) { std::fprintf(stderr, "FAIL: %s\n", message); ++failures; } } while (false)

fs::path strucppBinary() {
#if defined(LASECSIMUL_TEST_STRUCPP_BINARY)
    return LASECSIMUL_TEST_STRUCPP_BINARY;
#else
    return {};
#endif
}

void realInfiniteStLoopTimesOutWithoutKillingTheCore() {
    const fs::path workDir = fs::temp_directory_path() / "plc_runtime_hang_test";
    std::error_code ec;
    fs::remove_all(workDir, ec);

    PlcCompileOptions options;
    options.stSourcePath = LASECSIMUL_TEST_PLC_HANG_FIXTURE_ST;
    options.workDir = workDir;
    options.strucppBinaryPath = strucppBinary();
    options.runtimeIncludeDir = LASECSIMUL_TEST_PLC_RUNTIME_INCLUDE_DIR;
    options.lasecsimulPlcSrcDir = LASECSIMUL_TEST_PLC_SRC_DIR;

    const PlcNativeModule module = PlcCompiler::compile(options);

    PlcRuntimeOptions runtimeOptions;
    runtimeOptions.handshakeTimeoutMs = 5000;
    runtimeOptions.stepTimeoutMs = 1500; // WHILE TRUE nunca retorna de run() -- deve estourar isto.
    runtimeOptions.shutdownTimeoutMs = 500;

    PlcRuntime runtime(module, runtimeOptions);
    runtime.ensureStarted();
    CHECK(runtime.state() == PlcRuntimeState::Ready, "handshake must succeed before the ST program ever runs a scan");

    bool threw = false;
    try {
        PlcScanRequest request;
        request.simulationTimeNs = 1000;
        request.inputs["DI0"] = "TRUE";
        (void)runtime.scan(request); // run() nunca retorna -- deve travar aqui ate o timeout.
    } catch (const PlcRuntimeError&) {
        threw = true;
    }
    CHECK(threw, "a genuine ST infinite loop inside run() must be caught as a timeout, never hang the caller forever");
    CHECK(runtime.state() == PlcRuntimeState::Faulted, "a timed-out scan against a real hung ST program must leave the runtime Faulted");
    CHECK(!runtime.workerRunning(), "the hung worker process must be force-killed after the timeout");
    // Se este processo de teste continua executando ate aqui, o Core sobreviveu ao worker travado.
}

} // namespace

int main() {
    if (strucppBinary().empty() || !fs::exists(strucppBinary())) {
        std::printf("PULADO: binario STruCpp vendorizado nao encontrado -- rode 'npm run build:strucpp'\n");
        return 0;
    }

    try {
        realInfiniteStLoopTimesOutWithoutKillingTheCore();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FAIL: unexpected exception escaped a test case: %s\n", error.what());
        return 1;
    }

    if (failures == 0) std::printf("PlcRuntime vs a real infinite ST loop (timeout, no Core impact): OK\n");
    return failures == 0 ? 0 : 1;
}

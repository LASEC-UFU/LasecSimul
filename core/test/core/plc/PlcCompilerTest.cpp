#include "plc/PlcCompiler.hpp"

#include <cstdio>
#include <filesystem>
#include <fstream>

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

PlcCompileOptions baseOptions(const fs::path& workDir) {
    PlcCompileOptions options;
    options.stSourcePath = LASECSIMUL_TEST_PLC_FIXTURE_ST;
    options.workDir = workDir;
    options.strucppBinaryPath = strucppBinary();
    options.runtimeIncludeDir = LASECSIMUL_TEST_PLC_RUNTIME_INCLUDE_DIR;
    options.lasecsimulPlcSrcDir = LASECSIMUL_TEST_PLC_SRC_DIR;
    return options;
}

bool isHexSha256(const std::string& text) {
    if (text.size() != 64) return false;
    for (char c : text) {
        if (!std::isxdigit(static_cast<unsigned char>(c))) return false;
    }
    return true;
}

void compilesHelloFixtureWithExpectedMetadata() {
    const fs::path workDir = fs::temp_directory_path() / "plc_compiler_test_hello";
    std::error_code ec;
    fs::remove_all(workDir, ec);

    const PlcNativeModule module = PlcCompiler::compile(baseOptions(workDir));

    CHECK(module.formatVersion == 1, "formatVersion must be 1");
    CHECK(module.workerProtocolVersion == 1, "workerProtocolVersion must match PlcScanSession's protocol (1)");
    CHECK(!module.targetPlatform.empty(), "targetPlatform must be populated");
    CHECK(!module.targetArch.empty(), "targetArch must be populated");
    CHECK(module.strucppVersion == "0.6.3", "strucppVersion must be read from the real binary's --version output");
    CHECK(module.runtimeRevision == module.strucppVersion, "runtimeRevision must match strucppVersion (headers come from the same release package)");
    CHECK(!module.cxxToolchainVersion.empty(), "cxxToolchainVersion must be populated");
    CHECK(isHexSha256(module.sourceHash), "sourceHash must be a real 64-hex-char SHA-256");
    CHECK(isHexSha256(module.artifactHash), "artifactHash must be a real 64-hex-char SHA-256");
    CHECK(fs::exists(module.nativeBinaryRef), "nativeBinaryRef must point to a file that actually exists (already validated by compile())");
    CHECK(module.programName == "hello", "programName must match the PROGRAM name from the ST source");

    CHECK(module.exportedIo.size() == 2, "exportedIo must contain exactly the two VAR_INPUT/VAR_OUTPUT variables from hello.st");
    bool foundInput = false, foundOutput = false;
    for (const auto& io : module.exportedIo) {
        if (io.name == "di0" && io.direction == "input" && io.iecType == "BOOL") foundInput = true;
        if (io.name == "do0" && io.direction == "output" && io.iecType == "BOOL") foundOutput = true;
    }
    CHECK(foundInput, "exportedIo must contain di0 as a BOOL input");
    CHECK(foundOutput, "exportedIo must contain do0 as a BOOL output");

    CHECK(!module.debugMap.empty(), "debugMap must be populated from #line directives (--line-directives)");
    bool sourceFileReferenced = false;
    for (const auto& entry : module.debugMap) {
        if (entry.sourceFile.find("hello.st") != std::string::npos) sourceFileReferenced = true;
    }
    CHECK(sourceFileReferenced, "debugMap entries must reference hello.st (the real #line directive target)");
}

void determinismAcrossTwoIdenticalBuilds() {
    const fs::path workDirA = fs::temp_directory_path() / "plc_compiler_test_determinism_a";
    const fs::path workDirB = fs::temp_directory_path() / "plc_compiler_test_determinism_b";
    std::error_code ec;
    fs::remove_all(workDirA, ec);
    fs::remove_all(workDirB, ec);

    const PlcNativeModule moduleA = PlcCompiler::compile(baseOptions(workDirA));
    const PlcNativeModule moduleB = PlcCompiler::compile(baseOptions(workDirB));

    CHECK(moduleA.sourceHash == moduleB.sourceHash, "sourceHash must be identical for identical source (trivially, same bytes)");
    CHECK(moduleA.artifactHash == moduleB.artifactHash,
          "artifactHash must be identical for two builds with identical source/toolchain/config -- "
          "if this fails, the compiled binary embeds something non-deterministic (timestamp, absolute path, etc.) "
          "that -Wl,--no-insert-timestamp did not fully suppress; report as a real divergence, do not silently accept.");
}

void rejectsMalformedStSourceAtParseStage() {
    const fs::path workDir = fs::temp_directory_path() / "plc_compiler_test_malformed";
    std::error_code ec;
    fs::remove_all(workDir, ec);
    fs::create_directories(workDir, ec);
    const fs::path malformedSt = workDir / "malformed.st";
    {
        std::ofstream file(malformedSt);
        file << "PROGRAM broken\nVAR_INPUT\n    di0 : BOOL;\n"; // sem END_VAR
    }

    PlcCompileOptions options = baseOptions(workDir);
    options.stSourcePath = malformedSt;

    bool threw = false;
    try {
        (void)PlcCompiler::compile(options);
    } catch (const PlcCompileError& error) {
        threw = true;
        CHECK(error.diagnostics().stage == "parse", "a missing END_VAR must fail at the parse stage, not later");
    }
    CHECK(threw, "compiling malformed ST (missing END_VAR) must throw PlcCompileError");
}

void neverSilentlyFallsBackToPathWhenCompilerIsConfigured() {
    const fs::path workDir = fs::temp_directory_path() / "plc_compiler_test_bad_toolchain";
    std::error_code ec;
    fs::remove_all(workDir, ec);

    PlcCompileOptions options = baseOptions(workDir);
    options.cxxCompilerPath = "this-compiler-does-not-exist-anywhere-xyz";

    bool threw = false;
    try {
        (void)PlcCompiler::compile(options);
    } catch (const PlcCompileError& error) {
        threw = true;
        CHECK(error.diagnostics().stage == "toolchain",
              "an explicitly-configured but nonexistent compiler must fail at the toolchain stage");
    }
    CHECK(threw, "an explicitly-configured but nonexistent compiler must never be silently replaced by a PATH fallback");
}

void noPartialArtifactWhenCxxCompilationFails() {
    const fs::path workDir = fs::temp_directory_path() / "plc_compiler_test_cxx_failure";
    std::error_code ec;
    fs::remove_all(workDir, ec);
    fs::create_directories(workDir, ec);

    // Um "PROGRAM" com VAR_INPUT do tipo IEC real DATE -- achado real (2026-08-20): a STruCpp
    // aceita DATE normalmente (nao e um tipo inventado, ela compila sem erro), mas VarTypeTag
    // (PlcVariableCommands.hpp/PlcDriverCodegen) ainda nao mapeia DATE/TOD/DT/WSTRING nesta rodada
    // -- entao a rejeicao correta acontece na etapa de codegen do PRÓPRIO LasecSimul, depois da
    // STruCpp já ter aceitado o fonte, nao na etapa "strucpp". Um nome de tipo totalmente inventado
    // (testado antes: "SOME_UNKNOWN_TYPE") na verdade falha ANTES, na própria STruCpp -- ela faz
    // sua própria validação de tipo real, então isso não exercitava o caminho de codegen.
    const fs::path unsupportedSt = workDir / "unsupported.st";
    {
        std::ofstream file(unsupportedSt);
        file << "PROGRAM unsupported\nVAR_INPUT\n    weird : DATE;\nEND_VAR\nVAR_OUTPUT\n    do0 : BOOL;\nEND_VAR\ndo0 := TRUE;\nEND_PROGRAM\n";
    }

    PlcCompileOptions options = baseOptions(workDir);
    options.stSourcePath = unsupportedSt;

    bool threw = false;
    try {
        (void)PlcCompiler::compile(options);
    } catch (const PlcCompileError& error) {
        threw = true;
        CHECK(error.diagnostics().stage == "codegen", "an unsupported IEC type in VAR_INPUT must fail at the codegen stage");
    }
    CHECK(threw, "an unsupported IEC type must cause compile() to throw");

    const fs::path expectedBinary = workDir / "unsupported"
#if defined(_WIN32)
        ".exe"
#endif
        ;
    CHECK(!fs::exists(expectedBinary), "a rejected build must never leave a binary that looks usable");
}

} // namespace

int main() {
    if (strucppBinary().empty() || !fs::exists(strucppBinary())) {
        std::printf("PULADO: binario STruCpp vendorizado nao encontrado -- rode 'npm run build:strucpp'\n");
        return 0;
    }

    try {
        compilesHelloFixtureWithExpectedMetadata();
        determinismAcrossTwoIdenticalBuilds();
        rejectsMalformedStSourceAtParseStage();
        neverSilentlyFallsBackToPathWhenCompilerIsConfigured();
        noPartialArtifactWhenCxxCompilationFails();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FAIL: unexpected exception escaped a test case: %s\n", error.what());
        return 1;
    }

    if (failures == 0) std::printf("PlcCompiler pipeline (ST->C++->driver->native, metadata, atomicity of failures): OK\n");
    return failures == 0 ? 0 : 1;
}

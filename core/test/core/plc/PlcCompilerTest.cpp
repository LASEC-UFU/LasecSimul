#include "plc/PlcCompiler.hpp"
#include "plc/PlcInterfaceParser.hpp"
#include "plc/PlcRuntime.hpp"

#include <cstdio>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;
using namespace lasecsimul::plc;
using lasecsimul::RuntimeLaunchIdentity;

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
    options.ioIdByVariableName = {{"di0", "io-input-stable"}, {"do0", "io-output-stable"}};
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
        if (io.ioId == "io-input-stable" && io.name == "di0" && io.direction == "input" && io.iecType == "BOOL") foundInput = true;
        if (io.ioId == "io-output-stable" && io.name == "do0" && io.direction == "output" && io.iecType == "BOOL") foundOutput = true;
    }
    CHECK(foundInput, "exportedIo must contain di0 as a BOOL input");
    CHECK(foundOutput, "exportedIo must contain do0 as a BOOL output");

    PlcRuntime monitorRuntime(module);
    const std::string timerOutput = monitorRuntime.get("HELLO.TIMER0.Q");
    CHECK(timerOutput.find("TIMER0.Q") != std::string::npos,
          "library TON public members must be addressable through GET without an in-project FB definition");
    monitorRuntime.shutdown();

    uint64_t launchGeneration = 0;
    PlcRuntimeOptions identityOptions;
    identityOptions.launchIdentityProvider = [&] { return RuntimeLaunchIdentity{77, 3, ++launchGeneration}; };
    PlcRuntime identityRuntime(module, identityOptions);
    PlcScanRequest identityScan;
    identityScan.simulationTimeNs = 0;
    identityScan.inputs["DI0"] = "FALSE";
    (void)identityRuntime.scan(identityScan);
    const RuntimeLaunchIdentity firstIdentity = identityRuntime.runtimeIdentity();
    identityRuntime.restart();
    (void)identityRuntime.scan(identityScan);
    const RuntimeLaunchIdentity secondIdentity = identityRuntime.runtimeIdentity();
    CHECK(firstIdentity.sessionExecutionId == 77 && firstIdentity.runtimeInstanceId == 3 &&
          firstIdentity.launchGeneration == 1, "worker launch records the reserved runtime identity");
    CHECK(secondIdentity.sessionExecutionId == firstIdentity.sessionExecutionId &&
          secondIdentity.runtimeInstanceId == firstIdentity.runtimeInstanceId &&
          secondIdentity.launchGeneration == 2, "worker relaunch preserves runtime identity and increments launch generation");
    identityRuntime.shutdown();

    CHECK(!module.debugMap.empty(), "debugMap must be populated from #line directives (--line-directives)");
    bool sourceFileReferenced = false;
    for (const auto& entry : module.debugMap) {
        if (entry.sourceFile.find("hello.st") != std::string::npos) sourceFileReferenced = true;
    }
    CHECK(sourceFileReferenced, "debugMap entries must reference hello.st (the real #line directive target)");
}

void configuredWorkerDispatchesCyclicTasksByVirtualTime() {
    const fs::path workDir = fs::temp_directory_path() / "plc_compiler_test_configured_tasks";
    std::error_code ec;
    fs::remove_all(workDir, ec);
    fs::create_directories(workDir, ec);
    const fs::path source = workDir / "main.st";
    {
        std::ofstream file(source);
        file << "PROGRAM MAIN\n"
                "VAR_OUTPUT\n  COUNT : DINT;\n  TOTAL : DINT;\nEND_VAR\n"
                "VAR\n  LOCAL_COUNT : DINT := 0;\nEND_VAR\n"
                "VAR_EXTERNAL\n  TOTAL_RUNS : DINT;\nEND_VAR\n"
                "LOCAL_COUNT := LOCAL_COUNT + 1;\nTOTAL_RUNS := TOTAL_RUNS + 1;\n"
                "COUNT := LOCAL_COUNT;\nTOTAL := TOTAL_RUNS;\n"
                "END_PROGRAM\n"
                "CONFIGURATION CFG\n"
                "VAR_GLOBAL\n  TOTAL_RUNS : DINT := 0;\nEND_VAR\n"
                "RESOURCE RES ON PLC\n"
                "TASK FAST(INTERVAL := T#5ms, PRIORITY := 2);\n"
                "TASK SLOW(INTERVAL := T#10ms, PRIORITY := 3);\n"
                "PROGRAM MAIN_FAST WITH FAST : MAIN;\n"
                "PROGRAM MAIN_SLOW WITH SLOW : MAIN;\n"
                "END_RESOURCE\nEND_CONFIGURATION\n";
    }
    PlcCompileOptions options = baseOptions(workDir);
    options.stSourcePath = source;
    const PlcNativeModule module = PlcCompiler::compile(options);
    CHECK(module.configurationName == "CFG", "artifact preserves the configured PLC configuration");
    CHECK(module.taskTable.size() == 2 && module.taskTable[0].intervalNs == 5'000'000 &&
          module.taskTable[1].intervalNs == 10'000'000 && module.taskTable[1].priority == 3,
          "artifact preserves each cyclic task period and priority");
    CHECK(module.programInstances.size() == 2 && module.programInstances[0].instanceName == "MAIN_FAST" &&
          module.programInstances[1].instanceName == "MAIN_SLOW", "artifact preserves program instance bindings");

    PlcRuntime runtime(module);
    const PlcScanResult first = runtime.scan({5'000'000, {}});
    const PlcScanResult second = runtime.scan({20'000'000, {}});
    CHECK(first.outputs.count("COUNT") && first.outputs.at("COUNT") == "1", "FAST task runs at its first virtual activation");
    CHECK(second.outputs.count("COUNT") && second.outputs.at("COUNT") == "4",
          "worker dispatches every missed FAST activation");
    CHECK(second.outputs.count("TOTAL") && second.outputs.at("TOTAL") == "6",
          "worker dispatches the SLOW instance twice and honors its higher priority before FAST");
    runtime.shutdown();
}

void configuredWorkerDispatchesSingleEventTasksExplicitly() {
    const fs::path workDir = fs::temp_directory_path() / "plc_compiler_test_event_tasks";
    std::error_code ec;
    fs::remove_all(workDir, ec);
    fs::create_directories(workDir, ec);
    const fs::path source = workDir / "main.st";
    {
        std::ofstream file(source);
        file << "PROGRAM MAIN\nVAR_INPUT\n GO : BOOL;\nEND_VAR\n"
                "VAR_OUTPUT\n COUNT : DINT;\nEND_VAR\n"
                "COUNT := COUNT + 1;\nEND_PROGRAM\n"
                "CONFIGURATION CFG\nRESOURCE RES ON PLC\n"
                "TASK ON_GO(SINGLE := GO, PRIORITY := 1);\n"
                "PROGRAM TRIGGER WITH ON_GO : MAIN;\n"
                "END_RESOURCE\nEND_CONFIGURATION\n";
    }
    PlcCompileOptions options = baseOptions(workDir);
    options.stSourcePath = source;
    const PlcNativeModule module = PlcCompiler::compile(options);
    CHECK(module.taskTable.size() == 1 && module.taskTable[0].intervalNs == 0 &&
          module.taskTable[0].eventVariable == "GO", "event task metadata is preserved in the artifact");
    PlcRuntime runtime(module);
    const auto idle = runtime.scan({0, {{"GO", "FALSE"}}});
    CHECK(idle.outputs.at("COUNT") == "0", "an event-only task does not run during a regular scan");
    PlcScanRequest activation{5'000'000, {{"GO", "TRUE"}}, {"ON_GO"}};
    const auto fired = runtime.event(activation);
    CHECK(fired.outputs.at("COUNT") == "1", "EVENT dispatches its configured SINGLE task");
    runtime.shutdown();
}

void retainedValueSurvivesWorkerShutdownAndRespawn() {
    const fs::path workDir = fs::temp_directory_path() / "plc_compiler_test_retain_restart";
    std::error_code ec;
    fs::remove_all(workDir, ec);
    fs::create_directories(workDir, ec);
    const fs::path source = workDir / "main.st";
    {
        std::ofstream file(source);
        file << "PROGRAM MAIN\n"
                "VAR_OUTPUT\n  VALUE : DINT;\nEND_VAR\n"
                "VAR RETAIN\n  COUNT : DINT := 0;\nEND_VAR\n"
                "COUNT := COUNT + 1;\nVALUE := COUNT;\nEND_PROGRAM\n";
    }
    PlcCompileOptions options = baseOptions(workDir);
    options.stSourcePath = source;
    const PlcNativeModule module = PlcCompiler::compile(options);
    CHECK(module.retainLayout == std::vector<std::string>{"COUNT:DINT"},
          "artifact publica o layout tipado da area RETAIN");
    PlcRuntimeOptions runtimeOptions;
    runtimeOptions.retainStoragePath = (workDir / "runtime-state" / "main.retain").string();
    {
        PlcRuntime runtime(module, runtimeOptions);
        const PlcScanResult first = runtime.scan({1'000'000, {}});
        CHECK(first.outputs.count("VALUE") && first.outputs.at("VALUE") == "1", "RETAIN program runs before shutdown");
        runtime.shutdown();
    }
    {
        PlcRuntime runtime(module, runtimeOptions);
        const PlcScanResult afterNewRuntime = runtime.scan({1'000'000, {}});
        CHECK(afterNewRuntime.outputs.count("VALUE") && afterNewRuntime.outputs.at("VALUE") == "2",
              "RETAIN value is restored from durable storage into a new PlcRuntime and worker");
        runtime.reset();
        const PlcScanResult cold = runtime.scan({1'000'000, {}});
        CHECK(cold.outputs.count("VALUE") && cold.outputs.at("VALUE") == "1",
              "Cold Reset deletes the durable RETAIN image and restores the declared initial value");
        runtime.shutdown();
    }

    runtimeOptions.retainStoragePath = (workDir / "runtime-state" / "crash.retain").string();
    {
        PlcRuntime runtime(module, runtimeOptions);
        const PlcScanResult beforeCrash = runtime.scan({1'000'000, {}});
        CHECK(beforeCrash.outputs.count("VALUE") && beforeCrash.outputs.at("VALUE") == "1",
              "RETAIN checkpoint is written after a committed scan");
        runtime.forceKill(); // Simulates abrupt worker/Core loss: no SHUTDOWN export is sent.
    }
    {
        PlcRuntime recovered(module, runtimeOptions);
        const PlcScanResult afterCrash = recovered.scan({1'000'000, {}});
        CHECK(afterCrash.outputs.count("VALUE") && afterCrash.outputs.at("VALUE") == "2",
              "RETAIN restores the most recent durable checkpoint after abrupt worker loss");
        recovered.shutdown();
    }
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

/** O ST canônico do editor IEC traz FUNCTION_BLOCKs antes do PROGRAM: a interface exportada é só a
 * do PROGRAM, e as locais escalares entram para o monitor. */
void interfaceParserScopesToProgram() {
    const PlcParsedInterface parsed = parsePlcProgramInterface(
        "FUNCTION_BLOCK TOGGLE\n"
        "VAR_INPUT\n  CLK : BOOL;\nEND_VAR\n"
        "VAR_OUTPUT\n  Q : BOOL;\nEND_VAR\n"
        "Q := CLK;\nEND_FUNCTION_BLOCK\n"
        "PROGRAM MAIN\n"
        "VAR_INPUT\n  START : BOOL; STOP : BOOL;\nEND_VAR\n"
        "VAR_OUTPUT\n  LAMP : BOOL;\nEND_VAR\n"
        "VAR\n  COUNT : INT := 0;\n  T1 : TON;\n  K1 AT %IX0.0 : BOOL;\nEND_VAR\n"
        "VAR CONSTANT\n  LIMIT : INT := 3;\nEND_VAR\n"
        "VARIABLE_IN_BODY := 1;\nLAMP := START;\nEND_PROGRAM\n");
    CHECK(parsed.programName == "MAIN", "program name");
    CHECK(parsed.variables.size() == 3, "FB VAR_INPUT/VAR_OUTPUT must not leak into the PROGRAM interface");
    CHECK(parsed.variables.size() == 3 && parsed.variables[0].name == "START" && parsed.variables[1].name == "STOP" &&
          parsed.variables[2].name == "LAMP" && parsed.variables[2].direction == "output",
          "two declarations on one line, in order");
    CHECK(parsed.locals.size() == 2 && parsed.locals[0].name == "COUNT" && parsed.locals[0].iecType == "INT" &&
          parsed.locals[1].name == "T1" && parsed.locals[1].iecType == "TON",
          "locals of VAR (not CONSTANT, not AT-located) are listed for the monitor");
}

void interfaceParserSelectsRequestedProgram() {
    const std::string source =
        "PROGRAM HELPER\nVAR_OUTPUT\n  WRONG : BOOL;\nEND_VAR\nEND_PROGRAM\n"
        "PROGRAM MAIN\nVAR_INPUT\n  START : BOOL;\nEND_VAR\n"
        "VAR_OUTPUT\n  LAMP : BOOL;\nEND_VAR\nEND_PROGRAM\n";
    const PlcParsedInterface parsed = parsePlcProgramInterface(source +
        "CONFIGURATION CFG\nRESOURCE RES ON PLC\n"
        "TASK FAST(INTERVAL := T#5ms, PRIORITY := 2);\n"
        "PROGRAM MAIN_INSTANCE WITH FAST : MAIN;\n"
        "END_RESOURCE\nEND_CONFIGURATION\n", "main");
    CHECK(parsed.programName == "MAIN", "requested PROGRAM is selected case-insensitively");
    CHECK(parsed.variables.size() == 2 && parsed.variables[0].name == "START" && parsed.variables[1].name == "LAMP",
          "the selected PROGRAM owns the exported interface");
    CHECK(parsed.configurationName == "CFG" && parsed.tasks.size() == 1 &&
          parsed.tasks[0].name == "FAST" && parsed.tasks[0].intervalNs == 5'000'000 && parsed.tasks[0].priority == 2,
          "configuration task metadata is parsed in virtual-time units");
    CHECK(parsed.programInstances.size() == 1 && parsed.programInstances[0].instanceName == "MAIN_INSTANCE" &&
          parsed.programInstances[0].taskName == "FAST" && parsed.programInstances[0].programName == "MAIN",
          "configured program instance binding is parsed");
}

} // namespace

int main() {
    interfaceParserScopesToProgram();
    interfaceParserSelectsRequestedProgram();
    if (strucppBinary().empty() || !fs::exists(strucppBinary())) {
        if (failures != 0) return 1;
        std::printf("PULADO: binario STruCpp vendorizado nao encontrado -- rode 'npm run build:strucpp'\n");
        return 0;
    }

    try {
        compilesHelloFixtureWithExpectedMetadata();
        configuredWorkerDispatchesCyclicTasksByVirtualTime();
        configuredWorkerDispatchesSingleEventTasksExplicitly();
        retainedValueSurvivesWorkerShutdownAndRespawn();
        determinismAcrossTwoIdenticalBuilds();
        rejectsMalformedStSourceAtParseStage();
        neverSilentlyFallsBackToPathWhenCompilerIsConfigured();
        noPartialArtifactWhenCxxCompilationFails();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FAIL: unexpected exception escaped a test case: %s\n", error.what());
        if (const auto* compileError = dynamic_cast<const PlcCompileError*>(&error))
            std::fprintf(stderr, "compile output: %s\n", compileError->diagnostics().capturedOutput.c_str());
        return 1;
    }

    if (failures == 0) std::printf("PlcCompiler pipeline (ST->C++->driver->native, metadata, atomicity of failures): OK\n");
    return failures == 0 ? 0 : 1;
}

#include "plc/PlcRuntime.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>

#include "lasecsimul/Sha256.hpp"

namespace fs = std::filesystem;
using namespace lasecsimul::plc;
using lasecsimul::Sha256;

namespace {
int failures = 0;
#define CHECK(condition, message) do { if (!(condition)) { std::fprintf(stderr, "FAIL: %s\n", message); ++failures; } } while (false)

fs::path helloWorkerBinary() { return LASECSIMUL_TEST_PLC_WORKER_HELLO_BINARY; }
fs::path misbehavingWorkerBinary() { return LASECSIMUL_TEST_PLC_MISBEHAVING_WORKER_BINARY; }

/** `PlcRuntime`/`Process::start()` spawna `nativeBinaryRef` como um caminho de executavel puro,
 * sem argv extra -- nenhum `PlcNativeModule` real precisa disso. Pra selecionar o modo de mau
 * comportamento do `misbehaving_worker` sem inventar um mecanismo de CLI só pro teste, o modo e
 * passado por variavel de ambiente do processo pai (herdada pelo worker spawnado -- ver
 * fixtures/misbehaving_worker.cpp). Setada aqui, ANTES de cada `ensureStarted()` que precisar de
 * um modo especifico -- os testes rodam sequencialmente num unico main(), entao nao ha
 * concorrencia entre o set e o spawn correspondente. */
void setMisbehaveMode(const std::string& mode) {
#if defined(_WIN32)
    _putenv_s("LASECSIMUL_PLC_TEST_MISBEHAVE_MODE", mode.c_str());
#else
    setenv("LASECSIMUL_PLC_TEST_MISBEHAVE_MODE", mode.c_str(), 1);
#endif
}

PlcNativeModule makeModule(const fs::path& binaryPath) {
    PlcNativeModule module;
    module.workerProtocolVersion = 1;
    module.programName = "hello";
    module.nativeBinaryRef = binaryPath.string();
    module.artifactHash = Sha256::hashFile(binaryPath);
    return module;
}

PlcRuntimeOptions fastOptions() {
    PlcRuntimeOptions options;
    options.handshakeTimeoutMs = 3000;
    options.stepTimeoutMs = 300;
    options.shutdownTimeoutMs = 500;
    return options;
}

void spawnsAndValidatesHandshake() {
    PlcRuntime runtime(makeModule(helloWorkerBinary()), fastOptions());
    runtime.ensureStarted();
    CHECK(runtime.state() == PlcRuntimeState::Ready, "ensureStarted() must reach Ready after a valid handshake");
    CHECK(runtime.workerRunning(), "the worker process must be running after a valid handshake");
    CHECK(runtime.workerProcessId() != 0, "a real worker process id must be reported once running");
    runtime.shutdown();
    CHECK(runtime.state() == PlcRuntimeState::Stopped, "shutdown() must leave the runtime Stopped");
    CHECK(!runtime.workerRunning(), "shutdown() must leave no worker process running");
}

void protocolAndIdentityMismatchAreRejected() {
    {
        setMisbehaveMode("bad-protocol");
        PlcRuntime runtime(makeModule(misbehavingWorkerBinary()), fastOptions());
        bool threw = false;
        try { runtime.ensureStarted(); } catch (const PlcRuntimeError&) { threw = true; }
        CHECK(threw, "a mismatched workerProtocolVersion in the HELLO response must be rejected");
        CHECK(runtime.state() == PlcRuntimeState::Faulted, "a rejected handshake must leave the runtime Faulted");
    }
    {
        setMisbehaveMode("bad-program");
        PlcRuntime runtime(makeModule(misbehavingWorkerBinary()), fastOptions());
        bool threw = false;
        try { runtime.ensureStarted(); } catch (const PlcRuntimeError&) { threw = true; }
        CHECK(threw, "an unexpected program identity in the HELLO response must be rejected");
        CHECK(runtime.state() == PlcRuntimeState::Faulted, "a rejected identity check must leave the runtime Faulted");
    }
}

void artifactHashMismatchIsRejectedBeforeSpawning() {
    PlcNativeModule module = makeModule(helloWorkerBinary());
    module.artifactHash = std::string(64, '0'); // real file, hash deliberadamente errado.
    PlcRuntime runtime(module, fastOptions());
    bool threw = false;
    try { runtime.ensureStarted(); } catch (const PlcRuntimeError&) { threw = true; }
    CHECK(threw, "an artifactHash mismatch must be rejected");
    CHECK(runtime.state() == PlcRuntimeState::Faulted, "an artifactHash mismatch must leave the runtime Faulted");
    CHECK(!runtime.workerRunning(), "a binary with a mismatched hash must never be spawned");
}

void validScanReturnsCompleteSnapshot() {
    PlcRuntime runtime(makeModule(helloWorkerBinary()), fastOptions());
    runtime.ensureStarted();

    PlcScanRequest r1; r1.simulationTimeNs = 0; r1.inputs["DI0"] = "FALSE";
    CHECK(runtime.scan(r1).outputs.at("DO0") == "FALSE", "first scan (no rising edge) must report DO0=FALSE");

    PlcScanRequest r2; r2.simulationTimeNs = 100000000; r2.inputs["DI0"] = "TRUE";
    CHECK(runtime.scan(r2).outputs.at("DO0") == "FALSE", "TON must not assert Q immediately on rising edge");

    PlcScanRequest r3; r3.simulationTimeNs = 400000000; r3.inputs["DI0"] = "TRUE";
    CHECK(runtime.scan(r3).outputs.at("DO0") == "FALSE", "TON must not assert Q before PT elapses");

    PlcScanRequest r4; r4.simulationTimeNs = 700000000; r4.inputs["DI0"] = "TRUE";
    CHECK(runtime.scan(r4).outputs.at("DO0") == "TRUE", "TON must assert Q once PT has elapsed in simulated time");
    CHECK(runtime.lastAcceptedSimulationTimeNs() == 700000000, "lastAcceptedSimulationTimeNs must track the last accepted scan");

    runtime.shutdown();
}

void getSetForceUnforceWorkThroughRuntime() {
    PlcRuntime runtime(makeModule(helloWorkerBinary()), fastOptions());
    runtime.ensureStarted();

    const std::string get1 = runtime.get("HELLO.DO0");
    CHECK(get1.find("DO0") != std::string::npos, "GET must succeed and echo the variable name");

    const std::string set1 = runtime.set("HELLO.DI0", "TRUE");
    CHECK(set1.find("DI0") != std::string::npos, "SET must succeed on a known input variable");

    const std::string force1 = runtime.force("HELLO.DO0", "TRUE");
    CHECK(force1.find("FORCED") != std::string::npos, "FORCE must report the variable as forced");

    const std::string get2 = runtime.get("HELLO.DO0");
    CHECK(get2.find("FORCED") != std::string::npos, "a forced variable must be observably forced via GET");

    const std::string unforce1 = runtime.unforce("HELLO.DO0");
    CHECK(unforce1.find("DO0") != std::string::npos, "UNFORCE must succeed on a forced variable");

    CHECK(runtime.state() == PlcRuntimeState::Ready, "GET/SET/FORCE/UNFORCE must never fault a healthy runtime");
    runtime.shutdown();
}

void wrongRequestIdIsRejected() {
    setMisbehaveMode("wrong-request-id");
    PlcRuntime runtime(makeModule(misbehavingWorkerBinary()), fastOptions());
    runtime.ensureStarted();
    CHECK(runtime.state() == PlcRuntimeState::Ready, "a well-formed HELLO must still succeed even in this misbehaving mode");

    bool threw = false;
    try { (void)runtime.get("HELLO.DO0"); } catch (const PlcRuntimeError&) { threw = true; }
    CHECK(threw, "a response carrying the wrong requestId must be rejected");
    CHECK(runtime.state() == PlcRuntimeState::Faulted, "a wrong requestId must leave the runtime Faulted");
}

void malformedResponseFaultsTheRuntime() {
    setMisbehaveMode("malformed-response");
    PlcRuntime runtime(makeModule(misbehavingWorkerBinary()), fastOptions());
    runtime.ensureStarted();

    bool threw = false;
    try { (void)runtime.get("HELLO.DO0"); } catch (const PlcRuntimeError&) { threw = true; }
    CHECK(threw, "a malformed response line must be rejected");
    CHECK(runtime.state() == PlcRuntimeState::Faulted, "a malformed response must leave the runtime Faulted");
}

void truncatedResponseFaultsTheRuntime() {
    setMisbehaveMode("truncated-response");
    PlcRuntime runtime(makeModule(misbehavingWorkerBinary()), fastOptions());
    runtime.ensureStarted();

    bool threw = false;
    try { (void)runtime.get("HELLO.DO0"); } catch (const PlcRuntimeError&) { threw = true; }
    CHECK(threw, "a truncated (no-newline) response followed by process exit must be rejected");
    CHECK(runtime.state() == PlcRuntimeState::Faulted, "a truncated response must leave the runtime Faulted");
}

void unexpectedlyTerminatedWorkerFaults() {
    setMisbehaveMode("crash-after-hello");
    PlcRuntime runtime(makeModule(misbehavingWorkerBinary()), fastOptions());
    runtime.ensureStarted();
    CHECK(runtime.state() == PlcRuntimeState::Ready, "the handshake itself must succeed before the worker crashes");

    bool threw = false;
    try { (void)runtime.get("HELLO.DO0"); } catch (const PlcRuntimeError&) { threw = true; }
    CHECK(threw, "a worker that exited right after HELLO must be detected on the next request");
    CHECK(runtime.state() == PlcRuntimeState::Faulted, "an unexpectedly terminated worker must leave the runtime Faulted");
}

void hungWorkerTimesOutWithoutKillingTheCore() {
    setMisbehaveMode("hang");
    PlcRuntime runtime(makeModule(misbehavingWorkerBinary()), fastOptions());
    runtime.ensureStarted();

    bool threw = false;
    try {
        PlcScanRequest request; request.simulationTimeNs = 1000;
        (void)runtime.scan(request);
    } catch (const PlcRuntimeError&) { threw = true; }
    CHECK(threw, "a worker that never responds must time out rather than hang the caller forever");
    CHECK(runtime.state() == PlcRuntimeState::Faulted, "a timed-out worker must leave the runtime Faulted");
    CHECK(runtime.faultMessage().find("timeout") != std::string::npos, "the fault message should identify a timeout");
    CHECK(!runtime.workerRunning(), "a timed-out worker must be force-killed, not left running in the background");
    // Se chegamos ate aqui sem o processo de teste travar/morrer junto, o Core (este processo)
    // sobreviveu ao worker travado -- exatamente a garantia pedida.
}

void failureAfterScanReceivedNeverPublishesOutputs() {
    setMisbehaveMode("exit-after-scan-received");
    PlcRuntime runtime(makeModule(misbehavingWorkerBinary()), fastOptions());
    runtime.ensureStarted();
    CHECK(runtime.lastAcceptedSimulationTimeNs() == -1, "no scan must have been accepted yet");

    bool threw = false;
    try {
        PlcScanRequest request; request.simulationTimeNs = 1000;
        (void)runtime.scan(request); // nunca deve retornar um PlcScanResult aqui.
    } catch (const PlcRuntimeError&) { threw = true; }
    CHECK(threw, "a worker that dies after receiving SCAN but before responding must fault, never return a partial result");
    CHECK(runtime.state() == PlcRuntimeState::Faulted, "this failure must leave the runtime Faulted");
    CHECK(runtime.lastAcceptedSimulationTimeNs() == -1, "a failed scan must never update lastAcceptedSimulationTimeNs");
}

void restartCreatesDeterministicState() {
    PlcRuntime runtime(makeModule(helloWorkerBinary()), fastOptions());
    runtime.ensureStarted();

    PlcScanRequest r1; r1.simulationTimeNs = 0; r1.inputs["DI0"] = "TRUE";
    runtime.scan(r1);
    PlcScanRequest r2; r2.simulationTimeNs = 700000000; r2.inputs["DI0"] = "TRUE";
    const auto beforeReset = runtime.scan(r2);
    CHECK(beforeReset.outputs.at("DO0") == "TRUE", "setup: TON must have asserted Q before reset");
    CHECK(runtime.lastAcceptedSimulationTimeNs() == 700000000, "setup: lastAcceptedSimulationTimeNs must reflect the last scan");

    runtime.restart();
    CHECK(runtime.state() == PlcRuntimeState::Ready, "restart() must leave the runtime Ready again");
    CHECK(runtime.lastAcceptedSimulationTimeNs() == -1, "restart() must clear the known simulated time");

    // Um SCAN em t=0 (que seria rejeitado como regressivo antes do restart) deve ser aceito de novo
    // e a instancia deve estar genuinamente fresca (DO0=FALSE), nao carregando estado da instancia
    // anterior -- prova que restart() sobe uma instancia nova de verdade, nao so zera contadores.
    PlcScanRequest r3; r3.simulationTimeNs = 0; r3.inputs["DI0"] = "FALSE";
    const auto afterReset = runtime.scan(r3);
    CHECK(afterReset.outputs.at("DO0") == "FALSE", "restart() must produce a genuinely fresh instance, not carry over prior state");
    runtime.shutdown();
}

void multipleInstancesNeverInterfere() {
    PlcRuntime runtimeA(makeModule(helloWorkerBinary()), fastOptions());
    PlcRuntime runtimeB(makeModule(helloWorkerBinary()), fastOptions());
    runtimeA.ensureStarted();
    runtimeB.ensureStarted();
    CHECK(runtimeA.workerProcessId() != runtimeB.workerProcessId(), "independent instances must run as distinct processes");

    PlcScanRequest a1; a1.simulationTimeNs = 0; a1.inputs["DI0"] = "TRUE";
    runtimeA.scan(a1);
    PlcScanRequest a2; a2.simulationTimeNs = 700000000; a2.inputs["DI0"] = "TRUE";
    const auto resultA = runtimeA.scan(a2);

    PlcScanRequest b1; b1.simulationTimeNs = 0; b1.inputs["DI0"] = "FALSE";
    runtimeB.scan(b1);
    PlcScanRequest b2; b2.simulationTimeNs = 100000000; b2.inputs["DI0"] = "TRUE";
    const auto resultB = runtimeB.scan(b2);

    CHECK(resultA.outputs.at("DO0") == "TRUE", "instance A (700ms elapsed since rising edge) must have DO0=TRUE");
    CHECK(resultB.outputs.at("DO0") == "FALSE", "instance B (only 100ms elapsed since rising edge) must have DO0=FALSE");
    CHECK(runtimeA.lastAcceptedSimulationTimeNs() == 700000000, "instance A's clock must be independent of B's");
    CHECK(runtimeB.lastAcceptedSimulationTimeNs() == 100000000, "instance B's clock must be independent of A's");

    runtimeA.shutdown();
    runtimeB.shutdown();
}

} // namespace

int main() {
    try {
        spawnsAndValidatesHandshake();
        protocolAndIdentityMismatchAreRejected();
        artifactHashMismatchIsRejectedBeforeSpawning();
        validScanReturnsCompleteSnapshot();
        getSetForceUnforceWorkThroughRuntime();
        wrongRequestIdIsRejected();
        malformedResponseFaultsTheRuntime();
        truncatedResponseFaultsTheRuntime();
        unexpectedlyTerminatedWorkerFaults();
        hungWorkerTimesOutWithoutKillingTheCore();
        failureAfterScanReceivedNeverPublishesOutputs();
        restartCreatesDeterministicState();
        multipleInstancesNeverInterfere();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FAIL: unexpected exception escaped a test case: %s\n", error.what());
        return 1;
    }

    if (failures == 0) std::printf("PlcRuntime worker lifecycle (handshake/scan/fault/reset/isolation): OK\n");
    return failures == 0 ? 0 : 1;
}

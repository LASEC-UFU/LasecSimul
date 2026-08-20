#include "plc/PlcScanSession.hpp"

#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "fixtures/hello.generated.hpp"

using namespace lasecsimul::plc;

namespace {
int failures = 0;
#define CHECK(condition, message) do { if (!(condition)) { std::fprintf(stderr, "FAIL: %s\n", message); ++failures; } } while (false)

struct HelloFixture {
    strucpp::Program_HELLO program;
    // Precisa sobreviver enquanto a PlcScanSession existir -- ProgramDescriptor::vars aponta pra
    // dentro deste vector, nao e copiado pelo PlcScanSession. Endereco de `program` em si e
    // estavel entre resets (placement-new reconstroi no mesmo lugar), entao os ponteiros aqui
    // dentro continuam validos mesmo depois de RESET.
    std::vector<VarDescriptor> allVars;

    PlcScanSession makeSession() {
        allVars = {
            {"DI0", VarTypeTag::BOOL, &program.DI0},
            {"DO0", VarTypeTag::BOOL, &program.DO0},
            {"TIMER0", VarTypeTag::OTHER, &program.TIMER0},
        };
        std::vector<VarDescriptor> inputVars = {{"DI0", VarTypeTag::BOOL, &program.DI0}};
        std::vector<VarDescriptor> outputVars = {{"DO0", VarTypeTag::BOOL, &program.DO0}};
        ProgramDescriptor descriptor{"HELLO", &program, allVars.data(), allVars.size(), 0LL};
        return PlcScanSession(descriptor, std::move(inputVars), std::move(outputVars), [this] {
            program.~Program_HELLO();
            new (&program) strucpp::Program_HELLO();
        });
    }
};

void oneScanPerCommandAndTonTiming() {
    HelloFixture fixture;
    PlcScanSession session = fixture.makeSession();

    const std::string hello = session.handleLine("HELLO r0");
    CHECK(hello == "OK r0 protocol=1 program=HELLO", "HELLO handshake must report protocol version and program name");

    // t=0, DI0=false: sem borda de subida ainda.
    std::string r1 = session.handleLine("SCAN r1 0 DI0=FALSE");
    CHECK(r1 == "OK r1 DO0=FALSE", "first scan (no rising edge) must report DO0=FALSE");
    CHECK(session.scanCount() == 1, "exactly one scan must have executed after one SCAN command");

    // t=100ms, DI0=true: borda de subida, TON entra em STATE=1, ainda nao decorreu PT (500ms).
    std::string r2 = session.handleLine("SCAN r2 100000000 DI0=TRUE");
    CHECK(r2 == "OK r2 DO0=FALSE", "TON must not assert Q immediately on rising edge");
    CHECK(session.scanCount() == 2, "exactly two scans must have executed after two SCAN commands");

    // t=400ms, DI0=true: decorridos 300ms desde a borda (100ms->400ms), ainda < 500ms.
    std::string r3 = session.handleLine("SCAN r3 400000000 DI0=TRUE");
    CHECK(r3 == "OK r3 DO0=FALSE", "TON must not assert Q before PT elapses (simulated time, not wall clock)");

    // t=700ms, DI0=true: decorridos 600ms desde a borda (100ms->700ms), >= 500ms -> Q=TRUE.
    std::string r4 = session.handleLine("SCAN r4 700000000 DI0=TRUE");
    CHECK(r4 == "OK r4 DO0=TRUE", "TON must assert Q once PT has elapsed in simulated time");
    CHECK(session.lastAcceptedTimeNs() == 700000000, "lastAcceptedTimeNs must track the last accepted scan");
}

void monotonicSimulationTime() {
    HelloFixture fixture;
    PlcScanSession session = fixture.makeSession();
    session.handleLine("SCAN r1 1000 DI0=FALSE");
    session.handleLine("SCAN r2 2000 DI0=FALSE");

    const std::string sameTime = session.handleLine("SCAN r3 2000 DI0=FALSE");
    CHECK(sameTime.rfind("ERR r3", 0) == 0, "SCAN with the same simulationTimeNs as the last accepted scan must be rejected");
    CHECK(session.scanCount() == 2, "a rejected same-timestamp scan must not execute run()");
    CHECK(session.lastAcceptedTimeNs() == 2000, "a rejected scan must not change lastAcceptedTimeNs");

    const std::string regressed = session.handleLine("SCAN r4 1500 DI0=FALSE");
    CHECK(regressed.rfind("ERR r4", 0) == 0, "SCAN with a regressed simulationTimeNs must be rejected");
    CHECK(session.scanCount() == 2, "a rejected regressed scan must not execute run()");
}

void inspectAndForceNeverAdvanceExecution() {
    HelloFixture fixture;
    PlcScanSession session = fixture.makeSession();
    session.handleLine("SCAN r1 1000 DI0=TRUE");
    const uint64_t scansBefore = session.scanCount();
    const int64_t timeBefore = session.lastAcceptedTimeNs();

    const std::string get = session.handleLine("GET r2 HELLO.DO0");
    CHECK(get.rfind("OK r2", 0) == 0, "GET on a stopped instance must succeed");
    CHECK(session.scanCount() == scansBefore && session.lastAcceptedTimeNs() == timeBefore,
          "GET must never advance the scan count or the simulated time");

    const std::string force = session.handleLine("FORCE r3 HELLO.DO0 TRUE");
    CHECK(force.rfind("OK r3", 0) == 0, "FORCE must succeed on a known variable");
    CHECK(session.scanCount() == scansBefore && session.lastAcceptedTimeNs() == timeBefore,
          "FORCE must never advance the scan count or the simulated time");

    const std::string getForced = session.handleLine("GET r4 HELLO.DO0");
    CHECK(getForced.find("FORCED") != std::string::npos, "a forced variable must be observably forced via GET");

    const std::string unforce = session.handleLine("UNFORCE r5 HELLO.DO0");
    CHECK(unforce.rfind("OK r5", 0) == 0, "UNFORCE must succeed");
    CHECK(session.scanCount() == scansBefore && session.lastAcceptedTimeNs() == timeBefore,
          "UNFORCE must never advance the scan count or the simulated time");

    const std::string set = session.handleLine("SET r6 HELLO.DI0 FALSE");
    CHECK(set.rfind("OK r6", 0) == 0, "SET must succeed on a known input variable");
    CHECK(session.scanCount() == scansBefore && session.lastAcceptedTimeNs() == timeBefore,
          "SET must never advance the scan count or the simulated time");
}

void atomicScanIoRejectsInvalidInputWithoutSideEffects() {
    HelloFixture fixture;
    PlcScanSession session = fixture.makeSession();
    session.handleLine("SCAN r1 1000 DI0=TRUE");
    CHECK(session.scanCount() == 1, "setup scan must have executed");

    // DI0 e valido, mas UNKNOWN_INPUT nao existe -- o scan inteiro deve ser rejeitado, incluindo
    // a atribuicao valida de DI0.
    const std::string invalid = session.handleLine("SCAN r2 2000 DI0=FALSE UNKNOWN_INPUT=1");
    CHECK(invalid.rfind("ERR r2", 0) == 0, "SCAN referencing an unknown input must be rejected entirely");
    CHECK(session.scanCount() == 1, "a rejected scan must never call run()");
    CHECK(session.lastAcceptedTimeNs() == 1000, "a rejected scan must not update lastAcceptedTimeNs");

    const std::string getDi0 = session.handleLine("GET r3 HELLO.DI0");
    CHECK(getDi0.find("TRUE") != std::string::npos,
          "DI0 must still be TRUE from the last successful scan -- the rejected scan's DI0=FALSE must never have been applied");

    // Valor sintaticamente invalido pro tipo (BOOL) tambem rejeita o scan inteiro.
    const std::string badValue = session.handleLine("SCAN r4 2000 DI0=NOTABOOL");
    CHECK(badValue.rfind("ERR r4", 0) == 0, "SCAN with a syntactically invalid value must be rejected entirely");
    CHECK(session.scanCount() == 1, "a rejected scan (invalid value) must never call run()");
}

void resetClearsSessionStateAndInstance() {
    HelloFixture fixture;
    PlcScanSession session = fixture.makeSession();
    session.handleLine("SCAN r1 0 DI0=TRUE");
    session.handleLine("SCAN r2 700000000 DI0=TRUE");
    CHECK(session.scanCount() == 2, "setup scans must have executed");

    const std::string reset = session.handleLine("RESET r3");
    CHECK(reset == "OK r3", "RESET must succeed");
    CHECK(!session.hasScanned(), "RESET must clear hasScanned()");
    CHECK(session.lastAcceptedTimeNs() == -1, "RESET must clear lastAcceptedTimeNs()");
    CHECK(session.scanCount() == 0, "RESET must clear scanCount()");

    // Depois do reset, um SCAN em t=0 (que seria rejeitado como regressivo antes do reset) deve
    // ser aceito de novo -- prova que o relogio simulado conhecido foi genuinamente redefinido.
    const std::string afterReset = session.handleLine("SCAN r4 0 DI0=FALSE");
    CHECK(afterReset == "OK r4 DO0=FALSE", "a scan at t=0 after RESET must be accepted and start from known initial state");
}

void reservedDebugCommandsAreExplicitlyNotImplemented() {
    HelloFixture fixture;
    PlcScanSession session = fixture.makeSession();
    for (const char* command : {"PAUSE r1", "CONTINUE r1", "STEP_SCAN r1", "SET_BREAKPOINT r1", "CLEAR_BREAKPOINT r1"}) {
        const std::string response = session.handleLine(command);
        CHECK(response.rfind("ERR r1", 0) == 0, "reserved debug commands must return an explicit ERR, not silently succeed or crash");
    }
}

} // namespace

int main() {
    oneScanPerCommandAndTonTiming();
    monotonicSimulationTime();
    inspectAndForceNeverAdvanceExecution();
    atomicScanIoRejectsInvalidInputWithoutSideEffects();
    resetClearsSessionStateAndInstance();
    reservedDebugCommandsAreExplicitlyNotImplemented();
    if (failures == 0) std::printf("PlcScanSession contract (scan/time/atomicity/inspect): OK\n");
    return failures == 0 ? 0 : 1;
}

// Passo 3 do plano FPGA/VHDL (golden-puzzling-quasar.md): GhdlProcessManager, sem GHDL real --
// mesma técnica de auto-spawn de QemuProcessManagerTest.cpp (o próprio executável de teste faz de
// conta de processo GHDL quando chamado com um dos modos --fake-*).
#include "fpga/GhdlProcessManager.hpp"
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>

using lasecsimul::fpga::GhdlLaunchSpec;
using lasecsimul::fpga::GhdlProcessManager;

namespace {

int runFakeChild(const char* mode) {
    if (std::strcmp(mode, "--fake-short") == 0) {
        std::printf("fake-ghdl-ready\n");
        std::fflush(stdout);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        return 0;
    }
    if (std::strcmp(mode, "--fake-hang") == 0) {
        std::printf("fake-ghdl-hanging\n");
        std::fflush(stdout);
        std::this_thread::sleep_for(std::chrono::seconds(30));
        return 0;
    }
    if (std::strcmp(mode, "--fake-print-env") == 0) {
        const char* mode2 = std::getenv("LASECSIMUL_FPGA_MODE");
        const char* arena = std::getenv("LASECSIMUL_FPGA_ARENA_NAME");
        std::printf("env-mode=%s env-arena=%s\n", mode2 ? mode2 : "(unset)", arena ? arena : "(unset)");
        std::fflush(stdout);
        return 0;
    }
    return 2;
}

void waitForLog(GhdlProcessManager& manager, const char* text) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (std::chrono::steady_clock::now() < deadline) {
        if (manager.logs().find(text) != std::string::npos) return;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    assert(false && "timed out waiting for process log");
}

void testStartStopAndLogs(const char* self) {
    GhdlProcessManager manager;
    manager.start(GhdlLaunchSpec{self, {"--fake-short"}, {}});
    waitForLog(manager, "fake-ghdl-ready");
    const bool graceful = manager.stop(std::chrono::seconds(2));
    assert(graceful);
    assert(!manager.isRunning());
    assert(manager.logs().find("fake-ghdl-ready") != std::string::npos);
    std::printf("OK: start/stop/logs do caminho feliz\n");
}

void testUtf8AndSpacesInCommandLine(const char* self) {
    GhdlProcessManager manager;
    // Mesma regressão coberta em QemuProcessManagerTest: caminho de projeto VHDL do usuário pode
    // ter espaços e caracteres não-ASCII (ex.: "meu projeto/contador.vhd").
    manager.start(GhdlLaunchSpec{self, {"--fake-short", "meu projeto com espa\xC3\xA7o"}, {}});
    waitForLog(manager, "fake-ghdl-ready");
    manager.stop(std::chrono::seconds(2));
    assert(!manager.isRunning());
    std::printf("OK: UTF-8 e espacos na linha de comando\n");
}

void testKillHungProcess(const char* self) {
    GhdlProcessManager manager;
    manager.start(GhdlLaunchSpec{self, {"--fake-hang"}, {}});
    waitForLog(manager, "fake-ghdl-hanging");
    assert(manager.isRunning());
    manager.kill();
    assert(!manager.isRunning());
    std::printf("OK: kill() derruba processo travado (Caso E: crash/hang isolado do Core)\n");
}

void testMissingBinaryReportsError() {
    GhdlProcessManager manager;
    bool threw = false;
    try {
        manager.start(GhdlLaunchSpec{"", {}, {}});
    } catch (const std::runtime_error&) {
        threw = true;
    }
    assert(threw);
    std::printf("OK: binario GHDL vazio/ausente lanca em vez de falhar em silencio\n");
}

void testEnvironmentOverridesReachChildProcess(const char* self) {
    // lasecsimul_vpi.c le LASECSIMUL_FPGA_MODE/LASECSIMUL_FPGA_ARENA_NAME do ambiente do processo
    // (GHDL nao repassa argv extra pro modulo VPI) -- prova que o mecanismo de injecao funciona
    // nos dois SOs antes de depender dele contra um GHDL real.
    GhdlProcessManager manager;
    GhdlLaunchSpec spec{self, {"--fake-print-env"}, {}};
    spec.environmentOverrides = {{"LASECSIMUL_FPGA_MODE", "run"}, {"LASECSIMUL_FPGA_ARENA_NAME", "lasecsimul-fpga-test-arena"}};
    manager.start(spec);
    waitForLog(manager, "env-mode=");
    manager.stop(std::chrono::seconds(2));
    const std::string logs = manager.logs();
    assert(logs.find("env-mode=run") != std::string::npos);
    assert(logs.find("env-arena=lasecsimul-fpga-test-arena") != std::string::npos);
    std::printf("OK: environmentOverrides chegam ao processo filho (LASECSIMUL_FPGA_MODE/ARENA_NAME)\n");
}

void testDiagnosticsPrefixAppearsInLogsBeforeProcessOutput(const char* self) {
    GhdlProcessManager manager;
    manager.start(GhdlLaunchSpec{self, {"--fake-short"}, "[GhdlProcessManager] resolvido via PATH\n"});
    waitForLog(manager, "fake-ghdl-ready");
    const std::string logs = manager.logs();
    const size_t diagPos = logs.find("resolvido via PATH");
    const size_t readyPos = logs.find("fake-ghdl-ready");
    assert(diagPos != std::string::npos && readyPos != std::string::npos && diagPos < readyPos);
    manager.stop(std::chrono::seconds(2));
    std::printf("OK: diagnostico de resolucao de binario aparece antes da saida do processo\n");
}

} // namespace

int main(int argc, char** argv) {
    if (argc >= 2 && std::strncmp(argv[1], "--fake-", 7) == 0) return runFakeChild(argv[1]);

    testStartStopAndLogs(argv[0]);
    testUtf8AndSpacesInCommandLine(argv[0]);
    testKillHungProcess(argv[0]);
    testMissingBinaryReportsError();
    testEnvironmentOverridesReachChildProcess(argv[0]);
    testDiagnosticsPrefixAppearsInLogsBeforeProcessOutput(argv[0]);
    std::printf("\nOK: GhdlProcessManager fake process lifecycle passed.\n");
    return 0;
}

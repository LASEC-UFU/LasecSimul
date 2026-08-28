#include "mcu/qemu/QemuProcessManager.hpp"
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>

using lasecsimul::QemuLaunchSpec;
using lasecsimul::mcu::qemu::QemuProcessManager;

namespace {

int runFakeChild(const char* mode) {
    if (std::strcmp(mode, "--env-child") == 0) {
        const char* a = std::getenv("LASECSIMUL_SESSION_EXECUTION_ID");
        const char* b = std::getenv("LASECSIMUL_RUNTIME_INSTANCE_ID");
        const char* c = std::getenv("LASECSIMUL_LAUNCH_GENERATION");
        const char* p = std::getenv("LASECSIMUL_ENV_PRESERVATION_TEST");
        std::printf("env=%s,%s,%s,%s\n", a?a:"", b?b:"", c?c:"", p?p:""); std::fflush(stdout); return 0;
    }
    if (std::strcmp(mode, "--fake-short") == 0) {
        std::printf("fake-qemu-ready\n");
        std::fflush(stdout);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        return 0;
    }
    if (std::strcmp(mode, "--fake-hang") == 0) {
        std::printf("fake-qemu-hanging\n");
        std::fflush(stdout);
        std::this_thread::sleep_for(std::chrono::seconds(30));
        return 0;
    }
    return 2;
}

void waitForLog(QemuProcessManager& manager, const char* text) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (std::chrono::steady_clock::now() < deadline) {
        if (manager.logs().find(text) != std::string::npos) return;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    assert(false && "timed out waiting for process log");
}

void testStartStopAndLogs(const char* self) {
    QemuProcessManager manager;
    manager.start(QemuLaunchSpec{self, {"--fake-short"}});
    waitForLog(manager, "fake-qemu-ready");
    const bool graceful = manager.stop(std::chrono::seconds(2));
    assert(graceful);
    assert(!manager.isRunning());
    assert(manager.logs().find("fake-qemu-ready") != std::string::npos);
}

void testUtf8AndSpacesInCommandLine(const char* self) {
    QemuProcessManager manager;
    // Regressão do heap overflow em widen(): cada argumento reserva e escreve também o NUL.
    // O firmware real do relato fica em uma árvore com espaços e caracteres não ASCII.
    manager.start(QemuLaunchSpec{self, {"--fake-short", "a\xC3\xA7\xC3\xA3o com espa\xC3\xA7o"}});
    waitForLog(manager, "fake-qemu-ready");
    manager.stop(std::chrono::seconds(2));
    assert(!manager.isRunning());
}

void testKillHungProcess(const char* self) {
    QemuProcessManager manager;
    manager.start(QemuLaunchSpec{self, {"--fake-hang"}});
    waitForLog(manager, "fake-qemu-hanging");
    assert(manager.isRunning());
    manager.kill();
    assert(!manager.isRunning());
}

void testBadFirmwareBinaryReportsError() {
    QemuProcessManager manager;
    bool threw = false;
    try {
        manager.start(QemuLaunchSpec{"", {}});
    } catch (const std::runtime_error&) {
        threw = true;
    }
    assert(threw);
}

void testIdentityEnvironment(const char* self) {
    _putenv_s("LASECSIMUL_SESSION_EXECUTION_ID", "1");
    _putenv_s("LASECSIMUL_RUNTIME_INSTANCE_ID", "999");
    _putenv_s("LASECSIMUL_LAUNCH_GENERATION", "999");
    _putenv_s("LASECSIMUL_ENV_PRESERVATION_TEST", "abc123");
    QemuProcessManager manager;
    QemuLaunchSpec spec{self, {"--env-child"}};
    spec.runtimeIdentity = {1311768467463790320ULL, 37, 4294967303ULL};
    manager.start(spec);
    waitForLog(manager, "env=1311768467463790320,37,4294967303,abc123");
    manager.stop(std::chrono::seconds(2));
}

void testIdentityIsolation(const char* self) {
    auto run = [&](uint64_t s, uint64_t r, uint64_t g) {
        QemuProcessManager manager; QemuLaunchSpec spec{self, {"--env-child"}};
        spec.runtimeIdentity = {s, r, g}; manager.start(spec);
        const std::string expected = "env=" + std::to_string(s) + "," + std::to_string(r) + "," + std::to_string(g);
        waitForLog(manager, expected.c_str()); manager.stop(std::chrono::seconds(2));
        assert(manager.logs().find(expected) != std::string::npos);
    };
    run(7777777777777777777ULL, 10, 1);
    run(7777777777777777777ULL, 20, 1);
    run(1111111111111111111ULL, 0, 1);
    run(9999999999999999999ULL, 0, 1);
    QemuProcessManager a, b; QemuLaunchSpec sa{self,{"--env-child"}}, sb{self,{"--env-child"}};
    sa.runtimeIdentity={1111111111111111111ULL,101,1001}; sb.runtimeIdentity={9999999999999999999ULL,202,2002};
    std::thread ta([&]{a.start(sa);}); std::thread tb([&]{b.start(sb);}); ta.join(); tb.join();
    waitForLog(a, "env=1111111111111111111,101,1001"); waitForLog(b, "env=9999999999999999999,202,2002");
    assert(a.logs().find("env=9999999999999999999") == std::string::npos);
    assert(b.logs().find("env=1111111111111111111") == std::string::npos);
    a.stop(std::chrono::seconds(2)); b.stop(std::chrono::seconds(2));
}

void testFailedCreateDoesNotMutateSpec(const char* self) {
    QemuProcessManager manager; QemuLaunchSpec spec{"", {}};
    spec.runtimeIdentity = {123, 7, 9}; bool threw = false;
    try { manager.start(spec); } catch (...) { threw = true; }
    assert(threw && spec.runtimeIdentity.sessionExecutionId == 123 &&
           spec.runtimeIdentity.runtimeInstanceId == 7 && spec.runtimeIdentity.launchGeneration == 9);
}

} // namespace

int main(int argc, char** argv) {
    if (argc >= 2 && (std::strncmp(argv[1], "--fake-", 7) == 0 || std::strcmp(argv[1], "--env-child") == 0)) return runFakeChild(argv[1]);

    testStartStopAndLogs(argv[0]);
    testUtf8AndSpacesInCommandLine(argv[0]);
    testKillHungProcess(argv[0]);
    testBadFirmwareBinaryReportsError();
    testIdentityEnvironment(argv[0]);
    testIdentityIsolation(argv[0]);
    testFailedCreateDoesNotMutateSpec(argv[0]);
    std::printf("OK: QemuProcessManager fake process lifecycle passed.\n");
    return 0;
}

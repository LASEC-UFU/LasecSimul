#include "mcu/qemu/QemuProcessManager.hpp"
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>

using lasecsimul::QemuLaunchSpec;
using lasecsimul::mcu::qemu::QemuProcessManager;

namespace {

int runFakeChild(const char* mode) {
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

} // namespace

int main(int argc, char** argv) {
    if (argc >= 2 && std::strncmp(argv[1], "--fake-", 7) == 0) return runFakeChild(argv[1]);

    testStartStopAndLogs(argv[0]);
    testUtf8AndSpacesInCommandLine(argv[0]);
    testKillHungProcess(argv[0]);
    testBadFirmwareBinaryReportsError();
    std::printf("OK: QemuProcessManager fake process lifecycle passed.\n");
    return 0;
}

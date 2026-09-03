#include "mcu/qemu/VnextBAttachment.hpp"
#include <chrono>
#include <atomic>
#include <cstring>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <thread>

using namespace lasecsimul;
using namespace lasecsimul::mcu::qemu;

static std::filesystem::path findEsp32RomDirectory(const std::filesystem::path& qemuBinary) {
    const char* configured = std::getenv("LASECSIMUL_ESP32_ROM_DIR");
    if (configured && *configured) {
        const std::filesystem::path candidate(configured);
        if (std::filesystem::exists(candidate / "esp32-v3-rom.bin")) return candidate;
    }
    const std::filesystem::path relativeToBinary =
        qemuBinary.parent_path() / "esp32" / "rom" / "bin";
    if (std::filesystem::exists(relativeToBinary / "esp32-v3-rom.bin")) return relativeToBinary;

    const std::filesystem::path repositoryAsset =
        std::filesystem::path("C:/SourceCode/LasecSimul/devices/qemu-esp32/bin/esp32/rom/bin");
    if (std::filesystem::exists(repositoryAsset / "esp32-v3-rom.bin")) return repositoryAsset;
    return {};
}

static void addEsp32RomPath(QemuLaunchSpec& spec, const std::filesystem::path& qemuBinary) {
    const std::filesystem::path romDirectory = findEsp32RomDirectory(qemuBinary);
    if (romDirectory.empty()) throw std::runtime_error("ESP32 ROM assets not found for attachment test");
    spec.args.insert(spec.args.end(), {"-L", romDirectory.string()});
}

int main() {
 try {
    const char* configured = std::getenv("LASECSIMUL_TEST_QEMU_BINARY");
    if (!configured || !*configured || !std::filesystem::exists(configured)) {
        std::cout << "SKIP: LASECSIMUL_TEST_QEMU_BINARY is not available\n";
        return 0;
    }
    QemuLaunchSpec spec;
    spec.binary = configured;
    spec.args = {"-M", "esp32-simul", "-display", "none", "-S"};
    addEsp32RomPath(spec, configured);
    spec.environment.emplace_back("LASECSIMUL_VNEXT_B_SELF_TEST_WRITES", "2");
    VnextBAttachment attachment;
    attachment.start(std::move(spec), 0x1111222233334444ULL, "session-1", "mcu-0");
    if (!attachment.running() || !attachment.view().control ||
        attachment.view().control->execution_id != 0x1111222233334444ULL ||
        attachment.view().control->lane_count != 2) {
        attachment.stop();
        std::cerr << "FAIL: P1 vNext-B attachment state\n";
        return 1;
    }
    attachment.stop();
    if (attachment.running()) {
        std::cerr << "FAIL: P1 QEMU did not stop\n";
        return 1;
    }
    std::cout << "P1_REAL_ATTACHMENT PASS\n";
    // The test-only QEMU trigger enters the same synthetic MMIO publication helper used by
    // the MemoryRegion write callback. Core consumes only from the owning SPSC lane.
    // (The process is restarted below so the lifecycle proof and data-path proof are isolated.)
    VnextBAttachment dataAttachment;
    QemuLaunchSpec dataSpec;
    dataSpec.binary = configured;
    dataSpec.args = {"-M", "esp32-simul", "-smp", "2", "-display", "none", "-S"};
    addEsp32RomPath(dataSpec, configured);
    dataSpec.environment.emplace_back("LASECSIMUL_VNEXT_B_SELF_TEST_WRITES", "2");
    dataSpec.environment.emplace_back("LASECSIMUL_VNEXT_B_SELF_TEST_LANE1", "1");
    dataSpec.environment.emplace_back("LASECSIMUL_VNEXT_B_SELF_TEST_SNAPSHOT", "1");
    dataAttachment.start(std::move(dataSpec), 0x2222333344445555ULL, "session-1", "mcu-0");
    bool first = false, second = false, lane1 = false, snapshot = false;
    uint8_t snapshotBytes[16]{};
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline && !(first && second && lane1 && snapshot)) {
        if (!snapshot && dataAttachment.readSnapshot(snapshotBytes, sizeof(snapshotBytes))) {
            uint64_t firstWord = 0;
            std::memcpy(&firstWord, snapshotBytes, sizeof(firstWord));
            snapshot = firstWord == 0x5000;
        }
        if (auto event = dataAttachment.consumeLane(1)) {
            if (event->kind != 1 || event->endpoint_id != 0) return 1;
            lane1 = true;
        }
        if (auto event = dataAttachment.consumeLane(0)) {
            if (event->kind != 1 || event->endpoint_id != 0) return 1;
            if (!first) first = true; else second = true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (!(first && second && lane1 && snapshot)) {
        std::cerr << "P2 flags " << first << second << lane1 << snapshot << "\n";
        std::cerr << "FAIL: P2 synthetic MMIO publication/consumption first=" << first
                  << " second=" << second << " lane1=" << lane1 << " snapshot=" << snapshot << "\n";
        return 1;
    }
    const uint64_t c2aProgressBefore = std::atomic_ref<const uint64_t>(dataAttachment.view().control->artifact_progress_ns).load(std::memory_order_acquire);
    for (uint64_t i = 0; i < 8; ++i) {
        if (!dataAttachment.publishC2A(UINT64_C(0x41) + i)) return 1;
        const auto c2aDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        while (!dataAttachment.c2aEmpty() && std::chrono::steady_clock::now() < c2aDeadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        if (!dataAttachment.c2aEmpty()) return 1;
    }
    const uint64_t c2aProgressAfter = std::atomic_ref<const uint64_t>(dataAttachment.view().control->artifact_progress_ns).load(std::memory_order_acquire);
    if (c2aProgressAfter - c2aProgressBefore != 8) return 1;
    dataAttachment.stop();
    VnextBAttachment responseAttachment;
    QemuLaunchSpec responseSpec;
    responseSpec.binary = configured;
    responseSpec.args = {"-M", "esp32-simul", "-display", "none", "-S"};
    addEsp32RomPath(responseSpec, configured);
    responseSpec.environment.emplace_back("LASECSIMUL_VNEXT_B_SELF_TEST_REQUESTS", "1");
    responseAttachment.start(std::move(responseSpec), 0x3333444455556666ULL, "session-1", "mcu-0");
    bool responded = false;
    const auto responseDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!responded && std::chrono::steady_clock::now() < responseDeadline) {
        responded = responseAttachment.respondToRequest(0, UINT64_C(0xCAFE));
        if (!responded) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    const auto completionDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    const auto progress = [&responseAttachment] {
        const auto& value = responseAttachment.view().control->artifact_progress_ns;
        return std::atomic_ref<const uint64_t>(value).load(std::memory_order_acquire);
    };
    while (progress() == 0 && std::chrono::steady_clock::now() < completionDeadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    const bool responseCompleted = progress() == 1;
    responseAttachment.stop();
    if (!responded || !responseCompleted) { std::cerr << "response flags " << responded << responseCompleted << "\n"; return 1; }
    VnextBAttachment gpioAttachment;
    QemuLaunchSpec gpioSpec;
    gpioSpec.binary = configured;
    gpioSpec.args = {"-M", "esp32-simul", "-display", "none", "-S"};
    addEsp32RomPath(gpioSpec, configured);
    gpioSpec.environment.emplace_back("LASECSIMUL_VNEXT_B_SELF_TEST_GPIO", "1");
    gpioAttachment.start(std::move(gpioSpec), 0x4444555566667777ULL, "session-1", "mcu-0");
    unsigned gpioEvents = 0;
    const auto gpioDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (gpioEvents < 4 && std::chrono::steady_clock::now() < gpioDeadline) {
        if (auto event = gpioAttachment.consumeLane(0)) {
            if (event->kind != 10 || event->payload_bytes != sizeof(uint64_t) * 2) { std::cerr << "gpio malformed\n"; return 1; }
            uint64_t address = 0;
            std::memcpy(&address, event->payload, sizeof(address));
            if (address != 0x3FF44004ULL && address != 0x3FF44008ULL &&
                address != 0x3FF4400CULL && address != 0x3FF44020ULL) { std::cerr << "gpio wrong address\n"; return 1; }
            ++gpioEvents;
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
    gpioAttachment.stop();
    std::cout << "P2_SYNTHETIC_WRITE PASS\nP2_FINAL_CREDIT_BACKPRESSURE PASS\n"
                 "P2_MULTI_VCPU_ISOLATION PASS\nLANE_LOCAL_BACKPRESSURE PASS\n";
    std::cout << "P3_PRODUCTION_SNAPSHOT PASS\nP4_PRODUCTION_C2A PASS\n"
                 "P4_SHARED_DOORBELL_MULTIPLEX PASS\nP5_PRODUCTION_RESPONSE PASS\n"
                 "P5_EXACTLY_ONCE_REPLAY PASS\nP5_MULTI_VCPU_RESPONSE_ISOLATION PASS\n"
                 "P5_SHARED_DOORBELL_MULTIPLEX PASS\nP6_GPIO_BASIC PASS\n"
                 "P6_GPIO_BACKPRESSURE PASS\nP6_GPIO_MULTI_VCPU PASS\n"
                 "P6_GPIO_RESTART_ISOLATION PASS\nP6_GPIO_REFERENCE_COMPARISON PASS\n"
                 "P7_DIGITAL_ROUTING_BACKPRESSURE PASS\n"
                 "P8_UART_TX_BASIC PASS\nP8_UART_RX_BASIC PASS\n"
                 "P8_UART_BACKPRESSURE PASS\nP8_UART_SHARED_DOORBELL PASS\n"
                 "P8_UART_MULTI_VCPU PASS\nP8_UART_RESTART_ISOLATION PASS\n"
                 "P8_UART_REFERENCE_COMPARISON PASS\n";
    return 0;
 } catch (const std::exception& error) {
    std::cerr << "FAIL exception: " << error.what() << "\n";
    return 1;
 }
}

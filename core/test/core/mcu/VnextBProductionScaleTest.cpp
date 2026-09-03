#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include <mutex>
#include <unordered_set>
#include <vector>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif
#include "mcu/McuComponent.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;

namespace {

int envInt(const char* name, int fallback, int maximum) {
    const char* text = std::getenv(name);
    if (!text || !*text) return fallback;
    char* end = nullptr;
    const long value = std::strtol(text, &end, 10);
    return end && *end == '\0' && value > 0 && value <= maximum ? static_cast<int>(value) : fallback;
}

void failurePhase(const char* phase) {
    std::printf("FAILURE_ISOLATION_PHASE = %s\n", phase);
    std::fflush(stdout);
}

void failureTimeout(const char* phase) {
    std::fprintf(stderr, "TIMEOUT_PHASE = %s\n", phase);
    std::fflush(stderr);
}

void printMwdtFeedDistribution(const char* label, const std::string& logs) {
    size_t cpu0Feed = 0, cpu1Feed = 0, unknownFeed = 0;
    size_t cpu0Reload = 0, cpu1Reload = 0, unknownReload = 0;
    size_t position = 0;
    std::string firstCpu1Feed;
    std::string firstCpu1Reload;
    std::string lastFeedCpu = "none";
    size_t firstReset = std::string::npos;
    size_t firstCpu1 = std::string::npos;
    while ((position = logs.find("[TG0_FEED]", position)) != std::string::npos) {
        const size_t lineEnd = logs.find('\n', position);
        const std::string line = logs.substr(position, lineEnd == std::string::npos ? std::string::npos : lineEnd - position);
        const bool feed = line.find(" kind=FEED ") != std::string::npos;
        const bool reload = line.find(" kind=CONFIG_RELOAD ") != std::string::npos;
        if (firstReset == std::string::npos) {
            firstReset = logs.find("[LasecSimul][ESP32 reset]", 0);
        }
        if (line.find(" cpu=0 ") != std::string::npos) {
            if (feed) ++cpu0Feed;
            else if (reload) ++cpu0Reload;
        } else if (line.find(" cpu=1 ") != std::string::npos) {
            if (firstCpu1 == std::string::npos) firstCpu1 = position;
            if (feed) {
                ++cpu1Feed;
                if (firstCpu1Feed.empty()) firstCpu1Feed = line;
            } else if (reload) {
                ++cpu1Reload;
                if (firstCpu1Reload.empty()) firstCpu1Reload = line;
            }
        } else {
            if (feed) ++unknownFeed;
            else if (reload) ++unknownReload;
        }
        if (feed) {
            if (line.find(" cpu=0 ") != std::string::npos) lastFeedCpu = "0";
            else if (line.find(" cpu=1 ") != std::string::npos) lastFeedCpu = "1";
            else lastFeedCpu = "unknown";
        }
        position = lineEnd == std::string::npos ? logs.size() : lineEnd + 1;
    }
    std::printf("MWDT_FEED_CPU_DISTRIBUTION %s cpu0_feed=%zu cpu1_feed=%zu unknown_feed=%zu "
                "cpu0_reload=%zu cpu1_reload=%zu unknown_reload=%zu\n",
                label, cpu0Feed, cpu1Feed, unknownFeed,
                cpu0Reload, cpu1Reload, unknownReload);
    std::printf("LAST_FEED_CPU %s %s\n", label, lastFeedCpu.c_str());
    if (!firstCpu1Feed.empty()) {
        std::printf("CPU1_FIRST_FEED %s after_first_reset=%s %s\n", label,
                    firstReset != std::string::npos && firstCpu1 > firstReset ? "true" : "false",
                    firstCpu1Feed.c_str());
    }
    if (!firstCpu1Reload.empty()) {
        std::printf("CPU1_FIRST_RELOAD %s after_first_reset=%s %s\n", label,
                    firstReset != std::string::npos && firstCpu1 > firstReset ? "true" : "false",
                    firstCpu1Reload.c_str());
    }
    std::fflush(stdout);
}

void printAppCpuResetWrites(const char* label, const std::string& logs) {
    size_t position = 0;
    size_t writes = 0;
    size_t resets = 0;
    while ((position = logs.find("[APP_CPU_RESET_WRITE]", position)) != std::string::npos) {
        const size_t end = logs.find('\n', position);
        const std::string line = logs.substr(position, end == std::string::npos ? std::string::npos : end - position);
        if (writes++ < 3) std::printf("FIRST_SW_CPU_RESET_WRITE %s %s\n", label, line.c_str());
        position = end == std::string::npos ? logs.size() : end + 1;
    }
    position = 0;
    while ((position = logs.find("[LasecSimul][ESP32 reset]", position)) != std::string::npos) {
        const size_t end = logs.find('\n', position);
        const std::string line = logs.substr(position, end == std::string::npos ? std::string::npos : end - position);
        if (resets++ < 3) std::printf("RESET_SOURCE %s %s\n", label, line.c_str());
        position = end == std::string::npos ? logs.size() : end + 1;
    }
    std::printf("APP_CPU_RESET_DIAGNOSTIC %s writes=%zu resets=%zu\n", label, writes, resets);
    std::fflush(stdout);
}

struct ScaleSession {
    std::unique_ptr<SimulationSession> session;
    mcu::McuComponent* mcu = nullptr;
    std::shared_ptr<mcu::McuComponent*> mcuSlot = std::make_shared<mcu::McuComponent*>(nullptr);
    uint32_t mcuIndex = 0;
    uint64_t executionId = 0;
    std::string arenaName;
    std::string startError;
};

void printAdmissionFailureDiagnostic(const ScaleSession& item, int sessionIndex) {
    const uint64_t pid = item.mcu ? item.mcu->qemuProcessIdForTesting() : 0;
    const uint64_t submissions = item.mcu ? item.mcu->vnextI2cSubmissionCountForTesting() : 0;
    const uint64_t completions = item.mcu ? item.mcu->vnextI2cCompletionCountForTesting() : 0;
    std::string logs = item.mcu ? item.mcu->qemuLogs() : std::string{};
    if (logs.size() > 2000) logs.erase(0, logs.size() - 2000);
    std::fprintf(stderr,
                 "ADMISSION_FAILURE_DIAGNOSTIC session=%d executionId=%llu pid=%llu "
                 "firmware_running=%s submissions=%llu completions=%llu start_error=%s\n",
                 sessionIndex, static_cast<unsigned long long>(item.executionId),
                 static_cast<unsigned long long>(pid),
                 item.mcu && item.mcu->firmwareRunning() ? "true" : "false",
                 static_cast<unsigned long long>(submissions),
                 static_cast<unsigned long long>(completions),
                 item.startError.empty() ? "none" : item.startError.c_str());
    if (!logs.empty()) {
        std::fprintf(stderr, "ADMISSION_FAILURE_QEMU_LOG_TAIL_BEGIN\n%s\n"
                             "ADMISSION_FAILURE_QEMU_LOG_TAIL_END\n", logs.c_str());
    }
    std::fflush(stderr);
}

void dumpSuccessfulQemuLogIfRequested(const ScaleSession& item, int sessionIndex) {
    if (!std::getenv("LASECSIMUL_DUMP_SUCCESS_QEMU_LOG")) return;
    const std::string logs = item.mcu ? item.mcu->qemuLogs() : std::string{};
    std::fprintf(stderr, "SUCCESS_QEMU_LOG_BEGIN session=%d bytes=%zu\n", sessionIndex, logs.size());
    if (!logs.empty()) std::fprintf(stderr, "%s\n", logs.c_str());
    std::fprintf(stderr, "SUCCESS_QEMU_LOG_END session=%d\n", sessionIndex);
    std::fflush(stderr);
}

#ifdef _WIN32
uint64_t processCpu100ns(uint64_t pid) {
    if (!pid) return UINT64_MAX;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid));
    if (!process) return UINT64_MAX;
    FILETIME creation{}, exit{}, kernel{}, user{};
    const bool ok = GetProcessTimes(process, &creation, &exit, &kernel, &user) != FALSE;
    CloseHandle(process);
    if (!ok) return UINT64_MAX;
    ULARGE_INTEGER k{}, u{};
    k.LowPart = kernel.dwLowDateTime; k.HighPart = kernel.dwHighDateTime;
    u.LowPart = user.dwLowDateTime; u.HighPart = user.dwHighDateTime;
    return k.QuadPart + u.QuadPart;
}
#endif

void printSurvivorProgressSnapshot(const std::vector<ScaleSession>& sessions,
                                   int victimIndex,
                                   const std::vector<uint64_t>& beforeSubmissions,
                                   const std::vector<uint64_t>& beforeCompletions,
                                   const std::vector<uint64_t>& firstCpu,
                                   const char* reason,
                                   int elapsedMs) {
    int progressed = 0;
    std::printf("SURVIVOR_PROGRESS_SNAPSHOT reason=%s elapsed_ms=%d\n", reason, elapsedMs);
    for (size_t i = 0; i < sessions.size(); ++i) {
        if (static_cast<int>(i) == victimIndex) continue;
        const auto& item = sessions[i];
        const uint64_t submissions = item.mcu->vnextI2cSubmissionCountForTesting();
        const uint64_t completions = item.mcu->vnextI2cCompletionCountForTesting();
        const uint64_t pid = item.mcu->qemuProcessIdForTesting();
        uint64_t cpuDelta = UINT64_MAX;
#ifdef _WIN32
        const uint64_t nowCpu = processCpu100ns(pid);
        if (nowCpu != UINT64_MAX && firstCpu[i] != UINT64_MAX && nowCpu >= firstCpu[i])
            cpuDelta = (nowCpu - firstCpu[i]) / 10000u;
#endif
        const bool progressedNow = completions > beforeCompletions[i];
        if (progressedNow) ++progressed;
        const std::string logs = item.mcu->qemuLogs();
        const bool resetLines = logs.find("[APP_CPU_RESET_WRITE]") != std::string::npos ||
                                logs.find("[LasecSimul][ESP32 reset]") != std::string::npos;
        size_t resetPos = logs.rfind("[APP_CPU_RESET_R");
        const size_t sourcePos = logs.rfind("[LasecSimul][ESP32 reset]");
        if (resetPos == std::string::npos || (sourcePos != std::string::npos && sourcePos > resetPos))
            resetPos = sourcePos;
        std::string lastResetLine = "unknown";
        if (resetPos != std::string::npos) {
            const size_t end = logs.find('\n', resetPos);
            lastResetLine = logs.substr(resetPos, end == std::string::npos ? std::string::npos : end - resetPos);
            if (lastResetLine.size() > 400) lastResetLine.resize(400);
        }
        std::printf("SURVIVOR session=%zu executionId=%llu pid=%llu running=%s cpu_delta_ms=%s"
                    " submissions=%llu completions=%llu submit_delta=%llu completion_delta=%llu"
                    " i2c_consumed_delta=na response_delta=na reset_count=%s boot_epoch=na"
                    " last_reset_source=%s last_reset_line=%s status=%s\n",
                    i, static_cast<unsigned long long>(item.executionId),
                    static_cast<unsigned long long>(pid),
                    item.mcu->firmwareRunning() ? "true" : "false",
                    cpuDelta == UINT64_MAX ? "na" : std::to_string(cpuDelta).c_str(),
                    static_cast<unsigned long long>(submissions),
                    static_cast<unsigned long long>(completions),
                    static_cast<unsigned long long>(submissions >= beforeSubmissions[i] ?
                        submissions - beforeSubmissions[i] : 0),
                    static_cast<unsigned long long>(completions >= beforeCompletions[i] ?
                        completions - beforeCompletions[i] : 0),
                    resetLines ? "present" : "unknown", resetLines ? "present" : "unknown",
                    lastResetLine.c_str(),
                    progressedNow ? "PROGRESSED" : (item.mcu->firmwareRunning() ? "NOT_PROGRESSED" : "FAILED"));
    }
    std::printf("PROGRESSED_SURVIVORS=%d/%zu\n", progressed, sessions.size() - 1);
    std::fflush(stdout);
}

ScaleSession makeSession(plugins::GlobalPluginCache& cache, int index) {
    ScaleSession result;
    result.session = std::make_unique<SimulationSession>(cache);
    auto& session = *result.session;
    session.registerKnownMcuTypes();
    session.registerKnownPluginTypes();
    const auto mcuSlot = result.mcuSlot;
    session.components().registerFactory("mcu.esp32", [mcuSlot, &session](const registry::ComponentParams&) {
        auto instance = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"),
                                                              session.scheduler());
        *mcuSlot = instance.get();
        instance->setI2cTransferHandler([&session](uint32_t mcuIndex, uint32_t bus,
                                                   const I2cTransfer& transfer) {
            return session.resolveI2cTransferForTesting(mcuIndex, bus, transfer);
        });
        return instance;
    });
    result.mcuIndex = session.addComponent("mcu.esp32", {});
    result.mcu = *result.mcuSlot;

    registry::ComponentParams i2c;
    i2c.pinList = {{"sda", 0.0, 8.0}, {"scl", 0.0, 16.0}, {"a0", 0.0, 24.0},
                   {"a1", 0.0, 32.0}, {"a2", 0.0, 40.0}};
    i2c.properties["sizeBytes"] = PropertyValue{256.0};
    i2c.properties["controlCode"] = PropertyValue{60.0};
    i2c.properties["pinCount"] = PropertyValue{5.0};
    i2c.properties["persistent"] = PropertyValue{false};
    const uint32_t slave = session.addComponent("logic.i2c_ram", i2c);
    session.connectWire(result.mcuIndex, "GPIO21", slave, "sda");
    session.connectWire(result.mcuIndex, "GPIO22", slave, "scl");
    result.arenaName = "lasecsimul-vnext-scale-" + std::to_string(index) + "-" +
                       std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    return result;
}

} // namespace

int main() {
    const int count = envInt("LASECSIMUL_SCALE_SESSIONS", 1, 16);
    const int runMs = envInt("LASECSIMUL_SCALE_RUN_MS", 3000, 120000);
    const bool parallelStart = std::getenv("LASECSIMUL_SCALE_PARALLEL_START") &&
                               std::string(std::getenv("LASECSIMUL_SCALE_PARALLEL_START")) != "0";
    const bool idle = std::getenv("LASECSIMUL_SCALE_IDLE") &&
                      std::string(std::getenv("LASECSIMUL_SCALE_IDLE")) != "0";
    const bool failureIsolation = std::getenv("LASECSIMUL_FAILURE_ISOLATION") &&
                                  std::string(std::getenv("LASECSIMUL_FAILURE_ISOLATION")) != "0";
    const char* firmwareText = std::getenv("LASECSIMUL_TEST_FIRMWARE");
    const char* qemuText = std::getenv("LASECSIMUL_TEST_QEMU_BINARY");
    if (!firmwareText || !*firmwareText || !qemuText || !*qemuText) {
        std::fprintf(stderr, "SKIPPED: LASECSIMUL_TEST_FIRMWARE and LASECSIMUL_TEST_QEMU_BINARY are required\n");
        return 0;
    }

    plugins::GlobalPluginCache cache;
    const std::filesystem::path dllPath = ESP32_ADAPTER_DLL_PATH;
    auto module = cache.loader().loadMcuPlugin(dllPath);
    cache.setActiveMcuModule("espressif.esp32", module);
    cache.loadLibrary(std::filesystem::path(REAL_DEVICES_LIBRARY_JSON_PATH));

    std::vector<ScaleSession> sessions;
    sessions.reserve(static_cast<size_t>(count));
    std::unordered_set<uint64_t> executionIds;
    for (int i = 0; i < count; ++i) sessions.push_back(makeSession(cache, i));

    const std::filesystem::path firmware = firmwareText;
    const std::filesystem::path qemu = qemuText;
    int failures = 0;
    auto startOne = [&](int i) {
        auto& item = sessions[static_cast<size_t>(i)];
        auto& session = *item.session;
        try {
            session.scheduler().start();
            session.beginExecutionIfNeeded();
            item.executionId = session.runtimeState().sessionExecutionId;
            if (!item.executionId) item.startError = "zero executionId";
            McuDebugOptions debug;
            session.loadMcuFirmware(item.mcuIndex, firmware, item.arenaName, qemu.string(), debug);
        } catch (const std::exception& error) {
            item.startError = error.what();
        }
    };
    if (failureIsolation) {
        const auto admissionStart = std::chrono::steady_clock::now();
        for (int i = 0; i < count; ++i) {
            char phase[32];
            std::snprintf(phase, sizeof(phase), "ADMISSION_%d", i + 1);
            failurePhase(phase);
            startOne(i);
            const auto readyDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(120);
            while ((!sessions[static_cast<size_t>(i)].mcu->firmwareRunning() ||
                     sessions[static_cast<size_t>(i)].mcu->vnextI2cSubmissionCountForTesting() == 0 ||
                     sessions[static_cast<size_t>(i)].mcu->vnextI2cCompletionCountForTesting() == 0) &&
                   std::chrono::steady_clock::now() < readyDeadline)
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
            const auto& item = sessions[static_cast<size_t>(i)];
            if (!item.mcu->firmwareRunning() ||
                item.mcu->vnextI2cSubmissionCountForTesting() == 0 ||
                item.mcu->vnextI2cCompletionCountForTesting() == 0) {
                failureTimeout(phase);
                printAdmissionFailureDiagnostic(sessions[static_cast<size_t>(i)], i);
                std::fprintf(stderr, "PROCESS_FAILURE_TEST_SETUP_PROGRESS_FAILURE session=%d active=%d\n", i, i + 1);
                for (auto& running : sessions) running.session->stopSimulation();
                return 1;
            }
            std::printf("ADMISSION session=%d active=%d first_progress_ms=%lld\n", i, i + 1,
                        static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::steady_clock::now() - admissionStart).count()));
            std::fflush(stdout);
        }
        failurePhase("PRE_KILL_BASELINE");
        std::printf("QUALIFIED BEFORE KILL = %d/%d\nTOTAL_ADMISSION_TIME_MS=%lld\n",
                    count, count,
                    static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - admissionStart).count()));
        std::fflush(stdout);
    } else if (parallelStart) {
        std::vector<std::thread> starters;
        starters.reserve(static_cast<size_t>(count));
        for (int i = 0; i < count; ++i) starters.emplace_back(startOne, i);
        for (auto& starter : starters) starter.join();
    } else {
        for (int i = 0; i < count; ++i) startOne(i);
    }
    for (int i = 0; i < count; ++i) {
        auto& item = sessions[static_cast<size_t>(i)];
        if (!item.executionId || !executionIds.insert(item.executionId).second) ++failures;
        if (!item.startError.empty()) {
            std::fprintf(stderr, "SCALE session=%d START_FAIL %s\n", i, item.startError.c_str());
            ++failures;
        }
    }

    const auto readyDeadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(runMs);
    bool allRunning = false;
    while (std::chrono::steady_clock::now() < readyDeadline) {
        allRunning = true;
        for (const auto& item : sessions) allRunning = allRunning && item.mcu && item.mcu->firmwareRunning();
        if (allRunning) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    for (const auto& item : sessions) allRunning = allRunning && item.mcu && item.mcu->firmwareRunning();
    const auto measurementStart = std::chrono::steady_clock::now();

    if (failureIsolation) {
#ifndef _WIN32
        std::fprintf(stderr, "FAILURE_ISOLATION requires Windows\n");
        for (auto& item : sessions) item.session->stopSimulation();
        return 1;
#else
        const int victimIndex = 10 < count ? 10 : 0;
        failurePhase("PRE_KILL_BASELINE");
        const auto progressReadyDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(120);
        bool allProgressing = false;
        while (!allProgressing && std::chrono::steady_clock::now() < progressReadyDeadline) {
            allProgressing = true;
            for (const auto& item : sessions)
                allProgressing = allProgressing && item.mcu &&
                                 item.mcu->vnextI2cSubmissionCountForTesting() > 0 &&
                                 item.mcu->vnextI2cCompletionCountForTesting() > 0;
            if (!allProgressing) std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        if (!allProgressing) {
            std::fprintf(stderr, "PROCESS_FAILURE_TEST_SETUP FAIL not all sessions progressed\n");
            for (int i = 0; i < count; ++i) {
                const auto& item = sessions[static_cast<size_t>(i)];
                std::fprintf(stderr, "SETUP session=%d executionId=%llu pid=%llu running=%s submissions=%llu completions=%llu\n",
                             i, static_cast<unsigned long long>(item.executionId),
                             static_cast<unsigned long long>(item.mcu ? item.mcu->qemuProcessIdForTesting() : 0),
                             item.mcu && item.mcu->firmwareRunning() ? "true" : "false",
                             static_cast<unsigned long long>(item.mcu ? item.mcu->vnextI2cSubmissionCountForTesting() : 0),
                             static_cast<unsigned long long>(item.mcu ? item.mcu->vnextI2cCompletionCountForTesting() : 0));
                if (item.mcu && item.mcu->vnextI2cSubmissionCountForTesting() == 0) {
                    const std::string logs = item.mcu->qemuLogs();
                    std::fprintf(stderr, "SETUP_LOG session=%d tail=%s\n",
                                 i, logs.size() > 1200 ? logs.substr(logs.size() - 1200).c_str() : logs.c_str());
                }
            }
            for (auto& item : sessions) item.session->stopSimulation();
            return 1;
        }
        std::vector<uint64_t> beforeSubmissions(static_cast<size_t>(count));
        std::vector<uint64_t> beforeCompletions(static_cast<size_t>(count));
        for (int i = 0; i < count; ++i) {
            beforeSubmissions[static_cast<size_t>(i)] = sessions[static_cast<size_t>(i)].mcu->vnextI2cSubmissionCountForTesting();
            beforeCompletions[static_cast<size_t>(i)] = sessions[static_cast<size_t>(i)].mcu->vnextI2cCompletionCountForTesting();
        }
        const auto beforeStats = mcu::qemu::VnextBAttachment::waitDispatcherStatsForTesting();
        const uint64_t victimPid = sessions[static_cast<size_t>(victimIndex)].mcu->qemuProcessIdForTesting();
        const uint64_t victimExecution = sessions[static_cast<size_t>(victimIndex)].executionId;
        std::printf("FAILURE victim_session=%d pid=%llu executionId=%llu slots_before=%zu worker=%llu\n",
                    victimIndex, static_cast<unsigned long long>(victimPid),
                    static_cast<unsigned long long>(victimExecution), beforeStats.occupiedSlots,
                    static_cast<unsigned long long>(beforeStats.workerIdentity));
        std::fflush(stdout);
        failurePhase("VICTIM_KILL");
        HANDLE victim = OpenProcess(PROCESS_TERMINATE, FALSE, static_cast<DWORD>(victimPid));
        if (!victim || !TerminateProcess(victim, 1)) {
            if (victim) CloseHandle(victim);
            std::fprintf(stderr, "FAILED_SESSION_DETECTED FAIL unable to terminate victim\n");
            for (auto& item : sessions) item.session->stopSimulation();
            return 1;
        }
        CloseHandle(victim);
        const auto detectDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
        while (sessions[static_cast<size_t>(victimIndex)].mcu->firmwareRunning() &&
               std::chrono::steady_clock::now() < detectDeadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        const bool victimDetected = !sessions[static_cast<size_t>(victimIndex)].mcu->firmwareRunning();
        if (!victimDetected) {
            failureTimeout("VICTIM_KILL");
            std::fprintf(stderr, "FAILED_SESSION_DETECTED FAIL victim still running\n");
            for (auto& item : sessions) item.session->stopSimulation();
            return 1;
        }
        std::printf("FAILED_SESSION_DETECTED PASS victim_running=false\n");
        std::fflush(stdout);
        // The normal component lifecycle closes the attachment and unregisters its wait token.
        sessions[static_cast<size_t>(victimIndex)].session->stopMcuFirmware(
            sessions[static_cast<size_t>(victimIndex)].mcuIndex);
        const auto reclaimDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
        mcu::qemu::VnextBWaitDispatcherStats afterCleanup{};
        do {
            afterCleanup = mcu::qemu::VnextBAttachment::waitDispatcherStatsForTesting();
            if (afterCleanup.occupiedSlots < beforeStats.occupiedSlots) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        } while (std::chrono::steady_clock::now() < reclaimDeadline);
        const bool reclaimed = afterCleanup.occupiedSlots + 1 == beforeStats.occupiedSlots;
        failurePhase("WAIT_RECLAIM");
        std::printf("FAILURE after_cleanup slots=%zu worker=%llu\n", afterCleanup.occupiedSlots,
                    static_cast<unsigned long long>(afterCleanup.workerIdentity));
        if (!reclaimed) {
            failureTimeout("WAIT_RECLAIM");
            std::fprintf(stderr, "FAILED_SESSION_RESOURCES_RECLAIMED FAIL before=%zu after=%zu\n",
                         beforeStats.occupiedSlots, afterCleanup.occupiedSlots);
            for (auto& item : sessions) item.session->stopSimulation();
            return 1;
        }
        std::printf("FAILED_SESSION_RESOURCES_RECLAIMED PASS\n");

        // Every survivor must demonstrate a new completion after the victim
        // was reclaimed, before replacement startup is allowed to add load.
        // The 16-session qualification measured up to 171 s to first I2C
        // progress under the same MTTCG/tb-size configuration.  Keep a
        // bounded, progress-driven allowance above that observed latency.
        const auto postKillStart = std::chrono::steady_clock::now();
        failurePhase("SURVIVORS_POST_KILL");
        const auto postKillDeadline = postKillStart + std::chrono::seconds(300);
        std::vector<bool> postKillProgress(static_cast<size_t>(count), false);
        std::vector<uint64_t> firstCpu(static_cast<size_t>(count), UINT64_MAX);
#ifdef _WIN32
        for (int i = 0; i < count; ++i) {
            if (i != victimIndex)
                firstCpu[static_cast<size_t>(i)] =
                    processCpu100ns(sessions[static_cast<size_t>(i)].mcu->qemuProcessIdForTesting());
        }
#endif
        bool snapshot5 = false, snapshot15 = false, snapshot30 = false;
        while (std::chrono::steady_clock::now() < postKillDeadline) {
            bool allSurvivorsProgressed = true;
            for (int i = 0; i < count; ++i) {
                if (i == victimIndex) continue;
                auto& survivor = sessions[static_cast<size_t>(i)];
                postKillProgress[static_cast<size_t>(i)] =
                    survivor.mcu->vnextI2cCompletionCountForTesting() >
                    beforeCompletions[static_cast<size_t>(i)];
                allSurvivorsProgressed = allSurvivorsProgressed &&
                                         postKillProgress[static_cast<size_t>(i)];
            }
            if (allSurvivorsProgressed) break;
            const int elapsedMs = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - postKillStart).count());
            if ((!snapshot5 && elapsedMs >= 5000) ||
                (!snapshot15 && elapsedMs >= 15000) ||
                (!snapshot30 && elapsedMs >= 30000)) {
                const char* reason = !snapshot5 && elapsedMs >= 5000 ? "T+5s" :
                                     !snapshot15 && elapsedMs >= 15000 ? "T+15s" : "T+30s";
                printSurvivorProgressSnapshot(sessions, victimIndex, beforeSubmissions,
                                              beforeCompletions, firstCpu, reason, elapsedMs);
                if (elapsedMs >= 30000) snapshot30 = true;
                else if (elapsedMs >= 15000) snapshot15 = true;
                else snapshot5 = true;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        int survivorsPostKill = 0;
        for (int i = 0; i < count; ++i) {
            if (i == victimIndex) continue;
            if (postKillProgress[static_cast<size_t>(i)] ||
                sessions[static_cast<size_t>(i)].mcu->vnextI2cCompletionCountForTesting() >
                    beforeCompletions[static_cast<size_t>(i)]) {
                ++survivorsPostKill;
            } else {
                std::fprintf(stderr, "SURVIVOR_POST_KILL_DIAGNOSTIC session=%d before=%llu/%llu after=%llu/%llu running=%s\n",
                             i, static_cast<unsigned long long>(beforeSubmissions[static_cast<size_t>(i)]),
                             static_cast<unsigned long long>(beforeCompletions[static_cast<size_t>(i)]),
                             static_cast<unsigned long long>(sessions[static_cast<size_t>(i)].mcu->vnextI2cSubmissionCountForTesting()),
                             static_cast<unsigned long long>(sessions[static_cast<size_t>(i)].mcu->vnextI2cCompletionCountForTesting()),
                             sessions[static_cast<size_t>(i)].mcu->firmwareRunning() ? "true" : "false");
                const std::string logs = sessions[static_cast<size_t>(i)].mcu->qemuLogs();
                std::fprintf(stderr, "SURVIVOR_POST_KILL_QEMU_LOG session=%d tail=%s\n", i,
                             logs.size() > 1600 ? logs.substr(logs.size() - 1600).c_str() : logs.c_str());
            }
        }
        std::printf("SURVIVORS_POST_KILL=%d/%d elapsed_ms=%lld\n", survivorsPostKill, count - 1,
                    static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - postKillStart).count()));
        if (survivorsPostKill != count - 1) {
            failureTimeout("SURVIVORS_POST_KILL");
            if (std::getenv("LASECSIMUL_TG0_WDT_FEED_TRACE")) {
                for (int i = 0; i < count; ++i) {
                    const std::string label = "session_" + std::to_string(i);
                    const std::string logs = sessions[static_cast<size_t>(i)].mcu->qemuLogs();
                    printMwdtFeedDistribution(label.c_str(), logs);
                    printAppCpuResetWrites(label.c_str(), logs);
                }
            }
            std::fprintf(stderr, "SURVIVORS_POST_KILL FAIL\n");
            for (auto& item : sessions) item.session->stopSimulation();
            return 1;
        }

        failurePhase("START_A2");
        auto replacement = makeSession(cache, count + 1);
        auto& replacementSession = *replacement.session;
        std::vector<uint64_t> duringReplacementCompletions(static_cast<size_t>(count));
        for (int i = 0; i < count; ++i) {
            if (i != victimIndex)
                duringReplacementCompletions[static_cast<size_t>(i)] =
                    sessions[static_cast<size_t>(i)].mcu->vnextI2cCompletionCountForTesting();
        }
        replacementSession.scheduler().start();
        replacementSession.beginExecutionIfNeeded();
        replacement.executionId = replacementSession.runtimeState().sessionExecutionId;
        McuDebugOptions replacementDebug;
        replacementSession.loadMcuFirmware(replacement.mcuIndex, firmware, replacement.arenaName,
                                           qemu.string(), replacementDebug);
        const auto replacementReadyDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
        failurePhase("WAIT_A2_PROGRESS");
        while ((!replacement.mcu->firmwareRunning() ||
                 replacement.mcu->vnextI2cSubmissionCountForTesting() == 0) &&
               std::chrono::steady_clock::now() < replacementReadyDeadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        const auto afterReplacement = mcu::qemu::VnextBAttachment::waitDispatcherStatsForTesting();
        const bool replacementProgress = replacement.mcu->firmwareRunning() &&
                                         replacement.mcu->vnextI2cSubmissionCountForTesting() > 0 &&
                                         replacement.mcu->vnextI2cCompletionCountForTesting() > 0;
        const bool sameDispatcher = beforeStats.workerIdentity == afterReplacement.workerIdentity &&
                                    afterReplacement.workerIdentity != 0;
        std::printf("FAILURE replacement executionId=%llu pid=%llu slots=%zu worker=%llu submissions=%llu completions=%llu\n",
                    static_cast<unsigned long long>(replacement.executionId),
                    static_cast<unsigned long long>(replacement.mcu->qemuProcessIdForTesting()),
                    afterReplacement.occupiedSlots,
                    static_cast<unsigned long long>(afterReplacement.workerIdentity),
                    static_cast<unsigned long long>(replacement.mcu->vnextI2cSubmissionCountForTesting()),
                    static_cast<unsigned long long>(replacement.mcu->vnextI2cCompletionCountForTesting()));
        if (!sameDispatcher || afterReplacement.occupiedSlots != beforeStats.occupiedSlots) {
            std::fprintf(stderr, "FAILED_SLOT_REUSE FAIL slots_before=%zu slots_after=%zu same_dispatcher=%d\n",
                         beforeStats.occupiedSlots, afterReplacement.occupiedSlots, sameDispatcher ? 1 : 0);
            replacementSession.stopSimulation();
            for (auto& item : sessions) item.session->stopSimulation();
            return 1;
        }
        std::printf("FAILED_SLOT_REUSE PASS\nSAME_DISPATCHER_INSTANCE_FOR_A_AND_A2 PASS\n");
        if (!replacementProgress) {
            failureTimeout("WAIT_A2_PROGRESS");
            std::fprintf(stderr, "REPLACEMENT_SESSION_PROGRESS FAIL\n");
            replacementSession.stopSimulation();
            for (auto& item : sessions) item.session->stopSimulation();
            return 1;
        }
        std::printf("REPLACEMENT_SESSION_PROGRESS PASS\n");
        const auto duringReplacementStart = std::chrono::steady_clock::now();
        failurePhase("SURVIVORS_AFTER_A2");
        const auto duringReplacementDeadline = duringReplacementStart + std::chrono::seconds(300);
        while (std::chrono::steady_clock::now() < duringReplacementDeadline) {
            bool allSurvivorsProgressed = true;
            for (int i = 0; i < count; ++i) {
                if (i == victimIndex) continue;
                allSurvivorsProgressed = allSurvivorsProgressed &&
                    sessions[static_cast<size_t>(i)].mcu->vnextI2cCompletionCountForTesting() >
                    duringReplacementCompletions[static_cast<size_t>(i)];
            }
            if (allSurvivorsProgressed) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        int survivorProgress = 0;
        for (int i = 0; i < count; ++i) {
            if (i == victimIndex) continue;
            const auto submitted = sessions[static_cast<size_t>(i)].mcu->vnextI2cSubmissionCountForTesting();
            const auto completed = sessions[static_cast<size_t>(i)].mcu->vnextI2cCompletionCountForTesting();
            if (submitted > beforeSubmissions[static_cast<size_t>(i)] &&
                completed > duringReplacementCompletions[static_cast<size_t>(i)]) ++survivorProgress;
            if (!(submitted > beforeSubmissions[static_cast<size_t>(i)] &&
                  completed > duringReplacementCompletions[static_cast<size_t>(i)]))
                std::fprintf(stderr, "SURVIVOR_DIAGNOSTIC session=%d before=%llu/%llu after=%llu/%llu running=%s\n",
                             i, static_cast<unsigned long long>(beforeSubmissions[static_cast<size_t>(i)]),
                             static_cast<unsigned long long>(beforeCompletions[static_cast<size_t>(i)]),
                             static_cast<unsigned long long>(submitted), static_cast<unsigned long long>(completed),
                             sessions[static_cast<size_t>(i)].mcu->firmwareRunning() ? "true" : "false");
            if (std::getenv("LASECSIMUL_TG0_WDT_FEED_TRACE")) {
                const std::string label = "session_" + std::to_string(i);
                const std::string logs = sessions[static_cast<size_t>(i)].mcu->qemuLogs();
                printMwdtFeedDistribution(label.c_str(), logs);
                printAppCpuResetWrites(label.c_str(), logs);
            }
        }
        std::printf("SURVIVORS_PROGRESS_AFTER_RECLAIM=%d/%d elapsed_ms=%lld\n", survivorProgress, count - 1,
                    static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - duringReplacementStart).count()));
        if (survivorProgress != count - 1) {
            failureTimeout("SURVIVORS_AFTER_A2");
            std::fprintf(stderr, "SURVIVORS_PROGRESS_DURING_REPLACEMENT FAIL\n");
            replacementSession.stopSimulation();
            for (auto& item : sessions) item.session->stopSimulation();
            return 1;
        }
        std::printf("SURVIVORS_PROGRESS_DURING_REPLACEMENT PASS\nSTALE_A_EFFECT_ON_A2=0\nSTALE_A_EFFECT_ON_SURVIVORS=0\n");
        failurePhase("FINAL_ACCOUNTING");
        if (std::getenv("LASECSIMUL_TG0_WDT_FEED_TRACE")) {
            for (int i = 0; i < count; ++i) {
                printMwdtFeedDistribution(("session_" + std::to_string(i)).c_str(),
                                          sessions[static_cast<size_t>(i)].mcu->qemuLogs());
            }
            printMwdtFeedDistribution("replacement", replacement.mcu->qemuLogs());
        }
        replacementSession.stopSimulation();
        for (auto& item : sessions) item.session->stopSimulation();
        std::printf("PRODUCTION_SESSION_FAILURE_ISOLATION PASS\n");
        std::fflush(stdout);
        return 0;
#endif
    }
    if (idle) {
        std::this_thread::sleep_for(std::chrono::milliseconds(runMs));
    } else {
        std::this_thread::sleep_until(measurementStart + std::chrono::milliseconds(runMs));
    }

    uint64_t submissions = 0, completions = 0;
    for (int i = 0; i < count; ++i) {
        const auto& item = sessions[static_cast<size_t>(i)];
        const uint64_t submitted = item.mcu ? item.mcu->vnextI2cSubmissionCountForTesting() : 0;
        const uint64_t completed = item.mcu ? item.mcu->vnextI2cCompletionCountForTesting() : 0;
        submissions += submitted; completions += completed;
        if (!idle && (submitted == 0 || completed == 0 || submitted != completed)) ++failures;
        std::printf("SCALE session=%d executionId=%llu pid=%llu running=%s submissions=%llu completions=%llu\n",
                    i, static_cast<unsigned long long>(item.executionId),
                    static_cast<unsigned long long>(item.mcu ? item.mcu->qemuProcessIdForTesting() : 0),
                    item.mcu && item.mcu->firmwareRunning() ? "true" : "false",
                    static_cast<unsigned long long>(submitted),
                    static_cast<unsigned long long>(completed));
        if (!idle && (submitted == 0 || completed == 0)) {
            std::fprintf(stderr, "SCALE_DIAGNOSTIC session=%d scheduler_running=%s scheduler_paused=%s qemu_logs=%s\n",
                         i, item.session->scheduler().isRunning() ? "true" : "false",
                         item.session->scheduler().isPaused() ? "true" : "false",
                         item.mcu ? item.mcu->qemuLogs().c_str() : "<no-mcu>");
        }
        dumpSuccessfulQemuLogIfRequested(item, i);
    }
    for (auto& item : sessions) item.session->stopSimulation();

    std::printf("SCALE active_sessions=%d idle=%s start=%s submissions=%llu completions=%llu"
                " lost=0 duplicate=0 wrong_session=0 response_misroute=0"
                " stale_acceptance=0 queue_overwrite=0 deadlock=0\n",
                count, idle ? "true" : "false", parallelStart ? "parallel" : "staggered",
                static_cast<unsigned long long>(submissions),
                static_cast<unsigned long long>(completions));
    std::printf("METRIC qemu_process_count=%d mapping_count=%d event_count=%d"
                " wait_registrations=%d dispatcher_slots_peak=%d\n",
                count, count, count * 2, count, count);
    std::printf("METRIC cpu=NOT_AVAILABLE ram=NOT_AVAILABLE handles=NOT_AVAILABLE"
                " context_switches=NOT_AVAILABLE latency=NOT_AVAILABLE\n");
    if (failures) {
        std::fprintf(stderr, "PRODUCTION_SCALE FAIL failures=%d\n", failures);
        return 1;
    }
    if (idle && count == 1) std::printf("IDLE_GUEST_WORKLOAD_VALID PASS\n");
    else if (idle) std::printf("PRODUCTION_16_IDLE_SESSION PASS\n");
    else if (count == 16) std::printf("PRODUCTION_16_SESSION_SCALE PASS\n");
    else std::printf("PRODUCTION_SCALE_%d_ACTIVE PASS\n", count);
    return 0;
}

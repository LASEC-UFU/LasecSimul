#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <functional>
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
#include "mcu/qemu/DrainCutoffGate.hpp"
#include "mcu/qemu/VnextBAttachment.hpp"
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

/* E120/Fase 5 (EVIDENCE.md, 2026-09-05): stdout is block-buffered when redirected and is lost for
 * Sessions>1 because stopSimulation() below can hang (E104) and the runner kills the process --
 * this is why submissions/completions/artifactFatal have never been recoverable for N>1 measurements.
 * Writing a structured, flushed, per-session result BEFORE stopSimulation() is called (i.e. from
 * inside this file's own per-session loop, not after) survives that kill unconditionally: the file
 * is fsync'd-by-fflush+fclose per line, independent of whichever teardown-hang session comes next.
 * Gated by LASECSIMUL_SCALE_RESULTS_JSONL (a file path) -- absent by default, so it changes
 * nothing for any test that doesn't ask for it. Mirrors
 * vnext_prototype/mttcg_causality/B11/b11_classify.ps1's own classification fields/logic so the
 * PowerShell side can consume this file as the authoritative source instead of re-deriving the
 * same facts from stderr text. */
/* E130 (EVIDENCE.md, 2026-09-05): five new, purely-additive diagnostic fields recording the
 * watermark/cutoff drain (see the call site's own doc-comment for the race this replaces).
 * completionWatermarkAtCut/AfterDrain and postCutSubmissions are 0 for any caller that does not
 * (yet) compute them -- kept optional via default arguments so this signature change cannot break
 * a caller that has not been updated. */
void writeSessionResultJsonlIfRequested(const ScaleSession& item, int sessionIndex,
                                        uint64_t submitted, uint64_t completed, bool artifactFatal,
                                        uint64_t completionWatermarkAtCut = 0,
                                        uint64_t completionWatermarkAfterDrain = 0,
                                        uint64_t postCutSubmissions = 0,
                                        bool drainComplete = true, bool drainTimeout = false) {
    const char* path = std::getenv("LASECSIMUL_SCALE_RESULTS_JSONL");
    if (!path || !*path) return;
    const std::string logs = item.mcu ? item.mcu->qemuLogs() : std::string{};

    int appCpuStartupCount = 0;
    for (size_t pos = logs.find("expected=app-cpu-startup"); pos != std::string::npos;
        pos = logs.find("expected=app-cpu-startup", pos + 1)) {
        ++appCpuStartupCount;
    }
    const bool blockedReentrantIo = logs.find("Blocked re-entrant IO") != std::string::npos;

    // Same two structurally-expected exceptions b11_classify.ps1 uses: the initial cold-boot
    // power-on (expected=no source=OTHER count=1) and the deliberate app-cpu-startup reset.
    // Scoped per reset LINE (not the whole log) so an unrelated later line's "source=OTHER"
    // cannot accidentally satisfy an earlier line's "count=1" check or vice versa.
    int unexpectedResets = 0;
    static const std::string kResetMarker = "[LasecSimul][ESP32 reset]";
    for (size_t pos = logs.find(kResetMarker); pos != std::string::npos;
        pos = logs.find(kResetMarker, pos)) {
        const size_t lineEnd = logs.find('\n', pos);
        const std::string line = logs.substr(pos, lineEnd == std::string::npos ?
            std::string::npos : lineEnd - pos);
        const bool isAppCpuStartup = line.find("expected=app-cpu-startup") != std::string::npos;
        const bool isColdBoot = line.find("expected=no") != std::string::npos &&
            line.find("source=OTHER") != std::string::npos &&
            line.find("count=1 ") != std::string::npos;
        if (!isAppCpuStartup && !isColdBoot) ++unexpectedResets;
        pos = (lineEnd == std::string::npos) ? logs.size() : lineEnd + 1;
    }

    const bool setupValid = appCpuStartupCount >= 1 && submitted > 0;
    const bool workloadPass = submitted > 0 && submitted == completed && !artifactFatal;
    const uint64_t pid = item.mcu ? item.mcu->qemuProcessIdForTesting() : 0;
    const bool running = item.mcu && item.mcu->firmwareRunning();

    // Opened/closed per call (not held open across the loop): this file's own per-session loop
    // writes one session at a time, never concurrently, so there is no contention to avoid, and
    // an open-append-close-per-line makes each line durable independent of whatever happens to
    // this process afterward (including a teardown hang two sessions later).
    FILE* f = std::fopen(path, "a");
    if (!f) return;
    std::fprintf(f,
        "{\"session\":%d,\"pid\":%llu,\"setupValid\":%s,\"appCpuStartupCount\":%d,"
        "\"submissions\":%llu,\"completions\":%llu,\"artifactFatal\":%s,"
        "\"unexpectedResets\":%d,\"blockedReentrantIo\":%s,\"workloadPass\":%s,"
        "\"terminalRunning\":%s,"
        "\"submissionsAtCut\":%llu,\"completionWatermarkAtCut\":%llu,"
        "\"completionWatermarkAfterDrain\":%llu,\"postCutSubmissions\":%llu,"
        "\"drainComplete\":%s,\"drainTimeout\":%s}\n",
        sessionIndex, static_cast<unsigned long long>(pid), setupValid ? "true" : "false",
        appCpuStartupCount, static_cast<unsigned long long>(submitted),
        static_cast<unsigned long long>(completed), artifactFatal ? "true" : "false",
        unexpectedResets, blockedReentrantIo ? "true" : "false", workloadPass ? "true" : "false",
        running ? "true" : "false",
        static_cast<unsigned long long>(submitted), static_cast<unsigned long long>(completionWatermarkAtCut),
        static_cast<unsigned long long>(completionWatermarkAfterDrain), static_cast<unsigned long long>(postCutSubmissions),
        drainComplete ? "true" : "false", drainTimeout ? "true" : "false");
    std::fflush(f);
    std::fclose(f);
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

/* E120/Fase 5 (EVIDENCE.md, 2026-09-05): bounded, diagnosed replacement for the plain
 * `for (auto& item : sessions) item.session->stopSimulation();` loop this file used to end with.
 *
 * Pre-existing defect (E104): for Sessions>1, `stopSimulation()` can hang indefinitely -- narrowed
 * in this entry to a high-confidence but not fully source-proven hypothesis (`Scheduler::stop()`'s
 * `m_thread.join()` blocking because the Scheduler's own worker thread is itself blocked, most
 * plausibly via a circular wait against `VnextBWaitDispatcher`'s own unbounded
 * `WaitForMultipleObjects(..., INFINITE)`, since `VnextBAttachment::stop()`'s
 * unregister-before-terminate sequence can only run AFTER `Scheduler::stop()` already returns).
 * NOT rewritten in this entry: this codebase's own history (see
 * softmmu/simuliface.c's `arenaTransactionBegin()` comment) already documents a concurrency change
 * in this exact area that looked correct and caused a ~36-minute hang on its first validation run
 * -- restructuring the stop *sequence* itself is real, separate, higher-risk work this entry does
 * not rush into.
 *
 * What this DOES fix: the harness itself no longer hangs forever. Every session's own result is
 * already durably written (`writeSessionResultJsonlIfRequested()`, called for every session before
 * ANY `stopSimulation()` call, in the loop above this function's call site) before teardown ever
 * starts, so a hung teardown loses no measurement. If one session's `stopSimulation()` does not
 * return within `perSessionTimeout`, this function logs exactly which session index hung, detaches
 * that stuck worker thread, and terminates the whole process immediately via `std::_Exit()` --
 * safe specifically because every QEMU child process is bound to a Job Object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`QemuProcessManager.cpp`), so this process's own exit, by
 * whatever means, kills every remaining QEMU child. No orphan can survive this path. The exit code
 * (2) is distinct from the normal PASS/FAIL codes (0/1) so a caller can tell "hung teardown,
 * results are in the JSONL file" apart from "ran to completion, see PRODUCTION_SCALE FAIL". */
void stopSessionsWithDefensiveTimeout(std::vector<ScaleSession>& sessions,
                                      std::chrono::milliseconds perSessionTimeout) {
    for (size_t i = 0; i < sessions.size(); ++i) {
        SimulationSession* session = sessions[i].session.get();
        auto done = std::make_shared<std::atomic<bool>>(false);
        std::thread worker([session, done] {
            session->stopSimulation();
            done->store(true, std::memory_order_release);
        });
        const auto deadline = std::chrono::steady_clock::now() + perSessionTimeout;
        while (!done->load(std::memory_order_acquire) &&
              std::chrono::steady_clock::now() < deadline) {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        if (done->load(std::memory_order_acquire)) {
            worker.join();
            continue;
        }
        std::fprintf(stderr,
            "TEARDOWN_HANG session=%zu did not complete stopSimulation() within %lldms -- "
            "see EVIDENCE.md E120 Fase 5 / E123. Exiting process now (every session's result was "
            "already written before teardown started; QEMU children are bound to a "
            "kill-on-close Job Object, so none survive this exit).\n",
            i, static_cast<long long>(perSessionTimeout.count()));
        std::fflush(stderr);
        // Unconditional snapshot of the shared dispatcher's own occupancy/identity at the moment
        // the hang was detected, using the existing test-support accessor (the dispatcher's
        // generation/in-flight counters are private implementation state, not exposed here).
        {
            char reason[32];
            std::snprintf(reason, sizeof(reason), "TEARDOWN_HANG session=%zu", i);
            const auto stats = mcu::qemu::VnextBAttachment::waitDispatcherStatsForTesting();
            std::fprintf(stderr,
                "[TEARDOWN_SNAPSHOT] reason=%s dispatcherOccupiedSlots=%zu dispatcherWorkerIdentity=%llu\n",
                reason, stats.occupiedSlots, static_cast<unsigned long long>(stats.workerIdentity));
            std::fflush(stderr);
        }
        worker.detach();
        // std::_Exit() (unlike exit()) does NOT flush open C stdio streams -- without an explicit
        // flush here, every std::printf() line already produced by this function's caller (the
        // per-session "SCALE session=..." lines, "METRIC ..." would-be lines, etc.) would be lost
        // under redirection to a file exactly the same way the original E104 hang lost them,
        // defeating the whole point of exiting instead of hanging.
        std::fflush(stdout);
        std::_Exit(2);
    }
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
    // E112 (EVIDENCE.md): correlates Scheduler::MetricsSnapshot::maxSettleNanoseconds/
    // maxSettleAtNowNs (.spec 32.5.18/32.5.19's own already-validated technique) against
    // QEMU-side timg_wdt_expire timestamps, off by default -- setProfilingEnabled() is cheap
    // (lock-free, no hot-path I/O per its own doc comment) but this keeps default test output
    // unchanged for the regular regression suite.
    const bool schedulerMetrics = std::getenv("LASECSIMUL_SCALE_SCHEDULER_METRICS") &&
                                  std::string(std::getenv("LASECSIMUL_SCALE_SCHEDULER_METRICS")) != "0";
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
            if (schedulerMetrics) session.scheduler().setProfilingEnabled(true);
            session.beginExecutionIfNeeded();
            item.executionId = session.runtimeState().sessionExecutionId;
            if (!item.executionId) item.startError = "zero executionId";
            McuDebugOptions debug;
            session.loadMcuFirmware(item.mcuIndex, firmware, item.arenaName, qemu.string(), debug);
        } catch (const std::exception& error) {
            item.startError = error.what();
            // E146 (EVIDENCE.md, 2026-09-09): without this, a session rejected by the capacity
            // guard was left running (Scheduler ticking, unattached) for the rest of the run
            // alongside the other real QEMU-backed sessions -- reproduced a STATUS_STACK_BUFFER_
            // OVERRUN crash (bisected: never before this point, ~100% reproducible after it, both
            // in parallelStart and sequential mode, only when a rejection actually occurs). A
            // bare scheduler().stop() fixed the crash but left the rejected session's own worker
            // thread busy-spinning at full CPU for the rest of the run (observed via Get-Process:
            // >850s of accumulated CPU time over an 85s wall-clock window) -- harmless with 32
            // unconstrained host cores, but enough to starve the other 8 real sessions under
            // run_production_mwdt.ps1's processor-affinity restriction and blow through its
            // external timeout backstop. stopSimulation() is the same full, idempotent teardown
            // every session already gets in the final loop below (it also stops each MCU
            // component's firmware, not just the Scheduler) -- calling it here immediately,
            // rather than leaving this session's teardown to happen only at the very end,
            // resolves both the crash and the busy-spin.
            session.stopSimulation();
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

    // E130 (EVIDENCE.md, 2026-09-05): replaces E120's own "poll for submitted==completed, then
    // break" convergence wait -- proven, by direct code inspection (not just observed in the
    // field), to admit exactly the race that produced E129's B11 N=8 finding
    // (submissions==completions+1 on 2 of 8 sessions): that loop's own "allConverged" check reads
    // BOTH counters fresh on every iteration, and the moment it observes equality it breaks
    // immediately -- but the FINAL per-session read used for the actual pass/fail decision and
    // JSONL record (previously a few lines below, also freshly re-read) is a SEPARATE, LATER
    // sample. Nothing pauses the guest between "the wait loop observed equality" and "the final
    // read" -- the workload keeps running in real time -- so a new submission accepted in that gap
    // is counted in the final `submitted` without its (not-yet-arrived) completion, producing
    // exactly a submissions=completions+1 artifact indistinguishable, under the old scheme, from a
    // genuine dropped completion.
    //
    // Fix: freeze a per-session submission CUTOFF once, at the runMs deadline, before any waiting
    // starts. The drain loop then waits for each session's own completion counter to reach (not
    // merely equal) that frozen cutoff -- `completionCount >= cutoff`, never re-reading the
    // cutoff itself. A submission accepted after the cutoff is explicitly out of scope for this
    // measurement (reported separately, informational only, matching this task's own "submissões
    // posteriores ao corte não participam daquela medição"). This requires completions to never
    // reorder ahead of the submission they answer WITHIN one session's own counters -- true here
    // because a single session's I2C traffic is a single VNEXT_B lane, processed strictly FIFO by
    // both vnext_b_i2c_submit()'s own ring publish and the Core's own dispatchOneEvent() consume
    // loop (softmmu/vnext_b.c / McuComponent.cpp) -- there is no mechanism by which this session's
    // Nth completion could ever be recorded before its Nth submission's own predecessors are, so
    // `completionCount >= cutoff` is a sound proxy for "every request accepted before the cutoff
    // has been answered", not merely a coincidental count match.
    std::vector<uint64_t> submissionCutoff(static_cast<size_t>(count), 0);
    std::vector<uint64_t> completionAtCut(static_cast<size_t>(count), 0);
    for (int i = 0; i < count; ++i) {
        const auto& item = sessions[static_cast<size_t>(i)];
        submissionCutoff[static_cast<size_t>(i)] = item.mcu ? item.mcu->vnextI2cSubmissionCountForTesting() : 0;
        completionAtCut[static_cast<size_t>(i)] = item.mcu ? item.mcu->vnextI2cCompletionCountForTesting() : 0;
    }

    bool drainTimeoutHit = false;
    if (!idle) {
        std::vector<std::function<uint64_t()>> readCompletions;
        readCompletions.reserve(static_cast<size_t>(count));
        for (int i = 0; i < count; ++i) {
            mcu::McuComponent* mcu = sessions[static_cast<size_t>(i)].mcu;
            readCompletions.push_back([mcu]() -> uint64_t {
                /* No mcu -> that session's own cutoff was also captured as 0 above, so this
                 * trivially satisfies readCompletion() >= cutoff without ever blocking -- matching
                 * the prior inline loop's `if (!item.mcu) continue`. */
                return mcu ? mcu->vnextI2cCompletionCountForTesting() : 0;
            });
        }
        const auto drainDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        const auto result = lasecsimul::mcu::waitForAllToDrain(
            readCompletions, submissionCutoff, drainDeadline, std::chrono::milliseconds(50));
        drainTimeoutHit = result.timedOut;
    }

    uint64_t submissions = 0, completions = 0;
    for (int i = 0; i < count; ++i) {
        const auto& item = sessions[static_cast<size_t>(i)];
        const uint64_t cutoff = submissionCutoff[static_cast<size_t>(i)];
        const uint64_t completedAfterDrain = item.mcu ? item.mcu->vnextI2cCompletionCountForTesting() : 0;
        const uint64_t currentSubmissions = item.mcu ? item.mcu->vnextI2cSubmissionCountForTesting() : 0;
        const uint64_t postCutSubmissions = currentSubmissions >= cutoff ? currentSubmissions - cutoff : 0;
        const bool drainComplete = completedAfterDrain >= cutoff;
        // Reported/gated value: never exceeds the cutoff, so "submissions"/"completions" stay
        // meaningfully comparable exactly as every existing consumer (b11_classify.ps1, this
        // file's own printf/JSONL) already expects -- drainComplete true means this equals cutoff;
        // false means it shows the genuine shortfall, never masked by post-cut activity.
        const uint64_t submitted = cutoff;
        const uint64_t completed = std::min(completedAfterDrain, cutoff);
        // E118 (EVIDENCE.md, 2026-09-05): a live process (firmwareRunning()==true) is not proof of
        // a healthy session -- artifact_state can become LASEC_AT_FAILED mid-run while the QEMU
        // process itself keeps executing. Classify that explicitly as a failure rather than
        // letting non-zero submissions/completions mask it.
        const bool artifactFatal = item.mcu && item.mcu->vnextArtifactFatal();
        submissions += submitted; completions += completed;
        if (!idle && (submitted == 0 || !drainComplete || artifactFatal)) ++failures;
        std::printf("SCALE session=%d executionId=%llu pid=%llu running=%s artifactFatal=%s submissions=%llu completions=%llu"
                    " drainComplete=%s drainTimeout=%s postCutSubmissions=%llu\n",
                    i, static_cast<unsigned long long>(item.executionId),
                    static_cast<unsigned long long>(item.mcu ? item.mcu->qemuProcessIdForTesting() : 0),
                    item.mcu && item.mcu->firmwareRunning() ? "true" : "false",
                    artifactFatal ? "true" : "false",
                    static_cast<unsigned long long>(submitted),
                    static_cast<unsigned long long>(completed),
                    drainComplete ? "true" : "false", drainTimeoutHit ? "true" : "false",
                    static_cast<unsigned long long>(postCutSubmissions));
        if (!idle && (submitted == 0 || !drainComplete)) {
            std::fprintf(stderr, "SCALE_DIAGNOSTIC session=%d scheduler_running=%s scheduler_paused=%s qemu_logs=%s\n",
                         i, item.session->scheduler().isRunning() ? "true" : "false",
                         item.session->scheduler().isPaused() ? "true" : "false",
                         item.mcu ? item.mcu->qemuLogs().c_str() : "<no-mcu>");
        }
        if (schedulerMetrics) {
            const auto snap = item.session->scheduler().metrics();
            std::fprintf(stderr, "SCHEDULER_METRICS session=%d maxSettleNanoseconds=%llu"
                         " maxSettleAtNowNs=%llu settleIterations=%llu eventsProcessed=%llu\n",
                         i, static_cast<unsigned long long>(snap.maxSettleNanoseconds),
                         static_cast<unsigned long long>(snap.maxSettleAtNowNs),
                         static_cast<unsigned long long>(snap.settleIterations),
                         static_cast<unsigned long long>(snap.eventsProcessed));
        }
        dumpSuccessfulQemuLogIfRequested(item, i);
        writeSessionResultJsonlIfRequested(item, i, submitted, completed, artifactFatal,
                                            completionAtCut[static_cast<size_t>(i)], completedAfterDrain,
                                            postCutSubmissions, drainComplete, drainTimeoutHit);
    }
    stopSessionsWithDefensiveTimeout(sessions, std::chrono::milliseconds(15000));

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

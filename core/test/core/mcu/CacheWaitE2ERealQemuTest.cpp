#include <chrono>
#include <algorithm>
#include <ctime>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <memory>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
extern char **environ;
#endif

#include "mcu/McuComponent.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginRuntime.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;

namespace {

struct MatchedLine {
    size_t offset{};
    std::string text;
};

struct GuestMark {
    size_t offset{};
    uint64_t value{};
};

void writeTextFile(const std::filesystem::path& path, const std::string& text);

uint64_t processIdForProgress() {
#ifdef _WIN32
    return static_cast<uint64_t>(_getpid());
#else
    return static_cast<uint64_t>(getpid());
#endif
}

std::string jsonEscape(const std::string& value) {
    std::string out;
    out.reserve(value.size() + 8);
    for (const char ch : value) {
        switch (ch) {
        case '\\': out += "\\\\"; break;
        case '"': out += "\\\""; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default: out.push_back(ch); break;
        }
    }
    return out;
}

std::string hostTimestamp() {
    const auto now = std::chrono::system_clock::now();
    const auto tt = std::chrono::system_clock::to_time_t(now);
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &tt);
#else
    gmtime_r(&tt, &tm);
#endif
    std::ostringstream out;
    out << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
    return out.str();
}

class ProgressLog {
public:
    ProgressLog(std::filesystem::path outDir, std::string scenario)
        : m_scenario(std::move(scenario)) {
        if (!outDir.empty()) {
            std::filesystem::create_directories(outDir);
            m_out.open(outDir / "HARNESS_PROGRESS.jsonl", std::ios::binary | std::ios::app);
        }
        m_last = std::chrono::steady_clock::now();
    }

    void event(const std::string& stage, const std::string& edge,
               uint64_t qemuPid = 0, const std::string& detail = {}) {
        if (!m_out) return;
        const auto now = std::chrono::steady_clock::now();
        const auto deltaMs = std::chrono::duration_cast<std::chrono::milliseconds>(now - m_last).count();
        m_last = now;
        m_out << "{\"seq\":" << ++m_seq
              << ",\"timestamp\":\"" << hostTimestamp() << "\""
              << ",\"scenario\":\"" << jsonEscape(m_scenario) << "\""
              << ",\"harness_pid\":" << processIdForProgress()
              << ",\"qemu_pid\":" << qemuPid
              << ",\"stage\":\"" << jsonEscape(stage) << "\""
              << ",\"edge\":\"" << jsonEscape(edge) << "\""
              << ",\"duration_ms_since_previous\":" << deltaMs;
        if (!detail.empty()) {
            m_out << ",\"detail\":\"" << jsonEscape(detail) << "\"";
        }
        m_out << "}\n";
        m_out.flush();
    }

private:
    std::ofstream m_out;
    std::string m_scenario;
    uint64_t m_seq = 0;
    std::chrono::steady_clock::time_point m_last;
};

std::vector<std::string> lasecEnvNames() {
    std::vector<std::string> out;
#ifdef _WIN32
    char **env = _environ;
#else
    char **env = environ;
#endif
    if (!env) return out;
    for (char **entry = env; *entry; ++entry) {
        std::string text(*entry);
        const auto eq = text.find('=');
        const std::string name = eq == std::string::npos ? text : text.substr(0, eq);
        if (name.rfind("LASECSIMUL_", 0) == 0) {
            out.push_back(name);
        }
    }
    std::sort(out.begin(), out.end());
    return out;
}

void writeLasecEnvNames(const std::filesystem::path& outDir) {
    if (outDir.empty()) return;
    std::string text;
    for (const auto& name : lasecEnvNames()) {
        text += name + "\n";
    }
    writeTextFile(outDir / "HARNESS_ENV_NAMES.txt", text);
}

std::string hexToText(const std::string& hex) {
    std::string out;
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        out.push_back(static_cast<char>(std::stoul(hex.substr(i, 2), nullptr, 16)));
    }
    return out;
}

std::vector<std::string> matchingLines(const std::string& text, const std::string& pattern) {
    std::vector<std::string> out;
    const std::regex re(pattern);
    for (std::sregex_iterator it(text.begin(), text.end(), re), end; it != end; ++it) {
        out.push_back(it->str());
    }
    return out;
}

std::vector<MatchedLine> matchingLogLines(const std::string& text, const std::string& pattern) {
    std::vector<MatchedLine> out;
    const std::regex re(pattern);
    for (std::sregex_iterator it(text.begin(), text.end(), re), end; it != end; ++it) {
        out.push_back(MatchedLine{static_cast<size_t>(it->position()), it->str()});
    }
    return out;
}

std::vector<std::string> linesForEvent(const std::string& text, const std::string& event) {
    return matchingLines(text, "\\[CACHE_WAIT_DIAG\\] event=" + event + "[^\\r\\n]*");
}

std::vector<MatchedLine> logLinesForEvent(const std::string& text, const std::string& event) {
    return matchingLogLines(text, "\\[CACHE_WAIT_DIAG\\] event=" + event + "[^\\r\\n]*");
}

std::string fieldOf(const std::string& line, const std::string& field) {
    const std::regex pattern("(^| )" + field + "=([^ ]+)");
    std::smatch m;
    return std::regex_search(line, m, pattern) ? m[2].str() : "";
}

uint64_t hexValue(const std::string& value) {
    if (value.empty()) return 0;
    size_t idx = 0;
    return std::stoull(value, &idx, 0);
}

std::vector<GuestMark> guestMarksWithOffsets(const std::string& text) {
    std::vector<GuestMark> out;
    const std::regex re("\\[E131_GUEST_MARK\\] value=(0x[0-9a-fA-F]+)");
    for (std::sregex_iterator it(text.begin(), text.end(), re), end; it != end; ++it) {
        out.push_back(GuestMark{static_cast<size_t>(it->position()), hexValue((*it)[1].str())});
    }
    return out;
}

std::vector<uint64_t> guestMarkValues(const std::string& text) {
    std::vector<uint64_t> out;
    for (const auto& mark : guestMarksWithOffsets(text)) {
        out.push_back(mark.value);
    }
    return out;
}

bool hasGuestMarkValue(const std::vector<uint64_t>& marks, uint64_t expected) {
    for (const uint64_t value : marks) {
        if (value == expected) return true;
    }
    return false;
}

size_t countGuestMarkValue(const std::vector<GuestMark>& marks, uint64_t expected) {
    size_t count = 0;
    for (const auto& mark : marks) {
        if (mark.value == expected) ++count;
    }
    return count;
}

int indexOfGuestMarkValue(const std::vector<GuestMark>& marks, uint64_t expected) {
    for (size_t i = 0; i < marks.size(); ++i) {
        if (marks[i].value == expected) return static_cast<int>(i);
    }
    return -1;
}

bool hasGuestFailureMark(const std::vector<uint64_t>& marks) {
    for (const uint64_t value : marks) {
        if ((value & 0xff000000ULL) == 0xaf000000ULL) return true;
        if ((value & 0xffffff00ULL) == 0xa0ffff00ULL && value != 0xa0ffffffULL) return true;
    }
    return false;
}

uint64_t envHex(const char* name) {
    const char* value = std::getenv(name);
    if (!value || !*value) return 0;
    return hexValue(value);
}

int envInt(const char* name) {
    const char* value = std::getenv(name);
    if (!value || !*value) return 0;
    return std::atoi(value);
}

void require(bool ok, std::vector<std::string>& failures, const std::string& message) {
    if (!ok) failures.push_back(message);
}

bool fieldHexEquals(const std::string& line, const std::string& field, uint64_t expected) {
    const std::string value = fieldOf(line, field);
    return !value.empty() && hexValue(value) == expected;
}

std::vector<std::string> filterField(const std::vector<std::string>& lines,
                                     const std::string& field,
                                     const std::string& expected) {
    std::vector<std::string> out;
    for (const auto& line : lines) {
        if (fieldOf(line, field) == expected) out.push_back(line);
    }
    return out;
}

std::vector<MatchedLine> filterField(const std::vector<MatchedLine>& lines,
                                     const std::string& field,
                                     const std::string& expected) {
    std::vector<MatchedLine> out;
    for (const auto& line : lines) {
        if (fieldOf(line.text, field) == expected) out.push_back(line);
    }
    return out;
}

std::vector<std::string> filterHexField(const std::vector<std::string>& lines,
                                        const std::string& field,
                                        uint64_t expected) {
    std::vector<std::string> out;
    for (const auto& line : lines) {
        if (fieldHexEquals(line, field, expected)) out.push_back(line);
    }
    return out;
}

std::vector<MatchedLine> filterHexField(const std::vector<MatchedLine>& lines,
                                        const std::string& field,
                                        uint64_t expected) {
    std::vector<MatchedLine> out;
    for (const auto& line : lines) {
        if (fieldHexEquals(line.text, field, expected)) out.push_back(line);
    }
    return out;
}

size_t firstOffset(const std::vector<MatchedLine>& lines) {
    return lines.empty() ? std::string::npos : lines.front().offset;
}

bool hasResumeBefore(const std::vector<MatchedLine>& resume, size_t offset) {
    for (const auto& line : resume) {
        if (line.offset < offset) return true;
    }
    return false;
}

bool markerFollowedBy(const std::vector<GuestMark>& marks, uint64_t marker, uint64_t value) {
    const int index = indexOfGuestMarkValue(marks, marker);
    return index >= 0 && static_cast<size_t>(index + 1) < marks.size() &&
           marks[static_cast<size_t>(index + 1)].value == value;
}

bool markerFollowedByEqualValues(const std::vector<GuestMark>& marks, uint64_t marker) {
    const int index = indexOfGuestMarkValue(marks, marker);
    return index >= 0 && static_cast<size_t>(index + 2) < marks.size() &&
           marks[static_cast<size_t>(index + 1)].value == marks[static_cast<size_t>(index + 2)].value;
}

uint64_t fieldU64(const MatchedLine& line, const std::string& field) {
    return hexValue(fieldOf(line.text, field));
}

void writeTextFile(const std::filesystem::path& path, const std::string& text) {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary);
    out << text;
}

void setEnv(const char* name, const char* value) {
#ifdef _WIN32
    _putenv_s(name, value);
#else
    setenv(name, value, 1);
#endif
}

std::string requiredEnv(const char* name, std::vector<std::string>& failures) {
    const char* value = std::getenv(name);
    if (!value || !*value) {
        failures.push_back(std::string("missing required environment variable ") + name);
        return {};
    }
    return value;
}

} // namespace

int main() {
    std::setvbuf(stderr, nullptr, _IONBF, 0);

    std::vector<std::string> failures;
    const std::string caseName = requiredEnv("LASECSIMUL_E131_CASE_NAME", failures);
    const int caseId = envInt("LASECSIMUL_E131_CASE_ID");
    const uint64_t expectedDromVaddr = envHex("LASECSIMUL_E131_DROM_VADDR");
    const uint64_t expectedDromLoadPc = envHex("LASECSIMUL_E131_DROM_LOAD_PC");
    const uint64_t expectedFetchPc = envHex("LASECSIMUL_E131_FETCH_TARGET_PC");
    const char* outDirEnv = std::getenv("LASECSIMUL_E131_OUT_DIR");
    const std::filesystem::path outDir =
        outDirEnv && *outDirEnv ? std::filesystem::u8path(outDirEnv) : std::filesystem::path{};
    ProgressLog progress(outDir, caseName);
    progress.event("harness", "begin");
    writeLasecEnvNames(outDir);

    std::fprintf(stderr, "E131_HARNESS_BEGIN case=%s id=%d\n", caseName.c_str(), caseId);
    const char* firmwareEnv = std::getenv("LASECSIMUL_TEST_FIRMWARE");
    const char* qemuEnv = std::getenv("LASECSIMUL_TEST_QEMU_BINARY");
    if (!firmwareEnv || !*firmwareEnv || !qemuEnv || !*qemuEnv) {
        std::fprintf(stderr, "FAILED: LASECSIMUL_TEST_FIRMWARE and LASECSIMUL_TEST_QEMU_BINARY are required\n");
        return 1;
    }
    const std::filesystem::path firmware = std::filesystem::u8path(firmwareEnv);
    const std::filesystem::path qemu = std::filesystem::u8path(qemuEnv);
    if (!std::filesystem::exists(firmware) || !std::filesystem::exists(qemu)) {
        std::fprintf(stderr, "FAILED: firmware or QEMU does not exist\n");
        return 1;
    }
    const bool useVnextB = std::getenv("LASECSIMUL_MCU_TRANSPORT") &&
                           std::string_view(std::getenv("LASECSIMUL_MCU_TRANSPORT")) == "VNEXT_B";
    const bool useMttcg = std::getenv("LASECSIMUL_ESP32_EXECUTION_MODE") &&
                          std::string_view(std::getenv("LASECSIMUL_ESP32_EXECUTION_MODE")) == "mttcg";
    if (!useVnextB || !useMttcg) {
        std::fprintf(stderr, "FAILED: this proof must run with VNEXT_B + MTTCG\n");
        return 1;
    }

    setEnv("LASECSIMUL_NETWORK_MODE", "disabled");
    setEnv("LASECSIMUL_CACHE_WAIT_DIAG_TRACE", "1");
    setEnv("LASECSIMUL_APP_CPU_RESET_TRACE", "1");
    setEnv("LASECSIMUL_E131_GUEST_MARK_TRACE", "1");
    setEnv("LASECSIMUL_E131_TCG_TRACE", "1");

    const std::filesystem::path adapterPath = ESP32_ADAPTER_DLL_PATH;
    const std::filesystem::path devicesLibraryPath = REAL_DEVICES_LIBRARY_JSON_PATH;
    if (!std::filesystem::exists(adapterPath) || !std::filesystem::exists(devicesLibraryPath)) {
        std::fprintf(stderr, "FAILED: adapter or devices library is not available\n");
        return 1;
    }

    progress.event("session_create", "begin");
    plugins::GlobalPluginCache cache;
    auto module = cache.loader().loadMcuPlugin(adapterPath);
    cache.setActiveMcuModule("espressif.esp32", module);
    cache.loadLibrary(devicesLibraryPath);

    SimulationSession session(cache);
    session.registerKnownMcuTypes();
    session.registerKnownPluginTypes();
    progress.event("session_create", "end");

    mcu::McuComponent* mcu = nullptr;
    session.components().registerFactory("test.esp32", [&session, &mcu](const registry::ComponentParams&) {
        auto result = std::make_unique<mcu::McuComponent>(session.mcus().create("espressif.esp32"), session.scheduler());
        mcu = result.get();
        return result;
    });

    registry::ComponentParams plotParams;
    plotParams.pinList = {{"tx", 0.0, 8.0}, {"rx", 0.0, 24.0}};
    const uint32_t plotIndex = session.addComponent("peripherals.lasecplot", plotParams);
    session.setProperty(plotIndex, "baudrate", PropertyValue{115200.0});
    session.setProperty(plotIndex, "data_bits", PropertyValue{8.0});
    session.setProperty(plotIndex, "stop_bits", PropertyValue{1.0});
    session.setProperty(plotIndex, "parity", PropertyValue{std::string("none")});
    const uint32_t esp32 = session.addComponent("test.esp32", {});
    session.connectWire(esp32, "GPIO1", plotIndex, "rx");

    const std::string arena = "lasecsimul-e131-" + caseName + "-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    progress.event("scheduler_start", "begin");
    session.scheduler().start();
    session.beginExecutionIfNeeded();
    progress.event("scheduler_start", "end");
    std::fprintf(stderr, "E131_HARNESS_LOADING case=%s firmware=%s qemu=%s\n",
                 caseName.c_str(), firmware.string().c_str(), qemu.string().c_str());
    progress.event("loadMcuFirmware", "begin");
    session.loadMcuFirmware(esp32, firmware, arena, qemu.string());
    const uint64_t qemuPid = mcu ? mcu->qemuProcessIdForTesting() : 0;
    progress.event("loadMcuFirmware", "end", qemuPid);
    std::fprintf(stderr, "E131_HARNESS_LOADED case=%s\n", caseName.c_str());
    if (std::getenv("LASECSIMUL_E131_FORCE_HARNESS_HANG_AFTER_LOAD")) {
        progress.event("forced_hang_after_load", "begin", qemuPid);
        for (;;) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            progress.event("forced_hang_after_load", "heartbeat", qemuPid);
        }
    }

    std::string accumulatedHex;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(35);
    std::string text;
    std::string logs;
    progress.event("observation_window", "begin", qemuPid);
    auto lastHeartbeat = std::chrono::steady_clock::now() - std::chrono::seconds(1);
    while (std::chrono::steady_clock::now() < deadline && mcu->firmwareRunning()) {
        const auto loopNow = std::chrono::steady_clock::now();
        const bool sampleProgress = loopNow - lastHeartbeat >= std::chrono::seconds(1);
        if (sampleProgress) progress.event("firmwareRunning", "begin", qemuPid);
        const bool running = mcu->firmwareRunning();
        if (sampleProgress) progress.event("firmwareRunning", "end", qemuPid, running ? "running" : "stopped");
        if (!running) break;
        if (sampleProgress) progress.event("tryDrainUartRx", "begin", qemuPid);
        if (const auto snapshot = session.tryDrainUartRx(plotIndex)) {
            if (sampleProgress) {
                progress.event("tryDrainUartRx", "end", qemuPid,
                               snapshot->dataHex.empty() ? "empty" : "data");
            }
            if (!snapshot->dataHex.empty()) {
                accumulatedHex += snapshot->dataHex;
                text = hexToText(accumulatedHex);
                if (text.find("E131_DONE ") != std::string::npos) break;
            }
        } else {
            if (sampleProgress) progress.event("tryDrainUartRx", "end", qemuPid, "none");
        }
        if (sampleProgress) progress.event("qemuLogs", "begin", qemuPid);
        logs = mcu->qemuLogs();
        if (sampleProgress) progress.event("qemuLogs", "end", qemuPid);
        if (sampleProgress) progress.event("marker_eval", "begin", qemuPid);
        const auto marks = guestMarkValues(logs);
        if (sampleProgress) progress.event("marker_eval", "end", qemuPid);
        if (hasGuestMarkValue(marks, 0xa0ffffffULL) || hasGuestFailureMark(marks)) {
            break;
        }
        if (sampleProgress) {
            progress.event("observation_window", "heartbeat", qemuPid);
            lastHeartbeat = loopNow;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    progress.event("observation_window", "end", qemuPid);

    const bool stillRunning = mcu->firmwareRunning();
    progress.event("final_log_capture", "begin", qemuPid);
    logs = mcu->qemuLogs();
    text = hexToText(accumulatedHex);
    progress.event("final_log_capture", "end", qemuPid);

    if (!outDir.empty()) {
        writeTextFile(outDir / "uart.txt", text);
        writeTextFile(outDir / "qemu.log", logs);
    }

    const auto guestMarkRecords = guestMarksWithOffsets(logs);
    const auto guestMarks = guestMarkValues(logs);
    const bool guestPass = text.find("E131_DONE PASS scenario=" + caseName) != std::string::npos ||
                           hasGuestMarkValue(guestMarks, 0xa0ffffffULL);
    const bool guestFail = text.find("E131_FAIL") != std::string::npos ||
                           hasGuestFailureMark(guestMarks);
    require(stillRunning, failures, "QEMU stopped before the proof completed");
    require(guestPass, failures, "guest did not publish E131 pass marker for " + caseName);
    require(!guestFail, failures, "guest published E131 failure marker");

    const auto suspend = linesForEvent(logs, "suspend_committed");
    const auto resume = linesForEvent(logs, "resume_committed");
    const auto release = linesForEvent(logs, "release_observed");
    const auto resetClear = linesForEvent(logs, "reset_wait_cleared");
    const auto legitIllegal = linesForEvent(logs, "legitimate_illegal_access");
    const auto tcgRestore = matchingLines(logs, "\\[E131_TCG_RESTORE\\][^\\r\\n]*");
    const auto tcgTranslate = matchingLines(logs, "\\[E131_TCG_TRANSLATE\\][^\\r\\n]*");
    const auto suspendLog = logLinesForEvent(logs, "suspend_committed");
    const auto resumeLog = logLinesForEvent(logs, "resume_committed");
    const auto releaseLog = logLinesForEvent(logs, "release_observed");
    const auto resetClearLog = logLinesForEvent(logs, "reset_wait_cleared");
    const auto tcgRestoreLog = matchingLogLines(logs, "\\[E131_TCG_RESTORE\\][^\\r\\n]*");
    const auto tcgTranslateLog = matchingLogLines(logs, "\\[E131_TCG_TRANSLATE\\][^\\r\\n]*");
    const auto resetR4Log = matchingLogLines(logs, "\\[APP_CPU_RESET_R4\\][^\\r\\n]*");
    const auto resetR6Log = matchingLogLines(logs, "\\[APP_CPU_RESET_R6\\][^\\r\\n]*");
    int tcgRestoreAttempted = 0;
    int tcgRestoreSucceeded = 0;
    for (const auto& line : tcgRestore) {
        if (fieldOf(line, "attempted") == "1") ++tcgRestoreAttempted;
        if (fieldOf(line, "restored") == "1") ++tcgRestoreSucceeded;
    }

    for (const auto& line : suspend) {
        require(fieldOf(line, "cpu") == "1", failures, "suspend not on APP CPU: " + line);
        require(fieldOf(line, "ill_irq") == "0", failures, "cache IRQ active during compensatory suspend: " + line);
        require(fieldOf(line, "stop") == "0" && fieldOf(line, "stopped") == "0",
                failures, "CPU already stopped before suspend: " + line);
    }
    for (const auto& line : resume) {
        require(fieldOf(line, "ill_irq") == "0", failures, "cache IRQ active during compensatory resume: " + line);
    }

    if (caseName == "DROM") {
        require(caseId == 1, failures, "DROM case id mismatch");
        require(expectedDromVaddr != 0, failures, "DROM exact vaddr was not supplied");
        require(expectedDromLoadPc != 0, failures, "DROM exact load PC was not supplied");
        auto dromSuspends = filterField(suspend, "region", "drom0");
        dromSuspends = filterHexField(dromSuspends, "vaddr", expectedDromVaddr);
        auto dromSuspendLog = filterField(suspendLog, "region", "drom0");
        dromSuspendLog = filterHexField(dromSuspendLog, "vaddr", expectedDromVaddr);
        require(dromSuspends.size() == 1, failures, "DROM did not produce exactly one suspend for the exact .flash.rodata vaddr");
        bool hasNonzeroMemIoPc = false;
        uint64_t dromMemIoPc = 0;
        for (const auto& line : dromSuspends) {
            dromMemIoPc = hexValue(fieldOf(line, "mem_io_pc"));
            hasNonzeroMemIoPc = hasNonzeroMemIoPc || dromMemIoPc != 0;
            require(fieldOf(line, "guest_case") == "1", failures, "DROM suspend missing guest_case=1: " + line);
        }
        require(hasNonzeroMemIoPc, failures, "DROM data-load suspend did not carry non-zero mem_io_pc");
        require(countGuestMarkValue(guestMarkRecords, 0xe131d00dULL) == 1,
                failures, "DROM guest did not publish the exact loaded value exactly once");
        require(countGuestMarkValue(guestMarkRecords, 0xa4010000ULL) == 1,
                failures, "DROM did not report zero flash-function side effects exactly once");
        const auto dromRestores = filterHexField(tcgRestore, "guest_pc", expectedDromLoadPc);
        require(dromRestores.size() == 1, failures, "DROM restore did not resolve exactly once to the exact load PC");
        for (const auto& line : dromRestores) {
            require(fieldOf(line, "cpu") == "1", failures, "DROM restore was not on APP CPU: " + line);
            require(fieldOf(line, "attempted") == "1" && fieldOf(line, "restored") == "1",
                    failures, "DROM restore was not successful: " + line);
            require(hexValue(fieldOf(line, "host_pc")) == dromMemIoPc,
                    failures, "DROM restore host_pc did not match suspend mem_io_pc: " + line);
        }
        require(release.size() == 1, failures, "DROM did not produce exactly one release_observed");
        require(resume.size() == 1, failures, "DROM did not produce exactly one resume_committed");
        if (!dromSuspendLog.empty() && !releaseLog.empty() && !resumeLog.empty()) {
            require(dromSuspendLog.front().offset < releaseLog.front().offset &&
                    releaseLog.front().offset < resumeLog.front().offset,
                    failures, "DROM suspend/release/resume order is not monotonic");
        }
        require(legitIllegal.empty(), failures, "DROM compensatory path produced legitimate illegal access");
    } else if (caseName == "FETCH") {
        require(caseId == 2, failures, "FETCH case id mismatch");
        require(expectedFetchPc != 0, failures, "FETCH target PC was not supplied");
        auto fetchSuspends = filterField(suspend, "region", "iram0");
        fetchSuspends = filterHexField(fetchSuspends, "vaddr", expectedFetchPc);
        auto fetchSuspendLog = filterField(suspendLog, "region", "iram0");
        fetchSuspendLog = filterHexField(fetchSuspendLog, "vaddr", expectedFetchPc);
        require(fetchSuspends.size() == 1, failures, "FETCH did not produce exactly one suspend for the exact flash instruction vaddr");
        bool hasTranslationFetch = false;
        for (const auto& line : fetchSuspends) {
            hasTranslationFetch = hasTranslationFetch || hexValue(fieldOf(line, "mem_io_pc")) == 0;
            require(fieldOf(line, "guest_case") == "2", failures, "FETCH suspend missing guest_case=2: " + line);
        }
        require(hasTranslationFetch, failures, "FETCH did not show translation-time mem_io_pc=0");
        require(countGuestMarkValue(guestMarkRecords, 0xe131f37cULL) == 1,
                failures, "FETCH guest did not publish the exact fetched value exactly once");
        require(countGuestMarkValue(guestMarkRecords, 0xa4020001ULL) == 1,
                failures, "FETCH did not report exactly one flash-function effect");
        std::vector<MatchedLine> beginAtTarget;
        for (const auto& line : tcgTranslateLog) {
            if (fieldOf(line.text, "event") == "begin" && fieldHexEquals(line.text, "pc", expectedFetchPc)) {
                beginAtTarget.push_back(line);
            }
        }
        require(beginAtTarget.size() >= 2, failures, "FETCH translation did not restart at the same guest PC");
        require(release.size() == 1, failures, "FETCH did not produce exactly one release_observed");
        require(resume.size() == 1, failures, "FETCH did not produce exactly one resume_committed");
        if (beginAtTarget.size() >= 2 && !fetchSuspendLog.empty() && !releaseLog.empty() && !resumeLog.empty()) {
            require(beginAtTarget.front().offset < fetchSuspendLog.front().offset &&
                    fetchSuspendLog.front().offset < releaseLog.front().offset &&
                    releaseLog.front().offset < resumeLog.front().offset &&
                    resumeLog.front().offset < beginAtTarget.back().offset,
                    failures, "FETCH did not follow begin/suspend/release/resume/retranslate order at the same guest PC");
        }
        for (const auto& line : tcgRestore) {
            require(fieldOf(line, "attempted") == "0" && fieldOf(line, "restored") == "0",
                    failures, "FETCH path unexpectedly used cpu_restore_state(): " + line);
        }
        require(legitIllegal.empty(), failures, "FETCH compensatory path produced legitimate illegal access");
    } else if (caseName == "RUNSTALL") {
        require(caseId == 3, failures, "RUNSTALL case id mismatch");
        bool preserved = false;
        for (const auto& line : release) {
            preserved = preserved || line.find("appcpu_stall=1") != std::string::npos;
        }
        const int holdIndex = indexOfGuestMarkValue(guestMarkRecords, 0xa6030000ULL);
        require(countGuestMarkValue(guestMarkRecords, 0xe131f37cULL) == 1,
                failures, "RUNSTALL guest did not publish exact fetched value exactly once");
        if (hasGuestMarkValue(guestMarks, 0xa6030000ULL) || hasGuestMarkValue(guestMarks, 0xa4030001ULL)) {
            require(countGuestMarkValue(guestMarkRecords, 0xa6030000ULL) == 1,
                    failures, "RUNSTALL did not prove zero effects before explicit hold release");
            require(countGuestMarkValue(guestMarkRecords, 0xa4030001ULL) == 1,
                    failures, "RUNSTALL did not report exactly one flash-function effect after release");
        }
        require(preserved, failures, "RUNSTALL release did not preserve active RUNSTALL state");
        if (holdIndex >= 0) {
            require(!hasResumeBefore(resumeLog, guestMarkRecords[static_cast<size_t>(holdIndex)].offset),
                    failures, "RUNSTALL resumed before explicit hold release marker");
        }
    } else if (caseName == "CLKGATE") {
        require(caseId == 4, failures, "CLKGATE case id mismatch");
        bool preserved = false;
        for (const auto& line : release) {
            preserved = preserved || line.find("appcpu_clkgate=0") != std::string::npos;
        }
        const int holdIndex = indexOfGuestMarkValue(guestMarkRecords, 0xa6040000ULL);
        require(countGuestMarkValue(guestMarkRecords, 0xe131f37cULL) == 1,
                failures, "CLKGATE guest did not publish exact fetched value exactly once");
        if (hasGuestMarkValue(guestMarks, 0xa6040000ULL) || hasGuestMarkValue(guestMarks, 0xa4040001ULL)) {
            require(countGuestMarkValue(guestMarkRecords, 0xa6040000ULL) == 1,
                    failures, "CLKGATE did not prove zero effects before explicit hold release");
            require(countGuestMarkValue(guestMarkRecords, 0xa4040001ULL) == 1,
                    failures, "CLKGATE did not report exactly one flash-function effect after release");
        }
        require(preserved, failures, "CLKGATE release did not preserve active clockgate state");
        if (holdIndex >= 0) {
            require(!hasResumeBefore(resumeLog, guestMarkRecords[static_cast<size_t>(holdIndex)].offset),
                    failures, "CLKGATE resumed before explicit hold release marker");
        }
    } else if (caseName == "SELF_ILLEGAL") {
        require(caseId == 5, failures, "SELF_ILLEGAL case id mismatch");
        require(countGuestMarkValue(guestMarkRecords, 0xbaadbaadULL) == 1,
                failures, "SELF_ILLEGAL did not return the intentional sentinel exactly once");
        require(!legitIllegal.empty(), failures, "SELF_ILLEGAL did not produce legitimate_illegal_access");
        require(suspend.empty(), failures, "SELF_ILLEGAL unexpectedly entered compensatory suspend path");
        require(markerFollowedByEqualValues(guestMarkRecords, 0xa5000005ULL),
                failures, "SELF_ILLEGAL did not prove CACHE_IA_INT_EN restoration to its initial value");
    } else if (caseName == "RESET_WAIT") {
        require(caseId == 6, failures, "RESET_WAIT case id mismatch");
        require(resetClear.size() == 1, failures, "RESET_WAIT did not emit exactly one reset_wait_cleared");
        require(resume.empty(), failures, "RESET_WAIT unexpectedly resumed a stale cache wait");
        const size_t suspendOffset = suspendLog.empty() ? 0 : suspendLog.front().offset;
        const MatchedLine *testR4 = nullptr;
        const MatchedLine *testR6 = nullptr;
        for (const auto& line : resetR4Log) {
            if (line.offset > suspendOffset) {
                testR4 = &line;
                break;
            }
        }
        if (testR4) {
            for (const auto& line : resetR6Log) {
                if (line.offset > testR4->offset) {
                    testR6 = &line;
                    break;
                }
            }
        }
        require(testR4 && testR6, failures,
                "RESET_WAIT did not emit the APP CPU reset R4/R6 pair after cache-wait suspend");
        if (testR4 && testR6) {
            const uint64_t generationBefore = fieldU64(*testR4, "app_cpu_reset_generation");
            const uint64_t generationAfter = fieldU64(*testR6, "app_cpu_reset_generation");
            require(generationAfter == generationBefore + 1, failures,
                    "RESET_WAIT APP CPU reset generation did not increase exactly once");
            require(fieldOf(testR6->text, "stop") == "0" &&
                    fieldOf(testR6->text, "stopped") == "0" &&
                    fieldOf(testR6->text, "halted") == "0",
                    failures, "RESET_WAIT APP CPU remained stopped or halted after reset R6");
            if (!resetClearLog.empty()) {
                require(testR4->offset < resetClearLog.front().offset &&
                        resetClearLog.front().offset < testR6->offset,
                        failures, "RESET_WAIT clear was not ordered between the test reset R4 and R6");
            }

            const uint64_t entriesAtR6 = fieldU64(*testR6, "cpu_exec_entries");
            const uint64_t lateMark = UINT64_C(0xa7060000);
            const MatchedLine *lateMarkLine = nullptr;
            const auto guestMarkLog = matchingLogLines(logs, "\\[E131_GUEST_MARK\\][^\\r\\n]*");
            for (const auto& line : guestMarkLog) {
                if (hexValue(fieldOf(line.text, "value")) == lateMark && line.offset > testR6->offset) {
                    lateMarkLine = &line;
                    break;
                }
            }
            require(entriesAtR6 != 0, failures,
                    "RESET_WAIT R6 did not expose CPU1 execution-entry watermark");
            require(lateMarkLine != nullptr, failures,
                    "RESET_WAIT did not emit its late post-reset observation marker after R6");
            if (lateMarkLine) {
                require(fieldU64(*lateMarkLine, "appcpu_exec_entries") > entriesAtR6,
                        failures, "RESET_WAIT did not prove CPU1 re-entered cpu_exec after reset R6");
                require(fieldOf(lateMarkLine->text, "appcpu_stop") == "0" &&
                        fieldOf(lateMarkLine->text, "appcpu_stopped") == "0" &&
                        fieldOf(lateMarkLine->text, "appcpu_halted") == "0",
                        failures, "RESET_WAIT APP CPU was stopped or halted at the late observation");
            }
        }
        require(countGuestMarkValue(guestMarkRecords, 0xe131d00dULL) == 0,
                failures, "RESET_WAIT stale pre-reset load path produced DROM value");
        require(countGuestMarkValue(guestMarkRecords, 0xa7060000ULL) == 1,
                failures, "RESET_WAIT did not prove zero stale old-path effects");
        for (const auto& line : resetClear) {
            require(fieldOf(line, "wait_mask") == "0x0",
                    failures, "RESET_WAIT clear did not remove cache wait state: " + line);
            require(fieldOf(line, "appcpu_reset") == "0",
                    failures, "RESET_WAIT clear happened while APP CPU reset line was asserted: " + line);
            require(!fieldOf(line, "app_cpu_reset_generation").empty(),
                    failures, "RESET_WAIT clear did not include reset generation: " + line);
        }
    } else {
        require(false, failures, "unknown E131 case " + caseName);
    }

    bool stopSimulationBegin = false;
    bool stopSimulationEnd = false;
    bool firmwareStoppedAfterStop = false;
    bool schedulerStoppedAfterStop = false;
    progress.event("stopSimulation", "begin", qemuPid);
    stopSimulationBegin = true;
    try {
        session.stopSimulation();
        stopSimulationEnd = true;
        progress.event("stopSimulation", "end", qemuPid, "ok");
    } catch (const std::exception& e) {
        progress.event("stopSimulation", "end", qemuPid, std::string("exception: ") + e.what());
        failures.push_back(std::string("stopSimulation threw: ") + e.what());
    } catch (...) {
        progress.event("stopSimulation", "end", qemuPid, "unknown exception");
        failures.push_back("stopSimulation threw an unknown exception");
    }
    firmwareStoppedAfterStop = mcu ? !mcu->firmwareRunning() : true;
    schedulerStoppedAfterStop = !session.scheduler().isRunning();
    require(firmwareStoppedAfterStop, failures, "firmware still running after stopSimulation()");
    require(schedulerStoppedAfterStop, failures, "scheduler still running after stopSimulation()");

    std::string summary;
    summary += "E131_CASE=" + caseName + "\n";
    summary += "harness_pid=" + std::to_string(processIdForProgress()) + "\n";
    summary += "qemu_pid=" + std::to_string(qemuPid) + "\n";
    summary += "suspend_committed=" + std::to_string(suspend.size()) + "\n";
    summary += "release_observed=" + std::to_string(release.size()) + "\n";
    summary += "resume_committed=" + std::to_string(resume.size()) + "\n";
    summary += "legitimate_illegal_access=" + std::to_string(legitIllegal.size()) + "\n";
    summary += "reset_wait_cleared=" + std::to_string(resetClear.size()) + "\n";
    summary += "tcg_restore_events=" + std::to_string(tcgRestore.size()) + "\n";
    summary += "tcg_restore_attempted=" + std::to_string(tcgRestoreAttempted) + "\n";
    summary += "tcg_restore_succeeded=" + std::to_string(tcgRestoreSucceeded) + "\n";
    summary += "tcg_translate=" + std::to_string(tcgTranslate.size()) + "\n";
    summary += "stopSimulation_begin=" + std::to_string(stopSimulationBegin ? 1 : 0) + "\n";
    summary += "stopSimulation_end=" + std::to_string(stopSimulationEnd ? 1 : 0) + "\n";
    summary += "firmware_stopped_after_stop=" + std::to_string(firmwareStoppedAfterStop ? 1 : 0) + "\n";
    summary += "scheduler_stopped_after_stop=" + std::to_string(schedulerStoppedAfterStop ? 1 : 0) + "\n";
    summary += "failures=" + std::to_string(failures.size()) + "\n";
    for (const auto& failure : failures) summary += "failure=" + failure + "\n";

    if (outDirEnv && *outDirEnv) {
        writeTextFile(std::filesystem::u8path(outDirEnv) / "harness-summary.txt", summary);
    }

    std::fprintf(stderr, "%s", summary.c_str());
    if (!failures.empty()) {
        progress.event("failure_report", "begin", qemuPid);
        for (const auto& failure : failures) {
            std::fprintf(stderr, "E131_FAILURE %s\n", failure.c_str());
        }
        std::fprintf(stderr, "E131 artifacts preserved under %s\n", outDir.string().c_str());
        std::fprintf(stderr, "E131 UART and full QEMU log are in uart.txt and qemu.log\n");
        progress.event("failure_report", "end", qemuPid);
        std::fflush(stderr);
        progress.event("destruction", "begin", qemuPid);
        progress.event("exit", "return", qemuPid, "1");
        return 1;
    }

    std::fprintf(stderr, "E131_CACHE_WAIT_E2E PASS case=%s\n", caseName.c_str());
    std::fflush(stderr);
    progress.event("destruction", "begin", qemuPid);
    progress.event("exit", "return", qemuPid, "0");
    return 0;
}

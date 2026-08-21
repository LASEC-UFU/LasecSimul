#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "ResourceGovernor.hpp"

namespace lasecsimul::resources {

/** Administrative limits for one SharedHost deployment. Every admitted session still owns a
 * separate Core process; this class never multiplexes mutable simulator state in one Core. */
struct SharedHostPolicy {
    std::string hostId;
    std::filesystem::path workRoot;
    size_t logicalProcessors = 1;
    uint64_t hostMemoryBytes = 0;
    uint64_t reservedMemoryBytes = 0;
    uint64_t perSessionResidentBytes = 0;
    size_t maxSessions = 1;
    size_t maxConcurrentBuilds = 1;
    size_t maxExternalProcessesPerSession = 2;
};

struct SharedHostSessionLease {
    std::string sessionId;
    std::string namespaceToken;
    std::string ipcEndpoint;
    std::string arenaNamespace;
    std::string virtualPortNamespace;
    std::filesystem::path workDir;
    ResourceBudget budget;
};

struct SharedHostSessionView {
    SharedHostSessionLease lease;
    /** All active sessions have equal scheduler-independent weight. The OS remains responsible
     * for distributing the separate Core processes; no affinity is imposed. */
    size_t fairShareNumerator = 1;
    size_t fairShareDenominator = 1;
};

struct SharedHostCleanupReport {
    size_t childProcessesObserved = 0;
    size_t childProcessesTerminated = 0;
    std::vector<std::string> failures;
};

struct SharedHostCleanupFailure {
    std::string sessionId;
    std::string detail;
};

/** Thread-safe admission/capacity policy for the SharedHost launcher boundary. */
class SharedHostCapacity {
public:
    explicit SharedHostCapacity(SharedHostPolicy policy);

    const SharedHostPolicy& policy() const { return m_policy; }
    size_t capacity() const { return m_capacity; }
    size_t activeSessions() const;

    SharedHostSessionLease admit(std::string sessionId);
    void release(const std::string& sessionId, SharedHostCleanupReport cleanup = {});
    std::optional<SharedHostSessionView> session(const std::string& sessionId) const;
    std::vector<SharedHostSessionView> snapshot() const;

    bool tryAcquireBuildSlot(const std::string& sessionId);
    void releaseBuildSlot(const std::string& sessionId);
    std::vector<SharedHostCleanupFailure> cleanupFailures() const;

private:
    static void validatePolicy(const SharedHostPolicy& policy);
    static std::string namespacePrefix(const std::string& hostId);
    static std::string stableToken(const std::string& hostId, const std::string& sessionId);
    SharedHostSessionLease makeLease(const std::string& sessionId, const std::string& token) const;

    SharedHostPolicy m_policy;
    size_t m_capacity = 0;
    mutable std::mutex m_mutex;
    std::unordered_map<std::string, SharedHostSessionLease> m_sessions;
    std::unordered_set<std::string> m_tokens;
    std::unordered_set<std::string> m_buildSlots;
    std::vector<SharedHostCleanupFailure> m_cleanupFailures;
};

} // namespace lasecsimul::resources

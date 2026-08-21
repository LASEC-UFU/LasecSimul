#include "SharedHostCapacity.hpp"

#include <algorithm>
#include <cctype>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace lasecsimul::resources {
namespace {

uint64_t fnv1a64(const std::string& value) {
    uint64_t hash = 14695981039346656037ull;
    for (const unsigned char byte : value) {
        hash ^= byte;
        hash *= 1099511628211ull;
    }
    return hash;
}

} // namespace

SharedHostCapacity::SharedHostCapacity(SharedHostPolicy policy)
    : m_policy(std::move(policy)) {
    validatePolicy(m_policy);
    const uint64_t usableMemory = m_policy.hostMemoryBytes - m_policy.reservedMemoryBytes;
    const uint64_t memoryCapacity = usableMemory / m_policy.perSessionResidentBytes;
    m_capacity = std::min<size_t>(m_policy.maxSessions, static_cast<size_t>(memoryCapacity));
    if (m_capacity == 0) throw std::invalid_argument("SharedHost nao possui memoria para uma sessao");
}

void SharedHostCapacity::validatePolicy(const SharedHostPolicy& policy) {
    if (policy.hostId.empty() || policy.workRoot.empty()) {
        throw std::invalid_argument("SharedHost exige hostId e workRoot");
    }
    if (policy.logicalProcessors == 0 || policy.maxSessions == 0 || policy.maxConcurrentBuilds == 0) {
        throw std::invalid_argument("SharedHost exige capacidades positivas de CPU, sessao e build");
    }
    if (policy.hostMemoryBytes <= policy.reservedMemoryBytes || policy.perSessionResidentBytes == 0) {
        throw std::invalid_argument("SharedHost possui budget de memoria invalido");
    }
    if (policy.maxExternalProcessesPerSession == 0) {
        throw std::invalid_argument("SharedHost precisa permitir ao menos um processo externo por sessao");
    }
}

std::string SharedHostCapacity::namespacePrefix(const std::string& hostId) {
    std::string result;
    result.reserve(std::min<size_t>(hostId.size(), 24));
    for (const unsigned char ch : hostId) {
        if (result.size() == 24) break;
        if (std::isalnum(ch)) result.push_back(static_cast<char>(std::tolower(ch)));
        else if (!result.empty() && result.back() != '-') result.push_back('-');
    }
    while (!result.empty() && result.back() == '-') result.pop_back();
    return result.empty() ? "host" : result;
}

std::string SharedHostCapacity::stableToken(const std::string& hostId, const std::string& sessionId) {
    std::ostringstream stream;
    stream << std::hex << std::setfill('0') << std::setw(16)
           << fnv1a64(hostId + std::string(1, '\0') + sessionId);
    return stream.str();
}

SharedHostSessionLease SharedHostCapacity::makeLease(const std::string& sessionId,
                                                     const std::string& token) const {
    const std::string stem = "lasecsimul-" + namespacePrefix(m_policy.hostId) + "-" + token;
    ResourceBudget budget = ResourceGovernor::forProfile(
        ResourceProfile::SharedHost, m_policy.logicalProcessors).budget();
    budget.maxExternalProcesses = std::min(budget.maxExternalProcesses,
                                           m_policy.maxExternalProcessesPerSession);
    budget.maxBuildJobs = std::min<size_t>(budget.maxBuildJobs, 1);

    SharedHostSessionLease lease;
    lease.sessionId = sessionId;
    lease.namespaceToken = token;
#if defined(_WIN32)
    lease.ipcEndpoint = R"(\\.\pipe\)" + stem;
#else
    lease.ipcEndpoint = (m_policy.workRoot / (stem + ".sock")).string();
#endif
    lease.arenaNamespace = stem + "-arena";
    lease.virtualPortNamespace = stem + "-vport";
    lease.workDir = m_policy.workRoot / token;
    lease.budget = budget;
    return lease;
}

size_t SharedHostCapacity::activeSessions() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_sessions.size();
}

SharedHostSessionLease SharedHostCapacity::admit(std::string sessionId) {
    if (sessionId.empty()) throw std::invalid_argument("sessionId vazio");
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_sessions.find(sessionId) != m_sessions.end()) {
        throw std::invalid_argument("sessionId duplicado no SharedHost");
    }
    if (m_sessions.size() >= m_capacity) throw std::runtime_error("capacidade SharedHost esgotada");

    const std::string token = stableToken(m_policy.hostId, sessionId);
    if (!m_tokens.insert(token).second) throw std::runtime_error("colisao de namespace SharedHost");
    SharedHostSessionLease lease = makeLease(sessionId, token);
    m_sessions.emplace(sessionId, lease);
    return lease;
}

void SharedHostCapacity::release(const std::string& sessionId, SharedHostCleanupReport cleanup) {
    std::lock_guard<std::mutex> lock(m_mutex);
    const auto found = m_sessions.find(sessionId);
    if (found == m_sessions.end()) throw std::invalid_argument("sessao SharedHost inexistente");
    if (cleanup.childProcessesTerminated > cleanup.childProcessesObserved) {
        throw std::invalid_argument("cleanup declarou mais filhos terminados que observados");
    }
    if (cleanup.childProcessesTerminated < cleanup.childProcessesObserved && cleanup.failures.empty()) {
        cleanup.failures.push_back("nem todos os processos filhos foram encerrados");
    }
    for (const std::string& detail : cleanup.failures) {
        m_cleanupFailures.push_back({sessionId, detail});
    }
    m_buildSlots.erase(sessionId);
    m_tokens.erase(found->second.namespaceToken);
    m_sessions.erase(found);
}

std::optional<SharedHostSessionView> SharedHostCapacity::session(const std::string& sessionId) const {
    std::lock_guard<std::mutex> lock(m_mutex);
    const auto found = m_sessions.find(sessionId);
    if (found == m_sessions.end()) return std::nullopt;
    return SharedHostSessionView{found->second, 1, m_sessions.size()};
}

std::vector<SharedHostSessionView> SharedHostCapacity::snapshot() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    std::vector<SharedHostSessionView> result;
    result.reserve(m_sessions.size());
    const size_t denominator = std::max<size_t>(1, m_sessions.size());
    for (const auto& [_, lease] : m_sessions) result.push_back({lease, 1, denominator});
    std::sort(result.begin(), result.end(), [](const auto& left, const auto& right) {
        return left.lease.sessionId < right.lease.sessionId;
    });
    return result;
}

bool SharedHostCapacity::tryAcquireBuildSlot(const std::string& sessionId) {
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_sessions.find(sessionId) == m_sessions.end()) {
        throw std::invalid_argument("build solicitado por sessao inexistente");
    }
    if (m_buildSlots.find(sessionId) != m_buildSlots.end()) return true;
    if (m_buildSlots.size() >= m_policy.maxConcurrentBuilds) return false;
    m_buildSlots.insert(sessionId);
    return true;
}

void SharedHostCapacity::releaseBuildSlot(const std::string& sessionId) {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_buildSlots.erase(sessionId);
}

std::vector<SharedHostCleanupFailure> SharedHostCapacity::cleanupFailures() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_cleanupFailures;
}

} // namespace lasecsimul::resources

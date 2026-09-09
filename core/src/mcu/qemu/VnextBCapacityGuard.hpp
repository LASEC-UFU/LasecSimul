#pragma once

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <thread>

namespace lasecsimul::mcu::qemu {

// E145 (EVIDENCE.md, 2026-09-09): DECISION-010 already documents that an unconfined multi-
// session MTTCG run can freeze the host -- every emulated ESP32 vCPU thread holds a host core at
// 100% and never yields, so N sessions cost exactly 2N host threads for the whole run. Test
// runners (run_production_mwdt.ps1) have carried an admission guard for this since E133/
// DECISION-010, but the production launch path (McuController::start()) had none: nothing
// stopped a project with enough MCU components from reproducing the same freeze outside any test
// harness. This is the product-side equivalent.
//
// Deliberately computed from the REAL host topology (std::thread::hardware_concurrency()), never
// a machine-specific hardcoded constant -- this guard must stay correct on whatever host the
// product actually runs on, not just the 32-logical-processor host this episode measured.

// Pure, unit-testable: PROJECT_CONSTITUTION.md/DECISION-012 -- MTTCG thread=multi spawns one
// host thread per emulated vCPU; ESP32 is dual-core, so 2 host threads per VNEXT_B session.
inline uint32_t computeSafeVnextBSessions(uint32_t logicalProcessors, uint32_t reserveProcessors,
                                           uint32_t vcpusPerSession) {
    if (vcpusPerSession == 0) return 0;
    const uint32_t usable = logicalProcessors > reserveProcessors ? logicalProcessors - reserveProcessors : 0;
    return usable / vcpusPerSession;
}

// The same 6-logical-processor reserve DECISION-010/E133 already established empirically for
// this exact guest workload shape (run_production_mwdt.ps1's -ReserveCores default) -- reused
// here rather than re-deriving a different number for the same guest on the same class of host.
// vcpusPerSession=2 is ESP32 dual-core under MTTCG thread=multi (DECISION-012), not a per-host
// tunable.
constexpr uint32_t kVnextBReservedProcessors = 6;
constexpr uint32_t kVnextBVcpusPerSession = 2;

inline uint32_t vnextBSafeSessionsForThisHost() {
    const unsigned logical = std::thread::hardware_concurrency();
    // hardware_concurrency() is permitted by the standard to return 0 when it cannot be
    // determined -- fail closed (zero safe sessions) rather than silently assuming an unbounded
    // host in that case.
    return logical == 0 ? 0
                         : computeSafeVnextBSessions(static_cast<uint32_t>(logical),
                                                      kVnextBReservedProcessors, kVnextBVcpusPerSession);
}

// E146 (EVIDENCE.md, 2026-09-09): the topology-computed safe_sessions ceiling above is a
// THEORETICAL host-CPU-oversubscription bound, not a validated one -- E145 computed 13 on this
// host but never validated N=13 (a second host freeze happened during planning for that step,
// unrelated in cause to N=13 itself never having been attempted). Treating an unvalidated
// theoretical bound as a certified production limit was exactly the mistake this release must
// not repeat. `kVnextBCertifiedReleaseSessionLimit` is a real, versioned, source-controlled
// production constant -- not a diagnostic env var, not something a deployment can silently
// override -- and MUST only ever be raised to a value that has actually been validated (a full,
// clean B11 cell at that N, on real hardware, per the project's own gate discipline) before this
// constant changes. E146 validated N=1 and N=8; this release is certified for N<=8 only.
// Bump this only alongside new B11 evidence for the higher N, in the same commit.
constexpr uint32_t kVnextBCertifiedReleaseSessionLimit = 8;

// Pure: the actual admitted ceiling is always the SMALLER of what the host's raw CPU topology
// could theoretically carry and what this release has actually been validated for -- never
// either alone. A host with less capacity than the certified limit is still capped by its own
// topology (never oversold); a host with more capacity than certified is still capped at the
// validated limit (never oversold on trust in unmeasured headroom).
inline uint32_t computeAllowedVnextBSessions(uint32_t topologySafeSessions, uint32_t certifiedReleaseLimit) {
    return topologySafeSessions < certifiedReleaseLimit ? topologySafeSessions : certifiedReleaseLimit;
}

inline uint32_t vnextBAllowedSessionsForThisHost() {
    return computeAllowedVnextBSessions(vnextBSafeSessionsForThisHost(), kVnextBCertifiedReleaseSessionLimit);
}

// Process-wide, not per-controller: the freeze risk is the AGGREGATE host vCPU-thread count
// across every McuController in this process (a single project can hold several MCU
// components), not a property of any one instance. One counter shared by the whole process.
inline std::atomic<uint32_t>& activeVnextBSessionCount() {
    static std::atomic<uint32_t> count{0};
    return count;
}

// Explicitly experimental-only escape hatch. Never set by any test runner, gate, or production
// configuration in this codebase -- grep before ever adding it to one. Exists so a deliberately
// controlled, understood, human-supervised experiment (as this project's own historical B11
// N=16 attempts were, via run_production_mwdt.ps1's separate -Force) remains possible without
// that path being reachable by anything automated or by ordinary product usage.
inline bool vnextBCapacityOverrideRequested() {
    const char* value = std::getenv("LASECSIMUL_VNEXT_B_CAPACITY_OVERRIDE");
    return value && *value && value[0] != '0';
}

} // namespace lasecsimul::mcu::qemu

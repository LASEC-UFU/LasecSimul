#pragma once

#include <cstdint>

namespace lasecsimul::protocols {

/** Normative command-number classes from HCF_SPEC-99 "Command Summary
 * Specification" Rev 9.0, section 7.1 / Table 9 (Command Number Partitions).
 * This is the ONE authority for that partition table -- no other component
 * should re-derive these ranges from a duplicated literal. */
enum class HartCommandClass : uint8_t {
    Universal,
    ExpansionFlag,
    CommonPractice,
    NonPublic,
    DeviceSpecific,
    Reserved,
    AdditionalCommonPractice,
    WirelessHart,
    DeviceFamily,
    WirelessDeviceSpecific,
    AdditionalDeviceSpecific,
};

/** Who owns a command's semantics and where its production implementation
 * must live. Derived from `HartCommandClass`, never assigned independently
 * (see `implementationPolicyFor`). */
enum class HartCommandImplementationPolicy : uint8_t {
    /** HART-standardized (Universal / Common Practice / Additional Common
     * Practice / WirelessHART / Device Family): the canonical implementation
     * is Core C++, shared by every device, never per-manufacturer DSL. */
    StandardCore,
    /** Device-Specific / Wireless Device-Specific / Additional Device-
     * Specific: the manufacturer defines the semantics via Lasec DSL. */
    ManufacturerDsl,
    /** Non-Public (122-126): factory-only. Shares the DSL/compiler/executor
     * infrastructure with ManufacturerDsl in principle, but is never offered
     * in the normal authoring flow (no factory mode exists in this build --
     * see `HartCommandJson`'s rejection diagnostic). */
    FactoryPrivateDsl,
    /** Expansion Flag (31): protocol framing infrastructure, never a
     * user-definable command body. */
    ProtocolInfrastructure,
    /** Reserved ranges: no implementation may exist under this id, ever. */
    Forbidden,
};

/** HCF_SPEC-99 Table 9, section 7.1. Pure, total, and independent of any
 * device/profile context -- a command number's normative class never
 * depends on what a particular device does with it. */
HartCommandClass classifyHartCommandNumber(uint32_t commandId) noexcept;

/** HCF_SPEC-99 section 7.1 read together with the manufacturer-authoring
 * architecture (see .spec/features/hart-device-engine.md): maps each class
 * to who is allowed to define that command's production behavior. */
HartCommandImplementationPolicy implementationPolicyFor(HartCommandClass cls) noexcept;

inline HartCommandImplementationPolicy classifyImplementationPolicy(uint32_t commandId) noexcept {
    return implementationPolicyFor(classifyHartCommandNumber(commandId));
}

const char* hartCommandClassName(HartCommandClass cls) noexcept;
const char* hartCommandImplementationPolicyName(HartCommandImplementationPolicy policy) noexcept;

/** The primary manufacturer range (Device-Specific, HCF_SPEC-99 Table 9). */
inline constexpr uint32_t kDeviceSpecificRangeBegin = 128;
inline constexpr uint32_t kDeviceSpecificRangeEnd = 253; // inclusive
inline constexpr uint32_t kDeviceSpecificRangeSize = kDeviceSpecificRangeEnd - kDeviceSpecificRangeBegin + 1; // 126

/** HCF_SPEC-99 section 7.1 note on the Additional Device-Specific range
 * (64768-65021): only usable once Device-Specific (128-253) is more than
 * 90% consumed by the device. The 90% threshold is derived from the range
 * size (never a hardcoded magic count) -- see boundary tests for 113 vs 114
 * consumed out of 126. */
bool isDeviceSpecificRangeOver90PercentConsumed(uint32_t consumedDeviceSpecificCount) noexcept;

/** True when `commandId` may legally be given a manufacturer-authored Lasec
 * DSL body on a device with the given context.
 *
 * `isWirelessHartCapable` gates Wireless Device-Specific (64512-64765): this
 * build has no WirelessHART device-capability model, so every caller today
 * passes false and that range is always rejected (a real, honestly-reported
 * limitation, not a silent stub).
 *
 * `consumedDeviceSpecificCount` gates Additional Device-Specific
 * (64768-65021) via the >90%-of-128-253 rule above.
 *
 * Non-Public (122-126) is NEVER authorable through this predicate -- there
 * is no factory-mode context to pass it, matching "do not offer 122-126 in
 * the normal authoring flow" (HCF_SPEC-99 factory-command note). */
bool isManufacturerAuthorable(uint32_t commandId, bool isWirelessHartCapable,
                              uint32_t consumedDeviceSpecificCount) noexcept;

} // namespace lasecsimul::protocols

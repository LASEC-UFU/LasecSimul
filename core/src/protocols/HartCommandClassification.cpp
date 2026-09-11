#include "HartCommandClassification.hpp"

namespace lasecsimul::protocols {

HartCommandClass classifyHartCommandNumber(uint32_t id) noexcept {
    // HCF_SPEC-99 section 7.1, Table 9 -- exact numeric partition, no
    // real-world firmware naming convention overrides it (e.g. commands 4/5
    // sit inside 0-30 and are therefore Universal by this table, regardless
    // of any historical "common practice" label some vendors use for them).
    if (id <= 30) return HartCommandClass::Universal;
    if (id == 31) return HartCommandClass::ExpansionFlag;
    if (id == 38 || id == 48) return HartCommandClass::Universal; // explicit exceptions inside 32-121
    if (id <= 121) return HartCommandClass::CommonPractice;
    if (id <= 126) return HartCommandClass::NonPublic; // 122-126
    if (id == 127) return HartCommandClass::Reserved;
    if (id <= 253) return HartCommandClass::DeviceSpecific; // 128-253
    if (id <= 511) return HartCommandClass::Reserved; // 254-511
    if (id <= 767) return HartCommandClass::AdditionalCommonPractice; // 512-767
    if (id <= 1023) return HartCommandClass::WirelessHart; // 768-1023
    if (id <= 33791) return HartCommandClass::DeviceFamily; // 1024-33791
    if (id <= 64511) return HartCommandClass::Reserved; // 33792-64511
    if (id <= 64765) return HartCommandClass::WirelessDeviceSpecific; // 64512-64765
    if (id <= 64767) return HartCommandClass::Reserved; // 64766-64767
    if (id <= 65021) return HartCommandClass::AdditionalDeviceSpecific; // 64768-65021
    return HartCommandClass::Reserved; // 65022-65535
}

HartCommandImplementationPolicy implementationPolicyFor(HartCommandClass cls) noexcept {
    switch (cls) {
        case HartCommandClass::Universal:
        case HartCommandClass::CommonPractice:
        case HartCommandClass::AdditionalCommonPractice:
        case HartCommandClass::WirelessHart:
        case HartCommandClass::DeviceFamily:
            return HartCommandImplementationPolicy::StandardCore;
        case HartCommandClass::DeviceSpecific:
        case HartCommandClass::WirelessDeviceSpecific:
        case HartCommandClass::AdditionalDeviceSpecific:
            return HartCommandImplementationPolicy::ManufacturerDsl;
        case HartCommandClass::NonPublic:
            return HartCommandImplementationPolicy::FactoryPrivateDsl;
        case HartCommandClass::ExpansionFlag:
            return HartCommandImplementationPolicy::ProtocolInfrastructure;
        case HartCommandClass::Reserved:
            return HartCommandImplementationPolicy::Forbidden;
    }
    return HartCommandImplementationPolicy::Forbidden; // unreachable: switch above is exhaustive
}

const char* hartCommandClassName(HartCommandClass cls) noexcept {
    switch (cls) {
        case HartCommandClass::Universal: return "Universal";
        case HartCommandClass::ExpansionFlag: return "ExpansionFlag";
        case HartCommandClass::CommonPractice: return "CommonPractice";
        case HartCommandClass::NonPublic: return "NonPublic";
        case HartCommandClass::DeviceSpecific: return "DeviceSpecific";
        case HartCommandClass::Reserved: return "Reserved";
        case HartCommandClass::AdditionalCommonPractice: return "AdditionalCommonPractice";
        case HartCommandClass::WirelessHart: return "WirelessHart";
        case HartCommandClass::DeviceFamily: return "DeviceFamily";
        case HartCommandClass::WirelessDeviceSpecific: return "WirelessDeviceSpecific";
        case HartCommandClass::AdditionalDeviceSpecific: return "AdditionalDeviceSpecific";
    }
    return "";
}

const char* hartCommandImplementationPolicyName(HartCommandImplementationPolicy policy) noexcept {
    switch (policy) {
        case HartCommandImplementationPolicy::StandardCore: return "StandardCore";
        case HartCommandImplementationPolicy::ManufacturerDsl: return "ManufacturerDsl";
        case HartCommandImplementationPolicy::FactoryPrivateDsl: return "FactoryPrivateDsl";
        case HartCommandImplementationPolicy::ProtocolInfrastructure: return "ProtocolInfrastructure";
        case HartCommandImplementationPolicy::Forbidden: return "Forbidden";
    }
    return "";
}

bool isDeviceSpecificRangeOver90PercentConsumed(uint32_t consumedDeviceSpecificCount) noexcept {
    // consumed / kDeviceSpecificRangeSize > 0.9  <=>  consumed * 10 > size * 9
    // (integer form -- no floating-point threshold drift).
    return static_cast<uint64_t>(consumedDeviceSpecificCount) * 10 >
           static_cast<uint64_t>(kDeviceSpecificRangeSize) * 9;
}

bool isManufacturerAuthorable(uint32_t commandId, bool isWirelessHartCapable,
                              uint32_t consumedDeviceSpecificCount) noexcept {
    switch (classifyHartCommandNumber(commandId)) {
        case HartCommandClass::DeviceSpecific:
            return true;
        case HartCommandClass::WirelessDeviceSpecific:
            return isWirelessHartCapable;
        case HartCommandClass::AdditionalDeviceSpecific:
            return isDeviceSpecificRangeOver90PercentConsumed(consumedDeviceSpecificCount);
        default:
            return false;
    }
}

} // namespace lasecsimul::protocols

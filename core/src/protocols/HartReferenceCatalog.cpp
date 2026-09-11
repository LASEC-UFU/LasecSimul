#include "HartReferenceCatalog.hpp"

#include <array>

namespace lasecsimul::protocols {

std::vector<HartCommandDescriptor> HartReferenceCatalog::commandDescriptors() {
    // Union of process_simul's command seed table and its transmitter dispatch table.
    static constexpr std::array<std::pair<HartCommandId, std::string_view>, 60> commands{{
        {0x00, "Read Unique Identifier"},
        {0x01, "Read Primary Variable"},
        {0x02, "Read Loop Current And Percent Of Range"},
        {0x03, "Read Dynamic Variables And Loop Current"},
        {0x04, "Read Loop Current And Percent Of Range (common)"},
        {0x05, "Read Dynamic Variables (common)"},
        {0x06, "Write Polling Address"},
        {0x07, "Read Loop Configuration"},
        {0x08, "Read Dynamic Variable Classifications"},
        {0x09, "Read Device Variables With Status"},
        {0x0A, "Read Expanded Device Status"},
        {0x0B, "Read Unique Identifier Associated With Tag"},
        {0x0C, "Read Message"},
        {0x0D, "Read Tag, Descriptor, Date"},
        {0x0E, "Read Primary Variable Sensor Information"},
        {0x0F, "Read Device Output Information"},
        {0x10, "Read Final Assembly Number"},
        {0x11, "Write Message"},
        {0x12, "Write Tag, Descriptor, Date"},
        {0x13, "Write Final Assembly Number"},
        {0x15, "Write Output Information"},
        {0x21, "Read Device Variables"},
        {0x26, "Reset Configuration Changed Flag"},
        {0x28, "Enter/Exit Fixed Current Mode"},
        {0x29, "Trim DAC Zero"},
        {0x2A, "Trim DAC Gain"},
        {0x2B, "Write Transmitter Message"},
        {0x2D, "Write Polling Address (extended)"},
        {0x2E, "Write Loop Current Mode"},
        {0x48, "Read Additional Transmitter Status"},
        {0x50, "Read Dynamic Variable Assignment"},
        {0x80, "Vendor Read Configuration"},
        {0x82, "Vendor Read Device Identity"},
        {0x84, "Vendor Read Sensor Configuration"},
        {0x85, "Vendor Paged Read"},
        {0x87, "Vendor Read Device Status"},
        {0x88, "Vendor Read Device Parameters"},
        {0x8A, "Vendor Reset Error Flags"},
        {0x8C, "Vendor Read Calibration"},
        {0x8E, "Vendor Read Limits"},
        {0x98, "Vendor Keepalive"},
        {0x9C, "Vendor Read Communication Status"},
        {0xA0, "Vendor Paged Write/Read"},
        {0xA2, "Vendor Read Block"},
        {0xA4, "Vendor Read Alarm Configuration"},
        {0xA6, "Vendor Read Device Variables"},
        {0xA8, "Vendor Read Extended Block"},
        {0xAD, "Vendor Read Ordering Code"},
        {0xB0, "Vendor Read Unit String"},
        {0xB1, "Vendor Read Engineering Units"},
        {0xB2, "Vendor Read Device Descriptor"},
        {0xB3, "Vendor Read Primary Variable Units"},
        {0xB4, "Vendor Read Secondary Variable Units"},
        {0xB9, "Vendor Read Device Health"},
        {0xBA, "Vendor Read Upper Range"},
        {0xBB, "Vendor Read Device Type"},
        {0xBD, "Vendor Read Alarm Selection"},
        {0xC6, "Vendor Read Firmware Information"},
        {0xCC, "Vendor Clear Status"},
        {0xDF, "Vendor Extended Identification"},
    }};
    std::vector<HartCommandDescriptor> result;
    result.reserve(commands.size());
    for (const auto [id, name] : commands) result.push_back({id, std::string(name)});
    return result;
}

std::vector<HartReferenceDeviceDefinition> HartReferenceCatalog::deviceDefinitions() {
    static constexpr std::array<HartReferenceDeviceDefinition, 11> devices{{
        {"FV100CA", 1, 0x3E, 0x03, "029EB1", "FV100CA"},
        {"FIT100CA", 2, 0x3E, 0x01, "029EB1", "FIT100CA"},
        {"FV100AR", 3, 0x3E, 0x03, "029EB1", "FV100AR"},
        {"FIT100AR", 4, 0x3E, 0x01, "029EB1", "FIT100AR"},
        {"TIT100", 5, 0x3E, 0x02, "029EB1", "TIT100"},
        {"FIT100V", 6, 0x3E, 0x0A, "029EB1", "FIT100V"},
        {"PIT100V", 7, 0x3E, 0x0A, "029EB1", "PIT100V"},
        {"LIT100", 8, 0x3E, 0x0A, "029EB1", "LIT100"},
        {"PIT100A", 9, 0x3E, 0x0A, "029EB1", "PIT100A"},
        {"FV100A", 10, 0x3E, 0x07, "029EB1", "FV100A"},
        {"FIT100A", 11, 0x3E, 0x0A, "029EB1", "FIT100A"},
    }};
    return {devices.begin(), devices.end()};
}

HartDeviceProfile HartReferenceCatalog::makeGenericProfile() {
    HartDeviceProfile profile;
    profile.id = "lasecsimul.hart.process-simul-compatible";
    profile.version = 1;
    profile.manufacturerId = 0x3E;
    profile.deviceType = 0x03;
    profile.commands = commandDescriptors();
    return profile;
}

} // namespace lasecsimul::protocols

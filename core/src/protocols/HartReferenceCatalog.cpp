#include "HartReferenceCatalog.hpp"

#include "HartTypeCodec.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <unordered_map>

namespace lasecsimul::protocols {

namespace {

std::array<uint8_t, 3> parseDeviceIdHex(std::string_view text) noexcept {
    std::array<uint8_t, 3> result{};
    auto hexNibble = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    size_t outIndex = 0;
    size_t i = 0;
    while (outIndex < result.size() && i + 2 <= text.size()) {
        const int hi = hexNibble(text[i]);
        const int lo = hexNibble(text[i + 1]);
        if (hi < 0 || lo < 0) break;
        result[outIndex++] = static_cast<uint8_t>((hi << 4) | lo);
        i += 2;
    }
    return result;
}

uint64_t daysFromCivil(uint32_t year, uint32_t month, uint32_t day) noexcept {
    // Days since 1900-01-01; deterministic proleptic Gregorian conversion.
    if (month <= 2) --year;
    const uint32_t era = year / 400;
    const uint32_t yoe = year - era * 400;
    const uint32_t mp = month + (month > 2 ? -3u : 9u);
    const uint32_t doy = (153u * mp + 2u) / 5u + day - 1u;
    const uint32_t doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
    const int64_t absolute = static_cast<int64_t>(era) * 146097 + static_cast<int64_t>(doe);
    constexpr int64_t epoch1900 = 693901; // civil 1900-01-01 in the same origin
    return absolute >= epoch1900 ? static_cast<uint64_t>(absolute - epoch1900) : 0;
}

std::array<uint8_t, 7> dateTimeBytes(uint64_t seconds) noexcept {
    const uint64_t days = seconds / 86400u;
    uint64_t z = days + 693901u;
    const uint64_t era = z / 146097u;
    const uint64_t doe = z - era * 146097u;
    const uint64_t yoe = (doe - doe / 1460u + doe / 36524u - doe / 146096u) / 365u;
    uint64_t year = yoe + era * 400u;
    const uint64_t doy = doe - (365u * yoe + yoe / 4u - yoe / 100u);
    const uint64_t mp = (5u * doy + 2u) / 153u;
    const uint64_t day = doy - (153u * mp + 2u) / 5u + 1u;
    const uint64_t month = mp < 10u ? mp + 3u : mp - 9u;
    year += month <= 2u;
    const uint32_t daySeconds = static_cast<uint32_t>(seconds % 86400u);
    return {static_cast<uint8_t>(day), static_cast<uint8_t>(month), static_cast<uint8_t>(year - 1900u),
            static_cast<uint8_t>(daySeconds >> 24), static_cast<uint8_t>(daySeconds >> 16),
            static_cast<uint8_t>(daySeconds >> 8), static_cast<uint8_t>(daySeconds)};
}

bool decodeDateTime(std::span<const uint8_t> bytes, uint64_t& seconds) noexcept {
    if (bytes.size() != 7) return false;
    const uint32_t year = 1900u + bytes[2];
    const uint32_t month = bytes[1];
    const uint32_t day = bytes[0];
    const uint32_t time = (static_cast<uint32_t>(bytes[3]) << 24) |
        (static_cast<uint32_t>(bytes[4]) << 16) | (static_cast<uint32_t>(bytes[5]) << 8) | bytes[6];
    if (month < 1 || month > 12 || day < 1 || day > 31 || time >= 86400u) return false;
    seconds = daysFromCivil(year, month, day) * 86400u + time;
    return true;
}

} // namespace

std::vector<HartCommandDescriptor> HartReferenceCatalog::commandDescriptors() {
    // Union of process_simul's command seed table and its transmitter dispatch table.
    static constexpr std::array<std::pair<HartCommandId, std::string_view>, 183> commands{{
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
        // 0x14/0x16 (20/22, Read/Write Long Tag) were absent from the
        // original process_simul import; added per HCF_SPEC-127 6.20/6.22
        // (Universal, mandatory) now that the official spec text is
        // available -- see .spec/features/hart-device-engine.md "Anexo F".
        {0x14, "Read Long Tag"},
        // 0x15 (21) was catalogued as "Write Output Information" from the
        // original process_simul import -- a name that does NOT match
        // HCF_SPEC-127's real Command 21 ("Read Unique Identifier
        // Associated With Long Tag"). Resolved this session, not left
        // ambiguous: 21 is in the Universal range (0-30), and Universal
        // command semantics are fixed by the HART specification -- no
        // compliant manufacturer may assign a different meaning to a
        // Universal command number (this is the exact principle
        // `HartCommandClassification.hpp` already enforces at authoring
        // time for everything else). A vendor-specific "Write Output
        // Information" at id 21 would itself be a HART non-compliance, so
        // the old label can only be a stale/incorrect import, never a
        // legitimate alternate meaning -- corrected to the real name.
        {0x15, "Read Unique Identifier Associated With Long Tag"},
        {0x16, "Write Long Tag"},
        {0x21, "Read Device Variables"},
        {0x22, "Write Primary Variable Damping Value"},
        {0x23, "Write Primary Variable Range Values"},
        {0x24, "Set Primary Variable Upper Range Value"},
        {0x25, "Set Primary Variable Lower Range Value"},
        {0x2C, "Write Primary Variable Units"},
        {0x26, "Reset Configuration Changed Flag"},
        {0x27, "EEPROM Control"},
        // 0x30 (48, Read Additional Device Status) was likewise absent --
        // the existing 0x48 entry below is a DIFFERENT, distinct command
        // (decimal 72, Common Practice range), not decimal 48.
        {0x30, "Read Additional Device Status"},
        {0x31, "Write Primary Variable Transducer Serial Number"},
        {0x32, "Read Dynamic Variable Assignments"},
        {0x33, "Write Dynamic Variable Assignments"},
        {0x34, "Set Device Variable Zero"},
        {0x28, "Enter/Exit Fixed Current Mode"},
        {0x29, "Perform Self Test"},
        {0x2A, "Perform Device Reset"},
        {0x2B, "Set Primary Variable Zero"},
        {0x2D, "Trim Loop Current Zero"},
        {0x2E, "Trim Loop Current Gain"},
        {0x2F, "Write Primary Variable Transfer Function"},
        {0x35, "Write Device Variable Units"},
        {0x36, "Read Device Variable Information"},
        {0x37, "Write Device Variable Damping Value"},
        {0x38, "Write Device Variable Transducer Serial Number"},
        {0x39, "Read Unit Tag, Descriptor, Date"},
        {0x3A, "Write Unit Tag, Descriptor, Date"},
        {0x3B, "Write Number Of Response Preambles"},
        {0x3C, "Read Analog Channel And Percent Of Range"},
        {0x3D, "Read Dynamic Variables And Primary Variable Analog Channel"},
        {0x3E, "Read Analog Channels"},
        {0x3F, "Read Analog Channel Information"},
        {0x40, "Write Analog Channel Additional Damping Value"},
        {0x41, "Write Analog Channel Range Values"},
        {0x42, "Enter/Exit Fixed Analog Channel Mode"},
        {0x43, "Trim Analog Channel Zero"},
        {0x44, "Trim Analog Channel Gain"},
        {0x45, "Write Analog Channel Transfer Function"},
        {0x46, "Read Analog Channel Endpoint Values"},
        {0x47, "Lock Device"},
        {0x48, "Squawk"},
        {0x49, "Find Device"},
        {0x4A, "Read I/O System Capabilities"},
        {0x4B, "Poll Sub-Device"},
        {0x4C, "Read Lock Device State"},
        {0x4D, "Send Command to Sub-Device"},
        {0x4E, "Read Aggregated Commands"},
        {0x4F, "Write Device Variable"},
        {0x50, "Read Device Variable Trim Points"},
        {0x51, "Read Device Variable Trim Guidelines"},
        {0x52, "Write Device Variable Trim Point"},
        {0x53, "Reset Device Variable Trim"},
        {0x54, "Read Sub-Device Identity Summary"},
        {0x55, "Read I/O Channel Statistics"},
        {0x56, "Read Sub-Device Statistics"},
        {0x57, "Write I/O System Master Mode"},
        {0x58, "Write I/O System Retry Count"},
        {0x59, "Set Real-Time Clock"},
        {0x5A, "Read Real-Time Clock"},
        {0x5B, "Read Trend Configuration"},
        {0x5C, "Write Trend Configuration"},
        {0x5D, "Read Trend"},
        {0x5E, "Read I/O System Client-Side Communication Statistics"},
        {0x5F, "Read Device Communications Statistics"},
        {0x60, "Read Synchronous Action"},
        {0x61, "Configure Synchronous Action"},
        {0x62, "Read Command Action"},
        {0x63, "Configure Command Action"},
        {0x64, "Write Primary Variable Alarm Code"},
        {0x65, "Read Sub-device to Burst Message Map"},
        {0x66, "Map Sub-device to Burst Message"},
        {0x67, "Write Burst Period"},
        {0x68, "Write Burst Trigger"},
        {0x69, "Read Burst Mode Configuration"},
        {0x6A, "Flush Delayed Responses"},
        {0x6B, "Write Burst Device Variables"},
        {0x6C, "Write Burst Mode Command Number"},
        {0x6D, "Burst Mode Control"},
        {0x6E, "Read All Dynamic Variables"},
        {0x6F, "Transfer Service Control"},
        {0x70, "Transfer Service"},
        {0x71, "Catch Device Variable"},
        {0x72, "Read Caught Device Variable"},
        {0x73, "Read Event Notification Summary"},
        {0x74, "Write Event Notification Bit Mask"},
        {0x75, "Write Event Notification Timing"},
        {0x76, "Event Notification Control"},
        {0x77, "Acknowledge Event Notification"},
        {512, "Read Country Code"},
        {513, "Write Country Code"},
        {514, "Register Event Manager"},
        {515, "Read Event Manager Registration Status"},
        {516, "Read Device Location"},
        {517, "Write Device Location"},
        {518, "Read Location Description"},
        {519, "Write Location Description"},
        {520, "Read Process Unit Tag"},
        {521, "Write Process Unit Tag"},
        {522, "Write Volumetric Flow Classification"},
        {523, "Read Condensed Status Mapping Array"},
        {524, "Write Condensed Status Mapping"},
        {525, "Reset Condensed Status Map"},
        {526, "Write Status Simulation Mode"},
        {527, "Simulate Status Bit"},
        {528, "Read Sub-Device Assignment List Information"},
        {529, "Read Sub-Device Assignment"},
        {530, "Write Sub-Device Assignment"},
        {531, "Transfer Live Sub-Device List to Assignment List"},
        {1280, "Read Pressure Status"},
        {1281, "Read Pressure Capabilities"},
        {1282, "Read Supported Pressure Status Mask"},
        {1283, "Read Pressure Sensor Information"},
        {1284, "Read Pressure Process Connection"},
        {1285, "Read Associated Pressure Device Variables"},
        {1286, "Read Optional Gasket Material Data"},
        {1287, "Read Min/Max Pressure Observation"},
        {1288, "Read Min/Max Temperature Observation"},
        {1289, "Read Min/Max Static Pressure Observation"},
        {1290, "Read Remote Seal Information"},
        {1408, "Write Process Connection"},
        {1409, "Write Optional Gasket Material"},
        {1410, "Write Remote Seal Information"},
        {1024, "Read Temperature Status"},
        {1025, "Read Temperature Configuration"},
        {1026, "Read Thermocouple Configuration"},
        {1027, "Read Callendar-Van Dusen Coefficients"},
        {1152, "Write Temperature Probe Type"},
        {1153, "Write Temperature Standard"},
        {1154, "Write Temperature Probe Connection"},
        {1155, "Select Cold Junction Compensation Type"},
        {1556, "Write Manual Cold Junction Temperature"},
        {1157, "Write Temperature Callendar-Van Dusen Coefficients"},
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
    profile.identity = {0x05, 0x05, 0x62, 0x03, 0x00, 0x06};
    return profile;
}

HartDeviceProfile HartReferenceCatalog::makeProfile(const HartReferenceDeviceDefinition& definition) {
    HartDeviceProfile profile = makeGenericProfile();
    profile.id = "lasecsimul.hart.process-simul." + std::string(definition.name);
    profile.manufacturerId = definition.manufacturerId;
    profile.deviceType = definition.deviceType;
    profile.primaryVariableUnit = 57;
    profile.upperRangeValue = 100.0f;
    if (definition.name == "FIT100CA" || definition.name == "FIT100AR" || definition.name == "FIT100V" || definition.name == "FIT100A") {
        profile.primaryVariableUnit = 240; profile.upperRangeValue = 2000.0f;
    } else if (definition.name == "TIT100") {
        profile.primaryVariableUnit = 53; profile.upperRangeValue = 150.0f;
    } else if (definition.name == "PIT100V" || definition.name == "PIT100A") {
        profile.primaryVariableUnit = 192; profile.upperRangeValue = 16.0f;
    }
    return profile;
}

bool HartReferenceCatalog::registerProfiles(HartProfileRegistry& registry) {
    bool ok = registerGenericProfile(registry);
    for (const auto& definition : deviceDefinitions()) ok = registry.registerProfile(makeProfile(definition)) && ok;
    return ok;
}

bool HartReferenceCatalog::registerGenericProfile(HartProfileRegistry& registry) {
    return registry.registerProfile(makeGenericProfile());
}

std::vector<HartDevicePlan> HartReferenceCatalog::makeDevicePlans(std::string_view bus) {
    std::vector<HartDevicePlan> result;
    const auto definitions = deviceDefinitions();
    result.reserve(definitions.size());
    for (const HartReferenceDeviceDefinition& definition : definitions) {
        HartDevicePlan plan{std::string(definition.name),
                           "lasecsimul.hart.process-simul." + std::string(definition.name),
                           std::string(bus), definition.pollingAddress,
                           std::string(definition.uniqueId), 0.0};
        plan.tag = std::string(definition.tag);
        result.push_back(std::move(plan));
    }
    return result;
}

std::vector<HartCommandDefinition> HartReferenceCatalog::commandProgramDefinitions() {
    std::vector<HartCommandDefinition> commands;

    // 0x00 -- Read Unique Identifier: the plain 13-byte identity block.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x00;
        cmd.name = "Read Unique Identifier";
        cmd.resp = hartIdentityBlockMacro();
        commands.push_back(std::move(cmd));
    }

    // Common Practice 34 (0x22): write the canonical PV Device Variable
    // damping property and echo the actual value used. HartCommandExecutor validates finite,
    // non-negative seconds and the engine commits atomically.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x22; cmd.name = "Write Primary Variable Damping Value";
        cmd.write = {HartStatement{HartSetDeviceVariableStmt{HartDeviceVariableField::Damping, HartExpr::bodySlice(0, 4)}}};
        cmd.resp = {HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Damping)}}};
        commands.push_back(std::move(cmd));
    }

    // Common Practice 53 (0x35): one-byte Device Variable code followed by
    // the selected Common Tables engineering-unit code.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x35; cmd.name = "Write Device Variable Units";
        HartForCodesStmt write;
        write.source = HartExpr::bodySlice(0, 1); write.maxIterations = 1;
        write.body = {
            HartStatement{HartGuardDeviceVariableStmt{HartDeviceVariableGuard::Exists, HartExpr::body()}},
            HartStatement{HartSetDeviceVariableStmt{HartDeviceVariableField::Units, HartExpr::bodySlice(1, 1)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Code)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Units)}},
        };
        cmd.resp = {HartStatement{std::move(write)}};
        commands.push_back(std::move(cmd));
    }

    // Common Practice 54 (0x36): complete Device Variable information. The
    // field order and widths follow HCF_SPEC-151 Rev 10.0 section 7.22:
    // code(1), serial(3, Unsigned-24), units(1), upper/lower limit(4 each),
    // damping(4), minimum span(4), classification(1), family(1), acquisition
    // period(4), properties(1) = 28 bytes total. Classification/Family are
    // BOTH single-byte Enums -- confirmed against the spec's own revision
    // history ("Included Response Data Byte 21, Variable Classification").
    // A bug found during this session's audit had Classification emitting 4
    // bytes via a duplicate `Classification` field accessor that shadowed
    // the already-correct `ClassificationCode` one; fixed by removing the
    // duplicate and using the single correct accessor here.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x36; cmd.name = "Read Device Variable Information";
        HartForCodesStmt read;
        read.source = HartExpr::bodySlice(0, 1); read.maxIterations = 1;
        read.body = {
            HartStatement{HartGuardDeviceVariableStmt{HartDeviceVariableGuard::Exists, HartExpr::body()}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Code)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Serial)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Units)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::UpperLimit)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::LowerLimit)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Damping)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::MinimumSpan)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::ClassificationCode)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Family)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::AcquisitionPeriod)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Properties)}},
        };
        cmd.resp = {HartStatement{std::move(read)}};
        commands.push_back(std::move(cmd));
    }

    // Common Practice 79 (0x4F): validate selection, write mode, exact unit
    // match and ownership before mutating the canonical Device Variable.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x4F; cmd.name = "Write Device Variable";
        HartForCodesStmt write;
        write.source = HartExpr::bodySlice(0, 1); write.maxIterations = 1;
        write.body = {
            HartStatement{HartGuardDeviceVariableStmt{HartDeviceVariableGuard::Exists, HartExpr::body()}},
            HartStatement{HartGuardDeviceVariableStmt{HartDeviceVariableGuard::Writable, HartExpr::body()}},
            HartStatement{HartGuardDeviceVariableStmt{HartDeviceVariableGuard::ValidWriteCode, HartExpr::bodySlice(1, 1)}},
            HartStatement{HartGuardDeviceVariableStmt{HartDeviceVariableGuard::UnitsMatch, HartExpr::bodySlice(2, 1)}},
            HartStatement{HartSetDeviceVariableStmt{HartDeviceVariableField::WriteMode, HartExpr::bodySlice(1, 1)}},
            HartStatement{HartSetDeviceVariableStmt{HartDeviceVariableField::Value, HartExpr::bodySlice(3, 4)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Code)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::WriteMode)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Units)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Value)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Status)}},
        };
        cmd.resp = {HartStatement{std::move(write)}};
        commands.push_back(std::move(cmd));
    }

    // 0x01 -- Read Primary Variable: PV unit code (1 byte) + PV float32 BE.
    // The prior native handler omitted the unit byte (4-byte response instead
    // of the correct 5); fixed here per HART command-1 layout, not carried
    // forward silently (FASE 17).
    {
        HartCommandDefinition cmd;
        cmd.id = 0x01;
        cmd.name = "Read Primary Variable";
        cmd.resp = {
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PrimaryVariableUnit)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PrimaryVariable)}},
        };
        commands.push_back(std::move(cmd));
    }

    // 0x03 -- Read Dynamic Variables And Loop Current. CORRECTED this session
    // against HCF_SPEC-127 6.4 (verified from HART/spec127r7.1.pdf, extracted
    // from the HART.zip now at the repository root): a prior session's
    // implementation was WRONG in a way that only became visible once the
    // real spec text was available, not from code review alone.
    //
    // The spec's Table 1 requires "the number of Response Data bytes must be
    // FIXED [per device type]... a Device type may not return PV, SV, and TV
    // in one mode and later only PV and SV" -- i.e. an unsupported Dynamic
    // Variable is never padded with a placeholder, the response is
    // TRUNCATED to exactly the bytes for what that device type genuinely
    // supports (9 bytes for PV-only, 14 for PV+SV, 19 for +TV, 24 for +QV).
    // The prior implementation instead padded SV/TV/QV with the HART "not
    // used" convention (unit 0xFA + NaN) to always return the full 24 bytes
    // -- that convention is real (see Commands 9/21/48) but does NOT apply
    // to Command 3, which has no such fallback documented at all; padding
    // unsupported variables here was simply incorrect, not just incomplete.
    // This profile genuinely models only PV, so the correct, spec-compliant
    // response is the 9-byte PV-only shape -- shorter than before, but
    // actually right instead of plausible-looking.
    //
    // Loop Current (bytes 0-3) is now the real 4-20mA linear mapping of PV
    // against the profile's Upper/Lower Range Value (`HartExpr::loopCurrentMilliamps()`,
    // added this session alongside Command 2 -- see HartCommandProgram.hpp/.cpp).
    // This closes the gap the previous session's status note flagged: Command
    // 3 is now a full, real, spec-compliant PASS, not a partial one.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x03;
        cmd.name = "Read Dynamic Variables And Loop Current";
        cmd.resp = {
            HartStatement{HartAppendStmt{HartExpr::loopCurrentMilliamps()}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PrimaryVariableUnit)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PrimaryVariable)}},
        };
        commands.push_back(std::move(cmd));
    }

    // 0x02 (2) -- Read Loop Current And Percent Of Range. HCF_SPEC-127 6.3:
    // both fields are the same linear mapping Command 3 now uses.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x02;
        cmd.name = "Read Loop Current And Percent Of Range";
        cmd.resp = {
            HartStatement{HartAppendStmt{HartExpr::loopCurrentMilliamps()}},
            HartStatement{HartAppendStmt{HartExpr::percentOfRange()}},
        };
        commands.push_back(std::move(cmd));
    }

    // 0x0B -- Read Unique Identifier Associated With Tag: status (00 match /
    // 01 mismatch) + identity block, exactly the PACTware `hrt_transmitter_v6`
    // shape (IF EQ(BODY[0:6], Tag) THEN/ELSE IDENTITY_BLOCK). This is the FASE
    // 72 proof that the special handler can disappear: no native handler was
    // ever written for 0x0B in LasecSimul, so this is a first implementation
    // via the DSL, not a migration away from an existing one.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x0B;
        cmd.name = "Read Unique Identifier Associated With Tag";
        HartIfStmt tagMatch;
        tagMatch.lhs = HartExpr::bodySlice(0, 6);
        tagMatch.rhs = HartExpr::var(HartVarId::Tag);
        tagMatch.thenBranch = {HartStatement{HartAppendStmt{HartExpr::hexByte(0x00)}}};
        for (HartStatement& stmt : hartIdentityBlockMacro()) tagMatch.thenBranch.push_back(std::move(stmt));
        tagMatch.elseBranch = {HartStatement{HartAppendStmt{HartExpr::hexByte(0x01)}}};
        for (HartStatement& stmt : hartIdentityBlockMacro()) tagMatch.elseBranch.push_back(std::move(stmt));
        cmd.resp = {HartStatement{std::move(tagMatch)}};
        commands.push_back(std::move(cmd));
    }

    // 0x21 (33) -- Read Device Variables. HCF_SPEC-151 section 7.1 allows
    // one through four requested codes and returns exactly one six-byte
    // tuple per requested slot: code, units, float value. Code 0 is retained
    // as the historical PV alias for the older Universal-9 fixtures; real
    // Common Practice Table 34 PV is code 246.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x21;
        cmd.name = "Read Device Variables";
        HartForCodesStmt forCodes;
        forCodes.source = HartExpr::body(); forCodes.maxIterations = 4;
        forCodes.body = {
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Code)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Units)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Value)}},
        };
        cmd.resp = {HartStatement{std::move(forCodes)}};
        commands.push_back(std::move(cmd));
    }

    // -----------------------------------------------------------------
    // Universal Commands 12/17, 13/18, 16/19: Message, Tag/Descriptor/Date,
    // Final Assembly Number read/write pairs. Byte layout corroborated
    // against the PACTware `hrt_transmitter_v6.py` COMMANDS table (same
    // reference this project has used as ground truth since FEAT-013's
    // first session): Command 18's write body is exactly tag[0:6] +
    // descriptor[6:18] + date[18:21] (hex-char offsets there map 1:1 to
    // byte offsets here), and 17/19 are equally direct single-field writes.
    // These are NOT sourced from the current HCF_SPEC-127 Rev 7.2 text --
    // that document is access-controlled (FieldComm Group's online reader
    // returns HTTP 403 without membership, confirmed this session) -- but
    // Tag/Descriptor/Date/Message/Final-Assembly-Number have been unchanged
    // since HART 5 and are corroborated by this project's existing reference
    // implementation, so they are implemented; anything revision-sensitive
    // (9, 48, and the rest) is deliberately left unmodeled rather than
    // guessed (see .spec/features/hart-device-engine.md "Anexo F").
    //
    // No command below carries an error_code/status prefix, matching this
    // project's existing convention for 0x01/0x03 (no generic Response-Code/
    // Device-Status framing exists yet -- a known, previously documented
    // gap, not a new inconsistency introduced here).

    // 0x0C (12) -- Read Message.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x0C;
        cmd.name = "Read Message";
        cmd.resp = {HartStatement{HartAppendStmt{HartExpr::var(HartVarId::Message)}}};
        commands.push_back(std::move(cmd));
    }

    // 0x11 (17) -- Write Message. HCF_SPEC-127 6.17 (verified against the
    // official PDF, HART/spec127r7.1.pdf): the Response Data Bytes are NOT
    // empty -- "the value returned in the response data bytes reflects the
    // value actually used by the Field Device", i.e. the SAME 18-byte packed
    // message is echoed back. A prior session left `.resp` empty (reasoning
    // this project has no generic status-byte framing yet); that was wrong
    // independent of the status-byte question -- the DATA payload itself is
    // a real echo per spec, fixed here now that the spec text is available.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x11;
        cmd.name = "Write Message";
        cmd.write = {HartStatement{HartSetStmt{HartVarId::Message, HartExpr::bodySlice(0, 18)}}};
        cmd.resp = {HartStatement{HartAppendStmt{HartExpr::var(HartVarId::Message)}}};
        commands.push_back(std::move(cmd));
    }

    // 0x0D (13) -- Read Tag, Descriptor, Date.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x0D;
        cmd.name = "Read Tag, Descriptor, Date";
        cmd.resp = {
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::Tag)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::Descriptor)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::Date)}},
        };
        commands.push_back(std::move(cmd));
    }

    // 0x12 (18) -- Write Tag, Descriptor, Date: tag[0:6] + descriptor[6:18] +
    // date[18:21], applied atomically (compiler validates all three slices
    // before any SET executes -- HartCommandExecutor aborts the whole write
    // stage on the first failing statement, never a partial mutation).
    // HCF_SPEC-127 6.18 (verified): Response Data Bytes echo tag+descriptor+
    // date, same fix as 0x11 above -- `.resp` was missing entirely before.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x12;
        cmd.name = "Write Tag, Descriptor, Date";
        cmd.write = {
            HartStatement{HartSetStmt{HartVarId::Tag, HartExpr::bodySlice(0, 6)}},
            HartStatement{HartSetStmt{HartVarId::Descriptor, HartExpr::bodySlice(6, 12)}},
            HartStatement{HartSetStmt{HartVarId::Date, HartExpr::bodySlice(18, 3)}},
        };
        cmd.resp = {
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::Tag)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::Descriptor)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::Date)}},
        };
        commands.push_back(std::move(cmd));
    }

    // 0x10 (16) -- Read Final Assembly Number.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x10;
        cmd.name = "Read Final Assembly Number";
        cmd.resp = {HartStatement{HartAppendStmt{HartExpr::var(HartVarId::FinalAssemblyNumber)}}};
        commands.push_back(std::move(cmd));
    }

    // 0x13 (19) -- Write Final Assembly Number: 3-byte big-endian unsigned.
    // HCF_SPEC-127 6.19 (verified): response echoes the same 3 bytes, same
    // fix as 0x11/0x12 above.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x13;
        cmd.name = "Write Final Assembly Number";
        cmd.write = {HartStatement{HartSetStmt{HartVarId::FinalAssemblyNumber, HartExpr::bodySlice(0, 3)}}};
        cmd.resp = {HartStatement{HartAppendStmt{HartExpr::var(HartVarId::FinalAssemblyNumber)}}};
        commands.push_back(std::move(cmd));
    }

    // -----------------------------------------------------------------
    // Universal Commands 6/7 (Write Polling Address / Read Loop
    // Configuration), 20/22 (Read/Write Long Tag), 38 (Reset Configuration
    // Changed Flag), 48 (Read Additional Device Status). All verified
    // byte-for-byte against HART/spec127r7.1.pdf (HCF_SPEC-127 Rev 7.1,
    // extracted from the HART.zip now present at the repository root -- see
    // .spec/features/hart-device-engine.md "Anexo F" for the full spec
    // inventory and section references).

    // 0x06 (6) -- Write Polling Address. HCF_SPEC-127 6.7: request/response
    // are both {pollingAddress: Unsigned-8, loopCurrentMode: Enum(Common
    // Table 16)}, response echoes the value actually used by the device.
    // This is a REAL live-readdressing mutation: `HartDevicePlan::pollingAddress`
    // doubles as the bus address `HartEngine::execute()` uses to find the
    // device, so writing it here changes which address the NEXT transaction
    // must use to reach this device (this transaction still replies under
    // the address the request arrived on, matching normal HART transaction
    // semantics -- the response is built and sent before the caller ever
    // re-resolves the device by address again). Backward-compatibility
    // (HART 5 masters sending a single byte) is NOT implemented -- HART 7
    // masters always send both bytes; documented gap, not a silent one.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x06;
        cmd.name = "Write Polling Address";
        cmd.write = {
            HartStatement{HartSetStmt{HartVarId::PollingAddress, HartExpr::bodySlice(0, 1)}},
            HartStatement{HartSetStmt{HartVarId::LoopCurrentMode, HartExpr::bodySlice(1, 1)}},
        };
        cmd.resp = {
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PollingAddress)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::LoopCurrentMode)}},
        };
        commands.push_back(std::move(cmd));
    }

    // 0x07 (7) -- Read Loop Configuration. HCF_SPEC-127 6.8: same 2-byte
    // shape as 0x06's response, read-only.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x07;
        cmd.name = "Read Loop Configuration";
        cmd.resp = {
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PollingAddress)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::LoopCurrentMode)}},
        };
        commands.push_back(std::move(cmd));
    }

    // 0x14 (20) -- Read Long Tag. HCF_SPEC-127 6.20: 32-byte ISO Latin-1,
    // "completely separate data item" from the 6-byte packed-ASCII Tag
    // (Command 13/18/0x0B). No status/error prefix, same convention as
    // every other command here.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x14;
        cmd.name = "Read Long Tag";
        cmd.resp = {HartStatement{HartAppendStmt{HartExpr::var(HartVarId::LongTag)}}};
        commands.push_back(std::move(cmd));
    }

    // 0x16 (22) -- Write Long Tag. HCF_SPEC-127 6.22: request/response both
    // 32-byte Latin-1, response echoes the value actually used.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x16;
        cmd.name = "Write Long Tag";
        cmd.write = {HartStatement{HartSetStmt{HartVarId::LongTag, HartExpr::bodySlice(0, 32)}}};
        cmd.resp = {HartStatement{HartAppendStmt{HartExpr::var(HartVarId::LongTag)}}};
        commands.push_back(std::move(cmd));
    }

    // 0x26 (38) -- Reset Configuration Changed Flag. HCF_SPEC-127 6.23:
    // "This command must be implemented by all devices." Request/response
    // are both the same 2-byte Configuration Change Counter -- the spec
    // defines this as a pure echo (the device compares the counter to its
    // own and, on match, clears a Device Status bit this project does not
    // yet model -- see Anexo F for that documented gap). No SET/persisted
    // variable is needed for the echo itself, so this reuses the same
    // `Append(bodySlice(...))` primitive every read-only command uses.
    // Backward compatibility (HART 5/6 masters sending zero bytes) is NOT
    // implemented -- documented gap, not silent.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x26;
        cmd.name = "Reset Configuration Changed Flag";
        cmd.resp = {HartStatement{HartAppendStmt{HartExpr::bodySlice(0, 2)}}};
        commands.push_back(std::move(cmd));
    }

    // 0x30 (48) -- Read Additional Device Status. HCF_SPEC-127 6.24: "This
    // command must be implemented by all devices." Full response is up to
    // 25 bytes of device/analog-channel status this project has no model
    // for yet (Device Status Byte, Extended Device Status, Operating Mode,
    // Standardized Status 0-3, Analog Channel Saturated/Fixed -- see Anexo
    // F). The spec explicitly permits truncating "after the last status
    // byte supported by the Field Device" and requires AT LEAST bytes 0-8
    // (Device-Specific Status 0-5 + Extended Device Status + Operating Mode
    // + Standardized Status 0). All nine are returned as literal zero here:
    // a real, spec-compliant, minimal response (all-clear/no-condition for
    // every currently-unmodeled bit/enum), not a fake placeholder -- the
    // wire contract (this command exists, returns exactly this shape) is
    // genuinely satisfied even though no diagnostic condition can currently
    // be reported through it.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x30;
        cmd.name = "Read Additional Device Status";
        cmd.resp = {HartStatement{HartAppendStmt{HartExpr::hex(std::vector<uint8_t>(9, 0x00))}}};
        commands.push_back(std::move(cmd));
    }

    // 0x08 (8) -- Read Dynamic Variable Classifications. HCF_SPEC-127 6.9:
    // exactly 4 bytes, one Enum per Dynamic Variable. This project models no
    // classification for ANY variable (not even PV), and the spec's own text
    // covers that case explicitly: "Dynamic Variables not supporting a
    // Device Variable Classification must return 0 (Not Yet Classified)"
    // for PV, and a separate note says unsupported variables (SV/TV/QV, not
    // modeled at all here) "must return 250 (Not Used)". This is a real,
    // fully spec-compliant response, not a placeholder -- the classification
    // concept genuinely does not exist in this device model yet.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x08;
        cmd.name = "Read Dynamic Variable Classifications";
        cmd.resp = {HartStatement{HartAppendStmt{HartExpr::hex({0x00, 0xFA, 0xFA, 0xFA})}}};
        commands.push_back(std::move(cmd));
    }

    // 0x09 (9) -- Read Device Variables with Status. HCF_SPEC-127 6.10:
    // request is 1-8 raw Device Variable Code bytes (no count prefix,
    // verified against the real byte table); response is Extended Field
    // Device Status(1) + 8 bytes per requested slot (Code + Classification +
    // Units + Value(Float) + Status) + a final 4-byte Slot-0 timestamp,
    // matching Table 2's byte counts exactly (13/21/29/.../69 for 1-8 slots).
    // Per the spec's own fallback rule ("If the Field Device does not
    // support Device Variables... return PV when Device Variable zero is
    // requested"), code 0 maps to the real PV; every other code uses the
    // documented "not supported" convention (Value=NaN, Status=0x30 Bad+
    // Constant, Units=250 Not Used, Classification=0 Not Yet Classified).
    // The Slot-0 timestamp is returned as 0: this project has no monotonic
    // virtual-time clock wired into the HART command path yet (same
    // documented gap as the RC=64/Extended Device Status work in Anexo E).
    {
        HartCommandDefinition cmd;
        cmd.id = 0x09;
        cmd.name = "Read Device Variables with Status";
        HartForCodesStmt forCodes;
        forCodes.source = HartExpr::body();
        forCodes.maxIterations = 8;
        // Each slot is a view of the same canonical Device Variable table;
        // code 0 remains the protocol's PV alias and is resolved by the
        // runtime handle table.
        forCodes.body = {
            HartStatement{HartAppendStmt{HartExpr::localCode()}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::ClassificationCode)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Units)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Value)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Status)}},
        };
        cmd.resp = {
            HartStatement{HartAppendStmt{HartExpr::hexByte(0x00)}}, // Extended Field Device Status: all-clear (not modeled)
            HartStatement{std::move(forCodes)},
            HartStatement{HartAppendStmt{HartExpr::hex({0x00, 0x00, 0x00, 0x00})}}, // Slot 0 timestamp: not modeled
        };
        commands.push_back(std::move(cmd));
    }

    // 0x0E (14) -- Read Primary Variable Transducer Information. HCF_SPEC-127
    // 6.14: this project models no physical transducer at all, and the spec
    // explicitly defines the "not applicable" response for exactly that
    // case -- "Serial Number... set to 0. The other parameters... set to
    // 0x7F,0xA0,0x00,0x00 or 250, Not Used". This is a complete, real,
    // spec-compliant response derived directly from the spec's own
    // documented fallback, not a placeholder invented for this project.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x0E;
        cmd.name = "Read Primary Variable Transducer Information";
        cmd.resp = {HartStatement{HartAppendStmt{HartExpr::hex({
            0x00, 0x00, 0x00,             // Transducer Serial Number: 0 (not applicable)
            0xFA,                          // Units Code: 250 Not Used
            0x7F, 0xA0, 0x00, 0x00,        // Upper Transducer Limit: Not Used (NaN)
            0x7F, 0xA0, 0x00, 0x00,        // Lower Transducer Limit: Not Used
            0x7F, 0xA0, 0x00, 0x00,        // Minimum Span: Not Used
        })}}};
        commands.push_back(std::move(cmd));
    }

    // 0x0F (15) -- Read Device Information. HCF_SPEC-127 6.15: every field
    // this project cannot genuinely model has a documented spec fallback,
    // and every one of those is now REAL, SHARED, WRITABLE device state
    // (HartVarId::AlarmSelectionCode/PvTransferFunctionCode/
    // WriteProtectCode) -- the SAME variables Common Practice write
    // commands 34/47/100 will mutate, not independent hardcoded literals
    // that a later write command could silently fail to affect. Defaults
    // (set on HartDevicePlan/HartExecutionVariables) match the spec's own
    // documented fallback: Transfer Function "must return 0, Linear, if...
    // not supported", Write Protect Code "must return 251, None, when...
    // not implemented", Alarm Selection uses Common Table 6's "251 = None".
    // Byte 16 is explicitly "Reserved, must be set to 250" -- a true
    // protocol constant, not device state, so it stays a literal. PV
    // Units/Upper/Lower Range Value are real, profile-backed values.
    // Analog Channel Flags = 0x00: per Common Table 26, bit 0 reset means
    // "this channel is an analog OUTPUT (DAC)", factually correct for a
    // transmitter's PV loop, not a placeholder either.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x0F;
        cmd.name = "Read Device Information";
        cmd.resp = {
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::AlarmSelectionCode)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PvTransferFunctionCode)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PrimaryVariableUnit)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::UpperRangeValue)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::LowerRangeValue)}},
            HartStatement{HartAppendStmt{HartExpr::deviceVariable(HartDeviceVariableField::Damping)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::WriteProtectCode)}},
            HartStatement{HartAppendStmt{HartExpr::hexByte(0xFA)}}, // Reserved: 250 Not Used (true protocol constant)
            HartStatement{HartAppendStmt{HartExpr::hexByte(0x00)}}, // Analog Channel Flags: output channel, no flags
        };
        commands.push_back(std::move(cmd));
    }

    // 0x15 (21) -- Read Unique Identifier Associated With Long Tag.
    // HCF_SPEC-127 6.21: response "Same as Command 0" on match. Unlike 0x0B
    // (authored to PACTware's status-byte-on-mismatch convention), this
    // command's real spec text says "No response is made unless the Long
    // Tag matches" -- genuine HART protocol silence on mismatch, not a
    // status byte. `bodySlice(32, 1)` in the else branch deliberately reads
    // one byte past the 32-byte Long Tag field: for the well-formed 32-byte
    // request this command expects, that slice is always out of bounds,
    // which aborts the whole command via the executor's existing "never
    // emit partial output on failure" contract -- HartEngine::execute()
    // then returns false and no frame is sent at all. This reuses an
    // existing guarantee rather than adding a dedicated "abort" primitive.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x15;
        cmd.name = "Read Unique Identifier Associated With Long Tag";
        HartIfStmt longTagMatch;
        longTagMatch.lhs = HartExpr::bodySlice(0, 32);
        longTagMatch.rhs = HartExpr::var(HartVarId::LongTag);
        longTagMatch.thenBranch = hartIdentityBlockMacro();
        longTagMatch.elseBranch = {HartStatement{HartAppendStmt{HartExpr::bodySlice(32, 1)}}};
        cmd.resp = {HartStatement{std::move(longTagMatch)}};
        commands.push_back(std::move(cmd));
    }

    // `commandDescriptors()` documents the full HART command-number union the
    // process_simul reference devices reference (Universal, Common Practice,
    // and a Device-Specific vendor block) -- but listing a command number
    // here is a statement about WHAT THIS DEVICE FAMILY CALLS THAT NUMBER,
    // never a claim that Core implements its behavior (section 53 of the
    // architecture doc: normative class, implementation availability, and
    // per-device applicability are three separate questions). Only the ids
    // modeled above have a real production body. Every other catalogued id
    // -- Universal/Common Practice ones this profile does not model, and
    // every Device-Specific (128-253) vendor id -- deliberately gets NO
    // program here: an unauthored standard id must produce the correct HART
    // "command not implemented" behavior (`HartEngine::execute` returns
    // false, no fake response), and an unauthored Device-Specific id must
    // stay open for a real manufacturer Lasec DSL body, not be silently
    // pre-occupied by an auto-generated echo. A prior version of this
    // function DID synthesize an "echo request body" program for every
    // undescribed id; that was the exact "fake fallback" anti-pattern the
    // architecture explicitly forbids (a HART host probing e.g. Command 128
    // would get a plausible-looking echoed reply instead of an honest
    // not-implemented) and has been removed.
    return commands;
}

namespace {
HartEngine::CommandProgramHook makeHook(std::shared_ptr<std::unordered_map<HartCommandId, HartCompiledCommandProgram>> programs) {
    return [programs](const HartDeviceProfile& profile, HartDevicePlan& plan, double primaryValue,
                      HartCommandId command, std::span<const uint8_t> request, HartResponseBuilder& response,
                      uint8_t masterRole) -> bool {
        const auto it = programs->find(command);
        // 35/36/37 are handled below as one atomic StandardCore semantic
        // operation; they deliberately have no command-local DSL program.
        //
        // This boolean is ONLY a fast-path hint ("skip the early return,
        // there's a native `if` block below for this id") -- the real
        // authority on whether a command is implemented is still the actual
        // `if (command == ...)` chain below plus the `it == programs->end()`
        // check at the end of this function; both paths already produce the
        // correct "not implemented" result for any id that reaches neither.
        // Audit finding (this session): the ranges below previously
        // over-claimed coverage for ids inside their span that have no
        // actual handler (528-531, 1285, 1290, and several ids inside
        // 71-119 -- 77/78, 84-86, 93-95, 110-112, 119). That was harmless at
        // runtime (the end-of-function guard still correctly rejects them),
        // but it made this boolean lie about what "StandardCore, no DSL
        // program" actually covers -- exactly the class of self-reported-
        // but-not-real coverage this audit exists to catch. Excluded
        // explicitly below rather than narrowing every range by hand, so a
        // future real implementation of any of these only needs its `if`
        // block added, not this list edited again.
        const bool inMissingCommonPracticeGap = command == 77 || command == 78 || (command >= 84 && command <= 86) ||
            (command >= 93 && command <= 95) || command == 111 || command == 112 || command == 119;
        const bool inMissingPressureGap = false;
        const bool inMissingAssignmentListGap = command >= 528 && command <= 531;
        const bool standardCoreNoProgram = (command == 0x23 || command == 0x24 || command == 0x25 || command == 0x26 || command == 0x27 ||
            command == 0x28 || command == 0x29 || command == 0x2A || command == 0x2B || command == 0x2C ||
            command == 0x2D || command == 0x2E || command == 0x2F || command == 0x31 || command == 0x32 ||
            command == 0x33 || command == 0x34 || command == 0x37 || command == 0x38 || command == 0x39 ||
            command == 0x3A || command == 0x3B || (command >= 0x3C && command <= 0x46) ||
            (command >= 0x47 && command <= 0x77) || (command >= 512 && command <= 531) ||
            (command >= 1280 && command <= 1290) || (command >= 1408 && command <= 1410) ||
            (command >= 1024 && command <= 1027) || command == 1152 || command == 1153 || command == 1154 || command == 1155 || command == 1157 || command == 1556) &&
            !inMissingCommonPracticeGap && !inMissingPressureGap && !inMissingAssignmentListGap;
        if (it == programs->end() && !standardCoreNoProgram) return false;
        HartExecutionVariables vars;
        vars.manufacturerId = static_cast<uint8_t>(profile.manufacturerId);
        vars.deviceType = static_cast<uint8_t>(profile.deviceType);
        vars.deviceId = parseDeviceIdHex(plan.uniqueId);
        vars.numRequestPreambles = plan.responsePreambles;
        vars.universalCommandRevision = profile.identity.universalCommandRevision;
        vars.transmitterSpecificRevision = profile.identity.transmitterSpecificRevision;
        vars.softwareRevision = profile.identity.softwareRevision;
        vars.hardwareRevisionAndSignal = profile.identity.hardwareRevisionAndSignal;
        vars.flags = profile.identity.flags;
        const std::string_view tagSource = plan.tag.empty() ? std::string_view(plan.id) : std::string_view(plan.tag);
        const std::vector<uint8_t> packedTag = HartTypeCodec::encodePackedAscii(tagSource, 8);
        std::copy_n(packedTag.begin(), std::min(packedTag.size(), vars.tagPacked.size()), vars.tagPacked.begin());
        const std::vector<uint8_t> packedMessage = HartTypeCodec::encodePackedAscii(plan.message, 24);
        std::copy_n(packedMessage.begin(), std::min(packedMessage.size(), vars.messagePacked.size()), vars.messagePacked.begin());
        const std::vector<uint8_t> packedDescriptor = HartTypeCodec::encodePackedAscii(plan.descriptor, 16);
        std::copy_n(packedDescriptor.begin(), std::min(packedDescriptor.size(), vars.descriptorPacked.size()), vars.descriptorPacked.begin());
        vars.date = plan.date;
        vars.finalAssemblyNumber = plan.finalAssemblyNumber;
        const std::vector<uint8_t> encodedLongTag = HartTypeCodec::encodeLatin1(plan.longTag, 32);
        std::copy_n(encodedLongTag.begin(), std::min(encodedLongTag.size(), vars.longTag.size()), vars.longTag.begin());
        vars.pollingAddress = plan.pollingAddress;
        vars.loopCurrentMode = plan.loopCurrentMode;
        vars.primaryVariableUnit = profile.primaryVariableUnit;
        const auto primary = std::find_if(plan.variables.begin(), plan.variables.end(), [](const auto& v) {
            return v.deviceVariableCode == 246 || v.role == HartVariableRole::PrimaryVariable ||
                   v.id == "PV" || v.id == "primary";
        });
        vars.rangeUnitCode = primary != plan.variables.end() && primary->rangeUnitCode != 0xFF
            ? primary->rangeUnitCode : profile.primaryVariableUnit;
        vars.upperRangeValue = primary != plan.variables.end() && std::isfinite(primary->upperRangeValue)
            ? primary->upperRangeValue : profile.upperRangeValue;
        vars.lowerRangeValue = primary != plan.variables.end() && std::isfinite(primary->lowerRangeValue)
            ? primary->lowerRangeValue : profile.lowerRangeValue;
        vars.pvTransferFunctionCode = plan.pvTransferFunctionCode;
        vars.alarmSelectionCode = plan.alarmSelectionCode;
        vars.writeProtectCode = plan.writeProtectCode;
        vars.fixedCurrentMode = plan.fixedCurrentMode;
        vars.fixedCurrentMilliamps = plan.fixedCurrentMilliamps;
        vars.loopCurrentZeroTrim = plan.loopCurrentZeroTrim;
        vars.loopCurrentGainTrim = plan.loopCurrentGainTrim;
        vars.diagnosticStatus = plan.diagnosticStatus;
        vars.primaryVariable = static_cast<float>(primaryValue + plan.primaryVariableZeroOffset);
        std::vector<HartExecutionVariables::DeviceVariable> deviceVariables;
        std::vector<std::vector<uint8_t>> allowedUnits;
        deviceVariables.reserve(plan.variables.size() + 1);
        allowedUnits.reserve(plan.variables.size() + 1);
        for (const auto& authored : plan.variables) {
            if (authored.deviceVariableCode == 0xFF) continue;
            const bool isPrimary = authored.deviceVariableCode == 246 || authored.id == "PV" || authored.id == "primary";
            HartExecutionVariables::DeviceVariable variable;
            variable.code = authored.deviceVariableCode;
            variable.units = authored.deviceVariableUnit != 250
                ? authored.deviceVariableUnit
                : (isPrimary ? profile.primaryVariableUnit : 250);
            variable.value = static_cast<float>(isPrimary && !authored.writable
                ? vars.primaryVariable + authored.trimAdjustment
                : authored.value + authored.trimAdjustment);
            variable.status = authored.deviceVariableStatus;
            variable.upperLimit = authored.upperTransducerLimit;
            variable.lowerLimit = authored.lowerTransducerLimit;
            variable.minimumSpan = authored.minimumSpan;
            variable.damping = authored.dampingValue;
            variable.classification = authored.classification;
            variable.family = authored.family;
            variable.acquisitionPeriod = authored.acquisitionPeriod;
            variable.properties = authored.deviceVariableProperties;
            variable.serial = authored.transducerSerialNumber;
            variable.writable = authored.writable && authored.direction != HartVariableDirection::Input;
            allowedUnits.push_back(authored.allowedUnitCodes);
            if (allowedUnits.back().empty()) allowedUnits.back().push_back(variable.units);
            variable.allowedUnits = allowedUnits.back();
            deviceVariables.push_back(variable);
        }
        const bool isDeviceVariableCommonPractice = command == 0x21 || command == 0x22 ||
            command == 0x35 || command == 0x36 || command == 0x4F;
        const bool legacyPrimaryVariableAlias = command == 0x21 && !request.empty() && request.front() == 0;
        if (deviceVariables.empty() && (!isDeviceVariableCommonPractice || legacyPrimaryVariableAlias)) {
            HartExecutionVariables::DeviceVariable primary;
            primary.code = 246; primary.units = profile.primaryVariableUnit;
            primary.value = vars.primaryVariable; primary.upperLimit = profile.upperRangeValue;
            primary.lowerLimit = profile.lowerRangeValue; primary.writable = false;
            allowedUnits.push_back({primary.units}); primary.allowedUnits = allowedUnits.back();
            deviceVariables.push_back(primary);
        }
        vars.deviceVariables = deviceVariables;
        std::vector<HartExecutionVariables::UserVariable> userVariables;
        userVariables.reserve(plan.variables.size());
        for (size_t i = 0; i < plan.variables.size(); ++i) {
            const auto& variable = plan.variables[i];
            const double value = (variable.id == "PV" || variable.id == "primary")
                ? primaryValue : variable.value;
            userVariables.push_back({variable.id, value, variable.type});
        }
        vars.userVariables = userVariables;

        // Configuration Changed has one numeric authority: the plan counter.
        // The Device Status bit is only its derived/acknowledgeable flag and
        // Command 48 exposes that same diagnostic status byte.
        if (command == 0x26) {
            // HCF_SPEC-127 6.23.1: a 0-byte request means a HART Revision 6
            // (or earlier) Master with no Configuration Change Counter field
            // -- the device must still reset the bit unconditionally rather
            // than reject the request, and echoes nothing back (the legacy
            // wire format never carried this field to begin with).
            if (request.empty()) {
                plan.diagnosticStatus = static_cast<uint8_t>(plan.diagnosticStatus & ~0x40u);
                return true;
            }
            if (request.size() != 2) return false;
            const uint16_t requested = static_cast<uint16_t>(request[0] << 8 | request[1]);
            if (requested == static_cast<uint16_t>(plan.configurationChangedCounter)) plan.diagnosticStatus = static_cast<uint8_t>(plan.diagnosticStatus & ~0x40u);
            return response.writeBytes(request);
        }
        if ((command >= 1024 && command <= 1027) || command == 1152 || command == 1153 || command == 1154 || command == 1155 || command == 1157 || command == 1556) {
            const auto temperature = std::find_if(plan.variables.begin(), plan.variables.end(), [&](const auto& variable) {
                return variable.deviceVariableCode == (request.empty() ? 0xFF : request[0]) && variable.classification == 64;
            });
            if (temperature == plan.variables.end()) return false;
            auto& metadata = temperature->temperature;
            const auto validEnum = [](uint8_t value) { return value <= 249 || value == 251; };
            const auto putFloat = [&](float value) { return response.writeBytes(HartTypeCodec::encodeFloat32BE(value)); };
            if (command == 1024) {
                if (request.size() != 1) return false;
                return response.writeByte(request[0]) && response.writeByte(metadata.familyStatus) && response.writeByte(metadata.familyStatus0);
            }
            if (command == 1025) {
                if (request.size() != 1) return false;
                return response.writeByte(request[0]) && response.writeByte(metadata.probeType) && response.writeByte(metadata.numberOfWires) &&
                    response.writeByte(metadata.temperatureStandard) && response.writeByte(metadata.probeConnection);
            }
            if (command == 1026) {
                if (request.size() != 1 || !metadata.supportsThermocouple) return false;
                return response.writeByte(request[0]) && response.writeByte(metadata.probeConnection) &&
                    response.writeByte(metadata.coldJunctionCompensationType) && response.writeByte(metadata.manualColdJunctionUnit) &&
                    putFloat(metadata.manualColdJunctionTemperature);
            }
            if (command == 1027) {
                if (request.size() != 1 || !metadata.supportsCalibratedRtd) return false;
                return response.writeByte(request[0]) && putFloat(metadata.cvdA) && putFloat(metadata.cvdB) &&
                    putFloat(metadata.cvdC) && putFloat(metadata.cvdR0);
            }
            const size_t expected = command == 1152 ? 3 : (command == 1153 || command == 1154 || command == 1155 ? 2 : (command == 1556 ? 6 : 17));
            if (request.size() != expected || plan.writeProtectCode != 0xFB) return false;
            if (plan.lockCode != 0 && plan.lockOwner != masterRole) return false;
            auto next = metadata;
            if (command == 1152) {
                if (!validEnum(request[1]) || request[2] > 8) return false;
                next.probeType = request[1]; next.numberOfWires = request[2];
            } else if (command == 1153) {
                if (!metadata.supportsWriteTemperatureStandard || !validEnum(request[1])) return false;
                next.temperatureStandard = request[1];
            } else if (command == 1154) {
                if (!metadata.supportsWriteProbeConnection || !validEnum(request[1])) return false;
                next.probeConnection = request[1];
            } else if (command == 1155) {
                if (!metadata.supportsWriteColdJunction || !validEnum(request[1])) return false;
                next.coldJunctionCompensationType = request[1];
            } else if (command == 1556) {
                if (!metadata.supportsWriteColdJunction || !validEnum(request[1])) return false;
                const float value = HartTypeCodec::decodeFloat32BE(request.subspan(2, 4));
                if (!std::isfinite(value)) return false;
                next.manualColdJunctionUnit = request[1]; next.manualColdJunctionTemperature = value;
            } else {
                if (!metadata.supportsCalibratedRtd) return false;
                const float a = HartTypeCodec::decodeFloat32BE(request.subspan(1, 4));
                const float b = HartTypeCodec::decodeFloat32BE(request.subspan(5, 4));
                const float c = HartTypeCodec::decodeFloat32BE(request.subspan(9, 4));
                const float r0 = HartTypeCodec::decodeFloat32BE(request.subspan(13, 4));
                if (!std::isfinite(a) || !std::isfinite(b) || !std::isfinite(c) || !std::isfinite(r0) || r0 <= 0.0f) return false;
                next.cvdA = a; next.cvdB = b; next.cvdC = c; next.cvdR0 = r0;
            }
            metadata = next;
            ++plan.configurationChangedCounter;
            plan.diagnosticStatus = static_cast<uint8_t>(plan.diagnosticStatus | 0x40u);
            return response.writeBytes(request);
        }

        // Common Practice 71/76 share one canonical Lock Code.  The status
        // byte is derived, never stored as a second mutable lock state.
        if (command == 0x47) {
            if (request.size() != 1 || request[0] > 3) return false;
            const uint8_t requested = request[0];
            const bool owner = plan.lockCode != 0 && plan.lockOwner == masterRole;
            if (requested == 0) {
                if (plan.lockCode != 0 && plan.lockCode != 3 && !owner) return false;
            } else if (plan.lockCode != 0 && plan.lockCode != 3 && !owner) {
                return false;
            }
            plan.lockCode = requested;
            if (requested != 0) plan.lockOwner = masterRole;
            return response.writeByte(requested);
        }
        if (command == 0x4C) {
            if (!request.empty()) return false;
            uint8_t status = plan.lockCode == 0 ? 0 : 0x01;
            if (plan.lockCode == 2) status |= 0x02;
            if (plan.lockCode != 0 && (plan.lockOwner == 0 || plan.lockOwner == 2)) status |= 0x04;
            if (plan.lockCode == 3) status |= 0x08;
            if (plan.lockCode != 0 && plan.lockOwner == 2) status |= 0x10;
            return response.writeByte(status);
        }
        if (command == 0x48) {
            if (request.size() > 1) return false;
            const uint8_t control = request.empty() ? 2 : request[0];
            if (control > 2) return false;
            plan.squawkControl = control;
            if (control == 2) plan.squawkEvent = 1;
            return response.writeByte(control);
        }
        if (command == 0x49) {
            if (!request.empty()) return false;
            if (!plan.findDeviceArmed) return false;
            const auto identity = programs->find(0x00);
            if (identity == programs->end()) return false;
            return HartCommandExecutor::execute(identity->second, vars, {}, response);
        }
        if (command == 0x4A) {
            if (!plan.ioSystem || !request.empty() || plan.ioMaximumCards == 0 ||
                plan.ioMaximumChannelsPerCard == 0 || plan.ioMaximumSubDevicesPerChannel == 0 ||
                plan.ioMaximumDelayedResponses < 2 || plan.ioRetryCount < 2 || plan.ioRetryCount > 5) return false;
            const uint16_t cards = plan.ioMaximumCards;
            if (!response.writeByte(plan.ioMaximumDelayedResponses) || !response.writeByte(plan.ioMasterMode) ||
                !response.writeByte(plan.ioRetryCount) || !response.writeByte(static_cast<uint8_t>(cards >> 8)) ||
                !response.writeByte(static_cast<uint8_t>(cards)) || !response.writeByte(plan.ioMaximumChannelsPerCard) ||
                !response.writeByte(plan.ioMaximumSubDevicesPerChannel) ||
                !response.writeByte(static_cast<uint8_t>(1 + plan.subDevices.size()))) return false;
            plan.ioSubDeviceListChanged = false;
            return true;
        }
        if (command == 0x4B) {
            // Polling is resolved by HartEngine's shared device registry.  A
            // hook cannot manufacture child identity, so this branch is kept
            // as an explicit not-applicable result for non-routed execution.
            return false;
        }

        auto findTrimVariable = [&](uint8_t code) {
            return std::find_if(plan.variables.begin(), plan.variables.end(),
                [code](const auto& variable) { return variable.deviceVariableCode == code; });
        };
        if (command == 0x50 || command == 0x51) {
            if (request.size() != 1) return false;
            auto variable = findTrimVariable(request[0]);
            if (variable == plan.variables.end()) return false;
            const bool supported = variable->trimPointsSupported != 0;
            const uint8_t units = supported ? variable->trimPointsUnit : 250;
            const float nan = std::numeric_limits<float>::quiet_NaN();
            if (command == 0x50) {
                if (!response.writeByte(request[0]) || !response.writeByte(units) ||
                    !response.writeBytes(HartTypeCodec::encodeFloat32BE(
                        supported && (variable->trimPointsSupported & 0x03) != 2 ? variable->lowerTrimPoint : nan)) ||
                    !response.writeBytes(HartTypeCodec::encodeFloat32BE(
                        supported && (variable->trimPointsSupported & 0x02) != 0 ? variable->upperTrimPoint : nan))) return false;
                return true;
            }
            const auto guideline = [&](float value) {
                return response.writeBytes(HartTypeCodec::encodeFloat32BE(supported ? value : nan));
            };
            return response.writeByte(variable->trimPointsSupported) && response.writeByte(units) &&
                guideline(variable->minimumLowerTrimPoint) && guideline(variable->maximumLowerTrimPoint) &&
                guideline(variable->minimumUpperTrimPoint) && guideline(variable->maximumUpperTrimPoint) &&
                guideline(variable->minimumTrimDifferential);
        }
        if (command == 0x52) {
            if (plan.writeProtectCode != 0xFB || request.size() != 7) return false;
            auto variable = findTrimVariable(request[0]);
            if (variable == plan.variables.end() || request[1] == 0 || request[1] > 2) return false;
            if ((variable->trimPointsSupported & request[1]) == 0 || request[2] != variable->trimPointsUnit) return false;
            const float value = HartTypeCodec::decodeFloat32BE(request.subspan(3, 4));
            if (!std::isfinite(value)) return false;
            const bool lower = request[1] == 1;
            const float minimum = lower ? variable->minimumLowerTrimPoint : variable->minimumUpperTrimPoint;
            const float maximum = lower ? variable->maximumLowerTrimPoint : variable->maximumUpperTrimPoint;
            if (std::isfinite(minimum) && value < minimum) return false;
            if (std::isfinite(maximum) && value > maximum) return false;
            const float raw = (variable->id == "PV" || variable->id == "primary")
                ? static_cast<float>(primaryValue) : static_cast<float>(variable->value);
            const float nextAdjustment = value - raw;
            if (lower && (variable->trimPointsSupported & 0x02) != 0 && std::isfinite(variable->upperTrimPoint) &&
                std::isfinite(variable->minimumTrimDifferential) && variable->upperTrimPoint - value < variable->minimumTrimDifferential) return false;
            if (!lower && (variable->trimPointsSupported & 0x01) != 0 && std::isfinite(variable->lowerTrimPoint) &&
                std::isfinite(variable->minimumTrimDifferential) && value - variable->lowerTrimPoint < variable->minimumTrimDifferential) return false;
            variable->trimAdjustment = nextAdjustment;
            if (lower) variable->lowerTrimPoint = value; else variable->upperTrimPoint = value;
            return response.writeByte(request[0]) && response.writeByte(request[1]) && response.writeByte(request[2]) &&
                response.writeBytes(HartTypeCodec::encodeFloat32BE(value));
        }
        if (command == 0x53) {
            if (plan.writeProtectCode != 0xFB || request.size() != 1) return false;
            auto variable = findTrimVariable(request[0]);
            if (variable == plan.variables.end() || variable->trimPointsSupported == 0) return false;
            variable->trimAdjustment = variable->factoryTrimAdjustment;
            variable->lowerTrimPoint = std::numeric_limits<float>::quiet_NaN();
            variable->upperTrimPoint = std::numeric_limits<float>::quiet_NaN();
            return response.writeByte(request[0]);
        }
        if (command == 0x57) {
            if (!plan.ioSystem || plan.writeProtectCode != 0xFB || request.size() != 1 || request[0] > 1) return false;
            plan.ioMasterMode = request[0];
            return response.writeByte(plan.ioMasterMode);
        }
        if (command == 0x58) {
            if (!plan.ioSystem || plan.writeProtectCode != 0xFB || request.size() != 1 || request[0] < 2 || request[0] > 5) return false;
            plan.ioRetryCount = request[0];
            return response.writeByte(plan.ioRetryCount);
        }
        if (command == 0x59) {
            if (!plan.rtcSupported || request.size() != 10 || (request[8] != 0 || request[9] != 0) || request[0] > 1) return false;
            uint64_t requestedSeconds = 0;
            if (!decodeDateTime(request.subspan(1, 7), requestedSeconds)) return false;
            const uint64_t now = plan.virtualTimeSeconds;
            if (request[0] == 1) {
                plan.rtcValueSeconds = requestedSeconds;
                plan.rtcSetVirtualSeconds = now;
                plan.rtcLastSetSeconds = requestedSeconds;
                plan.rtcInitialized = true;
            }
            const auto current = dateTimeBytes(request[0] == 1 ? requestedSeconds : (plan.rtcInitialized ?
                plan.rtcValueSeconds + (now >= plan.rtcSetVirtualSeconds ? now - plan.rtcSetVirtualSeconds : 0) : 0));
            return response.writeByte(request[0]) && response.writeBytes(current);
        }
        if (command == 0x5A) {
            if (!plan.rtcSupported || !request.empty()) return false;
            const uint64_t now = plan.virtualTimeSeconds;
            const uint64_t currentSeconds = plan.rtcInitialized
                ? plan.rtcValueSeconds + (now >= plan.rtcSetVirtualSeconds ? now - plan.rtcSetVirtualSeconds : 0) : 0;
            const uint64_t lastSetSeconds = plan.rtcInitialized ? plan.rtcLastSetSeconds : 0;
            const auto current = dateTimeBytes(currentSeconds);
            const auto lastSet = dateTimeBytes(lastSetSeconds);
            uint8_t flags = plan.rtcNonVolatile ? 0x01 : 0;
            if (!plan.rtcInitialized) flags |= 0x02;
            return response.writeBytes(current) && response.writeBytes(lastSet) && response.writeByte(flags);
        }
        if (command >= 1280 && command <= 1285) {
            // HCF_SPEC-160.05 selects every Pressure Family operation by a
            // real Pressure Device Variable Code.  A generic plan therefore
            // cannot accidentally advertise this family.
            if (request.size() != 1) return false;
            const auto pressure = std::find_if(plan.variables.begin(), plan.variables.end(), [&](const auto& variable) {
                return variable.deviceVariableCode == request[0] && variable.classification == 65;
            });
            if (pressure == plan.variables.end()) return false;
            const auto& metadata = pressure->pressure;
            auto associatedCode = [&](const std::string& id) -> uint8_t {
                if (id.empty()) return 250;
                const auto associated = std::find_if(plan.variables.begin(), plan.variables.end(), [&](const auto& variable) {
                    return variable.id == id && variable.deviceVariableCode != 0xFF;
                });
                return associated == plan.variables.end() ? 250 : associated->deviceVariableCode;
            };
            if (command == 1280) {
                return response.writeByte(request[0]) && response.writeByte(pressure->deviceVariableStatus) &&
                    response.writeByte(metadata.status0);
            }
            if (command == 1281) {
                return response.writeByte(request[0]) && response.writeByte(metadata.familyDefinitionRevision) &&
                    response.writeByte(metadata.familyCapabilities0) && response.writeByte(metadata.familyCapabilities1);
            }
            if (command == 1282) {
                return response.writeByte(request[0]) && response.writeByte(metadata.supportedStatusFamilyMask) &&
                    response.writeByte(metadata.supportedStatus0Mask);
            }
            if (command == 1283) {
                return response.writeByte(request[0]) && response.writeByte(metadata.measurementType) &&
                    response.writeByte(metadata.moduleFillFluid) && response.writeByte(metadata.diaphragmMaterial) &&
                    response.writeByte(metadata.sensorHardwareRevision) && response.writeByte(metadata.sensorTechnology) &&
                    response.writeByte(metadata.pressureUnitCode) && response.writeBytes(HartTypeCodec::encodeFloat32BE(metadata.minimumAbsolutePressure)) &&
                    response.writeBytes(HartTypeCodec::encodeFloat32BE(metadata.maximumStaticPressure));
            }
            if (command == 1284) {
                return response.writeByte(request[0]) && response.writeBytes(metadata.processConnection);
            }
            return response.writeByte(request[0]) && response.writeByte(associatedCode(metadata.associatedTemperatureVariableId)) &&
                response.writeByte(associatedCode(metadata.associatedStaticPressureVariableId));
        }
        if (command >= 1286 && command <= 1290) {
            if (request.size() != 1) return false;
            const auto pressure = std::find_if(plan.variables.begin(), plan.variables.end(), [&](const auto& variable) {
                return variable.deviceVariableCode == request[0] && variable.classification == 65;
            });
            if (pressure == plan.variables.end()) return false;
            const auto& metadata = pressure->pressure;
            if (command == 1286) {
                if (!metadata.supportsOptionalGasket) return false;
                return response.writeByte(request[0]) && response.writeBytes(metadata.optionalGasket);
            }
            if (command == 1287) {
                if (!metadata.supportsPressureObservation) return false;
                return response.writeByte(request[0]) && response.writeByte(metadata.pressureObservationUnit) &&
                    response.writeBytes(HartTypeCodec::encodeFloat32BE(metadata.minimumPressureObservation)) &&
                    response.writeBytes(HartTypeCodec::encodeFloat32BE(metadata.maximumPressureObservation));
            }
            if (command == 1288) {
                if (!metadata.supportsTemperatureObservation) return false;
                return response.writeByte(request[0]) && response.writeByte(metadata.temperatureObservationUnit) &&
                    response.writeBytes(HartTypeCodec::encodeFloat32BE(metadata.minimumTemperatureObservation)) &&
                    response.writeBytes(HartTypeCodec::encodeFloat32BE(metadata.maximumTemperatureObservation));
            }
            if (command == 1289) {
                if (!metadata.supportsStaticPressureObservation) return false;
                return response.writeByte(request[0]) && response.writeByte(metadata.staticPressureObservationUnit) &&
                    response.writeBytes(HartTypeCodec::encodeFloat32BE(metadata.minimumStaticPressureObservation)) &&
                    response.writeBytes(HartTypeCodec::encodeFloat32BE(metadata.maximumStaticPressureObservation));
            }
            if (!metadata.supportsRemoteSeal) return false;
            return response.writeByte(request[0]) && response.writeBytes(metadata.remoteSeal);
        }
        if (command >= 1408 && command <= 1410) {
            const size_t expected = command == 1408 ? 11 : (command == 1409 ? 4 : 8);
            if (request.size() != expected || plan.writeProtectCode != 0xFB) return false;
            const auto validPressureEnum = [](uint8_t value) { return value <= 249 || value == 251; };
            const bool lockedByOtherMaster = plan.lockCode != 0 && plan.lockOwner != masterRole;
            if (lockedByOtherMaster) return false;
            const size_t enumOffset = 1;
            if (command == 1410 && request[1] > 2) return false;
            for (size_t i = enumOffset; i < request.size(); ++i) {
                if (!validPressureEnum(request[i])) return false;
            }
            const auto pressure = std::find_if(plan.variables.begin(), plan.variables.end(), [&](const auto& variable) {
                return variable.deviceVariableCode == request[0] && variable.classification == 65;
            });
            if (pressure == plan.variables.end()) return false;
            if ((command == 1408 && !pressure->pressure.supportsWriteProcessConnection) ||
                (command == 1409 && !pressure->pressure.supportsWriteOptionalGasket) ||
                (command == 1410 && !pressure->pressure.supportsWriteRemoteSeal)) return false;
            auto next = pressure->pressure;
            if (command == 1408) {
                std::copy_n(request.begin() + 1, 10, next.processConnection.begin());
            } else if (command == 1409) {
                std::copy_n(request.begin() + 1, 3, next.optionalGasket.begin());
            } else {
                std::copy_n(request.begin() + 1, 7, next.remoteSeal.begin());
            }
            pressure->pressure = next;
            ++plan.configurationChangedCounter;
            plan.diagnosticStatus = static_cast<uint8_t>(plan.diagnosticStatus | 0x40u);
            if (command == 1408) return response.writeByte(request[0]) && response.writeBytes(next.processConnection);
            if (command == 1409) return response.writeByte(request[0]) && response.writeByte(next.optionalGasket[0]) &&
                response.writeByte(next.optionalGasket[1]) && response.writeByte(next.optionalGasket[2]);
            return response.writeByte(request[0]) && response.writeBytes(next.remoteSeal);
        }
        if (command >= 512 && command <= 527) {
            auto put32 = [&](uint32_t value) {
                return response.writeByte(static_cast<uint8_t>(value >> 24)) && response.writeByte(static_cast<uint8_t>(value >> 16)) &&
                    response.writeByte(static_cast<uint8_t>(value >> 8)) && response.writeByte(static_cast<uint8_t>(value));
            };
            auto putFloat = [&](float value) { return response.writeBytes(HartTypeCodec::encodeFloat32BE(value)); };
            auto getU32 = [](std::span<const uint8_t> bytes) {
                return (static_cast<uint32_t>(bytes[0]) << 24) | (static_cast<uint32_t>(bytes[1]) << 16) |
                    (static_cast<uint32_t>(bytes[2]) << 8) | bytes[3];
            };
            const auto validLatinCountry = [](uint8_t value) {
                return (value >= static_cast<uint8_t>('A') && value <= static_cast<uint8_t>('Z')) ||
                    (value >= static_cast<uint8_t>('a') && value <= static_cast<uint8_t>('z'));
            };
            if (command == 512) {
                if (!request.empty()) return false;
                return response.writeByte(plan.countryCode[0]) && response.writeByte(plan.countryCode[1]) &&
                    response.writeByte(plan.siUnitsControl);
            }
            if (command == 513) {
                if (plan.writeProtectCode != 0xFB || request.size() != 3 || !validLatinCountry(request[0]) ||
                    !validLatinCountry(request[1]) || request[2] > 1) return false;
                if (request[2] == 1) {
                    for (const auto& variable : plan.variables) {
                        if (variable.deviceVariableUnit == 250) continue;
                        // The Common Tables mark the standard SI base/derived
                        // unit codes; unknown authored unit codes cannot be
                        // silently declared SI-compliant.
                        static constexpr std::array<uint8_t, 16> si{{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 39}};
                        if (std::find(si.begin(), si.end(), variable.deviceVariableUnit) == si.end()) return false;
                    }
                }
                plan.countryCode = {request[0], request[1]}; plan.siUnitsControl = request[2];
                return response.writeBytes(request);
            }
            if (command == 514) {
                if (!plan.ioSystem || request.size() != 1 || request[0] > 2) return false;
                const uint8_t control = request[0];
                if (control == 0) {
                    if (plan.eventManagerRegistered && plan.eventManagerOwner != masterRole) return false;
                    plan.eventManagerRegistered = true; plan.eventManagerOwner = masterRole;
                } else if (control == 1) {
                    if (plan.eventManagerRegistered && plan.eventManagerOwner != masterRole) return false;
                    plan.eventManagerRegistered = false;
                } else {
                    plan.eventManagerRegistered = false;
                }
                return response.writeByte(control);
            }
            if (command == 515) {
                if (!plan.ioSystem || !request.empty()) return false;
                uint8_t status = plan.eventManagerRegistered ? 0x01 : 0;
                if (plan.eventManagerRegistered && plan.eventManagerOwner == masterRole) status |= 0x02;
                return response.writeByte(status);
            }
            if (command == 516) {
                if (!plan.deviceLocationSupported || !request.empty()) return false;
                return putFloat(plan.deviceLocation.latitude) && putFloat(plan.deviceLocation.longitude) &&
                    response.writeByte(plan.deviceLocation.method) && putFloat(plan.deviceLocation.altitude);
            }
            if (command == 517) {
                if (!plan.deviceLocationSupported || plan.writeProtectCode != 0xFB || request.size() != 13) return false;
                const float latitude = HartTypeCodec::decodeFloat32BE(request.subspan(0, 4));
                const float longitude = HartTypeCodec::decodeFloat32BE(request.subspan(4, 4));
                const float altitude = HartTypeCodec::decodeFloat32BE(request.subspan(9, 4));
                if (!std::isfinite(latitude) || !std::isfinite(longitude) || !std::isfinite(altitude) ||
                    std::fabs(latitude) > 90.0f || std::fabs(longitude) > 180.0f || request[8] > 8) return false;
                plan.deviceLocation = {latitude, longitude, request[8], altitude};
                return response.writeBytes(request);
            }
            if (command == 518) {
                if (!plan.locationDescriptionSupported || !request.empty()) return false;
                return response.writeBytes(plan.locationDescription);
            }
            if (command == 519) {
                if (!plan.locationDescriptionSupported || plan.writeProtectCode != 0xFB || request.size() != 32) return false;
                std::copy(request.begin(), request.end(), plan.locationDescription.begin());
                return response.writeBytes(plan.locationDescription);
            }
            if (command == 520) {
                if (!plan.processUnitTagSupported || !request.empty()) return false;
                return response.writeBytes(plan.processUnitTag);
            }
            if (command == 521) {
                if (!plan.processUnitTagSupported || plan.writeProtectCode != 0xFB || request.size() != 32) return false;
                std::copy(request.begin(), request.end(), plan.processUnitTag.begin());
                return response.writeBytes(plan.processUnitTag);
            }
            if (command == 522) {
                if (plan.writeProtectCode != 0xFB || request.size() != 2 || request[1] < 100 || request[1] > 107) return false;
                auto variable = std::find_if(plan.variables.begin(), plan.variables.end(), [&](const auto& item) {
                    return item.deviceVariableCode == request[0] && item.classification == 66;
                });
                if (variable == plan.variables.end()) return false;
                variable->classification = request[1];
                return response.writeBytes(request);
            }
            if (command == 523 || command == 524 || command == 525) {
                if (!plan.condensedStatusSupported) return false;
                const auto validMap = [](uint8_t code) { return code == 0 || code == 1 || code == 3 || code == 4 || code == 5 || code == 6; };
                auto packMaps = [&](uint8_t start, uint8_t count, std::array<uint8_t, 208> const& maps) {
                    if (!response.writeByte(start) || !response.writeByte(count)) return false;
                    for (uint8_t i = 0; i < count; i += 2) {
                        const uint8_t low = maps[start + i];
                        const uint8_t high = (i + 1 < count) ? maps[start + i + 1] : 0;
                        if (!response.writeByte(static_cast<uint8_t>(low | (high << 4)))) return false;
                    }
                    return true;
                };
                const auto normativeDefaultMap = [] {
                    std::array<uint8_t, 208> defaults{};
                    // Common Table 30, Standardized Status 1: Status
                    // Simulation Active is Function Check.  Tables 31/32
                    // provide the standardized I/O/Wireless defaults below;
                    // all unspecified bits are explicitly No Effect.
                    defaults[81] = 5;
                    defaults[97] = 1; defaults[98] = 1; defaults[100] = 4;
                    defaults[101] = 3; defaults[102] = 3;
                    defaults[104] = 1; defaults[108] = 3;
                    return defaults;
                };
                if (command == 525) {
                    if (plan.writeProtectCode != 0xFB || !request.empty()) return false;
                    plan.condensedStatusMapping = normativeDefaultMap();
                    return true;
                }
                if (request.size() < 2 || request[0] >= plan.condensedStatusMapping.size()) return false;
                const uint8_t requestedStart = request[0];
                uint8_t start = static_cast<uint8_t>(requestedStart & 0xFE);
                uint8_t count = request[1];
                if (count < 2) return false;
                count = static_cast<uint8_t>(std::min<size_t>(count, plan.condensedStatusMapping.size() - start));
                count = static_cast<uint8_t>(count & 0xFE);
                if (count < 2) return false;
                if (command == 523) return packMaps(start, count, plan.condensedStatusMapping);
                if (plan.writeProtectCode != 0xFB || request.size() != 2 + (request[1] + 1) / 2 || request[1] < 2 || (request[1] & 1) != 0) return false;
                if (start + request[1] > plan.condensedStatusMapping.size()) return false;
                std::array<uint8_t, 208> staged = plan.condensedStatusMapping;
                for (uint8_t i = 0; i < request[1]; ++i) {
                    const uint8_t code = static_cast<uint8_t>((request[2 + i / 2] >> ((i & 1) ? 4 : 0)) & 0x0F);
                    if (!validMap(code)) return false;
                    staged[start + i] = code;
                }
                plan.condensedStatusMapping = staged;
                return packMaps(start, request[1], plan.condensedStatusMapping);
            }
            if (command == 526) {
                if (!plan.condensedStatusSupported || plan.writeProtectCode != 0xFB || request.size() != 1 || request[0] > 1) return false;
                if (request[0] == 0) {
                    plan.statusSimulationEnabled = false;
                    plan.simulatedStatusMask.fill(0);
                } else {
                    plan.statusSimulationEnabled = true;
                }
                return response.writeByte(plan.statusSimulationEnabled ? 1 : 0);
            }
            if (command == 527) {
                if (!plan.condensedStatusSupported || !plan.statusSimulationEnabled || request.size() != 2 || request[0] >= plan.simulatedStatusMask.size() || request[1] > 1) return false;
                if (request[0] >= 56 && request[0] <= 59) return false;
                plan.simulatedStatusMask[request[0]] = 1;
                plan.simulatedStatusValues[request[0]] = request[1];
                return response.writeBytes(request);
            }
        }
        if (command >= 0x64 && command <= 0x6E) {
            auto validBurstIndex = [&](uint8_t index) { return index < plan.burstMessageCount && index < plan.burstMessages.size(); };
            auto burst = [&](uint8_t index) -> HartBurstConfiguration& { return plan.burstMessages[index]; };
            auto burstSubDeviceIndex = [&](const HartBurstConfiguration& configuration) -> uint16_t {
                if (configuration.mappedSubDeviceId.empty()) return 0;
                for (size_t i = 0; i < plan.subDevices.size(); ++i)
                    if (plan.subDevices[i].childDeviceId == configuration.mappedSubDeviceId) return static_cast<uint16_t>(i + 1);
                return 0xFFFF;
            };
            auto validBurstCommand = [](HartCommandId id) {
                return id == 1 || id == 2 || id == 3 || id == 9 || id == 33 || id == 48 || id < 256;
            };
            auto put32 = [&](uint32_t value) {
                return response.writeByte(static_cast<uint8_t>(value >> 24)) && response.writeByte(static_cast<uint8_t>(value >> 16)) &&
                    response.writeByte(static_cast<uint8_t>(value >> 8)) && response.writeByte(static_cast<uint8_t>(value));
            };
            auto put16 = [&](uint16_t value) { return response.writeByte(static_cast<uint8_t>(value >> 8)) && response.writeByte(static_cast<uint8_t>(value)); };
            if (command == 0x64) {
                if (plan.writeProtectCode != 0xFB || request.size() != 1 || request[0] > 3) return false;
                plan.alarmSelectionCode = request[0];
                return response.writeByte(plan.alarmSelectionCode);
            }
            if (command == 0x65) {
                if (request.size() != 1 || !validBurstIndex(request[0])) return false;
                const auto& configuration = burst(request[0]);
                return response.writeByte(request[0]) && put16(burstSubDeviceIndex(configuration));
            }
            if (command == 0x66) {
                if (plan.writeProtectCode != 0xFB || request.size() != 3 || !validBurstIndex(request[0])) return false;
                const uint16_t subIndex = static_cast<uint16_t>(request[1] << 8 | request[2]);
                if (subIndex > plan.subDevices.size()) return false;
                if (subIndex == 0) burst(request[0]).mappedSubDeviceId.clear();
                else burst(request[0]).mappedSubDeviceId = plan.subDevices[subIndex - 1].childDeviceId;
                return response.writeBytes(request);
            }
            if (command == 0x67) {
                if (plan.writeProtectCode != 0xFB || request.size() != 9 || !validBurstIndex(request[0])) return false;
                const uint32_t update = (static_cast<uint32_t>(request[1]) << 24) | (static_cast<uint32_t>(request[2]) << 16) |
                    (static_cast<uint32_t>(request[3]) << 8) | request[4];
                const uint32_t maximum = (static_cast<uint32_t>(request[5]) << 24) | (static_cast<uint32_t>(request[6]) << 16) |
                    (static_cast<uint32_t>(request[7]) << 8) | request[8];
                const auto allowedPeriod = [](uint32_t ticks) {
                    constexpr std::array<uint32_t, 9> standard{{3200, 8000, 16000, 32000, 64000, 128000, 256000, 512000, 1024000}};
                    return std::find(standard.begin(), standard.end(), ticks) != standard.end() ||
                        (ticks >= 60u * 32000u && ticks <= 3600u * 32000u);
                };
                if (!allowedPeriod(update) || !allowedPeriod(maximum) || update > maximum) return false;
                auto& configuration = burst(request[0]);
                configuration.updatePeriodTicks = update; configuration.maximumUpdatePeriodTicks = maximum;
                return response.writeBytes(request);
            }
            if (command == 0x68) {
                if (plan.writeProtectCode != 0xFB || request.size() != 8 || !validBurstIndex(request[0])) return false;
                const uint8_t mode = request[1];
                const uint8_t classification = request[2];
                const uint8_t units = request[3];
                const float value = HartTypeCodec::decodeFloat32BE(request.subspan(4, 4));
                if (mode > 3) return false;
                if (mode == 0) {
                    if (classification != 0 || units != 250 || !std::isnan(value)) return false;
                } else if (!std::isfinite(value) || value <= 0.0f || units == 250) return false;
                auto& configuration = burst(request[0]);
                configuration.triggerMode = mode; configuration.triggerClassification = classification;
                configuration.triggerUnits = units; configuration.triggerValue = value;
                return response.writeBytes(request);
            }
            if (command == 0x69) {
                if (!((request.empty() || request.size() == 1) && (request.empty() || validBurstIndex(request[0])))) return false;
                const uint8_t index = request.empty() ? 0 : request[0];
                const auto& configuration = burst(index);
                if (!response.writeByte(configuration.control) || !response.writeByte(31)) return false;
                for (const uint8_t code : configuration.deviceVariableCodes) if (!response.writeByte(code)) return false;
                if (!response.writeByte(index) || !response.writeByte(plan.burstMessageCount) || !put16(configuration.command) ||
                    !put32(configuration.updatePeriodTicks) || !put32(configuration.maximumUpdatePeriodTicks) ||
                    !response.writeByte(configuration.triggerMode) || !response.writeByte(configuration.triggerClassification) ||
                    !response.writeByte(configuration.triggerUnits) || !response.writeBytes(HartTypeCodec::encodeFloat32BE(configuration.triggerValue))) return false;
                return true;
            }
            if (command == 0x6A) {
                if (!request.empty()) return false;
                return true; // The bounded burst event queue is the delayed-response authority.
            }
            if (command == 0x6B) {
                if (plan.writeProtectCode != 0xFB || request.size() != 9 || !validBurstIndex(request[8])) return false;
                std::array<uint8_t, 8> next{};
                for (size_t i = 0; i < next.size(); ++i) {
                    if (request[i] != 250 && std::find_if(plan.variables.begin(), plan.variables.end(), [&](const auto& variable) {
                        return variable.deviceVariableCode == request[i];
                    }) == plan.variables.end()) return false;
                    next[i] = request[i];
                }
                burst(request[8]).deviceVariableCodes = next;
                return response.writeBytes(request);
            }
            if (command == 0x6C) {
                const bool legacy = request.size() == 1;
                if (plan.writeProtectCode != 0xFB || (request.size() != 1 && request.size() != 3)) return false;
                const HartCommandId target = legacy ? request[0] : static_cast<HartCommandId>(request[0] << 8 | request[1]);
                const uint8_t index = legacy ? 0 : request[2];
                if (!validBurstIndex(index) || !validBurstCommand(target)) return false;
                burst(index).command = target;
                if (legacy) return response.writeByte(static_cast<uint8_t>(target));
                return response.writeBytes(request);
            }
            if (command == 0x6D) {
                const bool legacy = request.size() == 1;
                if ((request.size() != 1 && request.size() != 2) || (legacy && request[0] > 1)) return false;
                const uint8_t index = legacy ? 0 : request[0];
                const uint8_t control = legacy ? request[0] : request[1];
                if (plan.writeProtectCode != 0xFB || !validBurstIndex(index) || control > 3) return false;
                burst(index).control = control;
                if (legacy) return response.writeByte(control);
                return response.writeBytes(request);
            }
            if (!request.empty()) return false;
            for (size_t i = 0; i < 4; ++i) {
                const uint8_t code = plan.dynamicVariableAssignments[i];
                if (code == 250) break;
                const auto variable = std::find_if(vars.deviceVariables.begin(), vars.deviceVariables.end(), [code](const auto& candidate) { return candidate.code == code; });
                if (variable == vars.deviceVariables.end() || !response.writeByte(variable->units) ||
                    !response.writeBytes(HartTypeCodec::encodeFloat32BE(variable->value))) return false;
            }
            return true;
        }
        if (command >= 0x71 && command <= 0x77) {
            auto findVariable = [&](uint8_t code) {
                return std::find_if(plan.variables.begin(), plan.variables.end(), [code](const auto& variable) {
                    return variable.deviceVariableCode == code;
                });
            };
            auto findCatch = [&](uint8_t code) {
                return std::find_if(plan.catchConfigurations.begin(), plan.catchConfigurations.end(), [code](const auto& configuration) {
                    return configuration.destinationDeviceVariable == code;
                });
            };
            auto put16 = [&](uint16_t value) { return response.writeByte(static_cast<uint8_t>(value >> 8)) && response.writeByte(static_cast<uint8_t>(value)); };
            auto put32 = [&](uint32_t value) {
                return response.writeByte(static_cast<uint8_t>(value >> 24)) && response.writeByte(static_cast<uint8_t>(value >> 16)) &&
                    response.writeByte(static_cast<uint8_t>(value >> 8)) && response.writeByte(static_cast<uint8_t>(value));
            };
            auto allowedTime = [](uint32_t value) {
                constexpr std::array<uint32_t, 9> standard{{3200, 8000, 16000, 32000, 64000, 128000, 256000, 512000, 1024000}};
                return std::find(standard.begin(), standard.end(), value) != standard.end() ||
                    (value >= 60u * 32000u && value <= 3600u * 32000u);
            };
            if (command == 0x71 || command == 0x72) {
                if (command == 0x71) {
                    if (plan.writeProtectCode != 0xFB || request.size() != 15 || request[1] > 2) return false;
                    if (findVariable(request[0]) == plan.variables.end() || request[7] > 7 || request[1] == 1 && request[13] == 0 && request[14] == 0) return false;
                    auto slot = findCatch(request[0]);
                    if (slot == plan.catchConfigurations.end()) slot = std::find_if(plan.catchConfigurations.begin(), plan.catchConfigurations.end(), [](const auto& item) { return item.destinationDeviceVariable == 250; });
                    if (slot == plan.catchConfigurations.end()) return false;
                    const float shed = HartTypeCodec::decodeFloat32BE(request.subspan(8, 4));
                    if (!std::isfinite(shed) || shed < 0.0f) return false;
                    slot->destinationDeviceVariable = request[0]; slot->captureMode = request[1];
                    std::copy_n(request.begin() + 2, 5, slot->sourceAddress.begin()); slot->sourceSlot = request[7];
                    slot->shedTime = shed; slot->sourceCommand = static_cast<HartCommandId>(request[13] << 8 | request[14]);
                }
                const uint8_t destination = request[0];
                const auto slot = findCatch(destination);
                HartCatchConfiguration defaults;
                defaults.destinationDeviceVariable = destination;
                const auto& configuration = slot == plan.catchConfigurations.end() ? defaults : *slot;
                if (!response.writeByte(destination) || !response.writeByte(configuration.captureMode) || !response.writeBytes(configuration.sourceAddress) ||
                    !response.writeByte(configuration.sourceSlot) || !response.writeByte(static_cast<uint8_t>(configuration.sourceCommand)) ||
                    !response.writeBytes(HartTypeCodec::encodeFloat32BE(configuration.shedTime)) || !put16(configuration.sourceCommand)) return false;
                return true;
            }
            auto& event = plan.eventNotifications[0];
            if (command == 0x73) {
                if (request.size() != 1 || request[0] != 0) return false;
                const uint8_t status = event.control == 0 ? 0 : 0;
                return response.writeByte(0) && response.writeByte(1) && response.writeByte(static_cast<uint8_t>((status << 4) | (event.control & 0x0F))) &&
                    put32(0xFFFFFFFFu) && put32(event.retryTimeTicks) && put32(event.maximumUpdateTimeTicks) && put32(event.debounceTimeTicks) &&
                    response.writeByte(event.deviceStatusMask) && response.writeBytes(event.eventMask);
            }
            if (command == 0x74) {
                if (plan.writeProtectCode != 0xFB || request.size() < 2 || request.size() > 27 || request[0] != 0) return false;
                event.deviceStatusMask = request[1]; event.eventMask.fill(0);
                std::copy(request.begin() + 2, request.end(), event.eventMask.begin());
                return response.writeBytes(request);
            }
            if (command == 0x75) {
                if (plan.writeProtectCode != 0xFB || request.size() != 13 || request[0] != 0) return false;
                const uint32_t retry = (static_cast<uint32_t>(request[1]) << 24) | (static_cast<uint32_t>(request[2]) << 16) | (static_cast<uint32_t>(request[3]) << 8) | request[4];
                const uint32_t maximum = (static_cast<uint32_t>(request[5]) << 24) | (static_cast<uint32_t>(request[6]) << 16) | (static_cast<uint32_t>(request[7]) << 8) | request[8];
                const uint32_t debounce = (static_cast<uint32_t>(request[9]) << 24) | (static_cast<uint32_t>(request[10]) << 16) | (static_cast<uint32_t>(request[11]) << 8) | request[12];
                if (!allowedTime(retry) || !allowedTime(maximum) || !allowedTime(debounce) || retry > maximum) return false;
                event.retryTimeTicks = retry; event.maximumUpdateTimeTicks = maximum; event.debounceTimeTicks = debounce;
                return response.writeBytes(request);
            }
            if (command == 0x76) {
                if (plan.writeProtectCode != 0xFB || request.size() != 2 || request[0] != 0 || request[1] > 3) return false;
                event.control = request[1];
                return response.writeBytes(request);
            }
            if (request.size() != 1 && request.size() != 33 || request[0] != 0) return false;
            HartEventNotificationRecord record;
            if (request.size() == 33) {
                record.timestamp = (static_cast<uint32_t>(request[1]) << 24) | (static_cast<uint32_t>(request[2]) << 16) | (static_cast<uint32_t>(request[3]) << 8) | request[4];
                record.configurationChangedCounter = static_cast<uint32_t>(request[5] << 8 | request[6]);
                record.deviceStatus = request[7]; std::copy(request.begin() + 8, request.end(), record.command48Data.begin());
            } else if (!response.writeByte(0)) return false;
            // The runtime record is attached by HartEngine before dispatch; a
            // no-payload request returns the oldest latched snapshot.
            return put32(request.size() == 33 ? static_cast<uint32_t>(record.timestamp) : 0xFFFFFFFFu) && put16(static_cast<uint16_t>(request.size() == 33 ? record.configurationChangedCounter : 0)) &&
                response.writeByte(static_cast<uint8_t>(request.size() == 33 ? record.deviceStatus : 0)) && response.writeBytes(request.size() == 33 ? record.command48Data : std::array<uint8_t, 25>{});
        }
        if (command == 0x5B || command == 0x5C) {
            if (request.size() != (command == 0x5B ? 1u : 7u) || plan.trendCount == 0) return false;
            const uint8_t index = request[0];
            if (index >= plan.trendCount || index >= plan.trends.size()) return false;
            if (command == 0x5B) {
                const auto& trend = plan.trends[index];
                return response.writeByte(index) && response.writeByte(plan.trendCount) && response.writeByte(trend.control) &&
                    response.writeByte(trend.deviceVariableCode) && response.writeByte(static_cast<uint8_t>(trend.samplePeriodSeconds >> 24)) &&
                    response.writeByte(static_cast<uint8_t>(trend.samplePeriodSeconds >> 16)) && response.writeByte(static_cast<uint8_t>(trend.samplePeriodSeconds >> 8)) &&
                    response.writeByte(static_cast<uint8_t>(trend.samplePeriodSeconds));
            }
            const uint8_t control = request[1];
            const uint8_t variableCode = request[2];
            const uint32_t period = (static_cast<uint32_t>(request[3]) << 24) | (static_cast<uint32_t>(request[4]) << 16) |
                (static_cast<uint32_t>(request[5]) << 8) | request[6];
            if (control > 3 || period == 0 || period > 7200) return false;
            if (control != 0 && std::find_if(plan.variables.begin(), plan.variables.end(),
                [variableCode](const auto& variable) { return variable.deviceVariableCode == variableCode; }) == plan.variables.end()) return false;
            plan.trends[index] = {control, variableCode, period};
            return response.writeBytes(request);
        }
        if (command == 0x60 || command == 0x61) {
            if (plan.actionCount == 0 || request.size() != (command == 0x60 ? 1u : 12u)) return false;
            const uint8_t index = request[0];
            if (index >= plan.actionCount || index >= plan.synchronousActions.size()) return false;
            auto& action = plan.synchronousActions[index];
            if (command == 0x60) {
                const auto dateTime = dateTimeBytes(action.triggerSeconds);
                return response.writeByte(index) && response.writeByte(plan.actionCount) && response.writeByte(action.control) &&
                    response.writeByte(action.deviceVariableCode) && response.writeByte(static_cast<uint8_t>(action.command >> 8)) &&
                    response.writeByte(static_cast<uint8_t>(action.command)) && response.writeBytes(std::span<const uint8_t>(dateTime.data(), dateTime.size()));
            }
            const uint8_t control = request[1];
            const uint8_t variableCode = request[2];
            const HartCommandId target = static_cast<HartCommandId>(request[3] << 8 | request[4]);
            uint64_t requested = 0;
            if (control & 0x01) {
                if (variableCode != 251 || target == 0xFFFF) return false;
            } else {
                if (target != 0xFFFF || std::find_if(plan.variables.begin(), plan.variables.end(),
                    [variableCode](const auto& variable) { return variable.deviceVariableCode == variableCode; }) == plan.variables.end()) return false;
            }
            if ((control & ~0x91u) != 0 || !decodeDateTime(request.subspan(5, 7), requested)) return false;
            const uint64_t currentRtc = plan.rtcInitialized ? plan.rtcValueSeconds +
                (plan.virtualTimeSeconds >= plan.rtcSetVirtualSeconds ? plan.virtualTimeSeconds - plan.rtcSetVirtualSeconds : 0) : 0;
            const uint64_t triggerVirtual = plan.rtcInitialized
                ? plan.virtualTimeSeconds + (requested >= currentRtc ? requested - currentRtc : 0)
                : requested;
            action = {control, variableCode, target, triggerVirtual, {}};
            const auto normalized = dateTimeBytes(action.triggerSeconds);
            return response.writeByte(index) && response.writeByte(action.control) && response.writeByte(action.deviceVariableCode) &&
                response.writeByte(static_cast<uint8_t>(action.command >> 8)) && response.writeByte(static_cast<uint8_t>(action.command)) &&
                response.writeBytes(std::span<const uint8_t>(normalized.data(), normalized.size()));
        }
        if (command == 0x62 || command == 0x63) {
            if (plan.actionCount == 0 || (command == 0x62 ? request.size() != 1u : request.size() < 4u)) return false;
            const uint8_t index = request[0];
            if (index >= plan.actionCount || index >= plan.commandActions.size()) return false;
            auto& action = plan.commandActions[index];
            if (command == 0x62) {
                if (action.command == 0xFFFF) return response.writeByte(index) && response.writeByte(0xFF) && response.writeByte(0xFF) && response.writeByte(0);
                return response.writeByte(index) && response.writeByte(static_cast<uint8_t>(action.command >> 8)) && response.writeByte(static_cast<uint8_t>(action.command)) &&
                    response.writeByte(static_cast<uint8_t>(action.requestData.size())) && response.writeBytes(action.requestData);
            }
            const HartCommandId target = static_cast<HartCommandId>(request[1] << 8 | request[2]);
            const size_t count = request[3];
            if (target == 0xFFFF || target == 0x60 || target == 0x61 || target == 0x62 || target == 0x63 || count != request.size() - 4 || count > 255) return false;
            action.command = target;
            action.requestData.assign(request.begin() + 4, request.end());
            return response.writeBytes(request);
        }

        // Commands 35/36/37 are intentionally kept as one StandardCore
        // semantic mutation because 35 must validate both values before it
        // commits. HCF_SPEC-151 7.3 permits reverse ranges and explicitly
        // says range units do not change PV units. Invalid requests therefore
        // fail without touching the canonical VariableConfiguration.
        if (command == 0x23 || command == 0x24 || command == 0x25) {
            if (plan.writeProtectCode != 0xFB) return false;
            if (primary == plan.variables.end()) return false;
            const auto& authored = *primary;
            auto validUnit = [&](uint8_t unit) {
                if (unit == 0xFA || unit == 0xFF) return false;
                return authored.allowedUnitCodes.empty() ||
                    std::find(authored.allowedUnitCodes.begin(), authored.allowedUnitCodes.end(), unit) != authored.allowedUnitCodes.end();
            };
            float nextLower = vars.lowerRangeValue;
            float nextUpper = vars.upperRangeValue;
            uint8_t nextUnit = vars.rangeUnitCode;
            if (command == 0x23) {
                if (request.size() != 9) return false;
                nextUnit = request[0];
                const auto upperBytes = request.subspan(1, 4);
                const auto lowerBytes = request.subspan(5, 4);
                nextUpper = HartTypeCodec::decodeFloat32BE(upperBytes);
                nextLower = HartTypeCodec::decodeFloat32BE(lowerBytes);
            } else {
                if (!request.empty()) return false;
                if (command == 0x24) nextUpper = vars.primaryVariable;
                else {
                    const float delta = vars.primaryVariable - nextLower;
                    nextLower = vars.primaryVariable;
                    nextUpper += delta;
                }
            }
            if (!validUnit(nextUnit) || !std::isfinite(nextLower) || !std::isfinite(nextUpper)) return false;
            const bool limitsConfigured = authored.upperTransducerLimit > authored.lowerTransducerLimit;
            if (limitsConfigured && (nextLower < authored.lowerTransducerLimit || nextUpper > authored.upperTransducerLimit)) return false;
            if (authored.minimumSpan > 0.0f && std::fabs(nextUpper - nextLower) < authored.minimumSpan) return false;
            // All validation is complete: this is the sole commit point.
            vars.rangeUnitCode = nextUnit;
            vars.lowerRangeValue = nextLower;
            vars.upperRangeValue = nextUpper;
            response = HartResponseBuilder(16);
            if (command == 0x23) {
                if (!response.writeByte(nextUnit) || !response.writeBytes(HartTypeCodec::encodeFloat32BE(nextUpper)) ||
                    !response.writeBytes(HartTypeCodec::encodeFloat32BE(nextLower))) return false;
            }
            auto& mutablePrimary = *const_cast<HartDevicePlan::VariableConfiguration*>(primary.operator->());
            mutablePrimary.rangeUnitCode = nextUnit;
            mutablePrimary.lowerRangeValue = nextLower;
            mutablePrimary.upperRangeValue = nextUpper;
            return true;
        }
        if (command == 0x2C) {
            if (plan.writeProtectCode != 0xFB || request.size() != 1 || primary == plan.variables.end()) return false;
            const auto& authored = *primary;
            const uint8_t unit = request[0];
            if (unit == 0xFA || unit == 0xFF ||
                (!authored.allowedUnitCodes.empty() && std::find(authored.allowedUnitCodes.begin(), authored.allowedUnitCodes.end(), unit) == authored.allowedUnitCodes.end())) return false;
            // HCF_SPEC-151 7.12 selects the unit for PV, limits and minimum
            // span. It does not define a numeric conversion; preserve the
            // configured values and change only the canonical unit metadata.
            auto& mutablePrimary = *primary;
            mutablePrimary.deviceVariableUnit = unit;
            mutablePrimary.rangeUnitCode = unit;
            if (!response.writeByte(unit)) return false;
            return true;
        }
        const bool hasAuthoredDeviceVariables = std::any_of(plan.variables.begin(), plan.variables.end(),
            [](const auto& variable) { return variable.deviceVariableCode != 0xFF; });
        if (command == 0x08 && hasAuthoredDeviceVariables) {
            if (!request.empty()) return false;
            for (const uint8_t code : plan.dynamicVariableAssignments) {
                if (code == 250) { if (!response.writeByte(250)) return false; continue; }
                const auto variable = std::find_if(plan.variables.begin(), plan.variables.end(),
                    [code](const auto& candidate) { return candidate.deviceVariableCode == code; });
                if (variable == plan.variables.end() || !response.writeByte(variable->classification)) return false;
            }
            return true;
        }
        if (command >= 0x27 && command <= 0x2F) {
            if (plan.writeProtectCode != 0xFB && command != 0x2A) return false;
            switch (command) {
                case 0x27: // EEPROM control: virtual device has no separate EEPROM; echo validated control.
                    if (request.size() != 1 || request[0] > 1) return false;
                    return response.writeByte(request[0]);
                case 0x28: { // fixed current mode
                    if (request.size() != 4) return false;
                    const float requested = HartTypeCodec::decodeFloat32BE(request);
                    if (!std::isfinite(requested) || requested < 0.0f || requested > 20.0f) return false;
                    plan.fixedCurrentMode = requested != 0.0f;
                    plan.fixedCurrentMilliamps = requested;
                    return response.writeBytes(HartTypeCodec::encodeFloat32BE(requested));
                }
                case 0x29: // self-test is instantaneous for this deterministic virtual device.
                    if (!request.empty()) return false;
                    plan.diagnosticStatus = 0;
                    return true;
                case 0x2A: // device reset clears volatile current/diagnostic state only.
                    if (!request.empty()) return false;
                    plan.fixedCurrentMode = false;
                    plan.fixedCurrentMilliamps = 0.0f;
                    plan.diagnosticStatus = 0;
                    if (plan.lockCode == 1) plan.lockCode = 0;
                    plan.squawkControl = 0;
                    plan.squawkEvent = 0;
                    return true;
                case 0x2B: // zero adjustment changes PV offset, not range.
                    if (!request.empty()) return false;
                    plan.primaryVariableZeroOffset = -static_cast<float>(primaryValue);
                    return true;
                case 0x2D: { // trim zero: measured value must be the 4 mA endpoint.
                    if (request.size() != 4) return false;
                    const float measured = HartTypeCodec::decodeFloat32BE(request);
                    if (!std::isfinite(measured) || std::fabs(measured - 4.0f) > 0.01f) return false;
                    plan.loopCurrentZeroTrim = 4.0f - measured;
                    return response.writeBytes(HartTypeCodec::encodeFloat32BE(measured));
                }
                case 0x2E: { // trim gain: measured value must be the 20 mA endpoint.
                    if (request.size() != 4) return false;
                    const float measured = HartTypeCodec::decodeFloat32BE(request);
                    if (!std::isfinite(measured) || std::fabs(measured - 20.0f) > 0.01f) return false;
                    plan.loopCurrentGainTrim = measured == 0.0f ? 1.0f : 20.0f / measured;
                    return response.writeBytes(HartTypeCodec::encodeFloat32BE(measured));
                }
                case 0x2F: // HCF common table 3: linear/square-root are the modeled selections.
                    if (request.size() != 1 || request[0] > 1) return false;
                    plan.pvTransferFunctionCode = request[0];
                    return response.writeByte(request[0]);
                default: return false;
            }
        }
        if (command >= 0x31 && command <= 0x3B) {
            auto findVariable = [&](uint8_t code) {
                return std::find_if(plan.variables.begin(), plan.variables.end(),
                    [code](const auto& variable) { return variable.deviceVariableCode == code; });
            };
            auto findPrimary = [&]() {
                return std::find_if(plan.variables.begin(), plan.variables.end(), [](const auto& variable) {
                    return variable.deviceVariableCode == 246 || variable.role == HartVariableRole::PrimaryVariable ||
                           variable.id == "PV" || variable.id == "primary";
                });
            };
            if (plan.writeProtectCode != 0xFB && command != 0x32) return false;
            if (command == 0x31) {
                if (request.size() != 3) return false;
                auto pv = findPrimary(); if (pv == plan.variables.end()) return false;
                const uint32_t serial = (static_cast<uint32_t>(request[0]) << 16) |
                    (static_cast<uint32_t>(request[1]) << 8) | request[2];
                pv->transducerSerialNumber = serial;
                return response.writeBytes(request);
            }
            if (command == 0x32) {
                if (!request.empty()) return false;
                return response.writeBytes(plan.dynamicVariableAssignments);
            }
            if (command == 0x33) {
                if (request.size() != 4) return false;
                std::array<uint8_t, 4> next{};
                for (size_t i = 0; i < next.size(); ++i) {
                    const uint8_t code = request[i];
                    if (code >= 244 && code <= 249) return false;
                    if (code != 250 && findVariable(code) == plan.variables.end()) return false;
                    next[i] = code;
                }
                plan.dynamicVariableAssignments = next;
                return response.writeBytes(next);
            }
            if (command == 0x34) {
                if (request.size() != 1) return false;
                const uint8_t code = request[0];
                auto variable = findVariable(code); if (variable == plan.variables.end()) return false;
                variable->zeroOffset = -variable->value;
                if (code == 246) plan.primaryVariableZeroOffset = -static_cast<float>(primaryValue);
                return response.writeByte(code);
            }
            if (command == 0x37) {
                if (request.size() != 5) return false;
                const uint8_t code = request[0];
                auto variable = findVariable(code); if (variable == plan.variables.end()) return false;
                const float value = HartTypeCodec::decodeFloat32BE(request.subspan(1, 4));
                if (!std::isfinite(value) || value < 0.0f) return false;
                variable->dampingValue = value;
                return response.writeByte(code) && response.writeBytes(HartTypeCodec::encodeFloat32BE(value));
            }
            if (command == 0x38) {
                if (request.size() != 4) return false;
                const uint8_t code = request[0];
                auto variable = findVariable(code); if (variable == plan.variables.end()) return false;
                variable->transducerSerialNumber = (static_cast<uint32_t>(request[1]) << 16) |
                    (static_cast<uint32_t>(request[2]) << 8) | request[3];
                return response.writeByte(code) && response.writeBytes(request.subspan(1, 3));
            }
            if (command == 0x39) {
                if (!request.empty()) return false;
                const auto tag = HartTypeCodec::encodePackedAscii(plan.tag.empty() ? plan.id : plan.tag, 8);
                const auto descriptor = HartTypeCodec::encodePackedAscii(plan.descriptor, 16);
                return response.writeBytes(tag) && response.writeBytes(descriptor) && response.writeBytes(plan.date);
            }
            if (command == 0x3A) {
                if (request.size() != 21) return false;
                const auto tagBytes = request.subspan(0, 6);
                const auto descriptorBytes = request.subspan(6, 12);
                plan.tag = HartTypeCodec::decodePackedAscii(tagBytes);
                plan.descriptor = HartTypeCodec::decodePackedAscii(descriptorBytes);
                std::copy_n(request.begin() + 18, 3, plan.date.begin());
                return response.writeBytes(request);
            }
            if (command == 0x3B) {
                if (request.size() != 1 || request[0] < 5) return false;
                plan.responsePreambles = request[0];
                return response.writeByte(plan.responsePreambles);
            }
        }
        if (command >= 0x3C && command <= 0x46) {
            if (!plan.analogChannel0Supported) return false;
            const auto channelOk = [](uint8_t channel) { return channel == 0; };
            const auto invalidFloat = std::array<uint8_t, 4>{0x7F, 0xA0, 0x00, 0x00};
            const auto writeFloat = [&](float value) { return response.writeBytes(HartTypeCodec::encodeFloat32BE(value)); };
            const auto writeChannelLevel = [&](uint8_t channel) {
                return response.writeByte(channel) && response.writeByte(plan.analogChannel0UnitCode) &&
                    writeFloat(hartLoopCurrentMilliamps(vars));
            };
            if (command == 0x3C) {
                if (request.size() != 1 || !channelOk(request[0])) return false;
                return writeChannelLevel(0) && writeFloat(hartPercentOfRange(vars));
            }
            if (command == 0x3D) {
                if (!request.empty()) return false;
                if (!response.writeByte(plan.analogChannel0UnitCode) || !writeFloat(hartLoopCurrentMilliamps(vars))) return false;
                const auto writeDynamic = [&](uint8_t code, bool primarySlot) {
                    if (code == 250) return response.writeByte(250) && response.writeBytes(invalidFloat);
                    const auto variable = std::find_if(plan.variables.begin(), plan.variables.end(),
                        [code](const auto& candidate) { return candidate.deviceVariableCode == code; });
                    if (variable == plan.variables.end()) return false;
                    const float value = primarySlot ? vars.primaryVariable : static_cast<float>(variable->value + variable->zeroOffset);
                    return response.writeByte(variable->deviceVariableUnit) && writeFloat(value);
                };
                for (size_t slot = 0; slot < 4; ++slot) {
                    if (!writeDynamic(plan.dynamicVariableAssignments[slot], slot == 0)) return false;
                }
                return true;
            }
            if (command == 0x3E) {
                if (request.empty() || request.size() > 4) return false;
                std::array<uint8_t, 4> slots{0, 0, 0, 0};
                for (size_t i = 0; i < slots.size(); ++i) slots[i] = i < request.size() ? request[i] : 0;
                for (const uint8_t channel : slots) if (!channelOk(channel)) return false;
                for (const uint8_t channel : slots) if (!writeChannelLevel(channel)) return false;
                return true;
            }
            if (command == 0x3F) {
                if (request.size() != 1 || !channelOk(request[0])) return false;
                return response.writeByte(0) && response.writeByte(plan.alarmSelectionCode) &&
                    response.writeByte(plan.pvTransferFunctionCode) && response.writeByte(plan.analogChannel0RangeUnitCode) &&
                    writeFloat(plan.analogChannel0UpperRangeValue) && writeFloat(plan.analogChannel0LowerRangeValue) &&
                    writeFloat(plan.analogChannel0AdditionalDamping) && response.writeByte(plan.analogChannel0Flags);
            }
            if (command == 0x40) {
                if (plan.writeProtectCode != 0xFB || request.size() != 5 || !channelOk(request[0])) return false;
                const float damping = HartTypeCodec::decodeFloat32BE(request.subspan(1, 4));
                if (!std::isfinite(damping) || damping < 0.0f) return false;
                plan.analogChannel0AdditionalDamping = damping;
                return response.writeByte(0) && writeFloat(damping);
            }
            if (command == 0x41) {
                if (plan.writeProtectCode != 0xFB || request.size() != 10 || !channelOk(request[0])) return false;
                const uint8_t unit = request[1];
                const float upper = HartTypeCodec::decodeFloat32BE(request.subspan(2, 4));
                const float lower = HartTypeCodec::decodeFloat32BE(request.subspan(6, 4));
                if (unit == 0xFA || unit == 0xFF || !std::isfinite(upper) || !std::isfinite(lower)) return false;
                plan.analogChannel0RangeUnitCode = unit;
                plan.analogChannel0UpperRangeValue = upper;
                plan.analogChannel0LowerRangeValue = lower;
                return response.writeByte(0) && response.writeByte(unit) && writeFloat(upper) && writeFloat(lower);
            }
            if (command == 0x42) {
                if (plan.writeProtectCode != 0xFB || request.size() != 6 || !channelOk(request[0])) return false;
                const uint8_t unit = request[1];
                const auto valueBytes = request.subspan(2, 4);
                const float level = HartTypeCodec::decodeFloat32BE(valueBytes);
                if (unit == 0xFA || unit == 0xFF) return false;
                if (std::equal(valueBytes.begin(), valueBytes.end(), invalidFloat.begin())) {
                    plan.fixedCurrentMode = false; plan.fixedCurrentMilliamps = 0.0f;
                } else {
                    if (!std::isfinite(level) || level < plan.analogChannel0LowerLimit || level > plan.analogChannel0UpperLimit) return false;
                    plan.fixedCurrentMode = true; plan.fixedCurrentMilliamps = level;
                }
                return response.writeByte(0) && response.writeByte(unit) && response.writeBytes(valueBytes);
            }
            if (command == 0x43 || command == 0x44) {
                if (plan.writeProtectCode != 0xFB || request.size() != 6 || !channelOk(request[0]) || request[1] == 0xFA || request[1] == 0xFF) return false;
                if (!plan.fixedCurrentMode) return false;
                const float measured = HartTypeCodec::decodeFloat32BE(request.subspan(2, 4));
                if (!std::isfinite(measured)) return false;
                if (command == 0x43) plan.loopCurrentZeroTrim = measured - plan.fixedCurrentMilliamps;
                else if (plan.fixedCurrentMilliamps == 0.0f) return false;
                else plan.loopCurrentGainTrim = measured / plan.fixedCurrentMilliamps;
                return response.writeByte(0) && response.writeByte(request[1]) && writeFloat(measured);
            }
            if (command == 0x45) {
                if (plan.writeProtectCode != 0xFB || request.size() != 2 || !channelOk(request[0]) || request[1] > 1) return false;
                plan.pvTransferFunctionCode = request[1];
                return response.writeByte(0) && response.writeByte(request[1]);
            }
            if (command == 0x46) {
                if (request.size() != 1 || !channelOk(request[0])) return false;
                return response.writeByte(0) && response.writeByte(plan.analogChannel0RangeUnitCode) &&
                    writeFloat(plan.analogChannel0UpperRangeValue) && writeFloat(plan.analogChannel0LowerRangeValue) &&
                    writeFloat(plan.analogChannel0UpperLimit) && writeFloat(plan.analogChannel0LowerLimit);
            }
        }
        // Snapshot the packed fields exactly as seeded above so persistence
        // below can tell "this command's write stage actually SET this
        // field" apart from "this field's packed encoding is merely stable
        // under decode(encode(x))". Without this, EVERY command dispatched
        // through this hook -- including plain reads that never touch Tag --
        // would silently re-canonicalize `plan.tag` (uppercase + space-pad +
        // truncate to 8 chars) on every single call, which is exactly the
        // kind of unrelated side effect a read must never have.
        const auto tagBefore = vars.tagPacked;
        const auto messageBefore = vars.messagePacked;
        const auto descriptorBefore = vars.descriptorPacked;
        const auto dateBefore = vars.date;
        const auto finalAssemblyBefore = vars.finalAssemblyNumber;
        const auto longTagBefore = vars.longTag;
        if (it == programs->end()) return false;
        if (!HartCommandExecutor::execute(it->second, vars, request, response)) return false;
        // Persist only the fields this command's `write`/`after` stage
        // actually mutated (see the doc comment on
        // `HartEngine::CommandProgramHook`) back into the plan HartEngine
        // will copy into the real runtime device. primaryVariableUnit/
        // primaryVariable are intentionally NEVER written back here even
        // though SET can target them: the primary variable's value is owned
        // by the Signal Graph/`primaryValue` parameter, not by this plan
        // snapshot, and writing it back would fight that ownership on the
        // next evaluation tick.
        if (vars.tagPacked != tagBefore) plan.tag = HartTypeCodec::decodePackedAscii(vars.tagPacked);
        if (vars.messagePacked != messageBefore) plan.message = HartTypeCodec::decodePackedAscii(vars.messagePacked);
        if (vars.descriptorPacked != descriptorBefore) plan.descriptor = HartTypeCodec::decodePackedAscii(vars.descriptorPacked);
        if (vars.date != dateBefore) plan.date = vars.date;
        if (vars.finalAssemblyNumber != finalAssemblyBefore) plan.finalAssemblyNumber = vars.finalAssemblyNumber;
        if (vars.longTag != longTagBefore) plan.longTag = HartTypeCodec::decodeLatin1(vars.longTag);
        // pollingAddress/loopCurrentMode are plain scalar bytes (no lossy
        // pack/unpack round-trip like the string fields above), so writing
        // them back unconditionally has no spurious-canonicalization risk --
        // this is what makes Command 6's live readdressing take effect.
        plan.pollingAddress = vars.pollingAddress;
        plan.loopCurrentMode = vars.loopCurrentMode;
        // Same "plain scalar, no lossy round-trip" reasoning as
        // pollingAddress/loopCurrentMode above -- these are the SAME fields
        // Common Practice write commands (34/47/100) will mutate, never a
        // second copy.
        plan.pvTransferFunctionCode = vars.pvTransferFunctionCode;
        plan.alarmSelectionCode = vars.alarmSelectionCode;
        plan.writeProtectCode = vars.writeProtectCode;
        for (auto& authored : plan.variables) {
            for (const auto& variable : vars.deviceVariables) {
                if (authored.deviceVariableCode != variable.code) continue;
                authored.value = variable.value;
                authored.deviceVariableUnit = variable.units;
                authored.dampingValue = variable.damping;
                authored.deviceVariableStatus = variable.status;
                authored.writable = variable.writable;
            }
        }
        return true;
    };
}
} // namespace

bool HartReferenceCatalog::installCommandPrograms(HartEngine& engine) {
    auto programs = std::make_shared<std::unordered_map<HartCommandId, HartCompiledCommandProgram>>();
    for (HartCommandDefinition& definition : commandProgramDefinitions()) {
        HartCommandCompileResult compiled = HartCommandCompiler::compile(std::move(definition));
        if (!compiled.success) return false;
        programs->emplace(compiled.program.definition.id, std::move(compiled.program));
    }
    engine.setCommandProgramHook(makeHook(programs));
    return true;
}

HartReferenceCatalog::InstallResult HartReferenceCatalog::installCommandPrograms(HartEngine& engine,
                                                                                 std::vector<HartCommandDefinition> additional) {
    auto builtins = std::make_shared<std::unordered_map<HartCommandId, HartCompiledCommandProgram>>();
    for (HartCommandDefinition& definition : commandProgramDefinitions()) {
        HartCommandCompileResult compiled = HartCommandCompiler::compile(std::move(definition));
        if (!compiled.success) { engine.setCommandProgramHook(makeHook(builtins)); return {false, "internal: built-in command failed to compile: " + compiled.error}; }
        builtins->emplace(compiled.program.definition.id, std::move(compiled.program));
    }

    auto combined = std::make_shared<std::unordered_map<HartCommandId, HartCompiledCommandProgram>>(*builtins);
    for (HartCommandDefinition& definition : additional) {
        const std::string name = definition.name.empty() ? std::to_string(definition.id) : definition.name;
        HartCommandCompileResult compiled = HartCommandCompiler::compile(std::move(definition));
        if (!compiled.success) {
            // All-or-nothing for `additional`: fall back to built-ins only so one
            // broken custom edit never takes down 0x00/0x01/0x03/0x0B/0x21.
            engine.setCommandProgramHook(makeHook(builtins));
            return {false, "command \"" + name + "\": " + compiled.error};
        }
        // operator[] assignment, not emplace: kept even though `commandProgramDefinitions()`
        // no longer auto-generates a placeholder for every catalogued id (that
        // "echo body" fallback was removed -- see its doc comment), because a
        // future built-in could still legitimately share an id with a Device-
        // Specific command during a transitional edit; assignment fails safe
        // (the custom program always wins) where `emplace` would silently
        // discard the manufacturer's real body. The 5 fully modeled commands
        // (0x00/0x01/0x03/0x0B/0x21) can never collide here at all: they
        // classify as Universal/Common Practice, and
        // `HartCommandJson::isManufacturerAuthorable` rejects authoring a
        // custom command under those ids before we ever reach this point.
        (*combined)[compiled.program.definition.id] = std::move(compiled.program);
    }
    engine.setCommandProgramHook(makeHook(combined));
    return {true, {}};
}

} // namespace lasecsimul::protocols

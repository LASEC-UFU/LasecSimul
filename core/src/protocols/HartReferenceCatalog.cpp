#include "HartReferenceCatalog.hpp"

#include "HartTypeCodec.hpp"

#include <algorithm>
#include <array>
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

} // namespace

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

bool HartReferenceCatalog::registerGenericProfile(HartProfileRegistry& registry) {
    return registry.registerProfile(makeGenericProfile());
}

std::vector<HartDevicePlan> HartReferenceCatalog::makeDevicePlans(std::string_view bus) {
    std::vector<HartDevicePlan> result;
    const auto definitions = deviceDefinitions();
    result.reserve(definitions.size());
    for (const HartReferenceDeviceDefinition& definition : definitions) {
        HartDevicePlan plan{std::string(definition.name),
                           "lasecsimul.hart.process-simul-compatible",
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

    // 0x03 -- Read Dynamic Variables And Loop Current: loop current + 4x
    // (unit, value) for PV/SV/TV/QV. Only PV is modeled by this profile; SV/TV/QV
    // and loop current use the HART "not used" convention (unit 0xFA + IEEE-754
    // NaN) rather than a fabricated number -- loop current requires an LRV/URV
    // range model FEAT-013 does not have yet (documented limitation, not a guess).
    {
        HartCommandDefinition cmd;
        cmd.id = 0x03;
        const auto nan = HartTypeCodec::encodeFloat32BE(HartTypeCodec::quietNaN());
        const std::vector<uint8_t> nanBytes(nan.begin(), nan.end());
        cmd.name = "Read Dynamic Variables And Loop Current";
        cmd.resp = {
            HartStatement{HartAppendStmt{HartExpr::hex(nanBytes)}}, // loop current: not modeled
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PrimaryVariableUnit)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PrimaryVariable)}},
            HartStatement{HartAppendStmt{HartExpr::hexByte(0xFA)}}, // SV: not used
            HartStatement{HartAppendStmt{HartExpr::hex(nanBytes)}},
            HartStatement{HartAppendStmt{HartExpr::hexByte(0xFA)}}, // TV: not used
            HartStatement{HartAppendStmt{HartExpr::hex(nanBytes)}},
            HartStatement{HartAppendStmt{HartExpr::hexByte(0xFA)}}, // QV: not used
            HartStatement{HartAppendStmt{HartExpr::hex(nanBytes)}},
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

    // 0x21 -- Read Device Variables: error_code + FOR_CODES over the request
    // body, one (unit, value) pair per requested device-variable code. Only
    // code 0x00 (PV) is modeled; every other code returns the HART "not used"
    // convention. Matches the FASE 33 worked example exactly.
    {
        HartCommandDefinition cmd;
        cmd.id = 0x21;
        cmd.name = "Read Device Variables";
        HartForCodesStmt forCodes;
        forCodes.source = HartExpr::body();
        forCodes.maxIterations = 8; // bounded: worst case 8 * 5 = 40 response bytes
        HartIfStmt knownCode;
        knownCode.lhs = HartExpr::localCode();
        knownCode.rhs = HartExpr::hexByte(0x00);
        knownCode.thenBranch = {
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PrimaryVariableUnit)}},
            HartStatement{HartAppendStmt{HartExpr::var(HartVarId::PrimaryVariable)}},
        };
        const auto nan = HartTypeCodec::encodeFloat32BE(HartTypeCodec::quietNaN());
        knownCode.elseBranch = {
            HartStatement{HartAppendStmt{HartExpr::hexByte(0xFA)}},
            HartStatement{HartAppendStmt{HartExpr::hex(std::vector<uint8_t>(nan.begin(), nan.end()))}},
        };
        forCodes.body = {HartStatement{std::move(knownCode)}};
        cmd.resp = {
            HartStatement{HartAppendStmt{HartExpr::hexByte(0x00)}}, // error_code: no per-device error tracking yet
            HartStatement{std::move(forCodes)},
        };
        commands.push_back(std::move(cmd));
    }

    return commands;
}

namespace {
HartEngine::CommandProgramHook makeHook(std::shared_ptr<std::unordered_map<HartCommandId, HartCompiledCommandProgram>> programs) {
    return [programs](const HartDeviceProfile& profile, const HartDevicePlan& plan, double primaryValue,
                      HartCommandId command, std::span<const uint8_t> request, HartResponseBuilder& response) -> bool {
        const auto it = programs->find(command);
        if (it == programs->end()) return false;
        HartExecutionVariables vars;
        vars.manufacturerId = static_cast<uint8_t>(profile.manufacturerId);
        vars.deviceType = static_cast<uint8_t>(profile.deviceType);
        vars.deviceId = parseDeviceIdHex(plan.uniqueId);
        vars.numRequestPreambles = profile.identity.numRequestPreambles;
        vars.universalCommandRevision = profile.identity.universalCommandRevision;
        vars.transmitterSpecificRevision = profile.identity.transmitterSpecificRevision;
        vars.softwareRevision = profile.identity.softwareRevision;
        vars.hardwareRevisionAndSignal = profile.identity.hardwareRevisionAndSignal;
        vars.flags = profile.identity.flags;
        const std::string_view tagSource = plan.tag.empty() ? std::string_view(plan.id) : std::string_view(plan.tag);
        const std::vector<uint8_t> packedTag = HartTypeCodec::encodePackedAscii(tagSource, 8);
        std::copy_n(packedTag.begin(), std::min(packedTag.size(), vars.tagPacked.size()), vars.tagPacked.begin());
        vars.primaryVariableUnit = 57; // percent; no per-device unit authoring yet
        vars.primaryVariable = static_cast<float>(primaryValue);
        return HartCommandExecutor::execute(it->second, vars, request, response);
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
        combined->emplace(compiled.program.definition.id, std::move(compiled.program));
    }
    engine.setCommandProgramHook(makeHook(combined));
    return {true, {}};
}

} // namespace lasecsimul::protocols

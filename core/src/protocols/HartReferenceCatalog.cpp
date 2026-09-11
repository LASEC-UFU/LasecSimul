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

    // 0x11 (17) -- Write Message: 24-char packed-ASCII message, no response
    // payload (this project has no generic status-byte framing to echo; see
    // the note above).
    {
        HartCommandDefinition cmd;
        cmd.id = 0x11;
        cmd.name = "Write Message";
        cmd.write = {HartStatement{HartSetStmt{HartVarId::Message, HartExpr::bodySlice(0, 18)}}};
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
    {
        HartCommandDefinition cmd;
        cmd.id = 0x12;
        cmd.name = "Write Tag, Descriptor, Date";
        cmd.write = {
            HartStatement{HartSetStmt{HartVarId::Tag, HartExpr::bodySlice(0, 6)}},
            HartStatement{HartSetStmt{HartVarId::Descriptor, HartExpr::bodySlice(6, 12)}},
            HartStatement{HartSetStmt{HartVarId::Date, HartExpr::bodySlice(18, 3)}},
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
    {
        HartCommandDefinition cmd;
        cmd.id = 0x13;
        cmd.name = "Write Final Assembly Number";
        cmd.write = {HartStatement{HartSetStmt{HartVarId::FinalAssemblyNumber, HartExpr::bodySlice(0, 3)}}};
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
        const std::vector<uint8_t> packedMessage = HartTypeCodec::encodePackedAscii(plan.message, 24);
        std::copy_n(packedMessage.begin(), std::min(packedMessage.size(), vars.messagePacked.size()), vars.messagePacked.begin());
        const std::vector<uint8_t> packedDescriptor = HartTypeCodec::encodePackedAscii(plan.descriptor, 16);
        std::copy_n(packedDescriptor.begin(), std::min(packedDescriptor.size(), vars.descriptorPacked.size()), vars.descriptorPacked.begin());
        vars.date = plan.date;
        vars.finalAssemblyNumber = plan.finalAssemblyNumber;
        vars.primaryVariableUnit = profile.primaryVariableUnit;
        vars.primaryVariable = static_cast<float>(primaryValue);
        std::vector<HartExecutionVariables::UserVariable> userVariables;
        userVariables.reserve(plan.variables.size());
        for (size_t i = 0; i < plan.variables.size(); ++i) {
            const auto& variable = plan.variables[i];
            const double value = (variable.id == "PV" || variable.id == "primary")
                ? primaryValue : variable.value;
            userVariables.push_back({variable.id, value, variable.type});
        }
        vars.userVariables = userVariables;
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

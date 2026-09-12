#pragma once

#include "HartEngine.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <variant>
#include <vector>

namespace lasecsimul::protocols {

// ---------------------------------------------------------------------------
// Semantic Hart Command authoring IR (cold path).
//
// This is the LasecSimul canonical DSL described in .spec/features/hart-device-engine.md
// "Anexo A", recovered from the PACTware `COMMANDS` dict primitives (SET, IF/EQ,
// MAP, FOR_CODES, $BODY, $BODY[a:b], hex literal, row/variable reference) and
// generalized/typed for a bounded C++ executor. It is NOT a new invented
// language: every node below maps 1:1 to a PACTware primitive documented in
// the audit. `req` is intentionally not modeled: LasecSimul's HartEngine is a
// device (responder), never a master, so there is no outgoing request to
// compose; `write`/`resp`/`after` are preserved because their ordering is
// observable (HART-FR of FEAT-013, FASE 76 gate).
//
// Variable references use a stable `HartVarId`, resolved once when the
// profile/plan is built -- never a string lookup per frame (HART-FR-003,
// section 97 "no string hot path").

/** Stable identity/runtime variables a command program can reference. Adding a
 * new one requires extending `HartExecutionVariables`/the executor (a
 * primitive-language change); using an existing one in a new command does
 * not (HART-FR extensibility gate). */
enum class HartVarId : uint8_t {
    ManufacturerId,
    DeviceType,
    DeviceId,                  // 3 bytes
    NumRequestPreambles,
    UniversalCommandRevision,
    TransmitterSpecificRevision,
    SoftwareRevision,
    HardwareRevisionAndSignal,
    Flags,
    Tag,                       // 6 bytes packed ASCII (8 chars)
    PrimaryVariableUnit,
    PrimaryVariable,           // 4 bytes IEEE-754 BE when appended
    Message,                   // 18 bytes packed ASCII (24 chars) -- Universal Command 12/17
    Descriptor,                // 12 bytes packed ASCII (16 chars) -- Universal Command 13/18
    Date,                      // 3 bytes {day, month, year-1900} -- Universal Command 13/18
    FinalAssemblyNumber,       // 3 bytes big-endian unsigned -- Universal Command 16/19
    LongTag,                   // 32 bytes ISO Latin-1 -- Universal Command 20/21/22
    PollingAddress,            // 1 byte -- Universal Command 6/7
    LoopCurrentMode,           // 1 byte enum (Common Table 16: 0=Disabled, 1=Enabled) -- Universal Command 6/7
    UpperRangeValue,           // 4 bytes float -- profile.upperRangeValue (Universal Command 15, Common Practice 35-37)
    LowerRangeValue,           // 4 bytes float -- profile.lowerRangeValue (Universal Command 15, Common Practice 35-37)
    /** These three are real, persisted, WRITABLE device state -- not
     * hardcoded response literals. They are read by Universal Command 15
     * and are the SAME storage that Common Practice write commands mutate
     * (47 Write PV Transfer Function, 100 Write PV Alarm Code -- Write Protect Code has no HART write command by
     * design, hardware/jumper-controlled, but still gets one identity so a
     * future read of it is never a second, disconnected literal). Adding a
     * command that touches one of these MUST reference the existing
     * HartVarId, never introduce a second one for the same concept. */
    PvTransferFunctionCode,    // 1 byte enum (Common Table 3) -- default 0 (Linear)
    AlarmSelectionCode,        // 1 byte enum (Common Table 6) -- default 251 (None)
    WriteProtectCode,          // 1 byte enum (Common Table 7) -- default 251 (None, not implemented)
};

enum class HartDeviceVariableField : uint8_t {
    Code, Units, Value, Status, UpperLimit, LowerLimit, MinimumSpan,
    ClassificationCode, Family, AcquisitionPeriod, Properties, Serial, Damping, WriteMode,
};

/** `$BODY`, `$BODY[a:b]`, hex literal, row/variable reference, `$code`. */
struct HartExpr {
    /** `LoopCurrentMilliamps`/`PercentOfRange`: the standard HART 4-20mA
     * linear mapping of PV against the profile's Upper/Lower Range Value
     * (Universal Commands 2/3). This is the one arithmetic computation the
     * DSL supports -- a dedicated node, not a generic expression grammar,
     * because it is the ONLY formula any HART command in this project
     * needs (HART-FR extensibility gate: add a new formula as a new Kind,
     * do not build a general arithmetic language for a single use). */
    enum class Kind : uint8_t { RequestBody, BodySlice, HexConstant, Variable, UserVariable, LocalCode,
                                LoopCurrentMilliamps, PercentOfRange, DeviceVariable };
    Kind kind = Kind::RequestBody;
    size_t offset = 0;              // BodySlice
    size_t length = 0;               // BodySlice; 0 means "to end of body"
    std::vector<uint8_t> constant;   // HexConstant
    HartVarId variable = HartVarId::ManufacturerId; // Variable
    std::string variableId;           // UserVariable, resolved against the plan
    HartDeviceVariableField deviceVariableField = HartDeviceVariableField::Value;

    static HartExpr body() noexcept { HartExpr e; e.kind = Kind::RequestBody; return e; }
    static HartExpr bodySlice(size_t offset, size_t length) noexcept {
        HartExpr e; e.kind = Kind::BodySlice; e.offset = offset; e.length = length; return e;
    }
    static HartExpr hex(std::vector<uint8_t> bytes) noexcept {
        HartExpr e; e.kind = Kind::HexConstant; e.constant = std::move(bytes); return e;
    }
    static HartExpr hexByte(uint8_t byte) noexcept { return hex({byte}); }
    static HartExpr var(HartVarId id) noexcept { HartExpr e; e.kind = Kind::Variable; e.variable = id; return e; }
    static HartExpr userVar(std::string id) { HartExpr e; e.kind = Kind::UserVariable; e.variableId = std::move(id); return e; }
    static HartExpr localCode() noexcept { HartExpr e; e.kind = Kind::LocalCode; return e; }
    static HartExpr loopCurrentMilliamps() noexcept { HartExpr e; e.kind = Kind::LoopCurrentMilliamps; return e; }
    static HartExpr percentOfRange() noexcept { HartExpr e; e.kind = Kind::PercentOfRange; return e; }
    static HartExpr deviceVariable(HartDeviceVariableField field) noexcept {
        HartExpr e; e.kind = Kind::DeviceVariable; e.deviceVariableField = field; return e;
    }
};

struct HartStatement; // fwd

/** `APPEND` -- concatenate evaluated bytes into the response (SEQUENCE semantics
 * from a list of statements composing the resp/write/after stage). */
struct HartAppendStmt { HartExpr source; };

/** `SET(variable, value)` -- write-stage/after-stage side effect. */
struct HartSetStmt { HartVarId target; HartExpr value; };

/** Mutates the Device Variable selected by the current FOR_CODES/local-code
 * context. This is a generic bounded primitive used by Common Practice
 * writes, not a command-specific handler. */
struct HartSetDeviceVariableStmt { HartDeviceVariableField target; HartExpr value; };

enum class HartDeviceVariableGuard : uint8_t { Exists, Writable, UnitsMatch, ValidWriteCode };
struct HartGuardDeviceVariableStmt { HartDeviceVariableGuard guard; HartExpr value; };

/** `IF EQ(lhs, rhs) THEN [...] ELSE [...]`. */
struct HartIfStmt {
    HartExpr lhs;
    HartExpr rhs;
    std::vector<HartStatement> thenBranch;
    std::vector<HartStatement> elseBranch;
};

struct HartMapEntry { std::vector<uint8_t> key; std::vector<uint8_t> value; };

/** `MAP KEY TABLE DEFAULT` -- bounded lookup, appends the matched or default bytes. */
struct HartMapStmt {
    HartExpr key;
    std::vector<HartMapEntry> table;
    std::vector<uint8_t> defaultValue;
};

/** `FOR_CODES SRC PREFIX DO` -- bounded iteration over one-byte codes parsed
 * from `source`; `prefix` runs once before the loop, `body` runs once per
 * code with `$code` bound. `maxIterations` is a compile-time bound validated
 * against the worst-case request size (never an unrestricted loop). */
struct HartForCodesStmt {
    HartExpr source;
    std::vector<HartStatement> prefix;
    std::vector<HartStatement> body;
    size_t maxIterations = 32;
};

using HartStatementNode = std::variant<HartAppendStmt, HartSetStmt, HartSetDeviceVariableStmt,
                                       HartGuardDeviceVariableStmt, HartIfStmt, HartMapStmt, HartForCodesStmt>;
struct HartStatement { HartStatementNode node; };

struct HartCommandDefinition {
    HartCommandId id = 0;
    std::string name;
    std::vector<HartStatement> write; // side effects applied before resp
    std::vector<HartStatement> resp;  // response body construction
    std::vector<HartStatement> after; // side effects applied after resp
};

// ---------------------------------------------------------------------------
// Compiled layer + compiler (cold path). Validates bounds so the executor
// never has to: body-slice ranges, duplicate MAP keys, FOR_CODES iteration
// caps, and a static worst-case response-size bound (HART-FR-006, FASE 35/50).

struct HartCompiledCommandProgram {
    HartCommandDefinition definition;
    size_t maxResponseBytes = 0;
};

struct HartCommandCompileResult {
    bool success = false;
    std::string error;
    HartCompiledCommandProgram program;
};

class HartCommandCompiler final {
public:
    static HartCommandCompileResult compile(HartCommandDefinition definition, size_t maxRequestBytes = 255,
                                             size_t maxResponseBytes = 255);
};

// ---------------------------------------------------------------------------
// Executor (hot path). Bounded: no heap allocation beyond the caller-owned
// response buffer, no string/name lookup (HartVarId is resolved to a struct
// field access), iteration bounded by the compiled maxIterations.

/** Per-device snapshot resolved from `HartDeviceProfile` + `HartDevicePlan` at
 * plan-load time (HART-FR: no string lookup per frame). Only `primaryVariable`
 * and `primaryVariableUnit` are expected to change between calls; the rest are
 * identity fields precomputed once. */
struct HartExecutionVariables {
    uint8_t manufacturerId = 0;
    uint8_t deviceType = 0;
    std::array<uint8_t, 3> deviceId{};
    uint8_t numRequestPreambles = 5;
    uint8_t universalCommandRevision = 7;
    uint8_t transmitterSpecificRevision = 1;
    uint8_t softwareRevision = 1;
    uint8_t hardwareRevisionAndSignal = 0;
    uint8_t flags = 0;
    std::array<uint8_t, 6> tagPacked{};
    uint8_t primaryVariableUnit = 57; // HART unit code 57 = percent
    float primaryVariable = 0.0f;
    std::array<uint8_t, 18> messagePacked{};
    std::array<uint8_t, 12> descriptorPacked{};
    std::array<uint8_t, 3> date{};
    std::array<uint8_t, 3> finalAssemblyNumber{};
    std::array<uint8_t, 32> longTag{};
    uint8_t pollingAddress = 0;
    uint8_t loopCurrentMode = 1; // Common Table 16: 1 = Enabled (HART default per HCF_SPEC-127 6.7)
    uint8_t rangeUnitCode = 57; // Command 35 range units; distinct from PV units per HCF_SPEC-151 7.3
    float upperRangeValue = 100.0f;
    float lowerRangeValue = 0.0f;
    uint8_t pvTransferFunctionCode = 0x00; // 0 = Linear
    uint8_t alarmSelectionCode = 0xFB;     // 251 = None
    uint8_t writeProtectCode = 0xFB;       // 251 = None
    bool fixedCurrentMode = false;
    float fixedCurrentMilliamps = 0.0f;
    float loopCurrentZeroTrim = 0.0f;
    float loopCurrentGainTrim = 1.0f;
    uint8_t diagnosticStatus = 0;
    struct UserVariable { std::string id; double value = 0.0; HartVariableType type = HartVariableType::Float32; };
    std::span<const UserVariable> userVariables;
    struct DeviceVariable {
        uint8_t code = 0xFF;
        uint8_t units = 250;
        float value = 0.0f;
        uint8_t status = 0;
        float upperLimit = 0.0f;
        float lowerLimit = 0.0f;
        float minimumSpan = 0.0f;
        float damping = 0.0f;
        uint8_t classification = 0;
        uint8_t family = 250;
        uint32_t acquisitionPeriod = 0xFFFFFFFFu;
        uint8_t properties = 0;
        uint32_t serial = 0;
        bool writable = false;
        bool unitsMatchRequired = false;
        std::span<const uint8_t> allowedUnits;
    };
    std::span<DeviceVariable> deviceVariables;
};

// Shared derived values used by Universal and Analog Channel commands.
float hartPercentOfRange(const HartExecutionVariables& variables) noexcept;
float hartLoopCurrentMilliamps(const HartExecutionVariables& variables) noexcept;

class HartCommandExecutor final {
public:
    /** Runs write -> resp -> after in order (FASE 76 gate) against `variables`
     * IN PLACE; only `resp` bytes reach `response`. `variables` is
     * intentionally a mutable reference (not a by-value working copy): a
     * write command's SET statements must be observable by the caller after
     * this returns, or the write has no real effect (see the doc comment on
     * `HartEngine::CommandProgramHook`). Returns false on any out-of-bounds
     * slice, map miss without default, or overflow -- never partially-written
     * garbage; on false, `variables` may hold a partial mutation from
     * whichever statement failed, so callers must not persist it when this
     * returns false. */
    static bool execute(const HartCompiledCommandProgram& program, HartExecutionVariables& variables,
                        std::span<const uint8_t> request, HartResponseBuilder& response) noexcept;
};

// Authoring helper: PACTware's `IDENTITY_BLOCK` macro, expanded at profile-
// construction time (cold path). Never traversed as a macro at runtime
// (FASE 77 gate). FE + manufacturer + device type + preambles + 4 revisions +
// flags (9 single bytes) + 3-byte device id = 12 bytes, matching the standard
// HART command-0 identity body.
std::vector<HartStatement> hartIdentityBlockMacro();

} // namespace lasecsimul::protocols

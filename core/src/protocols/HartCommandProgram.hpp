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
};

/** `$BODY`, `$BODY[a:b]`, hex literal, row/variable reference, `$code`. */
struct HartExpr {
    enum class Kind : uint8_t { RequestBody, BodySlice, HexConstant, Variable, LocalCode };
    Kind kind = Kind::RequestBody;
    size_t offset = 0;              // BodySlice
    size_t length = 0;               // BodySlice; 0 means "to end of body"
    std::vector<uint8_t> constant;   // HexConstant
    HartVarId variable = HartVarId::ManufacturerId; // Variable

    static HartExpr body() noexcept { return HartExpr{Kind::RequestBody, 0, 0, {}, {}}; }
    static HartExpr bodySlice(size_t offset, size_t length) noexcept {
        return HartExpr{Kind::BodySlice, offset, length, {}, {}};
    }
    static HartExpr hex(std::vector<uint8_t> bytes) noexcept {
        return HartExpr{Kind::HexConstant, 0, 0, std::move(bytes), {}};
    }
    static HartExpr hexByte(uint8_t byte) noexcept { return hex({byte}); }
    static HartExpr var(HartVarId id) noexcept { return HartExpr{Kind::Variable, 0, 0, {}, id}; }
    static HartExpr localCode() noexcept { return HartExpr{Kind::LocalCode, 0, 0, {}, {}}; }
};

struct HartStatement; // fwd

/** `APPEND` -- concatenate evaluated bytes into the response (SEQUENCE semantics
 * from a list of statements composing the resp/write/after stage). */
struct HartAppendStmt { HartExpr source; };

/** `SET(variable, value)` -- write-stage/after-stage side effect. */
struct HartSetStmt { HartVarId target; HartExpr value; };

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

using HartStatementNode = std::variant<HartAppendStmt, HartSetStmt, HartIfStmt, HartMapStmt, HartForCodesStmt>;
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
};

class HartCommandExecutor final {
public:
    /** Runs write -> resp -> after in order (FASE 76 gate) against a working
     * copy of `variables`; only `resp` bytes reach `response`. Returns false on
     * any out-of-bounds slice, map miss without default, or overflow -- never
     * partially-written garbage. */
    static bool execute(const HartCompiledCommandProgram& program, HartExecutionVariables variables,
                        std::span<const uint8_t> request, HartResponseBuilder& response) noexcept;
};

// Authoring helper: PACTware's `IDENTITY_BLOCK` macro, expanded at profile-
// construction time (cold path). Never traversed as a macro at runtime
// (FASE 77 gate). FE + manufacturer + device type + preambles + 4 revisions +
// flags (9 single bytes) + 3-byte device id = 12 bytes, matching the standard
// HART command-0 identity body.
std::vector<HartStatement> hartIdentityBlockMacro();

} // namespace lasecsimul::protocols

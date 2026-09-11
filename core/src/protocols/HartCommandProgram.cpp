#include "HartCommandProgram.hpp"

#include "HartTypeCodec.hpp"

#include <algorithm>
#include <optional>

namespace lasecsimul::protocols {

namespace {

size_t hartVarWidth(HartVarId id) noexcept {
    switch (id) {
        case HartVarId::DeviceId: return 3;
        case HartVarId::Tag: return 6;
        case HartVarId::PrimaryVariable: return 4;
        case HartVarId::Message: return 18;
        case HartVarId::Descriptor: return 12;
        case HartVarId::Date: return 3;
        case HartVarId::FinalAssemblyNumber: return 3;
        default: return 1;
    }
}

// Evaluates one expression to a byte span. Scalar/computed values are written
// into `scratch` and the returned span points into it; values with stable
// backing storage (constants, request slices, multi-byte identity fields) are
// returned directly. Returns std::nullopt on an out-of-bounds slice -- the
// caller must abort the whole command, never emit partial/garbage output
// (section 103 security requirement).
std::optional<std::span<const uint8_t>> evalExpr(const HartExpr& expr, const HartExecutionVariables& vars,
                                                  std::span<const uint8_t> request, uint8_t localCode,
                                                  std::array<uint8_t, 8>& scratch) noexcept {
    switch (expr.kind) {
        case HartExpr::Kind::RequestBody:
            return request;
        case HartExpr::Kind::BodySlice: {
            if (expr.offset > request.size()) return std::nullopt;
            const size_t available = request.size() - expr.offset;
            const size_t length = expr.length == 0 ? available : expr.length;
            if (length > available) return std::nullopt;
            return request.subspan(expr.offset, length);
        }
        case HartExpr::Kind::HexConstant:
            return std::span<const uint8_t>(expr.constant);
        case HartExpr::Kind::LocalCode:
            scratch[0] = localCode;
            return std::span<const uint8_t>(scratch.data(), 1);
        case HartExpr::Kind::Variable:
            switch (expr.variable) {
                case HartVarId::ManufacturerId: scratch[0] = vars.manufacturerId; return std::span(scratch.data(), 1);
                case HartVarId::DeviceType: scratch[0] = vars.deviceType; return std::span(scratch.data(), 1);
                case HartVarId::DeviceId: return std::span<const uint8_t>(vars.deviceId.data(), vars.deviceId.size());
                case HartVarId::NumRequestPreambles: scratch[0] = vars.numRequestPreambles; return std::span(scratch.data(), 1);
                case HartVarId::UniversalCommandRevision: scratch[0] = vars.universalCommandRevision; return std::span(scratch.data(), 1);
                case HartVarId::TransmitterSpecificRevision: scratch[0] = vars.transmitterSpecificRevision; return std::span(scratch.data(), 1);
                case HartVarId::SoftwareRevision: scratch[0] = vars.softwareRevision; return std::span(scratch.data(), 1);
                case HartVarId::HardwareRevisionAndSignal: scratch[0] = vars.hardwareRevisionAndSignal; return std::span(scratch.data(), 1);
                case HartVarId::Flags: scratch[0] = vars.flags; return std::span(scratch.data(), 1);
                case HartVarId::Tag: return std::span<const uint8_t>(vars.tagPacked.data(), vars.tagPacked.size());
                case HartVarId::PrimaryVariableUnit: scratch[0] = vars.primaryVariableUnit; return std::span(scratch.data(), 1);
                case HartVarId::PrimaryVariable: {
                    const auto encoded = HartTypeCodec::encodeFloat32BE(vars.primaryVariable);
                    std::copy(encoded.begin(), encoded.end(), scratch.begin());
                    return std::span<const uint8_t>(scratch.data(), 4);
                }
                case HartVarId::Message: return std::span<const uint8_t>(vars.messagePacked.data(), vars.messagePacked.size());
                case HartVarId::Descriptor: return std::span<const uint8_t>(vars.descriptorPacked.data(), vars.descriptorPacked.size());
                case HartVarId::Date: return std::span<const uint8_t>(vars.date.data(), vars.date.size());
                case HartVarId::FinalAssemblyNumber: return std::span<const uint8_t>(vars.finalAssemblyNumber.data(), vars.finalAssemblyNumber.size());
            }
            return std::nullopt;
        case HartExpr::Kind::UserVariable:
            for (const auto& value : vars.userVariables) {
                if (value.id != expr.variableId) continue;
                // Encode per the variable's OWN declared type, not always
                // Float32BE -- a user variable authored as UInt8/UInt16/
                // Int16/Bool in the Property Inspector must actually produce
                // that many bytes on the wire, or its "type" field is exactly
                // the class of decorative property (edited, persisted,
                // silently ignored by the runtime) this audit exists to find.
                switch (value.type) {
                    case HartVariableType::Float32: {
                        const auto encoded = HartTypeCodec::encodeFloat32BE(static_cast<float>(value.value));
                        std::copy(encoded.begin(), encoded.end(), scratch.begin());
                        return std::span<const uint8_t>(scratch.data(), encoded.size());
                    }
                    case HartVariableType::UInt8: {
                        const auto encoded = HartTypeCodec::encodeUnsignedBE(static_cast<uint32_t>(value.value), 1);
                        std::copy(encoded.begin(), encoded.end(), scratch.begin());
                        return std::span<const uint8_t>(scratch.data(), 1);
                    }
                    case HartVariableType::UInt16: {
                        const auto encoded = HartTypeCodec::encodeUnsignedBE(static_cast<uint32_t>(value.value), 2);
                        std::copy(encoded.begin(), encoded.end(), scratch.begin());
                        return std::span<const uint8_t>(scratch.data(), 2);
                    }
                    case HartVariableType::Int16: {
                        // Two's complement bit pattern via the same unsigned
                        // BE encoder -- static_cast<uint32_t> of a negative
                        // int16_t is well-defined modular conversion (C++20
                        // mandates two's complement).
                        const auto encoded = HartTypeCodec::encodeUnsignedBE(
                            static_cast<uint32_t>(static_cast<uint16_t>(static_cast<int16_t>(value.value))), 2);
                        std::copy(encoded.begin(), encoded.end(), scratch.begin());
                        return std::span<const uint8_t>(scratch.data(), 2);
                    }
                    case HartVariableType::Bool:
                        scratch[0] = value.value != 0.0 ? 1 : 0;
                        return std::span<const uint8_t>(scratch.data(), 1);
                    case HartVariableType::PackedAscii:
                        // A PackedAscii-typed value is textual; `UserVariable`
                        // only carries a numeric `double` today (see
                        // HartCommandProgram.hpp). Rather than silently
                        // encode garbage, this is a documented, real gap:
                        // fail the command instead of emitting wrong bytes.
                        // Closing it needs a string-valued variable slot,
                        // deliberately not added under this session's time
                        // budget -- see "Anexo D" known gaps.
                        return std::nullopt;
                }
                return std::nullopt;
            }
            return std::nullopt;
    }
    return std::nullopt;
}

bool bytesEqual(std::span<const uint8_t> a, std::span<const uint8_t> b) noexcept {
    return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin());
}

// Static worst-case byte-size estimate (FASE 35/50 bound analysis).
size_t estimateMaxBytes(const std::vector<HartStatement>& statements, size_t maxRequestBytes) noexcept;

size_t estimateExprMax(const HartExpr& expr, size_t maxRequestBytes) noexcept {
    switch (expr.kind) {
        case HartExpr::Kind::RequestBody: return maxRequestBytes;
        case HartExpr::Kind::BodySlice: return expr.length == 0 ? maxRequestBytes : expr.length;
        case HartExpr::Kind::HexConstant: return expr.constant.size();
        case HartExpr::Kind::LocalCode: return 1;
        case HartExpr::Kind::Variable: return hartVarWidth(expr.variable);
        case HartExpr::Kind::UserVariable: return 4;
    }
    return maxRequestBytes;
}

size_t estimateMaxBytes(const std::vector<HartStatement>& statements, size_t maxRequestBytes) noexcept {
    size_t total = 0;
    for (const HartStatement& statement : statements) {
        std::visit(
            [&](const auto& node) {
                using T = std::decay_t<decltype(node)>;
                if constexpr (std::is_same_v<T, HartAppendStmt>) {
                    total += estimateExprMax(node.source, maxRequestBytes);
                } else if constexpr (std::is_same_v<T, HartSetStmt>) {
                    // no response bytes
                } else if constexpr (std::is_same_v<T, HartIfStmt>) {
                    total += std::max(estimateMaxBytes(node.thenBranch, maxRequestBytes),
                                      estimateMaxBytes(node.elseBranch, maxRequestBytes));
                } else if constexpr (std::is_same_v<T, HartMapStmt>) {
                    size_t maxEntry = node.defaultValue.size();
                    for (const HartMapEntry& entry : node.table) maxEntry = std::max(maxEntry, entry.value.size());
                    total += maxEntry;
                } else if constexpr (std::is_same_v<T, HartForCodesStmt>) {
                    total += estimateMaxBytes(node.prefix, maxRequestBytes);
                    total += node.maxIterations * estimateMaxBytes(node.body, maxRequestBytes);
                }
            },
            statement.node);
    }
    return total;
}

std::string validateStatements(const std::vector<HartStatement>& statements, size_t maxRequestBytes,
                               size_t depth, std::string& error);

std::string validateExpr(const HartExpr& expr, size_t maxRequestBytes) {
    if (expr.kind == HartExpr::Kind::BodySlice && expr.length != 0 && expr.offset + expr.length > maxRequestBytes) {
        return "HART command body slice exceeds maximum request size";
    }
    return {};
}

std::string validateStatements(const std::vector<HartStatement>& statements, size_t maxRequestBytes,
                               size_t depth, std::string& error) {
    if (depth > 8) { error = "HART command nesting too deep"; return error; }
    for (const HartStatement& statement : statements) {
        std::visit(
            [&](const auto& node) {
                if (!error.empty()) return;
                using T = std::decay_t<decltype(node)>;
                if constexpr (std::is_same_v<T, HartAppendStmt>) {
                    error = validateExpr(node.source, maxRequestBytes);
                } else if constexpr (std::is_same_v<T, HartSetStmt>) {
                    switch (node.target) {
                        case HartVarId::Tag:
                        case HartVarId::PrimaryVariableUnit:
                        case HartVarId::PrimaryVariable:
                        case HartVarId::Message:
                        case HartVarId::Descriptor:
                        case HartVarId::Date:
                        case HartVarId::FinalAssemblyNumber:
                            break;
                        default:
                            error = "HART command SET targets a non-writable variable";
                            return;
                    }
                    error = validateExpr(node.value, maxRequestBytes);
                } else if constexpr (std::is_same_v<T, HartIfStmt>) {
                    error = validateExpr(node.lhs, maxRequestBytes);
                    if (error.empty()) error = validateExpr(node.rhs, maxRequestBytes);
                    if (error.empty()) error = validateStatements(node.thenBranch, maxRequestBytes, depth + 1, error);
                    if (error.empty()) error = validateStatements(node.elseBranch, maxRequestBytes, depth + 1, error);
                } else if constexpr (std::is_same_v<T, HartMapStmt>) {
                    error = validateExpr(node.key, maxRequestBytes);
                    for (size_t i = 0; error.empty() && i < node.table.size(); ++i) {
                        for (size_t j = 0; j < i; ++j) {
                            if (node.table[i].key == node.table[j].key) { error = "HART command MAP has duplicate keys"; break; }
                        }
                    }
                } else if constexpr (std::is_same_v<T, HartForCodesStmt>) {
                    if (node.maxIterations == 0 || node.maxIterations > 64) {
                        error = "HART command FOR_CODES iteration bound is not sane";
                        return;
                    }
                    error = validateExpr(node.source, maxRequestBytes);
                    if (error.empty()) error = validateStatements(node.prefix, maxRequestBytes, depth + 1, error);
                    if (error.empty()) error = validateStatements(node.body, maxRequestBytes, depth + 1, error);
                }
            },
            statement.node);
        if (!error.empty()) return error;
    }
    return error;
}

bool execStatements(const std::vector<HartStatement>& statements, HartExecutionVariables& vars,
                    std::span<const uint8_t> request, uint8_t localCode, HartResponseBuilder& response) noexcept;

bool execStatement(const HartStatement& statement, HartExecutionVariables& vars, std::span<const uint8_t> request,
                   uint8_t localCode, HartResponseBuilder& response) noexcept {
    return std::visit(
        [&](const auto& node) noexcept -> bool {
            using T = std::decay_t<decltype(node)>;
            if constexpr (std::is_same_v<T, HartAppendStmt>) {
                std::array<uint8_t, 8> scratch{};
                const auto bytes = evalExpr(node.source, vars, request, localCode, scratch);
                return bytes.has_value() && response.writeBytes(*bytes);
            } else if constexpr (std::is_same_v<T, HartSetStmt>) {
                std::array<uint8_t, 8> scratch{};
                const auto bytes = evalExpr(node.value, vars, request, localCode, scratch);
                if (!bytes.has_value()) return false;
                switch (node.target) {
                    case HartVarId::Tag:
                        if (bytes->size() != vars.tagPacked.size()) return false;
                        std::copy(bytes->begin(), bytes->end(), vars.tagPacked.begin());
                        return true;
                    case HartVarId::PrimaryVariableUnit:
                        if (bytes->size() != 1) return false;
                        vars.primaryVariableUnit = (*bytes)[0];
                        return true;
                    case HartVarId::PrimaryVariable:
                        if (bytes->size() != 4) return false;
                        vars.primaryVariable = HartTypeCodec::decodeFloat32BE(*bytes);
                        return true;
                    case HartVarId::Message:
                        if (bytes->size() != vars.messagePacked.size()) return false;
                        std::copy(bytes->begin(), bytes->end(), vars.messagePacked.begin());
                        return true;
                    case HartVarId::Descriptor:
                        if (bytes->size() != vars.descriptorPacked.size()) return false;
                        std::copy(bytes->begin(), bytes->end(), vars.descriptorPacked.begin());
                        return true;
                    case HartVarId::Date:
                        if (bytes->size() != vars.date.size()) return false;
                        std::copy(bytes->begin(), bytes->end(), vars.date.begin());
                        return true;
                    case HartVarId::FinalAssemblyNumber:
                        if (bytes->size() != vars.finalAssemblyNumber.size()) return false;
                        std::copy(bytes->begin(), bytes->end(), vars.finalAssemblyNumber.begin());
                        return true;
                    default: return false;
                }
            } else if constexpr (std::is_same_v<T, HartIfStmt>) {
                std::array<uint8_t, 8> lhsScratch{};
                std::array<uint8_t, 8> rhsScratch{};
                const auto lhs = evalExpr(node.lhs, vars, request, localCode, lhsScratch);
                const auto rhs = evalExpr(node.rhs, vars, request, localCode, rhsScratch);
                if (!lhs.has_value() || !rhs.has_value()) return false;
                const bool equal = bytesEqual(*lhs, *rhs);
                return execStatements(equal ? node.thenBranch : node.elseBranch, vars, request, localCode, response);
            } else if constexpr (std::is_same_v<T, HartMapStmt>) {
                std::array<uint8_t, 8> scratch{};
                const auto key = evalExpr(node.key, vars, request, localCode, scratch);
                if (!key.has_value()) return false;
                for (const HartMapEntry& entry : node.table) {
                    if (bytesEqual(*key, std::span<const uint8_t>(entry.key))) {
                        return response.writeBytes(entry.value);
                    }
                }
                return response.writeBytes(node.defaultValue);
            } else if constexpr (std::is_same_v<T, HartForCodesStmt>) {
                if (!execStatements(node.prefix, vars, request, localCode, response)) return false;
                std::array<uint8_t, 8> sourceScratch{};
                const auto source = evalExpr(node.source, vars, request, localCode, sourceScratch);
                if (!source.has_value()) return false;
                const size_t count = std::min(source->size(), node.maxIterations);
                for (size_t i = 0; i < count; ++i) {
                    if (!execStatements(node.body, vars, request, (*source)[i], response)) return false;
                }
                return true;
            }
            return false;
        },
        statement.node);
}

bool execStatements(const std::vector<HartStatement>& statements, HartExecutionVariables& vars,
                    std::span<const uint8_t> request, uint8_t localCode, HartResponseBuilder& response) noexcept {
    for (const HartStatement& statement : statements) {
        if (!execStatement(statement, vars, request, localCode, response)) return false;
    }
    return true;
}

} // namespace

HartCommandCompileResult HartCommandCompiler::compile(HartCommandDefinition definition, size_t maxRequestBytes,
                                                       size_t maxResponseBytes) {
    HartCommandCompileResult result;
    std::string error;
    if (!validateStatements(definition.write, maxRequestBytes, 0, error).empty() ||
        !validateStatements(definition.resp, maxRequestBytes, 0, error).empty() ||
        !validateStatements(definition.after, maxRequestBytes, 0, error).empty()) {
        result.error = error;
        return result;
    }
    const size_t estimated = estimateMaxBytes(definition.resp, maxRequestBytes);
    if (estimated > maxResponseBytes) {
        result.error = "HART command worst-case response exceeds frame limit";
        return result;
    }
    result.success = true;
    result.program.maxResponseBytes = estimated;
    result.program.definition = std::move(definition);
    return result;
}

bool HartCommandExecutor::execute(const HartCompiledCommandProgram& program, HartExecutionVariables& variables,
                                  std::span<const uint8_t> request, HartResponseBuilder& response) noexcept {
    HartResponseBuilder discard(program.maxResponseBytes + 1);
    if (!execStatements(program.definition.write, variables, request, 0, discard)) return false;
    if (!execStatements(program.definition.resp, variables, request, 0, response)) return false;
    return execStatements(program.definition.after, variables, request, 0, discard);
}

std::vector<HartStatement> hartIdentityBlockMacro() {
    return {
        HartStatement{HartAppendStmt{HartExpr::hexByte(0xFE)}},
        HartStatement{HartAppendStmt{HartExpr::var(HartVarId::ManufacturerId)}},
        HartStatement{HartAppendStmt{HartExpr::var(HartVarId::DeviceType)}},
        HartStatement{HartAppendStmt{HartExpr::var(HartVarId::NumRequestPreambles)}},
        HartStatement{HartAppendStmt{HartExpr::var(HartVarId::UniversalCommandRevision)}},
        HartStatement{HartAppendStmt{HartExpr::var(HartVarId::TransmitterSpecificRevision)}},
        HartStatement{HartAppendStmt{HartExpr::var(HartVarId::SoftwareRevision)}},
        HartStatement{HartAppendStmt{HartExpr::var(HartVarId::HardwareRevisionAndSignal)}},
        HartStatement{HartAppendStmt{HartExpr::var(HartVarId::Flags)}},
        HartStatement{HartAppendStmt{HartExpr::var(HartVarId::DeviceId)}},
    };
}

} // namespace lasecsimul::protocols

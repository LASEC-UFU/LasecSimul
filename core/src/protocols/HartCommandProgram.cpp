#include "HartCommandProgram.hpp"

#include "HartTypeCodec.hpp"

#include <algorithm>
#include <cmath>
#include <optional>

namespace lasecsimul::protocols {

float hartPercentOfRange(const HartExecutionVariables& variables) noexcept {
    const float span = variables.upperRangeValue - variables.lowerRangeValue;
    return span != 0.0f ? 100.0f * (variables.primaryVariable - variables.lowerRangeValue) / span : 0.0f;
}

float hartLoopCurrentMilliamps(const HartExecutionVariables& variables) noexcept {
    if (variables.fixedCurrentMode) return variables.fixedCurrentMilliamps;
    const float calculated = 4.0f + 16.0f * (hartPercentOfRange(variables) / 100.0f);
    return (calculated + variables.loopCurrentZeroTrim) * variables.loopCurrentGainTrim;
}

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
        case HartVarId::LongTag: return 32;
        case HartVarId::UpperRangeValue: return 4;
        case HartVarId::LowerRangeValue: return 4;
        default: return 1;
    }
}

HartExecutionVariables::DeviceVariable* selectedDeviceVariable(HartExecutionVariables& vars, uint8_t code) noexcept {
    for (auto& variable : vars.deviceVariables) if (variable.code == code) return &variable;
    // Legacy Universal Command 9/33 fixtures used code 0 for PV before the
    // Common Practice Table 34 code 246 was modeled. Keep that alias only in
    // the cold-resolved handle table; no string/name lookup is involved.
    if (code == 0) for (auto& variable : vars.deviceVariables) if (variable.code == 246) return &variable;
    return nullptr;
}

// Evaluates one expression to a byte span. Scalar/computed values are written
// into `scratch` and the returned span points into it; values with stable
// backing storage (constants, request slices, multi-byte identity fields) are
// returned directly. Returns std::nullopt on an out-of-bounds slice -- the
// caller must abort the whole command, never emit partial/garbage output
// (section 103 security requirement).
std::optional<std::span<const uint8_t>> evalExpr(const HartExpr& expr, HartExecutionVariables& vars,
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
                case HartVarId::PrimaryVariableUnit: {
                    // PV units have one authority: Device Variable code 246.
                    // The profile value is only the initialization fallback.
                    if (auto* pv = selectedDeviceVariable(vars, 246)) scratch[0] = pv->units;
                    else scratch[0] = vars.primaryVariableUnit;
                    return std::span(scratch.data(), 1);
                }
                case HartVarId::PrimaryVariable: {
                    const auto encoded = HartTypeCodec::encodeFloat32BE(vars.primaryVariable);
                    std::copy(encoded.begin(), encoded.end(), scratch.begin());
                    return std::span<const uint8_t>(scratch.data(), 4);
                }
                case HartVarId::Message: return std::span<const uint8_t>(vars.messagePacked.data(), vars.messagePacked.size());
                case HartVarId::Descriptor: return std::span<const uint8_t>(vars.descriptorPacked.data(), vars.descriptorPacked.size());
                case HartVarId::Date: return std::span<const uint8_t>(vars.date.data(), vars.date.size());
                case HartVarId::FinalAssemblyNumber: return std::span<const uint8_t>(vars.finalAssemblyNumber.data(), vars.finalAssemblyNumber.size());
                case HartVarId::LongTag: return std::span<const uint8_t>(vars.longTag.data(), vars.longTag.size());
                case HartVarId::PollingAddress: scratch[0] = vars.pollingAddress; return std::span(scratch.data(), 1);
                case HartVarId::LoopCurrentMode: scratch[0] = vars.loopCurrentMode; return std::span(scratch.data(), 1);
                case HartVarId::UpperRangeValue: {
                    const auto encoded = HartTypeCodec::encodeFloat32BE(vars.upperRangeValue);
                    std::copy(encoded.begin(), encoded.end(), scratch.begin());
                    return std::span<const uint8_t>(scratch.data(), 4);
                }
                case HartVarId::LowerRangeValue: {
                    const auto encoded = HartTypeCodec::encodeFloat32BE(vars.lowerRangeValue);
                    std::copy(encoded.begin(), encoded.end(), scratch.begin());
                    return std::span<const uint8_t>(scratch.data(), 4);
                }
                case HartVarId::PvTransferFunctionCode: scratch[0] = vars.pvTransferFunctionCode; return std::span(scratch.data(), 1);
                case HartVarId::AlarmSelectionCode: scratch[0] = vars.alarmSelectionCode; return std::span(scratch.data(), 1);
                case HartVarId::WriteProtectCode: scratch[0] = vars.writeProtectCode; return std::span(scratch.data(), 1);
            }
            return std::nullopt;
        case HartExpr::Kind::PercentOfRange:
        case HartExpr::Kind::LoopCurrentMilliamps: {
            // HCF_SPEC-127 6.3: Percent of Range follows PV linearly between
            // Lower/Upper Range Value; Loop Current is the standard 4-20mA
            // mapping of that same percent. A zero-span range (URV==LRV) is
            // a degenerate device misconfiguration this project cannot fix
            // up -- 0% is the defined fallback rather than propagating
            // NaN/Inf into the response.
            const float percent = hartPercentOfRange(vars);
            const float calculated = hartLoopCurrentMilliamps(vars);
            const float value = expr.kind == HartExpr::Kind::PercentOfRange
                ? percent
                : calculated;
            const auto encoded = HartTypeCodec::encodeFloat32BE(value);
            std::copy(encoded.begin(), encoded.end(), scratch.begin());
            return std::span<const uint8_t>(scratch.data(), 4);
        }
        case HartExpr::Kind::DeviceVariable: {
            auto* variable = selectedDeviceVariable(vars, localCode);
            if (expr.deviceVariableField == HartDeviceVariableField::Code) {
                scratch[0] = variable ? variable->code : localCode;
                return std::span<const uint8_t>(scratch.data(), 1);
            }
            const auto emitFloat = [&](float value) -> std::span<const uint8_t> {
                const auto encoded = HartTypeCodec::encodeFloat32BE(value);
                std::copy(encoded.begin(), encoded.end(), scratch.begin());
                return std::span<const uint8_t>(scratch.data(), 4);
            };
            const auto emitU32 = [&](uint32_t value) -> std::span<const uint8_t> {
                const auto encoded = HartTypeCodec::encodeUnsignedBE(value, 4);
                std::copy(encoded.begin(), encoded.end(), scratch.begin());
                return std::span<const uint8_t>(scratch.data(), 4);
            };
            if (!variable) {
                switch (expr.deviceVariableField) {
                    case HartDeviceVariableField::Units: scratch[0] = 250; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::Value:
                    case HartDeviceVariableField::UpperLimit:
                    case HartDeviceVariableField::LowerLimit:
                    case HartDeviceVariableField::MinimumSpan:
                    case HartDeviceVariableField::Damping: {
                        static constexpr std::array<uint8_t, 4> kNotUsed{0x7F, 0xA0, 0x00, 0x00};
                        return std::span<const uint8_t>(kNotUsed.data(), kNotUsed.size());
                    }
                    // HCF_SPEC-151 7.22 footnotes 40/41: Classification "not
                    // supported" -> 0 (Not Yet Implemented); Family "not
                    // supported" -> 250 (Not Used). Both are single-byte
                    // Enums (confirmed by the spec's own revision history:
                    // "Included Response Data Byte 21, Variable
                    // Classification" -- ONE byte, not the 4-byte float this
                    // field was wrongly emitting before this fix).
                    case HartDeviceVariableField::ClassificationCode: scratch[0] = 0; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::Family: scratch[0] = 250; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::AcquisitionPeriod: return emitU32(0xFFFFFFFFu);
                    case HartDeviceVariableField::Serial: scratch[0] = scratch[1] = scratch[2] = 0; return std::span(scratch.data(), 3);
                    case HartDeviceVariableField::Status: scratch[0] = 0x30; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::Properties: scratch[0] = 0; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::WriteMode: scratch[0] = 0; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::Code: break;
                }
            } else {
                switch (expr.deviceVariableField) {
                    case HartDeviceVariableField::Units: scratch[0] = variable->units; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::Value: return emitFloat(variable->value);
                    case HartDeviceVariableField::Status: scratch[0] = variable->status; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::UpperLimit: return emitFloat(variable->upperLimit);
                    case HartDeviceVariableField::LowerLimit: return emitFloat(variable->lowerLimit);
                    case HartDeviceVariableField::MinimumSpan: return emitFloat(variable->minimumSpan);
                    case HartDeviceVariableField::Damping: return emitFloat(variable->damping);
                    // Classification is a single byte (HCF_SPEC-151 7.22
                    // byte 21, per the spec's own revision history) --
                    // `ClassificationCode` is the ONE authority for it. A
                    // second `Classification` case here previously emitted
                    // 4 bytes (an incorrect float encoding of the same
                    // underlying `variable->classification` byte); removed
                    // rather than fixed-in-place, since having two accessors
                    // for one field is itself the defect (section 18: one
                    // semantic property, one authority).
                    case HartDeviceVariableField::ClassificationCode: scratch[0] = variable->classification; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::Family: scratch[0] = variable->family; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::AcquisitionPeriod: return emitU32(variable->acquisitionPeriod);
                    case HartDeviceVariableField::Properties: scratch[0] = variable->properties; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::WriteMode: scratch[0] = (variable->properties & 0x80) ? 1 : 0; return std::span(scratch.data(), 1);
                    case HartDeviceVariableField::Serial:
                        scratch[0] = static_cast<uint8_t>(variable->serial >> 16); scratch[1] = static_cast<uint8_t>(variable->serial >> 8); scratch[2] = static_cast<uint8_t>(variable->serial); return std::span(scratch.data(), 3);
                    case HartDeviceVariableField::Code: break;
                }
            }
            return std::nullopt;
        }
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
        case HartExpr::Kind::LoopCurrentMilliamps: return 4;
        case HartExpr::Kind::PercentOfRange: return 4;
        case HartExpr::Kind::DeviceVariable:
            switch (expr.deviceVariableField) {
                case HartDeviceVariableField::Code:
                case HartDeviceVariableField::Units:
                case HartDeviceVariableField::Status:
                case HartDeviceVariableField::ClassificationCode:
                case HartDeviceVariableField::Family:
                case HartDeviceVariableField::Properties:
                case HartDeviceVariableField::WriteMode: return 1;
                case HartDeviceVariableField::Serial: return 3;
                default: return 4;
            }
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
                } else if constexpr (std::is_same_v<T, HartSetDeviceVariableStmt> ||
                                     std::is_same_v<T, HartGuardDeviceVariableStmt>) {
                    // side effect/validation only
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
                        case HartVarId::LongTag:
                        case HartVarId::PollingAddress:
                        case HartVarId::LoopCurrentMode:
                        case HartVarId::PvTransferFunctionCode:
                        case HartVarId::AlarmSelectionCode:
                        case HartVarId::WriteProtectCode:
                            break;
                        default:
                            error = "HART command SET targets a non-writable variable";
                            return;
                    }
                    error = validateExpr(node.value, maxRequestBytes);
                } else if constexpr (std::is_same_v<T, HartSetDeviceVariableStmt>) {
                    error = validateExpr(node.value, maxRequestBytes);
                } else if constexpr (std::is_same_v<T, HartGuardDeviceVariableStmt>) {
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
            } else if constexpr (std::is_same_v<T, HartSetDeviceVariableStmt>) {
                std::array<uint8_t, 8> scratch{};
                const auto bytes = evalExpr(node.value, vars, request, localCode, scratch);
                auto* variable = selectedDeviceVariable(vars, localCode);
                if (!bytes.has_value() || !variable) return false;
                switch (node.target) {
                    case HartDeviceVariableField::Value:
                        if (bytes->size() != 4) return false;
                        variable->value = HartTypeCodec::decodeFloat32BE(*bytes);
                        return std::isfinite(variable->value);
                case HartDeviceVariableField::Damping:
                        if (bytes->size() != 4) return false;
                        variable->damping = HartTypeCodec::decodeFloat32BE(*bytes);
                        return std::isfinite(variable->damping) && variable->damping >= 0.0f;
                    case HartDeviceVariableField::WriteMode:
                        if (bytes->size() != 1 || ((*bytes)[0] != 0 && (*bytes)[0] != 1)) return false;
                        if ((*bytes)[0]) variable->properties |= 0x80; else variable->properties &= static_cast<uint8_t>(~0x80u);
                        return true;
                    case HartDeviceVariableField::Units: {
                        if (bytes->size() != 1 || (*bytes)[0] == 250 || (*bytes)[0] == 255) return false;
                        if (!variable->allowedUnits.empty() && std::find(variable->allowedUnits.begin(), variable->allowedUnits.end(), (*bytes)[0]) == variable->allowedUnits.end()) return false;
                        variable->units = (*bytes)[0]; return true;
                    }
                    default: return false;
                }
            } else if constexpr (std::is_same_v<T, HartGuardDeviceVariableStmt>) {
                std::array<uint8_t, 8> scratch{};
                const auto bytes = evalExpr(node.value, vars, request, localCode, scratch);
                auto* variable = selectedDeviceVariable(vars, localCode);
                if (node.guard == HartDeviceVariableGuard::Exists) return variable != nullptr;
                if (!variable || !bytes.has_value()) return false;
                if (node.guard == HartDeviceVariableGuard::Writable) return variable->writable;
                if (node.guard == HartDeviceVariableGuard::UnitsMatch)
                    return bytes->size() == 1 && (*bytes)[0] == variable->units;
                return bytes->size() == 1 && ((*bytes)[0] == 0 || (*bytes)[0] == 1);
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
                        if (auto* pv = selectedDeviceVariable(vars, 246)) pv->units = (*bytes)[0];
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
                    case HartVarId::LongTag:
                        if (bytes->size() != vars.longTag.size()) return false;
                        std::copy(bytes->begin(), bytes->end(), vars.longTag.begin());
                        return true;
                    case HartVarId::PollingAddress:
                        if (bytes->size() != 1 || (*bytes)[0] > 63) return false;
                        vars.pollingAddress = (*bytes)[0];
                        return true;
                    case HartVarId::LoopCurrentMode:
                        if (bytes->size() != 1 || (*bytes)[0] > 1) return false;
                        vars.loopCurrentMode = (*bytes)[0];
                        return true;
                    case HartVarId::PvTransferFunctionCode:
                        if (bytes->size() != 1) return false;
                        vars.pvTransferFunctionCode = (*bytes)[0];
                        return true;
                    case HartVarId::AlarmSelectionCode:
                        if (bytes->size() != 1) return false;
                        vars.alarmSelectionCode = (*bytes)[0];
                        return true;
                    case HartVarId::WriteProtectCode:
                        if (bytes->size() != 1) return false;
                        vars.writeProtectCode = (*bytes)[0];
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

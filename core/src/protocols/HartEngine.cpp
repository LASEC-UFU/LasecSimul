#include "HartEngine.hpp"
#include "HartTypeCodec.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>

namespace lasecsimul::protocols {

namespace {
std::array<uint8_t, 3> parseDeviceIdHexEngine(std::string_view text) noexcept {
    std::array<uint8_t, 3> result{};
    auto nibble = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (size_t i = 0; i < 3 && i * 2 + 1 < text.size(); ++i) {
        const int hi = nibble(text[i * 2]);
        const int lo = nibble(text[i * 2 + 1]);
        if (hi < 0 || lo < 0) break;
        result[i] = static_cast<uint8_t>((hi << 4) | lo);
    }
    return result;
}

std::array<uint8_t, 7> encodeDateTimeEngine(uint64_t seconds) noexcept {
    const uint64_t days = seconds / 86400u;
    const uint64_t z = days + 693901u;
    const uint64_t era = z / 146097u;
    const uint64_t doe = z - era * 146097u;
    const uint64_t yoe = (doe - doe / 1460u + doe / 36524u - doe / 146096u) / 365u;
    uint64_t year = yoe + era * 400u;
    const uint64_t doy = doe - (365u * yoe + yoe / 4u - yoe / 100u);
    const uint64_t mp = (5u * doy + 2u) / 153u;
    const uint64_t day = doy - (153u * mp + 2u) / 5u + 1u;
    const uint64_t month = mp < 10u ? mp + 3u : mp - 9u;
    year += month <= 2u;
    const uint32_t time = static_cast<uint32_t>(seconds % 86400u);
    return {static_cast<uint8_t>(day), static_cast<uint8_t>(month), static_cast<uint8_t>(year - 1900u),
            static_cast<uint8_t>(time >> 24), static_cast<uint8_t>(time >> 16),
            static_cast<uint8_t>(time >> 8), static_cast<uint8_t>(time)};
}

std::array<uint8_t, 4> encodeFloatEngine(float value) noexcept {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof bits);
    return {static_cast<uint8_t>(bits >> 24), static_cast<uint8_t>(bits >> 16),
            static_cast<uint8_t>(bits >> 8), static_cast<uint8_t>(bits)};
}
}

bool HartResponseBuilder::writeByte(uint8_t value) noexcept {
    if (m_size >= m_bytes.size()) { m_overflow = true; return false; }
    m_bytes[m_size++] = value;
    return true;
}

bool HartResponseBuilder::writeBytes(std::span<const uint8_t> values) noexcept {
    if (values.size() > m_bytes.size() - m_size) { m_overflow = true; return false; }
    std::copy(values.begin(), values.end(), m_bytes.begin() + static_cast<std::vector<uint8_t>::difference_type>(m_size));
    m_size += values.size();
    return true;
}

bool HartResponseBuilder::writeAscii(std::string_view value) noexcept {
    return writeBytes({reinterpret_cast<const uint8_t*>(value.data()), value.size()});
}

bool HartPayloadReader::readByte(uint8_t& value) noexcept {
    if (m_offset >= m_bytes.size()) return false;
    value = m_bytes[m_offset++];
    return true;
}

bool HartPayloadReader::readU16(uint16_t& value) noexcept {
    if (m_bytes.size() - m_offset < 2) return false;
    value = static_cast<uint16_t>(m_bytes[m_offset] << 8 | m_bytes[m_offset + 1]);
    m_offset += 2;
    return true;
}

bool HartPayloadReader::readU32(uint32_t& value) noexcept {
    if (m_bytes.size() - m_offset < 4) return false;
    value = (static_cast<uint32_t>(m_bytes[m_offset]) << 24) |
            (static_cast<uint32_t>(m_bytes[m_offset + 1]) << 16) |
            (static_cast<uint32_t>(m_bytes[m_offset + 2]) << 8) |
            static_cast<uint32_t>(m_bytes[m_offset + 3]);
    m_offset += 4;
    return true;
}

bool HartPayloadReader::readBytes(size_t count, std::span<const uint8_t>& value) noexcept {
    if (count > m_bytes.size() - m_offset) return false;
    value = m_bytes.subspan(m_offset, count);
    m_offset += count;
    return true;
}

uint8_t HartFrameCodec::checksum(std::span<const uint8_t> bytes) noexcept {
    uint8_t result = 0;
    for (uint8_t byte : bytes) result ^= byte;
    return result;
}

bool HartFrameCodec::decode(std::span<const uint8_t> wire, HartFrame& frame,
                            size_t maxPayload) noexcept {
    // Semantic HART frame used by the virtual engine:
    // delimiter, short address, command, byte-count, payload, XOR checksum.
    if (wire.size() < 5 || wire[0] != 0x02) return false;
    const size_t payloadSize = wire[3];
    if (payloadSize > maxPayload || wire.size() != payloadSize + 5) return false;
    if (checksum(wire.first(wire.size() - 1)) != wire.back()) return false;
    frame.pollingAddress = wire[1];
    frame.command = wire[2];
    frame.payload.assign(wire.begin() + 4, wire.begin() + 4 + static_cast<std::span<const uint8_t>::difference_type>(payloadSize));
    return true;
}

bool HartFrameCodec::encode(const HartFrame& frame, HartResponseBuilder& output,
                            size_t maxPayload) noexcept {
    if (frame.payload.size() > maxPayload || frame.payload.size() > 255) return false;
    const size_t start = output.size();
    if (!output.writeByte(0x02) || !output.writeByte(frame.pollingAddress) ||
        !output.writeByte(static_cast<uint8_t>(frame.command)) ||
        !output.writeByte(static_cast<uint8_t>(frame.payload.size())) ||
        !output.writeBytes(frame.payload)) return false;
    const auto encoded = output.bytes();
    return output.writeByte(checksum(encoded.subspan(start)));
}

bool HartCommandRegistry::registerHandler(IHartCommandHandler& handler) {
    const auto [it, inserted] = m_handlers.emplace(handler.command(), &handler);
    return inserted && it->second == &handler;
}

bool HartCommandRegistry::remove(HartCommandId command) noexcept {
    return m_handlers.erase(command) != 0;
}

IHartCommandHandler* HartCommandRegistry::find(HartCommandId command) const noexcept {
    const auto it = m_handlers.find(command);
    return it == m_handlers.end() ? nullptr : it->second;
}

bool HartProfileRegistry::registerProfile(HartDeviceProfile profile) {
    if (profile.id.empty() || profile.version == 0) return false;
    const auto [it, inserted] = m_profiles.emplace(profile.id, std::move(profile));
    return inserted && !it->second.id.empty();
}

bool HartProfileRegistry::remove(std::string_view id) noexcept {
    return m_profiles.erase(std::string(id)) != 0;
}

const HartDeviceProfile* HartProfileRegistry::find(std::string_view id) const noexcept {
    const auto it = m_profiles.find(std::string(id));
    return it == m_profiles.end() ? nullptr : &it->second;
}

HartPlanCompileResult HartPlanCompiler::compile(std::span<const HartDevicePlan> devices,
                                                const HartProfileRegistry& profiles) {
    HartPlanCompileResult result;
    for (const HartDevicePlan& device : devices) {
        if (device.id.empty()) { result.error = "HART device id is empty"; return result; }
        if (device.bus.empty()) { result.error = "HART bus is empty"; return result; }
        if (device.pollingAddress > 63) { result.error = "HART polling address out of range"; return result; }
        if (!profiles.find(device.profileId)) { result.error = "HART profile not found: " + device.profileId; return result; }
        for (size_t i = 0; i < device.commandConfigurations.size(); ++i) {
            const auto& configuration = device.commandConfigurations[i];
            const bool declaredByProfile = std::any_of(profiles.find(device.profileId)->commands.begin(),
                                                       profiles.find(device.profileId)->commands.end(),
                                                       [&](const HartCommandDescriptor& descriptor) {
                                                           return descriptor.id == configuration.command;
                                                       });
            // A profile-declared command may be disabled or given a static
            // response override (that's what this list was originally for). A
            // command the profile does NOT know about may only appear here as a
            // plain additive declaration (enabled, no static override) -- that's
            // how a device gains a custom/vendor command id without mutating the
            // shared profile object (HartEngine::execute() checks this same list
            // for exactly that). Disabling or static-overriding an undeclared
            // command has no coherent meaning, so it stays rejected.
            if (!declaredByProfile && (!configuration.enabled || configuration.hasStaticResponse)) {
                result.error = "HART command override is not declared by profile"; return result;
            }
            if (configuration.staticResponse.size() > 255) {
                result.error = "HART command override response exceeds frame limit"; return result;
            }
            for (size_t j = 0; j < i; ++j) {
                if (device.commandConfigurations[j].command == configuration.command) {
                    result.error = "duplicate HART command override"; return result;
                }
            }
        }
        for (size_t i = 0; i < device.variables.size(); ++i) {
            const auto& variable = device.variables[i];
            if (variable.id.empty()) { result.error = "HART variable id is empty"; return result; }
            if (!std::isfinite(variable.value)) { result.error = "HART variable value is not finite"; return result; }
            for (size_t j = 0; j < i; ++j)
                if (device.variables[j].id == variable.id) { result.error = "duplicate HART variable id"; return result; }
        }
        for (const HartDevicePlan& prior : result.plan.devices) {
            if (prior.id == device.id) { result.error = "duplicate HART device id"; return result; }
            if (prior.bus == device.bus && prior.pollingAddress == device.pollingAddress) {
                result.error = "duplicate HART address on bus: " + device.bus; return result;
            }
        }
        result.plan.devices.push_back(device);
    }
    result.success = true;
    return result;
}

HartEngine::HartEngine(const HartProfileRegistry& profiles) : m_profiles(profiles) {}

void HartEngine::setVirtualTimeSeconds(uint64_t seconds) noexcept {
    const uint64_t previous = m_virtualTimeSeconds;
    m_virtualTimeSeconds = seconds;
    if (seconds >= previous) advanceVirtualState(previous, seconds);
}

void HartEngine::sampleTrend(RuntimeDevice& device, size_t trendIndex, uint64_t timestamp) noexcept {
    if (trendIndex >= device.plan.trendCount || trendIndex >= device.plan.trends.size()) return;
    const auto& configuration = device.plan.trends[trendIndex];
    if (configuration.control == 0) return;
    float value = std::numeric_limits<float>::quiet_NaN();
    if (configuration.deviceVariableCode == 246) {
        value = static_cast<float>(evaluatePrimary(device));
        for (const auto& variable : device.plan.variables)
            if (variable.deviceVariableCode == 246) value += variable.trimAdjustment;
    } else {
        for (size_t i = 0; i < device.plan.variables.size() && i < device.variableValues.size(); ++i)
            if (device.plan.variables[i].deviceVariableCode == configuration.deviceVariableCode)
                value = static_cast<float>(device.variableValues[i] + device.plan.variables[i].trimAdjustment);
    }
    auto& count = device.trendSampleCounts[trendIndex];
    auto& next = device.trendSampleNext[trendIndex];
    auto& slot = device.trendSamples[trendIndex][next];
    slot.timestamp = timestamp; slot.value = value; slot.status = std::isfinite(value) ? 0 : 0x30;
    next = static_cast<uint8_t>((next + 1) % 12);
    if (count < 12) ++count;
}

void HartEngine::runDueActions(RuntimeDevice& device, uint64_t previous, uint64_t current) noexcept {
    if (device.plan.actionCount == 0 || current < previous) return;
    for (size_t i = 0; i < device.plan.actionCount && i < device.plan.synchronousActions.size(); ++i) {
        auto& action = device.plan.synchronousActions[i];
        // A virtual-time jump may cross the trigger without landing exactly
        // on it.  Once the current instant has reached the trigger, execute
        // it; the one-shot/recurring policy below prevents duplicate fires.
        if ((action.control & 0x80) == 0 || device.actionFired[i] || action.triggerSeconds > current) continue;
        if ((action.control & 0x01) != 0) {
            const auto& commandAction = device.plan.commandActions[i];
            HartResponseBuilder ignored(255);
            execute(device.plan.bus, device.plan.pollingAddress, commandAction.command, commandAction.requestData, ignored, 0, 1);
        }
        device.actionFired[i] = true;
        if ((action.control & 0x10) != 0) action.control = static_cast<uint8_t>(action.control & ~0x80u);
        else action.triggerSeconds += 86400u;
    }
}

void HartEngine::advanceVirtualState(uint64_t previous, uint64_t current) noexcept {
    for (RuntimeDevice& device : m_devices) {
        for (size_t i = 0; i < device.plan.trendCount && i < device.plan.trends.size(); ++i) {
            const auto& configuration = device.plan.trends[i];
            if (configuration.control == 0 || configuration.samplePeriodSeconds == 0) continue;
            if (device.trendNextSampleTime[i] == 0) device.trendNextSampleTime[i] = previous + configuration.samplePeriodSeconds;
            size_t guard = 0;
            while (device.trendNextSampleTime[i] <= current && guard++ < 64) {
                sampleTrend(device, i, device.trendNextSampleTime[i]);
                device.trendNextSampleTime[i] += configuration.samplePeriodSeconds;
            }
        }
        runDueActions(device, previous, current);
        runDueBursts(device, previous, current);
    }
}

namespace {
uint64_t burstPeriodSeconds(uint32_t ticks) noexcept {
    if (ticks == 0) return 1;
    return std::max<uint64_t>(1, (static_cast<uint64_t>(ticks) + 31999u) / 32000u);
}
}

void HartEngine::runDueBursts(RuntimeDevice& device, uint64_t previous, uint64_t current) noexcept {
    if (current < previous || device.plan.burstMessageCount == 0) return;
    for (size_t index = 0; index < device.plan.burstMessageCount && index < device.plan.burstMessages.size(); ++index) {
        auto& configuration = device.plan.burstMessages[index];
        if (configuration.control == 0 || configuration.command == 0xFFFF) continue;
        const uint64_t maximumPeriod = burstPeriodSeconds(configuration.maximumUpdatePeriodTicks);
        if (device.burstNextSampleTime[index] == 0) device.burstNextSampleTime[index] = previous + maximumPeriod;
        size_t guard = 0;
        while (device.burstNextSampleTime[index] <= current && guard++ < 64) {
            RuntimeDevice* source = &device;
            if (!configuration.mappedSubDeviceId.empty()) {
                auto mapped = std::find_if(m_devices.begin(), m_devices.end(), [&](const RuntimeDevice& candidate) {
                    return candidate.plan.id == configuration.mappedSubDeviceId;
                });
                if (mapped == m_devices.end()) { device.burstNextSampleTime[index] += maximumPeriod; continue; }
                source = &*mapped;
            }
            float triggerSource = static_cast<float>(evaluatePrimary(*source));
            if (configuration.deviceVariableCodes[0] != 250 && configuration.deviceVariableCodes[0] != 246) {
                for (size_t i = 0; i < source->plan.variables.size(); ++i)
                    if (source->plan.variables[i].deviceVariableCode == configuration.deviceVariableCodes[0])
                        triggerSource = static_cast<float>(source->variableValues[i]);
            }
            const bool triggered = configuration.triggerMode == 0 ||
                (configuration.triggerMode == 1 && std::isfinite(configuration.triggerValue) &&
                 (!std::isfinite(device.burstLastValues[index]) || std::fabs(triggerSource - device.burstLastValues[index]) >= configuration.triggerValue)) ||
                (configuration.triggerMode == 2 && std::isfinite(configuration.triggerValue) && triggerSource > configuration.triggerValue) ||
                (configuration.triggerMode == 3 && std::isfinite(configuration.triggerValue) && triggerSource < configuration.triggerValue);
            HartResponseBuilder burstResponse(255);
            const bool emitted = execute(source->plan.bus, source->plan.pollingAddress, configuration.command, {}, burstResponse, 0, 1);
            if (emitted && device.burstEvents.size() < 32) {
                HartBurstEvent event;
                event.deviceId = source->plan.id;
                event.burstMessage = static_cast<uint8_t>(index);
                event.command = configuration.command;
                event.timestamp = device.burstNextSampleTime[index];
                event.payload.assign(burstResponse.bytes().begin(), burstResponse.bytes().end());
                device.burstEvents.push_back(std::move(event));
            }
            device.burstLastValues[index] = triggerSource;
            device.burstNextSampleTime[index] += burstPeriodSeconds(triggered ? configuration.updatePeriodTicks : configuration.maximumUpdatePeriodTicks);
        }
    }
}

bool HartEngine::loadPlan(HartProtocolPlan plan) {
    const HartPlanCompileResult checked = HartPlanCompiler::compile(plan.devices, m_profiles);
    if (!checked.success) return false;
    std::vector<RuntimeDevice> resolved;
    resolved.reserve(checked.plan.devices.size());
    for (const HartDevicePlan& device : checked.plan.devices) {
        const HartDeviceProfile* profile = m_profiles.find(device.profileId);
        if (!profile) return false;
        RuntimeDevice runtime{device, profile, {}};
        runtime.variableValues.reserve(device.variables.size());
        for (const auto& variable : device.variables) {
            runtime.variableValues.push_back(variable.value);
        }
        resolved.push_back(std::move(runtime));
    }
    m_devices = std::move(resolved);
    return true;
}

void HartEngine::clear() noexcept { m_devices.clear(); }

std::vector<HartBurstEvent> HartEngine::takeBurstEvents(std::string_view deviceId) noexcept {
    for (RuntimeDevice& device : m_devices) {
        if (device.plan.id != deviceId) continue;
        std::vector<HartBurstEvent> result;
        result.swap(device.burstEvents);
        return result;
    }
    return {};
}

bool HartEngine::setDiagnosticStatus(std::string_view deviceId, uint8_t status) noexcept {
    for (RuntimeDevice& device : m_devices) {
        if (device.plan.id != deviceId) continue;
        if (device.plan.statusSimulationEnabled) return true;
        const uint8_t previous = device.plan.diagnosticStatus;
        device.plan.diagnosticStatus = status;
        const auto& configuration = device.plan.eventNotifications[0];
        const bool deviceStatusChanged = ((previous ^ status) & configuration.deviceStatusMask) != 0;
        const bool command48Changed = ((previous ^ status) & configuration.eventMask[0]) != 0;
        if (configuration.control != 0 && (deviceStatusChanged || command48Changed) && device.eventRecords.size() < 8) {
            HartEventNotificationRecord record;
            record.timestamp = m_virtualTimeSeconds;
            record.deviceStatus = status;
            record.command48Data[0] = status;
            device.eventRecords.push_back(record);
        }
        return true;
    }
    return false;
}

bool HartEngine::setPrimaryValue(std::string_view deviceId, double value) noexcept {
    if (!std::isfinite(value)) return false;
    for (RuntimeDevice& device : m_devices) {
        if (device.plan.id == deviceId) {
            device.plan.primaryValue = value;
            for (size_t i = 0; i < device.plan.variables.size(); ++i)
                if (device.plan.variables[i].id == "PV" || device.plan.variables[i].id == "primary")
                    device.variableValues[i] = value;
            return true;
        }
    }
    return false;
}

bool HartEngine::setVariableInput(std::string_view deviceId, std::string_view variableId, double value) noexcept {
    if (!std::isfinite(value)) return false;
    for (RuntimeDevice& device : m_devices) {
        if (device.plan.id != deviceId) continue;
        for (size_t i = 0; i < device.plan.variables.size(); ++i) {
            if (device.plan.variables[i].id != variableId) continue;
            if (device.plan.variables[i].direction != HartVariableDirection::Input) return false;
            device.variableValues[i] = value;
            return true;
        }
        return false;
    }
    return false;
}

std::optional<double> HartEngine::variableValue(std::string_view deviceId, std::string_view variableId) const noexcept {
    for (const RuntimeDevice& device : m_devices) {
        if (device.plan.id != deviceId) continue;
        for (size_t i = 0; i < device.plan.variables.size(); ++i)
            if (device.plan.variables[i].id == variableId) return device.variableValues[i];
        return std::nullopt;
    }
    return std::nullopt;
}

const HartDevicePlan* HartEngine::findDevicePlan(std::string_view deviceId) const noexcept {
    for (const RuntimeDevice& device : m_devices) {
        if (device.plan.id == deviceId) return &device.plan;
    }
    return nullptr;
}

double HartEngine::evaluatePrimary(RuntimeDevice& device) noexcept {
    for (size_t i = 0; i < device.plan.variables.size(); ++i)
        if (device.plan.variables[i].id == "PV" || device.plan.variables[i].id == "primary")
            return device.variableValues[i];
    return device.plan.primaryValue;
}

bool HartEngine::setCommandEnabled(std::string_view deviceId, HartCommandId command, bool enabled) noexcept {
    for (RuntimeDevice& device : m_devices) {
        if (device.plan.id != deviceId) continue;
        for (auto& configuration : device.plan.commandConfigurations) {
            if (configuration.command == command) { configuration.enabled = enabled; return true; }
        }
        return false;
    }
    return false;
}

bool HartEngine::setCommandResponse(std::string_view deviceId, HartCommandId command,
                                    std::span<const uint8_t> response) noexcept {
    if (response.size() > 255) return false;
    for (RuntimeDevice& device : m_devices) {
        if (device.plan.id != deviceId) continue;
        for (auto& configuration : device.plan.commandConfigurations) {
            if (configuration.command != command) continue;
            configuration.hasStaticResponse = true;
            configuration.staticResponse.assign(response.begin(), response.end());
            return true;
        }
        return false;
    }
    return false;
}

bool HartEngine::execute(std::string_view bus, uint8_t pollingAddress, HartCommandId command,
                         std::span<const uint8_t> request, HartResponseBuilder& response) noexcept {
    return execute(bus, pollingAddress, command, request, response, 0);
}

bool HartEngine::execute(std::string_view bus, uint8_t pollingAddress, HartCommandId command,
                         std::span<const uint8_t> request, HartResponseBuilder& response,
                         uint8_t masterRole) noexcept {
    return execute(bus, pollingAddress, command, request, response, masterRole, 0);
}

bool HartEngine::execute(std::string_view bus, uint8_t pollingAddress, HartCommandId command,
                         std::span<const uint8_t> request, HartResponseBuilder& response,
                         uint8_t masterRole, uint8_t routingDepth) noexcept {
    RuntimeDevice* selected = nullptr;
    for (RuntimeDevice& device : m_devices) {
        if (device.plan.bus == bus && device.plan.pollingAddress == pollingAddress) {
            selected = &device;
            break;
        }
    }
    if (!selected) return false;
    ++selected->plan.clientMessagesReceived;
    ++selected->plan.deviceStxReceived;
    // Declared by the profile (the common case: standard/vendor commands
    // every instance of this profile shares) OR declared by this specific
    // device's commandConfigurations (a custom command added to just this
    // instance, e.g. authored through the Property Inspector -- see
    // HartPlanCompiler::compile()'s matching relaxation for why an
    // undeclared-by-profile entry can appear there at all). Either way, a
    // command truly unknown to both stays rejected -- this is what keeps one
    // device's custom command id from leaking into another device sharing the
    // same engine (see hart_engine_test "undeclared custom command rejected").
    const bool declaredByProfile = std::any_of(selected->profile->commands.begin(), selected->profile->commands.end(),
                                               [command](const HartCommandDescriptor& descriptor) { return descriptor.id == command; });
    const bool declaredByDevice = std::any_of(selected->plan.commandConfigurations.begin(), selected->plan.commandConfigurations.end(),
                                              [command](const HartDevicePlan::CommandConfiguration& configuration) { return configuration.command == command; });
    if (!declaredByProfile && !declaredByDevice) return false;
    if (command == 0x6A) {
        if (!request.empty()) return false;
        selected->burstEvents.clear();
        return true;
    }
    if (command == 0x2A && request.empty()) {
        selected->transferOpen = false;
        selected->transferMasterCounter = 0;
        selected->transferDeviceCounter = 0;
        selected->eventRecords.clear();
        selected->caughtValid.fill(false);
        selected->burstNextSampleTime.fill(0);
        selected->burstEvents.clear();
    }
    if (command == 0x5D) {
        if (request.size() != 1 || request[0] >= selected->plan.trendCount || request[0] >= selected->plan.trends.size()) return false;
        const size_t index = request[0];
        const auto& configuration = selected->plan.trends[index];
        if (!response.writeByte(request[0]) || !response.writeByte(configuration.deviceVariableCode)) return false;
        uint8_t classification = 0, units = 250;
        for (const auto& variable : selected->plan.variables)
            if (variable.deviceVariableCode == configuration.deviceVariableCode) { classification = variable.classification; units = variable.deviceVariableUnit; }
        if (!response.writeByte(classification) || !response.writeByte(units)) return false;
        uint64_t newestTimestamp = 0;
        if (selected->trendSampleCounts[index] != 0) {
            const uint8_t newest = static_cast<uint8_t>((selected->trendSampleNext[index] + 11) % 12);
            newestTimestamp = selected->trendSamples[index][newest].timestamp;
        }
        const auto dateTime = encodeDateTimeEngine(newestTimestamp);
        if (!response.writeBytes(std::span<const uint8_t>(dateTime.data(), dateTime.size())) ||
            !response.writeByte(static_cast<uint8_t>(configuration.samplePeriodSeconds >> 24)) ||
            !response.writeByte(static_cast<uint8_t>(configuration.samplePeriodSeconds >> 16)) ||
            !response.writeByte(static_cast<uint8_t>(configuration.samplePeriodSeconds >> 8)) ||
            !response.writeByte(static_cast<uint8_t>(configuration.samplePeriodSeconds))) return false;
        const uint8_t count = selected->trendSampleCounts[index];
        for (size_t position = 0; position < 12; ++position) {
            RuntimeDevice::TrendSample sample;
            if (position < count) {
                const uint8_t slot = static_cast<uint8_t>((selected->trendSampleNext[index] + 12 - 1 - position) % 12);
                sample = selected->trendSamples[index][slot];
            }
            const auto encoded = encodeFloatEngine(sample.value);
            if (!response.writeBytes(encoded) || !response.writeByte(sample.status)) return false;
        }
        ++selected->plan.clientMessagesReturned;
        return true;
    }
    if (command == 0x5E) {
        if (!selected->plan.ioSystem || !request.empty()) return false;
        const auto put32 = [&](uint32_t value) {
            return response.writeByte(static_cast<uint8_t>(value >> 24)) && response.writeByte(static_cast<uint8_t>(value >> 16)) &&
                response.writeByte(static_cast<uint8_t>(value >> 8)) && response.writeByte(static_cast<uint8_t>(value));
        };
        return put32(selected->plan.clientMessagesReceived) && put32(selected->plan.clientMessagesReturned) &&
            put32(selected->plan.clientRequestsForwarded) && put32(selected->plan.clientResponsesReturned);
    }
    if (command == 0x5F) {
        if (!request.empty()) return false;
        return response.writeByte(static_cast<uint8_t>(selected->plan.deviceStxReceived >> 8)) &&
            response.writeByte(static_cast<uint8_t>(selected->plan.deviceStxReceived)) &&
            response.writeByte(static_cast<uint8_t>(selected->plan.deviceAckSent >> 8)) &&
            response.writeByte(static_cast<uint8_t>(selected->plan.deviceAckSent)) &&
            response.writeByte(static_cast<uint8_t>(selected->plan.deviceBackSent >> 8)) &&
            response.writeByte(static_cast<uint8_t>(selected->plan.deviceBackSent));
    }
    for (const auto& configuration : selected->plan.commandConfigurations) {
        if (configuration.command != command) continue;
        if (!configuration.enabled) return false;
        if (configuration.hasStaticResponse) {
            return response.writeBytes(configuration.staticResponse);
        }
        break;
    }
    if (IHartCommandHandler* custom = m_commands.find(command)) {
        return custom->execute({pollingAddress, static_cast<uint8_t>(command), request}, response);
    }
    // Device Lock is a device-wide policy, distinct from Write Protect.  It
    // protects configuration/calibration writes while allowing the owner to
    // continue, and always permits the normative reset-configuration flag
    // command (38 / 0x26).  Command 71 itself is handled by the semantic hook.
    if (selected->plan.lockCode != 0 && command != 0x47 && command != 0x4C &&
        command != 0x48 && command != 0x49 && command != 0x4A && command != 0x4B &&
        command != 0x4D && command != 0x4E && command != 0x26 && command != 0x30) {
        const bool owner = selected->plan.lockCode != 3 && selected->plan.lockOwner == masterRole;
        if (!owner) return false;
    }

    auto put16Engine = [&](uint16_t value) {
        return response.writeByte(static_cast<uint8_t>(value >> 8)) && response.writeByte(static_cast<uint8_t>(value));
    };
    if (command == 0x30) {
        // HCF_SPEC-127 6.24: "Irrespective of the contents of the Request
        // Data Bytes the device must return the current values of the
        // fields contained in the Response Data Bytes" -- this must not be
        // gated on an empty request. A non-empty (HART7, comparison-bytes)
        // request used to fall through to a DSL stub registered elsewhere
        // that always answered all-zero regardless of real diagnostic
        // status; that stub has been removed (see
        // HartReferenceCatalog::commandPrograms, formerly command id 0x30)
        // so this is now the single authority for Command 48's response,
        // matched by request shape or not. Comparing the request against
        // the current value to conditionally reset the per-Master "More
        // Status Available" bit (6.24, 6.24.1) is not modeled -- this
        // project has no per-Master device status bit yet -- and remains a
        // disclosed gap, distinct from the response-content bug fixed here.
        std::array<uint8_t, 9> statusBytes{};
        statusBytes[0] = selected->plan.diagnosticStatus;
        if (selected->plan.statusSimulationEnabled) {
            for (size_t index = 0; index < selected->plan.simulatedStatusMask.size(); ++index) {
                if (selected->plan.simulatedStatusMask[index] == 0) continue;
                const size_t byte = index < 8 ? 0 : 1 + (index - 8) / 8;
                if (byte >= statusBytes.size()) continue;
                const uint8_t bit = static_cast<uint8_t>(1u << (index < 8 ? index : (index - 8) % 8));
                if (selected->plan.simulatedStatusValues[index] != 0) statusBytes[byte] |= bit;
                else statusBytes[byte] = static_cast<uint8_t>(statusBytes[byte] & ~bit);
            }
        }
        return response.writeBytes(statusBytes);
    }
    if (command == 0x6F) {
        if (request.size() != 5 || request[1] < 2 || request[1] > 8 || request[2] == 0) return false;
        const uint8_t function = request[0];
        if (function != 1 && function != 2 && function != 3 && function != 4) return false;
        if (function == 1) {
            selected->transferOpen = true;
            selected->transferPort = request[1];
            selected->transferMaximumSegment = std::min<uint8_t>(request[2], 200);
            selected->transferMasterCounter = static_cast<uint16_t>(request[3] << 8 | request[4]);
            selected->transferDeviceCounter = 0;
        } else if (!selected->transferOpen || selected->transferPort != request[1]) return false;
        if (function == 2) {
            selected->transferOpen = false;
            selected->transferMasterCounter = 0;
            selected->transferDeviceCounter = 0;
        } else if (function == 4) {
            selected->transferOpen = false;
        }
        return response.writeByte(function) && response.writeByte(request[1]) &&
            response.writeByte(selected->transferMaximumSegment) &&
            put16Engine(selected->transferMasterCounter) && put16Engine(selected->transferDeviceCounter);
    }
    if (command == 0x70) {
        if (request.size() < 6 || !selected->transferOpen) return false;
        const uint8_t function = request[0];
        const uint8_t count = request[1];
        const uint16_t masterCounter = static_cast<uint16_t>(request[2] << 8 | request[3]);
        const uint16_t slaveCounter = static_cast<uint16_t>(request[4] << 8 | request[5]);
        if (function != 0 && function != 3 && function != 4) return false;
        if (function == 0) {
            if (count > selected->transferMaximumSegment || request.size() != 6u + count || masterCounter != selected->transferMasterCounter || slaveCounter != selected->transferDeviceCounter) return false;
            selected->transferMasterCounter = static_cast<uint16_t>(selected->transferMasterCounter + count);
        } else if (request.size() != 6 || function == 4) {
            if (function == 4) selected->transferOpen = false;
        }
        return response.writeByte(function) && response.writeByte(0) &&
            put16Engine(selected->transferMasterCounter) && put16Engine(selected->transferDeviceCounter);
    }
    if (command == 0x73 || command == 0x77) {
        if ((command == 0x73 && (request.size() != 1 || request[0] != 0)) ||
            (command == 0x77 && request.size() != 1 && request.size() != 33) ||
            (command == 0x77 && request[0] != 0)) return false;
        const auto& configuration = selected->plan.eventNotifications[0];
        HartEventNotificationRecord record;
        if (!selected->eventRecords.empty()) record = selected->eventRecords.front();
        const auto put32 = [&](uint32_t value) {
            return response.writeByte(static_cast<uint8_t>(value >> 24)) && response.writeByte(static_cast<uint8_t>(value >> 16)) &&
                response.writeByte(static_cast<uint8_t>(value >> 8)) && response.writeByte(static_cast<uint8_t>(value));
        };
        if (command == 0x73) {
            const uint8_t eventStatus = selected->eventRecords.empty() ? 0 : 0x02;
            return response.writeByte(0) && response.writeByte(1) && response.writeByte(static_cast<uint8_t>((eventStatus << 4) | (configuration.control & 0x0F))) &&
                put32(selected->eventRecords.empty() ? 0xFFFFFFFFu : static_cast<uint32_t>(record.timestamp)) &&
                put32(configuration.retryTimeTicks) && put32(configuration.maximumUpdateTimeTicks) && put32(configuration.debounceTimeTicks) &&
                response.writeByte(configuration.deviceStatusMask) && response.writeBytes(configuration.eventMask);
        }
        if (request.size() == 33 && selected->plan.eventManagerRegistered && selected->plan.eventManagerOwner != masterRole) return false;
        if (request.size() == 33 && !selected->eventRecords.empty()) {
            const uint32_t timestamp = (static_cast<uint32_t>(request[1]) << 24) | (static_cast<uint32_t>(request[2]) << 16) |
                (static_cast<uint32_t>(request[3]) << 8) | request[4];
            const uint16_t counter = static_cast<uint16_t>(request[5] << 8 | request[6]);
            if (timestamp == static_cast<uint32_t>(record.timestamp) && counter == static_cast<uint16_t>(record.configurationChangedCounter) &&
                request[7] == static_cast<uint8_t>(record.deviceStatus) && std::equal(request.begin() + 8, request.end(), record.command48Data.begin()))
                selected->eventRecords.erase(selected->eventRecords.begin());
        }
        if (selected->eventRecords.empty()) {
            record.timestamp = 0xFFFFFFFFu;
            record.deviceStatus = selected->plan.diagnosticStatus;
            record.command48Data.fill(0);
            record.command48Data[0] = selected->plan.diagnosticStatus;
        }
        if (!response.writeByte(0) || !put32(static_cast<uint32_t>(record.timestamp)) ||
            !put16Engine(static_cast<uint16_t>(record.configurationChangedCounter)) || !response.writeByte(static_cast<uint8_t>(record.deviceStatus)) ||
            !response.writeBytes(record.command48Data)) return false;
        return true;
    }

    if (command >= 528 && command <= 531) {
        if (!selected->plan.ioSystem || selected->plan.assignmentCapacity == 0) return false;
        const auto put16 = [&](uint16_t value) {
            return response.writeByte(static_cast<uint8_t>(value >> 8)) && response.writeByte(static_cast<uint8_t>(value));
        };
        const auto put24 = [&](uint32_t value) {
            return response.writeByte(static_cast<uint8_t>(value >> 16)) && response.writeByte(static_cast<uint8_t>(value >> 8)) &&
                response.writeByte(static_cast<uint8_t>(value));
        };
        const auto childFor = [&](const std::string& id) -> RuntimeDevice* {
            for (RuntimeDevice& candidate : m_devices) if (candidate.plan.id == id) return &candidate;
            return nullptr;
        };
        const auto assignmentStatus = [&](const HartSubDeviceAssignment& assignment) {
            RuntimeDevice* child = childFor(assignment.childDeviceId);
            if (child == nullptr) {
                uint8_t status = 0x01;
                if (assignment.expandedDeviceType == 0 && std::all_of(assignment.longTag.begin(), assignment.longTag.end(), [](uint8_t value) { return value == 0; })) status = 0x02;
                return status;
            }
            uint8_t status = 0;
            const auto liveLink = std::find_if(selected->plan.subDevices.begin(), selected->plan.subDevices.end(), [&](const HartSubDeviceLink& link) {
                return link.childDeviceId == assignment.childDeviceId;
            });
            if (liveLink == selected->plan.subDevices.end()) return static_cast<uint8_t>(0x01);
            if ((assignment.ioCard != 0xFF && assignment.ioCard != liveLink->ioCard) ||
                (assignment.channel != 0xFF && assignment.channel != liveLink->channel)) status |= 0x01;
            const auto childTag = HartTypeCodec::encodeLatin1(child->plan.longTag, 32);
            const bool tagMatch = std::equal(assignment.longTag.begin(), assignment.longTag.end(), childTag.begin());
            if (!tagMatch && assignment.expandedDeviceType == 0) status |= 0x02;
            return status;
        };
        const auto writeIdentity = [&](uint16_t index, uint8_t status, uint8_t card, uint8_t channel, uint16_t manufacturer,
                                       uint16_t type, uint32_t deviceId, const std::array<uint8_t, 32>& tag, uint8_t revision) {
            return put16(index) && response.writeByte(status) && response.writeByte(card) && response.writeByte(channel) &&
                put16(manufacturer) && put16(type) && put24(deviceId) && response.writeBytes(tag) && response.writeByte(revision);
        };
        const auto writeAssignment = [&](uint16_t index, uint8_t card, uint8_t channel, uint16_t manufacturer,
                                         uint16_t type, uint32_t deviceId, const std::array<uint8_t, 32>& tag, uint8_t revision) {
            return put16(index) && response.writeByte(card) && response.writeByte(channel) && put16(manufacturer) && put16(type) &&
                put24(deviceId) && response.writeBytes(tag) && response.writeByte(revision);
        };
        if (command == 528) {
            if (!request.empty()) return false;
            uint8_t status = 0;
            for (size_t i = 0; i < selected->plan.assignmentCount; ++i) status |= assignmentStatus(selected->plan.assignments[i]);
            const uint16_t total = static_cast<uint16_t>(selected->plan.assignmentCount + 1);
            const uint16_t maximum = static_cast<uint16_t>(selected->plan.assignmentCapacity + 1);
            return put16(total) && put16(maximum) && response.writeByte(status);
        }
        if (command == 529) {
            if (request.size() != 2) return false;
            const uint16_t index = static_cast<uint16_t>(request[0] << 8 | request[1]);
            if (index > selected->plan.assignmentCount) return false;
            if (index == 0) {
                const auto id = parseDeviceIdHexEngine(selected->plan.uniqueId);
                std::array<uint8_t, 32> tag{};
                const auto encoded = HartTypeCodec::encodeLatin1(selected->plan.longTag, 32);
                std::copy(encoded.begin(), encoded.end(), tag.begin());
                return writeIdentity(0, 0, 0xFB, 0xFB, selected->profile->manufacturerId, selected->profile->deviceType,
                                     (static_cast<uint32_t>(id[0]) << 16) | (static_cast<uint32_t>(id[1]) << 8) | id[2], tag,
                                     selected->profile->identity.transmitterSpecificRevision);
            }
            auto& assignment = selected->plan.assignments[index - 1];
            assignment.status = assignmentStatus(assignment);
            return writeIdentity(assignment.index, assignment.status, assignment.ioCard, assignment.channel, assignment.manufacturerId,
                                 assignment.expandedDeviceType, assignment.deviceId, assignment.longTag, assignment.deviceRevision);
        }
        if (command == 530) {
            if (selected->plan.writeProtectCode != 0xFB || request.size() != 44) return false;
            const uint16_t requestedIndex = static_cast<uint16_t>(request[0] << 8 | request[1]);
            const uint8_t card = request[2], channel = request[3];
            const uint16_t manufacturer = static_cast<uint16_t>(request[4] << 8 | request[5]);
            const uint16_t type = static_cast<uint16_t>(request[6] << 8 | request[7]);
            const uint32_t deviceId = (static_cast<uint32_t>(request[8]) << 16) | (static_cast<uint32_t>(request[9]) << 8) | request[10];
            std::array<uint8_t, 32> tag{}; std::copy_n(request.begin() + 11, 32, tag.begin());
            const uint8_t revision = request[43];
            if ((card != 0xFF && card >= selected->plan.ioMaximumCards) ||
                (channel != 0xFF && channel >= selected->plan.ioMaximumChannelsPerCard)) return false;
            const bool deleting = manufacturer == 0xFFFF;
            const bool tagEmpty = std::all_of(tag.begin(), tag.end(), [](uint8_t value) { return value == 0; });
            if (!deleting && type == 0 && deviceId == 0 && tagEmpty) return false;
            auto sameIdentity = [&](const HartSubDeviceAssignment& item) {
                const bool itemTagEmpty = std::all_of(item.longTag.begin(), item.longTag.end(), [](uint8_t value) { return value == 0; });
                if (!tagEmpty && !itemTagEmpty) return item.longTag == tag;
                return type != 0 && item.expandedDeviceType == type && item.deviceId == deviceId;
            };
            size_t match = selected->plan.assignmentCount;
            for (size_t i = 0; i < selected->plan.assignmentCount; ++i) if (sameIdentity(selected->plan.assignments[i])) { match = i; break; }
            if (requestedIndex == 0 && !deleting && match != selected->plan.assignmentCount) return false;
            if (requestedIndex > selected->plan.assignmentCount) return false;
            if (deleting) {
                if (match == selected->plan.assignmentCount) return false;
                for (size_t i = match + 1; i < selected->plan.assignmentCount; ++i) selected->plan.assignments[i - 1] = selected->plan.assignments[i];
                --selected->plan.assignmentCount;
            } else {
                size_t target = requestedIndex == 0 ? selected->plan.assignmentCount : requestedIndex - 1;
                if (target >= selected->plan.assignmentCapacity || target >= selected->plan.assignments.size()) return false;
                HartSubDeviceAssignment staged;
                staged.index = static_cast<uint16_t>(target + 1); staged.ioCard = card; staged.channel = channel;
                staged.manufacturerId = manufacturer; staged.expandedDeviceType = type; staged.deviceId = deviceId;
                staged.longTag = tag; staged.deviceRevision = revision;
                if (target == selected->plan.assignmentCount) ++selected->plan.assignmentCount;
                selected->plan.assignments[target] = std::move(staged);
                if (RuntimeDevice* child = childFor(selected->plan.assignments[target].childDeviceId); child == nullptr) {
                    for (RuntimeDevice& candidate : m_devices) {
                        const auto candidateTag = HartTypeCodec::encodeLatin1(candidate.plan.longTag, 32);
                        const bool tagMatch = !tagEmpty && std::equal(tag.begin(), tag.end(), candidateTag.begin());
                        const auto candidateId = parseDeviceIdHexEngine(candidate.plan.uniqueId);
                        const uint32_t candidateNumericId = (static_cast<uint32_t>(candidateId[0]) << 16) | (static_cast<uint32_t>(candidateId[1]) << 8) | candidateId[2];
                        if (tagMatch || (type != 0 && candidateNumericId == deviceId && candidate.profile->deviceType == type)) {
                            selected->plan.assignments[target].childDeviceId = candidate.plan.id; break;
                        }
                    }
                }
            }
            const auto& committed = deleting ? selected->plan.assignments[std::min<size_t>(match, selected->plan.assignmentCount ? selected->plan.assignmentCount - 1 : 0)]
                                             : selected->plan.assignments[(requestedIndex == 0 ? selected->plan.assignmentCount : requestedIndex) - 1];
            return writeAssignment(committed.index, committed.ioCard, committed.channel, committed.manufacturerId,
                                   committed.expandedDeviceType, committed.deviceId, committed.longTag, committed.deviceRevision);
        }
        if (command == 531) {
            if (selected->plan.writeProtectCode != 0xFB || request.size() != 1 || request[0] > 1) return false;
            if (selected->plan.subDevices.size() > selected->plan.assignmentCapacity || selected->plan.subDevices.size() > selected->plan.assignments.size()) return false;
            std::array<HartSubDeviceAssignment, 32> staged{};
            for (size_t i = 0; i < selected->plan.subDevices.size(); ++i) {
                RuntimeDevice* child = childFor(selected->plan.subDevices[i].childDeviceId);
                if (child == nullptr) return false;
                auto& entry = staged[i]; entry.index = static_cast<uint16_t>(i + 1);
                entry.ioCard = selected->plan.subDevices[i].ioCard; entry.channel = selected->plan.subDevices[i].channel;
                entry.manufacturerId = child->profile->manufacturerId; entry.expandedDeviceType = child->profile->deviceType;
                const auto childId = parseDeviceIdHexEngine(child->plan.uniqueId);
                entry.deviceId = (static_cast<uint32_t>(childId[0]) << 16) | (static_cast<uint32_t>(childId[1]) << 8) | childId[2];
                const auto childTag = HartTypeCodec::encodeLatin1(child->plan.longTag, 32); std::copy(childTag.begin(), childTag.end(), entry.longTag.begin());
                entry.deviceRevision = child->profile->identity.transmitterSpecificRevision; entry.childDeviceId = child->plan.id;
            }
            selected->plan.assignments = staged;
            selected->plan.assignmentCount = static_cast<uint8_t>(selected->plan.subDevices.size());
            return response.writeByte(request[0]);
        }
    }

    // Command 75 resolves a real child from the same device registry and
    // returns that child's normal Command 0 identity response.
    if (command == 0x4B) {
        if (!selected->plan.ioSystem || request.size() != 3) return false;
        const auto link = std::find_if(selected->plan.subDevices.begin(), selected->plan.subDevices.end(),
            [&](const HartSubDeviceLink& candidate) {
                return candidate.ioCard == request[0] && candidate.channel == request[1] &&
                       candidate.pollingAddress == request[2];
            });
        if (link == selected->plan.subDevices.end() || link->childDeviceId == selected->plan.id) return false;
        RuntimeDevice* child = nullptr;
        for (RuntimeDevice& candidate : m_devices)
            if (candidate.plan.id == link->childDeviceId) { child = &candidate; break; }
        if (!child) return false;
        HartResponseBuilder childResponse(255);
        const bool ok = execute(child->plan.bus, child->plan.pollingAddress, 0x00, {}, childResponse, masterRole, routingDepth);
        if (ok) {
            ++selected->plan.clientRequestsForwarded;
            ++selected->plan.clientResponsesReturned;
            auto stats = std::find_if(selected->plan.ioChannelStatistics.begin(), selected->plan.ioChannelStatistics.end(),
                [&](const HartIoChannelStatistics& value) { return value.ioCard == request[0] && value.channel == request[1]; });
            if (stats == selected->plan.ioChannelStatistics.end()) {
                selected->plan.ioChannelStatistics.push_back({request[0], request[1]});
                stats = std::prev(selected->plan.ioChannelStatistics.end());
            }
            ++stats->stxSent; ++stats->ackReceived;
            for (auto& linkEntry : selected->plan.subDevices)
                if (linkEntry.childDeviceId == link->childDeviceId) { ++linkEntry.messagesSent; ++linkEntry.acknowledgementsReceived; }
            return response.writeBytes(childResponse.bytes());
        }
        return false;
    }
    if (command == 0x54) {
        if (!selected->plan.ioSystem || request.size() != 2) return false;
        const uint16_t index = static_cast<uint16_t>(request[0] << 8 | request[1]);
        const HartDevicePlan* childPlan = nullptr;
        const HartDeviceProfile* childProfile = selected->profile;
        uint8_t card = 0, channel = 0;
        if (index != 0) {
            if (index > selected->plan.subDevices.size()) return false;
            const auto& link = selected->plan.subDevices[index - 1];
            for (const RuntimeDevice& candidate : m_devices)
                if (candidate.plan.id == link.childDeviceId) { childPlan = &candidate.plan; childProfile = candidate.profile; break; }
            if (!childPlan) return false;
            card = link.ioCard; channel = link.channel;
        } else childPlan = &selected->plan;
        const auto deviceId = parseDeviceIdHexEngine(childPlan->uniqueId);
        const std::string tag = childPlan->longTag.empty() ? (childPlan->tag.empty() ? childPlan->id : childPlan->tag) : childPlan->longTag;
        std::array<uint8_t, 32> encodedTag{};
        std::fill(encodedTag.begin(), encodedTag.end(), static_cast<uint8_t>(' '));
        std::copy_n(reinterpret_cast<const uint8_t*>(tag.data()), std::min<size_t>(tag.size(), encodedTag.size()), encodedTag.begin());
        if (!response.writeByte(static_cast<uint8_t>(index >> 8)) || !response.writeByte(static_cast<uint8_t>(index)) ||
            !response.writeByte(card) || !response.writeByte(channel) ||
            !response.writeByte(static_cast<uint8_t>(childProfile->manufacturerId >> 8)) ||
            !response.writeByte(static_cast<uint8_t>(childProfile->manufacturerId)) ||
            !response.writeByte(static_cast<uint8_t>(childProfile->deviceType >> 8)) ||
            !response.writeByte(static_cast<uint8_t>(childProfile->deviceType)) || !response.writeBytes(deviceId) ||
            !response.writeByte(childProfile->identity.universalCommandRevision) || !response.writeBytes(encodedTag) ||
            // HCF_SPEC-151 7.52 footnote 64: a sub-device that doesn't report
            // its own Device Profile must be reported as Device Profile 1
            // "Process Automation Device" (Common Table 57) -- 0 is not a
            // defined code in that table and was a wrong default.
            !response.writeByte(childProfile->identity.transmitterSpecificRevision) || !response.writeByte(1) ||
            !response.writeByte(0) || !response.writeByte(0)) return false;
        return true;
    }
    if (command == 0x55) {
        if (!selected->plan.ioSystem || request.size() != 2) return false;
        if (request[0] >= selected->plan.ioMaximumCards || request[1] >= selected->plan.ioMaximumChannelsPerCard) return false;
        auto stats = std::find_if(selected->plan.ioChannelStatistics.begin(), selected->plan.ioChannelStatistics.end(),
            [&](const HartIoChannelStatistics& value) { return value.ioCard == request[0] && value.channel == request[1]; });
        HartIoChannelStatistics zero{request[0], request[1]};
        const auto& value = stats == selected->plan.ioChannelStatistics.end() ? zero : *stats;
        const auto put16 = [&](uint16_t number) { return response.writeByte(static_cast<uint8_t>(number >> 8)) && response.writeByte(static_cast<uint8_t>(number)); };
        return response.writeByte(value.ioCard) && response.writeByte(value.channel) && put16(value.stxSent) &&
            put16(value.ackReceived) && put16(value.ostxReceived) && put16(value.oackReceived) && put16(value.backReceived);
    }
    if (command == 0x56) {
        if (!selected->plan.ioSystem || request.size() != 2) return false;
        const uint16_t index = static_cast<uint16_t>(request[0] << 8 | request[1]);
        if (index > selected->plan.subDevices.size()) return false;
        uint16_t sent = 0, ack = 0, back = 0;
        if (index != 0) {
            const auto& link = selected->plan.subDevices[index - 1];
            sent = link.messagesSent; ack = link.acknowledgementsReceived; back = link.backMessagesReceived;
        }
        const auto put16 = [&](uint16_t number) { return response.writeByte(static_cast<uint8_t>(number >> 8)) && response.writeByte(static_cast<uint8_t>(number)); };
        return response.writeByte(request[0]) && response.writeByte(request[1]) && put16(sent) && put16(ack) && put16(back);
    }
    // Command 77 is routed through this same engine/registry.  The parent
    // stores only a stable child reference and topology coordinates; child
    // HART state and command semantics remain in its own RuntimeDevice.
    if (command == 0x4D) {
        if (routingDepth >= 8) return false;
        if (!selected->plan.ioSystem || request.size() < 6 || request[2] < 5 || request[2] > 20) return false;
        const uint8_t card = request[0];
        const uint8_t channel = request[1];
        const uint8_t delimiter = request[3];
        const size_t addressLength = (delimiter & 0x80u) != 0 ? 5u : 1u;
        const size_t commandOffset = 4u + addressLength;
        if (commandOffset + 2 > request.size()) return false;
        const HartCommandId childCommand = request[commandOffset];
        const size_t countOffset = commandOffset + 1;
        const size_t count = request[countOffset];
        if (count > 255 || countOffset + 1 + count != request.size()) return false;
        const auto link = std::find_if(selected->plan.subDevices.begin(), selected->plan.subDevices.end(),
            [&](const HartSubDeviceLink& candidate) {
                return candidate.ioCard == card && candidate.channel == channel &&
                       candidate.pollingAddress == request[4];
            });
        if (link == selected->plan.subDevices.end() || link->childDeviceId == selected->plan.id) return false;
        RuntimeDevice* child = nullptr;
        for (RuntimeDevice& candidate : m_devices)
            if (candidate.plan.id == link->childDeviceId) { child = &candidate; break; }
        if (!child) return false;
        HartResponseBuilder childResponse(255);
        if (!execute(child->plan.bus, child->plan.pollingAddress, childCommand,
                     request.subspan(countOffset + 1, count), childResponse, masterRole,
                     static_cast<uint8_t>(routingDepth + 1))) return false;
        auto stats = std::find_if(selected->plan.ioChannelStatistics.begin(), selected->plan.ioChannelStatistics.end(),
            [&](const HartIoChannelStatistics& value) { return value.ioCard == card && value.channel == channel; });
        if (stats == selected->plan.ioChannelStatistics.end()) {
            selected->plan.ioChannelStatistics.push_back({card, channel});
            stats = std::prev(selected->plan.ioChannelStatistics.end());
        }
        ++stats->stxSent; ++stats->ackReceived;
        ++selected->plan.clientRequestsForwarded;
        ++selected->plan.clientResponsesReturned;
        for (auto& linkEntry : selected->plan.subDevices)
            if (linkEntry.childDeviceId == link->childDeviceId) { ++linkEntry.messagesSent; ++linkEntry.acknowledgementsReceived; }
        if (!response.writeByte(card) || !response.writeByte(channel) || !response.writeByte(delimiter)) return false;
        if (addressLength == 5) {
            if (!response.writeBytes(request.subspan(4, 5))) return false;
        } else if (!response.writeByte(request[4])) return false;
        if (!response.writeByte(static_cast<uint8_t>(childCommand)) ||
            !response.writeByte(static_cast<uint8_t>(childResponse.size())) ||
            !response.writeBytes(childResponse.bytes())) return false;
        return true;
    }
    // Command 78 is deliberately a bounded envelope around normal command
    // dispatch. It never calls a second executor or interprets command data.
    if (command == 0x4E) {
        if (request.empty() || request.size() > 255 || request[0] == 0 || request[0] > 32) return false;
        const uint8_t requested = request[0];
        size_t offset = 1;
        std::vector<std::pair<HartCommandId, std::vector<uint8_t>>> embedded;
        embedded.reserve(requested);
        for (uint8_t i = 0; i < requested; ++i) {
            if (offset + 3 > request.size()) return false;
            const HartCommandId inner = static_cast<HartCommandId>(request[offset] << 8 | request[offset + 1]);
            const size_t length = request[offset + 2];
            offset += 3;
            if (inner == 31 || inner == 78 || offset + length > request.size()) return false;
            embedded.emplace_back(inner, std::vector<uint8_t>(request.begin() + static_cast<std::ptrdiff_t>(offset),
                                                               request.begin() + static_cast<std::ptrdiff_t>(offset + length)));
            offset += length;
        }
        if (offset != request.size()) return false;
        // Stage all embedded commands on a copy. If the aggregate response
        // cannot fit, no embedded mutation leaks out and no truncated command
        // has been committed (the normative Command 78 atomicity boundary).
        HartEngine staged(*this);
        struct AggregateResult { HartCommandId command; std::vector<uint8_t> bytes; bool success; };
        std::vector<AggregateResult> results;
        results.reserve(embedded.size());
        for (const auto& item : embedded) {
            HartResponseBuilder innerResponse(255);
            const bool ok = staged.execute(bus, pollingAddress, item.first, item.second, innerResponse, masterRole);
            if (!ok) results.push_back({item.first, {}, false});
            else results.push_back({item.first, std::vector<uint8_t>(innerResponse.bytes().begin(), innerResponse.bytes().end()), true});
        }
        if (!response.writeByte(0) || !response.writeByte(requested)) return false;
        for (size_t i = 0; i < results.size(); ++i) {
            const auto& item = results[i];
            const uint8_t responseCode = item.success ? 0 : 6;
            if (!response.writeByte(static_cast<uint8_t>(item.command >> 8)) ||
                !response.writeByte(static_cast<uint8_t>(item.command)) ||
                !response.writeByte(static_cast<uint8_t>(item.bytes.size())) ||
                !response.writeByte(responseCode) || !response.writeBytes(item.bytes)) return false;
        }
        m_devices = std::move(staged.m_devices);
        return true;
    }
    if (m_programHook) {
        const double primary = evaluatePrimary(*selected);
        HartDevicePlan effectivePlan = selected->plan;
        effectivePlan.virtualTimeSeconds = m_virtualTimeSeconds;
        for (size_t i = 0; i < effectivePlan.variables.size() && i < selected->variableValues.size(); ++i)
            effectivePlan.variables[i].value = selected->variableValues[i];
        if (m_programHook(*selected->profile, effectivePlan, primary, command, request, response, masterRole)) {
            // Persist whatever the command's write stage mutated (tag,
            // message, descriptor, date, final assembly number, ...) back
            // into the actual runtime device -- a write command is a real
            // state change, not just a response byte (see the doc comment
            // on `CommandProgramHook`). `variables`/`commandConfigurations`
            // round-trip unchanged here too (the hook never touches them),
            // so this is a safe unconditional copy-back, not a selective one
            // that could silently miss a field a future write command needs.
            bool trendChanged = selected->plan.trendCount != effectivePlan.trendCount;
            for (size_t i = 0; i < selected->plan.trends.size(); ++i) {
                const auto& before = selected->plan.trends[i];
                const auto& after = effectivePlan.trends[i];
                if (before.control != after.control || before.deviceVariableCode != after.deviceVariableCode || before.samplePeriodSeconds != after.samplePeriodSeconds) trendChanged = true;
            }
            bool actionChanged = selected->plan.actionCount != effectivePlan.actionCount;
            for (size_t i = 0; i < selected->plan.synchronousActions.size(); ++i) {
                if (selected->plan.synchronousActions[i].control != effectivePlan.synchronousActions[i].control ||
                    selected->plan.synchronousActions[i].triggerSeconds != effectivePlan.synchronousActions[i].triggerSeconds ||
                    selected->plan.commandActions[i].command != effectivePlan.commandActions[i].command ||
                    selected->plan.commandActions[i].requestData != effectivePlan.commandActions[i].requestData) actionChanged = true;
            }
            selected->plan = std::move(effectivePlan);
            if (trendChanged) {
                selected->trendSampleCounts.fill(0); selected->trendSampleNext.fill(0); selected->trendNextSampleTime.fill(0);
            }
            if (actionChanged) selected->actionFired.fill(false);
            // Keep the live value cache coherent after a writable Device
            // Variable mutation; otherwise the next dispatch would replace
            // the committed value with the stale Signal Graph snapshot.
            for (size_t i = 0; i < selected->plan.variables.size() && i < selected->variableValues.size(); ++i)
                if (selected->plan.variables[i].writable)
                    selected->variableValues[i] = selected->plan.variables[i].value;
            // Command 113 catch mappings observe actual canonical command
            // responses. The captured snapshot is stored on the receiver's
            // runtime state and never replaces its live Device Variable.
            for (RuntimeDevice& receiver : m_devices) {
                for (size_t catchIndex = 0; catchIndex < receiver.plan.catchConfigurations.size(); ++catchIndex) {
                    const auto& mapping = receiver.plan.catchConfigurations[catchIndex];
                    if (mapping.captureMode != 1 || mapping.sourceCommand != command ||
                        mapping.destinationDeviceVariable == 250 ||
                        (mapping.sourceAddress[4] != 0 && mapping.sourceAddress[4] != selected->plan.pollingAddress)) continue;
                    float caught = std::numeric_limits<float>::quiet_NaN();
                    uint8_t caughtStatus = 0x30;
                    if (command == 1 && response.size() >= 5 && mapping.sourceSlot == 0) {
                        caught = HartTypeCodec::decodeFloat32BE(response.bytes().subspan(1, 4)); caughtStatus = 0;
                    } else if (command == 3 && response.size() >= 9 && mapping.sourceSlot < 4) {
                        const size_t offset = 1 + mapping.sourceSlot * 5;
                        if (offset + 5 <= response.size()) {
                            caught = HartTypeCodec::decodeFloat32BE(response.bytes().subspan(offset + 1, 4)); caughtStatus = response.bytes()[offset];
                        }
                    }
                    if (std::isfinite(caught)) {
                        receiver.caughtValues[catchIndex] = caught;
                        receiver.caughtStatuses[catchIndex] = caughtStatus;
                        receiver.caughtTimestamps[catchIndex] = m_virtualTimeSeconds;
                        receiver.caughtValid[catchIndex] = true;
                        for (size_t variableIndex = 0; variableIndex < receiver.plan.variables.size(); ++variableIndex)
                            if (receiver.plan.variables[variableIndex].deviceVariableCode == mapping.destinationDeviceVariable)
                                receiver.variableValues[variableIndex] = caught;
                    }
                }
            }
            return true;
        }
    }
    return false;
}

} // namespace lasecsimul::protocols

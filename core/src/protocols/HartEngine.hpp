#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "simulation/SignalEngine.hpp"

namespace lasecsimul::protocols {

using HartCommandId = uint16_t;

struct HartCommandContext {
    uint8_t pollingAddress = 0;
    uint8_t command = 0;
    std::span<const uint8_t> request;
};

class HartResponseBuilder final {
public:
    explicit HartResponseBuilder(size_t capacity = 64) : m_bytes(capacity) {}
    bool writeByte(uint8_t value) noexcept;
    bool writeBytes(std::span<const uint8_t> values) noexcept;
    bool writeAscii(std::string_view value) noexcept;
    std::span<const uint8_t> bytes() const noexcept { return {m_bytes.data(), m_size}; }
    size_t size() const noexcept { return m_size; }
    bool overflowed() const noexcept { return m_overflow; }

private:
    std::vector<uint8_t> m_bytes;
    size_t m_size = 0;
    bool m_overflow = false;
};

class HartPayloadReader final {
public:
    explicit HartPayloadReader(std::span<const uint8_t> bytes) : m_bytes(bytes) {}
    bool readByte(uint8_t& value) noexcept;
    bool readU16(uint16_t& value) noexcept;
    bool readU32(uint32_t& value) noexcept;
    bool readBytes(size_t count, std::span<const uint8_t>& value) noexcept;
    size_t remaining() const noexcept { return m_bytes.size() - m_offset; }

private:
    std::span<const uint8_t> m_bytes;
    size_t m_offset = 0;
};

struct HartFrame {
    uint8_t pollingAddress = 0;
    HartCommandId command = 0;
    std::vector<uint8_t> payload;
};

class HartFrameCodec final {
public:
    static uint8_t checksum(std::span<const uint8_t> bytes) noexcept;
    static bool decode(std::span<const uint8_t> wire, HartFrame& frame,
                       size_t maxPayload = 255) noexcept;
    static bool encode(const HartFrame& frame, HartResponseBuilder& output,
                       size_t maxPayload = 255) noexcept;
};

struct HartCommandDescriptor {
    HartCommandId id = 0;
    std::string name;
};

class IHartCommandHandler {
public:
    virtual ~IHartCommandHandler() = default;
    virtual HartCommandId command() const noexcept = 0;
    virtual bool execute(const HartCommandContext&, HartResponseBuilder&) noexcept = 0;
};

class HartCommandRegistry final {
public:
    bool registerHandler(IHartCommandHandler& handler);
    bool remove(HartCommandId command) noexcept;
    IHartCommandHandler* find(HartCommandId command) const noexcept;
    size_t size() const noexcept { return m_handlers.size(); }

private:
    std::unordered_map<HartCommandId, IHartCommandHandler*> m_handlers;
};

/** Static command-0/0x0B identity fields not yet exposed as authored profile
 * properties; defaults are HART-plausible placeholders (FASE 24.2 open item). */
struct HartDeviceIdentity {
    uint8_t numRequestPreambles = 5;
    uint8_t universalCommandRevision = 7;
    uint8_t transmitterSpecificRevision = 1;
    uint8_t softwareRevision = 1;
    uint8_t hardwareRevisionAndSignal = 0;
    uint8_t flags = 0;
};

struct HartDeviceProfile {
    std::string id;
    uint32_t version = 1;
    uint16_t manufacturerId = 0;
    uint16_t deviceType = 0;
    std::vector<HartCommandDescriptor> commands;
    HartDeviceIdentity identity{};
};

class HartProfileRegistry final {
public:
    bool registerProfile(HartDeviceProfile profile);
    bool remove(std::string_view id) noexcept;
    const HartDeviceProfile* find(std::string_view id) const noexcept;
    size_t size() const noexcept { return m_profiles.size(); }

private:
    std::unordered_map<std::string, HartDeviceProfile> m_profiles;
};

/** Property Inspector authoring vocabulary (FEAT-013 Property Inspector). Kept
 * as a small closed enum matched by a UI-side mirror (see
 * `hartVariableSchema.ts`) rather than a generic Core "describe my JSON
 * collection" mechanism -- these are architecture-level, not per-profile. */
enum class HartVariableRole : uint8_t {
    PrimaryVariable, SecondaryVariable, TertiaryVariable, QuaternaryVariable,
    Internal, DeviceSpecific, VendorSpecific, Custom,
};

/** Only the types `HartTypeCodec` actually implements today; do not add a type
 * here the codec cannot encode (section 14 rule: no UI type disconnected from
 * a real codec). */
enum class HartVariableType : uint8_t { Float32, UInt8, UInt16, Int16, PackedAscii, Bool };

/** `Internal`/`Input`/`Output` only -- see .spec/features/hart-device-engine.md
 * section 37/48: `Constant`/`Reference`/`Expression`/`TransferFunction` as
 * parallel source modes are explicitly retired. `Input`/`Output` are modeled
 * here (stored, validated) but do NOT yet materialize a Signal Graph port --
 * that is a separate, larger structural feature (see Anexo B gap list). */
enum class HartVariableDirection : uint8_t { Internal, Input, Output };

struct HartDevicePlan {
    std::string id;
    std::string profileId;
    std::string bus = "hart-1";
    uint8_t pollingAddress = 0;
    std::string uniqueId;
    double primaryValue = 0.0;
    struct CommandConfiguration {
        HartCommandId command = 0;
        bool enabled = true;
        bool hasStaticResponse = false;
        std::vector<uint8_t> staticResponse;
    };
    std::vector<CommandConfiguration> commandConfigurations;
    /** User-authored Core variables. A value is literal; expression is evaluated by
     * SignalExpression using the same grammar as control.calc_expression. */
    struct VariableConfiguration {
        std::string id;
        std::string name;
        std::string unit;
        double value = 0.0;
        std::string expression;
        bool writable = false;
        HartVariableRole role = HartVariableRole::Internal;
        HartVariableType type = HartVariableType::Float32;
        HartVariableDirection direction = HartVariableDirection::Internal;
        bool readable = true;
        /** Distinct from `writable`: `writable` says a HART command may SET this
         * value; `runtimeMutable` says the Property Inspector may edit it while
         * RUN is active (HART-FR-021). */
        bool runtimeMutable = false;
    };
    std::vector<VariableConfiguration> variables;
    /** Packed-ASCII device tag used by command 0x0B tag matching; falls back to
     * `id` when empty. */
    std::string tag;
};

struct HartProtocolPlan {
    std::vector<HartDevicePlan> devices;
};

struct HartPlanCompileResult {
    bool success = false;
    std::string error;
    HartProtocolPlan plan;
};

class HartPlanCompiler final {
public:
    static HartPlanCompileResult compile(std::span<const HartDevicePlan> devices,
                                         const HartProfileRegistry& profiles);
};

/** Virtual HART runtime. It is deliberately synchronous and bounded: no host I/O,
 * no worker per device and no string lookup in the command hot path. */
class HartEngine final {
public:
    explicit HartEngine(const HartProfileRegistry& profiles);
    bool loadPlan(HartProtocolPlan plan);
    void clear() noexcept;
    size_t deviceCount() const noexcept { return m_devices.size(); }
    bool setPrimaryValue(std::string_view deviceId, double value) noexcept;
    bool setCommandEnabled(std::string_view deviceId, HartCommandId command, bool enabled) noexcept;
    bool setCommandResponse(std::string_view deviceId, HartCommandId command,
                            std::span<const uint8_t> response) noexcept;
    bool registerCommandHandler(IHartCommandHandler& handler) { return m_commands.registerHandler(handler); }
    bool removeCommandHandler(HartCommandId command) noexcept { return m_commands.remove(command); }
    /** Consulted after per-device overrides and native `IHartCommandHandler`s,
     * before a command is treated as unsupported. Lets the semantic Hart
     * Command DSL (HartCommandProgram.hpp) dispatch compiled command programs
     * without HartEngine depending on the DSL module -- registering/removing a
     * DSL-backed command never requires editing HartEngine (HART-FR-005/006). */
    using CommandProgramHook = std::function<bool(const HartDeviceProfile&, const HartDevicePlan&, double primaryValue,
                                                   HartCommandId, std::span<const uint8_t>, HartResponseBuilder&)>;
    void setCommandProgramHook(CommandProgramHook hook) { m_programHook = std::move(hook); }
    bool execute(std::string_view bus, uint8_t pollingAddress, HartCommandId command,
                 std::span<const uint8_t> request, HartResponseBuilder& response) noexcept;
    bool execute(uint8_t pollingAddress, HartCommandId command,
                 std::span<const uint8_t> request, HartResponseBuilder& response) noexcept {
        return execute("hart-1", pollingAddress, command, request, response);
    }

private:
    struct RuntimeDevice {
        HartDevicePlan plan;
        const HartDeviceProfile* profile = nullptr;
        std::vector<std::shared_ptr<simulation::SignalExpression>> variableExpressions;
        std::vector<double> variableValues;
    };
    static double evaluatePrimary(RuntimeDevice&) noexcept;
    const HartProfileRegistry& m_profiles;
    HartCommandRegistry m_commands;
    std::vector<RuntimeDevice> m_devices;
    CommandProgramHook m_programHook;
};

} // namespace lasecsimul::protocols

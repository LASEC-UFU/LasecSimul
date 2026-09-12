#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
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
    uint8_t primaryVariableUnit = 57;
    float upperRangeValue = 100.0f;
    float lowerRangeValue = 0.0f;
};

/** Stable authoring-time edge from an I/O System to one child HART device.
 * The child remains a first-class HartDevicePlan in the same engine; this
 * record contains routing metadata only, never a copy of child state. */
struct HartSubDeviceLink {
    std::string childDeviceId;
    uint8_t ioCard = 0;
    uint8_t channel = 0;
    uint8_t pollingAddress = 0;
    uint16_t messagesSent = 0;
    uint16_t acknowledgementsReceived = 0;
    uint16_t backMessagesReceived = 0;
};

struct HartIoChannelStatistics {
    uint8_t ioCard = 0;
    uint8_t channel = 0;
    uint16_t stxSent = 0;
    uint16_t ackReceived = 0;
    uint16_t ostxReceived = 0;
    uint16_t oackReceived = 0;
    uint16_t backReceived = 0;
};

struct HartTrendConfiguration {
    uint8_t control = 0;
    uint8_t deviceVariableCode = 250;
    uint32_t samplePeriodSeconds = 0;
};

struct HartSynchronousActionConfiguration {
    uint8_t control = 0;
    uint8_t deviceVariableCode = 251;
    HartCommandId command = 0xFFFF;
    uint64_t triggerSeconds = 0;
    std::vector<uint8_t> requestData;
};

struct HartBurstConfiguration {
    uint8_t control = 0;
    HartCommandId command = 1;
    std::array<uint8_t, 8> deviceVariableCodes{{246, 250, 250, 250, 250, 250, 250, 250}};
    uint32_t updatePeriodTicks = 32u * 1000u;
    uint32_t maximumUpdatePeriodTicks = 32u * 1000u;
    uint8_t triggerMode = 0;
    uint8_t triggerClassification = 0;
    uint8_t triggerUnits = 250;
    float triggerValue = std::numeric_limits<float>::quiet_NaN();
    std::string mappedSubDeviceId;
};

struct HartBurstEvent {
    std::string deviceId;
    uint8_t burstMessage = 0;
    HartCommandId command = 0;
    uint64_t timestamp = 0;
    std::vector<uint8_t> payload;
};

struct HartCatchConfiguration {
    uint8_t destinationDeviceVariable = 250;
    uint8_t captureMode = 0;
    std::array<uint8_t, 5> sourceAddress{};
    uint8_t sourceSlot = 0;
    float shedTime = std::numeric_limits<float>::quiet_NaN();
    HartCommandId sourceCommand = 0;
};

struct HartEventNotificationConfiguration {
    uint8_t control = 0;
    uint32_t retryTimeTicks = 32000;
    uint32_t maximumUpdateTimeTicks = 32000;
    uint32_t debounceTimeTicks = 32000;
    uint8_t deviceStatusMask = 0;
    std::array<uint8_t, 25> eventMask{};
};

struct HartEventNotificationRecord {
    uint64_t timestamp = 0;
    uint32_t configurationChangedCounter = 0;
    uint16_t deviceStatus = 0;
    std::array<uint8_t, 25> command48Data{};
};

struct HartDeviceLocation {
    float latitude = 0.0f;
    float longitude = 0.0f;
    uint8_t method = 0;
    float altitude = 0.0f;
};

struct HartSubDeviceAssignment {
    uint16_t index = 0;
    uint8_t ioCard = 0xFF;
    uint8_t channel = 0xFF;
    uint16_t manufacturerId = 0;
    uint16_t expandedDeviceType = 0;
    uint32_t deviceId = 0;
    std::array<uint8_t, 32> longTag{};
    uint8_t deviceRevision = 0;
    uint8_t status = 0;
    std::string childDeviceId;
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

/** The only public value-ownership choices for a HART variable. */
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
    /** User-authored Core variables.  Signal expressions and transfer
     * functions belong to Signal Graph blocks, never to this record. */
    struct VariableConfiguration {
        std::string id;
        std::string name;
        std::string unit;
        double value = 0.0;
        HartVariableRole role = HartVariableRole::Internal;
        HartVariableType type = HartVariableType::Float32;
        HartVariableDirection direction = HartVariableDirection::Internal;
        /** Internal runtime policy; deliberately not part of normal authoring UX. */
        bool runtimeMutable = false;
        // Common Practice Device Variable metadata.  code 0xFF means that
        // this authored variable is not exposed as a Device Variable.
        uint8_t deviceVariableCode = 0xFF;
        uint8_t classification = 0;
        uint8_t family = 250;
        uint32_t transducerSerialNumber = 0;
        float upperTransducerLimit = 0.0f;
        float lowerTransducerLimit = 0.0f;
        float minimumSpan = 0.0f;
        float dampingValue = 0.0f;
        uint32_t acquisitionPeriod = 0xFFFFFFFFu;
        uint8_t deviceVariableProperties = 0;
        uint8_t deviceVariableStatus = 0;
        bool writable = false;
        std::vector<uint8_t> allowedUnitCodes;
        /** Numeric Device Variable units code; `unit` remains the UI label. */
        uint8_t deviceVariableUnit = 250;
        /** HCF_SPEC-160.05 Pressure Family metadata owned by this specific
         * Device Variable.  It is intentionally nested here so two pressure
         * variables cannot accidentally share observations, connection or
         * seal state. */
        struct PressureFamilyConfiguration {
            uint8_t status0 = 0;
            uint8_t familyDefinitionRevision = 0;
            uint8_t familyCapabilities0 = 0;
            uint8_t familyCapabilities1 = 0;
            uint8_t supportedStatusFamilyMask = 0;
            uint8_t supportedStatus0Mask = 0;
            uint8_t measurementType = 251;
            uint8_t moduleFillFluid = 251;
            uint8_t diaphragmMaterial = 251;
            uint8_t sensorHardwareRevision = 0;
            uint8_t sensorTechnology = 251;
            uint8_t pressureUnitCode = 251;
            float minimumAbsolutePressure = 0.0f;
            float maximumStaticPressure = 0.0f;
            std::array<uint8_t, 10> processConnection{{251, 251, 251, 251, 251, 251, 251, 251, 251, 251}};
            std::string associatedTemperatureVariableId;
            std::string associatedStaticPressureVariableId;
            std::array<uint8_t, 3> optionalGasket{{251, 251, 251}};
            uint8_t pressureObservationUnit = 251;
            float minimumPressureObservation = 0.0f;
            float maximumPressureObservation = 0.0f;
            uint8_t temperatureObservationUnit = 251;
            float minimumTemperatureObservation = 0.0f;
            float maximumTemperatureObservation = 0.0f;
            uint8_t staticPressureObservationUnit = 251;
            float minimumStaticPressureObservation = 0.0f;
            float maximumStaticPressureObservation = 0.0f;
            std::array<uint8_t, 7> remoteSeal{{0, 251, 251, 251, 251, 251, 251}};
            bool supportsOptionalGasket = false;
            bool supportsPressureObservation = false;
            bool supportsTemperatureObservation = false;
            bool supportsStaticPressureObservation = false;
            bool supportsRemoteSeal = false;
            bool supportsWriteProcessConnection = false;
            bool supportsWriteOptionalGasket = false;
            bool supportsWriteRemoteSeal = false;
        } pressure;
        /** HCF_SPEC-160.4 Rev. 2.0 Temperature Family metadata, owned by
         * this Device Variable. Base applicability is temperature
         * classification 64; optional thermocouple/RTD operations require
         * their explicit semantic capability. */
        struct TemperatureFamilyConfiguration {
            uint8_t familyStatus = 0;
            uint8_t familyStatus0 = 0;
            uint8_t probeType = 0;
            uint8_t numberOfWires = 0;
            uint8_t temperatureStandard = 0;
            uint8_t probeConnection = 0;
            uint8_t coldJunctionCompensationType = 0;
            uint8_t manualColdJunctionUnit = 250;
            float manualColdJunctionTemperature = 0.0f;
            float cvdA = 0.0f;
            float cvdB = 0.0f;
            float cvdC = 0.0f;
            float cvdR0 = 0.0f;
            bool supportsThermocouple = false;
            bool supportsCalibratedRtd = false;
            bool supportsWriteTemperatureStandard = false;
            bool supportsWriteProbeConnection = false;
            bool supportsWriteColdJunction = false;
        } temperature;
        /** Common Practice 35 range units. 0xFF means "not authored" and
         * resolves once from the profile default; unlike deviceVariableUnit,
         * this is intentionally independent of the PV engineering units. */
        uint8_t rangeUnitCode = 0xFF;
        /** Per-device PV range. NaN means use the profile default at plan
         * creation/execution; writes replace both values atomically. */
        float lowerRangeValue = std::numeric_limits<float>::quiet_NaN();
        float upperRangeValue = std::numeric_limits<float>::quiet_NaN();
        float zeroOffset = 0.0f;
        uint8_t trimPointsSupported = 0;
        uint8_t trimPointsUnit = 250;
        float lowerTrimPoint = std::numeric_limits<float>::quiet_NaN();
        float upperTrimPoint = std::numeric_limits<float>::quiet_NaN();
        float minimumLowerTrimPoint = std::numeric_limits<float>::quiet_NaN();
        float maximumLowerTrimPoint = std::numeric_limits<float>::quiet_NaN();
        float minimumUpperTrimPoint = std::numeric_limits<float>::quiet_NaN();
        float maximumUpperTrimPoint = std::numeric_limits<float>::quiet_NaN();
        float minimumTrimDifferential = std::numeric_limits<float>::quiet_NaN();
        float trimAdjustment = 0.0f;
        float factoryTrimAdjustment = 0.0f;
    };
    std::vector<VariableConfiguration> variables;
    /** Packed-ASCII device tag used by command 0x0B tag matching; falls back to
     * `id` when empty. */
    std::string tag;
    /** Universal Command 12/17 (Read/Write Message): up to 24 characters,
     * packed at execution time -- stored here in human-readable form, same
     * convention as `tag`. */
    std::string message;
    /** Universal Command 13/18 (Read/Write Tag, Descriptor, Date): Descriptor
     * is up to 16 characters, packed at execution time. */
    std::string descriptor;
    /** Universal Command 13/18: {day, month, year-1900}, the standard HART
     * Date encoding -- raw bytes, no packing. */
    std::array<uint8_t, 3> date{};
    /** Universal Command 16/19 (Read/Write Final Assembly Number): 3-byte
     * big-endian unsigned integer, raw bytes. */
    std::array<uint8_t, 3> finalAssemblyNumber{};
    /** Universal Command 20/21/22 (Read/Write Long Tag): up to 32 ISO
     * Latin-1 characters -- a completely separate data item from `tag`
     * (HCF_SPEC-127 6.20: "The Tag and Long Tag are completely separate
     * data items."). */
    std::string longTag;
    /** Universal Command 6/7 (Write Polling Address / Read Loop
     * Configuration): Common Table 16 code, 1 = Enabled (HART-default
     * "active" per HCF_SPEC-127 6.7). `pollingAddress` above already exists
     * and doubles as this device's bus address (used for lookup in
     * `HartEngine::execute()`) -- Command 6 writing it is therefore a REAL
     * live-readdressing mutation, not just a stored field. */
    uint8_t loopCurrentMode = 1;
    /** Universal Command 15 (Read Device Information) reads these; Common
     * Practice writes for transfer-function/alarm code mutate the same
     * fields. PV damping is owned by VariableConfiguration::dampingValue,
     * the canonical Device Variable property shared by Commands 34/54/15. */
    uint8_t pvTransferFunctionCode = 0x00;
    uint8_t alarmSelectionCode = 0xFB;
    uint8_t writeProtectCode = 0xFB;
    uint8_t responsePreambles = 5;
    std::array<uint8_t, 4> dynamicVariableAssignments{{246, 250, 250, 250}};
    // Analog Channel 0 is the mandatory Primary/Loop Current channel. The
    // model is deliberately singular until a profile declares more channels.
    bool analogChannel0Supported = true;
    uint8_t analogChannel0UnitCode = 39; // HART mA unit code
    uint8_t analogChannel0RangeUnitCode = 39;
    float analogChannel0LowerRangeValue = 4.0f;
    float analogChannel0UpperRangeValue = 20.0f;
    float analogChannel0LowerLimit = 0.0f;
    float analogChannel0UpperLimit = 20.0f;
    float analogChannel0AdditionalDamping = 0.0f;
    uint8_t analogChannel0Flags = 0;
    // Canonical loop-current/calibration state shared by Universal 2/3 and
    // Common Practice 40/45/46. These are device state, not command caches.
    bool fixedCurrentMode = false;
    float fixedCurrentMilliamps = 0.0f;
    float loopCurrentZeroTrim = 0.0f;
    float loopCurrentGainTrim = 1.0f;
    float primaryVariableZeroOffset = 0.0f;
    uint8_t diagnosticStatus = 0;
    std::array<uint8_t, 2> countryCode{{' ', ' '}};
    uint8_t siUnitsControl = 0;
    bool eventManagerRegistered = false;
    uint8_t eventManagerOwner = 0;
    bool deviceLocationSupported = false;
    HartDeviceLocation deviceLocation{};
    bool locationDescriptionSupported = false;
    bool processUnitTagSupported = false;
    std::array<uint8_t, 32> locationDescription{};
    std::array<uint8_t, 32> processUnitTag{};
    bool condensedStatusSupported = false;
    std::array<uint8_t, 208> condensedStatusMapping{};
    bool statusSimulationEnabled = false;
    std::array<uint8_t, 208> simulatedStatusMask{};
    std::array<uint8_t, 208> simulatedStatusValues{};
    // Common Practice 71/76.  The requested Lock Code is the sole
    // persistent semantic state; status bits are derived at execution time.
    uint8_t lockCode = 0; // Common Table 18: 0 unlocked, 1 temporary, 2 permanent, 3 lock all
    uint8_t lockOwner = 0; // 0 primary master, 1 secondary master, 2 gateway
    // Common Practice 72.  This is a virtual semantic state/event, not a UI
    // or wall-clock timer.  0=off, 1=on, 2=squawk once (consumed on read).
    uint8_t squawkControl = 0;
    uint8_t squawkEvent = 0;
    bool findDeviceArmed = false;
    // A non-empty list is the semantic I/O System capability.  No synthetic
    // child is created for an ordinary device.
    bool ioSystem = false;
    uint8_t ioMaximumCards = 1;
    uint8_t ioMaximumChannelsPerCard = 1;
    uint8_t ioMaximumSubDevicesPerChannel = 1;
    uint8_t ioMaximumDelayedResponses = 2;
    uint8_t ioMasterMode = 1;
    uint8_t ioRetryCount = 3;
    bool ioSubDeviceListChanged = false;
    std::vector<HartSubDeviceLink> subDevices;
    uint8_t assignmentCapacity = 0;
    uint8_t assignmentCount = 0;
    std::array<HartSubDeviceAssignment, 32> assignments{};
    std::vector<HartIoChannelStatistics> ioChannelStatistics;
    bool rtcSupported = false;
    bool rtcNonVolatile = false;
    bool rtcInitialized = false;
    uint64_t rtcSetVirtualSeconds = 0;
    uint64_t rtcValueSeconds = 0;
    uint64_t rtcLastSetSeconds = 0;
    uint64_t virtualTimeSeconds = 0; // runtime injection from the session Scheduler; never wall clock
    /** Universal Command 38 (Reset Configuration Changed Flag): a single
     * device-wide counter, incremented by any command that mutates
     * persisted configuration (compile-error fix during this session's
     * audit -- Device Family Pressure write commands 1408-1410 already
     * incremented this field before it existed on `HartDevicePlan`, so this
     * adds the missing declaration rather than redesigning the feature).
     * Command 38 itself still only echoes the request's counter (see
     * Anexo E.4/F.11.2) -- wiring it to compare/reset against this real
     * counter is follow-up work, not done as part of this fix. */
    uint32_t configurationChangedCounter = 0;
    uint8_t trendCount = 0;
    std::array<HartTrendConfiguration, 4> trends{};
    uint8_t actionCount = 0;
    std::array<HartSynchronousActionConfiguration, 4> synchronousActions{};
    std::array<HartSynchronousActionConfiguration, 4> commandActions{};
    uint8_t burstMessageCount = 3;
    std::array<HartBurstConfiguration, 3> burstMessages{};
    std::array<HartCatchConfiguration, 8> catchConfigurations{};
    std::array<HartEventNotificationConfiguration, 1> eventNotifications{};
    uint32_t clientMessagesReceived = 0;
    uint32_t clientMessagesReturned = 0;
    uint32_t clientRequestsForwarded = 0;
    uint32_t clientResponsesReturned = 0;
    uint16_t deviceStxReceived = 0;
    uint16_t deviceAckSent = 0;
    uint16_t deviceBackSent = 0;
    struct WirelessConfiguration {
        bool capable = false;
        std::array<uint8_t, 16> joinKey{};
        uint16_t networkId = 0;
        uint16_t pendingNetworkId = 0;
        std::array<uint8_t, 32> networkTag{};
        uint8_t joinMode = 0;
        uint32_t activeSearchShedTime = 0;
        uint8_t maxJoinRetries = 5;
        uint8_t wirelessMode = 0;
        uint16_t joinStatus = 0;
        uint8_t availableNeighbors = 0;
        uint8_t advertisingPacketsReceived = 0;
        uint8_t joinAttempts = 0;
        uint32_t joinRetryTimer = 0;
        uint32_t networkSearchTimer = 0;
        uint32_t activeAdvertisingShedTime = 0;
        uint32_t advertisingPeriod = 0;
        uint8_t advertisingNeighbors = 0;
        uint8_t radioTransmitPower = 0;
        uint8_t ccaMode = 0;
        uint32_t packetTimeToLive = 0;
        uint8_t joinPriority = 0;
        uint8_t packetReceivePriority = 0;
        uint8_t networkAccessMode = 0;
        uint8_t joinKeyMode = 0;
        uint16_t batteryLifeDays = 0xFFFF;
        uint16_t nickname = 0;
        uint8_t securityLevelAdvertised = 1;
        std::array<uint8_t, 16> networkKey{};
        uint64_t pendingNetworkKeyExecutionAsn = 0;
        uint8_t statusCounterMode = 0;
        uint8_t securityLevelSupported = 1;
        uint8_t capabilityFlags = 0;
        uint8_t powerSource = 0;
        float peakPacketsPerSecond = 1.0f;
        uint32_t peakLoadDuration = 86400;
        uint32_t powerRecoveryTime = 0;
        int8_t goodConnectionRsl = -80;
        uint32_t requiredKeepAlive = 60;
        uint16_t maximumNeighbors = 32;
        uint16_t maximumPacketBuffers = 32;
        std::array<uint32_t, 8> timerIntervals{};
        float staleDataTimer = 100.0f;
        uint8_t staleDataCountSetpoint = 3;
        uint64_t suspendAtAsn = 0;
        uint64_t resumeAtAsn = 0;
        struct Session { uint8_t type = 0; uint16_t peerNickname = 0; std::array<uint8_t, 5> peerUniqueId{}; uint32_t peerNonce = 0; uint32_t deviceNonce = 0; std::array<uint8_t, 16> key{}; uint64_t executionTimeAsn = 0; };
        struct Superframe { uint8_t id = 0; uint16_t slots = 0; uint8_t modeFlags = 0; uint64_t executionTimeAsn = 0; };
        struct Link { uint8_t superframeId = 0; uint16_t slot = 0; uint8_t channelOffset = 0; uint16_t neighborNickname = 0xFFFF; uint8_t options = 0; uint8_t type = 0; };
        struct Graph { uint16_t id = 0; std::array<uint16_t, 16> neighbors{}; uint8_t neighborCount = 0; };
        struct Route { uint8_t id = 0; uint16_t destinationNickname = 0; uint16_t graphId = 0; bool sourceRouteAttached = false; };
        struct Timetable { uint8_t id = 0; uint8_t requestFlags = 0; uint8_t domain = 0; uint16_t peerNickname = 0; uint32_t period = 0; uint8_t routeId = 0; };
        std::array<Session, 8> sessions{}; uint8_t sessionCount = 0;
        std::array<Superframe, 8> superframes{}; uint8_t superframeCount = 0;
        std::array<Link, 32> links{}; uint8_t linkCount = 0;
        struct NeighborProperty { uint16_t nickname = 0; uint8_t flags = 0; };
        std::array<NeighborProperty, 32> neighborProperties{}; uint8_t neighborPropertyCount = 0;
        std::array<Graph, 8> graphs{}; uint8_t graphCount = 0;
        std::array<Route, 8> routes{}; uint8_t routeCount = 0;
        struct SourceRoute { uint8_t routeId = 0; std::array<uint16_t, 16> hops{}; uint8_t hopCount = 0; };
        std::array<SourceRoute, 8> sourceRoutes{}; uint8_t sourceRouteCount = 0;
        std::array<Timetable, 8> timetables{}; uint8_t timetableCount = 0;
        struct DeviceListEntry { uint8_t listCode = 0; std::array<uint8_t, 5> uniqueId{}; };
        std::array<DeviceListEntry, 64> deviceListEntries{}; uint8_t deviceListCount = 0;
        std::array<uint8_t, 2> channelBlacklist{{0xFF, 0xFF}};
        std::array<uint8_t, 2> pendingChannelBlacklist{{0xFF, 0xFF}};
    } wireless;
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
    bool setVariableInput(std::string_view deviceId, std::string_view variableId, double value) noexcept;
    std::optional<double> variableValue(std::string_view deviceId, std::string_view variableId) const noexcept;
    /** Read-only view of a device's CURRENT runtime plan -- in particular the
     * identity fields a write command's `CommandProgramHook` may have
     * mutated (tag/message/descriptor/date/finalAssemblyNumber/longTag/
     * pollingAddress/loopCurrentMode). Lets a host component (e.g.
     * `HartCommunicationComponent`) sync those live changes back into its
     * own persisted properties after a transaction, so a HART write
     * command's effect survives save/reopen and not just the live session. */
    const HartDevicePlan* findDevicePlan(std::string_view deviceId) const noexcept;
    bool setCommandEnabled(std::string_view deviceId, HartCommandId command, bool enabled) noexcept;
    bool setCommandResponse(std::string_view deviceId, HartCommandId command,
                            std::span<const uint8_t> response) noexcept;
    bool registerCommandHandler(IHartCommandHandler& handler) { return m_commands.registerHandler(handler); }
    bool removeCommandHandler(HartCommandId command) noexcept { return m_commands.remove(command); }
    /** Consulted after per-device overrides and native `IHartCommandHandler`s,
     * before a command is treated as unsupported. Lets the semantic Hart
     * Command DSL (HartCommandProgram.hpp) dispatch compiled command programs
     * without HartEngine depending on the DSL module -- registering/removing a
     * DSL-backed command never requires editing HartEngine (HART-FR-005/006).
     *
     * `HartDevicePlan&` is intentionally mutable: a write command (e.g.
     * Universal 6/17/18/19/22) mutates identity fields through the DSL's SET
     * primitive, and the hook is expected to persist those changes into the
     * plan it was given. `HartEngine::execute()` copies that mutated plan
     * back into the real runtime device after a successful call -- a write
     * command is not just a response byte, it is a real state change (this
     * was NOT true before the persistence fix landed: SET previously mutated
     * a throwaway `HartExecutionVariables` copy that was discarded when
     * `HartCommandExecutor::execute` returned, so every "write" command
     * would have reported success while changing nothing). */
    using CommandProgramHook = std::function<bool(const HartDeviceProfile&, HartDevicePlan&, double primaryValue,
                                                   HartCommandId, std::span<const uint8_t>, HartResponseBuilder&, uint8_t masterRole)>;
    void setCommandProgramHook(CommandProgramHook hook) { m_programHook = std::move(hook); }
    bool execute(std::string_view bus, uint8_t pollingAddress, HartCommandId command,
                 std::span<const uint8_t> request, HartResponseBuilder& response) noexcept;
    /** `masterRole`: 0 primary, 1 secondary, 2 gateway.  Existing callers
     * use the primary-master default; the explicit overload lets Lock Device
     * enforce its owner semantics without inventing command-local state. */
    bool execute(std::string_view bus, uint8_t pollingAddress, HartCommandId command,
                 std::span<const uint8_t> request, HartResponseBuilder& response,
                 uint8_t masterRole) noexcept;
    bool execute(std::string_view bus, uint8_t pollingAddress, HartCommandId command,
                 std::span<const uint8_t> request, HartResponseBuilder& response,
                 uint8_t masterRole, uint8_t routingDepth) noexcept;
    bool execute(uint8_t pollingAddress, HartCommandId command,
                 std::span<const uint8_t> request, HartResponseBuilder& response) noexcept {
        return execute("hart-1", pollingAddress, command, request, response);
    }
    void setVirtualTimeSeconds(uint64_t seconds) noexcept;
    uint64_t virtualTimeSeconds() const noexcept { return m_virtualTimeSeconds; }
    std::vector<HartBurstEvent> takeBurstEvents(std::string_view deviceId) noexcept;
    bool setDiagnosticStatus(std::string_view deviceId, uint8_t status) noexcept;

private:
    struct RuntimeDevice {
        HartDevicePlan plan;
        const HartDeviceProfile* profile = nullptr;
        std::vector<double> variableValues;
        struct TrendSample { uint64_t timestamp = 0; float value = std::numeric_limits<float>::quiet_NaN(); uint8_t status = 0x30; };
        std::array<std::array<TrendSample, 12>, 4> trendSamples{};
        std::array<uint8_t, 4> trendSampleCounts{};
        std::array<uint8_t, 4> trendSampleNext{};
        std::array<uint64_t, 4> trendNextSampleTime{};
        std::array<bool, 4> actionFired{};
        std::array<uint64_t, 3> burstNextSampleTime{};
        std::array<float, 3> burstLastValues{};
        std::vector<HartBurstEvent> burstEvents;
        bool transferOpen = false;
        uint8_t transferPort = 250;
        uint8_t transferMaximumSegment = 0;
        uint16_t transferMasterCounter = 0;
        uint16_t transferDeviceCounter = 0;
        std::array<float, 8> caughtValues{};
        std::array<uint8_t, 8> caughtStatuses{};
        std::array<uint64_t, 8> caughtTimestamps{};
        std::array<bool, 8> caughtValid{};
        std::vector<HartEventNotificationRecord> eventRecords;
    };
    void advanceVirtualState(uint64_t previous, uint64_t current) noexcept;
    void sampleTrend(RuntimeDevice& device, size_t trendIndex, uint64_t timestamp) noexcept;
    void runDueActions(RuntimeDevice& device, uint64_t previous, uint64_t current) noexcept;
    void runDueBursts(RuntimeDevice& device, uint64_t previous, uint64_t current) noexcept;
    static double evaluatePrimary(RuntimeDevice&) noexcept;
    const HartProfileRegistry& m_profiles;
    HartCommandRegistry m_commands;
    std::vector<RuntimeDevice> m_devices;
    CommandProgramHook m_programHook;
    uint64_t m_virtualTimeSeconds = 0;
};

} // namespace lasecsimul::protocols

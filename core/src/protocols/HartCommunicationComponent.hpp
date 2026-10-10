#pragma once

#include "HartReferenceCatalog.hpp"
#include "HartLcd.hpp"
#include "HartPhysicalLayer.hpp"
#include "HartTransport.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "registry/ComponentParams.hpp"
#include "simulation/Scheduler.hpp"

#include <array>
#include <memory>
#include <optional>

namespace lasecsimul::protocols {

/** HART field device (and the UDP tap). A field device communicates only through its
 * 4-20 mA loop terminals: it demodulates the master's voltage carrier seen across LOOP+/LOOP-
 * and answers by modulating ±0.5 mA on its loop current (Bell 202, HartPhysicalLayer.hpp).
 * There is no serial port in the device -- a PC reaches it through a HART modem wired in the
 * loop (HartModemComponent). */
class HartCommunicationComponent final : public IComponentModel {
public:
    enum class Mode : uint8_t { Serial, Udp };

    /** Identifies a concrete, pre-configured field device built on top of this SAME class/engine
     * (FEAT: HART concrete devices -- SMAR LD301/TT301/FY301). `typeId` is what `typeId()` reports
     * (and what gets persisted/reloaded), decoupled from `mode` so a device preset can fix the
     * wired transport (Mode::Serial) while still exposing its own catalog identity instead of
     * lying as a generic "protocol.hart.internal". The remaining fields become the property
     * schema's `defaultValue` (what a freshly-dropped instance receives via
     * `ComponentParams::properties`, see `CoreApplication.cpp`'s `registerHartDevice`) AND this
     * constructor's own fallback (so a component built with an empty `ComponentParams` -- e.g. a
     * unit test -- still gets the right profile instead of silently falling back to the generic
     * one). No new engine/dispatcher code: only default configuration data layered on the existing
     * generic HART engine. */
    struct DevicePreset {
        const char* typeId;
        std::string profileId;
        std::string tag;
        std::string uniqueId;
        std::string unit;
        std::string hartVariablesJson;
        /** JSON object of per-instance property defaults the concrete device
         * ships with (identity text, alarm/write-protect codes, ...). A saved
         * property always wins over these. */
        std::string propertyDefaultsJson = "{}";
    };

    HartCommunicationComponent(Mode mode, simulation::Scheduler& scheduler,
                               const registry::ComponentParams& params, const DevicePreset* preset = nullptr);
    ~HartCommunicationComponent() override { *m_alive = false; }

    const char* typeId() const override;
    std::span<Pin> pins() override { return m_fieldDevice ? std::span<Pin>{m_pins} : std::span<Pin>{}; }
    void onAssignedIndex(uint32_t index) override;
    std::vector<SignalPortDescriptor> signalPorts() const override;
    /** signalPorts() without the copy, for the per-step Signal Graph bridges. */
    const std::vector<SignalPortDescriptor>& cachedSignalPorts() const;
private:
    std::vector<SignalPortDescriptor> parseSignalPorts() const;
    /** Bumped on every assignment of m_hartVariablesJson: validating the port cache by comparing
     * the whole JSON (18 KB for the LD301) on every stable step cost microseconds per step. */
    uint64_t m_hartVariablesRevision = 1;
    mutable uint64_t m_signalPortsRevision = 0;
    mutable std::vector<SignalPortDescriptor> m_signalPortsCache;
public:
    std::string signalBlockId(std::string_view variableId) const;
    bool setSignalInput(std::string_view variableId, double value) noexcept;
    std::optional<double> signalOutput(std::string_view variableId) const noexcept;
    uint32_t extraVariableCount() const override { return 0; }
    void stamp(MnaMatrixView&) override;
    /** Field device terminals: 0/1 = signal input (sensor_plus/minus), 2/3 =
     * 4-20 mA loop (loop_plus/minus). Wiring decides the PV source. */
    void onPinConnectionChanged(size_t pinIndex, bool connected) override {
        if (pinIndex < m_pinConnected.size()) m_pinConnected[pinIndex] = connected;
    }
    /** Loop current (mA) the device drives on loop_plus/loop_minus. */
    double loopCurrentMilliamps() const noexcept { return m_loopCurrent * 1000.0; }
    /** PV damping (HART Command 34): a first-order filter on the process
     * input, advanced here (LD301 manual: 0..128 s time constant). */
    void postStep(uint64_t deltaNs) override;
    bool isDynamic() const override { return m_fieldDevice; }
    size_t getState(uint8_t* out, size_t cap) const override;
    /** Telemetry of a field device: f64 loop current (mA, the scalar
     * readout), u32 'LCD1' marker, then the local display frame
     * (HartLcd.hpp, `kHartLcdPayloadBytes`). */
    size_t getTelemetryState(uint8_t* out, size_t cap) const override;
    /** What the local display shows now (also used by tests). */
    HartLcdFrame displayFrame(std::optional<uint64_t> elapsedNs = std::nullopt) const;
    void setState(const uint8_t* in, size_t len) override;
    std::vector<PropertyDescriptor> propertyDescriptors() override;
    bool transact(std::span<const uint8_t> request, HartResponseBuilder& response) noexcept {
        if (!m_enabled) return false;
        const bool ok = m_endpoint.transact(request, response);
        // A write command (6/17/18/19/22/...) may have just mutated the
        // device's identity fields via HartEngine's persistence fix -- pull
        // that state back into this component's OWN persisted properties so
        // it survives save/reopen, not just the live session (see
        // syncPersistedStateFromEngine's doc comment).
        if (ok) syncPersistedStateFromEngine();
        return ok;
    }
    const HartTransportCounters& counters() const noexcept { return m_endpoint.counters(); }
    /** HART frames received on the loop wire / replies modulated back. */
    uint32_t wireFramesReceived() const noexcept { return m_wireFramesReceived; }
    uint32_t wireRepliesSent() const noexcept { return m_wireRepliesSent; }
    bool wireTransmitting() const noexcept { return m_wireTx.active(); }

    static std::vector<PropertySchema> propertySchema(Mode mode, const DevicePreset* preset = nullptr);
    static ReadoutFormat readoutFormat() { return {ReadoutKind::Scalar, "mA", 0}; } // field devices: loop current

    /** Canonical DevicePreset for each concrete SMAR device (FEAT: HART concrete devices). The
     * SINGLE source of truth both `CoreApplication.cpp`'s catalog registration and the regression
     * tests consume, so the registered typeId/profile/default Signal Graph ports can never silently
     * drift from what is actually tested. */
    static DevicePreset smarLd301Preset();
    static DevicePreset smarTt301Preset();
    static DevicePreset smarFy301Preset();
    /** The standard (generic) HART field device all concrete transmitters
     * are built from. */
    static DevicePreset standardFieldDevicePreset();

private:
    static std::string stringProperty(const registry::ComponentParams&, const char*, std::string);
    static double numberProperty(const registry::ComponentParams&, const char*, double);
    void setPropertyValue(const std::string&, const PropertyValue&);
    PropertyValue propertyValue(const std::string&) const;
    void rebuildConfiguredPlan();
    /** Parses `m_hartCommandsJson` (Property Inspector Commands editor) and
     * installs it merged with the reference catalog's built-in 0x00/0x01/0x03/
     * 0x0B/0x21 via `HartReferenceCatalog::installCommandPrograms`, recording
     * the outcome in `m_hartCommandsStatus` for the Diagnostics section. */
    void rebuildCommandPrograms();
    /** Pulls `m_engine`'s CURRENT plan for this device (via
     * `HartEngine::findDevicePlan`) into `m_tag`/`m_message`/`m_descriptor`/
     * `m_date*`/`m_finalAssemblyNumber`/`m_longTag`/`m_pollingAddress`/
     * `m_loopCurrentModeEnabled` -- the members `propertyValue()` reads and
     * project persistence serializes. Called after every successful
     * `transact()`. Bypasses `setPropertyValue`/`rebuildConfiguredPlan()`
     * deliberately: this reflects device-side state INTO storage, it is not
     * a user edit, and must never itself trigger a full plan rebuild (which
     * would be redundant here and, for other properties, actually wrong --
     * a HART write command's effect must not look like an authoring change
     * for undo/redo purposes). */
    void syncPersistedStateFromEngine();

    Mode m_mode;
    std::string m_typeId;
    simulation::Scheduler& m_scheduler;
    HartProfileRegistry m_profiles;
    HartEngine m_engine;
    HartTransportEndpoint m_endpoint;
    std::string m_bus = "hart-1";
    std::string m_endpointName;
    std::string m_deviceId;
    std::string m_profileId = "lasecsimul.hart.process-simul-compatible";
    std::string m_uniqueId = "029EB1";
    std::string m_tag = "HART";
    std::string m_unit = "V";
    uint8_t m_pollingAddress = 0;
    uint32_t m_baudRate = 1200;
    uint16_t m_udpPort = 5094;
    bool m_enabled = true;
    std::string m_hartVariablesJson = "[]", m_hartCommandsJson = "[]";
    std::string m_hartBurstJson = "[]";
    std::string m_hartAdditionalJson = "{}";
    uint8_t m_alarmSelectionCode = 0xFB;
    uint8_t m_writeProtectCode = 0xFB;
    /** Per-instance HART profile traits. They start from the registered
     * profile and can be changed per transmitter (Property Inspector or a
     * device template): identity bytes reported by Command 0, the Universal
     * revision whose layouts are implemented, the supported standard command
     * set and the analog output saturation. */
    struct ProfileTraits {
        double manufacturerId = 0, deviceType = 0, requestPreambles = 5, universalRevision = 7, deviceRevision = 1,
               softwareRevision = 1, hardwareRevision = 0, flags = 0, implementedRevision = 7;
        double saturationLowPercent = -1000.0, saturationHighPercent = 1000.0;
        /** 0 = not declared (loop test uses the saturation band; no burnout). */
        double fixedLowMilliamps = 0, fixedHighMilliamps = 0, alarmLowMilliamps = 0, alarmHighMilliamps = 0;
        double rangeTolerancePercent = 0, minimumSpanAcceptPercent = 100;
        std::string commandSet;
        /** "43=counter.zero;35,36,37=counter.range": operation counters. */
        std::string operationCounters;
        /** Alarm Selection Codes of the high/low burnout current; the Write
         * Protect Code that refuses writes (above 255: none). */
        double alarmHighCode = 0, alarmLowCode = 1, writeProtectActiveCode = 1, burnoutStatus = 0x04;
        bool coldStartKeptByCommand0 = false, burnoutPercentFollowsOutput = false;
        /** HART 6/7 Command 0 trailer. */
        double maxDeviceVariables = 0, privateLabel = 0, deviceProfile = 1;
        /** "15=17": at most 17 response data bytes for Command 15. */
        std::string responseDataLimits;
    } m_traits;
    /** Configuration Change Counter (HART 6/7 Command 0), persisted. */
    uint32_t m_configChangeCounter = 0;
    /** HartLcdGlass: which indicator glass the device has. */
    double m_displayGlass = 0;
    void resolveProfileTraits(const registry::ComponentParams& params, const std::string& defaultsJson);
    uint8_t m_configurationChangedFlags = 0;
    uint32_t m_componentIndex = 0;
    /** Universal Command 12/17, 13/18, 16/19, 20/22, 6/7 persisted state
     * (Anexo F.6 gap closed): these mirror `HartDevicePlan`'s identity
     * fields and are the save/reopen-durable copy `syncPersistedStateFromEngine`
     * writes into after a HART write command changes the live device. */
    std::string m_message, m_descriptor, m_longTag;
    /** {day, month, year-1900}, split into 3 persisted number properties
     * (dateDay/dateMonth/dateYear) rather than one packed/hex text field --
     * no string-parsing code needed, and the Property Inspector gets 3
     * plain numeric fields for free from the existing schema helpers. */
    std::array<uint8_t, 3> m_date{};
    uint32_t m_finalAssemblyNumber = 0;
    bool m_loopCurrentModeEnabled = true;
    // Field devices have a real measurement input (S+/S-) and a 4-20 mA
    // loop (LOOP+/LOOP-). HART frames deliberately have no electrical pins.
    bool m_fieldDevice = false;
    std::array<Pin, 4> m_pins{};
    double m_sensorLowVolts = 0.0, m_sensorHighVolts = 5.0;
    /** Process value (PV units) at sensorLowVolts / sensorHighVolts: the
     * physical scale of the injected signal. Deliberately independent of the
     * HART-configurable LRV/URV -- re-ranging a transmitter never changes the
     * pressure it is exposed to. */
    double m_sensorLowValue = 0.0, m_sensorHighValue = 0.0;
    std::array<bool, 4> m_pinConnected{};
    /** Local display: installed?, the one or two variables it shows (a
     * source token, or `var:<id>` resolved through `m_displayCodeMap`), and
     * the model name of the power-up page. */
    bool m_displayInstalled = true;
    std::string m_displayVariable1 = "pv";
    std::string m_displayVariable2;
    std::string m_displayCodeMap;
    std::string m_displayModelName = "HART";
    uint64_t m_powerOnNs = 0;
    HartLcdPage displayPage(const std::string& source, const HartDevicePlan& plan, double pv,
                            const HartAnalogOutput& analog) const;
    double m_loopCurrent = 0.004;
    /** HART on the wire (field devices): receiver of the master's carrier,
     * transmitter of the replies, frames waiting for the engine. */
    HartFskTransmitter m_wireTx;
    HartFskReceiver m_wireRx;
    HartFrameAssembler m_wireFrames;
    std::vector<std::vector<uint8_t>> m_wireRequests;
    std::vector<uint8_t> m_wireReply;
    uint64_t m_wireRequestEndNs = 0;
    bool m_wireProcessScheduled = false;
    bool m_wireReplyWaiting = false;
    bool m_wireSampling = false;
    uint32_t m_wireFramesReceived = 0;
    uint32_t m_wireRepliesSent = 0;
    std::shared_ptr<bool> m_alive = std::make_shared<bool>(true);
    void onWireRequests();
    void onWireReplyCheck();
    void onWireCarrierSample();
    /** Simulated sensor failure (property `sensorFault`). */
    bool m_sensorFault = false;
    /** Sensor failure detected by the model's input stage (signal input `sensorFault`, e.g. an open
     * RTD seen by the 4-wire measurement of a TT301); the device fails when either is set. */
    bool m_signalSensorFault = false;
    /** Raw (undamped) process input and the damped value fed to the engine. */
    double m_rawPrimary = std::numeric_limits<double>::quiet_NaN();
    double m_dampedPrimary = std::numeric_limits<double>::quiet_NaN();
    double primaryDampingSeconds() const;
    void feedPrimary(double raw);
    /** "OK" or "ERROR: <compiler message>" -- read-only, shown in the Property
     * Inspector's Diagnostics/Commands section (never a silent failure). */
    std::string m_hartCommandsStatus = "OK";
    /** Same idea for the Variables editor (id/direction/duplicate validation). */
    std::string m_hartVariablesStatus = "OK";
};

} // namespace lasecsimul::protocols

#pragma once

#include "HartReferenceCatalog.hpp"
#include "HartTransport.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "registry/ComponentParams.hpp"
#include "simulation/Scheduler.hpp"

#include <array>
#include <memory>

namespace lasecsimul::protocols {

/** Core-side HART communication block.  It is deliberately non-electrical: a serial/UDP
 * adapter submits bounded HART frames through the Core IPC endpoint and receives the encoded
 * response.  This prevents a second COM/socket implementation from competing with the existing
 * terminal and keeps protocol execution on the simulation thread. */
class HartCommunicationComponent final : public IComponentModel {
public:
    enum class Mode : uint8_t { Serial, Udp };

    /** Identifies a concrete, pre-configured field device built on top of this SAME class/engine
     * (FEAT: HART concrete devices -- SMAR LD301/TT301/FY301). `typeId` is what `typeId()` reports
     * (and what gets persisted/reloaded), decoupled from `mode` so a device preset can fix the
     * wired transport (Mode::Serial) while still exposing its own catalog identity instead of
     * lying as a generic "protocol.hart.serial". The remaining fields become the property
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
    };

    HartCommunicationComponent(Mode mode, simulation::Scheduler& scheduler,
                               const registry::ComponentParams& params, const DevicePreset* preset = nullptr);
    ~HartCommunicationComponent() override = default;

    const char* typeId() const override;
    std::span<Pin> pins() override { return {}; }
    void onAssignedIndex(uint32_t index) override;
    std::vector<SignalPortDescriptor> signalPorts() const override;
    std::string signalBlockId(std::string_view variableId) const;
    bool setSignalInput(std::string_view variableId, double value) noexcept;
    std::optional<double> signalOutput(std::string_view variableId) const noexcept;
    uint32_t extraVariableCount() const override { return 0; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t* out, size_t cap) const override;
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

    static std::vector<PropertySchema> propertySchema(Mode mode, const DevicePreset* preset = nullptr);
    static ReadoutFormat readoutFormat() { return {ReadoutKind::Scalar, "", 0}; }

    /** Canonical DevicePreset for each concrete SMAR device (FEAT: HART concrete devices). The
     * SINGLE source of truth both `CoreApplication.cpp`'s catalog registration and the regression
     * tests consume, so the registered typeId/profile/default Signal Graph ports can never silently
     * drift from what is actually tested. */
    static DevicePreset smarLd301Preset();
    static DevicePreset smarTt301Preset();
    static DevicePreset smarFy301Preset();

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
    /** "OK" or "ERROR: <compiler message>" -- read-only, shown in the Property
     * Inspector's Diagnostics/Commands section (never a silent failure). */
    std::string m_hartCommandsStatus = "OK";
    /** Same idea for the Variables editor (id/direction/duplicate validation). */
    std::string m_hartVariablesStatus = "OK";
};

} // namespace lasecsimul::protocols

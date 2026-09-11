#pragma once

#include "HartReferenceCatalog.hpp"
#include "HartTransport.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "registry/ComponentParams.hpp"
#include "simulation/Scheduler.hpp"

#include <memory>

namespace lasecsimul::protocols {

/** Core-side HART communication block.  It is deliberately non-electrical: a serial/UDP
 * adapter submits bounded HART frames through the Core IPC endpoint and receives the encoded
 * response.  This prevents a second COM/socket implementation from competing with the existing
 * terminal and keeps protocol execution on the simulation thread. */
class HartCommunicationComponent final : public IComponentModel {
public:
    enum class Mode : uint8_t { Serial, Udp };

    HartCommunicationComponent(Mode mode, simulation::Scheduler& scheduler,
                               const registry::ComponentParams& params);
    ~HartCommunicationComponent() override = default;

    const char* typeId() const override;
    std::span<Pin> pins() override { return {}; }
    uint32_t extraVariableCount() const override { return 0; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t* out, size_t cap) const override;
    void setState(const uint8_t* in, size_t len) override;
    std::vector<PropertyDescriptor> propertyDescriptors() override;
    bool transact(std::span<const uint8_t> request, HartResponseBuilder& response) noexcept {
        if (!m_enabled) return false;
        return m_endpoint.transact(request, response);
    }
    const HartTransportCounters& counters() const noexcept { return m_endpoint.counters(); }

    static std::vector<PropertySchema> propertySchema(Mode mode);
    static ReadoutFormat readoutFormat() { return {ReadoutKind::Scalar, "", 0}; }

private:
    static std::string stringProperty(const registry::ComponentParams&, const char*, std::string);
    static double numberProperty(const registry::ComponentParams&, const char*, double);
    void setPropertyValue(const std::string&, const PropertyValue&);
    PropertyValue propertyValue(const std::string&) const;

    Mode m_mode;
    simulation::Scheduler& m_scheduler;
    HartProfileRegistry m_profiles;
    HartEngine m_engine;
    HartTransportEndpoint m_endpoint;
    std::string m_bus = "hart-1";
    std::string m_endpointName;
    std::string m_uniqueId = "029EB1";
    std::string m_tag = "HART";
    std::string m_unit = "V";
    uint8_t m_pollingAddress = 0;
    uint32_t m_baudRate = 1200;
    uint16_t m_udpPort = 5094;
    bool m_enabled = true;
};

} // namespace lasecsimul::protocols

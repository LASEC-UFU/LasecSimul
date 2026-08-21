#pragma once

#include <array>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "IndustrialProtocols.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"
#include "simulation/Scheduler.hpp"

namespace lasecsimul::protocols {

enum class IndustrialComponentKind : uint8_t { ModbusServer, ModbusClient, HartTransmitter, HartCommunicator };

/** Elemento industrial ligavel no esquema. Servidor/transmissor amostram a tensao `value-gnd` e
 * publicam no barramento virtual da sessao; cliente/comunicador leem o mesmo endereco e dirigem
 * `value-gnd`. O padrao nao abre rede/serial do host e segue exclusivamente o tempo virtual. */
class IndustrialProtocolComponent final : public IComponentModel {
public:
    IndustrialProtocolComponent(IndustrialComponentKind kind, simulation::Scheduler& scheduler,
                                std::shared_ptr<VirtualIndustrialBus> bus, std::array<Pin, 2> pins)
        : m_kind(kind), m_scheduler(scheduler), m_bus(std::move(bus)), m_pins(std::move(pins)),
          m_lifetime(std::make_shared<uint8_t>(0)),
          m_channel(kind == IndustrialComponentKind::ModbusServer || kind == IndustrialComponentKind::ModbusClient
                        ? "modbus-1" : "hart-1") {}
    ~IndustrialProtocolComponent() override { m_lifetime.reset(); }

    const char* typeId() const override {
        switch (m_kind) {
            case IndustrialComponentKind::ModbusServer: return "protocol.modbus.server";
            case IndustrialComponentKind::ModbusClient: return "protocol.modbus.client";
            case IndustrialComponentKind::HartTransmitter: return "protocol.hart.transmitter";
            case IndustrialComponentKind::HartCommunicator: return "protocol.hart.communicator";
        }
        return "protocol.unknown";
    }
    std::span<Pin> pins() override { return m_pins; }
    uint32_t extraVariableCount() const override { return isPublisher() ? 0u : 1u; }
    std::span<const uint32_t> leakagePinIndices() const override { return m_leakagePin; }
    void onAssignedIndex(uint32_t index) override { m_componentIndex = index; scheduleNextScan(); }

    void stamp(MnaMatrixView& matrix) override {
        if (!m_enabled) { m_online = false; return; }
        const uint64_t now = m_scheduler.nowNsUnlocked();
        if (isPublisher()) {
            const double input = matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]);
            matrix.addConductance(m_pins[0], m_pins[1], kInputConductance);
            if (isModbus()) {
                const double encoded = (input - m_offset) / m_scale;
                m_online = std::isfinite(encoded) && encoded >= 0.0 && encoded <= 65535.0;
                if (m_online) {
                    m_lastValue = std::llround(encoded);
                    m_bus->publishModbus(modbusPoint(), m_lastValue, now);
                }
            } else {
                m_lastValue = input;
                m_bus->publishHart(hartPoint(), {m_uniqueId, m_tag, m_unit, input}, now);
                m_online = true;
            }
            return;
        }
        const uint64_t maximumAge = millisecondsToNs(m_timeoutMs);
        if (isModbus()) {
            const std::optional<double> encoded = m_bus->readModbus(modbusPoint(), now, maximumAge);
            m_online = encoded.has_value();
            if (encoded) m_lastValue = *encoded * m_scale + m_offset;
        } else {
            const std::optional<VirtualHartValue> response = m_bus->readHart(hartPoint(), now, maximumAge);
            m_online = response.has_value();
            if (response && (m_hartCommand == "1" || m_hartCommand == "3")) m_lastValue = response->primaryValue;
            else if (response) m_lastValue = 0.0;
        }
        matrix.addVoltageSource(m_pins[0], m_pins[1], m_online ? m_lastValue : 0.0);
    }
    void postStep(uint64_t) override {}

    size_t getState(uint8_t* out, size_t cap) const override {
        struct State { double value; uint8_t online; } state{m_lastValue, static_cast<uint8_t>(m_online ? 1 : 0)};
        if (cap < sizeof(state)) return 0;
        std::memcpy(out, &state, sizeof(state));
        return sizeof(state);
    }
    void setState(const uint8_t* in, size_t len) override {
        struct State { double value; uint8_t online; } state{};
        if (len < sizeof(state)) return;
        std::memcpy(&state, in, sizeof(state));
        m_lastValue = state.value; m_online = state.online != 0;
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        std::vector<PropertyDescriptor> result;
        for (const PropertySchema& schema : propertySchema(m_kind)) {
            result.push_back({schema.id, schema.unit,
                [this, id = schema.id] { return propertyValue(id); },
                [this, schema](const PropertyValue& value) {
                    if (!validatePropertyValue(schema, value)) setPropertyValue(schema.id, value);
                }, schema});
        }
        return result;
    }
    static ReadoutFormat readoutFormat() { return {ReadoutKind::Scalar, "V", 0}; }

    static std::vector<PropertySchema> propertySchema(IndustrialComponentKind kind) {
        const auto text = [](std::string id, std::string label, std::string group, std::string defaultValue) {
            return PropertySchema{std::move(id), std::move(label), std::move(group), "", PropertyValueKind::String,
                                  "text", std::move(defaultValue)};
        };
        const auto number = [](std::string id, std::string label, std::string group, std::string unit,
                               double defaultValue, std::optional<double> minimum = std::nullopt,
                               std::optional<double> maximum = std::nullopt) {
            PropertySchema schema{std::move(id), std::move(label), std::move(group), std::move(unit),
                                  PropertyValueKind::Number, "number", defaultValue};
            schema.minValue = minimum; schema.maxValue = maximum; return schema;
        };
        const bool modbus = kind == IndustrialComponentKind::ModbusServer || kind == IndustrialComponentKind::ModbusClient;
        PropertySchema channel = text("channel", "Canal virtual", "Comunicacao", modbus ? "modbus-1" : "hart-1");
        channel.flags |= PropertySchemaShowOnSymbol;
        PropertySchema enabled{"enabled", "Habilitado", "Comunicacao", "", PropertyValueKind::Bool, "checkbox", true};
        std::vector<PropertySchema> schemas{
            std::move(channel), enabled,
            number("scanPeriodMs", "Periodo de varredura", "Comunicacao", "ms", 100.0, 1.0, 60000.0),
            number("timeoutMs", "Timeout", "Comunicacao", "ms", 1000.0, 1.0, 600000.0),
        };
        if (modbus) {
            PropertySchema area = text("area", "Area", "Modbus", "holdingRegister");
            area.editor = "enum";
            area.options = {{"coil", "Coil"}, {"discreteInput", "Discrete Input"},
                            {"inputRegister", "Input Register"}, {"holdingRegister", "Holding Register"}};
            schemas.push_back(number("unitId", "Unit ID", "Modbus", "", 1.0, 0.0, 247.0));
            schemas.push_back(std::move(area));
            schemas.push_back(number("address", "Endereco", "Modbus", "", 0.0, 0.0, 65535.0));
            schemas.push_back(number("scale", "Escala", "Modbus", "", 0.001, 1e-12));
            schemas.push_back(number("offset", "Offset", "Modbus", "V", 0.0));
        } else {
            schemas.push_back(number("pollingAddress", "Polling address", "HART", "", 0.0, 0.0, 63.0));
            schemas.push_back(text("uniqueId", "Unique ID", "HART", "0011223344"));
            schemas.push_back(text("tag", "Tag", "HART", "TIC101"));
            schemas.push_back(text("unit", "Unidade PV", "HART", "V"));
            if (kind == IndustrialComponentKind::HartCommunicator) {
                PropertySchema command = text("hartCommand", "Comando", "HART", "1");
                command.editor = "enum";
                command.options = {{"0", "0 - Identidade"}, {"1", "1 - Variavel primaria"},
                                   {"3", "3 - Variaveis dinamicas"}};
                schemas.push_back(std::move(command));
            }
        }
        return schemas;
    }

    bool online() const { return m_online; }
    double lastValue() const { return m_lastValue; }

private:
    static constexpr double kInputConductance = 1e-9;
    static constexpr uint32_t kNoComponent = 0xFFFFFFFFu;
    bool isModbus() const { return m_kind == IndustrialComponentKind::ModbusServer || m_kind == IndustrialComponentKind::ModbusClient; }
    bool isPublisher() const { return m_kind == IndustrialComponentKind::ModbusServer || m_kind == IndustrialComponentKind::HartTransmitter; }
    static uint64_t millisecondsToNs(double value) { return static_cast<uint64_t>(std::max(1.0, value) * 1'000'000.0); }
    ModbusArea area() const {
        if (m_area == "coil") return ModbusArea::Coil;
        if (m_area == "discreteInput") return ModbusArea::DiscreteInput;
        if (m_area == "inputRegister") return ModbusArea::InputRegister;
        return ModbusArea::HoldingRegister;
    }
    VirtualModbusPoint modbusPoint() const { return {m_channel, static_cast<uint8_t>(m_unitId), area(), static_cast<uint16_t>(m_address)}; }
    VirtualHartPoint hartPoint() const { return {m_channel, static_cast<uint8_t>(m_pollingAddress)}; }

    PropertyValue propertyValue(const std::string& id) const {
        if (id == "channel") return m_channel; if (id == "enabled") return m_enabled;
        if (id == "scanPeriodMs") return m_scanPeriodMs; if (id == "timeoutMs") return m_timeoutMs;
        if (id == "unitId") return m_unitId; if (id == "area") return m_area; if (id == "address") return m_address;
        if (id == "scale") return m_scale; if (id == "offset") return m_offset;
        if (id == "pollingAddress") return m_pollingAddress; if (id == "uniqueId") return m_uniqueId;
        if (id == "tag") return m_tag; if (id == "unit") return m_unit; if (id == "hartCommand") return m_hartCommand;
        return std::string{};
    }
    void setPropertyValue(const std::string& id, const PropertyValue& value) {
        if (id == "channel") m_channel = std::get<std::string>(value); else if (id == "enabled") m_enabled = std::get<bool>(value);
        else if (id == "scanPeriodMs") m_scanPeriodMs = std::get<double>(value); else if (id == "timeoutMs") m_timeoutMs = std::get<double>(value);
        else if (id == "unitId") m_unitId = std::get<double>(value); else if (id == "area") m_area = std::get<std::string>(value);
        else if (id == "address") m_address = std::get<double>(value); else if (id == "scale") m_scale = std::get<double>(value);
        else if (id == "offset") m_offset = std::get<double>(value); else if (id == "pollingAddress") m_pollingAddress = std::get<double>(value);
        else if (id == "uniqueId") m_uniqueId = std::get<std::string>(value); else if (id == "tag") m_tag = std::get<std::string>(value);
        else if (id == "unit") m_unit = std::get<std::string>(value); else if (id == "hartCommand") m_hartCommand = std::get<std::string>(value);
    }
    void scheduleNextScan() {
        if (m_componentIndex == kNoComponent) return;
        const std::weak_ptr<uint8_t> lifetime = m_lifetime;
        m_scheduler.scheduleEvent(millisecondsToNs(m_scanPeriodMs), [this, lifetime] {
            if (lifetime.expired()) return;
            m_scheduler.markDirty(m_componentIndex); scheduleNextScan();
        });
    }

    IndustrialComponentKind m_kind;
    simulation::Scheduler& m_scheduler;
    std::shared_ptr<VirtualIndustrialBus> m_bus;
    std::array<Pin, 2> m_pins;
    std::array<uint32_t, 1> m_leakagePin{1};
    std::shared_ptr<uint8_t> m_lifetime;
    uint32_t m_componentIndex = kNoComponent;
    std::string m_channel;
    bool m_enabled = true;
    double m_scanPeriodMs = 100.0, m_timeoutMs = 1000.0, m_unitId = 1.0;
    std::string m_area = "holdingRegister";
    double m_address = 0.0, m_scale = 0.001, m_offset = 0.0, m_pollingAddress = 0.0;
    std::string m_uniqueId = "0011223344", m_tag = "TIC101", m_unit = "V", m_hartCommand = "1";
    double m_lastValue = 0.0;
    bool m_online = false;
};

} // namespace lasecsimul::protocols

#pragma once

#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

namespace lasecsimul::protocols {

using ProtocolValue = std::variant<bool, int64_t, double>;
using VariableHandle = uint32_t;

enum class VariableType : uint8_t { Boolean, Integer, Real };

struct VariableDescriptor {
    std::string namespaceId;
    std::string name;
    VariableType type = VariableType::Real;
    bool writable = true;
};

class VariableRegistry {
public:
    VariableHandle registerVariable(VariableDescriptor descriptor, ProtocolValue initialValue);
    const VariableDescriptor& descriptor(VariableHandle handle) const;
    ProtocolValue read(VariableHandle handle) const;
    void write(VariableHandle handle, ProtocolValue value);
    size_t size() const { return m_entries.size(); }

private:
    struct Entry { VariableDescriptor descriptor; ProtocolValue value; };
    std::vector<Entry> m_entries;
    std::unordered_map<std::string, VariableHandle> m_byQualifiedName;
};

enum class ModbusArea : uint8_t { Coil, DiscreteInput, InputRegister, HoldingRegister };

struct ModbusMapping {
    uint8_t unitId = 1;
    ModbusArea area = ModbusArea::HoldingRegister;
    uint16_t address = 0;
    VariableHandle variable = 0;
    double scale = 1.0;
    double offset = 0.0;
};

struct RealTransportOptions {
    bool explicitOptIn = false;
    uint16_t port = 0;
};

/** Chave deterministica do barramento Modbus virtual da sessao. O transporte virtual e o padrao
 * seguro do simulador: nao abre socket nem porta serial e permite ligar componentes pelo mesmo
 * canal/endereco sem depender do relogio de parede. */
struct VirtualModbusPoint {
    std::string channel = "modbus-1";
    uint8_t unitId = 1;
    ModbusArea area = ModbusArea::HoldingRegister;
    uint16_t address = 0;
    bool operator==(const VirtualModbusPoint&) const = default;
};

struct VirtualHartPoint {
    std::string channel = "hart-1";
    uint8_t pollingAddress = 0;
    bool operator==(const VirtualHartPoint&) const = default;
};

struct VirtualHartValue {
    std::string uniqueId;
    std::string tag;
    std::string unit;
    double primaryValue = 0.0;
};

/** Barramento industrial compartilhado apenas pelas instancias de uma CoreApplication. Valores
 * carregam timestamp de tempo virtual; leituras nunca aceitam dados do "futuro" (por exemplo,
 * depois de resetar a simulacao) nem dados alem do timeout pedido pelo receptor. */
class VirtualIndustrialBus {
public:
    void publishModbus(const VirtualModbusPoint& point, double value, uint64_t virtualNowNs);
    std::optional<double> readModbus(const VirtualModbusPoint& point, uint64_t virtualNowNs,
                                     uint64_t maximumAgeNs) const;
    void publishHart(const VirtualHartPoint& point, VirtualHartValue value, uint64_t virtualNowNs);
    std::optional<VirtualHartValue> readHart(const VirtualHartPoint& point, uint64_t virtualNowNs,
                                             uint64_t maximumAgeNs) const;
    void clear();

private:
    struct ModbusEntry { VirtualModbusPoint point; double value = 0.0; uint64_t timestampNs = 0; };
    struct HartEntry { VirtualHartPoint point; VirtualHartValue value; uint64_t timestampNs = 0; };
    mutable std::mutex m_mutex;
    std::vector<ModbusEntry> m_modbus;
    std::vector<HartEntry> m_hart;
};

class ProtocolTimeout final : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

/** Modbus server/client semântico. Não cria socket; uma camada de transporte futura consome este
 * contrato somente depois de configureRealTransport() receber opt-in inequívoco. */
class ModbusSemanticEndpoint {
public:
    explicit ModbusSemanticEndpoint(VariableRegistry& registry, std::string sessionNamespace);

    void addMapping(ModbusMapping mapping);
    std::vector<uint16_t> read(uint8_t unitId, ModbusArea area, uint16_t address, uint16_t quantity,
                               uint64_t virtualNowNs, uint64_t virtualDeadlineNs) const;
    void write(uint8_t unitId, ModbusArea area, uint16_t address, const std::vector<uint16_t>& values,
               uint64_t virtualNowNs, uint64_t virtualDeadlineNs);

    void configureRealTransport(RealTransportOptions options);
    bool realTransportEnabled() const { return m_realTransport.has_value(); }
    std::optional<uint16_t> configuredPort() const {
        return m_realTransport ? std::optional<uint16_t>(m_realTransport->port) : std::nullopt;
    }
    const std::string& sessionNamespace() const { return m_sessionNamespace; }

private:
    const ModbusMapping& requireMapping(uint8_t unitId, ModbusArea area, uint16_t address) const;
    static uint16_t encode(const ProtocolValue& value, const ModbusMapping& mapping);
    static ProtocolValue decode(uint16_t value, const VariableDescriptor& descriptor, const ModbusMapping& mapping);
    static void enforceDeadline(uint64_t now, uint64_t deadline);

    VariableRegistry& m_registry;
    std::string m_sessionNamespace;
    std::vector<ModbusMapping> m_mappings;
    std::optional<RealTransportOptions> m_realTransport;
};

struct HartDevice {
    uint8_t pollingAddress = 0;
    std::string uniqueId;
    std::string tag;
    std::string unit;
    VariableHandle primaryVariable = 0;
};

struct HartResponse {
    uint8_t command = 0;
    std::vector<std::string> fields;
};

class HartSemanticEndpoint {
public:
    explicit HartSemanticEndpoint(VariableRegistry& registry) : m_registry(registry) {}
    void addDevice(HartDevice device);
    HartResponse execute(uint8_t pollingAddress, uint8_t command) const;

private:
    VariableRegistry& m_registry;
    std::vector<HartDevice> m_devices;
};

enum class BindingSourceKind : uint8_t { SignalSlot, PlcSymbol };

struct ProtocolBinding {
    BindingSourceKind sourceKind = BindingSourceKind::SignalSlot;
    uint32_t sourceHandle = 0;
    VariableHandle protocolVariable = 0;
};

/** Plano resolvido cold-path: o hot path usa apenas handles densos, sem busca global por nome. */
class SemanticBindingPlan {
public:
    void add(ProtocolBinding binding);
    void commit(const std::unordered_map<uint32_t, ProtocolValue>& sourceValues, VariableRegistry& registry) const;
    const std::vector<ProtocolBinding>& bindings() const { return m_bindings; }

private:
    std::vector<ProtocolBinding> m_bindings;
};

} // namespace lasecsimul::protocols

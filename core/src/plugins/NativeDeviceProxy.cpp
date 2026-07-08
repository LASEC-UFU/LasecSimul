#include "NativeDeviceProxy.hpp"
#include <cstring>
#include <stdexcept>
#include "PluginWatchdog.hpp"

namespace lasecsimul::plugins {

namespace {

// pin_write/pin_write_analog (ver stamp()): mesma ordem de grandeza de Rail::kRailConductance --
// "baixa impedância" o bastante pra fixar o nó, sem deixar a matriz mal-condicionada.
constexpr double kDigitalDriveConductance = 1e9;
constexpr double kDigitalHighVolts = 5.0;

struct AbiMatrixContext {
    MnaMatrixView* matrix;
    const ComponentMeta* meta;
};

const Pin& pinByIndex(const AbiMatrixContext* ctx, uint32_t index) {
    if (!ctx || !ctx->meta) {
        throw std::runtime_error("contexto ABI invalido para stamp nativo");
    }
    if (index >= ctx->meta->pins.size()) {
        throw std::out_of_range("indice de pino nativo fora do intervalo");
    }
    return ctx->meta->pins[index];
}

void abiAddConductance(void* opaque, uint32_t pinA, uint32_t pinB, double siemens) {
    auto* ctx = static_cast<AbiMatrixContext*>(opaque);
    ctx->matrix->addConductance(pinByIndex(ctx, pinA), pinByIndex(ctx, pinB), siemens);
}

void abiAddVoltageSource(void* opaque, uint32_t pinA, uint32_t pinB, double volts) {
    auto* ctx = static_cast<AbiMatrixContext*>(opaque);
    ctx->matrix->addVoltageSource(pinByIndex(ctx, pinA), pinByIndex(ctx, pinB), volts);
}

double abiGetNodeVoltage(void* opaque, uint32_t pin) {
    auto* ctx = static_cast<AbiMatrixContext*>(opaque);
    return ctx->matrix->getNodeVoltage(pinByIndex(ctx, pin));
}

void abiAddConductanceToGround(void* opaque, uint32_t pin, double siemens) {
    auto* ctx = static_cast<AbiMatrixContext*>(opaque);
    ctx->matrix->addConductanceToGround(pinByIndex(ctx, pin), siemens);
}

void abiAddCurrentToGround(void* opaque, uint32_t pin, double amperes) {
    auto* ctx = static_cast<AbiMatrixContext*>(opaque);
    ctx->matrix->addCurrentToGround(pinByIndex(ctx, pin), amperes);
}

PropertyValue readAbiPropertyValue(const LsdnPropertyValue& value) {
    switch (value.kind) {
        case LSDN_PROPERTY_NUMBER:
            return value.number_value;
        case LSDN_PROPERTY_BOOL:
            return value.bool_value != 0;
        case LSDN_PROPERTY_POINT:
            return PropertyPoint{value.point_value.x, value.point_value.y};
        case LSDN_PROPERTY_STRING:
        default:
            return std::string(value.string_value ? value.string_value : "");
    }
}

bool writeAbiPropertyValue(const PropertyValue& value, LsdnPropertyValue* outValue) {
    if (!outValue) return false;
    std::memset(outValue, 0, sizeof(*outValue));

    if (const double* number = std::get_if<double>(&value)) {
        outValue->kind = LSDN_PROPERTY_NUMBER;
        outValue->number_value = *number;
        return true;
    }
    if (const std::string* text = std::get_if<std::string>(&value)) {
        outValue->kind = LSDN_PROPERTY_STRING;
        outValue->string_value = text->c_str();
        return true;
    }
    if (const bool* flag = std::get_if<bool>(&value)) {
        outValue->kind = LSDN_PROPERTY_BOOL;
        outValue->bool_value = *flag ? 1 : 0;
        return true;
    }
    if (const PropertyPoint* point = std::get_if<PropertyPoint>(&value)) {
        outValue->kind = LSDN_PROPERTY_POINT;
        outValue->point_value = LsdnPropertyPoint{point->x, point->y};
        return true;
    }
    return false;
}

PropertyValueKind schemaKindFromValue(const PropertyValue& value) {
    if (std::holds_alternative<double>(value)) return PropertyValueKind::Number;
    if (std::holds_alternative<bool>(value)) return PropertyValueKind::Bool;
    if (std::holds_alternative<PropertyPoint>(value)) return PropertyValueKind::Point;
    return PropertyValueKind::String;
}

} // namespace

LsdnMatrixView NativeDeviceProxy::toAbiView(void* context) {
    return LsdnMatrixView{
        /*opaque*/ context,
        /*add_conductance*/ &abiAddConductance,
        /*add_voltage_source*/ &abiAddVoltageSource,
        /*get_node_voltage*/ &abiGetNodeVoltage,
        /*add_conductance_to_ground*/ &abiAddConductanceToGround,
        /*add_current_to_ground*/ &abiAddCurrentToGround,
    };
}

NativeDeviceProxy::~NativeDeviceProxy() {
    if (m_module && m_handle) {
        m_module->deviceVTable()->destroy(m_handle);
    }
}

void NativeDeviceProxy::stamp(MnaMatrixView& matrix) {
    // Síncrono e sem watchdog de propósito: stamp() roda inline na mesma iteração do MnaSolver,
    // sem cosimulação (.spec/lasecsimul-native-devices.spec seção 10) -- um timeout aqui não tem
    // fallback seguro de "último valor conhecido" (a contribuição na matriz desta rodada já teria
    // que existir ou não, não dá pra adiar). CrashGuard ainda protege contra crash (não contra
    // travamento), igual ao comportamento já existente.
    auto context = std::make_unique<AbiMatrixContext>(AbiMatrixContext{&matrix, &m_meta});
    LsdnMatrixView view = toAbiView(context.get()); // context.reset() no fim do escopo, mesmo se a lambda lançar
    const bool ok = CrashGuard::call(m_meta.typeId, [&] { m_module->deviceVTable()->stamp(m_handle, &view); });
    if (!ok) m_health = PluginHealthStatus::Faulted;

    // pin_write/pin_write_analog (ver device_abi.h LsdnHostApi): camada ergonômica por cima da
    // MESMA matriz -- fonte de baixa impedância pro nível pedido. Persistente (não limpa depois):
    // GPIO real fica no nível até alguém escrever de novo, igual Rail/VoltSource já fazem.
    for (const auto& [pinIndex, level] : m_hostContext->pendingDigitalDrive) {
        if (pinIndex >= m_meta.pins.size()) continue;
        matrix.addConductanceToGround(m_meta.pins[pinIndex], kDigitalDriveConductance);
        matrix.addCurrentToGround(m_meta.pins[pinIndex], (level ? kDigitalHighVolts : 0.0) * kDigitalDriveConductance);
    }
    for (const auto& [pinIndex, volts] : m_hostContext->pendingAnalogDrive) {
        if (pinIndex >= m_meta.pins.size()) continue;
        matrix.addConductanceToGround(m_meta.pins[pinIndex], kDigitalDriveConductance);
        matrix.addCurrentToGround(m_meta.pins[pinIndex], volts * kDigitalDriveConductance);
    }

    // pin_read: cache da tensão de CADA pino nesta stamp() -- pra ler fora de stamp() (on_event/
    // post_step), sem disparar solve novo (mesmo princípio de current()/getBranchCurrent).
    for (uint32_t pinIndex = 0; pinIndex < m_meta.pins.size(); ++pinIndex) {
        m_hostContext->lastPinVoltage[pinIndex] = matrix.getNodeVoltage(m_meta.pins[pinIndex]);
    }
}

void NativeDeviceProxy::postStep(uint64_t timeNs) {
    if (m_health == PluginHealthStatus::Faulted) return;

    const WatchdogOutcome outcome = PluginWatchdog::call(
        m_meta.typeId, m_meta.stepTimeoutMs, [&] { m_module->deviceVTable()->post_step(m_handle, timeNs); });

    switch (outcome) {
        case WatchdogOutcome::Completed:
            m_consecutiveTimeouts = 0;
            m_health = PluginHealthStatus::Ok;
            break;
        case WatchdogOutcome::Crashed:
            m_health = PluginHealthStatus::Faulted;
            break;
        case WatchdogOutcome::TimedOut:
            // zero-order hold: o macropasso segue com o último valor conhecido do device (a thread
            // travada é desanexada, nunca terminada à força -- ver PluginWatchdog/seção 13).
            m_consecutiveTimeouts++;
            m_health = m_consecutiveTimeouts >= kMaxConsecutiveTimeouts
                ? PluginHealthStatus::Faulted
                : PluginHealthStatus::Lagging;
            break;
    }
}

void NativeDeviceProxy::onEvent(const ComponentEvent& event) {
    if (m_health == PluginHealthStatus::Faulted) return;
    LsdnEvent abiEvent{};
    abiEvent.tag = event.tag;
    abiEvent.a = event.a;
    abiEvent.b = event.b;
    abiEvent.c = event.c;
    const bool ok = CrashGuard::call(m_meta.typeId, [&] { m_module->deviceVTable()->on_event(m_handle, &abiEvent); });
    if (!ok) m_health = PluginHealthStatus::Faulted;
}

size_t NativeDeviceProxy::getState(uint8_t* out, size_t cap) const {
    size_t result = 0;
    const bool ok = CrashGuard::call(
        m_meta.typeId, [&] { result = m_module->deviceVTable()->get_state(m_handle, out, static_cast<uint32_t>(cap)); });
    if (!ok) {
        m_health = PluginHealthStatus::Faulted;
        return 0;
    }
    return result;
}

void NativeDeviceProxy::setState(const uint8_t* in, size_t len) {
    const bool ok = CrashGuard::call(
        m_meta.typeId, [&] { m_module->deviceVTable()->set_state(m_handle, in, static_cast<uint32_t>(len)); });
    if (!ok) m_health = PluginHealthStatus::Faulted;
}

std::vector<PropertyDescriptor> NativeDeviceProxy::propertyDescriptors() {
    std::vector<PropertyDescriptor> descriptors;
    descriptors.reserve(m_meta.propertySchema.size());

    for (const PropertySchema& schema : m_meta.propertySchema) {
        PropertySchema descriptorSchema = schema;
        descriptors.push_back(PropertyDescriptor{
            schema.id,
            schema.unit,
            [this, propertyId = schema.id, fallbackValue = schema.defaultValue] {
                const LsdnDeviceVTable* vt = m_module->deviceVTable();
                if (vt->get_property) {
                    LsdnPropertyValue abiValue{};
                    uint32_t found = 0;
                    const bool ok = CrashGuard::call(
                        m_meta.typeId, [&] { found = vt->get_property(m_handle, propertyId.c_str(), &abiValue); });
                    if (!ok) {
                        m_health = PluginHealthStatus::Faulted;
                        return fallbackValue;
                    }
                    if (found) return readAbiPropertyValue(abiValue);
                }
                const auto it = m_hostContext->properties.find(propertyId);
                if (it != m_hostContext->properties.end()) return it->second;
                return fallbackValue;
            },
            [this, propertyId = schema.id, affectsPinCount = (schema.flags & PropertySchemaAffectsPinCount) != 0](
                const PropertyValue& value) {
                m_hostContext->properties[propertyId] = value;
                const LsdnDeviceVTable* vt = m_module->deviceVTable();
                if (vt->set_property) {
                    LsdnPropertyValue abiValue{};
                    if (writeAbiPropertyValue(value, &abiValue)) {
                        const bool ok =
                            CrashGuard::call(m_meta.typeId, [&] { vt->set_property(m_handle, propertyId.c_str(), &abiValue); });
                        if (!ok) m_health = PluginHealthStatus::Faulted;
                    }
                }
                // `pinSpec` declarativo (manifesto, sem C nenhum) -- recomputa aqui, DEPOIS do
                // `set_property` acima (que pode ser um no-op pra um device puramente
                // pinSpec-driven, sem vtable de verdade fazendo nada com a propriedade). Um plugin
                // que em vez disso chama `pin_declare` na mão de dentro do próprio `set_property()`
                // já escreveu em `declaredPins` na chamada acima -- este bloco só roda de novo se
                // `pinSpec` também estiver presente (ver ComponentMeta::pinSpec: não deveriam
                // coexistir, mas não há necessidade de impedir).
                if (affectsPinCount && m_meta.pinSpec) {
                    m_hostContext->declaredPins = resolveDynamicPins(*m_meta.pinSpec, m_hostContext->properties);
                }
            },
            std::move(descriptorSchema),
        });
    }

    for (PropertyDescriptor& descriptor : descriptors) {
        if (descriptor.schema.id.empty()) {
            descriptor.schema.id = descriptor.name;
            const auto propertyIt = m_hostContext->properties.find(descriptor.name);
            if (propertyIt != m_hostContext->properties.end()) {
                descriptor.schema.valueKind = schemaKindFromValue(propertyIt->second);
                descriptor.schema.defaultValue = propertyIt->second;
            }
        }
    }

    return descriptors;
}

} // namespace lasecsimul::plugins

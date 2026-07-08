#include "PluginRuntime.hpp"
#include <cstdio>
#include <string>
#include <utility>

namespace lasecsimul::plugins {

namespace {

// Até esta mudança, `pin_declare` só escrevia em `pinNames` (usado só por `pin_write`/`pin_read`/
// `pin_name`) -- `NativeDeviceProxy::pins()` continuava devolvendo `ComponentMeta::pins`, fixo
// desde o manifesto, então um plugin que chamasse `pin_declare` (ex: `example-blinker`,
// `simulide-logic`) não mudava NADA na topologia elétrica real -- bug latente pré-existente, mesma
// classe do keypad (TR-9). Agora escreve em `declaredPins` (a lista REAL que `pins()` devolve) --
// `id` vazio (`name` nulo/vazio) usa `pin-N` genérico, igual a `makePinVector` do lado built-in,
// nunca deixa um `Pin` com id vazio (`Netlist::registerComponent` rejeita isso).
uint32_t hostPinDeclare(void* hostCtx, uint32_t index, LsdnPinKind, const char* name) {
    auto* ctx = static_cast<NativeDeviceHostContext*>(hostCtx);
    if (!ctx) return index;
    if (ctx->pinNames.size() <= index) ctx->pinNames.resize(index + 1);
    ctx->pinNames[index] = name ? name : "";
    if (ctx->declaredPins.size() <= index) ctx->declaredPins.resize(index + 1);
    ctx->declaredPins[index].id = (name && *name) ? name : ("pin-" + std::to_string(index + 1));
    return index;
}

// pin_write/pin_write_analog: só guarda o nível pedido -- NativeDeviceProxy::stamp() é quem
// aplica isso na matriz (fonte de baixa impedância) na PRÓXIMA stamp() deste device. Marcar dirty
// via `dirtySet()` direto (não `markDirty()`, que toma o mutex do Scheduler de novo): chamador
// documentado destas 2 funções é sempre on_event/stamp, que já roda DENTRO da seção travada do
// settle -- ver Scheduler::nowNsUnlocked()/scheduleEventUnlocked().
void hostPinWrite(void* hostCtx, uint32_t pin, int32_t level) {
    auto* ctx = static_cast<NativeDeviceHostContext*>(hostCtx);
    if (!ctx) return;
    ctx->pendingDigitalDrive[pin] = level;
    if (ctx->scheduler) ctx->scheduler->dirtySet().insert(ctx->componentIndex);
}

void hostPinWriteAnalog(void* hostCtx, uint32_t pin, float volts) {
    auto* ctx = static_cast<NativeDeviceHostContext*>(hostCtx);
    if (!ctx) return;
    ctx->pendingAnalogDrive[pin] = volts;
    if (ctx->scheduler) ctx->scheduler->dirtySet().insert(ctx->componentIndex);
}

// Cache de NativeDeviceProxy::stamp() (toda stamp(), não só quando há pin_write) -- nunca dispara
// solve novo, mesmo princípio de IComponentModel::current().
int32_t hostPinRead(void* hostCtx, uint32_t pin) {
    auto* ctx = static_cast<NativeDeviceHostContext*>(hostCtx);
    if (!ctx) return 0;
    const auto it = ctx->lastPinVoltage.find(pin);
    return (it != ctx->lastPinVoltage.end() && it->second > kDigitalLevelThreshold) ? 1 : 0;
}

const char* hostPinName(void* hostCtx, uint32_t index) {
    auto* ctx = static_cast<NativeDeviceHostContext*>(hostCtx);
    if (!ctx || index >= ctx->pinNames.size()) return "";
    return ctx->pinNames[index].c_str();
}

// LSDN_EVT_TIMER entregue de volta via NativeDeviceProxy::onEvent() (não direto na vtable): assim
// ganha o MESMO CrashGuard/m_health de qualquer outro evento, sem duplicar essa lógica aqui.
// `scheduleEventUnlocked` é seguro chamar de dentro de on_event/stamp (mesma seção travada do
// settle); o callback em si dispara DEPOIS, já fora dela (ver Scheduler::processNextEventUntilLocked).
void hostScheduleEvent(void* hostCtx, uint64_t delayNs, uint32_t eventId) {
    auto* ctx = static_cast<NativeDeviceHostContext*>(hostCtx);
    if (!ctx || !ctx->scheduler || !ctx->owner) return;
    NativeDeviceProxy* owner = ctx->owner;
    ctx->scheduler->scheduleEventUnlocked(delayNs, [owner, eventId] {
        owner->onEvent(ComponentEvent{kTimerEventTag, eventId, 0, 0});
    });
}

uint64_t hostNowNs(void* hostCtx) {
    auto* ctx = static_cast<NativeDeviceHostContext*>(hostCtx);
    return (ctx && ctx->scheduler) ? ctx->scheduler->nowNsUnlocked() : 0;
}

void hostLog(void*, int32_t level, const char* msg) {
    std::fprintf(stderr, "[NativeDeviceHost][%d] %s\n", level, msg ? msg : "");
}
void hostSubmitTask(void*, void (*fn)(void* arg), void* arg) {
    if (fn) fn(arg);
}

bool writeAbiPropertyValue(const PropertyValue& value, LsdnPropertyValue* outValue) {
    if (!outValue) return false;

    if (const double* number = std::get_if<double>(&value)) {
        outValue->kind = LSDN_PROPERTY_NUMBER;
        outValue->number_value = *number;
        outValue->bool_value = 0;
        outValue->string_value = nullptr;
        outValue->point_value = LsdnPropertyPoint{0.0, 0.0};
        return true;
    }
    if (const std::string* text = std::get_if<std::string>(&value)) {
        outValue->kind = LSDN_PROPERTY_STRING;
        outValue->number_value = 0.0;
        outValue->bool_value = 0;
        outValue->string_value = text->c_str();
        outValue->point_value = LsdnPropertyPoint{0.0, 0.0};
        return true;
    }
    if (const bool* flag = std::get_if<bool>(&value)) {
        outValue->kind = LSDN_PROPERTY_BOOL;
        outValue->number_value = 0.0;
        outValue->bool_value = *flag ? 1 : 0;
        outValue->string_value = nullptr;
        outValue->point_value = LsdnPropertyPoint{0.0, 0.0};
        return true;
    }
    if (const PropertyPoint* point = std::get_if<PropertyPoint>(&value)) {
        outValue->kind = LSDN_PROPERTY_POINT;
        outValue->number_value = 0.0;
        outValue->bool_value = 0;
        outValue->string_value = nullptr;
        outValue->point_value = LsdnPropertyPoint{point->x, point->y};
        return true;
    }
    return false;
}

uint32_t hostConfigGet(void* hostCtx, const char* name, LsdnPropertyValue* outValue) {
    auto* ctx = static_cast<NativeDeviceHostContext*>(hostCtx);
    if (!ctx || !name || !outValue) return 0;

    const auto it = ctx->properties.find(name);
    if (it == ctx->properties.end()) return 0;
    return writeAbiPropertyValue(it->second, outValue) ? 1u : 0u;
}

const LsdnHostApi kHostApi = {
    &hostPinDeclare, &hostPinWrite, &hostPinWriteAnalog, &hostPinRead, &hostPinName,
    &hostScheduleEvent, &hostConfigGet, &hostNowNs, &hostLog, &hostSubmitTask,
};

} // namespace

std::unique_ptr<IComponentModel> PluginRuntime::createDeviceInstance(const std::string& typeId, ComponentMeta meta,
                                                                     const registry::ComponentParams& params,
                                                                     simulation::Scheduler& scheduler) {
    auto module = m_cache.activeDeviceModule(typeId);
    if (!module) {
        throw std::runtime_error("Nenhum PluginModule ativo para typeId: " + typeId);
    }

    auto hostContext = std::make_shared<NativeDeviceHostContext>();
    hostContext->properties = params.properties;
    hostContext->properties["__typeId"] = typeId;
    hostContext->pinNames.reserve(meta.pins.size());
    for (const Pin& pin : meta.pins) hostContext->pinNames.push_back(pin.id);
    // Semente = `pins[]` do manifesto -- plugin que NUNCA chama `pin_declare` (a maioria hoje)
    // mantém o comportamento de sempre. `hostPinDeclare` (acima) sobrescreve por índice se o
    // plugin declarar de verdade, durante `init()` OU depois, de dentro do próprio `set_property()`
    // (é assim que um plugin de terceiro ganha pino dinâmico, sem nenhuma mudança de ABI -- ver
    // NativeDeviceHostContext::declaredPins). `pinSpec` declarativo (manifesto) tem prioridade
    // sobre a semente estática quando presente -- caminho SEM CÓDIGO C nenhum, ver
    // ComponentMeta::pinSpec.
    hostContext->declaredPins = meta.pinSpec ? resolveDynamicPins(*meta.pinSpec, params.properties) : meta.pins;

    const LsdnDeviceVTable* vt = module->deviceVTable();
    LsdnDevice* handle = vt->create(hostContext.get(), &kHostApi);
    if (!handle) {
        throw std::runtime_error("Plugin device create() retornou nullptr para typeId: " + typeId);
    }
    vt->init(handle);
    return std::make_unique<NativeDeviceProxy>(std::move(module), handle, std::move(meta), std::move(hostContext),
                                               scheduler);
}

std::unique_ptr<IMcuAdapter> PluginRuntime::createMcuAdapter(const std::string& chipId) {
    auto module = m_cache.activeMcuModule(chipId);
    if (!module) {
        throw std::runtime_error("Nenhum PluginModule ativo para chipId: " + chipId);
    }

    const LsdnMcuVTable* vt = module->mcuVTable();
    LsdnMcuAdapter* handle = vt->create(nullptr, nullptr);
    if (!handle) {
        throw std::runtime_error("Plugin MCU create() retornou nullptr para chipId: " + chipId);
    }
    return std::make_unique<NativeMcuAdapterProxy>(std::move(module), handle, chipId);
}

} // namespace lasecsimul::plugins

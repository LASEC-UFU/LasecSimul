#pragma once

#include <memory>
#include <unordered_map>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/device_abi.h"
#include "../registry/ComponentParams.hpp"
#include "../simulation/Scheduler.hpp"
#include "CrashGuard.hpp"
#include "PluginModule.hpp"

namespace lasecsimul::plugins {

class NativeDeviceProxy;

/** Estado do lado do host pra um device plugin -- inclui o backing real de `LsdnHostApi`
 * (PluginRuntime.cpp): `pendingDigitalDrive`/`pendingAnalogDrive` (pin_write/pin_write_analog,
 * aplicado na PRÓXIMA stamp() deste device -- ver NativeDeviceProxy::stamp()), `lastPinVoltage`
 * (pin_read, atualizado em TODA stamp()), `scheduler`/`componentIndex`/`owner` (now_ns/
 * schedule_event, populados por NativeDeviceProxy::onAssignedIndex). */
struct NativeDeviceHostContext {
    std::unordered_map<std::string, PropertyValue> properties;
    std::vector<std::string> pinNames;
    /** Contagem/id REAL de pino da instância -- semeado do manifesto (`ComponentMeta::pins`) ANTES
     * de `create()`/`init()` rodar (plugin que nunca chama `pin_declare` mantém o comportamento de
     * sempre); `hostPinDeclare` (PluginRuntime.cpp) escreve aqui de verdade, ao contrário de
     * `pinNames` (só nomes pra `pin_write`/`pin_read`/`pin_name`, nunca a lista elétrica real que
     * `Netlist`/`SimulationSession` usam). `NativeDeviceProxy::pins()` devolve ISTO, não
     * `ComponentMeta::pins` -- por isso um plugin pode chamar `pin_declare` de dentro do próprio
     * `set_property()` (não só `init()`) pra ganhar pino dinâmico, sem nenhuma mudança de ABI: quem
     * detecta a contagem mudou e reregistra no `Netlist` é `SimulationSession::setProperty`, olhando
     * só a `PropertySchema` (`PropertySchemaAffectsPinCount`), nunca o typeId. */
    std::vector<Pin> declaredPins;

    simulation::Scheduler* scheduler = nullptr;
    uint32_t componentIndex = 0;
    NativeDeviceProxy* owner = nullptr;

    std::unordered_map<uint32_t, int32_t> pendingDigitalDrive;
    std::unordered_map<uint32_t, float> pendingAnalogDrive;
    std::unordered_map<uint32_t, double> lastPinVoltage;
};

/**
 * PluginInstance de um dispositivo: implementa IComponentModel delegando para a vtable C de um
 * PluginModule compartilhado. Guarda shared_ptr<PluginModule> — isso é o que mantém o binário
 * carregado vivo enquanto esta instância existir, e é todo o mecanismo de refcount necessário
 * (sem contagem manual). Ver .spec/lasecsimul-native-devices.spec, seção 2.
 */
class NativeDeviceProxy final : public IComponentModel {
public:
    NativeDeviceProxy(std::shared_ptr<PluginModule> module, LsdnDevice* handle, ComponentMeta meta,
                      std::shared_ptr<NativeDeviceHostContext> hostContext, simulation::Scheduler& scheduler)
        : m_module(std::move(module)), m_handle(handle), m_meta(std::move(meta)),
          m_hostContext(std::move(hostContext)), m_scheduler(scheduler) {}

    ~NativeDeviceProxy() override;

    const char* typeId() const override { return m_meta.typeId.c_str(); }
    /** `m_hostContext->declaredPins`, NUNCA `m_meta.pins` -- este último é só a semente do
     * manifesto (congelada na criação); o primeiro é a lista REAL, atualizada por `pin_declare`
     * (`init()` ou `set_property()`, ver `PluginRuntime.cpp::hostPinDeclare`). Os dois só divergem
     * pra um plugin que efetivamente declara pino dinâmico -- pra todo o resto, são idênticos. */
    std::span<Pin> pins() override { return m_hostContext->declaredPins; }

    void stamp(MnaMatrixView& matrix) override;
    void postStep(uint64_t timeNs) override;
    void onEvent(const ComponentEvent& event) override;
    size_t getState(uint8_t* out, size_t cap) const override;
    void setState(const uint8_t* in, size_t len) override;
    std::vector<PropertyDescriptor> propertyDescriptors() override;

    /** Descobre o próprio componentIndex (chamado 1x por SimulationSession::addComponent) e
     * termina de "ligar" o host context real -- pin_write/pin_read/now_ns/schedule_event (ver
     * NativeDeviceHostContext) só funcionam a partir daqui. Mesmo hook que Clock/WaveGen
     * built-in já usam. */
    void onAssignedIndex(uint32_t index) override {
        m_hostContext->componentIndex = index;
        m_hostContext->owner = this;
        m_hostContext->scheduler = &m_scheduler;
    }

    bool faulted() const { return m_health == PluginHealthStatus::Faulted; }
    PluginHealthStatus health() const override { return m_health; }
    NativeDeviceHostContext* hostContext() { return m_hostContext.get(); }

private:
    static LsdnMatrixView toAbiView(void* context); // implementado em NativeDeviceProxy.cpp

    /** Quantos timeouts seguidos de watchdog antes de desistir e marcar `Faulted` permanente --
     * ver .spec/lasecsimul-native-devices.spec, seção 13, item 3 ("abandono da thread após N
     * timeouts consecutivos"). Pequeno de propósito: cada timeout já deixa uma thread presa pra
     * sempre (nunca terminada à força), então não vale a pena tolerar muitos antes de desistir. */
    static constexpr uint32_t kMaxConsecutiveTimeouts = 3;

    std::shared_ptr<PluginModule> m_module; // mantém o binário vivo enquanto esta instância existir
    LsdnDevice* m_handle;
    ComponentMeta m_meta;
    std::shared_ptr<NativeDeviceHostContext> m_hostContext;
    simulation::Scheduler& m_scheduler;
    // mutable: getState()/o getter de propriedade são const (leitura), mas precisam marcar Faulted
    // se o plugin travar mesmo numa chamada "só leitura" -- ver CrashGuard em cada um.
    mutable PluginHealthStatus m_health = PluginHealthStatus::Ok;
    uint32_t m_consecutiveTimeouts = 0;
};

} // namespace lasecsimul::plugins

#pragma once

#include <string>
#include <string_view>
#include <variant>

#include "lasecsimul/IComponentModel.hpp"
#include "registry/ComponentParams.hpp"

namespace lasecsimul::components {

/**
 * O equivalente de `Tunnel` (conexão por nome compartilhado, ver `Tunnel.hpp`) para o domínio
 * Signal Graph -- marca um pino de FRONTEIRA de `.lssubcircuit` (`SubcircuitInterfaceDef` com
 * `domain == "signal"`) sem nenhuma relação com o Netlist elétrico. Deliberadamente um componente
 * SEPARADO de `Tunnel`, nunca o mesmo: `Tunnel::pins()` é elétrico (participa do Netlist/MNA);
 * `SignalTunnel::pins()` é vazio e `signalPorts()` é o único contrato que expõe -- misturar os dois
 * domínios no mesmo componente seria exatamente "reaproveitar/falsificar pino elétrico como Signal
 * Port", o que a arquitetura proíbe explicitamente (ver `IComponentModel.hpp`, nota de
 * `signalPorts()`).
 *
 * `SimulationSession::expandSubcircuit` acha esta instância por `name` (mesma convenção de
 * `Tunnel::name()`/`tunnelNameFromPropertiesJson`) quando resolve um `SubcircuitInterfaceDef` com
 * `domain == "signal"`, e expõe seu único `signalPorts()` (id fixo `"value"`) como
 * `SubcircuitExposedPin` em `SubcircuitExpansionResult::exposedSignalPins` -- NUNCA em
 * `exposedPins` (que continua 100% elétrico). `direction`/`valueType`/`unit` são fixados na
 * criação (mesmo espírito de `Tunnel` não expor `propertyDescriptors()` pra "name": mudar a
 * direção/tipo de uma porta de fronteira já publicada é uma edição estrutural que passa por
 * recriar o componente via o editor de subcircuito, não por edição de propriedade em runtime).
 */
class SignalTunnel final : public IComponentModel {
public:
    explicit SignalTunnel(const registry::ComponentParams& params)
        : m_name(stringProperty(params, "name", "")),
          m_direction(stringProperty(params, "direction", "Input") == "Output" ? SignalPortDirection::Output
                                                                                : SignalPortDirection::Input),
          m_kind(kindFromValueType(stringProperty(params, "valueType", "Real"))),
          m_unit(stringProperty(params, "unit", "")) {}

    const char* typeId() const override { return "connectors.signal_tunnel"; }
    std::span<Pin> pins() override { return {}; }

    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}

    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < m_name.size()) return 0;
        std::copy(m_name.begin(), m_name.end(), out);
        return m_name.size();
    }
    void setState(const uint8_t* in, size_t len) override { m_name.assign(in, in + len); }

    const std::string& name() const { return m_name; }

    /** Porta id fixo (uma única porta por instância -- ao contrário de HART, que multiplexa várias
     * variáveis por componente via `hartVariablesJson`, um `SignalTunnel` É uma única porta). */
    static constexpr std::string_view kPortId = "value";

    std::vector<SignalPortDescriptor> signalPorts() const override {
        return {{std::string(kPortId), m_direction, m_kind, m_unit}};
    }

private:
    static std::string stringProperty(const registry::ComponentParams& p, const char* key, std::string fallback) {
        const auto it = p.properties.find(key);
        if (it == p.properties.end()) return fallback;
        if (const std::string* v = std::get_if<std::string>(&it->second)) return *v;
        return fallback;
    }
    static SignalValueKind kindFromValueType(const std::string& valueType) {
        if (valueType == "Bool") return SignalValueKind::Digital;
        if (valueType == "Int64") return SignalValueKind::Unsigned;
        return SignalValueKind::Analog;
    }

    std::string m_name;
    SignalPortDirection m_direction;
    SignalValueKind m_kind;
    std::string m_unit;
};

} // namespace lasecsimul::components

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/active/mux_analog.cpp` -- multiplexador analógico real
 * (não `SimulidePassiveState`, cujo `stamp()` é um no-op puro; achado de auditoria 2026-07-08: este
 * componente ficava eletricamente inerte, nenhum canal jamais se conectava a `Z`).
 *
 * Layout de pinos SEMPRE `[z, en, addr-<N pinos>, chan-<M pinos>]`, nesta ordem exata -- garantido
 * por `resolveDynamicPins` (`ComponentPinSpec{fixedPinIds:{"z","en"}, dynamicGroups:{addr,chan}}`,
 * ids sequenciais cruzando os dois grupos, ver `Types.hpp`). `addrBits = ceil(log2(channels))`,
 * MESMA fórmula usada pra derivar a própria contagem de pinos (`DynamicPinCountFn::Log2Ceil`) --
 * recalculada aqui a partir de `m_channels`, nunca lida de volta de `m_pins.size()`, pra nunca
 * divergir da fonte da verdade.
 *
 * `en` é ATIVO EM NÍVEL BAIXO (`m_enPin->setInverted(true)` no original -- `voltage < 2.5V` ==
 * habilitado). Endereço decodificado em binário dos pinos `addr-*` (bit 0 = primeiro, MESMO sentido
 * do `pow(2,i)` real). Canal endereçado ganha baixa impedância (`kOnConductance`) até `z`; os
 * demais ficam em alta impedância (`kOffConductance`, mesma ordem de grandeza do `low_imp` real do
 * SimulIDE) -- linear em vez de Newton-Raphson: não há incógnita implícita, só uma tabela-verdade
 * lida da ÚLTIMA `solve()` (mesmo espírito de `Csource`), então `isNonlinear()==false` seria
 * defensável, mas mantido `true` porque um endereço mudando de canal PODE mudar o ponto de operação
 * de vizinhos o bastante pra precisar de outra iteração de settle -- mais seguro que assumir que
 * nunca precisa.
 */
class AnalogMux final : public IComponentModel {
public:
    static ComponentPinSpec pinSpec() {
        return ComponentPinSpec{{"z", "en"}, {{"addr-", "channels", DynamicPinCountFn::Log2Ceil}, {"chan-", "channels"}}};
    }

    AnalogMux(std::vector<Pin> pins, double channels) : m_pins(std::move(pins)), m_channels(channels) {
        recomputeLeakageIndices();
    }

    const char* typeId() const override { return "active.analog_mux"; }
    std::span<Pin> pins() override { return m_pins; }

    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return m_converged; }

    /** `en` + todo `addr-*` -- só são LIDOS em `stamp()`, nunca ganham condutância própria ali (sem
     * isto, um pino não fiado, comum: endereço fixo, `en` sempre habilitado, faria
     * `Netlist::rebuildTopology` fundir um nó SEM equação nenhuma no mesmo grupo topológico de
     * `z`/`chan-*`, deixando o grupo INTEIRO singular). Framework aplica `kLeakageGuardConductance`
     * a estes depois de `stamp()` (achado de auditoria arquitetural 2026-07-09, D9/LeakageGuard) --
     * default resultante (não fiado = ~0V) continua "habilitado" (en ativo baixo) / bit 0
     * (endereço), mesmo comportamento de antes. */
    std::span<const uint32_t> leakagePinIndices() const override { return m_leakageIndices; }

    void stamp(MnaMatrixView& matrix) override {
        if (m_pins.size() < kFixedCount) {
            m_converged = true;
            return;
        }
        const size_t addrBits = addrBitCount();
        const size_t channelCount = std::min(channelCountFromProperty(), m_pins.size() - kFixedCount - addrBits);

        const bool enabled = matrix.getNodeVoltage(m_pins[kEn]) < kLogicThreshold;
        size_t address = 0;
        for (size_t i = 0; i < addrBits; ++i) {
            if (matrix.getNodeVoltage(m_pins[kFixedCount + i]) > kLogicThreshold) address |= (size_t{1} << i);
        }

        for (size_t i = 0; i < channelCount; ++i) {
            const double admit = (enabled && i == address) ? kOnConductance : kOffConductance;
            matrix.addConductance(m_pins[kZ], m_pins[kFixedCount + addrBits + i], admit);
        }

        const bool changed = enabled != m_lastEnabled || address != m_lastAddress;
        m_converged = !changed;
        m_lastEnabled = enabled;
        m_lastAddress = address;
    }

    void postStep(uint64_t) override {} // puramente algébrico (chaveamento resistivo, sem estado dinâmico)

    std::optional<double> current() const override { return std::nullopt; } // sem terminal de 2 pinos único -- ver `Ampmeter` pra leitura de corrente real

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const PropertySchema channelsSchema = schema();
        return {
            PropertyDefinition{
                channelsSchema,
                [this] { return PropertyValue{m_channels}; },
                [this, channelsSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(channelsSchema, v)) return {false, *error};
                    m_channels = std::max(1.0, std::get<double>(v));
                    // Recomputa `m_pins` SÍNCRONO aqui (mesmo padrão de `SimulidePassiveState`) --
                    // `SimulationSession::reregisterPinsIfChanged` só compara `instance->pins()`
                    // ANTES/DEPOIS de `descriptor.set()`, não recalcula nada sozinho.
                    m_pins = resolveDynamicPins(pinSpec(), {{"channels", PropertyValue{m_channels}}});
                    recomputeLeakageIndices(); // addrBits pode ter mudado junto com os pinos
                    return {true, {}};
                },
            },
        };
    }

    static PropertySchema schema() {
        PropertySchema s;
        s.id = "channels";
        s.label = "Canais";
        s.group = "Elétrica";
        s.valueKind = PropertyValueKind::Number;
        s.editor = "number";
        s.defaultValue = 8.0;
        s.minValue = 1.0;
        s.maxValue = 64.0;
        s.flags = PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount;
        return s;
    }

private:
    static constexpr double kOnConductance = 1000.0;  // siemens -- mesmo `m_admit` default do original (1mΩ)
    static constexpr double kOffConductance = 1e-7;    // siemens -- mesma ordem de `low_imp` do SimulIDE
    static constexpr double kLogicThreshold = 2.5;     // V -- mesmo limiar de `voltChanged()` real
    static constexpr size_t kZ = 0;
    static constexpr size_t kEn = 1;
    static constexpr size_t kFixedCount = 2;

    size_t addrBitCount() const {
        return m_channels > 1.0 ? static_cast<size_t>(std::ceil(std::log2(m_channels))) : 0;
    }
    size_t channelCountFromProperty() const { return static_cast<size_t>(std::max(0.0, m_channels)); }

    /** `en` + todo `addr-*` -- recomputado sempre que `m_pins`/`m_channels` mudam (construtor e o
     * setter de `channels`), nunca lido de volta de `m_pins.size()` pra nunca divergir. */
    void recomputeLeakageIndices() {
        m_leakageIndices.clear();
        m_leakageIndices.push_back(static_cast<uint32_t>(kEn));
        const size_t addrBits = addrBitCount();
        for (size_t i = 0; i < addrBits; ++i) m_leakageIndices.push_back(static_cast<uint32_t>(kFixedCount + i));
    }

    std::vector<Pin> m_pins;
    double m_channels;
    std::vector<uint32_t> m_leakageIndices;
    bool m_lastEnabled = false;
    size_t m_lastAddress = 0;
    bool m_converged = false;
};

} // namespace lasecsimul::components

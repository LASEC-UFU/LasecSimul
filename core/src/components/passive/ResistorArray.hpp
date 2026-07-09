#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <span>
#include <stdexcept>
#include <vector>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * N resistores independentes de 2 terminais cada, MESMA resistência compartilhada (`resistance`),
 * pinos em pares consecutivos `(2i, 2i+1)` -- porta de `SimulIDE-dev/src/components/passive/
 * resistors/resistordip.cpp` (`m_pin[i*2]`/`m_pin[i*2+1]` por resistor `i`, `res->setResistance(
 * m_resistance)` uniforme pra todos).
 *
 * Usada por `passive.resistor_dip` (achado de auditoria 2026-07-08: registrava só 2 dos 16 pinos
 * declarados no catálogo via `SimulideTwoPinResistor`, os outros 14 ficavam eletricamente
 * flutuando -- 8 pares fixos aqui, batendo com o `package` já existente) e `outputs.dc_motor`/
 * `outputs.stepper` (mesmo achado: `SimulidePassiveState` sem `stamp()`, agora resistores reais
 * aproximando o enrolamento/bobina -- sem modelo de torque/rotação, simplificação documentada).
 *
 * NÃO implementado (fora de escopo desta correção, `resistordip.cpp` real também suporta): modo
 * "Pullup" (barramento com pino direito oculto, ligado a um trilho comum) e redimensionamento
 * dinâmico de `size` -- o catálogo atual declara os 16 pinos como fixos (sem `dynamicLayout`), esta
 * classe segue a mesma contagem fixa.
 */
class ResistorArray final : public IComponentModel {
public:
    ResistorArray(std::string typeId, std::vector<Pin> pins, double resistanceOhm)
        : m_typeId(std::move(typeId)), m_pins(std::move(pins)), m_resistance(validate(resistanceOhm)) {
        m_lastCurrent.assign(pairCount(), 0.0);
        m_leakageIndices.reserve(m_pins.size());
        for (uint32_t i = 0; i < m_pins.size(); ++i) m_leakageIndices.push_back(i);
    }

    const char* typeId() const override { return m_typeId.c_str(); }
    std::span<Pin> pins() override { return m_pins; }

    /** Cada PAR só se conecta a si mesmo (nunca aos outros pares) -- mas `Netlist::rebuildTopology`
     * funde TODOS os pinos do MESMO componente no MESMO grupo topológico de qualquer forma ("mesmo
     * componente => mesmo grupo", ver `Netlist.hpp`). Um usuário usando só 1-2 dos 8 pares (uso
     * normal de um DIP -- ninguém fia os 16 pinos sempre) deixaria os outros pares como sub-redes
     * sem referência nenhuma DENTRO do mesmo grupo dos pares em uso, tornando o GRUPO INTEIRO
     * singular. Framework aplica `kLeakageGuardConductance` a TODOS os pinos depois de `stamp()`
     * (achado de auditoria arquitetural 2026-07-09, D9/LeakageGuard) -- insignificante mesmo
     * empilhado sobre a condutância real de um par já estampado. */
    std::span<const uint32_t> leakagePinIndices() const override { return m_leakageIndices; }

    void stamp(MnaMatrixView& matrix) override {
        const double conductance = 1.0 / m_resistance;
        for (size_t i = 0; i < pairCount(); ++i) {
            const Pin& a = m_pins[i * 2];
            const Pin& b = m_pins[i * 2 + 1];
            m_lastCurrent[i] = conductance * (matrix.getNodeVoltage(a) - matrix.getNodeVoltage(b));
            matrix.addConductance(a, b, conductance);
        }
    }

    void postStep(uint64_t) override {} // puramente algébrico, mesma nota de Resistor::postStep

    /** Corrente do PRIMEIRO par (pin0->pin1) -- leitura única exigida por `IComponentModel`; os
     * demais pares não têm um canal de leitura individual hoje (mesma limitação que qualquer
     * componente multi-terminal sem medidor dedicado, ver `Ampmeter` pra leitura real por ramo). */
    std::optional<double> current() const override { return m_lastCurrent.empty() ? std::nullopt : std::optional{m_lastCurrent[0]}; }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const PropertySchema schema = propertySchema(m_resistance).front();
        return {
            PropertyDefinition{
                schema,
                [this] { return PropertyValue{m_resistance}; },
                [this, schema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(schema, v)) return {false, *error};
                    m_resistance = validate(std::get<double>(v));
                    return {true, {}};
                },
            },
        };
    }

    static std::vector<PropertySchema> propertySchema(double defaultOhm) {
        PropertySchema schema;
        schema.id = "resistance";
        schema.label = "Resistência";
        schema.group = "Elétrica";
        schema.unit = "Ω";
        schema.valueKind = PropertyValueKind::Number;
        schema.editor = "number";
        schema.defaultValue = defaultOhm;
        schema.minValue = 1e-9;
        schema.step = 1.0;
        schema.flags |= PropertySchemaShowOnSymbol;
        return {schema};
    }

private:
    static double validate(double ohm) {
        if (!std::isfinite(ohm) || ohm <= 0.0) throw std::invalid_argument("resistance deve ser > 0 ohm");
        return ohm;
    }
    size_t pairCount() const { return m_pins.size() / 2; }

    std::string m_typeId;
    std::vector<Pin> m_pins;
    double m_resistance;
    std::vector<double> m_lastCurrent;
    std::vector<uint32_t> m_leakageIndices;
};

} // namespace lasecsimul::components

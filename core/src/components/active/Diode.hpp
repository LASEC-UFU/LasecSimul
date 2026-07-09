#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <stdexcept>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * Primeiro componente não linear real do Core (Épico H do roadmap de pendências) — diodo
 * Shockley com modelo companion (condutância + fonte de corrente equivalente) linearizado em
 * torno do ponto de operação da ÚLTIMA solve(), exatamente como `IComponentModel::stamp()` já
 * documenta para `isNonlinear()==true`. Ver .spec/lasecsimul.spec, seção 7.4.
 *
 * Id(Vd) = Is * (exp(Vd/Vt) - 1)
 * Linearizado em Vop: Id(Vd) ≈ Gd*Vd + Ieq, com Gd = dId/dVd em Vop, Ieq = Id(Vop) - Gd*Vop.
 *
 * Amortecimento de Newton (técnica padrão de SPICE, "limiting"): o passo de Vd entre duas
 * iterações consecutivas é limitado a `2*Vt` quando o ponto anterior já passou de `vCrit` — sem
 * isso, exp(Vd/Vt) diverge pra infinito antes do laço de Newton-Raphson conseguir convergir,
 * para qualquer circuito que force uma estimativa inicial de Vd grande.
 *
 * `breakdownVoltage` (opcional, 0 = desativado, comportamento de `active.diode` intocado):
 * ruptura reversa tipo zener -- um SEGUNDO ramo exponencial espelhado, ativo quando
 * `-vd > breakdownVoltage`, na MESMA base `saturationCurrent`/`thermalVoltage` do ramo direto (não
 * introduz parâmetros novos pro usuário além do próprio `breakdownVoltage`). Simplificação
 * DELIBERADA frente ao `eDiode::voltChanged()` real do SimulIDE (`e-diode.cpp`): sem o offset
 * logarítmico de suavização do joelho (`m_zOfset`) nem o `emCoef`/`gmin` variável por passo -- captura
 * o comportamento físico essencial (clampeamento de tensão perto da ruptura) sem replicar as
 * constantes exatas de arredondamento do SimulIDE. Documentado, não escondido -- ver
 * `.spec/lasecsimul.spec` seção 7.4 e memória do projeto.
 */
class Diode final : public IComponentModel {
public:
    explicit Diode(std::array<Pin, 2> pins, double saturationCurrent = 1e-12, double thermalVoltage = 0.02585,
                   double breakdownVoltage = 0.0, bool supportsBreakdown = false)
        : m_pins(std::move(pins)), m_saturationCurrent(validate(saturationCurrent)), m_thermalVoltage(thermalVoltage),
          m_breakdownVoltage(std::max(breakdownVoltage, 0.0)), m_supportsBreakdown(supportsBreakdown) {}

    const char* typeId() const override { return "active.diode"; }
    std::span<Pin> pins() override { return m_pins; }

    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return m_converged; }

    void stamp(MnaMatrixView& matrix) override {
        double vd = matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]);
        vd = dampedVoltage(vd);

        const double expTerm = std::exp(vd / m_thermalVoltage);
        double id = m_saturationCurrent * (expTerm - 1.0);
        // Gd nunca cai a zero (mesmo em polarização reversa funda) -- evita admitância nula numa
        // ponta do componente, o que deixaria o nó sem nenhuma referência e a matriz quase singular.
        double gd = std::max((m_saturationCurrent / m_thermalVoltage) * expTerm, 1e-15);

        if (m_breakdownVoltage > 0.0 && vd < 0.0) {
            // vz = quanto a tensão reversa já passou do ponto de ruptura -- cresce rápido uma vez
            // que a "ruptura" começa a conduzir, por isso o clamp em kMaxBreakdownOvershoot (o
            // amortecimento de `dampedVoltage` já limita o passo por iteração, isto é só uma
            // segunda rede de segurança contra overflow de exp() em circuitos patológicos).
            const double vz = std::min(-vd - m_breakdownVoltage, kMaxBreakdownOvershoot);
            if (vz > 0.0) {
                const double expZ = std::exp(vz / m_thermalVoltage);
                id -= m_saturationCurrent * expZ;
                gd += (m_saturationCurrent / m_thermalVoltage) * expZ;
            }
        }
        const double ieq = id - gd * vd;

        matrix.addConductance(m_pins[0], m_pins[1], gd);
        matrix.addCurrent(m_pins[0], m_pins[1], ieq);

        m_converged = std::abs(vd - m_lastVd) < kVoltageTolerance;
        m_lastVd = vd;
        m_lastCurrent = id; // equação real do diodo no ponto de linearização, não o companion model
    }

    void postStep(uint64_t) override {
        // puramente algébrico (sem capacitância de junção modelada nesta primeira versão) — nunca
        // registrado como dinâmico, isto nunca é chamado de fato.
    }

    /** Corrente do anodo (p0) pro catodo (p1) na última solve(), pela equação de Shockley real
     * (não o companion model linearizado -- mais fiel ao Id físico no ponto convergido). */
    std::optional<double> current() const override { return m_lastCurrent; }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    /** `withBreakdown`: schema tem 1 ou 2 entradas dependendo de `m_supportsBreakdown` (`active.zener`
     * vs `active.diode`, ver `propertySchema()` abaixo) -- `properties()` busca cada uma por id em
     * vez de índice fixo, então o número de propriedades varia sem acoplamento posicional. */
    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema(m_supportsBreakdown);
        const PropertySchema saturationCurrentSchema = schemaById(schemas, "saturationCurrent");
        std::vector<PropertyDefinition> defs{
            PropertyDefinition{
                saturationCurrentSchema,
                [this] { return PropertyValue{m_saturationCurrent}; },
                [this, saturationCurrentSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(saturationCurrentSchema, v)) {
                        return {false, *error};
                    }
                    setSaturationCurrent(std::get<double>(v));
                    return {true, {}};
                },
            },
        };
        if (!m_supportsBreakdown) return defs;

        const PropertySchema breakdownSchema = schemaById(schemas, "breakdownVoltage");
        defs.push_back(PropertyDefinition{
            breakdownSchema,
            [this] { return PropertyValue{m_breakdownVoltage}; },
            [this, breakdownSchema](const PropertyValue& v) -> PropertyBindResult {
                if (const std::optional<std::string> error = validatePropertyValue(breakdownSchema, v)) return {false, *error};
                m_breakdownVoltage = std::max(std::get<double>(v), 0.0);
                return {true, {}};
            },
        });
        return defs;
    }

    /** `withBreakdown`: `active.zener` registra com `true` (schema de 2 campos, ver
     * `CoreApplication.cpp`); `active.diode` registra com `false` (só `saturationCurrent`, schema
     * idêntico ao de antes desta mudança -- comportamento/UI de `active.diode` intocados). */
    static std::vector<PropertySchema> propertySchema(bool withBreakdown = false) {
        PropertySchema schema;
        schema.id = "saturationCurrent";
        schema.label = "Corrente de Saturação";
        schema.group = "Elétrica";
        schema.unit = "A";
        schema.valueKind = PropertyValueKind::Number;
        schema.editor = "number";
        schema.defaultValue = 1e-12;
        schema.minValue = 1e-18;
        schema.step = 1e-12;
        if (!withBreakdown) return {schema};

        PropertySchema breakdown;
        breakdown.id = "breakdownVoltage";
        breakdown.label = "Tensão de Ruptura (Zener)";
        breakdown.group = "Elétrica";
        breakdown.unit = "V";
        breakdown.valueKind = PropertyValueKind::Number;
        breakdown.editor = "number";
        breakdown.defaultValue = 5.1;
        breakdown.minValue = 0.0;
        breakdown.step = 0.1;
        return {schema, breakdown};
    }

    void setSaturationCurrent(double amperes) { m_saturationCurrent = validate(amperes); }

private:
    static constexpr double kVoltageTolerance = 1e-6;
    // Limite absoluto de quanto o ramo de ruptura pode ultrapassar breakdownVoltage antes de
    // saturar o cálculo -- rede de segurança contra overflow de exp() em circuito patológico
    // (fonte reversa absurdamente alta sem resistor limitador); amortecimento por iteração
    // (dampedVoltage) já é a defesa PRINCIPAL, isto é só o teto final.
    static constexpr double kMaxBreakdownOvershoot = 2.0;

    static double validate(double amperes) {
        if (!std::isfinite(amperes) || amperes <= 0.0) {
            throw std::invalid_argument("saturationCurrent deve ser > 0 A");
        }
        return amperes;
    }

    double dampedVoltage(double vd) const {
        const double vCrit = m_thermalVoltage * std::log(m_thermalVoltage / (std::sqrt(2.0) * m_saturationCurrent));
        if (vd > vCrit) {
            if (m_lastVd <= vCrit) return vCrit; // primeira vez cruzando vCrit: entra exatamente no limiar
            return std::min(vd, m_lastVd + 2.0 * m_thermalVoltage); // passo de Newton amortecido
        }
        if (m_breakdownVoltage > 0.0) {
            // Espelho do amortecimento acima, ancorado no limiar de ruptura reversa em vez de vCrit
            // -- sem isto, o ramo de ruptura (stamp()) teria a MESMA divergência exponencial que o
            // ramo direto tinha antes do amortecimento existir.
            const double vCritNeg = -(m_breakdownVoltage + vCrit);
            if (vd < vCritNeg) {
                if (m_lastVd >= vCritNeg) return vCritNeg;
                return std::max(vd, m_lastVd - 2.0 * m_thermalVoltage);
            }
        }
        return vd;
    }

    std::array<Pin, 2> m_pins;
    double m_saturationCurrent;
    double m_thermalVoltage;
    double m_breakdownVoltage;
    bool m_supportsBreakdown;
    double m_lastVd = 0.0;
    double m_lastCurrent = 0.0;
    bool m_converged = false;
};

} // namespace lasecsimul::components

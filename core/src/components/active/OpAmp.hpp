#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <span>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * Amplificador operacional ideal (nullor) simplificado — porta conceitual de
 * `SimulIDE-dev/src/components/active/op_amp.cpp`, reduzida à MESMA técnica já usada por `Csource`
 * (fonte controlada linearizada por round, sem Newton-Raphson de verdade) e `Rail` (saída de 1
 * terminal referenciada à terra global via `addConductanceToGround`/`addCurrentToGround`, sem
 * precisar de um segundo pino de retorno). `Vout = clamp(gain*(V+ - V-), ±kMaxOutput)` -- entrada
 * de impedância infinita (nada estampado em in+/in-, ganho tende a forçar V+≈V- via realimentação
 * externa negativa, exatamente como um opamp real em malha fechada).
 *
 * Pinos de alimentação (`powerPos`/`powerNeg`, ver `component-catalog.json`) são deliberadamente
 * NÃO estampados eletricamente aqui -- sem clamping real de saída nos trilhos de alimentação
 * (simplificação documentada, mesmo espírito da nota em `Diode.hpp` sobre não replicar cada
 * detalhe do modelo real). `kMaxOutput` existe só como rede de segurança numérica contra
 * overflow/instabilidade em circuitos de malha aberta (sem realimentação), não como modelo físico
 * de saturação de trilho.
 *
 * **Amortecimento obrigatório** (achado ao testar um buffer de ganho unitário real: sem isto a
 * iteração diverge) -- diferente de `Csource` (tipicamente usado em malha ABERTA, pino de controle
 * separado da saída), um opamp em realimentação negativa alimenta sua PRÓPRIA saída de volta pro
 * `in-`. Sem amortecimento, a iteração ingênua `V_out(n+1) = gain*(V+ - V_out(n))` é um ponto fixo
 * com |derivada| = `gain` >> 1 -- diverge geometricamente a cada round em vez de convergir.
 * Sub-relaxação com `alpha = 1/(1+gain)` resolve isto: pro caso buffer (`in-` = `out` direto, pior
 * caso de realimentação, atenuação=1), a substituição algébrica mostra que `V_out` converge pro
 * valor correto em UMA única iteração, de qualquer ponto de partida -- qualquer rede de
 * realimentação com atenuação ≤1 (a esmagadora maioria dos circuitos reais: buffer, não-inversor,
 * inversor, somador) converge de forma estável com esta mesma escolha de `alpha`.
 *
 * Reaproveitada por `active.opamp` (ganho editável, default 100000 -- ver `opAmpSchema` em
 * `CoreApplication.cpp`) e `active.comparator` (mesma classe, ganho fixo bem mais alto pra
 * aproximar uma transição quase digital -- ver registro em `CoreApplication.cpp`).
 *
 * 5 pinos (não 3) pra bater com o `package` do catálogo (in+, in-, out, powerPos, powerNeg) --
 * `powerPos`/`powerNeg` (índices 3/4) ficam DECLARADOS mas sem física de trilho real (mesma
 * simplificação de sempre). PRECISAM, no entanto, de uma condutância mínima até a terra
 * (`kLeakageConductance`) mesmo assim -- achado ao testar: `Netlist::rebuildTopology` funde TODOS
 * os pinos do MESMO componente no MESMO grupo topológico, sempre, mesmo sem fio nenhum entre eles
 * (comentário "mesmo componente => mesmo grupo" em `Netlist.hpp`). Se `powerPos`/`powerNeg`
 * ficassem SEM estampa nenhuma (nem pra terra), o grupo inteiro (5 nós, incluindo in+/in-/out)
 * ficaria singular por causa dos 2 pinos sem NENHUMA equação -- o solver zeraria a saída de
 * qualquer opamp em qualquer circuito que não fiasse os pinos de alimentação (o caso comum, já que
 * eles são decorativos). Precisam, mesmo assim, de uma condutância mínima até a terra -- ver
 * `leakagePinIndices()` abaixo (LeakageGuard, aplicado pelo framework desde 2026-07-09, não mais
 * manualmente dentro de `stamp()`) -- fisicamente insignificante (corrente na casa de picoampère
 * mesmo em tensões altas), só evita a matriz singular, não modela nada.
 */
class OpAmp final : public IComponentModel {
public:
    explicit OpAmp(std::array<Pin, 5> pins, double gain) : m_pins(std::move(pins)), m_gain(gain) {}

    const char* typeId() const override { return "active.opamp"; }
    std::span<Pin> pins() override { return m_pins; }

    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return m_converged; }

    /** `powerPos`/`powerNeg` -- ver doc da classe. Framework (`SimulationSession::settleStep`)
     * aplica `kLeakageGuardConductance` a estes dois depois de `stamp()`; `OpAmp` nunca mais
     * estampa isso manualmente (achado de auditoria arquitetural 2026-07-09, D9/LeakageGuard). */
    std::span<const uint32_t> leakagePinIndices() const override { return kLeakageIndices; }

    void stamp(MnaMatrixView& matrix) override {
        const double vPlus = matrix.getNodeVoltage(m_pins[kInPlus]);
        const double vMinus = matrix.getNodeVoltage(m_pins[kInMinus]);
        const double desired = std::clamp(m_gain * (vPlus - vMinus), -kMaxOutput, kMaxOutput);
        const double alpha = 1.0 / (1.0 + m_gain);
        const double effective = m_lastEffective + alpha * (desired - m_lastEffective);

        m_lastOutputCurrent =
            kOutputConductance * matrix.getNodeVoltage(m_pins[kOut]) - effective * kOutputConductance;
        matrix.addConductanceToGround(m_pins[kOut], kOutputConductance);
        matrix.addCurrentToGround(m_pins[kOut], effective * kOutputConductance);

        m_converged = std::abs(effective - m_lastEffective) < kTolerance;
        m_lastEffective = effective;
    }

    void postStep(uint64_t) override {} // puramente algébrico

    /** Corrente entregue pela saída (convenção passiva, ver Rail::current()). */
    std::optional<double> current() const override { return m_lastOutputCurrent; }

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const PropertySchema schema = propertySchema().front();
        return {
            PropertyDefinition{
                schema,
                [this] { return PropertyValue{m_gain}; },
                [this, schema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(schema, v)) return {false, *error};
                    m_gain = std::get<double>(v);
                    return {true, {}};
                },
            },
        };
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema gain;
        gain.id = "gain";
        gain.label = "Ganho";
        gain.group = "Elétrica";
        gain.valueKind = PropertyValueKind::Number;
        gain.editor = "number";
        gain.defaultValue = 100000.0;
        gain.minValue = 1.0;
        return {gain};
    }

private:
    static constexpr double kOutputConductance = 1e6; // siemens -- menor que Rail (1e9): saída tem alguma "força" finita, evita mal-condicionamento quando gain já é grande
    static constexpr double kMaxOutput = 1e6; // V -- rede de segurança numérica, não modelo de trilho real
    static constexpr double kTolerance = 1e-6;
    static constexpr size_t kInPlus = 0;
    static constexpr size_t kInMinus = 1;
    static constexpr size_t kOut = 2;
    static constexpr size_t kPowerPos = 3;
    static constexpr size_t kPowerNeg = 4;
    static constexpr std::array<uint32_t, 2> kLeakageIndices = {kPowerPos, kPowerNeg};

    std::array<Pin, 5> m_pins;
    double m_gain;
    double m_lastEffective = 0.0;
    double m_lastOutputCurrent = 0.0;
    bool m_converged = false;
};

} // namespace lasecsimul::components

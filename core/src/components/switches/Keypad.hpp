#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/switches/keypad.cpp` -- matriz de teclas real (não
 * `SimulidePassiveState`, cujo `stamp()` é um no-op puro; achado de auditoria 2026-07-08: apertar
 * uma tecla nunca curto-circuitava linha-coluna nenhuma, o keypad inteiro era eletricamente
 * inerte).
 *
 * Pinos SEMPRE `[row-0..row-(rows-1), col-0..col-(cols-1)]` (`ComponentPinSpec{{}, {{"pin-","rows"},
 * {"pin-","columns"}}}`, mesma fórmula do original: `m_pin[row]`/`m_pin[m_rows+col]`).
 *
 * `pressedMask`: bitmask (bit `row*columns+col`) de quais teclas estão pressionadas AGORA --
 * substitui o clique interativo do mouse do SimulIDE real (`PushBase::press()` por tecla), que
 * exigiria um caminho de UI/IPC novo (Webview -> Core por tecla) fora do escopo desta correção
 * (documentado como pendência separada, não um bug de física). Uma tecla pressionada ainda conecta
 * linha↔coluna com baixa impedância, exatamente como o botão real faria -- só a FONTE do estado
 * (propriedade em vez de clique do mouse) é simplificada. Sem diodo (`diodes=false`): conexão
 * direta linha-coluna. Com diodo (`diodes=true`): a MESMA física de `Diode` (Shockley, sem
 * ruptura) em série, direção controlada por `diodesDirection` -- mesma convenção de `direction` no
 * original (`false`: anodo na linha; `true`: anodo na coluna).
 */
class Keypad final : public IComponentModel {
public:
    Keypad(std::vector<Pin> pins, size_t rows, size_t columns, bool hasDiodes, bool diodesDirection,
           double pressedMask)
        : m_pins(std::move(pins)), m_rows(rows), m_columns(columns), m_hasDiodes(hasDiodes),
          m_diodesDirection(diodesDirection), m_pressedMask(pressedMask) {
        m_lastVd.assign(m_rows * m_columns, 0.0);
    }

    const char* typeId() const override { return "switches.keypad"; }
    std::span<Pin> pins() override { return m_pins; }

    bool isNonlinear() const override { return m_hasDiodes; } // sem diodo: puramente resistivo, converge no 1º round
    bool hasConverged() const override { return m_converged; }

    void stamp(MnaMatrixView& matrix) override {
        bool allConverged = true;
        for (size_t row = 0; row < m_rows; ++row) {
            const Pin& rowPin = m_pins[row];
            for (size_t col = 0; col < m_columns; ++col) {
                const Pin& colPin = m_pins[m_rows + col];
                const size_t index = row * m_columns + col;
                const bool pressed = keyPressed(index);

                if (!m_hasDiodes) {
                    matrix.addConductance(rowPin, colPin, pressed ? kClosedConductance : kOpenConductance);
                    continue;
                }
                // Diodo em série com a tecla -- só conduz de verdade se a tecla estiver fechada
                // (mesma topologia do original: botão + diodo em série entre linha e coluna).
                // Simplificação: modelamos o par botão+diodo como UM ramo -- fechado ideal quando
                // pressionado (mesma condutância `kClosedConductance` do caso sem diodo) na direção
                // permitida pelo diodo, e a física exponencial de verdade só quando isso importa
                // (tecla fechada) -- tecla aberta já é alta impedância por si só, sem precisar do
                // diodo pra bloquear nada.
                const Pin& anode = m_diodesDirection ? colPin : rowPin;
                const Pin& cathode = m_diodesDirection ? rowPin : colPin;
                if (!pressed) {
                    matrix.addConductance(rowPin, colPin, kOpenConductance);
                    m_lastVd[index] = 0.0;
                    continue;
                }
                double vd = matrix.getNodeVoltage(anode) - matrix.getNodeVoltage(cathode);
                vd = dampedVoltage(vd, m_lastVd[index]);
                const double expTerm = std::exp(vd / kThermalVoltage);
                const double id = kSaturationCurrent * (expTerm - 1.0);
                const double gd = std::max((kSaturationCurrent / kThermalVoltage) * expTerm, kOpenConductance);
                const double ieq = id - gd * vd;
                matrix.addConductance(anode, cathode, gd);
                matrix.addCurrent(anode, cathode, ieq);
                allConverged = allConverged && std::abs(vd - m_lastVd[index]) < kVoltageTolerance;
                m_lastVd[index] = vd;
            }
        }
        m_converged = !m_hasDiodes || allConverged;
    }

    void postStep(uint64_t) override {}

    std::optional<double> current() const override { return std::nullopt; } // sem terminal único -- matriz N×M

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    /** `rows`/`columns`/`keyLabels` continuam só na metadata catalog (`keypadSchema` em
     * `CoreApplication.cpp`, editável na criação via `ComponentParams`, nunca em runtime) --
     * assimetria pré-existente à esta migração, preservada de propósito (mudar isso seria uma
     * mudança de comportamento nova, fora do escopo de "migrar pro padrão novo"). Achado ao migrar:
     * ANTES desta correção, `propertyDescriptors()` nunca preenchia `.schema` pra nenhum destes 3
     * -- `PropertyDescriptor::schema` ficava default-construído (`valueKind=String`), então
     * `SimulationSession::setProperty` rejeitava `diodes`/`diodesDirection`/`pressedMask` com
     * `type_mismatch` mesmo passando o tipo certo (bool/number). `propertySchema()` abaixo fecha
     * isso -- efeito colateral correto da unificação, não escopo novo. */
    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        const PropertySchema diodesSchema = schemaById(schemas, "diodes");
        const PropertySchema diodesDirectionSchema = schemaById(schemas, "diodesDirection");
        const PropertySchema pressedMaskSchema = schemaById(schemas, "pressedMask");
        return {
            PropertyDefinition{
                diodesSchema,
                [this] { return PropertyValue{m_hasDiodes}; },
                [this, diodesSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(diodesSchema, v)) return {false, *error};
                    m_hasDiodes = std::get<bool>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                diodesDirectionSchema,
                [this] { return PropertyValue{m_diodesDirection}; },
                [this, diodesDirectionSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(diodesDirectionSchema, v)) {
                        return {false, *error};
                    }
                    m_diodesDirection = std::get<bool>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                pressedMaskSchema,
                [this] { return PropertyValue{m_pressedMask}; },
                [this, pressedMaskSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(pressedMaskSchema, v)) return {false, *error};
                    m_pressedMask = std::max(0.0, std::get<double>(v));
                    return {true, {}};
                },
            },
        };
    }

    /** Subconjunto de `keypadSchema` (`CoreApplication.cpp`) — só as 3 propriedades editáveis em
     * runtime (`rows`/`columns`/`keyLabels` ficam só na metadata catalog, ver comentário de
     * `properties()` acima). Grupo "Principal" pra bater com o override que `CoreApplication.cpp`
     * já aplica em `keypadSchema` (mesma aba na Webview). */
    static std::vector<PropertySchema> propertySchema() {
        PropertySchema diodes;
        diodes.id = "diodes";
        diodes.label = "Diodos";
        diodes.group = "Principal";
        diodes.valueKind = PropertyValueKind::Bool;
        diodes.editor = "checkbox";
        diodes.defaultValue = false;

        PropertySchema diodesDirection;
        diodesDirection.id = "diodesDirection";
        diodesDirection.label = "Direção dos Diodos";
        diodesDirection.group = "Principal";
        diodesDirection.valueKind = PropertyValueKind::Bool;
        diodesDirection.editor = "checkbox";
        diodesDirection.defaultValue = false;

        PropertySchema pressedMask;
        pressedMask.id = "pressedMask";
        pressedMask.label = "Teclas Pressionadas (bitmask)";
        pressedMask.group = "Principal";
        pressedMask.valueKind = PropertyValueKind::Number;
        pressedMask.editor = "number";
        pressedMask.defaultValue = 0.0;
        pressedMask.minValue = 0.0;
        pressedMask.step = 1.0;

        return {diodes, diodesDirection, pressedMask};
    }

private:
    bool keyPressed(size_t index) const {
        if (index >= 53) return false; // limite de precisão exata de bitmask num double (2^53)
        const uint64_t mask = static_cast<uint64_t>(m_pressedMask);
        return (mask & (uint64_t{1} << index)) != 0;
    }

    double dampedVoltage(double vd, double lastVd) const {
        const double vCrit = kThermalVoltage * std::log(kThermalVoltage / (std::sqrt(2.0) * kSaturationCurrent));
        if (vd > vCrit) {
            if (lastVd <= vCrit) return vCrit;
            return std::min(vd, lastVd + 2.0 * kThermalVoltage);
        }
        return vd;
    }

    static constexpr double kClosedConductance = 1e3;    // siemens -- tecla fechada, baixa impedância
    static constexpr double kOpenConductance = 1e-9;      // siemens -- tecla aberta, alta impedância
    static constexpr double kSaturationCurrent = 1e-12;   // "Diode Default" -- mesmo preset citado no original (setModel("Diode Default"))
    static constexpr double kThermalVoltage = 0.02585;
    static constexpr double kVoltageTolerance = 1e-6;

    std::vector<Pin> m_pins;
    size_t m_rows;
    size_t m_columns;
    bool m_hasDiodes;
    bool m_diodesDirection;
    double m_pressedMask;
    std::vector<double> m_lastVd;
    bool m_converged = false;
};

} // namespace lasecsimul::components

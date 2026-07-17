#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <string>
#include <utility>
#include <vector>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"

namespace lasecsimul::components {

/**
 * N "pernas" de LED independentes dentro de UM componente multi-pino -- usado por displays de LED
 * cujo `SimulidePassiveState` anterior tinha `stamp()` no-op (achado de auditoria 2026-07-08:
 * `outputs.led_rgb`/`led_bar`/`led_matrix`/`seven_segment` ficavam eletricamente inertes) e cujas
 * propriedades (Cor/Tensão Direta/Resistência) nunca existiram (achado da auditoria de dispositivos
 * 2026-07-13 -- `propertyDescriptors()` devolvia `{}`, `.spec` seção 29).
 *
 * Modelo piecewise linear REAL do LED (`eLed::voltChanged()`, `simulator/elements/outputs/e-led.cpp`
 * do SimulIDE) -- NÃO a equação exponencial de Shockley que este arquivo usava antes (essa é a de
 * `active.diode`/`active.zener`, ver `Diode.hpp`, correta pra diodo retificador comum, mas o LED real
 * do SimulIDE nunca usou essa curva). Abaixo de `threshold`, a perna está essencialmente aberta
 * (condutância de fuga); a partir de `threshold`, conduz como um resistor linear de valor
 * `resistance`, com uma fonte de corrente companion ancorando o "joelho" exatamente em
 * `(threshold, 0)` -- mesma forma de `eLed::voltChanged()`: `admit=1/impedance`,
 * `ThCurrent=threshold*admit` quando `vd>=threshold-ε`, senão `admit=1e-9` (fuga) e `ThCurrent=0`.
 * Convergência do Newton externo pela MESMA regra do SimulIDE real: a perna convergiu quando o TERMO
 * DE CORRENTE COMPANION (`ThCurrent`, não a tensão) parou de mudar entre iterações -- suficiente
 * porque só há 2 regiões (conduzindo/não), diferente do diodo exponencial que precisa de tolerância
 * contínua em tensão.
 *
 * Generalização (não uma correção isolada por typeId, ver `.spec` seção 29): a MESMA classe atende
 * `outputs.led` (1 perna, 2 pinos -- ver `CoreApplication.cpp`), `outputs.led_rgb`/`led_bar`/
 * `led_matrix`/`seven_segment` (N pernas). Propriedades (`Color`/`Threshold`/`Resistance`) são
 * UNIFORMES pro componente inteiro -- fiel ao real `LedBar`/`LedMatrix`/`SevenSegment` (que também
 * aplicam Color/Threshold/MaxCurrent/Resistance a TODOS os segmentos de uma vez, nunca por-segmento
 * individual, ver `ledbar.cpp::setColorStr`); `led_rgb` real tem `Threshold_R/G/B` PER-CANAL (3x) e
 * `CommonCathode` -- simplificado aqui pra um valor uniforme + catodo comum fixo, documentado como
 * pendência em `.spec` seção 29 (não uma correção parcial escondida).
 */
class DiodeLegArray final : public IComponentModel {
public:
    struct Leg {
        size_t anode;
        size_t cathode;
    };

    /** `shortedPairs`: pares de índice de pino unidos por uma condutância alta (sem diodo entre
     * eles). Recurso genérico para arrays futuros; o SevenSegment do SimulIDE usa um único comum
     * por display e não precisa desta aproximação. `threshold`/`resistance` default (2.4V/0.6Ω) == `eLed::eLed()` real
     * (`e-led.cpp:16-17`, cor "Yellow" default). */
    DiodeLegArray(std::string typeId, std::vector<Pin> pins, std::vector<Leg> legs, double threshold = 2.4,
                  double resistance = 0.6, std::vector<std::pair<size_t, size_t>> shortedPairs = {})
        : m_typeId(std::move(typeId)), m_pins(std::move(pins)), m_legs(std::move(legs)), m_threshold(threshold),
          m_resistance(resistance), m_shortedPairs(std::move(shortedPairs)) {
        m_lastThCurrent.assign(m_legs.size(), 0.0);
        m_lastCurrent.assign(m_legs.size(), 0.0);
        m_leakageIndices.reserve(m_pins.size());
        for (uint32_t i = 0; i < m_pins.size(); ++i) m_leakageIndices.push_back(i);
    }

    const char* typeId() const override { return m_typeId.c_str(); }
    std::span<Pin> pins() override { return m_pins; }

    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return m_converged; }

    /** Pernas mutuamente desconectadas (ex: `outputs.led_bar`, pares P/N independentes -- ao
     * contrário de `led_rgb`/`seven_segment`, sem catodo comum ligando tudo) sofrem do MESMO achado
     * documentado em `OpAmp.hpp`/`ResistorArray.hpp`: "mesmo componente => mesmo grupo" faria o
     * grupo INTEIRO ficar singular se o usuário só fiar algumas das pernas (uso normal de uma barra
     * de LED de 8, ninguém fia as 16). Framework aplica `kLeakageGuardConductance` a TODOS os pinos
     * depois de `stamp()` (achado de auditoria arquitetural 2026-07-09, D9/LeakageGuard) --
     * insignificante mesmo empilhado sobre a condutância real de uma perna já estampada. */
    std::span<const uint32_t> leakagePinIndices() const override { return m_leakageIndices; }

    void stamp(MnaMatrixView& matrix) override {
        for (const auto& [a, b] : m_shortedPairs) matrix.addConductance(m_pins[a], m_pins[b], kShortConductance);

        bool allConverged = true;
        const double admitOn = 1.0 / m_resistance;
        for (size_t i = 0; i < m_legs.size(); ++i) {
            const Pin& anode = m_pins[m_legs[i].anode];
            const Pin& cathode = m_pins[m_legs[i].cathode];
            const double vd = matrix.getNodeVoltage(anode) - matrix.getNodeVoltage(cathode);

            double admit = kLeakageAdmittance;
            double thCurrent = 0.0;
            if (vd - m_threshold > -kConductionEpsilon) { // "Conducing" real (e-led.cpp:62)
                admit = admitOn;
                thCurrent = m_threshold * admitOn;
            }
            const double ieq = -thCurrent; // i = admit*vd + ieq, mesma forma companion de Diode.hpp
            matrix.addConductance(anode, cathode, admit);
            matrix.addCurrent(anode, cathode, ieq);

            allConverged = allConverged && std::abs(thCurrent - m_lastThCurrent[i]) < kCurrentTolerance;
            m_lastThCurrent[i] = thCurrent;
            m_lastCurrent[i] = admit * vd + ieq;
        }
        m_converged = allConverged;
    }

    void postStep(uint64_t) override {}

    /** Só existe "a corrente" (leitura por `getComponentCurrent`/IPC) quando há exatamente 1 perna
     * -- é o caso de `outputs.led` (2 pinos, 1 perna, registrado com esta MESMA classe desde a
     * auditoria de 2026-07-13). Com N pernas (`led_rgb`/`led_bar`/`led_matrix`/`seven_segment`) não
     * há terminal único -- ver Ampmeter pra leitura por ramo; retornar uma perna arbitrária aqui
     * seria enganoso (LasecSimul não hardcoda um proxy falso), documentado como pendência de leitura
     * por-segmento em `.spec` seção 29. */
    std::optional<double> current() const override {
        if (m_legs.size() != 1) return std::nullopt;
        return m_lastCurrent[0];
    }

    /** Mesmo padrão de `Voltmeter`/`Ampmeter` (1 double) -- só existe quando há exatamente 1 perna
     * (mesma restrição de `current()`, ver comentário acima). Alimenta `readoutFormat()` abaixo, que
     * é o que faz a Webview colorir/acender o LED de verdade (`__led_fill`, `main.ts`) em vez do
     * símbolo estático de sempre -- achado do diagnóstico "LED não pisca com ESP32": o Core nunca
     * expunha esse estado, então não havia telemetria nenhuma pra Webview reagir. */
    size_t getState(uint8_t* out, size_t cap) const override {
        if (m_legs.size() != 1 || cap < sizeof(double)) return 0;
        std::memcpy(out, &m_lastCurrent[0], sizeof(double));
        return sizeof(double);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (m_legs.size() != 1 || len < sizeof(double)) return;
        std::memcpy(&m_lastCurrent[0], in, sizeof(double));
    }

    /** Só declarado por quem registra `outputs.led` (1 perna) em `CoreApplication.cpp` -- os outros
     * typeIds desta MESMA classe (led_rgb/led_bar/led_matrix/seven_segment, N pernas) não passam
     * este format pro registro, então `getComponentStates`/telemetria nunca é pedida pra eles (ver
     * limitação documentada em `current()` acima: leitura por-segmento é pendência separada). */
    static ReadoutFormat readoutFormat() {
        ReadoutFormat format;
        format.kind = ReadoutKind::Scalar;
        format.unit = "A";
        return format;
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        const PropertySchema colorSchema = schemaById(schemas, "color");
        const PropertySchema thresholdSchema = schemaById(schemas, "threshold");
        const PropertySchema resistanceSchema = schemaById(schemas, "resistance");
        return {
            PropertyDefinition{
                colorSchema,
                [this] { return PropertyValue{m_colorStr}; },
                [this, colorSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(colorSchema, v)) return {false, *error};
                    m_colorStr = std::get<std::string>(v);
                    m_threshold = thresholdForColor(m_colorStr); // eLed::setColorStr real, e-led não tem essa parte
                                                                  // -- ela vive em LedBase::setColorStr (ledbase.cpp)
                    return {true, {}};
                },
            },
            PropertyDefinition{
                thresholdSchema,
                [this] { return PropertyValue{m_threshold}; },
                [this, thresholdSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(thresholdSchema, v)) return {false, *error};
                    m_threshold = std::get<double>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                resistanceSchema,
                [this] { return PropertyValue{m_resistance}; },
                [this, resistanceSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(resistanceSchema, v)) return {false, *error};
                    m_resistance = std::max(std::get<double>(v), 0.01);
                    return {true, {}};
                },
            },
        };
    }

    /** Mesmos 7 nomes/traduções de `LedBase::getColorList()` real (`ledbase.cpp:21-24`). */
    static std::vector<PropertySchema> propertySchema() {
        PropertySchema color;
        color.id = "color";
        color.label = "Cor";
        color.group = "Principal";
        color.valueKind = PropertyValueKind::String;
        color.editor = "enum";
        color.defaultValue = std::string{"Yellow"};
        color.options = {
            {"Yellow", "Amarelo"}, {"Red", "Vermelho"}, {"Green", "Verde"},  {"Blue", "Azul"},
            {"Orange", "Laranja"}, {"Purple", "Roxo"},  {"White", "Branco"},
        };

        PropertySchema threshold;
        threshold.id = "threshold";
        threshold.label = "Tensao Direta";
        threshold.group = "Eletrica";
        threshold.unit = "V";
        threshold.valueKind = PropertyValueKind::Number;
        threshold.editor = "number";
        threshold.defaultValue = 2.4;
        threshold.minValue = 0.0;
        threshold.step = 0.1;

        PropertySchema resistance;
        resistance.id = "resistance";
        resistance.label = "Resistencia";
        resistance.group = "Eletrica";
        resistance.unit = "ohm";
        resistance.valueKind = PropertyValueKind::Number;
        resistance.editor = "number";
        resistance.defaultValue = 0.6;
        resistance.minValue = 0.01;
        resistance.step = 0.1;

        return {color, threshold, resistance};
    }

    /** `LedBase::setColorStr` real (`ledbase.cpp:108-119`) -- Yellow e cor desconhecida caem no
     * mesmo default (2.4V). */
    static double thresholdForColor(const std::string& color) {
        if (color == "Red") return 1.8;
        if (color == "Green") return 3.5;
        if (color == "Blue") return 3.6;
        if (color == "Orange") return 2.0;
        if (color == "Purple") return 3.5;
        if (color == "White") return 4.0;
        return 2.4;
    }

private:
    static constexpr double kCurrentTolerance = 1e-9;
    static constexpr double kConductionEpsilon = 1e-12; // "deltaV > -1e-12" real, e-led.cpp:62
    static constexpr double kLeakageAdmittance = 1e-9;  // "admit = 1e-9" real, e-led.cpp:59
    static constexpr double kShortConductance = 1e9;

    std::string m_typeId;
    std::vector<Pin> m_pins;
    std::vector<Leg> m_legs;
    double m_threshold;
    double m_resistance;
    std::string m_colorStr = "Yellow";
    std::vector<std::pair<size_t, size_t>> m_shortedPairs;
    std::vector<double> m_lastThCurrent;
    std::vector<double> m_lastCurrent;
    std::vector<uint32_t> m_leakageIndices;
    bool m_converged = false;
};

} // namespace lasecsimul::components

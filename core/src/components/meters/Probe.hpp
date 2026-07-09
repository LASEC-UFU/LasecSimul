#pragma once

#include <array>
#include <cmath>
#include <cstring>
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"
#include "simulation/Scheduler.hpp"

namespace lasecsimul::components {

/**
 * Porta de `SimulIDE-dev/src/components/meters/probe.cpp` — sonda de 1 pino, altíssima
 * impedância (`setImpedance(1e9)` no original), mostra a tensão lida e muda de cor acima/abaixo
 * de `threshold`. Lê a tensão no PRÓPRIO `stamp()` (reflete a última `solve()`, antes de aplicar a
 * admitância desta rodada) e guarda em `getState()` -- mesmo papel do `m_voltIn`/`setVolt()` do
 * original, exposto via o mecanismo genérico de leitura de estado em vez de rótulo gráfico
 * próprio.
 *
 * `pauseOnChange` (achado de auditoria de UI 2026-07-09, paridade com "Pause at state change" real
 * do SimulIDE, `probe.cpp:199-208`): quando ativo, PAUSA a simulação (`Scheduler::pause()`, mesma
 * referência que `Oscope`/`WaveGen` já recebem no construtor) na primeira mudança de estado digital
 * (cruzar `threshold`) depois de ativado -- breakpoint de sinal digital pra depuração. `pause()` é
 * um `store` atômico, seguro de chamar de dentro do próprio `stamp()` (mesma thread do settle loop
 * do Scheduler, sem risco de dead-lock, mesma categoria de `nowNsUnlocked()`).
 */
class Probe final : public IComponentModel {
public:
    Probe(simulation::Scheduler& scheduler, Pin pin, double threshold, bool showVolt = true, bool pauseOnChange = false)
        : m_scheduler(scheduler), m_pins{std::move(pin)}, m_threshold(threshold), m_showVolt(showVolt),
          m_pauseOnChange(pauseOnChange) {}

    const char* typeId() const override { return "meters.probe"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        m_lastVoltage = matrix.getNodeVoltage(m_pins[0]);
        matrix.addConductanceToGround(m_pins[0], kInputConductance); // alta impedância, nunca zero

        const bool digitalState = m_lastVoltage > m_threshold;
        if (m_hasLastDigitalState && digitalState != m_lastDigitalState && m_pauseOnChange) {
            m_scheduler.pause();
        }
        m_lastDigitalState = digitalState;
        m_hasLastDigitalState = true;
    }

    void postStep(uint64_t) override {}

    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(double)) return 0;
        std::memcpy(out, &m_lastVoltage, sizeof(double));
        return sizeof(double);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len < sizeof(double)) return;
        std::memcpy(&m_lastVoltage, in, sizeof(double));
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override { return toPropertyDescriptors(properties()); }

    /** ABI v2 (.spec/lasecsimul-native-devices.spec) -- `getState()` é 1 double de tensão. */
    static ReadoutFormat readoutFormat() {
        ReadoutFormat format;
        format.kind = ReadoutKind::Scalar;
        format.unit = "V";
        return format;
    }

    /** Única fonte de schema -- usada tanto por `ComponentMetadataRegistry` (via
     * `registerBuiltinMetadata`, chamada estática, sem instância) quanto por `properties()`
     * (instância, ver abaixo), que busca cada schema por ID em vez de índice. */
    static std::vector<PropertySchema> propertySchema() {
        return {
            PropertySchema{"threshold", "Limiar", "Leitura", "V", PropertyValueKind::Number, "number", 2.5},
            PropertySchema{"showVolt", "Mostrar Tensão", "Leitura", "", PropertyValueKind::Bool, "checkbox", true},
            PropertySchema{"pauseOnChange", "Pausar na Mudança de Estado", "Leitura", "", PropertyValueKind::Bool,
                           "checkbox", false},
        };
    }

    /** Declaração ÚNICA de cada propriedade -- id/schema nunca repetido à mão (achado de auditoria
     * arquitetural 2026-07-09, D1/D2: antes, `propertyDescriptors()` pegava `schemas[0]`/`[1]`/`[2]`
     * do vetor de `propertySchema()` por ÍNDICE numérico -- reordenar `propertySchema()` quebraria o
     * descriptor errado em silêncio. Aqui cada get/set é casado ao schema por ID
     * (`schemaById`), imune a reordenação). `set` valida (via `validatePropertyValue`, mesma regra
     * de `SimulationSession::setProperty`) antes de mutar. */
    std::vector<PropertyDefinition> properties() {
        const std::vector<PropertySchema> schemas = propertySchema();
        const PropertySchema thresholdSchema = schemaById(schemas, "threshold");
        const PropertySchema showVoltSchema = schemaById(schemas, "showVolt");
        const PropertySchema pauseOnChangeSchema = schemaById(schemas, "pauseOnChange");
        return {
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
                showVoltSchema,
                [this] { return PropertyValue{m_showVolt}; },
                [this, showVoltSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(showVoltSchema, v)) return {false, *error};
                    m_showVolt = std::get<bool>(v);
                    return {true, {}};
                },
            },
            PropertyDefinition{
                pauseOnChangeSchema,
                [this] { return PropertyValue{m_pauseOnChange}; },
                [this, pauseOnChangeSchema](const PropertyValue& v) -> PropertyBindResult {
                    if (const std::optional<std::string> error = validatePropertyValue(pauseOnChangeSchema, v)) return {false, *error};
                    m_pauseOnChange = std::get<bool>(v);
                    return {true, {}};
                },
            },
        };
    }

private:
    static constexpr double kInputConductance = 1e-9; // ~1GΩ, mesma ordem do high_imp do SimulIDE

    simulation::Scheduler& m_scheduler;
    std::array<Pin, 1> m_pins;
    double m_threshold;
    bool m_showVolt = true;
    bool m_pauseOnChange = false;
    double m_lastVoltage = 0.0;
    bool m_lastDigitalState = false;
    bool m_hasLastDigitalState = false;
};

} // namespace lasecsimul::components

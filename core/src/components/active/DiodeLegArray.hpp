#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <span>
#include <utility>
#include <vector>
#include "lasecsimul/IComponentModel.hpp"

namespace lasecsimul::components {

/**
 * N "pernas" de diodo independentes (mesma física de `Diode`, sem ruptura reversa) dentro de UM
 * componente multi-pino -- usado por displays de LED cujo `SimulidePassiveState` anterior tinha
 * `stamp()` no-op (achado de auditoria 2026-07-08: `outputs.led_rgb`/`led_bar`/`led_matrix`/
 * `seven_segment` ficavam eletricamente inertes). Cada perna é `(pins[anode], pins[cathode])`,
 * saturationCurrent/thermalVoltage IGUAIS ao preset "RGY Default" já usado por `outputs.led`
 * (`e-diode.cpp::getModels()`) -- mesmo joelho de tensão (~1.5-2.5V) que um LED discreto.
 *
 * Não reaproveita `Diode` diretamente (hardcoded pra exatamente 2 pinos) -- duplica a MESMA
 * equação/amortecimento de Newton em forma de laço, sem os extras de ruptura reversa (LEDs de
 * display não precisam disso). Ver `Diode.hpp` pro comentário completo da física/amortecimento.
 */
class DiodeLegArray final : public IComponentModel {
public:
    struct Leg {
        size_t anode;
        size_t cathode;
    };

    /** `shortedPairs`: pares de índice de pino unidos por uma condutância alta (sem diodo entre
     * eles) -- uso real: `outputs.seven_segment` tem DOIS pinos comuns (`commona`/`commonb`) que no
     * hardware real são o MESMO net (só exposto duas vezes pra facilitar solda), então precisam
     * ficar unidos mesmo sem o usuário desenhar um fio entre eles (mesma técnica de `Ground`,
     * `kShortConductance`). */
    DiodeLegArray(std::string typeId, std::vector<Pin> pins, std::vector<Leg> legs,
                  double saturationCurrent = 9.32e-11, double thermalVoltage = 0.0965,
                  std::vector<std::pair<size_t, size_t>> shortedPairs = {})
        : m_typeId(std::move(typeId)), m_pins(std::move(pins)), m_legs(std::move(legs)),
          m_saturationCurrent(saturationCurrent), m_thermalVoltage(thermalVoltage),
          m_shortedPairs(std::move(shortedPairs)) {
        m_lastVd.assign(m_legs.size(), 0.0);
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
        for (size_t i = 0; i < m_legs.size(); ++i) {
            const Pin& anode = m_pins[m_legs[i].anode];
            const Pin& cathode = m_pins[m_legs[i].cathode];
            double vd = matrix.getNodeVoltage(anode) - matrix.getNodeVoltage(cathode);
            vd = dampedVoltage(vd, m_lastVd[i]);

            const double expTerm = std::exp(vd / m_thermalVoltage);
            const double id = m_saturationCurrent * (expTerm - 1.0);
            const double gd = std::max((m_saturationCurrent / m_thermalVoltage) * expTerm, 1e-15);
            const double ieq = id - gd * vd;

            matrix.addConductance(anode, cathode, gd);
            matrix.addCurrent(anode, cathode, ieq);

            allConverged = allConverged && std::abs(vd - m_lastVd[i]) < kVoltageTolerance;
            m_lastVd[i] = vd;
        }
        m_converged = allConverged;
    }

    void postStep(uint64_t) override {}

    std::optional<double> current() const override { return std::nullopt; } // sem terminal único -- ver Ampmeter pra leitura por ramo

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override { return {}; } // sem propriedade elétrica editável hoje (mesmos valores fixos do preset "RGY Default")

private:
    double dampedVoltage(double vd, double lastVd) const {
        const double vCrit = m_thermalVoltage * std::log(m_thermalVoltage / (std::sqrt(2.0) * m_saturationCurrent));
        if (vd > vCrit) {
            if (lastVd <= vCrit) return vCrit;
            return std::min(vd, lastVd + 2.0 * m_thermalVoltage);
        }
        return vd;
    }

    static constexpr double kVoltageTolerance = 1e-6;
    static constexpr double kShortConductance = 1e9;

    std::string m_typeId;
    std::vector<Pin> m_pins;
    std::vector<Leg> m_legs;
    double m_saturationCurrent;
    double m_thermalVoltage;
    std::vector<std::pair<size_t, size_t>> m_shortedPairs;
    std::vector<double> m_lastVd;
    std::vector<uint32_t> m_leakageIndices;
    bool m_converged = false;
};

} // namespace lasecsimul::components

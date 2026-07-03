#pragma once

#include <array>
#include <cstring>
#include "lasecsimul/IComponentModel.hpp"

namespace lasecsimul::components {

/**
 * Voltímetro de alta impedância: 1 MΩ entre os terminais (kLeft/kRight), leitura V(+) − V(−).
 * kOut reproduz a leitura como tensão analógica (mesmo padrão do Ampmeter/Probe — outros
 * componentes podem ler esse pino).
 */
class Voltmeter final : public IComponentModel {
public:
    explicit Voltmeter(std::array<Pin, 3> pins) : m_pins(std::move(pins)) {}

    const char* typeId() const override { return "instruments.voltmeter"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override {
        m_lastVolt = matrix.getNodeVoltage(m_pins[kRight]) - matrix.getNodeVoltage(m_pins[kLeft]);

        matrix.addConductance(m_pins[kLeft], m_pins[kRight], kInputConductance);

        matrix.addConductanceToGround(m_pins[kOut], kOutConductance);
        matrix.addCurrentToGround(m_pins[kOut], m_lastVolt * kOutConductance);
    }

    void postStep(uint64_t) override {}

    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(double)) return 0;
        std::memcpy(out, &m_lastVolt, sizeof(double));
        return sizeof(double);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len < sizeof(double)) return;
        std::memcpy(&m_lastVolt, in, sizeof(double));
    }

    static ReadoutFormat readoutFormat() {
        ReadoutFormat format;
        format.kind = ReadoutKind::Scalar;
        format.unit = "V";
        return format;
    }

    static std::vector<PropertySchema> propertySchema() { return {}; }

private:
    static constexpr size_t kLeft  = 0;
    static constexpr size_t kRight = 1;
    static constexpr size_t kOut   = 2;
    static constexpr double kInputConductance = 1e-6; // 1 MΩ
    static constexpr double kOutConductance   = 1e9;

    std::array<Pin, 3> m_pins;
    double m_lastVolt = 0.0;
};

} // namespace lasecsimul::components

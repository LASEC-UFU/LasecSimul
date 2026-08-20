#pragma once

#include <array>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <optional>
#include <stdexcept>

#include "lasecsimul/IComponentModel.hpp"

namespace lasecsimul::components {

class SignalVoltageSensor final : public IComponentModel {
public:
    explicit SignalVoltageSensor(std::array<Pin, 2> pins, double inputResistanceOhm = 1e12)
        : m_pins(std::move(pins)), m_conductance(1.0 / std::max(1.0, inputResistanceOhm)) {}
    const char* typeId() const override { return "bridges.voltage_sensor"; }
    std::span<Pin> pins() override { return m_pins; }
    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return m_converged; }
    void stamp(MnaMatrixView& matrix) override {
        const double measured = matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]);
        m_converged = std::abs(measured - m_value) <= 1e-12;
        m_value = measured;
        matrix.addConductance(m_pins[0], m_pins[1], m_conductance);
    }
    void postStep(uint64_t) override {}
    double measuredValue() const { return m_value; }
    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(m_value)) return 0;
        std::memcpy(out, &m_value, sizeof(m_value)); return sizeof(m_value);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len >= sizeof(m_value)) std::memcpy(&m_value, in, sizeof(m_value));
    }
private:
    std::array<Pin, 2> m_pins;
    double m_conductance;
    double m_value = 0.0;
    bool m_converged = false;
};

class SignalCurrentSensor final : public IComponentModel {
public:
    explicit SignalCurrentSensor(std::array<Pin, 2> pins) : m_pins(std::move(pins)) {}
    const char* typeId() const override { return "bridges.current_sensor"; }
    std::span<Pin> pins() override { return m_pins; }
    uint32_t extraVariableCount() const override { return 1; }
    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return m_converged; }
    void stamp(MnaMatrixView& matrix) override {
        const double measured = matrix.getBranchCurrent();
        m_converged = std::abs(measured - m_value) <= 1e-12;
        m_value = measured;
        matrix.addVoltageSource(m_pins[0], m_pins[1], 0.0);
    }
    void postStep(uint64_t) override {}
    std::optional<double> current() const override { return m_value; }
    double measuredValue() const { return m_value; }
    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(m_value)) return 0;
        std::memcpy(out, &m_value, sizeof(m_value)); return sizeof(m_value);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len >= sizeof(m_value)) std::memcpy(&m_value, in, sizeof(m_value));
    }
private:
    std::array<Pin, 2> m_pins;
    double m_value = 0.0;
    bool m_converged = false;
};

class SignalDigitalInput final : public IComponentModel {
public:
    SignalDigitalInput(std::array<Pin, 2> pins, double lowThreshold = 0.8, double highThreshold = 2.0)
        : m_pins(std::move(pins)), m_low(lowThreshold), m_high(highThreshold) {
        if (m_low > m_high) throw std::invalid_argument("DigitalInput exige lowThreshold <= highThreshold");
    }
    const char* typeId() const override { return "bridges.digital_input"; }
    std::span<Pin> pins() override { return m_pins; }
    bool isNonlinear() const override { return true; }
    bool hasConverged() const override { return m_converged; }
    void stamp(MnaMatrixView& matrix) override {
        const bool previous = m_value;
        const double volts = matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]);
        if (volts <= m_low) m_value = false;
        else if (volts >= m_high) m_value = true;
        m_converged = previous == m_value;
        matrix.addConductance(m_pins[0], m_pins[1], 1e-12);
    }
    void postStep(uint64_t) override {}
    bool measuredValue() const { return m_value; }
    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < 1) return 0; out[0] = m_value ? 1 : 0; return 1;
    }
    void setState(const uint8_t* in, size_t len) override { if (len) m_value = in[0] != 0; }
private:
    std::array<Pin, 2> m_pins;
    double m_low;
    double m_high;
    bool m_value = false;
    bool m_converged = false;
};

class SignalControlledVoltageSource final : public IComponentModel {
public:
    explicit SignalControlledVoltageSource(std::array<Pin, 2> pins) : m_pins(std::move(pins)) {}
    const char* typeId() const override { return "bridges.controlled_voltage_source"; }
    std::span<Pin> pins() override { return m_pins; }
    uint32_t extraVariableCount() const override { return 1; }
    void stamp(MnaMatrixView& matrix) override {
        m_current = matrix.getBranchCurrent();
        matrix.addVoltageSource(m_pins[0], m_pins[1], m_command);
    }
    void postStep(uint64_t) override {}
    bool setCommand(double value) {
        if (value == m_command) return false; m_command = value; return true;
    }
    double command() const { return m_command; }
    std::optional<double> current() const override { return m_current; }
    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(m_command)) return 0;
        std::memcpy(out, &m_command, sizeof(m_command)); return sizeof(m_command);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len >= sizeof(m_command)) std::memcpy(&m_command, in, sizeof(m_command));
    }
private:
    std::array<Pin, 2> m_pins;
    double m_command = 0.0;
    double m_current = 0.0;
};

class SignalControlledCurrentSource final : public IComponentModel {
public:
    explicit SignalControlledCurrentSource(std::array<Pin, 2> pins) : m_pins(std::move(pins)) {}
    const char* typeId() const override { return "bridges.controlled_current_source"; }
    std::span<Pin> pins() override { return m_pins; }
    void stamp(MnaMatrixView& matrix) override { matrix.addCurrent(m_pins[1], m_pins[0], m_command); }
    void postStep(uint64_t) override {}
    bool setCommand(double value) {
        if (value == m_command) return false; m_command = value; return true;
    }
    double command() const { return m_command; }
    std::optional<double> current() const override { return -m_command; }
    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < sizeof(m_command)) return 0;
        std::memcpy(out, &m_command, sizeof(m_command)); return sizeof(m_command);
    }
    void setState(const uint8_t* in, size_t len) override {
        if (len >= sizeof(m_command)) std::memcpy(&m_command, in, sizeof(m_command));
    }
private:
    std::array<Pin, 2> m_pins;
    double m_command = 0.0;
};

class SignalDigitalOutput final : public IComponentModel {
public:
    SignalDigitalOutput(std::array<Pin, 2> pins, double lowVolts = 0.0, double highVolts = 5.0)
        : m_pins(std::move(pins)), m_low(lowVolts), m_high(highVolts) {}
    const char* typeId() const override { return "bridges.digital_output"; }
    std::span<Pin> pins() override { return m_pins; }
    uint32_t extraVariableCount() const override { return 1; }
    void stamp(MnaMatrixView& matrix) override { matrix.addVoltageSource(m_pins[0], m_pins[1], m_value ? m_high : m_low); }
    void postStep(uint64_t) override {}
    bool setCommand(bool value) { if (value == m_value) return false; m_value = value; return true; }
    bool command() const { return m_value; }
    size_t getState(uint8_t* out, size_t cap) const override { if (!cap) return 0; out[0] = m_value ? 1 : 0; return 1; }
    void setState(const uint8_t* in, size_t len) override { if (len) m_value = in[0] != 0; }
private:
    std::array<Pin, 2> m_pins;
    double m_low;
    double m_high;
    bool m_value = false;
};

} // namespace lasecsimul::components

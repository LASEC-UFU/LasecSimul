#pragma once
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
#include "CircuitGroup.hpp"
#include "lasecsimul/IComponentModel.hpp"

namespace lasecsimul::simulation {

/** View de stamping. No hot path guarda apenas entradas nao nulas; nunca cria uma matriz NxN por componente. */
class ComponentMatrixView final : public lasecsimul::MnaMatrixView {
public:
    ComponentMatrixView(CircuitGroup& group, const std::unordered_map<std::string, uint32_t>& pins,
                        std::optional<uint32_t> extra = std::nullopt)
        : m_group(group), m_pins(pins), m_extra(extra) {}

    ComponentMatrixView(CircuitGroup& group, const std::unordered_map<std::string, uint32_t>& pins,
                        uint32_t owner, std::optional<uint32_t> extra = std::nullopt)
        : m_group(group), m_pins(pins), m_extra(extra), m_owner(owner) {
        m_group.beginPendingStamp(owner);
    }

    void commit() {
        if (!m_owner || m_committed) return;
        m_group.commitPendingStamp(*m_owner);
        m_committed = true;
    }

    void addConductance(const Pin& a, const Pin& b, double value) override {
        const uint32_t ia = index(a), ib = index(b);
        addMatrix(ia, ia, value); addMatrix(ib, ib, value);
        addMatrix(ia, ib, -value); addMatrix(ib, ia, -value);
    }
    void addCurrent(const Pin& a, const Pin& b, double value) override {
        addRhs(index(a), -value); addRhs(index(b), value);
    }
    void addConductanceToGround(const Pin& pin, double value) override { addMatrix(index(pin), index(pin), value); }
    void addCurrentToGround(const Pin& pin, double value) override { addRhs(index(pin), value); }
    void addVoltageSource(const Pin& a, const Pin& b, double volts) override {
        if (!m_extra) throw std::runtime_error("fonte de tensao sem variavel extra");
        const uint32_t ia = index(a), ib = index(b), ik = *m_extra;
        addMatrix(ia, ik, 1.0); addMatrix(ib, ik, -1.0);
        addMatrix(ik, ia, 1.0); addMatrix(ik, ib, -1.0);
        setRhs(ik, volts);
    }
    double getNodeVoltage(const Pin& pin) const override { return m_group.valueOf(index(pin)); }
    double getBranchCurrent() const override {
        if (!m_extra) throw std::runtime_error("corrente de ramo sem variavel extra");
        return m_group.valueOf(*m_extra);
    }

private:
    uint32_t index(const Pin& pin) const {
        const auto it = m_pins.find(pin.id);
        if (it == m_pins.end()) throw std::runtime_error("Pin desconhecido nesta view: " + pin.id);
        return it->second;
    }
    void addMatrix(uint32_t row, uint32_t column, double value) {
        if (!m_owner) { m_group.admittance()(row, column) += value; return; }
        m_group.addPendingMatrix(*m_owner, row, column, value);
    }
    void addRhs(uint32_t row, double value) {
        if (!m_owner) { m_group.rhs()(row) += value; return; }
        m_group.addPendingRhs(*m_owner, row, value);
    }
    void setRhs(uint32_t row, double value) {
        if (!m_owner) { m_group.rhs()(row) = value; return; }
        m_group.addPendingRhs(*m_owner, row, value, true);
    }

    CircuitGroup& m_group;
    const std::unordered_map<std::string, uint32_t>& m_pins;
    std::optional<uint32_t> m_extra;
    std::optional<uint32_t> m_owner;
    bool m_committed = false;
};

} // namespace lasecsimul::simulation

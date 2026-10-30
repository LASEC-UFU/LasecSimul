#pragma once
#include <cstdint>
#include <optional>
#include <span>
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
        : m_group(group), m_pins(pins), m_extra(extra), m_owner(owner),
          m_pending(&m_group.beginPendingStamp(owner)) {}

    /** `componentPins` = IComponentModel::pins() do dono e `localIndexByOrdinal` o índice local de
     * cada um, na mesma ordem: um Pin desse array resolve pela posição, sem hash. */
    ComponentMatrixView(CircuitGroup& group, const std::unordered_map<std::string, uint32_t>& pins,
                        uint32_t owner, std::optional<uint32_t> extra, std::span<const Pin> componentPins,
                        const std::vector<uint32_t>& localIndexByOrdinal)
        : ComponentMatrixView(group, pins, owner, extra) {
        if (localIndexByOrdinal.size() == componentPins.size()) {
            m_componentPins = componentPins;
            m_localIndexByOrdinal = localIndexByOrdinal.data();
        }
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
    // Um stamp costuma tocar o mesmo pino várias vezes seguidas (condutância, corrente, tensão): o
    // último pino resolvido evita um hash de string por operação. Compara o id (um Pin temporário
    // pode reaparecer no mesmo endereço com outro id); a chave aponta para o mapa, que não muda
    // durante a view.
    uint32_t index(const Pin& pin) const {
        if (m_localIndexByOrdinal) {
            // Endereço dentro do próprio array de pinos do componente: é aquele pino (nenhum Pin
            // temporário aponta para dentro dele).
            const auto address = reinterpret_cast<std::uintptr_t>(&pin);
            const auto base = reinterpret_cast<std::uintptr_t>(m_componentPins.data());
            if (address >= base && address < base + m_componentPins.size_bytes() && (address - base) % sizeof(Pin) == 0) {
                const uint32_t local = m_localIndexByOrdinal[(address - base) / sizeof(Pin)];
                if (local != UINT32_MAX) return local;
            }
        }
        if (m_lastId && pin.id == *m_lastId) return m_lastIndex;
        const auto it = m_pins.find(pin.id);
        if (it == m_pins.end()) throw std::runtime_error("Pin desconhecido nesta view: " + pin.id);
        m_lastId = &it->first;
        m_lastIndex = it->second;
        return it->second;
    }
    void addMatrix(uint32_t row, uint32_t column, double value) {
        if (!m_pending) { m_group.admittance()(row, column) += value; return; }
        CircuitGroup::addPendingMatrix(*m_pending, row, column, value);
    }
    void addRhs(uint32_t row, double value) {
        if (!m_pending) { m_group.rhs()(row) += value; return; }
        CircuitGroup::addPendingRhs(*m_pending, row, value);
    }
    void setRhs(uint32_t row, double value) {
        if (!m_pending) { m_group.rhs()(row) = value; return; }
        CircuitGroup::addPendingRhs(*m_pending, row, value, true);
    }

    CircuitGroup& m_group;
    const std::unordered_map<std::string, uint32_t>& m_pins;
    std::optional<uint32_t> m_extra;
    std::optional<uint32_t> m_owner;
    CircuitGroup::StampContribution* m_pending = nullptr; // a de m_owner, de beginPendingStamp()
    std::span<const Pin> m_componentPins;
    const uint32_t* m_localIndexByOrdinal = nullptr;
    mutable const std::string* m_lastId = nullptr;
    mutable uint32_t m_lastIndex = 0;
    bool m_committed = false;
};

} // namespace lasecsimul::simulation

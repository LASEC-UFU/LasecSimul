#pragma once

#include <array>
#include "lasecsimul/IComponentModel.hpp"

namespace lasecsimul::components {

/**
 * Referência de 0V. Convenção deliberadamente simples (não elimina linha/coluna como MNA "de
 * livro" faria) — pino fica puxado pra 0V com admitância alta, não literalmente excluído da
 * matriz. Erro residual ~ 1/kGroundConductance, desprezível na prática mas não bit-exato. Ver
 * .spec/archive/legacy-v2/lasecsimul.spec, seção 7.3, pela troca feita e a forma "correta" (eliminação de
 * linha/coluna) deixada como refinamento futuro.
 */
class Ground final : public IComponentModel {
public:
    static constexpr double kGroundConductance = 1e9; // siemens — grande o bastante pra "fixar" 0V

    explicit Ground(Pin pin) : m_pins{std::move(pin)} {}

    const char* typeId() const override { return "other.ground"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView& matrix) override { matrix.addConductanceToGround(m_pins[0], kGroundConductance); }

    void postStep(uint64_t) override {} // puramente algébrico

    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

private:
    std::array<Pin, 1> m_pins;
};

} // namespace lasecsimul::components

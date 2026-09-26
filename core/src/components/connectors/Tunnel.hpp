#pragma once

#include <algorithm>
#include <array>
#include <string>
#include "lasecsimul/IComponentModel.hpp"

namespace lasecsimul::components {

/**
 * Conecta pinos por NOME compartilhado em vez de fio desenhado — equivalente ao `Tunnel` do
 * SimulIDE (`components/connectors/tunnel.{h,cpp}`). Não contribui nada em stamp(): a fusão de nó
 * acontece inteiramente no `Netlist` (passada 1, união por grupo de túnel), nunca aqui.
 *
 * Diferente do SimulIDE (registro estático `Tunnel::m_tunnels`, processo inteiro): o registro de
 * nomes vive no `Netlist` de cada `SimulationSession` — duas sessões nunca compartilham nomes de
 * túnel por acidente (ver .spec/archive/legacy-v2/lasecsimul.spec, seção 7.2).
 *
 * Estrutura inicial: quem chama `SimulationSession::setTunnelName()` ao detectar que a propriedade
 * "name" desta instância mudou é o manipulador de "set property" da camada de IPC/sessão — ainda
 * não construído. Este componente só guarda o valor; não toca o Netlist diretamente (ao contrário
 * do SimulIDE, onde Tunnel manipula o registro estático por conta própria) para não exigir que
 * todo IComponentModel built-in conheça Netlist.
 */
class Tunnel final : public IComponentModel {
public:
    explicit Tunnel(Pin pin) : m_pins{std::move(pin)} {}

    const char* typeId() const override { return "connectors.tunnel"; }
    std::span<Pin> pins() override { return m_pins; }

    void stamp(MnaMatrixView&) override {} // sem contribuição elétrica própria
    void postStep(uint64_t) override {}

    size_t getState(uint8_t* out, size_t cap) const override {
        if (cap < m_name.size()) return 0;
        std::copy(m_name.begin(), m_name.end(), out);
        return m_name.size();
    }
    void setState(const uint8_t* in, size_t len) override { m_name.assign(in, in + len); }

    const std::string& name() const { return m_name; }
    void setNameLocal(std::string name) { m_name = std::move(name); } // não funde nó por si só — ver nota acima

    // Deliberadamente NÃO sobrescreve propertyDescriptors() pra expor "name": renomear um túnel
    // precisa rodar Netlist::setTunnelName() (desune do grupo antigo, marca topologia suja) — o
    // mecanismo genérico de propriedade (SimulationSession::setProperty) só re-stampa o componente,
    // não rebuilda topologia. Quem edita o nome de um túnel chama
    // SimulationSession::setTunnelName() diretamente, nunca o caminho genérico — ver .spec, seção 6.1.

private:
    std::array<Pin, 1> m_pins;
    std::string m_name;
};

} // namespace lasecsimul::components

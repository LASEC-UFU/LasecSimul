// Teste de integração: SimulationSession::removeComponent() deve desconectar um componente do
// circuito sem invalidar os índices das instâncias restantes nem corromper a próxima resolução de
// topologia. Sem framework de teste — assert + código de saída, mesmo padrão de voltage_divider_test.cpp.
#include <array>
#include <cmath>
#include <cstdio>
#include <memory>
#include <optional>
#include "components/connectors/Tunnel.hpp"
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/DcVoltageSource.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;

namespace {

bool nearlyEqual(double a, double b, double eps = 1e-4) { return std::abs(a - b) < eps; }

class TopologySensitiveClamp final : public IComponentModel {
public:
    explicit TopologySensitiveClamp(std::array<Pin, 2> pins, bool clampEnabled)
        : m_pins(std::move(pins)), m_clampEnabled(clampEnabled) {}

    const char* typeId() const override { return "test.topology_sensitive_clamp"; }
    std::span<Pin> pins() override { return m_pins; }
    uint32_t extraVariableCount() const override { return m_clampEnabled ? 1u : 0u; }

    void stamp(MnaMatrixView& matrix) override {
        if (m_clampEnabled) {
            matrix.addVoltageSource(m_pins[0], m_pins[1], 5.0);
        } else {
            matrix.addConductance(m_pins[0], m_pins[1], 1e-9);
        }
    }

    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        PropertySchema schema;
        schema.id = "clampEnabled";
        schema.label = "Clamp enabled";
        schema.group = "Test";
        schema.valueKind = PropertyValueKind::Bool;
        schema.editor = "checkbox";
        schema.defaultValue = false;
        schema.flags = PropertySchemaAffectsTopology;

        PropertyDescriptor descriptor{
            "clampEnabled",
            "",
            [this] { return PropertyValue{m_clampEnabled}; },
            [this](const PropertyValue& value) {
                if (const bool* enabled = std::get_if<bool>(&value)) m_clampEnabled = *enabled;
            },
            schema,
        };
        return {descriptor};
    }

private:
    std::array<Pin, 2> m_pins;
    bool m_clampEnabled = false;
};

void registerTestComponents(ComponentRegistry& components) {
    components.registerFactory("sources.dc_voltage", [](const ComponentParams& params) {
        return std::make_unique<components::DcVoltageSource>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                               params.property("voltage", 10.0));
    });
    components.registerFactory("passive.resistor", [](const ComponentParams& params) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                        params.property("resistance", 1000.0));
    });
    components.registerFactory("other.ground", [](const ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
    components.registerFactory("test.topology_sensitive_clamp", [](const ComponentParams& params) {
        return std::make_unique<TopologySensitiveClamp>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                        params.property("clampEnabled", false));
    });
}

ComponentParams withVoltage(double v) {
    ComponentParams p;
    p.properties["voltage"] = v;
    return p;
}

ComponentParams withResistance(double r) {
    ComponentParams p;
    p.properties["resistance"] = r;
    return p;
}

ComponentParams withClampEnabled(bool enabled) {
    ComponentParams p;
    p.properties["clampEnabled"] = enabled;
    return p;
}

void settle(SimulationSession& session) {
    for (int i = 0; i < 100 && session.settleStep(); ++i) {}
}

} // namespace

int main() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerTestComponents(session.components());

    // Fonte 10V -- R1 1k -- (nó B) -- R2 1k -- Terra, igual ao voltage_divider_test.
    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(10.0));
    const uint32_t r1 = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t r2 = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t ground = session.addComponent("other.ground", {});

    session.connectWire(source, "p1", r1, "p1");
    session.connectWire(r1, "p2", r2, "p1");
    session.connectWire(r2, "p2", source, "p2");
    session.connectWire(source, "p2", ground, "pin");

    settle(session);

    bool ok = true;

    // Remove r2: o nó B fica órfão (só ligado a r1), e o nó GND perde uma referência mas continua
    // valendo porque source/ground ainda estão ligados nele.
    session.removeComponent(r2);

    // addComponent depois de uma remoção não reaproveita o índice removido — confirma a decisão
    // documentada de nunca reciclar índices (ver docs/mvp-limitacoes.md).
    const uint32_t r3 = session.addComponent("passive.resistor", withResistance(2000.0));
    if (r3 == r2) {
        std::fprintf(stderr, "FALHOU: addComponent reciclou o índice %u recém-removido\n", r2);
        ok = false;
    }

    // Religa o circuito sem r2: fonte -- r1 -- terra direto (sem o segundo resistor da malha).
    session.connectWire(r1, "p2", source, "p2");

    // Transação inválida deve restaurar inclusive uma remoção já executada antes da falha.
    bool transactionRejected = false;
    try {
        session.applyWireTopologyTransaction(session.wireTopologyRevision(), {
            {WireTopologyOperation::Kind::Disconnect, {r1, "p2"}, {source, "p2"}},
            {WireTopologyOperation::Kind::Connect, {r1, "pin-inexistente"}, {source, "p2"}},
        });
    } catch (const std::exception&) {
        transactionRejected = true;
    }
    if (!transactionRejected || !session.disconnectWire(r1, "p2", source, "p2")) {
        std::fprintf(stderr, "FALHOU: transacao de fios rejeitada nao restaurou a aresta anterior\n");
        ok = false;
    }
    session.connectWire(r1, "p2", source, "p2");

    settle(session);

    const double voltA = session.nodeVoltageOfPin(source, "p1");
    const double voltGnd = session.nodeVoltageOfPin(ground, "pin");
    std::printf("Após remoção: V_A=%.6f V_GND=%.6f\n", voltA, voltGnd);

    if (!nearlyEqual(voltGnd, 0.0, 1e-3)) {
        std::fprintf(stderr, "FALHOU: V_GND deveria ser ~0V (terra), deu %.6f\n", voltGnd);
        ok = false;
    }
    if (!nearlyEqual(voltA, 10.0)) {
        std::fprintf(stderr, "FALHOU: V_A deveria continuar 10V (fonte ideal), deu %.6f\n", voltA);
        ok = false;
    }

    // Reconectar um fio a um componente já removido deve falhar de forma controlada, não corromper
    // estado nem travar o processo.
    bool threwOnRemovedComponent = false;
    try {
        session.connectWire(r2, "p1", r1, "p1");
    } catch (const std::exception&) {
        threwOnRemovedComponent = true;
    }
    if (!threwOnRemovedComponent) {
        std::fprintf(stderr, "FALHOU: connectWire deveria rejeitar componente removido\n");
        ok = false;
    }

    // setProperty em componente removido deve devolver false (sem crash), não derrubar o processo.
    if (!session.setProperty(r2, "resistance", 500.0).has_value()) {
        std::fprintf(stderr, "FALHOU: setProperty não deveria achar propriedade em componente removido\n");
        ok = false;
    }

    // Remover de novo o mesmo índice é idempotente (não lança, não corrompe nada).
    session.removeComponent(r2);

    // affectsTopology precisa forçar rebuildTopologyIfNeeded no próximo settleStep. O componente
    // de teste muda extraVariableCount() quando a propriedade alterna, então um simples re-stamp
    // sem rebuild deixaria a topologia inconsistente.
    const uint32_t clampSource = session.addComponent("sources.dc_voltage", withVoltage(10.0));
    const uint32_t clampResistor = session.addComponent("passive.resistor", withResistance(1000.0));
    const uint32_t clamp = session.addComponent("test.topology_sensitive_clamp", withClampEnabled(false));
    const uint32_t clampGround = session.addComponent("other.ground", {});

    session.connectWire(clampSource, "p1", clampResistor, "p1");
    session.connectWire(clampResistor, "p2", clamp, "p1");
    session.connectWire(clamp, "p2", clampGround, "pin");
    session.connectWire(clampSource, "p2", clampGround, "pin");

    settle(session);
    const double unclampedVoltage = session.nodeVoltageOfPin(clamp, "p1");
    if (!nearlyEqual(unclampedVoltage, 10.0, 1e-3)) {
        std::fprintf(stderr, "FALHOU: tensao inicial do clamp deveria ser ~10V, deu %.6f\n", unclampedVoltage);
        ok = false;
    }

    const std::optional<std::string> enableClampError = session.setProperty(clamp, "clampEnabled", true);
    if (enableClampError) {
        std::fprintf(stderr, "FALHOU: setProperty(clampEnabled=true) falhou: %s\n", enableClampError->c_str());
        ok = false;
    }

    settle(session);
    const double clampedVoltage = session.nodeVoltageOfPin(clamp, "p1");
    if (!nearlyEqual(clampedVoltage, 5.0, 1e-3)) {
        std::fprintf(stderr, "FALHOU: affectsTopology deveria reconstruir a topologia e prender em ~5V, deu %.6f\n",
                     clampedVoltage);
        ok = false;
    }

    const std::optional<std::string> disableClampError = session.setProperty(clamp, "clampEnabled", false);
    if (disableClampError) {
        std::fprintf(stderr, "FALHOU: setProperty(clampEnabled=false) falhou: %s\n", disableClampError->c_str());
        ok = false;
    }

    settle(session);
    const double restoredVoltage = session.nodeVoltageOfPin(clamp, "p1");
    if (!nearlyEqual(restoredVoltage, 10.0, 1e-3)) {
        std::fprintf(stderr, "FALHOU: desabilitar o clamp deveria voltar a ~10V, deu %.6f\n", restoredVoltage);
        ok = false;
    }

    if (ok) {
        std::printf("OK: remocao de componente nao corrompe topologia, indices restantes nem affectsTopology.\n");
    }
    return ok ? 0 : 1;
}

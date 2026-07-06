// Teste de integração da expansão de subcircuitos (Épico F do roadmap de pendências): registra um
// "subcircuits.divisor_5v" (2 resistores + 3 tunnels VIN/VOUT/GND, exatamente o exemplo de
// .spec/lasecsimul-subcircuits.spec seção 1), expande via addSubcircuitInstance(), conecta uma
// fonte+terra externas aos pinos expostos e valida que o circuito INTERNO resolve corretamente
// através da expansão -- prova que addComponent/connectWire/setTunnelName recursivos produzem o
// mesmo resultado elétrico que montar o divisor à mão (ver voltage_divider_test.cpp).
#include <array>
#include <cmath>
#include <cstdio>
#include <memory>
#include "components/connectors/Tunnel.hpp"
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/DcVoltageSource.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "registry/SubcircuitRegistry.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;

namespace {

bool nearlyEqual(double a, double b, double eps = 1e-4) { return std::abs(a - b) < eps; }

void registerTestComponents(ComponentRegistry& components) {
    components.registerFactory("sources.dc_voltage", [](const ComponentParams& params) {
        return std::make_unique<components::DcVoltageSource>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                               params.property("voltage", 10.0));
    });
    components.registerFactory("passive.resistor", [](const ComponentParams& params) {
        return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"p1"}, Pin{"p2"}},
                                                        params.property("resistance", 1000.0));
    });
    components.registerFactory("connectors.tunnel", [](const ComponentParams&) {
        return std::make_unique<components::Tunnel>(Pin{"pin"});
    });
    components.registerFactory("other.ground", [](const ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
}

SubcircuitDefinition makeDivisor5vDefinition() {
    SubcircuitDefinition def;
    def.typeId = "subcircuits.divisor_5v";
    def.name = "Divisor 5V (R/R)";
    def.components = {
        {"r1", "passive.resistor", R"({"resistance":1000})"},
        {"r2", "passive.resistor", R"({"resistance":1000})"},
        {"tunnel_in", "connectors.tunnel", R"({"name":"VIN"})"},
        {"tunnel_out", "connectors.tunnel", R"({"name":"VOUT"})"},
        {"tunnel_gnd", "connectors.tunnel", R"({"name":"GND"})"},
    };
    def.wires = {
        {"tunnel_in", "pin", "r1", "p1"},
        {"r1", "p2", "r2", "p1"},
        {"r1", "p2", "tunnel_out", "pin"},
        {"r2", "p2", "tunnel_gnd", "pin"},
    };
    def.interfaceDefs = {
        {"VIN", "Entrada", "VIN"},
        {"VOUT", "Saída", "VOUT"},
        {"GND", "Terra", "GND"},
    };
    return def;
}

ComponentParams withVoltage(double v) {
    ComponentParams p;
    p.properties["voltage"] = v;
    return p;
}

void testExpansionAndElectricalBehavior() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerTestComponents(session.components());
    session.subcircuits().registerDefinition(makeDivisor5vDefinition());

    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.divisor_5v");
    if (expansion.exposedPins.size() != 3) {
        std::fprintf(stderr, "FALHOU: esperava 3 pinos expostos (VIN/VOUT/GND), veio %zu\n", expansion.exposedPins.size());
        std::exit(1);
    }

    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(10.0));
    const uint32_t ground = session.addComponent("other.ground", {});

    const auto& vin = expansion.exposedPins.at("VIN");
    const auto& vout = expansion.exposedPins.at("VOUT");
    const auto& gnd = expansion.exposedPins.at("GND");

    session.connectWire(source, "p1", vin.instanceId, vin.pinId);
    session.connectWire(gnd.instanceId, gnd.pinId, source, "p2");
    session.connectWire(gnd.instanceId, gnd.pinId, ground, "pin");

    for (int i = 0; i < 100 && session.settleStep(); ++i) {}

    const double voltIn = session.nodeVoltageOfPin(vin.instanceId, vin.pinId);
    const double voltOut = session.nodeVoltageOfPin(vout.instanceId, vout.pinId);
    const double voltGnd = session.nodeVoltageOfPin(gnd.instanceId, gnd.pinId);
    std::printf("V_VIN=%.6f V_VOUT=%.6f V_GND=%.6f\n", voltIn, voltOut, voltGnd);

    bool ok = true;
    if (!nearlyEqual(voltGnd, 0.0, 1e-3)) {
        std::fprintf(stderr, "FALHOU: V_GND deveria ser ~0V, deu %.6f\n", voltGnd);
        ok = false;
    }
    if (!nearlyEqual(voltIn, 10.0)) {
        std::fprintf(stderr, "FALHOU: V_VIN deveria ser 10V, deu %.6f\n", voltIn);
        ok = false;
    }
    if (!nearlyEqual(voltOut, 5.0)) {
        std::fprintf(stderr, "FALHOU: V_VOUT deveria ser 5V (divisor 1:1 dentro do subcircuito), deu %.6f\n", voltOut);
        ok = false;
    }
    if (!ok) std::exit(1);
    std::printf("OK: subcircuito expandido resolve eletricamente igual ao divisor montado à mão.\n");
}

void testTwoInstancesDontCollideOnTunnelNames() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerTestComponents(session.components());
    session.subcircuits().registerDefinition(makeDivisor5vDefinition());

    const SubcircuitExpansionResult first = session.addSubcircuitInstance("subcircuits.divisor_5v");
    const SubcircuitExpansionResult second = session.addSubcircuitInstance("subcircuits.divisor_5v");

    if (first.subcircuitInstanceId == second.subcircuitInstanceId) {
        std::fprintf(stderr, "FALHOU: duas instâncias do mesmo subcircuito geraram o mesmo subcircuitInstanceId\n");
        std::exit(1);
    }
    // Túneis internos com o mesmo nome ("VIN" etc.) em instâncias diferentes não podem ter se
    // fundido no mesmo nó -- cada instância tem seu próprio resistor 1kΩ "r1"; ligar uma fonte só
    // na primeira instância não deveria mover a tensão da segunda (que fica em 0V, sem fonte).
    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(10.0));
    const uint32_t ground = session.addComponent("other.ground", {});
    const auto& firstVin = first.exposedPins.at("VIN");
    const auto& firstGnd = first.exposedPins.at("GND");
    session.connectWire(source, "p1", firstVin.instanceId, firstVin.pinId);
    session.connectWire(firstGnd.instanceId, firstGnd.pinId, source, "p2");
    session.connectWire(firstGnd.instanceId, firstGnd.pinId, ground, "pin");

    for (int i = 0; i < 100 && session.settleStep(); ++i) {}

    const auto& secondVin = second.exposedPins.at("VIN");
    const double secondVinVoltage = session.nodeVoltageOfPin(secondVin.instanceId, secondVin.pinId);
    if (!nearlyEqual(secondVinVoltage, 0.0, 1e-3)) {
        std::fprintf(stderr,
                     "FALHOU: segunda instância (sem fonte) deveria continuar em 0V, deu %.6f -- "
                     "túneis internos colidiram entre instâncias\n",
                     secondVinVoltage);
        std::exit(1);
    }
    std::printf("OK: duas instâncias do mesmo subcircuito não colidem (túneis prefixados por instância).\n");
}

void testCascadeRemovalDeletesAllInternalComponents() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerTestComponents(session.components());
    session.subcircuits().registerDefinition(makeDivisor5vDefinition());

    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.divisor_5v");
    if (!session.isSubcircuitInstance(expansion.subcircuitInstanceId)) {
        std::fprintf(stderr, "FALHOU: isSubcircuitInstance deveria reconhecer o id devolvido por addSubcircuitInstance\n");
        std::exit(1);
    }

    const auto& vout = expansion.exposedPins.at("VOUT");
    const uint32_t tunnelOutIndex = vout.instanceId; // componentIndex real do Tunnel interno

    session.removeSubcircuitInstance(expansion.subcircuitInstanceId);

    if (session.isSubcircuitInstance(expansion.subcircuitInstanceId)) {
        std::fprintf(stderr, "FALHOU: subcircuitInstanceId deveria deixar de existir após a remoção\n");
        std::exit(1);
    }
    bool threw = false;
    try {
        session.connectWire(tunnelOutIndex, "pin", tunnelOutIndex, "pin");
    } catch (const std::exception&) {
        threw = true;
    }
    if (!threw) {
        std::fprintf(stderr, "FALHOU: componente interno (Tunnel) deveria estar removido depois da cascata\n");
        std::exit(1);
    }
    std::printf("OK: removeSubcircuitInstance remove em cascata todos os componentes internos.\n");
}

void testCycleDetection() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerTestComponents(session.components());

    // A contém B, B contém A -- ciclo direto (o caso mais simples; profundidade arbitrária usa a
    // mesma pilha de expansão, ver SimulationSession::expandSubcircuit).
    SubcircuitDefinition a;
    a.typeId = "subcircuits.a";
    a.components = {{"inner", "subcircuits.b", "{}"}};
    SubcircuitDefinition b;
    b.typeId = "subcircuits.b";
    b.components = {{"inner", "subcircuits.a", "{}"}};
    session.subcircuits().registerDefinition(std::move(a));
    session.subcircuits().registerDefinition(std::move(b));

    bool threw = false;
    try {
        session.addSubcircuitInstance("subcircuits.a");
    } catch (const std::exception& e) {
        threw = true;
        std::printf("[info] erro esperado: %s\n", e.what());
    }
    if (!threw) {
        std::fprintf(stderr, "FALHOU: ciclo A->B->A deveria lançar, não silenciosamente recursar pra sempre\n");
        std::exit(1);
    }
    std::printf("OK: ciclo de dependência entre subcircuitos é detectado e rejeitado.\n");
}

/** Prova `findSubcircuitChildByLocalId()` (2026-06-29, suporte ao overlay de Modo Placa da
 * Extension -- ver `CoreApplication.cpp::"setSubcircuitChildProperty"`): resolve um id LOCAL do
 * `.lssubcircuit` (ex: "r1") pro índice real do Core, em duas instâncias INDEPENDENTES (não pode
 * colidir, mesmo princípio do teste de túneis acima), confirma que editar a propriedade resolvida
 * tem efeito elétrico real (muda a tensão de saída do divisor), e que IDs inválidos/instância
 * removida devolvem `std::nullopt` em vez de um índice qualquer. */
void testFindSubcircuitChildByLocalId() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerTestComponents(session.components());
    session.subcircuits().registerDefinition(makeDivisor5vDefinition());

    const SubcircuitExpansionResult first = session.addSubcircuitInstance("subcircuits.divisor_5v");
    const SubcircuitExpansionResult second = session.addSubcircuitInstance("subcircuits.divisor_5v");

    const std::optional<uint32_t> firstR1 = session.findSubcircuitChildByLocalId(first.subcircuitInstanceId, "r1");
    const std::optional<uint32_t> secondR1 = session.findSubcircuitChildByLocalId(second.subcircuitInstanceId, "r1");
    if (!firstR1 || !secondR1) {
        std::fprintf(stderr, "FALHOU: findSubcircuitChildByLocalId deveria achar 'r1' nas duas instâncias\n");
        std::exit(1);
    }
    if (*firstR1 == *secondR1) {
        std::fprintf(stderr, "FALHOU: 'r1' de instâncias diferentes resolveu pro MESMO índice Core (colisão)\n");
        std::exit(1);
    }

    if (session.findSubcircuitChildByLocalId(first.subcircuitInstanceId, "id_que_nao_existe")) {
        std::fprintf(stderr, "FALHOU: id local inexistente deveria devolver std::nullopt\n");
        std::exit(1);
    }

    // Editar r1 (1k -> 3k) por índice resolvido tem efeito elétrico real: divisor deixa de ser 1:1.
    const uint32_t source = session.addComponent("sources.dc_voltage", withVoltage(10.0));
    const uint32_t ground = session.addComponent("other.ground", {});
    const auto& vin = first.exposedPins.at("VIN");
    const auto& vout = first.exposedPins.at("VOUT");
    const auto& gnd = first.exposedPins.at("GND");
    session.connectWire(source, "p1", vin.instanceId, vin.pinId);
    session.connectWire(gnd.instanceId, gnd.pinId, source, "p2");
    session.connectWire(gnd.instanceId, gnd.pinId, ground, "pin");

    const std::optional<std::string> error = session.setProperty(*firstR1, "resistance", PropertyValue{3000.0});
    if (error) {
        std::fprintf(stderr, "FALHOU: setProperty via índice resolvido devolveu erro: %s\n", error->c_str());
        std::exit(1);
    }
    for (int i = 0; i < 100 && session.settleStep(); ++i) {}

    // R1=3k, R2=1k: Vout = Vin * R2/(R1+R2) = 10 * 1/4 = 2.5V (era 5V com R1=R2=1k).
    const double voltOut = session.nodeVoltageOfPin(vout.instanceId, vout.pinId);
    if (!nearlyEqual(voltOut, 2.5, 1e-2)) {
        std::fprintf(stderr, "FALHOU: apos mudar r1 pra 3k via id local, Vout deveria ser 2.5V, deu %.6f\n", voltOut);
        std::exit(1);
    }

    session.removeSubcircuitInstance(first.subcircuitInstanceId);
    if (session.findSubcircuitChildByLocalId(first.subcircuitInstanceId, "r1")) {
        std::fprintf(stderr, "FALHOU: apos remover a instancia, 'r1' nao deveria mais resolver\n");
        std::exit(1);
    }
    std::printf("OK: findSubcircuitChildByLocalId resolve por id local, sem colisao entre instancias, com efeito eletrico real, e expira na remocao.\n");
}

} // namespace

int main() {
    testExpansionAndElectricalBehavior();
    testTwoInstancesDontCollideOnTunnelNames();
    testCascadeRemovalDeletesAllInternalComponents();
    testCycleDetection();
    testFindSubcircuitChildByLocalId();
    std::printf("\nTodos os testes de subcircuito passaram.\n");
    return 0;
}

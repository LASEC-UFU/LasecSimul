// `connectors.tunnel` agora serve os DOIS domínios (elétrico e Signal Graph) pela MESMA instância
// visual -- pedido do usuário: "quero apenas um túnel... funciona igual a saída 4-20mA dos
// transmissores HART, que tem duas funções: pro usuário é o mesmo equipamento, mas pro Core são
// dois". Este teste prova: (1) uso elétrico continua funcionando exatamente como antes; (2) uso
// como sinal funciona ligado a um bloco control.*; (3) o domínio é decidido pelo que está do outro
// lado do fio; (4) misturar domínios na MESMA instância é rejeitado; (5) misturar domínios entre
// duas instâncias com o MESMO `name` também é rejeitado; (6) dois túneis-túnel sem domínio ainda
// decidido seguem a convenção antiga (elétrico).
#include <cmath>
#include <cstdio>
#include <memory>

#include "components/connectors/Tunnel.hpp"
#include "components/control/SignalMathBlock.hpp"
#include "components/passive/Resistor.hpp"
#include "components/other/Ground.hpp"
#include "components/sources/FixedVolt.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;
using namespace lasecsimul::simulation;

namespace {

int failures = 0;
void check(bool ok, const char* label) {
    if (ok) std::printf("OK: %s\n", label);
    else { std::fprintf(stderr, "FALHOU: %s\n", label); ++failures; }
}

void registerFactories(SimulationSession& session) {
    session.components().registerFactory("connectors.tunnel", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Tunnel>(Pin{pos[0].id.empty() ? "pin" : pos[0].id, pos[0].x, pos[0].y});
    });
    session.components().registerFactory("other.ground", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Ground>(Pin{pos[0].id.empty() ? "pin" : pos[0].id, pos[0].x, pos[0].y});
    });
    session.components().registerFactory("sources.fixed_volt", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::FixedVolt>(Pin{pos[0].id.empty() ? "pin" : pos[0].id, pos[0].x, pos[0].y}, 5.0, true);
    });
    session.components().registerFactory("passive.resistor", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        return std::make_unique<components::Resistor>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            1000.0);
    });
    for (const std::string_view mathTypeId : components::SignalMathBlock::signalMathTypeIds()) {
        const std::string typeId(mathTypeId);
        session.components().registerFactory(typeId, [typeId](const ComponentParams& p) {
            return std::make_unique<components::SignalMathBlock>(typeId, p);
        });
    }
}

// `Tunnel` deliberadamente não expõe "name" via `propertyDescriptors()` (ver Tunnel.hpp): quem
// aplica o nome é sempre `SimulationSession::setTunnelName`, nunca `ComponentParams::properties`
// genérico -- mesmo contrato que a Extension usa (`coreLifecycle.ts::setTunnelName`).
uint32_t addTunnel(SimulationSession& session, const std::string& name = "") {
    const uint32_t instance = session.addComponent("connectors.tunnel", {});
    if (!name.empty()) session.setTunnelName(instance, "pin", "", name);
    return instance;
}

// (1) Uso 100% elétrico continua idêntico ao túnel de sempre: fonte -> resistor -> túnel "gnd" ->
// terra, sem nenhum envolvimento do Signal Graph.
void electricalUsageUnaffected() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t source = session.addComponent("sources.fixed_volt", {});
    const uint32_t resistor = session.addComponent("passive.resistor", {});
    const uint32_t tunnelA = addTunnel(session, "gnd");
    const uint32_t tunnelB = addTunnel(session, "gnd");
    const uint32_t ground = session.addComponent("other.ground", {});

    session.connectWire(source, "pin", resistor, "p1");
    session.connectWire(resistor, "p2", tunnelA, "pin");
    session.connectWire(tunnelB, "pin", ground, "pin"); // junta com tunnelA só pelo NOME "gnd"

    const auto plan = session.simulationPlan();
    check(plan != nullptr, "(1) circuito 100% elétrico com túnel dual-domínio compila igual antes");
}

// (2)+(3) Uso como sinal: túnel ligado a um control.gain -- o domínio é decidido pelo bloco do
// outro lado (que não tem nenhum pino elétrico).
void signalUsageResolvesFromPeer() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    ComponentParams gainParams;
    gainParams.properties["gain"] = 2.0;
    gainParams.properties["samplePeriodNs"] = 10'000'000.0;
    const uint32_t gain = session.addComponent("control.gain", gainParams);
    const uint32_t tunnelIn = addTunnel(session, "nivel_pv");

    session.connectWire(tunnelIn, "pin", gain, "in");

    const auto plan = session.simulationPlan();
    check(plan != nullptr && plan->signal && plan->signal->engine,
          "(2) túnel ligado a um bloco de controle resolve como sinal e compila o Signal Plan");
}

// (4) A MESMA instância não pode virar elétrica numa ponta e sinal na outra.
void sameInstanceMixedDomainRejected() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t resistor = session.addComponent("passive.resistor", {});
    const uint32_t tunnel = addTunnel(session, "misto");
    session.connectWire(tunnel, "pin", resistor, "p1"); // compromete "misto" como ELÉTRICO

    ComponentParams gainParams;
    gainParams.properties["samplePeriodNs"] = 10'000'000.0;
    const uint32_t gain = session.addComponent("control.gain", gainParams);

    bool rejected = false;
    try { session.connectWire(tunnel, "pin", gain, "in"); }
    catch (const std::invalid_argument&) { rejected = true; }
    check(rejected, "(4) mesma instância de túnel não pode ser elétrica numa ponta e sinal na outra");

    const auto plan = session.simulationPlan();
    check(plan != nullptr, "(4) sessão continua consistente depois da rejeição (nenhuma mutação parcial)");
}

// (5) DUAS instâncias com o MESMO name (a identidade que importa pro usuário) não podem divergir
// de domínio entre si, mesmo sem nenhum fio direto entre as duas.
void sameNameAcrossInstancesMixedDomainRejected() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t resistor = session.addComponent("passive.resistor", {});
    const uint32_t tunnelElectrical = addTunnel(session, "compartilhado");
    session.connectWire(tunnelElectrical, "pin", resistor, "p1"); // "compartilhado" -> elétrico

    ComponentParams gainParams;
    gainParams.properties["samplePeriodNs"] = 10'000'000.0;
    const uint32_t gain = session.addComponent("control.gain", gainParams);
    const uint32_t tunnelSignal = addTunnel(session, "compartilhado"); // OUTRA instância, mesmo name

    bool rejected = false;
    try { session.connectWire(tunnelSignal, "pin", gain, "in"); }
    catch (const std::invalid_argument&) { rejected = true; }
    check(rejected, "(5) outro túnel com o MESMO name não pode comprometer o domínio oposto");
}

// (6) Dois túneis flexíveis ligados entre si, nenhum ainda comprometido: convenção antiga
// (elétrico) preservada -- nunca quebra autoria publicada que já conta com isso.
void twoUncommittedTunnelsDefaultToElectrical() {
    GlobalPluginCache cache;
    SimulationSession session(cache);
    registerFactories(session);

    const uint32_t tunnelA = addTunnel(session, "a");
    const uint32_t tunnelB = addTunnel(session, "b");
    session.connectWire(tunnelA, "pin", tunnelB, "pin");

    const uint32_t source = session.addComponent("sources.fixed_volt", {});
    const uint32_t resistor = session.addComponent("passive.resistor", {});
    session.connectWire(source, "pin", tunnelA, "pin");
    session.connectWire(tunnelB, "pin", resistor, "p1");

    const auto plan = session.simulationPlan();
    check(plan != nullptr, "(6) dois túneis flexíveis ligados entre si, sem sinal envolvido, seguem elétrico por padrão");
}

} // namespace

int main() {
    try {
        electricalUsageUnaffected();
        signalUsageResolvesFromPeer();
        sameInstanceMixedDomainRejected();
        sameNameAcrossInstancesMixedDomainRejected();
        twoUncommittedTunnelsDefaultToElectrical();
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "EXCECAO NAO TRATADA: %s\n", ex.what());
        return 2;
    }
    if (failures == 0) std::puts("DualDomainTunnelTest: OK");
    return failures == 0 ? 0 : 1;
}

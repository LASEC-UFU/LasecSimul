#include <cstdio>
#include <cstdint>
#include <exception>
#include <initializer_list>
#include <stdexcept>
#include <vector>
#include "simulation/Netlist.hpp"

using lasecsimul::simulation::Netlist;
using lasecsimul::simulation::Topology;

namespace {

bool expect(bool condition, const char* message) {
    if (!condition) std::fprintf(stderr, "FAILED: %s\n", message);
    return condition;
}

bool expectThrowsOutOfRange(void (*fn)(), const char* message) {
    try {
        fn();
    } catch (const std::out_of_range&) {
        return true;
    } catch (...) {
        std::fprintf(stderr, "FAILED: %s threw the wrong exception\n", message);
        return false;
    }
    std::fprintf(stderr, "FAILED: %s did not throw\n", message);
    return false;
}

bool expectThrowsInvalidArgument(void (*fn)(), const char* message) {
    try {
        fn();
    } catch (const std::invalid_argument&) {
        return true;
    } catch (...) {
        std::fprintf(stderr, "FAILED: %s threw the wrong exception\n", message);
        return false;
    }
    std::fprintf(stderr, "FAILED: %s did not throw\n", message);
    return false;
}

bool vectorEquals(const std::vector<uint32_t>& actual, std::initializer_list<uint32_t> expected) {
    return actual == std::vector<uint32_t>(expected);
}

} // namespace

int main() {
    bool ok = true;

    {
        Netlist netlist;
        const Topology topology = netlist.rebuildTopology();
        ok &= expect(topology.groups.empty(), "empty circuit should have no groups");
        ok &= expect(topology.slotToNode.empty(), "empty circuit should have no node mapping");
        ok &= expect(topology.listenersByNode.empty(), "empty circuit should have no listeners");
    }

    {
        Netlist netlist;
        const auto a = netlist.registerComponent(0, {"pin"});
        const auto b = netlist.registerComponent(1, {"pin"});
        const Topology topology = netlist.rebuildTopology();
        ok &= expect(a.at("pin") == 0 && b.at("pin") == 1, "pin slots should be dense per rebuild input");
        ok &= expect(vectorEquals(topology.slotToNode, {0, 1}), "disconnected pins should map to dense nodes");
        ok &= expect(topology.groups.size() == 2, "two one-pin disconnected components should form two groups");
        ok &= expect(vectorEquals(topology.listenersByNode[0], {0}), "first node should listen to component 0");
        ok &= expect(vectorEquals(topology.listenersByNode[1], {1}), "second node should listen to component 1");
    }

    {
        ok &= expectThrowsOutOfRange(
            [] {
                Netlist netlist;
                netlist.connectWire(0, 1);
            },
            "connectWire should reject invalid slots");
        ok &= expectThrowsOutOfRange(
            [] {
                Netlist netlist;
                netlist.setTunnelName(0, "", "BUS");
            },
            "setTunnelName should reject invalid slots");
        ok &= expectThrowsInvalidArgument(
            [] {
                Netlist netlist;
                netlist.registerComponent(1, {"pin"});
            },
            "registerComponent should require dense component ids");
        ok &= expectThrowsInvalidArgument(
            [] {
                Netlist netlist;
                netlist.registerComponent(0, {"a", "a"});
            },
            "registerComponent should reject duplicate pin ids");
    }

    {
        Netlist netlist;
        const auto resistor = netlist.registerComponent(0, {"p1", "p2"});
        const Topology topology = netlist.rebuildTopology();
        ok &= expect(vectorEquals(topology.slotToNode, {0, 1}), "simple resistor pins should be separate nodes");
        ok &= expect(topology.groups.size() == 1, "a two-pin component should create one galvanic group");
        ok &= expect(topology.groups[0].nodeIndices().size() == 2, "resistor group should contain both nodes");
        ok &= expect(topology.resolutionBySlot[resistor.at("p1")].groupIndex == 0, "p1 should resolve to group 0");
        ok &= expect(topology.resolutionBySlot[resistor.at("p2")].groupIndex == 0, "p2 should resolve to group 0");
    }

    {
        Netlist netlist;
        const auto a = netlist.registerComponent(0, {"pin"});
        const auto b = netlist.registerComponent(1, {"pin"});
        netlist.setTunnelName(a.at("pin"), "", "BUS");
        netlist.setTunnelName(b.at("pin"), "", "BUS");
        netlist.setTunnelName(b.at("pin"), "BUS", "BUS"); // no duplicate tunnel membership
        Topology topology = netlist.rebuildTopology();
        ok &= expect(vectorEquals(topology.slotToNode, {0, 0}), "same-name tunnels should share a node");
        ok &= expect(vectorEquals(topology.listenersByNode[0], {0, 1}), "tunnel listeners should be unique");

        netlist.setTunnelName(b.at("pin"), "BUS", "OTHER");
        topology = netlist.rebuildTopology();
        ok &= expect(vectorEquals(topology.slotToNode, {0, 1}), "renaming a tunnel should split old topology");

        Netlist otherSession;
        otherSession.registerComponent(0, {"pin"});
        otherSession.setTunnelName(0, "", "BUS");
        const Topology otherTopology = otherSession.rebuildTopology();
        ok &= expect(vectorEquals(otherTopology.slotToNode, {0}), "tunnel names should be local to each Netlist");
    }

    {
        Netlist netlist;
        const auto tunnel = netlist.registerComponent(0, {"pin"});
        const auto instrument = netlist.registerComponent(1, {"ch0"});
        const auto physicalSource = netlist.registerComponent(2, {"out"});
        netlist.setTunnelName(tunnel.at("pin"), "", "SIGNAL");
        netlist.setFallbackTunnelName(instrument.at("ch0"), "SIGNAL");

        Topology topology = netlist.rebuildTopology();
        ok &= expect(topology.slotToNode[tunnel.at("pin")] == topology.slotToNode[instrument.at("ch0")],
                     "instrument fallback should observe a real tunnel with the same name");

        netlist.connectWire(instrument.at("ch0"), physicalSource.at("out"));
        topology = netlist.rebuildTopology();
        ok &= expect(topology.slotToNode[instrument.at("ch0")] == topology.slotToNode[physicalSource.at("out")],
                     "physical wire should connect the instrument channel");
        ok &= expect(topology.slotToNode[instrument.at("ch0")] != topology.slotToNode[tunnel.at("pin")],
                     "physical wire should take precedence over the typed tunnel name");

        netlist.disconnectWire(instrument.at("ch0"), physicalSource.at("out"));
        topology = netlist.rebuildTopology();
        ok &= expect(topology.slotToNode[tunnel.at("pin")] == topology.slotToNode[instrument.at("ch0")],
                     "removing the physical wire should reactivate the tunnel fallback");

        Netlist noRealTunnel;
        const auto loneInstrument = noRealTunnel.registerComponent(0, {"ch0"});
        noRealTunnel.setFallbackTunnelName(loneInstrument.at("ch0"), "MISSING");
        ok &= expect(!noRealTunnel.isPinExternallyConnected(0, "ch0"),
                     "typed name without a real Tunnel must remain disconnected like Tunnel::getEnode");
    }

    {
        Netlist netlist;
        const auto a = netlist.registerComponent(0, {"p1", "p2"});
        const auto b = netlist.registerComponent(1, {"p1", "p2"});
        Topology topology = netlist.rebuildTopology();
        ok &= expect(topology.groups.size() == 2, "two disconnected two-pin components should form two groups");

        netlist.connectWire(a.at("p2"), b.at("p1"));
        topology = netlist.rebuildTopology();
        ok &= expect(vectorEquals(topology.slotToNode, {0, 1, 1, 2}),
                     "wire should merge only the connected endpoints into one node");
        ok &= expect(topology.groups.size() == 1, "wired components should form one connected group");
        ok &= expect(topology.groups[0].nodeIndices().size() == 3, "connected group should contain three nodes");
    }

    {
        Netlist netlist;
        const auto component = netlist.registerComponent(0, {"p1", "p2"});
        netlist.connectWire(component.at("p1"), component.at("p2"));
        const Topology topology = netlist.rebuildTopology();
        ok &= expect(vectorEquals(topology.slotToNode, {0, 0}), "self-connected pins should share a node");
        ok &= expect(vectorEquals(topology.listenersByNode[0], {0}),
                     "component should appear only once in listeners for a shared node");
    }

    // EX-6.1/EX-6.2: disconnectWire is the inverse of connectWire -- removing just one wire without
    // touching any other component, so the Extension can drop a wire without rebuilding the whole
    // circuit (see SimulationSession::disconnectWire / IPC "disconnectWire" in CoreApplication.cpp).
    {
        Netlist netlist;
        const auto a = netlist.registerComponent(0, {"p1", "p2"});
        const auto b = netlist.registerComponent(1, {"p1", "p2"});
        netlist.connectWire(a.at("p2"), b.at("p1"));
        const bool removed = netlist.disconnectWire(a.at("p2"), b.at("p1"));
        ok &= expect(removed, "disconnectWire should report true for an existing edge");
        const Topology topology = netlist.rebuildTopology();
        ok &= expect(topology.groups.size() == 2, "removing the only wire should split the group back in two");
    }

    {
        Netlist netlist;
        const auto a = netlist.registerComponent(0, {"p1", "p2"});
        const auto b = netlist.registerComponent(1, {"p1", "p2"});
        netlist.connectWire(a.at("p2"), b.at("p1"));
        // Order of endpoints should not matter -- same as an undirected edge.
        const bool removed = netlist.disconnectWire(b.at("p1"), a.at("p2"));
        ok &= expect(removed, "disconnectWire should match the edge regardless of endpoint order");
    }

    {
        Netlist netlist;
        const auto a = netlist.registerComponent(0, {"p1", "p2"});
        const auto b = netlist.registerComponent(1, {"p1", "p2"});
        const bool removed = netlist.disconnectWire(a.at("p1"), b.at("p1"));
        ok &= expect(!removed, "disconnectWire should report false when no such edge exists (idempotent)");
    }

    // Diferencial determinístico: a cada mutação, compara o oracle com uma Netlist nova que
    // reconstrói independentemente o mesmo conjunto de arestas.
    {
        constexpr uint32_t count = 30;
        Netlist edited;
        for (uint32_t i = 0; i < count; ++i) edited.registerComponent(i, {"pin"});
        std::vector<std::pair<uint32_t, uint32_t>> edges;
        uint32_t randomState = 0x51a7c3u;
        const auto nextRandom = [&]() { randomState = randomState * 1664525u + 1013904223u; return randomState; };
        for (uint32_t step = 0; step < 250; ++step) {
            uint32_t a = nextRandom() % count;
            uint32_t b = nextRandom() % count;
            if (a == b) b = (b + 1) % count;
            if ((nextRandom() & 1u) != 0 || edges.empty()) {
                edited.connectWire(a, b);
                edges.emplace_back(a, b);
            } else {
                const size_t index = nextRandom() % edges.size();
                const auto edge = edges[index];
                ok &= expect(edited.disconnectWire(edge.first, edge.second),
                             "differential setup should remove an existing edge");
                edges.erase(edges.begin() + static_cast<std::ptrdiff_t>(index));
            }
            const Topology actual = edited.rebuildTopology();
            Netlist reference;
            for (uint32_t i = 0; i < count; ++i) reference.registerComponent(i, {"pin"});
            for (const auto& edge : edges) reference.connectWire(edge.first, edge.second);
            const Topology expected = reference.rebuildTopology();
            for (uint32_t left = 0; left < count; ++left) for (uint32_t right = 0; right < count; ++right) {
                const bool actualConnected = actual.slotToNode[left] == actual.slotToNode[right];
                const bool expectedConnected = expected.slotToNode[left] == expected.slotToNode[right];
                if (actualConnected != expectedConnected) {
                    ok &= expect(false, "edited connectivity must match an independent full rebuild after every random edit");
                    left = count; break;
                }
            }
        }
    }

    // reregisterComponentPins (pino dinâmico, ex: switches.keypad rows/columns) -- crescer contagem.
    {
        Netlist netlist;
        netlist.registerComponent(0, {"pin-1", "pin-2"});
        netlist.reregisterComponentPins(0, {"pin-1", "pin-2", "pin-3", "pin-4"});
        const auto& slots = netlist.pinSlotsOf(0);
        ok &= expect(slots.size() == 4, "reregister should reflect the new pin count");
        ok &= expect(slots.find("pin-3") != slots.end() && slots.find("pin-4") != slots.end(),
                     "reregister should add the new pin ids");
        const Topology topology = netlist.rebuildTopology();
        // Não checa `topology.groups.size()` no total: os 2 slots ANTIGOS (órfãos desde o
        // reregister) ainda formam seus próprios grupos-fantasma de 1 nó cada -- mesmo
        // comportamento, já pré-existente, de um `removeComponent()` (nenhum dos dois "limpa" o
        // grupo, só o esvazia de qualquer fiação/listener real; `CircuitGroup::singular()` já trata
        // um grupo de 1 nó sem estampa como inerte, sem risco). O que importa é achar o grupo REAL
        // (via um pino que ainda existe) e conferir que ele tem os 4 pinos atuais, nada a mais.
        const uint32_t liveGroup = topology.resolutionBySlot[slots.at("pin-1")].groupIndex;
        ok &= expect(topology.groups[liveGroup].nodeIndices().size() == 4,
                     "the component's live group should contain exactly its 4 current pins");
    }

    // reregisterComponentPins -- encolher contagem com um fio ligado ao pino que some: o fio some
    // junto (órfão), nunca sobrevive apontando pra um slot morto.
    {
        Netlist netlist;
        const auto a = netlist.registerComponent(0, {"pin-1", "pin-2", "pin-3"});
        const auto b = netlist.registerComponent(1, {"p1"});
        netlist.connectWire(a.at("pin-3"), b.at("p1")); // liga o pino que vai sumir no reregister
        netlist.reregisterComponentPins(0, {"pin-1", "pin-2"});
        const Topology topology = netlist.rebuildTopology();
        ok &= expect(netlist.pinSlotsOf(0).size() == 2, "pinSlotsOf should only report the surviving pins");
        // Grupo do componente 0 (2 pinos sobreviventes, nunca ligados entre si) precisa ser
        // DIFERENTE do grupo do componente 1 -- prova que o fio que tocava o pino removido não
        // sobrevive (senão os dois ainda estariam no mesmo grupo). Não checa `groups.size()` total
        // pelo mesmo motivo do bloco acima (slot órfão vira grupo-fantasma de 1 nó, inofensivo).
        const auto& survivingSlots = netlist.pinSlotsOf(0);
        const uint32_t groupOfComponent0 = topology.resolutionBySlot[survivingSlots.at("pin-1")].groupIndex;
        const uint32_t groupOfComponent1 = topology.resolutionBySlot[b.at("p1")].groupIndex;
        ok &= expect(groupOfComponent0 != groupOfComponent1,
                     "shrinking pins should silently drop the wire touching the removed pin, splitting the groups back");
        ok &= expect(topology.groups[groupOfComponent0].nodeIndices().size() == 2,
                     "component 0's surviving pins (unconnected to each other) should form a 2-node group");
    }

    // reregisterComponentPins -- slot órfão nunca reaparece em listener/pinRef mesmo o dono vivo.
    {
        Netlist netlist;
        const auto a = netlist.registerComponent(0, {"pin-1", "pin-2"});
        netlist.reregisterComponentPins(0, {"pin-1"}); // pin-2 vira órfão
        const Topology topology = netlist.rebuildTopology();
        size_t totalListeners = 0;
        for (const auto& listeners : topology.listenersByNode) totalListeners += listeners.size();
        ok &= expect(totalListeners == 1, "orphaned slot must never appear as a topology listener");
        size_t totalPinRefs = 0;
        for (const auto& refs : topology.pinRefsByNode) totalPinRefs += refs.size();
        ok &= expect(totalPinRefs == 1, "orphaned slot must never appear in pinRefsByNode");
        ok &= expect(netlist.pinSlotsOf(0).find("pin-2") == netlist.pinSlotsOf(0).end(),
                     "pinSlotsOf must not expose the orphaned pin id anymore");
        (void)a;
    }

    ok &= expectThrowsOutOfRange(
        [] {
            Netlist netlist;
            netlist.reregisterComponentPins(0, {"pin-1"});
        },
        "reregisterComponentPins should reject an unknown component index");
    ok &= expectThrowsInvalidArgument(
        [] {
            Netlist netlist;
            netlist.registerComponent(0, {"pin-1"});
            netlist.removeComponent(0);
            netlist.reregisterComponentPins(0, {"pin-1"});
        },
        "reregisterComponentPins should reject a removed component");
    ok &= expectThrowsInvalidArgument(
        [] {
            Netlist netlist;
            netlist.registerComponent(0, {"pin-1"});
            netlist.reregisterComponentPins(0, {"a", "a"});
        },
        "reregisterComponentPins should reject duplicate pin ids, same as registerComponent");


    if (ok) std::printf("OK: Netlist topology cases passed.\n");
    return ok ? 0 : 1;
}

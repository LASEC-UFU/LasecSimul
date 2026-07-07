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

    if (ok) std::printf("OK: Netlist topology cases passed.\n");
    return ok ? 0 : 1;
}

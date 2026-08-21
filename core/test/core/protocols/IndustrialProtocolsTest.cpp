#include "protocols/IndustrialProtocols.hpp"
#include "protocols/IndustrialProtocolComponents.hpp"

#include <cstdio>
#include <unordered_map>

using namespace lasecsimul::protocols;

namespace {
int failures = 0;
#define CHECK(condition, message) do { if (!(condition)) { std::fprintf(stderr, "FAIL: %s\n", message); ++failures; } } while (false)

class TestMatrix final : public lasecsimul::MnaMatrixView {
public:
    void addConductance(const lasecsimul::Pin&, const lasecsimul::Pin&, double) override {}
    void addCurrent(const lasecsimul::Pin&, const lasecsimul::Pin&, double) override {}
    void addVoltageSource(const lasecsimul::Pin&, const lasecsimul::Pin&, double volts) override { drivenVoltage = volts; }
    void addConductanceToGround(const lasecsimul::Pin&, double) override {}
    void addCurrentToGround(const lasecsimul::Pin&, double) override {}
    double getNodeVoltage(const lasecsimul::Pin& pin) const override {
        const auto found = voltages.find(pin.id); return found == voltages.end() ? 0.0 : found->second;
    }
    double getBranchCurrent() const override { return 0.0; }
    std::unordered_map<std::string, double> voltages;
    double drivenVoltage = 0.0;
};

void modbusWorksWithoutPlcAndUsesVirtualTime() {
    VariableRegistry registry;
    const auto run = registry.registerVariable({"session-a", "run", VariableType::Boolean, true}, false);
    const auto temperature = registry.registerVariable({"session-a", "temperature", VariableType::Real, true}, 20.0);
    ModbusSemanticEndpoint endpoint(registry, "session-a");
    endpoint.addMapping({1, ModbusArea::Coil, 0, run, 1.0, 0.0});
    endpoint.addMapping({1, ModbusArea::HoldingRegister, 100, temperature, 0.1, 0.0});

    CHECK(!endpoint.realTransportEnabled() && !endpoint.configuredPort(),
          "semantic endpoint must not create/configure a host port implicitly");
    endpoint.write(1, ModbusArea::Coil, 0, {1}, 100, 200);
    endpoint.write(1, ModbusArea::HoldingRegister, 100, {255}, 100, 200);
    CHECK(std::get<bool>(registry.read(run)), "coil write must update its single source of state");
    CHECK(std::get<double>(registry.read(temperature)) == 25.5, "register scaling must be deterministic");
    CHECK(endpoint.read(1, ModbusArea::HoldingRegister, 100, 1, 150, 200)[0] == 255,
          "register mapping golden must round-trip");

    bool timedOut = false;
    try { (void)endpoint.read(1, ModbusArea::Coil, 0, 1, 201, 200); }
    catch (const ProtocolTimeout&) { timedOut = true; }
    CHECK(timedOut, "simulated endpoint timeout must use virtual time");

    bool implicitPortRejected = false;
    try { endpoint.configureRealTransport({false, 502}); }
    catch (const std::invalid_argument&) { implicitPortRejected = true; }
    CHECK(implicitPortRejected && !endpoint.realTransportEnabled(), "real port requires explicit opt-in");
    endpoint.configureRealTransport({true, 1502});
    CHECK(endpoint.configuredPort() == 1502, "explicit transport configuration must remain observable");
}

void namespacesBindingsAndHartAreIndependent() {
    VariableRegistry left;
    VariableRegistry right;
    const auto leftPv = left.registerVariable({"student-1", "pv", VariableType::Real, true}, 1.0);
    const auto rightPv = right.registerVariable({"student-2", "pv", VariableType::Real, true}, 2.0);
    CHECK(leftPv == 0 && rightPv == 0 && std::get<double>(left.read(leftPv)) != std::get<double>(right.read(rightPv)),
          "session registries may reuse dense handles without sharing state");

    SemanticBindingPlan plan;
    plan.add({BindingSourceKind::SignalSlot, 42, leftPv});
    plan.commit({{42, 18.75}}, left);
    CHECK(std::get<double>(left.read(leftPv)) == 18.75, "explicit Signal binding must commit by resolved handles");

    HartSemanticEndpoint hart(left);
    hart.addDevice({0, "0011223344", "TIC101", "degC", leftPv});
    const HartResponse identity = hart.execute(0, 0);
    const HartResponse primary = hart.execute(0, 1);
    CHECK(identity.fields.size() == 2 && identity.fields[0] == "0011223344", "HART command 0 identity golden");
    CHECK(primary.fields.size() == 2 && primary.fields[1] == "degC", "HART command 1 primary variable golden");
}

void virtualIndustrialBusUsesAddressingTimeoutAndResetIsolation() {
    VirtualIndustrialBus bus;
    const VirtualModbusPoint register100{"line-a", 7, ModbusArea::HoldingRegister, 100};
    const VirtualModbusPoint register101{"line-a", 7, ModbusArea::HoldingRegister, 101};
    bus.publishModbus(register100, 1234.0, 1'000);
    CHECK(bus.readModbus(register100, 1'500, 500) == 1234.0, "virtual Modbus point must round-trip at the deadline");
    CHECK(!bus.readModbus(register101, 1'500, 500), "virtual Modbus addresses must remain isolated");
    CHECK(!bus.readModbus(register100, 1'501, 500), "virtual Modbus point must expire by virtual time");
    CHECK(!bus.readModbus(register100, 0, 500), "data from before a simulation reset must not leak into the new timeline");

    const VirtualHartPoint device{"hart-loop", 3};
    bus.publishHart(device, {"AABBCCDD", "FT101", "m3/h", 18.75}, 2'000);
    const auto hart = bus.readHart(device, 2'100, 100);
    CHECK(hart && hart->uniqueId == "AABBCCDD" && hart->primaryValue == 18.75,
          "virtual HART device must preserve identity and primary value");
    bus.clear();
    CHECK(!bus.readHart(device, 2'100, 100), "clearing a session bus must remove all HART state");
}

void visibleProtocolComponentsExchangeElectricalValues() {
    lasecsimul::simulation::Scheduler scheduler(8, [] { return true; });
    auto bus = std::make_shared<VirtualIndustrialBus>();
    IndustrialProtocolComponent server(IndustrialComponentKind::ModbusServer, scheduler, bus,
        std::array<lasecsimul::Pin, 2>{{{"value", 0, 0}, {"gnd", 0, 0}}});
    IndustrialProtocolComponent client(IndustrialComponentKind::ModbusClient, scheduler, bus,
        std::array<lasecsimul::Pin, 2>{{{"value", 0, 0}, {"gnd", 0, 0}}});
    TestMatrix source, destination;
    source.voltages["value"] = 12.345;
    server.stamp(source); client.stamp(destination);
    CHECK(server.online() && client.online(), "visible Modbus server/client components must become online");
    CHECK(std::abs(destination.drivenVoltage - 12.345) < 1e-9, "Modbus component pair must preserve scaled electrical value");

    IndustrialProtocolComponent transmitter(IndustrialComponentKind::HartTransmitter, scheduler, bus,
        std::array<lasecsimul::Pin, 2>{{{"value", 0, 0}, {"gnd", 0, 0}}});
    IndustrialProtocolComponent communicator(IndustrialComponentKind::HartCommunicator, scheduler, bus,
        std::array<lasecsimul::Pin, 2>{{{"value", 0, 0}, {"gnd", 0, 0}}});
    source.voltages["value"] = 4.2;
    transmitter.stamp(source); communicator.stamp(destination);
    CHECK(transmitter.online() && communicator.online(), "visible HART transmitter/communicator components must become online");
    CHECK(std::abs(destination.drivenVoltage - 4.2) < 1e-9, "HART command 1 component pair must expose the primary value");
}
} // namespace

int main() {
    modbusWorksWithoutPlcAndUsesVirtualTime();
    namespacesBindingsAndHartAreIndependent();
    virtualIndustrialBusUsesAddressingTimeoutAndResetIsolation();
    visibleProtocolComponentsExchangeElectricalValues();
    if (failures == 0) std::printf("Semantic Modbus/HART/explicit bindings (PLC-independent): OK\n");
    return failures == 0 ? 0 : 1;
}

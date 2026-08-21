#include "protocols/IndustrialProtocols.hpp"

#include <cstdio>

using namespace lasecsimul::protocols;

namespace {
int failures = 0;
#define CHECK(condition, message) do { if (!(condition)) { std::fprintf(stderr, "FAIL: %s\n", message); ++failures; } } while (false)

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
} // namespace

int main() {
    modbusWorksWithoutPlcAndUsesVirtualTime();
    namespacesBindingsAndHartAreIndependent();
    if (failures == 0) std::printf("Semantic Modbus/HART/explicit bindings (PLC-independent): OK\n");
    return failures == 0 ? 0 : 1;
}

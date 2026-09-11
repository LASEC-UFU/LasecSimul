#include "protocols/HartEngine.hpp"
#include "protocols/HartReferenceCatalog.hpp"
#include "protocols/HartTransport.hpp"

#include <cstdio>
#include <span>

using namespace lasecsimul::protocols;

namespace {
int failures = 0;
void check(bool condition, const char* message) {
    if (!condition) { std::fprintf(stderr, "FAIL: %s\n", message); ++failures; }
}

class Handler final : public IHartCommandHandler {
public:
    HartCommandId command() const noexcept override { return 1; }
    bool execute(const HartCommandContext&, HartResponseBuilder& response) noexcept override {
        return response.writeByte(0x42);
    }
};

class CustomHandler final : public IHartCommandHandler {
public:
    HartCommandId command() const noexcept override { return 99; }
    bool execute(const HartCommandContext&, HartResponseBuilder& response) noexcept override {
        return response.writeByte(0x99);
    }
};
}

int main() {
    const auto referenceCommands = HartReferenceCatalog::commandDescriptors();
    const auto referenceDevices = HartReferenceCatalog::deviceDefinitions();
    check(referenceCommands.size() == 60, "process_simul command catalog imported");
    check(referenceDevices.size() == 11 && referenceDevices.front().name == "FV100CA" &&
              referenceDevices.back().name == "FIT100A",
          "process_simul device catalog imported");
    const HartDeviceProfile referenceProfile = HartReferenceCatalog::makeGenericProfile();
    check(referenceProfile.commands.size() == referenceCommands.size() &&
              referenceProfile.manufacturerId == 0x3E,
          "generic process_simul-compatible profile");
    HartProfileRegistry referenceRegistry;
    check(HartReferenceCatalog::registerGenericProfile(referenceRegistry),
          "reference profile registration");
    const auto referencePlans = HartReferenceCatalog::makeDevicePlans();
    check(referencePlans.size() == 11 &&
              referencePlans.front().pollingAddress == 1 &&
              referencePlans.back().pollingAddress == 11,
          "reference device plan factory");
    HartEngine referenceEngine(referenceRegistry);
    check(referenceEngine.loadPlan({referencePlans}) && referenceEngine.deviceCount() == 11,
          "reference device plan loads");
    uint8_t payload[] = {0x10, 0x20, 0x30};
    HartFrame request{3, 1, {payload[0], payload[1], payload[2]}};
    HartResponseBuilder wire(16);
    check(HartFrameCodec::encode(request, wire), "frame encode");
    HartFrame decoded;
    check(HartFrameCodec::decode(wire.bytes(), decoded), "frame decode");
    check(decoded.pollingAddress == 3 && decoded.command == 1 && decoded.payload == request.payload,
          "frame round trip");
    auto corrupt = std::vector<uint8_t>(wire.bytes().begin(), wire.bytes().end());
    corrupt.back() ^= 1;
    check(!HartFrameCodec::decode(corrupt, decoded), "checksum rejects corruption");

    HartPayloadReader reader{std::span<const uint8_t>(payload)};
    uint16_t u16 = 0; uint8_t byte = 0;
    check(reader.readByte(byte) && byte == 0x10, "payload byte");
    check(reader.readU16(u16) && u16 == 0x2030, "payload u16");
    check(!reader.readByte(byte), "payload bounds");

    Handler handler;
    HartCommandRegistry commands;
    check(commands.registerHandler(handler), "command register");
    check(!commands.registerHandler(handler), "duplicate command rejected");
    check(commands.find(1) == &handler, "command lookup");
    check(commands.remove(1) && commands.find(1) == nullptr, "command removal");

    HartProfileRegistry profiles;
    check(profiles.registerProfile({"hart.default", 1, 0, 0, {{0, "identity"}}}), "profile register");
    check(!profiles.registerProfile({"hart.default", 1, 0, 0, {}}), "duplicate profile rejected");
    check(profiles.find("hart.default") != nullptr, "profile lookup");
    check(profiles.remove("hart.default") && profiles.find("hart.default") == nullptr, "profile removal");

    HartProfileRegistry runtimeProfiles;
    check(runtimeProfiles.registerProfile({"hart.default", 1, 0, 0,
                                           {{0, "identity"}, {1, "primary"}, {3, "dynamic"}}}),
          "runtime profile register");
    const std::vector<HartDevicePlan> devices{{"dev-a", "hart.default", "hart-1", 3, "0011223344", 21.5},
                                              {"dev-b", "hart.default", "hart-2", 3, "5566778899", 7.0}};
    const HartPlanCompileResult plan = HartPlanCompiler::compile(devices, runtimeProfiles);
    check(plan.success && plan.plan.devices.size() == 2, "plan compile multiple buses");
    HartEngine engine(runtimeProfiles);
    check(engine.loadPlan(plan.plan), "engine load plan");
    HartResponseBuilder primary(8);
    check(engine.execute(3, 1, {}, primary) && primary.size() == 4, "primary command dispatch");
    HartResponseBuilder secondary(8);
    check(engine.execute("hart-2", 3, 1, {}, secondary) && secondary.size() == 4 &&
              secondary.bytes()[0] != primary.bytes()[0],
          "same address dispatches by bus");
    check(engine.setPrimaryValue("dev-a", 42.25), "runtime value update");
    check(!engine.setPrimaryValue("missing", 1.0), "missing device rejected");
    const std::vector<uint8_t> configuredResponse{0xCA, 0xFE};
    const HartDevicePlan configuredDevice{"configured", "hart.default", "hart-1", 5,
                                         "configured-id", 0.0,
                                         {{1, true, false, {}}}};
    HartEngine configuredEngine(runtimeProfiles);
    check(configuredEngine.loadPlan({{configuredDevice}}), "per-device command configuration loads");
    check(configuredEngine.setCommandResponse("configured", 1, configuredResponse),
          "per-device static response update");
    HartResponseBuilder configuredResponseOut(4);
    check(configuredEngine.execute(5, 1, {}, configuredResponseOut) &&
              configuredResponseOut.bytes().size() == 2 && configuredResponseOut.bytes()[0] == 0xCA,
          "per-device static response dispatch");
    check(configuredEngine.setCommandEnabled("configured", 1, false),
          "per-device command disable");
    HartResponseBuilder disabledResponse(4);
    check(!configuredEngine.execute(5, 1, {}, disabledResponse), "disabled per-device command rejected");
    HartTransportEndpoint endpoint(configuredEngine);
    HartTransportConfig udpConfig{HartTransportKind::Udp, "hart-1", "127.0.0.1", 1200, 5094, 272};
    check(endpoint.configure(udpConfig), "transport configuration");
    // Re-enable command 1 for the transport boundary test.
    check(configuredEngine.setCommandEnabled("configured", 1, true), "transport command enable");
    HartFrame wireRequest{5, 1, {}};
    HartResponseBuilder encodedRequest(16);
    check(HartFrameCodec::encode(wireRequest, encodedRequest), "transport request encode");
    HartResponseBuilder encodedResponse(272);
    check(endpoint.transact(encodedRequest.bytes(), encodedResponse), "transport transaction");
    HartFrame wireResponse;
    check(HartFrameCodec::decode(encodedResponse.bytes(), wireResponse) &&
              wireResponse.pollingAddress == 5 && wireResponse.command == 1,
          "transport response decode");
    check(endpoint.counters().framesRx == 1 && endpoint.counters().framesTx == 1,
          "transport counters");
    CustomHandler custom;
    check(engine.registerCommandHandler(custom), "custom command registration");
    HartResponseBuilder customResponse(4);
    check(!engine.execute(3, 99, {}, customResponse), "undeclared custom command rejected");
    HartProfileRegistry customProfiles;
    check(customProfiles.registerProfile({"hart.custom", 1, 0, 0, {{99, "custom"}}}), "custom profile register");
    HartEngine customEngine(customProfiles);
    check(customEngine.registerCommandHandler(custom), "custom engine handler");
    check(customEngine.loadPlan({{{"custom-device", "hart.custom", "hart-1", 4, "custom", 0.0}}}), "custom plan");
    check(customEngine.execute(4, 99, {}, customResponse) && customResponse.bytes()[0] == 0x99,
          "custom command dispatch without engine edit");
    const std::vector<HartDevicePlan> collision{{"a", "hart.default", "hart-1", 1, "a", 0.0},
                                                {"b", "hart.default", "hart-1", 1, "b", 0.0}};
    check(!HartPlanCompiler::compile(collision, runtimeProfiles).success, "same-bus address collision rejected");
    const HartProtocolPlan invalid{{{"broken", "missing-profile", "hart-1", 1, "", 0.0}}};
    check(!engine.loadPlan(invalid), "engine rejects invalid plan");

    if (failures == 0) std::puts("HART engine contracts: PASS");
    return failures == 0 ? 0 : 1;
}

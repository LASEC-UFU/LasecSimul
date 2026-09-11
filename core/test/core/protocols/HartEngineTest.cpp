#include "protocols/HartCommandProgram.hpp"
#include "protocols/HartEngine.hpp"
#include "protocols/HartReferenceCatalog.hpp"
#include "protocols/HartTransport.hpp"
#include "protocols/HartTypeCodec.hpp"

#include <algorithm>
#include <cstdio>
#include <span>
#include <vector>

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
    check(HartReferenceCatalog::installCommandPrograms(referenceEngine), "DSL command programs install");

    // Golden vectors for the five commands migrated off the former central
    // switch (FASE 19/72/73 proof gate): FV100CA, bus "hart-1", address 1,
    // manufacturerId=0x3E, deviceType=0x03, uniqueId="029EB1" -> deviceId
    // {0x02,0x9E,0xB1}, default identity revisions, PV defaults to 0.0.
    {
        const std::vector<uint8_t> identityBlock{0xFE, 0x3E, 0x03, 0x05, 0x07, 0x01, 0x01, 0x00, 0x00,
                                                 0x02, 0x9E, 0xB1};
        HartResponseBuilder cmd0(32);
        check(referenceEngine.execute("hart-1", 1, 0x00, {}, cmd0) &&
                  std::equal(cmd0.bytes().begin(), cmd0.bytes().end(), identityBlock.begin()) &&
                  cmd0.size() == identityBlock.size(),
              "0x00 read unique identifier: 12-byte identity block");

        HartResponseBuilder cmd1(32);
        const std::vector<uint8_t> pv0{0x39, 0x00, 0x00, 0x00, 0x00}; // unit=57 (percent), PV=0.0f
        check(referenceEngine.execute("hart-1", 1, 0x01, {}, cmd1) &&
                  std::equal(cmd1.bytes().begin(), cmd1.bytes().end(), pv0.begin()) && cmd1.size() == 5,
              "0x01 read primary variable includes the unit byte (fixed from the prior 4-byte response)");

        HartResponseBuilder cmd3(32);
        check(referenceEngine.execute("hart-1", 1, 0x03, {}, cmd3) && cmd3.size() == 24,
              "0x03 read dynamic variables: 24-byte body (loop current + 4x unit/value)");
        check(cmd3.bytes()[4] == 0x39 && cmd3.bytes()[9] == 0xFA && cmd3.bytes()[14] == 0xFA && cmd3.bytes()[19] == 0xFA,
              "0x03 marks SV/TV/QV as HART 'not used' (0xFA), only PV modeled");

        const std::vector<uint8_t> packedTag = HartTypeCodec::encodePackedAscii("FV100CA", 8);
        check(packedTag.size() == 6, "packed-ASCII tag round-trips to 6 bytes for 8 chars");

        HartResponseBuilder cmd0bMatch(32);
        check(referenceEngine.execute("hart-1", 1, 0x0B, packedTag, cmd0bMatch) &&
                  cmd0bMatch.size() == 13 && cmd0bMatch.bytes()[0] == 0x00 &&
                  std::equal(identityBlock.begin(), identityBlock.end(), cmd0bMatch.bytes().begin() + 1),
              "0x0B tag match: status 0x00 + identity block");

        std::vector<uint8_t> wrongTag = packedTag;
        wrongTag[0] ^= 0xFF;
        HartResponseBuilder cmd0bMismatch(32);
        check(referenceEngine.execute("hart-1", 1, 0x0B, wrongTag, cmd0bMismatch) &&
                  cmd0bMismatch.size() == 13 && cmd0bMismatch.bytes()[0] == 0x01,
              "0x0B tag mismatch: status 0x01 (no native handler ever existed for 0x0B; first implementation is the DSL)");

        const uint8_t codes[] = {0x00, 0x05};
        HartResponseBuilder cmd21(32);
        const std::vector<uint8_t> expectedCmd21{0x00,                         // error_code
                                                 0x39, 0x00, 0x00, 0x00, 0x00, // code 0x00 -> PV unit + value
                                                 0xFA, 0x7F, 0xC0, 0x00, 0x00}; // code 0x05 -> not used + NaN
        check(referenceEngine.execute("hart-1", 1, 0x21, codes, cmd21) &&
                  std::equal(cmd21.bytes().begin(), cmd21.bytes().end(), expectedCmd21.begin()) &&
                  cmd21.size() == expectedCmd21.size(),
              "0x21 read device variables: known code 0x00 (PV) + unknown code -> not used (no native handler ever existed for 0x21)");
    }
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
    check(HartReferenceCatalog::installCommandPrograms(engine), "DSL command programs install (runtime engine)");
    HartResponseBuilder primary(8);
    check(engine.execute(3, 1, {}, primary) && primary.size() == 5, "primary command dispatch");
    HartResponseBuilder secondary(8);
    check(engine.execute("hart-2", 3, 1, {}, secondary) && secondary.size() == 5 &&
              !std::equal(primary.bytes().begin(), primary.bytes().end(), secondary.bytes().begin()),
          "same address dispatches by bus");
    check(engine.setPrimaryValue("dev-a", 42.25), "runtime value update");
    check(!engine.setPrimaryValue("missing", 1.0), "missing device rejected");
    const std::vector<uint8_t> configuredResponse{0xCA, 0xFE};
    HartDevicePlan configuredDevice{"configured", "hart.default", "hart-1", 5,
                                    "configured-id", 0.0,
                                    {{1, true, false, {}}}};
    configuredDevice.variables.push_back({"PV", "Primary", "V", 2.0, "base * gain", false});
    configuredDevice.variables.push_back({"base", "Base", "V", 3.0, "", false});
    configuredDevice.variables.push_back({"gain", "Gain", "", 4.0, "", false});
    HartEngine configuredEngine(runtimeProfiles);
    check(configuredEngine.loadPlan({{configuredDevice}}), "per-device command configuration loads");
    check(HartReferenceCatalog::installCommandPrograms(configuredEngine), "DSL command programs install (configured engine)");
    HartResponseBuilder expressionResponse(8);
    const auto expectedPv = HartTypeCodec::encodeFloat32BE(12.0f); // base(3) * gain(4)
    check(configuredEngine.execute(5, 1, {}, expressionResponse) && expressionResponse.size() == 5 &&
              expressionResponse.bytes()[0] == 0x39 &&
              std::equal(expectedPv.begin(), expectedPv.end(), expressionResponse.bytes().begin() + 1),
          "HART variable expression uses Core SignalEngine, PV reaches the DSL response byte-exact");
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

    // Direct DSL primitive characterization (not a real HART command): proves
    // SET, IF/EQ, MAP and FOR_CODES individually, and the write -> resp -> after
    // ordering guarantee (FASE 76 gate), independent of any specific command.
    {
        HartCommandDefinition def;
        def.id = 200;
        def.name = "primitive characterization";
        def.write = {HartStatement{HartSetStmt{HartVarId::PrimaryVariableUnit, HartExpr::bodySlice(0, 1)}}};
        HartIfStmt ifStmt;
        ifStmt.lhs = HartExpr::var(HartVarId::PrimaryVariableUnit);
        ifStmt.rhs = HartExpr::hexByte(0x11);
        ifStmt.thenBranch = {HartStatement{HartAppendStmt{HartExpr::hexByte(0xAA)}}};
        ifStmt.elseBranch = {HartStatement{HartAppendStmt{HartExpr::hexByte(0xBB)}}};
        HartMapStmt mapStmt;
        mapStmt.key = HartExpr::bodySlice(1, 1);
        mapStmt.table = {{{0x01}, {0xC1}}, {{0x02}, {0xC2}}};
        mapStmt.defaultValue = {0xC0};
        HartForCodesStmt forStmt;
        forStmt.source = HartExpr::bodySlice(2, 2);
        forStmt.maxIterations = 4;
        forStmt.body = {HartStatement{HartAppendStmt{HartExpr::localCode()}}};
        def.resp = {HartStatement{std::move(ifStmt)}, HartStatement{std::move(mapStmt)}, HartStatement{std::move(forStmt)}};
        def.after = {HartStatement{HartSetStmt{HartVarId::PrimaryVariableUnit, HartExpr::hexByte(0x00)}}};

        const HartCommandCompileResult compiled = HartCommandCompiler::compile(def);
        check(compiled.success, "primitive program compiles");

        HartExecutionVariables vars;
        const uint8_t request1[] = {0x11, 0x01, 0x07, 0x08};
        HartResponseBuilder out1(16);
        check(HartCommandExecutor::execute(compiled.program, vars, request1, out1), "primitive program executes");
        const std::vector<uint8_t> expected1{0xAA, 0xC1, 0x07, 0x08};
        check(out1.size() == expected1.size() && std::equal(expected1.begin(), expected1.end(), out1.bytes().begin()),
              "SET/IF/MAP/FOR_CODES produce expected bytes (write value observed by resp)");

        const uint8_t request2[] = {0x22, 0x09, 0x0A, 0x0B};
        HartResponseBuilder out2(16);
        check(HartCommandExecutor::execute(compiled.program, vars, request2, out2),
              "primitive program executes (else/default branch)");
        const std::vector<uint8_t> expected2{0xBB, 0xC0, 0x0A, 0x0B};
        check(out2.size() == expected2.size() && std::equal(expected2.begin(), expected2.end(), out2.bytes().begin()),
              "IF else branch and MAP default are both reachable");

        HartCommandDefinition badSet;
        badSet.id = 201;
        badSet.write = {HartStatement{HartSetStmt{HartVarId::ManufacturerId, HartExpr::hexByte(0x01)}}};
        check(!HartCommandCompiler::compile(badSet).success, "compiler rejects SET to a non-writable variable");

        HartCommandDefinition badSlice;
        badSlice.id = 202;
        badSlice.resp = {HartStatement{HartAppendStmt{HartExpr::bodySlice(0, 1000)}}};
        check(!HartCommandCompiler::compile(badSlice, 32, 255).success,
              "compiler rejects a body slice exceeding the declared request bound");

        HartCommandDefinition oobRead;
        oobRead.id = 203;
        oobRead.resp = {HartStatement{HartAppendStmt{HartExpr::bodySlice(0, 4)}}};
        const HartCommandCompileResult oobCompiled = HartCommandCompiler::compile(oobRead);
        check(oobCompiled.success, "a slice within the declared bound compiles");
        const uint8_t shortRequest[] = {0x01};
        HartResponseBuilder oobOut(16);
        check(!HartCommandExecutor::execute(oobCompiled.program, vars, shortRequest, oobOut),
              "runtime out-of-bounds slice is rejected, never read past the actual request buffer");
    }

    if (failures == 0) std::puts("HART engine contracts: PASS");
    return failures == 0 ? 0 : 1;
}

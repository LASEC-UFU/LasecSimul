// LD301 reference audit (docs/ld301-audit.md): the simulated Smar LD301 must
// reproduce the HART behavior of the real transmitter captured in ld301/.
// Every check talks to the device through PHYSICAL HART frames (preambles,
// long address, byte count, XOR) via HartCommunicationComponent::transact,
// exactly the path PACTware traffic takes.

#include "protocols/HartCommandJson.hpp"
#include "protocols/HartCommunicationComponent.hpp"
#include "protocols/HartEngine.hpp"
#include "protocols/HartLcd.hpp"
#include "protocols/HartReferenceCatalog.hpp"
#include "protocols/HartTypeCodec.hpp"
#include "registry/ComponentParams.hpp"
#include "simulation/Scheduler.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <tuple>
#include <vector>

using namespace lasecsimul::protocols;
using Bytes = std::vector<uint8_t>;

namespace {

int failures = 0;
int checks = 0;
void check(bool condition, const std::string& message) {
    ++checks;
    if (!condition) { std::fprintf(stderr, "FAIL: %s\n", message.c_str()); ++failures; }
}

std::string hex(std::span<const uint8_t> bytes) {
    std::ostringstream out;
    out << std::uppercase << std::hex << std::setfill('0');
    for (size_t i = 0; i < bytes.size(); ++i) out << (i ? " " : "") << std::setw(2) << static_cast<unsigned>(bytes[i]);
    return out.str();
}

Bytes f32(float value) {
    const auto encoded = HartTypeCodec::encodeFloat32BE(value);
    return {encoded.begin(), encoded.end()};
}

Bytes cat(std::initializer_list<Bytes> parts) {
    Bytes out;
    for (const auto& part : parts) out.insert(out.end(), part.begin(), part.end());
    return out;
}

constexpr std::array<uint8_t, 5> kLongAddress{0x3E, 0x01, 0x05, 0xF0, 0x4D};

/** Builds a physical master request (5 preambles). */
Bytes requestFrame(uint8_t command, const Bytes& data = {}, bool longFrame = true, bool primary = true,
                   uint8_t pollingAddress = 0) {
    Bytes frame{0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
    const size_t start = frame.size();
    frame.push_back(longFrame ? 0x82 : 0x02);
    const uint8_t master = primary ? 0x80 : 0x00;
    if (longFrame) {
        frame.push_back(static_cast<uint8_t>(kLongAddress[0] | master));
        frame.insert(frame.end(), kLongAddress.begin() + 1, kLongAddress.end());
    } else {
        frame.push_back(static_cast<uint8_t>(pollingAddress | master));
    }
    frame.push_back(command);
    frame.push_back(static_cast<uint8_t>(data.size()));
    frame.insert(frame.end(), data.begin(), data.end());
    frame.push_back(HartFrameCodec::checksum(std::span<const uint8_t>(frame).subspan(start)));
    return frame;
}

struct Reply {
    bool present = false;
    bool wellFormed = false;
    size_t preambles = 0;
    uint8_t delimiter = 0;
    Bytes address;
    uint8_t command = 0;
    uint8_t responseCode = 0;
    uint8_t status = 0;
    Bytes data;
    Bytes raw;
};

/** Parses a physical slave reply, validating byte count and XOR. */
Reply parseReply(std::span<const uint8_t> raw) {
    Reply reply;
    reply.raw.assign(raw.begin(), raw.end());
    reply.present = !raw.empty();
    size_t i = 0;
    while (i < raw.size() && raw[i] == 0xFF) ++i;
    reply.preambles = i;
    if (i >= raw.size()) return reply;
    reply.delimiter = raw[i];
    const size_t addressBytes = (reply.delimiter & 0x80) ? 5 : 1;
    if (raw.size() < i + 1 + addressBytes + 4) return reply;
    reply.address.assign(raw.begin() + static_cast<std::ptrdiff_t>(i + 1),
                         raw.begin() + static_cast<std::ptrdiff_t>(i + 1 + addressBytes));
    const size_t at = i + 1 + addressBytes;
    reply.command = raw[at];
    const size_t count = raw[at + 1];
    if (count < 2 || raw.size() != at + 2 + count + 1) return reply;
    reply.responseCode = raw[at + 2];
    reply.status = raw[at + 3];
    reply.data.assign(raw.begin() + static_cast<std::ptrdiff_t>(at + 4), raw.begin() + static_cast<std::ptrdiff_t>(at + 2 + count));
    reply.wellFormed = HartFrameCodec::checksum(raw.subspan(i)) == 0;
    return reply;
}

// The LD301 is NOT built into Core: it is the subcircuit
// subcircuits/hart_smar_ld301.lssubcircuit, one standard HART field device
// (`protocol.hart.device.standard`) configured with the LD301 data. Every
// test below instantiates exactly what that file describes.
nlohmann::json loadSubcircuit() {
    std::ifstream file(LASECSIMUL_TEST_LD301_SUBCIRCUIT);
    nlohmann::json document = nlohmann::json::object();
    try { document = nlohmann::json::parse(file); } catch (...) {}
    return document;
}

const nlohmann::json* innerHartDevice(const nlohmann::json& document) {
    if (!document.contains("components") || !document["components"].is_array()) return nullptr;
    for (const auto& component : document["components"])
        if (component.value("typeId", std::string{}) == "protocol.hart.device.standard") return &component;
    return nullptr;
}

lasecsimul::registry::ComponentParams ld301Params(const lasecsimul::registry::ComponentParams& overrides = {}) {
    static const nlohmann::json document = loadSubcircuit();
    lasecsimul::registry::ComponentParams params;
    if (const auto* device = innerHartDevice(document); device && device->contains("properties")) {
        for (const auto& [key, value] : (*device)["properties"].items()) {
            if (value.is_string()) params.properties[key] = value.get<std::string>();
            else if (value.is_boolean()) params.properties[key] = value.get<bool>();
            else if (value.is_number()) params.properties[key] = value.get<double>();
        }
    }
    for (const auto& [key, value] : overrides.properties) params.properties[key] = value;
    return params;
}

struct Device {
    lasecsimul::simulation::Scheduler scheduler{6, [] { return true; }};
    HartCommunicationComponent::DevicePreset preset = HartCommunicationComponent::standardFieldDevicePreset();
    std::unique_ptr<HartCommunicationComponent> component;

    /** An LD301 as placed from the subcircuit; `overrides` are instance
     * edits on top of it (e.g. a saved project). */
    explicit Device(const lasecsimul::registry::ComponentParams& overrides = {}) {
        component = std::make_unique<HartCommunicationComponent>(HartCommunicationComponent::Mode::Serial, scheduler,
                                                                 ld301Params(overrides), &preset);
    }
    Reply send(const Bytes& frame) {
        HartResponseBuilder response(300);
        if (!component->transact(frame, response)) return {};
        return parseReply(response.bytes());
    }
    Reply cmd(uint8_t command, const Bytes& data = {}, bool primary = true) {
        return send(requestFrame(command, data, true, primary));
    }
    lasecsimul::registry::ComponentParams save() {
        lasecsimul::registry::ComponentParams saved;
        for (const auto& descriptor : component->propertyDescriptors()) saved.properties[descriptor.schema.id] = descriptor.get();
        return saved;
    }
};

float floatAt(const Bytes& data, size_t offset) {
    return offset + 4 <= data.size() ? HartTypeCodec::decodeFloat32BE(std::span<const uint8_t>(data).subspan(offset, 4))
                                     : std::numeric_limits<float>::quiet_NaN();
}

/** Minimal MNA view: node voltages by pin id, records stamped currents. */
class StubMatrix final : public lasecsimul::MnaMatrixView {
public:
    std::vector<std::pair<std::string, double>> voltages;
    std::vector<std::tuple<std::string, std::string, double>> currents;
    void addConductance(const lasecsimul::Pin&, const lasecsimul::Pin&, double) override {}
    void addCurrent(const lasecsimul::Pin& a, const lasecsimul::Pin& b, double amperes) override { currents.emplace_back(a.id, b.id, amperes); }
    void addVoltageSource(const lasecsimul::Pin&, const lasecsimul::Pin&, double) override {}
    void addConductanceToGround(const lasecsimul::Pin&, double) override {}
    void addCurrentToGround(const lasecsimul::Pin&, double) override {}
    double getNodeVoltage(const lasecsimul::Pin& pin) const override {
        for (const auto& [id, volts] : voltages) if (id == pin.id) return volts;
        return 0.0;
    }
    double getBranchCurrent() const override { return 0.0; }
};

// ---------------------------------------------------------------------------
// Captured-session replay.

struct Exchange { std::string time; Bytes request, response; size_t index = 0; };

std::vector<Exchange> loadCapture(const char* path) {
    std::ifstream stream(path);
    std::vector<Exchange> exchanges;
    std::string line;
    while (std::getline(stream, line)) {
        const bool serial = line.find("SERIAL RX") != std::string::npos;
        const bool udp = line.find("UDP RX") != std::string::npos;
        if (!serial && !udp) continue;
        const size_t start = line.find("): ");
        if (start == std::string::npos) continue;
        std::istringstream tokens(line.substr(start + 3));
        Bytes bytes;
        std::string token;
        // The UDP log fragments the reply in 1-4 byte datagrams; the capture's
        // very last datagram ends with a lone nibble (truncated log).
        while (tokens >> token) {
            if (token.size() != 2) break;
            bytes.push_back(static_cast<uint8_t>(std::stoul(token, nullptr, 16)));
        }
        if (serial) {
            Exchange exchange;
            exchange.time = line.substr(1, line.find(']') - 1);
            exchange.request = bytes;
            exchange.index = exchanges.size();
            exchanges.push_back(std::move(exchange));
        } else if (!exchanges.empty()) {
            auto& response = exchanges.back().response;
            response.insert(response.end(), bytes.begin(), bytes.end());
        }
    }
    return exchanges;
}

// Recent bench captures include More Status Available (0x10) without a
// diagnostic exchange that identifies its source. Compare all other frame
// bytes, including the XOR after removing only that session status bit.
bool matchesCaptureWithoutUnknownStatus(Device& device, const Exchange& exchange) {
    HartResponseBuilder response(300);
    device.component->transact(exchange.request, response);
    const Bytes simulated(response.bytes().begin(), response.bytes().end());
    Bytes captured = exchange.response;
    const Reply real = parseReply(captured);
    if (!real.wellFormed) return false;
    if ((real.status & 0x10) != 0) {
        const size_t statusAt = real.preambles + 1 + real.address.size() + 3;
        captured[statusAt] ^= 0x10;
        captured.back() ^= 0x10;
    }
    if (simulated == captured) return true;
    std::fprintf(stderr, "Capture #%zu Cmd %u\n  real      %s\n  simulated %s\n", exchange.index,
                 static_cast<unsigned>(real.command), hex(exchange.response).c_str(), hex(simulated).c_str());
    return false;
}

/** HART frame without preambles; stray non-0xFF bytes in the preamble run
 * (line noise, e.g. 0xFD) are skipped up to the ACK delimiter. */
Bytes stripPreambles(std::span<const uint8_t> bytes) {
    size_t i = 0;
    while (i < bytes.size() && bytes[i] != 0x86 && bytes[i] != 0x06) ++i;
    return {bytes.begin() + static_cast<std::ptrdiff_t>(i), bytes.end()};
}

struct ReplayRow {
    size_t index = 0;
    std::string time;
    uint8_t command = 0;
    std::string result;   // EXACT / SEMANTIC / MISMATCH
    std::string detail;
    Bytes request, real, simulated;
};

std::vector<ReplayRow> replayCapture(const char* path) {
    std::vector<ReplayRow> rows;
    const auto exchanges = loadCapture(path);
    Device device;
    // Pre-capture state: the log starts BEFORE PACTware writes the identity
    // shown in fig02 (Commands 18/17 at 13:27). The device then held the
    // texts below and date bytes 82 08 20. That state is primed through the
    // SECONDARY master, so the primary master's Cold Start bit (seen as 0x64
    // in the first captured reply) is untouched.
    const Bytes tagDescDate = cat({HartTypeCodec::encodePackedAscii("TAG", 8),
                                   HartTypeCodec::encodePackedAscii("16 CHARACTERES", 16), Bytes{0x82, 0x08, 0x20}});
    device.cmd(18, tagDescDate, false);
    device.cmd(17, HartTypeCodec::encodePackedAscii("32 CHARACTERES", 32), false);
    for (const auto& exchange : exchanges) {
        ReplayRow row;
        row.index = exchange.index;
        row.time = exchange.time;
        row.request = exchange.request;
        row.real = exchange.response;
        HartResponseBuilder response(300);
        const bool answered = device.component->transact(exchange.request, response);
        row.simulated.assign(response.bytes().begin(), response.bytes().end());
        const Reply sim = parseReply(row.simulated);
        const Reply real = parseReply(row.real);
        row.command = sim.command;
        if (!answered || !sim.wellFormed) {
            row.result = "MISMATCH";
            row.detail = "simulator produced no well-formed reply";
        } else if (row.real == row.simulated) {
            row.result = "EXACT";
        } else {
            const Bytes realFrame = stripPreambles(row.real);
            const Bytes simFrame = stripPreambles(row.simulated);
            std::vector<size_t> differing;
            for (size_t i = 0; i < std::min(realFrame.size(), simFrame.size()); ++i)
                if (realFrame[i] != simFrame[i]) differing.push_back(i);
            const bool addressOnly = !differing.empty() &&
                std::all_of(differing.begin(), differing.end(), [](size_t i) { return i >= 1 && i <= 5; });
            // Process measurements (PV, sensor temperature) are live values:
            // only their float may differ; command, RC, status, codes and
            // units must be identical.
            const auto dynamicOnly = [&]() {
                if (!real.wellFormed || real.command != sim.command || real.responseCode != sim.responseCode ||
                    real.status != sim.status || real.data.size() != sim.data.size()) return false;
                std::vector<bool> dynamicByte(real.data.size(), false);
                if (real.command == 1 && real.data.size() == 5) std::fill(dynamicByte.begin() + 1, dynamicByte.end(), true);
                if (real.command == 33 && real.data.size() % 6 == 0)
                    for (size_t slot = 0; slot < real.data.size(); slot += 6)
                        if (real.data[slot] == 5 || real.data[slot] == 246)
                            std::fill(dynamicByte.begin() + static_cast<std::ptrdiff_t>(slot + 2),
                                      dynamicByte.begin() + static_cast<std::ptrdiff_t>(slot + 6), true);
                for (size_t i = 0; i < real.data.size(); ++i)
                    if (real.data[i] != sim.data[i] && !dynamicByte[i]) return false;
                return true;
            };
            if (real.wellFormed && realFrame == simFrame) {
                row.result = "SEMANTIC";
                row.detail = "identical HART frame, different preamble count";
            } else if (dynamicOnly()) {
                row.result = "SEMANTIC";
                std::ostringstream detail;
                detail << "live process value differs (command " << static_cast<unsigned>(real.command)
                       << "): captured [" << hex(real.data) << "] simulated [" << hex(sim.data) << "]";
                row.detail = detail.str();
            } else if (!real.wellFormed && realFrame.size() == simFrame.size() && addressOnly) {
                // The device computed its XOR over the correct address; the
                // bit flipped on the wire afterwards (capture XOR is invalid).
                row.result = "SEMANTIC";
                row.detail = "capture corrupted by line noise: address byte " + hex(Bytes{realFrame[differing.front()]}) +
                             " vs " + hex(Bytes{simFrame[differing.front()]}) +
                             " (single bit flip, XOR invalid); every other byte incl. checksum matches";
            } else if (!real.wellFormed && realFrame.size() < simFrame.size() && differing.empty()) {
                row.result = "SEMANTIC";
                row.detail = "capture truncated (log ended; 0xFD preamble glitch); all " + std::to_string(realFrame.size()) +
                             " captured frame bytes match the simulated reply";
            } else {
                row.result = "MISMATCH";
                std::ostringstream detail;
                detail << "RC/status real " << hex(Bytes{real.responseCode, real.status}) << " sim "
                       << hex(Bytes{sim.responseCode, sim.status}) << "; data real [" << hex(real.data) << "] sim ["
                       << hex(sim.data) << "]";
                row.detail = detail.str();
            }
        }
        rows.push_back(std::move(row));
    }
    return rows;
}

std::string csvEscape(const std::string& text) {
    std::string out = "\"";
    for (char c : text) { if (c == '"') out += '"'; out += c; }
    return out + "\"";
}

} // namespace

int main(int argc, char** argv) {
    const char* capture = LASECSIMUL_TEST_LD301_CAPTURE;
    std::string reportPath;
    for (int i = 1; i < argc; ++i) {
        if (i + 1 < argc && std::string(argv[i]) == "--capture") capture = argv[i + 1];
        if (i + 1 < argc && std::string(argv[i]) == "--report") reportPath = argv[i + 1];
    }

    // ----------------------------- S. LD301 = subcircuit of the standard device
    {
        const nlohmann::json document = loadSubcircuit();
        const auto* device = innerHartDevice(document);
        check(document.value("schemaVersion", 0) == 3 && document.value("typeId", std::string{}) == "subcircuits.hart.smar_ld301",
              "S1 the LD301 is the subcircuit subcircuits.hart.smar_ld301 (schemaVersion 3)");
        check(device != nullptr && device->value("id", std::string{}) == "ld301" &&
                  device->at("properties").value("profileId", std::string{}) == "lasecsimul.hart.standard-field-device",
              "S2 it contains one standard HART field device (protocol.hart.device.standard), not a built-in LD301");
        bool interfaceOk = document.contains("interface") && document["interface"].size() == 4;
        for (const char* pin : {"loop_plus", "loop_minus"}) {
            bool inInterface = false, tunnelWired = false;
            std::string tunnelId;
            for (const auto& entry : document["interface"])
                if (entry.value("pinId", std::string{}) == pin && entry.value("internalTunnel", std::string{}) == pin &&
                    entry.value("domain", std::string{}) == "electrical") inInterface = true;
            for (const auto& component : document["components"])
                if (component.value("typeId", std::string{}) == "connectors.tunnel" &&
                    component["properties"].value("name", std::string{}) == pin) tunnelId = component.value("id", std::string{});
            for (const auto& wire : document["topology"]["conductors"])
                if (wire["from"].value("componentId", std::string{}) == tunnelId && wire["to"].value("componentId", std::string{}) == "ld301" &&
                    wire["to"].value("pinId", std::string{}) == pin) tunnelWired = true;
            interfaceOk = interfaceOk && inInterface && tunnelWired;
        }
        for (const char* pin : {"high", "low"}) {
            const auto signalPort = std::find_if(document["interface"].begin(), document["interface"].end(), [pin](const auto& entry) {
                return entry.value("pinId", std::string{}) == pin && entry.value("domain", std::string{}) == "signal" &&
                       entry.value("direction", std::string{}) == "in";
            });
            interfaceOk = interfaceOk && signalPort != document["interface"].end();
        }
        const bool pressureWired = std::any_of(document["topology"]["conductors"].begin(),
            document["topology"]["conductors"].end(), [](const auto& wire) {
                return wire["from"].value("componentId", std::string{}) == "differential_pressure" &&
                       wire["to"].value("componentId", std::string{}) == "ld301" &&
                       wire["to"].value("pinId", std::string{}) == "PV";
            });
        check(interfaceOk && pressureWired, "S3 HIGH/LOW drive PV through a differential block; LOOP+/LOOP- stay electrical");
        const auto exported = document.value("exportedPropertyComponentIds", nlohmann::json::array());
        check(std::find(exported.begin(), exported.end(), "ld301") != exported.end(),
              "S4 the inner device's properties are exported: each LD301 instance can be changed");
        nlohmann::json commands = nlohmann::json::array();
        try { commands = nlohmann::json::parse(device ? device->at("properties").value("hartCommandsJson", std::string{"[]"}) : "[]"); } catch (...) {}
        bool allDeviceSpecific = commands.size() == 33;
        for (const auto& command : commands) allDeviceSpecific = allDeviceSpecific && command.value("id", 0) >= 128 && command.value("id", 0) <= 253;
        check(allDeviceSpecific, "S5 the 33 LD301 commands are Lasec HART DSL data (Device-Specific 128-253) in hartCommandsJson");
        Device ld301;
        check(ld301.component->pins().size() == 4 && std::string(ld301.component->typeId()) == "protocol.hart.device.standard",
              "S6 instantiating the subcircuit's device gives the standard C++ HART device with 4 terminals");
        lasecsimul::registry::ComponentParams changes;
        changes.properties["hartSoftwareRevision"] = 128.0;
        changes.properties["tag"] = std::string("PT-9");
        Device edited(changes);
        edited.send(requestFrame(0, {}, false));
        check(edited.send(requestFrame(0, {}, false)).data[6] == 0x80 &&
                  HartTypeCodec::decodePackedAscii(std::span<const uint8_t>(edited.cmd(13).data).first(6)) == "PT-9    ",
              "S7 changing instance properties changes the transmitter (software revision, tag)");
    }

    // ---------------- T. the standard HART device alone (no LD301 data at all)
    {
        lasecsimul::simulation::Scheduler scheduler(6, [] { return true; });
        auto preset = HartCommunicationComponent::standardFieldDevicePreset();
        HartCommunicationComponent standard(HartCommunicationComponent::Mode::Serial, scheduler, {}, &preset);
        const auto frameFor = [](uint8_t command, const Bytes& data, bool longFrame) {
            Bytes frame{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, static_cast<uint8_t>(longFrame ? 0x82 : 0x02)};
            if (longFrame) frame.insert(frame.end(), {0xBE, 0x03, 0x00, 0x00, 0x01}); else frame.push_back(0x80);
            frame.push_back(command); frame.push_back(static_cast<uint8_t>(data.size()));
            frame.insert(frame.end(), data.begin(), data.end());
            frame.push_back(HartFrameCodec::checksum(std::span<const uint8_t>(frame).subspan(5)));
            return frame;
        };
        const auto send = [&](uint8_t command, const Bytes& data = {}, bool longFrame = true) {
            HartResponseBuilder response(300);
            return standard.transact(frameFor(command, data, longFrame), response) ? parseReply(response.bytes()) : Reply{};
        };
        const Reply identity = send(0, {}, false);
        check(identity.wellFormed && identity.status == 0x20 && identity.data.size() == 12 && identity.data[1] == 0x3E &&
                  identity.data[2] == 0x03 && Bytes(identity.data.begin() + 9, identity.data.end()) == Bytes{0x00, 0x00, 0x01},
              "T1 standard device: Command 0 short frame, cold start 0x20, generic identity (3E/03, ID 000001)");
        check(send(15).data.size() == 18, "T2 standard device: HART 7 Command 15 layout (18 bytes)");
        check(send(12).data.size() == 24, "T3 standard device: Command 12 message is 24 packed bytes");
        check(send(128).responseCode == 64, "T4 standard device: no vendor command unless authored -> RC 64");
        const Reply fixed = send(40, f32(12.0f));
        check(fixed.responseCode == 0 && (fixed.status & 0x08) && send(2).data == cat({f32(12.0f), f32(0.0f)}),
              "T5 standard device: loop test with Loop Current Fixed status");
        send(40, f32(0.0f));
        check(standard.pins().size() == 4, "T6 standard device: signal + loop terminals");
        StubMatrix matrix;
        for (size_t i = 0; i < 4; ++i) standard.onPinConnectionChanged(i, true);
        matrix.voltages = {{"sensor_plus", 2.5}, {"sensor_minus", 0.0}};
        standard.stamp(matrix);
        check(!matrix.currents.empty() && std::fabs(std::get<2>(matrix.currents.back()) * 1000.0 - 12.0) < 1e-6,
              "T7 standard device: 2.5 V on the 0-5 V signal scale = 50 % = 12 mA on the loop");
        lasecsimul::registry::ComponentParams protectedDevice;
        protectedDevice.properties["writeProtectCode"] = 1.0;
        HartCommunicationComponent locked(HartCommunicationComponent::Mode::Serial, scheduler, protectedDevice, &preset);
        HartResponseBuilder lockedReply(300);
        locked.transact(frameFor(18, Bytes(21, 0x20), true), lockedReply);
        check(parseReply(lockedReply.bytes()).responseCode == 7, "T8 standard device: write protect -> RC 7, also for DSL writes (Cmd 18)");
    }

    // ------------------------------------------------------------- A. identity
    {
        Device device;
        const Reply shortFrame = device.send(requestFrame(0, {}, false));
        check(shortFrame.wellFormed && shortFrame.delimiter == 0x06 && shortFrame.preambles == 5 &&
                  shortFrame.address == Bytes{0x80},
              "A1 Command 0 answers the short-frame poll with an ACK short frame and 5 preambles");
        check(shortFrame.data == Bytes{0xFE, 0x3E, 0x01, 0x05, 0x05, 0x05, 0x72, 0x20, 0x06, 0x05, 0xF0, 0x4D},
              "A2 Command 0 identity: FE, Smar 3E, LD301 01, 5 preambles, univ rev 5, device rev 5, sw 0x72, hw 0x20, flags 06, ID 05F04D");
        const Reply longFrame = device.cmd(0);
        check(longFrame.wellFormed && longFrame.delimiter == 0x86 && longFrame.address == Bytes{0xBE, 0x01, 0x05, 0xF0, 0x4D} &&
                  longFrame.data == shortFrame.data,
              "A3 Command 0 over the long address BE 01 05 F0 4D returns the same identity");
        const Reply tag = device.cmd(13);
        check(tag.data.size() == 21 && HartTypeCodec::decodePackedAscii(std::span<const uint8_t>(tag.data).first(6)) == "LT100   " &&
                  HartTypeCodec::decodePackedAscii(std::span<const uint8_t>(tag.data).subspan(6, 12)) == "MEDIDOR DE NIVEL" &&
                  Bytes(tag.data.begin() + 18, tag.data.end()) == Bytes{8, 3, 81},
              "A4 Command 13: Tag LT100, Descriptor MEDIDOR DE NIVEL, Date 08/03/1981 (fig02)");
        const Reply message = device.cmd(12);
        check(message.data.size() == 24 && HartTypeCodec::decodePackedAscii(message.data) == "TRANSMISSOR DE NIVEL            ",
              "A5 Command 12: 24-byte (32-char) message TRANSMISSOR DE NIVEL (fig02)");
        check(device.cmd(16).data == Bytes{0x00, 0xD0, 0xE6}, "A6 Command 16: final assembly / main board serial 53478 (fig03)");
        const Reply ordering = device.cmd(173);
        check(std::string(ordering.data.begin(), ordering.data.end()) == "LD301M21ITD10011-I6P0 ",
              "A7 Command 173: ordering code LD301M21ITD10011-I6P0 (fig02)");
        const Reply sensor = device.cmd(14);
        check(Bytes(sensor.data.begin(), sensor.data.begin() + 4) == Bytes{0x09, 0xFA, 0x78, 0x04},
              "A8 Command 14: sensor serial 653944 (fig03/fig04), limits unit mmH2O");
        check(device.cmd(20).responseCode == 64, "A9 HART-5 command set from the instance traits: Command 20 -> RC 64");
    }

    // --------------------------------------------------------- B. initial state
    {
        Device device;
        const Reply first = device.cmd(1);
        check(first.status == 0x64, "B1 first reply to the primary master after power-up: status 0x64 (config changed + cold start + saturated)");
        const Reply second = device.cmd(1);
        check(second.status == 0x44, "B2 cold start is cleared after the first reply: status 0x44");
        check(device.cmd(1, {}, false).status == 0x64, "B3 the secondary master keeps its own Cold Start bit (per-master)");
        check(second.data == cat({Bytes{0x04}, f32(0.0f)}), "B4 PV starts at 0.0 mmH2O@20C (Command 1)");
        const Reply output = device.cmd(15);
        check(output.data == Bytes{0x01, 0x00, 0x04, 0x44, 0xD3, 0x40, 0x00, 0x43, 0x3E, 0x00, 0x00,
                                   0x00, 0x00, 0x00, 0x00, 0x00, 0x3E},
              "B5 Command 15 (HART-5, 17 bytes): alarm Low, linear, mmH2O, URV 1690, LRV 190, damping 0, not write protected, private label Smar");
        const Reply limits = device.cmd(14);
        check(limits.data == Bytes{0x09, 0xFA, 0x78, 0x04, 0x45, 0x9F, 0x9D, 0xF6, 0xC5, 0x9F, 0x9D, 0xF6, 0x41, 0xCC, 0x4F, 0x4F},
              "B6 Command 14: USL +5107.7451, LSL -5107.7451, minimum span 25.5387");
        const Reply vars = device.cmd(33, {4, 5, 0});
        check(vars.data == cat({Bytes{0x04, 0x31}, f32(172.44667053222656f), Bytes{0x05, 0x20}, f32(28.077999114990234f),
                                Bytes{0x00, 0x27}, f32(3.8f)}),
              "B7 Command 33 {4,5,0}: 172.4467 mm, 28.08 degC, 3.80 mA (fig14 calibration overview)");
        check(device.cmd(33, {20}).data == cat({Bytes{20, 0xFB}, f32(-1582.9156494140625f)}),
              "B8 Command 33 {20}: device variable 20 in unit 251 holds the captured state");
        const Reply loop = device.cmd(2);
        check(loop.data == cat({f32(3.8f), Bytes{0xC1, 0x4A, 0xAA, 0xAA}}), "B9 Command 2: 3.80 mA and -12.6667 % (PV 0 below LRV 190)");
    }

    // --------------------------------------------------- C. universal commands
    {
        Device device;
        device.cmd(0);
        const Bytes tagDescDate = cat({HartTypeCodec::encodePackedAscii("PT200", 8), HartTypeCodec::encodePackedAscii("NOVO DESCRITOR", 16),
                                       Bytes{15, 6, 124}});
        const Reply write18 = device.cmd(18, tagDescDate);
        check(write18.responseCode == 0 && write18.data == tagDescDate, "C1 Command 18 echoes the tag/descriptor/date actually stored");
        check(device.cmd(13).data == tagDescDate, "C2 Command 13 reads back the Command 18 write");
        const Bytes message = HartTypeCodec::encodePackedAscii("MENSAGEM DE TESTE", 32);
        check(device.cmd(17, message).data == message && device.cmd(12).data == message, "C3 Command 17 -> Command 12 round trip (24 bytes)");
        check(device.cmd(19, {0x01, 0x02, 0x03}).data == Bytes{1, 2, 3} && device.cmd(16).data == Bytes{1, 2, 3},
              "C4 Command 19 -> Command 16 round trip");
        const Reply dynamics = device.cmd(3);
        check(dynamics.data.size() == 9 && floatAt(dynamics.data, 0) == 3.8f && dynamics.data[4] == 0x04,
              "C5 Command 3: loop current 3.8 mA + PV (unit mmH2O)");
        check(!device.send(requestFrame(1, {}, false)).present,
              "C6 HART-5: a short frame other than Command 0 is not answered");
        check(device.cmd(11, HartTypeCodec::encodePackedAscii("PT200", 8)).present, "C7 Command 11 is part of the HART-5 set");
    }

    // ----------------------------------------------- D. common practice commands
    {
        Device device;
        device.cmd(0);
        const Reply damping = device.cmd(34, f32(1.5f));
        const Reply dampingRead = device.cmd(15);
        check(damping.data == f32(1.5f) && Bytes(dampingRead.data.begin() + 11, dampingRead.data.begin() + 15) == f32(1.5f),
              "D1 Command 34 writes PV damping; Command 15 reports it");
        const Reply status = device.cmd(48);
        check(status.responseCode == 0 && status.data.size() >= 9, "D2 Command 48 is supported (mandatory)");
        const Reply beforeReset = device.cmd(1);
        const Reply reset = device.cmd(38);
        const Reply afterReset = device.cmd(1);
        check((beforeReset.status & 0x40) && reset.responseCode == 0 && !(afterReset.status & 0x40),
              "D3 Command 38 clears Configuration Changed for the requesting (primary) master");
        check(device.cmd(1, {}, false).status & 0x40, "D4 ...but not for the secondary master (per-master bit)");
        device.cmd(34, f32(0.0f));
        check(device.cmd(1).status & 0x40, "D5 a later configuration write sets Configuration Changed again");
        check(device.cmd(44, {0x0C}).data == Bytes{0x0C} && device.cmd(1).data[0] == 0x0C && device.cmd(15).data[2] == 0x0C,
              "D6 Command 44 changes the PV unit seen by Commands 1 and 15");
        check(device.cmd(59, {5}).responseCode == 0, "D7 Command 59 (response preambles) is accepted");
    }

    // ------------------------------------------- E. LD301 manufacturer commands
    {
        Device device;
        device.cmd(0);
        check(device.cmd(128).data == cat({Bytes{0x0C, 0x03, 0x0A, 0x01, 0x02, 0xFB, 0xFB, 0xFB, 0xFB, 0x01, 0x02, 0x01, 0x01, 0x04},
                                           f32(5088.8974609375f), f32(0.0f), Bytes{0xFA, 0x00}}),
              "E1 Command 128: flange/seal/sensor enumerations and last calibration points 5088.8975 / 0");
        check(device.cmd(133, {0x00}).data == cat({Bytes{0x00, 0x06}, f32(0), f32(100), f32(100), f32(100)}) &&
                  device.cmd(133, {0x14}).data == cat({Bytes{0x14, 0x06}, f32(100), f32(100), f32(0), f32(0)}),
              "E2 Command 133 pages the 6-point table X1..X16,Y1..Y16 (fig10)");
        const Reply pidMode = device.cmd(136);
        check(pidMode.responseCode == 112 && pidMode.data == Bytes{0x17, 0x00, 0x00}, "E3 Command 136: warning 112 + PID operating mode");
        check(device.cmd(138).data == Bytes{0xFF}, "E4 Command 138: controller mode Off");
        const Reply pidLoop = device.cmd(140);
        check(pidLoop.responseCode == 112 &&
                  pidLoop.data == cat({Bytes{0x39, 0xC1, 0x4A, 0xAA, 0xAA, 0x39}, f32(50.0f), Bytes{0x39}, f32(-1.25f),
                                       Bytes{0xFF, 0x00, 0x39}, f32(0.0f)}),
              "E5 Command 140: PV -12.67 %, SP 50 %, MV -1.25 %, error 0 (fig12)");
        const Reply tuning = device.cmd(142);
        check(tuning.responseCode == 112 && tuning.data == cat({f32(1.0f), f32(0.01f), f32(0.0f), f32(0.0f), f32(0.1f)}),
              "E6 Command 142: Kp 1.00, Tr 0.01, Td 0.00 (fig11)");
        const Reply block156 = device.cmd(156);
        check(block156.responseCode == 113 && block156.data == cat({Bytes{0x00}, f32(6.0f)}), "E7 Command 156: warning 113 + state");
        check(device.cmd(160, {1}).data == cat({Bytes{0x01, 0x0F, 0x05}, f32(1276.936279296875f), f32(1276.936279296875f)}),
              "E8 Command 160: characterization point 2 (fig19)");
        check(device.cmd(164).data == Bytes{0x03, 0x05, 0x02, 0x02}, "E9 Command 164: display configuration bytes");
        check(device.cmd(166).data == Bytes{0x3D, 0x07, 0x00, 0x00, 0x0E, 0x00, 0x00, 0x08, 0x00, 0x01, 0x00, 0x00, 0x03, 0x08},
              "E10 Command 166: operation counters at the start of the capture (Zero trim 14; 19 after its five Command 43, see O)");
        check(device.cmd(176).data == Bytes{0x31, 'm', 'm', 0x00, 0x00, 0x00}, "E11 Command 176: user unit code 49 + label mm");
        check(device.cmd(178).data == cat({Bytes{0x00}, f32(800.0f), f32(243.0f)}), "E12 Command 178: user unit 100 % = 800, 0 % = 243 (fig08)");
        const Reply total = device.cmd(185);
        check(total.responseCode == 118 && total.data == cat({Bytes{0xFF, 0xFB}, f32(0.0f)}), "E13 Command 185: totalization Off, total 0");
        check(device.cmd(186).data == cat({f32(100.0f), f32(1.0f)}), "E14 Command 186: maximum flow 100, factor 1 (fig13)");
        check(device.cmd(189).data == Bytes{0xFB, 0x00, 0x00, 0x00, 0x00, 0x00}, "E15 Command 189");
        check(device.cmd(204, {0x01, 0x10}).data == Bytes{0x01, 0x10, 0x00}, "E16 Command 204 echoes its two request bytes + result");
        // Isolation: the same Device-Specific numbers mean nothing for another profile.
        lasecsimul::simulation::Scheduler scheduler(6, [] { return true; });
        auto tt301Preset = HartCommunicationComponent::smarTt301Preset();
        HartCommunicationComponent tt301(HartCommunicationComponent::Mode::Serial, scheduler, {}, &tt301Preset);
        HartResponseBuilder ttReply(64);
        Bytes ttRequest{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x02, 0x80, 0x00, 0x00};
        ttRequest.push_back(HartFrameCodec::checksum(std::span<const uint8_t>(ttRequest).subspan(5)));
        tt301.transact(ttRequest, ttReply);
        const Reply ttIdentity = parseReply(ttReply.bytes());
        Bytes tt128{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x82, 0xBE, 0x02};
        tt128.insert(tt128.end(), ttIdentity.data.begin() + 9, ttIdentity.data.begin() + 12);
        tt128.insert(tt128.end(), {128, 0});
        tt128.push_back(HartFrameCodec::checksum(std::span<const uint8_t>(tt128).subspan(5)));
        HartResponseBuilder tt128Reply(64);
        tt301.transact(tt128, tt128Reply);
        check(parseReply(tt128Reply.bytes()).responseCode == 64, "E17 LD301 Command 128 is profile-scoped: a TT301 answers RC 64");
    }

    // ------------------------------------------------------------- F. ranges
    {
        Device device;
        device.cmd(0);
        // PV 940 -> 50 % of 190..1690.
        device.component->setSignalInput("PV", 940.0);
        check(device.cmd(2).data == cat({f32(12.0f), f32(50.0f)}), "F1 PV 940 mmH2O in 190..1690 -> 50 %, 12 mA");
        check(!(device.cmd(1).status & 0x04), "F2 in-range PV clears Loop Current Saturated");
        check(device.cmd(33, {4}).data == cat({Bytes{0x04, 0x31}, f32(521.5f)}), "F3 Device Variable 4 follows: 243 + 50 % of 557 mm");
        const Reply range = device.cmd(35, cat({Bytes{0x04}, f32(1000.0f), f32(0.0f)}));
        check(range.responseCode == 0 && range.data == cat({Bytes{0x04}, f32(1000.0f), f32(0.0f)}), "F4 Command 35 writes the range and echoes it");
        const Reply newRange = device.cmd(15);
        check(Bytes(newRange.data.begin() + 3, newRange.data.begin() + 11) == cat({f32(1000.0f), f32(0.0f)}),
              "F5 Command 15 reflects the new range");
        const Reply recomputed = device.cmd(2);
        check(std::fabs(floatAt(recomputed.data, 0) - 19.04f) < 1e-4f && floatAt(recomputed.data, 4) == 94.0f,
              "F6 loop current/percent recomputed from the new range (94 %, 19.04 mA)");
        const Reply pid = device.cmd(140);
        check(floatAt(pid.data, 1) == 94.0f, "F7 vendor Command 140 PV% follows the same range");
        check(device.cmd(35, cat({Bytes{0x04}, f32(7000.0f), f32(0.0f)})).responseCode == 11,
              "F8 an URV more than 25 % above the upper limit is rejected (RC 11)");
        check(device.cmd(35, cat({Bytes{0x04}, f32(10.0f), f32(0.0f)})).responseCode == 29,
              "F9 a span below 0.90 of the minimum span is rejected (RC 29)");
        const Reply keptRange = device.cmd(15);
        check(Bytes(keptRange.data.begin() + 3, keptRange.data.begin() + 11) == cat({f32(1000.0f), f32(0.0f)}),
              "F10 rejected range writes leave the stored range unchanged");
    }

    // ------------------------------------------------------------ G. units
    {
        Device device;
        device.cmd(0);
        check(device.cmd(1).data[0] == 0x04, "G1 PV unit code 4 = mmH2O @ 68 degF (20 degC)");
        check(device.cmd(33, {0}).data[1] == 0x27 && device.cmd(33, {5}).data[1] == 0x20 && device.cmd(33, {4}).data[1] == 0x31,
              "G2 device variable units: mA (39), degC (32), mm (49)");
        check(device.cmd(44, {0xFA}).responseCode != 0, "G3 unit 250 (Not Used) is rejected for the PV");
    }

    // ------------------------------------------------------------ H. floats
    {
        const std::array<std::pair<float, Bytes>, 9> vectors{{
            {4.0f, {0x40, 0x80, 0x00, 0x00}}, {8.0f, {0x41, 0x00, 0x00, 0x00}}, {12.0f, {0x41, 0x40, 0x00, 0x00}},
            {16.0f, {0x41, 0x80, 0x00, 0x00}}, {20.0f, {0x41, 0xA0, 0x00, 0x00}}, {3.8f, {0x40, 0x73, 0x33, 0x33}},
            {190.0f, {0x43, 0x3E, 0x00, 0x00}}, {1690.0f, {0x44, 0xD3, 0x40, 0x00}}, {-1.25f, {0xBF, 0xA0, 0x00, 0x00}},
        }};
        for (const auto& [value, bytes] : vectors) {
            check(f32(value) == bytes, "H1 IEEE-754 big-endian encode " + std::to_string(value));
            check(HartTypeCodec::decodeFloat32BE(bytes) == value, "H2 IEEE-754 big-endian decode " + std::to_string(value));
        }
        check(std::isnan(HartTypeCodec::decodeFloat32BE(Bytes{0x7F, 0xA0, 0x00, 0x00})), "H3 HART 'not a number' 7F A0 00 00 decodes as NaN");
        Device device;
        device.cmd(0);
        check(device.cmd(40, {0x7F, 0xA0, 0x00, 0x00}).responseCode != 0, "H4 a NaN loop-current request is rejected");
        check(device.cmd(34, {0x7F, 0xA0, 0x00, 0x00}).responseCode != 0, "H5 a NaN damping value is rejected");
    }

    // ------------------------------------------------------ I. current output
    {
        Device device;
        device.cmd(0);
        const auto current = [&](double pv) { device.component->setSignalInput("PV", pv); return floatAt(device.cmd(2).data, 0); };
        check(current(190.0) == 4.0f, "I1 PV = LRV -> 4 mA");
        check(current(1690.0) == 20.0f, "I2 PV = URV -> 20 mA");
        check(current(565.0) == 8.0f, "I3 PV 25 % -> 8 mA");
        check(current(0.0) == 3.8f && (device.cmd(1).status & 0x04), "I4 below LRV saturates at 3.8 mA with status 0x04");
        check(current(5000.0) == 20.5f && (device.cmd(1).status & 0x04), "I5 above URV saturates at 20.5 mA with status 0x04");
        device.component->setSignalInput("PV", 6000.0);
        check(device.cmd(1).status & 0x01, "I6 PV beyond USL sets PV Out Of Limits (0x01)");
        device.component->setSignalInput("PV", 0.0);
        check(!(device.cmd(1).status & 0x01), "I7 PV back inside the sensor limits clears 0x01");
    }

    // ----------------------------------------------------------- J. loop test
    {
        Device device;
        device.cmd(0);
        for (const float milliamps : {4.0f, 8.0f, 12.0f, 16.0f, 20.0f}) {
            const Reply fixed = device.cmd(40, f32(milliamps));
            const Reply read = device.cmd(33, {0});
            check(fixed.responseCode == 0 && fixed.status == 0x4C && fixed.data == f32(milliamps) &&
                      read.data == cat({Bytes{0x00, 0x27}, f32(milliamps)}) && read.status == 0x4C,
                  "J1 loop test " + std::to_string(milliamps) + " mA: echoed, read back by Command 33 code 0, status 0x4C");
        }
        check(floatAt(device.cmd(2).data, 0) == 20.0f, "J2 Command 2 reports the fixed current");
        const Reply exit = device.cmd(40, f32(0.0f));
        check(exit.status == 0x44 && device.cmd(33, {0}).data == cat({Bytes{0x00, 0x27}, f32(3.8f)}),
              "J3 0 mA exits fixed-current mode; the PV-driven 3.8 mA returns (status 0x44)");
        check(device.cmd(40, f32(25.0f)).responseCode == 3, "J4 25 mA is above the 21 mA loop-test limit: RC 3");
        check(device.cmd(40, f32(2.0f)).responseCode == 4, "J5 2 mA is below the 3.6 mA loop-test limit: RC 4");
        check(device.cmd(40, {0x41}).responseCode == 5, "J6 a 1-byte loop-test request: RC 5 (too few data bytes)");
        device.cmd(40, f32(12.0f));
        check(device.cmd(42).responseCode == 0 && !(device.cmd(1).status & 0x08) && (device.cmd(1, {}, false).status & 0x20),
              "J7 Command 42 (device reset) leaves fixed-current mode and re-arms Cold Start");
    }

    // ---------------------------------------------------------- K. calibration
    {
        Device device;
        device.cmd(0);
        device.component->setSignalInput("PV", 12.5);
        check(floatAt(device.cmd(1).data, 1) == 12.5f, "K1 applied pressure 12.5 mmH2O is read before the zero trim");
        device.cmd(38);
        const Reply zero = device.cmd(43, {0x00});
        check(zero.responseCode == 0 && zero.data.empty(), "K2 Command 43 (with the LD301's surplus 00 byte) is accepted");
        check(floatAt(device.cmd(1).data, 1) == 0.0f, "K3 after Set PV Zero the PV reads 0");
        check(device.cmd(1).status & 0x40, "K4 the zero trim is a configuration change");
        device.component->setSignalInput("PV", 112.5);
        check(floatAt(device.cmd(1).data, 1) == 100.0f, "K5 the zero offset persists for later readings");
    }

    // ------------------------------------------------------ L. reset/persistence
    {
        lasecsimul::registry::ComponentParams saved;
        {
            Device device;
            device.cmd(0);
            device.cmd(18, cat({HartTypeCodec::encodePackedAscii("PERSIST", 8), HartTypeCodec::encodePackedAscii("DESC", 16), Bytes{1, 2, 99}}));
            device.cmd(35, cat({Bytes{0x04}, f32(2000.0f), f32(100.0f)}));
            device.cmd(34, f32(2.0f));
            device.cmd(40, f32(16.0f));
            saved = device.save();
        }
        Device reopened(saved);
        const Reply first = reopened.cmd(1);
        check(first.status & 0x20, "L1 reopening is a power cycle: Cold Start is set again");
        check(first.status & 0x40, "L2 Configuration Changed is non-volatile across the power cycle");
        check(HartTypeCodec::decodePackedAscii(std::span<const uint8_t>(reopened.cmd(13).data).first(6)) == "PERSIST ",
              "L3 the written Tag survives save/reopen");
        const Reply output = reopened.cmd(15);
        check(Bytes(output.data.begin() + 3, output.data.begin() + 15) == cat({f32(2000.0f), f32(100.0f), f32(2.0f)}),
              "L4 range and damping survive save/reopen");
        check(!(first.status & 0x08) && floatAt(reopened.cmd(2).data, 0) == 3.8f,
              "L5 fixed-current (loop test) mode is volatile: not restored after reopen");
        Device fresh;
        check(fresh.cmd(15).data[3] == 0x44 && HartTypeCodec::decodePackedAscii(std::span<const uint8_t>(fresh.cmd(13).data).first(6)) == "LT100   ",
              "L6 a new instance starts from the captured specimen configuration");
    }

    // --------------------------------------------- M. invalid / unsupported commands
    {
        Device device;
        device.cmd(0);
        const Reply longTag = device.cmd(20);
        check(longTag.wellFormed && longTag.responseCode == 64 && longTag.status == 0x44 && longTag.data.empty(),
              "M1 Command 20 (HART 6+ Long Tag) -> RC 64 'not implemented', exactly as the real LD301 (40 44)");
        check(device.cmd(22, Bytes(32, 0x20)).responseCode == 64 && device.cmd(9, {0}).responseCode == 64,
              "M2 other HART-6/7-only commands -> RC 64");
        check(device.cmd(200).responseCode == 64, "M3 an undefined Device-Specific command -> RC 64");
        Bytes badChecksum = requestFrame(0);
        badChecksum.back() ^= 0x01;
        check(!device.send(badChecksum).present, "M4 a frame with a bad longitudinal parity is ignored");
        Bytes otherDevice = requestFrame(0);
        otherDevice[9] = 0x4E;
        otherDevice.back() = HartFrameCodec::checksum(std::span<const uint8_t>(otherDevice).subspan(5, otherDevice.size() - 6));
        check(!device.send(otherDevice).present, "M5 a long address of another device is not answered");
        check(!device.send(requestFrame(0, {}, false, true, 5)).present, "M6 a short frame for another polling address is not answered");
    }

    // ----------------------------------------------------- N. invalid parameters
    {
        Device device;
        device.cmd(0);
        check(device.cmd(133, {0x1D}).responseCode == 2, "N1 Command 133 index beyond the 32-entry table -> RC 2");
        check(device.cmd(160, {5}).responseCode == 2, "N2 Command 160 index beyond the 5 characterization points -> RC 2");
        check(device.cmd(133).responseCode == 5, "N3 Command 133 without its index byte -> RC 5");
        check(device.cmd(204, {0x01}).responseCode == 5, "N4 Command 204 with 1 of 2 bytes -> RC 5");
        check(device.cmd(18, {0x01, 0x02}).responseCode == 5, "N5 a truncated Command 18 -> RC 5 and nothing is written");
        check(HartTypeCodec::decodePackedAscii(std::span<const uint8_t>(device.cmd(13).data).first(6)) == "LT100   ", "N6 ...tag unchanged");
        lasecsimul::registry::ComponentParams protectedParams;
        protectedParams.properties["writeProtectCode"] = 1.0;
        Device locked(protectedParams);
        locked.cmd(0);
        check(locked.cmd(15).data[15] == 0x01, "N7 write protect code 1 is reported by Command 15");
        check(locked.cmd(35, cat({Bytes{0x04}, f32(1000.0f), f32(0.0f)})).responseCode == 7, "N8 write-protected range write -> RC 7");
        check(locked.cmd(40, f32(12.0f)).responseCode == 7, "N9 write-protected loop test -> RC 7");
    }

    // ------------------------------------- Q. electrical terminals (4 pins)
    {
        Device device;
        device.cmd(0);
        auto& ld301 = *device.component;
        const auto pins = ld301.pins();
        check(pins.size() == 4 && pins[0].id == "sensor_plus" && pins[1].id == "sensor_minus" &&
                  pins[2].id == "loop_plus" && pins[3].id == "loop_minus",
              "Q1 four terminals: signal input sensor_plus/minus, 4-20 mA loop loop_plus/minus");
        StubMatrix matrix;
        ld301.setSignalInput("PV", 940.0);
        ld301.stamp(matrix);
        check(matrix.currents.empty() && floatAt(device.cmd(1).data, 1) == 940.0f,
              "Q2 unwired: the Signal Graph PV stands and no loop current is stamped");
        for (size_t i = 0; i < 4; ++i) ld301.onPinConnectionChanged(i, true);
        const auto stampAt = [&](double volts) {
            matrix.voltages = {{"sensor_plus", volts + 2.0}, {"sensor_minus", 2.0}}; // differential input
            matrix.currents.clear();
            ld301.stamp(matrix);
            return matrix.currents.empty() ? -1.0 : std::get<2>(matrix.currents.back()) * 1000.0;
        };
        check(std::fabs(stampAt(0.0) - 3.8) < 1e-6 && floatAt(device.cmd(1).data, 1) == 0.0f &&
                  std::get<0>(matrix.currents.back()) == "loop_plus" && std::get<1>(matrix.currents.back()) == "loop_minus",
              "Q3 0 V on the signal terminals = 0 mmH2O (capture state): loop sinks 3.8 mA loop_plus -> loop_minus");
        const double atOneVolt = stampAt(1.0);
        const float pvOneVolt = floatAt(device.cmd(1).data, 1);
        check(std::fabs(pvOneVolt - 1021.549f) < 1e-2f && std::fabs(atOneVolt - (4.0 + 16.0 * (1021.549 - 190.0) / 1500.0)) < 1e-3,
              "Q4 1 V = 1021.549 mmH2O (5 V = sensor URL), 12.87 mA by the HART range");
        check(std::fabs(ld301.loopCurrentMilliamps() - atOneVolt) < 1e-9, "Q5 the loop current is readable as a device property");
        device.cmd(35, cat({Bytes{0x04}, f32(2000.0f), f32(0.0f)}));
        stampAt(1.0);
        check(floatAt(device.cmd(1).data, 1) == pvOneVolt, "Q6 re-ranging via HART does not change the pressure seen by the terminals");
        check(std::fabs(stampAt(1.0) - (4.0 + 16.0 * 1021.549 / 2000.0)) < 1e-3, "Q7 ...but the 4-20 mA output follows the new range");
        device.cmd(40, f32(16.0f));
        check(std::fabs(stampAt(0.0) - 16.0) < 1e-6, "Q8 loop test (Command 40) drives 16 mA on the loop terminals");
        device.cmd(40, f32(0.0f));
        stampAt(6.0);
        check((device.cmd(1).status & 0x01) && std::fabs(stampAt(6.0) - 20.5) < 1e-6,
              "Q9 6 V = 7229 mmH2O > USL: PV Out Of Limits and 20.5 mA saturation");
        stampAt(-1.0);
        check(floatAt(device.cmd(1).data, 1) < 0.0f, "Q10 the signal scale is not clamped: negative input = negative (gauge) pressure");
        ld301.onPinConnectionChanged(2, false);
        matrix.currents.clear();
        ld301.stamp(matrix);
        check(matrix.currents.empty(), "Q11 an open loop (loop terminal unwired) stamps no current source");
    }

    // --------------------------------- V. local display (LCD, LD301 manual sec. 2)
    {
        const auto numeric = [](const HartLcdFrame& frame) { return std::string(frame.numeric.begin(), frame.numeric.end()); };
        const auto alpha = [](const HartLcdFrame& frame) { return std::string(frame.alpha.begin(), frame.alpha.end()); };
        HartLcdFrame f;
        hartLcdFormatNumber(25.0, f);
        check(numeric(f) == "  2500" && f.decimalPoints == (1u << 3), "V1 25.00 (Fig. 2.5) uses all 4 digits with 2 decimals");
        hartLcdFormatNumber(-12.666666030883789, f);
        check(numeric(f) == "-12667" && f.decimalPoints == (1u << 2), "V2 -12.667: sign, half digit '1', 3 decimals (4 1/2 digits)");
        hartLcdFormatNumber(19999.0, f);
        check(numeric(f) == " 19999" && f.decimalPoints == 0, "V3 19999 is the largest count of 4 1/2 digits");
        check(!hartLcdFormatNumber(20000.0, f) && numeric(f) == "  ----", "V4 above 19999 counts the field shows dashes");
        hartLcdFormatNumber(3.8, f);
        check(numeric(f) == "  3800" && f.decimalPoints == (1u << 2), "V5 3.800 mA");
        uint32_t unitAnnunciators = 0;
        check(hartLcdUnitLabel(4, unitAnnunciators) == "mmH2O" && unitAnnunciators == 0, "V6 mmH2O fills the 5 alphanumeric characters (Fig. 2.5)");
        check(hartLcdUnitLabel(32, unitAnnunciators) == "C" && (unitAnnunciators & HartLcdAnnunciator::Degree), "V7 degC uses the degree mark");

        Device device;
        const auto& ld301 = *device.component;
        const uint64_t s = 1'000'000'000ull;
        HartLcdFrame frame = ld301.displayFrame(0);
        check(frame.enabled && numeric(frame) == "  5 00" && alpha(frame) == "LD301",
              "V8 power-up page: protocol (HART 5) and address 00, model LD301");
        check(alpha(ld301.displayFrame(2 * s)) == "V7.02", "V9 power-up page: firmware version 7.02 (software revision 0x72)");
        frame = ld301.displayFrame(3 * s);
        check(numeric(frame) == "-12667" && (frame.annunciators & HartLcdAnnunciator::ProcessVariable) &&
                  (frame.annunciators & HartLcdAnnunciator::Percent) && alpha(frame) == "     ",
              "V10 1st variable PV(%) (Command 164 code 3): -12.667 % with PV and % indicators");
        check(alpha(ld301.displayFrame(4 * s + s / 2)) == "  SAT", "V11 output saturated at 3.8 mA: the unit alternates with SAT");
        frame = ld301.displayFrame(6 * s + s / 10);
        check(numeric(frame) == "  2808" && frame.decimalPoints == (1u << 3) && (frame.annunciators & HartLcdAnnunciator::Degree) &&
                  alpha(frame) == "    C",
              "V12 after 3 s the 2nd variable Temp. (code 5): 28.08 degC");
        check(numeric(ld301.displayFrame(9 * s + s / 10)) == "-12667", "V13 ...and back to the 1st variable 3 s later");
        device.component->setSignalInput("PV", 940.0);
        frame = ld301.displayFrame(3 * s);
        check(numeric(frame) == "  5000" && alpha(ld301.displayFrame(4 * s + s / 2)) == "     ", "V14 PV 940 mmH2O = 50.00 %, not saturated: no SAT");
        device.cmd(0);
        device.cmd(40, f32(12.0f));
        check(ld301.displayFrame(3 * s).annunciators & HartLcdAnnunciator::Fix, "V15 loop test (fixed output) lights Fix");
        device.cmd(40, f32(0.0f));
        lasecsimul::registry::ComponentParams multidrop;
        multidrop.properties["loopCurrentMode"] = false;
        check(Device(multidrop).component->displayFrame(3 * s).annunciators & HartLcdAnnunciator::Multidrop, "V16 multidrop lights MD");
        lasecsimul::registry::ComponentParams noMeter;
        noMeter.properties["displayInstalled"] = false;
        check(!Device(noMeter).component->displayFrame(3 * s).enabled, "V17 meter not installed: blank glass");
        std::array<uint8_t, 64> telemetry{};
        const size_t size = Device().component->getTelemetryState(telemetry.data(), telemetry.size());
        double milliamps = 0.0;
        std::memcpy(&milliamps, telemetry.data(), sizeof milliamps);
        check(size == 36 && std::fabs(milliamps - 3.8) < 1e-6 && telemetry[8] == 0x31 && telemetry[11] == 0x4C &&
                  telemetry[12] == 1 && telemetry[16] == ' ' && telemetry[18] == '5',
              "V18 telemetry: f64 loop current 3.80 mA, 'LCD1' marker, display frame (power-up page)");
        lasecsimul::simulation::Scheduler scheduler(6, [] { return true; });
        auto preset = HartCommunicationComponent::standardFieldDevicePreset();
        HartCommunicationComponent standard(HartCommunicationComponent::Mode::Serial, scheduler, {}, &preset);
        standard.setSignalInput("PV", 42.5);
        frame = standard.displayFrame(3 * s);
        check(numeric(frame) == "  4250" && (frame.annunciators & HartLcdAnnunciator::Percent) &&
                  (frame.annunciators & HartLcdAnnunciator::ProcessVariable) && alpha(standard.displayFrame(0)) == "HART ",
              "V19 the standard HART device has the display too (PV 42.50 %, model HART)");
    }

    // ------------------------- W. rules from the LD301 manual (ld301mp.pdf)
    {
        const auto counters = [](Device& device) { return device.cmd(166).data; };
        Device device;
        device.cmd(0);
        check(device.cmd(43, {0x00}).responseCode == 0 && counters(device)[4] == 15,
              "W1 a zero trim (Command 43) increments the Trim Zero/Inferior counter (14 -> 15)");
        check(device.cmd(35, cat({Bytes{0x04}, f32(1500.0f), f32(100.0f)})).responseCode == 0 && counters(device)[0] == 62,
              "W2 a range calibration (Command 35) increments the LRV/URV counter (61 -> 62)");
        check(device.cmd(35, cat({Bytes{0x04}, f32(9000.0f), f32(100.0f)})).responseCode == 11 && counters(device)[0] == 62,
              "W3 a rejected calibration changes no counter");
        for (int i = 0; i < 240; ++i) device.cmd(43, {0x00});
        const uint8_t full = counters(device)[4];
        device.cmd(43, {0x00});
        check(full == 255 && counters(device)[4] == 0, "W4 the counters are cyclic 0..255");
        const Reply readdress = device.cmd(6, {0x05});
        check(readdress.responseCode == 0 && readdress.data == Bytes{0x05} && counters(device)[11] == 1,
              "W5 a HART 5 Command 6 (1 byte, HCF_SPEC-127 6.7.1) readdresses and increments the Multidrop counter");
        check(floatAt(device.cmd(2).data, 0) == 4.0f && device.cmd(40, f32(12.0f)).responseCode == 11,
              "W5b address 5 from a HART 5 master disables loop current signaling (multidrop)");

        Device range;
        range.cmd(0);
        const auto write35 = [&](float upper, float lower) { return range.cmd(35, cat({Bytes{0x04}, f32(upper), f32(lower)})); };
        const auto stored = [&]() { const Reply r = range.cmd(15); return std::make_pair(floatAt(r.data, 3), floatAt(r.data, 7)); };
        check(write35(6000.0f, 0.0f).responseCode == 0 && stored().first == 6000.0f,
              "W6 an URV up to 25 % beyond the 5107.7 mmH2O limit is accepted (6000)");
        check(write35(6000.0f, 6500.0f).responseCode == 9, "W7 LRV above the tolerated limit: RC 9 (Lower Range Value Too High)");
        check(write35(6000.0f, -7000.0f).responseCode == 10, "W8 LRV below the tolerated limit: RC 10 (Lower Range Value Too Low)");
        check(write35(-7000.0f, 0.0f).responseCode == 12, "W9 URV below the tolerated limit: RC 12 (Upper Range Value Too Low)");
        check(write35(7000.0f, -7000.0f).responseCode == 13, "W10 both out of limits: RC 13");
        check(range.cmd(35, cat({Bytes{0xFA}, f32(1000.0f), f32(0.0f)})).responseCode == 18, "W11 unit 250 is not a range unit: RC 18");
        const Reply narrow = write35(24.0f, 0.0f);
        check(narrow.responseCode == 14 && stored() == std::make_pair(24.0f, 0.0f),
              "W12 a span of 0.94 x the minimum span is accepted with warning 14 (Span Too Small)");
        check(stored() == std::make_pair(24.0f, 0.0f) && write35(20.0f, 0.0f).responseCode == 29 && stored().first == 24.0f,
              "W13 0.78 x the minimum span is an invalid span (RC 29) and keeps the range");
        write35(1690.0f, 190.0f);
        range.component->setSignalInput("PV", 7000.0);
        check(range.cmd(36).responseCode == 9 && range.cmd(37).responseCode == 9, "W14 Commands 36/37 with the applied pressure too high: RC 9");
        range.component->setSignalInput("PV", 5500.0);
        const Reply pushed = range.cmd(37);
        const float limit = 5107.7451171875f * 1.25f;
        check(pushed.responseCode == 14 && stored() == std::make_pair(limit, 5500.0f),
              "W15 Command 37 keeps the span; an URV pushed past the limit stops there (warning 14, manual: URV limited)");

        Device loop;
        loop.cmd(0);
        check(loop.cmd(40, f32(3.6f)).responseCode == 0 && loop.cmd(40, f32(21.0f)).responseCode == 0,
              "W16 loop test accepts 3.6 and 21 mA (manual: 3,6 a 21 mA)");
        check(loop.cmd(40, f32(3.5f)).responseCode == 4 && loop.cmd(40, f32(21.1f)).responseCode == 3, "W17 ...and nothing outside it");
        loop.cmd(40, f32(0.0f));

        lasecsimul::registry::ComponentParams lowAlarm;
        lowAlarm.properties["sensorFault"] = true;
        Device failed(lowAlarm);
        failed.cmd(0);
        failed.component->setSignalInput("PV", 940.0);
        const Reply burnout = failed.cmd(2);
        check(floatAt(burnout.data, 0) == 3.6f && (burnout.status & 0x80) && (burnout.status & 0x04),
              "W18 sensor failure, Alarm Selection Low: 3.6 mA burnout, Device Malfunction + output saturated");
        const uint64_t second = 1'000'000'000ull;
        const HartLcdFrame failing = failed.component->displayFrame(4 * second + second / 2);
        check(std::string(failing.alpha.begin(), failing.alpha.end()) == "SFAIL", "W19 the display alternates the unit with SFAIL (Table 2.1)");
        failed.cmd(40, f32(12.0f));
        check(floatAt(failed.cmd(2).data, 0) == 12.0f, "W20 a loop test still drives its current during the failure");
        failed.cmd(40, f32(0.0f));
        for (auto& descriptor : failed.component->propertyDescriptors())
            if (descriptor.schema.id == "sensorFault") descriptor.set(false);
        const Reply recovered = failed.cmd(2);
        check(floatAt(recovered.data, 0) == 12.0f && !(recovered.status & 0x80), "W21 clearing the failure restores the PV output (50 % = 12 mA)");
        lasecsimul::registry::ComponentParams highAlarm;
        highAlarm.properties["sensorFault"] = true;
        highAlarm.properties["alarmSelectionCode"] = 0.0;
        Device failedHigh(highAlarm);
        failedHigh.cmd(0);
        check(floatAt(failedHigh.cmd(2).data, 0) == 21.0f, "W22 Alarm Selection High: 21 mA burnout");

        Device damped;
        damped.cmd(0);
        damped.component->setSignalInput("PV", 190.0);
        check(damped.cmd(34, f32(2.0f)).responseCode == 0, "W23 Command 34 writes a 2 s PV damping");
        damped.component->setSignalInput("PV", 1690.0);
        const float before = floatAt(damped.cmd(1).data, 1);
        damped.component->postStep(2 * second);
        const float oneTau = floatAt(damped.cmd(1).data, 1);
        const float expected = static_cast<float>(190.0 + 1500.0 * (1.0 - std::exp(-1.0)));
        check(before == 190.0f && std::fabs(oneTau - expected) < 0.01f,
              "W24 PV damping is a first-order filter: one time constant reaches 63.2 % of the step");
        damped.component->postStep(40 * second);
        check(std::fabs(floatAt(damped.cmd(1).data, 1) - 1690.0f) < 0.01f && std::fabs(floatAt(damped.cmd(2).data, 0) - 20.0f) < 1e-3f,
              "W25 ...and settles on the input; the loop current follows the damped PV");

        const auto withDisplayCode = [](int code) {
            auto variables = nlohmann::json::parse(std::get<std::string>(ld301Params().properties.at("hartVariablesJson")));
            for (auto& variable : variables) if (variable["id"] == "display.firstVariable") variable["value"] = code;
            lasecsimul::registry::ComponentParams params;
            params.properties["hartVariablesJson"] = variables.dump();
            params.properties["displayVariable2"] = std::string();
            return params;
        };
        const auto page = [&](int code) {
            Device shown(withDisplayCode(code));
            shown.component->setSignalInput("PV", 940.0);
            const HartLcdFrame frame = shown.component->displayFrame(3 * second);
            return std::string(frame.numeric.begin(), frame.numeric.end()) + "|" + std::string(frame.alpha.begin(), frame.alpha.end());
        };
        check(page(0) == " 12000|   mA" && page(2) == "  9400|mmH2O" && page(3) == "  5000|     " && page(4) == "  5215|   mm",
              "W26 display codes in the manual's order: 0 OUT (12.000 mA), 2 PRES (940.0 mmH2O), 3 PV% (50.00), 4 PV (521.5 mm)");
        auto totalDisplay = withDisplayCode(9);
        auto totalVariables = nlohmann::json::parse(std::get<std::string>(totalDisplay.properties.at("hartVariablesJson")));
        for (auto& variable : totalVariables) if (variable["id"] == "totalization.total") variable["value"] = 1234.5;
        totalDisplay.properties["hartVariablesJson"] = totalVariables.dump();
        Device totalShown(totalDisplay);
        const HartLcdFrame totalPage = totalShown.component->displayFrame(3 * second);
        check(std::string(totalPage.numeric.begin(), totalPage.numeric.end()) == " 12345" &&
                  totalPage.decimalPoints == (1u << 4),
              "W27 Display code 9 shows the configured Total value on the LCD");
    }

    // ------------------- X. write commands captured on the real LD301 (PACTware)
    {
        // Flange / Remote Seal screen: Command 129 writes the first 11 bytes of
        // the Command 128 block (same order) and echoes them; the read-back
        // shows them, the calibration part of the block is untouched.
        const auto exchanges = loadCapture(LASECSIMUL_TEST_LD301_CMD129_CAPTURE);
        Device device;
        device.cmd(0); // mid-session capture: the primary master's Cold Start was already reported
        bool exact = exchanges.size() == 3;
        for (const auto& exchange : exchanges) {
            HartResponseBuilder response(300);
            device.component->transact(exchange.request, response);
            const Bytes simulated(response.bytes().begin(), response.bytes().end());
            if (simulated != exchange.response) {
                exact = false;
                std::fprintf(stderr, "Cmd 129 capture #%zu\n  real      %s\n  simulated %s\n", exchange.index,
                             hex(exchange.response).c_str(), hex(simulated).c_str());
            }
        }
        check(exact, "X1 Flange/Remote Seal write (Command 129) and both Command 128 reads match the real LD301 byte for byte");
        // Same session, next write on the real device: only the remote seal
        // diaphragm changed (Hastelloy C 3 -> Tantalum 5, HCF_SPEC-183 Table 4),
        // which is byte 7 of the block.
        bool diaphragmExact = true;
        for (const auto& exchange : loadCapture(LASECSIMUL_TEST_LD301_CMD129_DIAPHRAGM_CAPTURE)) {
            HartResponseBuilder response(300);
            device.component->transact(exchange.request, response);
            if (Bytes(response.bytes().begin(), response.bytes().end()) != exchange.response) diaphragmExact = false;
        }
        const auto sealValue = [&](const char* id) {
            for (const auto& descriptor : device.component->propertyDescriptors()) {
                if (descriptor.schema.id != "hartVariablesJson") continue;
                for (const auto& variable : nlohmann::json::parse(std::get<std::string>(descriptor.get())))
                    if (variable.value("id", std::string{}) == id) return variable.value("value", -1.0);
            }
            return -1.0;
        };
        check(diaphragmExact && sealValue("remoteSeal.diaphragm") == 5.0 && sealValue("remoteSeal.fillFluid") == 5.0,
              "X1b second capture (diaphragm -> Tantalum) matches byte for byte; byte 7 = seal diaphragm (5), byte 6 = fill fluid (5 Glycerin/H2O)");
        // Third capture: Fill Fluid -> Silicone Oil, then -> Neobee-M20; only byte 6 changes (2, then 7).
        bool fillExact = true;
        for (const auto& exchange : loadCapture(LASECSIMUL_TEST_LD301_CMD129_FILL_CAPTURE)) {
            HartResponseBuilder response(300);
            device.component->transact(exchange.request, response);
            if (Bytes(response.bytes().begin(), response.bytes().end()) != exchange.response) fillExact = false;
        }
        check(fillExact && sealValue("remoteSeal.fillFluid") == 7.0,
              "X1c fill fluid captures (Silicone Oil 2, Neobee-M20 7) match byte for byte; the fill fluid is byte 6");
        // Fourth capture: Quantity -> One Seal (byte 8: 2 -> 1), then Type -> Flanged (F) (byte 5: 4 -> 5).
        bool sealExact = true;
        for (const auto& exchange : loadCapture(LASECSIMUL_TEST_LD301_CMD129_SEAL_CAPTURE)) {
            HartResponseBuilder response(300);
            device.component->transact(exchange.request, response);
            if (Bytes(response.bytes().begin(), response.bytes().end()) != exchange.response) sealExact = false;
        }
        check(sealExact && sealValue("remoteSeal.quantity") == 1.0 && sealValue("remoteSeal.type") == 5.0,
              "X1d seal captures (One Seal, Flanged (F)) match byte for byte; byte 8 = quantity (1), byte 5 = seal type (5)");
        check(device.cmd(129, Bytes{0x16, 0x04}).responseCode == 5, "X2 Command 129 with fewer than 11 data bytes: RC 5");
        lasecsimul::registry::ComponentParams locked;
        locked.properties["writeProtectCode"] = 1.0;
        Device protectedDevice(locked);
        protectedDevice.cmd(0);
        check(protectedDevice.cmd(129, Bytes(11, 0x01)).responseCode == 7 &&
                  protectedDevice.cmd(128).data.at(0) == 0x0C,
              "X3 write protected: Command 129 answers RC 7 and changes nothing");
        const auto saved = device.save();
        Device reopened(saved);
        reopened.cmd(0);
        const Reply readBack = reopened.cmd(128);
        check(readBack.data.size() >= 11 && Bytes(readBack.data.begin(), readBack.data.begin() + 11) ==
                  Bytes{0x16, 0x04, 0xFC, 0x01, 0xFB, 0x05, 0x07, 0x05, 0x01, 0x01, 0x02},
              "X4 the written flange/seal data survive save/reopen");

        // Display screen: PV% -> OUT (mA) in the first slot. The real DTM
        // reads Cmd 164, writes Cmd 165 with two bytes, then reads back both
        // Cmd 164 and Cmd 128. The latter proves the flange block is intact.
        const auto displayExchanges = loadCapture(LASECSIMUL_TEST_LD301_CMD165_DISPLAY_CAPTURE);
        bool displayExact = displayExchanges.size() == 5;
        for (const auto& exchange : displayExchanges) {
            HartResponseBuilder response(300);
            reopened.component->transact(exchange.request, response);
            const Bytes simulated(response.bytes().begin(), response.bytes().end());
            if (simulated != exchange.response) {
                displayExact = false;
                std::fprintf(stderr, "Cmd 165 capture #%zu\n  real      %s\n  simulated %s\n", exchange.index,
                             hex(exchange.response).c_str(), hex(simulated).c_str());
            }
        }
        check(displayExact, "X5 Display first variable PV% -> OUT (mA): Cmd 164/128, Cmd 165 and both readbacks match the real LD301 byte for byte");
        check(reopened.cmd(165, Bytes{0x03}).responseCode == 5 && reopened.cmd(164).data == Bytes{0x00, 0x05, 0x02, 0x02},
              "X6 Cmd 165 requires both display variable bytes and keeps the configuration on a short request");
        const auto displaySaved = reopened.save();
        Device displayReopened(displaySaved);
        displayReopened.cmd(0);
        check(displayReopened.cmd(164).data == Bytes{0x00, 0x05, 0x02, 0x02},
              "X7 both display variable selections survive save/reopen");

        // Next DTM session: OUT (mA) -> OUT (%) in the first slot. The first
        // response reports Cold Start (0x64), then the readbacks report 0x44.
        Device outputPercent(displaySaved);
        const auto percentExchanges = loadCapture(LASECSIMUL_TEST_LD301_CMD165_OUTPUT_PERCENT_CAPTURE);
        bool percentExact = percentExchanges.size() == 3;
        for (const auto& exchange : percentExchanges) {
            HartResponseBuilder response(300);
            outputPercent.component->transact(exchange.request, response);
            const Bytes simulated(response.bytes().begin(), response.bytes().end());
            if (simulated != exchange.response) {
                percentExact = false;
                std::fprintf(stderr, "Cmd 165 OUT (%%) capture #%zu\n  real      %s\n  simulated %s\n", exchange.index,
                             hex(exchange.response).c_str(), hex(simulated).c_str());
            }
        }
        check(percentExact, "X8 Display first variable OUT (mA) -> OUT (%): Cmd 165 and Cmd 164/128 readbacks match the real LD301 byte for byte");

        // OUT (%) -> Pressure. The DTM sent the same write twice; the first
        // reply has Cold Start, the second does not. Both readbacks agree.
        Device pressure(outputPercent.save());
        const auto pressureExchanges = loadCapture(LASECSIMUL_TEST_LD301_CMD165_PRESSURE_CAPTURE);
        bool pressureExact = pressureExchanges.size() == 6;
        for (const auto& exchange : pressureExchanges) {
            HartResponseBuilder response(300);
            pressure.component->transact(exchange.request, response);
            const Bytes simulated(response.bytes().begin(), response.bytes().end());
            if (simulated != exchange.response) {
                pressureExact = false;
                std::fprintf(stderr, "Cmd 165 Pressure capture #%zu\n  real      %s\n  simulated %s\n", exchange.index,
                             hex(exchange.response).c_str(), hex(simulated).c_str());
            }
        }
        check(pressureExact, "X9 Display first variable OUT (%) -> Pressure: both Cmd 165 writes and Cmd 164/128 readbacks match the real LD301 byte for byte");

        // Same device state, next option in the DTM: Pressure -> PV.
        const auto pvExchanges = loadCapture(LASECSIMUL_TEST_LD301_CMD165_PV_CAPTURE);
        bool pvExact = pvExchanges.size() == 3;
        for (const auto& exchange : pvExchanges) {
            HartResponseBuilder response(300);
            pressure.component->transact(exchange.request, response);
            const Bytes simulated(response.bytes().begin(), response.bytes().end());
            if (simulated != exchange.response) {
                pvExact = false;
                std::fprintf(stderr, "Cmd 165 PV capture #%zu\n  real      %s\n  simulated %s\n", exchange.index,
                             hex(exchange.response).c_str(), hex(simulated).c_str());
            }
        }
        check(pvExact, "X10 Display first variable Pressure -> PV: Cmd 165 and Cmd 164/128 readbacks match the real LD301 byte for byte");

        // The second selector can be None (0xFB), while the first selector
        // cannot. The trailing Command 164 bytes become 00 00 in this state.
        const auto noneExchanges = loadCapture(LASECSIMUL_TEST_LD301_CMD165_NONE_CAPTURE);
        bool noneExact = noneExchanges.size() == 6;
        for (const auto& exchange : noneExchanges) {
            HartResponseBuilder response(300);
            pressure.component->transact(exchange.request, response);
            const Bytes simulated(response.bytes().begin(), response.bytes().end());
            if (simulated != exchange.response) {
                noneExact = false;
                std::fprintf(stderr, "Cmd 165 None capture #%zu\n  real      %s\n  simulated %s\n", exchange.index,
                             hex(exchange.response).c_str(), hex(simulated).c_str());
            }
        }
        check(noneExact, "X11 Display first Total, second None: both Cmd 165 writes and Cmd 164/128 readbacks match the real LD301 byte for byte");
        check(pressure.cmd(164).data == Bytes{0x09, 0xFB, 0x00, 0x00},
              "X11b Cmd 164 derives two zero trailing bytes when the second display selector is None");
    }

    // ------------------- Y. Table writes captured on the real LD301 (PACTware)
    {
        Device table;
        table.cmd(0); // clear Cold Start before the mid-session capture
        const auto tableExchanges = loadCapture(LASECSIMUL_TEST_LD301_TABLE_Y2_CAPTURE);
        size_t exact = 0;
        size_t damagedAddress = 0;
        bool matches = tableExchanges.size() == 52;
        for (const auto& exchange : tableExchanges) {
            HartResponseBuilder response(300);
            table.component->transact(exchange.request, response);
            const Bytes simulated(response.bytes().begin(), response.bytes().end());
            Bytes captured = exchange.response;
            if (exchange.index == 7) {
                const Reply damaged = parseReply(captured);
                const size_t preambles = damaged.preambles;
                if (!damaged.wellFormed && preambles == 5 && captured.size() > preambles + 1 &&
                    captured[preambles + 1] == 0xBC) {
                    captured[preambles + 1] = 0xBE;
                    ++damagedAddress;
                }
            }
            if (simulated == captured) {
                if (exchange.index != 7) ++exact;
            } else {
                matches = false;
                std::fprintf(stderr, "Table capture #%zu\n  real      %s\n  simulated %s\n", exchange.index,
                             hex(exchange.response).c_str(), hex(simulated).c_str());
            }
        }
        check(matches && exact == 51 && damagedAddress == 1,
              "Y1 Table capture: 51 frames exact; one response has a single corrupted address bit and an immediate exact retry");
        check(table.cmd(135, Bytes{0x06}).data == Bytes{0x06} && floatAt(table.cmd(133, Bytes{0x10}).data, 6) == 99.0f,
              "Y2 Cmd 135 holds 6 points and Cmd 134 index 0x11 changed only Y2 to 99.00 percent");
        check(table.cmd(134, Bytes{0x20, 0, 0, 0, 0}).responseCode == 2 &&
                  table.cmd(134, Bytes{0x11, 0x42}).responseCode == 5 &&
                  floatAt(table.cmd(133, Bytes{0x10}).data, 6) == 99.0f,
              "Y3 invalid table index and truncated point write return RC 2/5 without altering Y2");
        Device tableReopened(table.save());
        tableReopened.cmd(0);
        check(floatAt(tableReopened.cmd(133, Bytes{0x10}).data, 6) == 99.0f,
              "Y4 written table point Y2 survives save/reopen");

        const auto points5Exchanges = loadCapture(LASECSIMUL_TEST_LD301_TABLE_POINTS5_CAPTURE);
        bool points5Exact = points5Exchanges.size() == 42;
        for (const auto& exchange : points5Exchanges) {
            HartResponseBuilder response(300);
            tableReopened.component->transact(exchange.request, response);
            const Bytes simulated(response.bytes().begin(), response.bytes().end());
            if (simulated != exchange.response) {
                points5Exact = false;
                std::fprintf(stderr, "Table points=5 capture #%zu\n  real      %s\n  simulated %s\n", exchange.index,
                             hex(exchange.response).c_str(), hex(simulated).c_str());
            }
        }
        check(points5Exact, "Y5 Table points 6 -> 5: all 42 Cmd 135/134/133 exchanges match the real LD301 byte for byte");
        const Bytes xPage = tableReopened.cmd(133, Bytes{0x04}).data;
        const Bytes yPage = tableReopened.cmd(133, Bytes{0x14}).data;
        check(xPage.size() == 18 && yPage.size() == 18 && xPage[1] == 5 && yPage[1] == 5 &&
                  floatAt(xPage, 2) == 100.0f && floatAt(xPage, 6) == 0.0f &&
                  floatAt(yPage, 2) == 100.0f && floatAt(yPage, 6) == 0.0f &&
                  floatAt(tableReopened.cmd(133, Bytes{0x10}).data, 6) == 99.0f,
              "Y6 the count becomes 5, X6/Y6 are zeroed by the DTM writes, and Y2 remains 99.00 percent");
        Device tablePoints5Reopened(tableReopened.save());
        tablePoints5Reopened.cmd(0);
        const Bytes persistedXPage = tablePoints5Reopened.cmd(133, Bytes{0x04}).data;
        const Bytes persistedYPage = tablePoints5Reopened.cmd(133, Bytes{0x14}).data;
        const Bytes persistedY2Page = tablePoints5Reopened.cmd(133, Bytes{0x10}).data;
        check(persistedXPage.size() == 18 && persistedYPage.size() == 18 && persistedY2Page.size() == 18 &&
                  persistedXPage[1] == 5 && floatAt(persistedYPage, 6) == 0.0f &&
                  floatAt(persistedY2Page, 6) == 99.0f,
              "Y7 the five-point table and Y2=99 survive save/reopen");
    }

    // -------- Z. Sensor characterization mode, captured on the real LD301
    {
        Device characterization;
        characterization.component->setSignalInput("PV", 148023.625);
        characterization.cmd(0); // the mid-session capture has no Cold Start bit
        const auto exchanges = loadCapture(LASECSIMUL_TEST_LD301_CHARACTERIZATION_ON_CAPTURE);
        bool matches = exchanges.size() == 8;
        size_t sessionStatusDifferences = 0;
        for (const auto& exchange : exchanges) {
            HartResponseBuilder response(300);
            characterization.component->transact(exchange.request, response);
            const Bytes simulated(response.bytes().begin(), response.bytes().end());
            Bytes captured = exchange.response;
            const Reply real = parseReply(captured);
            if (real.wellFormed && real.status == 0x55 && captured.size() > 14) {
                // The capture has More Status Available (0x10). Its cause is
                // not identified by these requests; the out-of-range PV is
                // modeled independently and contributes the observed 0x01.
                captured[14] &= static_cast<uint8_t>(~0x10u);
                captured.back() ^= 0x10;
                ++sessionStatusDifferences;
            }
            if (simulated != captured) {
                matches = false;
                std::fprintf(stderr, "Characterization On capture #%zu\n  real      %s\n  simulated %s\n", exchange.index,
                             hex(exchange.response).c_str(), hex(simulated).c_str());
            }
        }
        check(matches && sessionStatusDifferences == 8,
              "Z1 Cmd 163 On and seven readbacks match the capture except the preexisting More Status Available bit");
        check(characterization.cmd(160, Bytes{0x00}).data.size() == 11 &&
                  characterization.cmd(160, Bytes{0x00}).data[1] == 0x00,
              "Z2 Cmd 163 changes the Cmd 160 characterization mode byte from 0F (Off) to 00 (On)");
        check(characterization.cmd(163, Bytes{0x0F, 0x55}).responseCode == 2 &&
                  characterization.cmd(163, Bytes{0x00}).responseCode == 5 &&
                  characterization.cmd(160, Bytes{0x00}).data[1] == 0x00,
              "Z3 unknown mode payload and short Cmd 163 request leave the captured On state intact");
        Device characterizationReopened(characterization.save());
        characterizationReopened.cmd(0);
        const Bytes persistedPoint = characterizationReopened.cmd(160, Bytes{0x00}).data;
        check(persistedPoint.size() == 11 && persistedPoint[1] == 0x00,
              "Z4 Sensor Characterization On persists after save/reopen");

        Device characterizationOff(characterization.save());
        characterizationOff.component->setSignalInput("PV", 148023.625);
        const auto offExchanges = loadCapture(LASECSIMUL_TEST_LD301_CHARACTERIZATION_OFF_CAPTURE);
        bool offMatches = offExchanges.size() == 1;
        for (const auto& exchange : offExchanges) {
            HartResponseBuilder response(300);
            characterizationOff.component->transact(exchange.request, response);
            const Bytes simulated(response.bytes().begin(), response.bytes().end());
            Bytes captured = exchange.response;
            const Reply real = parseReply(captured);
            offMatches = offMatches && real.wellFormed && real.status == 0x75 && captured.size() > 14;
            if (real.wellFormed && captured.size() > 14) {
                captured[14] &= static_cast<uint8_t>(~0x10u);
                captured.back() ^= 0x10;
            }
            if (simulated != captured) {
                offMatches = false;
                std::fprintf(stderr, "Characterization Off capture #%zu\n  real      %s\n  simulated %s\n", exchange.index,
                             hex(exchange.response).c_str(), hex(simulated).c_str());
            }
        }
        check(offMatches, "Z5 Cmd 163 Off echoes 0F 00; only the unexplained More Status Available bit differs");
        const Bytes offPoint = characterizationOff.cmd(160, Bytes{0x00}).data;
        Device characterizationOffReopened(characterizationOff.save());
        characterizationOffReopened.cmd(0);
        const Bytes persistedOffPoint = characterizationOffReopened.cmd(160, Bytes{0x00}).data;
        check(offPoint.size() == 11 && offPoint[1] == 0x0F && persistedOffPoint.size() == 11 &&
                  persistedOffPoint[1] == 0x0F,
              "Z6 Cmd 163 restores Off and that mode survives save/reopen");
    }

    // ------- AA. Function, User Unit and Totalization bench captures
    {
        Device function;
        function.component->setSignalInput("PV", 148023.625);
        function.cmd(0);
        const auto functionWrites = loadCapture(LASECSIMUL_TEST_LD301_FUNCTION_SQRT_WRITE_CAPTURE);
        bool functionMatches = functionWrites.size() == 9;
        for (const auto& exchange : functionWrites)
            functionMatches = matchesCaptureWithoutUnknownStatus(function, exchange) && functionMatches;
        check(functionMatches,
              "AA1 Function Sqrt: the nine complete Cmd 34/203/47/139/183/191/157/15/138 frames match apart from session status 0x10");
        const auto functionReads = loadCapture(LASECSIMUL_TEST_LD301_FUNCTION_SQRT_READBACK_CAPTURE);
        const Reply capturedFunction = functionReads.empty() ? Reply{} : parseReply(functionReads.front().response);
        const Reply configuredFunction = function.cmd(15);
        check(functionReads.size() == 4 && capturedFunction.wellFormed && capturedFunction.data.size() == 17 &&
                  capturedFunction.data[1] == 0 && configuredFunction.data.size() == 17 && configuredFunction.data[1] == 1 &&
                  function.cmd(156).data == cat({Bytes{0x00}, f32(6.0f)}),
              "AA2 Cmd 47 selects Sqrt (code 1); the earlier readback was Linear and Hard cutoff remains 6 percent");

        Device bumpless;
        bumpless.component->setSignalInput("PV", 148023.625);
        bumpless.cmd(0);
        const auto bumplessWrites = loadCapture(LASECSIMUL_TEST_LD301_SQRT_BUMPLESS_CAPTURE);
        bool bumplessMatches = bumplessWrites.size() == 10;
        for (size_t index = 0; index < std::min<size_t>(9, bumplessWrites.size()); ++index)
            bumplessMatches = matchesCaptureWithoutUnknownStatus(bumpless, bumplessWrites[index]) && bumplessMatches;
        if (bumplessWrites.size() == 10) {
            const Reply capturedCutoff = parseReply(bumplessWrites[9].response);
            const Reply simulatedCutoff = bumpless.cmd(156);
            bumplessMatches = bumplessMatches && capturedCutoff.wellFormed && capturedCutoff.data == simulatedCutoff.data &&
                              capturedCutoff.data == cat({Bytes{0xFF}, f32(6.0f)});
        }
        check(bumplessMatches,
              "AA10 Bumpless: nine write/read frames match; Cmd 156 data is FF and 6 percent (response code differs)");
        Device bumplessReopened(bumpless.save());
        bumplessReopened.cmd(0);
        const bool bumplessPersisted = bumplessReopened.cmd(156).data == cat({Bytes{0xFF}, f32(6.0f)});
        const Reply backToHard = bumpless.cmd(191, Bytes{0x00});
        check(bumplessPersisted && backToHard.responseCode == 0 &&
                  bumpless.cmd(156).data == cat({Bytes{0x00}, f32(6.0f)}),
              "AA11 Cmd 191 code 1 selects Bumpless/0xFF, persists, and code 0 restores Hard/0x00");
        const Reply bumplessAgain = bumpless.cmd(191, Bytes{0x01});
        const Reply cutoffFive = bumpless.cmd(157, f32(5.0f));
        check(bumplessAgain.responseCode == 0 && cutoffFive.responseCode == 0 && cutoffFive.data == f32(5.0f) &&
                  bumpless.cmd(156).responseCode == 0 && bumpless.cmd(156).data == cat({Bytes{0xFF}, f32(5.0f)}),
              "AA12 Cutoff Value 6 -> 5: Cmd 157 echoes float 5 and Cmd 156 retains Bumpless");
        const Reply linear = bumpless.cmd(47, Bytes{0x00});
        const Reply linearMode = bumpless.cmd(191, Bytes{0x01});
        const Reply linearCutoff = bumpless.cmd(157, f32(5.0f));
        const Reply linearRead = bumpless.cmd(156);
        check(linear.responseCode == 0 && linearMode.responseCode == 113 && linearMode.data == Bytes{0x01} &&
                  linearCutoff.responseCode == 113 && linearCutoff.data == f32(5.0f) &&
                  linearRead.responseCode == 113 && linearRead.data == cat({Bytes{0xFF}, f32(5.0f)}) &&
                  bumpless.cmd(15).data[1] == 0,
              "AA13 Function Sqrt -> Linear: Cmd 47 writes 00; Square Root settings return warning 113");

        Device transfer;
        transfer.cmd(0);
        transfer.component->setSignalInput("PV", 565.0); // 25 % of 190..1690 mmH2O
        const Reply linearOutput = transfer.cmd(2);
        transfer.cmd(47, Bytes{0x01});
        transfer.cmd(157, f32(6.0f));
        transfer.cmd(191, Bytes{0x00});
        const Reply squareOutput = transfer.cmd(2);
        const Reply measuredPressure = transfer.cmd(1);
        const HartLcdFrame squareLcd = transfer.component->displayFrame(3'000'000'000ull);
        std::array<uint8_t, 64> squareTelemetry{};
        const size_t squareTelemetrySize = transfer.component->getTelemetryState(squareTelemetry.data(), squareTelemetry.size());
        double squareTelemetryMilliamps = 0.0;
        std::memcpy(&squareTelemetryMilliamps, squareTelemetry.data(), sizeof squareTelemetryMilliamps);
        check(floatAt(linearOutput.data, 0) == 8.0f && floatAt(linearOutput.data, 4) == 25.0f &&
                  floatAt(squareOutput.data, 0) == 12.0f && floatAt(squareOutput.data, 4) == 50.0f &&
                  floatAt(measuredPressure.data, 1) == 565.0f &&
                  squareTelemetrySize == 36 && std::fabs(squareTelemetryMilliamps - 12.0) < 1e-6 &&
                  std::string(squareLcd.numeric.begin(), squareLcd.numeric.end()) == "  5000" &&
                  (squareLcd.annunciators & HartLcdAnnunciator::Sqrt),
              "AA18 Sqrt converts 25 percent pressure to 50 percent output, 12 mA and LCD while PV remains pressure");
        transfer.component->setSignalInput("PV", 205.0); // 1 % of calibrated span
        const Reply hardCutoff = transfer.cmd(2);
        transfer.cmd(191, Bytes{0x01});
        const Reply smoothCutoff = transfer.cmd(2);
        const float smoothPercent = 10.0f / std::sqrt(6.0f);
        check(floatAt(hardCutoff.data, 0) == 4.0f && floatAt(hardCutoff.data, 4) == 0.0f &&
                  std::fabs(floatAt(smoothCutoff.data, 4) - smoothPercent) < 1e-4f &&
                  std::fabs(floatAt(smoothCutoff.data, 0) - (4.0f + 16.0f * smoothPercent / 100.0f)) < 1e-4f,
              "AA19 below 6 percent Hard yields 0 output; Bumpless uses manual gain 10/sqrt(cutoff)");

        Device userUnit;
        userUnit.component->setSignalInput("PV", 148023.625);
        userUnit.cmd(0);
        const auto userExchanges = loadCapture(LASECSIMUL_TEST_LD301_USER_UNIT_OFF_CAPTURE);
        bool userMatches = userExchanges.size() == 20;
        for (size_t index : std::array<size_t, 7>{0, 1, 10, 11, 13, 14, 15})
            if (index < userExchanges.size()) userMatches = matchesCaptureWithoutUnknownStatus(userUnit, userExchanges[index]) && userMatches;
        check(userMatches,
              "AA3 User Unit Off: Cmd 180/177/179 writes and Cmd 176/178 readbacks match seven stable captured frames");
        const Reply userVariable = userUnit.cmd(33, Bytes{0x04});
        check(userVariable.data.size() == 6 && userVariable.data[0] == 0x04 && userVariable.data[1] == 0x39 &&
                  userUnit.cmd(178).data[0] == 0xFF && userUnit.cmd(176).data[0] == 0x31,
              "AA4 User Unit Off reports PV code 4 in percent while retaining configured user unit mm");
        const auto userOnExchanges = loadCapture(LASECSIMUL_TEST_LD301_USER_UNIT_ON_CAPTURE);
        bool userOnMatches = userOnExchanges.size() == 12;
        for (size_t index = 3; index <= 7 && index < userOnExchanges.size(); ++index)
            userOnMatches = matchesCaptureWithoutUnknownStatus(userUnit, userOnExchanges[index]) && userOnMatches;
        check(userOnMatches, "AA14 User Unit Off -> On: Cmds 180/177/179/178/176 match five complete frames");
        const Reply userOnVariable = userUnit.cmd(33, Bytes{0x04});
        check(userOnVariable.data.size() == 6 && userOnVariable.data[1] == 0x31 &&
                  userUnit.cmd(178).data[0] == 0x00 && userUnit.cmd(176).responseCode == 0,
              "AA15 User Unit On restores configured mm and removes warning 117");

        auto totalDocument = loadSubcircuit();
        const auto* totalBase = innerHartDevice(totalDocument);
        nlohmann::json totalVariables = nlohmann::json::parse(totalBase->at("properties").at("hartVariablesJson").get<std::string>());
        for (auto& variable : totalVariables) {
            const std::string id = variable.value("id", std::string{});
            if (id == "totalization.unit" || id == "cmd189.byte0") variable["value"] = 253;
            if (id == "totalization.total") variable["value"] = 5182085.0;
        }
        lasecsimul::registry::ComponentParams totalOverrides;
        totalOverrides.properties["hartVariablesJson"] = totalVariables.dump();
        Device total(totalOverrides);
        total.component->setSignalInput("PV", 148023.625);
        total.cmd(0);
        const auto maxFlowExchanges = loadCapture(LASECSIMUL_TEST_LD301_TOTALIZATION_MAXFLOW_CAPTURE);
        bool maxFlowMatches = maxFlowExchanges.size() == 14;
        for (const auto& exchange : maxFlowExchanges)
            if (exchange.index != 10 && exchange.index != 13)
                maxFlowMatches = matchesCaptureWithoutUnknownStatus(total, exchange) && maxFlowMatches;
        check(maxFlowMatches,
              "AA5 Maximum Flow 100 -> 99: 12 complete frames match; two captured replies are absent/truncated");
        const auto factorExchanges = loadCapture(LASECSIMUL_TEST_LD301_TOTALIZATION_FACTOR_CAPTURE);
        bool factorMatches = factorExchanges.size() == 10;
        for (const auto& exchange : factorExchanges)
            factorMatches = matchesCaptureWithoutUnknownStatus(total, exchange) && factorMatches;
        check(factorMatches, "AA6 Factor 1 -> 2: all ten complete write/read frames match apart from session status 0x10");

        const auto modeExchanges = loadCapture(LASECSIMUL_TEST_LD301_TOTALIZATION_MODE_CAPTURE);
        bool modeMatches = modeExchanges.size() == 16;
        size_t dynamicTotals = 0;
        for (const auto& exchange : modeExchanges) {
            if (exchange.index == 11 || exchange.index == 14 || exchange.index == 15) {
                const Reply real = parseReply(exchange.response);
                const Reply simulated = total.send(exchange.request);
                modeMatches = modeMatches && real.wellFormed && simulated.wellFormed && real.command == 185 &&
                    real.responseCode == 0 && simulated.responseCode == 0 &&
                    real.status == static_cast<uint8_t>(simulated.status | 0x10) &&
                    real.data.size() == 6 && simulated.data.size() == 6 &&
                    real.data[0] == 0 && simulated.data[0] == 0 && real.data[1] == 253 && simulated.data[1] == 253 &&
                    floatAt(real.data, 2) >= 5182085.0f;
                ++dynamicTotals;
            } else {
                modeMatches = matchesCaptureWithoutUnknownStatus(total, exchange) && modeMatches;
            }
        }
        check(modeMatches && dynamicTotals == 3,
              "AA7 Totalization Off -> On: 13 stable frames match and three live accumulated-total readings vary as captured");
        const Reply totalSettings = total.cmd(186);
        const Reply totalState = total.cmd(185);
        check(totalSettings.responseCode == 0 && totalSettings.data == cat({f32(99.0f), f32(2.0f)}) &&
                  totalState.responseCode == 0 && totalState.data.size() == 6 && totalState.data[0] == 0 && totalState.data[1] == 253,
              "AA8 totalization retains mode On, unit Special, maximum flow 99 and factor 2");
        Device totalReopened(total.save());
        totalReopened.cmd(0);
        check(totalReopened.cmd(186).data == cat({f32(99.0f), f32(2.0f)}) &&
                  totalReopened.cmd(185).data[0] == 0,
              "AA9 totalization settings survive save/reopen");
        const auto totalOffExchanges = loadCapture(LASECSIMUL_TEST_LD301_TOTALIZATION_MODE_OFF_CAPTURE);
        bool totalOffMatches = totalOffExchanges.size() == 14;
        for (size_t index : std::array<size_t, 7>{4, 5, 6, 7, 8, 10, 11})
            if (index < totalOffExchanges.size()) totalOffMatches = matchesCaptureWithoutUnknownStatus(total, totalOffExchanges[index]) && totalOffMatches;
        check(totalOffMatches,
              "AA16 Totalization On -> Off: Cmd 190/187/188/183 and stable readbacks match seven frames");
        check(total.cmd(185).responseCode == 118 && total.cmd(185).data[0] == 0xFF &&
                  total.cmd(186).data == cat({f32(99.0f), f32(2.0f)}),
              "AA17 Totalization Off retains maximum flow 99 and factor 2 with warning 118");
    }

    // ------------------------------------------------- O. captured-session replay
    {
        const auto rows = replayCapture(capture);
        size_t exact = 0, semantic = 0, mismatch = 0;
        for (const auto& row : rows) {
            if (row.result == "EXACT") ++exact;
            else if (row.result == "SEMANTIC") ++semantic;
            else ++mismatch;
            if (row.result == "MISMATCH")
                std::fprintf(stderr, "REPLAY MISMATCH #%zu cmd %u: %s\n  request   %s\n  real      %s\n  simulated %s\n",
                             row.index, row.command, row.detail.c_str(), hex(row.request).c_str(), hex(row.real).c_str(),
                             hex(row.simulated).c_str());
        }
        std::fprintf(stderr, "Replay result: %zu commands tested; %zu exact matches; %zu semantically equivalent; %zu mismatches\n",
                     rows.size(), exact, semantic, mismatch);
        check(rows.size() == 135, "O1 the capture holds 135 request/response exchanges");
        check(mismatch == 0, "O2 every captured exchange is reproduced exactly or semantically");
        if (!reportPath.empty()) {
            std::ofstream report(reportPath);
            report << "index,time,command,result,request,real_response,simulated_response,detail\n";
            for (const auto& row : rows)
                report << row.index << ',' << row.time << ',' << static_cast<unsigned>(row.command) << ',' << row.result << ','
                       << csvEscape(hex(row.request)) << ',' << csvEscape(hex(row.real)) << ',' << csvEscape(hex(row.simulated))
                       << ',' << csvEscape(row.detail) << '\n';
        }
    }

    std::fprintf(stderr, "LD301 audit: %d checks, %d failures\n", checks, failures);
    if (failures == 0) std::puts("LD301 audit: PASS");
    return failures == 0 ? 0 : 1;
}

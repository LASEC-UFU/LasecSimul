// TT301 reference audit (docs/tt301-audit.md): the simulated Smar TT301 must
// reproduce the HART behavior of the real transmitter captured in trm/tt301.
// Like the LD301 (HartLd301Test.cpp), the TT301 is NOT built into Core: it is
// the subcircuit subcircuits/hart_smar_tt301.lssubcircuit, one standard HART
// field device configured with the TT301 data. Every check talks to it
// through PHYSICAL HART frames via HartCommunicationComponent::transact.

#include "protocols/HartCommunicationComponent.hpp"
#include "protocols/HartEngine.hpp"
#include "protocols/HartLcd.hpp"
#include "protocols/HartTypeCodec.hpp"
#include "registry/ComponentParams.hpp"
#include "simulation/Scheduler.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iomanip>
#include <limits>
#include <memory>
#include <sstream>
#include <string>
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

Bytes fromHex(const std::string& text) {
    Bytes out;
    std::istringstream tokens(text);
    std::string token;
    while (tokens >> token) out.push_back(static_cast<uint8_t>(std::stoul(token, nullptr, 16)));
    return out;
}

// Long address of the captured specimen: Smar (3E | 0x80 primary), TT301 02, ID 01 0C 3A.
constexpr std::array<uint8_t, 5> kLongAddress{0x3E, 0x02, 0x01, 0x0C, 0x3A};

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
};

Reply parseReply(std::span<const uint8_t> raw) {
    Reply reply;
    reply.present = !raw.empty();
    size_t i = 0;
    while (i < raw.size() && raw[i] == 0xFF) ++i;
    reply.preambles = i;
    if (i >= raw.size()) return reply;
    reply.delimiter = raw[i];
    const size_t addressBytes = (reply.delimiter & 0x80) ? 5 : 1;
    if (raw.size() < i + 1 + addressBytes + 4) return reply;
    reply.address.assign(raw.begin() + static_cast<std::ptrdiff_t>(i + 1), raw.begin() + static_cast<std::ptrdiff_t>(i + 1 + addressBytes));
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

nlohmann::json loadSubcircuit() {
    std::ifstream file(LASECSIMUL_TEST_TT301_SUBCIRCUIT);
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

lasecsimul::registry::ComponentParams tt301Params(const lasecsimul::registry::ComponentParams& overrides = {}) {
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

    explicit Device(const lasecsimul::registry::ComponentParams& overrides = {}) {
        component = std::make_unique<HartCommunicationComponent>(HartCommunicationComponent::Mode::Serial, scheduler,
                                                                 tt301Params(overrides), &preset);
    }
    Reply send(const Bytes& frame) {
        HartResponseBuilder response(300);
        if (!component->transact(frame, response)) return {};
        return parseReply(response.bytes());
    }
    Reply cmd(uint8_t command, const Bytes& data = {}, bool primary = true) { return send(requestFrame(command, data, true, primary)); }
    lasecsimul::registry::ComponentParams save() {
        lasecsimul::registry::ComponentParams saved;
        for (const auto& descriptor : component->propertyDescriptors()) saved.properties[descriptor.schema.id] = descriptor.get();
        return saved;
    }
};

std::string textProperty(HartCommunicationComponent& component, const std::string& id) {
    for (const auto& descriptor : component.propertyDescriptors()) {
        if (descriptor.schema.id != id) continue;
        const auto value = descriptor.get();
        if (const auto* text = std::get_if<std::string>(&value)) return *text;
    }
    return "(missing)";
}

float floatAt(const Bytes& data, size_t offset) {
    return offset + 4 <= data.size() ? HartTypeCodec::decodeFloat32BE(std::span<const uint8_t>(data).subspan(offset, 4))
                                     : std::numeric_limits<float>::quiet_NaN();
}

class StubMatrix final : public lasecsimul::MnaMatrixView {
public:
    std::vector<std::tuple<std::string, std::string, double>> currents;
    void addConductance(const lasecsimul::Pin&, const lasecsimul::Pin&, double) override {}
    void addCurrent(const lasecsimul::Pin& a, const lasecsimul::Pin& b, double amperes) override { currents.emplace_back(a.id, b.id, amperes); }
    void addVoltageSource(const lasecsimul::Pin&, const lasecsimul::Pin&, double) override {}
    void addConductanceToGround(const lasecsimul::Pin&, double) override {}
    void addCurrentToGround(const lasecsimul::Pin&, double) override {}
    double getNodeVoltage(const lasecsimul::Pin&) const override { return 0.0; }
    double getBranchCurrent() const override { return 0.0; }
};

// ---------------------------------------------------------------------------
// Captured-session replay.

struct Exchange { std::string time; std::string section; Bytes request, response; size_t index = 0; };

std::vector<Exchange> loadCapture(const char* path) {
    std::ifstream stream(path);
    std::vector<Exchange> exchanges;
    std::string line, section;
    while (std::getline(stream, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        const bool serial = line.find("SERIAL RX") != std::string::npos;
        const bool udp = line.find("UDP RX") != std::string::npos;
        if (!serial && !udp) {
            if (line.find_first_not_of(" \t") != std::string::npos) section = line;
            continue;
        }
        const size_t start = line.find("): ");
        if (start == std::string::npos) continue;
        std::istringstream tokens(line.substr(start + 3));
        Bytes bytes;
        std::string token;
        while (tokens >> token) {
            if (token.size() != 2) break;
            bytes.push_back(static_cast<uint8_t>(std::stoul(token, nullptr, 16)));
        }
        if (serial) {
            Exchange exchange;
            exchange.time = line.substr(1, line.find(']') - 1);
            exchange.section = section;
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

struct ReplayRow { size_t index = 0; uint8_t command = 0; std::string result, detail; };

/** The bench state the capture starts from: the specimen had no sensor
 * wired (burnout High, 21 mA = 106.25 %, Device Malfunction + PV Out Of
 * Limits). An open RTD reads at the top of the Pt100 range, 850 degC. */
lasecsimul::registry::ComponentParams benchState() {
    lasecsimul::registry::ComponentParams bench;
    bench.properties["sensorFault"] = true;
    return bench;
}

std::vector<ReplayRow> replayCapture(const char* path) {
    std::vector<ReplayRow> rows;
    const auto exchanges = loadCapture(path);
    Device device(benchState());
    device.component->setSignalInput("PV", 850.0);
    for (const auto& exchange : exchanges) {
        // Between 15:43:33 and 15:47:54 the sensor went back to RTD Pt100
        // without a captured write (fig08). That write is replayed through
        // the SECONDARY master (primary status bits untouched); selecting
        // the sensor alone yields the captured range -200..850 degC.
        if (exchange.index == 91) device.cmd(131, {0x02, 0x01, 0x02, 0x01}, false);
        ReplayRow row;
        row.index = exchange.index;
        HartResponseBuilder response(300);
        const bool answered = device.component->transact(exchange.request, response);
        const Bytes simulated(response.bytes().begin(), response.bytes().end());
        const Reply sim = parseReply(simulated);
        const Reply real = parseReply(exchange.response);
        row.command = real.command;
        if (!answered || !sim.wellFormed) {
            row.result = "MISMATCH";
            row.detail = "simulator produced no well-formed reply";
        } else if (simulated == exchange.response) {
            row.result = "EXACT";
        } else if (real.command == 0 && real.data.size() == 22 && sim.data.size() == 22 && real.status == sim.status &&
                   std::equal(real.data.begin(), real.data.begin() + 14, sim.data.begin()) &&
                   std::equal(real.data.begin() + 16, real.data.end(), sim.data.begin() + 16)) {
            // Only the Configuration Change Counter differs: the capture
            // misses the configuration changes made between 15:43 and 15:47.
            row.result = "SEMANTIC";
            row.detail = "Configuration Change Counter real " + hex(Bytes(real.data.begin() + 14, real.data.begin() + 16)) +
                         " sim " + hex(Bytes(sim.data.begin() + 14, sim.data.begin() + 16)) + " (uncaptured writes)";
        } else {
            row.result = "MISMATCH";
            row.detail = "real [" + hex(exchange.response) + "] sim [" + hex(simulated) + "]";
        }
        rows.push_back(std::move(row));
    }
    return rows;
}

} // namespace

int main(int argc, char** argv) {
    const char* capture = LASECSIMUL_TEST_TT301_CAPTURE;
    for (int i = 1; i + 1 < argc; ++i)
        if (std::string(argv[i]) == "--capture") capture = argv[i + 1];
    const uint64_t s = 1'000'000'000ull;

    // ----------------------------- S. TT301 = subcircuit of the standard device
    {
        const nlohmann::json document = loadSubcircuit();
        const auto* device = innerHartDevice(document);
        check(document.value("schemaVersion", 0) == 3 && document.value("typeId", std::string{}) == "subcircuits.hart.smar_tt301",
              "S1 the TT301 is the subcircuit subcircuits.hart.smar_tt301 (schemaVersion 3)");
        check(device != nullptr && device->value("id", std::string{}) == "tt301" &&
                  device->at("properties").value("profileId", std::string{}) == "lasecsimul.hart.standard-field-device",
              "S2 it contains one standard HART field device (protocol.hart.device.standard), not a built-in TT301");
        // The sensor arrives at the terminals 1-4 like on the real transmitter (RTD at 2, 3 or 4 wires, or a
        // thermocouple on 2 and 3): an input stage of generic blocks measures it and drives the device's PV.
        bool interfaceOk = document.contains("interface") && document["interface"].size() == 6;
        for (const auto& entry : document["interface"]) {
            const std::string pin = entry.value("pinId", std::string{});
            interfaceOk = interfaceOk && (pin == "s1" || pin == "s2" || pin == "s3" || pin == "s4" || pin == "loop_plus" || pin == "loop_minus") &&
                          entry.value("domain", std::string{}) == "electrical";
        }
        bool temperatureWired = false, faultWired = false, loopWired = true;
        for (const auto& wire : document["topology"]["conductors"]) {
            const std::string from = wire["from"].value("componentId", std::string{});
            const bool toDevice = wire["to"].value("componentId", std::string{}) == "tt301";
            if (from == "pv_select" && toDevice && wire["to"].value("pinId", std::string{}) == "PV") temperatureWired = true;
            if (from == "fault_select" && toDevice && wire["to"].value("pinId", std::string{}) == "sensorFault") faultWired = true;
        }
        for (const char* pin : {"loop_plus", "loop_minus"}) {
            bool found = false;
            for (const auto& wire : document["topology"]["conductors"])
                if (wire["to"].value("componentId", std::string{}) == "tt301" && wire["to"].value("pinId", std::string{}) == pin) found = true;
            loopWired = loopWired && found;
        }
        check(interfaceOk && temperatureWired && faultWired && loopWired,
              "S3 sensor terminals 1-4 (RTD 2/3/4 wires, thermocouple on 2-3) feed the PV and the burnout through the input stage; LOOP+/LOOP- stay the 4-20 mA loop");
        const auto exported = document.value("exportedPropertyComponentIds", nlohmann::json::array());
        check(std::find(exported.begin(), exported.end(), "tt301") != exported.end() &&
                  std::find(exported.begin(), exported.end(), "c_tterm") != exported.end(),
              "S4 the inner device's properties and the terminal block (cold junction) temperature are exported");
        nlohmann::json commands = nlohmann::json::array();
        try { commands = nlohmann::json::parse(device ? device->at("properties").value("hartCommandsJson", std::string{"[]"}) : "[]"); } catch (...) {}
        bool allDeviceSpecific = commands.size() == 19;
        for (const auto& command : commands) allDeviceSpecific = allDeviceSpecific && command.value("id", 0) >= 128 && command.value("id", 0) <= 253;
        check(allDeviceSpecific, "S5 the 19 TT301 commands are Lasec HART DSL data (Device-Specific 128-253)");
        Device tt301;
        check(tt301.component->pins().size() == 4 && std::string(tt301.component->typeId()) == "protocol.hart.device.standard" &&
                  textProperty(*tt301.component, "hartVariablesStatus").find("ERROR") == std::string::npos &&
                  textProperty(*tt301.component, "hartCommandsStatus").find("ERROR") == std::string::npos,
              "S6 the subcircuit's device compiles: standard C++ HART device, variables and commands accepted");
        check(document.value("iconPath", std::string{}) == "./tt301.svg", "S7 the TT301 artwork is the palette icon and symbol");
        const auto ports = tt301.component->signalPorts();
        const auto port = [&](const char* id) { return std::find_if(ports.begin(), ports.end(), [&](const auto& p) { return p.id == id; }); };
        const auto pv = port("PV");
        const auto fault = port("sensorFault");
        const auto connection = port("sensor.connection");
        const auto terminal = port("terminalTemperature");
        bool configurationOut = true;
        for (const char* id : {"sensor.type", "sensor.model", "sensor.connection", "sensor.coldJunction"}) {
            const auto entry = port(id);
            configurationOut = configurationOut && entry != ports.end() && entry->direction == lasecsimul::SignalPortDirection::Output;
        }
        check(ports.size() == 7 && pv != ports.end() && pv->direction == lasecsimul::SignalPortDirection::Input && pv->unit.empty() &&
                  fault != ports.end() && fault->direction == lasecsimul::SignalPortDirection::Input &&
                  terminal != ports.end() && terminal->direction == lasecsimul::SignalPortDirection::Input && terminal->unit.empty() &&
                  connection != ports.end() && configurationOut,
              "S8 signal ports: dimensionless PV, sensorFault and terminal temperature inputs; sensor type, model, connection and cold junction as outputs for the input stage");
    }

    // ------------------------------------------------------------- A. identity
    {
        Device device;
        const Reply shortFrame = device.send(requestFrame(0, {}, false));
        check(shortFrame.wellFormed && shortFrame.delimiter == 0x06 && shortFrame.preambles == 5 && shortFrame.address == Bytes{0x80},
              "A1 Command 0 answers the short-frame poll with 5 preambles");
        check(shortFrame.data == fromHex("FE 3E 02 05 07 08 60 10 00 01 0C 3A 05 09 00 28 00 00 3E 00 3E 01"),
              "A2 HART 7 Command 0 (fig01): Smar 3E, TT301 02, 5 preambles, univ rev 7, device rev 8, sw 6.00, hw 16, ID 68666, "
              "9 device variables, counter 0x0028, private label Smar, profile 1");
        const Reply longFrame = device.cmd(0);
        check(longFrame.wellFormed && longFrame.delimiter == 0x86 && longFrame.address == Bytes{0xBE, 0x02, 0x01, 0x0C, 0x3A} &&
                  longFrame.data == shortFrame.data,
              "A3 the long address BE 02 01 0C 3A returns the same identity");
        const Reply tag = device.cmd(13);
        check(tag.data == fromHex("50 11 E0 82 08 20 C7 68 03 20 14 81 0D 41 52 4E 08 20 0F 04 71"),
              "A4 Command 13: Tag TAG, Descriptor 16 CHARACTERS, Date 15/04/2013 (fig03)");
        check(device.cmd(12).data == fromHex("CF 28 03 20 14 81 0D 41 52 4E 08 20 82 08 20 82 08 20 82 08 20 82 08 20"),
              "A5 Command 12: message 32 CHARACTERS (fig03)");
        check(device.cmd(16).data == Bytes{0x00, 0x00, 0x00}, "A6 Command 16: main board serial 0 (fig04)");
        check(device.cmd(173, {0x02}).data == cat({Bytes{0x02}, Bytes(21, 0x20)}), "A7 Command 173: blank ordering code (fig04)");
        check(device.cmd(14).data == fromHex("00 00 00 20 44 54 80 00 C3 48 00 00 41 20 00 00"),
              "A8 Command 14: Pt100 limits 850 / -200 degC, minimum span 10 (fig08)");
        check(device.cmd(20).responseCode == 0, "A9 HART 7 command set: Command 20 (Long Tag) is implemented");
    }

    // --------------------------------------------------------- B. initial state
    {
        Device device;
        const Reply first = device.cmd(1);
        check(first.status == 0x60, "B1 first reply to the primary master: Configuration Changed + Cold Start (sensor wired, in range)");
        check(device.cmd(1).status == 0x40, "B2 Cold Start is cleared after the first reply");
        check(device.cmd(1).data == cat({Bytes{0x20}, f32(25.0f)}), "B3 PV 25 degC with a sensor wired (Command 1)");
        check(device.cmd(15).data == fromHex("01 00 20 44 48 00 00 00 00 00 00 00 00 00 00 FF FA"),
              "B4 Command 15 (17 bytes, fig05): burnout code 01, linear, degC, URV 800, LRV 0, damping 0, write protect FF, 250");
        check(device.cmd(2).data == cat({f32(4.5f), f32(3.125f)}), "B5 Command 2: 25 degC in 0..800 = 3.125 % = 4.5 mA");
    }

    // ------------------------------------------- E. TT301 manufacturer commands
    {
        Device device;
        device.cmd(0);
        check(device.cmd(130, {0x02}).data == Bytes{0x02, 0x01, 0x02, 0x01, 0x01}, "E1 Command 130: RTD / Pt 100 IEC / two wires (fig06a)");
        check(device.cmd(187, {0x02}).data == Bytes{0x02, 0xFF}, "E2 Command 187: no cold junction with an RTD");
        check(device.cmd(198, {0x02}).data == Bytes{0x02, 0x00, 0x00, 0x00, 0x00}, "E3 Command 198");
        check(device.cmd(223, {0x02}).data == fromHex("02 42 C8 00 00 3B 80 11 32 B5 1B 05 7F AC 93 2D 1D"),
              "E4 Command 223: Callendar-Van Dusen R0 100, A 3.9083e-3, B -5.775e-7, C -4.183e-12 (IEC 751 Pt100)");
        check(device.cmd(168, {0x02}).data == Bytes{0x02, 0xFF, 0xFF}, "E5 Command 168: write protection FF FF (fig05a read/write)");
        check(device.cmd(162, {0x02}).data == Bytes{0x02, 0x01}, "E6 Command 162: burnout code 01 = High (fig05a)");
        check(device.cmd(164, {0x02}).data == Bytes{0x02, 0x02, 0x02}, "E7 Command 164: LCD Temp. PV / Temp. PV (fig05a)");
        const Reply pidMode = device.cmd(136, {0x02});
        check(pidMode.responseCode == 112 && pidMode.data == Bytes{0x02, 0xFF, 0xFF, 0xFF}, "E8 Command 136: warning 112 + PID off (fig07)");
        check(device.cmd(138, {0x02}).data == Bytes{0x02, 0xFF}, "E9 Command 138: controller mode Off");
        const Reply pidLoop = device.cmd(140, {0x02});
        check(pidLoop.responseCode == 112 &&
                  pidLoop.data == cat({Bytes{0x02, 0x39}, f32(3.125f), Bytes{0x39}, f32(0.0f), Bytes{0x39}, f32(3.125f),
                                       Bytes{0xFF, 0xFF, 0x39}, f32(0.0f)}),
              "E10 Command 140 (same layout as the LD301 behind the slot byte): PV%, SP 0, MV, mode/tracking FF, error 0");
        check(device.cmd(152, {0x02}).data == cat({Bytes{0x02}, f32(0.0f), Bytes{0xFF, 0xFF}}), "E11 Command 152: SP generator Off (fig07)");
        const Reply tuning = device.cmd(142, {0x02});
        check(tuning.responseCode == 112 && tuning.data == cat({Bytes{0x02}, f32(1.0f), f32(0.01f), f32(0.0f), f32(0.0f), f32(0.1f)}),
              "E12 Command 142 (inferred from the LD301): Kp 1, Tr 0.01, Td 0");
        check(device.cmd(130).responseCode == 5 && device.cmd(140).responseCode == 5,
              "E13 the vendor commands need their first data byte (02): RC 5 without it");
        check(device.cmd(128).responseCode == 64 && device.cmd(166).responseCode == 64,
              "E14 LD301-only commands (128, 166) are not TT301 commands: RC 64");
    }

    // ----------------------------------------- X. writes captured on the TT301
    {
        Device device;
        device.cmd(0);
        const Reply sensor = device.cmd(131, {0x02, 0x83, 0x02, 0x01});
        check(sensor.responseCode == 0 && sensor.data == Bytes{0x02, 0x83, 0x02, 0x01} &&
                  device.cmd(130, {0x02}).data == Bytes{0x02, 0x83, 0x02, 0x01, 0x01},
              "X1 Command 131 TC / J NBS / two wires (fig06b) echoes and reads back through Command 130");
        check(device.cmd(186, {0x02, 0x00}).data == Bytes{0x02, 0x00} && device.cmd(187, {0x02}).data == Bytes{0x02, 0x00},
              "X2 Command 186 enables the cold junction (00), read back by Command 187");
        check(device.cmd(165, {0x02, 0x03, 0x02}).data == Bytes{0x02, 0x03, 0x02} && device.cmd(164, {0x02}).data == Bytes{0x02, 0x03, 0x02},
              "X3 Command 165 sets the first LCD variable to Temp. (03)");
        const Reply protect = device.cmd(169, {0x02, 0x01, 0xFF});
        check(protect.responseCode == 0 && protect.data == Bytes{0x02, 0x01, 0xFF} && device.cmd(168, {0x02}).data == Bytes{0x02, 0x01, 0xFF},
              "X4 Command 169 writes the protection bytes 01 FF");
        check(device.cmd(15).data[15] == 0x01 && device.cmd(165, {0x02, 0x00, 0x02}).responseCode == 0,
              "X5 Command 15 reports the Smar code 01 as its Write Protect Code, and the TT301 stays writable (captured 165 after 169)");
        check(device.cmd(163, {0x02, 0x01}).data == Bytes{0x02, 0x01} && device.cmd(15).data[0] == 0x01,
              "X6 Command 163 writes the burnout (Command 15 byte 0)");
        check(device.cmd(0).data[14] == 0x00 && device.cmd(0).data[15] > 0x28,
              "X7 each configuration write increments the HART 7 Configuration Change Counter (Command 0)");
    }

    // -------------------------------------------- F. ranges and output (manual)
    {
        Device device;
        device.cmd(0);
        const auto current = [&](double pv) { device.component->setSignalInput("PV", pv); return floatAt(device.cmd(2).data, 0); };
        check(current(0.0) == 4.0f && current(800.0) == 20.0f && current(400.0) == 12.0f, "F1 0 / 400 / 800 degC -> 4 / 12 / 20 mA");
        check(current(-50.0) == 3.8f && (device.cmd(1).status & 0x04), "F2 below the range: 3.8 mA saturated (manual 5.1)");
        check(current(840.0) == 20.5f && (device.cmd(1).status & 0x04), "F3 above the range: 20.5 mA saturated");
        device.component->setSignalInput("PV", 900.0);
        check(device.cmd(1).status & 0x01, "F4 beyond the 850 degC sensor limit: PV Out Of Limits");
        const Reply range = device.cmd(35, cat({Bytes{0x20}, f32(100.0f), f32(0.0f)}));
        check(range.responseCode == 0 && device.cmd(15).data == fromHex("01 00 20 42 C8 00 00 00 00 00 00 00 00 00 00 FF FA"),
              "F5 Command 35 (calibration without reference, manual 3.15) sets 0..100 degC");
        check(device.cmd(35, cat({Bytes{0x20}, f32(900.0f), f32(0.0f)})).responseCode == 11,
              "F6 an URV beyond the 850 degC limit is refused (manual: values within the calibration limits)");
        check(device.cmd(35, cat({Bytes{0x20}, f32(5.0f), f32(0.0f)})).responseCode == 29,
              "F7 a span below the 10 degC minimum span is refused");
        check(device.cmd(44, {0x21}).responseCode == 0 && device.cmd(1).data[0] == 0x21, "F8 Command 44: degF (manual: C, F, R, K)");
        check(device.cmd(34, f32(32.0f)).responseCode == 0 && floatAt(device.cmd(15).data, 11) == 32.0f, "F9 damping up to 32 s");
        Device loop;
        loop.cmd(0);
        check(loop.cmd(40, f32(3.6f)).responseCode == 0 && loop.cmd(40, f32(21.0f)).responseCode == 0 &&
                  loop.cmd(40, f32(3.5f)).responseCode == 4 && loop.cmd(40, f32(21.1f)).responseCode == 3,
              "F10 loop test from 3.6 to 21 mA (manual 3.10)");
    }

    // --------------------------------------------- R. burnout (manual 3.6, 5.2)
    {
        Device device(benchState());
        device.cmd(0);
        device.cmd(13); // Command 0 keeps Cold Start; the next command reports and clears it
        device.component->setSignalInput("PV", 850.0);
        const Reply failed = device.cmd(2);
        check(floatAt(failed.data, 0) == 21.0f && floatAt(failed.data, 4) == 106.25f && failed.status == 0xC1,
              "R1 open sensor, burnout High (code 01): 21 mA = 106.25 %, status 0xC1 as captured (no Saturated bit)");
        check(device.cmd(163, {0x02, 0x00}).responseCode == 0 && floatAt(device.cmd(2).data, 0) == 3.6f,
              "R2 burnout Low (code 00, inferred) drives 3.6 mA");
        for (auto& descriptor : device.component->propertyDescriptors())
            if (descriptor.schema.id == "sensorFault") descriptor.set(false);
        device.component->setSignalInput("PV", 400.0);
        const Reply recovered = device.cmd(2);
        check(floatAt(recovered.data, 0) == 12.0f && !(recovered.status & 0x80), "R3 a sensor wired again restores the PV output");
    }

    // ------------------------------------------------- P. write protection
    {
        Device device;
        device.cmd(0);
        check(device.cmd(169, {0x02, 0x00, 0xFF}).responseCode == 0 && device.cmd(15).data[15] == 0x00,
              "P1 Command 169 code 00 (read only, inferred) is reported by Command 15");
        check(device.cmd(165, {0x02, 0x00, 0x02}).responseCode == 7 && device.cmd(35, cat({Bytes{0x20}, f32(100.0f), f32(0.0f)})).responseCode == 7,
              "P2 ...and refuses configuration writes with RC 7");
    }

    // ------------------------------------------------------- Q. signal + loop
    {
        Device device;
        device.cmd(0);
        auto& tt301 = *device.component;
        StubMatrix matrix;
        for (size_t i = 2; i < 4; ++i) tt301.onPinConnectionChanged(i, true); // LOOP+/LOOP- only: TEMP is a signal
        tt301.setSignalInput("PV", 200.0);
        tt301.stamp(matrix);
        check(!matrix.currents.empty() && std::fabs(std::get<2>(matrix.currents.back()) * 1000.0 - 8.0) < 1e-6 &&
                  std::get<0>(matrix.currents.back()) == "loop_plus",
              "Q1 200 degC on the TEMP input drives 8 mA into LOOP+ -> LOOP-");
        check(std::fabs(tt301.loopCurrentMilliamps() - 8.0) < 1e-9, "Q2 the loop current is readable as a device property");
    }

    // ------------------------------------------------------------ V. LCD
    {
        const auto numeric = [](const HartLcdFrame& frame) { return std::string(frame.numeric.begin(), frame.numeric.end()); };
        const auto alpha = [](const HartLcdFrame& frame) { return std::string(frame.alpha.begin(), frame.alpha.end()); };
        Device device;
        device.component->setSignalInput("PV", 123.4);
        check(alpha(device.component->displayFrame(0)) == "TT301", "V1 power-up page shows the model TT301");
        const auto shown = [](double value, int decimals = 3) {
            HartLcdFrame expected;
            hartLcdFormatNumber(value, expected, decimals);
            return std::string(expected.numeric.begin(), expected.numeric.end());
        };
        HartLcdFrame frame = device.component->displayFrame(3 * s);
        check(numeric(frame) == "  1234" && frame.decimalPoints == (1u << 4) && (frame.annunciators & HartLcdAnnunciator::Degree) &&
                  alpha(frame) == "    C",
              "V2 first variable Temp. PV (code 2): 123.4 degC, one decimal like the manual's 25.0 degC (Fig. 2.7)");
        check(frame.glass == HartLcdGlass::Tt301, "V3 the TT301 glass (manual Fig. 2.9: ACK, no square-root marks)");
        device.cmd(0);
        device.cmd(165, {0x02, 0x03, 0x00});
        frame = device.component->displayFrame(3 * s);
        check(numeric(frame) == shown(25.0, 1) && numeric(frame) == "   250" && alpha(frame) == "    C" &&
                  numeric(device.component->displayFrame(6 * s + s / 10)) == shown(4.0 + 16.0 * 123.4 / 800.0) &&
                  alpha(device.component->displayFrame(6 * s + s / 10)) == "   mA",
              "V4 Temp. (code 3) shows the terminal temperature 25.0 degC; Out (mA) (code 0) 6.468 mA");
        device.cmd(165, {0x02, 0x04, 0x01});
        frame = device.component->displayFrame(3 * s);
        check(numeric(frame) == shown(100.0 * 123.4 / 800.0) && (frame.annunciators & HartLcdAnnunciator::Percent) &&
                  (frame.annunciators & HartLcdAnnunciator::ProcessVariable),
              "V5 PV (%) (code 4, manual 3.9 order): 15.425 %");
        frame = device.component->displayFrame(6 * s + s / 10);
        check(numeric(frame) == shown(100.0 * 123.4 / 800.0) && (frame.annunciators & HartLcdAnnunciator::Percent),
              "V6 Out (%) (code 1): the output in percent");
        device.component->setSignalInput("PV", 840.0);
        check(alpha(device.component->displayFrame(4 * s + s / 2)) == "     ",
              "V7 saturated output: no SAT message (the TT301 manual has none; LD301 glass only)");

        Device failed(benchState());
        failed.component->setSignalInput("PV", 850.0);
        frame = failed.component->displayFrame(3 * s);
        check(alpha(frame) == "AL_0 " && (frame.annunciators & HartLcdAnnunciator::Acknowledge) && numeric(frame) == "      ",
              "V8 burnout: alarm 0 'AL_0' with ACK lit interrupts monitoring (manual 2.8, Fig. 2.8)");
    }

    // ------------------- Z. a sensor change loads its limits and range
    {
        Device device;
        device.cmd(0);
        device.cmd(131, {0x02, 0x83, 0x02, 0x01}); // TC J NBS (fig06b)
        check(device.cmd(15).data == cat({Bytes{0x01, 0x00, 0x20}, f32(750.0f), f32(-150.0f), f32(0.0f), Bytes{0xFF, 0xFA}}) &&
                  device.cmd(14).data == cat({Bytes{0x00, 0x00, 0x00, 0x20}, f32(750.0f), f32(-150.0f), f32(30.0f)}),
              "Z1 TC J NBS: range and limits -150..750 degC, minimum span 30 (manual Table 6.1)");
        check(device.cmd(35, cat({Bytes{0x20}, f32(800.0f), f32(0.0f)})).responseCode == 11,
              "Z2 the range is now checked against the J limits: URV 800 > 750 -> RC 11");
        device.cmd(131, {0x02, 0x01, 0x02, 0x01}); // RTD Pt100 IEC
        check(device.cmd(15).data == fromHex("01 00 20 44 54 80 00 C3 48 00 00 00 00 00 00 FF FA") &&
                  device.cmd(14).data == fromHex("00 00 00 20 44 54 80 00 C3 48 00 00 41 20 00 00"),
              "Z3 back to RTD Pt100 IEC: -200..850 degC, span 10 -- the captured Commands 15 and 14 (fig08)");
        device.cmd(131, {0x02, 0x83, 0x03, 0x01}); // TC K NBS (inferred code)
        const auto range = [](Device& on) { const Bytes data = on.cmd(15).data; return Bytes(data.begin() + 3, data.begin() + 11); };
        check(range(device) == cat({f32(1350.0f), f32(-200.0f)}),
              "Z4 TC K NBS (inferred code 83 03): -200..1350 degC");
        device.cmd(35, cat({Bytes{0x20}, f32(500.0f), f32(100.0f)}));
        device.cmd(131, {0x02, 0x05, 0x07, 0x01}); // a code without a known sensor
        check(range(device) == cat({f32(500.0f), f32(100.0f)}) &&
                  device.cmd(130, {0x02}).data == Bytes{0x02, 0x05, 0x07, 0x01, 0x01},
              "Z5 an unknown sensor code is stored but leaves range and limits as they were");
        device.cmd(131, {0x02, 0x83, 0x02, 0x01});
        Device reopened(device.save());
        check(reopened.cmd(14).data == cat({Bytes{0x00, 0x00, 0x00, 0x20}, f32(750.0f), f32(-150.0f), f32(30.0f)}) &&
                  range(reopened) == cat({f32(750.0f), f32(-150.0f)}),
              "Z6 the sensor's limits and range survive save/reopen");
    }

    // ------------------------------------------------------ L. save / reopen
    {
        lasecsimul::registry::ComponentParams saved;
        {
            Device device;
            device.cmd(0);
            device.cmd(131, {0x02, 0x83, 0x02, 0x01});
            device.cmd(165, {0x02, 0x03, 0x00});
            device.cmd(163, {0x02, 0x00});
            saved = device.save();
        }
        Device reopened(saved);
        check(reopened.cmd(130, {0x02}).data == Bytes{0x02, 0x83, 0x02, 0x01, 0x01} &&
                  reopened.cmd(164, {0x02}).data == Bytes{0x02, 0x03, 0x00} && reopened.cmd(162, {0x02}).data == Bytes{0x02, 0x00},
              "L1 sensor, LCD and burnout written over HART survive save/reopen");
        check(reopened.cmd(0).data[15] == 0x2B, "L2 the Configuration Change Counter survives save/reopen (40 + 3 writes)");
    }

    // ------------------------------------------------- O. captured-session replay
    {
        const auto rows = replayCapture(capture);
        size_t exact = 0, semantic = 0, mismatch = 0;
        for (const auto& row : rows) {
            if (row.result == "EXACT") ++exact;
            else if (row.result == "SEMANTIC") ++semantic;
            else ++mismatch;
            if (row.result != "EXACT")
                std::fprintf(stderr, "  #%zu Cmd %u %s %s\n", row.index, static_cast<unsigned>(row.command), row.result.c_str(), row.detail.c_str());
        }
        std::printf("TT301 replay: %zu exchanges, %zu exact, %zu semantic, %zu mismatch\n", rows.size(), exact, semantic, mismatch);
        check(rows.size() == 104 && mismatch == 0, "O1 every captured TT301 exchange is reproduced (byte-exact or explained)");
        check(exact >= 103, "O2 at least 103 of 104 replies are byte-for-byte identical to the real TT301");
    }

    std::printf("hart_tt301: %d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}

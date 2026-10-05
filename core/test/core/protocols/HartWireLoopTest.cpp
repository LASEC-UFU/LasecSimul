// HART over the 4-20 mA wire, end to end in a real SimulationSession:
//
//   Rail 24 V -- R 250 ohm -- [Modem HART L+ / L-] -- [LD301 LOOP+ / LOOP-] -- ground
//
// The PC side writes a request into the modem; the modem modulates it on the
// loop as a voltage carrier, the transmitter demodulates it from its own
// terminals, executes it and answers by modulating ±0.5 mA on the loop
// current, which the modem demodulates back for the PC. Nothing bypasses the
// circuit: the reply bytes are compared with what an identical, separate
// transmitter returns for the same requests.
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/Rail.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "protocols/HartCommunicationComponent.hpp"
#include "protocols/HartModemComponent.hpp"
#include "protocols/HostUdpSocket.hpp"
#include "session/SimulationSession.hpp"

#include <nlohmann/json.hpp>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <string>
#include <vector>

using namespace lasecsimul;
using namespace lasecsimul::protocols;
using Bytes = std::vector<uint8_t>;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string& label) {
    ++checks;
    if (ok) std::printf("OK: %s\n", label.c_str());
    else {
        ++failures;
        std::fprintf(stderr, "FAIL: %s\n", label.c_str());
    }
}

registry::ComponentParams ld301Params() {
    registry::ComponentParams params;
    std::ifstream file(LASECSIMUL_TEST_LD301_SUBCIRCUIT);
    nlohmann::json document = nlohmann::json::object();
    try { document = nlohmann::json::parse(file); } catch (...) {}
    for (const auto& component : document.value("components", nlohmann::json::array())) {
        if (component.value("typeId", std::string{}) != "protocol.hart.device.standard") continue;
        for (const auto& [key, value] : component["properties"].items()) {
            if (value.is_string()) params.properties[key] = value.get<std::string>();
            else if (value.is_boolean()) params.properties[key] = value.get<bool>();
            else if (value.is_number()) params.properties[key] = value.get<double>();
        }
    }
    return params;
}

Bytes request(uint8_t command, const Bytes& data = {}, uint8_t addressFirst = 0x3E) {
    Bytes frame{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x82, static_cast<uint8_t>(0x80 | addressFirst), 0x01, 0x05, 0xF0, 0x4D, command,
                static_cast<uint8_t>(data.size())};
    frame.insert(frame.end(), data.begin(), data.end());
    uint8_t checksum = 0;
    for (size_t i = 5; i < frame.size(); ++i) checksum ^= frame[i];
    frame.push_back(checksum);
    return frame;
}

Bytes withoutPreambles(const Bytes& frame) {
    size_t i = 0;
    while (i < frame.size() && frame[i] == 0xFF) ++i;
    return Bytes(frame.begin() + static_cast<std::ptrdiff_t>(i), frame.end());
}

std::string hex(const Bytes& bytes) {
    std::string out;
    char buffer[4];
    for (uint8_t b : bytes) { std::snprintf(buffer, sizeof buffer, "%02X ", b); out += buffer; }
    return out;
}

/** Oscilloscope-like probe: records the differential voltage every time
 * the circuit is solved with a new value at its nodes. */
class RecordingProbe final : public IComponentModel {
public:
    using Sink = std::function<void(uint64_t, double)>;
    RecordingProbe(simulation::Scheduler& scheduler, Sink sink) : m_scheduler(scheduler), m_sink(std::move(sink)) {}
    const char* typeId() const override { return "test.probe"; }
    std::span<Pin> pins() override { return m_pins; }
    void stamp(MnaMatrixView& matrix) override {
        matrix.addConductance(m_pins[0], m_pins[1], 1e-9);
        m_sink(m_scheduler.nowNsUnlocked(), matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]));
    }
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

private:
    simulation::Scheduler& m_scheduler;
    Sink m_sink;
    std::array<Pin, 2> m_pins{Pin{"a", 0, 0}, Pin{"b", 0, 0}};
};

struct Loop {
    plugins::GlobalPluginCache cache;
    session::SimulationSession session{cache};
    HartCommunicationComponent::DevicePreset preset = HartCommunicationComponent::standardFieldDevicePreset();
    HartModemComponent* modem = nullptr;
    HartCommunicationComponent* device = nullptr;
    uint32_t resistor = 0, modemIndex = 0, deviceIndex = 0;

    struct Trace {
        Bytes received;
        double resistorMin = 1e9, resistorMax = -1e9, resistorSum = 0.0;
        size_t resistorSamples = 0;
        double deviceMin = 1e9, deviceMax = -1e9;
        double resistorMinDuringRequest = 1e9, resistorMaxDuringRequest = -1e9;
        uint64_t replyCompleteNs = 0;
        double wallSeconds = 0.0;
        double resistorMean() const { return resistorSamples ? resistorSum / static_cast<double>(resistorSamples) : 0.0; }
    };
    Trace* recording = nullptr;

    explicit Loop(double senseOhm = 250.0, bool wireDevice = true) {
        auto& components = session.components();
        auto& scheduler = session.scheduler();
        components.registerFactory("sources.rail", [](const registry::ComponentParams& p) {
            return std::make_unique<components::Rail>(Pin{"out", 0, 0}, p.property("voltage", 24.0));
        });
        components.registerFactory("passive.resistor", [](const registry::ComponentParams& p) {
            return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"p1", 0, 0}, Pin{"p2", 0, 0}}, p.property("resistance", 250.0));
        });
        components.registerFactory("other.ground", [](const registry::ComponentParams&) {
            return std::make_unique<components::Ground>(Pin{"pin", 0, 0});
        });
        components.registerFactory(HartModemComponent::kTypeId, [this, &scheduler](const registry::ComponentParams& p) {
            auto instance = std::make_unique<HartModemComponent>(scheduler, p);
            modem = instance.get();
            return instance;
        });
        components.registerFactory("protocol.hart.device.standard", [this, &scheduler](const registry::ComponentParams& p) {
            auto instance = std::make_unique<HartCommunicationComponent>(HartCommunicationComponent::Mode::Serial, scheduler, p, &preset);
            device = instance.get();
            return instance;
        });
        components.registerFactory("test.probe.resistor", [this, &scheduler](const registry::ComponentParams&) {
            return std::make_unique<RecordingProbe>(scheduler, [this](uint64_t, double volts) {
                if (!recording || !device) return;
                if (device->wireTransmitting()) {
                    recording->resistorMin = std::min(recording->resistorMin, volts);
                    recording->resistorMax = std::max(recording->resistorMax, volts);
                    recording->resistorSum += volts;
                    ++recording->resistorSamples;
                }
                if (modem && modem->transmitting()) {
                    recording->resistorMinDuringRequest = std::min(recording->resistorMinDuringRequest, volts);
                    recording->resistorMaxDuringRequest = std::max(recording->resistorMaxDuringRequest, volts);
                }
            });
        });
        components.registerFactory("test.probe.device", [this, &scheduler](const registry::ComponentParams&) {
            return std::make_unique<RecordingProbe>(scheduler, [this](uint64_t, double volts) {
                if (!recording || !modem || !modem->transmitting()) return;
                recording->deviceMin = std::min(recording->deviceMin, volts);
                recording->deviceMax = std::max(recording->deviceMax, volts);
            });
        });
        registry::ComponentParams rail;
        rail.properties["voltage"] = 24.0;
        const uint32_t supply = session.addComponent("sources.rail", rail);
        registry::ComponentParams load;
        load.properties["resistance"] = 250.0;
        resistor = session.addComponent("passive.resistor", load);
        registry::ComponentParams modemParams;
        modemParams.properties["senseResistance"] = senseOhm;
        modemIndex = session.addComponent(HartModemComponent::kTypeId, modemParams);
        deviceIndex = session.addComponent("protocol.hart.device.standard", ld301Params());
        const uint32_t ground = session.addComponent("other.ground", {});
        const uint32_t resistorProbe = session.addComponent("test.probe.resistor", {});
        const uint32_t deviceProbe = session.addComponent("test.probe.device", {});
        session.connectWire(supply, "out", resistor, "p1");
        session.connectWire(resistor, "p2", modemIndex, "loop_plus");
        if (wireDevice) session.connectWire(modemIndex, "loop_minus", deviceIndex, "loop_plus");
        session.connectWire(deviceIndex, "loop_minus", ground, "pin");
        session.connectWire(resistorProbe, "a", resistor, "p1");
        session.connectWire(resistorProbe, "b", resistor, "p2");
        session.connectWire(deviceProbe, "a", deviceIndex, "loop_plus");
        session.connectWire(deviceProbe, "b", deviceIndex, "loop_minus");
        for (int i = 0; i < 20 && session.settleStep(); ++i) {}
    }

    double resistorVolts() { return session.nodeVoltageOfPin(resistor, "p1") - session.nodeVoltageOfPin(resistor, "p2"); }

    /** PC writes `frame`; runs until the modem delivered `expectedLength`
     * bytes after the request (or `limitNs`). */
    Trace transact(const Bytes& frame, size_t expectedLength, uint64_t limitNs = 1'000'000'000) {
        Trace trace;
        recording = &trace;
        const auto wallStart = std::chrono::steady_clock::now();
        const uint64_t start = session.scheduler().nowNs();
        modem->hostWrite(frame);
        for (uint64_t t = 0; t < limitNs; t += 1'000'000) {
            session.scheduler().step(1'000'000);
            const Bytes out = modem->takeHostOutput();
            trace.received.insert(trace.received.end(), out.begin(), out.end());
            if (expectedLength && withoutPreambles(trace.received).size() >= expectedLength && !device->wireTransmitting()) {
                trace.replyCompleteNs = session.scheduler().nowNs() - start;
                break;
            }
        }
        trace.wallSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - wallStart).count();
        recording = nullptr;
        return trace;
    }
};


/** Multidrop: one supply, one HART modem, several transmitters on the same
 * pair of wires (electrically in parallel), each with its own polling
 * address and device ID. */
struct Multidrop {
    plugins::GlobalPluginCache cache;
    session::SimulationSession session{cache};
    HartCommunicationComponent::DevicePreset preset = HartCommunicationComponent::standardFieldDevicePreset();
    HartModemComponent* modem = nullptr;
    std::vector<HartCommunicationComponent*> devices;
    uint32_t resistor = 0;

    Multidrop(const std::vector<std::pair<int, std::string>>& addresses, const registry::ComponentParams& modemParams) {
        auto& components = session.components();
        auto& scheduler = session.scheduler();
        components.registerFactory("sources.rail", [](const registry::ComponentParams& p) {
            return std::make_unique<components::Rail>(Pin{"out", 0, 0}, p.property("voltage", 24.0));
        });
        components.registerFactory("passive.resistor", [](const registry::ComponentParams& p) {
            return std::make_unique<components::Resistor>(std::array<Pin, 2>{Pin{"p1", 0, 0}, Pin{"p2", 0, 0}}, p.property("resistance", 250.0));
        });
        components.registerFactory("other.ground", [](const registry::ComponentParams&) {
            return std::make_unique<components::Ground>(Pin{"pin", 0, 0});
        });
        components.registerFactory(HartModemComponent::kTypeId, [this, &scheduler](const registry::ComponentParams& p) {
            auto instance = std::make_unique<HartModemComponent>(scheduler, p);
            modem = instance.get();
            return instance;
        });
        components.registerFactory("protocol.hart.device.standard", [this, &scheduler](const registry::ComponentParams& p) {
            auto instance = std::make_unique<HartCommunicationComponent>(HartCommunicationComponent::Mode::Serial, scheduler, p, &preset);
            devices.push_back(instance.get());
            return instance;
        });
        registry::ComponentParams rail;
        rail.properties["voltage"] = 24.0;
        const uint32_t supply = session.addComponent("sources.rail", rail);
        registry::ComponentParams load;
        load.properties["resistance"] = 250.0;
        resistor = session.addComponent("passive.resistor", load);
        const uint32_t modemIndex = session.addComponent(HartModemComponent::kTypeId, modemParams);
        const uint32_t ground = session.addComponent("other.ground", {});
        session.connectWire(supply, "out", resistor, "p1");
        session.connectWire(resistor, "p2", modemIndex, "loop_plus");
        for (const auto& [address, id] : addresses) {
            const uint32_t index = session.addComponent("protocol.hart.device.standard", multidropParams(address, id));
            session.connectWire(modemIndex, "loop_minus", index, "loop_plus");
            session.connectWire(index, "loop_minus", ground, "pin");
        }
        for (int i = 0; i < 20 && session.settleStep(); ++i) {}
    }

    static registry::ComponentParams multidropParams(int address, const std::string& uniqueId) {
        registry::ComponentParams params = ld301Params();
        params.properties["pollingAddress"] = static_cast<double>(address);
        params.properties["uniqueId"] = uniqueId;
        return params;
    }

    double resistorVolts() { return session.nodeVoltageOfPin(resistor, "p1") - session.nodeVoltageOfPin(resistor, "p2"); }

    Bytes transact(const Bytes& frame, uint64_t limitNs = 800'000'000) {
        Bytes received;
        modem->hostWrite(frame);
        for (uint64_t t = 0; t < limitNs; t += 1'000'000) {
            session.scheduler().step(1'000'000);
            const Bytes out = modem->takeHostOutput();
            received.insert(received.end(), out.begin(), out.end());
            bool busy = false;
            for (auto* device : devices) busy = busy || device->wireTransmitting();
            if (!received.empty() && !busy && t > 50'000'000) {
                // let the last bytes reach the PC side
                session.scheduler().step(5'000'000);
                const Bytes tail = modem->takeHostOutput();
                received.insert(received.end(), tail.begin(), tail.end());
                break;
            }
        }
        return received;
    }
};

Bytes shortFrame(uint8_t pollingAddress, uint8_t command) {
    Bytes frame{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x02, static_cast<uint8_t>(0x80 | pollingAddress), command, 0x00};
    uint8_t checksum = 0;
    for (size_t i = 5; i < frame.size(); ++i) checksum ^= frame[i];
    frame.push_back(checksum);
    return frame;
}

Bytes longFrame(const std::string& uniqueId, uint8_t command) {
    const uint32_t id = static_cast<uint32_t>(std::stoul(uniqueId, nullptr, 16));
    Bytes frame{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x82, 0x80 | 0x3E, 0x01, static_cast<uint8_t>(id >> 16), static_cast<uint8_t>(id >> 8),
                static_cast<uint8_t>(id), command, 0x00};
    uint8_t checksum = 0;
    for (size_t i = 5; i < frame.size(); ++i) checksum ^= frame[i];
    frame.push_back(checksum);
    return frame;
}

void multidropTests() {
    const std::vector<std::pair<int, std::string>> addresses{{1, "000101"}, {2, "000202"}, {3, "000303"}};
    registry::ComponentParams modemParams;
    Multidrop loop(addresses, modemParams);
    check(loop.modem && loop.devices.size() == 3, "M0 one supply, one 250 ohm resistor, one HART modem, three LD301 on the same pair");
    loop.session.scheduler().step(2'000'000);
    check(std::fabs(loop.resistorVolts() - 3.0) < 1e-3,
          "M1 multidrop (HART 5, address != 0): every transmitter parks at 4 mA -> 3 x 4 mA = 12 mA, 3.000 V on 250 ohm (" +
          std::to_string(loop.resistorVolts()) + " V)");
    lasecsimul::simulation::Scheduler twinScheduler(6, [] { return true; });
    auto twinPreset = HartCommunicationComponent::standardFieldDevicePreset();
    for (size_t k = 0; k < addresses.size(); ++k) {
        const auto& [address, id] = addresses[k];
        HartCommunicationComponent twin(HartCommunicationComponent::Mode::Serial, twinScheduler, Multidrop::multidropParams(address, id), &twinPreset);
        HartResponseBuilder expected(300);
        twin.transact(shortFrame(static_cast<uint8_t>(address), 0), expected);
        const Bytes reply = loop.transact(shortFrame(static_cast<uint8_t>(address), 0));
        check(withoutPreambles(reply) == withoutPreambles(Bytes(expected.bytes().begin(), expected.bytes().end())) &&
                  loop.devices[k]->wireRepliesSent() == 1,
              "M2 polling address " + std::to_string(address) + ": Command 0 (short frame) answered only by device ID " + id +
                  (withoutPreambles(reply).empty() ? " (no reply)" : ""));
    }
    {
        HartCommunicationComponent twin(HartCommunicationComponent::Mode::Serial, twinScheduler, Multidrop::multidropParams(2, "000202"), &twinPreset);
        HartResponseBuilder warm(300);
        twin.transact(shortFrame(2, 0), warm);
        HartResponseBuilder expected(300);
        twin.transact(longFrame("000202", 1), expected);
        const Bytes reply = loop.transact(longFrame("000202", 1));
        check(withoutPreambles(reply) == withoutPreambles(Bytes(expected.bytes().begin(), expected.bytes().end())) &&
                  loop.devices[0]->wireRepliesSent() == 1 && loop.devices[1]->wireRepliesSent() == 2 && loop.devices[2]->wireRepliesSent() == 1,
              "M3 long frame to device ID 000202: only that transmitter answers Command 1; the others heard it and stayed quiet");
    }
    check(withoutPreambles(loop.transact(shortFrame(9, 0), 600'000'000)).empty(), "M4 polling address 9 (no device): no reply");

    // PC side over UDP instead of COM: one HART frame per datagram.
    registry::ComponentParams udpModem;
    udpModem.properties["pc_link"] = std::string("udp");
    udpModem.properties["udp_address"] = std::string("127.0.0.1");
    udpModem.properties["udp_port"] = 15094.0;
    udpModem.properties["auto_open"] = true;
    Multidrop overUdp({{1, "000101"}, {2, "000202"}}, udpModem);
    bool modemOpen = false;
    std::string modemError;
    for (auto& descriptor : overUdp.modem->propertyDescriptors()) {
        if (descriptor.schema.id == "port_is_open") modemOpen = std::get<bool>(descriptor.get());
        if (descriptor.schema.id == "port_error") modemError = std::get<std::string>(descriptor.get());
    }
    HostUdpSocket client;
    const bool clientOpen = client.open("127.0.0.1", 0);
    check(modemOpen && clientOpen, "M5 modem PC side = UDP 127.0.0.1:15094 (property pc_link = udp)" +
          (modemOpen ? std::string() : " [modem: " + modemError + "]") + (clientOpen ? std::string() : " [client: " + client.error() + "]"));
    HostUdpSocket::Peer modemPeer;
    {
        // 127.0.0.1:15094 in network byte order.
        const uint8_t address[4] = {127, 0, 0, 1};
        std::memcpy(&modemPeer.address, address, 4);
        const uint8_t port[2] = {15094 >> 8, 15094 & 0xFF};
        std::memcpy(&modemPeer.port, port, 2);
    }
    const Bytes request = shortFrame(2, 0);
    client.sendTo(request, modemPeer);
    Bytes datagram;
    for (int ms = 0; ms < 800 && datagram.empty(); ++ms) {
        overUdp.session.scheduler().step(1'000'000);
        uint8_t buffer[512];
        HostUdpSocket::Peer from;
        const size_t got = client.receive(buffer, sizeof buffer, from);
        if (got) datagram.assign(buffer, buffer + got);
    }
    HartCommunicationComponent twin(HartCommunicationComponent::Mode::Serial, twinScheduler, Multidrop::multidropParams(2, "000202"), &twinPreset);
    HartResponseBuilder expected(300);
    twin.transact(request, expected);
    check(!datagram.empty() && withoutPreambles(datagram) == withoutPreambles(Bytes(expected.bytes().begin(), expected.bytes().end())),
          "M6 over UDP: the request datagram went through the wire to address 2 and the whole reply frame came back in one datagram");
}

} // namespace

int run();

int main() {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    try {
        return run();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "FAIL: exception: %s\n", error.what());
        return 1;
    }
}

int run() {
    // Reference transmitter (not wired): what the LD301 answers.
    lasecsimul::simulation::Scheduler twinScheduler(6, [] { return true; });
    auto twinPreset = HartCommunicationComponent::standardFieldDevicePreset();
    HartCommunicationComponent twin(HartCommunicationComponent::Mode::Serial, twinScheduler, ld301Params(), &twinPreset);
    twin.setSignalInput("PV", 940.0); // same process value as the wired transmitter
    const auto expected = [&](const Bytes& frame) {
        HartResponseBuilder response(300);
        twin.transact(frame, response);
        return Bytes(response.bytes().begin(), response.bytes().end());
    };

    {
        Loop loop;
        check(loop.modem && loop.device, "W0 circuit built: 24 V, 250 ohm, HART modem in series, LD301");
        loop.device->setSignalInput("PV", 940.0); // 50 % of 190..1690 mmH2O -> 12 mA
        for (int i = 0; i < 20 && loop.session.settleStep(); ++i) {}
        loop.session.scheduler().step(1'000'000);
        check(std::fabs(loop.resistorVolts() - 3.0) < 1e-3, "W1 DC: 12 mA through the loop -> 3.000 V on the 250 ohm resistor (" +
              std::to_string(loop.resistorVolts()) + " V)");

        const std::vector<std::pair<std::string, Bytes>> requests = {
            {"Command 0 (identity)", request(0)},
            {"Command 1 (PV)", request(1)},
            {"Command 3 (dynamic variables + current)", request(3)},
            {"Command 13 (tag, descriptor, date)", request(13)},
            {"Command 15 (range, damping, transfer function)", request(15)},
        };
        bool first = true;
        for (const auto& [name, frame] : requests) {
            const Bytes reply = expected(frame);
            const Loop::Trace trace = loop.transact(frame, withoutPreambles(reply).size());
            const Bytes body = withoutPreambles(trace.received);
            const size_t preambles = trace.received.size() - body.size();
            check(!reply.empty() && body == withoutPreambles(reply) && preambles >= 2,
                  "W2 " + name + ": the reply demodulated by the modem equals the transmitter's frame (" +
                  std::to_string(preambles) + " preambles heard)" + (body == withoutPreambles(reply) ? "" : "\n  got " + hex(trace.received) + "\n  exp " + hex(reply)));
            if (first) {
                first = false;
                const double replyPp = trace.resistorMax - trace.resistorMin;
                check(std::fabs(replyPp - 0.25) < 0.02,
                      "W3 oscilloscope on the 250 ohm resistor during the reply: ±0.5 mA -> " + std::to_string(replyPp * 1000) + " mV p-p (expected 250)");
                check(std::fabs(trace.resistorMean() - 3.0) < 0.01,
                      "W4 the carrier has zero mean: the 4-20 mA value is unchanged (" + std::to_string(trace.resistorMean()) + " V mean)");
                const double requestPp = trace.deviceMax - trace.deviceMin;
                check(std::fabs(requestPp - 0.5) < 0.02,
                      "W5 the modem's request is a voltage carrier across the transmitter terminals: " + std::to_string(requestPp * 1000) + " mV p-p");
                const double requestOnResistor = trace.resistorMaxDuringRequest - trace.resistorMinDuringRequest;
                check(requestOnResistor < 0.005,
                      "W6 ...that does not change the loop current (" + std::to_string(requestOnResistor * 1000) + " mV p-p on the resistor)");
                check(trace.replyCompleteNs > 0 && trace.replyCompleteNs < 600'000'000,
                      "W7 request + turnaround + reply in " + std::to_string(trace.replyCompleteNs / 1'000'000) + " ms of simulated time");
                std::printf("INFO: wall time for one transaction: %.3f s (simulated %.3f s)\n", trace.wallSeconds, trace.replyCompleteNs * 1e-9);
            }
        }
        check(loop.device->wireFramesReceived() == requests.size() && loop.device->wireRepliesSent() == requests.size(),
              "W8 the transmitter received " + std::to_string(loop.device->wireFramesReceived()) + " frames on its terminals and answered each");

        const Loop::Trace other = loop.transact(request(0, {}, 0x11), 0, 600'000'000);
        check(withoutPreambles(other.received).empty(), "W9 a request to another long address gets no reply");

        loop.device->setSignalInput("PV", 565.0); // 25 % of the pressure span
        for (int i = 0; i < 20 && loop.session.settleStep(); ++i) {}
        const double linearVolts = loop.resistorVolts();
        const Loop::Trace sqrtWrite = loop.transact(request(47, Bytes{0x01}), 12);
        for (int i = 0; i < 20 && loop.session.settleStep(); ++i) {}
        const double sqrtVolts = loop.resistorVolts();
        check(!sqrtWrite.received.empty() && std::fabs(linearVolts - 2.0) < 0.01 &&
                  std::fabs(sqrtVolts - 3.0) < 0.01,
              "W12 Cmd 47 over the physical HART loop changes 25 percent pressure from 8 to 12 mA across 250 ohm");
    }
    {
        Loop weak(30.0);
        weak.device->setSignalInput("PV", 940.0);
        const Loop::Trace trace = weak.transact(request(0), 0, 700'000'000);
        check(weak.device->wireRepliesSent() == 1 && withoutPreambles(trace.received).empty(),
              "W10 with only 30 ohm in the modem the reply (30 mV p-p) is below the carrier threshold: the PC hears nothing");
    }
    {
        Loop open(250.0, false);
        const Loop::Trace trace = open.transact(request(0), 0, 600'000'000);
        check(open.device->wireFramesReceived() == 0 && trace.received.empty(), "W11 transmitter not wired into the loop: no communication");
    }

    multidropTests();
    std::printf("HART wire loop: %d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}

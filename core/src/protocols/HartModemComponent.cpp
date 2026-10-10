#include "HartModemComponent.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace lasecsimul::protocols {

namespace {
constexpr uint64_t kPollNs = 1'000'000;   ///< PC serial port polled every 1 ms of simulated time
constexpr size_t kMaxHostBuffer = 64 * 1024;

PropertySchema schema(std::string id, std::string label, std::string group, std::string unit, PropertyValueKind kind,
                      std::string editor, PropertyValue value, uint32_t flags = PropertySchemaNone) {
    PropertySchema s{std::move(id), std::move(label), std::move(group), std::move(unit), kind, std::move(editor), std::move(value)};
    s.flags = flags;
    return s;
}
} // namespace

HartModemComponent::HartModemComponent(simulation::Scheduler& scheduler, const registry::ComponentParams& params)
    : m_scheduler(scheduler) {
    const auto positions = params.pins<2>();
    m_pins[0] = Pin{positions[0].id.empty() ? "loop_plus" : positions[0].id, positions[0].x, positions[0].y};
    m_pins[1] = Pin{positions[1].id.empty() ? "loop_minus" : positions[1].id, positions[1].x, positions[1].y};
    if (const auto it = params.properties.find("port_name"); it != params.properties.end())
        if (const auto* name = std::get_if<std::string>(&it->second)) m_portName = *name;
    m_autoOpen = params.property("auto_open", false);
    if (const auto it = params.properties.find("pc_link"); it != params.properties.end())
        if (const auto* link = std::get_if<std::string>(&it->second)) m_udpLink = *link == "udp";
    if (const auto it = params.properties.find("udp_address"); it != params.properties.end())
        if (const auto* address = std::get_if<std::string>(&it->second)) m_udpAddress = *address;
    m_udpPort = static_cast<uint16_t>(std::clamp(params.property("udp_port", 5094.0), 1.0, 65535.0));
    if (const auto it = params.properties.find("connection"); it != params.properties.end())
        if (const auto* connection = std::get_if<std::string>(&it->second)) m_parallel = *connection == "parallel";
    m_senseResistance = std::clamp(params.property("senseResistance", 250.0), 1.0, 100000.0);
    m_transmitVpp = std::clamp(params.property("transmitAmplitudeMvpp", 500.0), 0.0, 5000.0) / 1000.0;
    m_portOpenRequested = m_autoOpen;
}

HartModemComponent::~HartModemComponent() {
    *m_alive = false;
    m_port.close();
    m_udp.close();
}

void HartModemComponent::onAssignedIndex(uint32_t index) {
    m_index = index;
    m_assigned = true;
    if (m_portOpenRequested) openPort();
}

void HartModemComponent::openPort() {
    m_port.close();
    m_udp.close();
    const bool opened = m_udpLink ? m_udp.open(m_udpAddress, m_udpPort)
                                  : m_port.open(m_portName, 1200, 8, HostSerialPort::Parity::Odd, 1);
    if (!opened) return;
    m_portOpenRequested = true;
    m_udpPeer = {};
    m_replyFrames.reset();
    schedulePoll(kPollNs);
}

void HartModemComponent::closePort() {
    m_port.close();
    m_udp.close();
    m_portOpenRequested = false;
}

void HartModemComponent::schedulePoll(uint64_t delayNs) {
    if (m_polling || !m_assigned) return;
    m_polling = true;
    std::weak_ptr<bool> alive = m_alive;
    // Property edits and onAssignedIndex run where the scheduler lock is
    // either held by this thread or not contended: the unlocked variant.
    m_scheduler.scheduleEventUnlocked(delayNs, [this, alive] {
        if (alive.expired() || !*alive.lock()) return;
        m_polling = false;
        m_scheduler.synchronized([this] { onPoll(); });
    });
}

void HartModemComponent::onPoll() {
    const uint64_t now = m_scheduler.nowNsUnlocked();
    std::vector<uint8_t> fromPc;
    fromPc.swap(m_hostInput);
    if (m_port.isOpen()) {
        uint8_t buffer[512];
        for (int guard = 0; guard < 16; ++guard) {
            const size_t got = m_port.read(buffer, sizeof buffer);
            if (got == 0) break;
            fromPc.insert(fromPc.end(), buffer, buffer + got);
        }
    }
    if (m_udp.isOpen()) {
        // One HART request per datagram; the reply goes to the last sender.
        uint8_t datagram[512];
        for (int guard = 0; guard < 16; ++guard) {
            HostUdpSocket::Peer from;
            const size_t got = m_udp.receive(datagram, sizeof datagram, from);
            if (got == 0) break;
            m_udpPeer = from;
            fromPc.insert(fromPc.end(), datagram, datagram + got);
        }
    }
    if (!fromPc.empty()) {
        m_bytesFromPc += fromPc.size();
        startTransmit(fromPc, now);
    }
    if (!m_toPc.empty()) {
        m_bytesToPc += m_toPc.size();
        if (m_port.isOpen()) m_port.write(m_toPc);
        else if (m_udp.isOpen()) {
            for (const auto& frame : m_replyFrames.push(m_toPc)) m_udp.sendTo(frame, m_udpPeer);
        } else if (m_hostOutput.size() + m_toPc.size() <= kMaxHostBuffer) m_hostOutput.insert(m_hostOutput.end(), m_toPc.begin(), m_toPc.end());
        m_toPc.clear();
    }
    if (pcLinkOpen()) schedulePoll(kPollNs);
}

void HartModemComponent::startTransmit(std::span<const uint8_t> bytes, uint64_t nowNs) {
    m_tx.send(bytes, nowNs);
    if (m_sampling || !m_tx.active()) return;
    // Half duplex: the modem does not listen to its own carrier.
    m_rx.setMuted(true);
    m_sampling = true;
    std::weak_ptr<bool> alive = m_alive;
    m_scheduler.scheduleEventUnlocked(0, [this, alive] {
        if (alive.expired() || !*alive.lock()) return;
        m_scheduler.synchronized([this] { onCarrierSample(); });
    });
}

void HartModemComponent::onCarrierSample() {
    const uint64_t now = m_scheduler.nowNsUnlocked();
    m_tx.advance(now);
    m_scheduler.dirtySet().insert(m_index);
    if (m_tx.active()) {
        std::weak_ptr<bool> alive = m_alive;
        m_scheduler.scheduleEventUnlocked(hart_phy::kSampleNs, [this, alive] {
            if (alive.expired() || !*alive.lock()) return;
            m_scheduler.synchronized([this] { onCarrierSample(); });
        });
        return;
    }
    m_sampling = false;
    m_rx.setMuted(false);
}

void HartModemComponent::stamp(MnaMatrixView& matrix) {
    const uint64_t now = m_scheduler.nowNsUnlocked();
    m_tx.advance(now);
    const double transmit = 0.5 * m_transmitVpp * m_tx.value(now);
    if (m_parallel) {
        // Across the line: 1 Mohm receiver; the carrier is injected through the output resistance with
        // no DC path (coupling capacitor), so the 4-20 mA is untouched. The receiver hears the line
        // voltage (its high-pass removes the DC).
        matrix.addConductance(m_pins[0], m_pins[1], kParallelInputConductance);
        if (transmit != 0.0) matrix.addCurrent(m_pins[1], m_pins[0], transmit / m_senseResistance);
        m_senseVolts = matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]);
    } else {
        // Sense resistance in series with the transmit source (Norton form):
        // i(L+ -> L-) = (V(L+) - V(L-) - v_tx) / R.
        const double conductance = 1.0 / m_senseResistance;
        matrix.addConductance(m_pins[0], m_pins[1], conductance);
        if (transmit != 0.0) matrix.addCurrent(m_pins[1], m_pins[0], conductance * transmit);
        m_senseVolts = matrix.getNodeVoltage(m_pins[0]) - matrix.getNodeVoltage(m_pins[1]) - transmit;
    }
    if (m_rx.muted()) return;
    m_rx.sample(now, m_senseVolts);
    const std::vector<uint8_t> bytes = m_rx.takeBytes();
    if (bytes.empty()) return;
    m_toPc.insert(m_toPc.end(), bytes.begin(), bytes.end());
    if (!m_polling && m_assigned) {
        // Deliver promptly also when no serial port is open (tests/tools).
        m_polling = true;
        std::weak_ptr<bool> alive = m_alive;
        m_scheduler.scheduleEventUnlocked(0, [this, alive] {
            if (alive.expired() || !*alive.lock()) return;
            m_polling = false;
            m_scheduler.synchronized([this] { onPoll(); });
        });
    }
}

void HartModemComponent::hostWrite(std::span<const uint8_t> bytes) {
    m_hostInput.insert(m_hostInput.end(), bytes.begin(), bytes.end());
    schedulePoll(0);
}

std::vector<uint8_t> HartModemComponent::takeHostOutput() {
    std::vector<uint8_t> out;
    out.swap(m_hostOutput);
    return out;
}

size_t HartModemComponent::getState(uint8_t* out, size_t cap) const {
    // Loop current through the modem (A), carrier on the wire, transmitting.
    struct State { double loopCurrent; uint8_t carrier; uint8_t transmitting; };
    if (cap < sizeof(State)) return 0;
    const State state{current().value_or(0.0), static_cast<uint8_t>(m_rx.carrierAt(m_scheduler.nowNs()) ? 1 : 0),
                      static_cast<uint8_t>(m_tx.active() ? 1 : 0)};
    std::memcpy(out, &state, sizeof state);
    return sizeof state;
}

std::vector<PropertySchema> HartModemComponent::propertySchema() {
    std::vector<PropertySchema> out;
    PropertySchema link = schema("pc_link", "Ligacao com o PC", "PC", "", PropertyValueKind::String, "select", std::string("serial"));
    link.options = {{"serial", "Serial (COM / CNC)"}, {"udp", "UDP"}};
    out.push_back(link);
    out.push_back(schema("port_name", "Porta serial (COM / CNC)", "PC", "", PropertyValueKind::String, "text", std::string("COM1")));
    out.push_back(schema("udp_address", "Endereco UDP local", "PC", "", PropertyValueKind::String, "text", std::string("127.0.0.1")));
    PropertySchema udpPort = schema("udp_port", "Porta UDP", "PC", "", PropertyValueKind::Number, "number", 5094.0);
    udpPort.minValue = 1.0;
    udpPort.maxValue = 65535.0;
    out.push_back(udpPort);
    out.push_back(schema("auto_open", "Abrir automaticamente", "PC", "", PropertyValueKind::Bool, "checkbox", false));
    PropertySchema connection = schema("connection", "Ligacao na linha", "HART", "", PropertyValueKind::String, "select", std::string("series"));
    connection.options = {{"series", "Em serie no laco (transmissor)"}, {"parallel", "Em paralelo na linha (posicionador / garras)"}};
    out.push_back(connection);
    PropertySchema resistance = schema("senseResistance", "Resistor interno (carga HART)", "HART", "Ω", PropertyValueKind::Number, "number", 250.0);
    resistance.minValue = 1.0;
    resistance.maxValue = 100000.0;
    out.push_back(resistance);
    PropertySchema amplitude = schema("transmitAmplitudeMvpp", "Amplitude de transmissao", "HART", "mVpp", PropertyValueKind::Number, "number", 500.0);
    amplitude.minValue = 0.0;
    amplitude.maxValue = 5000.0;
    out.push_back(amplitude);
    out.push_back(schema("port_open", "Solicitar abertura", "Interno", "", PropertyValueKind::Bool, "checkbox", false, PropertySchemaHidden));
    out.push_back(schema("port_is_open", "Porta aberta", "Diagnostico", "", PropertyValueKind::Bool, "checkbox", false,
                         PropertySchemaHidden | PropertySchemaReadOnly));
    out.push_back(schema("port_error", "Erro da porta", "Diagnostico", "", PropertyValueKind::String, "display", std::string(),
                         PropertySchemaHidden | PropertySchemaReadOnly));
    out.push_back(schema("port_rx_bytes", "Bytes enviados ao PC", "Diagnostico", "", PropertyValueKind::Number, "number", 0.0,
                         PropertySchemaHidden | PropertySchemaReadOnly));
    out.push_back(schema("port_tx_bytes", "Bytes recebidos do PC", "Diagnostico", "", PropertyValueKind::Number, "number", 0.0,
                         PropertySchemaHidden | PropertySchemaReadOnly));
    return out;
}

PropertyValue HartModemComponent::propertyValue(const std::string& id) const {
    if (id == "port_name") return m_portName;
    if (id == "pc_link") return std::string(m_udpLink ? "udp" : "serial");
    if (id == "udp_address") return m_udpAddress;
    if (id == "udp_port") return static_cast<double>(m_udpPort);
    if (id == "auto_open") return m_autoOpen;
    if (id == "connection") return std::string(m_parallel ? "parallel" : "series");
    if (id == "senseResistance") return m_senseResistance;
    if (id == "transmitAmplitudeMvpp") return m_transmitVpp * 1000.0;
    if (id == "port_open") return m_portOpenRequested;
    if (id == "port_is_open") return pcLinkOpen();
    if (id == "port_error") return pcLinkError();
    if (id == "port_rx_bytes") return static_cast<double>(m_bytesToPc);
    if (id == "port_tx_bytes") return static_cast<double>(m_bytesFromPc);
    return std::string();
}

void HartModemComponent::setPropertyValue(const std::string& id, const PropertyValue& value) {
    if (id == "port_name" && std::holds_alternative<std::string>(value)) {
        m_portName = std::get<std::string>(value);
        if (pcLinkOpen()) { closePort(); openPort(); }
    } else if (id == "pc_link" && std::holds_alternative<std::string>(value)) {
        const bool reopen = pcLinkOpen();
        if (reopen) closePort();
        m_udpLink = std::get<std::string>(value) == "udp";
        if (reopen) openPort();
    } else if (id == "udp_address" && std::holds_alternative<std::string>(value)) {
        m_udpAddress = std::get<std::string>(value);
        if (pcLinkOpen()) { closePort(); openPort(); }
    } else if (id == "udp_port" && std::holds_alternative<double>(value)) {
        m_udpPort = static_cast<uint16_t>(std::clamp(std::get<double>(value), 1.0, 65535.0));
        if (pcLinkOpen()) { closePort(); openPort(); }
    } else if (id == "auto_open" && std::holds_alternative<bool>(value)) {
        m_autoOpen = std::get<bool>(value);
    } else if (id == "connection" && std::holds_alternative<std::string>(value)) {
        m_parallel = std::get<std::string>(value) == "parallel";
        if (m_assigned) m_scheduler.dirtySet().insert(m_index);
    } else if (id == "senseResistance" && std::holds_alternative<double>(value)) {
        m_senseResistance = std::clamp(std::get<double>(value), 1.0, 100000.0);
        if (m_assigned) m_scheduler.dirtySet().insert(m_index);
    } else if (id == "transmitAmplitudeMvpp" && std::holds_alternative<double>(value)) {
        m_transmitVpp = std::clamp(std::get<double>(value), 0.0, 5000.0) / 1000.0;
    } else if (id == "port_open" && std::holds_alternative<bool>(value)) {
        if (std::get<bool>(value)) openPort();
        else closePort();
    }
}

std::vector<PropertyDescriptor> HartModemComponent::propertyDescriptors() {
    std::vector<PropertyDescriptor> out;
    for (const auto& item : propertySchema())
        out.push_back({item.id, item.unit, [this, id = item.id] { return propertyValue(id); },
                       [this, id = item.id](const PropertyValue& v) { setPropertyValue(id, v); }, item});
    return out;
}

} // namespace lasecsimul::protocols

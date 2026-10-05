#pragma once

#include "HartPhysicalLayer.hpp"
#include "HostSerialPort.hpp"
#include "HostUdpSocket.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "registry/ComponentParams.hpp"
#include "simulation/Scheduler.hpp"

#include <array>
#include <memory>
#include <string>
#include <vector>

namespace lasecsimul::protocols {

/**
 * HART modem: the PC side of a 4-20 mA + HART loop, wired IN SERIES with the
 * loop (terminals L+ / L-), like a series HART interface with its own sense
 * resistor.
 *
 * Electrically it is a sense resistance (default 250 ohm, the HART loop load)
 * in series with the modem's transmit source:
 *  - receive: the field device's ±0.5 mA current carrier becomes a voltage on
 *    the sense resistance and is demodulated (Bell 202);
 *  - transmit: the bytes the PC writes to the serial port are sent as a
 *    ≈500 mV p-p voltage carrier in series with the loop, which the field
 *    devices see across their terminals.
 * The PC side is chosen per instance: a serial port (COMx / com0com CNCx,
 * 1200 bit/s 8O1, byte stream) or UDP (one HART frame per datagram, the reply
 * goes back to the sender). Bytes from the PC are modulated onto the wire,
 * bytes demodulated from the wire go to the PC -- nothing reaches a device
 * except through the circuit, so one modem serves every device on the loop
 * (multidrop, polling addresses 0..63).
 */
class HartModemComponent final : public IComponentModel {
public:
    static constexpr const char* kTypeId = "protocol.hart.modem";

    HartModemComponent(simulation::Scheduler& scheduler, const registry::ComponentParams& params);
    ~HartModemComponent() override;

    const char* typeId() const override { return kTypeId; }
    std::span<Pin> pins() override { return m_pins; }
    void onAssignedIndex(uint32_t index) override;
    void stamp(MnaMatrixView& matrix) override;
    void postStep(uint64_t) override {}
    size_t getState(uint8_t* out, size_t cap) const override;
    void setState(const uint8_t*, size_t) override {}
    std::vector<PropertyDescriptor> propertyDescriptors() override;
    std::optional<double> current() const override { return m_senseVolts / m_senseResistance; }

    static std::vector<PropertySchema> propertySchema();

    /** PC side without a serial port (tests/tools): bytes "written by the
     * PC" and bytes the modem delivered to the PC. */
    void hostWrite(std::span<const uint8_t> bytes);
    std::vector<uint8_t> takeHostOutput();
    bool transmitting() const noexcept { return m_tx.active(); }
    bool carrier() const { return m_rx.carrierAt(m_scheduler.nowNs()); }

private:
    PropertyValue propertyValue(const std::string& id) const;
    void setPropertyValue(const std::string& id, const PropertyValue& value);
    void openPort();
    void closePort();
    void schedulePoll(uint64_t delayNs);
    void onPoll();
    void startTransmit(std::span<const uint8_t> bytes, uint64_t nowNs);
    void onCarrierSample();

    simulation::Scheduler& m_scheduler;
    std::array<Pin, 2> m_pins{};
    uint32_t m_index = 0;
    bool m_assigned = false;
    /** Guards scheduled callbacks against a destroyed component. */
    std::shared_ptr<bool> m_alive = std::make_shared<bool>(true);

    double m_senseResistance = 250.0;
    double m_transmitVpp = 0.5;
    HartFskTransmitter m_tx;
    HartFskReceiver m_rx;
    bool m_sampling = false;
    bool m_polling = false;
    double m_senseVolts = 0.0;

    bool pcLinkOpen() const { return m_udpLink ? m_udp.isOpen() : m_port.isOpen(); }
    const std::string& pcLinkError() const { return m_udpLink ? m_udp.error() : m_port.error(); }

    HostSerialPort m_port;
    std::string m_portName = "COM1";
    /** PC side: false = serial port, true = UDP. */
    bool m_udpLink = false;
    HostUdpSocket m_udp;
    std::string m_udpAddress = "127.0.0.1";
    uint16_t m_udpPort = 5094;
    HostUdpSocket::Peer m_udpPeer;
    /** Replies cut into whole HART frames for UDP datagrams. */
    HartFrameAssembler m_replyFrames;
    bool m_portOpenRequested = false;
    bool m_autoOpen = false;
    uint64_t m_bytesFromPc = 0;   ///< "tx" from the PC's point of view (modulated onto the loop)
    uint64_t m_bytesToPc = 0;     ///< "rx" for the PC (demodulated from the loop)
    std::vector<uint8_t> m_toPc;
    std::vector<uint8_t> m_hostInput;
    std::vector<uint8_t> m_hostOutput;
};

} // namespace lasecsimul::protocols

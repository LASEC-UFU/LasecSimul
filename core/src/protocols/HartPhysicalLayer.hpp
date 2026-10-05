#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <span>
#include <vector>

namespace lasecsimul::protocols {

/**
 * HART physical layer (HCF_SPEC-54, Bell 202 FSK) as an electrical signal.
 *
 * A HART character is a UART frame of 11 bits at 1200 bit/s -- start (0),
 * 8 data bits LSB first, odd parity, stop (1) -- sent as a phase-continuous
 * sine: 1200 Hz for a "1" (mark) and 2200 Hz for a "0" (space). A slave
 * modulates its loop current (±0.5 mA around the 4-20 mA value); a master
 * modulates the loop voltage (≈500 mV p-p). Both directions use the same
 * coding, so the transmitter and the receiver below are shared by the field
 * device and by the HART modem.
 *
 * The receiver works only from the sampled waveform: DC removal, carrier
 * detection by amplitude (HART receivers must accept ≥120 mV p-p and reject
 * ≤80 mV p-p), zero-crossing frequency discrimination and UART sampling at the
 * bit centres. A loop without enough resistance, an open wire or a too weak
 * carrier therefore fails exactly like real hardware.
 */
namespace hart_phy {
inline constexpr double kMarkHz = 1200.0;
inline constexpr double kSpaceHz = 2200.0;
inline constexpr uint64_t kBitNs = 833'333;          ///< 1200 bit/s
inline constexpr uint64_t kCharNs = 11 * kBitNs;     ///< start + 8 data + odd parity + stop
/** Carrier sampling period while transmitting (50 kHz: ≥22 points per
 * 2200 Hz cycle -- smooth on an oscilloscope, cheap for the solver). */
inline constexpr uint64_t kSampleNs = 20'000;
/** Slave transmit amplitude: ±0.5 mA (1 mA p-p) on the loop current. */
inline constexpr double kSlaveCurrentAmplitudeA = 0.5e-3;
/** Receiver carrier detect thresholds (peak-to-peak volts). */
inline constexpr double kCarrierOnVpp = 0.100;
inline constexpr double kCarrierOffVpp = 0.080;
}

/** Phase-continuous Bell 202 transmitter. Queue characters with `send`; the
 * carrier starts with a short mark lead-in, sends the characters back to back
 * and drops after `idleHoldNs` of mark once the queue is empty. */
class HartFskTransmitter {
public:
    void send(std::span<const uint8_t> bytes, uint64_t nowNs);
    /** Moves the bit timeline to `nowNs` (non-decreasing). */
    void advance(uint64_t nowNs);
    /** Unit-amplitude carrier at `nowNs` (after `advance`), 0 when off. */
    double value(uint64_t nowNs) const;
    bool active() const noexcept { return m_on; }
    size_t queued() const noexcept { return m_queue.size(); }
    /** Time the carrier last went off (0 = never on). */
    uint64_t carrierOffNs() const noexcept { return m_offNs; }
    void reset();

    uint64_t leadInNs = 2 * hart_phy::kBitNs;
    uint64_t idleHoldNs = 2 * hart_phy::kBitNs;

private:
    void nextBit();
    std::deque<uint8_t> m_queue;
    bool m_on = false;
    uint64_t m_bitStartNs = 0;
    double m_phaseAtBitStart = 0.0;
    bool m_mark = true;
    uint16_t m_frame = 0;      ///< remaining bits of the current character, LSB first
    int m_bitsLeft = 0;
    int m_leadBits = 0;
    uint64_t m_idleNs = 0;     ///< mark idle time accumulated since the queue emptied
    uint64_t m_offNs = 0;
    uint64_t m_stopAtNs = 0;   ///< carrier stops at this zero crossing (0 = not stopping)
};

/** Bell 202 receiver fed with (time, volts) samples. Repeated samples at the
 * same instant replace each other (a settle round may re-read a node). */
class HartFskReceiver {
public:
    void sample(uint64_t tNs, double volts);
    /** Half duplex: a transmitting station ignores its own line. */
    void setMuted(bool muted);
    bool muted() const noexcept { return m_muted; }
    /** Carrier present at `nowNs` (the envelope decays without samples). */
    bool carrierAt(uint64_t nowNs) const;
    /** Last instant the carrier was seen. */
    uint64_t lastCarrierNs() const noexcept { return m_lastCarrierNs; }
    std::vector<uint8_t> takeBytes();
    uint32_t parityErrors() const noexcept { return m_parityErrors; }
    uint32_t framingErrors() const noexcept { return m_framingErrors; }
    /** Peak-to-peak amplitude of the AC signal last seen (volts). */
    double peakToPeak() const noexcept { return 2.0 * m_envelope; }
    void reset();

private:
    struct HalfPeriod { double startNs; double endNs; bool mark; };
    void commit(uint64_t tNs, double volts);
    void onZeroCrossing(double tNs);
    void runUart();
    void resetLine();
    bool markAt(double tNs, bool& known) const;

    bool m_muted = false;
    bool m_havePending = false;
    uint64_t m_pendingT = 0;
    double m_pendingV = 0.0;
    bool m_havePrev = false;
    uint64_t m_prevT = 0;
    double m_prevAc = 0.0;
    double m_mean = 0.0;
    double m_envelope = 0.0;
    bool m_carrier = false;
    uint64_t m_lastCarrierNs = 0;
    int m_sign = 0;
    double m_zeroCandidateNs = -1.0;
    double m_lastZeroNs = -1.0;
    std::deque<HalfPeriod> m_halves;
    size_t m_scan = 0;
    size_t m_charHalf = 0;
    bool m_inChar = false;
    double m_charStartNs = 0.0;
    int m_bit = 0;
    uint16_t m_bits = 0;
    std::vector<uint8_t> m_bytes;
    uint32_t m_parityErrors = 0;
    uint32_t m_framingErrors = 0;
};

/** Cuts complete HART frames (≥2 preambles 0xFF, delimiter, address, command,
 * byte count, data, checksum) out of the received character stream. */
class HartFrameAssembler {
public:
    /** Returns the frames completed by `bytes` (preambles included). */
    std::vector<std::vector<uint8_t>> push(std::span<const uint8_t> bytes);
    void reset();

private:
    std::vector<uint8_t> m_frame;
    size_t m_preambles = 0;
    size_t m_expected = 0;   ///< total frame length once the byte count is known
    size_t m_headerLength = 0;
    bool m_inFrame = false;
};

} // namespace lasecsimul::protocols

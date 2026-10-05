#include "HartPhysicalLayer.hpp"

#include <algorithm>
#include <bit>
#include <cmath>

namespace lasecsimul::protocols {

namespace {
constexpr double kTwoPi = 6.283185307179586;
constexpr double kBitPeriodNs = 1e9 / 1200.0;
constexpr double kSpaceHalfNs = 1e9 / (2.0 * hart_phy::kSpaceHz);  // 227.3 µs
constexpr double kMarkHalfNs = 1e9 / (2.0 * hart_phy::kMarkHz);    // 416.7 µs
/** Half periods longer than this are a 1200 Hz (mark) half cycle. */
constexpr double kHalfThresholdNs = 320'000.0;
/** A half period that straddles a mark->space bit boundary lasts
 * a + (1 - 2·1200·a)/(2·2200): it grows by this factor of the mark part `a`. */
constexpr double kStraddleSlope = 1.0 - hart_phy::kMarkHz / hart_phy::kSpaceHz;
constexpr double kHighPassTauNs = 3.0e6;    ///< DC removal (≈53 Hz)
constexpr double kEnvelopeTauNs = 2.0e6;    ///< carrier envelope decay
constexpr uint64_t kGapNs = 5'000'000;      ///< no samples for this long: line restarts

uint16_t characterFrame(uint8_t byte) {
    // start (0), 8 data bits LSB first, odd parity, stop (1).
    const uint16_t parity = (std::popcount(byte) % 2 == 0) ? 1u : 0u;
    return static_cast<uint16_t>((static_cast<uint16_t>(byte) << 1) | (parity << 9) | (1u << 10));
}
} // namespace

// ------------------------------------------------------------- transmitter

void HartFskTransmitter::send(std::span<const uint8_t> bytes, uint64_t nowNs) {
    m_queue.insert(m_queue.end(), bytes.begin(), bytes.end());
    if (m_on && !m_queue.empty()) m_stopAtNs = 0; // more to send: keep the carrier
    if (m_on || m_queue.empty()) return;
    // Carrier on: a short mark lead-in lets every receiver lock before the
    // first start bit.
    m_on = true;
    m_bitStartNs = nowNs;
    m_phaseAtBitStart = 0.0;
    m_mark = true;
    m_bitsLeft = 0;
    m_idleNs = 0;
    const uint64_t leadBits = std::max<uint64_t>(1, (leadInNs + hart_phy::kBitNs - 1) / hart_phy::kBitNs);
    m_idleNs = 0;
    m_leadBits = static_cast<int>(leadBits) - 1;
}

void HartFskTransmitter::nextBit() {
    const double frequency = m_mark ? hart_phy::kMarkHz : hart_phy::kSpaceHz;
    m_phaseAtBitStart = std::fmod(m_phaseAtBitStart + kTwoPi * frequency * (static_cast<double>(hart_phy::kBitNs) * 1e-9), kTwoPi);
    m_bitStartNs += hart_phy::kBitNs;
    if (m_leadBits > 0) {
        --m_leadBits;
        m_mark = true;
        return;
    }
    if (m_bitsLeft == 0) {
        if (m_queue.empty()) {
            m_idleNs += hart_phy::kBitNs;
            if (m_idleNs > idleHoldNs && m_stopAtNs == 0) {
                // The carrier stops at its next zero crossing: no step on
                // the line (clean on an oscilloscope).
                const double toZero = std::ceil(m_phaseAtBitStart / 3.141592653589793) * 3.141592653589793 - m_phaseAtBitStart;
                m_stopAtNs = m_bitStartNs + static_cast<uint64_t>(toZero / (kTwoPi * hart_phy::kMarkHz) * 1e9);
            }
            m_mark = true;
            return;
        }
        m_frame = characterFrame(m_queue.front());
        m_queue.pop_front();
        m_bitsLeft = 11;
        m_idleNs = 0;
    }
    m_mark = (m_frame & 1u) != 0;
    m_frame = static_cast<uint16_t>(m_frame >> 1);
    --m_bitsLeft;
}

void HartFskTransmitter::advance(uint64_t nowNs) {
    while (m_on && m_stopAtNs == 0 && nowNs >= m_bitStartNs + hart_phy::kBitNs) nextBit();
    if (m_on && m_stopAtNs != 0 && nowNs >= m_stopAtNs) {
        m_on = false;
        m_offNs = m_stopAtNs;
        m_stopAtNs = 0;
    }
}

double HartFskTransmitter::value(uint64_t nowNs) const {
    if (!m_on || nowNs < m_bitStartNs || (m_stopAtNs != 0 && nowNs >= m_stopAtNs)) return 0.0;
    const double frequency = m_mark ? hart_phy::kMarkHz : hart_phy::kSpaceHz;
    return std::sin(m_phaseAtBitStart + kTwoPi * frequency * (static_cast<double>(nowNs - m_bitStartNs) * 1e-9));
}

void HartFskTransmitter::reset() {
    m_queue.clear();
    m_on = false;
    m_bitsLeft = 0;
    m_leadBits = 0;
    m_idleNs = 0;
    m_stopAtNs = 0;
}

// ---------------------------------------------------------------- receiver

void HartFskReceiver::sample(uint64_t tNs, double volts) {
    if (m_muted || !std::isfinite(volts)) return;
    // The value at an instant is final only once time moves on: a node may
    // be re-read several times during one settle.
    if (m_havePending && tNs == m_pendingT) {
        m_pendingV = volts;
        return;
    }
    if (m_havePending) {
        if (tNs < m_pendingT) return;
        commit(m_pendingT, m_pendingV);
    }
    m_havePending = true;
    m_pendingT = tNs;
    m_pendingV = volts;
}

void HartFskReceiver::setMuted(bool muted) {
    if (muted == m_muted) return;
    m_muted = muted;
    m_havePending = false;
    m_havePrev = false;
    m_carrier = false;
    m_envelope = 0.0;
    resetLine();
}

bool HartFskReceiver::carrierAt(uint64_t nowNs) const {
    if (m_muted || !m_carrier || !m_havePrev) return false;
    const uint64_t last = m_havePending ? m_pendingT : m_prevT;
    if (nowNs > last + kGapNs) return false;
    const double decayed = m_envelope * std::exp(-static_cast<double>(nowNs > m_prevT ? nowNs - m_prevT : 0) / kEnvelopeTauNs);
    return 2.0 * decayed >= hart_phy::kCarrierOffVpp;
}

std::vector<uint8_t> HartFskReceiver::takeBytes() {
    std::vector<uint8_t> out;
    out.swap(m_bytes);
    return out;
}

void HartFskReceiver::reset() {
    m_havePending = false;
    m_havePrev = false;
    m_carrier = false;
    m_envelope = 0.0;
    m_bytes.clear();
    resetLine();
}

void HartFskReceiver::resetLine() {
    m_halves.clear();
    m_scan = 0;
    m_inChar = false;
    m_charHalf = 0;
    m_sign = 0;
    m_lastZeroNs = -1.0;
    m_zeroCandidateNs = -1.0;
}

void HartFskReceiver::commit(uint64_t tNs, double volts) {
    if (!m_havePrev || tNs - m_prevT > kGapNs) {
        m_havePrev = true;
        m_prevT = tNs;
        m_mean = volts;
        m_prevAc = 0.0;
        m_envelope = 0.0;
        m_carrier = false;
        resetLine();
        return;
    }
    const double dt = static_cast<double>(tNs - m_prevT);
    const double ac = volts - m_mean;
    m_mean += (volts - m_mean) * (1.0 - std::exp(-dt / kHighPassTauNs));
    m_envelope = std::max(std::fabs(ac), m_envelope * std::exp(-dt / kEnvelopeTauNs));
    const double peakToPeak = 2.0 * m_envelope;
    if (!m_carrier && peakToPeak >= hart_phy::kCarrierOnVpp) {
        m_carrier = true;
        resetLine();
    } else if (m_carrier && peakToPeak < hart_phy::kCarrierOffVpp) {
        m_carrier = false;
        resetLine();
    }
    if (m_carrier) {
        m_lastCarrierNs = tNs;
        if ((m_prevAc < 0.0 && ac >= 0.0) || (m_prevAc > 0.0 && ac <= 0.0))
            m_zeroCandidateNs = static_cast<double>(m_prevT) + dt * (m_prevAc / (m_prevAc - ac));
        // Schmitt trigger around zero: a crossing counts once the signal is
        // clearly on the other side (no chatter near zero).
        const double hysteresis = 0.25 * m_envelope;
        if (m_sign >= 0 && ac < -hysteresis) {
            if (m_sign > 0 && m_zeroCandidateNs >= 0.0) onZeroCrossing(m_zeroCandidateNs);
            m_sign = -1;
        } else if (m_sign <= 0 && ac > hysteresis) {
            if (m_sign < 0 && m_zeroCandidateNs >= 0.0) onZeroCrossing(m_zeroCandidateNs);
            m_sign = 1;
        }
    }
    m_prevAc = ac;
    m_prevT = tNs;
}

void HartFskReceiver::onZeroCrossing(double tNs) {
    if (m_lastZeroNs >= 0.0) {
        const double half = tNs - m_lastZeroNs;
        if (half < 0.6 * kSpaceHalfNs || half > 1.6 * kMarkHalfNs) {
            // Not a Bell 202 half cycle: the character in progress is lost.
            m_halves.clear();
            m_scan = 0;
            m_inChar = false;
        } else {
            m_halves.push_back({m_lastZeroNs, tNs, half > kHalfThresholdNs});
            runUart();
        }
    }
    m_lastZeroNs = tNs;
}

bool HartFskReceiver::markAt(double tNs, bool& known) const {
    for (auto it = m_halves.rbegin(); it != m_halves.rend(); ++it) {
        if (it->startNs <= tNs && tNs < it->endNs) {
            known = true;
            return it->mark;
        }
        if (it->endNs <= tNs) break;
    }
    known = false;
    return true;
}

void HartFskReceiver::runUart() {
    for (;;) {
        if (!m_inChar) {
            // Start bit: the first space half cycle after a mark one.
            size_t k = m_scan;
            while (k < m_halves.size() && m_halves[k].mark) ++k;
            if (k >= m_halves.size()) {
                m_scan = k;
                break;
            }
            if (k == 0) {
                m_scan = 1;
                continue;
            }
            const HalfPeriod& previous = m_halves[k - 1];
            const HalfPeriod& current = m_halves[k];
            // The mark->space boundary lies inside the straddling half cycle;
            // its length tells where (phase-continuous FSK).
            const double previousLength = previous.endNs - previous.startNs;
            const double currentLength = current.endNs - current.startNs;
            double boundary = current.startNs;
            if (previousLength < kMarkHalfNs - 12'000.0)
                boundary = previous.startNs + std::max(0.0, previousLength - kSpaceHalfNs) / kStraddleSlope;
            else if (currentLength > kSpaceHalfNs + 5'000.0)
                boundary = current.startNs + (currentLength - kSpaceHalfNs) / kStraddleSlope;
            m_inChar = true;
            m_charStartNs = boundary;
            m_charHalf = k;
            m_bit = 0;
            m_bits = 0;
        }
        const double centre = m_charStartNs + (m_bit + 0.5) * kBitPeriodNs;
        if (m_halves.empty() || m_halves.back().endNs < centre) break;
        bool known = false;
        const bool mark = markAt(centre, known);
        if (!known) {
            ++m_framingErrors;
            m_inChar = false;
            m_scan = m_halves.size();
            break;
        }
        if (m_bit == 0 && mark) {
            // False start: look for the next mark->space transition.
            m_inChar = false;
            m_scan = m_charHalf + 1;
            continue;
        }
        if (mark) m_bits = static_cast<uint16_t>(m_bits | (1u << m_bit));
        if (++m_bit < 11) continue;
        const uint8_t data = static_cast<uint8_t>((m_bits >> 1) & 0xFFu);
        const unsigned parity = (m_bits >> 9) & 1u;
        const bool stop = ((m_bits >> 10) & 1u) != 0;
        if (!stop) ++m_framingErrors;
        else if ((std::popcount(data) + parity) % 2 == 0) ++m_parityErrors;
        else m_bytes.push_back(data);
        m_inChar = false;
        // The next start bit is searched from the half cycle holding the
        // stop bit centre.
        size_t index = m_halves.size();
        while (index > 0 && m_halves[index - 1].endNs > centre) --index;
        m_scan = index;
    }
    // Bounded history: keep what the character in progress still needs.
    while (m_halves.size() > 64) {
        const size_t needed = m_inChar ? m_charHalf : m_scan;
        if (needed == 0) break;
        m_halves.pop_front();
        if (m_scan > 0) --m_scan;
        if (m_charHalf > 0) --m_charHalf;
    }
}

// ---------------------------------------------------------- frame assembler

namespace {
bool isDelimiter(uint8_t byte) {
    // Frame type (bits 0-2): 1 BACK, 2 STX, 6 ACK; physical layer bits 3-4 = 0.
    const uint8_t type = byte & 0x07u;
    return (byte & 0x18u) == 0 && (type == 1 || type == 2 || type == 6);
}
} // namespace

std::vector<std::vector<uint8_t>> HartFrameAssembler::push(std::span<const uint8_t> bytes) {
    std::vector<std::vector<uint8_t>> frames;
    for (const uint8_t byte : bytes) {
        if (!m_inFrame) {
            if (byte == 0xFF) {
                ++m_preambles;
                continue;
            }
            if (m_preambles >= 2 && isDelimiter(byte)) {
                m_frame.assign(std::min<size_t>(m_preambles, 20), 0xFF);
                m_frame.push_back(byte);
                m_inFrame = true;
                m_expected = 0;
                const size_t addressLength = (byte & 0x80u) ? 5 : 1;
                const size_t expansion = (byte >> 5) & 0x03u;
                m_headerLength = m_frame.size() + addressLength + expansion + 2;
            }
            m_preambles = 0;
            continue;
        }
        m_frame.push_back(byte);
        if (m_frame.size() == m_headerLength) m_expected = m_headerLength + byte + 1;
        if (m_expected != 0 && m_frame.size() == m_expected) {
            frames.push_back(std::move(m_frame));
            m_frame.clear();
            m_inFrame = false;
            m_preambles = 0;
            m_expected = 0;
        }
    }
    return frames;
}

void HartFrameAssembler::reset() {
    m_frame.clear();
    m_preambles = 0;
    m_expected = 0;
    m_headerLength = 0;
    m_inFrame = false;
}

} // namespace lasecsimul::protocols

#include "HartLcd.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace lasecsimul::protocols {

namespace {
constexpr uint64_t kStartupNs = 3'000'000'000ull;   // power-up page
constexpr uint64_t kPageNs = 3'000'000'000ull;      // alternation between the two variables
constexpr uint64_t kBlinkNs = 1'500'000'000ull;     // unit <-> SAT, model <-> version

void put32(uint8_t* out, uint32_t value) {
    for (int i = 0; i < 4; ++i) out[i] = static_cast<uint8_t>(value >> (8 * i));
}
} // namespace

bool hartLcdFormatNumber(double value, HartLcdFrame& frame, int maxDecimals) {
    frame.numeric = {{' ', ' ', ' ', ' ', ' ', ' '}};
    frame.decimalPoints = 0;
    const auto dashes = [&] {
        for (size_t i = 2; i < frame.numeric.size(); ++i) frame.numeric[i] = '-';
        return false;
    };
    if (!std::isfinite(value)) return dashes();
    const double magnitude = std::fabs(value);
    int decimals = -1;
    long long counts = 0;
    for (int d = std::clamp(maxDecimals, 0, 3); d >= 0; --d) {
        counts = std::llround(magnitude * std::pow(10.0, d));
        if (counts <= 19999) { decimals = d; break; }
    }
    if (decimals < 0) return dashes();
    std::string digits = std::to_string(counts);
    while (digits.size() < static_cast<size_t>(decimals) + 1) digits.insert(digits.begin(), '0');
    if (digits.size() == 5) { frame.numeric[1] = '1'; digits.erase(digits.begin()); }
    for (size_t i = 0; i < digits.size(); ++i) frame.numeric[2 + (4 - digits.size()) + i] = digits[i];
    if (decimals > 0) frame.decimalPoints = static_cast<uint8_t>(1u << (5 - decimals));
    if (value < 0 && counts > 0) frame.numeric[0] = '-';
    return true;
}

std::string hartLcdUnitLabel(uint8_t unitCode, uint32_t& annunciators) {
    switch (unitCode) {
        case 1: case 145: case 238: return "inH2O";
        case 2: return "inHg";
        case 3: return "ftH2O";
        case 4: case 239: return "mmH2O";
        case 5: return "mmHg";
        case 6: return "psi";
        case 7: return "bar";
        case 8: return "mbar";
        case 9: return "g/cm2";
        case 10: return "kgcm2";
        case 11: return "Pa";
        case 12: return "kPa";
        case 13: return "torr";
        case 14: return "atm";
        case 237: return "MPa";
        case 32: annunciators |= HartLcdAnnunciator::Degree; return "C";
        case 33: annunciators |= HartLcdAnnunciator::Degree; return "F";
        case 34: annunciators |= HartLcdAnnunciator::Degree; return "R";
        case 35: return "K";
        case 36: return "mV";
        case 37: return "Ohm"; // TT301 manual Table 4.2
        case 38: return "Hz";
        case 39: return "mA";
        case 40: return "gal";
        case 41: return "L";
        case 43: return "m3";
        case 44: return "ft";
        case 45: return "m";
        case 47: return "in";
        case 48: return "cm";
        case 49: return "mm";
        case 50: annunciators |= HartLcdAnnunciator::Minutes; return "";
        case 51: return "s";
        case 52: return "h";
        case 53: return "d";
        case 57: annunciators |= HartLcdAnnunciator::Percent; return "";
        case 58: return "V";
        default: return "";
    }
}

void hartLcdSetAlpha(HartLcdFrame& frame, const std::string& text, bool rightAlign) {
    frame.alpha = {{' ', ' ', ' ', ' ', ' '}};
    const std::string shown = text.substr(0, frame.alpha.size());
    const size_t start = rightAlign ? frame.alpha.size() - shown.size() : 0;
    for (size_t i = 0; i < shown.size(); ++i) frame.alpha[start + i] = shown[i];
}

HartLcdFrame hartLcdCompose(const HartLcdInput& input) {
    HartLcdFrame frame;
    frame.enabled = input.installed && input.powered;
    frame.glass = input.glass;
    if (!frame.enabled) return frame;
    if (input.fixedCurrent) frame.annunciators |= HartLcdAnnunciator::Fix;
    if (input.multidrop) frame.annunciators |= HartLcdAnnunciator::Multidrop;
    switch (input.transferFunctionCode) { // Common Table 3
        case 1: frame.annunciators |= HartLcdAnnunciator::Sqrt; break;
        case 2: frame.annunciators |= HartLcdAnnunciator::Sqrt | HartLcdAnnunciator::SqrtCube; break;
        case 3: frame.annunciators |= HartLcdAnnunciator::Sqrt | HartLcdAnnunciator::SqrtFifth; break;
        case 4: frame.annunciators |= HartLcdAnnunciator::Table; break;
        default: break;
    }
    if (input.malfunction) {
        hartLcdSetAlpha(frame, "FAIL");
        return frame;
    }
    if (input.elapsedNs < kStartupNs) {
        // Protocol and address on the numeric field; model, then version.
        frame.numeric = {{' ', ' ', static_cast<char>('0' + input.universalRevision % 10), ' ',
                          static_cast<char>('0' + input.pollingAddress / 10 % 10), static_cast<char>('0' + input.pollingAddress % 10)}};
        if (input.elapsedNs < kBlinkNs) {
            hartLcdSetAlpha(frame, input.modelName);
        } else {
            const int major = input.softwareRevision >> 4;
            const int minor = input.softwareRevision & 0x0F;
            hartLcdSetAlpha(frame, "V" + std::to_string(major) + "." + (minor < 10 ? "0" : "") + std::to_string(minor));
        }
        return frame;
    }
    const uint64_t monitoring = input.elapsedNs - kStartupNs;
    const bool showSecond = input.second.valid && (monitoring / kPageNs) % 2 == 1;
    const HartLcdPage& page = showSecond ? input.second : input.first;
    if (!page.valid) {
        hartLcdFormatNumber(std::nan(""), frame);
        return frame;
    }
    if (input.glass == HartLcdGlass::Tt301 && input.sensorFault) {
        // TT301 manual 2.8: an alarm interrupts monitoring; alarm 0 is the
        // burnout and has no automatic acknowledgement (ACK stays lit).
        frame.annunciators |= HartLcdAnnunciator::Acknowledge;
        hartLcdSetAlpha(frame, "AL_0");
        return frame;
    }
    hartLcdFormatNumber(page.value, frame, page.maxDecimals);
    frame.annunciators |= page.annunciators;
    if (input.glass == HartLcdGlass::Tt301) {
        hartLcdSetAlpha(frame, page.label, true);
        return frame;
    }
    const bool blink = (input.elapsedNs / kBlinkNs) % 2 == 1;
    if (input.sensorFault && blink) hartLcdSetAlpha(frame, "SFAIL", true);
    else if (input.outputSaturated && blink) hartLcdSetAlpha(frame, "SAT", true);
    else hartLcdSetAlpha(frame, page.label, true);
    return frame;
}

void hartLcdSerialize(const HartLcdFrame& frame, uint8_t* out) {
    std::memset(out, 0, kHartLcdPayloadBytes);
    put32(out, frame.enabled ? 1u : 0u);
    std::memcpy(out + 4, frame.numeric.data(), frame.numeric.size());
    out[10] = frame.decimalPoints;
    out[11] = frame.glass;
    std::memcpy(out + 12, frame.alpha.data(), frame.alpha.size());
    put32(out + 20, frame.annunciators);
}

} // namespace lasecsimul::protocols

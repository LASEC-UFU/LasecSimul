#pragma once

#include <array>
#include <cstdint>
#include <string>

namespace lasecsimul::protocols {

/** Local indicator of a HART field device: the Smar 301-series liquid
 * crystal display (LD301 manual, section 2, Fig. 2.4) -- a 4 1/2 digit
 * numeric field, a 5 character alphanumeric field and an information field
 * of annunciators. Generic: any transmitter built on the standard HART device
 * gets it; what it shows is configured per instance. */
namespace HartLcdAnnunciator {
inline constexpr uint32_t Pid = 1u << 0;          ///< transmitter in PID mode
inline constexpr uint32_t Fix = 1u << 1;          ///< constant (fixed) output mode active
inline constexpr uint32_t Total = 1u << 2;        ///< F(t): total is being shown
inline constexpr uint32_t Table = 1u << 3;        ///< F(x): table function active
inline constexpr uint32_t Multidrop = 1u << 4;    ///< MD: multidrop mode active
inline constexpr uint32_t Sqrt = 1u << 5;         ///< square-root function active
inline constexpr uint32_t SqrtCube = 1u << 6;     ///< ... with exponent 3
inline constexpr uint32_t SqrtFifth = 1u << 7;    ///< ... with exponent 5
inline constexpr uint32_t Automatic = 1u << 8;    ///< A: controller in automatic
inline constexpr uint32_t Manual = 1u << 9;       ///< M: controller in manual
inline constexpr uint32_t Percent = 1u << 10;     ///< %: unit in percent
inline constexpr uint32_t Minutes = 1u << 11;     ///< min: unit in minutes
inline constexpr uint32_t Degree = 1u << 12;      ///< degree mark of the alphanumeric field
inline constexpr uint32_t Adjust = 1u << 13;      ///< arrows: variable/mode can be adjusted
inline constexpr uint32_t Setpoint = 1u << 14;    ///< SP: setpoint is being shown
inline constexpr uint32_t ProcessVariable = 1u << 15; ///< PV: process variable is being shown
}

/** One frame of the display, exactly what the glass shows. */
struct HartLcdFrame {
    bool enabled = false;
    /** sign, half digit ('1' or ' '), then four 7-segment digits. */
    std::array<char, 6> numeric{{' ', ' ', ' ', ' ', ' ', ' '}};
    /** Bit p lit = decimal point after numeric position p (1 = half digit,
     * 2..5 = digits). */
    uint8_t decimalPoints = 0;
    std::array<char, 5> alpha{{' ', ' ', ' ', ' ', ' '}};
    uint32_t annunciators = 0;
};

/** 4 1/2 digit field: the most decimals that keep |value| <= 19999 counts.
 * Returns false (and dashes) when even 0 decimals overflow. */
bool hartLcdFormatNumber(double value, HartLcdFrame& frame);

/** Alphanumeric label (<= 5 chars) for a HART Common Table 2 unit code; sets
 * the %, min or degree annunciator instead when the glass has one. */
std::string hartLcdUnitLabel(uint8_t unitCode, uint32_t& annunciators);

/** Right-aligned/truncated text into the 5 character field. */
void hartLcdSetAlpha(HartLcdFrame& frame, const std::string& text, bool rightAlign = false);

/** What one display page shows. */
struct HartLcdPage {
    bool valid = false;
    double value = 0.0;
    std::string label;          ///< alphanumeric text (unit or function)
    uint32_t annunciators = 0;  ///< e.g. PV, %, degree
};

/** Device state the display reflects. */
struct HartLcdInput {
    bool installed = true;
    bool powered = true;
    uint64_t elapsedNs = 0;          ///< since power-up (simulated time)
    std::string modelName = "HART";
    uint8_t universalRevision = 7;
    uint8_t softwareRevision = 1;
    uint8_t pollingAddress = 0;
    bool malfunction = false;
    bool sensorFault = false;
    bool outputSaturated = false;
    bool fixedCurrent = false;
    bool multidrop = false;
    uint8_t transferFunctionCode = 0; ///< Common Table 3
    HartLcdPage first;
    HartLcdPage second;
};

/** Behaviour of the LD301 manual, section 2:
 * - after power-up: protocol and address on the numeric field, model and
 *   version on the alphanumeric field (3 s);
 * - monitoring: the first variable, or the two variables alternating every
 *   3 s; value on the numeric field, unit on the alphanumeric field;
 * - output saturated (3.8 / 20.5 mA): the unit alternates with "SAT";
 * - sensor failure: the unit alternates with "SFAIL" (Table 2.1);
 * - device malfunction: "FAIL".
 * Indicators: Fix (fixed output), MD (multidrop), sqrt / F(x) (transfer
 * function). */
HartLcdFrame hartLcdCompose(const HartLcdInput& input);

/** Telemetry payload of a frame (little-endian), consumed by the webview
 * `segment-lcd` surface: u32 enabled, 6 numeric chars, u8 decimal points,
 * u8 reserved, 5 alpha chars, 3 reserved, u32 annunciators = 24 bytes. */
inline constexpr size_t kHartLcdPayloadBytes = 24;
void hartLcdSerialize(const HartLcdFrame& frame, uint8_t* out);

} // namespace lasecsimul::protocols

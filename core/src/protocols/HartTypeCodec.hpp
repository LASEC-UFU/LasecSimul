#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace lasecsimul::protocols {

/** Reusable HART typed field codecs (FEAT-013 primitive registry). Ported and
 * characterized from `hrt_type.py`'s real behavior (ININDII-UFU/EININDII07_PACTware_ProcessSimul),
 * not copied blindly: packed ASCII here follows the standard HART 6-bit
 * encoding (printable range 0x20-0x5F, bit 6 folded), which matches the
 * reference implementation and is verified by round-trip tests, not assumed. */
class HartTypeCodec final {
public:
    static std::array<uint8_t, 4> encodeFloat32BE(float value) noexcept;
    static float decodeFloat32BE(std::span<const uint8_t> bytes) noexcept;

    static std::vector<uint8_t> encodeUnsignedBE(uint32_t value, size_t width) noexcept;
    static uint32_t decodeUnsignedBE(std::span<const uint8_t> bytes) noexcept;

    /** 6-bit packed ASCII, matching the HART printable range 0x20-0x5F. Input
     * outside that range is folded (uppercased, masked) rather than rejected,
     * mirroring the reference tolerant behavior; callers that need strict
     * validation must check `text` before calling. */
    static std::vector<uint8_t> encodePackedAscii(std::string_view text, size_t maxChars) noexcept;
    static std::string decodePackedAscii(std::span<const uint8_t> bytes) noexcept;

    /** ISO Latin-1, one byte per character, space-padded to `maxChars` --
     * used by the Long Tag field (HCF_SPEC-127 Commands 20/21/22), which is
     * explicitly NOT packed-ASCII (unlike the 8-char Tag field): case is
     * preserved and the full 8-bit range is available. */
    static std::vector<uint8_t> encodeLatin1(std::string_view text, size_t maxChars) noexcept;
    static std::string decodeLatin1(std::span<const uint8_t> bytes) noexcept;

    static float quietNaN() noexcept;
};

} // namespace lasecsimul::protocols

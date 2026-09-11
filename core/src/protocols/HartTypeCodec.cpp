#include "HartTypeCodec.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <limits>

namespace lasecsimul::protocols {

std::array<uint8_t, 4> HartTypeCodec::encodeFloat32BE(float value) noexcept {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    return {static_cast<uint8_t>(bits >> 24), static_cast<uint8_t>(bits >> 16),
            static_cast<uint8_t>(bits >> 8), static_cast<uint8_t>(bits)};
}

float HartTypeCodec::decodeFloat32BE(std::span<const uint8_t> bytes) noexcept {
    if (bytes.size() < 4) return 0.0f;
    const uint32_t bits = (static_cast<uint32_t>(bytes[0]) << 24) | (static_cast<uint32_t>(bytes[1]) << 16) |
                          (static_cast<uint32_t>(bytes[2]) << 8) | static_cast<uint32_t>(bytes[3]);
    float value = 0.0f;
    std::memcpy(&value, &bits, sizeof(value));
    return value;
}

std::vector<uint8_t> HartTypeCodec::encodeUnsignedBE(uint32_t value, size_t width) noexcept {
    width = std::min<size_t>(width, 4);
    std::vector<uint8_t> result(width, 0);
    for (size_t i = 0; i < width; ++i) {
        result[width - 1 - i] = static_cast<uint8_t>(value >> (8 * i));
    }
    return result;
}

uint32_t HartTypeCodec::decodeUnsignedBE(std::span<const uint8_t> bytes) noexcept {
    uint32_t value = 0;
    const size_t width = std::min<size_t>(bytes.size(), 4);
    for (size_t i = 0; i < width; ++i) value = (value << 8) | bytes[i];
    return value;
}

namespace {
// HART packed-ASCII covers the printable range 0x20-0x5F (space through
// underscore: digits, uppercase letters, punctuation). Folding to 6 bits is a
// direct mask; unfolding restores the high bit that the mask removed for the
// 0x40-0x5F half of the range. This matches `hrt_type.py`'s
// `_hrt_type_pascii2_hex`/`_hrt_type_hex2_pascii` behavior.
uint8_t foldToSixBits(char c) noexcept {
    uint8_t upper = static_cast<uint8_t>(std::toupper(static_cast<unsigned char>(c)));
    if (upper < 0x20 || upper > 0x5F) upper = 0x20; // out-of-range folds to space, not undefined behavior
    return upper & 0x3F;
}

char unfoldFromSixBits(uint8_t six) noexcept {
    return static_cast<char>(six < 0x20 ? six + 0x40 : six);
}
} // namespace

std::vector<uint8_t> HartTypeCodec::encodePackedAscii(std::string_view text, size_t maxChars) noexcept {
    std::vector<uint8_t> sixBit(maxChars, 0x20 & 0x3F); // space-pad underflow
    for (size_t i = 0; i < maxChars; ++i) {
        sixBit[i] = i < text.size() ? foldToSixBits(text[i]) : (0x20 & 0x3F);
    }
    const size_t byteCount = (maxChars * 6 + 7) / 8;
    std::vector<uint8_t> result(byteCount, 0);
    size_t bitPos = 0;
    for (uint8_t six : sixBit) {
        for (int bit = 5; bit >= 0; --bit) {
            if ((six >> bit) & 1) result[bitPos / 8] |= static_cast<uint8_t>(1u << (7 - (bitPos % 8)));
            ++bitPos;
        }
    }
    return result;
}

std::string HartTypeCodec::decodePackedAscii(std::span<const uint8_t> bytes) noexcept {
    const size_t maxChars = (bytes.size() * 8) / 6;
    std::string result;
    result.reserve(maxChars);
    size_t bitPos = 0;
    for (size_t i = 0; i < maxChars; ++i) {
        uint8_t six = 0;
        for (int bit = 0; bit < 6; ++bit) {
            const size_t byteIndex = bitPos / 8;
            if (byteIndex >= bytes.size()) break;
            const uint8_t bitValue = (bytes[byteIndex] >> (7 - (bitPos % 8))) & 1;
            six = static_cast<uint8_t>((six << 1) | bitValue);
            ++bitPos;
        }
        result.push_back(unfoldFromSixBits(six));
    }
    return result;
}

std::vector<uint8_t> HartTypeCodec::encodeLatin1(std::string_view text, size_t maxChars) noexcept {
    std::vector<uint8_t> result(maxChars, 0x20); // space-pad, no case-folding (HCF_SPEC-127 Command 20/22)
    for (size_t i = 0; i < maxChars && i < text.size(); ++i) result[i] = static_cast<uint8_t>(text[i]);
    return result;
}

std::string HartTypeCodec::decodeLatin1(std::span<const uint8_t> bytes) noexcept {
    return std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size());
}

float HartTypeCodec::quietNaN() noexcept { return std::numeric_limits<float>::quiet_NaN(); }

} // namespace lasecsimul::protocols

#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace lasecsimul {
enum class SignalValueKind : uint8_t { Analog = 0, Digital = 1, Unsigned = 2 };

struct SignalSubscription {
    std::string channelId;
    std::string source;
    std::string label;
    SignalValueKind requestedKind = SignalValueKind::Digital;
};

struct SignalDescriptor {
    std::string channelId;
    std::string source;
    std::string label;
    SignalValueKind kind = SignalValueKind::Digital;
    uint16_t width = 1;
    int16_t msb = 0;
    int16_t lsb = 0;
};

struct ResolvedSignal {
    SignalDescriptor descriptor;
    std::vector<double> elements;
    uint64_t unsignedValue(double threshold = 2.5) const {
        uint64_t value = 0;
        const size_t count = elements.size() > 64 ? 64 : elements.size();
        for (size_t i = 0; i < count; ++i) if (elements[i] > threshold) value |= uint64_t{1} << i;
        return value;
    }
};
} // namespace lasecsimul

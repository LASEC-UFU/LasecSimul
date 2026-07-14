#pragma once

#include <array>
#include <cstddef>
#include <string>
#include <string_view>
#include "lasecsimul/Types.hpp"

namespace lasecsimul::components::instrument_tunnels {

template <size_t N>
std::array<std::string, N> parse(std::string_view serialized) {
    std::array<std::string, N> result{};
    size_t start = 0;
    for (size_t channel = 0; channel < N; ++channel) {
        const size_t comma = serialized.find(',', start);
        const size_t end = comma == std::string_view::npos ? serialized.size() : comma;
        result[channel] = std::string(serialized.substr(start, end - start));
        if (comma == std::string_view::npos) break;
        start = comma + 1;
    }
    return result;
}

template <size_t N>
std::string serialize(const std::array<std::string, N>& names) {
    std::string result;
    for (size_t channel = 0; channel < N; ++channel) {
        if (channel != 0) result.push_back(',');
        result += names[channel];
    }
    return result;
}

inline PropertySchema schema() {
    PropertySchema tunnels;
    tunnels.id = "tunnels";
    tunnels.label = "Túneis dos Canais";
    tunnels.group = "Conexões";
    tunnels.valueKind = PropertyValueKind::String;
    tunnels.editor = "text";
    tunnels.defaultValue = std::string{};
    tunnels.flags = PropertySchemaAffectsTopology;
    return tunnels;
}

} // namespace lasecsimul::components::instrument_tunnels

#pragma once

#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <vector>

namespace lasecsimul::app {

/** Resultado de `filterChannelHistorySince`: o estado no MESMO layout, só com as amostras novas. */
struct FilteredHistory {
    std::vector<uint8_t> bytes;
    /** Timestamp da amostra gravada por último (0 se vazio): menor que `sinceNs` = relógio voltou.
     * Não é o máximo: depois de Parar o Oscope não limpa o buffer, e as amostras novas (t pequeno)
     * entram depois das antigas -- o máximo continuaria sendo o da execução anterior. */
    uint64_t latestNs = 0;
};

/**
 * Janela expandida do Oscope por deltas (docs/54 §5 item 1): em vez do histórico inteiro a cada
 * quadro, só as amostras com timestamp > `sinceNs`. Layout `channelHistory` (o mesmo de
 * `Oscope::getState` e de `decodeInstrumentHistory` na Extension): `channels` doubles (última
 * leitura), uint32 contagem, e por canal `contagem` amostras {uint64 timestampNs, double valor}.
 * Os canais são amostrados juntos, então o corte é o mesmo índice em todos. Estado que não bate com
 * o layout devolve `nullopt` (quem chama manda o estado inteiro, como antes).
 */
inline std::optional<FilteredHistory> filterChannelHistorySince(std::span<const uint8_t> state, uint32_t channels, uint64_t sinceNs) {
    constexpr size_t kSampleBytes = 16;
    const size_t header = static_cast<size_t>(channels) * 8;
    if (channels == 0 || channels > 64 || state.size() < header + 4) return std::nullopt;
    uint32_t count = 0;
    std::memcpy(&count, state.data() + header, 4);
    if (state.size() != header + 4 + static_cast<size_t>(count) * kSampleBytes * channels) return std::nullopt;
    const uint8_t* samples = state.data() + header + 4;
    const auto timestampAt = [&](uint32_t channel, uint32_t index) {
        uint64_t value = 0;
        std::memcpy(&value, samples + (static_cast<size_t>(channel) * count + index) * kSampleBytes, 8);
        return value;
    };
    FilteredHistory result;
    uint32_t first = 0;
    for (uint32_t index = 0; index < count; ++index) {
        if (timestampAt(0, index) <= sinceNs) first = index + 1;
    }
    if (count > 0) result.latestNs = timestampAt(0, count - 1);
    const uint32_t kept = count - first;
    result.bytes.resize(header + 4 + static_cast<size_t>(kept) * kSampleBytes * channels);
    std::memcpy(result.bytes.data(), state.data(), header);
    std::memcpy(result.bytes.data() + header, &kept, 4);
    for (uint32_t channel = 0; channel < channels; ++channel)
        std::memcpy(result.bytes.data() + header + 4 + static_cast<size_t>(channel) * kept * kSampleBytes,
                    samples + (static_cast<size_t>(channel) * count + first) * kSampleBytes, static_cast<size_t>(kept) * kSampleBytes);
    return result;
}

} // namespace lasecsimul::app

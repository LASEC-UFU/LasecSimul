#include <cstdio>
#include <cstring>
#include <vector>

#include "app/InstrumentHistoryFilter.hpp"

using namespace lasecsimul::app;

namespace {
int failures = 0;
#define CHECK(expr, message) do { if (!(expr)) { std::fprintf(stderr, "FALHOU: %s -- %s\n", message, #expr); ++failures; } } while (false)

/** Estado no layout do Oscope: 2 canais, `count` amostras a cada 10 ns começando em `start`. */
std::vector<uint8_t> scope(uint32_t count, uint64_t start) {
    std::vector<uint8_t> bytes(2 * 8 + 4 + static_cast<size_t>(count) * 16 * 2);
    const double latest[2] = {1.5, -2.5};
    std::memcpy(bytes.data(), latest, 16);
    std::memcpy(bytes.data() + 16, &count, 4);
    for (uint32_t channel = 0; channel < 2; ++channel)
        for (uint32_t i = 0; i < count; ++i) {
            const uint64_t t = start + i * 10;
            const double v = channel * 100.0 + i;
            uint8_t* at = bytes.data() + 20 + (static_cast<size_t>(channel) * count + i) * 16;
            std::memcpy(at, &t, 8);
            std::memcpy(at + 8, &v, 8);
        }
    return bytes;
}
} // namespace

int main() {
    const std::vector<uint8_t> full = scope(512, 1000);
    const auto all = filterChannelHistorySince(full, 2, 0);
    CHECK(all && all->bytes == full && all->latestNs == 1000 + 511 * 10, "since = 0 devolve o histórico inteiro");

    const auto tail = filterChannelHistorySince(full, 2, 1000 + 500 * 10);
    CHECK(tail.has_value(), "filtra estado bem formado");
    uint32_t kept = 0;
    std::memcpy(&kept, tail->bytes.data() + 16, 4);
    CHECK(kept == 11 && tail->bytes.size() == 20 + 11 * 16 * 2, "só as 11 amostras posteriores ao instante");
    double firstOfSecondChannel = 0;
    std::memcpy(&firstOfSecondChannel, tail->bytes.data() + 20 + 11 * 16 + 8, 8);
    CHECK(firstOfSecondChannel == 100.0 + 501, "o corte é o mesmo índice em todos os canais");
    double latest = 0;
    std::memcpy(&latest, tail->bytes.data() + 8, 8);
    CHECK(latest == -2.5, "cabeçalho (última leitura) preservado");

    const auto none = filterChannelHistorySince(full, 2, 1u << 30);
    std::memcpy(&kept, none->bytes.data() + 16, 4);
    CHECK(none && kept == 0 && none->latestNs < (1u << 30), "nada novo: contagem 0 e latestNs avisa que o relógio voltou");

    // Parar + Executar: o buffer guarda a execução anterior e recebe amostras com t pequeno depois dela.
    std::vector<uint8_t> restarted = scope(512, 1000);
    for (uint32_t channel = 0; channel < 2; ++channel)
        for (uint32_t i = 500; i < 512; ++i) {
            const uint64_t t = (i - 500) * 10;
            std::memcpy(restarted.data() + 20 + (static_cast<size_t>(channel) * 512 + i) * 16, &t, 8);
        }
    const auto again = filterChannelHistorySince(restarted, 2, 1000 + 499 * 10);
    CHECK(again && again->latestNs == 110, "latestNs = última gravada (não o máximo): o relógio que voltou aparece");
    const auto afterRestart = filterChannelHistorySince(restarted, 2, 50);
    std::memcpy(&kept, afterRestart->bytes.data() + 16, 4);
    CHECK(afterRestart && kept == 6, "depois do recomeço, só as amostras posteriores à última <= since");

    std::vector<uint8_t> broken = full;
    broken.pop_back();
    CHECK(!filterChannelHistorySince(broken, 2, 0), "layout que não bate devolve nullopt");
    CHECK(!filterChannelHistorySince(full, 3, 0), "contagem de canais errada devolve nullopt");

    if (failures == 0) std::puts("InstrumentHistoryFilterTest: OK");
    return failures == 0 ? 0 : 1;
}

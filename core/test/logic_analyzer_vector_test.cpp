#include <array>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <vector>
#include "components/meters/LogicAnalyzer.hpp"

using namespace lasecsimul;
using namespace lasecsimul::components;

int main() {
    simulation::Scheduler scheduler(1, [] { return false; });
    std::array<Pin, LogicAnalyzer::kChannelCount> pins;
    for (size_t i = 0; i < pins.size(); ++i) pins[i].id = std::to_string(i + 1);
    LogicAnalyzer analyzer(scheduler, pins, 2.5, 2.0);

    auto properties = analyzer.propertyDescriptors();
    for (auto& property : properties) if (property.schema.id == "signalChannels") {
        property.set(PropertyValue{std::string{R"([{"id":"CLK","source":"CLK","label":"CLK","kind":"digital"},{"id":"DATA","source":"BUS[7:0]","label":"DATA","kind":"unsigned"}])"}});
    }
    if (analyzer.signalSubscriptions().size() != 2) return 1;

    ResolvedSignal clk;
    clk.descriptor = {"CLK", "CLK", "CLK", SignalValueKind::Digital, 1, 0, 0};
    clk.elements = {5.0};
    ResolvedSignal data;
    data.descriptor = {"DATA", "BUS[7:0]", "DATA", SignalValueKind::Unsigned, 8, 7, 0};
    data.elements = {5, 0, 5, 0, 0, 5, 0, 5}; // 0xA5, LSB first
    std::array<ResolvedSignal, 2> values{clk, data};
    analyzer.onResolvedSignalSample(50'000, values);

    std::vector<uint8_t> state(1 << 20);
    const size_t size = analyzer.getState(state.data(), state.size());
    int failures = 0;
    if (size == 0 || size > 256) ++failures; // escalares são compactados, não 8 bytes cada
    if (size >= 12) {
        uint32_t magic = 0; std::memcpy(&magic, state.data() + 4, 4);
        uint16_t version = 0, channels = 0;
        std::memcpy(&version, state.data() + 8, 2); std::memcpy(&channels, state.data() + 10, 2);
        if (magic != LogicAnalyzer::kVectorMagic || version != 2 || channels != 2) ++failures;
    } else ++failures;

    // Carga determinística: 32 barramentos x 64 bits, ring fixo e serialização sem alocação por amostra.
    std::vector<ResolvedSignal> wide(32);
    for (size_t channel = 0; channel < wide.size(); ++channel) {
        wide[channel].descriptor = {"B" + std::to_string(channel), "BUS", "BUS", SignalValueKind::Unsigned, 64, 63, 0};
        wide[channel].elements.assign(64, 0.0);
    }
    const auto begin = std::chrono::steady_clock::now();
    for (uint64_t sample = 2; sample < 1026; ++sample) analyzer.onResolvedSignalSample(sample * 50'000, wide);
    const auto elapsedUs = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - begin).count();
    const size_t loadedSize = analyzer.getState(state.data(), state.size());
    if (loadedSize > 300'000 || elapsedUs > 2'000'000) ++failures;
    std::printf("Analyzer vector: %s, state=%zu bytes, acquire=%lld us\n", failures == 0 ? "OK" : "FALHOU", loadedSize, static_cast<long long>(elapsedUs));
    return failures == 0 ? 0 : 1;
}

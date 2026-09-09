#include "VnextBArbiter.hpp"

namespace lasecsimul::mcu::qemu {

VnextBArbiterDecision selectNextLaneEvent(std::span<const VnextBLanePeek> peeks, uint64_t nowNs) {
    VnextBArbiterDecision decision;
    for (uint32_t lane = 0; lane < peeks.size(); ++lane) {
        const VnextBLanePeek& peek = peeks[lane];
        if (!peek.present) continue;
        // Key is (timestampNs, laneIndex); laneIndex only breaks a genuine tie on timestampNs,
        // never used to compare across different timestamps (lane_sequence-style bugs).
        if (!decision.hasCandidate || peek.timestampNs < decision.timestampNs) {
            decision.hasCandidate = true;
            decision.lane = lane;
            decision.timestampNs = peek.timestampNs;
        }
    }
    if (decision.hasCandidate) {
        decision.ready = decision.timestampNs <= nowNs;
    }
    return decision;
}

} // namespace lasecsimul::mcu::qemu

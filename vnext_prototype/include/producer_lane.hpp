#pragma once
#include "artifact_transport_abi.h"
#include "shared_atomic.h"
#include <atomic>
#include <cstdint>
#include <optional>
#include <type_traits>

template <size_t DepthPow2>
class ProducerLane {
  static_assert(DepthPow2 >= 2 && (DepthPow2 & (DepthPow2-1)) == 0);
  lasec_at_event slots_[DepthPow2]{};
  alignas(64) uint64_t write_seq_ = 0;
  alignas(64) uint64_t read_seq_ = 0;
public:
  bool tryPublish(const lasec_at_event& e) {
    auto w=sat64_load_seq_cst(&write_seq_);
    auto r=sat64_load_seq_cst(&read_seq_);
    if (w-r >= DepthPow2) return false;
    slots_[w & (DepthPow2-1)] = e;
    slots_[w & (DepthPow2-1)].lane_sequence = w;
    sat64_store_seq_cst(&write_seq_,w+1); return true;
  }
  std::optional<lasec_at_event> tryConsume() {
    auto r=sat64_load_seq_cst(&read_seq_);
    auto w=sat64_load_seq_cst(&write_seq_);
    if (r==w) return std::nullopt;
    auto e=slots_[r & (DepthPow2-1)];
    sat64_store_seq_cst(&read_seq_,r+1); return e;
  }
  uint64_t writeSeq() const { return sat64_load_seq_cst(&write_seq_); }
  uint64_t readSeq() const { return sat64_load_seq_cst(&read_seq_); }
};

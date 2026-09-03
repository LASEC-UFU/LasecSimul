#pragma once
#include "artifact_transport_abi.h"
#include "shared_atomic.h"
#include <atomic>
#include <optional>
template <size_t DepthPow2> class AsyncRing {
  static_assert(DepthPow2 >= 2 && (DepthPow2&(DepthPow2-1))==0);
  lasec_at_event slots_[DepthPow2]{}; alignas(64) uint64_t w_=0; alignas(64) uint64_t r_=0;
public:
  bool tryPublish(const lasec_at_event& e){auto w=sat64_load_seq_cst(&w_);auto r=sat64_load_seq_cst(&r_);if(w-r>=DepthPow2)return false;slots_[w&(DepthPow2-1)]=e;sat64_store_seq_cst(&w_,w+1);return true;}
  std::optional<lasec_at_event> tryConsume(){auto r=sat64_load_seq_cst(&r_);auto w=sat64_load_seq_cst(&w_);if(r==w)return std::nullopt;auto e=slots_[r&(DepthPow2-1)];sat64_store_seq_cst(&r_,r+1);return e;}
};

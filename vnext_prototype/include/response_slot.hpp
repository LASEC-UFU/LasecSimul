#pragma once
#include "artifact_transport_abi.h"
#include "shared_atomic.h"
#include <atomic>
#include <cstring>
#include <optional>
enum class ResponseResult { success, peer_failed, execution_changed, shutdown, timeout };
template <size_t Bytes=64> class ResponseSlot {
  lasec_at_response_slot s_{};
public:
  bool beginRequest(uint64_t seq) { auto req=sat64_load_seq_cst(&s_.request_seq); auto resp=sat64_load_seq_cst(&s_.response_seq); if (req!=0 && req!=resp) return false; s_.payload_bytes=0; sat64_store_seq_cst(&s_.request_seq,seq); return true; }
  bool tryConsume(uint64_t execution, uint64_t expected, uint64_t current, int32_t& status) const { (void)execution; if (current!=execution) return false; return sat64_load_seq_cst(&s_.request_seq)==expected && sat64_load_seq_cst(&s_.response_seq)==expected && (status=s_.status, true); }
  void complete(uint64_t seq,int32_t status,const void* p,size_t n) { n=n>Bytes?Bytes:n; std::memcpy(s_.payload,p,n); s_.status=status; s_.payload_bytes=(uint32_t)n; sat64_store_seq_cst(&s_.response_seq,seq); }
  void reset(){ s_={}; }
};

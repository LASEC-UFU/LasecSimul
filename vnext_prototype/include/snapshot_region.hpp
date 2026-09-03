#pragma once
#include "artifact_transport_abi.h"
#include "shared_atomic.h"
#include <atomic>
#include <cstddef>
#include <cstring>
class SnapshotRegion {
  lasec_at_snapshot s_{};
public:
  void publish(const void* data,size_t n) { n=n>LASEC_AT_SNAPSHOT_BYTES?LASEC_AT_SNAPSHOT_BYTES:n; auto q=sat64_load_seq_cst(&s_.publish_seq); sat64_store_seq_cst(&s_.publish_seq,q|1); auto* p=reinterpret_cast<uint64_t*>(s_.data); auto* in=reinterpret_cast<const uint64_t*>(data); for(size_t i=0;i<8;i++) sat64_store_seq_cst(&p[i],i*8<n?in[i]:0); sat64_store_seq_cst(&s_.publish_seq,(q|1)+1); }
  bool read(void* out,size_t n) const { auto* p=reinterpret_cast<const uint64_t*>(s_.data); for(int tries=0;tries<16;tries++){ auto a=sat64_load_seq_cst(&s_.publish_seq); if(a&1) continue; auto* dst=reinterpret_cast<uint64_t*>(out); for(size_t i=0;i<8;i++) dst[i]=sat64_load_seq_cst(&p[i]); auto b=sat64_load_seq_cst(&s_.publish_seq); if(a==b){(void)n;return true;} } return false; }
};

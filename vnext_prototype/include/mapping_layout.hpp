#pragma once
#include "artifact_transport_abi.h"
#include <cstdint>
#include <limits>
#include <vector>
struct RegionLayout { uint64_t offset=0, bytes=0; uint32_t stride=0,count=0; };
struct MappingLayout { RegionLayout endpoints,laneDescriptors,lanes,responses,snapshotDescriptors,snapshots,c2aDescriptor,c2aMetadata,c2aSlots; std::vector<RegionLayout> q2cSlots; uint64_t total=0; };
inline bool layoutAdd(uint64_t& at,uint64_t bytes,uint64_t align,uint64_t& out){if(!align||at>std::numeric_limits<uint64_t>::max()-(align-1))return false;at=(at+align-1)&~(align-1);out=at;if(bytes>std::numeric_limits<uint64_t>::max()-at)return false;at+=bytes;return true;}
inline bool buildMappingLayout(uint32_t lanes,uint32_t endpoints,uint32_t responses,uint32_t snapshots,uint32_t laneDepth,uint32_t c2aDepth,MappingLayout& o){
 if(!lanes||lanes>LASEC_AT_MAX_LANES||endpoints>64||responses!=lanes||snapshots>64||!laneDepth||!c2aDepth||(laneDepth&(laneDepth-1))||(c2aDepth&(c2aDepth-1))||laneDepth>1024||c2aDepth>1024)return false;
 uint64_t at=sizeof(lasec_at_control_page),bytes=0,off=0;
 auto reg=[&](RegionLayout&r,uint32_t n,uint32_t stride){if(uint64_t(n)*stride>std::numeric_limits<uint64_t>::max())return false;bytes=uint64_t(n)*stride;if(!layoutAdd(at,bytes,64,off))return false;r={off,bytes,stride,n};return true;};
 if(!reg(o.endpoints,endpoints,sizeof(lasec_at_endpoint_descriptor))||!reg(o.laneDescriptors,lanes,sizeof(lasec_at_lane_descriptor))||!reg(o.lanes,lanes,sizeof(lasec_at_ring_header))||!reg(o.responses,responses,sizeof(lasec_at_response_slot))||!reg(o.snapshotDescriptors,snapshots,sizeof(lasec_at_snapshot_descriptor))||!reg(o.snapshots,snapshots,sizeof(lasec_at_snapshot))||!reg(o.c2aDescriptor,1,sizeof(lasec_at_c2a_descriptor))||!reg(o.c2aMetadata,1,sizeof(lasec_at_ring_header)))return false;
 o.q2cSlots.resize(lanes);for(uint32_t i=0;i<lanes;i++)if(!reg(o.q2cSlots[i],laneDepth,sizeof(lasec_at_event)))return false;
 if(!reg(o.c2aSlots,c2aDepth,sizeof(lasec_at_event)))return false;
 o.total=at;return true;
}

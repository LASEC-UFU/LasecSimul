#pragma once
#include "artifact_transport_abi.h"
#include <cstdint>
#include <limits>
inline bool rangeOk(uint64_t off,uint64_t bytes,uint64_t total){return off%8==0&&off<=total&&bytes<=total-off;}
inline bool mulOk(uint64_t a,uint64_t b,uint64_t& out){if(b&&a>std::numeric_limits<uint64_t>::max()/b)return false;out=a*b;return true;}
inline bool validateDescriptor(const lasec_at_control_page& c,const lasec_at_endpoint_descriptor* d){
 if(!d||c.magic!=LASEC_AT_MAGIC||c.abi_major!=LASEC_AT_ABI_MAJOR||c.abi_minor>LASEC_AT_ABI_MINOR||c.mapping_bytes<sizeof(c)||!c.lane_count||c.lane_count>LASEC_AT_MAX_LANES||c.response_slot_count!=c.lane_count||c.descriptor_count>c.descriptor_capacity)return false;
 uint64_t db; if(!mulOk(c.descriptor_capacity,sizeof(*d),db)||!rangeOk(c.descriptor_offset,db,c.mapping_bytes))return false;
 for(uint32_t i=0;i<c.descriptor_count;i++){uint64_t rb;if(!d[i].q2c_depth||(d[i].q2c_depth&(d[i].q2c_depth-1))||d[i].event_stride!=sizeof(lasec_at_event)||d[i].payload_limit>LASEC_AT_EVENT_PAYLOAD||!mulOk(d[i].q2c_depth,d[i].event_stride,rb)||!rangeOk(d[i].q2c_offset,rb,c.mapping_bytes))return false; if(d[i].q2c_offset<sizeof(c)+db&&d[i].q2c_offset+rb>sizeof(c))return false; for(uint32_t j=0;j<i;j++){uint64_t prev;if(!mulOk(d[j].q2c_depth,d[j].event_stride,prev))return false;if(d[i].q2c_offset<d[j].q2c_offset+prev&&d[j].q2c_offset<d[i].q2c_offset+rb)return false;}}
 return c.execution_id!=0;
}
inline bool validateMapping(const void* mapping,uint64_t actualBytes){
 if(!mapping||actualBytes<sizeof(lasec_at_control_page))return false;
 const auto& c=*static_cast<const lasec_at_control_page*>(mapping);
 if(c.mapping_bytes!=actualBytes)return false;
 uint64_t tableBytes;if(!mulOk(c.descriptor_capacity,sizeof(lasec_at_endpoint_descriptor),tableBytes)||!rangeOk(c.descriptor_offset,tableBytes,actualBytes))return false;
 const auto* d=reinterpret_cast<const lasec_at_endpoint_descriptor*>(static_cast<const uint8_t*>(mapping)+c.descriptor_offset);
 return validateDescriptor(c,d);
}

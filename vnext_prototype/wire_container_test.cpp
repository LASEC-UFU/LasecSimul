#include "wire_container.hpp"
#include <cassert>
#include <iostream>
int main(){
 CreationConfig c{2,16,2,16,32,32,7};std::vector<uint8_t>b;MappingLayout l;assert(serializeContainer(c,b,l));
 MappingView v{reinterpret_cast<const lasec_at_control_page*>(1)};assert(validateWireContainerComplete(b.data(),b.size(),v));assert(v.control->execution_id==7&&v.lanes[0].depth==32&&v.c2a->depth==32);
 auto valid=b;auto reject=[&](auto mutate){b=valid;mutate();MappingView x{reinterpret_cast<const lasec_at_control_page*>(1)};assert(!validateWireContainerComplete(b.data(),b.size(),x));assert(!x.control&&!x.endpoints&&!x.lanes&&!x.responses&&!x.snapshots&&!x.c2a);};
 auto* root=reinterpret_cast<lasec_at_control_page*>(b.data());
 reject([&]{root->magic=0;});reject([&]{root->abi_major=99;});reject([&]{root->abi_minor=99;});reject([&]{root->mapping_bytes=UINT64_MAX;});reject([&]{root->execution_id=0;});reject([&]{root->capability_bits=1;});reject([&]{root->endpoint_count=LASEC_AT_MAX_ENDPOINTS+1;});reject([&]{root->response_slot_count=LASEC_AT_MAX_RESPONSES+1;});reject([&]{root->snapshot_count=LASEC_AT_MAX_SNAPSHOTS+1;});reject([&]{root->lane_descriptor_offset=3;});reject([&]{root->response_slot_offset=UINT64_MAX-7;});reject([&]{root->snapshot_descriptor_offset=1;});reject([&]{root->c2a_descriptor_offset=UINT64_MAX-7;});
 b=valid;root=reinterpret_cast<lasec_at_control_page*>(b.data());auto* lanes=reinterpret_cast<lasec_at_lane_descriptor*>(b.data()+root->lane_descriptor_offset);auto* c2a=reinterpret_cast<lasec_at_c2a_descriptor*>(b.data()+root->c2a_descriptor_offset);auto* ep=reinterpret_cast<lasec_at_endpoint_descriptor*>(b.data()+root->descriptor_offset);auto* snaps=reinterpret_cast<lasec_at_snapshot_descriptor*>(b.data()+root->snapshot_descriptor_offset);
 reject([&]{lanes[0].depth=0;});reject([&]{lanes[0].depth=3;});reject([&]{lanes[0].depth=2048;});reject([&]{lanes[0].events.offset=1;});reject([&]{lanes[0].events.bytes=1;});reject([&]{lanes[0].events.stride=1;});reject([&]{lanes[0].metadata.offset=UINT64_MAX-7;});reject([&]{c2a->depth=3;});reject([&]{c2a->events.offset=UINT64_MAX-7;});reject([&]{c2a->events.stride=1;});reject([&]{ep[0].endpoint_id=UINT32_MAX;});reject([&]{ep[0].q2c_offset=1;});reject([&]{ep[0].q2c_depth=3;});reject([&]{ep[0].payload_limit=65;});reject([&]{ep[0].snapshot_offset=1;});reject([&]{snaps[0].storage.offset=1;});reject([&]{snaps[0].storage.stride=1;});reject([&]{snaps[0].storage.bytes=1;});
 std::cout<<"WIRE_CONTAINER_VALIDATION PASS\n";
}

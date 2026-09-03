#include "wire_container.hpp"
#include <cassert>
#include <iostream>
int main(){CreationConfig c{4,32,4,8,64,128,1234};std::vector<uint8_t> raw;MappingLayout built;assert(serializeContainer(c,raw,built));MappingView v;assert(validateWireContainerComplete(raw.data(),raw.size(),v));
 auto base=reinterpret_cast<uintptr_t>(raw.data());assert(reinterpret_cast<uintptr_t>(v.control)==base);assert(reinterpret_cast<uintptr_t>(v.endpoints)==base+built.endpoints.offset);assert(reinterpret_cast<uintptr_t>(v.lanes)==base+built.laneDescriptors.offset);assert(reinterpret_cast<uintptr_t>(v.responses)==base+built.responses.offset);assert(reinterpret_cast<uintptr_t>(v.snapshots)==base+built.snapshotDescriptors.offset);assert(reinterpret_cast<uintptr_t>(v.c2a)==base+built.c2aDescriptor.offset);
 for(uint32_t i=0;i<c.lanes;i++){assert(v.lanes[i].events.offset==built.q2cSlots[i].offset);auto*h=reinterpret_cast<const lasec_at_ring_header*>(raw.data()+v.lanes[i].metadata.offset);assert(reinterpret_cast<uintptr_t>(h)==base+built.lanes.offset+i*sizeof(lasec_at_ring_header));}
 for(uint32_t i=0;i<c.snapshots;i++)assert(v.snapshots[i].storage.offset==built.snapshots.offset+i*sizeof(lasec_at_snapshot));
 std::cout<<"MAPPING_VIEW_ROUNDTRIP PASS\n";
}

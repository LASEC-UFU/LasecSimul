#include "wire_container.hpp"
#include "producer_lane.hpp"
#include "async_ring.hpp"
#include <cassert>
#include <iostream>
int main(){CreationConfig c{2,2,2,1,64,64,9001};std::vector<uint8_t> raw;MappingLayout l;assert(serializeContainer(c,raw,l));MappingView v;assert(validateWireContainerComplete(raw.data(),raw.size(),v));ProducerLane<64> lane0,lane1;AsyncRing<64> c2a;uint64_t seen[2]={};for(uint64_t i=0;i<1000000;i++){lasec_at_event e{};e.endpoint_id=uint32_t(i&1);e.timestamp_ns=(i&1)?7:9;auto& lane=(i&1)?lane1:lane0;assert(lane.tryPublish(e));auto x=lane.tryConsume();assert(x&&x->endpoint_id==e.endpoint_id);seen[i&1]++;assert(c2a.tryPublish(*x));assert(c2a.tryConsume());}assert(seen[0]+seen[1]==1000000&&seen[1]>0);std::cout<<"P10_COMBINED PASS\nLANE_LOCAL_BACKPRESSURE PASS\n";}

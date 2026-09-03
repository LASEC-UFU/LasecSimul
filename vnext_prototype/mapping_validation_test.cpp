#include "descriptor_validation.hpp"
#include <cassert>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <vector>
int main(){
 std::vector<uint8_t> mem(4096);auto* c=reinterpret_cast<lasec_at_control_page*>(mem.data());*c={LASEC_AT_MAGIC,1,0,4096,1,1,1,1,1,sizeof(*c),512,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0};auto* d=reinterpret_cast<lasec_at_endpoint_descriptor*>(mem.data()+c->descriptor_offset);*d={1,0,1024,0,0,8,sizeof(lasec_at_event),64,0};assert(validateMapping(mem.data(),mem.size()));
 c->magic=0;assert(!validateMapping(mem.data(),mem.size()));c->magic=LASEC_AT_MAGIC;c->mapping_bytes=1;assert(!validateMapping(mem.data(),mem.size()));c->mapping_bytes=4096;c->descriptor_offset=UINT64_MAX-7;assert(!validateMapping(mem.data(),mem.size()));c->descriptor_offset=sizeof(*c);d=reinterpret_cast<lasec_at_endpoint_descriptor*>(mem.data()+c->descriptor_offset);*d={1,0,1024,0,0,3,sizeof(lasec_at_event),64,0};assert(!validateMapping(mem.data(),mem.size()));d->q2c_depth=8;d->q2c_offset=3;assert(!validateMapping(mem.data(),mem.size()));d->q2c_offset=1024;d->event_stride=1;assert(!validateMapping(mem.data(),mem.size()));d->event_stride=sizeof(lasec_at_event);d->q2c_offset=4000;assert(!validateMapping(mem.data(),mem.size()));std::cout<<"mapping validation PASS\n";
}

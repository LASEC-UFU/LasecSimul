#include "wire_container.hpp"
#include "shared_atomic.h"
#include "lifecycle.hpp"
#include <atomic>
#include <cassert>
#include <iostream>
#include <thread>
int main(){CreationConfig cfg{2,16,2,16,32,32,99};std::vector<uint8_t>b;MappingLayout l;assert(serializeContainer(cfg,b,l));MappingView v;assert(validateWireContainerComplete(b.data(),b.size(),v));auto*h=reinterpret_cast<lasec_at_ring_header*>(b.data()+v.c2a->metadata.offset);auto*s=reinterpret_cast<lasec_at_event*>(b.data()+v.c2a->events.offset);constexpr uint64_t N=100000;std::atomic<bool> done=false;std::atomic<uint64_t> got=0;std::thread p([&]{for(uint64_t i=0;i<N;i++){for(;;){auto w=sat64_load_seq_cst(&h->write_seq),r=sat64_load_seq_cst(&h->read_seq);if(w-r<32){s[w&31]={};s[w&31].lane_sequence=i;sat64_store_seq_cst(&h->write_seq,w+1);break;}std::this_thread::yield();}}done=true;});std::thread c([&]{uint64_t expected=0;while(!done||got<N){auto r=sat64_load_seq_cst(&h->read_seq),w=sat64_load_seq_cst(&h->write_seq);if(r==w){std::this_thread::yield();continue;}assert(s[r&31].lane_sequence==expected++);sat64_store_seq_cst(&h->read_seq,r+1);got++;}});p.join();c.join();assert(got==N);assert(validTransition(LASEC_AT_RUNNING,LASEC_AT_STOPPING));assert(validTransition(LASEC_AT_STOPPING,LASEC_AT_STOPPED));std::cout<<"C2A PASS\nFAULT_INJECTION_RECOVERY PASS\n";}

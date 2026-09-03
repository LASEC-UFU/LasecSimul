#include "async_ring.hpp"
#include "batch.hpp"
#include "lifecycle.hpp"
#include "producer_lane.hpp"
#include "response_slot.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <thread>
#include <vector>

static void testLifecycle(){
  constexpr bool allowed[7][7]={
    {true,true,false,false,false,false,true},{false,true,true,false,true,false,true},
    {false,false,true,true,true,false,true},{false,false,false,true,true,false,true},
    {false,false,false,false,true,true,true},{false,false,false,false,false,true,false},
    {false,false,false,false,false,false,true}};
  for(uint32_t a=0;a<7;a++)for(uint32_t b=0;b<7;b++)assert(validTransition(a,b)==allowed[a][b]);
}
static void testC2A(){
  AsyncRing<8> ring;lasec_at_event e{};
  for(uint32_t i=0;i<8;i++){e.kind=i;assert(ring.tryPublish(e));} e.kind=99;assert(!ring.tryPublish(e));
  for(uint32_t i=0;i<8;i++){auto v=ring.tryConsume();assert(v&&v->kind==i);}assert(!ring.tryConsume());
  constexpr uint32_t N=100000;std::atomic<bool> done=false;std::atomic<uint32_t> consumed=0;
  std::thread producer([&]{for(uint32_t i=0;i<N;i++){e.kind=i;while(!ring.tryPublish(e))std::this_thread::yield();}done=true;});
  std::thread consumer([&]{uint32_t expected=0;while(!done||consumed<N){auto v=ring.tryConsume();if(!v){std::this_thread::yield();continue;}assert(v->kind==expected++);consumed++;}});
  producer.join();consumer.join();assert(consumed==N);
}
static void testBatch(){
  uint8_t good[]={2,0,0,0,1,0,0,0,2,0,0,0,8,9,1,0,1,0,2,0,0,0,7,6};BatchSegment s[2]{};size_t n=0;
  assert(parseBatch(good,sizeof(good),s,2,n)&&n==2);good[18]=0;assert(!parseBatch(good,sizeof(good),s,2,n));
  uint8_t bad[]={1,0,0,0,1,0,0,0,65,0,0,0};assert(!parseBatch(bad,sizeof(bad),s,2,n));
}
struct Head{uint64_t time;uint32_t lane;uint64_t seq;};
static bool less(const Head&a,const Head&b){return a.time!=b.time?a.time<b.time:a.lane!=b.lane?a.lane<b.lane:a.seq<b.seq;}
static void testFutureHead(){
  std::vector<Head> h={{20,1,2},{20,0,9},{10,1,1}};auto it=std::min_element(h.begin(),h.end(),less);assert(it->time==10&&it->lane==1);h.erase(it);it=std::min_element(h.begin(),h.end(),less);assert(it->lane==0);
  uint64_t scheduled=20,reschedules=0;Head earlier{15,1,3},later{30,0,1};if(earlier.time<scheduled){scheduled=earlier.time;reschedules++;}if(later.time<scheduled){scheduled=later.time;reschedules++;}assert(reschedules==1&&scheduled==15);
}
static void testProducerAndResponse(){
  ProducerLane<4> lane;lasec_at_event e{};for(uint32_t i=0;i<4;i++){e.kind=i;assert(lane.tryPublish(e));}assert(!lane.tryPublish(e));for(uint32_t i=0;i<4;i++){auto v=lane.tryConsume();assert(v&&v->kind==i);}ResponseSlot<> r;int st=0;assert(r.beginRequest(1));uint8_t p=1;r.complete(1,7,&p,1);assert(r.tryConsume(5,1,5,st)&&st==7);assert(!r.tryConsume(5,1,6,st));}
int main(){assert(sat_supported());testLifecycle();testC2A();testBatch();testFutureHead();testProducerAndResponse();std::cout<<"foundation verification PASS\n";}

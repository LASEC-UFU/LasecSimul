#include "producer_lane.hpp"
#include "response_slot.hpp"
#include "snapshot_region.hpp"
#include "doorbell.hpp"
#include "batch.hpp"
#include "descriptor_validation.hpp"
#include "async_ring.hpp"
#include "lifecycle.hpp"
#include "windows_doorbell.hpp"
#include <cassert>
#include <cstring>
#include <iostream>
#include <thread>
#include <atomic>
#include <vector>
int main(){
  ProducerLane<8> lane; lasec_at_event e{}; e.timestamp_ns=7; for(uint32_t i=0;i<20;i++){e.kind=i; while(!lane.tryPublish(e)) {auto x=lane.tryConsume();assert(x);} auto x=lane.tryConsume();assert(x&&x->kind==i);}
  ResponseSlot<> rs; assert(rs.beginRequest(1)); int st=0; assert(!rs.tryConsume(1,1,1,st)); uint8_t x=3; rs.complete(1,9,&x,1); assert(rs.tryConsume(1,1,1,st)&&st==9); assert(rs.beginRequest(2)); assert(!rs.tryConsume(2,2,2,st));
  SnapshotRegion snap; uint64_t v[8]={1,2,3,4,5,6,7,8},o[8]={}; snap.publish(v,sizeof(v)); assert(snap.read(o,sizeof(o))&&o[7]==8);
  Doorbell bell; auto seen=bell.generation(); bool woke=false; std::thread t([&]{woke=bell.wait(seen,[]{return false;},std::chrono::milliseconds(500));}); bell.ring(); t.join(); assert(woke); auto g=bell.generation(); assert(bell.wait(g,[]{return true;},std::chrono::milliseconds(1)));
  AsyncRing<4> async; assert(async.tryPublish(e)); assert(async.tryConsume()); assert(validTransition(LASEC_AT_CREATED,LASEC_AT_STARTING)); assert(!validTransition(LASEC_AT_FAILED,LASEC_AT_RUNNING));
  uint8_t b[]={2,0,0,0,7,0,0,0,2,0,0,0,9,8,4,0,1,0,2,0,0,0,1,2}; BatchSegment seg[2]{};size_t n=0;assert(parseBatch(b,sizeof(b),seg,2,n)&&n==2); b[8]=1;assert(!parseBatch(b,sizeof(b),seg,2,n));
  lasec_at_control_page c{LASEC_AT_MAGIC,1,0,4096,1,2,2,1,2,sizeof(c),512,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}; lasec_at_endpoint_descriptor d{1,0,1024,0,0,8,sizeof(lasec_at_event),64,0}; assert(validateDescriptor(c,&d)); c.lane_count=0;assert(!validateDescriptor(c,&d)); c.lane_count=2; c.execution_id=0;assert(!validateDescriptor(c,&d));
  SnapshotRegion concurrent; std::atomic<bool> done=false; std::atomic<uint64_t> reads=0; std::thread sw([&]{for(uint64_t k=1;k<=1000000;k++){uint64_t a[8];for(auto& z:a)z=k;concurrent.publish(a,sizeof(a));}done=true;}); std::vector<std::thread> readers;for(int j=0;j<4;j++)readers.emplace_back([&]{uint64_t a[8];while(!done||reads<1000){if(concurrent.read(a,sizeof(a))){for(auto z:a)assert(z==a[0]);reads++;}}}); sw.join();for(auto& r:readers)r.join();assert(reads>0);
#ifdef _WIN32
  uint64_t ng=0;WindowsDoorbell native(L"Local\\LasecSimul_vnext_foundation",ng,true);assert(native.valid());std::atomic<int> armed{0};std::atomic<bool> ready{false};std::vector<std::thread> nw;for(int j=0;j<3;j++)nw.emplace_back([&]{armed++;assert(native.wait([&]{return ready.load();},std::chrono::milliseconds(20)));});while(armed<3)std::this_thread::yield();native.notify();ready=true;for(auto& w:nw)w.join();
#endif
  std::cout<<"vnext synthetic PASS\n";
}

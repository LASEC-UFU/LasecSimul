#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <evntrace.h>
#include <evntcons.h>
#include <cstdio>
#include <cstdint>
#include <vector>
#include <fstream>
#include <algorithm>
#include <unordered_map>
#include <string>
#include <cmath>
#pragma comment(lib,"advapi32.lib")

struct Rec { uint64_t seq{},r3{},d0{},t0{},t5{},v3{},v4{}; uint32_t tid{}; };
struct Sw { uint64_t t{}; uint32_t oldTid{},newTid{},cpu{}; };
static std::vector<Sw> g_sw; static std::vector<std::pair<uint64_t,uint32_t>> g_readyEv; static std::vector<uint64_t> g_dpcEv,g_isrEv; static uint64_t g_ready=0,g_dpc=0,g_isr=0; static TRACE_LOGFILE_HEADER g_hdr{};
static uint64_t g_ops[256]{};
static uint32_t u32(const BYTE* p, ULONG n, ULONG o) { return o+4<=n ? *reinterpret_cast<const uint32_t*>(p+o) : 0; }
static VOID WINAPI cb(EVENT_RECORD* e) {
  if (!e) return; const auto op=e->EventHeader.EventDescriptor.Opcode; if(op<256) ++g_ops[op]; const auto t=e->EventHeader.TimeStamp.QuadPart;
  if(op==36 && e->UserDataLength>=8) { Sw s{(uint64_t)t,u32((BYTE*)e->UserData,e->UserDataLength,4),u32((BYTE*)e->UserData,e->UserDataLength,0),0}; if(e->UserDataLength>=48) s.cpu=u32((BYTE*)e->UserData,e->UserDataLength,44); g_sw.push_back(s); }
  else if(op==50) { ++g_ready; if(e->UserDataLength>=4) g_readyEv.push_back({(uint64_t)t,u32((BYTE*)e->UserData,e->UserDataLength,0)}); } else if(op==68) { ++g_dpc; g_dpcEv.push_back((uint64_t)t); } else if(op==64) { ++g_isr; g_isrEv.push_back((uint64_t)t); }
}
static bool fixture() {
  struct I{uint64_t a,b;}; std::vector<I> x{{150,250},{350,500}}; uint64_t sum=0; for(auto i:x) { const uint64_t e=(i.b<400?i.b:400), s=(i.a>100?i.a:100); if(e>s) sum+=e-s; }
  return sum==150;
}
int wmain(int argc,wchar_t** argv) {
  if(argc<3){ fwprintf(stderr,L"usage: etw-sched-correlator <etl> <core.trace> [out.csv]\n"); return 2; }
  std::ifstream in(argv[2],std::ios::binary); if(!in){fwprintf(stderr,L"core trace open failed\n");return 3;}
  struct H{char magic[8];uint32_t ver,size;uint64_t run,qpf,start,written,dropped,high;}; H h{}; in.read((char*)&h,sizeof(h));
  if(std::string(h.magic,8)!="LSCTRCE1") { /* header validation is intentionally tolerant */ }
  std::vector<BYTE> b(h.size); std::vector<Rec> rs; for(uint64_t i=0;i<h.written && in.read((char*)b.data(),h.size);++i){
    auto rd64=[&](size_t o){uint64_t v=0;if(o+8<=b.size()) memcpy(&v,b.data()+o,8);return v;}; auto rd32=[&](size_t o){uint32_t v=0;if(o+4<=b.size())memcpy(&v,b.data()+o,4);return v;};
    uint16_t et=0; if(b.size()>=84) memcpy(&et,b.data()+80,2); uint64_t seq=rd64(32); if(et==2){auto it=std::find_if(rs.begin(),rs.end(),[&](const Rec&q){return q.seq==seq;}); if(it==rs.end()){Rec r{};r.seq=seq;r.tid=rd32(76);r.v3=rd64(56);rs.push_back(r);}} else if(et==22){ for(auto &q:rs) if(q.seq==seq){q.r3=rd64(136);q.d0=rd64(120);q.v4=rd64(56);}} else if(et==23){for(auto &q:rs) if(q.seq==seq)q.t5=rd64(64);}
  }
  EVENT_TRACE_LOGFILEW lf{}; lf.LogFileName=argv[1]; lf.ProcessTraceMode=PROCESS_TRACE_MODE_EVENT_RECORD|PROCESS_TRACE_MODE_RAW_TIMESTAMP; lf.EventRecordCallback=cb;
  TRACEHANDLE th=OpenTraceW(&lf); if(th==INVALID_PROCESSTRACE_HANDLE){fwprintf(stderr,L"OpenTrace failed=%lu\n",GetLastError());return 4;} g_hdr=lf.LogfileHeader;
  ULONG st=ProcessTrace(&th,1,nullptr,nullptr); CloseTrace(th); if(st!=ERROR_SUCCESS){fwprintf(stderr,L"ProcessTrace failed=%lu\n",st);return 5;}
  wprintf(L"raw ETW reader = PASS\nETW ReservedFlags=0x%08lx PerfFreq=%llu\nCore QPF=%llu\nCSwitch=%zu ReadyThread=%llu DPC=%llu ISR=%llu\nETW raw range=%llu..%llu Core R3 range=",g_hdr.ReservedFlags,(unsigned long long)g_hdr.PerfFreq.QuadPart,(unsigned long long)h.qpf,g_sw.size(),(unsigned long long)g_ready,(unsigned long long)g_dpc,(unsigned long long)g_isr,g_sw.empty()?0:(unsigned long long)g_sw.front().t,g_sw.empty()?0:(unsigned long long)g_sw.back().t);
  uint64_t lo=~0ull,hi=0;for(auto&r:rs)if(r.r3){lo=std::min(lo,r.r3);hi=std::max(hi,r.r3);} wprintf(L"%llu..%llu\nlost events=%llu\nfixture=%s\n",lo==~0ull?0:lo,hi,(unsigned long long)g_hdr.EventsLost,fixture()?L"PASS":L"FAIL");
  wprintf(L"opcode histogram:"); for(int i=0;i<256;++i) if(g_ops[i]) wprintf(L" %d=%llu",i,(unsigned long long)g_ops[i]); wprintf(L"\n");
  std::unordered_map<uint32_t,std::vector<std::pair<uint64_t,uint64_t>>> off; std::unordered_map<uint32_t,uint64_t> open;
  for(auto&s:g_sw){if(s.oldTid){open[s.oldTid]=s.t;} if(s.newTid){auto it=open.find(s.newTid);if(it!=open.end()){off[s.newTid].push_back({it->second,s.t});open.erase(it);}}}
  struct R{uint64_t seq,r3,d0,off,dpc,isr;uint32_t tid,n;}; std::vector<R> out; size_t confirmed=0; auto overlap=[&](const std::vector<uint64_t>&v,uint64_t a,uint64_t b){uint64_t z=0;for(auto t:v)if(t>=a&&t<b)z+=1;return z;}; for(auto&r:rs) if(r.r3&&r.d0&&r.d0>r.r3&&r.d0-r.r3>=h.qpf/100000){uint64_t oc=0;uint32_t n=0; auto it=off.find(r.tid); if(it!=off.end()) for(auto p:it->second){auto e=(p.second<r.d0?p.second:r.d0),s=(p.first>r.r3?p.first:r.r3);if(e>s){oc+=e-s;++n;}} out.push_back({r.seq,r.r3,r.d0,oc,overlap(g_dpcEv,r.r3,r.d0),overlap(g_isrEv,r.r3,r.d0),r.tid,n});if(oc)++confirmed;}
  auto pct=[&](int kind,double p){std::vector<double>v;for(auto&r:out){double w=(r.d0-r.r3)*1e6/h.qpf;v.push_back(kind==0?w:kind==1?r.off*1e6/h.qpf:(double)r.off/(r.d0-r.r3));}if(v.empty())return 0.0;std::sort(v.begin(),v.end());size_t i=(size_t)std::floor(p*(v.size()-1));return v[i];};
  wprintf(L"transactions=%zu tails>=10us=%zu confirmed descheduled=%zu no scheduling=%zu\nwallGapUs median=%.3f p95=%.3f max=%.3f\noffCpuGapUs median=%.3f p95=%.3f max=%.3f\noffCpuShare median=%.3f p95=%.3f\n",rs.size(),out.size(),confirmed,out.size()-confirmed,pct(0,.5),pct(0,.95),pct(0,1),pct(1,.5),pct(1,.95),pct(1,1),pct(2,.5),pct(2,.95));
  std::sort(out.begin(),out.end(),[](const R&a,const R&b){return (a.d0-a.r3)>(b.d0-b.r3);}); wprintf(L"top tails (seq tid R3 D0 wallUs offUs share switches)\n"); for(size_t i=0;i<std::min<size_t>(20,out.size());++i){auto&r=out[i];wprintf(L"%llu %lu %llu %llu %.3f %.3f %.3f %u\n",r.seq,r.tid,r.r3,r.d0,(r.d0-r.r3)*1e6/h.qpf,r.off*1e6/h.qpf,(double)r.off/(r.d0-r.r3),r.n);}
  if(argc>3){std::wofstream o(argv[3]);o<<L"seq,tid,r3,d0,wallGapUs,offCpuUs,offCpuShare,switches,dpcEvents,isrEvents\n"; for(auto&r:out)o<<r.seq<<L","<<r.tid<<L","<<r.r3<<L","<<r.d0<<L","<<(r.d0-r.r3)*1e6/h.qpf<<L","<<r.off*1e6/h.qpf<<L","<<(double)r.off/(r.d0-r.r3)<<L","<<r.n<<L","<<r.dpc<<L","<<r.isr<<L"\n";}
  return 0;
}

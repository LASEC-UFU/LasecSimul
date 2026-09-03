#include "windows_doorbell.hpp"
#include <cassert>
#include <cstdint>
#include <iostream>
#ifdef _WIN32
#include <windows.h>
#include <atomic>
#include <thread>
#include <vector>
#include "shared_atomic.h"
struct SharedState { alignas(8) uint64_t generation; uint32_t state; uint32_t child_ready; uint64_t response_seq; int32_t response_status; uint64_t snapshot_seq; uint64_t snapshot[8]; };
int wmain(int argc,wchar_t** argv){
  (void)argv;
  if(argc!=1)return 1;
  wchar_t exe[MAX_PATH];GetModuleFileNameW(nullptr,exe,MAX_PATH);std::wstring cexe=exe;cexe=cexe.substr(0,cexe.find_last_of(L"\\/"))+L"\\cross_process_c.exe";std::wstring suffix=std::to_wstring(GetCurrentProcessId());std::wstring mapName=L"Local\\LasecSimul_vnext_map_"+suffix,eventName=L"Local\\LasecSimul_vnext_event_"+suffix;
  HANDLE map=CreateFileMappingW(INVALID_HANDLE_VALUE,nullptr,PAGE_READWRITE,0,sizeof(SharedState),mapName.c_str());assert(map);auto* s=(SharedState*)MapViewOfFile(map,FILE_MAP_ALL_ACCESS,0,0,sizeof(SharedState));assert(s);*s={0,0,0,0,0,0,{0,0,0,0,0,0,0,0}};HANDLE event=CreateEventW(nullptr,TRUE,FALSE,eventName.c_str());assert(event);
  std::wstring cmd=L"\""+cexe+L"\" "+mapName+L" "+eventName;STARTUPINFOW si{};si.cb=sizeof(si);PROCESS_INFORMATION pi{};std::vector<wchar_t> buffer(cmd.begin(),cmd.end());buffer.push_back(0);assert(CreateProcessW(nullptr,buffer.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&si,&pi));
  while(sat32_load_seq_cst(&s->child_ready)==0)Sleep(1);
  for(int i=0;i<8;i++) { sat64_store_seq_cst(&s->snapshot[i],77); }
  sat32_store_seq_cst((uint32_t*)&s->response_status,42);sat64_store_seq_cst(&s->snapshot_seq,1);sat64_store_seq_cst(&s->response_seq,1);sat32_store_seq_cst(&s->state,1);WindowsDoorbell bell(eventName,s->generation,true);bell.notify();
  while(sat64_load_seq_cst(&s->response_seq)!=2)Sleep(1);
  assert(sat32_load_seq_cst((uint32_t*)&s->response_status)==43&&sat64_load_seq_cst(&s->snapshot_seq)==2);for(int i=0;i<8;i++)assert(sat64_load_seq_cst(&s->snapshot[i])==88);sat32_store_seq_cst(&s->state,2);sat64_fetch_add(&s->generation,1); // deliberately suppress SetEvent; child must use fallback
  DWORD result=WaitForSingleObject(pi.hProcess,3000);assert(result==WAIT_OBJECT_0);DWORD code=1;GetExitCodeProcess(pi.hProcess,&code);assert(code==0);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(event);UnmapViewOfFile(s);CloseHandle(map);std::cout<<"cross-process doorbell PASS\n";return 0;
}
#else
int main(){std::cout<<"cross-process doorbell UNAVAILABLE (Windows only)\n";return 0;}
#endif

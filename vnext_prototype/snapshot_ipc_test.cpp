#include "shared_atomic.h"
#include <windows.h>
#include <cassert>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
struct SnapshotShared { uint64_t seq; uint64_t words[8]; uint32_t ready; uint32_t done; uint64_t errors; };
static void writeSnapshot(SnapshotShared*s,uint64_t n){uint64_t q=sat64_load_seq_cst(&s->seq);sat64_store_seq_cst(&s->seq,q|1);for(int i=0;i<8;i++)sat64_store_seq_cst(&s->words[i],n*17u+(uint64_t)i);sat64_store_seq_cst(&s->seq,(q|1)+1);}
static void readSnapshot(SnapshotShared*s){uint64_t a=sat64_load_seq_cst(&s->seq);if(!a||a&1)return;uint64_t x[8];for(int i=0;i<8;i++)x[i]=sat64_load_seq_cst(&s->words[i]);if(a==sat64_load_seq_cst(&s->seq))for(int i=1;i<8;i++)if(x[i]!=x[0]+(uint64_t)i){sat64_fetch_add(&s->errors,1);break;}}
static void run(int mode){wchar_t exe[MAX_PATH];GetModuleFileNameW(nullptr,exe,MAX_PATH);std::wstring child=std::wstring(exe).substr(0,std::wstring(exe).find_last_of(L"\\/"))+L"\\snapshot_ipc_c.exe";std::wstring name=L"Local\\LasecSimul_snapshot_"+std::to_wstring(GetCurrentProcessId())+L"_"+std::to_wstring(mode);HANDLE m=CreateFileMappingW(INVALID_HANDLE_VALUE,nullptr,PAGE_READWRITE,0,sizeof(SnapshotShared),name.c_str());assert(m);auto*s=(SnapshotShared*)MapViewOfFile(m,FILE_MAP_ALL_ACCESS,0,0,sizeof(SnapshotShared));assert(s);*s={};std::wstring cmd=L"\""+child+L"\" "+name+L" "+std::to_wstring(mode);STARTUPINFOW si{};si.cb=sizeof(si);PROCESS_INFORMATION pi{};std::vector<wchar_t>b(cmd.begin(),cmd.end());b.push_back(0);assert(CreateProcessW(nullptr,b.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&si,&pi));while(!sat32_load_seq_cst(&s->ready))Sleep(1);if(mode==1){for(uint64_t i=1;i<=1000000;i++)writeSnapshot(s,i);sat32_store_seq_cst(&s->done,1);}else{while(!sat32_load_seq_cst(&s->done)){readSnapshot(s);Sleep(0);}}assert(WaitForSingleObject(pi.hProcess,30000)==WAIT_OBJECT_0);DWORD code=1;GetExitCodeProcess(pi.hProcess,&code);assert(code==0&&sat64_load_seq_cst(&s->errors)==0);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);UnmapViewOfFile(s);CloseHandle(m);}
int wmain(){assert(sat_supported());run(1);run(2);std::cout<<"cross-process snapshot PASS\n";return 0;}

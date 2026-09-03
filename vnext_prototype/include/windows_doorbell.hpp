#pragma once
#ifdef _WIN32
#include <windows.h>
#include <atomic>
#include <chrono>
#include <string>
#include "shared_atomic.h"
// The named manual-reset Event is only a wake accelerator; generation/state is truth.
class WindowsDoorbell { HANDLE event_=nullptr; uint64_t* generation_;
public: WindowsDoorbell(const std::wstring& name,uint64_t& generation,bool create):generation_(&generation){event_=create?CreateEventW(nullptr,TRUE,FALSE,name.c_str()):OpenEventW(SYNCHRONIZE|EVENT_MODIFY_STATE,FALSE,name.c_str());}
 ~WindowsDoorbell(){if(event_)CloseHandle(event_);} WindowsDoorbell(const WindowsDoorbell&)=delete; bool valid()const{return event_!=nullptr;}
 bool notify(){sat64_fetch_add(generation_,1);return SetEvent(event_)!=0;}
 template<class P> bool wait(P predicate,DWORD timeout=INFINITE){for(;;){if(predicate())return true;auto seen=sat64_load_seq_cst(generation_);ResetEvent(event_);if(predicate()||sat64_load_seq_cst(generation_)!=seen)continue;auto r=WaitForSingleObject(event_,timeout);if(r==WAIT_FAILED||r==WAIT_ABANDONED)return false;if(timeout!=INFINITE&&r==WAIT_TIMEOUT)return predicate();}}
 template<class P> bool wait(P predicate,std::chrono::milliseconds fallback){return wait(predicate,(DWORD)fallback.count());}
};
#endif

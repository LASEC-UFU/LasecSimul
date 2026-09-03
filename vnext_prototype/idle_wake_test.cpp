#include "windows_doorbell.hpp"
#include <atomic>
#include <cassert>
#include <chrono>
#include <iostream>
#include <thread>
#include <vector>
int main(){std::atomic<int> returned{0};std::vector<uint64_t> generations(16);std::vector<std::atomic<bool>> stop(16);std::vector<std::unique_ptr<WindowsDoorbell>> bells;std::vector<std::thread> waiters;for(int i=0;i<16;i++){stop[i]=false;bells.emplace_back(new WindowsDoorbell(L"Local\\LasecSimul_idle_"+std::to_wstring(i),generations[i],true));assert(bells.back()->valid());waiters.emplace_back([&,i]{assert(bells[i]->wait([&]{return stop[i].load();}));returned++;});}std::this_thread::sleep_for(std::chrono::milliseconds(100));assert(returned==0);for(int i=0;i<16;i++){stop[i]=true;assert(bells[i]->notify());}for(auto&t:waiters)t.join();assert(returned==16);std::cout<<"idle wake policy PASS\n";}

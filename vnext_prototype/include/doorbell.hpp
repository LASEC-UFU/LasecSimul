#pragma once
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <chrono>
class Doorbell { std::atomic<uint64_t> generation_{0}; std::mutex m_; std::condition_variable cv_;
public: void ring(){generation_.fetch_add(1,std::memory_order_release);cv_.notify_all();}
  template<class P> bool wait(uint64_t seen,P predicate,std::chrono::milliseconds fallback){ std::unique_lock<std::mutex> l(m_); return cv_.wait_for(l,fallback,[&]{return generation_.load(std::memory_order_acquire)!=seen || predicate();}); }
  uint64_t generation() const{return generation_.load(std::memory_order_acquire);}
};

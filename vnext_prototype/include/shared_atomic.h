#ifndef LASEC_SHARED_ATOMIC_H
#define LASEC_SHARED_ATOMIC_H
#include <stdint.h>
#ifdef _MSC_VER
#include <intrin.h>
static inline uint32_t sat32_load_seq_cst(const uint32_t* p){return (uint32_t)_InterlockedCompareExchange((volatile long*)p,0,0);}
static inline uint64_t sat64_load_seq_cst(const uint64_t* p){return (uint64_t)_InterlockedCompareExchange64((volatile long long*)p,0,0);}
static inline void sat32_store_seq_cst(uint32_t* p,uint32_t v){_InterlockedExchange((volatile long*)p,(long)v);}
static inline void sat64_store_seq_cst(uint64_t* p,uint64_t v){_InterlockedExchange64((volatile long long*)p,(long long)v);}
static inline uint64_t sat64_fetch_add(uint64_t* p,uint64_t v){return (uint64_t)_InterlockedExchangeAdd64((volatile long long*)p,(long long)v);}
#else
static inline uint32_t sat32_load_seq_cst(const uint32_t* p){uint32_t v;__atomic_load(p,&v,__ATOMIC_SEQ_CST);return v;}
static inline uint64_t sat64_load_seq_cst(const uint64_t* p){uint64_t v;__atomic_load(p,&v,__ATOMIC_SEQ_CST);return v;}
static inline void sat32_store_seq_cst(uint32_t* p,uint32_t v){__atomic_store(p,&v,__ATOMIC_SEQ_CST);}
static inline void sat64_store_seq_cst(uint64_t* p,uint64_t v){__atomic_store(p,&v,__ATOMIC_SEQ_CST);}
static inline uint64_t sat64_fetch_add(uint64_t* p,uint64_t v){return __atomic_fetch_add(p,v,__ATOMIC_SEQ_CST);}
#endif
static inline int sat_supported(void){
#ifdef _MSC_VER
 return 1;
#else
 return __atomic_always_lock_free(4,0)&&__atomic_always_lock_free(8,0);
#endif
}
#endif

#pragma once
#include "artifact_transport_abi.h"
#include <cstddef>
#include <cstdint>
struct BatchSegment { uint32_t transaction; uint16_t index; uint16_t count; const uint8_t* data; };
inline bool parseBatch(const uint8_t* p,size_t n,BatchSegment* out,size_t cap,size_t& count){ if(n<4)return false; count=p[0]; if(!count||count>cap||count>LASEC_AT_BATCH_MAX_SEGMENTS)return false; size_t at=4; uint16_t last=0; for(size_t i=0;i<count;i++){if(at+8>n)return false; uint32_t tx=uint32_t(p[at])|uint32_t(p[at+1])<<8; uint16_t ix=uint16_t(uint16_t(p[at+2])|uint16_t(uint16_t(p[at+3])<<8)); uint16_t bytes=uint16_t(uint16_t(p[at+4])|uint16_t(uint16_t(p[at+5])<<8)); out[i]={tx,ix,bytes,p+at+8}; if(out[i].index!=i||(!i&&out[i].index)|| (i&&out[i].index<=last)||at+8+out[i].count>n)return false; last=out[i].index;at+=8+out[i].count;} return at==n; }

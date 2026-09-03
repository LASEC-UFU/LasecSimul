#include "shared_atomic.h"
#include <windows.h>
#include <stdint.h>
#include <stdlib.h>
typedef struct SnapshotShared { uint64_t seq; uint64_t words[8]; uint32_t ready; uint32_t done; uint64_t errors; } SnapshotShared;
static void write_snapshot(SnapshotShared*s,uint64_t n){uint64_t q=sat64_load_seq_cst(&s->seq);sat64_store_seq_cst(&s->seq,q|1);for(int i=0;i<8;i++)sat64_store_seq_cst(&s->words[i],n*17u+(uint64_t)i);sat64_store_seq_cst(&s->seq,(q|1)+1);}
static void read_snapshot(SnapshotShared*s){uint64_t a=sat64_load_seq_cst(&s->seq);if(!a||a&1)return;uint64_t x[8];for(int i=0;i<8;i++)x[i]=sat64_load_seq_cst(&s->words[i]);if(a==sat64_load_seq_cst(&s->seq)){for(int i=1;i<8;i++)if(x[i]!=x[0]+(uint64_t)i){sat64_fetch_add(&s->errors,1);break;}}}
int main(int argc,char**argv){if(argc!=3)return 2;HANDLE m=OpenFileMappingA(FILE_MAP_ALL_ACCESS,0,argv[1]);if(!m)return 3;SnapshotShared*s=MapViewOfFile(m,FILE_MAP_ALL_ACCESS,0,0,sizeof(*s));if(!s)return 4;int mode=atoi(argv[2]);sat32_store_seq_cst(&s->ready,1);if(mode==1){while(!sat32_load_seq_cst(&s->done)){read_snapshot(s);Sleep(0);}}else{for(uint64_t i=1;i<=1000000;i++)write_snapshot(s,i);sat32_store_seq_cst(&s->done,1);}int ok=sat64_load_seq_cst(&s->errors)==0;UnmapViewOfFile(s);CloseHandle(m);return ok?0:5;}

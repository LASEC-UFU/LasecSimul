#include "shared_atomic.h"
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
typedef struct SharedState { uint64_t generation; uint32_t state; uint32_t child_ready; uint64_t response_seq; int32_t response_status; uint64_t snapshot_seq; uint64_t snapshot[8]; } SharedState;
static int wait_state(SharedState* s,HANDLE ev,uint32_t wanted){for(;;){if(sat32_load_seq_cst(&s->state)==wanted)return 1;uint64_t seen=sat64_load_seq_cst(&s->generation);ResetEvent(ev);if(sat32_load_seq_cst(&s->state)==wanted||sat64_load_seq_cst(&s->generation)!=seen)continue;DWORD r=WaitForSingleObject(ev,5);if(r==WAIT_FAILED)return 0;}}
int main(int argc,char** argv){if(argc!=3)return 2;HANDLE map=OpenFileMappingA(FILE_MAP_ALL_ACCESS,FALSE,argv[1]);if(!map)return 3;SharedState* s=(SharedState*)MapViewOfFile(map,FILE_MAP_ALL_ACCESS,0,0,sizeof(*s));HANDLE ev=OpenEventA(SYNCHRONIZE|EVENT_MODIFY_STATE,FALSE,argv[2]);if(!s||!ev)return 4;sat32_store_seq_cst(&s->child_ready,1);if(!wait_state(s,ev,1))return 5;if(sat64_load_seq_cst(&s->response_seq)!=1||sat32_load_seq_cst((uint32_t*)&s->response_status)!=42||sat64_load_seq_cst(&s->snapshot_seq)!=1)return 6;for(int i=0;i<8;i++)if(sat64_load_seq_cst(&s->snapshot[i])!=77)return 7;sat32_store_seq_cst((uint32_t*)&s->response_status,43);sat64_store_seq_cst(&s->response_seq,2);for(int i=0;i<8;i++)sat64_store_seq_cst(&s->snapshot[i],88);sat64_store_seq_cst(&s->snapshot_seq,2);sat64_fetch_add(&s->generation,1);SetEvent(ev);int ok=wait_state(s,ev,2);if(s)UnmapViewOfFile(s);if(ev)CloseHandle(ev);CloseHandle(map);return ok?0:8;}

#include <windows.h>
#include <stdio.h>
int main(void){LARGE_INTEGER f,a,b;QueryPerformanceFrequency(&f);unsigned long long min=~0ull,sum=0,max=0;for(int i=0;i<1000000;i++){QueryPerformanceCounter(&a);QueryPerformanceCounter(&b);unsigned long long d=(unsigned long long)(b.QuadPart-a.QuadPart);if(d<min)min=d;if(d>max)max=d;sum+=d;}printf("freq=%lld samples=1000000 min=%llu avg_ticks=%.3f max=%llu avg_ns=%.3f\n",f.QuadPart,min,(double)sum/1000000.0,max,(double)sum*1e9/(1000000.0*f.QuadPart));}

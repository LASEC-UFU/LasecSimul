#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int parse(const char *v, uint64_t *out) {
    if (!v || !v[0]) return 0;
    for (const unsigned char *p=(const unsigned char*)v; *p; ++p)
        if (*p < '0' || *p > '9') return 0;
    errno=0; char *end=0;
    unsigned long long x=strtoull(v,&end,10);
    if (errno==ERANGE || end==(char*)v || *end) return 0;
    *out=(uint64_t)x; return 1;
}
int main(void) {
    const char *ok[]={"1","0","1311768467463790320","18446744073709551615"};
    const char *bad[]={"","-1","+1"," 1","1 ","abc","123abc","18446744073709551616"};
    uint64_t x;
    for (size_t i=0;i<sizeof(ok)/sizeof(ok[0]);++i) if(!parse(ok[i],&x)){fprintf(stderr,"valid rejected: %s\n",ok[i]);return 1;}
    for (size_t i=0;i<sizeof(bad)/sizeof(bad[0]);++i) if(parse(bad[i],&x)){fprintf(stderr,"invalid accepted: %s\n",bad[i]);return 1;}
    if (parse("0",&x) && x!=0) return 1;
    puts("strict identity parser cases passed"); return 0;
}

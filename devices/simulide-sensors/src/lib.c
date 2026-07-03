#include "lasecsimul/device_abi.h"
#include <stdint.h>

/*
 * Windows-only: replace every CRT dependency with Windows API (kernel32) or
 * inline code so that ucrtbase.dll (MinGW release UCRT) is never loaded into
 * a process that already has ucrtbased.dll (MSVC debug UCRT).  Loading both
 * causes the debug CRT consistency check to call abort().
 *
 * On Linux/macOS the normal CRT headers are used as before.
 */
/* MinGW on Windows: replace every CRT dep so ucrtbase.dll (release UCRT) is never
 * loaded into a process that already has ucrtbased.dll (MSVC Debug UCRT).
 * MSVC builds use the normal CRT — same as the Core — so no conflict. */
#if defined(_WIN32) && !defined(_MSC_VER)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* DLL entry point — replaces MinGW's DllMainCRTStartup (which loads ucrtbase.dll) */
BOOL WINAPI DllMainCRTStartup(HINSTANCE h, DWORD r, LPVOID p) {
    (void)h; (void)r; (void)p; return TRUE;
}

/* Memory — kernel32 process heap, zero-initialised like calloc */
static void *_lsdn_calloc(size_t n) {
    return HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, n);
}
static void _lsdn_free(void *p) {
    if (p) HeapFree(GetProcessHeap(), 0, p);
}

/* memset / memcpy — non-static so GCC can resolve external calls when not inlined */
void *memset(void *s, int c, size_t n) {
    unsigned char *p = (unsigned char *)s;
    while (n--) *p++ = (unsigned char)c;
    return s;
}
void *memcpy(void *d, const void *s, size_t n) {
    char *dp = (char *)d;
    const char *sp = (const char *)s;
    while (n--) *dp++ = *sp++;
    return d;
}

/* String functions — static, no external CRT reference */
static int _lsdn_strcmp(const char *a, const char *b) {
    while (*a && *a == *b) { ++a; ++b; }
    return (unsigned char)*a - (unsigned char)*b;
}
static void _lsdn_strncpy(char *d, const char *s, size_t n) {
    size_t i;
    for (i = 0; i < n && s[i]; i++) d[i] = s[i];
    for (; i < n; i++) d[i] = '\0';
}
static const char *_lsdn_strstr(const char *h, const char *needle) {
    if (!*needle) return h;
    for (; *h; ++h) {
        const char *p = h, *q = needle;
        while (*p && *q && *p == *q) { ++p; ++q; }
        if (!*q) return h;
    }
    return 0;
}

/* Math — inline implementations adequate for sensor simulation ranges */
typedef union { double d; unsigned long long u; } _lsdn_du;

static double _lsdn_log(double x) {
    if (x <= 0.0) return -1e300;
    _lsdn_du du; du.d = x;
    int e = (int)((du.u >> 52) & 0x7FFull) - 1023;
    du.u = (du.u & 0x000FFFFFFFFFFFFFull) | 0x3FF0000000000000ull; /* m in [1,2) */
    double m = du.d, y = (m - 1.0) / (m + 1.0), y2 = y * y;
    double lm = 2.0*y*(1.0 + y2*(1.0/3.0 + y2*(1.0/5.0 + y2*(1.0/7.0 + y2*(1.0/9.0 + y2/11.0)))));
    return lm + (double)e * 0.6931471805599453;
}
static double _lsdn_exp(double x) {
    if (x < -708.0) return 0.0;
    if (x >  709.0) return 1e308;
    const double LN2 = 0.6931471805599453;
    long long n = (long long)(x / LN2);
    if ((double)n * LN2 > x) n--;   /* floor toward -inf */
    double r = x - (double)n * LN2; /* r in [0, ln2) */
    double p = 1.0 + r*(1.0 + r*(0.5 + r*(1.0/6.0 + r*(1.0/24.0 + r*(1.0/120.0 + r/720.0)))));
    _lsdn_du du; du.d = p;
    long long ex = (long long)((du.u >> 52) & 0x7FFull) + n;
    if (ex <= 0)   return 0.0;
    if (ex > 2046) return 1e308;
    du.u = (du.u & 0x800FFFFFFFFFFFFFull) | ((unsigned long long)ex << 52);
    return du.d;
}
static double _lsdn_pow(double b, double e) {
    if (b <= 0.0) return (e == 0.0) ? 1.0 : 0.0;
    return _lsdn_exp(e * _lsdn_log(b));
}

#define calloc(n, sz)    _lsdn_calloc((size_t)(n) * (size_t)(sz))
#define free(p)          _lsdn_free(p)
#define strcmp(a, b)     _lsdn_strcmp(a, b)
#define strncpy(d, s, n) _lsdn_strncpy(d, s, n)
#define strstr(h, nd)    _lsdn_strstr(h, nd)
#define pow(b, e)        _lsdn_pow(b, e)
#define exp(x)           _lsdn_exp(x)

#else  /* MSVC or non-Windows: use normal CRT */
#include <string.h>
#include <stdlib.h>
#include <math.h>
#endif

/* ------------------------------------------------------------------ */

enum {
    KIND_LDR        = 0,
    KIND_THERMISTOR = 1,
    KIND_RTD        = 2,
    KIND_STRAIN     = 3,
    KIND_SR04       = 4,
    KIND_DHT22      = 5,
    KIND_DS1621     = 6,
    KIND_DS18B20    = 7,
};

typedef struct {
    void *host_ctx;
    const LsdnHostApi *api;
    int kind;

    /* LDR */
    double lux, gamma, r1;
    double min_lux, max_lux;

    /* Thermistor */
    double therm_temp, b_coeff, r25;
    double therm_min, therm_max;
    int    ptc;

    /* RTD */
    double rtd_temp, r0_rtd;
    double rtd_min, rtd_max;

    /* Strain gauge */
    double force_n, min_force, max_force;
    double gf, r0_sg;

    /* SR04 */
    double distance_m;
    int    use_analog, sr04_echo_active;

    /* DHT22/11 */
    int      dht_model;
    double   dht_temp, dht_humi;
    double   dht_temp_inc, dht_humi_inc;
    int      dht_bit_idx, dht_state;
    uint64_t dht_bits;

    /* DS1621 */
    double  ds1621_temp, ds1621_th, ds1621_tl;
    uint8_t ds1621_reg, ds1621_buf[2];
    int     ds1621_addr;

    /* DS18B20 */
    char   rom_hex[17];
    double ds18b20_temp;
    int    ds18b20_state;
} SensorState;

static const char *cfg_str(SensorState *s, const char *name, const char *fallback) {
    static char buf[96];
    LsdnPropertyValue v;
    memset(&v, 0, sizeof(v));
    if (s->api->config_get && s->api->config_get(s->host_ctx, name, &v)
            && v.kind == LSDN_PROPERTY_STRING && v.string_value) {
        strncpy(buf, v.string_value, sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = '\0';
        return buf;
    }
    return fallback;
}

static double cfg_num(SensorState *s, const char *name, double fallback) {
    LsdnPropertyValue v;
    memset(&v, 0, sizeof(v));
    if (s->api->config_get && s->api->config_get(s->host_ctx, name, &v)
            && v.kind == LSDN_PROPERTY_NUMBER)
        return v.number_value;
    return fallback;
}

static double ldr_R(SensorState *s) {
    double lux = s->lux > 1e-6 ? s->lux : 1e-6;
    return s->r1 * pow(lux, -s->gamma);
}

static double therm_R(SensorState *s) {
    if (s->ptc) {
        double alpha = 0.00385;
        double R = s->r25 * (1.0 + alpha * (s->therm_temp - 25.0));
        return R < 0.01 ? 0.01 : R;
    }
    double T_K  = s->therm_temp + 273.15;
    double T0_K = 298.15;
    double R = s->r25 * exp(s->b_coeff * (1.0/T_K - 1.0/T0_K));
    return R < 0.01 ? 0.01 : R;
}

static double rtd_R(SensorState *s) {
    double A = 3.9083e-3;
    double B = -5.775e-7;
    double T = s->rtd_temp;
    double R = s->r0_rtd * (1.0 + A*T + B*T*T);
    return R < 0.01 ? 0.01 : R;
}

static double strain_R(SensorState *s) {
    double range = s->max_force - s->min_force;
    double strain = range > 0.0 ? (s->force_n - s->min_force) / range - 0.5 : 0.0;
    double R = s->r0_sg * (1.0 + s->gf * strain * 0.01);
    return R < 0.01 ? 0.01 : R;
}

static uint64_t dht_pack(SensorState *s) {
    uint16_t hraw, traw;
    if (s->dht_model == 11) {
        hraw = (uint16_t)((int)s->dht_humi & 0xFF) << 8;
        traw = (uint16_t)((int)s->dht_temp & 0xFF) << 8;
    } else {
        hraw = (uint16_t)(int)(s->dht_humi * 10.0);
        int16_t t10 = (int16_t)(s->dht_temp * 10.0);
        traw = (s->dht_temp < 0.0)
            ? ((uint16_t)(-t10) | 0x8000u)
            : (uint16_t)t10;
    }
    uint8_t cs = (hraw >> 8) + (hraw & 0xFF) + (traw >> 8) + (traw & 0xFF);
    return ((uint64_t)hraw << 24) | ((uint64_t)traw << 8) | cs;
}

static LsdnDevice *sens_create(void *host_ctx, const LsdnHostApi *api) {
    SensorState *s = (SensorState *)calloc(1, sizeof(SensorState));
    if (!s) return NULL;
    s->host_ctx = host_ctx;
    s->api      = api;
    return (LsdnDevice *)s;
}

static void sens_init(LsdnDevice *dev) {
    SensorState *s = (SensorState *)dev;

    const char *tid = cfg_str(s, "__typeId", "sensors.ldr");
    if      (strstr(tid, "thermistor")) s->kind = KIND_THERMISTOR;
    else if (strstr(tid, "rtd"))        s->kind = KIND_RTD;
    else if (strstr(tid, "strain"))     s->kind = KIND_STRAIN;
    else if (strstr(tid, "sr04"))       s->kind = KIND_SR04;
    else if (strstr(tid, "dht"))        s->kind = KIND_DHT22;
    else if (strstr(tid, "ds1621"))     s->kind = KIND_DS1621;
    else if (strstr(tid, "ds18b20"))    s->kind = KIND_DS18B20;
    else                                s->kind = KIND_LDR;

    s->lux      = cfg_num(s, "lux",     1.0);
    s->gamma    = cfg_num(s, "gamma",   0.8582);
    s->r1       = cfg_num(s, "r1",      127410.0);
    s->min_lux  = cfg_num(s, "min_lux", 0.001);
    s->max_lux  = cfg_num(s, "max_lux", 100000.0);

    s->therm_temp = cfg_num(s, "temp",    25.0);
    s->b_coeff    = cfg_num(s, "b_coeff", 3455.0);
    s->r25        = cfg_num(s, "r25",     10000.0);
    s->therm_min  = cfg_num(s, "min_temp",-55.0);
    s->therm_max  = cfg_num(s, "max_temp", 200.0);
    s->ptc        = (int)cfg_num(s, "ptc", 0.0);

    s->rtd_temp  = cfg_num(s, "temp",    25.0);
    s->r0_rtd    = cfg_num(s, "r0",      100.0);
    s->rtd_min   = cfg_num(s, "min_temp",-200.0);
    s->rtd_max   = cfg_num(s, "max_temp", 850.0);

    s->force_n   = cfg_num(s, "force_n",   0.0);
    s->min_force = cfg_num(s, "min_force",-1000.0);
    s->max_force = cfg_num(s, "max_force", 1000.0);
    s->gf        = cfg_num(s, "gf",        2.0);
    s->r0_sg     = cfg_num(s, "r0",        120.0);

    s->distance_m = cfg_num(s, "distance_m", 0.5);
    s->use_analog = (int)cfg_num(s, "use_analog", 0.0);

    s->dht_model    = (int)cfg_num(s, "model",    22.0);
    s->dht_temp     = cfg_num(s, "temp",           25.0);
    s->dht_humi     = cfg_num(s, "humi",           50.0);
    s->dht_temp_inc = cfg_num(s, "temp_inc",        0.0);
    s->dht_humi_inc = cfg_num(s, "humi_inc",        0.0);

    s->ds1621_temp = cfg_num(s, "temp", 25.0);
    s->ds1621_th   = cfg_num(s, "th",   80.0);
    s->ds1621_tl   = cfg_num(s, "tl",   20.0);

    strncpy(s->rom_hex, cfg_str(s, "rom", "28AA0000000000B1"), 16);
    s->ds18b20_temp = cfg_num(s, "temp", 25.0);

    /* Periodic tick for auto-increment sensors (event ID=100, 1 second) */
    if (s->kind == KIND_DHT22)
        s->api->schedule_event(s->host_ctx, 1000000000u, 100u);
}

static void sens_stamp(LsdnDevice *dev, LsdnMatrixView *m) {
    SensorState *s = (SensorState *)dev;
    if (!m) return;

    double R = 1e9;
    switch (s->kind) {
        case KIND_LDR:        R = ldr_R(s);    break;
        case KIND_THERMISTOR: R = therm_R(s);  break;
        case KIND_RTD:        R = rtd_R(s);    break;
        case KIND_STRAIN:     R = strain_R(s); break;
        default: break;
    }

    switch (s->kind) {
        case KIND_LDR:
        case KIND_THERMISTOR:
        case KIND_RTD:
        case KIND_STRAIN:
            m->add_conductance(m->opaque, 0, 1, 1.0 / R);
            break;
        default:
            break;
    }
}

static void sens_post_step(LsdnDevice *dev, uint64_t dt_ns) {
    (void)dev; (void)dt_ns;
}

static void sens_on_event(LsdnDevice *dev, const LsdnEvent *ev) {
    SensorState *s = (SensorState *)dev;
    if (!ev) return;

    if (ev->tag == LSDN_EVT_PIN_CHANGE) {
        switch (s->kind) {
            case KIND_SR04:
                if (ev->a == 1 && ev->b == 1) {
                    uint64_t echo_ns = (uint64_t)(s->distance_m * 2.0 / 340.0 * 1e9);
                    if (echo_ns > 38000000u) echo_ns = 38000000u;
                    s->api->schedule_event(s->host_ctx, 10000u, 1u);
                    s->api->schedule_event(s->host_ctx, 10000u + echo_ns, 2u);
                }
                break;
            case KIND_DHT22:
                if (ev->a == 1 && ev->b == 0 && s->dht_state == 0) {
                    s->dht_bits    = dht_pack(s);
                    s->dht_bit_idx = 39;
                    s->dht_state   = 1;
                    s->api->schedule_event(s->host_ctx, 80000u, 10u);
                }
                break;
            case KIND_DS18B20:
                if (ev->a == 1 && ev->b == 0) {
                    s->ds18b20_state = 1;
                }
                if (ev->a == 1 && ev->b == 1 && s->ds18b20_state == 1) {
                    s->api->schedule_event(s->host_ctx, 60000u, 20u);
                    s->ds18b20_state = 0;
                }
                break;
            default:
                break;
        }
    } else if (ev->tag == LSDN_EVT_TIMER) {
        uint32_t id = ev->a;
        switch (s->kind) {
            case KIND_SR04:
                if (id == 1u) {
                    s->api->pin_write(s->host_ctx, 2, 1);
                    s->sr04_echo_active = 1;
                    if (s->use_analog) {
                        float v_out = (float)(s->distance_m * 1.0);
                        s->api->pin_write_analog(s->host_ctx, 2, v_out);
                    }
                } else if (id == 2u) {
                    s->api->pin_write(s->host_ctx, 2, 0);
                    s->sr04_echo_active = 0;
                }
                break;
            case KIND_DHT22:
                if (id == 10u) {
                    s->api->pin_write(s->host_ctx, 1, 1);
                    s->api->schedule_event(s->host_ctx, 80000u, 11u);
                } else if (id == 11u) {
                    if (s->dht_bit_idx >= 0) {
                        int bit = (int)((s->dht_bits >> s->dht_bit_idx) & 1u);
                        s->api->pin_write(s->host_ctx, 1, 0);
                        s->api->schedule_event(s->host_ctx, 50000u, 12u);
                        s->dht_bit_idx--;
                        s->dht_state = (int)((unsigned)s->dht_state | ((unsigned)bit << 8));
                    } else {
                        s->dht_state = 0;
                        s->api->pin_write(s->host_ctx, 1, 1);
                    }
                } else if (id == 12u) {
                    int bit = (s->dht_state >> 8) & 1;
                    s->api->pin_write(s->host_ctx, 1, 1);
                    s->api->schedule_event(s->host_ctx, bit ? 70000u : 26000u, 11u);
                } else if (id == 100u) {
                    if (s->dht_temp_inc != 0.0) {
                        s->dht_temp += s->dht_temp_inc;
                        if (s->dht_temp > 80.0)  s->dht_temp = 80.0;
                        if (s->dht_temp < -40.0) s->dht_temp = -40.0;
                    }
                    if (s->dht_humi_inc != 0.0) {
                        s->dht_humi += s->dht_humi_inc;
                        if (s->dht_humi > 100.0) s->dht_humi = 100.0;
                        if (s->dht_humi < 0.0)   s->dht_humi = 0.0;
                    }
                    s->api->schedule_event(s->host_ctx, 1000000000u, 100u);
                }
                break;
            case KIND_DS18B20:
                if (id == 20u) {
                    s->api->pin_write(s->host_ctx, 1, 0);
                    s->api->schedule_event(s->host_ctx, 240000u, 21u);
                } else if (id == 21u) {
                    s->api->pin_write(s->host_ctx, 1, 1);
                }
                break;
            default:
                break;
        }
    }
}

static uint32_t sens_get_property(LsdnDevice *dev, const char *name, LsdnPropertyValue *out) {
    SensorState *s = (SensorState *)dev;
    if (!name || !out) return 0;
    memset(out, 0, sizeof(*out));

#define RET_NUM(field)  do { out->kind = LSDN_PROPERTY_NUMBER; out->number_value = (double)(field); return 1; } while(0)
#define RET_BOOL(field) do { out->kind = LSDN_PROPERTY_BOOL;   out->bool_value   = (field) ? 1 : 0; return 1; } while(0)
#define RET_STR(field)  do { out->kind = LSDN_PROPERTY_STRING; out->string_value  = (field); return 1; } while(0)

    switch (s->kind) {
        case KIND_LDR:
            if (!strcmp(name,"lux"))     RET_NUM(s->lux);
            if (!strcmp(name,"min_lux")) RET_NUM(s->min_lux);
            if (!strcmp(name,"max_lux")) RET_NUM(s->max_lux);
            if (!strcmp(name,"gamma"))   RET_NUM(s->gamma);
            if (!strcmp(name,"r1"))      RET_NUM(s->r1);
            break;
        case KIND_THERMISTOR:
            if (!strcmp(name,"temp"))     RET_NUM(s->therm_temp);
            if (!strcmp(name,"min_temp")) RET_NUM(s->therm_min);
            if (!strcmp(name,"max_temp")) RET_NUM(s->therm_max);
            if (!strcmp(name,"b_coeff"))  RET_NUM(s->b_coeff);
            if (!strcmp(name,"r25"))      RET_NUM(s->r25);
            if (!strcmp(name,"ptc"))      RET_BOOL(s->ptc);
            break;
        case KIND_RTD:
            if (!strcmp(name,"temp"))     RET_NUM(s->rtd_temp);
            if (!strcmp(name,"min_temp")) RET_NUM(s->rtd_min);
            if (!strcmp(name,"max_temp")) RET_NUM(s->rtd_max);
            if (!strcmp(name,"r0"))       RET_NUM(s->r0_rtd);
            break;
        case KIND_STRAIN:
            if (!strcmp(name,"force_n"))   RET_NUM(s->force_n);
            if (!strcmp(name,"min_force")) RET_NUM(s->min_force);
            if (!strcmp(name,"max_force")) RET_NUM(s->max_force);
            if (!strcmp(name,"gf"))        RET_NUM(s->gf);
            if (!strcmp(name,"r0"))        RET_NUM(s->r0_sg);
            break;
        case KIND_SR04:
            if (!strcmp(name,"distance_m")) RET_NUM(s->distance_m);
            if (!strcmp(name,"use_analog")) RET_BOOL(s->use_analog);
            break;
        case KIND_DHT22:
            if (!strcmp(name,"model"))    RET_NUM(s->dht_model);
            if (!strcmp(name,"temp"))     RET_NUM(s->dht_temp);
            if (!strcmp(name,"humi"))     RET_NUM(s->dht_humi);
            if (!strcmp(name,"temp_inc")) RET_NUM(s->dht_temp_inc);
            if (!strcmp(name,"humi_inc")) RET_NUM(s->dht_humi_inc);
            break;
        case KIND_DS1621:
            if (!strcmp(name,"temp")) RET_NUM(s->ds1621_temp);
            if (!strcmp(name,"th"))   RET_NUM(s->ds1621_th);
            if (!strcmp(name,"tl"))   RET_NUM(s->ds1621_tl);
            break;
        case KIND_DS18B20:
            if (!strcmp(name,"rom"))  RET_STR(s->rom_hex);
            if (!strcmp(name,"temp")) RET_NUM(s->ds18b20_temp);
            break;
        default: break;
    }
#undef RET_NUM
#undef RET_BOOL
#undef RET_STR
    return 0;
}

static uint32_t sens_set_property(LsdnDevice *dev, const char *name, const LsdnPropertyValue *val) {
    SensorState *s = (SensorState *)dev;
    if (!name || !val) return 0;
    double n = val->number_value;
    int    b = val->bool_value;

    switch (s->kind) {
        case KIND_LDR:
            if (!strcmp(name,"lux"))     { s->lux     = n; return 1; }
            if (!strcmp(name,"min_lux")) { s->min_lux = n; return 1; }
            if (!strcmp(name,"max_lux")) { s->max_lux = n; return 1; }
            if (!strcmp(name,"gamma"))   { s->gamma   = n; return 1; }
            if (!strcmp(name,"r1"))      { s->r1      = n; return 1; }
            break;
        case KIND_THERMISTOR:
            if (!strcmp(name,"temp"))     { s->therm_temp = n; return 1; }
            if (!strcmp(name,"min_temp")) { s->therm_min  = n; return 1; }
            if (!strcmp(name,"max_temp")) { s->therm_max  = n; return 1; }
            if (!strcmp(name,"b_coeff"))  { s->b_coeff    = n; return 1; }
            if (!strcmp(name,"r25"))      { s->r25        = n; return 1; }
            if (!strcmp(name,"ptc"))      { s->ptc        = b; return 1; }
            break;
        case KIND_RTD:
            if (!strcmp(name,"temp"))     { s->rtd_temp = n; return 1; }
            if (!strcmp(name,"min_temp")) { s->rtd_min  = n; return 1; }
            if (!strcmp(name,"max_temp")) { s->rtd_max  = n; return 1; }
            if (!strcmp(name,"r0"))       { s->r0_rtd = n; return 1; }
            break;
        case KIND_STRAIN:
            if (!strcmp(name,"force_n"))   { s->force_n   = n; return 1; }
            if (!strcmp(name,"min_force")) { s->min_force = n; return 1; }
            if (!strcmp(name,"max_force")) { s->max_force = n; return 1; }
            if (!strcmp(name,"gf"))        { s->gf        = n; return 1; }
            if (!strcmp(name,"r0"))        { s->r0_sg     = n; return 1; }
            break;
        case KIND_SR04:
            if (!strcmp(name,"distance_m")) { s->distance_m = n; return 1; }
            if (!strcmp(name,"use_analog")) { s->use_analog  = b; return 1; }
            break;
        case KIND_DHT22:
            if (!strcmp(name,"model"))    { s->dht_model    = (int)n; return 1; }
            if (!strcmp(name,"temp"))     { s->dht_temp     = n; return 1; }
            if (!strcmp(name,"humi"))     { s->dht_humi     = n; return 1; }
            if (!strcmp(name,"temp_inc")) { s->dht_temp_inc = n; return 1; }
            if (!strcmp(name,"humi_inc")) { s->dht_humi_inc = n; return 1; }
            break;
        case KIND_DS1621:
            if (!strcmp(name,"temp")) { s->ds1621_temp = n; return 1; }
            if (!strcmp(name,"th"))   { s->ds1621_th   = n; return 1; }
            if (!strcmp(name,"tl"))   { s->ds1621_tl   = n; return 1; }
            break;
        case KIND_DS18B20:
            if (!strcmp(name,"rom")) {
                if (val->kind == LSDN_PROPERTY_STRING && val->string_value)
                    strncpy(s->rom_hex, val->string_value, 16);
                return 1;
            }
            if (!strcmp(name,"temp")) { s->ds18b20_temp = n; return 1; }
            break;
        default: break;
    }
    return 0;
}

#define STATE_VERSION 1u

static uint32_t sens_get_state(LsdnDevice *dev, uint8_t *out, uint32_t cap) {
    SensorState *s = (SensorState *)dev;
    uint32_t need = sizeof(uint32_t) + sizeof(SensorState);
    if (!out || cap < need) return need;
    uint32_t ver = STATE_VERSION;
    memcpy(out, &ver, sizeof(ver));
    memcpy(out + sizeof(ver), s, sizeof(SensorState));
    return need;
}

static void sens_set_state(LsdnDevice *dev, const uint8_t *in, uint32_t len) {
    SensorState *s = (SensorState *)dev;
    if (!in || len < sizeof(uint32_t)) return;
    uint32_t ver;
    memcpy(&ver, in, sizeof(ver));
    if (ver != STATE_VERSION) return;
    if (len < sizeof(uint32_t) + sizeof(SensorState)) return;
    int kind               = s->kind;
    void *host_ctx         = s->host_ctx;
    const LsdnHostApi *api = s->api;
    memcpy(s, in + sizeof(uint32_t), sizeof(SensorState));
    s->kind     = kind;
    s->host_ctx = host_ctx;
    s->api      = api;
}

static void sens_destroy(LsdnDevice *dev) { free(dev); }

static const LsdnDeviceVTable kVTable = {
    sens_create, sens_init, sens_stamp, sens_post_step,
    sens_on_event, sens_get_property, sens_set_property,
    sens_get_state, sens_set_state, sens_destroy
};

LSDN_EXPORT
const LsdnDeviceVTable *lsdn_get_vtable(uint32_t *abi_major, uint32_t *abi_minor) {
    *abi_major = LSDN_ABI_VERSION_MAJOR;
    *abi_minor = LSDN_ABI_VERSION_MINOR;
    return &kVTable;
}

#include "lasecsimul/device_abi.h"
#include <stdint.h>

/* MinGW on Windows: replace CRT so ucrtbase.dll is never loaded alongside ucrtbased.dll.
 * MSVC builds use the normal CRT (matching the Core), no action needed. */
#if defined(_WIN32) && !defined(_MSC_VER)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

BOOL WINAPI DllMainCRTStartup(HINSTANCE h, DWORD r, LPVOID p) {
    (void)h; (void)r; (void)p; return TRUE;
}

static void *_lsdn_calloc(size_t n) {
    return HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, n);
}
static void _lsdn_free(void *p) {
    if (p) HeapFree(GetProcessHeap(), 0, p);
}

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

#define calloc(n, sz)    _lsdn_calloc((size_t)(n) * (size_t)(sz))
#define free(p)          _lsdn_free(p)
#define strcmp(a, b)     _lsdn_strcmp(a, b)
#define strncpy(d, s, n) _lsdn_strncpy(d, s, n)
#define strstr(h, nd)    _lsdn_strstr(h, nd)

#else  /* MSVC or non-Windows: use normal CRT */
#include <string.h>
#include <stdlib.h>
#endif

enum {
    KIND_KY023      = 0,
    KIND_KY040      = 1,
    KIND_TOUCHPAD   = 2,
    KIND_DS1307     = 3,
    KIND_SERIALTERM = 4,
    KIND_SERIALPORT = 5,
    KIND_SDCARD     = 6,
    KIND_ESP01      = 7,
};

typedef struct {
    void *host_ctx;
    const LsdnHostApi *api;
    int kind;

    /* KY-023 */
    int joy_x, joy_y, joy_sw;

    /* KY-040 */
    int32_t enc_pos;
    int     enc_steps_rev, enc_sw, enc_clk_prev;

    /* TouchPad */
    int    tp_width, tp_height;
    int    tp_touch_x, tp_touch_y;
    int    tp_pressed, tp_transparent;
    double tp_rx_min, tp_rx_max;
    double tp_ry_min, tp_ry_max;

    /* DS1307 — BCD time registers [0]=sec [1]=min [2]=hr [3]=dow [4]=date [5]=mon [6]=yr */
    uint8_t rtc_regs[8];
    uint8_t rtc_ptr;
    int     rtc_i2c_addr;
    int     rtc_i2c_state;
    int     rtc_time_updated;
    int     rtc_sqw_freq;
    /* raw user fields */
    int rtc_year, rtc_month, rtc_day;
    int rtc_hour, rtc_min, rtc_sec;

    /* Serial Terminal */
    uint32_t ser_baudrate;
    uint32_t ser_bit_period_ns;
    int      ser_data_bits, ser_stop_bits;
    char     ser_rx_buf[256];
    char     ser_tx_buf[256];
    int      ser_tx_pos;
    int      ser_rx_active, ser_rx_bit_idx;
    uint8_t  ser_rx_byte;

    /* Serial Port */
    char     port_name[64];
    uint32_t port_baudrate;
    int      port_data_bits, port_stop_bits;
    int      port_auto_open;

    /* SD Card */
    char sd_file[256];

    /* ESP-01 */
    uint32_t esp_baudrate;
    int      esp_debug;
    char     esp_at_buf[256];
    int      esp_at_pos, esp_rx_active, esp_rx_bit_idx;
    uint8_t  esp_rx_byte;
} PeriphState;

/* ------------------------------------------------------------------ */
/*  Config helpers                                                      */
/* ------------------------------------------------------------------ */
static const char *cfg_str(PeriphState *s, const char *name, const char *fallback) {
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

static double cfg_num(PeriphState *s, const char *name, double fallback) {
    LsdnPropertyValue v;
    memset(&v, 0, sizeof(v));
    if (s->api->config_get && s->api->config_get(s->host_ctx, name, &v)
            && v.kind == LSDN_PROPERTY_NUMBER)
        return v.number_value;
    return fallback;
}

/* ------------------------------------------------------------------ */
/*  BCD helpers                                                         */
/* ------------------------------------------------------------------ */
static uint8_t to_bcd(int v) { return (uint8_t)(((v / 10) << 4) | (v % 10)); }
static int     from_bcd(uint8_t b) { return ((b >> 4) * 10) + (b & 0x0F); }

static void rtc_load_regs(PeriphState *s) {
    int yr = s->rtc_year % 100;
    s->rtc_regs[0] = to_bcd(s->rtc_sec   & 0x3F);  /* CH bit cleared = clock running */
    s->rtc_regs[1] = to_bcd(s->rtc_min   & 0x3F);
    s->rtc_regs[2] = to_bcd(s->rtc_hour  & 0x3F);  /* 24h mode */
    s->rtc_regs[3] = 1;                              /* day-of-week = Monday */
    s->rtc_regs[4] = to_bcd(s->rtc_day   & 0x3F);
    s->rtc_regs[5] = to_bcd(s->rtc_month & 0x1F);
    s->rtc_regs[6] = to_bcd(yr & 0xFF);
    s->rtc_regs[7] = 0x10; /* 1Hz SQW */
}

static void rtc_tick(PeriphState *s) {
    s->rtc_sec++;
    if (s->rtc_sec >= 60) { s->rtc_sec = 0; s->rtc_min++; }
    if (s->rtc_min >= 60) { s->rtc_min = 0; s->rtc_hour++; }
    if (s->rtc_hour >= 24){ s->rtc_hour = 0; s->rtc_day++; }
    /* Simplified: no month-end rollover */
    if (s->rtc_day > 31)  { s->rtc_day = 1; s->rtc_month++; }
    if (s->rtc_month > 12){ s->rtc_month = 1; s->rtc_year++; }
    rtc_load_regs(s);
}

/* ------------------------------------------------------------------ */
/*  KY-040 quadrature output                                            */
/* ------------------------------------------------------------------ */
static void enc_update(PeriphState *s) {
    int steps = s->enc_steps_rev > 0 ? s->enc_steps_rev : 1;
    int phase = ((s->enc_pos % steps) + steps) % 4;
    int clk   = (phase == 0 || phase == 1) ? 1 : 0;
    int dt    = (phase == 0 || phase == 3) ? 1 : 0;
    /* SimulIDE pin order: SW=0, DT=1, CLK=2 */
    s->api->pin_write(s->host_ctx, 2, clk);
    s->api->pin_write(s->host_ctx, 1, dt);
    s->api->pin_write(s->host_ctx, 0, s->enc_sw ? 0 : 1);
}

/* ------------------------------------------------------------------ */
/*  VTable                                                              */
/* ------------------------------------------------------------------ */
static LsdnDevice *periph_create(void *host_ctx, const LsdnHostApi *api) {
    PeriphState *s = (PeriphState *)calloc(1, sizeof(PeriphState));
    if (!s) return NULL;
    s->host_ctx = host_ctx;
    s->api      = api;
    return (LsdnDevice *)s;
}

static void periph_init(LsdnDevice *dev) {
    PeriphState *s = (PeriphState *)dev;

    const char *tid = cfg_str(s, "__typeId", "peripherals.ky023");
    if      (strstr(tid, "ky023"))      s->kind = KIND_KY023;
    else if (strstr(tid, "ky040"))      s->kind = KIND_KY040;
    else if (strstr(tid, "touchpad"))   s->kind = KIND_TOUCHPAD;
    else if (strstr(tid, "ds1307"))     s->kind = KIND_DS1307;
    else if (strstr(tid, "serialterm")) s->kind = KIND_SERIALTERM;
    else if (strstr(tid, "serialport")) s->kind = KIND_SERIALPORT;
    else if (strstr(tid, "sdcard"))     s->kind = KIND_SDCARD;
    else if (strstr(tid, "esp01"))      s->kind = KIND_ESP01;

    s->joy_x  = (int)cfg_num(s, "x_pos",      512.0);
    s->joy_y  = (int)cfg_num(s, "y_pos",       512.0);
    s->joy_sw = (int)cfg_num(s, "sw_pressed",  0.0);

    s->enc_steps_rev = (int)cfg_num(s, "steps_rev", 20.0);
    s->enc_pos       = (int32_t)cfg_num(s, "position", 0.0);

    s->tp_width       = (int)cfg_num(s, "width",       240.0);
    s->tp_height      = (int)cfg_num(s, "height",      320.0);
    s->tp_touch_x     = (int)cfg_num(s, "touch_x",     120.0);
    s->tp_touch_y     = (int)cfg_num(s, "touch_y",     160.0);
    s->tp_pressed     = (int)cfg_num(s, "pressed",     0.0);
    s->tp_transparent = (int)cfg_num(s, "transparent", 0.0);
    s->tp_rx_min      = cfg_num(s, "rx_min", 100.0);
    s->tp_rx_max      = cfg_num(s, "rx_max", 500.0);
    s->tp_ry_min      = cfg_num(s, "ry_min", 100.0);
    s->tp_ry_max      = cfg_num(s, "ry_max", 500.0);

    s->rtc_year  = (int)cfg_num(s, "year",   2024.0);
    s->rtc_month = (int)cfg_num(s, "month",  1.0);
    s->rtc_day   = (int)cfg_num(s, "day",    1.0);
    s->rtc_hour  = (int)cfg_num(s, "hour",   0.0);
    s->rtc_min   = (int)cfg_num(s, "minute", 0.0);
    s->rtc_sec   = (int)cfg_num(s, "second", 0.0);
    s->rtc_sqw_freq = (int)cfg_num(s, "sqw_freq", 1.0);
    rtc_load_regs(s);

    s->ser_baudrate      = (uint32_t)cfg_num(s, "baudrate",  9600.0);
    s->ser_bit_period_ns = s->ser_baudrate > 0 ? 1000000000u / s->ser_baudrate : 104167u;
    s->ser_data_bits     = (int)cfg_num(s, "data_bits", 8.0);
    s->ser_stop_bits     = (int)cfg_num(s, "stop_bits", 1.0);

    strncpy(s->port_name, cfg_str(s, "port_name", "COM1"), sizeof(s->port_name) - 1);
    s->port_baudrate  = (uint32_t)cfg_num(s, "baudrate",   9600.0);
    s->port_data_bits = (int)cfg_num(s, "data_bits", 8.0);
    s->port_stop_bits = (int)cfg_num(s, "stop_bits", 1.0);
    s->port_auto_open = (int)cfg_num(s, "auto_open", 1.0);

    strncpy(s->sd_file, cfg_str(s, "file", ""), sizeof(s->sd_file) - 1);

    s->esp_baudrate = (uint32_t)cfg_num(s, "baudrate", 115200.0);
    s->esp_debug    = (int)cfg_num(s, "debug", 0.0);

    if (s->kind == KIND_DS1307)
        s->api->schedule_event(s->host_ctx, 1000000000u, 10u);
}

static void periph_stamp(LsdnDevice *dev, LsdnMatrixView *m) {
    PeriphState *s = (PeriphState *)dev;
    if (!m) return;

    switch (s->kind) {
        case KIND_KY023: {
            /* SimulIDE pin order: VRX=0, VRY=1, SW=2 */
            double vcc = 5.0;
            double vx  = (s->joy_x / 1023.0) * vcc;
            double vy  = (s->joy_y / 1023.0) * vcc;
            double vsw = s->joy_sw ? 0.0 : vcc;
            double G   = 1e6;
            m->add_conductance_to_ground(m->opaque, 0, G);
            m->add_current_to_ground(m->opaque, 0, vx  * G);
            m->add_conductance_to_ground(m->opaque, 1, G);
            m->add_current_to_ground(m->opaque, 1, vy  * G);
            m->add_conductance_to_ground(m->opaque, 2, G);
            m->add_current_to_ground(m->opaque, 2, vsw * G);
            break;
        }
        case KIND_TOUCHPAD: {
            /*
             * 4-wire resistive model:
             * pins: XP=0, XM=1, YP=2, YM=3
             * When pressed, X position appears on YP (pin2) and Y position on XM (pin1)
             * using Thevenin equivalent with Rx/Ry resistances.
             */
            if (s->tp_pressed) {
                double w   = s->tp_width  > 0 ? (double)s->tp_width  : 1.0;
                double h   = s->tp_height > 0 ? (double)s->tp_height : 1.0;
                double vcc = 5.0;
                /* X measurement: XP=VCC, XM=GND → voltage divider on Y axis */
                double rx  = s->tp_rx_min + (s->tp_rx_max - s->tp_rx_min) * (s->tp_touch_x / w);
                double ry  = s->tp_ry_min + (s->tp_ry_max - s->tp_ry_min) * (s->tp_touch_y / h);
                double vx  = vcc * rx / (s->tp_rx_max > 0.0 ? s->tp_rx_max : 1.0);
                double vy  = vcc * ry / (s->tp_ry_max > 0.0 ? s->tp_ry_max : 1.0);
                double G   = 1e6;
                /* YP output = X position voltage */
                m->add_conductance_to_ground(m->opaque, 2, G);
                m->add_current_to_ground(m->opaque, 2, vx * G);
                /* XM output = Y position voltage */
                m->add_conductance_to_ground(m->opaque, 1, G);
                m->add_current_to_ground(m->opaque, 1, vy * G);
            }
            break;
        }
        default:
            break;
    }
}

static void periph_post_step(LsdnDevice *dev, uint64_t dt_ns) {
    (void)dev; (void)dt_ns;
}

static void periph_on_event(LsdnDevice *dev, const LsdnEvent *ev) {
    PeriphState *s = (PeriphState *)dev;
    if (!ev) return;

    if (ev->tag == LSDN_EVT_PIN_CHANGE) {
        switch (s->kind) {
            case KIND_KY040:
                /* SimulIDE pin order: SW=0, DT=1, CLK=2 */
                if (ev->a == 2) {
                    int clk_now = (int)ev->b;
                    if (clk_now && !s->enc_clk_prev) {
                        int dt_level = s->api->pin_read(s->host_ctx, 1);
                        if (dt_level) s->enc_pos--;
                        else          s->enc_pos++;
                        enc_update(s);
                    }
                    s->enc_clk_prev = clk_now;
                }
                break;
            case KIND_SERIALTERM:
                /* RX = pin 1; detect start bit (high→low) */
                if (ev->a == 1 && ev->b == 0 && !s->ser_rx_active) {
                    s->ser_rx_active  = 1;
                    s->ser_rx_bit_idx = 0;
                    s->ser_rx_byte    = 0;
                    s->api->schedule_event(s->host_ctx,
                        (uint64_t)(s->ser_bit_period_ns * 3 / 2), 20u);
                }
                break;
            case KIND_ESP01:
                /* RX = pin 1 */
                if (ev->a == 1 && ev->b == 0 && !s->esp_rx_active) {
                    uint64_t period_ns = s->esp_baudrate > 0 ? 1000000000u / s->esp_baudrate : 8681u;
                    s->esp_rx_active  = 1;
                    s->esp_rx_bit_idx = 0;
                    s->esp_rx_byte    = 0;
                    s->api->schedule_event(s->host_ctx, period_ns * 3 / 2, 30u);
                }
                break;
            default:
                break;
        }
    } else if (ev->tag == LSDN_EVT_TIMER) {
        uint32_t id = ev->a;
        switch (s->kind) {
            case KIND_DS1307:
                if (id == 10u) {
                    rtc_tick(s);
                    s->api->schedule_event(s->host_ctx, 1000000000u, 10u);
                    /* Toggle SQW at 1Hz */
                    int sqw = (s->rtc_sec & 1);
                    s->api->pin_write(s->host_ctx, 2, sqw);
                }
                break;
            case KIND_SERIALTERM:
                if (id == 20u) {
                    int data_bits = s->ser_data_bits > 0 ? s->ser_data_bits : 8;
                    if (s->ser_rx_bit_idx < data_bits) {
                        int bit = s->api->pin_read(s->host_ctx, 1);
                        if (bit) s->ser_rx_byte |= (1u << (unsigned)s->ser_rx_bit_idx);
                        s->ser_rx_bit_idx++;
                        s->api->schedule_event(s->host_ctx, s->ser_bit_period_ns, 20u);
                    } else {
                        int pos = s->ser_tx_pos;
                        if (pos < 255) {
                            s->ser_tx_buf[pos]   = (char)s->ser_rx_byte;
                            s->ser_tx_buf[pos+1] = '\0';
                            s->ser_tx_pos = pos + 1;
                        }
                        s->ser_rx_active  = 0;
                        s->ser_rx_bit_idx = 0;
                    }
                }
                break;
            case KIND_ESP01:
                if (id == 30u) {
                    if (s->esp_rx_bit_idx < 8) {
                        int bit = s->api->pin_read(s->host_ctx, 1);
                        if (bit) s->esp_rx_byte |= (1u << (unsigned)s->esp_rx_bit_idx);
                        s->esp_rx_bit_idx++;
                        uint64_t period_ns = s->esp_baudrate > 0 ? 1000000000u / s->esp_baudrate : 8681u;
                        s->api->schedule_event(s->host_ctx, period_ns, 30u);
                    } else {
                        int pos = s->esp_at_pos;
                        if (pos < 255) {
                            s->esp_at_buf[pos]   = (char)s->esp_rx_byte;
                            s->esp_at_buf[pos+1] = '\0';
                            s->esp_at_pos = pos + 1;
                        }
                        s->esp_rx_active  = 0;
                        s->esp_rx_bit_idx = 0;
                        if (s->esp_at_pos >= 4 && s->esp_at_buf[s->esp_at_pos-1] == '\n'
                                && s->esp_at_buf[s->esp_at_pos-2] == '\r') {
                            s->esp_at_pos = 0;
                        }
                    }
                }
                break;
            default:
                break;
        }
    }
}

static uint32_t periph_get_property(LsdnDevice *dev, const char *name, LsdnPropertyValue *out) {
    PeriphState *s = (PeriphState *)dev;
    if (!name || !out) return 0;
    memset(out, 0, sizeof(*out));

#define RET_NUM(field)  do { out->kind = LSDN_PROPERTY_NUMBER; out->number_value = (double)(field); return 1; } while(0)
#define RET_BOOL(field) do { out->kind = LSDN_PROPERTY_BOOL;   out->bool_value   = (field) ? 1 : 0; return 1; } while(0)
#define RET_STR(field)  do { out->kind = LSDN_PROPERTY_STRING; out->string_value  = (field); return 1; } while(0)

    switch (s->kind) {
        case KIND_KY023:
            if (!strcmp(name,"x_pos"))      RET_NUM(s->joy_x);
            if (!strcmp(name,"y_pos"))      RET_NUM(s->joy_y);
            if (!strcmp(name,"sw_pressed")) RET_BOOL(s->joy_sw);
            break;
        case KIND_KY040:
            if (!strcmp(name,"position"))   RET_NUM(s->enc_pos);
            if (!strcmp(name,"steps_rev"))  RET_NUM(s->enc_steps_rev);
            if (!strcmp(name,"sw_pressed")) RET_BOOL(s->enc_sw);
            break;
        case KIND_TOUCHPAD:
            if (!strcmp(name,"width"))       RET_NUM(s->tp_width);
            if (!strcmp(name,"height"))      RET_NUM(s->tp_height);
            if (!strcmp(name,"touch_x"))    RET_NUM(s->tp_touch_x);
            if (!strcmp(name,"touch_y"))    RET_NUM(s->tp_touch_y);
            if (!strcmp(name,"pressed"))    RET_BOOL(s->tp_pressed);
            if (!strcmp(name,"transparent"))RET_BOOL(s->tp_transparent);
            if (!strcmp(name,"rx_min"))     RET_NUM(s->tp_rx_min);
            if (!strcmp(name,"rx_max"))     RET_NUM(s->tp_rx_max);
            if (!strcmp(name,"ry_min"))     RET_NUM(s->tp_ry_min);
            if (!strcmp(name,"ry_max"))     RET_NUM(s->tp_ry_max);
            break;
        case KIND_DS1307:
            if (!strcmp(name,"year"))         RET_NUM(s->rtc_year);
            if (!strcmp(name,"month"))        RET_NUM(s->rtc_month);
            if (!strcmp(name,"day"))          RET_NUM(s->rtc_day);
            if (!strcmp(name,"hour"))         RET_NUM(s->rtc_hour);
            if (!strcmp(name,"minute"))       RET_NUM(s->rtc_min);
            if (!strcmp(name,"second"))       RET_NUM(s->rtc_sec);
            if (!strcmp(name,"sqw_freq"))     RET_NUM(s->rtc_sqw_freq);
            if (!strcmp(name,"time_updated")) RET_BOOL(s->rtc_time_updated);
            break;
        case KIND_SERIALTERM:
            if (!strcmp(name,"baudrate"))  RET_NUM(s->ser_baudrate);
            if (!strcmp(name,"data_bits")) RET_NUM(s->ser_data_bits);
            if (!strcmp(name,"stop_bits")) RET_NUM(s->ser_stop_bits);
            if (!strcmp(name,"rx_buffer")) RET_STR(s->ser_rx_buf);
            if (!strcmp(name,"tx_bytes"))  RET_STR(s->ser_tx_buf);
            break;
        case KIND_SERIALPORT:
            if (!strcmp(name,"port_name")) RET_STR(s->port_name);
            if (!strcmp(name,"baudrate"))  RET_NUM(s->port_baudrate);
            if (!strcmp(name,"data_bits")) RET_NUM(s->port_data_bits);
            if (!strcmp(name,"stop_bits")) RET_NUM(s->port_stop_bits);
            if (!strcmp(name,"auto_open")) RET_BOOL(s->port_auto_open);
            break;
        case KIND_SDCARD:
            if (!strcmp(name,"file")) RET_STR(s->sd_file);
            break;
        case KIND_ESP01:
            if (!strcmp(name,"baudrate")) RET_NUM(s->esp_baudrate);
            if (!strcmp(name,"debug"))    RET_BOOL(s->esp_debug);
            break;
        default: break;
    }
#undef RET_NUM
#undef RET_BOOL
#undef RET_STR
    return 0;
}

static uint32_t periph_set_property(LsdnDevice *dev, const char *name, const LsdnPropertyValue *val) {
    PeriphState *s = (PeriphState *)dev;
    if (!name || !val) return 0;
    double n = val->number_value;
    int    b = val->bool_value;

    switch (s->kind) {
        case KIND_KY023:
            if (!strcmp(name,"x_pos"))      { s->joy_x  = (int)n; if (s->joy_x<0) s->joy_x=0; if (s->joy_x>1023) s->joy_x=1023; return 1; }
            if (!strcmp(name,"y_pos"))      { s->joy_y  = (int)n; if (s->joy_y<0) s->joy_y=0; if (s->joy_y>1023) s->joy_y=1023; return 1; }
            if (!strcmp(name,"sw_pressed")) { s->joy_sw = b; return 1; }
            break;
        case KIND_KY040:
            if (!strcmp(name,"position"))   { s->enc_pos = (int32_t)n; enc_update(s); return 1; }
            if (!strcmp(name,"steps_rev"))  { s->enc_steps_rev = (int)n > 0 ? (int)n : 1; return 1; }
            if (!strcmp(name,"sw_pressed")) { s->enc_sw = b; enc_update(s); return 1; }
            break;
        case KIND_TOUCHPAD:
            if (!strcmp(name,"width"))       { s->tp_width   = (int)n>0?(int)n:1; return 1; }
            if (!strcmp(name,"height"))      { s->tp_height  = (int)n>0?(int)n:1; return 1; }
            if (!strcmp(name,"touch_x"))    { s->tp_touch_x = (int)n; return 1; }
            if (!strcmp(name,"touch_y"))    { s->tp_touch_y = (int)n; return 1; }
            if (!strcmp(name,"pressed"))    { s->tp_pressed    = b; return 1; }
            if (!strcmp(name,"transparent")){ s->tp_transparent = b; return 1; }
            if (!strcmp(name,"rx_min"))     { s->tp_rx_min = n; return 1; }
            if (!strcmp(name,"rx_max"))     { s->tp_rx_max = n; return 1; }
            if (!strcmp(name,"ry_min"))     { s->tp_ry_min = n; return 1; }
            if (!strcmp(name,"ry_max"))     { s->tp_ry_max = n; return 1; }
            break;
        case KIND_DS1307:
            if (!strcmp(name,"year"))         { s->rtc_year  = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"month"))        { s->rtc_month = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"day"))          { s->rtc_day   = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"hour"))         { s->rtc_hour  = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"minute"))       { s->rtc_min   = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"second"))       { s->rtc_sec   = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"sqw_freq"))     { s->rtc_sqw_freq = (int)n; return 1; }
            if (!strcmp(name,"time_updated")) { s->rtc_time_updated = b; return 1; }
            break;
        case KIND_SERIALTERM:
            if (!strcmp(name,"baudrate")) {
                s->ser_baudrate      = (uint32_t)n;
                s->ser_bit_period_ns = s->ser_baudrate > 0 ? 1000000000u / s->ser_baudrate : 104167u;
                return 1;
            }
            if (!strcmp(name,"data_bits")) { s->ser_data_bits = (int)n; return 1; }
            if (!strcmp(name,"stop_bits")) { s->ser_stop_bits = (int)n; return 1; }
            if (!strcmp(name,"rx_buffer") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                strncpy(s->ser_rx_buf, val->string_value, sizeof(s->ser_rx_buf)-1); return 1;
            }
            break;
        case KIND_SERIALPORT:
            if (!strcmp(name,"port_name") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                strncpy(s->port_name, val->string_value, sizeof(s->port_name)-1); return 1;
            }
            if (!strcmp(name,"baudrate"))  { s->port_baudrate  = (uint32_t)n; return 1; }
            if (!strcmp(name,"data_bits")) { s->port_data_bits = (int)n;      return 1; }
            if (!strcmp(name,"stop_bits")) { s->port_stop_bits = (int)n;      return 1; }
            if (!strcmp(name,"auto_open")) { s->port_auto_open = b;            return 1; }
            break;
        case KIND_SDCARD:
            if (!strcmp(name,"file") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                strncpy(s->sd_file, val->string_value, sizeof(s->sd_file)-1); return 1;
            }
            break;
        case KIND_ESP01:
            if (!strcmp(name,"baudrate")) { s->esp_baudrate = (uint32_t)n; return 1; }
            if (!strcmp(name,"debug"))    { s->esp_debug    = b;            return 1; }
            break;
        default: break;
    }
    return 0;
}

#define STATE_VERSION 1u

static uint32_t periph_get_state(LsdnDevice *dev, uint8_t *out, uint32_t cap) {
    PeriphState *s = (PeriphState *)dev;
    uint32_t need = sizeof(uint32_t) + sizeof(PeriphState);
    if (!out || cap < need) return need;
    uint32_t ver = STATE_VERSION;
    memcpy(out, &ver, sizeof(ver));
    memcpy(out + sizeof(ver), s, sizeof(PeriphState));
    return need;
}

static void periph_set_state(LsdnDevice *dev, const uint8_t *in, uint32_t len) {
    PeriphState *s = (PeriphState *)dev;
    if (!in || len < sizeof(uint32_t)) return;
    uint32_t ver;
    memcpy(&ver, in, sizeof(ver));
    if (ver != STATE_VERSION) return;
    if (len < sizeof(uint32_t) + sizeof(PeriphState)) return;
    int kind               = s->kind;
    void *host_ctx         = s->host_ctx;
    const LsdnHostApi *api = s->api;
    memcpy(s, in + sizeof(uint32_t), sizeof(PeriphState));
    s->kind     = kind;
    s->host_ctx = host_ctx;
    s->api      = api;
}

static void periph_destroy(LsdnDevice *dev) { free(dev); }

static const LsdnDeviceVTable kVTable = {
    periph_create, periph_init, periph_stamp, periph_post_step,
    periph_on_event, periph_get_property, periph_set_property,
    periph_get_state, periph_set_state, periph_destroy
};

LSDN_EXPORT
const LsdnDeviceVTable *lsdn_get_vtable(uint32_t *abi_major, uint32_t *abi_minor) {
    *abi_major = LSDN_ABI_VERSION_MAJOR;
    *abi_minor = LSDN_ABI_VERSION_MINOR;
    return &kVTable;
}

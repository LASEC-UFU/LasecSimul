#include "lasecsimul/device_abi.h"
#include <string.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>

/* ------------------------------------------------------------------ */
/*  Kind constants                                                      */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/*  State                                                               */
/* ------------------------------------------------------------------ */
typedef struct {
    void *host_ctx;
    const LsdnHostApi *api;
    int kind;

    /* KY-023 */
    int joy_x;
    int joy_y;
    int joy_sw;

    /* KY-040 */
    int32_t enc_pos;
    int     enc_steps_rev;
    int     enc_sw;
    int     enc_clk_prev;

    /* TouchPad */
    int tp_width;
    int tp_height;
    int tp_touch_x;
    int tp_touch_y;
    int tp_pressed;

    /* DS1307 */
    char rtc_time_str[32];

    /* Serial Terminal */
    uint32_t ser_baudrate;
    uint32_t ser_bit_period_ns;
    char     ser_rx_buf[256];
    char     ser_tx_buf[256];
    int      ser_tx_pos;
    int      ser_rx_active;
    int      ser_rx_bit_idx;
    uint8_t  ser_rx_byte;

    /* Serial Port */
    char     port_name[64];
    uint32_t port_baudrate;
    int      port_auto_open;

    /* SD Card */
    char sd_file[256];

    /* ESP-01 */
    uint32_t esp_baudrate;
    int      esp_debug;
    char     esp_at_buf[256];
    int      esp_at_pos;
    int      esp_rx_active;
    int      esp_rx_bit_idx;
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
/*  Encoder quadrature output                                           */
/* ------------------------------------------------------------------ */
static void enc_update(PeriphState *s) {
    int steps = s->enc_steps_rev > 0 ? s->enc_steps_rev : 1;
    int phase = ((s->enc_pos % steps) + steps) % 4;
    int clk   = (phase == 0 || phase == 1) ? 1 : 0;
    int dt    = (phase == 0 || phase == 3) ? 1 : 0;
    s->api->pin_write(s->host_ctx, 4, clk);
    s->api->pin_write(s->host_ctx, 3, dt);
    s->api->pin_write(s->host_ctx, 2, s->enc_sw ? 0 : 1);
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

    s->joy_x         = (int)cfg_num(s, "x_pos",      512.0);
    s->joy_y         = (int)cfg_num(s, "y_pos",       512.0);
    s->joy_sw        = (int)cfg_num(s, "sw_pressed",  0.0);

    s->enc_steps_rev = (int)cfg_num(s, "steps_rev",   20.0);
    s->enc_pos       = (int32_t)cfg_num(s, "position", 0.0);

    s->tp_width      = (int)cfg_num(s, "width",    240.0);
    s->tp_height     = (int)cfg_num(s, "height",   320.0);
    s->tp_touch_x    = (int)cfg_num(s, "touch_x",  120.0);
    s->tp_touch_y    = (int)cfg_num(s, "touch_y",  160.0);
    s->tp_pressed    = (int)cfg_num(s, "pressed",    0.0);

    strncpy(s->rtc_time_str, cfg_str(s, "set_time", "2024-01-01T00:00:00"),
            sizeof(s->rtc_time_str) - 1);

    s->ser_baudrate     = (uint32_t)cfg_num(s, "baudrate", 9600.0);
    s->ser_bit_period_ns = s->ser_baudrate > 0 ? 1000000000u / s->ser_baudrate : 104167u;

    strncpy(s->port_name, cfg_str(s, "port_name", "COM1"), sizeof(s->port_name) - 1);
    s->port_baudrate  = (uint32_t)cfg_num(s, "baudrate",  9600.0);
    s->port_auto_open = (int)cfg_num(s,      "auto_open", 1.0);

    strncpy(s->sd_file, cfg_str(s, "file", ""), sizeof(s->sd_file) - 1);

    s->esp_baudrate = (uint32_t)cfg_num(s, "baudrate", 115200.0);
    s->esp_debug    = (int)cfg_num(s, "debug", 0.0);

    /* Schedule 1-second tick for RTC */
    if (s->kind == KIND_DS1307)
        s->api->schedule_event(s->host_ctx, 1000000000u, 10u);
}

static void periph_stamp(LsdnDevice *dev, LsdnMatrixView *m) {
    PeriphState *s = (PeriphState *)dev;
    if (!m) return;

    switch (s->kind) {
        case KIND_KY023: {
            /* Joystick: VRX=pin2, VRY=pin3, SW=pin4; GND=pin0, +5V=pin1 */
            double vx  = (s->joy_x  / 1023.0) * 5.0;
            double vy  = (s->joy_y  / 1023.0) * 5.0;
            double vsw = s->joy_sw  ? 0.0 : 5.0;
            double G   = 1e6;
            m->add_conductance_to_ground(m->opaque, 2, G);
            m->add_current_to_ground(m->opaque, 2, vx  * G);
            m->add_conductance_to_ground(m->opaque, 3, G);
            m->add_current_to_ground(m->opaque, 3, vy  * G);
            m->add_conductance_to_ground(m->opaque, 4, G);
            m->add_current_to_ground(m->opaque, 4, vsw * G);
            break;
        }
        case KIND_TOUCHPAD: {
            if (s->tp_pressed) {
                double vx = ((double)s->tp_touch_x / (s->tp_width  > 0 ? s->tp_width  : 1)) * 5.0;
                double vy = ((double)s->tp_touch_y / (s->tp_height > 0 ? s->tp_height : 1)) * 5.0;
                double G  = 1e6;
                m->add_conductance_to_ground(m->opaque, 0, G);
                m->add_current_to_ground(m->opaque, 0, vx * G);
                m->add_conductance_to_ground(m->opaque, 2, G);
                m->add_current_to_ground(m->opaque, 2, vy * G);
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
                /* CLK = pin 4 */
                if (ev->a == 4) {
                    int clk_now = (int)ev->b;
                    if (clk_now && !s->enc_clk_prev) {
                        /* Rising CLK: DT low=CW, DT high=CCW */
                        int dt_level = s->api->pin_read(s->host_ctx, 3);
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
                    /* Sample first data bit after 1.5 bit periods */
                    s->api->schedule_event(s->host_ctx,
                        (uint64_t)(s->ser_bit_period_ns * 3 / 2), 20u);
                }
                break;
            case KIND_ESP01:
                /* RX = pin 1 */
                if (ev->a == 1 && ev->b == 0 && !s->esp_rx_active) {
                    s->esp_rx_active  = 1;
                    s->esp_rx_bit_idx = 0;
                    s->esp_rx_byte    = 0;
                    s->api->schedule_event(s->host_ctx,
                        (uint64_t)(1000000000u / s->esp_baudrate * 3 / 2), 30u);
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
                    /* Reschedule 1-second tick */
                    s->api->schedule_event(s->host_ctx, 1000000000u, 10u);
                }
                break;
            case KIND_SERIALTERM:
                if (id == 20u) {
                    if (s->ser_rx_bit_idx < 8) {
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
                        /* Detect AT command end and reply OK */
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
            if (!strcmp(name,"width"))   RET_NUM(s->tp_width);
            if (!strcmp(name,"height"))  RET_NUM(s->tp_height);
            if (!strcmp(name,"touch_x")) RET_NUM(s->tp_touch_x);
            if (!strcmp(name,"touch_y")) RET_NUM(s->tp_touch_y);
            if (!strcmp(name,"pressed")) RET_BOOL(s->tp_pressed);
            break;
        case KIND_DS1307:
            if (!strcmp(name,"set_time")) RET_STR(s->rtc_time_str);
            break;
        case KIND_SERIALTERM:
            if (!strcmp(name,"baudrate"))  RET_NUM(s->ser_baudrate);
            if (!strcmp(name,"rx_buffer")) RET_STR(s->ser_rx_buf);
            if (!strcmp(name,"tx_bytes"))  RET_STR(s->ser_tx_buf);
            break;
        case KIND_SERIALPORT:
            if (!strcmp(name,"port_name")) RET_STR(s->port_name);
            if (!strcmp(name,"baudrate"))  RET_NUM(s->port_baudrate);
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
            if (!strcmp(name,"x_pos"))      { s->joy_x  = (int)n; if (s->joy_x < 0) s->joy_x = 0; if (s->joy_x > 1023) s->joy_x = 1023; return 1; }
            if (!strcmp(name,"y_pos"))      { s->joy_y  = (int)n; if (s->joy_y < 0) s->joy_y = 0; if (s->joy_y > 1023) s->joy_y = 1023; return 1; }
            if (!strcmp(name,"sw_pressed")) { s->joy_sw = b; return 1; }
            break;
        case KIND_KY040:
            if (!strcmp(name,"position"))   { s->enc_pos = (int32_t)n; enc_update(s); return 1; }
            if (!strcmp(name,"steps_rev"))  { s->enc_steps_rev = (int)n > 0 ? (int)n : 1; return 1; }
            if (!strcmp(name,"sw_pressed")) { s->enc_sw = b; enc_update(s); return 1; }
            break;
        case KIND_TOUCHPAD:
            if (!strcmp(name,"width"))   { s->tp_width   = (int)n > 0 ? (int)n : 1; return 1; }
            if (!strcmp(name,"height"))  { s->tp_height  = (int)n > 0 ? (int)n : 1; return 1; }
            if (!strcmp(name,"touch_x")) { s->tp_touch_x = (int)n; return 1; }
            if (!strcmp(name,"touch_y")) { s->tp_touch_y = (int)n; return 1; }
            if (!strcmp(name,"pressed")) { s->tp_pressed  = b; return 1; }
            break;
        case KIND_DS1307:
            if (!strcmp(name,"set_time") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                strncpy(s->rtc_time_str, val->string_value, sizeof(s->rtc_time_str) - 1);
                return 1;
            }
            break;
        case KIND_SERIALTERM:
            if (!strcmp(name,"baudrate")) {
                s->ser_baudrate      = (uint32_t)n;
                s->ser_bit_period_ns = s->ser_baudrate > 0 ? 1000000000u / s->ser_baudrate : 104167u;
                return 1;
            }
            if (!strcmp(name,"rx_buffer") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                strncpy(s->ser_rx_buf, val->string_value, sizeof(s->ser_rx_buf) - 1);
                return 1;
            }
            break;
        case KIND_SERIALPORT:
            if (!strcmp(name,"port_name") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                strncpy(s->port_name, val->string_value, sizeof(s->port_name) - 1); return 1;
            }
            if (!strcmp(name,"baudrate"))  { s->port_baudrate  = (uint32_t)n; return 1; }
            if (!strcmp(name,"auto_open")) { s->port_auto_open = b;            return 1; }
            break;
        case KIND_SDCARD:
            if (!strcmp(name,"file") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                strncpy(s->sd_file, val->string_value, sizeof(s->sd_file) - 1); return 1;
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

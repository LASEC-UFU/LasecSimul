/* Dispositivo nativo de exemplo: pisca um pino digital a cada periodMs/2.
 *
 * Self-agendamento via schedule_event/LSDN_EVT_TIMER (não post_step -- nunca chamado pelo Core
 * hoje, igual Clock/WaveGen built-in já fazem via Scheduler::scheduleEvent). O primeiro
 * schedule_event tem que esperar a PRIMEIRA stamp(): chamar em init() seria no-op silencioso (o
 * host só liga componentIndex/scheduler DEPOIS de init() retornar -- ver device_abi.h). */
#include "lasecsimul/device_abi.h"
#include <stdlib.h>
#include <string.h>

#define EV_TICK 1

typedef struct {
    void* host_ctx;
    const LsdnHostApi* api;
    uint32_t pin_out;
    uint64_t half_period_ns;
    int32_t level;
    int32_t scheduled;
} BlinkerState;

static LsdnDevice* create(void* host_ctx, const LsdnHostApi* api) {
    BlinkerState* s = (BlinkerState*)calloc(1, sizeof(BlinkerState));
    s->host_ctx = host_ctx;
    s->api = api;
    return (LsdnDevice*)s;
}

static void init(LsdnDevice* dev) {
    BlinkerState* s = (BlinkerState*)dev;
    s->pin_out = s->api->pin_declare(s->host_ctx, 0, LSDN_PIN_DIGITAL_OUT, "out");
    LsdnPropertyValue value;
    memset(&value, 0, sizeof(value));
    if (s->api->config_get && s->api->config_get(s->host_ctx, "periodMs", &value) && value.kind == LSDN_PROPERTY_NUMBER) {
        s->half_period_ns = (uint64_t)(value.number_value * 1000000.0) / 2;
    } else {
        s->half_period_ns = 250000000;
    }
    s->level = 0;
}

static void stamp(LsdnDevice* dev, LsdnMatrixView* matrix) {
    BlinkerState* s = (BlinkerState*)dev;
    (void)matrix; /* saida puramente digital -- sem contribuicao passiva direta na matriz */
    if (!s->scheduled) {
        s->scheduled = 1;
        s->api->schedule_event(s->host_ctx, s->half_period_ns, EV_TICK);
    }
}

static void post_step(LsdnDevice* dev, uint64_t dt_ns) { (void)dev; (void)dt_ns; /* nao usado -- ver schedule_event */ }

static void on_event(LsdnDevice* dev, const LsdnEvent* ev) {
    BlinkerState* s = (BlinkerState*)dev;
    if (!ev || ev->tag != LSDN_EVT_TIMER || ev->a != EV_TICK) return;
    s->level = !s->level;
    s->api->pin_write(s->host_ctx, s->pin_out, s->level);
    s->api->schedule_event(s->host_ctx, s->half_period_ns, EV_TICK);
}
static uint32_t get_property(LsdnDevice* dev, const char* name, LsdnPropertyValue* out) {
    BlinkerState* s = (BlinkerState*)dev;
    if (!name || !out || strcmp(name, "periodMs") != 0) return 0;
    out->kind = LSDN_PROPERTY_NUMBER;
    out->number_value = (double)(s->half_period_ns * 2) / 1000000.0;
    out->bool_value = 0;
    out->string_value = 0;
    out->point_value.x = 0.0;
    out->point_value.y = 0.0;
    return 1;
}
static uint32_t set_property(LsdnDevice* dev, const char* name, const LsdnPropertyValue* value) {
    BlinkerState* s = (BlinkerState*)dev;
    if (!name || !value || strcmp(name, "periodMs") != 0 || value->kind != LSDN_PROPERTY_NUMBER) return 0;
    s->half_period_ns = (uint64_t)(value->number_value * 1000000.0) / 2;
    return 1;
}
static uint32_t get_state(LsdnDevice* dev, uint8_t* out, uint32_t cap) {
    BlinkerState* s = (BlinkerState*)dev;
    if (cap < sizeof(int32_t)) return 0;
    *(int32_t*)out = s->level;
    return sizeof(int32_t);
}
static void set_state(LsdnDevice* dev, const uint8_t* in, uint32_t len) {
    BlinkerState* s = (BlinkerState*)dev;
    if (len >= sizeof(int32_t)) s->level = *(const int32_t*)in;
}
static void destroy(LsdnDevice* dev) { free(dev); }

static const LsdnDeviceVTable kVTable = {
    create, init, stamp, post_step, on_event, get_property, set_property, get_state, set_state, destroy
};

LSDN_EXPORT
const LsdnDeviceVTable* lsdn_get_vtable(uint32_t* abi_major, uint32_t* abi_minor) {
    *abi_major = LSDN_ABI_VERSION_MAJOR;
    *abi_minor = LSDN_ABI_VERSION_MINOR;
    return &kVTable;
}

/* Voltímetro DC: mede a tensão entre p1 e p2 e expõe via get_state()/set_state() (8 bytes, double)
 * -- mecanismo genérico de leitura via IPC "getComponentState" (ver CoreApplication.cpp), já que a
 * ABI ainda não tem um getter de propriedade plugin->host (ver NativeDeviceProxy.hpp).
 *
 * Deliberadamente NÃO usa LsdnHostApi/pin_declare em init(): o bridge host_ctx real (que ligaria
 * pin_declare/pin_write ao Netlist/Scheduler da sessão) ainda não existe -- PluginRuntime::
 * createDeviceInstance() chama create(nullptr, nullptr) hoje (ver .spec/lasecsimul.spec e
 * docs/mvp-limitacoes.md). Este dispositivo só precisa do que já chega pronto via LsdnMatrixView em
 * stamp() (add_conductance/get_node_voltage), por isso funciona sem esse bridge.
 *
 * Impedância de entrada altíssima (quase circuito aberto) entre p1/p2: garante que os dois pinos
 * caiam no mesmo grupo MNA (sem isso, get_node_voltage não teria como relacionar os dois lados),
 * sem carregar o circuito que está sendo medido -- mesma técnica documentada pro switch ideal
 * (logic.button) no Core.
 *
 * Terceiro pino "outPin" (ABI >= 1.2): reflete a tensão medida como sinal analógico referenciado à
 * terra global, mesmo papel do `m_outPin`/`Meter::updateStep()` do `Meter` real do SimulIDE (3
 * pinos: 2 de medição + 1 de saída) -- outros componentes podem ler esse pino pra reagir à
 * leitura, ex: um osciloscópio. Usa `add_conductance_to_ground`/`add_current_to_ground`, expostos
 * a plugins só a partir da ABI 1.2 (ver device_abi.h). */
#include "lasecsimul/device_abi.h"
#include <stdlib.h>
#include <string.h>

#define VOLTMETER_INPUT_SIEMENS 1e-9
#define VOLTMETER_OUTPUT_SIEMENS 1e9

typedef struct {
    void* host_ctx;
    const LsdnHostApi* api;
    double voltage;
} VoltmeterState;

static LsdnDevice* create(void* host_ctx, const LsdnHostApi* api) {
    VoltmeterState* s = (VoltmeterState*)calloc(1, sizeof(VoltmeterState));
    s->host_ctx = host_ctx;
    s->api = api;
    return (LsdnDevice*)s;
}

static void init(LsdnDevice* dev) {
    (void)dev; /* pinos já vêm fixos do device.json/ComponentMeta -- nada a declarar aqui */
}

static void stamp(LsdnDevice* dev, LsdnMatrixView* matrix) {
    VoltmeterState* s = (VoltmeterState*)dev;
    /* pino 0 = "p1", pino 1 = "p2", pino 2 = "outPin" -- ordem declarada em device.json/ComponentMeta::pins */
    matrix->add_conductance(matrix->opaque, 0, 1, VOLTMETER_INPUT_SIEMENS);
    const double va = matrix->get_node_voltage(matrix->opaque, 0);
    const double vb = matrix->get_node_voltage(matrix->opaque, 1);
    s->voltage = va - vb;

    matrix->add_conductance_to_ground(matrix->opaque, 2, VOLTMETER_OUTPUT_SIEMENS);
    matrix->add_current_to_ground(matrix->opaque, 2, s->voltage * VOLTMETER_OUTPUT_SIEMENS);
}

static void post_step(LsdnDevice* dev, uint64_t dt_ns) { (void)dev; (void)dt_ns; }
static void on_event(LsdnDevice* dev, const LsdnEvent* ev) { (void)dev; (void)ev; }
static uint32_t get_property(LsdnDevice* dev, const char* name, LsdnPropertyValue* out) {
    VoltmeterState* s = (VoltmeterState*)dev;
    if (!name || !out || strcmp(name, "displayVoltage") != 0) return 0;
    out->kind = LSDN_PROPERTY_NUMBER;
    out->number_value = s->voltage;
    out->bool_value = 0;
    out->string_value = 0;
    out->point_value.x = 0.0;
    out->point_value.y = 0.0;
    return 1;
}
static uint32_t set_property(LsdnDevice* dev, const char* name, const LsdnPropertyValue* value) {
    (void)dev; (void)name; (void)value;
    return 0;
}

static uint32_t get_state(LsdnDevice* dev, uint8_t* out, uint32_t cap) {
    VoltmeterState* s = (VoltmeterState*)dev;
    if (cap < sizeof(double)) return 0;
    memcpy(out, &s->voltage, sizeof(double));
    return sizeof(double);
}
static void set_state(LsdnDevice* dev, const uint8_t* in, uint32_t len) {
    VoltmeterState* s = (VoltmeterState*)dev;
    if (len >= sizeof(double)) memcpy(&s->voltage, in, sizeof(double));
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
